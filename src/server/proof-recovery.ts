import type { Env } from './env';
import { ApiError } from './security';
import { PROOF_PROFILE, PROOF_RULES_VERSION, proofHash } from './proof-contract';
import { type ProofLifecycle, proofLifecycle, saveProofLifecycle } from './proof-lifecycle';
import { RECOVERY_SCHEMA, recognizedRecoveryPolicies, type RecoveryPoint } from './recovery';

export const PROOF_RECOVERY_SCHEMA = 'ejm-chess-proof-recovery-v1';
export interface ProofAdmissionReceipt {
  game_id: string; rules_version: typeof PROOF_RULES_VERSION; profile_version: typeof PROOF_PROFILE;
  credits: 2; period: number; created_at: number;
}
export interface ProofAttemptCharge {
  [key: string]: SqlStorageValue;
  id: string; game_id: string; attempt: 1 | 2; digest: string; created_at: number; native_generation: number | null;
}
export interface ProofCreditLedger {
  schema: typeof PROOF_RECOVERY_SCHEMA;
  profile: typeof PROOF_PROFILE;
  capturedAt: number;
  admissions: ProofAdmissionReceipt[];
  months: { slot: number; period: number; used: number }[];
  attempts: ProofAttemptCharge[];
  lifecycle: ProofLifecycle;
  sha256: string;
}

function invalid(): never {
  throw new ApiError(409, 'PROOF_RECOVERY_UNVERIFIED', 'Preserve the complete proof-credit ledger and keep admission closed.');
}
function integer(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function id(value: string): boolean { return typeof value === 'string' && /^[\w-]{8,100}$/.test(value); }
function sha(value: string): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function ledgerBody(value: Omit<ProofCreditLedger, 'sha256'> | ProofCreditLedger) {
  return [value.schema, value.profile, value.capturedAt, value.admissions, value.months, value.attempts, value.lifecycle];
}

/** Private consumed-credit metadata only. No solver result, account or credential leaves the pool. */
export function proofAttemptCharges(sql: SqlStorage): ProofAttemptCharge[] {
  const attempts = sql.exec<ProofAttemptCharge>(
    'SELECT id,game_id,attempt,digest,created_at,native_generation FROM proof_attempts ORDER BY id LIMIT 2001').toArray();
  if (attempts.length > 2000) invalid();
  return attempts;
}

export async function validateProofCreditLedger(ledger: ProofCreditLedger): Promise<void> {
  if (!ledger || ledger.schema !== PROOF_RECOVERY_SCHEMA || ledger.profile !== PROOF_PROFILE
    || !integer(ledger.capturedAt) || ledger.capturedAt === 0 || !sha(ledger.sha256)
    || !Array.isArray(ledger.admissions) || ledger.admissions.length > 1000
    || !Array.isArray(ledger.attempts) || ledger.attempts.length > 2000
    || !Array.isArray(ledger.months) || ledger.months.length > 12) invalid();
  const admissions = new Set<string>();
  for (const row of ledger.admissions) {
    if (!id(row.game_id) || admissions.has(row.game_id) || row.rules_version !== PROOF_RULES_VERSION
      || row.profile_version !== PROOF_PROFILE || row.credits !== 2 || !integer(row.period)
      || !integer(row.created_at)) invalid();
    admissions.add(row.game_id);
  }
  const slots = new Set<number>();
  for (const row of ledger.months) {
    if (!integer(row.slot) || row.slot > 11 || slots.has(row.slot) || !integer(row.period)
      || row.period % 12 !== row.slot || !integer(row.used) || row.used > 1000) invalid();
    slots.add(row.slot);
  }
  const attempts = new Set<string>();
  const pairs = new Set<string>();
  for (const row of ledger.attempts) {
    const pair = `${row.game_id}:${row.attempt}`;
    if (!admissions.has(row.game_id) || ![1, 2].includes(row.attempt) || !integer(row.created_at)
      || !row.id.startsWith(`timeout:${row.game_id}:`) || !/^timeout:[\w-]{8,100}:\d+:[12]$/.test(row.id)
      || !row.id.endsWith(`:${row.attempt}`) || !sha(row.digest) || attempts.has(row.id) || pairs.has(pair)
      || (row.native_generation !== null && (!integer(row.native_generation) || row.native_generation < 1))) invalid();
    attempts.add(row.id); pairs.add(pair);
  }
  const state = ledger.lifecycle;
  const numbers = ['generation', 'reserved_at', 'deadline', 'reserved_ms', 'observed_ms', 'observed_at',
    'stop_attempts', 'stop_pending', 'start_issued', 'destroy_confirmed', 'stop_debt', 'schedule_failed', 'diagnostic_emitted'] as const;
  if (!state || !['idle', 'reserved', 'active', 'stopping'].includes(state.phase)
    || numbers.some(key => !integer(state[key])) || state.stop_attempts > 3
    || ['start_issued', 'destroy_confirmed', 'stop_debt', 'schedule_failed', 'diagnostic_emitted']
      .some(key => ![0, 1].includes(state[key as keyof ProofLifecycle] as number))
    || ledger.attempts.some(row => (row.native_generation ?? 0) > state.generation)
    || await proofHash(ledgerBody(ledger)) !== ledger.sha256) invalid();
}

/** Capture while new admission is stopped. It is not a distributed atomic snapshot. */
export async function captureProofCreditLedger(env: Pick<Env, 'DB' | 'NEW_WORK_STOPPED'>,
  pool: { attempts: ProofAttemptCharge[]; lifecycle: ProofLifecycle }): Promise<ProofCreditLedger> {
  if (env.NEW_WORK_STOPPED !== 'true') invalid();
  const [admissions, months] = await Promise.all([
    env.DB.prepare('SELECT game_id,rules_version,profile_version,credits,period,created_at FROM timeout_proof_admissions ORDER BY game_id LIMIT 1001').all<ProofAdmissionReceipt>(),
    env.DB.prepare('SELECT slot,period,used FROM timeout_proof_months ORDER BY slot LIMIT 13').all<ProofCreditLedger['months'][number]>(),
  ]);
  const body: Omit<ProofCreditLedger, 'sha256'> = { schema: PROOF_RECOVERY_SCHEMA, profile: PROOF_PROFILE, capturedAt: Date.now(),
    admissions: admissions.results, months: months.results, attempts: pool.attempts, lifecycle: pool.lifecycle };
  const ledger: ProofCreditLedger = { ...body, sha256: await proofHash(ledgerBody(body)) };
  await validateProofCreditLedger(ledger);
  return ledger;
}

/**
 * Use only after an approved restore, with the pre-restore ledger saved outside
 * every rollback target. The atomic batch restores the union and each monthly
 * high-water mark. It never refunds a receipt or substitutes a native result.
 */
export async function reapplyProofAdmissions(env: Pick<Env, 'DB' | 'NEW_WORK_STOPPED'>,
  ledger: ProofCreditLedger): Promise<void> {
  if (env.NEW_WORK_STOPPED !== 'true') invalid();
  await validateProofCreditLedger(ledger);
  const rows = JSON.stringify(ledger.admissions);
  const current = await env.DB.prepare(`SELECT COUNT(*) AS count FROM timeout_proof_admissions a
    WHERE NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.game_id')=a.game_id)`)
    .bind(rows).first<number>('count');
  if (current === null || current + ledger.admissions.length > 1000) invalid();
  // A conflicting restored identity cannot be overwritten by a later ledger.
  const conflict = await env.DB.prepare(`SELECT 1 FROM timeout_proof_admissions a JOIN json_each(?) j
    ON a.game_id=json_extract(j.value,'$.game_id') WHERE a.rules_version<>json_extract(j.value,'$.rules_version')
    OR a.profile_version<>json_extract(j.value,'$.profile_version') OR a.credits<>2
    OR a.period<>json_extract(j.value,'$.period') OR a.created_at<>json_extract(j.value,'$.created_at') LIMIT 1`).bind(rows).first();
  if (conflict) invalid();
  const batch: D1PreparedStatement[] = [];
  for (const month of ledger.months) {
    batch.push(env.DB.prepare(`INSERT INTO timeout_proof_months(slot,period,used) VALUES(?,?,0)
      ON CONFLICT(slot) DO UPDATE SET period=excluded.period,used=0 WHERE timeout_proof_months.period<excluded.period`).bind(month.slot, month.period));
    // The insertion trigger charges missing rows. Precompute its base inside
    // this transaction so replay cannot double-charge a preserved high-water.
    batch.push(env.DB.prepare(`UPDATE timeout_proof_months SET used=MAX(used,?,
      (SELECT COUNT(*) FROM timeout_proof_admissions WHERE period=?)+
      (SELECT COUNT(*) FROM json_each(?) j WHERE json_extract(j.value,'$.period')=?
        AND NOT EXISTS(SELECT 1 FROM timeout_proof_admissions a WHERE a.game_id=json_extract(j.value,'$.game_id'))))-
      (SELECT COUNT(*) FROM json_each(?) j WHERE json_extract(j.value,'$.period')=?
        AND NOT EXISTS(SELECT 1 FROM timeout_proof_admissions a WHERE a.game_id=json_extract(j.value,'$.game_id')))
      WHERE slot=? AND period=?`).bind(month.used, month.period, rows, month.period, rows, month.period, month.slot, month.period));
  }
  batch.push(env.DB.prepare(`INSERT OR IGNORE INTO timeout_proof_admissions(game_id,rules_version,profile_version,credits,period,created_at)
    SELECT json_extract(value,'$.game_id'),json_extract(value,'$.rules_version'),json_extract(value,'$.profile_version'),
      2,json_extract(value,'$.period'),json_extract(value,'$.created_at') FROM json_each(?)`).bind(rows));
  await env.DB.batch(batch);
  const restored = await env.DB.prepare(`SELECT COUNT(*) AS count FROM json_each(?) j JOIN timeout_proof_admissions a
    ON a.game_id=json_extract(j.value,'$.game_id')`).bind(rows).first<number>('count');
  if (restored !== ledger.admissions.length) invalid();
}

/** Must run under the pool's concurrency barrier after native stop reconciliation. */
export function reapplyProofAttempts(sql: SqlStorage, ledger: ProofCreditLedger): void {
  const current = proofLifecycle(sql);
  if (current.phase !== 'idle' || current.stop_debt || current.stop_pending) invalid();
  const existing = proofAttemptCharges(sql);
  const saved = new Map(existing.map(row => [row.id, row]));
  if (new Set([...existing, ...ledger.attempts].map(row => row.id)).size > 2000) invalid();
  for (const row of ledger.attempts) {
    const prior = saved.get(row.id);
    if (prior && ['game_id', 'attempt', 'digest', 'created_at', 'native_generation']
      .some(key => prior[key as keyof ProofAttemptCharge] !== row[key as keyof ProofAttemptCharge])) invalid();
    if (!prior && existing.some(item => item.game_id === row.game_id && item.attempt === row.attempt)) invalid();
    sql.exec(`INSERT OR IGNORE INTO proof_attempts(id,game_id,attempt,digest,result,created_at,native_generation)
      VALUES(?,?,?,?,NULL,?,?)`, row.id, row.game_id, row.attempt, row.digest, row.created_at, row.native_generation);
  }
  const old = ledger.lifecycle;
  // A restored call whose native settlement was uncertain stays closed even
  // after an independent cleanup confirms that the physical instance is off.
  const debt = current.stop_pending > 0 || old.stop_pending > 0 || old.stop_debt > 0;
  saveProofLifecycle(sql, { ...current, generation: Math.max(current.generation, old.generation),
    reserved_ms: Math.max(current.reserved_ms, old.reserved_ms), observed_ms: Math.max(current.observed_ms, old.observed_ms),
    stop_pending: Math.max(current.stop_pending, old.stop_pending),
    stop_attempts: Math.max(current.stop_attempts, old.stop_attempts),
    start_issued: Math.max(current.start_issued, old.start_issued),
    destroy_confirmed: debt ? 0 : current.destroy_confirmed,
    stop_debt: debt ? 1 : 0, phase: debt ? 'stopping' : 'idle',
    schedule_failed: Math.max(current.schedule_failed, old.schedule_failed),
    diagnostic_emitted: Math.max(current.diagnostic_emitted, old.diagnostic_emitted),
    deadline: Math.min(current.deadline || old.deadline, old.deadline || current.deadline) });
}

export interface RankedRecoveryManifest {
  schema: 'ejm-chess-four-authority-recovery-v1';
  databaseId: string;
  d1Bookmark: string;
  credits: ProofCreditLedger;
  competition: RecoveryPoint;
  prover: RecoveryPoint;
  games: RecoveryPoint[];
}

/** Verify all four authorities before a caller may prepare any native restore. */
export async function validateRankedRecoveryManifest(manifest: RankedRecoveryManifest): Promise<void> {
  if (!manifest || manifest.schema !== 'ejm-chess-four-authority-recovery-v1'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.databaseId)
    || typeof manifest.d1Bookmark !== 'string' || !manifest.d1Bookmark || manifest.d1Bookmark.length > 256
    || !Array.isArray(manifest.games) || manifest.games.length > 1000) invalid();
  await validateProofCreditLedger(manifest.credits);
  const points = [manifest.competition, manifest.prover, ...manifest.games];
  if (manifest.competition?.kind !== 'Competition' || manifest.competition.name !== 'global'
    || manifest.prover?.kind !== 'TimeoutProver' || manifest.prover.name !== 'timeout-proof-v1-singleton'
    || new Set(points.map(point => point?.objectId)).size !== points.length) invalid();
  const games = new Set(manifest.games.map(point => point.name));
  if (games.size !== manifest.games.length || manifest.credits.admissions.some(row => !games.has(row.game_id))) invalid();
  for (const point of points) {
    if (!point || point.schema !== RECOVERY_SCHEMA || !/^[a-f0-9]{64}$/.test(point.objectId)
      || typeof point.bookmark !== 'string' || !point.bookmark || point.bookmark.length > 256
      || !recognizedRecoveryPolicies(point.policies) || !sha(point.authority?.sha256)
      || !integer(point.capturedAt) || point.capturedAt > manifest.credits.capturedAt) invalid();
  }
  if (manifest.games.some(point => point.kind !== 'Game')) invalid();
}
