import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextReconcileAt } from '../src/server/events';
import type { Competition } from '../src/server/competition';
import type { ArenaActionResult, ArenaMe } from '../src/shared/arenas';
import { activeGame, gamesAnswering, heldCompetition, holdAlarms, intercept, patchBindings, player } from './authority-helpers';

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

/** A D1 that fails statements containing `fail` (the empty string matches every one), or every batch while `batch` is set. Each failure records its time. */
interface Flaky { fail: string | null; batch: boolean; attempts: number[] }

const ANY_STATEMENT = '';
/** A whole D1 outage. */
const outage = (d1: Flaky, down: boolean) => { d1.fail = down ? ANY_STATEMENT : null; d1.batch = down; };

const ARENAS = { ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true' } as const;

/** An arena with `players` registered and none queued, on a mocked clock. Its alarms are real, so the stored alarm is what the platform would wake for. */
async function arena(players: number) {
  const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++index * 240 * HOUR + 120 * HOUR;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 600_000);
  const competition: Authority = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  open.push(competition);
  const d1: Flaky = { fail: null, batch: false, attempts: [] };
  const failure = () => { d1.attempts.push(Date.now()); return new Error('d1_unavailable'); };
  await patchBindings(competition, ({ DB }) => ({ ...ARENAS, DB: intercept(DB, {
    prepare: (sql: string) => { if (d1.fail !== null && sql.includes(d1.fail)) throw failure(); return DB.prepare(sql); },
    batch: (statements: D1PreparedStatement[]) => { if (d1.batch) throw failure(); return DB.batch(statements); },
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
    ['an event cleanup proof read', async ({ competition, startsAt, clock, d1 }) => {
      clock.mockReturnValue(startsAt);
      await competition.maintenance();
      // The event closes and publishes. Its rows are due for cleanup a week later.
      await wake(competition, clock, startsAt + 70 * MINUTE);
      const { due } = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ due: number }>(
        'SELECT MIN(cleanup_after) AS due FROM arena_events').one());
      clock.mockReturnValue(due);
      d1.fail = 'FROM arena_final_archives';
    }, 1],
  ];

  it.each(failures)('spaces out %s from a second up to a minute', async (_name, fail, players) => {
    const setup = await arena(players);
    await fail(setup);
    const wakes = await wake(setup.competition, setup.clock, Date.now() + 10 * MINUTE);
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

  it('backs off a whole failing pass while work is due, then resumes its cadence once D1 answers', async () => {
    const { competition, actors, id, startsAt, clock, d1 } = await arena(3);
    for (const actor of actors.slice(0, 2)) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    await wake(competition, clock, startsAt + 5 * SECOND);
    value(await competition.queueArena(actors[2], id));
    await wake(competition, clock, startsAt + 8 * SECOND);
    // One game is live and a third player waits. Pairing reads D1 before the game read that comes due during the outage.
    outage(d1, true);
    const wakes = await wake(competition, clock, Date.now() + 10 * MINUTE);
    const spacing = gaps(wakes);
    expect(spacing[0]).toBe(SECOND);
    expect(spacing).toEqual([...spacing].sort((a, b) => a - b));
    expect(Math.max(...spacing)).toBe(MINUTE);
    expect(wakes.length).toBeLessThanOrEqual(16);
    const due = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ due: number }>(
      "SELECT MIN(next_at) AS due FROM arena_intents WHERE status IN ('live','settling')").one().due);
    expect(due).toBeLessThanOrEqual(Date.now());
    outage(d1, false);
    const resumed = await wake(competition, clock, Date.now() + 2 * MINUTE);
    // The first pass settles the game and releases both players. Then the waiting player's one second cadence is back.
    expect(gaps(resumed).slice(2, 7)).toEqual(Array(5).fill(SECOND));
    expect((await Promise.all(actors.map(actor => competition.getArenaMe(actor, id)))).map(me => me?.state)).toEqual(['paused', 'paused', 'queued']);
    // A pass that succeeded starts the count over.
    outage(d1, true);
    expect(gaps(await wake(competition, clock, Date.now() + 10 * SECOND)).slice(0, 3)).toEqual([SECOND, 2 * SECOND, 4 * SECOND]);
  });

  it('keeps a request that lands during a failed pass from arming the alarm inside its backoff', async () => {
    const { competition, actors, id, startsAt, clock, d1 } = await arena(1);
    value(await competition.queueArena(actors[0], id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    outage(d1, true);
    for (const wait of [SECOND, 2 * SECOND]) {
      const failedAt = Date.now();
      await competition.maintenance();
      await runInDurableObject(competition, (_instance, state) => state.storage.setAlarm(failedAt + 1));
      await competition.listTournaments();
      expect(await alarm(competition)).toBe(failedAt + wait);
      clock.mockReturnValue(failedAt + wait);
    }
  });

  it('keeps the one second pairing cadence while a ranked game read keeps failing on its own half minute retry', async () => {
    const { competition, actors, id, startsAt, clock } = await arena(1);
    value(await competition.queueArena(actors[0], id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(`INSERT INTO matches(id,reservation_id,pool,white_id,black_id,
      white_actor,black_actor,status,created_at,next_attempt_at) VALUES(?,?,'blitz',?,?,'{}','{}','live',?,?)`,
    crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), startsAt, startsAt));
    await patchBindings(competition, gamesAnswering(() => ({ status: async () => { throw new Error('game_unreachable'); } })));
    expect((await competition.maintenance()).errors).toEqual(['reconciliation']);
    expect((await wake(competition, clock, startsAt + MINUTE)).length).toBeGreaterThanOrEqual(55);
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

/** Runs `attempt` at each retry time and returns how long each failure waited, until `count` failures. */
async function waits(clock: ReturnType<typeof vi.spyOn>, count: number, attempt: () => Promise<number | null>): Promise<number[]> {
  const waited: number[] = [];
  while (waited.length < count) {
    const next = await attempt();
    if (next === null) continue;
    waited.push(next - Date.now());
    clock.mockReturnValue(next);
  }
  return waited;
}

const TWO_SECONDS_UP_TO_A_MINUTE = [2, 4, 8, 16, 32, 60, 60].map(seconds => seconds * SECOND);

describe('other failure retries back off the same way', () => {
  it('spaces out a failing outbox row', async () => {
    const competition = await heldCompetition();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    // An unreadable projection fails on every attempt without a D1 fault.
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec("INSERT INTO outbox(id,payload,next_attempt_at) VALUES('broken','{}',0)"));
    expect(await waits(clock, 7, async () => {
      await competition.flush();
      return runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ next: number }>('SELECT next_attempt_at AS next FROM outbox').one().next);
    })).toEqual(TWO_SECONDS_UP_TO_A_MINUTE);
  });

  it('spaces out a ranked match that cannot be created', async () => {
    const competition = await heldCompetition({ RANKED_ENABLED: 'true' });
    await patchBindings(competition, gamesAnswering(() => ({ init: async () => { throw new Error('init_unavailable'); } })));
    const [a, b] = await Promise.all([player(), player()]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await competition.joinQueue(a, 'blitz', 'test');
    expect(await competition.joinQueue(b, 'blitz', 'test')).toMatchObject({ status: 'reserved' });
    const next = () => runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ next: number }>('SELECT next_attempt_at AS next FROM matches').one().next);
    let first = true;
    expect(await waits(clock, 7, async () => {
      // The pairing's own creation attempt already failed once.
      if (!first) await competition.maintenance();
      first = false;
      return next();
    })).toEqual(TWO_SECONDS_UP_TO_A_MINUTE);
  });

  it('spaces out a result a Game cannot deliver', async () => {
    const { game, white, snapshot } = await activeGame();
    await holdAlarms(game);
    await patchBindings(game, { COMPETITION: intercept(env.COMPETITION, { get: () => ({ settle: async () => { throw new Error('competition_unavailable'); } }) }) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const ended = await game.command(white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    expect(ended.ok).toBe(true);
    const delivery = () => runInDurableObject(game, (_instance, state) => JSON.parse(state.storage.sql.exec<{ value: string }>(
      'SELECT value FROM result_delivery').one().value) as { attempts: number; nextAttemptAt: number });
    let tried = 0;
    expect(await waits(clock, 7, async () => {
      await game.flush();
      const { attempts, nextAttemptAt } = await delivery();
      if (attempts === tried) return null;
      tried = attempts;
      return nextAttemptAt;
    })).toEqual(TWO_SECONDS_UP_TO_A_MINUTE);
  });

  it('spaces out a tournament recovery from half a minute to a minute, and starts over after a success', async () => {
    const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++index * 240 * HOUR;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 10 * MINUTE);
    const competition = await heldCompetition({ TOURNAMENTS_ENABLED: 'true', ARENAS_ENABLED: 'false' });
    let fail = true;
    await patchBindings(competition, ({ DB }) => ({ DB: intercept(DB, { prepare: (sql: string) => {
      if (fail && sql.includes('INSERT INTO tournament_account_locks')) throw new Error('d1_unavailable');
      return DB.prepare(sql);
    } }) }));
    const id = `hourly-${startsAt}`;
    await competition.listTournaments();
    for (const actor of await Promise.all([player(), player(), player()])) expect((await competition.registerTournament(actor, id)).ok).toBe(true);
    const saved = () => runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ next_at: number; value: string }>(
      'SELECT next_at,value FROM tournaments WHERE id=?', id).one());
    clock.mockReturnValue(startsAt);
    expect(await waits(clock, 5, async () => {
      await competition.maintenance();
      return (await saved()).next_at;
    })).toEqual([30, 60, 60, 60, 60].map(seconds => seconds * SECOND));
    fail = false;
    await competition.maintenance();
    const recovered = JSON.parse((await saved()).value);
    expect(recovered.status).toBe('running');
    expect(recovered).not.toHaveProperty('failures');
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
