import { ApiError } from './security';

export type BudgetKind = 'games' | 'email';
export interface BudgetEnv {
  DB: D1Database;
  NEW_WORK_STOPPED?: string;
}

const policies = {
  games: { stop: 'games_stopped' },
  email: { stop: 'email_stopped' },
} as const;
const kinds: BudgetKind[] = ['games', 'email'];
const RECEIPT_RETENTION_MS = 62 * 86_400_000;
export const BUDGET_CLEANUP_BATCH = 100;

interface Control {
  version: number; games_stopped: number; email_stopped: number;
  changed_at: number | null; changed_by: string | null; reason: string | null;
}
interface Month {
  kind: BudgetKind; period: number; used: number; denied: number; first_denied_at: number | null; updated_at: number;
}
interface SignupBudget { period: number; monthly_attempts: number; lifetime_attempts: number }

function period(now: number): number {
  const date = new Date(now);
  if (!Number.isSafeInteger(now) || !Number.isFinite(date.getTime())) throw new Error('invalid_budget_time');
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}
function monthName(value: number): string { return `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`; }

function stoppedByEnv(env: BudgetEnv): boolean {
  return env.NEW_WORK_STOPPED !== undefined && env.NEW_WORK_STOPPED !== 'false';
}
function unavailable(): ApiError {
  return new ApiError(503, 'BUDGET_UNAVAILABLE', 'New work is paused while the service checks its safety allowance. Try again later.');
}

/** A valid challenged signup spends one attempt before maintained hashing. No refunds or reusable credits. */
export async function reserveSignupAttempt(env: BudgetEnv, now = Date.now()): Promise<boolean> {
  const current = period(now);
  if (stoppedByEnv(env)) return false;
  try {
    const accepted = await env.DB.prepare(`UPDATE signup_budget SET period=?,
      monthly_attempts=CASE WHEN period=? THEN monthly_attempts+1 ELSE 1 END,
      lifetime_attempts=lifetime_attempts+1
      WHERE id='product' AND period<=?
        AND EXISTS(SELECT 1 FROM operations_control WHERE id='product' AND games_stopped=0)
      RETURNING 1 AS accepted`)
      .bind(current, current, current).first();
    return accepted !== null;
  } catch { throw unavailable(); }
}

/**
 * Admission is one D1 transaction. SQLite inserts a stable receipt; its trigger
 * charges only a newly inserted row. Accepted receipts survive stops and month
 * rollover. Uncertain work is never refunded. This is usage accounting, not a
 * Cloudflare invoice cap.
 */
export async function reserveMonthlyWork(env: BudgetEnv, kind: BudgetKind, id: string, now = Date.now(), units = 1): Promise<boolean> {
  if (!/^[A-Za-z0-9_:.-]{1,200}$/.test(id) || !Number.isInteger(units) || units < 1 || units > (kind === 'games' ? 6 : 1)) {
    throw new Error('invalid_budget_reservation');
  }
  const current = period(now);
  const policy = policies[kind];
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO budget_months(kind,slot,period,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(kind,slot) DO UPDATE SET period=excluded.period,used=0,denied=0,first_denied_at=NULL,updated_at=excluded.updated_at
        WHERE budget_months.period<excluded.period`).bind(kind, current % 12, current, now),
      env.DB.prepare(`INSERT OR IGNORE INTO budget_receipts(kind,id,period,units,created_at)
        SELECT ?,?,?,?,? WHERE ?=0
          AND EXISTS(SELECT 1 FROM operations_control WHERE id='product' AND ${policy.stop}=0)`)
        .bind(kind, id, current, units, now, Number(stoppedByEnv(env))),
      env.DB.prepare(`UPDATE budget_months SET denied=MIN(denied+1,1000000000),first_denied_at=COALESCE(first_denied_at,?),updated_at=?
        WHERE kind=? AND slot=? AND period=? AND NOT EXISTS(SELECT 1 FROM budget_receipts WHERE kind=? AND id=? AND units=?)`)
        .bind(now, now, kind, current % 12, current, kind, id, units),
      env.DB.prepare('SELECT 1 AS accepted FROM budget_receipts WHERE kind=? AND id=? AND units=?').bind(kind, id, units),
    ]);
    return result[3].results.length === 1;
  } catch { throw unavailable(); }
}

/** A preflight for a new queue/registration entry. A later receipt is still required. */
export async function newWorkAllowed(env: BudgetEnv, kind: BudgetKind): Promise<boolean> {
  if (stoppedByEnv(env)) return false;
  try {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM operations_control WHERE id='product' AND ${policies[kind].stop}=0`).bind().first());
  } catch { throw unavailable(); }
}

/** Private owner status. Aggregate history has at most 36 rows and changes at most 64. */
export async function budgetStatus(env: BudgetEnv, now = Date.now()) {
  const current = period(now);
  const [control, months, receipts, changes, signup] = await Promise.all([
    env.DB.prepare('SELECT version,games_stopped,email_stopped,changed_at,changed_by,reason FROM operations_control WHERE id=?').bind('product').first<Control>(),
    env.DB.prepare('SELECT kind,period,used,denied,first_denied_at,updated_at FROM budget_months ORDER BY period DESC,kind').all<Month>(),
    env.DB.prepare('SELECT kind,count FROM budget_receipt_counts').all<{ kind: BudgetKind; count: number }>(),
    env.DB.prepare('SELECT version,games_stopped,email_stopped,changed_at,changed_by,reason FROM operations_changes ORDER BY version DESC LIMIT 8').all<Control>(),
    env.DB.prepare("SELECT period,monthly_attempts,lifetime_attempts FROM signup_budget WHERE id='product'").first<SignupBudget>(),
  ]);
  if (!control || !signup) throw unavailable();
  const signupUsed = signup.period === current ? signup.monthly_attempts : 0;
  const signupStopped = stoppedByEnv(env) || control.games_stopped !== 0;
  return {
    month: monthName(current), envelopeUsd: 100, invoiceHardCap: false, stoppedByEnv: stoppedByEnv(env),
    control, recentChanges: changes.results,
    signup: {
      used: signupUsed, lifetimeUsed: signup.lifetime_attempts, stopped: signupStopped,
      accepting: !signupStopped && signup.period <= current,
    },
    allowances: kinds.map(kind => {
      const policy = policies[kind];
      const usage = months.results.find(row => row.kind === kind && row.period === current);
      const stopped = stoppedByEnv(env) || control[policy.stop] !== 0;
      return { kind, used: usage?.used ?? 0, stopped, accepting: !stopped,
        denied: usage?.denied ?? 0, firstDeniedAt: usage?.first_denied_at ?? null,
        retainedReceipts: receipts.results.find(row => row.kind === kind)?.count ?? 0 };
    }),
    history: months.results.map(({ period: value, ...row }) => ({ ...row, month: monthName(value) })),
  };
}

/** Retain permanent game receipts. Never remove an accepted game or delivery record. */
export async function cleanupBudgetReceipts(env: BudgetEnv, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(`DELETE FROM budget_receipts WHERE rowid IN
    (SELECT rowid FROM budget_receipts WHERE kind='email' AND created_at<? ORDER BY created_at,id LIMIT ?)
    RETURNING 1 AS removed`)
    .bind(now - RECEIPT_RETENTION_MS, BUDGET_CLEANUP_BATCH).all();
  return result.results.length;
}
