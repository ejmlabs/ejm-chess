import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthEndpoint, getSession } from 'better-auth/api';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { anonymous } from 'better-auth/plugins/anonymous';
import { username } from 'better-auth/plugins/username';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password-policy';
import { consumeAccountRequest } from './abuse';
import { newWorkAllowed, reserveMonthlyWork, reserveSignupAttempt, type BudgetEnv } from './budget';
import { ApiError, canonicalOrigin, isLocalRequest, jsonResponse, readJson, requireSameOrigin, verifyTurnstile, type SecurityEnv } from './security';

export interface AuthEnv extends SecurityEnv, BudgetEnv {
  DB: D1Database;
  AUTH_SECRET: string;
  RANKED_ENABLED?: string;
  OPERATION_MODE?: string;
  CASUAL_GAME_LIMIT?: string;
  CASUAL_GAME_ID_LIMIT?: string;
  EMAIL?: { send(message: { from: string; to: string[]; subject: string; text: string }): Promise<unknown> };
  EMAIL_FROM?: string;
}

export interface Actor {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  sessionId: string;
  sessionExpiresAt: number;
  username: string | null;
  accountReady: boolean;
}

/** Use the primary credential records at every admission and public identity boundary. */
export const PASSWORD_ACCOUNT_SQL = `COALESCE(u.isAnonymous,0)=0 AND u.username IS NOT NULL
  AND length(u.username) BETWEEN 3 AND 24 AND u.username NOT GLOB '*[^a-z0-9_]*'
  AND EXISTS(SELECT 1 FROM account c WHERE c.userId=u.id AND c.providerId='credential'
    AND c.accountId=u.id AND c.password IS NOT NULL AND length(c.password)>0)`;

export async function passwordAccountReady(env: Pick<AuthEnv, 'DB'>, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT (${PASSWORD_ACCOUNT_SQL}) AS ready FROM user u WHERE u.id=?`)
    .bind(userId).first<{ ready: number }>();
  return row?.ready === 1;
}

/** The reserved .invalid namespace never represents a recovery mailbox. */
export function hasRecoveryEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return domain.length > 0 && domain !== 'invalid' && !domain.endsWith('.invalid');
}

async function sendSecurityEmail(env: AuthEnv, email: string, subject: string, text: string): Promise<void> {
  if (!hasRecoveryEmail(email)) return;
  if (!env.EMAIL || !env.EMAIL_FROM || env.LOCAL_DEV === 'true') throw new ApiError(503, 'MAIL_UNAVAILABLE', 'Account email is unavailable. Try again later.');
  try {
    if (!await reserveMonthlyWork(env, 'email', crypto.randomUUID())) throw new Error('mail_budget_closed');
    await env.EMAIL.send({ from: env.EMAIL_FROM, to: [email], subject, text });
  } catch { throw new ApiError(503, 'MAIL_UNAVAILABLE', 'Account email is unavailable. Try again later.'); }
}

/** Native D1 is detected by Better Auth. No ORM, replica session, or secondary auth store is used. */
export function authOptions(env: AuthEnv): BetterAuthOptions {
  const origin = canonicalOrigin(env);
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Sign-in is unavailable. Try again later.');
  const local = env.LOCAL_DEV === 'true' && new URL(origin).hostname !== 'chess.ejmlabs.com';
  return {
    appName: 'ejm chess',
    baseURL: origin,
    basePath: '/api/auth',
    secret: env.AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 900,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        if ((user as typeof user & { isAnonymous?: boolean }).isAnonymous || !hasRecoveryEmail(user.email)) return;
        const url = new URL('/account/', origin);
        url.searchParams.set('reset', token);
        await sendSecurityEmail(env, user.email, 'Reset your chess password', `Reset your ejm chess password: ${url.href}\n\nThis link expires in 15 minutes and works once. If you did not request it, ignore this email.`);
      },
    },
    emailVerification: {
      expiresIn: 900,
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      beforeEmailVerification: async user => {
        if (!hasRecoveryEmail(user.email)) throw new ApiError(400, 'INVALID_VERIFICATION', 'This verification link is invalid or expired.');
      },
      sendVerificationEmail: async ({ user, url }) => {
        await sendSecurityEmail(env, user.email, 'Verify your chess account', `Verify your ejm chess account: ${url}\n\nThis link expires in 15 minutes. If you did not request it, ignore this email.`);
      },
    },
    account: { accountLinking: { enabled: false } },
    databaseHooks: { user: { create: { before: async user => ({ data: { ...user, name: user.name.trim().slice(0, 40) || 'Player' } }) } } },
    session: { expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true, cookieCache: { enabled: false } },
    verification: { storeInDatabase: true, storeIdentifier: 'hashed' },
    advanced: {
      database: { joins: true },
      useSecureCookies: !local,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { httpOnly: true, secure: !local, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-up/email': { window: 60, max: 5 },
        '/sign-in/username': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
      },
    },
    logger: { disabled: true },
    plugins: [
      // Keep the guest account and its completed records. Identity ownership never transfers between active seats.
      anonymous({ disableDeleteAnonymousUser: true, generateName: () => 'Guest' }),
      username({ minUsernameLength: 3, maxUsernameLength: 24, usernameValidator: value => /^[a-zA-Z0-9_]+$/.test(value), displayUsername: false, immutableUsername: true }),
    ],
  };
}

/** Keep primary session and credential reads in one remote wait, using package authentication. */
function currentPlayerPlugin(env: AuthEnv) {
  return {
    id: 'chess-current-player',
    endpoints: {
      currentPlayer: createAuthEndpoint.serverOnly({ method: 'GET', requireHeaders: true, metadata: { noStore: true } }, async ctx => {
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        if (!token) return null;
        // Drain both reads even if one fails. A native meter must not finish
        // while its companion query is still using the database binding.
        const [session, credential] = await Promise.allSettled([
          getSession()({ ...ctx, method: 'GET', asResponse: false, returnHeaders: false, returnStatus: false,
            query: { disableCookieCache: true, disableRefresh: true } }),
          Promise.resolve().then(() => env.DB.prepare(`SELECT u.id AS userId,s.id AS sessionId,s.expiresAt,u.username,(${PASSWORD_ACCOUNT_SQL}) AS accountReady
            FROM session s JOIN user u ON u.id=s.userId WHERE s.token=? LIMIT 1`)
            .bind(token).first<{ userId: string; sessionId: string; expiresAt: string; username: string | null; accountReady: number }>()),
        ]);
        if (session.status === 'rejected') throw session.reason;
        const found = session.value;
        if (!found || found.session.expiresAt.getTime() <= Date.now()) return null;
        if (credential.status === 'rejected') throw credential.reason;
        const stored = credential.value;
        if (!stored || stored.userId !== found.user.id || stored.userId !== found.session.userId
          || stored.sessionId !== found.session.id || Date.parse(stored.expiresAt) !== found.session.expiresAt.getTime()) return null;
        return {
          id: found.user.id, name: found.user.name, email: found.user.email,
          emailVerified: found.user.emailVerified,
          isAnonymous: (found.user as typeof found.user & { isAnonymous?: boolean }).isAnonymous === true,
          sessionId: found.session.id, sessionExpiresAt: found.session.expiresAt.getTime(),
          username: stored.username, accountReady: stored.accountReady === 1,
        } satisfies Actor;
      }),
    },
  };
}

function buildAuth(env: AuthEnv) {
  const options = authOptions(env);
  return betterAuth({ ...options, plugins: [currentPlayerPlugin(env), ...(options.plugins ?? [])] });
}
const instances = new WeakMap<object, ReturnType<typeof buildAuth>>();

export function createAuth(env: AuthEnv): ReturnType<typeof buildAuth> {
  let auth = instances.get(env);
  if (!auth) { auth = buildAuth(env); instances.set(env, auth); }
  return auth;
}

export async function currentActor(request: Request, env: AuthEnv): Promise<Actor | null> {
  return createAuth(env).api.currentPlayer({ headers: request.headers });
}

/** Revalidate an internal session ID against Better Auth's primary D1 records, without exposing its token. */
export async function getActorBySessionId(env: AuthEnv, sessionId: string): Promise<Actor | null> {
  const row = await env.DB.prepare(`SELECT u.id, u.name, u.email, u.emailVerified, u.isAnonymous, u.username, (${PASSWORD_ACCOUNT_SQL}) AS accountReady, s.id AS sessionId, s.expiresAt
    FROM session s JOIN user u ON u.id=s.userId WHERE s.id=? LIMIT 1`).bind(sessionId).first<{
      id: string; name: string; email: string; emailVerified: number; isAnonymous: number | null; username: string | null; accountReady: number; sessionId: string; expiresAt: string;
    }>();
  if (!row) return null;
  const expires = Date.parse(row.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email, emailVerified: Boolean(row.emailVerified), isAnonymous: Boolean(row.isAnonymous), username: row.username, accountReady: Boolean(row.accountReady), sessionId: row.sessionId, sessionExpiresAt: expires };
}

export async function expireRestrictions(db: D1Database, now = Date.now(), userId?: string): Promise<void> {
  const filter = userId ? ' AND user_id=?' : '';
  const args = userId ? [now, userId] : [now];
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO fairplay_events(id,case_id,actor_id,kind,reference_id,created_at)
      SELECT id || ':expired',case_id,NULL,'restriction_expired',id,? FROM restrictions
      WHERE revoked_at IS NULL AND expires_at<=?${filter} ORDER BY expires_at,id LIMIT 500`).bind(now, ...args),
    db.prepare(`UPDATE restrictions SET revoked_at=expires_at, revoke_reason='expired' WHERE id IN
      (SELECT id FROM restrictions WHERE revoked_at IS NULL AND expires_at<=?${filter} ORDER BY expires_at,id LIMIT 500)`).bind(...args),
  ]);
}

export async function competitiveAccountEligibility(env: AuthEnv, userId: string): Promise<{ eligible: boolean; reason?: string }> {
  const row = await env.DB.prepare(`SELECT (${PASSWORD_ACCOUNT_SQL}) AS accountReady,
    EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=u.id AND r.revoked_at IS NULL AND r.expires_at>?) AS restricted
    FROM user u WHERE u.id=?`).bind(Date.now(), userId).first<{ accountReady: number; restricted: number }>();
  if (!row?.accountReady) return { eligible: false, reason: 'ACCOUNT_REQUIRED' };
  if (row.restricted) return { eligible: false, reason: 'RANKED_RESTRICTED' };
  return { eligible: true };
}

/** Check session ownership, credentials and restrictions in one primary read. */
export async function competitiveSessionEligible(actor: Pick<Actor, 'id' | 'sessionId'>, env: AuthEnv): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT s.expiresAt,(${PASSWORD_ACCOUNT_SQL}) AS accountReady,
    EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=u.id AND r.revoked_at IS NULL AND r.expires_at>?) AS restricted
    FROM session s JOIN user u ON u.id=s.userId WHERE s.id=? AND u.id=? LIMIT 1`)
    .bind(Date.now(), actor.sessionId, actor.id).first<{ expiresAt: string; accountReady: number; restricted: number }>();
  return Boolean(row?.accountReady && !row.restricted && Date.parse(row.expiresAt) > Date.now());
}

export async function rankedEligibility(env: AuthEnv, userId: string): Promise<{ eligible: boolean; reason?: string }> {
  if (env.RANKED_ENABLED !== 'true') return { eligible: false, reason: 'RANKED_CLOSED' };
  return competitiveAccountEligibility(env, userId);
}

/** Claim an opted-in account atomically against casual seats and identity changes. */
export async function acquireTournamentAccount(env: AuthEnv, actor: Pick<Actor, 'id' | 'sessionId'>, tournamentId: string): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO tournament_account_locks(user_id,tournament_id,acquired_at)
    SELECT u.id,?,? FROM user u JOIN session s ON s.userId=u.id
    WHERE u.id=? AND s.id=? AND s.expiresAt>? AND ${PASSWORD_ACCOUNT_SQL}
      AND NOT EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=u.id AND r.revoked_at IS NULL AND r.expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM identity_change_leases i WHERE i.user_id=u.id AND i.expires_at>?)
      AND (NOT EXISTS(SELECT 1 FROM active_game_seats a WHERE a.user_id=u.id AND a.released_at IS NULL)
        OR EXISTS(SELECT 1 FROM tournament_account_locks t WHERE t.user_id=u.id AND t.tournament_id=?))
    ON CONFLICT(user_id) DO UPDATE SET tournament_id=excluded.tournament_id
      WHERE tournament_account_locks.tournament_id=excluded.tournament_id RETURNING user_id`)
    .bind(tournamentId, now, actor.id, actor.sessionId, new Date(now).toISOString(), now, now, tournamentId).first();
  return Boolean(row);
}

/** Internal game allocation consumes an existing account and game reservation, never browser identity. */
export async function acquireTournamentSeat(env: AuthEnv, userId: string, gameId: string, tournamentId: string): Promise<boolean> {
  const row = await env.DB.prepare(`INSERT INTO active_game_seats(user_id,game_id,acquired_at,released_at)
    SELECT user_id,?,?,NULL FROM tournament_account_locks t WHERE t.user_id=? AND t.tournament_id=?
      AND EXISTS(SELECT 1 FROM user u WHERE u.id=t.user_id AND ${PASSWORD_ACCOUNT_SQL})
      AND NOT EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=t.user_id AND r.revoked_at IS NULL AND r.expires_at>?)
      AND EXISTS(SELECT 1 FROM tournament_game_admissions g WHERE g.game_id=? AND g.tournament_id=? AND g.storage_state='retained')
      AND NOT EXISTS(SELECT 1 FROM active_game_seats a WHERE a.user_id=t.user_id AND a.game_id<>? AND a.released_at IS NULL)
    ON CONFLICT(user_id,game_id) DO UPDATE SET
      acquired_at=CASE WHEN active_game_seats.released_at IS NULL THEN active_game_seats.acquired_at ELSE excluded.acquired_at END,
      released_at=NULL RETURNING user_id`)
    .bind(gameId, Date.now(), userId, tournamentId, Date.now(), gameId, tournamentId, gameId).first();
  return Boolean(row);
}

export async function revalidateActor(actor: Pick<Actor, 'id' | 'sessionId' | 'sessionExpiresAt'>, env: AuthEnv, ranked = false): Promise<boolean> {
  const current = await getActorBySessionId(env, actor.sessionId);
  return Boolean(current && current.id === actor.id && (!ranked || (await rankedEligibility(env, current.id)).eligible));
}

export async function requireActor(request: Request, env: AuthEnv): Promise<Actor> {
  const actor = await currentActor(request, env);
  if (!actor) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to your chess account.');
  return actor;
}

export async function requireRankedActor(request: Request, env: AuthEnv): Promise<Actor> {
  const actor = await requireActor(request, env);
  const eligibility = await rankedEligibility(env, actor.id);
  if (!eligibility.eligible) throw new ApiError(403, eligibility.reason ?? 'RANKED_UNAVAILABLE', eligibility.reason === 'RANKED_CLOSED' ? 'Ranked play is closed.' : 'Ranked play requires an eligible account.');
  return actor;
}

export async function hasActiveSeat(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM active_game_seats WHERE user_id=? AND released_at IS NULL)
    OR EXISTS(SELECT 1 FROM tournament_account_locks WHERE user_id=?)`).bind(userId, userId).first());
}

/** Hot payload admission is independent from permanent game identity retention. */
export function casualGameLimit(env: Pick<AuthEnv, 'CASUAL_GAME_LIMIT'>): number {
  const value = Number(env.CASUAL_GAME_LIMIT ?? Number.MAX_SAFE_INTEGER);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Archived tombstones still count. Invalid configuration closes new game admission. */
export function casualGameIdLimit(env: Pick<AuthEnv, 'CASUAL_GAME_ID_LIMIT'>): number {
  const value = Number(env.CASUAL_GAME_ID_LIMIT ?? Number.MAX_SAFE_INTEGER);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Reject unknown IDs before a Game RPC can create an empty Durable Object. */
export async function knownGame(env: Pick<AuthEnv, 'DB'>, gameId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM casual_game_admissions WHERE game_id=?)
    OR EXISTS(SELECT 1 FROM tournament_game_admissions WHERE game_id=?)
    OR EXISTS(SELECT 1 FROM active_game_seats WHERE game_id=?)
    OR EXISTS(SELECT 1 FROM games WHERE id=?) AS known`).bind(gameId, gameId, gameId, gameId).first<{ known: number }>();
  return row?.known === 1;
}

/** This bridge protects the product's seat ownership while Better Auth changes browser identity. */
export async function acquireSeatGuard(env: AuthEnv, actor: Pick<Actor, 'id' | 'sessionId' | 'sessionExpiresAt'>, gameId: string, ranked = false, creatorOnly = false, reservationId?: string): Promise<boolean> {
  if (ranked && env.RANKED_ENABLED !== 'true') return false;
  const now = Date.now();
  if (!ranked && !await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(gameId).first()
    && !await reserveMonthlyWork(env, 'games', `casual:${gameId}`, now)) return false;
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO request_limits(key,count,window_start)
      SELECT ?,1,? WHERE NOT EXISTS(SELECT 1 FROM active_game_seats WHERE user_id=? AND game_id=? AND released_at IS NULL)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN window_start<=? THEN 1 ELSE MIN(count+1,11) END,
        window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END`)
      .bind(`seat:${actor.id}`, now, actor.id, gameId, now - 60_000, now - 60_000),
    env.DB.prepare(`INSERT INTO active_game_seats(user_id,game_id,acquired_at,released_at)
    SELECT u.id,?,?,NULL FROM user u JOIN session s ON s.userId=u.id
    WHERE u.id=? AND s.id=? AND s.expiresAt>?
      AND NOT EXISTS(SELECT 1 FROM identity_change_leases i WHERE i.user_id=u.id AND i.expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM tournament_account_locks t WHERE t.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM tournament_game_admissions t WHERE t.game_id=?)
      AND NOT EXISTS(SELECT 1 FROM casual_game_admissions g WHERE g.game_id=? AND g.storage_state='archived')
      AND (SELECT COUNT(*) FROM active_game_seats a WHERE a.user_id=u.id AND a.game_id<>? AND a.released_at IS NULL)<4
      AND (EXISTS(SELECT 1 FROM active_game_seats a WHERE a.user_id=u.id AND a.game_id=? AND a.released_at IS NULL)
        OR EXISTS(SELECT 1 FROM request_limits l WHERE l.key=? AND l.count<=10 AND l.window_start>?))
      AND (?=0 OR ((${PASSWORD_ACCOUNT_SQL})
        AND NOT EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=u.id AND r.revoked_at IS NULL AND r.expires_at>?)))
      AND ((${PASSWORD_ACCOUNT_SQL})
        OR EXISTS(SELECT 1 FROM active_game_seats a WHERE a.user_id=u.id AND a.game_id=? AND a.released_at IS NULL)
        OR EXISTS(SELECT 1 FROM casual_game_admissions g WHERE g.game_id=? AND g.creator_id=u.id))
      AND (?=1 OR EXISTS(SELECT 1 FROM casual_game_admissions WHERE game_id=?)
        OR EXISTS(SELECT 1 FROM game_admission_counts WHERE kind='casual' AND retained_payloads<? AND permanent_ids<?))
      AND (?=0 OR NOT EXISTS(SELECT 1 FROM casual_game_admissions WHERE game_id=?)
        OR EXISTS(SELECT 1 FROM casual_game_admissions WHERE game_id=? AND creator_id=u.id))
    ON CONFLICT(user_id,game_id) DO UPDATE SET
      acquired_at=CASE WHEN active_game_seats.released_at IS NULL THEN active_game_seats.acquired_at ELSE excluded.acquired_at END,
      released_at=NULL RETURNING user_id`)
      .bind(gameId, now, actor.id, actor.sessionId, new Date(now).toISOString(), now, gameId, gameId, gameId, gameId, `seat:${actor.id}`, now - 60_000, Number(ranked), now, gameId, gameId, Number(ranked), gameId, casualGameLimit(env), casualGameIdLimit(env), Number(creatorOnly), gameId, gameId),
    env.DB.prepare(`INSERT OR IGNORE INTO casual_game_admissions(game_id,creator_id,created_at,reservation_id)
      SELECT game_id,user_id,?,? FROM active_game_seats WHERE user_id=? AND game_id=? AND released_at IS NULL AND ?=0
        AND NOT EXISTS(SELECT 1 FROM tournament_game_admissions t WHERE t.game_id=?)`)
      .bind(now, reservationId ?? null, actor.id, gameId, Number(ranked), gameId),
  ]);
  return results[1].results.length === 1;
}

export async function beginIdentityChange(db: D1Database, userId: string): Promise<string> {
  const now = Date.now();
  const lease = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO identity_change_leases(user_id,lease_id,expires_at)
    SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM active_game_seats WHERE user_id=? AND released_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM tournament_account_locks WHERE user_id=?)
    ON CONFLICT(user_id) DO UPDATE SET lease_id=excluded.lease_id,expires_at=excluded.expires_at
      WHERE identity_change_leases.expires_at<=? RETURNING lease_id`)
    .bind(userId, lease, now + 300_000, userId, userId, now).first<{ lease_id: string }>();
  if (!result) throw new ApiError(409, 'ACTIVE_GAME', 'Finish your active game before changing sign-in.');
  return lease;
}

const allowedAuthPaths = new Map([
  ['/api/auth/sign-up/email', 'POST'], ['/api/auth/sign-in/username', 'POST'],
  ['/api/auth/send-verification-email', 'POST'], ['/api/auth/verify-email', 'GET'],
  ['/api/auth/request-password-reset', 'POST'], ['/api/auth/reset-password', 'POST'],
  ['/api/auth/sign-out', 'POST'], ['/api/auth/revoke-session', 'POST'], ['/api/auth/revoke-other-sessions', 'POST'],
]);

const MAIL_RECEIPT = { ok: true, message: 'If this account exists and delivery is available, an account email will arrive shortly.' };
const SIGN_IN_ERROR = { error: 'INVALID_CREDENTIALS', message: 'The username or password is incorrect.' };
const RESET_ERROR = { error: 'INVALID_RESET', message: 'This reset link is invalid or expired. Request another link.' };

function onlyFields(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some(key => !fields.includes(key))) throw new ApiError(400, 'INVALID_REQUEST', 'Use the fields in the account form.');
}

function accountUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(value)) {
    throw new ApiError(400, 'INVALID_USERNAME', 'Use 3 to 24 letters, digits, or underscores for your username.');
  }
  return value.toLowerCase();
}

function accountPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new ApiError(400, 'INVALID_PASSWORD_LENGTH', `Use a password with ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

function authJson(response: Response, body: unknown, status = response.status): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  if (status === 429 && !headers.has('Retry-After')) {
    const retryAfter = headers.get('X-Retry-After');
    if (retryAfter) headers.set('Retry-After', retryAfter);
  }
  headers.delete('Content-Length');
  headers.delete('Location');
  return new Response(JSON.stringify(body), { status, headers });
}

/** Explicit upgrade for a signed-in legacy account. Guest ownership never transfers. */
export async function completeAccount(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request, env);
  const body = await readJson(request, 2048);
  onlyFields(body, ['username', 'password']);
  const username = accountUsername(body.username);
  const password = accountPassword(body.password);
  const actor = await requireActor(request, env);
  if (actor.isAnonymous) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Create an account to play new games. Existing guest records stay with this session.');
  if (actor.accountReady) throw new ApiError(409, 'ACCOUNT_COMPLETE', 'This account already has a username and password.');
  await consumeAccountRequest(env.DB, actor.id, 'credential');
  await verifyTurnstile(request, env, 'account-complete');
  const lease = await beginIdentityChange(env.DB, actor.id);
  try {
    const auth = createAuth(env);
    const existing = await env.DB.prepare("SELECT 1 FROM account WHERE userId=? AND accountId=? AND providerId='credential' AND password IS NOT NULL AND length(password)>0")
      .bind(actor.id, actor.id).first();
    if (existing) await auth.api.verifyPassword({ headers: request.headers, body: { password } });
    await auth.api.updateUser({ headers: request.headers, body: { name: username, username } as { name: string } });
    if (!existing) await auth.api.setPassword({ headers: request.headers, body: { newPassword: password } });
    return jsonResponse({ ok: true });
  } catch {
    throw new ApiError(400, 'ACCOUNT_NOT_COMPLETED', 'This account could not be completed. Check your username and password, or sign in again.');
  } finally {
    await env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=? AND lease_id=?').bind(actor.id, lease).run();
  }
}

export async function authHandler(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== canonicalOrigin(env)) throw new ApiError(403, 'INVALID_ORIGIN', 'Use the canonical chess site.');
  if (allowedAuthPaths.get(url.pathname) !== request.method) throw new ApiError(404, 'NOT_FOUND', 'This auth endpoint is unavailable.');
  const path = url.pathname.slice('/api/auth'.length);
  if (request.method === 'GET') {
    if ([...url.searchParams.keys()].some(key => !['token', 'callbackURL'].includes(key)) || !url.searchParams.get('token') || url.searchParams.get('token')!.length > 4096) {
      throw new ApiError(400, 'INVALID_VERIFICATION', 'This verification link is invalid or expired.');
    }
    url.searchParams.set('callbackURL', '/account/?verified=1');
    request = new Request(url, request);
  }
  if (request.method === 'POST') {
    requireSameOrigin(request, env);
    if (url.search) throw new ApiError(400, 'INVALID_REQUEST', 'Send account details in the form.');
    let body = await readJson(request.clone(), 2048);
    if (path === '/sign-up/email') {
      onlyFields(body, ['username', 'email', 'password', 'name']);
      const username = accountUsername(body.username);
      const password = accountPassword(body.password);
      let email: string;
      if (body.email === undefined || (typeof body.email === 'string' && !body.email.trim())) {
        email = createPlaceholderEmail({ identifier: crypto.randomUUID(), namespace: 'chess' });
      } else {
        if (typeof body.email !== 'string' || body.email.length > 254 || !hasRecoveryEmail(body.email)) {
          throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid recovery email or leave it blank.');
        }
        email = body.email.trim();
      }
      body = { username, name: username, email, password };
      await verifyTurnstile(request, env, 'sign-up');
    } else if (path === '/sign-in/username') {
      onlyFields(body, ['username', 'password']);
      if (typeof body.username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(body.username) || typeof body.password !== 'string' || !body.password.length || body.password.length > 128) {
        return jsonResponse(SIGN_IN_ERROR, 401);
      }
      body = { username: body.username.toLowerCase(), password: body.password };
      await verifyTurnstile(request, env, 'sign-in');
    } else if (path === '/request-password-reset' || path === '/send-verification-email') {
      onlyFields(body, path === '/request-password-reset' ? ['email'] : []);
      await verifyTurnstile(request, env, path === '/request-password-reset' ? 'password-reset' : 'verify-email');
      const actor = path === '/send-verification-email' ? await requireActor(request, env) : null;
      if (actor && !actor.accountReady) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Complete your account before requesting verification.');
      if ((actor && !hasRecoveryEmail(actor.email)) || (path === '/request-password-reset' && typeof body.email === 'string' && !hasRecoveryEmail(body.email))) {
        return jsonResponse(MAIL_RECEIPT, 202);
      }
      // Availability is checked before any address lookup, including unknown addresses.
      if (!env.EMAIL || !env.EMAIL_FROM || isLocalRequest(request, env) || !await newWorkAllowed(env, 'email')) {
        throw new ApiError(503, 'MAIL_UNAVAILABLE', 'Account email is unavailable. Try again later.');
      }
      if (path === '/send-verification-email') {
        body = { email: actor!.email, callbackURL: '/account/?verified=1' };
      } else {
        if (typeof body.email !== 'string' || body.email.length > 254) return jsonResponse(MAIL_RECEIPT, 202);
        body = { email: body.email, redirectTo: '/account/' };
      }
    } else if (path === '/reset-password') {
      onlyFields(body, ['token', 'newPassword']);
      await verifyTurnstile(request, env, 'password-reset');
      if (typeof body.token !== 'string' || !body.token.length || body.token.length > 256) return jsonResponse(RESET_ERROR, 400);
      body = { token: body.token, newPassword: accountPassword(body.newPassword) };
    }
    request = new Request(request, { body: JSON.stringify(body) });
  }
  let identityChange: { userId: string; lease: string } | undefined;
  if (['/sign-up/email', '/sign-in/username', '/sign-out'].includes(path)) {
    const actor = await currentActor(request, env);
    if (actor) identityChange = { userId: actor.id, lease: await beginIdentityChange(env.DB, actor.id) };
  }
  let response: Response;
  try {
    if (path === '/sign-up/email' && !await reserveSignupAttempt(env)) {
      throw new ApiError(503, 'SIGNUP_UNAVAILABLE', 'New accounts are paused. Try again later, or sign in to an existing account.');
    }
    response = await createAuth(env).handler(request);
  }
  finally {
    if (identityChange) await env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=? AND lease_id=?').bind(identityChange.userId, identityChange.lease).run();
  }
  if (response.status === 429) return authJson(response, { error: 'AUTH_RATE_LIMITED', message: 'Too many account requests. Try again shortly.' });
  if (path === '/request-password-reset' || path === '/send-verification-email') {
    // A provider failure for a known account must not disclose that it exists.
    return authJson(response, MAIL_RECEIPT, 202);
  }
  if (path === '/sign-in/username') return authJson(response, response.ok ? { ok: true } : SIGN_IN_ERROR, response.ok ? 200 : 401);
  if (path === '/sign-up/email') return authJson(response, response.ok ? { ok: true } : { error: 'ACCOUNT_NOT_CREATED', message: 'An account could not be created. Check your details or sign in.' }, response.ok ? 200 : 400);
  if (path === '/reset-password') return authJson(response, response.ok ? { ok: true } : RESET_ERROR, response.ok ? 200 : 400);
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  return result;
}
