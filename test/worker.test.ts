import { env } from 'cloudflare:workers';
import { STOCKFISH_BUILD } from '../src/shared/engine';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import handler from '../src/server/index';
import type { Env } from '../src/server/env';
import type { GameSnapshot } from '../src/shared/protocol';
import { currentActor } from '../src/server/auth';
import { ACCOUNT_REQUEST_LIMITS } from '../src/server/abuse';

const origin = 'http://localhost:8787';
const worker = { async fetch(request: Request, bindings: Env) {
  const ctx = createExecutionContext();
  const response = await handler.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
} };
function request(path: string, cookie = '', body?: unknown, extra: Record<string, string> = {}) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let accountAddress = 1;
async function account() {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const response = await worker.fetch(request('/api/auth/sign-up/email', '', {
    username, name: username, email: `${username}@example.test`, password: 'test-only-password-12345',
  }, { 'X-Turnstile-Token': 'local-development', 'CF-Connecting-IP': `192.0.2.${accountAddress++}` }), env);
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}

describe('Worker admission and private read contracts', () => {
  it('binds a casual invitation to the actual session and denies forged live reads', async () => {
    const [white, outsider] = await Promise.all([account(), account()]);
    const id = crypto.randomUUID();
    const created = await worker.fetch(request('/api/games', white, { id, format: 'blitz', whiteId: 'forged' }), env);
    expect(created.status).toBe(201);
    const state = await created.json() as GameSnapshot;
    const me = await (await worker.fetch(request('/api/me', white), env)).json() as { id: string };
    expect(state.white.id).toBe(me.id);
    expect(state.rated).toBe(false);
    const denied = await worker.fetch(request(`/api/games/${id}`, outsider, undefined, { 'x-chess-actor': JSON.stringify({ id: me.id }) }), env);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(state.fen);
    const replay = await worker.fetch(request('/api/games', white, { id, format: 'blitz' }), env);
    expect((await replay.json() as GameSnapshot).id).toBe(id);
  });

  it('rejects cross-origin mutations before a game is created', async () => {
    const cookie = await account();
    const id = crypto.randomUUID();
    const result = await worker.fetch(request('/api/games', cookie, { id, format: 'blitz' }, { Origin: 'https://unrelated.example' }), env);
    expect(result.status).toBe(403);
    expect(await env.GAME.get(env.GAME.idFromName(id)).status()).toBeNull();
    for (const path of ['/api/account/complete', '/api/account/export', '/api/account/close', '/api/reports', '/api/appeals', '/api/admin/decisions']) {
      const denied = await worker.fetch(request(path, cookie, {}, { Origin: 'https://unrelated.example' }), env);
      expect(denied.status, path).toBe(403);
      expect(await denied.json(), path).toMatchObject({ error: 'INVALID_ORIGIN' });
    }
  });

  it('does not let a third player claim an occupied invitation', async () => {
    const [white, black, third] = await Promise.all([account(), account(), account()]);
    const id = crypto.randomUUID();
    await worker.fetch(request('/api/games', white, { id, format: 'rapid' }), env);
    const joined = await worker.fetch(request(`/api/games/${id}/join`, black, {}), env);
    expect(joined.status).toBe(200);
    const denied = await worker.fetch(request(`/api/games/${id}/join`, third, {}), env);
    expect(denied.status).toBe(409);
    expect((await joined.json() as GameSnapshot).black?.id).not.toBeNull();
    const guarded = await env.DB.prepare('SELECT 1 FROM active_game_seats a JOIN session s ON s.userId=a.user_id WHERE s.token IS NOT NULL AND a.game_id=? AND released_at IS NULL').bind(id).all();
    expect(guarded.results).toHaveLength(2);
  });

  it('keeps ranked admission closed and publishes no invented ranks or private fields', async () => {
    const cookie = await account();
    const closed = await worker.fetch(request('/api/queue', cookie, { pool: 'blitz' }), env);
    expect(closed.status).toBe(403);
    const leaderboard = await worker.fetch(request('/api/leaderboard?pool=blitz'), env);
    expect(await leaderboard.json()).toEqual({ pool: 'blitz', entries: [], updatedAt: null, nextCursor: null });
    const me = await (await worker.fetch(request('/api/me', cookie), env)).json();
    expect(Object.keys(me as object).sort()).toEqual(['accountReady', 'emailVerified', 'hasRecoveryEmail', 'id', 'isAnonymous', 'name', 'username']);
    expect(me).toMatchObject({ accountReady: true, emailVerified: false, hasRecoveryEmail: true, isAnonymous: false });
  });

  it('protects owner routes and dynamic responses without wildcard CSP sources', async () => {
    const result = await worker.fetch(request('/api/admin/cases'), env);
    expect([401, 403]).toContain(result.status);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    const policy = result.headers.get('Content-Security-Policy')!;
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain(new URL(env.AUTH_BASE_URL).origin.replace(/^http/, 'ws'));
    expect(policy).not.toContain('*');
    const admin = await worker.fetch(request('/admin/'), env);
    expect(admin.status).toBe(403);
    for (const path of ['/api/admin/operations', '/api/admin/operations/export/manifest', '/api/admin/operations/export?kind=results&watermark=1', `/api/admin/games/${crypto.randomUUID()}/security`]) {
      const denied = await worker.fetch(request(path), env);
      expect([401, 403]).toContain(denied.status);
      expect(denied.headers.get('Cache-Control')).toBe('no-store');
    }
    const retry = await worker.fetch(request('/api/admin/operations/maintenance', '', {}), env);
    expect([401, 403]).toContain(retry.status);
  });

  it('redirects other hosts to the canonical origin and never to a host named in the path', async () => {
    const other = 'http://127.0.0.1:8787';
    const page = await worker.fetch(new Request(`${other}/play/?game=1`), env);
    expect(page.status).toBe(308);
    expect(page.headers.get('Location')).toBe(`${origin}/play/?game=1`);
    const smuggled = await worker.fetch(new Request(`${other}//evil.example/x?y=1`), env);
    expect(smuggled.status).toBe(308);
    expect(new URL(smuggled.headers.get('Location')!).origin).toBe(origin);
  });

  it('applies the owner gate and private headers to every spelling of an admin or account page', async () => {
    for (const path of ['/%61dmin/', '/%61dmin/index.html', '//admin/', '/admin%2f', '/admin.html', '/Admin/']) {
      const denied = await worker.fetch(request(path), env);
      expect(denied.status, path).toBe(403);
      expect(await denied.json()).toMatchObject({ error: 'ADMIN_REQUIRED' });
    }
    for (const path of ['/account/', '/%61ccount/', '//account/', '/account.html']) {
      const page = await worker.fetch(request(path), env);
      expect(page.status, path).toBe(200);
      expect(page.headers.get('Cache-Control'), path).toBe('no-store');
      expect(page.headers.get('X-Robots-Tag'), path).toContain('noindex');
      await page.body?.cancel();
    }
  });

  it('keeps account recovery pages private and uses the configured local socket origin', async () => {
    const localOrigin = 'http://localhost:8791';
    const assets = {
      fetch: async () => new Response('<!doctype html><title>Account</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      }),
    } as unknown as Env['ASSETS'];
    const response = await worker.fetch(new Request(`${localOrigin}/account/?reset=synthetic-placeholder`), {
      ...env, AUTH_BASE_URL: localOrigin, LOCAL_DEV: 'true', ASSETS: assets,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const policy = response.headers.get('Content-Security-Policy')!;
    expect(policy.split('; ').find(value => value.startsWith('connect-src '))?.split(' '))
      .toContain('ws://localhost:8791');
    expect(policy).not.toContain('ws://localhost:8787');
    await response.body?.cancel();
  });

  it('uses the browser-engine practice gate and rejects disabled or forged computer admission before taking a seat', async () => {
    const config = await worker.fetch(request('/api/config'), { ...env, AI_ENABLED: 'true' });
    expect(await config.json()).toMatchObject({ ai: true, ranked: false });
    expect((await worker.fetch(request('/api/ai/models'), env)).status).toBe(404);
    const cookie = await account();
    const id = crypto.randomUUID();
    const disabled = await worker.fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' } }), { ...env, AI_ENABLED: 'false' });
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: 'AI_UNAVAILABLE' });
    expect(await env.DB.prepare('SELECT 1 FROM active_game_seats WHERE game_id=?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(id).first()).toBeNull();
    const malformed = await worker.fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: ['bad'] } }), env);
    expect(malformed.status).toBe(400);
    for (const forbidden of [{ rated: true }, { ranked: true }, { tournament: {} }]) {
      const forged = await worker.fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' }, ...forbidden }), env);
      expect(forged.status).toBe(400);
    }
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(id).first()).toBeNull();
    const created = await worker.fetch(request('/api/games', cookie, { id, format: 'blitz', ai: { modelId: STOCKFISH_BUILD, level: 'club' } }), { ...env, AI_ENABLED: 'true' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ rated: false, ai: { modelId: STOCKFISH_BUILD, actualModel: STOCKFISH_BUILD, level: 'club' }, black: { ready: true } });
  });

  it('forwards the authenticated WebSocket and security headers through the Worker', async () => {
    const cookie = await account();
    const id = crypto.randomUUID();
    await worker.fetch(request('/api/games', cookie, { id, format: 'blitz' }), env);
    const connected = await worker.fetch(request(`/api/games/${id}/connect`, cookie, undefined, { Upgrade: 'websocket' }), env);
    expect(connected.status).toBe(101);
    expect(connected.webSocket).not.toBeNull();
    expect(connected.headers.get('Cache-Control')).toBe('no-store');
    expect(connected.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    connected.webSocket!.accept();
    connected.webSocket!.close(1000, 'Test complete');
  });

  it('gives the private Game binding the seat identity but never the browser identity or session cookie', async () => {
    const cookie = await account();
    const id = crypto.randomUUID();
    await worker.fetch(request('/api/games', cookie, { id, format: 'blitz' }), env);
    const me = await (await worker.fetch(request('/api/me', cookie), env)).json() as { id: string };
    let forwarded: Headers | undefined;
    const stub = { fetch: async (internal: Request) => { forwarded = internal.headers; return new Response('ok'); } };
    const bindings = { ...env, GAME: { idFromName: (name: string) => name, get: () => stub } } as unknown as Env;
    const connect = request(`/api/games/${id}/connect`, cookie, undefined, { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify({ id: 'forged' }) });
    expect((await worker.fetch(connect, bindings)).status).toBe(200);
    expect(forwarded!.get('Cookie')).toBeNull();
    const actor = JSON.parse(forwarded!.get('x-chess-actor')!);
    expect(actor.id).toBe(me.id);
    expect(actor).not.toHaveProperty('email');
  });

  it('limits malformed writes and unknown connection IDs before their route-specific work', async () => {
    const cookie = await account();
    const actor = (await currentActor(request('/api/me', cookie), env))!;
    const now = Date.now();
    await env.DB.batch((['write', 'connect'] as const).map(kind => env.DB.prepare('INSERT INTO request_limits(key,count,window_start) VALUES(?,?,?)')
      .bind(`account:${kind}:${actor.id}`, ACCOUNT_REQUEST_LIMITS[kind].maximum, now)));
    const invalid = new Request(origin + '/api/games', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'text/plain' }, body: 'invalid' });
    const limitedWrite = await worker.fetch(invalid, env);
    expect(limitedWrite.status).toBe(429);
    expect(await limitedWrite.json()).toMatchObject({ error: 'REQUEST_RATE_LIMITED' });
    const missing = crypto.randomUUID();
    const limitedConnect = await worker.fetch(request(`/api/games/${missing}/connect`, cookie, undefined, { Upgrade: 'websocket' }), env);
    expect(limitedConnect.status).toBe(429);
    expect(Number(limitedConnect.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await env.GAME.get(env.GAME.idFromName(missing)).status()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM restrictions WHERE user_id=?').bind(actor.id).first()).toBeNull();
  });

  it('keeps account limits separate for two players using the same network', async () => {
    const [first, second] = await Promise.all([account(), account()]);
    const actor = (await currentActor(request('/api/me', first), env))!;
    await env.DB.prepare('INSERT INTO request_limits(key,count,window_start) VALUES(?,?,?)')
      .bind(`account:read:${actor.id}`, ACCOUNT_REQUEST_LIMITS.read.maximum, Date.now()).run();
    const sameNetwork = { 'CF-Connecting-IP': '192.0.2.240' };
    expect((await worker.fetch(request('/api/me', first, undefined, sameNetwork), env)).status).toBe(429);
    expect((await worker.fetch(request('/api/me', second, undefined, sameNetwork), env)).status).toBe(200);
  });

  it('serves public arena projections without session lookup or a Competition binding', async () => {
    const bindings = { ...env, AUTH_SECRET: '', COMPETITION: undefined as unknown as Env['COMPETITION'] };
    const list = await worker.fetch(request('/api/arenas'), bindings);
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('public, max-age=10, s-maxage=10');
    for (const path of ['/api/arenas/missing-arena', '/api/arenas/missing-arena/standings']) {
      const missing = await worker.fetch(request(path), bindings);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: 'ARENA_NOT_FOUND' });
      expect(missing.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await worker.fetch(request('/api/arenas/missing-arena/me'), bindings)).status).toBe(503);
  });
});
