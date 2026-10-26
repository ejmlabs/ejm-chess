import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../src/server/index';
import { arenaRegistrationAdmission } from '../src/server/arena-registration-admission';
import { ARENA_POLICY } from '../src/server/arena-policy';

const origin = 'https://chess.ejmlabs.com';
const path = '/api/arenas';
const config = { ...env, AUTH_BASE_URL: origin, LOCAL_DEV: undefined, AUTH_SECRET: '' };

async function get(url: string, bindings = config, headers: HeadersInit = {}) {
  const ctx = createExecutionContext();
  const response = await handler.fetch(new Request(origin + url, { headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  await caches.default.delete(new Request(origin + path));
});

describe('public arena edge cache', () => {
  it('bounds registration input before its single native auth dispatch', async () => {
    const prepare = vi.fn(() => { throw new Error('Worker registration must not query D1'); });
    const registerArenaRequest = vi.fn(async (_request: Request, _id: string) => ({ ok: false as const,
      error: { status: 401, code: 'SIGN_IN_REQUIRED', message: 'Sign in.' } }));
    const bindings = { ...config, DB: { prepare } as unknown as D1Database,
      COMPETITION: { idFromName: (name: string) => name, get: () => ({ registerArenaRequest }) } as unknown as typeof config.COMPETITION };
    for (const [body, status] of [['{"unexpected":1}', 400], [JSON.stringify({ large: 'a'.repeat(1_024) }), 413], ['{}', 401]] as const) {
      const ctx = createExecutionContext();
      const response = await handler.fetch(new Request(origin + '/api/arenas/weekly/register', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body,
      }), bindings, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(status);
    }
    expect(registerArenaRequest).toHaveBeenCalledOnce();
    expect(registerArenaRequest.mock.calls[0][0]).toBeInstanceOf(Request);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects busy registration before D1 while preserving origin checks', async () => {
    const release: (() => void)[] = [];
    const occupied = Array.from({ length: ARENA_POLICY.registrationAuthConcurrency }, () =>
      arenaRegistrationAdmission.run(() => new Promise<void>(resolve => release.push(resolve))));
    const prepare = vi.fn(() => { throw new Error('Shed registration must not query D1'); });
    const bindings = { ...config, DB: { prepare } as unknown as D1Database };
    try {
      for (const [site, status] of [[origin, 429], ['https://unrelated.example', 403]] as const) {
        const ctx = createExecutionContext();
        const response = await handler.fetch(new Request(origin + '/api/arenas/weekly/register', {
          method: 'POST', headers: { Origin: site, 'Content-Type': 'application/json' }, body: '{}',
        }), bindings, ctx);
        await waitOnExecutionContext(ctx);
        expect(response.status).toBe(status);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toMatchObject({ error: status === 429 ? 'ARENA_RETRY' : 'INVALID_ORIGIN' });
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      release.forEach(done => done());
      await Promise.all(occupied);
    }
  });

  it('serves warm spectator reads without sessions, D1 or cookie-specific variants', async () => {
    const first = await get(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=10, s-maxage=10');
    const initial = await first.json();
    const prepare = vi.fn(() => { throw new Error('Warm spectator read must not query D1'); });
    const warm = await get(path + '?unrelated=ignored', { ...config, DB: { prepare } as unknown as D1Database },
      { Cookie: 'unrelated=private-value', Authorization: 'Bearer private-value' });
    expect(warm.status).toBe(200);
    expect(await warm.json()).toEqual(initial);
    expect(prepare).not.toHaveBeenCalled();
    expect(warm.headers.has('Set-Cookie')).toBe(false);
    expect(warm.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('leaves failed reads uncached so a recovered read model can answer', async () => {
    const unavailable = { ...config, DB: { prepare: () => { throw new Error('Read model unavailable'); } } as unknown as D1Database };
    const failed = await get(path, unavailable);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(await caches.default.match(new Request(origin + path))).toBeUndefined();
    expect((await get(path)).status).toBe(200);
  });
});
