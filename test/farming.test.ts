import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FARMING_PATTERNS, FARMING_POLICY, farmingStatus, initializeFarmingChecks, recordFarmingCheck } from '../src/server/farming';
import { RULES_VERSION, type GameResult } from '../src/shared/protocol';
import { enableRanked, player } from './authority-helpers';

function result(overrides: Partial<GameResult> = {}): GameResult {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    id, eventId: `${id}:2`, format: 'blitz', rated: true, reservationId: crypto.randomUUID(),
    white: { id: 'account-a', name: 'A', isAnonymous: false, ready: true },
    black: { id: 'account-b', name: 'B', isAnonymous: false, ready: true },
    status: 'finished', version: 2, rulesVersion: RULES_VERSION, terminalDigest: id,
    outcome: { winner: null, score: 0.5, reason: 'draw-agreement' },
    createdAt: now - 120_000, startedAt: now - 60_000, endedAt: now, pgn: '', plies: 30,
    ...overrides,
  };
}

const DAY = 86_400_000;
function between(a: string, b: string, endedAt: number, overrides: Partial<GameResult> = {}): GameResult {
  return result({ white: { id: a, name: a, isAnonymous: false, ready: true },
    black: { id: b, name: b, isAnonymous: false, ready: true }, endedAt, ...overrides });
}

function storeCheck(sql: SqlStorage, game: GameResult, legacy = false, source = false): void {
  const winner = game.outcome.score === 1 ? game.white.id : game.outcome.score === 0 ? game.black!.id : null;
  sql.exec(`INSERT INTO rated_result_checks
    (game_id,event_id,terminal_digest,policy,pair_key,winner_id,reason,plies,ended_at,patterns_json,checked_at${legacy ? '' : ',score,coverage'})
    VALUES(?,?,?,?,?,?,?,?,?,?,?${legacy ? '' : ",?,'complete'"})`, game.id, game.eventId, game.terminalDigest,
    legacy ? 'informational-2026-10-v1' : FARMING_POLICY, JSON.stringify([game.white.id, game.black!.id].sort()),
    winner, game.outcome.reason, game.plies, game.endedAt, '[]', game.endedAt, ...(legacy ? [] : [game.outcome.score]));
  if (source) sql.exec('INSERT INTO result_events(event_id,game_id,payload,accepted_at) VALUES(?,?,?,?)', game.eventId, game.id, JSON.stringify(game), game.endedAt);
}

function facts(sql: SqlStorage): Array<{ game_id: string; patterns_json: string }> {
  return sql.exec<{ game_id: string; patterns_json: string }>('SELECT game_id,patterns_json FROM rated_result_checks ORDER BY game_id').toArray();
}

describe('informational farming facts', () => {
  it('recognizes reciprocal wins across formats and colors when the older result arrives last', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const older = result({ endedAt: Date.now() - 3_600_000, outcome: { winner: 'w', score: 1, reason: 'checkmate' } });
    const newer = result({ format: 'rapid', white: older.black!, black: older.white, outcome: { winner: 'w', score: 1, reason: 'checkmate' } });
    const status = await runInDurableObject(competition, (_instance, state) => {
      recordFarmingCheck(state.storage.sql, newer, Date.now());
      recordFarmingCheck(state.storage.sql, older, Date.now());
      recordFarmingCheck(state.storage.sql, older, Date.now());
      return farmingStatus(state.storage.sql);
    });
    expect(status).toMatchObject({ checked: 2, flagged: 2, patterns: { 'repeated-pair': 2, 'reciprocal-wins': 2, 'early-resignation': 0 } });
    expect(status.recent.map(check => check.gameId).sort()).toEqual([older.id, newer.id].sort());
    for (const check of status.recent) expect(check.patterns).toEqual(expect.arrayContaining(['repeated-pair', 'reciprocal-wins']));
  });

  it('checks draws and voids without a winner, excludes other modes and pending results, and keeps single early resignations informational', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const draw = result();
    const voided = result({ outcome: { winner: null, score: null, reason: 'technical-void' }, endedAt: draw.endedAt + 2 * 86_400_000 });
    const early = result({ white: { ...draw.white, id: 'account-c' }, plies: 4, outcome: { winner: 'b', score: 0, reason: 'resignation' } });
    const status = await runInDurableObject(competition, (_instance, state) => {
      for (const item of [draw, voided, early, result({ rated: false }), result({ status: 'pending-adjudication' }),
        result({ ai: { modelId: 'fixture', name: 'Fixture', actualModel: 'fixture' } })]) {
        recordFarmingCheck(state.storage.sql, item, Date.now());
      }
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM rated_result_checks WHERE winner_id IS NULL').one().count).toBe(2);
      return farmingStatus(state.storage.sql);
    });
    expect(status).toMatchObject({ informational: true, checked: 3, flagged: 1,
      patterns: { 'repeated-pair': 0, 'reciprocal-wins': 0, 'early-resignation': 1 } });
    expect(status.recent).toMatchObject([{ gameId: early.id, patterns: ['early-resignation'] }]);
  });

  it.each([
    ['an early timeout win', 4, 1],
    ['a timeout win after ten plies', 12, 0],
  ])('treats %s like an early resignation only before ten plies', async (_name, plies, flagged) => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const timeout = result({ plies, outcome: { winner: 'b', score: 0, reason: 'timeout-win' } });
    const status = await runInDurableObject(competition, (_instance, state) => {
      recordFarmingCheck(state.storage.sql, timeout, Date.now());
      return farmingStatus(state.storage.sql);
    });
    expect(status).toMatchObject({ checked: 1, flagged, patterns: { 'early-resignation': flagged } });
  });

  it('rejects self-play before creating a check or accepting a result', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const game = result();
    game.black = game.white;
    const observed = await runInDurableObject(competition, async (instance, state) => {
      expect(() => recordFarmingCheck(state.storage.sql, game, Date.now())).toThrow('self_play_result');
      try { await instance.settle(game); return 'unexpected_success'; }
      catch (error) { return (error as Error).message; }
    });
    expect(observed).toBe('self_play_result');
    expect((await competition.health()).farming.checked).toBe(0);
  });

  it('flags every scored triangle edge at the exact day boundary, regardless of delivery order', async () => {
    const now = Date.now();
    const games = [between('a', 'b', now - DAY), between('c', 'a', now - DAY / 2, { format: 'rapid' }),
      between('b', 'c', now), between('a', 'b', now - 1), between('d', 'e', now - DAY - 1),
      between('f', 'd', now - DAY / 2), between('e', 'f', now),
      between('x', 'y', now - 2), between('z', 'x', now - 1), between('y', 'z', now, { outcome: { winner: null, score: null, reason: 'technical-void' } })];
    const expected = games.slice(0, 4).map(game => game.id).sort();
    const observed = [];
    for (const delivery of [games, [...games].reverse(), [...games.slice(3), ...games.slice(0, 3)]]) {
      const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
      observed.push(await runInDurableObject(competition, (_instance, state) => {
        for (const game of delivery) recordFarmingCheck(state.storage.sql, game, now);
        expect(recordFarmingCheck(state.storage.sql, delivery[0], now)).toMatchObject({ duplicate: true, candidateRows: 0, rowsRead: 0, updatedChecks: 0 });
        return facts(state.storage.sql);
      }));
    }
    expect(observed[1]).toEqual(observed[0]); expect(observed[2]).toEqual(observed[0]);
    expect(observed[0].filter(row => JSON.parse(row.patterns_json).includes('account-cluster')).map(row => row.game_id)).toEqual(expected);
    for (const row of observed[0]) {
      const patterns = JSON.parse(row.patterns_json);
      expect(patterns).toEqual(FARMING_PATTERNS.filter(pattern => patterns.includes(pattern)));
    }
  });

  it('records concentrated wins only with two short resignations, two losers, and a one-day span', async () => {
    const now = Date.now();
    const win = { outcome: { winner: 'w' as const, score: 1 as const, reason: 'resignation' as const }, plies: 9 };
    const groups = [
      [between('r', 'a', now - DAY, win), between('b', 'r', now - 1, { ...win, format: 'rapid', outcome: { winner: 'b', score: 0, reason: 'resignation' } }), between('r', 'a', now)],
      [between('few-short', 'c', now - 2, win), between('few-short', 'd', now - 1, { ...win, plies: 10 }), between('few-short', 'c', now)],
      [between('one-loser', 'e', now - 2, win), between('one-loser', 'e', now - 1, win), between('one-loser', 'e', now)],
      [between('too-wide', 'f', now - DAY - 1, win), between('too-wide', 'g', now - 1, win), between('too-wide', 'f', now)],
    ];
    const games = groups.flat();
    // The third winning result can be a checkmate; it need not be short.
    for (const group of groups) group[2].outcome = { winner: 'w', score: 1, reason: 'checkmate' };
    const snapshots = [];
    for (const delivery of [games, [...games].reverse(), [...games.slice(1), games[0]]]) {
      const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
      snapshots.push(await runInDurableObject(competition, (_instance, state) => {
        for (const game of delivery) recordFarmingCheck(state.storage.sql, game, now);
        return facts(state.storage.sql);
      }));
    }
    expect(snapshots[1]).toEqual(snapshots[0]); expect(snapshots[2]).toEqual(snapshots[0]);
    expect(snapshots[0].filter(row => JSON.parse(row.patterns_json).includes('rating-transfer-candidate')).map(row => row.game_id)).toEqual(groups[0].map(game => game.id).sort());
  });

  it('uses bounded indexed neighborhoods at 1,000 retained games and leaves duplicates idle', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const now = Date.now();
    const observed = await runInDurableObject(competition, (_instance, state) => {
      const sql = state.storage.sql;
      for (let index = 0; index < 999; index++) storeCheck(sql, between('dense-a', 'dense-b', now, { outcome: { winner: 'w', score: 1, reason: 'checkmate' } }));
      const game = between('dense-a', 'dense-b', now, { outcome: { winner: 'w', score: 1, reason: 'checkmate' } });
      const lookups: Array<{ statement: string; bindings: SqlStorageValue[] }> = [];
      const measured = { exec: (statement: string, ...bindings: SqlStorageValue[]) => {
        if (statement.startsWith('SELECT ') && statement.includes('FROM rated_result_checks WHERE')) lookups.push({ statement, bindings });
        return sql.exec(statement, ...bindings);
      } } as unknown as SqlStorage;
      const started = performance.now();
      const work = recordFarmingCheck(measured, game, now)!;
      const elapsedMs = performance.now() - started;
      const plans = lookups.flatMap(query => sql.exec<{ detail: string }>('EXPLAIN QUERY PLAN ' + query.statement, ...query.bindings).toArray().map(row => row.detail));
      const duplicate = recordFarmingCheck(sql, game, now);
      return { work, elapsedMs, plans, duplicate };
    });
    expect(observed.work).toMatchObject({ complete: true, candidateRows: 4_000, updatedChecks: 1_000 });
    // SQLite also counts an empty indexed seek; the six lookups have a fixed allowance.
    expect(observed.work.rowsRead).toBeLessThanOrEqual(4_006);
    expect(observed.plans.every(plan => plan.startsWith('SEARCH ') && plan.includes('USING INDEX rated_check_'))).toBe(true);
    expect(observed.duplicate).toMatchObject({ duplicate: true, candidateRows: 0, rowsRead: 0, updatedChecks: 0 });
    console.info('farming dense 1000', { ...observed.work, elapsedMs: observed.elapsedMs, plans: observed.plans });
  });

  it('keeps the basic record and discloses incomplete coverage when a sentinel exceeds the bound', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const now = Date.now();
    const observed = await runInDurableObject(competition, (_instance, state) => {
      const sql = state.storage.sql;
      for (let index = 0; index < 1_000; index++) storeCheck(sql, between('over-a', 'over-b', now));
      const game = between('over-a', 'over-b', now, { outcome: { winner: 'w', score: 1, reason: 'resignation' }, plies: 4 });
      const work = recordFarmingCheck(sql, game, now);
      const source = sql.exec<{ patterns_json: string }>('SELECT patterns_json FROM rated_result_checks WHERE game_id=?', game.id).one();
      return { work, source, modifiedPeers: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM rated_result_checks WHERE game_id<>? AND patterns_json<>'[]'", game.id).one().count, status: farmingStatus(sql) };
    });
    expect(observed.work).toMatchObject({ complete: false, reason: 'candidate-limit', candidateRows: 1_001, updatedChecks: 0 });
    expect(observed.work!.rowsRead).toBeLessThanOrEqual(2_002);
    expect(observed.source.patterns_json).toBe('["early-resignation"]');
    expect(observed.modifiedPeers).toBe(0);
    expect(observed.status.coverage).toMatchObject({ complete: false, pending: false, incomplete: 1, reasons: { 'candidate-limit': 1 } });
    console.info('farming guard 1001', observed.work);
  });

  it('upgrades v1 through at most eight checks per maintenance call and resumes after restart', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    const now = Date.now();
    await runInDurableObject(competition, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE rated_result_checks');
      sql.exec(`CREATE TABLE rated_result_checks
        (game_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,terminal_digest TEXT NOT NULL,policy TEXT NOT NULL,
          pair_key TEXT NOT NULL,winner_id TEXT,reason TEXT NOT NULL,plies INTEGER NOT NULL,ended_at INTEGER NOT NULL,
          patterns_json TEXT NOT NULL,checked_at INTEGER NOT NULL)`);
      for (let index = 0; index < 10; index++) {
        const game = between('legacy-a-' + index, 'legacy-b-' + index, now, { id: 'legacy-' + String(index).padStart(2, '0') });
        storeCheck(sql, game, true, index !== 9);
      }
      initializeFarmingChecks(sql);
    });
    expect((await competition.health()).farming.coverage).toMatchObject({ complete: false, pending: true, incomplete: 0 });
    expect((await competition.maintenance()).errors).toEqual([]);
    const first = await runInDurableObject(competition, (_instance, state) => ({
      done: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM rated_result_checks WHERE coverage='complete'").one().count,
      cursor: state.storage.sql.exec<{ cursor: string }>('SELECT cursor FROM rated_farming_upgrade WHERE policy=?', FARMING_POLICY).one().cursor,
    }));
    expect(first).toEqual({ done: 8, cursor: 'legacy-07' });
    await evictDurableObject(competition);
    expect((await competition.health()).farming.coverage.pending).toBe(true);
    expect((await competition.maintenance()).errors).toEqual([]);
    expect((await competition.health()).farming).toMatchObject({ checked: 10, coverage: {
      complete: false, pending: false, incomplete: 1, reasons: { 'source-unavailable': 1 },
    } });
  });

  it('checks a finished result before its rating settlement waits for repair', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    await enableRanked(competition);
    const [a, b] = await Promise.all([player(), player()]);
    await competition.joinQueue(a, 'blitz');
    let queued = await competition.joinQueue(b, 'blitz');
    if (queued.status === 'queued') {
      await runInDurableObject(competition, (_instance, state) => { state.storage.sql.exec('UPDATE queue SET joined_at=?', Date.now() - 120_000); });
      queued = await competition.queueStatus(b);
    }
    if (queued.status !== 'reserved' && queued.status !== 'live') throw new Error('Expected a reserved ranked game.');
    const board = env.GAME.get(env.GAME.idFromName(queued.gameId));
    await enableRanked(board);
    const initial = await board.snapshot(a);
    const white = initial.white.id === a.id ? a : b;
    const black = initial.white.id === a.id ? b : a;
    const first = await board.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
    if (!first.ok) throw new Error(first.code);
    const active = await board.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
    if (!active.ok) throw new Error(active.code);
    await runInDurableObject(competition, (_instance, state) => { state.storage.sql.exec("INSERT INTO meta(key,value) VALUES('paused:blitz','1')"); });
    const ended = await board.command(black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: active.snapshot.version });
    if (!ended.ok) throw new Error(ended.code);
    const accepted = await competition.settle((await board.status())!.result!);
    const observed = await runInDurableObject(competition, (_instance, state) => ({ accepted,
      status: farmingStatus(state.storage.sql), pending: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending_results').one().count,
    }));
    expect(observed).toMatchObject({ accepted: { accepted: true, pending: true }, pending: 1,
      status: { checked: 1, coverage: { complete: true }, patterns: { 'early-resignation': 1 } } });
  });
});
