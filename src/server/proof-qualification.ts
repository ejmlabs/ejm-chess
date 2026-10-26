/** Isolated fixed-corpus harness. This entry point is never imported by index.ts. */
import { DurableObject } from 'cloudflare:workers';
import { Chess } from 'chess.js';
import corpus from '../../proof/corpus.json';
import type { Env } from './env';
import { ApiError, errorResponse, jsonResponse, readJson } from './security';
import { reserveProofAdmission } from './proof-budget';
import { TimeoutProver } from './proof-pool';
import { PROOF_INSTANCE, PROOF_PROFILE, PROOF_RULES_VERSION, PROOF_RESULT_BYTES, parseProofResult,
  proofDigests, proofHash, transientProof, unknownProof, type TimeoutProofRequest, type TimeoutProofResult } from './proof-contract';

export const QUALIFICATION_SCHEMA = 'ejm-chess-timeout-qualification-v1';
export const QUALIFICATION_INSTANCE = 'fixed-proof-qualification-v1';
export const QUALIFICATION_RESERVATIONS = 32;
const MAX_DURATION_MS = 2 * 60 * 60 * 1_000;
const MAX_STOP_ATTEMPTS = 6;
const TIERS = ['lite', 'basic', 'standard-1', 'standard-2'];

export interface ProofQualificationEnv extends Env {
  PROOF_QUALIFICATION: DurableObjectNamespace<ProofQualification>;
  PROVER: DurableObjectNamespace<TimeoutProver>;
  PROOF_QUALIFICATION_TOKEN?: string;
  PROOF_QUALIFICATION_SCOPE: string;
  PROOF_QUALIFICATION_DATABASE_ID: string;
  PROOF_QUALIFICATION_CONTROL_NAMESPACE_ID: string;
  PROOF_QUALIFICATION_PROVER_NAMESPACE_ID: string;
  PROOF_QUALIFICATION_SOURCE_REVISION: string;
  PROOF_QUALIFICATION_EXPIRES_AT: string;
  PROOF_QUALIFICATION_TIER: string;
}

interface Fixture { name: string; initialFen: string; moves: string[]; expected: string; ordinary: boolean; reason?: string }
const fixtures = corpus.fixtures as Fixture[];
const batches = Array.from({ length: Math.ceil(fixtures.length / 4) }, (_, batch) =>
  fixtures.slice(batch * 4, batch * 4 + 4).map((fixture, offset) => ({ fixture, index: batch * 4 + offset })));
batches.push(fixtures.filter(fixture => fixture.ordinary).slice(0, 4).map((fixture, offset) => ({ fixture, index: fixtures.length + offset })));
type Command = { operation: 'inspect' } | { operation: 'stop' } | { operation: 'run'; batch: number };
type Control = { corpus: string; source: string; tier: string; expires_at: number; stopped: number; cold_reset: number; active_batch: number | null };
type Job = { id: string; fixture: string; batch: number; position: number; expected: string; ordinary: number; expected_reason: string | null; request: string; result: string | null;
  deliveries: number; status: string; started_at: number | null; finished_at: number | null; error: string | null };

// The main product namespace exposes only TimeoutProver. Only this separate
// entry point reaches the two qualification RPC methods on its isolated class.
function qualificationProver(env: ProofQualificationEnv): DurableObjectStub<QualificationTimeoutProver> {
  return env.PROVER.get(env.PROVER.idFromName(PROOF_INSTANCE)) as unknown as DurableObjectStub<QualificationTimeoutProver>;
}

export function initializeQualification(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS qualification_control
    (id INTEGER PRIMARY KEY CHECK(id=1),corpus TEXT NOT NULL,source TEXT NOT NULL,tier TEXT NOT NULL,
     expires_at INTEGER NOT NULL,stopped INTEGER NOT NULL DEFAULT 0,cold_reset INTEGER NOT NULL DEFAULT 0,active_batch INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS qualification_jobs
    (id TEXT PRIMARY KEY,fixture TEXT NOT NULL,batch INTEGER NOT NULL,position INTEGER NOT NULL UNIQUE,
     expected TEXT NOT NULL,ordinary INTEGER NOT NULL,expected_reason TEXT,request TEXT NOT NULL,
     result TEXT,deliveries INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',started_at INTEGER,finished_at INTEGER,error TEXT)`);
  sql.exec('CREATE TABLE IF NOT EXISTS qualification_commands(id INTEGER PRIMARY KEY CHECK(id=1),used INTEGER NOT NULL)');
  sql.exec('INSERT OR IGNORE INTO qualification_commands(id,used) VALUES(1,0)');
  sql.exec('CREATE TABLE IF NOT EXISTS qualification_stop(id INTEGER PRIMARY KEY CHECK(id=1),completed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0)');
}

export function parseQualificationCommand(value: unknown): Command | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if ((item.operation === 'inspect' || item.operation === 'stop') && Object.keys(item).length === 1) return item as Command;
  return item.operation === 'run' && Object.keys(item).length === 2 && Number.isInteger(item.batch)
    && Number(item.batch) >= 0 && Number(item.batch) < batches.length ? item as Command : null;
}

export function assertProofQualification(env: ProofQualificationEnv, now = Date.now()): number {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const namespace = /^[0-9a-f]{32}$/;
  const expiry = Number(env.PROOF_QUALIFICATION_EXPIRES_AT);
  if (!/^ejm-chess-proof-qualification-[a-z0-9-]{1,40}$/.test(env.PROOF_QUALIFICATION_SCOPE ?? '')
    || !uuid.test(env.PROOF_QUALIFICATION_DATABASE_ID ?? '')
    || ['00000000-0000-0000-0000-000000000000', 'ebba66c8-3910-4465-a053-426fcb733833', 'd149c96d-186a-4bcd-94b7-702dd956b7d9'].includes(env.PROOF_QUALIFICATION_DATABASE_ID)
    || !namespace.test(env.PROOF_QUALIFICATION_CONTROL_NAMESPACE_ID ?? '') || !namespace.test(env.PROOF_QUALIFICATION_PROVER_NAMESPACE_ID ?? '')
    || env.PROOF_QUALIFICATION_CONTROL_NAMESPACE_ID === env.PROOF_QUALIFICATION_PROVER_NAMESPACE_ID
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(env.PROOF_QUALIFICATION_SOURCE_REVISION ?? '')
    || !TIERS.includes(env.PROOF_QUALIFICATION_TIER) || !Number.isSafeInteger(expiry) || expiry <= now || expiry > now + MAX_DURATION_MS
    || env.TIMEOUT_PROOF_PROFILE !== 'off' || env.MONTHLY_PROOF_LIMIT !== '0' || env.NEW_WORK_STOPPED !== 'true'
    || env.RANKED_ENABLED !== 'false' || env.TOURNAMENTS_ENABLED !== 'false' || env.ARENAS_ENABLED !== 'false'
    || env.ANALYSIS_ENABLED !== 'false' || env.AI_ENABLED !== 'false' || env.GAME || env.COMPETITION || env.ASSETS
    || env.EMAIL || env.ANALYZER || env.ANALYSIS_QUEUE || env.ANALYSIS_DEAD_LETTER_QUEUE
    || !env.PROVER || !env.PROOF_QUALIFICATION || fixtures.length + 4 > QUALIFICATION_RESERVATIONS) {
    throw new ApiError(409, 'PROOF_QUALIFICATION_UNARMED', 'Review isolated resources, fixed source, expiry and measured tier before running qualification.');
  }
  return expiry;
}

/** Only this isolated subclass exposes a destructive qualification stop. */
export class QualificationTimeoutProver extends TimeoutProver {
  private qualificationCancellation = new AbortController();
  constructor(ctx: DurableObjectState<{}>, env: ProofQualificationEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS qualification_stop(id INTEGER PRIMARY KEY CHECK(id=1))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS qualification_cold(id INTEGER PRIMARY KEY CHECK(id=1))');
  }
  override async fetch(request: Request): Promise<Response> {
    if (this.ctx.storage.sql.exec('SELECT 1 FROM qualification_stop').toArray().length) return new Response('Qualification stopped', { status: 410 });
    return super.fetch(request);
  }
  protected override async native(request: TimeoutProofRequest, signal: AbortSignal): Promise<TimeoutProofResult> {
    if (this.ctx.storage.sql.exec('SELECT 1 FROM qualification_stop').toArray().length) {
      return unknownProof(request, 'interrupted');
    }
    return super.native(request, AbortSignal.any([signal, this.qualificationCancellation.signal]));
  }
  async stopQualification(): Promise<void> {
    this.qualificationCancellation.abort();
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO qualification_stop(id) VALUES(1)');
    await this.ctx.storage.sync();
    await this.stop('SIGKILL');
  }
  async coldQualification(): Promise<void> {
    if (this.ctx.storage.sql.exec('SELECT 1 FROM qualification_stop').toArray().length) throw new Error('qualification_stopped');
    if (this.ctx.storage.sql.exec('SELECT 1 FROM qualification_cold').toArray().length) return;
    await this.stop('SIGKILL');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO qualification_cold(id) VALUES(1)');
    await this.ctx.storage.sync();
  }
}

/** The one durable controller preserves quota and expiry across reset/redeploy. */
export class ProofQualification extends DurableObject<ProofQualificationEnv> {
  private running: ReturnType<ProofQualification['inspect']> | null = null;
  constructor(ctx: DurableObjectState, env: ProofQualificationEnv) {
    super(ctx, env);
    initializeQualification(ctx.storage.sql);
    const control = this.control();
    const stop = ctx.storage.sql.exec<{ completed: number; attempts: number }>('SELECT completed,attempts FROM qualification_stop').toArray()[0];
    if (stop && !stop.completed && stop.attempts < MAX_STOP_ATTEMPTS) ctx.blockConcurrencyWhile(() => ctx.storage.setAlarm(Date.now() + 1));
    else if (control && !control.stopped && !stop) ctx.blockConcurrencyWhile(() => ctx.storage.setAlarm(Math.max(Date.now() + 1, control.expires_at)));
  }
  private control(): Control | null {
    return this.ctx.storage.sql.exec<Control>('SELECT * FROM qualification_control WHERE id=1').toArray()[0] ?? null;
  }
  private job(id: string): Job {
    return this.ctx.storage.sql.exec<Job>('SELECT * FROM qualification_jobs WHERE id=?', id).one();
  }
  private stopped(): boolean {
    return Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM qualification_stop').toArray().length || this.control()?.stopped);
  }
  private takeCommand(): void {
    if (!this.ctx.storage.sql.exec('UPDATE qualification_commands SET used=used+1 WHERE id=1 AND used<128 RETURNING used').toArray().length) {
      throw new ApiError(429, 'PROOF_QUALIFICATION_QUOTA', 'The fixed command allowance is exhausted. Stop remains available.');
    }
  }
  private async stop(fromAlarm = false): Promise<void> {
    if (this.ctx.storage.sql.exec<{ completed: number }>('SELECT completed FROM qualification_stop').toArray()[0]?.completed) return;
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO qualification_stop(id) VALUES(1)');
    this.ctx.storage.sql.exec('UPDATE qualification_control SET stopped=1 WHERE id=1');
    const attempts = this.ctx.storage.sql.exec<{ attempts: number }>('SELECT attempts FROM qualification_stop').one().attempts;
    if (fromAlarm && attempts >= MAX_STOP_ATTEMPTS) { await this.ctx.storage.deleteAlarm(); return; }
    this.ctx.storage.sql.exec('UPDATE qualification_stop SET attempts=attempts+1 WHERE id=1');
    // Bound outage work as well as native work. A private explicit stop can
    // reconcile again after the six automatic attempts have been consumed.
    if (attempts + 1 < MAX_STOP_ATTEMPTS) await this.ctx.storage.setAlarm(Date.now() + 1_000 * 2 ** attempts);
    else await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.sync();
    await qualificationProver(this.env).stopQualification();
    this.ctx.storage.sql.exec('UPDATE qualification_stop SET completed=1 WHERE id=1');
    await this.ctx.storage.sync();
    await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    const control = this.control();
    const stop = this.ctx.storage.sql.exec<{ completed: number }>('SELECT completed FROM qualification_stop').toArray()[0];
    if ((stop && !stop.completed) || (control && !control.stopped && Date.now() >= control.expires_at)) await this.stop(true);
  }
  private async inspect() {
    const corpusDigest = await proofHash([corpus]);
    const control = this.control();
    let configurationMatches = false;
    try {
      configurationMatches = Boolean(control && assertProofQualification(this.env) === control.expires_at
        && control.source === this.env.PROOF_QUALIFICATION_SOURCE_REVISION
        && control.tier === this.env.PROOF_QUALIFICATION_TIER && control.corpus === corpusDigest);
    } catch { /* Inspection and stop remain available after configuration changes. */ }
    const stop = this.ctx.storage.sql.exec<{ completed: number; attempts: number }>('SELECT completed,attempts FROM qualification_stop').toArray()[0];
    const jobs = this.ctx.storage.sql.exec<Job>('SELECT * FROM qualification_jobs ORDER BY position LIMIT 32').toArray();
    return { schema: QUALIFICATION_SCHEMA, scope: this.env.PROOF_QUALIFICATION_SCOPE,
      tier: control?.tier ?? null, configuredTier: this.env.PROOF_QUALIFICATION_TIER, configurationMatches,
      enabled: Boolean(control && configurationMatches && !this.stopped() && control.expires_at > Date.now()), stopped: this.stopped(),
      stopConfirmed: Boolean(stop?.completed), stopAttempts: stop?.attempts ?? 0, automaticStopAttemptLimit: MAX_STOP_ATTEMPTS,
      expiresAt: control?.expires_at ?? null, sourceRevision: control?.source ?? null, corpusDigest: control?.corpus ?? null,
      commands: this.ctx.storage.sql.exec<{ used: number }>('SELECT used FROM qualification_commands WHERE id=1').one().used,
      commandLimit: 128, reservationLimit: QUALIFICATION_RESERVATIONS, reserved: jobs.length, creditsPerGame: 2,
      batches: batches.length, coldBatch: batches.length - 1, activeBatch: control?.active_batch ?? null,
      measurements: jobs.map(job => {
        const request = JSON.parse(job.request) as TimeoutProofRequest;
        const result = job.result ? JSON.parse(job.result) as TimeoutProofResult : null;
        const beforeOriginalDeadline = job.finished_at !== null && job.finished_at < request.expiresAt;
        return { fixture: job.fixture, batch: job.batch, position: job.position, requestId: request.requestId,
          expected: job.expected, ordinary: Boolean(job.ordinary), status: job.status, verdict: result?.verdict ?? null,
          reason: result?.reason ?? null, witnessPlies: result?.witness.length ?? 0, attempt: request.attempt,
          deliveries: job.deliveries, startedAt: job.started_at, finishedAt: job.finished_at,
          wallMs: job.started_at !== null && job.finished_at !== null ? job.finished_at - job.started_at : null,
          expiresAt: request.expiresAt, beforeOriginalDeadline, error: job.error,
          passed: Boolean(result && result.verdict === job.expected && (!job.expected_reason || result.reason === job.expected_reason) && beforeOriginalDeadline) };
      }),
      limits: { nativeJobs: 1, poolSlots: 4, nativeAttempts: QUALIFICATION_RESERVATIONS * 2 },
      scopeNote: 'Fixed synthetic private transport evidence. No player accounts, gameplay, rating settlement, child CPU/peak memory or invoice-cap claim.' };
  }
  private async prepare(batch: number, expiry: number): Promise<void> {
    const corpusDigest = await proofHash([corpus]);
    const control = this.control();
    if (this.stopped() || control && (control.expires_at !== expiry || control.source !== this.env.PROOF_QUALIFICATION_SOURCE_REVISION
      || control.corpus !== corpusDigest || control.tier !== this.env.PROOF_QUALIFICATION_TIER)) {
      throw new ApiError(409, 'PROOF_QUALIFICATION_FROZEN', 'Stopped, expired or changed qualification state cannot be reset for more work.');
    }
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO qualification_control(id,corpus,source,tier,expires_at)
      VALUES(1,?,?,?,?)`, corpusDigest, this.env.PROOF_QUALIFICATION_SOURCE_REVISION, this.env.PROOF_QUALIFICATION_TIER, expiry);
    const current = this.control()!;
    if (current.active_batch !== null && current.active_batch !== batch) throw new ApiError(409, 'PROOF_QUALIFICATION_BUSY', 'Reconcile the saved batch before starting another.');
    this.ctx.storage.sql.exec('UPDATE qualification_control SET active_batch=? WHERE id=1', batch);
    await this.ctx.storage.setAlarm(expiry);
    for (const { fixture, index } of batches[batch]) {
      const id = `pq-${corpusDigest.slice(0, 24)}-${index}`;
      if (this.ctx.storage.sql.exec('SELECT 1 FROM qualification_jobs WHERE id=?', id).toArray().length) continue;
      const chess = new Chess(fixture.initialFen);
      for (const move of fixture.moves) chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}) });
      const source = { rulesVersion: PROOF_RULES_VERSION as typeof PROOF_RULES_VERSION, gameId: id, pendingVersion: 1,
        initialFen: fixture.initialFen, fen: chess.fen(), moves: fixture.moves, survivor: chess.turn() === 'w' ? 'b' as const : 'w' as const };
      const request: TimeoutProofRequest = { ...source, ...await proofDigests(source), v: 1, profileVersion: PROOF_PROFILE,
        reservationId: id, requestId: `timeout:${id}:1`, expiresAt: Math.min(expiry, Date.now() + 30_000), attempt: 1 };
      if (this.stopped()) throw new ApiError(409, 'PROOF_QUALIFICATION_STOPPED', 'This qualification has stopped.');
      if (!this.ctx.storage.sql.exec(`INSERT INTO qualification_jobs(id,fixture,batch,position,expected,ordinary,expected_reason,request)
        SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM qualification_jobs)<32 RETURNING id`,
      id, fixture.name, batch, index, fixture.expected, Number(fixture.ordinary), fixture.reason ?? null, JSON.stringify(request)).toArray().length) {
        throw new ApiError(429, 'PROOF_QUALIFICATION_RESERVATIONS', 'The fixed reservation allowance is exhausted.');
      }
    }
    await this.ctx.storage.sync();
  }
  private async runJob(id: string): Promise<void> {
    let row = this.job(id);
    if (row.status === 'done' || row.status === 'failed') return;
    if (this.stopped()) return;
    const config: Env = { ...this.env, TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '32', NEW_WORK_STOPPED: 'false' };
    if (!await reserveProofAdmission(config, id)) throw new Error('qualification_admission_denied');
    while (row.deliveries < 2) {
      const request = JSON.parse(row.request) as TimeoutProofRequest;
      if (this.stopped() || Date.now() >= request.expiresAt) break;
      this.ctx.storage.sql.exec("UPDATE qualification_jobs SET status='running',deliveries=deliveries+1,started_at=COALESCE(started_at,?) WHERE id=?", Date.now(), id);
      await this.ctx.storage.sync();
      const cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(), Math.max(1, request.expiresAt - Date.now()));
      try {
        const response = await this.env.PROVER.get(this.env.PROVER.idFromName(PROOF_INSTANCE)).fetch(new Request('http://proof.internal/prove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: cancellation.signal,
        }));
        if (!response.ok) throw new Error('private_proof_transport');
        const result = parseProofResult(await readJson<unknown>(response, PROOF_RESULT_BYTES), request);
        if (!result) throw new Error('private_proof_identity');
        if (transientProof(result) && request.attempt === 1 && Date.now() < request.expiresAt && !this.stopped()) {
          this.ctx.storage.sql.exec("UPDATE qualification_jobs SET request=?,deliveries=0,status='pending' WHERE id=?", JSON.stringify({ ...request, attempt: 2 }), id);
          row = this.job(id);
          continue;
        }
        this.ctx.storage.sql.exec("UPDATE qualification_jobs SET status='done',result=?,finished_at=?,error=NULL WHERE id=?", JSON.stringify(result), Date.now(), id);
        await this.ctx.storage.sync();
        return;
      } catch {
        this.ctx.storage.sql.exec("UPDATE qualification_jobs SET error='transport-unavailable' WHERE id=?", id);
      } finally { clearTimeout(timer); }
      row = this.job(id);
    }
    this.ctx.storage.sql.exec("UPDATE qualification_jobs SET status='failed',finished_at=?,error=COALESCE(error,'expired-or-stopped') WHERE id=?", Date.now(), id);
    await this.ctx.storage.sync();
  }
  async execute(command: Command) {
    try {
      if (command.operation === 'stop') { await this.stop(); return { ok: true as const, value: await this.inspect() }; }
      this.takeCommand();
      if (command.operation === 'inspect') return { ok: true as const, value: await this.inspect() };
      const expiry = assertProofQualification(this.env);
      if (this.running) throw new ApiError(409, 'PROOF_QUALIFICATION_BUSY', 'Wait for or reconcile the current fixed batch.');
      const batch = command.batch;
      this.running = (async () => {
        await this.prepare(batch, expiry);
        const jobs = this.ctx.storage.sql.exec<Job>('SELECT * FROM qualification_jobs WHERE batch=? ORDER BY position LIMIT 4', batch).toArray();
        if (batch === batches.length - 1 && !this.control()?.cold_reset) {
          await qualificationProver(this.env).coldQualification();
          this.ctx.storage.sql.exec('UPDATE qualification_control SET cold_reset=1 WHERE id=1');
          await this.ctx.storage.sync();
        }
        const settled = await Promise.allSettled(jobs.map(job => this.runJob(job.id)));
        const failure = settled.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        this.ctx.storage.sql.exec('UPDATE qualification_control SET active_batch=NULL WHERE id=1');
        await this.ctx.storage.sync();
        return this.inspect();
      })();
      try { return { ok: true as const, value: await this.running }; }
      finally { this.running = null; }
    } catch (error) {
      return { ok: false as const, error: { status: error instanceof ApiError ? error.status : 503,
        code: error instanceof ApiError ? error.code : 'PROOF_QUALIFICATION_UNAVAILABLE',
        message: error instanceof ApiError ? error.message : 'The isolated qualification failed. Reconcile saved state or stop it.' } };
    }
  }
}

export default {
  async fetch(request: Request, env: ProofQualificationEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/qualify' || url.search) throw new ApiError(404, 'NOT_FOUND', 'This endpoint was not found.');
      const secret = env.PROOF_QUALIFICATION_TOKEN;
      if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
      const header = request.headers.get('Authorization');
      if (!header?.startsWith('Bearer ') || header.length > 136) throw new ApiError(403, 'QUALIFICATION_AUTH_REQUIRED', 'Private qualification authentication is required.');
      const encoder = new TextEncoder();
      const [actual, expected] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))), crypto.subtle.digest('SHA-256', encoder.encode(secret))]);
      if (!crypto.subtle.timingSafeEqual(actual, expected)) throw new ApiError(403, 'QUALIFICATION_AUTH_REQUIRED', 'Private qualification authentication is required.');
      const command = parseQualificationCommand(await readJson<unknown>(request, 2048));
      if (!command) throw new ApiError(400, 'INVALID_QUALIFICATION_COMMAND', 'Choose inspect, stop or a fixed corpus batch.');
      const result = await env.PROOF_QUALIFICATION.get(env.PROOF_QUALIFICATION.idFromName(QUALIFICATION_INSTANCE)).execute(command);
      if (result.ok && new TextEncoder().encode(JSON.stringify(result.value)).byteLength > 64 * 1024) {
        throw new ApiError(503, 'QUALIFICATION_RESULT_LIMIT', 'The bounded qualification readout is unavailable.');
      }
      return result.ok ? jsonResponse(result.value) : jsonResponse({ error: result.error.code, message: result.error.message }, result.error.status);
    } catch (error) { return errorResponse(error); }
  },
};
