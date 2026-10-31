import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { admitGameFixture, enableRanked, player } from './authority-helpers';
import { STOCKFISH_BUILD } from '../src/shared/engine';
import { publicProfile } from '../src/server/profile';
import type { Env } from '../src/server/env';
import type { Game } from '../src/server/game';
import type { Actor, GameCommand, GameSnapshot, InitGame } from '../src/shared/protocol';

async function quiet(game: DurableObjectStub<Game>, enabled = true): Promise<void> {
  await runInDurableObject(game, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...internal.env, AI_ENABLED: String(enabled), RANKED_ENABLED: 'true' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

async function activeComputer(firstMove = true) {
  const white = await player();
  const id = crypto.randomUUID();
  const game = env.GAME.get(env.GAME.idFromName(id));
  await quiet(game);
  await admitGameFixture({ id, format: 'blitz', rated: false, white, ai: { modelId: STOCKFISH_BUILD, level: 'club' } });
  const initial = await game.init({ id, format: 'blitz', rated: false, white, ai: { modelId: STOCKFISH_BUILD, level: 'club' } });
  expect(initial.black).toMatchObject({ id: `ai:${id}`, ready: true });
  const ready = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
  if (!ready.ok) throw new Error(ready.code);
  if (!firstMove) return { game, white, snapshot: ready.snapshot };
  const moved = await game.command(white, { type: 'move', id: crypto.randomUUID(), expectedVersion: ready.snapshot.version, from: 'e2', to: 'e4' });
  if (!moved.ok) throw new Error(moved.code);
  expect(moved.snapshot.ai?.thinking).toBe(true);
  return { game, white, snapshot: moved.snapshot };
}

function engineCommand(expectedVersion: number, from = 'e7', to = 'e5') {
  return { type: 'engine-move' as const, id: crypto.randomUUID(), expectedVersion, from, to };
}

async function deniedCommand(game: DurableObjectStub<Game>, actor: Actor, command: GameCommand, code: string) {
  await runInDurableObject(game, async instance => {
    await expect(instance.command(actor, command)).rejects.toThrow(code);
  });
}

async function expiredClock(game: DurableObjectStub<Game>) {
  await runInDurableObject(game, (_instance, state) => {
    const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one();
    const value = JSON.parse(row.value) as { deadline: number };
    value.deadline = Date.now() - 1;
    state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(value));
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('authoritative browser Stockfish practice', () => {
  it('recovers a Black proposal and its receipt, keeps labelled replay, and grants no competitive credit', async () => {
    const { game, white, snapshot } = await activeComputer();
    const command = engineCommand(snapshot.version);
    await evictDurableObject(game);
    await quiet(game);
    const moved = await game.command(white, command);
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error(moved.code);
    expect(moved.snapshot.clocks.b).toBe(Math.max(0, snapshot.clocks.deadline! - moved.receipt.acceptedAt) + 3_000);
    const retry = await game.command(white, command);
    expect(retry).toMatchObject({ ok: true, receipt: moved.ok ? moved.receipt : null,
      snapshot: { version: moved.snapshot.version, moves: moved.snapshot.moves, clocks: { b: moved.snapshot.clocks.b } } });
    expect(moved.snapshot.moves.map(move => [move.san, move.by])).toEqual([['e4', 'w'], ['e5', 'b']]);
    expect(moved.snapshot.ai).toMatchObject({ modelId: STOCKFISH_BUILD, actualModel: STOCKFISH_BUILD, level: 'club', thinking: false });
    expect((await game.command(white, { ...command, to: 'e6' })).ok).toBe(false);
    expect((await game.command(white, engineCommand(snapshot.version))).ok).toBe(false);
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    await runInDurableObject(competition, async (instance, state) => {
      (instance as unknown as { schedule(): Promise<void> }).schedule = async () => {};
      await state.storage.deleteAlarm();
    });
    const end = await game.command(white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: moved.snapshot.version });
    expect(end.snapshot.status).toBe('finished');
    const repeatedAfterFinish = await game.command(white, command);
    expect(repeatedAfterFinish).toMatchObject({ ok: true, receipt: moved.ok ? moved.receipt : null });
    expect(repeatedAfterFinish.snapshot.moves).toHaveLength(2);
    await game.flush();
    const result = (await game.status())!.result!;
    expect(result).toMatchObject({ rated: false, ai: { modelId: STOCKFISH_BUILD, actualModel: STOCKFISH_BUILD, level: 'club' } });
    const pgn = new Chess();
    pgn.loadPgn(result.pgn, { strict: true });
    expect(pgn.getHeaders()).toMatchObject({ Mode: 'AI', AIModel: STOCKFISH_BUILD, AIActualModel: STOCKFISH_BUILD,
      AILevel: 'club', Black: 'Stockfish 19.0.1 · Club (AI)' });
    expect(pgn.history()).toEqual(['e4', 'e5']);
    const competitive = await runInDurableObject(competition, (_instance, state) => ({
      ratings: state.storage.sql.exec('SELECT game_id FROM rating_events WHERE game_id=?', snapshot.id).toArray(),
      farming: state.storage.sql.exec('SELECT game_id FROM pair_games WHERE game_id=?', snapshot.id).toArray(),
    }));
    expect(competitive.ratings).toHaveLength(0);
    expect(competitive.farming).toHaveLength(0);
    await competition.flush();
    expect(await env.DB.prepare('SELECT rated,ai_model_id,ai_actual_model,settlement FROM games WHERE id=?').bind(snapshot.id).first())
      .toEqual({ rated: 0, ai_model_id: STOCKFISH_BUILD, ai_actual_model: STOCKFISH_BUILD, settlement: 'unrated' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leaderboard_entries WHERE user_id=?').bind(white.id).first('n')).toBe(0);
    const profile = await publicProfile(env, white.id);
    expect(profile?.pools).toHaveLength(2);
    expect(profile?.pools.every(pool => pool.games === 0 && pool.distinctOpponents === 0 && !pool.eligible && !pool.pending)).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE userId=?').bind(snapshot.black!.id).first('n')).toBe(0);
  });

  it('rejects other actors, ordinary Black moves, stale versions, illegal proposals, and extra trusted state', async () => {
    const { game, white, snapshot } = await activeComputer();
    const outsider = await player(true);
    await deniedCommand(game, outsider, engineCommand(snapshot.version), 'not_a_player');
    await deniedCommand(game, { ...white, id: snapshot.black!.id }, engineCommand(snapshot.version), 'session_invalid');
    const proposals = [
      [{ ...engineCommand(snapshot.version), type: 'move' }, 'not_your_turn'],
      [engineCommand(snapshot.version - 1), 'stale_version'],
      [engineCommand(snapshot.version, 'e2', 'e4'), 'illegal_move'],
      [{ ...engineCommand(snapshot.version), fen: snapshot.fen }, 'invalid_command'],
    ] as const;
    for (const [proposal, code] of proposals) {
      const reply = await game.command(white, proposal as GameCommand);
      expect(reply).toMatchObject({ ok: false, code });
      expect(reply.snapshot).toMatchObject({ version: snapshot.version, moves: snapshot.moves, clocks: { deadline: snapshot.clocks.deadline } });
    }
    const accepted = await game.command(white, engineCommand(snapshot.version));
    expect(accepted.ok).toBe(true);
    expect(await game.command(white, engineCommand(accepted.snapshot.version, 'd7', 'd5'))).toMatchObject({ ok: false, code: 'not_your_turn' });
    await env.DB.prepare('DELETE FROM session WHERE id=?').bind(white.sessionId).run();
    await deniedCommand(game, white, { type: 'move', id: crypto.randomUUID(), expectedVersion: accepted.snapshot.version, from: 'd2', to: 'd4' }, 'session_invalid');
  });

  it('keeps engine proposals out of human, ranked, and tournament games for both seats', async () => {
    for (const mode of ['human', 'ranked', 'tournament', 'arena'] as const) {
      const [white, black] = await Promise.all([player(), player()]);
      const id = crypto.randomUUID();
      let game = env.GAME.get(env.GAME.idFromName(id));
      let initial: GameSnapshot;
      if (mode === 'ranked') {
        const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
        await enableRanked(competition);
        await competition.joinQueue(white, 'blitz');
        const match = await competition.joinQueue(black, 'blitz');
        if (match.status !== 'reserved' && match.status !== 'live') throw new Error('not_paired');
        game = env.GAME.get(env.GAME.idFromName(match.gameId));
        await enableRanked(game);
        await quiet(game);
        initial = await game.snapshot(white);
      } else {
        await quiet(game);
        if (mode === 'human') await admitGameFixture({ id, format: 'blitz', rated: false, white, black });
        initial = await game.init({ id, format: 'blitz', rated: false, white, black,
          ...(mode !== 'human' ? { reservationId: crypto.randomUUID() } : {}),
          ...(['tournament', 'arena'].includes(mode) ? { tournament: { id: 'engine-contract-event', round: 1, deadlineAt: Date.now() + 1_080_000,
            ...(mode === 'arena' ? { format: 'arena-v1' as const } : {}) } } : {}) });
      }
      const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
      const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
      expect(second.snapshot.status).toBe('active');
      for (const actor of [white, black]) {
        const denied = await game.command(actor, engineCommand(second.snapshot.version));
        expect(denied).toMatchObject({ ok: false, code: 'engine_move_unavailable', snapshot: { version: second.snapshot.version, moves: [] } });
      }
    }
  });

  it('uses the common legal-move result path for an engine checkmate and rejects later output', async () => {
    const { game, white, snapshot } = await activeComputer(false);
    let current = snapshot;
    for (const [type, from, to] of [['move', 'f2', 'f3'], ['engine-move', 'e7', 'e5'], ['move', 'g2', 'g4'], ['engine-move', 'd8', 'h4']] as const) {
      const reply = await game.command(white, { type, id: crypto.randomUUID(), expectedVersion: current.version, from, to });
      expect(reply.ok).toBe(true);
      current = reply.snapshot;
    }
    expect(current.outcome).toEqual({ winner: 'b', score: 0, reason: 'checkmate' });
    const result = (await game.status())!.result;
    expect(await game.command(white, engineCommand(current.version))).toMatchObject({ ok: false, code: 'game_over' });
    expect((await game.status())!.result).toEqual(result);
  });

  it('checks Black deadline before accepting a proposal and preserves a resignation against late output', async () => {
    const timed = await activeComputer();
    await expiredClock(timed.game);
    const late = await timed.game.command(timed.white, engineCommand(timed.snapshot.version));
    expect(late).toMatchObject({ ok: false, code: 'game_over', snapshot: { status: 'finished', moves: timed.snapshot.moves,
      outcome: { reason: 'timeout-win' } } });
    const resigned = await activeComputer();
    const ended = await resigned.game.command(resigned.white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: resigned.snapshot.version });
    expect(ended.snapshot.outcome?.reason).toBe('resignation');
    const original = (await resigned.game.status())!.result;
    expect(await resigned.game.command(resigned.white, engineCommand(resigned.snapshot.version))).toMatchObject({ ok: false, code: 'game_over' });
    expect((await resigned.game.status())!.result).toEqual(original);
  });

  it('ends unfinished legacy provider work without inference and preserves its historical labels', async () => {
    const { game, white } = await activeComputer();
    await runInDurableObject(game, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one();
      const value = JSON.parse(row.value);
      value.ai = { modelId: 'legacy/chess:free', name: 'Legacy provider', actualModel: 'legacy/routed:free',
        turn: { id: `v${value.version}`, version: value.version, attempts: 1, nextAt: Date.now() + 25_000 } };
      value.black.name = 'Legacy provider (AI)';
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(value));
    });
    await evictDurableObject(game);
    await quiet(game);
    const fetch = vi.fn(() => { throw new Error('Provider work has been removed.'); });
    vi.stubGlobal('fetch', fetch);
    const ended = await game.snapshot(white);
    expect(ended.outcome).toEqual({ winner: null, score: null, reason: 'ai-unavailable', aiError: 'AI_UNAVAILABLE' });
    expect(ended.moves.map(move => move.san)).toEqual(['e4']);
    const result = (await game.status())!.result!;
    expect(result.ai).toEqual({ modelId: 'legacy/chess:free', name: 'Legacy provider', actualModel: 'legacy/routed:free' });
    const pgn = new Chess();
    pgn.loadPgn(result.pgn, { strict: true });
    expect(pgn.getHeaders()).toMatchObject({ AIModel: 'legacy/chess:free', AIActualModel: 'legacy/routed:free', Black: 'Legacy provider (AI)' });
    expect(await game.command(white, engineCommand(ended.version))).toMatchObject({ ok: false, code: 'game_over' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('honors the explicit practice kill switch without changing completed results', async () => {
    const active = await activeComputer();
    await quiet(active.game, false);
    const ended = await active.game.snapshot(active.white);
    expect(ended.outcome).toEqual({ winner: null, score: null, reason: 'ai-unavailable', aiError: 'AI_UNAVAILABLE' });
    expect(ended.moves).toEqual(active.snapshot.moves);
    const finished = await activeComputer();
    await finished.game.command(finished.white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: finished.snapshot.version });
    const original = (await finished.game.status())!.result;
    await quiet(finished.game, false);
    expect((await finished.game.status())!.result).toEqual(original);
  });

  it('rejects unsupported build, difficulty, and competitive AI initialization', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    const base = { format: 'blitz', rated: false, white, ai: { modelId: STOCKFISH_BUILD, level: 'club' } } as const;
    const invalid = [
      { ai: { modelId: 'legacy/chess:free', level: 'club' } },
      { ai: { modelId: STOCKFISH_BUILD, level: 'invented' } },
      { rated: true, black, reservationId: crypto.randomUUID() },
      { black },
      { black, reservationId: crypto.randomUUID(), tournament: { id: 'event', round: 1, deadlineAt: Date.now() + 60_000 } },
    ];
    for (const extra of invalid) {
      const id = crypto.randomUUID();
      const game = env.GAME.get(env.GAME.idFromName(id));
      await quiet(game);
      await runInDurableObject(game, async instance => {
        await expect(instance.init({ ...base, ...extra, id } as InitGame)).rejects.toThrow('invalid_game');
      });
      expect(await game.status()).toBeNull();
    }
  });
});
