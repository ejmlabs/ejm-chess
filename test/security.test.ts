import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { canonicalOrigin, readJson, requireAdmin, requireSameOrigin, verifyAccessJwt, verifyTurnstile } from '../src/server/security';

const local = { AUTH_BASE_URL: 'http://localhost:8787', LOCAL_DEV: 'true' };

describe('browser trust boundaries', () => {
  it('permits a local challenge bypass only with an explicit loopback configuration and request', async () => {
    const headers = { 'X-Turnstile-Token': 'local-development' };
    await expect(verifyTurnstile(new Request('http://localhost:8787/api/auth/sign-up/email', { headers }), local, 'sign-up')).resolves.toBeUndefined();
    await expect(verifyTurnstile(new Request('https://chess.ejmlabs.com/api/auth/sign-up/email', { headers }), local, 'sign-up')).rejects.toMatchObject({ code: 'CHALLENGE_UNAVAILABLE' });
    expect(() => canonicalOrigin({ AUTH_BASE_URL: 'https://untrusted.example', LOCAL_DEV: 'true' })).toThrow();
    expect(() => requireSameOrigin(new Request('http://localhost:8787/api/report', { headers: { Origin: 'https://attacker.example' } }), local)).toThrow();
  });

  it('validates Turnstile result, action, hostname, time, and replay failure on the server', async () => {
    const request = new Request('https://chess.ejmlabs.com/api/report', { headers: { 'X-Turnstile-Token': 'one-use-challenge' } });
    const env = { AUTH_BASE_URL: 'https://chess.ejmlabs.com', TURNSTILE_SECRET_KEY: 'test-secret' };
    const result = { success: true, hostname: 'chess.ejmlabs.com', action: 'report', challenge_ts: new Date().toISOString() };
    const responder = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
    await expect(verifyTurnstile(request, env, 'report', responder(result))).resolves.toBeUndefined();
    for (const invalid of [{ ...result, success: false }, { ...result, action: 'guest' }, { ...result, hostname: 'other.example' }, { ...result, challenge_ts: new Date(Date.now() - 301_000).toISOString() }]) {
      await expect(verifyTurnstile(request, env, 'report', responder(invalid))).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    }
    await expect(verifyTurnstile(request, env, 'report', (async () => { throw new Error('outage'); }) as typeof fetch)).rejects.toMatchObject({ status: 503 });
  });

  it('bounds streamed JSON even without a Content-Length header', async () => {
    const request = new Request('http://localhost:8787', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(17_000) }) });
    await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request('http://localhost:8787', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('private reviewer authentication', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let resolver: ReturnType<typeof createLocalJWKSet>;
  const env = { AUTH_BASE_URL: 'https://chess.ejmlabs.com', CF_ACCESS_TEAM_DOMAIN: 'chess-owner.cloudflareaccess.com', CF_ACCESS_AUD: 'private-review-audience', OWNER_EMAILS: 'owner@example.com' };
  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    const jwk = await exportJWK(keys.publicKey);
    resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'reviewer-key', alg: 'RS256' }] });
  });
  const sign = async (audience = env.CF_ACCESS_AUD, expires = '1h') => new SignJWT({ email: 'owner@example.com', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'reviewer-key' }).setIssuer(`https://${env.CF_ACCESS_TEAM_DOMAIN}`)
    .setAudience(audience).setSubject('access-owner').setIssuedAt().setExpirationTime(expires).sign(keys.privateKey);

  it('verifies the signature, issuer, audience, expiry, and required app identity', async () => {
    await expect(verifyAccessJwt(await sign(), env, resolver)).resolves.toBe('owner@example.com');
    await expect(verifyAccessJwt(await sign('wrong-audience'), env, resolver)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    await expect(verifyAccessJwt(await sign(env.CF_ACCESS_AUD, '-1s'), env, resolver)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    const invalid = (await sign()).split('.');
    invalid[2] = 'invalid-signature';
    await expect(verifyAccessJwt(invalid.join('.'), env, resolver)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('denies public requests and spoofed identity headers without an owner session and Access JWT', async () => {
    const request = new Request('https://chess.ejmlabs.com/api/admin/cases', { headers: { 'CF-Access-Authenticated-User-Email': 'owner@example.com' } });
    await expect(requireAdmin(request, env, null)).rejects.toMatchObject({ status: 403 });
    await expect(requireAdmin(request, env, { id: 'owner', email: 'owner@example.com', emailVerified: true, isAnonymous: false })).rejects.toMatchObject({ status: 403 });
  });
});
