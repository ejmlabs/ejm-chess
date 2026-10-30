import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHandler, beginIdentityChange, currentActor, type Actor } from '../src/server/auth';
import { applyAccountClosure } from '../src/server/privacy';
import { ACCOUNT_PRIVACY_POLICY, type AccountClosureReceipt, type AccountExportPage } from '../src/shared/privacy';
import type { Env } from '../src/server/env';
import type { Competition } from '../src/server/competition';
import handler from '../src/server/index';
import { enableRanked, player } from './authority-helpers';

const origin = 'http://localhost:8787';
const password = 'privacy-test-password-12345';
let address = 1;
function request(path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}): Request {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Turnstile-Token': 'local-development',
    'CF-Connecting-IP': `198.51.100.${address++}`, ...extra,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fetchWorker(input: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await handler.fetch(input, env, context);
  await waitOnExecutionContext(context);
  return response;
}
async function account(email = false): Promise<{ actor: Actor; cookie: string; username: string }> {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const created = await authHandler(request('/api/auth/sign-up/email', { username, password, ...(email ? { email: `${username}@example.test` } : {}) }), env);
  expect(created.status).toBe(200);
  const cookie = created.headers.get('Set-Cookie')!.split(';')[0];
  const actor = (await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env))!;
  return { actor, cookie, username };
}
function closure(userId: string): AccountClosureReceipt {
  return { userId, requestId: crypto.randomUUID(), policyVersion: ACCOUNT_PRIVACY_POLICY, completedAt: Date.now() };
}
async function counts(userId: string) {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM account WHERE userId=?) AS credentials,
    (SELECT COUNT(*) FROM session WHERE userId=?) AS sessions,
    (SELECT COUNT(*) FROM verification WHERE value=?) AS resets,
    (SELECT COUNT(*) FROM account_closure_receipts WHERE user_id=?) AS receipts`).bind(userId, userId, userId, userId).first();
}
async function completedGame(white: { id: string; name: string }, black: { id: string; name: string }): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO games(id,pool,rated,white_id,black_id,white_name,black_name,status,reason,winner,score,started_at,ended_at,created_at,pgn,plies,rules_version,result_version,projection_epoch,projection_version,projected_at,settlement)
    VALUES(?,'blitz',1,?,?,?,?,'finished','resignation','w',1,?,?,?,'1. e4 e5 1-0',2,'online-v1',1,0,1,?,'settled')`)
    .bind(id, white.id, black.id, white.name, black.name, now - 60_000, now, now, now).run();
  return id;
}

describe('password-confirmed account data controls', () => {
  it('exports and closes a no-email account while preserving identity, history and one receipt', async () => {
    const { actor, cookie, username } = await account();
    const other = await player();
    const gameId = await completedGame(actor, other);
    const original = await env.DB.prepare('SELECT createdAt FROM user WHERE id=?').bind(actor.id).first();
    await env.DB.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), 'test-only-reset', actor.id, new Date(Date.now() + 900_000).toISOString(), new Date().toISOString(), new Date().toISOString()).run();
    const exported = await fetchWorker(request('/api/account/export', { password, category: 'profile' }, cookie));
    expect(exported.status).toBe(200);
    expect(exported.headers.get('Cache-Control')).toBe('no-store');
    expect(exported.headers.get('Content-Disposition')).toContain('attachment;');
    const page = await exported.json() as AccountExportPage;
    expect(page).toMatchObject({ category: 'profile', atomicSnapshot: false, nextCursor: null });
    expect(page.records).toMatchObject([{ id: actor.id, username, email: null }]);
    expect(JSON.stringify(page)).not.toContain('.invalid');
    const requestId = crypto.randomUUID();
    const closed = await fetchWorker(request('/api/account/close', { password, confirmation: 'CLOSE', requestId }, cookie));
    expect(closed.status).toBe(200);
    expect(closed.headers.get('Set-Cookie')).toContain('Max-Age=0');
    const accepted = await closed.json() as AccountClosureReceipt;
    expect(accepted).toMatchObject({ requestId, userId: actor.id, policyVersion: ACCOUNT_PRIVACY_POLICY });
    expect(await counts(actor.id)).toEqual({ credentials: 0, sessions: 0, resets: 0, receipts: 1 });
    expect(await env.DB.prepare('SELECT id,name,username,emailVerified,image,isAnonymous,createdAt FROM user WHERE id=?').bind(actor.id).first())
      .toEqual({ id: actor.id, name: 'Closed account', username: null, emailVerified: 0, image: null, isAnonymous: 0, createdAt: original!.createdAt });
    expect(await env.DB.prepare('SELECT white_id,white_name,pgn FROM games WHERE id=?').bind(gameId).first())
      .toEqual({ white_id: actor.id, white_name: actor.name, pgn: '1. e4 e5 1-0' });
    expect(await applyAccountClosure(env.DB, accepted)).toEqual(accepted);
    expect(await counts(actor.id)).toEqual({ credentials: 0, sessions: 0, resets: 0, receipts: 1 });
    expect(await (await fetchWorker(request('/api/me', undefined, cookie))).json()).toBeNull();
    expect((await authHandler(request('/api/auth/sign-in/username', { username, password }), env)).status).toBe(401);
    expect((await fetchWorker(request('/api/account/close', { password, confirmation: 'CLOSE', requestId }, cookie))).status).toBe(401);
    expect((await counts(other.id))!.credentials).toBe(1);
  });

  it('denies wrong passwords, forged account fields, cross-origin actions and credential floods', async () => {
    const { actor, cookie } = await account();
    const other = await player();
    const forged = await fetchWorker(request('/api/account/export', { password, category: 'profile', userId: other.id }, cookie));
    expect(forged.status).toBe(400);
    expect((await fetchWorker(request('/api/account/export', { password, category: 'profile' }, cookie, { Origin: 'https://unrelated.example' }))).status).toBe(403);
    for (let i = 0; i < 3; i++) {
      const denied = await fetchWorker(request('/api/account/export', { password: 'incorrect', category: 'profile' }, cookie));
      expect(denied.status).toBe(400);
      expect(await denied.text()).not.toContain(actor.email);
    }
    expect((await fetchWorker(request('/api/account/export', { password, category: 'profile' }, cookie))).status).toBe(429);
    expect((await counts(actor.id))!.receipts).toBe(0);
  });

  it('paginates large private text within both bounds and excludes reviewer and reporter secrets', async () => {
    const { actor, cookie } = await account(true);
    const reviewer = await player();
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 51; i++) {
      const id = `${actor.id}-${String(i).padStart(3, '0')}`;
      statements.push(
        env.DB.prepare("INSERT INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at) VALUES(?,?,?,'decided',?,?)").bind(id, actor.id, id, Date.now(), Date.now()),
        env.DB.prepare("INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until) VALUES(?,?,?,?,'restrict','Player notice','secret reviewer note','secret corroboration','[]','secret request hash',?,?)").bind(id, id, actor.id, reviewer.id, Date.now(), Date.now() + 86_400_000),
        env.DB.prepare("INSERT INTO fairplay_appeals(id,decision_id,case_id,user_id,reason,status,created_at) VALUES(?,?,?,?,?,'pending',?)").bind(id, id, id, actor.id, '棋'.repeat(2000), Date.now()),
      );
    }
    await env.DB.batch(statements);
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 2; i++) {
      const response = await fetchWorker(request('/api/account/export', { password, category: 'appeals', ...(cursor ? { cursor } : {}) }, cookie));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(256 * 1024);
      const page = JSON.parse(text) as AccountExportPage;
      expect(page.records.length).toBeLessThanOrEqual(50);
      for (const row of page.records) { expect(ids.has(String(row.id))).toBe(false); ids.add(String(row.id)); }
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids.size).toBe(51);
    expect(cursor).toBeUndefined();
    const notices = await fetchWorker(request('/api/account/export', { password, category: 'notices' }, cookie));
    const text = await notices.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain(reviewer.id);
    expect((JSON.parse(text) as AccountExportPage).records).toHaveLength(50);
  });

  it('returns only the owner reports and participant game metadata with guarded PGN links', async () => {
    const { actor, cookie } = await account(true);
    const other = await player();
    const gameId = await completedGame(actor, other);
    const foreignGame = await completedGame(other, other);
    const caseId = crypto.randomUUID();
    const ownReport = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)").bind(caseId, other.id, gameId, Date.now(), Date.now()),
      env.DB.prepare("INSERT INTO fairplay_reports(id,case_id,game_id,reporter_id,reason,details,created_at) VALUES(?,?,?,?,'other','own submission',?)").bind(ownReport, caseId, gameId, actor.id, Date.now()),
      env.DB.prepare("INSERT INTO fairplay_reports(id,case_id,game_id,reporter_id,reason,details,created_at) VALUES(?,?,?,?,'other','other reporter secret',?)").bind(crypto.randomUUID(), caseId, gameId, other.id, Date.now()),
    ]);
    const profile = await (await fetchWorker(request('/api/account/export', { password, category: 'profile' }, cookie))).json() as AccountExportPage;
    expect(profile.records[0].email).toBe(actor.email);
    const reports = await fetchWorker(request('/api/account/export', { password, category: 'reports' }, cookie));
    const reportText = await reports.text();
    expect(reportText).not.toContain('other reporter secret');
    expect((JSON.parse(reportText) as AccountExportPage).records).toMatchObject([{ id: ownReport, details: 'own submission' }]);
    const games = await (await fetchWorker(request('/api/account/export', { password, category: 'games' }, cookie))).json() as AccountExportPage;
    expect(games.records).toMatchObject([{ id: gameId, pgnUrl: `/api/games/${gameId}/pgn` }]);
    expect(JSON.stringify(games)).not.toContain(foreignGame);
    expect((await fetchWorker(request(`/api/games/${foreignGame}/pgn`, undefined, cookie))).status).toBe(404);
  });

  it('rolls back the whole closure on native failure and can retry the same request', async () => {
    const { actor, cookie } = await account();
    await env.DB.exec(`CREATE TRIGGER test_closure_failure BEFORE UPDATE ON user WHEN NEW.id='${actor.id}' BEGIN SELECT RAISE(ABORT,'simulated_failure'); END;`);
    const body = { password, confirmation: 'CLOSE', requestId: crypto.randomUUID() };
    expect((await fetchWorker(request('/api/account/close', body, cookie))).status).toBe(503);
    expect(await counts(actor.id)).toEqual({ credentials: 1, sessions: 1, resets: 0, receipts: 0 });
    expect(await currentActor(request('/api/me', undefined, cookie), env)).toMatchObject({ id: actor.id, accountReady: true });
    await env.DB.exec('DROP TRIGGER test_closure_failure;');
    expect((await fetchWorker(request('/api/account/close', body, cookie))).status).toBe(200);
    expect(await counts(actor.id)).toEqual({ credentials: 0, sessions: 0, resets: 0, receipts: 1 });
  });

  it('keeps a committed closure after a lost batch reply and blocks native auth reactivation', async () => {
    const actor = await player();
    const accepted = closure(actor.id);
    const lostReply = new Proxy(env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => { await target.batch(statements); throw new Error('lost_batch_reply'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(applyAccountClosure(lostReply, accepted)).rejects.toThrow('lost_batch_reply');
    expect(await applyAccountClosure(env.DB, accepted)).toEqual(accepted);
    const now = new Date().toISOString();
    await expect(env.DB.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,'test-only-hash',?,?)")
      .bind(crypto.randomUUID(), actor.id, actor.id, now, now).run()).rejects.toThrow('account_closed');
    await expect(env.DB.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), actor.id, crypto.randomUUID(), new Date(Date.now() + 60_000).toISOString(), now, now).run()).rejects.toThrow('account_closed');
    await expect(env.DB.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), crypto.randomUUID(), actor.id, new Date(Date.now() + 60_000).toISOString(), now, now).run()).rejects.toThrow('account_closed');
    await expect(env.DB.prepare('UPDATE user SET email=?,username=? WHERE id=?').bind('revived@example.test', 'revived', actor.id).run()).rejects.toThrow('account_closed');
    expect(await counts(actor.id)).toEqual({ credentials: 0, sessions: 0, resets: 0, receipts: 1 });
  });

  it('rejects a maintained auth signin whose session write was already in flight', async () => {
    const { actor, cookie, username } = await account();
    let release!: () => void;
    let observed!: () => void;
    const paused = new Promise<void>(resolve => { observed = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    let once = true;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(value, method) {
          if (method === 'bind') return (...args: unknown[]) => wrap(value.bind(...args));
          const original = Reflect.get(value, method);
          if (typeof original !== 'function') return original;
          return async (...args: unknown[]) => {
            if (once && /insert\s+into\s+["`]?session["`]?/i.test(sql)) { once = false; observed(); await proceed; }
            return original.apply(value, args);
          };
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const signingIn = authHandler(request('/api/auth/sign-in/username', { username, password }), { ...env, DB: db });
    try {
      await Promise.race([paused, signingIn.then(() => { throw new Error('signin_completed_before_session_gate'); })]);
      expect((await fetchWorker(request('/api/account/close', { password, confirmation: 'CLOSE', requestId: crypto.randomUUID() }, cookie))).status).toBe(200);
      release();
      expect((await signingIn).status).not.toBe(200);
      expect(await counts(actor.id)).toEqual({ credentials: 0, sessions: 0, resets: 0, receipts: 1 });
    } finally { release(); }
  });
});

describe('closure and admission authority', () => {
  it.each(['ranked', 'casual'] as const)('fences %s admission that passed a primary session check before closure', async mode => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await enableRanked(competition);
    const actor = await player();
    await runInDurableObject(competition, async (instance, state) => {
      const local = instance as Competition;
      const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
      const original = internal.env;
      const schedule = internal.schedule;
      internal.schedule = async () => {};
      await state.storage.deleteAlarm();
      let release!: () => void;
      let observed!: () => void;
      const paused = new Promise<void>(resolve => { observed = resolve; });
      const reply = new Promise<void>(resolve => { release = resolve; });
      let once = true;
      const db = new Proxy(original.DB, { get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(value, method) {
            if (method === 'bind') return (...args: unknown[]) => wrap(value.bind(...args));
            if (method === 'first') return async (...args: unknown[]) => {
              const result = await value.first(...args as []);
              if (once && sql.includes(mode === 'ranked' ? 'AS restricted' : 'FROM session s JOIN user u')) { once = false; observed(); await reply; }
              return result;
            };
            const result = Reflect.get(value, method); return typeof result === 'function' ? result.bind(value) : result;
          } });
          return wrap(target.prepare(sql));
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      internal.env = { ...original, DB: db };
      try {
        const gameId = crypto.randomUUID();
        const pending = mode === 'ranked' ? local.joinQueue(actor, 'blitz') : local.createCasualGame(actor, { id: gameId, format: 'blitz' });
        await paused;
        const leaseId = await beginIdentityChange(original.DB, actor.id);
        const accepted = closure(actor.id);
        expect(await local.reserveAccountClosure(actor.id, accepted.requestId, leaseId)).toBe(true);
        await applyAccountClosure(original.DB, accepted, { leaseId, sessionId: actor.sessionId });
        await original.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=? AND lease_id=?').bind(actor.id, leaseId).run();
        await local.settleAccountClosure(actor.id, leaseId);
        release();
        const result = await pending;
        if (mode === 'ranked') expect(result).toMatchObject({ status: 'closed' });
        else expect(result).toMatchObject({ ok: false, error: { code: 'ACCOUNT_CLOSING' } });
        expect(state.storage.sql.exec('SELECT * FROM slots WHERE user_id=?', actor.id).toArray()).toEqual([]);
        expect(state.storage.sql.exec('SELECT * FROM casual_intents WHERE creator_id=?', actor.id).toArray()).toEqual([]);
      } finally { release(); internal.env = original; internal.schedule = schedule; }
    });
  });

  it('cancels only unpaired ranked queue entries and refuses unsettled or event reservations', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await enableRanked(competition);
    const queued = await player();
    expect((await competition.joinQueue(queued, 'blitz')).status).toBe('queued');
    const leaseId = await beginIdentityChange(env.DB, queued.id);
    expect(await competition.reserveAccountClosure(queued.id, crypto.randomUUID(), leaseId)).toBe(true);
    expect(await competition.queueStatus(queued)).toEqual({ status: 'idle' });
    await env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=?').bind(queued.id).run();
    await competition.settleAccountClosure(queued.id, leaseId);
    const occupied = await player();
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO slots(user_id,state,pool,game_id) VALUES(?,'reserved','blitz',?)", occupied.id, crypto.randomUUID());
    });
    const otherLease = await beginIdentityChange(env.DB, occupied.id);
    expect(await competition.reserveAccountClosure(occupied.id, crypto.randomUUID(), otherLease)).toBe(false);
    await env.DB.prepare('INSERT INTO tournament_account_locks(user_id,tournament_id,acquired_at) VALUES(?,?,?)').bind(queued.id, 'test-event', Date.now()).run();
    await expect(beginIdentityChange(env.DB, queued.id)).rejects.toMatchObject({ code: 'ACTIVE_GAME' });
    const active = await player();
    await env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at,released_at) VALUES(?,?,?,NULL)').bind(active.id, crypto.randomUUID(), Date.now()).run();
    await expect(beginIdentityChange(env.DB, active.id)).rejects.toMatchObject({ code: 'ACTIVE_GAME' });
  });

  it('recovers abandoned closure reservations and completes committed ones through maintenance', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
    await enableRanked(competition);
    const [abandoned, committed] = await Promise.all([player(), player()]);
    for (const actor of [abandoned, committed]) {
      const leaseId = await beginIdentityChange(env.DB, actor.id);
      const accepted = closure(actor.id);
      expect(await competition.reserveAccountClosure(actor.id, accepted.requestId, leaseId)).toBe(true);
      if (actor.id === committed.id) await applyAccountClosure(env.DB, accepted, { leaseId, sessionId: actor.sessionId });
      await env.DB.prepare('UPDATE identity_change_leases SET expires_at=? WHERE user_id=?').bind(Date.now() - 1, actor.id).run();
    }
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec("UPDATE account_closure_fences SET expires_at=? WHERE state='pending'", Date.now() - 1);
    });
    expect((await competition.maintenance()).errors).toEqual([]);
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT user_id,state FROM account_closure_fences ORDER BY user_id').toArray()))
      .toEqual([{ user_id: committed.id, state: 'closed' }]);
    expect((await competition.joinQueue(abandoned, 'blitz')).status).toBe('queued');
  });
});
