import type { Env } from './env';
import { ADJUDICATION_WAIT_MS, GAME_HOT_RETENTION_MS } from './game';
import { cleanupBudgetReceipts } from './budget';
import { DAY } from './schedule';

const GAME_MAINTENANCE_BATCH = 4;
const GAME_MAINTENANCE_RETRY_MS = 300_000;
const GAME_RETIREMENT_SCALED_BATCH = 32;
const GAME_RETIREMENT_CONCURRENCY = 4;
// The D1 bucket holds milli-tokens, so tokens per second is also milli-tokens per millisecond.
const RETIREMENT_TOKENS_PER_SECOND = 32;
const RETIREMENT_BURST_MILLI = 32_000;

type Ledger = 'casual_game_admissions' | 'tournament_game_admissions';
interface Candidate { ledger: Ledger; game_id: string; result_version: number; terminal_digest: string }
export interface MaintenanceResult { attempted: number; completed: number; failed: number }

const ledgers: Ledger[] = ['casual_game_admissions', 'tournament_game_admissions'];
/** No game outlives its clocks: two initial allowances plus an increment for every ply of the cap is about 18 hours. */
const GAME_MAX_AGE_MS = DAY;
/** Competition polls every game it admitted through a durable intent. Only older casual admissions have none. */
const UNWATCHED: Record<Ledger, string> = {
  casual_game_admissions: 'casual_game_admissions.reservation_id IS NULL',
  tournament_game_admissions: '0',
};

async function takeBudget(env: Env, kind: 'game-retirement' | 'game-recovery', now: number): Promise<boolean> {
  const window = Math.floor(now / 60_000) * 60_000;
  const row = await env.DB.prepare(`INSERT INTO maintenance_budgets(kind,window_start,attempts) VALUES(?,?,1)
    ON CONFLICT(kind) DO UPDATE SET window_start=excluded.window_start,
      attempts=CASE WHEN maintenance_budgets.window_start<excluded.window_start THEN 1 ELSE maintenance_budgets.attempts+1 END
    WHERE maintenance_budgets.window_start<excluded.window_start OR (maintenance_budgets.window_start=excluded.window_start AND maintenance_budgets.attempts<4)
    RETURNING attempts`).bind(kind, window).first();
  return row !== null;
}

export function retirementMode(env: Pick<Env, 'GAME_RETIREMENT_MODE'>): 'preview' | 'scaled' | 'closed' {
  if (env.GAME_RETIREMENT_MODE === undefined || env.GAME_RETIREMENT_MODE === 'preview') return 'preview';
  return env.GAME_RETIREMENT_MODE === 'scaled' ? 'scaled' : 'closed';
}

function holds(ledger: string): string {
  return `NOT EXISTS(SELECT 1 FROM active_game_seats s WHERE s.game_id=${ledger}.game_id AND s.released_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM fairplay_evidence e WHERE e.game_id=${ledger}.game_id AND (e.expires_at>? OR e.hold_until>?))
    AND NOT EXISTS(SELECT 1 FROM fairplay_cases c JOIN fairplay_appeals a ON a.case_id=c.id
      WHERE c.game_id=${ledger}.game_id AND a.status='pending' AND a.automatic_closed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM fairplay_evidence e JOIN fairplay_appeals a ON a.case_id=e.case_id
      WHERE e.game_id=${ledger}.game_id AND a.status='pending' AND a.automatic_closed_at IS NULL)`;
}

async function archiveCandidate(env: Env, candidate: Candidate, now: number): Promise<boolean> {
  let receiptReceived = false;
  try {
    const receipt = await env.GAME.get(env.GAME.idFromName(candidate.game_id)).archive({
      gameId: candidate.game_id, expectedVersion: candidate.result_version, terminalDigest: candidate.terminal_digest,
    });
    if (receipt.gameId !== candidate.game_id || receipt.terminalVersion !== candidate.result_version
      || receipt.terminalDigest !== candidate.terminal_digest || !Number.isSafeInteger(receipt.archivedAt)
      || receipt.archivedAt > Date.now()) throw new Error('archive_receipt_mismatch');
    receiptReceived = true;
    const marked = await env.DB.prepare(`UPDATE ${candidate.ledger} SET storage_state='archived',archived_at=?,
      terminal_version=?,terminal_digest=?,archive_retry_at=0,archive_error=NULL
      WHERE game_id=? AND storage_state='retained'
        AND EXISTS(SELECT 1 FROM games g WHERE g.id=${candidate.ledger}.game_id AND g.status='finished' AND g.rated=0
          AND g.settlement<>'pending' AND g.result_version=? AND g.terminal_digest=?) RETURNING game_id`)
      .bind(receipt.archivedAt, receipt.terminalVersion, receipt.terminalDigest, candidate.game_id,
        receipt.terminalVersion, receipt.terminalDigest).first();
    if (!marked) throw new Error('archive_projection_changed');
    return true;
  } catch {
    await env.DB.prepare(`UPDATE ${candidate.ledger} SET archive_retry_at=MAX(archive_retry_at,?),
      archive_error=CASE WHEN ?=1 OR archive_error='archive_receipt_pending' THEN 'archive_receipt_pending'
        WHEN COALESCE(archive_error,'') LIKE 'retiring:%' THEN archive_error ELSE 'retirement_failed' END
      WHERE game_id=? AND storage_state='retained'`).bind(now + GAME_MAINTENANCE_RETRY_MS, Number(receiptReceived), candidate.game_id).run();
    return false;
  }
}

/** Preview remains four attempts per minute across every caller. */
async function retirePreviewPayloads(env: Env, now: number): Promise<MaintenanceResult> {
  const select = ledgers.map(ledger => `SELECT '${ledger}' AS ledger,${ledger}.game_id,g.result_version,g.terminal_digest,g.ended_at
    FROM ${ledger} JOIN games g ON g.id=${ledger}.game_id
    WHERE ${ledger}.storage_state='retained' AND ${ledger}.archive_retry_at<=?
      AND g.status='finished' AND g.rated=0 AND g.settlement<>'pending' AND g.ended_at<=?
      AND g.terminal_digest IS NOT NULL AND (COALESCE(${ledger}.archive_error,'') LIKE 'retiring:%'
        OR ${ledger}.archive_error='archive_receipt_pending' OR (${holds(ledger)}))`).join(' UNION ALL ');
  const args = ledgers.flatMap(() => [now, now - GAME_HOT_RETENTION_MS, now, now]);
  const candidates = (await env.DB.prepare(`${select} ORDER BY ended_at,game_id LIMIT ?`)
    .bind(...args, GAME_MAINTENANCE_BATCH).all<Candidate>()).results;
  const result = { attempted: 0, completed: 0, failed: 0 };
  for (const candidate of candidates) {
    if (!await takeBudget(env, 'game-retirement', now)) break;
    result.attempted++;
    if (await archiveCandidate(env, candidate, now)) result.completed++;
    else result.failed++;
  }
  return result;
}

async function takeScaledBudget(env: Env, now: number): Promise<boolean> {
  const row = await env.DB.prepare(`UPDATE game_retirement_budget
    SET tokens_milli=MIN(${RETIREMENT_BURST_MILLI},tokens_milli+MAX(0,?-refilled_at)*${RETIREMENT_TOKENS_PER_SECOND})-1000,refilled_at=MAX(refilled_at,?)
    WHERE id=1 AND MIN(${RETIREMENT_BURST_MILLI},tokens_milli+MAX(0,?-refilled_at)*${RETIREMENT_TOKENS_PER_SECOND})>=1000 RETURNING tokens_milli`)
    .bind(now, now, now).first();
  return row !== null;
}

/** Called only by the global Competition's single-flight coordinator. */
export async function runScaledRetirementPass(env: Env, now = Date.now()): Promise<MaintenanceResult> {
  const result = { attempted: 0, completed: 0, failed: 0 };
  if (retirementMode(env) !== 'scaled') return result;
  const candidates = (await env.DB.prepare(`WITH due AS (
      SELECT * FROM game_retirement_work WHERE ready_at<=? ORDER BY ready_at,game_id LIMIT ?)
    SELECT due.ledger,due.game_id,g.result_version,g.terminal_digest,
      CASE WHEN due.ledger='casual_game_admissions' THEN c.archive_error ELSE t.archive_error END AS archive_error,
      (${holds('due')}) AS unheld
    FROM due JOIN games g ON g.id=due.game_id
    LEFT JOIN casual_game_admissions c ON c.game_id=due.game_id
    LEFT JOIN tournament_game_admissions t ON t.game_id=due.game_id`)
    .bind(now, GAME_RETIREMENT_SCALED_BATCH, now, now).all<Candidate & { archive_error: string | null; unheld: number }>()).results;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(GAME_RETIREMENT_CONCURRENCY, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      // A recovered archive receipt is valid even if evidence arrived after
      // the tombstone commit. Game.archive still checks its exact identity.
      if (!candidate.unheld && !candidate.archive_error?.startsWith('retiring:') && candidate.archive_error !== 'archive_receipt_pending') {
        await env.DB.prepare(`UPDATE ${candidate.ledger} SET archive_retry_at=MAX(archive_retry_at,?)
          WHERE game_id=? AND storage_state='retained'`).bind(now + GAME_MAINTENANCE_RETRY_MS, candidate.game_id).run();
        continue;
      }
      if (!await takeScaledBudget(env, now)) return;
      result.attempted++;
      if (await archiveCandidate(env, candidate, now)) result.completed++;
      else result.failed++;
    }
  }));
  return result;
}

export async function nextRetirementAt(env: Env, now = Date.now()): Promise<number | null> {
  if (retirementMode(env) !== 'scaled') return null;
  const row = await env.DB.prepare('SELECT ready_at FROM game_retirement_work ORDER BY ready_at,game_id LIMIT 1').first<{ ready_at: number }>();
  if (!row) return null;
  if (row.ready_at > now) return row.ready_at;
  const budget = await env.DB.prepare('SELECT tokens_milli,refilled_at FROM game_retirement_budget WHERE id=1').first<{ tokens_milli: number; refilled_at: number }>();
  if (!budget) throw new Error('retirement_budget_missing');
  const tokens = Math.min(RETIREMENT_BURST_MILLI, budget.tokens_milli + Math.max(0, now - budget.refilled_at) * RETIREMENT_TOKENS_PER_SECOND);
  return tokens >= 1_000 ? now + 1 : Math.max(now, budget.refilled_at) + Math.ceil((1_000 - tokens) / RETIREMENT_TOKENS_PER_SECOND);
}

export async function retirementStatus(env: Env) {
  const work = await env.DB.prepare('SELECT COUNT(*) AS pending,MIN(ready_at) AS oldestDue FROM game_retirement_work').first<{ pending: number; oldestDue: number | null }>();
  return { mode: retirementMode(env), ...work, batch: GAME_RETIREMENT_SCALED_BATCH,
    concurrency: GAME_RETIREMENT_CONCURRENCY, tokensPerSecond: RETIREMENT_TOKENS_PER_SECOND,
    tokenBurst: RETIREMENT_BURST_MILLI / 1_000, hotRetentionMs: GAME_HOT_RETENTION_MS };
}

/** All expanded callers share the same coordinator, token bucket and alarm. */
export async function retireGamePayloads(env: Env, now = Date.now()): Promise<MaintenanceResult> {
  const mode = retirementMode(env);
  if (mode === 'scaled') return env.COMPETITION.get(env.COMPETITION.idFromName('global')).retirePayloads();
  if (mode === 'closed') return { attempted: 0, completed: 0, failed: 0 };
  return retirePreviewPayloads(env, now);
}

/**
 * Retry expired authority work even after a Durable Object alarm has exhausted retries.
 * D1 holds no Game deadlines, so a healthy game cannot be told from an overdue one. Competition already
 * reconciles each game it admitted every 30 seconds, so this fallback skips those until they are older than
 * any game can be. A game Competition cannot see is polled from the end of the adjudication wait.
 */
async function recoverUnattendedGames(env: Env, now: number): Promise<MaintenanceResult> {
  const select = ledgers.map(ledger => `SELECT '${ledger}' AS ledger,${ledger}.game_id,
      COALESCE(g.ended_at,${ledger}.created_at) AS due_at
    FROM ${ledger} LEFT JOIN games g ON g.id=${ledger}.game_id
    WHERE ${ledger}.storage_state='retained' AND ${ledger}.archive_retry_at<=?
      AND ((g.status='pending-adjudication' AND g.ended_at<=?)
        OR (g.id IS NULL AND ${ledger}.created_at<=CASE WHEN ${UNWATCHED[ledger]} THEN ? ELSE ? END))`).join(' UNION ALL ');
  const args = ledgers.flatMap(() => [now, now - ADJUDICATION_WAIT_MS, now - ADJUDICATION_WAIT_MS, now - GAME_MAX_AGE_MS]);
  const candidates = (await env.DB.prepare(`${select} ORDER BY due_at,game_id LIMIT ?`)
    .bind(...args, GAME_MAINTENANCE_BATCH).all<Pick<Candidate, 'ledger' | 'game_id'>>()).results;
  const result = { attempted: 0, completed: 0, failed: 0 };
  for (const candidate of candidates) {
    if (!await takeBudget(env, 'game-recovery', now)) break;
    const claimed = await env.DB.prepare(`UPDATE ${candidate.ledger} SET archive_retry_at=?
      WHERE game_id=? AND storage_state='retained' AND archive_retry_at<=? RETURNING game_id`)
      .bind(now + GAME_MAINTENANCE_RETRY_MS, candidate.game_id, now).first();
    if (!claimed) continue;
    result.attempted++;
    try {
      const game = env.GAME.get(env.GAME.idFromName(candidate.game_id));
      await game.status();
      await game.flush();
      result.completed++;
    } catch { result.failed++; }
  }
  return result;
}

export async function maintainUnattendedGames(env: Env, now = Date.now()) {
  const recovery = await recoverUnattendedGames(env, now);
  const retirement = await retireGamePayloads(env, now);
  // Cleanup keeps work receipts bounded even while all new work is stopped.
  // Its failure must not prevent accepted game recovery or retirement.
  let budgetReceipts: number | 'retry-needed';
  try { budgetReceipts = await cleanupBudgetReceipts(env, now); }
  catch { budgetReceipts = 'retry-needed'; }
  return { recovery, retirement, budgetReceipts };
}
