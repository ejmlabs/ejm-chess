import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { Actor, GameSnapshot } from '../src/shared/protocol';
import type { Env } from '../src/server/env';
import { readArenaStandings, readArenaSummary } from '../src/server/arena-projection';
import { holdAlarms, player } from '../test/authority-helpers';
import { authorityBindings } from './isolation';

type Intent = { game_id: string; event_id: string; white_actor: string; black_actor: string };

async function parallel<T, R>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; output[index] = await work(items[index], index); }
  }));
  return output;
}

it('qualifies three native 2000-entry events sharing 1000 games across both formats with restart and unavailable verification', async ({ task }) => {
  const perEvent = __QUALIFICATION_ENTRANTS__;
  const totalGames = perEvent / 2;
  const gamesPerEvent = [Math.floor(totalGames / 3), Math.floor(totalGames / 3), totalGames - Math.floor(totalGames / 3) * 2];
  const date = new Date();
  const sundayAt18 = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + (7 - date.getUTCDay()) % 7, 18);
  const registrationAt = sundayAt18 - 600_000;
  const events = [`arena-weekly-${sundayAt18 - 7_200_000}`, `arena-daily-${sundayAt18}`, `arena-hourly-${sundayAt18}`];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(registrationAt);
  const authorityName = crypto.randomUUID();
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName(authorityName));
  const configure = () => holdAlarms(competition, { ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'false',
    ARENA_ENTRANT_LIMIT: '2000', ARENA_GAME_LIMIT: '1000', ARENA_RETAINED_GAME_LIMIT: '2000', ARENA_AUTHORITY_BYTE_LIMIT: '2147483648' });
  async function intents() {
    return runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<Intent>(
      "SELECT game_id,event_id,white_actor,black_actor FROM arena_intents WHERE status='live' ORDER BY event_id,game_id").toArray());
  }
  const report: Record<string, unknown> = { kind: 'native-three-event-local', entrantsPerEvent: perEvent, distinctAccounts: perEvent * 3,
    totalGames, formats: ['blitz', 'rapid'],
    scope: 'Native D1/SQLite and Game DOs. Real cadence overlap: weekly rapid drains while daily rapid and hourly blitz start. Policy time is virtual; elapsed RPC times are measured. Existing credential-backed fixtures exclude signup, passwords, HTTP, provider alarms, WAN and cost.' };
  task.meta.qualification = report;
  try {
    await configure();
    const registrationStart = performance.now();
    const actors = await parallel(Array.from({ length: perEvent * 3 }), 16, () => player(false, { recoveryEmail: false }));
    for (let offset = 0; offset < actors.length; offset += 32) {
      clock.mockReturnValue(registrationAt + offset * 20);
      await parallel(actors.slice(offset, offset + 32), 32, async (actor, localIndex) => {
        const index = offset + localIndex;
        expect((await competition.registerArena(actor, events[Math.floor(index / perEvent)])).ok).toBe(true);
      });
    }
    report.registrationMs = performance.now() - registrationStart;
    for (let event = 0; event < events.length; event++) {
      const count = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM arena_entries WHERE event_id=?', events[event]).one().count);
      expect(count).toBe(perEvent);
    }
    for (const actor of actors.slice(0, gamesPerEvent[0] * 2)) expect((await competition.queueArena(actor, events[0])).ok).toBe(true);
    let tick = sundayAt18 - 60_000;
    async function advance(target: number) {
      for (let pass = 0; pass < 512; pass++) {
        clock.mockReturnValue(tick); tick += 125;
        expect((await competition.maintenance()).errors).toEqual([]);
        const games = await intents(); if (games.length === target) return games;
      }
      report.pairingFailure = await runInDurableObject(competition, (_instance, state) => ({
        events: state.storage.sql.exec('SELECT id,status,entrants,unresolved,reason FROM arena_events ORDER BY starts_at,id').toArray(),
        games: state.storage.sql.exec('SELECT event_id,status,COUNT(*) AS count FROM arena_intents GROUP BY event_id,status').toArray(),
        entries: state.storage.sql.exec('SELECT event_id,state,COUNT(*) AS count FROM arena_entries GROUP BY event_id,state').toArray(),
      }));
      throw new Error('native_pairing_did_not_reach_target');
    }
    async function readyAndMove(games: Intent[]) {
      return parallel(games, 16, async intent => {
        const white = JSON.parse(intent.white_actor) as Actor; const black = JSON.parse(intent.black_actor) as Actor;
        const game = env.GAME.get(env.GAME.idFromName(intent.game_id));
        await holdAlarms(game, authorityBindings(authorityName));
        let snapshot: GameSnapshot = await game.snapshot(white);
        for (const actor of [white, black]) {
          const reply = await game.command(actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version });
          expect(reply.ok).toBe(true); snapshot = reply.snapshot;
        }
        const before = performance.now();
        const reply = await game.command(white, { type: 'move', id: crypto.randomUUID(), expectedVersion: snapshot.version, from: 'e2', to: 'e4' });
        expect(reply.ok).toBe(true); expect(reply.snapshot.status).toBe('active');
        return { intent, white, black, game, snapshot: reply.snapshot, moveMs: performance.now() - before };
      });
    }
    const weekly = await readyAndMove(await advance(gamesPerEvent[0]));
    for (let event = 1; event < events.length; event++) {
      for (const actor of actors.slice(event * perEvent, event * perEvent + gamesPerEvent[event] * 2))
        expect((await competition.queueArena(actor, events[event])).ok).toBe(true);
    }
    tick = sundayAt18;
    const allIntents = await advance(totalGames);
    const games = [...weekly, ...await readyAndMove(allIntents.filter(intent => intent.event_id !== events[0]))];
    const states = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ id: string; status: string; entrants: number; unresolved: number }>(
      'SELECT id,status,entrants,unresolved FROM arena_events WHERE id IN (?,?,?) ORDER BY id', ...events).toArray());
    expect(states.filter(row => row.status === 'running')).toHaveLength(2);
    expect(states.filter(row => row.status === 'draining')).toHaveLength(1);
    expect(states.reduce((sum, row) => sum + row.unresolved, 0)).toBe(totalGames);
    expect(new Set(games.flatMap(game => [game.white.id, game.black.id])).size).toBe(totalGames * 2);
    for (const format of ['blitz', 'rapid']) {
      const values = games.filter(game => game.snapshot.format === format).map(game => game.moveMs).sort((a, b) => a - b);
      report[`${format}Moves`] = { samples: values.length, p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) };
    }
    report.overlap = states;
    const results = await parallel(games, 16, async context => {
      expect((await context.game.command(context.black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: context.snapshot.version })).ok).toBe(true);
      return (await context.game.status())!.result!;
    });
    await runInDurableObject(competition, async instance => {
      const internal = instance as unknown as { env: Env };
      internal.env = { ...internal.env, GAME: { idFromName: env.GAME.idFromName.bind(env.GAME),
        get: () => ({ status: async () => { throw new Error('injected_verification_outage'); } }) } as unknown as Env['GAME'] };
      let error: string | null = null;
      try { await instance.settle(results[0]); } catch (failure) { error = (failure as Error).message; }
      expect(error).toBe('injected_verification_outage');
    });
    await evictDurableObject(competition); await configure();
    const recoveryStart = performance.now();
    await parallel(results, 16, async result => { expect(await competition.settle(result)).toEqual({ accepted: true, pending: false }); });
    const recoveryMs = performance.now() - recoveryStart;
    await parallel(results.flatMap(result => Array.from({ length: 5 }, () => result)), 32, async result => {
      expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    });
    await parallel(games, 16, context => runInDurableObject(context.game, async (instance, state) => {
      await instance.flush();
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM result_delivery').one().count).toBe(0);
    }));
    for (let pass = 0; pass < 1_200; pass++) {
      clock.mockReturnValue(tick); tick += 125;
      expect((await competition.maintenance()).errors).toEqual([]);
      const done = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM arena_entries WHERE state='releasing'").one().count === 0
        && state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_events WHERE revision>projected_revision').one().count === 0);
      if (done) break;
    }
    const accounting = await runInDurableObject(competition, (_instance, state) => ({
      receipts: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_receipts').one().count,
      pointsHalf: state.storage.sql.exec<{ count: number }>('SELECT SUM(points_half) AS count FROM arena_entries').one().count,
      games: state.storage.sql.exec<{ count: number }>('SELECT SUM(games) AS count FROM arena_entries').one().count,
      bytes: state.storage.sql.databaseSize,
    }));
    expect(accounting).toMatchObject({ receipts: totalGames, pointsHalf: totalGames * 2, games: totalGames * 2 });
    const pageCounts: number[] = [];
    for (const id of events) {
      let cursor: string | null = null; let pages = 0; const seen = new Set<string>(); let generation: number | null = null;
      do {
        const page = await readArenaStandings(env.DB, id, cursor); expect(page).not.toBeNull();
        if (generation !== null) expect(page!.generation).toBe(generation); generation = page!.generation;
        expect(page!.standings.length).toBeLessThanOrEqual(32);
        expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(32 * 1024);
        for (const row of page!.standings) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); }
        cursor = page!.nextCursor; pages++;
      } while (cursor);
      expect(seen.size).toBe(perEvent); pageCounts.push(pages);
    }
    clock.mockReturnValue(sundayAt18 + 7_200_000);
    for (let pass = 0; pass < 1_200; pass++) {
      expect((await competition.maintenance()).errors).toEqual([]);
      const finished = await Promise.all(events.map(id => readArenaSummary(env.DB, id)));
      if (finished.every(event => event?.status === 'finished' && !event.provisional)) break;
    }
    for (const id of events) expect(await readArenaSummary(env.DB, id)).toMatchObject({ status: 'finished', provisional: false, unresolvedGames: 0 });
    report.recovery = { unique: totalGames, duplicates: totalGames * 5, elapsedMs: recoveryMs, uniquePerSecond: totalGames / recoveryMs * 1_000,
      scope: 'Real terminal Game verification after coordinator eviction and one injected binding outage; no simultaneous continuing traffic claim.' };
    report.accounting = accounting; report.standingsPages = pageCounts; report.finished = true; report.gameOutboxesDrained = totalGames;
    report.unqualified = ['public registration/accounts', 'provider alarms', 'WAN/regions', 'spectator cache', 'live cost'];
  } finally { clock.mockRestore(); }
});
