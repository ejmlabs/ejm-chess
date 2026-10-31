import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../src/server/index';
import { currentActor } from '../src/server/auth';
import { parseReplay } from '../src/client/replay';
import { STOCKFISH_BUILD } from '../src/shared/engine';
import type { Env } from '../src/server/env';
import type { Actor, GameSnapshot } from '../src/shared/protocol';
import type { Competition } from '../src/server/competition';
import type { Game } from '../src/server/game';
import { enableRanked } from './authority-helpers';

const origin = 'http://localhost:8787';
let address = 1;

function request(path: string, cookie = '', body?: unknown, extra: Record<string, string> = {}) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function http(request: Request, bindings: Env = env) {
  const context = createExecutionContext();
  const response = await handler.fetch(request, bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

async function readPgn(response: Response) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await response.arrayBuffer());
}

async function user(verified = false) {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const response = await http(request('/api/auth/sign-up/email', '', {
    username, name: username, email: `${username}@example.test`, password: 'test-only-password-12345',
  }, {
    'X-Turnstile-Token': 'local-development', 'CF-Connecting-IP': `203.0.113.${address++}`,
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  let actor = (await currentActor(request('/api/me', cookie), env))!;
  if (verified) {
    await env.DB.prepare('UPDATE user SET emailVerified=1 WHERE id=?').bind(actor.id).run();
    actor = (await currentActor(request('/api/me', cookie), env))!;
  }
  return { cookie, actor };
}

async function quiet(game: DurableObjectStub<Game>, ai = false) {
  await runInDurableObject(game, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    if (ai) internal.env = { ...internal.env, AI_ENABLED: 'true' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

async function ready(game: DurableObjectStub<Game>, white: Actor, black: Actor, initial: GameSnapshot) {
  const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
  expect(first.ok).toBe(true);
  const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  expect(second.ok).toBe(true);
  return second.snapshot;
}

async function humanGame() {
  const [white, black] = await Promise.all([user(true), user()]);
  const id = crypto.randomUUID();
  expect((await http(request('/api/games', white.cookie, { id, format: 'blitz' }))).status).toBe(201);
  const joined = await http(request(`/api/games/${id}/join`, black.cookie, {}));
  expect(joined.status).toBe(200);
  const game = env.GAME.get(env.GAME.idFromName(id));
  await quiet(game);
  const snapshot = await ready(game, white.actor, black.actor, await joined.json() as GameSnapshot);
  return { id, game, white, black, snapshot };
}

/** Ranked proof-policy games are the only path that still enters pending-adjudication. */
async function proofGame() {
  const [first, second] = await Promise.all([user(true), user(true)]);
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  await runInDurableObject(competition, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...env, TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
    for (const table of ['ranked_proof_slots', 'matches', 'slots', 'queue']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
  await enableRanked(competition);
  await competition.joinQueue(first.actor, 'blitz');
  const queue = await competition.joinQueue(second.actor, 'blitz');
  if (queue.status !== 'reserved' && queue.status !== 'live') throw new Error('not_paired');
  const id = queue.gameId;
  const game = env.GAME.get(env.GAME.idFromName(id));
  await enableRanked(game);
  await quiet(game);
  const initial = await game.snapshot(first.actor);
  const white = initial.white.id === first.actor.id ? first : second;
  const black = initial.white.id === first.actor.id ? second : first;
  const snapshot = await ready(game, white.actor, black.actor, initial);
  return { id, game, white, black, snapshot, competition };
}

async function project(game: DurableObjectStub<Game>, competition?: DurableObjectStub<Competition>) {
  await game.flush();
  await (competition ?? env.COMPETITION.get(env.COMPETITION.idFromName('global'))).flush();
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('participant replay exports', () => {
  it('replays a real human export for either participant without touching live Game storage', async () => {
    const { id, game, white, black, snapshot } = await humanGame();
    let version = snapshot.version;
    for (const [actor, from, to] of [[white.actor, 'e2', 'e4'], [black.actor, 'e7', 'e5']] as const) {
      const moved = await game.command(actor, { type: 'move', id: crypto.randomUUID(), expectedVersion: version, from, to });
      expect(moved.ok).toBe(true);
      version = moved.snapshot.version;
    }
    const ended = await game.command(white.actor, { type: 'resign', id: crypto.randomUUID(), expectedVersion: version });
    expect(ended.snapshot.status).toBe('finished');
    await project(game);
    const expected = (await game.status())!.result!.pgn;
    const rpc = vi.fn(() => { throw new Error('PGN reads must not open live game storage.'); });
    const bindings: Env = { ...env, GAME: { idFromName: rpc, get: rpc } as unknown as Env['GAME'] };
    for (const participant of [white, black]) {
      const response = await http(request(`/api/games/${id}/pgn`, participant.cookie), bindings);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Type')).toContain('application/x-chess-pgn');
      expect(response.headers.get('Content-Disposition')).toContain(`${id}.pgn`);
      const pgn = await readPgn(response);
      expect(pgn).toBe(expected);
      const replay = parseReplay(pgn);
      expect(replay.moves.map(move => move.san)).toEqual(['e4', 'e5']);
      expect(replay.moves.at(-1)?.after).toBe(ended.snapshot.fen);
      expect(replay.result).toBe('0-1');
      expect(replay.ai).toBeNull();
    }
    expect(rpc).not.toHaveBeenCalled();
    const outsider = await user();
    const denied = await http(request(`/api/games/${id}/pgn`, outsider.cookie), bindings);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(expected);
    expect((await http(request(`/api/games/${id}/pgn`), bindings)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps active and pending-adjudication proof records out of replay and history downloads', async () => {
    const { id, game, white, snapshot, competition } = await proofGame();
    expect((await http(request(`/api/games/${id}/pgn`, white.cookie))).status).toBe(404);
    await runInDurableObject(game, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one();
      const value = JSON.parse(row.value) as { deadline: number };
      value.deadline = Date.now() - 1;
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(value));
    });
    const late = await game.command(white.actor, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    expect(late.snapshot.status).toBe('pending-adjudication');
    await project(game, competition);
    const denied = await http(request(`/api/games/${id}/pgn`, white.cookie));
    expect(denied.status).toBe(404);
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
    const history = await http(request('/api/history', white.cookie));
    const records = await history.json() as { games: { id: string; pgn?: string }[] };
    expect(records.games.find(record => record.id === id)).not.toHaveProperty('pgn');
  });

  it('replays a real completed computer export with its fixed build and difficulty labels', async () => {
    const white = await user();
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    await quiet(game, true);
    const bindings = { ...env, AI_ENABLED: 'true' };
    const created = await http(request('/api/games', white.cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' } }), bindings);
    expect(created.status).toBe(201);
    const initial = await created.json() as GameSnapshot;
    const started = await game.command(white.actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
    expect(started.ok).toBe(true);
    const moved = await game.command(white.actor, { type: 'move', id: crypto.randomUUID(), expectedVersion: started.snapshot.version, from: 'e2', to: 'e4' });
    expect(moved.ok).toBe(true);
    const engine = await game.command(white.actor, { type: 'engine-move', id: crypto.randomUUID(), expectedVersion: moved.snapshot.version, from: 'e7', to: 'e5' });
    expect(engine.ok).toBe(true);
    const played = await game.snapshot(white.actor);
    expect(played.moves).toHaveLength(2);
    const ended = await game.command(white.actor, { type: 'resign', id: crypto.randomUUID(), expectedVersion: played.version });
    expect(ended.snapshot.status).toBe('finished');
    await project(game);
    const response = await http(request(`/api/games/${id}/pgn`, white.cookie));
    expect(response.status).toBe(200);
    const replay = parseReplay(await readPgn(response));
    expect(replay.ai).toEqual({ model: STOCKFISH_BUILD, actualModel: STOCKFISH_BUILD });
    expect(replay.black).toBe('Stockfish 19.0.1 · Club (AI)');
    expect(replay.moves.map(move => move.san)).toEqual(['e4', 'e5']);
    expect(replay.moves.at(-1)?.after).toBe(ended.snapshot.fen);
  });
});
