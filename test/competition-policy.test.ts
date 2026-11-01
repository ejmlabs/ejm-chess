import { env } from 'cloudflare:workers';
import { createExecutionContext, evictDurableObject, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { Glicko2 } from 'glicko2';
import { describe, expect, it } from 'vitest';
import handler from '../src/server/index';
import { CREATION_LIFETIME_MS, type Competition } from '../src/server/competition';
import { publicProfile } from '../src/server/profile';
import { initialRating, rateMatch } from '../src/server/rating';
import { RULES_VERSION, type Actor, type GameResult, type InitGame } from '../src/shared/protocol';
import { enableRanked, gamesAnswering, heldCompetition, patchBindings, player, privates, rankedPair, settlesWith, swapBindings } from './authority-helpers';

const DAY = 86_400_000;
type Authority = DurableObjectStub<Competition>;

async function authority(existing?: Authority): Promise<Authority> {
  const competition = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await enableRanked(competition);
  // The isolated fixture must answer Game's normal ranked-reservation check.
  return heldCompetition(gamesAnswering(game => ({
    init: async (input: InitGame) => { await patchBindings(game, settlesWith(competition)); return game.init(input); },
  })), competition);
}

const pair = (competition: Authority, actors: readonly [Actor, Actor]) => rankedPair(competition, actors, { region: 'test', holdAlarms: true });

async function finish(competition: Authority, actors: readonly [Actor, Actor]) {
  const match = await pair(competition, actors);
  const first = await match.game.command(match.white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: match.initial.version });
  if (!first.ok) throw new Error(first.code);
  const active = await match.game.command(match.black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  if (!active.ok) throw new Error(active.code);
  const ended = await match.game.command(actors[1], { type: 'resign', id: crypto.randomUUID(), expectedVersion: active.snapshot.version });
  if (!ended.ok) throw new Error(ended.code);
  const result = (await match.game.status())!.result!;
  expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
  return result;
}

describe('ranked queue and rating policy', () => {
  it('drops a player whose password credential was removed while queued before matching an eligible opponent', async () => {
    const competition = await authority();
    const [changed, eligible] = await Promise.all([player(), player()]);
    expect((await competition.joinQueue(changed, 'blitz')).status).toBe('queued');
    await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(changed.id).run();
    expect((await competition.joinQueue(eligible, 'blitz')).status).toBe('queued');
    expect(await competition.queueStatus(changed)).toEqual({ status: 'idle' });
    expect((await competition.queueStatus(eligible)).status).toBe('queued');
    expect((await competition.health()).retainedRankedGames).toBe(0);
  });

  it('voids a reserved game before starting if a participant loses eligibility', async () => {
    const competition = await authority();
    const actors = await Promise.all([player(), player()]) as [Actor, Actor];
    const match = await pair(competition, actors);
    await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(match.black.id).run();
    const denied = await match.game.command(match.white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: match.initial.version });
    expect(denied.ok).toBe(false);
    expect(denied.snapshot.status).toBe('finished');
    expect(denied.snapshot.outcome).toEqual({ winner: null, score: null, reason: 'eligibility-revoked' });
    expect(denied.snapshot.startedAt).toBeNull();
    const result = (await match.game.status())!.result!;
    expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    expect(await competition.queueStatus(match.white)).toEqual({ status: 'idle' });
    expect(await competition.queueStatus(match.black)).toEqual({ status: 'idle' });
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT game_id FROM rating_events').toArray())).toHaveLength(0);
  });

  it('pairs accounts without recovery email and keeps reservations when cancellation races with game initialization', async () => {
    const competition = await authority();
    const [a, b] = await Promise.all([player(false, { recoveryEmail: false }), player(false, { recoveryEmail: false })]);
    await competition.joinQueue(a, 'blitz');
    const outcome = await runInDurableObject(competition, async instance => {
      const local = instance as Competition;
      let release!: () => void;
      let observed!: () => void;
      const reachedStatus = new Promise<void>(resolve => { observed = resolve; });
      const statusReply = new Promise<void>(resolve => { release = resolve; });
      const restore = swapBindings(instance, gamesAnswering(game => ({
        status: async () => { observed(); await statusReply; return game.status(); },
      })));
      try {
        const joining = local.joinQueue(b, 'blitz');
        await reachedStatus;
        const canceled = await local.cancelQueue(a);
        expect(canceled.status).toBe('reserved');
        release();
        return { canceled, joined: await joining };
      } finally { release(); restore(); }
    });
    expect(outcome.joined).toEqual(outcome.canceled);
    if (outcome.joined.status !== 'reserved') throw new Error('The committed reservation must survive cancellation.');
    const game = env.GAME.get(env.GAME.idFromName(outcome.joined.gameId));
    expect((await game.snapshot(a)).status).toBe('ready');
    expect(await competition.queueStatus(a)).toEqual(outcome.joined);
    expect(await competition.queueStatus(b)).toEqual(outcome.joined);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(outcome.joined.gameId).first('count')).toBe(2);
    expect(await env.DB.prepare('SELECT SUM(emailVerified) AS verified FROM user WHERE id IN (?,?)').bind(a.id, b.id).first('verified')).toBe(0);
  });

  it('limits an unordered pair to two started games until a prior start leaves the rolling day', async () => {
    const competition = await authority();
    const actors = await Promise.all([player(), player()]) as [Actor, Actor];
    const first = await finish(competition, actors);
    const second = await finish(competition, [actors[1], actors[0]]);
    expect((await competition.health()).farming).toMatchObject({ informational: true, checked: 2, flagged: 2,
      patterns: { 'repeated-pair': 2, 'reciprocal-wins': 2, 'early-resignation': 2 } });
    await competition.settle(second);
    await evictDurableObject(competition);
    await authority(competition);
    expect((await competition.health()).farming.checked).toBe(2);
    expect(await env.DB.prepare('SELECT 1 FROM restrictions WHERE user_id IN (?,?)').bind(actors[0].id, actors[1].id).first()).toBeNull();
    expect((await competition.joinQueue(actors[0], 'blitz')).status).toBe('queued');
    expect((await competition.joinQueue(actors[1], 'blitz')).status).toBe('queued');
    expect((await competition.queueStatus(actors[0])).status).toBe('queued');
    expect((await competition.health()).retainedRankedGames).toBe(2);
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec('UPDATE pair_games SET started_at=? WHERE game_id=?', Date.now() - DAY - 1, first.id);
      state.storage.sql.exec('UPDATE queue SET joined_at=? WHERE user_id IN (?,?)', Date.now() - 120_000, actors[0].id, actors[1].id);
    });
    expect((await competition.queueStatus(actors[1])).status).toBe('reserved');
    expect((await competition.health()).retainedRankedGames).toBe(3);
  });

  it('adds one empty period only after a whole inactive UTC week closes and replays without skill decay', () => {
    const playedAt = Date.parse('2026-10-04T23:59:59.999Z');
    const before = { ...initialRating(playedAt), rating: 1600, rd: 80, games: 40, lastPlayedAt: playedAt };
    const checkpoint = { ...before };
    const [sameWeek] = rateMatch(before, before, 0.5, playedAt);
    const [nextMonday] = rateMatch(before, before, 0.5, playedAt + 1);
    const [beforeClose] = rateMatch(before, before, 0.5, Date.parse('2026-10-11T23:59:59.999Z'));
    const atClose = Date.parse('2026-10-12T00:00:00.000Z');
    const [afterClose] = rateMatch(before, before, 0.5, atClose);
    expect(nextMonday.rd).toBe(sameWeek.rd);
    expect(beforeClose.rd).toBe(sameWeek.rd);
    expect(afterClose.rd).toBeGreaterThan(beforeClose.rd);
    // Independent package periods encode the published one-empty-week policy.
    const expected = new Glicko2({ rating: 1500, rd: 350, vol: 0.06, tau: 0.5 });
    const left = expected.makePlayer(1600, 80, 0.06);
    const right = expected.makePlayer(1600, 80, 0.06);
    expected.updateRatings([]);
    expected.updateRatings([[left, right, 0.5]]);
    expect(afterClose.rd).toBeCloseTo(left.getRd(), 10);
    expect(afterClose.rating).toBe(1600);
    expect(afterClose.games).toBe(41);
    expect(rateMatch(before, before, 0.5, atClose)[0]).toEqual(afterClose);
    expect(before).toEqual(checkpoint);
  });
});

describe('ranked matchmaking policy', () => {
  async function waited(competition: Authority, seconds: number, ...actors: Actor[]): Promise<void> {
    await runInDurableObject(competition, (_instance, state) => {
      for (const actor of actors) state.storage.sql.exec('UPDATE queue SET joined_at=? WHERE user_id=?', Date.now() - seconds * 1_000, actor.id);
    });
  }

  it('widens the rating window by five points each second of the shorter wait', async () => {
    const competition = await authority();
    const [low, high] = await Promise.all([player(), player()]);
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      "INSERT INTO ratings(pool,user_id,value) VALUES('blitz',?,?)", high.id, JSON.stringify({ ...initialRating(Date.now()), rating: 1900 })));
    await competition.joinQueue(low, 'blitz', 'EU');
    expect((await competition.joinQueue(high, 'blitz', 'EU')).status).toBe('queued');
    await waited(competition, 59, low, high);
    expect((await competition.queueStatus(low)).status).toBe('queued');
    await waited(competition, 60, low, high);
    expect((await competition.queueStatus(low)).status).toBe('reserved');
  });

  it('matches across regions only after thirty seconds', async () => {
    const competition = await authority();
    const [east, west] = await Promise.all([player(), player()]);
    await competition.joinQueue(east, 'blitz', 'EU');
    expect((await competition.joinQueue(west, 'blitz', 'AS')).status).toBe('queued');
    await waited(competition, 29, east, west);
    expect((await competition.queueStatus(east)).status).toBe('queued');
    await waited(competition, 30, east, west);
    expect((await competition.queueStatus(east)).status).toBe('reserved');
  });

  it('gives White to the player with fewer White games, whichever joined first', async () => {
    const competition = await authority();
    const [moreFirst, fewerSecond, fewerFirst, moreSecond] = await Promise.all([player(), player(), player(), player()]);
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      'INSERT INTO colors(user_id,balance) VALUES(?,3),(?,-3),(?,-3),(?,3)', moreFirst.id, fewerSecond.id, fewerFirst.id, moreSecond.id));
    for (const actor of [moreFirst, fewerSecond, fewerFirst, moreSecond]) await competition.joinQueue(actor, 'blitz', 'EU');
    const whites = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ white_id: string }>('SELECT white_id FROM matches').toArray().map(row => row.white_id));
    expect(whites.sort()).toEqual([fewerSecond.id, fewerFirst.id].sort());
  });
});

describe('ranked match creation', () => {
  /** Replaces what the Competition's Game binding answers, keeping the isolated fixture's other behavior. Returns a restore. */
  const overrideGame = (competition: Authority, calls: Record<string, unknown>) => patchBindings(competition, gamesAnswering(() => calls));

  async function reservedPair(competition: Authority, actors: readonly [Actor, Actor]): Promise<string> {
    await competition.joinQueue(actors[0], 'blitz');
    const queued = await competition.joinQueue(actors[1], 'blitz');
    if (queued.status !== 'reserved') throw new Error('Expected a reserved pairing.');
    return queued.gameId;
  }

  /** Runs the next creation attempt, optionally pretending the match started `age` ms ago. */
  async function retry(competition: Authority, gameId: string, age?: number): Promise<{ status: string; attempts: number }> {
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      'UPDATE matches SET next_attempt_at=0,created_at=COALESCE(?,created_at) WHERE id=?', age === undefined ? null : Date.now() - age, gameId));
    expect((await competition.maintenance()).errors).toEqual([]);
    return runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ status: string; attempts: number }>(
      'SELECT status,attempts FROM matches WHERE id=?', gameId).one());
  }

  const openSeats = (gameId: string) => env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(gameId).first('count');
  const capSeats = (actor: Actor) => env.DB.batch(Array.from({ length: 4 }, () => env.DB.prepare(
    'INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(actor.id, crypto.randomUUID(), Date.now())));

  it.each([
    ['a seat cannot be acquired', async (competition: Authority, actors: readonly [Actor, Actor]) => { await capSeats(actors[1]); return async () => {}; }, 0],
    ['Game initialization keeps failing after both seats are held', async (competition: Authority) => overrideGame(competition, { init: async () => { throw new Error('init_unavailable'); } }), 2],
  ])('cancels a match stuck creating when %s, frees both players and lets them queue again', async (_name, stick, seatsHeld) => {
    const competition = await authority();
    const actors = await Promise.all([player(), player()]) as [Actor, Actor];
    await stick(competition, actors);
    const gameId = await reservedPair(competition, actors);
    expect(await retry(competition, gameId)).toMatchObject({ status: 'creating' });
    expect(await retry(competition, gameId, CREATION_LIFETIME_MS - 60_000)).toMatchObject({ status: 'creating' });
    if (seatsHeld) expect(await openSeats(gameId)).toBe(seatsHeld);
    expect(await retry(competition, gameId, CREATION_LIFETIME_MS)).toMatchObject({ status: 'cancelled' });
    expect(await openSeats(gameId)).toBe(0);
    expect(await env.GAME.get(env.GAME.idFromName(gameId)).status()).toBeNull();
    for (const actor of actors) expect(await competition.queueStatus(actor)).toEqual({ status: 'idle' });
    expect(await competition.joinQueue(actors[0], 'blitz')).toMatchObject({ status: 'queued' });
  });

  it('recovers a match before its lifetime ends and never cancels it once its Game exists', async () => {
    const competition = await authority();
    const [free, capped] = await Promise.all([player(), player()]);
    await capSeats(capped);
    const gameId = await reservedPair(competition, [free, capped]);
    expect(await retry(competition, gameId)).toMatchObject({ status: 'creating' });
    await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=? AND released_at IS NULL AND game_id<>?').bind(Date.now(), capped.id, gameId).run();
    expect(await retry(competition, gameId, CREATION_LIFETIME_MS - 60_000)).toMatchObject({ status: 'reserved' });
    expect(await env.GAME.get(env.GAME.idFromName(gameId)).status()).toMatchObject({ id: gameId, status: 'ready' });
    // A lost reply leaves the match creating although its Game exists. An expired age must not cancel it.
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec("UPDATE matches SET status='creating' WHERE id=?", gameId));
    expect(await retry(competition, gameId, 2 * CREATION_LIFETIME_MS)).toMatchObject({ status: 'reserved' });
    expect(await openSeats(gameId)).toBe(2);
    for (const actor of [free, capped]) expect(await competition.queueStatus(actor)).toMatchObject({ status: 'reserved', gameId });
  });

  it('does not cancel an expired match while its Game cannot be asked', async () => {
    const competition = await authority();
    const actors = await Promise.all([player(), player()]) as [Actor, Actor];
    const restore = await overrideGame(competition, { status: async () => { throw new Error('game_unreachable'); } });
    const gameId = await reservedPair(competition, actors);
    expect(await retry(competition, gameId, 2 * CREATION_LIFETIME_MS)).toMatchObject({ status: 'creating' });
    await restore();
    expect(await retry(competition, gameId, 2 * CREATION_LIFETIME_MS)).toMatchObject({ status: 'cancelled' });
  });
});

describe('public leaderboard policy', () => {
  it('paginates tied players once in stable order and excludes private or ineligible account state', async () => {
    const now = Date.now();
    const actors = await Promise.all(Array.from({ length: 59 }, (_, index) => player(false, { recoveryEmail: index !== 0 })));
    const ranked = actors.slice(0, 52);
    const [guest, recent, inactive, provisional, restricted, withoutUsername, withoutCredential] = actors.slice(52);
    await env.DB.batch([
      env.DB.prepare('UPDATE user SET isAnonymous=1 WHERE id=?').bind(guest.id),
      env.DB.prepare('UPDATE user SET emailVerified=0 WHERE id=?').bind(ranked[1].id),
      env.DB.prepare('UPDATE user SET username=NULL WHERE id=?').bind(withoutUsername.id),
      env.DB.prepare('DELETE FROM account WHERE userId=?').bind(withoutCredential.id),
      ...actors.map(actor => env.DB.prepare(`INSERT INTO leaderboard_entries(pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,
        account_created_at,last_played_at,eligible,epoch,version,projected_at) VALUES('rapid',?,?,1600,1600,80,0.06,40,10,?,?,?,1,1,?)`)
        .bind(actor.id, actor.name, actor.id === recent.id ? now - DAY : now - 30 * DAY,
          actor.id === inactive.id ? now - 31 * DAY : now, actor.id === provisional.id ? 0 : 1, now)),
    ]);
    const caseId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(caseId, restricted.id, crypto.randomUUID(), now, now),
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'restrict','Private policy fixture.','Private notes.','Private evidence.','[]','fixture',?,?)`).bind(decisionId, caseId, restricted.id, ranked[0].id, now, now + DAY),
      env.DB.prepare('INSERT INTO restrictions(id,user_id,case_id,decision_id,reason,starts_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(decisionId, restricted.id, caseId, decisionId, 'Private restriction.', now, now + DAY),
    ]);
    type Page = { pool: string; entries: { id: string; name: string; rating: number; games: number }[]; updatedAt: number; nextCursor: string | null };
    async function page(cursor?: string): Promise<Page> {
      const context = createExecutionContext();
      const request = new Request(`http://localhost:8787/api/leaderboard?pool=rapid${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const response = await handler.fetch(request, env, context);
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      return response.json() as Promise<Page>;
    }
    const first = await page();
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(first.nextCursor!);
    expect(second.entries).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const entries = [...first.entries, ...second.entries];
    expect(entries.map(entry => entry.id)).toEqual(ranked.map(actor => actor.id).sort());
    expect(new Set(entries.map(entry => entry.id)).size).toBe(52);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(['games', 'id', 'name', 'rating']);
    expect(Object.keys(first).sort()).toEqual(['entries', 'nextCursor', 'pool', 'updatedAt']);
    expect(first.updatedAt).toBe(now);
    expect(JSON.stringify([first, second])).not.toContain('placeholder.invalid');
    expect(await env.DB.prepare('SELECT SUM(emailVerified) AS verified FROM user WHERE id IN (?,?)').bind(ranked[0].id, ranked[1].id).first('verified')).toBe(0);
  });

  it('stores rating standing only, so account age, a restriction or a closed ranking never strands an established player', async () => {
    const now = Date.now();
    const [young, restricted, closed, opponent] = await Promise.all([player(), player(), player(), player()]);
    const caseId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('UPDATE user SET createdAt=? WHERE id=?').bind(new Date(now - DAY).toISOString(), young.id),
      env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at) VALUES(?,?,?,\'decided\',?,?)').bind(caseId, restricted.id, crypto.randomUUID(), now, now),
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'restrict','Policy fixture.','Policy notes.','Policy proof.','[]','fixture',?,?)`).bind(decisionId, caseId, restricted.id, opponent.id, now, now + DAY),
      env.DB.prepare('INSERT INTO restrictions(id,user_id,case_id,decision_id,reason,starts_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(decisionId, restricted.id, caseId, decisionId, 'Policy fixture.', now, now + DAY),
    ]);
    const established = { ...initialRating(now), rating: 1650, rd: 80, games: 25, lastPlayedAt: now };
    const open = await authority();
    const shut = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    async function project(competition: Authority, actor: Actor): Promise<void> {
      const id = crypto.randomUUID();
      const result: GameResult = {
        id, eventId: `${id}:3`, reservationId: crypto.randomUUID(), format: 'blitz', rated: true,
        white: { id: actor.id, name: actor.name, ready: true, isAnonymous: false }, black: { id: opponent.id, name: opponent.name, ready: true, isAnonymous: false },
        status: 'finished', version: 3, rulesVersion: RULES_VERSION, terminalDigest: `fixture-${id}`,
        outcome: { winner: 'w', score: 1, reason: 'resignation' }, startedAt: now - 30_000, endedAt: now, createdAt: now - 40_000, pgn: '[Result "1-0"]\n\n1-0', plies: 20,
      };
      await runInDurableObject(competition, instance => privates(instance)
        .project({ result, epoch: 1, version: 1, ratings: [{ userId: actor.id, state: established, distinctOpponents: 10 }] }));
    }
    await Promise.all([project(open, young), project(open, restricted), project(shut, closed)]);
    const later = now + 8 * DAY;
    for (const actor of [young, restricted, closed]) {
      expect(await env.DB.prepare('SELECT eligible FROM leaderboard_entries WHERE user_id=?').bind(actor.id).first('eligible')).toBe(1);
      expect((await publicProfile(env, actor.id, later))?.pools[0]).toMatchObject({ status: 'established', eligible: true });
    }
  });
});
