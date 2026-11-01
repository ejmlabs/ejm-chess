import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Competition } from '../src/server/competition';
import type { ArenaActionResult, ArenaMe } from '../src/shared/arenas';
import { patchBindings, player, privates } from './authority-helpers';

type Authority = DurableObjectStub<Competition>;
const HOUR = 3_600_000;
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

/** Real alarm scheduling, so the stored alarm is what the platform would wake for. */
async function running(options: { players: number; queued: number }) {
  const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++index * 240 * HOUR;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 600_000);
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  open.push(competition);
  await patchBindings(competition, { ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true' });
  const actors = await Promise.all(Array.from({ length: options.players }, () => player(false, { recoveryEmail: false })));
  const id = `arena-hourly-${startsAt}`;
  for (const actor of actors) value(await competition.registerArena(actor, id));
  for (const actor of actors.slice(0, options.queued)) value(await competition.queueArena(actor, id));
  clock.mockReturnValue(startsAt);
  await competition.maintenance();
  return { competition, actors, id, startsAt, clock, closesAt: startsAt + HOUR };
}

const alarm = (competition: Authority) => runInDurableObject(competition, (_instance, state) => state.storage.getAlarm());

/** Delivers each alarm at its due time, as the platform would, and counts the wakeups before `until`. */
async function wakeups(competition: Authority, clock: ReturnType<typeof vi.spyOn>, until: number): Promise<number> {
  let count = 0;
  for (let due = await alarm(competition); due !== null && due < until; due = await alarm(competition)) {
    if (++count > 400) throw new Error('alarm is polling');
    clock.mockReturnValue(Math.max(Date.now(), due));
    await competition.maintenance();
  }
  return count;
}

describe('arena alarm schedule', () => {
  it('sleeps an idle running arena until its close instead of waking every second', async () => {
    const { competition, actors, id, startsAt, clock, closesAt } = await running({ players: 2, queued: 0 });
    // The first second publishes the new events. After that nothing is due until the close.
    await wakeups(competition, clock, startsAt + 1_000);
    expect(await wakeups(competition, clock, startsAt + 120_000)).toBe(0);
    expect(await alarm(competition)).toBe(closesAt);
    clock.mockReturnValue(closesAt);
    await competition.maintenance();
    expect(await competition.getArenaMe(actors[0], id)).toMatchObject({ status: 'finished' });
  });

  it('retries pairing every second only while a player waits for an opponent', async () => {
    const { competition, actors, id, startsAt, clock, closesAt } = await running({ players: 3, queued: 1 });
    await wakeups(competition, clock, startsAt + 500);
    expect(await alarm(competition)).toBe(startsAt + 1_000);
    clock.mockReturnValue(startsAt + 1_000);
    value(await competition.pauseArena(actors[0], id));
    await competition.maintenance();
    expect(await wakeups(competition, clock, startsAt + 120_000)).toBe(0);
    expect(await alarm(competition)).toBe(closesAt);
  });

  it('keeps retrying the player left waiting while two others play', async () => {
    const { competition, clock, startsAt } = await running({ players: 5, queued: 5 });
    // Pairing latency is unchanged: one retry a second after the start pass.
    expect(await wakeups(competition, clock, startsAt + 10_000)).toBeGreaterThanOrEqual(10);
  });

  it('wakes only for game polls, not pairing, once every queued player has a game', async () => {
    const { competition, clock, startsAt } = await running({ players: 4, queued: 4 });
    await wakeups(competition, clock, startsAt + 1_000);
    // Each Game reports its own next due time, here the end of its two-minute readiness wait, so nothing wakes before it.
    expect(await wakeups(competition, clock, startsAt + 119_000)).toBe(0);
    expect(await wakeups(competition, clock, startsAt + 121_000)).toBeGreaterThanOrEqual(1);
  });

  it('drains a running arena at the next pass after entry is switched off, and releases every queued player', async () => {
    const { competition, actors, id, startsAt, clock } = await running({ players: 2, queued: 0 });
    await wakeups(competition, clock, startsAt + 1_000);
    // More queued entries than one release batch.
    const waiting = Array.from({ length: 40 }, (_unused, number) => `waiting-${number}`);
    await runInDurableObject(competition, (_instance, state) => {
      for (const userId of waiting) state.storage.sql.exec(`INSERT INTO arena_entries(event_id,user_id,actor,name,rating,state,joined_at,queued_at,next_at,rating_band)
        VALUES(?,?,?,?,1500,'queued',?,?,?,7)`, id, userId, '{}', userId, startsAt, startsAt, startsAt + 60_000);
    });
    await patchBindings(competition, { ARENAS_ENABLED: 'false' });
    clock.mockReturnValue(startsAt + 5_000);
    await competition.maintenance();
    expect(await competition.getArenaMe(actors[0], id)).toMatchObject({ status: 'finished' });
    const queued = () => runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM arena_entries WHERE state='queued'").one().count);
    expect(await queued()).toBe(8);
    // The rest of the batch is due now, not at the close an hour away.
    expect((await alarm(competition))!).toBeLessThanOrEqual(Date.now() + 1);
    await competition.maintenance();
    expect(await queued()).toBe(0);
  });
  it('retries a failed standings publication after a second, not every millisecond', async () => {
    const { competition, clock, startsAt } = await running({ players: 2, queued: 0 });
    // The start pass publishes one event. The other new events still wait for their first publication.
    await runInDurableObject(competition, instance => {
      vi.spyOn(privates(instance).env.DB, 'batch').mockRejectedValue(new Error('d1_unavailable'));
    });
    clock.mockReturnValue(startsAt + 5);
    expect((await competition.maintenance()).errors).toContain('arena');
    expect((await alarm(competition))! - Date.now()).toBeGreaterThanOrEqual(1_000);
  });
});
