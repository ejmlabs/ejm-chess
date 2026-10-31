import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../src/server/index';
import { acquireSeatGuard, currentActor } from '../src/server/auth';
import { STOCKFISH_BUILD } from '../src/shared/engine';
import { GAME_HOT_RETENTION_MS } from '../src/server/game';
import { retireGamePayloads } from '../src/server/maintenance';
import type { Env } from '../src/server/env';
import type { Actor, GameSnapshot, InitGame } from '../src/shared/protocol';
import { player } from './authority-helpers';

const origin = 'http://localhost:8787';
let originalCompetitionEnv: Env | undefined;
async function configureAdmission(bindings: Env) {
  const authority = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  await runInDurableObject(authority, instance => {
    const internal = instance as unknown as { env: Env };
    originalCompetitionEnv ??= internal.env;
    internal.env = { ...originalCompetitionEnv, ...bindings };
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (!originalCompetitionEnv) return;
  const authority = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  await runInDurableObject(authority, instance => {
    (instance as unknown as { env: Env }).env = originalCompetitionEnv!;
  });
  originalCompetitionEnv = undefined;
});
function request(path: string, cookie: string, body?: unknown, extra: Record<string, string> = {}) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fetch(request: Request, bindings: Env = env) {
  if (request.method === 'POST' && new URL(request.url).pathname === '/api/games') await configureAdmission(bindings);
  const context = createExecutionContext();
  const response = await handler.fetch(request, bindings, context);
  await waitOnExecutionContext(context);
  return response;
}
let address = 1;
async function account() {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const response = await fetch(request('/api/auth/sign-up/email', '', {
    username, name: username, email: `${username}@example.test`, password: 'test-only-password-12345',
  }, {
    'X-Turnstile-Token': 'local-development', 'CF-Connecting-IP': `198.51.100.${address++}`,
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const actor = await currentActor(request('/api/me', cookie), env);
  return { cookie, actor: actor! };
}
async function aiBindings(): Promise<Env> {
  return { ...env, AI_ENABLED: 'true' };
}

describe('bounded game admission', () => {
  it('opens retained capacity only after retirement, returns private replay redirects, and never reopens an archived ID', async () => {
    const [white, black, outsider] = await Promise.all([account(), account(), account()]);
    const baseline = Number(await env.DB.prepare("SELECT COUNT(*) AS count FROM casual_game_admissions WHERE storage_state='retained'").first('count'));
    const bindings = { ...env, CASUAL_GAME_LIMIT: String(baseline + 1) };
    const id = crypto.randomUUID();
    expect((await fetch(request('/api/games', white.cookie, { id, format: 'blitz' }), bindings)).status).toBe(201);
    const joined = await fetch(request(`/api/games/${id}/join`, black.cookie, {}), bindings);
    const snapshot = await joined.json() as GameSnapshot;
    const authority = env.GAME.get(env.GAME.idFromName(id));
    await authority.command(white.actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    await authority.command(black.actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version + 1 });
    await authority.command(white.actor, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version + 2 });
    await authority.flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    const result = (await authority.status())!.result!;
    expect((await fetch(request('/api/games', white.cookie, { id: crypto.randomUUID(), format: 'blitz' }), bindings)).status).toBe(409);
    vi.spyOn(Date, 'now').mockReturnValue(result.endedAt + GAME_HOT_RETENTION_MS);
    expect(await retireGamePayloads(env)).toMatchObject({ completed: 1, failed: 0 });
    const get = vi.fn(() => { throw new Error('Archived routes must not invoke the Game binding.'); });
    const retiredBindings: Env = { ...bindings, GAME: { idFromName: env.GAME.idFromName.bind(env.GAME), get } as unknown as Env['GAME'] };
    for (const participant of [white, black]) {
      for (const pending of [
        request(`/api/games/${id}`, participant.cookie),
        request(`/api/games/${id}/join`, participant.cookie, {}),
        request(`/api/games/${id}/connect`, participant.cookie, undefined, { Upgrade: 'websocket' }),
      ]) {
        const response = await fetch(pending, retiredBindings);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: 'GAME_ARCHIVED', replayUrl: `/replay/?game=${id}` });
      }
    }
    expect((await fetch(request('/api/games', white.cookie, { id, format: 'blitz' }), retiredBindings)).status).toBe(410);
    for (const pending of [
      request(`/api/games/${id}`, outsider.cookie),
      request(`/api/games/${id}/join`, outsider.cookie, {}),
      request(`/api/games/${id}/connect`, outsider.cookie, undefined, { Upgrade: 'websocket' }),
      request(`/api/games/${id}/pgn`, outsider.cookie),
      request('/api/games', black.cookie, { id, format: 'blitz' }),
    ]) {
      const response = await fetch(pending, retiredBindings);
      expect(response.status).toBe(404);
      if (new URL(pending.url).pathname.endsWith('/join')) {
        expect(await response.json()).toMatchObject({ error: 'INVITATION_UNAVAILABLE' });
      }
    }
    const pgn = await fetch(request(`/api/games/${id}/pgn`, white.cookie), retiredBindings);
    expect(pgn.status).toBe(200);
    expect(new TextDecoder().decode(await pgn.arrayBuffer())).toBe(result.pgn);
    expect(get).not.toHaveBeenCalled();
    expect((await fetch(request('/api/games', white.cookie, { id: crypto.randomUUID(), format: 'blitz' }), bindings)).status).toBe(201);
    expect(await authority.status()).toBeNull();
    expect(await env.DB.prepare('SELECT storage_state FROM casual_game_admissions WHERE game_id=?').bind(id).first('storage_state')).toBe('archived');
  });

  it('refuses an expired invitation without a seat and allows a fresh invitation', async () => {
    const [white, opponent] = await Promise.all([account(), account()]);
    const id = crypto.randomUUID();
    const created = await fetch(request('/api/games', white.cookie, { id, format: 'blitz' }));
    expect(created.status).toBe(201);
    const snapshot = await created.json() as GameSnapshot;
    vi.spyOn(Date, 'now').mockReturnValue(snapshot.serverNow + 10 * 60_000 + 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(request(`/api/games/${id}/join`, opponent.cookie, {}));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'INVITATION_UNAVAILABLE' });
    }
    const expired = await env.GAME.get(env.GAME.idFromName(id)).lookup(white.actor);
    expect(expired).toMatchObject({ status: 'finished', black: null, outcome: { reason: 'readiness-expired' } });
    expect((await fetch(request(`/api/games/${id}`, opponent.cookie))).status).toBe(404);
    expect(await env.DB.prepare('SELECT 1 FROM active_game_seats WHERE user_id=? AND game_id=? AND released_at IS NULL')
      .bind(opponent.actor.id, id).first()).toBeNull();
    expect((await fetch(request('/api/games', opponent.cookie, { id: crypto.randomUUID(), format: 'blitz' }))).status).toBe(201);
    await env.GAME.get(env.GAME.idFromName(id)).flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    vi.spyOn(Date, 'now').mockReturnValue(snapshot.serverNow + 10 * 60_000 + GAME_HOT_RETENTION_MS + 1);
    await retireGamePayloads(env);
    expect(await env.DB.prepare('SELECT storage_state FROM casual_game_admissions WHERE game_id=?').bind(id).first('storage_state')).toBe('archived');
    for (const participant of [white, opponent]) {
      const response = await fetch(request(`/api/games/${id}/join`, participant.cookie, {}));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'INVITATION_UNAVAILABLE' });
    }
  });

  it('does not invoke a Game RPC for unknown reads, joins, sockets, or cap-denied creates', async () => {
    const { cookie } = await account();
    const rpc = vi.fn(async () => { throw new Error('Rejected IDs must create no Game storage.'); });
    const get = vi.fn(() => ({ status: rpc, lookup: rpc, init: rpc, fetch: rpc, claimSeat: rpc }));
    const bindings: Env = { ...env, CASUAL_GAME_LIMIT: '0', GAME: {
      idFromName: (name: string) => env.GAME.idFromName(name), get,
    } as unknown as Env['GAME'] };
    const id = crypto.randomUUID();
    for (const pending of [
      request(`/api/games/${id}`, cookie),
      request(`/api/games/${id}/join`, cookie, {}),
      request(`/api/games/${id}/connect`, cookie, undefined, { Upgrade: 'websocket' }),
    ]) expect((await fetch(pending, bindings)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect((await fetch(request('/api/games', cookie, { id, format: 'blitz' }), bindings)).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(id).first()).toBeNull();
  });

  it('allows the admitted creator to retry and the opponent to join at full capacity', async () => {
    const [white, black] = await Promise.all([account(), account()]);
    const baseline = (await env.DB.prepare("SELECT COUNT(*) AS count FROM casual_game_admissions WHERE storage_state='retained'").first<{ count: number }>())!.count;
    const bindings = { ...env, CASUAL_GAME_LIMIT: String(baseline + 1) };
    const id = crypto.randomUUID();
    expect((await fetch(request('/api/games', white.cookie, { id, format: 'blitz' }), bindings)).status).toBe(201);
    const replay = await fetch(request('/api/games', white.cookie, { id, format: 'rapid' }), bindings);
    expect(replay.status).toBe(200);
    expect((await replay.json() as GameSnapshot).format).toBe('blitz');
    expect((await fetch(request('/api/games', black.cookie, { id, format: 'blitz' }), bindings)).status).toBe(404);
    const joined = await fetch(request(`/api/games/${id}/join`, black.cookie, {}), bindings);
    expect(joined.status).toBe(200);
    expect((await joined.json() as GameSnapshot).black?.id).toBe(black.actor.id);
    expect((await fetch(request('/api/games', black.cookie, { id: crypto.randomUUID(), format: 'blitz' }), bindings)).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM casual_game_admissions WHERE storage_state='retained'").first<{ count: number }>())?.count).toBe(baseline + 1);
  });

  it('keeps the winning seat guard when concurrent creation conflicts on format', async () => {
    const { actor, cookie } = await account();
    const id = crypto.randomUUID();
    const authority = env.GAME.get(env.GAME.idFromName(id));
    // The coordinator must preserve one initialization payload and seat even
    // when concurrent requests disagree before Game initialization completes.
    const init = vi.fn((input: InitGame) => env.GAME.get(env.GAME.idFromName(input.id)).init(input));
    const bindings: Env = { ...env, GAME: {
      idFromName: (name: string) => env.GAME.idFromName(name),
      get: (gameId: DurableObjectId) => {
        const game = env.GAME.get(gameId);
        return { status: async () => null, init, lookup: (player: Actor) => game.lookup(player) };
      },
    } as unknown as Env['GAME'] };
    const responses = await Promise.all(['blitz', 'rapid'].map(format => fetch(request('/api/games', cookie, { id, format }), bindings)));
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(responses.some(response => response.status === 201), JSON.stringify(bodies)).toBe(true);
    const snapshots: GameSnapshot[] = [];
    for (const [index, response] of responses.entries()) {
      if (response.ok) snapshots.push(bodies[index] as GameSnapshot);
      else {
        expect(response.status).toBe(409);
        expect(bodies[index]).toMatchObject({ error: 'GAME_INITIALIZATION_CONFLICT' });
      }
    }
    expect(new Set(snapshots.map(snapshot => snapshot.format)).size).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
    const seat = await env.DB.prepare('SELECT released_at FROM active_game_seats WHERE user_id=? AND game_id=?').bind(actor.id, id).first<{ released_at: number | null }>();
    expect(seat?.released_at).toBeNull();
    expect((await authority.lookup(actor))?.white.id).toBe(actor.id);
  });

  it('retains an uncertain AI initialization and recovers the same admitted game on retry', async () => {
    const { actor, cookie } = await account();
    const id = crypto.randomUUID();
    const bindings: Env = { ...await aiBindings(), GAME: {
      idFromName: (name: string) => env.GAME.idFromName(name),
      get: () => ({ status: async () => null, init: async () => { throw new Error('Initialization reply unavailable'); }, lookup: async () => null }),
    } as unknown as Env['GAME'] };
    const response = await fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' } }), bindings);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'GAME_INITIALIZATION_PENDING' });
    const guard = await env.DB.prepare('SELECT released_at FROM active_game_seats WHERE user_id=? AND game_id=?')
      .bind(actor.id, id).first<{ released_at: number | null }>();
    expect(guard?.released_at).toBeNull();
    expect(await env.DB.prepare('SELECT creator_id FROM casual_game_admissions WHERE game_id=?').bind(id).first()).toEqual({ creator_id: actor.id });
    expect((await fetch(request('/api/auth/sign-out', cookie, {}), bindings)).status).toBe(409);
    const recovered = await fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' } }), await aiBindings());
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ id, white: { id: actor.id }, ai: { modelId: STOCKFISH_BUILD, level: 'club' } });
  });

  it('preserves an initialized AI seat when its reply is lost and concurrent requests retry', async () => {
    const { actor, cookie } = await account();
    const id = crypto.randomUUID();
    const authority = env.GAME.get(env.GAME.idFromName(id));
    // The real authority needs practice enabled, matching the Worker fixture.
    await runInDurableObject(authority, instance => {
      const internal = instance as unknown as { env: Env };
      internal.env = { ...internal.env, AI_ENABLED: 'true' };
    });
    const init = vi.fn(async (input: InitGame) => {
      await env.GAME.get(env.GAME.idFromName(input.id)).init(input);
      throw new Error('Initialization reply lost after commit');
    });
    const bindings: Env = { ...await aiBindings(), GAME: {
      idFromName: (name: string) => env.GAME.idFromName(name),
      get: (gameId: DurableObjectId) => {
        const game = env.GAME.get(gameId);
        return { status: () => game.status(), init, lookup: (player: Actor) => game.lookup(player) };
      },
    } as unknown as Env['GAME'] };
    const responses = await Promise.all(Array.from({ length: 2 }, () => fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' } }), bindings)));
    for (const response of responses) {
      const body = await response.json();
      expect(response.ok, JSON.stringify(body)).toBe(true);
      expect(body).toMatchObject({ id, ai: { modelId: STOCKFISH_BUILD } });
    }
    expect(init).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT released_at FROM active_game_seats WHERE user_id=? AND game_id=?')
      .bind(actor.id, id).first()).toEqual({ released_at: null });
    expect((await authority.lookup(actor))?.ai?.modelId).toBe(STOCKFISH_BUILD);
  });

  it('lets authenticated players inspect and cancel the queue while ranked admission is closed', async () => {
    const { cookie } = await account();
    const bindings = { ...env, RANKED_ENABLED: 'false' };
    expect((await fetch(request('/api/queue', cookie, { pool: 'blitz' }), bindings)).status).toBe(403);
    const status = await fetch(request('/api/queue', cookie), bindings);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: 'idle' });
    const canceled = await fetch(request('/api/queue/cancel', cookie, {}), bindings);
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ status: 'idle' });
  });

  it('reuses retired casual payload capacity while retaining a separate permanent game ID ceiling', async () => {
    const actor = await player();
    const counts = await env.DB.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN storage_state='retained' THEN 1 ELSE 0 END) AS retained
      FROM casual_game_admissions`).first<{ total: number; retained: number | null }>();
    const limited = { ...env, CASUAL_GAME_LIMIT: String((counts?.retained ?? 0) + 1), CASUAL_GAME_ID_LIMIT: String((counts?.total ?? 0) + 2) };
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(await acquireSeatGuard(limited, actor, first)).toBe(true);
    expect(await acquireSeatGuard(limited, actor, second)).toBe(false);
    await env.DB.prepare("UPDATE casual_game_admissions SET storage_state='archived',archived_at=? WHERE game_id=?").bind(Date.now(), first).run();
    expect(await acquireSeatGuard(limited, actor, second)).toBe(true);
    await env.DB.prepare("UPDATE casual_game_admissions SET storage_state='archived',archived_at=? WHERE game_id=?").bind(Date.now(), second).run();
    expect(await acquireSeatGuard(limited, actor, crypto.randomUUID())).toBe(false);
    expect(await acquireSeatGuard({ ...limited, CASUAL_GAME_ID_LIMIT: '-1' }, actor, crypto.randomUUID())).toBe(false);
  });
});
