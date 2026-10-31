import { budgetStatus, type BudgetEnv } from './budget';
import { ApiError } from './security';

/** The retired `analysis_stopped` column is NOT NULL without a default in `operations_changes`, so each change row writes 0. */
const CHANGE_COLUMNS = 'slot,version,games_stopped,email_stopped,analysis_stopped,changed_at,changed_by,reason';
const CHANGE_VALUES = 'version%64,version,games_stopped,email_stopped,0,changed_at,changed_by,reason';
const CHANGE_CONFLICT = `ON CONFLICT(slot) DO UPDATE SET version=excluded.version,games_stopped=excluded.games_stopped,email_stopped=excluded.email_stopped,
  changed_at=excluded.changed_at,changed_by=excluded.changed_by,reason=excluded.reason`;

/** Called only after the Worker has checked the owner account and Access JWT. */
export async function setBudgetStops(env: BudgetEnv, actorId: string, body: Record<string, unknown>, now = Date.now()) {
  if (Object.keys(body).some(key => !['expectedVersion', 'gamesStopped', 'emailStopped', 'reason'].includes(key))
    || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0
    || typeof body.gamesStopped !== 'boolean' || typeof body.emailStopped !== 'boolean'
    || typeof body.reason !== 'string' || [...body.reason.trim()].length < 10 || body.reason.trim().length > 240 || body.reason.includes('\0')) {
    throw new ApiError(400, 'INVALID_BUDGET_CONTROL', 'Supply the current version, both stop settings, and a reason of 10 to 240 characters.');
  }
  const reason = body.reason.trim();
  const version = Number(body.expectedVersion);
  const updated = await env.DB.batch([
    env.DB.prepare(`UPDATE operations_control SET version=version+1,games_stopped=?,email_stopped=?,changed_at=?,changed_by=?,reason=?
      WHERE id='product' AND version=? RETURNING version`)
      .bind(Number(body.gamesStopped), Number(body.emailStopped), now, actorId, reason, version),
    env.DB.prepare(`INSERT INTO operations_changes(${CHANGE_COLUMNS}) SELECT ${CHANGE_VALUES} FROM operations_control
      WHERE id='product' AND version=? ${CHANGE_CONFLICT}`)
      .bind(version + 1),
  ]);
  if (updated[0].results.length !== 1) throw new ApiError(409, 'BUDGET_CONTROL_CHANGED', 'Refresh operations status before changing the stops.');
  return budgetStatus(env, now);
}

/** A verified dedicated notification can only stop work. Retries while stopped are no-ops. */
export async function stopNewWorkAutomatically(env: BudgetEnv, now = Date.now()): Promise<void> {
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE operations_control SET version=version+1,games_stopped=1,email_stopped=1,
        changed_at=?,changed_by='cloudflare:budget-stop',reason='Dedicated Cloudflare budget-stop notification received.'
        WHERE id='product' AND (games_stopped=0 OR email_stopped=0)`)
        .bind(now),
      env.DB.prepare(`INSERT INTO operations_changes(${CHANGE_COLUMNS}) SELECT ${CHANGE_VALUES} FROM operations_control
        WHERE id='product' AND changed_by='cloudflare:budget-stop' AND changed_at=? ${CHANGE_CONFLICT}`)
        .bind(now),
      env.DB.prepare("SELECT 1 FROM operations_control WHERE id='product' AND games_stopped=1 AND email_stopped=1"),
    ]);
    if (result[2].results.length !== 1) throw new Error('budget_control_missing');
  } catch {
    throw new ApiError(503, 'BUDGET_UNAVAILABLE', 'The service could not confirm its admission stop. Retry the notification.');
  }
}
