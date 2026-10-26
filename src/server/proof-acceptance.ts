/** Fixed private native acceptance. Production never imports this entry. */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Chess } from 'chess.js';
import manifest from '../../proof/acceptance-manifest.json';
import corpus from '../../proof/corpus.json';
import { parseProofAcceptanceCommand, ProofAcceptanceJournal, proofAcceptanceManifestDigest,
  proofAcceptanceExecutionAvailable, PROOF_ACCEPTANCE_SCOPE, PROOF_ACCEPTANCE_LIMITS } from './proof-acceptance-journal';
import { acceptanceIdentity, prepareAcceptanceAccounts, acceptanceActors, readyAcceptanceGame,
  AcceptanceGame, AcceptanceCompetition, AcceptanceTimeoutProver, ACCEPTANCE_INSTANCE, type AcceptanceAdapterEnv, type AcceptanceScenario } from './proof-acceptance-adapters';
import { ProofAcceptanceBudget } from './proof-acceptance-budget';
import { proofRestoreRecord, captureProofRestoreCredits, captureProofRestoreD1, reapplyProofRestoreAdmissions,
  type ProofRestoreControl, type ProofRestoreReview, type ProofRestoreReceipt, type ProofRestoreRole } from './proof-recovery-drill';
import { reserveProofAdmission } from './proof-budget';
import { parseProofRequest, parseProofResult, proofDigests, transientProof, PROOF_INSTANCE, PROOF_PROFILE, PROOF_RULES_VERSION,
  type TimeoutProofRequest, type TimeoutProofResult } from './proof-contract';
export { AcceptanceGame, AcceptanceCompetition, AcceptanceTimeoutProver };

const stopped = { TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0', NEW_WORK_STOPPED: 'true',
  RANKED_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false', ANALYSIS_ENABLED: 'false',
  AI_ENABLED: 'false', MONTHLY_GAME_LIMIT: '0', MONTHLY_EMAIL_LIMIT: '0', MONTHLY_ANALYSIS_LIMIT: '0' };
const fields = new Set([...Object.keys(stopped), 'PROOF_ACCEPTANCE', 'PROOF_ACCEPTANCE_SCOPE',
  'PROOF_ACCEPTANCE_SOURCE_REVISION', 'PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID', 'PROOF_ACCEPTANCE_MANIFEST_SHA256', 'PROOF_ACCEPTANCE_EXECUTION']);
const executionFields = new Set([...fields, 'DB', 'GAME', 'COMPETITION', 'PROVER', 'PROOF_ACCEPTANCE_TIER', 'PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID']);
export type ProofAcceptanceEnv = Record<string, unknown>;

/** No product binding is accepted until the compiled source has a reviewed seal. */
export function proofAcceptanceScopeAllowed(env: ProofAcceptanceEnv): boolean {
  const source = env.PROOF_ACCEPTANCE_SOURCE_REVISION;
  const namespace = env.PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID;
  const digest = env.PROOF_ACCEPTANCE_MANIFEST_SHA256;
  const executable = proofAcceptanceExecutionAvailable();
  return Object.keys(env).every(key => (executable ? executionFields : fields).has(key))
    && env.PROOF_ACCEPTANCE_SCOPE === PROOF_ACCEPTANCE_SCOPE && Object.entries(stopped).every(([key, value]) => env[key] === value)
    && env.PROOF_ACCEPTANCE_EXECUTION === (executable ? 'sealed-private' : 'disabled')
    && (source === 'unconfigured' || typeof source === 'string' && /^[a-f0-9]{64}$/.test(source))
    && (namespace === 'unconfigured' || typeof namespace === 'string' && /^(?!0{32}$)[a-f0-9]{32}$/.test(namespace))
    && (digest === 'unconfigured' || typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
}
type Job = { id: string; game_id: string | null; prepared: number; deadline: number | null; request: string | null;
  deliveries: number; credit_deliveries: number; complete: number; passed: number; observation: string | null };
type Runtime = { tier: 'lite' | 'basic' | null; lite_stopped: number; fallback: number; branch_started: number;
  proof_calls: number; cleanups: number; failed: number; closed_admission: number };

export class ProofAcceptance extends DurableObject<ProofAcceptanceEnv> {
  private journal?: Promise<ProofAcceptanceJournal>;
  private budget?: ProofAcceptanceBudget;
  constructor(ctx: DurableObjectState, env: ProofAcceptanceEnv) {
    super(ctx, env);
    if (!proofAcceptanceScopeAllowed(env)) throw new Error('proof_acceptance_scope_invalid');
    if (proofAcceptanceExecutionAvailable()) {
      this.budget = new ProofAcceptanceBudget(ctx, 'Control'); this.ctx = this.budget.context as typeof this.ctx;
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_jobs(id TEXT PRIMARY KEY,game_id TEXT UNIQUE,
        prepared INTEGER NOT NULL DEFAULT 0,deadline INTEGER,request TEXT,deliveries INTEGER NOT NULL DEFAULT 0,credit_deliveries INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,observation TEXT)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_runtime(id INTEGER PRIMARY KEY CHECK(id=1),tier TEXT,
        lite_stopped INTEGER NOT NULL DEFAULT 0,fallback INTEGER NOT NULL DEFAULT 0,branch_started INTEGER NOT NULL DEFAULT 0,
        proof_calls INTEGER NOT NULL DEFAULT 0,cleanups INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,
        closed_admission INTEGER NOT NULL DEFAULT 0)`);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO proof_acceptance_runtime(id) VALUES(1)');
      this.budget.sealBootstrap();
    }
  }
  private run<T>(operation: string, body: () => T | Promise<T>): Promise<T> {
    return this.budget ? this.budget.run(operation, body) : Promise.resolve().then(body);
  }
  private adapter(): AcceptanceAdapterEnv {
    const env = this.env as unknown as AcceptanceAdapterEnv;
    return this.budget ? { ...env, DB: this.budget.d1(env.DB) } : env;
  }
  private store(): Promise<ProofAcceptanceJournal> {
    return this.journal ??= proofAcceptanceManifestDigest().then(async digest =>
      new ProofAcceptanceJournal(this.ctx.storage.sql, run => this.ctx.storage.transactionSync(run), digest,
        this.budget ? await acceptanceIdentity(this.adapter(), true) : null));
  }
  private runtime(): Runtime { return this.ctx.storage.sql.exec<Runtime>('SELECT * FROM proof_acceptance_runtime WHERE id=1').one(); }
  private job(id: string): Job | null {
    return this.ctx.storage.sql.exec<Job>('SELECT * FROM proof_acceptance_jobs WHERE id=?', id).toArray()[0] ?? null;
  }
  private jobs(): Job[] { return this.ctx.storage.sql.exec<Job>('SELECT * FROM proof_acceptance_jobs ORDER BY id LIMIT 39').toArray(); }
  private competition(): DurableObjectStub<AcceptanceCompetition> {
    const env = this.adapter(); return env.COMPETITION.get(env.COMPETITION.idFromName('global')) as unknown as DurableObjectStub<AcceptanceCompetition>;
  }
  private prover(): DurableObjectStub<AcceptanceTimeoutProver> {
    const env = this.adapter(); return env.PROVER!.get(env.PROVER!.idFromName(PROOF_INSTANCE)) as unknown as DurableObjectStub<AcceptanceTimeoutProver>;
  }
  private game(id: string): DurableObjectStub<AcceptanceGame> {
    const env = this.adapter(); return env.GAME.get(env.GAME.idFromName(id)) as unknown as DurableObjectStub<AcceptanceGame>;
  }
  async inspect() {
    return this.run('inspect', async () => {
      const status = (await this.store()).inspect(); await this.ctx.storage.sync();
      const configuredManifestMatches = this.env.PROOF_ACCEPTANCE_MANIFEST_SHA256 === await proofAcceptanceManifestDigest();
      return { ...status, configuredManifestMatches, reviewGates: manifest.reviewGates,
        runnable: Boolean(this.budget && configuredManifestMatches && status.manifestMatches === true
          && status.identityMatches === true && status.armed && !status.closed), executionAvailable: Boolean(this.budget),
        ...(this.budget ? { runtime: this.runtime(), jobs: this.jobs(), nativeBudget: this.budget.inspect() } : {}) };
    });
  }
  async claimAdapterFault(command: string, id: string, ordinal: number): Promise<boolean> {
    return this.run('adapter-fault', async () => {
      if (!this.budget) throw new Error('proof_acceptance_unsealed');
      const result = (await this.store()).consumeFault(command, id, ordinal); await this.ctx.storage.sync(); return result.fresh;
    });
  }
  async claimProofDelivery(): Promise<void> {
    await this.run('proof-delivery', async () => {
      const journal = (await this.store()).inspect();
      if (journal.manifestMatches !== true || journal.identityMatches !== true || !journal.armed || journal.closed
        || this.runtime().proof_calls >= PROOF_ACCEPTANCE_LIMITS.privateProofCalls) throw new Error('proof_acceptance_delivery_limit');
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET proof_calls=proof_calls+1 WHERE id=1');
      await this.ctx.storage.sync();
    });
  }
  async recoveryRecord(input: Parameters<ProofRestoreControl['recoveryRecord']>[0]) {
    return this.run('recovery-control', async () => {
      if (!this.budget) throw new Error('proof_restore_unsealed');
      const identity = await acceptanceIdentity(this.adapter(), true);
      if (input.operation !== 'read' && Date.now() > identity.expiresAt + manifest.limits.postCloseIoTailSeconds * 1000) {
        throw new Error('proof_restore_window_expired');
      }
      if (input.operation === 'approve' && (input.review.baseline.databaseId !== identity.databaseId
        || input.review.baseline.sourceDigest !== identity.sourceDigest
        || input.review.baseline.proverNamespaceId !== this.env.PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID)) throw new Error('proof_restore_identity_mismatch');
      if (input.operation !== 'read' && !(['claim', 'finish'].includes(input.operation) && 'key' in input && input.key.startsWith('capture:'))
        && !(await this.store()).inspect().closed) throw new Error('proof_restore_admission_open');
      const result = await proofRestoreRecord(this.ctx.storage.sql, input); await this.ctx.storage.sync(); return result;
    });
  }
  async recoveryIdentity() {
    return this.run('recovery-identity', async () => ({ ...await acceptanceIdentity(this.adapter(), true),
      proverNamespaceId: this.env.PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID, tier: this.env.PROOF_ACCEPTANCE_TIER }));
  }
  async recoveryCredits() {
    return this.run('recovery-credits', async () => {
      if (!this.budget) throw new Error('proof_restore_unsealed');
      await acceptanceIdentity(this.adapter(), true);
      return captureProofRestoreCredits(this.adapter(), await this.prover().proofRecoveryState());
    });
  }
  async recoveryD1() {
    return this.run('recovery-d1', async () => {
      if (!this.budget || !(await this.store()).inspect().closed) throw new Error('proof_restore_admission_open');
      await acceptanceIdentity(this.adapter(), true);
      return captureProofRestoreD1(this.adapter().DB);
    });
  }
  async recoveryAdmissions(review: ProofRestoreReview) {
    return this.run('recovery-admissions', async () => {
      if (!this.budget || !(await this.store()).inspect().closed) throw new Error('proof_restore_admission_open');
      const identity = await acceptanceIdentity(this.adapter(), true);
      if (Date.now() > identity.expiresAt + manifest.limits.postCloseIoTailSeconds * 1000) throw new Error('proof_restore_window_expired');
      if (review.baseline.databaseId !== identity.databaseId) throw new Error('proof_restore_database_mismatch');
      const saved = await proofRestoreRecord(this.ctx.storage.sql, { operation: 'read' });
      if (!saved || !('review' in saved) || saved.review?.sha256 !== review.sha256) throw new Error('proof_restore_review_unapproved');
      return reapplyProofRestoreAdmissions(this.adapter(), review);
    });
  }
  async recoveryObject(input: { operation: 'capture' | 'prepare' | 'restart' | 'reapply' | 'verify'; role: ProofRestoreRole;
    name: string; review?: ProofRestoreReview; receipt?: ProofRestoreReceipt; privateReceiptSaved?: boolean }) {
    return this.run('recovery-object', async () => {
      if (!this.budget) throw new Error('proof_restore_unsealed');
      await acceptanceIdentity(this.adapter(), true);
      if (input.operation !== 'capture' && !(await this.store()).inspect().closed) throw new Error('proof_restore_admission_open');
      const stub = input.role === 'Game' ? this.game(input.name) : input.role === 'Competition' ? this.competition() : this.prover();
      if (input.role === 'Competition' && input.name !== 'global' || input.role === 'TimeoutProver' && input.name !== PROOF_INSTANCE) {
        throw new Error('proof_restore_target_mismatch');
      }
      if (input.operation === 'capture') return stub.acceptanceRestoreCapture(input.name);
      if (input.operation === 'restart' && input.receipt) return stub.acceptanceRestoreRestart(input.receipt, input.privateReceiptSaved === true);
      if (!input.review) throw new Error('proof_restore_review_required');
      if (input.operation === 'prepare') {
        const saved = await proofRestoreRecord(this.ctx.storage.sql, { operation: 'read' });
        const point = [input.review.baseline.competition, input.review.baseline.prover, ...input.review.baseline.games]
          .find(item => item.point.kind === input.role && item.point.name === input.name);
        const receipt = saved && 'receipts' in saved && point ? saved.receipts?.[point.point.objectId] : undefined;
        if (receipt) {
          if (receipt.reviewSha256 !== input.review.sha256) throw new Error('proof_restore_receipt_conflict');
          return receipt;
        }
        return stub.acceptanceRestorePrepare(input.name, input.review);
      }
      if (input.operation === 'reapply') return stub.acceptanceRestoreReapply(input.name, input.review);
      if (input.operation === 'verify') return stub.acceptanceRestoreVerify(input.name, input.review);
      throw new Error('proof_restore_operation_invalid');
    });
  }
  async stop() {
    return this.run('stop', async () => {
      const receipt = (await this.store()).stop(); await this.ctx.storage.sync(); await this.ctx.storage.deleteAlarm();
      if (this.budget) await this.cleanup(); return receipt;
    });
  }
  private async cleanup(): Promise<void> {
    const state = this.runtime();
    if (state.cleanups >= PROOF_ACCEPTANCE_LIMITS.extraCleanupCalls || state.tier === null) return;
    this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET cleanups=cleanups+1 WHERE id=1');
    await this.ctx.storage.sync(); await this.prover().acceptanceStop();
  }
  private async admitOpen(): Promise<void> {
    await this.adapter().DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'").run();
  }
  private async select(id: string): Promise<void> {
    const state = this.runtime(); const configured = this.adapter().PROOF_ACCEPTANCE_TIER;
    if (id === 'select-lite') {
      if (configured !== 'lite' || state.tier === 'basic' || state.branch_started) throw new Error('proof_acceptance_tier_locked');
      this.ctx.storage.sql.exec("UPDATE proof_acceptance_runtime SET tier='lite' WHERE id=1 AND tier IS NULL");
      await this.admitOpen(); await prepareAcceptanceAccounts(this.adapter());
    } else if (id === 'confirm-lite-stopped') {
      if (configured !== 'lite' || state.tier !== 'lite' || !state.fallback || state.branch_started) throw new Error('proof_acceptance_fallback_denied');
      const stopped = await this.prover().acceptanceStop();
      if (stopped.nativeRunning || stopped.stopDebt || stopped.pendingStops || stopped.phase !== 'idle') throw new Error('proof_acceptance_lite_stop_unconfirmed');
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET lite_stopped=1 WHERE id=1');
    } else {
      if (configured !== 'basic' || state.tier !== 'lite' || !state.fallback || !state.lite_stopped || state.branch_started) throw new Error('proof_acceptance_fallback_denied');
      this.ctx.storage.sql.exec("UPDATE proof_acceptance_runtime SET tier='basic' WHERE id=1");
    }
    await this.ctx.storage.sync();
  }
  private async corpus(id: string): Promise<void> {
    const index = Number(id.slice(1)); const fixture = corpus.fixtures[index]; const state = this.runtime();
    if (this.job(id)?.complete) return;
    if (state.tier !== 'lite' || this.adapter().PROOF_ACCEPTANCE_TIER !== 'lite' || state.branch_started || state.fallback || state.failed) throw new Error('proof_acceptance_corpus_closed');
    if (index && !this.job(`C${String(index - 1).padStart(2, '0')}`)?.complete) throw new Error('proof_acceptance_corpus_order');
    let job = this.job(id);
    if (!job) {
      const chess = new Chess(fixture.initialFen);
      for (const move of fixture.moves) chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}) });
      const gameId = `proof-acceptance-corpus-${id}`;
      const input = { rulesVersion: PROOF_RULES_VERSION as typeof PROOF_RULES_VERSION, gameId, pendingVersion: 1, initialFen: fixture.initialFen,
        fen: chess.fen(), moves: fixture.moves, survivor: chess.turn() === 'w' ? 'b' as const : 'w' as const };
      const request: TimeoutProofRequest = { ...input, ...await proofDigests(input), v: 1, profileVersion: PROOF_PROFILE,
        reservationId: gameId, requestId: `timeout:${gameId}:1`, expiresAt: Math.min(Number((await this.store()).inspect().expiresAt), Date.now() + 30_000), attempt: 1 };
      this.ctx.storage.sql.exec('INSERT INTO proof_acceptance_jobs(id,game_id,request,deadline) VALUES(?,?,?,?)', id, gameId, JSON.stringify(request), request.expiresAt);
      await this.ctx.storage.sync(); job = this.job(id)!;
    }
    const env = this.adapter();
    if (!await reserveProofAdmission({ ...env, TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '39', NEW_WORK_STOPPED: 'false' }, job.game_id!)) throw new Error('proof_acceptance_admission_denied');
    let result: TimeoutProofResult | null = null;
    while (job.deliveries < 4 && job.credit_deliveries < 2) {
      const request = JSON.parse(job.request!) as TimeoutProofRequest;
      if (Date.now() >= request.expiresAt) break;
      await this.claimProofDelivery();
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET deliveries=deliveries+1,credit_deliveries=credit_deliveries+1 WHERE id=?', id); await this.ctx.storage.sync();
      try {
        const response = await this.prover().fetch(new Request('http://proof.internal/prove', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(Math.max(1, request.expiresAt - Date.now())) }));
        result = response.ok ? parseProofResult(await response.json(), request) : null;
        if (result && transientProof(result) && request.attempt === 1) this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET request=?,credit_deliveries=0 WHERE id=?', JSON.stringify({ ...request, attempt: 2 }), id);
        else if (result) break;
      } catch { /* Keep the saved delivery charged and retry only this identity. */ }
      job = this.job(id)!;
    }
    const passed = result !== null && result.verdict === fixture.expected && (!('reason' in fixture) || result.reason === fixture.reason) && Date.now() < job.deadline!;
    const fallback = !passed && fixture.ordinary && result?.verdict === 'unknown' && ['resource-limit', 'interrupted', 'expired'].includes(result.reason ?? '');
    this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET complete=1,passed=?,observation=? WHERE id=?', Number(passed), JSON.stringify({ result, finishedAt: Date.now() }), id);
    if (!passed) this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET fallback=?,failed=? WHERE id=1', Number(fallback), Number(!fallback));
    await this.ctx.storage.sync();
  }
  private async beginGame(scenario: AcceptanceScenario, prepareOnly = false): Promise<void> {
    if (!this.job(scenario)) { this.ctx.storage.sql.exec('INSERT INTO proof_acceptance_jobs(id) VALUES(?)', scenario); await this.ctx.storage.sync(); }
    const job = this.job(scenario)!;
    if (job.deadline === null) {
      const match = await this.competition().acceptanceJoin(scenario);
      if (!match.gameId) {
        if (job.game_id) throw new Error('proof_acceptance_game_missing');
        return;
      }
      if (job.game_id && job.game_id !== match.gameId) throw new Error('proof_acceptance_game_replaced');
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET game_id=? WHERE id=? AND game_id IS NULL', match.gameId, scenario); await this.ctx.storage.sync();
      if (match.status === 'pending') return;
      const snapshot = await readyAcceptanceGame(this.adapter(), scenario, match.gameId, prepareOnly);
      if (prepareOnly) {
        this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET prepared=1 WHERE id=?', scenario); await this.ctx.storage.sync();
        return;
      }
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET deadline=?,observation=? WHERE id=? AND deadline IS NULL', snapshot.clocks.deadline,
        JSON.stringify({ legalDeadline: snapshot.clocks.deadline }), scenario); await this.ctx.storage.sync();
    }
    if (scenario === 'G09' && !this.runtime().closed_admission) {
      // Reconcile a saved intent after a lost reply at any later boundary.
      // Repeating these fixed writes cannot admit a replacement Game.
      await this.claimAdapterFault('G09', 'G09-close-new-admission', 1);
      await this.adapter().DB.prepare("UPDATE operations_control SET games_stopped=1 WHERE id='product'").run();
      const next = (await acceptanceActors(this.adapter(), 'G10'))[0];
      if ((await this.competition().joinQueue(next, 'blitz')).status !== 'closed') throw new Error('proof_acceptance_new_work_not_stopped');
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET closed_admission=1 WHERE id=1'); await this.ctx.storage.sync();
    }
  }
  private async advanceGame(scenario: AcceptanceScenario): Promise<void> {
    const state = this.runtime();
    if (state.failed || state.tier === null || state.tier !== this.adapter().PROOF_ACCEPTANCE_TIER) throw new Error('proof_acceptance_branch_closed');
    if (scenario === 'G00') {
      if (state.tier === 'lite' && !manifest.corpus.fixtures.every(fixture => this.job(fixture.id)?.passed)) throw new Error('proof_acceptance_corpus_incomplete');
      if (state.tier === 'basic' && (!state.fallback || !state.lite_stopped)) throw new Error('proof_acceptance_basic_unqualified');
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET branch_started=1 WHERE id=1'); await this.ctx.storage.sync();
      for (const id of ['G00', 'G01', 'G02', 'G03'] as AcceptanceScenario[]) {
        (await this.store()).claimCommand(id);
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO proof_acceptance_jobs(id) VALUES(?)', id);
      }
      await this.ctx.storage.sync();
    } else if (!this.job(scenario)) {
      const previous = Number(scenario.slice(1)) <= 3 ? ['G00'] : Number(scenario.slice(1)) === 4 ? ['G00', 'G01', 'G02', 'G03']
        : [`G${String(Number(scenario.slice(1)) - 1).padStart(2, '0')}`];
      if (!previous.every(id => this.job(id)?.passed)) throw new Error('proof_acceptance_scenario_order');
      await this.beginGame(scenario);
    } else await this.beginGame(scenario);
    await this.schedule();
  }
  private async observeGame(job: Job): Promise<void> {
    if (!job.game_id || job.deadline === null) return this.beginGame(job.id as AcceptanceScenario);
    const game = this.game(job.game_id); const observation = await game.acceptanceInspect();
    if (!observation.game) throw new Error('proof_acceptance_game_missing');
    if (job.id === 'G08' && observation.game.status === 'pending-adjudication' && observation.replies.length) {
      if ((await game.acceptanceStaleProbes()).some(Boolean)) throw new Error('proof_acceptance_stale_receipt_accepted');
    }
    if (observation.game.status !== 'finished') {
      this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET deliveries=deliveries+1 WHERE id=?', job.id);
      await this.ctx.storage.sync(); return;
    }
    await game.flush(); await this.competition().flush();
    const settlement = await this.competition().acceptanceInspect(job.game_id);
    const technical = ['G07', 'G08', 'G11'].includes(job.id); const result = observation.game.result;
    const once = settlement.results.length === 1 && settlement.slots.length === 1 && settlement.slots[0].released_at !== null
      && settlement.ratings.length === (technical ? 0 : 1);
    let passed = Boolean(result && once && result.status === 'finished' && result.outcome.reason === (technical ? 'technical-void' : 'timeout-proof-win'));
    const faults = (await this.store()).inspect().faultReceipts;
    const required = manifest.faults.filter(fault => fault.command === job.id && !['G08-late-real-receipt', 'G10-lost-stop-ack', 'G11-restart-prover', 'G11-emergency-cleanup'].includes(fault.id));
    passed = passed && required.every(fault => faults.filter(saved => saved.fault === fault.id).length === fault.maximum);
    if (job.id === 'G08' && await game.acceptanceLateReceipt()) passed = false;
    if (job.id === 'G09') { passed = passed && Boolean(this.runtime().closed_admission); await this.admitOpen(); }
    let native;
    if (job.id === 'G07' || job.id === 'G10' || job.id === 'G11') {
      native = job.id === 'G10' ? await this.prover().acceptanceStop('G10') : await this.prover().acceptanceInspect();
      if (job.id === 'G07') {
        const saved = 'diagnostic' in native ? native.diagnostic : null;
        const evidence = saved && typeof saved === 'object' && 'watcher' in saved && typeof saved.watcher === 'string' ? JSON.parse(saved.watcher) : null;
        const receipts = (native as unknown as {
          receipts?: { id: string; game_id: string; attempt: number; result: string | null }[];
        }).receipts ?? [];
        const replies = (observation as unknown as {
          replies: { attempt: number; request: unknown; result: unknown }[];
        }).replies;
        const retained = replies.some(reply => {
          const request = parseProofRequest(reply.request);
          if (!request || request.gameId !== job.game_id || request.attempt !== reply.attempt) return false;
          const delivered = parseProofResult(reply.result, request);
          if (delivered?.verdict !== 'unknown' || delivered.reason !== 'resource-limit') return false;
          const matches = receipts.filter(receipt => receipt.game_id === job.game_id
            && receipt.id === `${request.requestId}:${request.attempt}` && receipt.attempt === request.attempt);
          if (matches.length !== 1 || !matches[0].result) return false;
          try {
            const result = parseProofResult(JSON.parse(matches[0].result), request);
            return result?.verdict === 'unknown' && result.reason === 'resource-limit';
          } catch { return false; }
        });
        passed = passed && retained && evidence?.exitCode === 0 && evidence.stopConfirmed === true && evidence.killed === true
          && Number.isSafeInteger(evidence.pid) && evidence.pid > 1 && Number.isSafeInteger(evidence.group) && evidence.group > 1;
      }
      if (job.id === 'G10') passed = passed && !native.nativeRunning && !native.stopDebt && native.phase === 'idle';
      if (job.id === 'G11') {
        passed = passed && native.stopDebt && native.stopExhausted;
        if (!faults.some(fault => fault.fault === 'G11-restart-prover')) { await this.prover().acceptanceRestart('G11').catch(() => {}); return; }
        const recovered = await this.prover().acceptanceInspect();
        passed = passed && recovered.stopDebt && recovered.stopExhausted && recovered.generation === native.generation;
        const stopped = await this.prover().acceptanceEmergencyCleanup();
        passed = passed && !stopped.nativeRunning && stopped.stopDebt && stopped.stopExhausted;
      }
    }
    this.ctx.storage.sql.exec('UPDATE proof_acceptance_jobs SET complete=1,passed=?,observation=? WHERE id=?', Number(passed), JSON.stringify({ game: observation.game, settlement, native, completedAt: Date.now() }), job.id);
    if (!passed) this.ctx.storage.sql.exec('UPDATE proof_acceptance_runtime SET failed=1 WHERE id=1'); await this.ctx.storage.sync();
  }
  private async schedule(): Promise<void> {
    const status = (await this.store()).inspect(); const pending = this.jobs().filter(job => job.id.startsWith('G') && !job.complete);
    if (status.closed) return this.ctx.storage.deleteAlarm();
    const deadline = Math.min(status.expiresAt!, ...pending.map(job => {
      const due = job.deadline ?? Date.now();
      return due > Date.now() ? due + 50 : job.deliveries < 2 ? Date.now() + 1_000 : Math.max(Date.now() + 1_000, due + 30_050);
    }));
    await this.ctx.storage.setAlarm(Math.min(deadline, status.expiresAt!));
  }
  async command(value: unknown) {
    const command = parseProofAcceptanceCommand(value);
    if (!command) return { ok: false as const, reason: 'invalid-command' as const };
    if (command.operation === 'inspect') return { ok: true as const, status: await this.inspect() };
    if (command.operation === 'stop') return { ok: true as const, receipt: await this.stop() };
    if (!proofAcceptanceExecutionAvailable()) {
      return { ok: false as const, reason: 'execution-unavailable' as const, runnable: false as const };
    }
    return this.run('command', async () => {
      await acceptanceIdentity(this.adapter()); const journal = await this.store();
      if (command.operation === 'arm') {
        const receipt = journal.arm(); await this.ctx.storage.sync(); await this.ctx.storage.setAlarm(receipt.expiresAt!);
        return { ok: true, receipt };
      }
      if (command.operation === 'fault') return { ok: false, reason: 'adapter-only' };
      if (command.operation !== 'advance') return { ok: false, reason: 'invalid-command' };
      const receipt = journal.claimCommand(command.id); await this.ctx.storage.sync();
      if (command.id === 'close-v1') {
        if (!manifest.scenarios.every(scenario => this.job(scenario.id)?.passed)) throw new Error('proof_acceptance_incomplete'); await this.stop();
      } else if (command.id.startsWith('C')) await this.corpus(command.id);
      else if (command.id.startsWith('G')) await this.advanceGame(command.id as AcceptanceScenario);
      else await this.select(command.id);
      return { ok: true, receipt, runtime: this.runtime(), job: this.job(command.id) };
    });
  }
  async alarm(): Promise<void> {
    if (!this.budget) { await this.stop(); return; }
    await this.run('alarm', async () => {
      const journal = await this.store();
      if (!journal.noteAlarm() || journal.inspect().closed) { await this.stop(); return; }
      await this.ctx.storage.sync();
      const burst = this.jobs().filter(job => /^G0[0-3]$/.test(job.id));
      if (burst.length === 4 && burst.some(job => job.deadline === null)) {
        // One preparation per native event bounds nested D1 and RPC work.
        // The final ready commands share a later event so legal clocks start together.
        const unprepared = burst.find(job => job.prepared !== 1);
        if (unprepared) await this.beginGame(unprepared.id as AcceptanceScenario, true);
        else {
          await Promise.all(burst.map(job => this.beginGame(job.id as AcceptanceScenario)));
          const started = this.jobs().filter(job => /^G0[0-3]$/.test(job.id));
          if (started.some(job => job.deadline === null)
            || Math.max(...started.map(job => job.deadline!)) - Math.min(...started.map(job => job.deadline!)) > 5_000) {
            throw new Error('proof_acceptance_burst_not_within_five_seconds');
          }
        }
        await this.schedule(); return;
      }
      for (const job of this.jobs().filter(job => job.id.startsWith('G') && !job.complete)) await this.observeGame(job);
      await this.schedule();
    });
  }
  fetch(): Response { return new Response('Not found', { status: 404 }); }
}
export default { fetch(): Response { return new Response('Not found', { status: 404 }); } } satisfies ExportedHandler<ProofAcceptanceEnv>;

/** Bind this exact entrypoint privately. There is no public HTTP command route. */
export class ProofAcceptanceCaller extends WorkerEntrypoint<{ PROOF_ACCEPTANCE: DurableObjectNamespace<ProofAcceptance> }> {
  async command(input: unknown) {
    const command = parseProofAcceptanceCommand(input);
    if (!command) throw new Error('proof_acceptance_command_invalid');
    return this.env.PROOF_ACCEPTANCE.get(this.env.PROOF_ACCEPTANCE.idFromName(ACCEPTANCE_INSTANCE)).command(command);
  }
  fetch(): Response { return new Response('Not found', { status: 404 }); }
}

/** Private service binding only. Restores remain absent from the public entry. */
export class ProofRecoveryCaller extends WorkerEntrypoint<{ PROOF_ACCEPTANCE: DurableObjectNamespace<ProofAcceptance> }> {
  private control() { return this.env.PROOF_ACCEPTANCE.get(this.env.PROOF_ACCEPTANCE.idFromName(ACCEPTANCE_INSTANCE)); }
  record(input: Parameters<ProofRestoreControl['recoveryRecord']>[0]) { return this.control().recoveryRecord(input); }
  identity() { return this.control().recoveryIdentity(); }
  credits() { return this.control().recoveryCredits(); }
  d1() { return this.control().recoveryD1(); }
  admissions(review: ProofRestoreReview) { return this.control().recoveryAdmissions(review); }
  object(input: Parameters<ProofAcceptance['recoveryObject']>[0]) { return this.control().recoveryObject(input); }
  fetch(): Response { return new Response('Not found', { status: 404 }); }
}
