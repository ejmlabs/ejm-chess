import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import handler from '../src/server/index';
import { player } from './authority-helpers';

const origin = 'https://chess.ejmlabs.com';
const config = { ...env, AUTH_BASE_URL: origin, LOCAL_DEV: undefined, AUTH_SECRET: '' };
const cursor = btoa(JSON.stringify({ rating: 1500, id: 'p' }));

/** Counts every D1 entry point so a warm read can prove it never reached the database. */
function counted() {
  const calls = { count: 0 };
  const DB = new Proxy(env.DB, { get(target, name) {
    if (name === 'prepare' || name === 'batch') calls.count++;
    const value = Reflect.get(target, name) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { calls, bindings: { ...config, DB } };
}

async function get(path: string, headers: HeadersInit = {}, bindings = config) {
  const ctx = createExecutionContext();
  const response = await handler.fetch(new Request(origin + path, { headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const keys = ['/api/leaderboard', `/api/leaderboard?pool=rapid`, `/api/leaderboard?cursor=${cursor}`, '/api/leaderboard?unrelated=1'];
beforeEach(async () => {
  for (const key of keys) await caches.default.delete(new Request(origin + key));
});

describe('public leaderboard cache', () => {
  it('serves a warm read from the edge without D1, a session or a cookie variant', async () => {
    const first = await get('/api/leaderboard');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, no-cache');
    const body = await first.json();
    const { calls, bindings } = counted();
    const warm = await get('/api/leaderboard?unrelated=1', { Cookie: 'better-auth.session_token=private-value', Authorization: 'Bearer private-value' }, bindings);
    expect(warm.status).toBe(200);
    expect(warm.headers.get('Cache-Control')).toBe('public, no-cache');
    expect(warm.headers.has('Set-Cookie')).toBe(false);
    expect(await warm.json()).toEqual(body);
    expect(calls.count).toBe(0);
    expect(await caches.default.match(new Request(origin + '/api/leaderboard?unrelated=1'))).toBeUndefined();
  });

  it('keeps one entry per documented pool and cursor, each read from D1 once', async () => {
    await get('/api/leaderboard');
    for (const query of ['?pool=rapid', `?cursor=${cursor}`]) {
      const cold = counted();
      expect((await get('/api/leaderboard' + query, {}, cold.bindings)).status).toBe(200);
      expect(cold.calls.count, query).toBeGreaterThan(0);
      const warm = counted();
      expect((await get('/api/leaderboard' + query, {}, warm.bindings)).status).toBe(200);
      expect(warm.calls.count, query).toBe(0);
    }
  });

  it('never stores a rejected read', async () => {
    const rejected = await get('/api/leaderboard?pool=bullet');
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get('Cache-Control')).toBe('no-store');
    expect(await caches.default.match(new Request(origin + '/api/leaderboard?pool=bullet'))).toBeUndefined();
  });
});

describe('public profile cache', () => {
  it('caches a found profile and leaves a missing one uncached until it exists', async () => {
    const actor = await player();
    const missing = crypto.randomUUID();
    const found = new Request(`${origin}/api/players/${actor.id}`);
    await caches.default.delete(found);
    await caches.default.delete(new Request(`${origin}/api/players/${missing}`));

    const absent = await get(`/api/players/${missing}`);
    expect(absent.status).toBe(404);
    expect(absent.headers.get('Cache-Control')).toBe('no-store');
    expect(await caches.default.match(new Request(`${origin}/api/players/${missing}`))).toBeUndefined();

    const first = await get(`/api/players/${actor.id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, no-cache');
    const { calls, bindings } = counted();
    const warm = await get(`/api/players/${actor.id}?utm=x`, { Cookie: 'session=private' }, bindings);
    expect(await warm.json()).toEqual(await first.json());
    expect(calls.count).toBe(0);
  });
});
