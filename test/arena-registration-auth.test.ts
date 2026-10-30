import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getCookies } from 'better-auth/cookies';
import { makeSignature } from 'better-auth/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authOptions, createAuth } from '../src/server/auth';
import { ARENA_POLICY } from '../src/server/arena-policy';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import { player } from './authority-helpers';

afterEach(() => vi.restoreAllMocks());

async function fixture(work: (instance: Competition, state: DurableObjectState, request: Request, eventId: string) => Promise<void>) {
  const actor = await player(false, { recoveryEmail: false });
  const stored = await env.DB.prepare('SELECT token FROM session WHERE id=?').bind(actor.sessionId).first<{ token: string }>();
  if (!stored) throw new Error('fixture_session_missing');
  const bindings = { ...env, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: 'false' };
  const name = getCookies(authOptions(bindings)).sessionToken.name;
  const cookie = `${name}=${encodeURIComponent(`${stored.token}.${await makeSignature(stored.token, env.AUTH_SECRET)}`)}`;
  const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`registration-auth-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...bindings, ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false' };
    internal.schedule = async () => {};
    await (await createAuth(internal.env).$context).checkSchema?.();
    const startsAt = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    vi.spyOn(Date, 'now').mockReturnValue(startsAt - 600_000);
    const eventId = `arena-hourly-${startsAt}`;
    await work(instance, state, new Request(`https://chess.ejmlabs.com/api/arenas/${eventId}/register`, { headers: { Cookie: cookie } }), eventId);
  });
}

describe('global native registration authentication', () => {
  it('rejects excess work before primary auth and releases the global guard after real auth failure', async () => {
    await fixture(async (instance, state, request, eventId) => {
      const database = (instance as unknown as { env: Env }).env.DB;
      const original = database.prepare.bind(database);
      for (const fail of [true, false]) {
        let release!: () => void, started = 0;
        const paused = new Promise<void>(resolve => { release = resolve; });
        const prepare = vi.spyOn(database, 'prepare').mockImplementation(query => {
          const statement = original(query);
          if (!query.startsWith('SELECT u.id AS userId,s.id AS sessionId')) return statement;
          return { bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return { first: async () => { started++; await paused; if (fail) throw new Error('primary_auth_unavailable'); return bound.first(); } };
          } } as unknown as D1PreparedStatement;
        });
        const pending = Array.from({ length: ARENA_POLICY.registrationAuthConcurrency }, () =>
          instance.registerArenaRequest(request, eventId).then(value => ({ value }), error => ({ error })));
        try {
          await vi.waitFor(() => expect(started).toBe(ARENA_POLICY.registrationAuthConcurrency), { timeout: 1_000, interval: 1 });
          const queries = prepare.mock.calls.length;
          expect(await instance.registerArenaRequest(request, eventId)).toMatchObject({ ok: false,
            error: { code: 'ARENA_RETRY', status: 429 } });
          expect(prepare).toHaveBeenCalledTimes(queries);
          expect(state.storage.sql.exec('SELECT 1 FROM arena_entries').toArray()).toEqual([]);
        } finally { release(); }
        const replies = await Promise.all(pending);
        prepare.mockRestore();
        if (fail) expect(replies.every(reply => 'error' in reply && reply.error.message === 'primary_auth_unavailable')).toBe(true);
        else expect(replies.every(reply => 'value' in reply && reply.value.ok)).toBe(true);
      }
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entries').one().count).toBe(1);
      const unsigned = new Request(request.url, { headers: { 'x-chess-actor': JSON.stringify({ id: 'forged-player', sessionId: 'forged-session' }) } });
      expect(await instance.registerArenaRequest(unsigned, eventId)).toMatchObject({ ok: false,
        error: { status: 401, code: 'SIGN_IN_REQUIRED' } });
      expect(await instance.authenticateArenaRegistration(request)).toMatchObject({ accountReady: true, isAnonymous: false });
    });
  });

  it('releases auth slots before slower fresh eligibility while keeping credential checks authoritative', async () => {
    await fixture(async (instance, state, request, eventId) => {
      const database = (instance as unknown as { env: Env }).env.DB;
      const original = database.prepare.bind(database);
      let release!: () => void, started = 0;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const prepare = vi.spyOn(database, 'prepare').mockImplementation(query => {
        const statement = original(query);
        if (!query.startsWith('SELECT s.expiresAt,')) return statement;
        return { bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return { first: async () => { started++; await paused; return bound.first(); } };
        } } as unknown as D1PreparedStatement;
      });
      const pending = Array.from({ length: ARENA_POLICY.registrationAuthConcurrency }, () => instance.registerArenaRequest(request, eventId));
      try {
        await vi.waitFor(() => expect(started).toBe(ARENA_POLICY.registrationAuthConcurrency), { timeout: 1_000, interval: 1 });
        vi.mocked(Date.now).mockReturnValue(Date.now() + Math.ceil(1_000 / ARENA_POLICY.registrationRate));
        pending.push(instance.registerArenaRequest(request, eventId));
        await vi.waitFor(() => expect(started).toBe(ARENA_POLICY.registrationAuthConcurrency + 1), { timeout: 1_000, interval: 1 });
      } finally { release(); }
      expect((await Promise.all(pending)).every(reply => reply.ok)).toBe(true);
      prepare.mockRestore();
      const actor = await instance.authenticateArenaRegistration(request);
      await database.prepare("DELETE FROM account WHERE userId=? AND providerId='credential'").bind(actor.id).run();
      expect(await instance.registerArenaRequest(request, eventId)).toMatchObject({ ok: false,
        error: { status: 403, code: 'ARENA_INELIGIBLE' } });
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entries').one().count).toBe(1);
    });
  });
});
