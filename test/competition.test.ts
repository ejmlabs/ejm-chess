import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { JournalKind } from '../src/server/competition';
import { initialRating, rateMatch } from '../src/server/rating';
import { enableRanked, gamesAnswering, holdAlarms, patchBindings, player, privates, rankedPair, swapBindings } from './authority-helpers';
import { RULES_VERSION, type Actor, type GameResult, type Pool, type RatingState } from '../src/shared/protocol';

async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function paired(actors?: readonly [Actor, Actor], pool: Pool = 'blitz') {
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  await enableRanked(competition);
  return { competition, ...await rankedPair(competition, actors ?? await Promise.all([player(), player()]), { pool, region: 'test' }) };
}

async function startMatch(match: Awaited<ReturnType<typeof paired>>) {
  const first = await match.game.command(match.white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: match.initial.version });
  if (!first.ok) throw new Error(first.code);
  const second = await match.game.command(match.black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  if (!second.ok) throw new Error(second.code);
  return second.snapshot;
}

async function finishedMatch(actors?: readonly [Actor, Actor], loser?: Actor, pool: Pool = 'blitz') {
  const match = await paired(actors, pool);
  const active = await startMatch(match);
  const end = await match.game.command(loser ?? match.black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: active.version });
  if (!end.ok) throw new Error(end.code);
  const status = await match.game.status();
  if (!status?.result) throw new Error('missing_result');
  return { ...match, result: status.result };
}

async function reviewedDecision(subject: Actor, gameId: string, affected: string[], prior?: { caseId: string }): Promise<{ id: string; caseId: string }> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const caseId = prior?.caseId ?? crypto.randomUUID();
  const reviewer = await player();
  const statements: D1PreparedStatement[] = [];
  if (!prior) statements.push(env.DB.prepare("INSERT INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at) VALUES(?,?,?,'decided',?,?)").bind(caseId, subject.id, gameId, now, now));
  statements.push(env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,affected_game_ids,request_hash,created_at,appeal_until)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, caseId, subject.id, reviewer.id, prior ? 'clear' : 'restrict', 'Reviewed test decision.', 'Review fixture.', 'Corroborated test records.', '[]', JSON.stringify(affected), id, now, now + 7 * 86_400_000));
  statements.push(env.DB.prepare('INSERT INTO rating_correction_outbox(decision_id,subject_id,action,created_at) VALUES(?,?,?,?)').bind(id, subject.id, prior ? 'reverse_replay' : 'review_replay', now));
  await env.DB.batch(statements);
  return { id, caseId };
}

async function overturnedAppeal(subject: Actor, original: { id: string; caseId: string }): Promise<string> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const appealId = crypto.randomUUID();
  const reviewer = await player();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO fairplay_appeals(id,decision_id,case_id,user_id,reason,status,created_at)
      VALUES(?,?,?,?,?,'pending',?)`).bind(appealId, original.id, original.caseId, subject.id, 'The original review requires a second review.', now),
    env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until,appeal_id)
      VALUES(?,?,?,?,'overturn',?,'Independent appeal review.','Corroborated appeal records.','[]',?,?,?,?)`)
      .bind(id, original.caseId, subject.id, reviewer.id, 'The independent appeal restores these results.', id, now, now + 7 * 86_400_000, appealId),
    env.DB.prepare("UPDATE fairplay_appeals SET status='overturned',resolved_at=?,outcome_decision_id=? WHERE id=?").bind(now, id, appealId),
    env.DB.prepare("INSERT INTO rating_correction_outbox(decision_id,subject_id,action,created_at) VALUES(?,?,'reverse_replay',?)").bind(id, subject.id, now),
  ]);
  return id;
}

async function finishReplay(competition: Awaited<ReturnType<typeof paired>>['competition'], decisionId: string): Promise<void> {
  for (let step = 0; step < 50; step++) {
    if ((await competition.correctionStatus(decisionId)).complete) return;
    await competition.processCorrections();
  }
  throw new Error(JSON.stringify(await competition.correctionStatus(decisionId)));
}

async function readRating(competition: Awaited<ReturnType<typeof paired>>['competition'], actor: Actor, pool: Pool = 'blitz'): Promise<RatingState | null> {
  return runInDurableObject(competition, (_instance, state) => {
    const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM ratings WHERE pool=? AND user_id=?', pool, actor.id).toArray()[0];
    return row ? JSON.parse(row.value) as RatingState : null;
  });
}

async function settledMatch() {
  const match = await paired();
  await holdAlarms(match.competition);
  const active = await startMatch(match);
  const ended = await match.game.command(match.black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: active.version });
  if (!ended.ok) throw new Error(ended.code);
  const result = (await match.game.status())!.result!;
  await match.competition.settle(result);
  return { ...match, result };
}

/** A finished result that no real Game produced, for driving settlement past its verification step. */
function syntheticResult(overrides: Partial<GameResult> = {}): GameResult {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    id, eventId: `${id}:2`, format: 'blitz', rated: false, reservationId: null,
    white: { id: 'account-a', name: 'A', isAnonymous: false, ready: true },
    black: { id: 'account-b', name: 'B', isAnonymous: false, ready: true },
    status: 'finished', version: 2, rulesVersion: RULES_VERSION, terminalDigest: id,
    outcome: { winner: 'w', score: 1, reason: 'checkmate' },
    createdAt: now - 120_000, startedAt: now - 60_000, endedAt: now, pgn: '', plies: 30,
    ...overrides,
  };
}

/** Settles `result` on a fresh Competition whose Game reports it as final, running `beforeReply` as the Game answers. */
async function settleAgainstGame(result: GameResult, beforeReply: (sql: SqlStorage) => void = () => {}) {
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  const outcome = await runInDurableObject(competition, async (instance, state) => {
    swapBindings(instance, gamesAnswering(() => ({ status: async () => { beforeReply(state.storage.sql); return { result }; } })));
    let error = 'unexpected_success';
    try { await instance.settle(result); } catch (thrown) { error = (thrown as Error).message; }
    return {
      error,
      incidents: state.storage.sql.exec<{ kind: string }>('SELECT kind FROM incidents WHERE game_id=?', result.id).toArray().map(row => row.kind),
      events: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM result_events WHERE game_id=?', result.id).one().count,
    };
  });
  return { competition, ...outcome };
}

describe('competitive authority', () => {
  it('drains scored ranked projections', async () => {
    const { competition, result, white, black } = await settledMatch();
    await competition.flush();
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT id FROM outbox').toArray())).toEqual([]);
    expect(await env.DB.prepare('SELECT status,settlement,score FROM games WHERE id=?').bind(result.id).first())
      .toEqual({ status: 'finished', settlement: 'settled', score: 1 });
    expect((await env.DB.prepare('SELECT games FROM leaderboard_entries WHERE user_id IN (?,?)').bind(white.id, black.id).all()).results)
      .toEqual([{ games: 1 }, { games: 1 }]);
  });

  it('retries a failed projection from the outbox without repeating settlement', async () => {
    const { competition, result, white } = await settledMatch();
    const rating = await readRating(competition, white);
    await runInDurableObject(competition, async (instance, state) => {
      const batch = vi.spyOn(privates(instance).env.DB, 'batch').mockRejectedValueOnce(new Error('d1_unavailable'));
      try { await instance.flush(); } finally { batch.mockRestore(); }
      expect(state.storage.sql.exec('SELECT projected,attempts FROM outbox').toArray()).toEqual([{ projected: 0, attempts: 1 }]);
      state.storage.sql.exec('UPDATE outbox SET next_attempt_at=0');
      await instance.flush();
      expect(state.storage.sql.exec('SELECT id FROM outbox').toArray()).toEqual([]);
    });
    expect(await env.DB.prepare('SELECT status,settlement FROM games WHERE id=?').bind(result.id).first()).toEqual({ status: 'finished', settlement: 'settled' });
    expect(await readRating(competition, white)).toEqual(rating);
  });

  it('keeps ranked admission closed by default', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    expect(await competition.joinQueue(await player(), 'blitz')).toMatchObject({ status: 'closed' });
  });

  it('coalesces queued alarm updates, preserves earlier work, and rearms after dispatch', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const now = Date.now() + 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await runInDurableObject(competition, async (instance, state) => {
        const internal = privates(instance);
        swapBindings(instance, { ARENAS_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false' });
        expect((await instance.maintenance()).errors).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
        state.storage.sql.exec(`INSERT INTO account_closure_fences(user_id,request_id,lease_id,expires_at,state)
          VALUES('alarm-player','alarm-request','alarm-lease',?,'pending')`, now + 5_000);
        let entered!: () => void, release!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const paused = new Promise<void>(resolve => { release = resolve; });
        const getAlarm = state.storage.getAlarm.bind(state.storage);
        const reads = vi.spyOn(state.storage, 'getAlarm').mockImplementationOnce(async () => {
          const value = await getAlarm();
          entered();
          await paused;
          return value;
        });
        const writes = vi.spyOn(state.storage, 'setAlarm');
        const pending: Promise<void>[] = [];
        try {
          pending.push(internal.schedule());
          await Promise.resolve();
          expect(reads).toHaveBeenCalledTimes(1);
          await reading;
          state.storage.sql.exec('UPDATE account_closure_fences SET expires_at=?', now + 2_000);
          pending.push(internal.schedule());
          for (let index = 0; index < 63; index++) pending.push(internal.schedule());
          expect(reads).toHaveBeenCalledTimes(1);
          release();
          await Promise.all(pending);
          expect(reads).toHaveBeenCalledTimes(2);
          expect(writes.mock.calls.map(([time]) => Number(time))).toEqual([now + 5_000, now + 2_000]);
          expect(await getAlarm()).toBe(now + 2_000);
          state.storage.sql.exec('UPDATE account_closure_fences SET expires_at=?', now + 9_000);
          writes.mockClear();
          await Promise.all([internal.schedule(), internal.schedule()]);
          expect(await getAlarm()).toBe(now + 2_000);
          expect(writes).not.toHaveBeenCalled();
          expect((await instance.maintenance()).errors).toEqual([]);
          expect(await getAlarm()).toBe(now + 2_000);
          expect(writes).not.toHaveBeenCalled();
          await Promise.all([internal.schedule(now + 1_000), internal.schedule(now + 3_000)]);
          expect(await getAlarm()).toBe(now + 9_000);
        } finally {
          release();
          await Promise.allSettled(pending);
          reads.mockRestore();
          writes.mockRestore();
        }
      });
      // The native helper dispatches and removes the pending alarm before the
      // handler runs. Maintenance must arm the still-pending future work again.
      expect(await runDurableObjectAlarm(competition)).toBe(true);
      expect(await runInDurableObject(competition, (_instance, state) => state.storage.getAlarm())).toBe(now + 9_000);
    } finally {
      clock.mockRestore();
      await runInDurableObject(competition, (_instance, state) => state.storage.deleteAlarm());
    }
  });

  it('preserves the farming continuation across repeated scheduling and restart, then advances one bounded batch', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const actor = await player();
    // Runtime alarms use wall time. Keep this manually stepped clock beyond the test timeout.
    const now = Date.now() + 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const stopEvents = () => patchBindings(competition, { ARENAS_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false' });
    const alarm = () => runInDurableObject(competition, (_instance, state) => state.storage.getAlarm());
    try {
      await stopEvents();
      // Finish the empty initial arena cleanup before isolating farming's deadline.
      expect((await competition.maintenance()).errors).toEqual([]);
      expect(await alarm()).toBeNull();
      await runInDurableObject(competition, (_instance, state) => {
        for (let index = 0; index < 9; index++) {
          const id = `legacy-continuation-${String(index).padStart(2, '0')}`;
          state.storage.sql.exec(`INSERT INTO rated_result_checks
            (game_id,event_id,terminal_digest,policy,pair_key,winner_id,reason,plies,ended_at,patterns_json,checked_at)
            VALUES(?,?,?,'informational-2026-10-v1',?,NULL,'technical-void',0,?,'[]',?)`,
          id, `${id}:1`, id, JSON.stringify([actor.id, 'legacy-opponent']), now, now);
        }
      });
      expect((await competition.health()).farming.coverage.pending).toBe(true);
      await competition.cancelQueue(actor);
      expect(await alarm()).toBe(now + 1_000);
      for (const offset of [100, 400, 900]) {
        clock.mockReturnValue(now + offset);
        await competition.cancelQueue(actor);
        expect(await alarm()).toBe(now + 1_000);
      }
      await evictDurableObject(competition);
      await stopEvents();
      clock.mockReturnValue(now + 950);
      await competition.cancelQueue(actor);
      expect(await alarm()).toBe(now + 1_000);

      clock.mockReturnValue(now + 1_000);
      expect((await competition.maintenance()).errors).toEqual([]);
      expect((await competition.health()).farming.coverage).toMatchObject({ pending: true, incomplete: 8 });
      expect(await alarm()).toBe(now + 2_000);
      clock.mockReturnValue(now + 1_400);
      await competition.cancelQueue(actor);
      expect(await alarm()).toBe(now + 2_000);
      clock.mockReturnValue(now + 2_000);
      expect((await competition.maintenance()).errors).toEqual([]);
      expect((await competition.health()).farming.coverage).toMatchObject({ pending: false, incomplete: 9 });
      expect(await alarm()).toBeNull();
    } finally {
      clock.mockRestore();
      await runInDurableObject(competition, (_instance, state) => state.storage.deleteAlarm());
    }
  });

  it('holds one account slot across both formats', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await enableRanked(competition);
    const actor = await player();
    const [blitz, rapid] = await Promise.all([competition.joinQueue(actor, 'blitz'), competition.joinQueue(actor, 'rapid')]);
    expect(blitz.status).toBe('queued');
    expect(rapid.status).toBe('queued');
    if (blitz.status !== 'queued' || rapid.status !== 'queued') throw new Error('not_queued');
    expect(blitz.pool).toBe(rapid.pool);
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM slots WHERE user_id=?', actor.id).one().count)).toBe(1);
  });

  it('keeps a retryable reservation and releases only its first guard when the other player is at the seat cap', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    await enableRanked(competition);
    await holdAlarms(competition);
    const [free, capped] = await Promise.all([player(), player()]);
    const existingGames = Array.from({ length: 4 }, () => crypto.randomUUID());
    await env.DB.batch(existingGames.map(id => env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(capped.id, id, Date.now())));
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO colors(user_id,balance) VALUES(?,0),(?,1)', free.id, capped.id);
    });
    await competition.joinQueue(free, 'blitz');
    const queued = await competition.joinQueue(capped, 'blitz');
    expect(queued.status).toBe('reserved');
    if (queued.status !== 'reserved') throw new Error('not_reserved');
    expect(await env.GAME.get(env.GAME.idFromName(queued.gameId)).status()).toBeNull();
    const guards = await env.DB.prepare('SELECT user_id,game_id,released_at FROM active_game_seats WHERE user_id IN (?,?)').bind(free.id, capped.id).all<{ user_id: string; game_id: string; released_at: number | null }>();
    expect(guards.results.filter(row => row.user_id === free.id)).toEqual([{ user_id: free.id, game_id: queued.gameId, released_at: expect.any(Number) }]);
    expect(guards.results.filter(row => row.user_id === capped.id && row.released_at === null).map(row => row.game_id).sort()).toEqual(existingGames.sort());
    expect(await competition.queueStatus(free)).toMatchObject({ status: 'reserved', gameId: queued.gameId });
    await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=? AND game_id=?').bind(Date.now(), capped.id, existingGames[0]).run();
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() - 1, queued.gameId));
    expect((await competition.maintenance()).errors).toEqual([]);
    expect(await env.GAME.get(env.GAME.idFromName(queued.gameId)).status()).toMatchObject({ id: queued.gameId, status: 'ready' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(queued.gameId).first('count')).toBe(2);
  });

  it('enforces queue, unsettled and retained admission ceilings while preserving existing reservations', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await enableRanked(competition);
    await holdAlarms(competition, { RANKED_GAME_LIMIT: '1', RANKED_QUEUE_LIMIT: '2', RANKED_RETAINED_GAME_LIMIT: '2' });
    const [a, b, c, d, e] = await Promise.all(Array.from({ length: 5 }, () => player()));
    await competition.joinQueue(a, 'blitz');
    expect(await competition.joinQueue(b, 'blitz')).toMatchObject({ status: 'reserved' });
    await competition.joinQueue(c, 'blitz');
    expect(await competition.joinQueue(d, 'blitz')).toMatchObject({ status: 'queued' });
    expect(await competition.joinQueue(e, 'blitz')).toMatchObject({ status: 'closed' });
    expect(await competition.queueStatus(a)).toMatchObject({ status: 'reserved' });
    expect(await competition.health()).toMatchObject({ unsettled: 1, queued: 2, retainedRankedGames: 1, limits: { unsettledGames: 1, queuedPerPool: 2, retainedGames: 2 } });
    await patchBindings(competition, { RANKED_GAME_LIMIT: '10000', RANKED_QUEUE_LIMIT: 'invalid', RANKED_RETAINED_GAME_LIMIT: '1' });
    expect(await competition.joinQueue(e, 'rapid')).toMatchObject({ status: 'closed' });
    expect(await competition.health()).toMatchObject({ limits: { unsettledGames: 10_000, queuedPerPool: Number.MAX_SAFE_INTEGER, retainedGames: 1 } });
    expect(await competition.queueStatus(a)).toMatchObject({ status: 'reserved' });
  });

  it('commits both rating changes once through duplicate delivery and restart', async () => {
    const { competition, result, white, black } = await finishedMatch();
    expect(await competition.settle(result)).toMatchObject({ accepted: true, pending: false });
    const before = await Promise.all([readRating(competition, white), readRating(competition, black)]);
    await evictDurableObject(competition);
    await competition.settle(result);
    const after = await Promise.all([readRating(competition, white), readRating(competition, black)]);
    expect(after).toEqual(before);
    expect(after.map(rating => rating?.games)).toEqual([1, 1]);
    expect(after[0]!.rating).toBeGreaterThan(1500);
    expect(after[1]!.rating).toBeLessThan(1500);
    expect(await competition.queueStatus(white)).toEqual({ status: 'idle' });
    const conflict = await runInDurableObject(competition, async instance => {
      try { await instance.settle({ ...result, terminalDigest: 'different' }); return 'unexpected_success'; }
      catch (error) { return (error as Error).message; }
    });
    expect(conflict).toBe('conflicting_result');
    expect(await readRating(competition, white)).toEqual(after[0]);
  });

  it('keeps an unsettled account reserved and never expires a live reservation', async () => {
    const { competition, game, white, black, initial } = await paired();
    const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
    if (!first.ok) throw new Error(first.code);
    const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
    if (!second.ok) throw new Error(second.code);
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('UPDATE matches SET created_at=?,next_attempt_at=? WHERE id=?', Date.now() - 86_400_000, Date.now() - 1, initial.id));
    await runInDurableObject(competition, instance => instance.alarm());
    expect(await competition.queueStatus(white)).toMatchObject({ status: 'live', gameId: initial.id });
    await runInDurableObject(game, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one();
      const value = JSON.parse(row.value) as { deadline: number };
      value.deadline = Date.now() - 1;
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(value));
    });
    const flagged = await game.status();
    expect(flagged?.result?.outcome).toMatchObject({ winner: 'b', reason: 'timeout-win' });
    expect(await competition.joinQueue(white, 'rapid')).toMatchObject({ status: 'live', pool: 'blitz', gameId: initial.id });
    await competition.settle(flagged!.result!);
    expect(await readRating(competition, white)).not.toBeNull();
    expect(await competition.queueStatus(white)).toEqual({ status: 'idle' });
  });

  it('expires a paired ranked game without rating credit and recovers both account slots', async () => {
    const before = Date.now();
    const { competition, game, white, black, initial } = await paired();
    expect(initial.readinessDeadline).toBeGreaterThanOrEqual(before + 120_000);
    expect(initial.readinessDeadline).toBeLessThanOrEqual(Date.now() + 120_000);
    const ready = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
    if (!ready.ok) throw new Error(ready.code);
    const deadline = Date.now() - 1;
    await runInDurableObject(game, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one();
      const value = JSON.parse(row.value) as { readinessDeadline: number };
      value.readinessDeadline = deadline;
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(value));
    });
    const late = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: ready.snapshot.version });
    expect(late).toMatchObject({ ok: false, code: 'game_over', snapshot: { status: 'finished', startedAt: null,
      outcome: { winner: null, score: null, reason: 'readiness-expired' } } });
    await game.flush();
    await competition.flush();
    expect(await competition.queueStatus(white)).toEqual({ status: 'idle' });
    expect(await competition.queueStatus(black)).toEqual({ status: 'idle' });
    expect(await readRating(competition, white)).toBeNull();
    expect(await readRating(competition, black)).toBeNull();
    expect(await env.DB.prepare('SELECT score,settlement FROM games WHERE id=?').bind(initial.id).first()).toEqual({ score: null, settlement: 'settled' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(initial.id).first('count')).toBe(0);
  });

  it('records an incident for a ranked result without a matching reservation and accepts nothing', async () => {
    const outcome = await settleAgainstGame(syntheticResult({ rated: true, reservationId: crypto.randomUUID() }));
    expect(outcome).toMatchObject({ error: 'unregistered_ranked_game', incidents: ['unregistered_ranked_game'], events: 0 });
    expect(await outcome.competition.health()).toMatchObject({ incidents: 1, outbox: 0 });
  });

  it('records the conflict when another delivery commits a different final result while the Game is being asked', async () => {
    const result = syntheticResult();
    const outcome = await settleAgainstGame(result, sql => sql.exec(
      'INSERT INTO processed_results(game_id,event_id,digest,sequence) VALUES(?,?,?,1)', result.id, 'other-event', 'other-digest'));
    expect(outcome).toMatchObject({ error: 'conflicting_result', incidents: ['conflicting_final_result'], events: 0 });
    expect(await outcome.competition.health()).toMatchObject({ incidents: 1 });
  });

  it('projects a game and both ratings atomically and prevents an older result from replacing it', async () => {
    const { competition, result, white, black } = await finishedMatch();
    await competition.settle(result);
    await competition.flush();
    const game = await env.DB.prepare('SELECT status,projection_version FROM games WHERE id=?').bind(result.id).first<{ status: string; projection_version: number }>();
    expect(game?.status).toBe('finished');
    const entries = await env.DB.prepare('SELECT user_id,games FROM leaderboard_entries WHERE user_id IN (?,?)').bind(white.id, black.id).all<{ user_id: string; games: number }>();
    expect(entries.results).toHaveLength(2);
    expect(entries.results.every(entry => entry.games === 1)).toBe(true);
    const projection = { result: { ...result, status: 'pending-adjudication' } as GameResult, epoch: 1, version: game!.projection_version - 1, ratings: [] };
    await runInDurableObject(competition, instance => privates(instance).project(projection));
    expect(await env.DB.prepare('SELECT status FROM games WHERE id=?').bind(result.id).first('status')).toBe('finished');
  });

  it('replays a reviewed void, drains a game completed during repair once, and restores the history on clearance', async () => {
    const [a, b, c, d] = await Promise.all([player(), player(), player(), player()]);
    const one = await finishedMatch([a, b], b);
    const competition = one.competition;
    await holdAlarms(competition);
    await competition.settle(one.result);
    const two = await finishedMatch([a, c], a);
    await competition.settle(two.result);
    await competition.flush();
    const originalEpoch = await runInDurableObject(competition, (_instance, state) => Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'").one().value));
    const three = await paired([a, d]);
    const active = await startMatch(three);
    const decision = await reviewedDecision(a, one.result.id, [one.result.id]);
    expect(await competition.requestCorrection(decision.id)).toEqual({ accepted: true, complete: false });
    expect(await competition.joinQueue(await player(), 'blitz')).toMatchObject({ status: 'closed' });
    const ended = await three.game.command(d, { type: 'resign', id: crypto.randomUUID(), expectedVersion: active.version });
    expect(ended.ok).toBe(true);
    const resultThree = (await three.game.status())!.result!;
    expect(await competition.settle(resultThree)).toEqual({ accepted: true, pending: true });
    const pendingFarming = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{
      event_id: string; terminal_digest: string; patterns_json: string;
    }>('SELECT event_id,terminal_digest,patterns_json FROM rated_result_checks WHERE game_id=?', resultThree.id).toArray());
    expect(pendingFarming).toMatchObject([{ event_id: resultThree.eventId, terminal_digest: resultThree.terminalDigest }]);
    expect(JSON.parse(pendingFarming[0].patterns_json)).toContain('early-resignation');
    expect(await competition.queueStatus(a)).toMatchObject({ status: 'settling', gameId: resultThree.id });
    await competition.processCorrections();
    await evictDurableObject(competition);
    await enableRanked(competition);
    await holdAlarms(competition);
    await finishReplay(competition, decision.id);
    await competition.flush();

    const expected = new Map<string, RatingState>();
    for (const result of [two.result, resultThree]) {
      const white = expected.get(result.white.id) ?? initialRating(result.endedAt);
      const black = expected.get(result.black!.id) ?? initialRating(result.endedAt);
      const [postWhite, postBlack] = rateMatch(white, black, result.outcome.score!, result.endedAt);
      expected.set(result.white.id, postWhite);
      expected.set(result.black!.id, postBlack);
    }
    for (const actor of [a, c, d]) {
      const actual = await readRating(competition, actor);
      expect(actual?.rating).toBeCloseTo(expected.get(actor.id)!.rating, 9);
      expect(actual?.games).toBe(expected.get(actor.id)!.games);
      expect(await env.DB.prepare('SELECT rating FROM leaderboard_entries WHERE pool=? AND user_id=?').bind('blitz', actor.id).first('rating')).toBeCloseTo(actual!.rating, 9);
    }
    expect((await readRating(competition, b))?.games).toBe(0);
    expect(await env.DB.prepare('SELECT rating_voided FROM games WHERE id=?').bind(one.result.id).first('rating_voided')).toBe(1);
    expect(await competition.settle(resultThree)).toEqual({ accepted: true, pending: false });
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      'SELECT event_id,terminal_digest,patterns_json FROM rated_result_checks WHERE game_id=?', resultThree.id).toArray())).toEqual(pendingFarming);
    expect(await competition.requestCorrection(decision.id)).toEqual({ accepted: true, complete: true });
    expect(await competition.queueStatus(a)).toEqual({ status: 'idle' });
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT sequence FROM rating_events WHERE game_id IN (?,?,?)', one.result.id, two.result.id, resultThree.id).toArray())).toHaveLength(3);
    const generation = await env.DB.prepare('SELECT epoch FROM competition_generations WHERE pool=?').bind('blitz').first<number>('epoch');
    expect(generation).toBe(originalEpoch + 1);

    const cleared = await reviewedDecision(a, one.result.id, [], decision);
    await competition.requestCorrection(cleared.id);
    await finishReplay(competition, cleared.id);
    await competition.flush();
    const restored = new Map<string, RatingState>();
    for (const result of [one.result, two.result, resultThree]) {
      const [white, black] = rateMatch(restored.get(result.white.id) ?? initialRating(result.endedAt), restored.get(result.black!.id) ?? initialRating(result.endedAt), result.outcome.score!, result.endedAt);
      restored.set(result.white.id, white);
      restored.set(result.black!.id, black);
    }
    for (const actor of [a, b, c, d]) expect((await readRating(competition, actor))?.rating).toBeCloseTo(restored.get(actor.id)!.rating, 9);
    expect(await env.DB.prepare('SELECT rating_voided FROM games WHERE id=?').bind(one.result.id).first('rating_voided')).toBe(0);
    expect(await env.DB.prepare('SELECT epoch FROM competition_generations WHERE pool=?').bind('blitz').first('epoch')).toBe(originalEpoch + 2);
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT sequence FROM corrected_events WHERE game_id IN (?,?,?)', one.result.id, two.result.id, resultThree.id).toArray())).toHaveLength(5);
  });

  it('imports correction decisions around a failing one and keeps each player in order', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await holdAlarms(competition);
    const [a, b] = await Promise.all([player(), player()]);
    // An unknown game ID leaves nothing to replay, so each decision completes as soon as it is imported.
    const failing = await reviewedDecision(a, crypto.randomUUID(), ['x']);
    const behind = await reviewedDecision(a, crypto.randomUUID(), ['unreplayed-game-a']);
    const other = await reviewedDecision(b, crypto.randomUUID(), ['unreplayed-game-b']);
    const createdAt = Date.now() - 60_000;
    for (const [index, decision] of [failing, behind, other].entries()) {
      await env.DB.prepare('UPDATE rating_correction_outbox SET created_at=? WHERE decision_id=?').bind(createdAt + index, decision.id).run();
    }
    const completed = async (decision: { id: string }) => Boolean(await env.DB.prepare('SELECT completed_at FROM rating_correction_outbox WHERE decision_id=?').bind(decision.id).first('completed_at'));
    const drain = async (done: () => Promise<boolean>) => { for (let step = 0; step < 12 && !await done(); step++) await competition.processCorrections(); };

    await drain(() => completed(other));
    expect(await completed(other)).toBe(true);
    for (let step = 0; step < 3; step++) await competition.processCorrections();
    expect([await completed(failing), await completed(behind)]).toEqual([false, false]);
    expect(await env.DB.prepare('SELECT last_error FROM rating_correction_outbox WHERE decision_id=?').bind(failing.id).first('last_error')).toBe('invalid_affected_games');

    await env.DB.prepare('UPDATE fairplay_decisions SET affected_game_ids=? WHERE id=?').bind('["unreplayed-game-c"]', failing.id).run();
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('UPDATE correction_import_retries SET retry_at=0'));
    await drain(() => completed(behind));
    expect([await completed(failing), await completed(behind)]).toEqual([true, true]);
    const mine = new Set([failing.id, behind.id, other.id]);
    const order = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ decision_id: string }>('SELECT decision_id FROM correction_decisions ORDER BY rowid').toArray().map(row => row.decision_id));
    expect(order.filter(id => mine.has(id))).toEqual([other.id, failing.id, behind.id]);
  });

  it('publishes both repaired pools together and restores their ratings through a linked appeal overturn', async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    const blitz = await finishedMatch([a, b], b);
    const competition = blitz.competition;
    await holdAlarms(competition);
    await competition.settle(blitz.result);
    const rapid = await finishedMatch([a, c], a, 'rapid');
    await competition.settle(rapid.result);
    await competition.flush();
    const originals = await Promise.all([
      readRating(competition, a, 'blitz'), readRating(competition, b, 'blitz'),
      readRating(competition, a, 'rapid'), readRating(competition, c, 'rapid'),
    ]);
    const originalEpoch = await runInDurableObject(competition, (_instance, state) => Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'").one().value));
    const visible = async () => (await env.DB.batch([
      env.DB.prepare('SELECT pool,user_id,rating,games,epoch FROM leaderboard_entries WHERE user_id IN (?,?,?) ORDER BY pool,user_id').bind(a.id, b.id, c.id),
      env.DB.prepare('SELECT id,rating_voided,projection_epoch FROM games WHERE id IN (?,?) ORDER BY id').bind(blitz.result.id, rapid.result.id),
      env.DB.prepare('SELECT pool,epoch FROM competition_generations ORDER BY pool'),
    ])).map(result => result.results);
    const before = await visible();
    const decision = await reviewedDecision(a, blitz.result.id, [blitz.result.id, rapid.result.id]);
    expect(await competition.requestCorrection(decision.id)).toEqual({ accepted: true, complete: false });
    let sawBarrier = false;
    let bothPrepared = false;
    for (let step = 0; step < 30; step++) {
      const { runs } = await competition.correctionStatus(decision.id);
      expect(runs).toHaveLength(2);
      if (runs.some(run => run.phase === 'publish') && runs.some(run => run.phase !== 'publish')) sawBarrier = true;
      expect(await visible()).toEqual(before);
      if (runs.every(run => run.phase === 'publish')) { bothPrepared = true; break; }
      await competition.processCorrections();
    }
    expect(sawBarrier).toBe(true);
    expect(bothPrepared).toBe(true);
    await competition.processCorrections();
    expect((await env.DB.prepare('SELECT pool,epoch FROM competition_generations ORDER BY pool').all()).results)
      .toEqual([{ pool: 'blitz', epoch: originalEpoch + 1 }, { pool: 'rapid', epoch: originalEpoch + 1 }]);
    expect((await env.DB.prepare('SELECT rating_voided FROM games WHERE id IN (?,?)').bind(blitz.result.id, rapid.result.id).all()).results)
      .toEqual([{ rating_voided: 1 }, { rating_voided: 1 }]);
    await finishReplay(competition, decision.id);
    expect((await readRating(competition, a, 'blitz'))?.games).toBe(0);
    expect((await readRating(competition, a, 'rapid'))?.games).toBe(0);

    const appealDecision = await overturnedAppeal(a, decision);
    expect(await competition.requestCorrection(appealDecision)).toEqual({ accepted: true, complete: false });
    await evictDurableObject(competition);
    await enableRanked(competition);
    await holdAlarms(competition);
    await finishReplay(competition, appealDecision);
    await competition.flush();
    expect(await Promise.all([
      readRating(competition, a, 'blitz'), readRating(competition, b, 'blitz'),
      readRating(competition, a, 'rapid'), readRating(competition, c, 'rapid'),
    ])).toEqual(originals);
    expect((await env.DB.prepare('SELECT rating_voided,rating_decision_id FROM games WHERE id IN (?,?)').bind(blitz.result.id, rapid.result.id).all()).results)
      .toEqual([{ rating_voided: 0, rating_decision_id: null }, { rating_voided: 0, rating_decision_id: null }]);
    expect((await env.DB.prepare('SELECT pool,epoch FROM competition_generations ORDER BY pool').all()).results)
      .toEqual([{ pool: 'blitz', epoch: originalEpoch + 2 }, { pool: 'rapid', epoch: originalEpoch + 2 }]);
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT restoring_decision_id,original_decision_id FROM restored_decisions WHERE restoring_decision_id=?', appealDecision).toArray()))
      .toEqual([{ restoring_decision_id: appealDecision, original_decision_id: decision.id }]);
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT sequence FROM rating_events WHERE game_id IN (?,?)', blitz.result.id, rapid.result.id).toArray())).toHaveLength(2);
    expect(await competition.requestCorrection(appealDecision)).toEqual({ accepted: true, complete: true });
  });

  it('keeps a prepared pool quiet at the publish barrier while its sibling waits to retry', async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    const blitz = await finishedMatch([a, b], b);
    const competition = blitz.competition;
    await holdAlarms(competition);
    await competition.settle(blitz.result);
    const rapid = await finishedMatch([a, c], a, 'rapid');
    await competition.settle(rapid.result);
    await competition.flush();
    const generations = async () => (await env.DB.prepare('SELECT pool,epoch FROM competition_generations ORDER BY pool').all()).results;
    const before = await generations();
    const decision = await reviewedDecision(a, blitz.result.id, [blitz.result.id, rapid.result.id]);
    await competition.requestCorrection(decision.id);
    const runs = () => runInDurableObject(competition, (_instance, state) => Object.fromEntries(state.storage.sql.exec<{ pool: string; phase: string; next_at: number }>(
      'SELECT pool,phase,next_at FROM correction_runs WHERE decision_id=?', decision.id).toArray().map(run => [run.pool, run])));
    for (let step = 0; step < 30 && (await runs()).blitz.phase !== 'publish'; step++) await competition.processCorrections();
    expect(await runs()).toMatchObject({ blitz: { phase: 'publish' }, rapid: { phase: expect.not.stringMatching(/^publish$/) } });
    const retryAt = Date.now() + 30_000;
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec("UPDATE correction_runs SET next_at=?,error='retry_later' WHERE decision_id=? AND pool='rapid'", retryAt, decision.id));
    await competition.processCorrections();
    // A prepared run that stays due would re-arm the alarm every millisecond until its sibling retries.
    expect((await runs()).blitz.next_at).toBeGreaterThanOrEqual(retryAt);
    expect(await generations()).toEqual(before);
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec("UPDATE correction_runs SET next_at=0 WHERE decision_id=?", decision.id));
    await finishReplay(competition, decision.id);
    expect(await generations()).not.toEqual(before);
  });

  it('keeps a pool paused and exposes an unsupported historical policy instead of publishing a guessed repair', async () => {
    const { competition, result, white } = await finishedMatch();
    await competition.settle(result);
    await holdAlarms(competition);
    const decision = await reviewedDecision(white, result.id, [result.id]);
    await competition.requestCorrection(decision.id);
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec("UPDATE rating_events SET policy='unknown-v0' WHERE game_id=?", result.id));
    await competition.processCorrections();
    expect(await competition.correctionStatus(decision.id)).toMatchObject({ complete: false, runs: [{ phase: 'replay', cursor: 0, error: 'unsupported_rating_policy' }] });
    expect(await competition.joinQueue(await player(), 'blitz')).toMatchObject({ status: 'closed' });
    expect(await env.DB.prepare('SELECT last_error FROM rating_correction_outbox WHERE decision_id=?').bind(decision.id).first('last_error')).toBe('unsupported_rating_policy');
    expect((await readRating(competition, white))?.games).toBe(1);
  });

  it('exports bounded immutable pages and replays an isolated restored journal across a durable cursor boundary', async () => {
    const source = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await holdAlarms(source);
    const [a, ...opponents] = await Promise.all(Array.from({ length: 22 }, () => player()));
    const now = Date.now();
    const results: GameResult[] = opponents.map((opponent, index) => {
      const id = crypto.randomUUID();
      const endedAt = now - (opponents.length - index) * 60_000;
      return {
        id, eventId: `${id}:3`, reservationId: crypto.randomUUID(), format: 'blitz', rated: true,
        white: { id: a.id, name: a.name, ready: true, isAnonymous: false },
        black: { id: opponent.id, name: opponent.name, ready: true, isAnonymous: false },
        status: 'finished', version: 3, rulesVersion: RULES_VERSION, terminalDigest: `fixture-${id}`,
        outcome: { winner: 'w', score: 1, reason: 'resignation' }, startedAt: endedAt - 30_000, endedAt,
        createdAt: endedAt - 40_000, pgn: '[Result "1-0"]\n\n1-0', plies: 0,
      };
    });
    await runInDurableObject(source, (instance, state) => {
      for (const result of results) {
        const sequence = state.storage.sql.exec<{ sequence: number }>('INSERT INTO result_events(event_id,game_id,payload,accepted_at) VALUES(?,?,?,?) RETURNING sequence', result.eventId, result.id, JSON.stringify(result), result.endedAt).one().sequence;
        privates(instance).applyFinished(result, sequence, 1, result.endedAt);
      }
    });
    const manifest = await source.beginExport();
    expect(manifest.watermarks.ratings).toBe(21);
    const pages: Awaited<ReturnType<typeof source.exportEvents>>[] = [];
    for (let after = 0; ;) {
      const page = await source.exportEvents({ kind: 'ratings', after, watermark: manifest.watermarks.ratings, limit: 7 });
      const { sha256, ...unsigned } = page;
      expect(sha256).toBe(await sha256Hex(JSON.stringify(unsigned)));
      expect(page.rows.length).toBeLessThanOrEqual(7);
      pages.push(page);
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(pages).toHaveLength(3);
    const rows = pages.flatMap(page => page.rows);
    expect(rows).toHaveLength(21);
    const safeDump = JSON.stringify(await Promise.all((Object.keys(manifest.watermarks) as JournalKind[]).map(kind => source.exportEvents({ kind, watermark: manifest.watermarks[kind] }))));
    expect(safeDump).not.toContain(a.sessionId);
    expect(safeDump).not.toContain('@example.test');
    const recovered = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await enableRanked(recovered);
    await holdAlarms(recovered);
    await runInDurableObject(recovered, (_instance, state) => {
      for (const { record } of rows) state.storage.sql.exec(`INSERT INTO rating_events(sequence,game_id,pool,policy,epoch,white_id,black_id,score,pre_white,pre_black,post_white,post_black,accepted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, record.sequence, record.game_id, record.pool, record.policy, record.epoch, record.white_id, record.black_id, record.score,
      record.pre_white, record.pre_black, record.post_white, record.post_black, record.accepted_at);
    });
    const decision = await reviewedDecision(a, results[0].id, [results[0].id]);
    await recovered.requestCorrection(decision.id);
    const checkpoint = await runInDurableObject(recovered, (_instance, state) => state.storage.sql.exec<{ payload: string; digest: string }>('SELECT payload,digest FROM checkpoints').one());
    expect(checkpoint.digest).toBe(await sha256Hex(checkpoint.payload));
    await recovered.processCorrections();
    expect(await recovered.correctionStatus(decision.id)).toMatchObject({ complete: false, runs: [{ phase: 'replay', cursor: 20, watermark: 21 }] });
    await evictDurableObject(recovered);
    await enableRanked(recovered);
    await holdAlarms(recovered);
    await finishReplay(recovered, decision.id);
    expect((await readRating(recovered, a))?.games).toBe(20);
    let expected = initialRating(results[1].endedAt);
    for (const result of results.slice(1)) [expected] = rateMatch(expected, initialRating(result.endedAt), 1, result.endedAt);
    expect((await readRating(recovered, a))?.rating).toBeCloseTo(expected.rating, 9);
    expect(await runInDurableObject(recovered, (_instance, state) => state.storage.sql.exec('SELECT sequence FROM rating_events').toArray())).toHaveLength(21);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM leaderboard_rebuild WHERE run_id=?').bind(`${decision.id}:blitz`).first('count')).toBe(0);
  });
});

describe('versioned rating adapter', () => {
  it('rates both participants from the same pre-game values and keeps zero as a real rating', () => {
    const now = Date.now();
    const [win, loss] = rateMatch(initialRating(now), initialRating(now), 1, now);
    expect(win.rating).toBeCloseTo(1662.3109, 3);
    expect(loss.rating).toBeCloseTo(1337.6891, 3);
    expect(win.rd).toBeCloseTo(loss.rd, 8);
    const zero = { ...initialRating(now), rating: 0 };
    const [zeroAfter] = rateMatch(zero, zero, 0.5, now);
    expect(zeroAfter.rating).toBeCloseTo(0, 8);
  });
});
