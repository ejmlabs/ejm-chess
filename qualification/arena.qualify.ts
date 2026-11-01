import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { readArenaStandings, readArenaSummary } from '../src/server/arena-projection';
import type { Competition } from '../src/server/competition';
import { GAME_HOT_RETENTION_MS } from '../src/server/game';
import { nextRetirementAt } from '../src/server/maintenance';
import type { Actor, GameResult, GameSnapshot } from '../src/shared/protocol';
import type { ArenaActionResult } from '../src/shared/arenas';
import { holdAlarms, patchBindings, player, swapBindings } from '../test/authority-helpers';
import { authorityBindings } from './isolation';

type Authority = DurableObjectStub<Competition>;
type Intent = { game_id: string; white_actor: string; black_actor: string };

async function parallel<T, R>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

function timing(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? 0 };
}

function accepted(reply: ArenaActionResult) {
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.value;
}

// The harness controls lifecycle and failure boundaries explicitly. This
// does not qualify provider alarm delivery or wall-clock scheduling.
const configure = (competition: Authority) => holdAlarms(competition, { ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'false',
  ARENA_ENTRANT_LIMIT: '2000', ARENA_GAME_LIMIT: '1000', ARENA_RETAINED_GAME_LIMIT: '2000', ARENA_AUTHORITY_BYTE_LIMIT: '2147483648' });

async function intents(competition: Authority, id: string): Promise<Intent[]> {
  return runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<Intent>(
    'SELECT game_id,white_actor,black_actor FROM arena_intents WHERE event_id=? ORDER BY game_id', id).toArray());
}

it('qualifies bounded native arena admission, game authority, sockets, scoring, and paged recovery', async ({ task }) => {
  const count = __QUALIFICATION_ENTRANTS__;
  if (!Number.isInteger(count) || count < 4 || count > 2_000 || count % 2) throw new Error('Use an even entrant count from 4 to 2000.');
  const targetGames = count / 2;
  const startsAt = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const registrationAt = startsAt - 600_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(registrationAt);
  const authorityName = crypto.randomUUID();
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName(authorityName));
  const id = `arena-hourly-${startsAt}`;
  const sockets: WebSocket[] = [];
  const report: Record<string, unknown> = {
    kind: 'native-arena-local', entrants: count, targetGames,
    policyClock: 'Virtual registration arrivals and cadence; elapsed service times use performance.now().',
    auth: 'Existing credential-backed D1 fixtures; no signup, password hashing, HTTP, Turnstile, or email load.',
    environment: 'Local Cloudflare Vitest/workerd with real SQLite/D1 and Game Durable Objects; no WAN or Cloudflare region.',
  };
  task.meta.qualification = report;
  try {
    await configure(competition);
    const fixtureStart = performance.now();
    const actors = await parallel(Array.from({ length: count }), 16, () => player(false, { recoveryEmail: false }));
    report.fixtureMs = performance.now() - fixtureStart;
    const replies: Record<string, number> = {};
    const registered = new Set<string>();
    const samples: number[] = [];
    const registrationStart = performance.now();
    const attempts = count * 5;
    for (let offset = 0; offset < attempts; offset += 32) {
      clock.mockReturnValue(registrationAt + Math.floor(offset * 3));
      await parallel(Array.from({ length: Math.min(32, attempts - offset) }, (_, index) => actors[(offset + index) % count]), 32, async actor => {
        const before = performance.now();
        const reply = await competition.registerArena(actor, id);
        samples.push(performance.now() - before);
        const key = reply.ok ? 'accepted-or-duplicate' : reply.error.code;
        replies[key] = (replies[key] ?? 0) + 1;
        if (reply.ok) registered.add(actor.id);
        else expect(reply.error.code).toBe('ARENA_RETRY');
      });
    }
    const initiallyRegistered = registered.size;
    // Retry the same accounts at the published 50/sec logical admission rate.
    let retryAt = registrationAt + attempts * 3 + 1_000;
    for (const actor of actors.filter(actor => !registered.has(actor.id))) {
      retryAt += 20;
      clock.mockReturnValue(retryAt);
      accepted(await competition.registerArena(actor, id));
      registered.add(actor.id);
    }
    expect(registered.size).toBe(count);
    report.registration = { requests: attempts, logicalArrivalMs: attempts * 3, initiallyRegistered,
      acceptedAfterRetry: registered.size, responses: replies, elapsedMs: performance.now() - registrationStart,
      latency: timing(samples), scope: 'Virtual-time rate-limit correctness. Not an end-to-end registrations/sec claim.' };
    const entrantRows = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM arena_entries WHERE event_id=?', id).one().count);
    expect(entrantRows).toBe(count);
    const extra = await player(false, { recoveryEmail: false });
    if (count === 2_000) expect(await competition.registerArena(extra, id)).toMatchObject({ ok: false, error: { code: 'ARENA_FULL' } });
    for (const actor of actors) accepted(await competition.queueArena(actor, id));
    const queueDurable = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM arena_entries WHERE event_id=? AND state='claiming'", id).one().count);
    expect(queueDurable).toBe(count);
    await evictDurableObject(competition);
    await configure(competition);
    const pairingStart = performance.now();
    let tick = startsAt;
    let passes = 0;
    let games: Intent[] = [];
    for (; passes < 512; passes++) {
      clock.mockReturnValue(tick);
      const result = await competition.maintenance();
      expect(result.errors).toEqual([]);
      tick += 125;
      const live = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM arena_intents WHERE event_id=? AND status='live'", id).one().count);
      if (live === targetGames) { games = await intents(competition, id); break; }
    }
    expect(games).toHaveLength(targetGames);
    const accountIds = games.flatMap(game => [JSON.parse(game.white_actor).id, JSON.parse(game.black_actor).id]);
    expect(new Set(accountIds).size).toBe(count);
    report.pairing = { games: games.length, maintenancePasses: passes + 1, elapsedMs: performance.now() - pairingStart,
      logicalElapsedMs: tick - startsAt, distinctPlayers: new Set(accountIds).size };
    const moves: number[] = [];
    const snapshots = await parallel(games, 16, async intent => {
      const white = JSON.parse(intent.white_actor) as Actor;
      const black = JSON.parse(intent.black_actor) as Actor;
      const game = env.GAME.get(env.GAME.idFromName(intent.game_id));
      await holdAlarms(game, authorityBindings(authorityName));
      let snapshot: GameSnapshot = await game.snapshot(white);
      for (const actor of [white, black]) {
        const reply = await game.command(actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version });
        expect(reply.ok).toBe(true); snapshot = reply.snapshot;
      }
      const before = performance.now();
      const reply = await game.command(white, { type: 'move', id: crypto.randomUUID(), expectedVersion: snapshot.version, from: 'e2', to: 'e4' });
      moves.push(performance.now() - before);
      expect(reply.ok).toBe(true);
      expect(reply.snapshot.status).toBe('active');
      return { intent, white, black, game, snapshot: reply.snapshot };
    });
    report.moves = { ...timing(moves), scope: 'Native private-binding service latency with 16 games in flight; includes RPC/commit, excludes WAN; CPU unmeasured.' };
    const connectTimes: number[] = [];
    const participants = snapshots.flatMap(context => [context.white, context.black].map(actor => ({ ...context, actor })));
    async function connect(context: typeof participants[number]) {
      const before = performance.now();
      const response = await context.game.fetch('https://game.internal/connect', { headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(context.actor) } });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept(); sockets.push(socket);
      connectTimes.push(performance.now() - before);
    }
    await parallel(participants, 32, connect);
    const nativeSockets = await parallel(snapshots, 16, context => runInDurableObject(context.game, (_instance, state) => state.getWebSockets().length));
    expect(nativeSockets.every(count => count === 2)).toBe(true);
    const reconnectStart = performance.now();
    await parallel(participants, 32, connect);
    report.connections = { simultaneousParticipantSockets: count, totalUpgrades: connectTimes.length,
      reconnects: count, reconnectElapsedMs: performance.now() - reconnectStart, latency: timing(connectTimes),
      scope: 'Native authenticated private-binding upgrades, including a replacement burst; no public edge/WAN or provider hibernation claim.' };
    for (const socket of sockets) socket.close(1000, 'Qualification complete.');
    const results = await parallel(snapshots, 16, async context => {
      const reply = await context.game.command(context.black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: context.snapshot.version });
      expect(reply.ok).toBe(true);
      const result = (await context.game.status())!.result;
      expect(result).not.toBeNull();
      return result!;
    });
    await evictDurableObject(competition);
    await configure(competition);
    const settlements: number[] = [];
    const settleStart = performance.now();
    await parallel(results, 16, async result => {
      const before = performance.now();
      expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
      settlements.push(performance.now() - before);
    });
    const settleMs = performance.now() - settleStart;
    const duplicatesStart = performance.now();
    await parallel(results.flatMap(result => Array.from({ length: 5 }, () => result)), 32, async result => {
      expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    });
    const accounting = await runInDurableObject(competition, (_instance, state) => ({
      receipts: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_receipts WHERE event_id=?', id).one().count,
      pointsHalf: state.storage.sql.exec<{ sum: number }>('SELECT SUM(points_half) AS sum FROM arena_entries WHERE event_id=?', id).one().sum,
      games: state.storage.sql.exec<{ sum: number }>('SELECT SUM(games) AS sum FROM arena_entries WHERE event_id=?', id).one().sum,
      unresolved: state.storage.sql.exec<{ unresolved: number }>('SELECT unresolved FROM arena_events WHERE id=?', id).one().unresolved,
      bytes: state.storage.sql.databaseSize,
    }));
    expect(accounting).toMatchObject({ receipts: targetGames, pointsHalf: targetGames * 2, games: count, unresolved: 0 });
    report.settlement = { unique: results.length, elapsedMs: settleMs, uniquePerSecond: results.length / settleMs * 1_000,
      latency: timing(settlements), duplicates: results.length * 5, duplicateElapsedMs: performance.now() - duplicatesStart,
      accounting, scope: 'Native terminal Game verification plus atomic authority acceptance. D1 projection/release measured separately. Not the 15-minute sustained admission workload.' };
    await parallel(snapshots, 16, context => runInDurableObject(context.game, async (instance, state) => {
      swapBindings(instance, authorityBindings(authorityName));
      await instance.flush();
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM result_delivery').one().count).toBe(0);
    }));
    const projectionStart = performance.now();
    let published = false;
    let projectionPasses = 0;
    for (; projectionPasses < 640; projectionPasses++) {
      tick += 125; clock.mockReturnValue(tick);
      expect((await competition.maintenance()).errors).toEqual([]);
      const summary = await readArenaSummary(env.DB, id);
      if (summary?.watermark === results.length) { published = true; break; }
    }
    expect(published).toBe(true);
    const standings: { id: string; points: number; rank: number }[] = [];
    let cursor: string | null = null;
    let generation: number | null = null;
    let pageCount = 0;
    do {
      const page = await readArenaStandings(env.DB, id, cursor);
      expect(page).not.toBeNull();
      if (generation !== null) expect(page!.generation).toBe(generation);
      generation = page!.generation;
      expect(page!.standings.length).toBeLessThanOrEqual(32);
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(32 * 1024);
      standings.push(...page!.standings); pageCount++; cursor = page!.nextCursor;
    } while (cursor);
    expect(standings).toHaveLength(count);
    expect(new Set(standings.map(row => row.id)).size).toBe(count);
    expect(standings.filter(row => row.points === 1).every(row => row.rank === 1)).toBe(true);
    expect(standings.filter(row => row.points === 0).every(row => row.rank === targetGames + 1)).toBe(true);
    const released = await env.DB.prepare('SELECT COUNT(*) AS count FROM tournament_account_locks WHERE tournament_id=?').bind(id).first('count');
    expect(released).toBe(0);
    report.projection = { pages: pageCount, generation, distinctEntrants: standings.length,
      maintenancePasses: projectionPasses + 1, elapsedMs: performance.now() - projectionStart,
      scope: 'Full D1 generation and reservation release after result burst. Not a spectator-cache or regional-lag benchmark.' };
    clock.mockReturnValue(startsAt + 3_600_000);
    for (let pass = 0; pass < 640; pass++) {
      expect((await competition.maintenance()).errors).toEqual([]);
      if ((await readArenaSummary(env.DB, id))?.status === 'finished') break;
    }
    expect(await readArenaSummary(env.DB, id)).toMatchObject({ status: 'finished', unresolvedGames: 0, provisional: false });
    report.finished = true;
    const sample = snapshots[0].game;
    const beforeRetirement = await runInDurableObject(sample, (_instance, state) => ({
      allocatedBytes: state.storage.sql.databaseSize,
      payloadBytes: state.storage.sql.exec<{ bytes: number }>('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM game_state').one().bytes,
      commandReceipts: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM command_receipts').one().count,
    }));
    const retirementAt = Math.max(...results.map(result => result.endedAt)) + GAME_HOT_RETENTION_MS;
    clock.mockReturnValue(retirementAt);
    await patchBindings(competition, { GAME_RETIREMENT_MODE: 'scaled' });
    const retirementStart = performance.now();
    let retired = 0;
    let warmupAt: number | null = null;
    const retirementPasses: number[] = [];
    while (retired < targetGames && performance.now() - retirementStart < 120_000) {
      clock.mockReturnValue(retirementAt + Math.floor(performance.now() - retirementStart));
      const before = performance.now();
      const pass = await competition.retirePayloads();
      retirementPasses.push(performance.now() - before);
      expect(pass.failed).toBe(0); retired += pass.completed;
      if (warmupAt === null && retired >= Math.min(32, targetGames)) warmupAt = performance.now();
      if (retired < targetGames) {
        const due = await nextRetirementAt({ ...env, GAME_RETIREMENT_MODE: 'scaled' }, Date.now());
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, (due ?? Date.now()) - Date.now()))));
      }
    }
    expect(retired).toBe(targetGames);
    const retirementMs = performance.now() - retirementStart;
    const steadyMs = performance.now() - (warmupAt ?? retirementStart);
    const afterRetirement = await runInDurableObject(sample, (_instance, state) => ({
      allocatedBytes: state.storage.sql.databaseSize,
      payloadRows: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM game_state').one().count,
      commandReceipts: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM command_receipts').one().count,
      tombstones: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM archived_game').one().count,
      tombstoneBytes: state.storage.sql.exec<{ bytes: number }>('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM archived_game').one().bytes,
    }));
    expect(afterRetirement).toMatchObject({ payloadRows: 0, commandReceipts: 0, tombstones: 1 });
    const ledgers = await env.DB.prepare(`SELECT COUNT(*) AS permanentIds,SUM(storage_state='archived') AS archived
      FROM tournament_game_admissions WHERE tournament_id=?`).bind(id).first();
    expect(ledgers).toEqual({ permanentIds: targetGames, archived: targetGames });
    report.retirement = { retired, elapsedMs: retirementMs, totalPerSecond: retired / retirementMs * 1_000,
      afterInitial32PerSecond: targetGames > 32 ? (retired - 32) / steadyMs * 1_000 : null,
      passLatency: timing(retirementPasses), sampleBefore: beforeRetirement, sampleAfter: afterRetirement, ledgers,
      scope: 'Native Game.archive and D1 acknowledgements. Explicit scaled mode, four RPCs in flight, persisted 32/sec token bucket. Retention jumps one logical hour; refill follows real elapsed time. One 1000-game batch does not establish 72000-payload steady-state storage or deployed cost. SQLite allocated pages may be retained for reuse.' };
    if (targetGames >= 1_000) expect((retired - 32) / steadyMs * 1_000).toBeGreaterThanOrEqual(25);
    report.unqualified = ['three simultaneous 2000-entry events', '20 unique settlements/sec for 15 minutes',
      '40 settlements/sec recovery while sustaining new traffic', '72000-payload hot-storage steady state',
      'public HTTP/account creation', '10,000 cached spectators', 'move CPU', 'provider resource memory', 'deployed regions', 'live cost'];
  } finally {
    for (const socket of sockets) { try { socket.close(1000, 'Qualification cleanup.'); } catch { /* Already closed. */ } }
    clock.mockRestore();
  }
});
