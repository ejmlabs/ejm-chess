import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, expect, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authHandler } from '../src/server/auth';
import type { Env } from '../src/server/env';
import handler from '../src/server/index';

const origin = 'http://localhost:8787';

/**
 * A verified owner behind a Cloudflare Access token, for tests that call `/api/admin/*` through the Worker.
 * Call once from a test file's `beforeAll`; the Access key set is served locally and removed after the file.
 */
export async function ownerFixture() {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const email = `${username}@example.com`;
  const signUp = await authHandler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Turnstile-Token': 'local-development', 'CF-Connecting-IP': '192.0.2.77' },
    body: JSON.stringify({ username, name: username, email, password: 'test-only-password-12345' }) }), env);
  expect(signUp.status).toBe(200);
  const cookie = signUp.headers.get('Set-Cookie')!.split(';')[0];
  await env.DB.prepare('UPDATE user SET emailVerified=1 WHERE email=?').bind(email).run();
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const config: Env = { ...env, CF_ACCESS_TEAM_DOMAIN: 'chess-owner-test.cloudflareaccess.com', CF_ACCESS_AUD: 'owner-audience', OWNER_EMAILS: email };
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== 'https://chess-owner-test.cloudflareaccess.com/cdn-cgi/access/certs') throw new Error('Unexpected network request in a local test.');
    return Response.json({ keys: [{ ...jwk, kid: 'owner-key', alg: 'RS256' }] });
  });
  afterAll(() => { vi.unstubAllGlobals(); });
  const token = await new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'owner-key' })
    .setIssuer('https://chess-owner-test.cloudflareaccess.com').setAudience('owner-audience').setSubject('test-owner').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  return async (path: string, body?: unknown): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await handler.fetch(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: cookie, Origin: origin, 'CF-Access-Jwt-Assertion': token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
}
