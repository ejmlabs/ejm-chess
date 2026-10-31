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

/** The two cron triggers in wrangler.jsonc. */
export const CRON = { minute: '* * * * *', daily: '15 3 * * *' } as const;
type Stage = [name: string, run: () => Promise<unknown>];

async function recordHeartbeat(db: D1Database, statement: string, ...args: Array<string | number | null>): Promise<void> {
  try { await db.prepare(statement).bind(...args).run(); }
  catch { console.error('heartbeat_failed'); }
}

/**
 * Runs one cron invocation and records when it started, when it finished and which stages failed.
 * A failed stage never stops the others, and a failed heartbeat write never stops the work.
 * A run that dies leaves `started_at` newer than `finished_at`.
 */
export async function runScheduled(env: { DB: D1Database }, schedule: string, stages: Stage[]): Promise<void> {
  const startedAt = Date.now();
  await recordHeartbeat(env.DB, `INSERT INTO cron_heartbeats(schedule,started_at) VALUES(?,?)
    ON CONFLICT(schedule) DO UPDATE SET started_at=excluded.started_at`, schedule, startedAt);
  const results = await Promise.allSettled(stages.map(async ([, run]) => run()));
  const failed = stages.filter((_, index) => results[index].status === 'rejected').map(([name]) => name);
  failed.forEach(name => console.error('maintenance_failed', name));
  const error = failed.length ? failed.join(',') : null;
  const finishedAt = Date.now();
  // Only the run that wrote `started_at` may finish it, so an overlapping later run is never reported done early.
  await recordHeartbeat(env.DB, `UPDATE cron_heartbeats SET finished_at=?,last_error=COALESCE(?,last_error),
    last_error_at=CASE WHEN ? IS NULL THEN last_error_at ELSE ? END WHERE schedule=? AND started_at=?`,
  finishedAt, error, error, finishedAt, schedule, startedAt);
}

interface Heartbeat { schedule: string; started_at: number; finished_at: number | null; last_error: string | null; last_error_at: number | null }

/** Private owner status. Healthy means `finishedAt` is recent and not older than `startedAt`, and `lastErrorAt` is null or older than `startedAt`. */
export async function cronStatus(db: D1Database) {
  const { results } = await db.prepare('SELECT schedule,started_at,finished_at,last_error,last_error_at FROM cron_heartbeats').all<Heartbeat>();
  return Object.fromEntries(Object.entries(CRON).map(([name, schedule]) => {
    const row = results.find(item => item.schedule === schedule);
    return [name, { schedule, startedAt: row?.started_at ?? null, finishedAt: row?.finished_at ?? null,
      lastError: row?.last_error ?? null, lastErrorAt: row?.last_error_at ?? null }];
  }));
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
