import type { Env } from './env';
import { ApiError } from './security';
import { PROOF_PROFILE, PROOF_RULES_VERSION } from './proof-contract';

export const PROOF_RETAINED_LIMIT = 1_000;

export function proofMonthlyLimit(env: Pick<Env, 'MONTHLY_PROOF_LIMIT'>): number {
  const raw = env.MONTHLY_PROOF_LIMIT;
  return raw !== undefined && /^\d{1,4}$/.test(raw) && Number(raw) <= 1_000 ? Number(raw) : 0;
}

export function proofConfigured(env: Pick<Env, 'TIMEOUT_PROOF_PROFILE' | 'PROVER' | 'MONTHLY_PROOF_LIMIT'>): boolean {
  return env.TIMEOUT_PROOF_PROFILE === PROOF_PROFILE && Boolean(env.PROVER) && proofMonthlyLimit(env) > 0;
}

function period(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_proof_budget_time');
  const date = new Date(now);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function unavailable(): ApiError {
  return new ApiError(503, 'PROOF_BUDGET_UNAVAILABLE', 'Ranked play is paused while timeout proof capacity is checked.');
}

export async function hasProofAdmission(env: Pick<Env, 'DB'>, gameId: string): Promise<boolean> {
  try {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM timeout_proof_admissions
      WHERE game_id=? AND rules_version=? AND profile_version=? AND credits=2`)
      .bind(gameId, PROOF_RULES_VERSION, PROOF_PROFILE).first());
  } catch { throw unavailable(); }
}

/** Saved credits survive stops, disabled config and month rollover. No refunds. */
export async function reserveProofAdmission(env: Env, gameId: string, now = Date.now()): Promise<boolean> {
  if (!/^[\w-]{8,100}$/.test(gameId)) throw new Error('invalid_proof_admission');
  const current = period(now);
  const enabled = proofConfigured(env) && (env.NEW_WORK_STOPPED === undefined || env.NEW_WORK_STOPPED === 'false');
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO timeout_proof_months(slot,period) VALUES(?,?)
        ON CONFLICT(slot) DO UPDATE SET period=excluded.period,used=0 WHERE timeout_proof_months.period<excluded.period`)
        .bind(current % 12, current),
      env.DB.prepare(`INSERT OR IGNORE INTO timeout_proof_admissions(game_id,rules_version,profile_version,credits,period,created_at)
        SELECT ?,?,?,2,?,? WHERE ?=1
          AND EXISTS(SELECT 1 FROM operations_control WHERE id='product' AND games_stopped=0)
          AND EXISTS(SELECT 1 FROM timeout_proof_months WHERE slot=? AND period=? AND used<?)
          AND (SELECT COUNT(*) FROM timeout_proof_admissions)<?`)
        .bind(gameId, PROOF_RULES_VERSION, PROOF_PROFILE, current, now, Number(enabled), current % 12, current,
          proofMonthlyLimit(env), PROOF_RETAINED_LIMIT),
      env.DB.prepare('SELECT 1 AS accepted FROM timeout_proof_admissions WHERE game_id=? AND rules_version=? AND profile_version=? AND credits=2')
        .bind(gameId, PROOF_RULES_VERSION, PROOF_PROFILE),
    ]);
    return result[2].results.length === 1;
  } catch { throw unavailable(); }
}

export async function proofBudgetAvailable(env: Env, now = Date.now()): Promise<boolean> {
  if (!proofConfigured(env) || (env.NEW_WORK_STOPPED !== undefined && env.NEW_WORK_STOPPED !== 'false')) return false;
  const current = period(now);
  try {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM operations_control WHERE id='product' AND games_stopped=0
      AND COALESCE((SELECT used FROM timeout_proof_months WHERE slot=? AND period=?),0)<?
      AND (SELECT COUNT(*) FROM timeout_proof_admissions)<?`)
      .bind(current % 12, current, proofMonthlyLimit(env), PROOF_RETAINED_LIMIT).first());
  } catch { throw unavailable(); }
}

export async function proofBudgetStatus(env: Env, now = Date.now()) {
  const current = period(now);
  const data = await env.DB.prepare(`SELECT
    COALESCE((SELECT used FROM timeout_proof_months WHERE slot=? AND period=?),0) AS used,
    (SELECT COUNT(*) FROM timeout_proof_admissions) AS retained`)
    .bind(current % 12, current).first<{ used: number; retained: number }>();
  return { configured: proofConfigured(env), limit: proofMonthlyLimit(env), used: data?.used ?? 0,
    retained: data?.retained ?? 0, retainedLimit: PROOF_RETAINED_LIMIT, creditsPerGame: 2, allocationUsd: 25, invoiceHardCap: false };
}
