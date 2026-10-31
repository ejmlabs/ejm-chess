import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/server/env';
import type { Game } from '../src/server/game';
import { RULES_VERSION, type GameSnapshot, type Pool } from '../src/shared/protocol';
import { enableRanked, player } from './authority-helpers';

const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));

async function pauseAlarms(stub: DurableObjectStub<Game>): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as { schedule(): Promise<void> }).schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

async function pair(pool: Pool = 'blitz') {
  const [a, b] = await Promise.all([player(), player()]);
  await competition.joinQueue(a, pool);
  const queue = await competition.joinQueue(b, pool);
  if (queue.status !== 'reserved' && queue.status !== 'live') throw new Error('not_paired');
  const game = env.GAME.get(env.GAME.idFromName(queue.gameId));
  await enableRanked(game);
  await pauseAlarms(game);
  const initial = await game.snapshot(a);
  return { game, initial, white: initial.white.id === a.id ? a : b, black: initial.white.id === a.id ? b : a };
}

async function start(match: Awaited<ReturnType<typeof pair>>): Promise<GameSnapshot> {
  const first = await match.game.command(match.white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: match.initial.version });
  const second = await match.game.command(match.black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  expect([first.ok, second.ok]).toEqual([true, true]);
  return second.snapshot;
}

/** Replaces the starting position of a game that has not moved. */
async function setPosition(game: DurableObjectStub<Game>, fen: string): Promise<void> {
  await runInDurableObject(game, (_instance, state) => {
    const stored = JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one().value);
    stored.initialFen = fen;
    state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(stored));
  });
}

async function ratingScores(gameId: string): Promise<number[]> {
  return runInDurableObject(competition, (_instance, state) =>
    state.storage.sql.exec<{ score: number }>('SELECT score FROM rating_events WHERE game_id=?', gameId).toArray().map(row => row.score));
}

beforeEach(async () => {
  await runInDurableObject(competition, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...env, TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
    for (const table of ['matches', 'slots', 'queue']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
  await enableRanked(competition);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ranked admission without a timeout proof', () => {
  it('opens with RANKED_ENABLED alone, pairs two accounts and records no proof receipt', async () => {
    expect(await competition.health()).toMatchObject({ rankedOpen: true });
    expect(await competition.health()).not.toHaveProperty('timeoutProof');
    const match = await pair();
    expect(match.initial).toMatchObject({ rated: true, rulesVersion: RULES_VERSION, status: 'ready' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM timeout_proof_admissions WHERE game_id=?').bind(match.initial.id).first('count')).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM budget_receipts WHERE kind='games' AND id=?").bind(`ranked:${match.initial.id}`).first('count')).toBe(1);
  });

  it('creates a ranked Game only for an open Competition reservation', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async instance => {
      await expect(instance.init({ id: crypto.randomUUID(), reservationId: crypto.randomUUID(), format: 'blitz', rated: true, white, black }))
        .rejects.toThrow('ranked_reservation_required');
    });
  });

  it('keeps more than four ranked games live at once', async () => {
    const matches = [];
    for (const pool of ['blitz', 'rapid', 'blitz', 'rapid', 'blitz'] as const) {
      const match = await pair(pool);
      await start(match);
      matches.push(match);
    }
    expect(await Promise.all(matches.map(match => competition.queueStatus(match.white))))
      .toEqual(matches.map(match => expect.objectContaining({ status: 'live', gameId: match.initial.id })));
    expect((await competition.health()).unsettled).toBe(5);
  });
});

describe('ranked timeout at the flag', () => {
  it('awards the survivor with mating material a win at the flag and rates it once', async () => {
    const match = await pair();
    const active = await start(match);
    const flagAt = active.clocks.deadline!;
    vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    expect(await match.game.snapshot(match.white)).toMatchObject({ status: 'finished', rulesVersion: RULES_VERSION, endedAt: flagAt,
      outcome: { winner: 'b', score: 0, reason: 'timeout-win' } });
    await match.game.flush();
    await match.game.flush();
    expect(await ratingScores(active.id)).toEqual([0]);
  });

  it('draws a flag when the survivor has only a king and rates it once', async () => {
    const match = await pair();
    const active = await start(match);
    await setPosition(match.game, '3k4/8/3K4/8/8/8/8/R7 w - - 0 1');
    vi.spyOn(Date, 'now').mockReturnValue(active.clocks.deadline!);
    expect(await match.game.snapshot(match.white)).toMatchObject({ status: 'finished',
      outcome: { winner: null, score: 0.5, reason: 'timeout-insufficient-material' } });
    await match.game.flush();
    await match.game.flush();
    expect(await ratingScores(active.id)).toEqual([0.5]);
  });
});
