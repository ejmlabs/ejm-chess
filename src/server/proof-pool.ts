import { Container } from '@cloudflare/containers';
import type { Env } from './env';
import { readJson } from './security';
import { hasProofAdmission } from './proof-budget';
import { captureNativePoint } from './recovery';
import { proofAttemptCharges } from './proof-recovery';
import { RATING_VERSION } from '../shared/protocol';
import {
  initializeProofLifecycle, observedProofMilliseconds, proofLifecycle, saveProofLifecycle, withinProofStop,
  PROOF_ALLOCATION_MS, PROOF_STOP_ATTEMPTS, PROOF_STOP_CALLBACK, type ProofLifecycle,
} from './proof-lifecycle';
import {
  parseProofRequest, parseProofResult, proofDigests, proofHash, unknownProof, transientProof,
  PROOF_INSTANCE, PROOF_PROFILE, PROOF_RULES_VERSION, PROOF_REQUEST_BYTES, PROOF_RESULT_BYTES, PROOF_SLOTS, PROOF_WAIT_MS,
  type TimeoutProofRequest, type TimeoutProofResult,
} from './proof-contract';

type Attempt = { digest: string; result: string | null; native_generation: number | null };
type StartPortsArgs = Parameters<Container['startAndWaitForPorts']>;
type StartOptions = Parameters<Container['start']>[0];
type StartWait = Parameters<Container['start']>[1];
type NativeCredit = { id: string; generation: number; signal: AbortSignal };

export function initializeProofPool(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS proof_attempts
    (id TEXT PRIMARY KEY,game_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
     digest TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,native_generation INTEGER,UNIQUE(game_id,attempt))`);
  if (!sql.exec<{ name: string }>('PRAGMA table_info(proof_attempts)').toArray().some(column => column.name === 'native_generation')) {
    sql.exec('ALTER TABLE proof_attempts ADD COLUMN native_generation INTEGER');
  }
  initializeProofLifecycle(sql);
}

/** Only the fixed private singleton may start native proof work. */
export class TimeoutProver extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10s';
  enableInternet = false;
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, Promise<TimeoutProofResult>>();
  private credit?: NativeCredit;
  private allocationCancellation = new AbortController();
  private startCalls = 0;
  private stopCalls = new Set<Promise<void>>();
  private stopping?: Promise<void>;
  private nativeMonitor?: Promise<void>;

  constructor(ctx: DurableObjectState<{}>, env: Env, internalContext?: DurableObjectState) {
    super(ctx, env);
    // Private acceptance may meter product storage. The SDK receives the real
    // native state above and retains its unchanged Container lifecycle.
    if (internalContext) { this.ctx = internalContext as typeof this.ctx; ctx = this.ctx; }
    initializeProofPool(ctx.storage.sql);
    ctx.blockConcurrencyWhile(() => this.recoverInterrupted());
  }

  private async recoverInterrupted(): Promise<void> {
    // Completed receipts do not prove that their native allocation stopped.
    const state = proofLifecycle(this.ctx.storage.sql);
    if (this.nativeRunning()) this.watchNative();
    if (state.phase !== 'idle' || state.stop_debt || this.nativeRunning()
      || this.ctx.storage.sql.exec('SELECT 1 FROM proof_attempts WHERE result IS NULL LIMIT 1').toArray().length) {
      await this.stop('SIGKILL').catch(() => {});
    }
  }

  private persistLifecycle(change: Partial<ProofLifecycle>): ProofLifecycle {
    const current = proofLifecycle(this.ctx.storage.sql);
    const next = { ...current, observed_ms: observedProofMilliseconds(current), ...change };
    saveProofLifecycle(this.ctx.storage.sql, next);
    return next;
  }

  /** Private binding-only readout. Elapsed reservations are not metered invoices. */
  lifecycleStatus() {
    const state = proofLifecycle(this.ctx.storage.sql);
    return { generation: state.generation, phase: state.phase, deadline: state.deadline,
      reservedMilliseconds: state.reserved_ms, observedMilliseconds: observedProofMilliseconds(state),
      startIssued: Boolean(state.start_issued), stopDebt: Boolean(state.stop_debt), stopAttempts: state.stop_attempts,
      pendingStops: state.stop_pending,
      destroyConfirmed: Boolean(state.destroy_confirmed),
      stopExhausted: state.stop_attempts >= PROOF_STOP_ATTEMPTS && Boolean(state.stop_debt),
      scheduleFailed: Boolean(state.schedule_failed), invoiceHardCap: false as const };
  }

  /** Private read-only capture. No restore or new native start is exposed. */
  async captureRecoveryPoint() {
    if (!this.env.PROVER?.idFromName(PROOF_INSTANCE).equals(this.ctx.id)) throw new Error('proof_recovery_target_invalid');
    return captureNativePoint(this.ctx, { kind: 'TimeoutProver', name: PROOF_INSTANCE,
      policies: { rules: PROOF_RULES_VERSION, ratings: RATING_VERSION } }, () => {
      const state = proofLifecycle(this.ctx.storage.sql);
      return { proofLifecycle: { profileVersion: PROOF_PROFILE, generation: state.generation,
        attempts: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM proof_attempts').one().count,
        stopDebt: Boolean(state.stop_debt), pendingStops: state.stop_pending } };
    });
  }

  /** Save outside every rollback target before an approved four-authority restore. */
  async proofRecoveryState() {
    if (this.pending.size || this.startCalls || this.stopCalls.size || this.nativeRunning()) throw new Error('proof_recovery_not_quiescent');
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sync();
      return { attempts: proofAttemptCharges(this.ctx.storage.sql), lifecycle: proofLifecycle(this.ctx.storage.sql) };
    });
  }

  protected nativeRunning(): boolean { return this.ctx.container!.running; }

  protected issueNativeStart(): void { this.ctx.container!.start({ enableInternet: false }); }

  protected watchNative(): void {
    if (this.nativeMonitor) return;
    const monitor = this.ctx.container!.monitor();
    this.nativeMonitor = monitor;
    const settled = () => { if (this.nativeMonitor === monitor) this.nativeMonitor = undefined; };
    void monitor.then(settled, settled);
  }

  protected nativeTransport(request: Request): Promise<Response> { return this.ctx.container!.getTcpPort(8080).fetch(request); }

  protected async stopNative(): Promise<void> {
    // destroy() is documented to kill the Container. A resolved signal alone
    // is not confirmation, and a failed signal must not skip destruction.
    try { if (this.nativeRunning()) this.ctx.container!.signal(9); } catch { /* Try destruction below. */ }
    await this.ctx.container!.destroy();
  }

  private assertCredit(): ProofLifecycle {
    const state = proofLifecycle(this.ctx.storage.sql);
    if (!this.credit || this.credit.generation !== state.generation || this.credit.signal.aborted
      || state.phase !== 'active' || state.schedule_failed || state.deadline <= Date.now()
      || this.receipt(this.credit.id)?.native_generation !== state.generation) throw new Error('proof_start_closed');
    return state;
  }

  // SDK 0.3.7 may retry native starts inside start()/startAndWaitForPorts().
  // Use its public wait API with one explicit, durably charged native start.
  override async start(options?: StartOptions, wait?: StartWait): Promise<void> {
    if (options && Object.keys(options).length) throw new Error('proof_start_options_fixed');
    this.assertCredit();
    if (wait?.signal?.aborted) throw new Error('proof_start_cancelled');
    this.startCalls++;
    try {
      if (!this.nativeRunning()) {
        if (this.assertCredit().start_issued) throw new Error('proof_generation_already_started');
        this.persistLifecycle({ start_issued: 1 });
        await this.ctx.storage.sync();
        this.assertCredit();
        if (wait?.signal?.aborted) throw new Error('proof_start_cancelled');
        if (this.nativeRunning()) throw new Error('proof_untracked_native_start');
        // No await separates the final fence from this synchronous platform API.
        this.issueNativeStart();
        this.watchNative();
      }
      this.renewActivityTimeout();
      if (wait?.signal?.aborted) throw new Error('proof_start_cancelled');
    } finally { this.startCalls--; }
  }

  override async startAndWaitForPorts(...args: StartPortsArgs): Promise<void> {
    const [first, cancellationOptions, startOptions] = args;
    const options = typeof first === 'object' && first !== null && !Array.isArray(first)
      ? first : { ports: first, cancellationOptions, startOptions };
    if (options.ports !== undefined && options.ports !== 8080) throw new Error('proof_port_fixed');
    const state = this.assertCredit();
    const signal = AbortSignal.any([this.credit!.signal, ...(options.cancellationOptions?.abort ? [options.cancellationOptions.abort] : [])]);
    this.startCalls++;
    try {
      await this.start(options.startOptions, { portToCheck: 8080, signal });
      this.assertCredit();
      await this.waitForPort({ portToCheck: 8080, signal, waitInterval: 100,
        retries: Math.max(1, Math.ceil(Math.min(5_000, state.deadline - Date.now(),
          options.cancellationOptions?.portReadyTimeoutMS ?? 5_000) / 100)) });
      this.assertCredit();
      await this.onStart();
    } finally { this.startCalls--; }
  }

  override async stop(_signal: Parameters<Container['stop']>[0] = 'SIGKILL'): Promise<void> {
    if (this.stopping) return this.stopping;
    this.allocationCancellation.abort();
    this.stopping = this.stopAllocation();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }

  private async stopAllocation(): Promise<void> {
    let state = proofLifecycle(this.ctx.storage.sql);
    if (state.phase === 'idle' && !state.stop_debt && !this.nativeRunning() && !this.startCalls && !this.stopCalls.size) return;
    if (state.phase === 'stopping' && await this.confirmStopped()) return;
    this.persistLifecycle({ phase: 'stopping', stop_debt: 1 });
    await this.ctx.storage.sync();
    if (await this.confirmStopped()) return;
    while ((state = proofLifecycle(this.ctx.storage.sql)).stop_attempts < PROOF_STOP_ATTEMPTS) {
      this.persistLifecycle({ stop_attempts: state.stop_attempts + 1, stop_pending: state.stop_pending + 1 });
      await this.ctx.storage.sync();
      const generation = state.generation;
      const recordSettlement = async (destroyed: boolean) => {
        const current = proofLifecycle(this.ctx.storage.sql);
        if (current.generation === generation && current.phase === 'stopping') {
          this.persistLifecycle({ stop_pending: Math.max(0, current.stop_pending - 1),
            destroy_confirmed: destroyed ? 1 : current.destroy_confirmed });
          await this.ctx.storage.sync();
        }
      };
      const work = this.stopNative().then(() => recordSettlement(true), async error => {
        await recordSettlement(false);
        throw error;
      });
      this.stopCalls.add(work);
      const settled = () => {
        this.stopCalls.delete(work);
        if (!this.stopping) void this.confirmStopped().catch(() => {});
      };
      void work.then(settled, settled);
      try {
        await withinProofStop(work);
        if (await this.confirmStopped()) return;
      } catch { /* Persisted debt and attempt count survive all failed stops. */ }
    }
    if (await this.confirmStopped()) return;
    state = proofLifecycle(this.ctx.storage.sql);
    if (!state.diagnostic_emitted) {
      this.persistLifecycle({ diagnostic_emitted: 1 });
      await this.ctx.storage.sync();
      console.error('timeout_proof_stop_unconfirmed');
    }
    throw new Error('proof_stop_unconfirmed');
  }

  private async confirmStopped(): Promise<boolean> {
    const state = proofLifecycle(this.ctx.storage.sql);
    if (state.phase !== 'stopping' || state.stop_pending || (state.start_issued && !state.destroy_confirmed)
      || this.nativeRunning() || this.startCalls || this.stopCalls.size) return false;
    this.deleteSchedules(PROOF_STOP_CALLBACK);
    this.persistLifecycle({ phase: 'idle', stop_debt: 0 });
    await this.ctx.storage.sync();
    return true;
  }

  override async onActivityExpired(): Promise<void> { await this.stop('SIGKILL').catch(() => {}); }

  override async onStop(_params: Parameters<Container['onStop']>[0]): Promise<void> { await this.confirmStopped(); }

  async expireProofAllocation(payload: { generation: number }): Promise<void> {
    if (payload.generation === proofLifecycle(this.ctx.storage.sql).generation) await this.stop('SIGKILL').catch(() => {});
  }

  private async reserveNativeCredit(id: string, input: TimeoutProofRequest, signal: AbortSignal): Promise<boolean> {
    let state = proofLifecycle(this.ctx.storage.sql);
    if (this.receipt(id)?.native_generation !== null || signal.aborted || input.expiresAt <= Date.now() || state.schedule_failed) return false;
    if (state.phase !== 'idle' && (state.phase !== 'active' || state.deadline <= Date.now() || !this.nativeRunning())) {
      await this.stop('SIGKILL');
      state = proofLifecycle(this.ctx.storage.sql);
    }
    if (state.phase === 'idle') {
      if (state.stop_debt || this.nativeRunning() || this.stopCalls.size) return false;
      const now = Date.now();
      const deadline = Math.min(input.expiresAt, now + PROOF_ALLOCATION_MS);
      state = this.persistLifecycle({ generation: state.generation + 1, phase: 'reserved', reserved_at: now, deadline,
        reserved_ms: state.reserved_ms + deadline - now, start_issued: 0, destroy_confirmed: 0, stop_debt: 1, stop_attempts: 0, stop_pending: 0 });
      this.ctx.storage.sql.exec('UPDATE proof_attempts SET native_generation=? WHERE id=? AND native_generation IS NULL', state.generation, id);
      await this.ctx.storage.sync();
      try {
        this.deleteSchedules(PROOF_STOP_CALLBACK);
        await this.schedule(new Date(deadline), PROOF_STOP_CALLBACK, { generation: state.generation });
        if (proofLifecycle(this.ctx.storage.sql).phase !== 'reserved') return false;
        state = this.persistLifecycle({ phase: 'active' });
        await this.ctx.storage.sync();
      } catch {
        this.persistLifecycle({ phase: 'stopping', schedule_failed: 1, stop_debt: 1 });
        await this.ctx.storage.sync();
        await this.stop('SIGKILL').catch(() => {});
        return false;
      }
      this.allocationCancellation = new AbortController();
    } else {
      this.ctx.storage.sql.exec('UPDATE proof_attempts SET native_generation=? WHERE id=? AND native_generation IS NULL', state.generation, id);
      await this.ctx.storage.sync();
    }
    this.credit = { id, generation: state.generation, signal: AbortSignal.any([signal, this.allocationCancellation.signal]) };
    return true;
  }

  private receipt(id: string): Attempt | null {
    return this.ctx.storage.sql.exec<Attempt>('SELECT digest,result,native_generation FROM proof_attempts WHERE id=?', id).toArray()[0] ?? null;
  }

  private async remember(id: string, result: TimeoutProofResult): Promise<TimeoutProofResult> {
    this.ctx.storage.sql.exec('UPDATE proof_attempts SET result=? WHERE id=?', JSON.stringify(result), id);
    await this.ctx.storage.sync();
    return result;
  }

  protected async native(request: TimeoutProofRequest, originalSignal: AbortSignal): Promise<TimeoutProofResult> {
    const remaining = Math.min(request.expiresAt, this.assertCredit().deadline) - Date.now();
    if (remaining <= 0) return unknownProof(request, request.expiresAt <= Date.now() ? 'expired' : 'interrupted');
    const cancellation = new AbortController();
    const deadlineTimer = setTimeout(() => cancellation.abort(), remaining);
    const signal = AbortSignal.any([originalSignal, this.credit!.signal, cancellation.signal]);
    let jobTimer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    try {
      await this.startAndWaitForPorts({ ports: 8080, cancellationOptions: {
        abort: signal, instanceGetTimeoutMS: Math.min(5_000, remaining), portReadyTimeoutMS: Math.min(5_000, remaining),
      } });
      started = true;
      const job = new AbortController();
      jobTimer = setTimeout(() => job.abort(), 2_500);
      const jobSignal = AbortSignal.any([signal, job.signal]);
      const response = await this.nativeTransport(new Request('http://proof.internal/prove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: jobSignal,
      }));
      if (!response.ok) return unknownProof(request, response.status === 504 ? 'resource-limit' : 'invalid-output');
      const result = parseProofResult(await readJson<unknown>(response, PROOF_RESULT_BYTES), request);
      return result ?? unknownProof(request, 'invalid-output');
    } catch {
      // An uncertain stop remains durable and closes later native starts.
      await this.stop('SIGKILL').catch(() => {});
      return unknownProof(request, request.expiresAt <= Date.now() ? 'expired'
        : !started ? 'transient-start' : signal.aborted ? 'interrupted' : 'resource-limit');
    } finally {
      clearTimeout(deadlineTimer);
      if (jobTimer !== undefined) clearTimeout(jobTimer);
      this.renewActivityTimeout();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.origin !== 'http://proof.internal' || url.pathname !== '/prove' || url.search
      || !this.env.PROVER || !this.env.PROVER.idFromName(PROOF_INSTANCE).equals(this.ctx.id)) return new Response('Unavailable', { status: 404 });
    let input: TimeoutProofRequest | null;
    try { input = parseProofRequest(await readJson<unknown>(request, PROOF_REQUEST_BYTES)); }
    catch { return new Response('Invalid proof envelope', { status: 422 }); }
    if (!input) return new Response('Invalid proof envelope', { status: 422 });
    const digests = await proofDigests(input);
    if (digests.historyDigest !== input.historyDigest || digests.positionDigest !== input.positionDigest
      || input.expiresAt > Date.now() + PROOF_WAIT_MS) return new Response('Invalid proof identity', { status: 422 });
    if (!await hasProofAdmission(this.env, input.gameId)) return new Response('Proof admission required', { status: 403 });
    const id = `${input.requestId}:${input.attempt}`;
    const digest = await proofHash([input.requestId, input.attempt, input.positionDigest, input.expiresAt]);
    const existing = this.receipt(id);
    if (existing && existing.digest !== digest) return new Response('Conflicting proof receipt', { status: 409 });
    if (existing?.result) return Response.json(JSON.parse(existing.result), { headers: { 'Cache-Control': 'no-store' } });
    const running = this.pending.get(id);
    if (running) return Response.json(await running, { headers: { 'Cache-Control': 'no-store' } });
    if (existing) return Response.json(await this.remember(id, unknownProof(input, 'interrupted')), { headers: { 'Cache-Control': 'no-store' } });
    if (input.expiresAt <= Date.now()) return Response.json(unknownProof(input, 'expired'));
    if (this.ctx.storage.sql.exec('SELECT 1 FROM proof_attempts WHERE game_id=? AND id NOT IN (?,?) LIMIT 1',
      input.gameId, `${input.requestId}:1`, `${input.requestId}:2`).toArray().length) {
      return new Response('Conflicting game proof identity', { status: 409 });
    }
    if (input.attempt === 2) {
      const prior = this.receipt(`${input.requestId}:1`);
      const result = prior?.result && parseProofResult(JSON.parse(prior.result), { ...input, attempt: 1 });
      if (!result || !transientProof(result)) {
        return new Response('No transient retry credit', { status: 409 });
      }
    }
    const lifecycle = proofLifecycle(this.ctx.storage.sql);
    if (lifecycle.phase === 'stopping' || lifecycle.schedule_failed) return new Response('Native stop unconfirmed', { status: 503 });
    if (this.pending.size >= PROOF_SLOTS) return new Response('Reserved pool busy', { status: 429 });
    const inserted = this.ctx.storage.sql.exec(`INSERT INTO proof_attempts(id,game_id,attempt,digest,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM proof_attempts)<2000 RETURNING id`, id, input.gameId, input.attempt, digest, Date.now()).toArray();
    if (!inserted.length) return new Response('Proof receipt storage full', { status: 503 });
    const job = this.tail.then(async () => {
      await this.ctx.storage.sync();
      try {
        const admitted = !request.signal.aborted && await this.reserveNativeCredit(id, input, request.signal);
        const result = admitted ? await this.native(input, request.signal)
          : unknownProof(input, input.expiresAt <= Date.now() ? 'expired' : 'interrupted');
        return this.remember(id, result);
      } finally { this.credit = undefined; }
    }).catch(async () => this.remember(id, unknownProof(input, 'interrupted')));
    this.pending.set(id, job);
    this.tail = job.then(() => {}, () => {});
    try { return Response.json(await job, { headers: { 'Cache-Control': 'no-store' } }); }
    finally { this.pending.delete(id); }
  }
}
