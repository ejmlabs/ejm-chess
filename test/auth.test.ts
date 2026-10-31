import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import handler from '../src/server/index';
import { accountRequestStatus } from '../src/server/abuse';
import { budgetStatus } from '../src/server/budget';
import { setBudgetStops } from '../src/server/operations';
import { acquireSeatGuard, authHandler, casualGameLimit, completeAccount, createAuth, currentActor, getActorBySessionId, hasRecoveryEmail, knownGame, rankedEligibility, revalidateActor, type AuthEnv } from '../src/server/auth';

const origin = 'http://localhost:8787';
const password = 'test1234';
let address = 1;
const name = () => `p_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
function post(path: string, body: unknown = {}, cookie?: string, authEnv: AuthEnv = env, ip?: string): Request {
  const action = path.includes('sign-up') ? 'sign-up' : path.includes('sign-in') ? 'sign-in'
    : path.includes('send-verification') ? 'verify-email' : path.includes('/account/complete') ? 'account-complete' : 'password-reset';
  return new Request(authEnv.AUTH_BASE_URL + path, { method: 'POST', headers: { Origin: authEnv.AUTH_BASE_URL, 'Content-Type': 'application/json',
    'X-Turnstile-Token': authEnv.LOCAL_DEV === 'true' ? 'local-development' : action,
    'CF-Connecting-IP': ip ?? `192.0.${Math.floor(address / 250)}.${address++ % 250 + 1}`, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
}
async function account(authEnv: AuthEnv = env) {
  const username = name();
  const email = `${username}@example.test`;
  const response = await authHandler(post('/api/auth/sign-up/email', { username, email, password, name: username }, undefined, authEnv), authEnv);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const actor = await currentActor(new Request(authEnv.AUTH_BASE_URL, { headers: { Cookie: cookie } }), authEnv);
  return { actor: actor!, cookie, username, email };
}
async function legacyGuest() {
  // The maintained plugin seeds a pre-rollout identity; its public route is closed.
  const response = await createAuth(env).handler(post('/api/auth/sign-in/anonymous'));
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const actor = await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env);
  expect(actor).toMatchObject({ isAnonymous: true, username: null, accountReady: false });
  return { actor: actor!, cookie };
}
async function fetchWorker(request: Request) {
  const context = createExecutionContext();
  const response = await handler.fetch(request, env, context);
  await waitOnExecutionContext(context);
  return response;
}
function productionChallenges() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network request.');
    const action = (init?.body as FormData).get('response');
    return Response.json({ success: true, hostname: 'chess.ejmlabs.com', action, challenge_ts: new Date().toISOString() });
  });
}

describe('native D1 player accounts', () => {
  it('overlaps primary session and credential reads and still observes credential removal and revoked sessions', async () => {
    const created = await account();
    let armed = false, pending = 0, maximumPending = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const statement = (native: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(native, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values), query);
        if (key === 'first' || key === 'all') return async (...values: unknown[]) => {
          const measured = armed && /\bFROM\s+["`]?session\b/i.test(query);
          if (measured) {
            maximumPending = Math.max(maximumPending, ++pending);
            if (pending === 2) releaseGate();
            await gate;
          }
          try { return await (target[key] as (...args: unknown[]) => Promise<unknown>)(...values); }
          finally { if (measured) pending--; }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === 'prepare') return (query: string) => statement(target.prepare(query), query);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const checked = { ...env, DB: db };
    await (await createAuth(checked).$context).checkSchema?.();
    const request = new Request(origin, { headers: { Cookie: created.cookie } });
    armed = true;
    // Release on regression too, so a serial implementation fails an
    // assertion instead of leaving a database operation alive after the test.
    const timeout = setTimeout(releaseGate, 500);
    try {
      expect(await currentActor(request, checked)).toMatchObject({ id: created.actor.id, accountReady: true });
      expect(maximumPending).toBe(2);
    } finally { clearTimeout(timeout); armed = false; releaseGate(); }
    await env.DB.prepare("DELETE FROM account WHERE userId=? AND providerId='credential'").bind(created.actor.id).run();
    expect(await currentActor(request, checked)).toMatchObject({ id: created.actor.id, accountReady: false });
    await env.DB.prepare('DELETE FROM session WHERE id=?').bind(created.actor.sessionId).run();
    expect(await currentActor(request, checked)).toBeNull();
  });

  it('charges failed signup work, rejects stopped signup before hashing, and keeps existing signin available', async () => {
    const created = await account();
    // A distinct env object gets its own Better Auth instance, so the spy cannot leak into other tests.
    const guarded = { ...env };
    const native = vi.spyOn(createAuth(guarded), 'handler');
    const originalControl = (await budgetStatus(guarded)).control;
    try {
      const before = (await budgetStatus(guarded)).signup.lifetimeUsed;
      await expect(authHandler(post('/api/auth/sign-up/email', { username: name(), password: 'short' }, undefined, guarded), guarded)).rejects.toMatchObject({ code: 'INVALID_PASSWORD_LENGTH' });
      expect((await budgetStatus(guarded)).signup.lifetimeUsed).toBe(before);
      const duplicate = await authHandler(post('/api/auth/sign-up/email', { username: created.username, password }, undefined, guarded), guarded);
      expect(duplicate.status).toBe(400);
      expect((await budgetStatus(guarded)).signup.lifetimeUsed).toBe(before + 1);
      native.mockClear();
      const users = await env.DB.prepare('SELECT COUNT(*) AS count FROM user').first('count');
      const version = (await budgetStatus(guarded)).control.version;
      await setBudgetStops(guarded, 'owner-fixture', { expectedVersion: version, gamesStopped: true, emailStopped: false, analysisStopped: true, reason: 'Testing bounded signup admission.' });
      await expect(authHandler(post('/api/auth/sign-up/email', { username: name(), password }, undefined, guarded), guarded)).rejects.toMatchObject({ status: 503, code: 'SIGNUP_UNAVAILABLE' });
      expect(native).not.toHaveBeenCalled();
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM user').first('count')).toBe(users);
      expect((await authHandler(post('/api/auth/sign-in/username', { username: created.username, password }, undefined, guarded), guarded)).status).toBe(200);
      expect((await budgetStatus(guarded)).signup.lifetimeUsed).toBe(before + 1);
    } finally {
      native.mockRestore();
      const control = (await budgetStatus(guarded)).control;
      if (control.version !== originalControl.version) await setBudgetStops(guarded, 'owner-fixture', {
        expectedVersion: control.version, gamesStopped: Boolean(originalControl.games_stopped),
        emailStopped: Boolean(originalControl.email_stopped), analysisStopped: Boolean(originalControl.analysis_stopped),
        reason: 'Restore the pre-test stop settings.',
      });
    }
  });

  it('drains an in-flight session read when starting the companion credential read throws', async () => {
    const created = await account();
    let markEntered!: () => void, releaseRead!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseRead = resolve; });
    let armed = false, sessionStarted = false, finished = false;
    const statement = (native: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(native, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values), query);
        if (key === 'all') return async () => {
          if (armed && /\bFROM\s+["`]?session\b/i.test(query)) {
            sessionStarted = true; markEntered(); await release;
          }
          return target.all();
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === 'prepare') return (query: string) => {
        if (armed && query.includes('AS accountReady')) throw new Error('credential_read_start_failed');
        return statement(target.prepare(query), query);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const checked = { ...env, DB: db };
    await (await createAuth(checked).$context).checkSchema?.();
    armed = true;
    const result = currentActor(new Request(origin, { headers: { Cookie: created.cookie } }), checked)
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    void result.then(() => { finished = true; });
    const timeout = setTimeout(() => { markEntered(); releaseRead(); }, 500);
    try {
      await entered;
      expect(sessionStarted).toBe(true);
      expect(finished).toBe(false);
    } finally { clearTimeout(timeout); releaseRead(); }
    expect((await result).error).toMatchObject({ message: 'credential_read_start_failed' });
  });

  it('accepts omitted or blank recovery email without changing explicit account, session or competition ownership', async () => {
    const addresses = new Set<string>();
    for (const email of [undefined, '', '  \t  ']) {
      const username = name();
      const created = await fetchWorker(post('/api/auth/sign-up/email', { username, password, ...(email === undefined ? {} : { email }) }));
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({ ok: true });
      const cookie = created.headers.get('Set-Cookie')!.split(';')[0];
      const actor = (await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env))!;
      expect(actor).toMatchObject({ username, emailVerified: false, isAnonymous: false, accountReady: true });
      expect(hasRecoveryEmail(actor.email)).toBe(false);
      expect(actor.email.includes(username)).toBe(false);
      addresses.add(actor.email);
      const me = await (await fetchWorker(new Request(origin + '/api/me', { headers: { Cookie: cookie } }))).json();
      expect(me).toMatchObject({ id: actor.id, username, accountReady: true, hasRecoveryEmail: false, emailVerified: false, isAnonymous: false });
      expect(Object.keys(me as object).sort()).toEqual(['accountReady', 'emailVerified', 'hasRecoveryEmail', 'id', 'isAnonymous', 'name', 'username']);
      expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, actor.id)).toEqual({ eligible: true });
      expect(await rankedEligibility(env, actor.id)).toEqual({ eligible: false, reason: 'RANKED_CLOSED' });
      expect(await getActorBySessionId(env, actor.sessionId)).toMatchObject({ id: actor.id, emailVerified: false });
      const signedIn = await authHandler(post('/api/auth/sign-in/username', { username, password }), env);
      expect(signedIn.status).toBe(200);
      const nextCookie = signedIn.headers.get('Set-Cookie')!.split(';')[0];
      expect(await currentActor(new Request(origin, { headers: { Cookie: nextCookie } }), env)).toMatchObject({ id: actor.id, emailVerified: false, accountReady: true });
    }
    expect(addresses.size).toBe(3);
  });

  it('rejects invalid and reserved recovery addresses without creating an account', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM user').first<{ count: number }>();
    for (const email of ['player@chess.placeholder.invalid', 'PLAYER@NAMESPACE.INVALID', 'player@invalid', null, 17, 'not-an-email', 'player@', '@example.test']) {
      const response = await fetchWorker(post('/api/auth/sign-up/email', { username: name(), password, email }));
      expect(response.status).toBe(400);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM user').first<{ count: number }>())?.count).toBe(before?.count);
  });

  it('suppresses placeholder verification and reset before native token and mail work', async () => {
    let sends = 0;
    const production: AuthEnv = { ...env, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: undefined, TURNSTILE_SECRET_KEY: 'synthetic-challenge-secret', EMAIL_FROM: 'chess@ejmlabs.com', EMAIL: { send: async () => { sends++; } } };
    const challenge = productionChallenges();
    const native = vi.spyOn(createAuth(production), 'handler');
    try {
      const username = name();
      const created = await authHandler(post('/api/auth/sign-up/email', { username, password }, undefined, production), production);
      expect(created.status).toBe(200);
      const cookie = created.headers.get('Set-Cookie')!.split(';')[0];
      const actor = (await currentActor(new Request(production.AUTH_BASE_URL, { headers: { Cookie: cookie } }), production))!;
      native.mockClear();
      const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM verification').first<{ count: number }>();
      const mailBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM budget_receipts WHERE kind='email'").first<{ count: number }>();
      const receipts = [];
      receipts.push(await authHandler(post('/api/auth/send-verification-email', {}, cookie, production), production));
      for (const email of [actor.email, actor.email.toUpperCase(), 'nobody@reserved.invalid']) {
        receipts.push(await authHandler(post('/api/auth/request-password-reset', { email }, undefined, production), production));
      }
      for (const receipt of receipts) expect(receipt.status).toBe(202);
      expect(native).not.toHaveBeenCalled();
      expect(sends).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM verification').first<{ count: number }>())?.count).toBe(before?.count);
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM budget_receipts WHERE kind='email'").first<{ count: number }>())?.count).toBe(mailBefore?.count);
      expect(await getActorBySessionId(env, actor.sessionId)).toMatchObject({ id: actor.id, emailVerified: false });
      const unknown = await authHandler(post('/api/auth/request-password-reset', { email: `${name()}@example.test` }, undefined, production), production);
      expect(unknown.status).toBe(202);
      expect(await receipts[0].json()).toEqual(await unknown.json());
    } finally { native.mockRestore(); challenge.mockRestore(); }
  });

  it('uses maintained password signup and signin without mail, hashes the credential, and rechecks session revocation', async () => {
    const start = performance.now();
    const created = await account();
    const signupMs = performance.now() - start;
    expect(created.actor).toMatchObject({ name: created.username, username: created.username, emailVerified: false, isAnonymous: false, accountReady: true });
    const stored = await env.DB.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").bind(created.actor.id).first<{ password: string }>();
    expect(Boolean(stored?.password && stored.password !== password)).toBe(true);
    expect(await getActorBySessionId(env, created.actor.sessionId)).toMatchObject({ id: created.actor.id, accountReady: true });
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, created.actor.id)).toEqual({ eligible: true });
    expect((await authHandler(post('/api/auth/sign-out', {}, created.cookie), env)).ok).toBe(true);
    expect(await revalidateActor(created.actor, env)).toBe(false);
    const beforeSignin = performance.now();
    const signedIn = await authHandler(post('/api/auth/sign-in/username', { username: created.username.toUpperCase(), password }), env);
    const signinMs = performance.now() - beforeSignin;
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ ok: true });
    const cookie = signedIn.headers.get('Set-Cookie')!.split(';')[0];
    const actor = (await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env))!;
    expect(actor.id).toBe(created.actor.id);
    await env.DB.prepare('UPDATE session SET expiresAt=? WHERE id=?').bind(new Date(Date.now() - 1).toISOString(), actor.sessionId).run();
    expect(await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env)).toBeNull();
    expect(await revalidateActor(actor, env)).toBe(false);
    console.info('password_worker_probe', JSON.stringify({ signupMs: Math.round(signupMs), signinMs: Math.round(signinMs), hash: 'Better Auth default', runtime: 'native local Worker', measurement: 'wall time, not CPU' }));
  });

  it('normalizes unique usernames, rejects private signup fields, and hides email collisions and signin failures', async () => {
    const created = await account();
    const wrong = await authHandler(post('/api/auth/sign-in/username', { username: created.username, password: 'wrong-test-password' }), env);
    const absent = await authHandler(post('/api/auth/sign-in/username', { username: name(), password: 'wrong-test-password' }), env);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(await absent.json());
    for (const body of [{ username: name(), email: created.email, password }, { username: created.username.toUpperCase(), email: `${name()}@example.test`, password }]) {
      const denied = await authHandler(post('/api/auth/sign-up/email', body), env);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: 'ACCOUNT_NOT_CREATED', message: 'An account could not be created. Check your details or sign in.' });
      expect(denied.headers.get('Set-Cookie')).toBeNull();
    }
    for (const extra of [{ emailVerified: true }, { isAnonymous: false }, { metadata: { private: 'unsupported' } }]) {
      await expect(authHandler(post('/api/auth/sign-up/email', { username: name(), email: `${name()}@example.test`, password, ...extra }), env)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    for (const username of ['ab', 'a'.repeat(25), 'a.b', 'pläyer']) await expect(authHandler(post('/api/auth/sign-up/email', { username, email: `${name()}@example.test`, password }), env)).rejects.toMatchObject({ code: 'INVALID_USERNAME' });
    for (const value of ['a'.repeat(7), 'a'.repeat(129)]) await expect(authHandler(post('/api/auth/sign-up/email', { username: name(), email: `${name()}@example.test`, password: value }), env)).rejects.toMatchObject({ code: 'INVALID_PASSWORD_LENGTH' });
    await expect(authHandler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' }), env)).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    for (const path of ['/api/auth/sign-in/anonymous', '/api/auth/sign-in/magic-link', '/api/auth/get-session']) await expect(authHandler(post(path), env)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('counts rejected native signin and signup attempts in database route limits', async () => {
    const created = await account();
    const unknown = name();
    for (let index = 0; index < 6; index++) {
      const signin = await authHandler(post('/api/auth/sign-in/username', { username: unknown, password }, undefined, env, '192.0.2.240'), env);
      expect(signin.status).toBe(index < 5 ? 401 : 429);
      const signup = await authHandler(post('/api/auth/sign-up/email', { username: created.username, email: `${name()}@example.test`, password }, undefined, env, '192.0.2.241'), env);
      expect(signup.status).toBe(index < 5 ? 400 : 429);
    }
    const limited = await authHandler(post('/api/auth/sign-in/username', { username: created.username, password }, undefined, env, '192.0.2.240'), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).not.toBeNull();
  });

  it('serializes signup, signin and signout against seats and tournament reservations', async () => {
    const created = await account();
    const admitted = await Promise.all(Array.from({ length: 5 }, () => acquireSeatGuard(env, created.actor, crypto.randomUUID())));
    expect(admitted.filter(Boolean)).toHaveLength(4);
    for (const request of [post('/api/auth/sign-out', {}, created.cookie), post('/api/auth/sign-in/username', { username: created.username, password }, created.cookie), post('/api/auth/sign-up/email', { username: name(), email: `${name()}@example.test`, password }, created.cookie)]) await expect(authHandler(request, env)).rejects.toMatchObject({ code: 'ACTIVE_GAME' });
    await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=?').bind(Date.now(), created.actor.id).run();
    await env.DB.prepare('INSERT INTO identity_change_leases(user_id,lease_id,expires_at) VALUES(?,?,?)').bind(created.actor.id, 'test-pending-signin', Date.now() + 60_000).run();
    expect(await acquireSeatGuard(env, created.actor, crypto.randomUUID())).toBe(false);
    await env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=?').bind(created.actor.id).run();
    await env.DB.prepare('INSERT INTO tournament_account_locks(user_id,tournament_id,acquired_at) VALUES(?,?,?)').bind(created.actor.id, 'legacy-account-lock', Date.now()).run();
    await expect(authHandler(post('/api/auth/sign-out', {}, created.cookie), env)).rejects.toMatchObject({ code: 'ACTIVE_GAME' });
  });

  it('preserves a legacy guest seat and replay while denying new games, seats and account promotion', async () => {
    const guest = await legacyGuest();
    const otherGuest = await legacyGuest();
    const opponent = await account();
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at) VALUES(?,?,?)').bind(id, guest.actor.id, Date.now()),
      env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(guest.actor.id, id, Date.now()),
    ]);
    const game = env.GAME.get(env.GAME.idFromName(id));
    await game.init({ id, format: 'blitz', rated: false, white: guest.actor, black: opponent.actor });
    expect((await fetchWorker(post(`/api/games/${id}/join`, {}, guest.cookie))).status).toBe(200);
    expect((await fetchWorker(post(`/api/games/${id}/join`, {}, otherGuest.cookie))).status).toBe(403);
    expect((await fetchWorker(post('/api/games', { id: crypto.randomUUID(), format: 'blitz' }, guest.cookie))).status).toBe(403);
    expect(await acquireSeatGuard(env, guest.actor, crypto.randomUUID())).toBe(false);
    expect(await acquireSeatGuard(env, guest.actor, id, false, true)).toBe(true);
    await expect(completeAccount(post('/api/account/complete', { username: name(), password }, guest.cookie), env)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' });
    await expect(authHandler(post('/api/auth/sign-up/email', { username: name(), email: `${name()}@example.test`, password }, guest.cookie), env)).rejects.toMatchObject({ code: 'ACTIVE_GAME' });
    const initial = await game.snapshot(guest.actor);
    const first = await game.command(guest.actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
    expect(first.ok).toBe(true);
    const second = await game.command(opponent.actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
    expect(second.ok).toBe(true);
    const ended = await game.command(guest.actor, { type: 'resign', id: crypto.randomUUID(), expectedVersion: second.snapshot.version });
    expect(ended.ok).toBe(true);
    await game.flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    const replay = await fetchWorker(new Request(origin + `/api/games/${id}/pgn`, { headers: { Cookie: guest.cookie } }));
    expect(replay.status).toBe(200);
    expect(await getActorBySessionId(env, guest.actor.sessionId)).toMatchObject({ id: guest.actor.id, isAnonymous: true, username: null, accountReady: false });
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, guest.actor.id)).toMatchObject({ eligible: false, reason: 'ACCOUNT_REQUIRED' });
    expect((await authHandler(post('/api/auth/sign-up/email', { username: name(), email: `${name()}@example.test`, password }, guest.cookie), env)).status).toBe(200);
    expect((await env.DB.prepare('SELECT white_id FROM games WHERE id=?').bind(id).first<{ white_id: string }>())?.white_id).toBe(guest.actor.id);
    expect(await env.DB.prepare('SELECT username,isAnonymous FROM user WHERE id=?').bind(guest.actor.id).first()).toEqual({ username: null, isAnonymous: 1 });
  });

  it('completes a legacy explicit account through public APIs without changing its ID', async () => {
    const legacy = await legacyGuest();
    await env.DB.prepare('UPDATE user SET isAnonymous=0,emailVerified=1 WHERE id=?').bind(legacy.actor.id).run();
    const username = name();
    await expect(completeAccount(post('/api/account/complete', { username, password: 'a'.repeat(7) }, legacy.cookie), env)).rejects.toMatchObject({ code: 'INVALID_PASSWORD_LENGTH' });
    expect((await completeAccount(post('/api/account/complete', { username, password }, legacy.cookie), env)).status).toBe(200);
    expect(await currentActor(new Request(origin, { headers: { Cookie: legacy.cookie } }), env)).toMatchObject({ id: legacy.actor.id, username, name: username, accountReady: true, emailVerified: true, isAnonymous: false });
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, legacy.actor.id)).toEqual({ eligible: true });
    await authHandler(post('/api/auth/sign-out', {}, legacy.cookie), env);
    expect((await authHandler(post('/api/auth/sign-in/username', { username, password }), env)).status).toBe(200);
  });

  it('bounds legacy credential attempts and reports their exhausted window once', async () => {
    const legacy = await legacyGuest();
    const existing = await account();
    await env.DB.prepare('UPDATE user SET isAnonymous=0,emailVerified=1 WHERE id=?').bind(legacy.actor.id).run();
    const baseline = (await accountRequestStatus(env.DB)).exhaustedWindows.credential;
    for (let index = 0; index < 4; index++) {
      await expect(completeAccount(post('/api/account/complete', { username: existing.username, password }, legacy.cookie), env))
        .rejects.toMatchObject({ code: index < 3 ? 'ACCOUNT_NOT_COMPLETED' : 'REQUEST_RATE_LIMITED' });
    }
    expect((await accountRequestStatus(env.DB)).exhaustedWindows.credential).toBe(baseline + 1);
  });

  it('verifies email without signin and uses hashed, expiring, single-use resets with session revocation', async () => {
    let sent = '';
    const production: AuthEnv = { ...env, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: undefined, TURNSTILE_SECRET_KEY: 'synthetic-challenge-secret', EMAIL_FROM: 'chess@ejmlabs.com', EMAIL: { send: async message => { sent = message.text; } } };
    const challenge = productionChallenges();
    try {
      const created = await account(production);
      expect((await authHandler(post('/api/auth/send-verification-email', {}, created.cookie, production), production)).status).toBe(202);
      const link = sent.match(/https:\/\/\S+/)![0];
      const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM session WHERE userId=?').bind(created.actor.id).first<{ count: number }>();
      const verified = await authHandler(new Request(link), production);
      expect(verified.status).toBe(302);
      expect(verified.headers.get('Set-Cookie')).toBeNull();
      expect(verified.headers.get('Location')).toBe('/account/?verified=1');
      expect((await authHandler(new Request(link), production)).headers.get('Set-Cookie')).toBeNull();
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM session WHERE userId=?').bind(created.actor.id).first<{ count: number }>())?.count).toBe(before?.count);
      const signedIn = await authHandler(post('/api/auth/sign-in/username', { username: created.username, password }, undefined, production), production);
      const secureCookie = signedIn.headers.get('Set-Cookie')!;
      expect(secureCookie).toContain('Secure');
      expect(secureCookie).toContain('HttpOnly');
      expect(secureCookie).not.toContain('Domain=');
      const otherCookie = secureCookie.split(';')[0];
      expect(await currentActor(new Request(production.AUTH_BASE_URL, { headers: { Cookie: otherCookie } }), production)).toMatchObject({ id: created.actor.id, emailVerified: true });
      expect((await authHandler(post('/api/auth/request-password-reset', { email: created.email }, undefined, production), production)).status).toBe(202);
      const resetUrl = new URL(sent.match(/https:\/\/\S+/)![0]);
      expect(resetUrl.pathname).toBe('/account/');
      const token = resetUrl.searchParams.get('reset')!;
      const stored = (await env.DB.prepare('SELECT identifier,value FROM verification').all<{ identifier: string; value: string }>()).results;
      expect(stored.some(row => row.identifier.includes(token) || row.value.includes(token))).toBe(false);
      for (const newPassword of ['a'.repeat(7), 'a'.repeat(129)]) {
        await expect(authHandler(post('/api/auth/reset-password', { token, newPassword }, undefined, production), production)).rejects.toMatchObject({ code: 'INVALID_PASSWORD_LENGTH' });
      }
      const newPassword = 'reset123';
      const reset = await authHandler(post('/api/auth/reset-password', { token, newPassword }, undefined, production), production);
      expect(reset.status).toBe(200);
      expect(reset.headers.get('Set-Cookie')).toBeNull();
      expect(await currentActor(new Request(production.AUTH_BASE_URL, { headers: { Cookie: created.cookie } }), production)).toBeNull();
      expect(await currentActor(new Request(production.AUTH_BASE_URL, { headers: { Cookie: otherCookie } }), production)).toBeNull();
      expect((await authHandler(post('/api/auth/reset-password', { token, newPassword }, undefined, production), production)).status).toBe(400);
      expect((await authHandler(post('/api/auth/sign-in/username', { username: created.username, password }, undefined, production), production)).status).toBe(401);
      expect((await authHandler(post('/api/auth/sign-in/username', { username: created.username, password: newPassword }, undefined, production), production)).status).toBe(200);
      await authHandler(post('/api/auth/request-password-reset', { email: created.email }, undefined, production), production);
      const expired = new URL(sent.match(/https:\/\/\S+/)![0]).searchParams.get('reset')!;
      await env.DB.prepare('UPDATE verification SET expiresAt=? WHERE value=?').bind(new Date(Date.now() - 1).toISOString(), created.actor.id).run();
      expect((await authHandler(post('/api/auth/reset-password', { token: expired, newPassword: password }, undefined, production), production)).status).toBe(400);
    } finally { challenge.mockRestore(); }
  });

  it('returns identical reset receipts during provider failure and identical failures when mail is unavailable', async () => {
    const created = await account();
    for (const email of [created.email, `${name()}@example.test`]) await expect(authHandler(post('/api/auth/request-password-reset', { email }), env)).rejects.toMatchObject({ code: 'MAIL_UNAVAILABLE', status: 503 });
    const production: AuthEnv = { ...env, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: undefined, TURNSTILE_SECRET_KEY: 'synthetic-challenge-secret', EMAIL_FROM: 'chess@ejmlabs.com', EMAIL: { send: async () => { throw new Error('Synthetic provider failure.'); } } };
    const challenge = productionChallenges();
    try {
      const known = await authHandler(post('/api/auth/request-password-reset', { email: created.email }, undefined, production), production);
      const unknown = await authHandler(post('/api/auth/request-password-reset', { email: `${name()}@example.test` }, undefined, production), production);
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(known.status);
      expect(await known.json()).toEqual(await unknown.json());
    } finally { challenge.mockRestore(); }
  });

  it('atomically bounds retained admissions while allowing retry and join at capacity', async () => {
    expect(casualGameLimit({})).toBe(Number.MAX_SAFE_INTEGER);
    const baseline = (await env.DB.prepare('SELECT COUNT(*) AS count FROM casual_game_admissions').first<{ count: number }>())!.count;
    const limited = { ...env, CASUAL_GAME_LIMIT: String(baseline + 2) };
    const players = await Promise.all(Array.from({ length: 6 }, () => account()));
    const ids = players.map(() => crypto.randomUUID());
    const accepted = await Promise.all(players.map((player, index) => acquireSeatGuard(limited, player.actor, ids[index])));
    expect(accepted.filter(Boolean)).toHaveLength(2);
    const creatorIndex = accepted.indexOf(true);
    const deniedIndex = accepted.indexOf(false);
    expect(await acquireSeatGuard(limited, players[creatorIndex].actor, ids[creatorIndex], false, true)).toBe(true);
    expect(await acquireSeatGuard(limited, players[deniedIndex].actor, ids[creatorIndex], false, true)).toBe(false);
    expect(await acquireSeatGuard(limited, players[deniedIndex].actor, ids[creatorIndex])).toBe(true);
    expect(await knownGame(env, ids[creatorIndex])).toBe(true);
    expect(await knownGame(env, ids[deniedIndex])).toBe(false);
    expect(await acquireSeatGuard({ ...env, CASUAL_GAME_LIMIT: '-1' }, players[deniedIndex].actor, crypto.randomUUID())).toBe(false);
    const rankedId = crypto.randomUUID();
    expect(await acquireSeatGuard({ ...env, CASUAL_GAME_LIMIT: '0', RANKED_ENABLED: 'true' }, players[deniedIndex].actor, rankedId, true)).toBe(true);
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(rankedId).first()).toBeNull();
  });
});
