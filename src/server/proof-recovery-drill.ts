/** Private saved-backup controls. The public product entry never imports this file. */
import { fingerprintAuthority, captureNativePoint, RECOVERY_SCHEMA, type RecoveryPoint } from './recovery';
import { PROOF_PROFILE, PROOF_RULES_VERSION, PROOF_INSTANCE, proofHash } from './proof-contract';
import { RATING_VERSION } from '../shared/protocol';
import { captureProofCreditLedger, reapplyProofAdmissions, reapplyProofAttempts, validateProofCreditLedger,
  validateRankedRecoveryManifest, proofAttemptCharges, type ProofCreditLedger } from './proof-recovery';
import { proofLifecycle } from './proof-lifecycle';
import { proofRecoveryBudgetPlan, type AcceptanceRecoveryBudget, type ProofAcceptanceBudget,
  type AcceptanceAuthority } from './proof-acceptance-budget';
import type { AcceptanceAdapterEnv } from './proof-acceptance-adapters';
import { CapacityNativeMeter, type CapacityNativeUsage } from './capacity-meter';

export const PROOF_RESTORE_SCHEMA = 'ejm-chess-private-proof-restore-v1';
const maximumGames = 12;
const maximumActions = 96;
const maximumJournalBytes = 1_048_576;
export const PROOF_RESTORE_WORK = Object.freeze({ actions: maximumActions, doRowsRead: 16_384,
  doRowsWritten: 2048, d1RowsRead: 4096, d1RowsWritten: 0, doStorageBytes: 4_194_304, d1StorageBytes: 16_777_216 });
export type ProofRestoreRole = 'Game' | 'Competition' | 'TimeoutProver';
export interface ProofRestorePoint {
  point: RecoveryPoint;
  product: RecoveryPoint['authority'];
  budget: AcceptanceRecoveryBudget;
  nativeRunning: boolean;
  credits?: ProofCreditLedger;
  unresolvedResults?: number;
}
export interface ProofRestoreD1 { capturedAt: number; authority: RecoveryPoint['authority'] }
export interface ProofRestoreBoundary {
  schema: typeof PROOF_RESTORE_SCHEMA;
  sourceDigest: string;
  proverNamespaceId: string;
  databaseId: string;
  d1Bookmark: string;
  d1: ProofRestoreD1;
  credits: ProofCreditLedger;
  competition: ProofRestorePoint;
  prover: ProofRestorePoint;
  games: ProofRestorePoint[];
}
export interface ProofRestoreReview {
  schema: typeof PROOF_RESTORE_SCHEMA;
  baseline: ProofRestoreBoundary;
  preserved: ProofRestoreBoundary;
  sha256: string;
}
export interface ProofRestoreReceipt {
  reviewSha256: string;
  kind: ProofRestoreRole;
  name: string;
  objectId: string;
  restoreBookmark: string;
  undoBookmark: string;
  currentAuthority: RecoveryPoint['authority'];
  currentAlarm: number | null;
}
export interface ProofRestoreControl {
  recoveryRecord(input: { operation: 'read' } | { operation: 'approve'; review: ProofRestoreReview }
    | { operation: 'claim'; key: string; reviewSha256?: string }
    | { operation: 'finish'; key: string; ordinal: number; usage: CapacityNativeUsage }
    | { operation: 'receipt'; receipt: ProofRestoreReceipt }): Promise<unknown>;
}

function fail(reason: string): never { throw new Error('proof_restore_' + reason); }
function control(env: AcceptanceAdapterEnv): ProofRestoreControl {
  return env.PROOF_ACCEPTANCE.get(env.PROOF_ACCEPTANCE.idFromName('fixed-proof-acceptance-v1')) as unknown as ProofRestoreControl;
}
function points(boundary: ProofRestoreBoundary): ProofRestorePoint[] { return [boundary.competition, boundary.prover, ...boundary.games]; }
function target(boundary: ProofRestoreBoundary, role: ProofRestoreRole, name: string): ProofRestorePoint {
  const value = points(boundary).find(item => item.point.kind === role && item.point.name === name);
  if (!value) fail('target_missing');
  return value;
}

/** Hash only bounded synthetic accepted state. Proof credits have their own ledger. */
export async function captureProofRestoreD1(db: D1Database): Promise<ProofRestoreD1> {
  const schema = (await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND substr(name,1,4)<>'_cf_' AND substr(tbl_name,1,4)<>'_cf_'
      AND tbl_name NOT IN ('timeout_proof_admissions','timeout_proof_months') ORDER BY type,name LIMIT 513`).all<{
    type: string; name: string; tbl_name: string; sql: string;
  }>()).results;
  const tables = schema.filter(row => row.type === 'table').sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (schema.length > 512 || tables.length > 128) fail('d1_capture_limit');
  let rows = 0, bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  const digests = [];
  for (const table of tables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name)) fail('d1_schema_unknown');
    const result = await db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid LIMIT ?`).bind(1025 - rows).all();
    rows += result.results.length;
    const text = JSON.stringify(result.results);
    bytes += new TextEncoder().encode(text).byteLength;
    if (rows > 1024 || bytes > maximumJournalBytes) fail('d1_capture_limit');
    digests.push({ table: table.name, schema: table.sql, digest: await proofHash([text]) });
  }
  return { capturedAt: Date.now(), authority: { sha256: await proofHash([schema, digests]), rows, bytes } };
}

/**
 * Narrow capture adapter: private acceptance journals are not accepted chess
 * state. The sealed recovery.ts owner cannot change during the capacity run.
 * Remove this projection when fingerprintAuthority has a public table filter.
 * Its hashing, limits, types and row handling remain the existing helper's.
 */
export function productRecoveryStorage(storage: DurableObjectStorage): DurableObjectStorage {
  return new Proxy(storage, { get(target, key) {
    if (key !== 'sql') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
    return new Proxy(target.sql, { get(sql, member) {
      if (member !== 'exec') { const value = Reflect.get(sql, member, sql); return typeof value === 'function' ? value.bind(sql) : value; }
      return (query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = sql.exec(query, ...bindings);
        if (!/^SELECT type,name,tbl_name,sql FROM sqlite_master\b/.test(query)) return cursor;
        return new Proxy(cursor, { get(result, property) {
          if (property === 'toArray') return () => result.toArray().filter(row =>
            typeof row.tbl_name === 'string' && !row.tbl_name.startsWith('proof_acceptance_') && row.tbl_name !== 'recovery_drill_probe');
          const value = Reflect.get(result, property, result); return typeof value === 'function' ? value.bind(result) : value;
        } });
      };
    } });
  } });
}

/** Fixed synthetic corpus IDs have no product Game authority. Never allocate one. */
async function validateBoundary(boundary: ProofRestoreBoundary): Promise<void> {
  if (!boundary || boundary.schema !== PROOF_RESTORE_SCHEMA || !Array.isArray(boundary.games)
    || boundary.games.length > maximumGames || !/^[a-f0-9]{64}$/.test(boundary.sourceDigest)
    || !/^[a-f0-9]{32}$/.test(boundary.proverNamespaceId)) fail('boundary_invalid');
  await validateProofCreditLedger(boundary.credits);
  if (boundary.credits.admissions.length > 39 || boundary.credits.attempts.length > 78 || boundary.credits.months.length > 1
    || !boundary.d1 || !Number.isSafeInteger(boundary.d1.capturedAt) || boundary.d1.capturedAt < 1
    || boundary.d1.capturedAt > boundary.credits.capturedAt || !/^[a-f0-9]{64}$/.test(boundary.d1.authority.sha256)) fail('boundary_invalid');
  const gameNames = new Set(boundary.games.map(item => item.point.name));
  const corpus = (id: string) => /^proof-acceptance-corpus-C(?:0[0-9]|1[0-9]|2[0-6])$/.test(id);
  if (boundary.credits.admissions.some(row => !corpus(row.game_id) && !gameNames.has(row.game_id))) fail('game_missing');
  const credits = { ...boundary.credits,
    admissions: boundary.credits.admissions.filter(row => !corpus(row.game_id)),
    attempts: boundary.credits.attempts.filter(row => !corpus(row.game_id)) };
  credits.sha256 = await proofHash([credits.schema, credits.profile, credits.capturedAt,
    credits.admissions, credits.months, credits.attempts, credits.lifecycle]);
  await validateRankedRecoveryManifest({ schema: 'ejm-chess-four-authority-recovery-v1',
    databaseId: boundary.databaseId, d1Bookmark: boundary.d1Bookmark, credits,
    competition: boundary.competition.point, prover: boundary.prover.point, games: boundary.games.map(item => item.point) });
  for (const item of points(boundary)) {
    if (item.nativeRunning || item.point.schema !== RECOVERY_SCHEMA || !/^[a-f0-9]{64}$/.test(item.product.sha256)
      || !Number.isSafeInteger(item.budget.events) || item.budget.events < 1
      || item.budget.entries.length !== item.budget.events) fail('boundary_unverified');
  }
}

export async function validateProofRestoreReview(review: ProofRestoreReview): Promise<void> {
  if (!review || review.schema !== PROOF_RESTORE_SCHEMA) fail('review_invalid');
  await validateBoundary(review.baseline); await validateBoundary(review.preserved);
  if (review.baseline.databaseId !== review.preserved.databaseId
    || review.baseline.sourceDigest !== review.preserved.sourceDigest
    || review.baseline.proverNamespaceId !== review.preserved.proverNamespaceId
    || review.baseline.d1.authority.sha256 !== review.preserved.d1.authority.sha256
    || review.baseline.credits.capturedAt > review.preserved.credits.capturedAt
    || review.sha256 !== await proofHash([review.schema, review.baseline, review.preserved])) fail('review_conflict');
  for (const old of points(review.baseline)) {
    const later = target(review.preserved, old.point.kind as ProofRestoreRole, old.point.name);
    if (old.point.objectId !== later.point.objectId || old.budget.kind !== later.budget.kind
      || old.point.capturedAt > later.point.capturedAt || old.budget.events > later.budget.events
      || old.point.kind !== 'TimeoutProver' && old.product.sha256 !== later.product.sha256) fail('later_chess_work');
    proofRecoveryBudgetPlan(old.budget, later.budget);
  }
  const baseline = review.baseline.prover.credits;
  if (!baseline) fail('baseline_not_quiescent');
  await validateProofCreditLedger(baseline);
  if (points(review.baseline).length !== points(review.preserved).length
    || baseline.lifecycle.phase !== 'idle' || baseline.lifecycle.stop_debt || baseline.lifecycle.stop_pending
    || review.baseline.prover.unresolvedResults !== 0
    || review.baseline.prover.point.metadata.proofLifecycle?.stopDebt
    || review.baseline.prover.point.metadata.proofLifecycle?.pendingStops
    || review.baseline.prover.point.alarm !== null
    || review.baseline.prover.point.metadata.proofLifecycle?.attempts !== baseline.attempts.length
    || review.baseline.prover.point.metadata.proofLifecycle?.generation !== baseline.lifecycle.generation) fail('baseline_not_quiescent');
}

/** Control is never restored with D1/Game/Competition/Prover. No reset operation. */
export async function proofRestoreRecord(sql: SqlStorage, input: Parameters<ProofRestoreControl['recoveryRecord']>[0]) {
  sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_recovery(id INTEGER PRIMARY KEY CHECK(id=1),review TEXT,
    actions TEXT NOT NULL,receipts TEXT NOT NULL,usage TEXT NOT NULL,failed INTEGER NOT NULL DEFAULT 0)`);
  sql.exec("INSERT OR IGNORE INTO proof_acceptance_recovery(id,actions,receipts,usage) VALUES(1,'{}','{}','{}')");
  const row = sql.exec<{ review: string | null; actions: string; receipts: string; usage: string; failed: number }>(
    'SELECT review,actions,receipts,usage,failed FROM proof_acceptance_recovery WHERE id=1').one();
  const actions = JSON.parse(row.actions) as Record<string, number>;
  const receipts = JSON.parse(row.receipts) as Record<string, ProofRestoreReceipt>;
  const usage = JSON.parse(row.usage) as Record<string, CapacityNativeUsage>;
  const save = (column: 'review' | 'actions' | 'receipts' | 'usage', value: string) => {
    if (value.length + Object.entries(row).reduce((sum, [key, item]) => sum + (key !== column && typeof item === 'string' ? item.length : 0), 0)
      > maximumJournalBytes) fail('journal_limit');
    sql.exec(`UPDATE proof_acceptance_recovery SET ${column}=? WHERE id=1`, value);
  };
  if (input.operation === 'read') return { review: row.review ? JSON.parse(row.review) as ProofRestoreReview : null,
    actions, receipts, usage, failed: Boolean(row.failed) };
  if (input.operation === 'approve') {
    await validateProofRestoreReview(input.review);
    const value = JSON.stringify(input.review);
    if (value.length > maximumJournalBytes || row.review !== null && row.review !== value) fail('review_locked');
    save('review', value);
    return { reviewSha256: input.review.sha256 };
  }
  const approved = row.review ? JSON.parse(row.review) as ProofRestoreReview : null;
  if (input.operation === 'claim') {
    if (!/^(?:capture|prepare|restart|reapply|verify):(Game|Competition|TimeoutProver):[\w-]{1,100}$/.test(input.key)
      || Object.values(actions).reduce((sum, used) => sum + used, 0) >= maximumActions
      || row.failed && !input.key.startsWith('verify:')
      || (actions[input.key] ?? 0) >= 2 || !input.key.startsWith('capture:') && (!approved || input.reviewSha256 !== approved.sha256)) fail('action_denied');
    actions[input.key] = (actions[input.key] ?? 0) + 1;
    save('actions', JSON.stringify(actions));
    return { key: input.key, ordinal: actions[input.key] };
  }
  if (input.operation === 'finish') {
    const key = `${input.key}:${input.ordinal}`;
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > (actions[input.key] ?? 0)
      || JSON.stringify(Object.keys(input.usage).sort()) !== JSON.stringify(Object.keys(new CapacityNativeMeter().snapshot()).sort())
      || Object.entries(input.usage).some(([name, value]) => name === 'uncertain'
        ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || Number(value) < 0)) fail('usage_invalid');
    if (usage[key] && JSON.stringify(usage[key]) !== JSON.stringify(input.usage)) fail('usage_conflict');
    usage[key] = input.usage;
    save('usage', JSON.stringify(usage));
    const failed = input.usage.uncertain || input.usage.unresolvedD1 > 0
      || Object.entries(PROOF_RESTORE_WORK).some(([name, limit]) => name !== 'actions'
        && Number(input.usage[name as keyof CapacityNativeUsage]) > limit);
    if (failed) sql.exec('UPDATE proof_acceptance_recovery SET failed=1 WHERE id=1');
    return { key, failed: Boolean(row.failed || failed) };
  }
  const receipt = input.receipt;
  if (!approved || receipt.reviewSha256 !== approved.sha256) fail('receipt_unapproved');
  const point = target(approved.baseline, receipt.kind, receipt.name);
  if (point.point.objectId !== receipt.objectId || point.point.bookmark !== receipt.restoreBookmark
    || typeof receipt.undoBookmark !== 'string' || !receipt.undoBookmark || receipt.undoBookmark.length > 256) fail('receipt_invalid');
  const prior = receipts[receipt.objectId];
  if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) fail('receipt_conflict');
  receipts[receipt.objectId] = receipt;
  save('receipts', JSON.stringify(receipts));
  return receipt;
}

export async function captureProofRestorePoint(ctx: DurableObjectState, env: AcceptanceAdapterEnv,
  budget: ProofAcceptanceBudget, kind: ProofRestoreRole, name: string, nativeRunning: boolean): Promise<ProofRestorePoint> {
  const savedBudget = await budget.recoveryBudget(ctx.storage.sql);
  const point = await captureNativePoint(ctx, { kind, name, policies: { rules: PROOF_RULES_VERSION, ratings: RATING_VERSION } }, () => {
    if (kind !== 'TimeoutProver') return {};
    const state = proofLifecycle(ctx.storage.sql);
    return { proofLifecycle: { profileVersion: PROOF_PROFILE, generation: state.generation,
      attempts: proofAttemptCharges(ctx.storage.sql).length, stopDebt: Boolean(state.stop_debt), pendingStops: state.stop_pending } };
  });
  return { point, product: await fingerprintAuthority(productRecoveryStorage(ctx.storage)), budget: savedBudget, nativeRunning,
    ...(kind === 'TimeoutProver' ? { credits: await captureProofRestoreCredits(env, {
      attempts: proofAttemptCharges(ctx.storage.sql), lifecycle: proofLifecycle(ctx.storage.sql) }),
      unresolvedResults: ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM proof_attempts WHERE result IS NULL').one().count } : {}) };
}

/** Catch within the native barrier so a rejected review does not reset the object. */
async function barrier<T>(ctx: DurableObjectState, run: () => Promise<T>): Promise<T> {
  const result = await ctx.blockConcurrencyWhile(async () => {
    try { return { value: await run() }; } catch (error) { return { error }; }
  });
  if ('error' in result) throw result.error;
  return result.value;
}

export async function prepareProofRestore(ctx: DurableObjectState, env: AcceptanceAdapterEnv,
  kind: ProofRestoreRole, name: string, review: ProofRestoreReview): Promise<ProofRestoreReceipt> {
  await validateProofRestoreReview(review);
  const baseline = target(review.baseline, kind, name), later = target(review.preserved, kind, name);
  if (ctx.id.toString() !== baseline.point.objectId) fail('target_mismatch');
  return barrier(ctx, async () => {
    await ctx.storage.sync();
    const current = await fingerprintAuthority(ctx.storage);
    const alarm = await ctx.storage.getAlarm();
    if (current.sha256 !== later.point.authority.sha256 || alarm !== later.point.alarm) fail('later_work');
    const undoBookmark = await ctx.storage.onNextSessionRestoreBookmark(baseline.point.bookmark);
    const receipt = { reviewSha256: review.sha256, kind, name, objectId: ctx.id.toString(),
      restoreBookmark: baseline.point.bookmark, undoBookmark, currentAuthority: current, currentAlarm: alarm };
    try { await control(env).recoveryRecord({ operation: 'receipt', receipt }); }
    catch (error) {
      try { await ctx.storage.onNextSessionRestoreBookmark(undoBookmark); }
      catch { fail('cancellation_uncertain_save_undo'); }
      throw error;
    }
    return receipt;
  });
}

export async function restartProofRestore(ctx: DurableObjectState, env: AcceptanceAdapterEnv,
  receipt: ProofRestoreReceipt, privateReceiptSaved: boolean): Promise<never> {
  const state = await control(env).recoveryRecord({ operation: 'read' }) as { receipts: Record<string, ProofRestoreReceipt> };
  if (!privateReceiptSaved || JSON.stringify(state.receipts[ctx.id.toString()]) !== JSON.stringify(receipt)) fail('undo_required');
  const changed = await barrier(ctx, async () => (await fingerprintAuthority(ctx.storage)).sha256 !== receipt.currentAuthority.sha256
    || await ctx.storage.getAlarm() !== receipt.currentAlarm);
  if (changed) fail('later_work');
  ctx.abort('Approved isolated four-authority restore', { retryAlarm: false });
  fail('native_restart_unavailable');
}

export async function reapplyProofRestore(ctx: DurableObjectState, env: AcceptanceAdapterEnv, budget: ProofAcceptanceBudget,
  kind: ProofRestoreRole, name: string, review: ProofRestoreReview) {
  await validateProofRestoreReview(review);
  const before = target(review.baseline, kind, name), later = target(review.preserved, kind, name);
  if (ctx.id.toString() !== before.point.objectId) fail('target_mismatch');
  await barrier(ctx, async () => {
    const product = await fingerprintAuthority(productRecoveryStorage(ctx.storage));
    const present = kind === 'TimeoutProver' && proofCreditsPresent(ctx.storage.sql, review.preserved.credits);
    if (product.sha256 !== before.product.sha256 && !present) fail('native_restore_unverified');
    await budget.reapplyRecoveryBudget(before.budget, later.budget, ctx.storage.sql);
    if (kind === 'TimeoutProver' && !present) {
      ctx.storage.transactionSync(() => reapplyProofAttempts(ctx.storage.sql, review.preserved.credits));
    }
    await ctx.storage.sync();
  });
  return { budget: await budget.recoveryBudget(ctx.storage.sql), product: await fingerprintAuthority(productRecoveryStorage(ctx.storage)) };
}

function proofCreditsPresent(sql: SqlStorage, ledger: ProofCreditLedger): boolean {
  const saved = new Map(proofAttemptCharges(sql).map(row => [row.id, row]));
  const current = proofLifecycle(sql), old = ledger.lifecycle;
  return ledger.attempts.every(row => JSON.stringify(saved.get(row.id)) === JSON.stringify(row))
    && (['generation', 'reserved_ms', 'observed_ms', 'stop_pending', 'stop_attempts', 'start_issued', 'schedule_failed', 'diagnostic_emitted'] as const)
      .every(key => current[key] >= old[key])
    && (old.stop_debt || old.stop_pending ? current.phase === 'stopping' && current.stop_debt === 1
      && current.destroy_confirmed === 0 : current.phase === 'idle' && current.stop_debt === 0);
}

export async function captureProofRestoreCredits(env: AcceptanceAdapterEnv, pool: Parameters<typeof captureProofCreditLedger>[1]) {
  return captureProofCreditLedger({ DB: env.DB, NEW_WORK_STOPPED: 'true' }, pool);
}
export async function reapplyProofRestoreAdmissions(env: AcceptanceAdapterEnv, review: ProofRestoreReview) {
  await validateProofRestoreReview(review);
  if ((await captureProofRestoreD1(env.DB)).authority.sha256 !== review.baseline.d1.authority.sha256) fail('d1_accepted_state_changed');
  await reapplyProofAdmissions({ DB: env.DB, NEW_WORK_STOPPED: 'true' }, review.preserved.credits);
  const admissions = (await env.DB.prepare('SELECT game_id,rules_version,profile_version,credits,period,created_at FROM timeout_proof_admissions ORDER BY game_id LIMIT 1001').all()).results;
  const months = (await env.DB.prepare('SELECT slot,period,used FROM timeout_proof_months ORDER BY slot LIMIT 13').all()).results;
  return { accepted: await captureProofRestoreD1(env.DB), admissions, months };
}

export const proofRestoreRoles: Record<ProofRestoreRole, AcceptanceAuthority> = { Game: 'Game', Competition: 'Competition', TimeoutProver: 'Prover' };
export { PROOF_PROFILE, PROOF_INSTANCE };

export interface ProofRestoreAdapter {
  acceptanceRestoreCapture(name: string): Promise<ProofRestorePoint>;
  acceptanceRestorePrepare(name: string, review: ProofRestoreReview): Promise<ProofRestoreReceipt>;
  acceptanceRestoreRestart(receipt: ProofRestoreReceipt, privateReceiptSaved: boolean): Promise<never>;
  acceptanceRestoreReapply(name: string, review: ProofRestoreReview): Promise<unknown>;
  acceptanceRestoreVerify(name: string, review: ProofRestoreReview): Promise<unknown>;
}
type AdapterState = { ctx: DurableObjectState; env: AcceptanceAdapterEnv; budget: ProofAcceptanceBudget;
  role: ProofRestoreRole; validate: () => Promise<unknown> };
const adapters = new WeakMap<object, AdapterState>();

/** The real native state stays private and is never replaced by a test handle. */
export function initializeProofRestoreAdapter(instance: object, state: AdapterState): void { adapters.set(instance, state); }
export function installProofRestoreAdapter(prototype: object): void {
  async function state(instance: object, name: string): Promise<AdapterState> {
    const value = adapters.get(instance); if (!value) fail('adapter_missing');
    await value.validate();
    const namespace = value.role === 'Game' ? value.env.GAME : value.role === 'Competition' ? value.env.COMPETITION : value.env.PROVER!;
    const fixed = value.role === 'Competition' ? 'global' : value.role === 'TimeoutProver' ? PROOF_INSTANCE : name;
    if (!fixed || name !== fixed || !namespace.idFromName(name).equals(value.ctx.id)) fail('target_mismatch');
    return value;
  }
  async function action<T>(instance: object, name: string, operation: string, review: ProofRestoreReview | undefined,
    run: (value: AdapterState) => Promise<T>): Promise<T> {
    const original = await state(instance, name), key = `${operation}:${original.role}:${name}`;
    const permit = await control(original.env).recoveryRecord({ operation: 'claim', key, reviewSha256: review?.sha256 }) as { ordinal: number };
    const meter = new CapacityNativeMeter(), sql = meter.sql(original.ctx.storage.sql);
    const storage = new Proxy(original.ctx.storage, { get(target, member) {
      if (member === 'sql') return sql;
      if (member === 'getAlarm') return () => meter.alarm('read', () => target.getAlarm());
      const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const ctx = new Proxy(original.ctx, { get(target, member) {
      if (member === 'storage') return storage;
      const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const value = { ...original, ctx, env: { ...original.env, DB: meter.d1(original.env.DB) } };
    let failed = false;
    try {
      if (value.role === 'Game' && !await value.env.DB.prepare('SELECT 1 FROM timeout_proof_admissions WHERE game_id=?').bind(name).first()) fail('game_unadmitted');
      return await run(value);
    } catch (error) { failed = true; throw error; }
    finally {
      // Native abort intentionally loses its reply. Preserve that action's
      // whole envelope instead of labelling the expected disconnect a failure.
      if (operation !== 'restart') {
        const usage = { ...meter.snapshot(), ...(failed ? { uncertain: true } : {}) };
        const saved = await control(original.env).recoveryRecord({ operation: 'finish', key, ordinal: permit.ordinal, usage }) as { failed: boolean };
        if (saved.failed) fail('native_envelope_failed');
      }
    }
  }
  const methods: ProofRestoreAdapter = {
    async acceptanceRestoreCapture(name) {
      return action(this, name, 'capture', undefined, async value => {
        const running = value.role === 'TimeoutProver' && value.ctx.container!.running;
        if (running) fail('native_running');
        return captureProofRestorePoint(value.ctx, value.env, value.budget, value.role, name, running);
      });
    },
    async acceptanceRestorePrepare(name, review) {
      return action(this, name, 'prepare', review, async value => {
        if (value.role === 'TimeoutProver' && value.ctx.container!.running) fail('native_running');
        return prepareProofRestore(value.ctx, value.env, value.role, name, review);
      });
    },
    async acceptanceRestoreRestart(receipt, privateReceiptSaved) {
      return action(this, receipt.name, 'restart', { sha256: receipt.reviewSha256 } as ProofRestoreReview,
        value => restartProofRestore(value.ctx, value.env, receipt, privateReceiptSaved));
    },
    async acceptanceRestoreReapply(name, review) {
      return action(this, name, 'reapply', review, async value => {
        if (value.role === 'TimeoutProver' && value.ctx.container!.running) fail('native_running');
        return reapplyProofRestore(value.ctx, value.env, value.budget, value.role, name, review);
      });
    },
    async acceptanceRestoreVerify(name, review) {
      return action(this, name, 'verify', review, async value => {
        await validateProofRestoreReview(review);
        const product = await fingerprintAuthority(productRecoveryStorage(value.ctx.storage));
        if (value.role !== 'TimeoutProver' && product.sha256 !== target(review.baseline, value.role, name).product.sha256) fail('chess_state_changed');
        return { product, budget: await value.budget.recoveryBudget(value.ctx.storage.sql), nativeRunning: value.role === 'TimeoutProver' && value.ctx.container!.running,
          ...(value.role === 'TimeoutProver' ? { attempts: proofAttemptCharges(value.ctx.storage.sql), lifecycle: proofLifecycle(value.ctx.storage.sql),
            missingNativeResults: value.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM proof_attempts WHERE result IS NULL ORDER BY id LIMIT 79').toArray().map(row => row.id) } : {}) };
      });
    },
  };
  for (const [name, method] of Object.entries(methods)) Object.defineProperty(prototype, name, { value: method, configurable: true });
}
