import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { getCookies } from 'better-auth/cookies';
import { generateRandomString, makeSignature } from 'better-auth/crypto';
import { capacityAccountId, capacityPreparationAccounts } from '../shared/capacity-corpus';
import { authOptions, createAuth, currentActor, type Actor, type AuthEnv } from './auth';
import { CAPACITY_FIXTURE_PASSWORD_HASH } from './capacity-fixture-credential';
import type { CapacityManifest } from './capacity-run';

/** Private response. Store the cookie only in the driver's protected input. */
export interface CapacityAccountCredential { accountIndex: number; cookie: string; expiresAt: number }

interface PrimaryFixture extends Record<string, SqlStorageValue> {
  account_index: number; ready: number;
}
interface SessionRecord { token: string; expiresAt: string; userId: string }

interface PrimaryBatchRecord extends SessionRecord {
  id: string; username: string; isAnonymous: number; credentialId: string;
  accountId: string; providerId: string; credentialUserId: string; password: string;
  sessionId: string;
}

const authEnvironments = new WeakMap<object, AuthEnv>();
function capacityAuth(db: D1Database, env: Pick<AuthEnv, 'AUTH_SECRET'>): AuthEnv {
  // Keep the production cookie policy. Only headers enter getSession.
  // The native product and fixtures share their one package context and DB
  // proxy, whose current event supplies the meter for every primary query.
  if ('DB' in env && env.DB === db && 'AUTH_BASE_URL' in env && env.AUTH_BASE_URL === 'https://chess.ejmlabs.com') return env as AuthEnv;
  const existing = authEnvironments.get(env);
  if (existing?.DB === db && existing.AUTH_SECRET === env.AUTH_SECRET) return existing;
  const auth: AuthEnv = { DB: db, AUTH_SECRET: env.AUTH_SECRET, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: 'false' };
  authEnvironments.set(env, auth);
  authEnvironments.set(auth, auth);
  return auth;
}

function sessionWindow(manifest: CapacityManifest): void {
  const now = Date.now();
  if (now < manifest.earliestArmAt || now >= manifest.issueCloseAt) throw new Error('capacity_fixture_expired');
}

/** For an admitted native meter after its immutable binding has been verified. */
export async function authenticateCapacitySession(db: D1Database, env: Pick<AuthEnv, 'AUTH_SECRET'>,
  manifest: CapacityManifest, request: Request, index: number): Promise<Actor> {
  sessionWindow(manifest);
  const id = capacityAccountId(index);
  if ((request.headers.get('Cookie')?.length ?? 0) > 2_048) throw new Error('capacity_session_invalid');
  const auth = capacityAuth(db, env);
  // The package starts its one cached schema check in the background. Await
  // that public context promise so startup SQL cannot outlive its native meter.
  await (await createAuth(auth).$context).checkSchema?.();
  const actor = await currentActor(request, auth);
  if (!actor || actor.id !== id || actor.sessionId !== `${id}:session`
    || actor.sessionExpiresAt !== manifest.hardCloseAt || actor.isAnonymous || !actor.accountReady) {
    throw new Error('capacity_session_invalid');
  }
  sessionWindow(manifest);
  return actor;
}

/**
 * Fixed synthetic rows in the primary auth tables, using package-generated
 * credentials and cookie signatures. This is not a signup or password test.
 * All handles must come from the admitted native event's meter.
 */
export class CapacityAccountFixtures {
  #auth: AuthEnv;

  constructor(private db: D1Database, private sql: SqlStorage, env: Pick<AuthEnv, 'AUTH_SECRET'>,
    private manifest: CapacityManifest) {
    // Retain the product cookie policy without widening canonicalOrigin's
    // production host allowlist. Only headers reach Better Auth's getSession.
    this.#auth = capacityAuth(db, env);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_fixture_accounts (
      account_index INTEGER PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0)`);
  }

  #window(setup: boolean): void {
    const now = Date.now();
    if (now < this.manifest.earliestArmAt
      || now >= (setup ? this.manifest.setupEndsAt : this.manifest.issueCloseAt)) throw new Error('capacity_fixture_expired');
  }

  async #session(index: number): Promise<SessionRecord | null> {
    const id = capacityAccountId(index);
    return this.db.prepare('SELECT token,expiresAt,userId FROM session WHERE id=? AND userId=? LIMIT 1')
      .bind(`${id}:session`, id).first<SessionRecord>();
  }

  async prepare(index: number): Promise<CapacityAccountCredential> {
    this.#window(true);
    const id = capacityAccountId(index);
    const row = this.sql.exec<PrimaryFixture>('SELECT account_index,ready FROM capacity_fixture_accounts WHERE account_index=?', index).toArray()[0];
    if (!row) {
      // A committed intent precedes D1. A lost/failed batch cannot authorize a
      // replacement identity or credential on a later call.
      this.sql.exec('INSERT INTO capacity_fixture_accounts(account_index,ready) VALUES(?,0)', index);
      const now = new Date().toISOString();
      await this.db.batch([
        this.db.prepare(`INSERT INTO user(id,name,email,emailVerified,isAnonymous,username,createdAt,updatedAt)
          VALUES(?,?,?,0,0,?,?,?)`).bind(id, `Capacity ${index}`,
          createPlaceholderEmail({ identifier: crypto.randomUUID(), namespace: 'chess' }),
          `capacity_${index.toString(36).padStart(4, '0')}`, now, now),
        this.db.prepare(`INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt)
          VALUES(?,?,'credential',?,?,?,?)`).bind(`${id}:credential`, id, id, CAPACITY_FIXTURE_PASSWORD_HASH, now, now),
        this.db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
          .bind(`${id}:session`, id, generateRandomString(32), new Date(this.manifest.hardCloseAt).toISOString(), now, now),
      ]);
    }
    const session = await this.#session(index);
    if (!session || session.userId !== id || Date.parse(session.expiresAt) !== this.manifest.hardCloseAt) {
      throw new Error('capacity_fixture_primary_state_unresolved');
    }
    this.#window(true);
    const cookieName = getCookies(authOptions(this.#auth)).sessionToken.name;
    const cookie = `${cookieName}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, this.#auth.AUTH_SECRET)}`)}`;
    const actor = await this.#actor(new Request(`https://${this.manifest.host}/capacity/account/${index}`, { headers: { Cookie: cookie } }), index, false);
    if (actor.id !== id || !actor.accountReady) throw new Error('capacity_fixture_primary_state_unresolved');
    if (!row?.ready) this.sql.exec('UPDATE capacity_fixture_accounts SET ready=1 WHERE account_index=?', index);
    return { accountIndex: index, cookie, expiresAt: this.manifest.hardCloseAt };
  }

  async prepareBatch(first: number): Promise<CapacityAccountCredential[]> {
    this.#window(true);
    const indexes = capacityPreparationAccounts(first);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const index of indexes) {
      const row = this.sql.exec<PrimaryFixture>('SELECT account_index,ready FROM capacity_fixture_accounts WHERE account_index=?', index).toArray()[0];
      if (row) continue;
      // Preserve the intent before D1. An uncertain batch never authorizes
      // fresh credentials for an existing fixture identity.
      this.sql.exec('INSERT INTO capacity_fixture_accounts(account_index,ready) VALUES(?,0)', index);
      const id = capacityAccountId(index);
      statements.push(
        this.db.prepare(`INSERT INTO user(id,name,email,emailVerified,isAnonymous,username,createdAt,updatedAt)
          VALUES(?,?,?,0,0,?,?,?)`).bind(id, `Capacity ${index}`,
          createPlaceholderEmail({ identifier: crypto.randomUUID(), namespace: 'chess' }),
          `capacity_${index.toString(36).padStart(4, '0')}`, now, now),
        this.db.prepare(`INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt)
          VALUES(?,?,'credential',?,?,?,?)`).bind(`${id}:credential`, id, id, CAPACITY_FIXTURE_PASSWORD_HASH, now, now),
        this.db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
          .bind(`${id}:session`, id, generateRandomString(32), new Date(this.manifest.hardCloseAt).toISOString(), now, now),
      );
    }
    if (statements.length) await this.db.batch(statements);
    const ids = indexes.map(capacityAccountId);
    const primary = await this.db.prepare(`SELECT u.id,u.username,u.isAnonymous,
      a.id AS credentialId,a.accountId,a.providerId,a.userId AS credentialUserId,a.password,
      s.id AS sessionId,s.token,s.expiresAt,s.userId FROM user u
      JOIN account a ON a.id=u.id||':credential' AND a.userId=u.id
      JOIN session s ON s.id=u.id||':session' AND s.userId=u.id
      WHERE u.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<PrimaryBatchRecord>();
    const records = new Map(primary.results.map(row => [row.id, row]));
    if (records.size !== indexes.length || primary.results.length !== indexes.length) {
      throw new Error('capacity_fixture_primary_state_unresolved');
    }
    const cookieName = getCookies(authOptions(this.#auth)).sessionToken.name;
    const credentials: CapacityAccountCredential[] = [];
    for (const index of indexes) {
      const id = capacityAccountId(index), row = records.get(id);
      if (!row || row.username !== `capacity_${index.toString(36).padStart(4, '0')}` || row.isAnonymous !== 0
        || row.credentialId !== `${id}:credential` || row.accountId !== id || row.providerId !== 'credential'
        || row.credentialUserId !== id || row.password !== CAPACITY_FIXTURE_PASSWORD_HASH
        || row.sessionId !== `${id}:session` || row.userId !== id || typeof row.token !== 'string' || row.token.length !== 32
        || Date.parse(row.expiresAt) !== this.manifest.hardCloseAt) throw new Error('capacity_fixture_primary_state_unresolved');
      const cookie = `${cookieName}=${encodeURIComponent(`${row.token}.${await makeSignature(row.token, this.#auth.AUTH_SECRET)}`)}`;
      credentials.push({ accountIndex: index, cookie, expiresAt: this.manifest.hardCloseAt });
    }
    this.#window(true);
    this.sql.exec(`UPDATE capacity_fixture_accounts SET ready=1 WHERE account_index IN (${indexes.map(() => '?').join(',')})`, ...indexes);
    // Registration still verifies every package-signed cookie through the
    // unchanged Better Auth session path and the primary credential records.
    return credentials;
  }

  async #actor(request: Request, index: number, requireReady: boolean): Promise<Actor> {
    const actor = await authenticateCapacitySession(this.db, this.#auth, this.manifest, request, index);
    const row = this.sql.exec<PrimaryFixture>('SELECT account_index,ready FROM capacity_fixture_accounts WHERE account_index=?', index).toArray()[0];
    if (!row || (requireReady && !row.ready)) {
      throw new Error('capacity_session_invalid');
    }
    this.#window(false);
    return actor;
  }

  async authenticate(request: Request, index: number): Promise<Actor> {
    return this.#actor(request, index, true);
  }

  /** Package auth owns cookies; the authority still fences the fixed fixture. */
  authenticatedActor(actor: Actor, index: number): Actor {
    const id = capacityAccountId(index);
    if (!actor || actor.id !== id || actor.sessionId !== `${id}:session`
      || actor.sessionExpiresAt !== this.manifest.hardCloseAt || actor.isAnonymous || !actor.accountReady) {
      throw new Error('capacity_session_invalid');
    }
    const row = this.sql.exec<PrimaryFixture>('SELECT account_index,ready FROM capacity_fixture_accounts WHERE account_index=?', index).toArray()[0];
    if (!row?.ready) throw new Error('capacity_session_invalid');
    this.#window(false);
    return actor;
  }
}
