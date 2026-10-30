import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { ACCOUNT_EXPORT_CATEGORIES, ACCOUNT_PRIVACY_POLICY, type AccountClosureReceipt, type AccountExportCategory, type AccountExportPage } from '../shared/privacy';
import { beginIdentityChange, createAuth, hasRecoveryEmail, type Actor } from './auth';
import { consumeAccountRequest } from './abuse';
import type { Env } from './env';
import { ApiError, jsonResponse, readJson, requireSameOrigin } from './security';

const PAGE_RECORDS = 50;
const PAGE_BYTES = 256 * 1024;
const identifier = /^[a-zA-Z0-9_.:-]{8,100}$/;
type ReceiptRow = { request_id: string; user_id: string; policy_version: typeof ACCOUNT_PRIVACY_POLICY; completed_at: number };

function receipt(row: ReceiptRow): AccountClosureReceipt {
  return { requestId: row.request_id, userId: row.user_id, policyVersion: row.policy_version, completedAt: row.completed_at };
}

async function confirmPassword(request: Request, env: Env, actor: Actor, body: Record<string, unknown>, fields: string[]): Promise<void> {
  if (!actor.accountReady || actor.isAnonymous) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Use your username and password account.');
  if (Object.keys(body).some(key => !fields.includes(key)) || typeof body.password !== 'string' || !body.password.length || body.password.length > 128) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Use the fields in the account form.');
  }
  await consumeAccountRequest(env.DB, actor.id, 'credential');
  try { await createAuth(env).api.verifyPassword({ headers: request.headers, body: { password: body.password } }); }
  catch { throw new ApiError(400, 'INVALID_PASSWORD', 'Your current password could not be confirmed. Sign in again or check your password.'); }
}

/** Trusted lifecycle adapter, also used to reapply preserved receipts during an approved restore.
 * Better Auth owns credentials. Its hard-delete contract cannot retain chess foreign keys.
 * Remove this adapter when a maintained public contract supplies atomic minimization.
 */
export async function applyAccountClosure(db: D1Database, accepted: AccountClosureReceipt, guard?: { leaseId: string; sessionId: string }): Promise<AccountClosureReceipt> {
  if (!identifier.test(accepted.requestId) || !identifier.test(accepted.userId) || accepted.policyVersion !== ACCOUNT_PRIVACY_POLICY
    || !Number.isSafeInteger(accepted.completedAt) || accepted.completedAt <= 0 || accepted.completedAt > Date.now() + 30_000) throw new Error('invalid_closure_receipt');
  const email = createPlaceholderEmail({ identifier: accepted.userId, namespace: 'closed-chess' });
  const hasReceipt = 'EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=?)';
  const guardSql = guard ? `AND EXISTS(SELECT 1 FROM identity_change_leases WHERE user_id=u.id AND lease_id=?
    AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)
    AND EXISTS(SELECT 1 FROM session WHERE userId=u.id AND id=? AND expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now'))` : '';
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO account_closure_receipts(request_id,user_id,policy_version,completed_at)
      SELECT ?,u.id,?,? FROM user u WHERE u.id=?
        AND NOT EXISTS(SELECT 1 FROM active_game_seats WHERE user_id=u.id AND released_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM tournament_account_locks WHERE user_id=u.id) ${guardSql}`)
      .bind(accepted.requestId, accepted.policyVersion, accepted.completedAt, accepted.userId, ...(guard ? [guard.leaseId, guard.sessionId] : [])),
    db.prepare(`DELETE FROM account WHERE userId=? AND ${hasReceipt}`).bind(accepted.userId, accepted.userId),
    db.prepare(`DELETE FROM session WHERE userId=? AND ${hasReceipt}`).bind(accepted.userId, accepted.userId),
    db.prepare(`DELETE FROM verification WHERE value=? AND ${hasReceipt}`).bind(accepted.userId, accepted.userId),
    db.prepare(`UPDATE user SET name='Closed account',email=?,emailVerified=0,image=NULL,username=NULL,isAnonymous=0,updatedAt=?
      WHERE id=? AND ${hasReceipt}`).bind(email, new Date(accepted.completedAt).toISOString(), accepted.userId, accepted.userId),
    db.prepare(`UPDATE leaderboard_entries SET eligible=0 WHERE user_id=? AND ${hasReceipt}`).bind(accepted.userId, accepted.userId),
    db.prepare('SELECT request_id,user_id,policy_version,completed_at FROM account_closure_receipts WHERE user_id=?').bind(accepted.userId),
  ]);
  const saved = results.at(-1)!.results[0] as ReceiptRow | undefined;
  if (!saved) throw new ApiError(409, 'ACCOUNT_CLOSURE_PENDING', 'Account closure could not be accepted. Finish active games or pending reservations and try again.');
  return receipt(saved);
}

export async function closeAccount(request: Request, env: Env, actor: Actor): Promise<Response> {
  requireSameOrigin(request, env);
  const body = await readJson(request, 2048);
  if (body.confirmation !== 'CLOSE' || typeof body.requestId !== 'string' || !identifier.test(body.requestId)) {
    throw new ApiError(400, 'CLOSURE_CONFIRMATION_REQUIRED', 'Confirm account closure using the account form.');
  }
  await confirmPassword(request, env, actor, body, ['password', 'confirmation', 'requestId']);
  const leaseId = await beginIdentityChange(env.DB, actor.id);
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  let saved: AccountClosureReceipt;
  try {
    if (!await competition.reserveAccountClosure(actor.id, body.requestId, leaseId)) {
      throw new ApiError(409, 'ACTIVE_GAME', 'Finish active games, pending reservations, or event queues before closing your account.');
    }
    saved = await applyAccountClosure(env.DB, { requestId: body.requestId, userId: actor.id, policyVersion: ACCOUNT_PRIVACY_POLICY, completedAt: Date.now() },
      { leaseId, sessionId: actor.sessionId });
  } finally {
    // Remove the D1 authority before releasing a pending fence. A delayed batch
    // cannot accept this lease after its reservation has been released.
    await env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=? AND lease_id=?').bind(actor.id, leaseId).run();
    await competition.settleAccountClosure(actor.id, leaseId);
  }
  const signedOut = await createAuth(env).api.signOut({ headers: request.headers, asResponse: true });
  const response = jsonResponse(saved);
  for (const cookie of signedOut.headers.getSetCookie()) response.headers.append('Set-Cookie', cookie);
  return response;
}

async function exportRows(db: D1Database, userId: string, category: AccountExportCategory, after: string): Promise<Array<Record<string, unknown>>> {
  if (category === 'profile') {
    const profile = await db.prepare('SELECT id,name,username,email,emailVerified,image,createdAt,updatedAt FROM user WHERE id=?').bind(userId).first<Record<string, unknown>>();
    if (!profile) return [];
    return [{ ...profile, email: typeof profile.email === 'string' && hasRecoveryEmail(profile.email) ? profile.email : null }];
  }
  const queries = {
    reports: `SELECT r.id,r.game_id AS gameId,r.case_id AS caseId,r.reason,r.details,r.created_at AS createdAt,
      c.status,c.automatic_closed_at AS automaticClosedAt,c.automatic_outcome AS automaticOutcome
      FROM fairplay_reports r JOIN fairplay_cases c ON c.id=r.case_id WHERE r.reporter_id=? AND r.id>? ORDER BY r.id LIMIT 51`,
    appeals: `SELECT id,decision_id AS decisionId,case_id AS caseId,reason,status,created_at AS createdAt,resolved_at AS resolvedAt,
      automatic_closed_at AS automaticClosedAt,automatic_outcome AS automaticOutcome
      FROM fairplay_appeals WHERE user_id=? AND id>? ORDER BY id LIMIT 51`,
    notices: `SELECT d.id,d.case_id AS caseId,d.outcome,d.reason,d.created_at AS createdAt,d.appeal_until AS appealUntil,
      r.id AS restrictionId,r.starts_at AS restrictionStartsAt,r.expires_at AS restrictionExpiresAt,r.revoked_at AS restrictionRevokedAt
      FROM fairplay_decisions d LEFT JOIN restrictions r ON r.decision_id=d.id WHERE d.subject_id=? AND d.id>? ORDER BY d.id LIMIT 51`,
    games: `SELECT id,pool AS format,rated,white_id AS whiteId,black_id AS blackId,white_name AS whiteName,black_name AS blackName,
      status,reason,winner,score,started_at AS startedAt,ended_at AS endedAt,plies,rules_version AS rulesVersion,
      settlement,rating_voided AS ratingVoided,ai_model_id AS computerModel FROM games
      WHERE (white_id=? OR black_id=?) AND id>? ORDER BY id LIMIT 51`,
  };
  const rows = await db.prepare(queries[category]).bind(userId, ...(category === 'games' ? [userId] : []), after).all<Record<string, unknown>>();
  return category === 'games' ? rows.results.map(row => ({ ...row, ...(row.status === 'finished' ? { pgnUrl: `/api/games/${row.id}/pgn` } : {}) })) : rows.results;
}

export async function exportAccount(request: Request, env: Env, actor: Actor): Promise<Response> {
  requireSameOrigin(request, env);
  const body = await readJson(request, 2048);
  if (typeof body.category !== 'string' || !ACCOUNT_EXPORT_CATEGORIES.includes(body.category as AccountExportCategory)
    || (body.cursor !== undefined && (typeof body.cursor !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(body.cursor)))
    || (body.category === 'profile' && body.cursor !== undefined)) throw new ApiError(400, 'INVALID_EXPORT_PAGE', 'Choose an account data category and a valid page.');
  await confirmPassword(request, env, actor, body, ['password', 'category', 'cursor']);
  const category = body.category as AccountExportCategory;
  const rows = await exportRows(env.DB, actor.id, category, body.cursor as string ?? '');
  const page: AccountExportPage = { policyVersion: ACCOUNT_PRIVACY_POLICY, exportedAt: Date.now(), category, records: [], nextCursor: null, atomicSnapshot: false };
  const encoder = new TextEncoder();
  // Count each record once and reserve the maximum cursor envelope before adding it.
  let bytes = encoder.encode(JSON.stringify({ ...page, nextCursor: 'x'.repeat(200) })).byteLength;
  for (const row of rows.slice(0, PAGE_RECORDS)) {
    const size = encoder.encode(JSON.stringify(row)).byteLength + (page.records.length ? 1 : 0);
    if (bytes + size > PAGE_BYTES) break;
    page.records.push(row); bytes += size;
  }
  if (rows.length && !page.records.length) throw new ApiError(503, 'EXPORT_RECORD_TOO_LARGE', 'This account data page exceeds its safety limit.');
  if (page.records.length < rows.length) page.nextCursor = String(page.records.at(-1)!.id);
  return new Response(JSON.stringify(page), { headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="chess-account-${category}.json"`, 'Cache-Control': 'no-store' } });
}
