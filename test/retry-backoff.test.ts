import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextReconcileAt } from '../src/server/events';
import type { Competition } from '../src/server/competition';
import type { ArenaActionResult, ArenaMe } from '../src/shared/arenas';
import { gamesAnswering, intercept, patchBindings, player } from './authority-helpers';

type Authority = DurableObjectStub<Competition>;
const HOUR = 3_600_000;
const SECOND = 1_000;
const MINUTE = 60_000;
const CLAIM = 'INSERT INTO tournament_account_locks';
const RELEASE = 'DELETE FROM tournament_account_locks';
let index = 0;
const open: Authority[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // These alarms carry mocked future times; leave none behind.
  for (const stub of open.splice(0)) await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
});

function value(result: ArenaActionResult): ArenaMe {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

/** A D1 that fails statements containing `fail`, or every standings write while `batch` is set. Each failure records its time. */
interface Flaky { fail: string | null; batch: boolean; attempts: number[] }

const ARENAS = { ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true' } as const;

/** An arena with `players` registered and none queued, on a mocked clock. Its alarms are real, so the stored alarm is what the platform would wake for. */
async function arena(players: number) {
  const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++index * 240 * HOUR + 120 * HOUR;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 600_000);
  const competition: Authority = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  open.push(competition);
  const d1: Flaky = { fail: null, batch: false, attempts: [] };
  const outage = () => { d1.attempts.push(Date.now()); return new Error('d1_unavailable'); };
  await patchBindings(competition, ({ DB }) => ({ ...ARENAS, DB: intercept(DB, {
    prepare: (sql: string) => { if (d1.fail && sql.includes(d1.fail)) throw outage(); return DB.prepare(sql); },
    batch: (statements: D1PreparedStatement[]) => { if (d1.batch) throw outage(); return DB.batch(statements); },
  }) }));
  const actors = await Promise.all(Array.from({ length: players }, () => player(false, { recoveryEmail: false })));
  const id = `arena-hourly-${startsAt}`;
  for (const actor of actors) value(await competition.registerArena(actor, id));
  return { competition, actors, id, startsAt, clock, d1 };
}

type Arena = Awaited<ReturnType<typeof arena>>;

const alarm = (competition: Authority) => runInDurableObject(competition, (_instance, state) => state.storage.getAlarm());

/** Delivers each alarm at its due time, as the platform would, and returns the wake times before `until`. */
async function wake(competition: Authority, clock: ReturnType<typeof vi.spyOn>, until: number): Promise<number[]> {
  const times: number[] = [];
  for (let due = await alarm(competition); due !== null && due < until; due = await alarm(competition)) {
    if (times.length > 400) throw new Error('alarm is polling');
    clock.mockReturnValue(Math.max(Date.now(), due));
    times.push(Date.now());
    await competition.maintenance();
  }
  clock.mockReturnValue(until);
  return times;
}

const gaps = (times: number[]) => times.slice(1).map((time, at) => time - times[at]);

/** Starts the arena with one entry whose claim fails. */
async function failingClaim({ competition, actors, id, startsAt, clock, d1 }: Arena) {
  d1.fail = CLAIM;
  value(await competition.queueArena(actors[0], id));
  clock.mockReturnValue(startsAt);
  await competition.maintenance();
}

describe('retries that keep failing back off', () => {
  // Ten minutes of one failing dependency took 600 attempts and about 600 wakeups at a fixed second.
  const failures: [string, (setup: Arena) => Promise<void>, number][] = [
    ['an entry claim', failingClaim, 1],
    ['an entry release', async ({ competition, actors, id, startsAt, clock, d1 }) => {
      value(await competition.queueArena(actors[0], id));
      clock.mockReturnValue(startsAt);
      await competition.maintenance();
      d1.fail = RELEASE;
      value(await competition.pauseArena(actors[0], id));
      await competition.maintenance();
    }, 1],
    ['a game allocation', async ({ competition, actors, id, startsAt, clock, d1 }) => {
      d1.fail = 'INSERT INTO tournament_game_admissions';
      for (const actor of actors) value(await competition.queueArena(actor, id));
      clock.mockReturnValue(startsAt);
      await competition.maintenance();
    }, 2],
    ['a standings publication', async ({ competition, startsAt, clock, d1 }) => {
      d1.batch = true;
      clock.mockReturnValue(startsAt);
      await competition.maintenance();
    }, 2],
    ['a public page cleanup', async ({ competition, id, startsAt, clock, d1 }) => {
      clock.mockReturnValue(startsAt);
      await competition.maintenance();
      await wake(competition, clock, startsAt + 3 * SECOND);
      d1.fail = 'SELECT event_id,generation,page_number FROM arena_public_pages';
      // A new standings version publishes, and each publication asks for one more sweep.
      value(await competition.registerArena(await player(false, { recoveryEmail: false }), id));
    }, 1],
  ];

  it.each(failures)('spaces out %s from a second up to a minute', async (_name, fail, players) => {
    const setup = await arena(players);
    await fail(setup);
    const wakes = await wake(setup.competition, setup.clock, setup.startsAt + 10 * MINUTE);
    const spacing = gaps(setup.d1.attempts);
    expect(spacing[0]).toBe(SECOND);
    expect(spacing).toEqual([...spacing].sort((a, b) => a - b));
    expect(Math.max(...spacing)).toBe(MINUTE);
    expect(setup.d1.attempts.length).toBeLessThanOrEqual(16);
    expect(wakes.length).toBeLessThanOrEqual(30);
  });

  it('recovers a single failed claim within a second', async () => {
    const setup = await arena(1);
    await failingClaim(setup);
    setup.d1.fail = null;
    expect(setup.d1.attempts).toEqual([setup.startsAt]);
    expect((await alarm(setup.competition))! - setup.startsAt).toBeLessThanOrEqual(SECOND);
    setup.clock.mockReturnValue(setup.startsAt + SECOND);
    await setup.competition.maintenance();
    expect(await setup.competition.getArenaMe(setup.actors[0], setup.id)).toMatchObject({ state: 'queued' });
  });

  it('starts over at a second after a success', async () => {
    const setup = await arena(1);
    const { competition, actors, id, startsAt, clock, d1 } = setup;
    await failingClaim(setup);
    // Five failures leave the next claim half a minute away.
    await wake(competition, clock, startsAt + 20 * SECOND);
    expect(d1.attempts).toHaveLength(5);
    d1.fail = null;
    await wake(competition, clock, startsAt + 40 * SECOND);
    expect(await competition.getArenaMe(actors[0], id)).toMatchObject({ state: 'queued' });
    d1.fail = RELEASE;
    d1.attempts.length = 0;
    value(await competition.pauseArena(actors[0], id));
    await competition.maintenance();
    await wake(competition, clock, startsAt + 50 * SECOND);
    expect(gaps(d1.attempts).slice(0, 3)).toEqual([SECOND, 2 * SECOND, 4 * SECOND]);
  });

  it('keeps the one second pairing cadence for a waiting player while another entry backs off', async () => {
    const { competition, actors, id, startsAt, clock, d1 } = await arena(2);
    value(await competition.queueArena(actors[0], id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    d1.fail = CLAIM;
    value(await competition.queueArena(actors[1], id));
    await competition.maintenance();
    const wakes = await wake(competition, clock, startsAt + MINUTE);
    expect(wakes.length).toBeGreaterThanOrEqual(55);
    expect(d1.attempts.length).toBeLessThanOrEqual(7);
    expect(await competition.getArenaMe(actors[0], id)).toMatchObject({ state: 'queued' });
  });

  it('backs off a game past its deadline that still reports no result', async () => {
    const { competition, actors, id, startsAt, clock } = await arena(2);
    for (const actor of actors) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    await wake(competition, clock, startsAt + 5 * SECOND);
    const read = () => runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ status: string; next_at: number; deadline_at: number }>(
      'SELECT status,next_at,deadline_at FROM arena_intents').one());
    const { deadline_at: deadline } = await read();
    await patchBindings(competition, gamesAnswering(game => ({
      status: async () => { const reply = await game.status(); return reply && { ...reply, status: 'active', result: null }; },
    })));
    const waits: number[] = [];
    for (clock.mockReturnValue(deadline); waits.length < 8; clock.mockReturnValue(Date.now() + waits.at(-1)!)) {
      await competition.maintenance();
      const intent = await read();
      expect(intent.status).not.toBe('finished');
      waits.push(intent.next_at - Date.now());
    }
    expect(waits).toEqual([SECOND, 2 * SECOND, 4 * SECOND, 8 * SECOND, 16 * SECOND, 32 * SECOND, MINUTE, MINUTE]);
  });

  it('adds the failure count to entries saved by an earlier build', async () => {
    const { competition, actors, id, startsAt, clock } = await arena(1);
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('ALTER TABLE arena_entries DROP COLUMN attempts'));
    await evictDurableObject(competition);
    await patchBindings(competition, ARENAS);
    clock.mockReturnValue(startsAt);
    expect(value(await competition.queueArena(actors[0], id))).toMatchObject({ state: 'reserving' });
    await competition.maintenance();
    expect(await competition.getArenaMe(actors[0], id)).toMatchObject({ state: 'queued' });
    const rows = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ attempts: number }>(
      'SELECT attempts FROM arena_entries').toArray());
    expect(rows).toEqual([{ attempts: 0 }]);
  });
});

describe('polling a Game whose due time has passed', () => {
  it('waits as long as it has been overdue, from a second up to a minute', () => {
    const due = 1_000_000;
    let now = due;
    const waits: number[] = [];
    for (let poll = 0; poll < 9; poll++) {
      const next = nextReconcileAt(now, due);
      waits.push(next - now);
      now = next;
    }
    expect(waits).toEqual([SECOND, SECOND, 2 * SECOND, 4 * SECOND, 8 * SECOND, 16 * SECOND, 32 * SECOND, MINUTE, MINUTE]);
  });

  it('still reads at a future due time and within five minutes of anything later', () => {
    expect(nextReconcileAt(1_000, 1_000 + 7 * SECOND)).toBe(1_000 + 7 * SECOND);
    expect(nextReconcileAt(1_000, 1_000 + HOUR)).toBe(1_000 + 5 * MINUTE);
    expect(nextReconcileAt(1_000, null)).toBe(1_000 + 5 * MINUTE);
  });
});
