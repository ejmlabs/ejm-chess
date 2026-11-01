import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Competition } from '../src/server/competition';
import { gamesAnswering, heldCompetition, patchBindings, player, privates } from './authority-helpers';

type Authority = DurableObjectStub<Competition>;
const SAFETY_MS = 300_000;
afterEach(() => vi.restoreAllMocks());

/** What the Game's status call does for the Competition under test. */
interface Probe { status: number; fail: number; dueAt?: (real: number | null) => number | null }

/** A Competition that counts every Game status call it makes. Its own alarm is held so the test drives each pass. */
async function watched(): Promise<{ competition: Authority; probe: Probe }> {
  const competition = await heldCompetition({ ARENAS_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true' });
  const probe: Probe = { status: 0, fail: 0 };
  await patchBindings(competition, gamesAnswering(game => ({
    status: async () => {
      probe.status++;
      if (probe.fail > 0) { probe.fail--; throw new Error('status reply lost'); }
      const reply = await game.status();
      return reply && probe.dueAt ? { ...reply, dueAt: probe.dueAt(reply.dueAt) } : reply;
    },
  })));
  return { competition, probe };
}

/** Two seated players who have both pressed Ready, so the clock runs and the Game owns a deadline. */
async function liveCasualGame(competition: Authority) {
  const [white, black] = await Promise.all([player(), player()]);
  const id = crypto.randomUUID();
  const created = await competition.createCasualGame(white, { id, format: 'rapid' });
  if (!created.ok) throw new Error(created.error.code);
  const game = env.GAME.get(env.GAME.idFromName(id));
  await game.join(black);
  const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: 1 });
  const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  if (!first.ok || !second.ok) throw new Error('not_started');
  return { id, game, white, black, snapshot: second.snapshot, deadline: second.snapshot.clocks.deadline! };
}

const intent = (competition: Authority, id: string) => runInDurableObject(competition, (_instance, state) =>
  state.storage.sql.exec<{ state: string; next_at: number | null; attempts: number }>('SELECT state,next_at,attempts FROM casual_intents WHERE game_id=?', id).one());

const nextDue = (competition: Authority) => runInDurableObject(competition, instance => privates(instance).casuals.nextDue());

/** Wakes Competition at each due time up to `until`, as its alarm would, and returns how many times it woke. */
async function wakeUntil(competition: Authority, clock: ReturnType<typeof vi.spyOn>, until: number): Promise<number> {
  let wakeups = 0;
  for (let due = await nextDue(competition); due !== null && due <= until; due = await nextDue(competition)) {
    if (++wakeups > 2_000) throw new Error('competition is polling');
    clock.mockReturnValue(Math.max(Date.now(), due));
    await competition.maintenance();
  }
  clock.mockReturnValue(until);
  return wakeups;
}

describe('game reconcile cadence', () => {
  it('reads ten live games near their deadline, not every 30 seconds, and settles each flag at its deadline', async () => {
    const { competition, probe } = await watched();
    const games = [];
    for (let index = 0; index < 10; index++) games.push(await liveCasualGame(competition));
    const clock = vi.spyOn(Date, 'now');
    const start = Math.max(...games.map(game => game.snapshot.serverNow));
    const deadline = Math.min(...games.map(game => game.deadline));
    clock.mockReturnValue(start);
    probe.status = 0;
    const wakeups = await wakeUntil(competition, clock, deadline - 1);
    // Ten minutes of clock allow one safety read each, where a 30-second poll read each game about 19 times.
    expect(probe.status).toBeLessThanOrEqual(games.length * Math.ceil(600_000 / SAFETY_MS));
    expect(wakeups).toBeLessThanOrEqual(games.length * 2);
    for (const game of games) expect(await game.game.status()).toMatchObject({ status: 'active', result: null });
    await wakeUntil(competition, clock, Math.max(...games.map(game => game.deadline)));
    for (const game of games) {
      expect(await intent(competition, game.id)).toMatchObject({ state: 'finished', next_at: null });
      expect(await game.game.status()).toMatchObject({ status: 'finished', result: { endedAt: game.deadline, outcome: { reason: 'timeout-win' } } });
    }
  });

  it('settles a resignation as soon as the Game delivers it, without waiting for a read', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    const { id, game, white, snapshot } = await liveCasualGame(competition);
    expect(await intent(competition, id)).toMatchObject({ state: 'live' });
    expect((await intent(competition, id)).next_at! - Date.now()).toBeGreaterThan(60_000);
    expect((await game.command(white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version })).ok).toBe(true);
    await game.flush();
    expect(await intent(competition, id)).toMatchObject({ state: 'finished', next_at: null });
  });

  it('reads a game again within the safety bound after a lost status reply', async () => {
    const { competition, probe } = await watched();
    const { id, snapshot } = await liveCasualGame(competition);
    probe.fail = 1;
    const lostAt = snapshot.serverNow + SAFETY_MS;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(lostAt);
    await competition.maintenance();
    expect(probe.fail).toBe(0);
    expect(await intent(competition, id)).toMatchObject({ state: 'live', attempts: 1 });
    const retryAt = (await intent(competition, id)).next_at!;
    expect(retryAt).toBeGreaterThan(lostAt);
    expect(retryAt - lostAt).toBeLessThanOrEqual(SAFETY_MS);
    const before = probe.status;
    clock.mockReturnValue(retryAt);
    await competition.maintenance();
    expect(probe.status).toBe(before + 1);
    expect(await intent(competition, id)).toMatchObject({ state: 'live', attempts: 0 });
  });

  it.each([
    ['a day away', () => Date.now() + 86_400_000],
    ['absent', () => null],
  ])('reads a game within the safety bound when its reply reports a due time that is %s', async (_name, dueAt) => {
    const { competition, probe } = await watched();
    const { id, snapshot } = await liveCasualGame(competition);
    probe.dueAt = dueAt;
    vi.spyOn(Date, 'now').mockReturnValue(snapshot.serverNow + SAFETY_MS);
    await competition.maintenance();
    expect((await intent(competition, id)).next_at).toBe(snapshot.serverNow + 2 * SAFETY_MS);
  });
});
