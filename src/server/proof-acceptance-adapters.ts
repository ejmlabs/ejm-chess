/** Fixed private acceptance adapters. The public product entry never imports this module. */
import manifest from '../../proof/acceptance-manifest.json';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { Game } from './game';
import { Competition } from './competition';
import { TimeoutProver } from './proof-pool';
import type { Env } from './env';
import type { Actor, GameResult, GameSnapshot, InitGame } from '../shared/protocol';
import { PROOF_INSTANCE, PROOF_PROFILE, PROOF_RULES_VERSION, parseProofResult, unknownProof, type TimeoutProofRequest } from './proof-contract';
import { type ProofAcceptanceIdentity, PROOF_ACCEPTANCE_SCOPE, proofAcceptanceManifestDigest,
  proofAcceptanceReviewDigests, proofAcceptanceExecutionAvailable } from './proof-acceptance-journal';
import { validateProofCreditLedger, reapplyProofAttempts, type ProofCreditLedger } from './proof-recovery';
import { ProofAcceptanceBudget } from './proof-acceptance-budget';
import { readJson } from './security';
import { initializeProofRestoreAdapter, installProofRestoreAdapter, type ProofRestoreAdapter } from './proof-recovery-drill';

export const ACCEPTANCE_INSTANCE = 'fixed-proof-acceptance-v1';
const production = new Set(['ebba66c8-3910-4465-a053-426fcb733833', '22831b22f6364e1bb6a5b33a69dbf1a8', 'f1ead0542d9543749e18ec92629bb414']);
const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 3], [1, 2], [4, 7], [5, 6]] as const;
export type AcceptanceScenario = `G${'00' | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11'}`;
interface AcceptanceControl {
  inspect(): Promise<{ manifestMatches: boolean; identityMatches: boolean; armed: boolean; closed: boolean; expiresAt: number | null }>;
  claimAdapterFault(command: string, id: string, ordinal: number): Promise<boolean>;
  claimProofDelivery(): Promise<void>;
}
export interface AcceptanceAdapterEnv extends Env {
  PROOF_ACCEPTANCE: DurableObjectNamespace;
  PROOF_ACCEPTANCE_SCOPE: string;
  PROOF_ACCEPTANCE_SOURCE_REVISION: string;
  PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID: string;
  PROOF_ACCEPTANCE_MANIFEST_SHA256: string;
  PROOF_ACCEPTANCE_EXECUTION: string;
  PROOF_ACCEPTANCE_TIER: 'lite' | 'basic';
  PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID: string;
}

/** A reviewed compiled seal is required. Environment flags alone cannot arm this code. */
export async function acceptanceIdentity(env: AcceptanceAdapterEnv, allowExpired = false): Promise<ProofAcceptanceIdentity> {
  const seal = manifest.sealedRuntimeIdentity as ProofAcceptanceIdentity | null;
  const reviews = proofAcceptanceReviewDigests();
  if (!seal || !reviews || !proofAcceptanceExecutionAvailable()
    || seal.costReviewSha256 !== reviews.costReviewSha256
    || seal.sourcePermitReviewSha256 !== reviews.sourcePermitReviewSha256
    || seal.ownerResidualCostAcceptanceSha256 !== reviews.ownerResidualCostAcceptanceSha256
    || env.PROOF_ACCEPTANCE_SCOPE !== PROOF_ACCEPTANCE_SCOPE || env.PROOF_ACCEPTANCE_EXECUTION !== 'sealed-private'
    || env.PROOF_ACCEPTANCE_SOURCE_REVISION !== seal.sourceDigest
    || env.PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID !== seal.controlNamespaceId
    || seal.manifestDigest !== await proofAcceptanceManifestDigest()
    || env.PROOF_ACCEPTANCE_MANIFEST_SHA256 !== seal.manifestDigest
    || !['lite', 'basic'].includes(env.PROOF_ACCEPTANCE_TIER)
    || env.PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID !== (env.PROOF_ACCEPTANCE_TIER === 'lite' ? seal.liteProverNamespaceId : seal.basicProverNamespaceId)
    || seal.privateCaller !== manifest.privateCaller || seal.scope !== PROOF_ACCEPTANCE_SCOPE
    || !Number.isSafeInteger(seal.expiresAt) || !allowExpired && seal.expiresAt <= Date.now()
    || [seal.databaseId, seal.controlNamespaceId, seal.gameNamespaceId, seal.competitionNamespaceId,
      seal.liteProverNamespaceId, seal.basicProverNamespaceId].some(value => production.has(value))
    || !env.DB || !env.GAME || !env.COMPETITION || !env.PROVER || !env.PROOF_ACCEPTANCE
    || env.ASSETS || env.EMAIL || env.ANALYZER || env.ANALYSIS_QUEUE || env.ANALYSIS_DEAD_LETTER_QUEUE
    || env.NEW_WORK_STOPPED !== 'true' || env.RANKED_ENABLED !== 'false' || env.TOURNAMENTS_ENABLED !== 'false'
    || env.ARENAS_ENABLED !== 'false' || env.AI_ENABLED !== 'false' || env.ANALYSIS_ENABLED !== 'false'
    || env.TIMEOUT_PROOF_PROFILE !== 'off' || env.MONTHLY_PROOF_LIMIT !== '0') {
    throw new Error('proof_acceptance_unsealed');
  }
  return seal;
}

function control(env: AcceptanceAdapterEnv): AcceptanceControl {
  return env.PROOF_ACCEPTANCE.get(env.PROOF_ACCEPTANCE.idFromName(ACCEPTANCE_INSTANCE)) as unknown as AcceptanceControl;
}
async function active(env: AcceptanceAdapterEnv): Promise<ProofAcceptanceIdentity> {
  const seal = await acceptanceIdentity(env);
  const state = await control(env).inspect();
  if (state.manifestMatches !== true || state.identityMatches !== true || !state.armed || state.closed
    || state.expiresAt !== seal.expiresAt) throw new Error('proof_acceptance_closed');
  return seal;
}
function actorId(index: number): string { return `proof-acceptance-account-${index}`; }
function sessionId(index: number): string { return `proof-acceptance-session-${index}`; }
function indexOf(scenario: AcceptanceScenario): number {
  const index = Number(scenario.slice(1));
  if (!/^G(?:0[0-9]|1[01])$/.test(scenario) || !pairs[index]) throw new Error('proof_acceptance_scenario_invalid');
  return index;
}
function scenarioFor(input: InitGame): AcceptanceScenario {
  const index = pairs.findIndex(pair => pair.every(value => [input.white.id, input.black?.id].includes(actorId(value))));
  if (index < 0 || !input.rated || input.format !== 'blitz' || input.ai || input.tournament
    || input.timeoutProof?.profileVersion !== PROOF_PROFILE) throw new Error('proof_acceptance_game_invalid');
  return `G${String(index).padStart(2, '0')}` as AcceptanceScenario;
}

/** Only the isolated composition opens internal ranked calls. No public router exists. */
function productEnv(raw: AcceptanceAdapterEnv): Env {
  return { ...raw, RANKED_ENABLED: 'true', TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '39',
    NEW_WORK_STOPPED: 'false', MONTHLY_GAME_LIMIT: '39', MONTHLY_EMAIL_LIMIT: '0', MONTHLY_ANALYSIS_LIMIT: '0',
    RANKED_GAME_LIMIT: '4', RANKED_RETAINED_GAME_LIMIT: '39', RANKED_QUEUE_LIMIT: '8',
    TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false', AI_ENABLED: 'false', ANALYSIS_ENABLED: 'false' };
}

/** Eight non-login synthetic authority accounts, never real passwords or mail. */
export async function prepareAcceptanceAccounts(env: AcceptanceAdapterEnv): Promise<void> {
  const seal = await active(env);
  const now = new Date().toISOString();
  for (let index = 0; index < 8; index++) {
    const id = actorId(index); const username = `proof_acceptance_${index}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO user(id,name,email,emailVerified,isAnonymous,username,createdAt,updatedAt)
        VALUES(?,?,?,0,0,?,?,?)`).bind(id, username, createPlaceholderEmail({ identifier: id, namespace: 'chess' }), username, now, now),
      env.DB.prepare(`INSERT OR IGNORE INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt)
        VALUES(?,?,'credential',?,'synthetic-authority-not-a-login-hash',?,?)`).bind(`proof-acceptance-credential-${index}`, id, id, now, now),
      env.DB.prepare(`INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt
        WHERE session.userId=excluded.userId AND session.token=excluded.token`)
        .bind(sessionId(index), id, `private-acceptance-session-${index}`, new Date(seal.expiresAt).toISOString(), now, now),
    ]);
  }
}

export async function acceptanceActors(env: AcceptanceAdapterEnv, scenario: AcceptanceScenario): Promise<[Actor, Actor]> {
  const seal = await active(env);
  return pairs[indexOf(scenario)].map(index => ({ id: actorId(index), name: `proof_acceptance_${index}`,
    isAnonymous: false, sessionId: sessionId(index), sessionExpiresAt: seal.expiresAt })) as [Actor, Actor];
}

export class AcceptanceGame extends Game {
  private raw: AcceptanceAdapterEnv;
  readonly acceptanceBudget: ProofAcceptanceBudget;
  constructor(ctx: DurableObjectState, raw: AcceptanceAdapterEnv) {
    const budget = new ProofAcceptanceBudget(ctx, 'Game');
    let owner: AcceptanceGame;
    const env = productEnv(raw); env.DB = budget.d1(raw.DB);
    const prover = raw.PROVER;
    const competition = raw.COMPETITION;
    if (prover) env.PROVER = new Proxy(prover, { get(target, key) {
      if (key === 'get') return (id: DurableObjectId) => {
        const stub = target.get(id);
        return new Proxy(stub, { get(stubTarget, member) {
          if (member === 'fetch') return (request: Request) => owner.proofReply(stubTarget, request);
          const value = Reflect.get(stubTarget, member, stubTarget);
          return typeof value === 'function' ? value.bind(stubTarget) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    if (competition) env.COMPETITION = new Proxy(competition, { get(target, key) {
      if (key === 'get') return (id: DurableObjectId) => {
        const stub = target.get(id);
        return new Proxy(stub, { get(stubTarget, member) {
          if (member === 'settle') return (result: GameResult) => owner.settlementReply(stubTarget, result);
          const value = Reflect.get(stubTarget, member, stubTarget);
          return typeof value === 'function' ? value.bind(stubTarget) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    super(ctx, env, budget.context); owner = this; this.raw = raw; this.acceptanceBudget = budget;
    initializeProofRestoreAdapter(this, { ctx, env: raw, budget, role: 'Game', validate: () => acceptanceIdentity(raw, true) });
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof_acceptance_game(id INTEGER PRIMARY KEY CHECK(id=1),scenario TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof_acceptance_replies(attempt INTEGER PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL)');
    budget.sealBootstrap();
  }
  private scenario(): AcceptanceScenario {
    const row = this.ctx.storage.sql.exec<{ scenario: AcceptanceScenario }>('SELECT scenario FROM proof_acceptance_game WHERE id=1').toArray()[0];
    if (!row) throw new Error('proof_acceptance_game_unconfigured');
    return row.scenario;
  }
  override async init(input: InitGame) {
    await active(this.raw);
    const scenario = scenarioFor(input);
    const saved = this.ctx.storage.sql.exec<{ scenario: string }>('SELECT scenario FROM proof_acceptance_game WHERE id=1').toArray()[0];
    if (saved && saved.scenario !== scenario) throw new Error('proof_acceptance_identity_changed');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO proof_acceptance_game(id,scenario) VALUES(1,?)', scenario);
    await this.ctx.storage.sync();
    return super.init(input);
  }
  private async fault(id: string, ordinal = 1): Promise<boolean> {
    return control(this.raw).claimAdapterFault(this.scenario(), id, ordinal);
  }
  private async proofReply(stub: DurableObjectStub<TimeoutProver>, request: Request): Promise<Response> {
    await active(this.raw);
    const input = await request.clone().json() as TimeoutProofRequest;
    await control(this.raw).claimProofDelivery();
    const response = await stub.fetch(request);
    if (!response.ok) return response;
    const result = parseProofResult(await response.clone().json(), input);
    if (!result) return response;
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO proof_acceptance_replies(attempt,request,result) VALUES(?,?,?)',
      input.attempt, JSON.stringify(input), JSON.stringify(result));
    await this.ctx.storage.sync();
    const scenario = this.scenario();
    if (scenario === 'G00' && await this.fault('G00-duplicate-proof')) {
      await control(this.raw).claimProofDelivery();
      const duplicate = await stub.fetch(new Request('http://proof.internal/prove', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
      if (!duplicate.ok || JSON.stringify(await duplicate.json()) !== JSON.stringify(result)) throw new Error('proof_acceptance_duplicate_changed');
    }
    if (scenario === 'G02' && await this.fault('G02-lost-proof-reply')) {
      const pool = stub as unknown as DurableObjectStub<AcceptanceTimeoutProver>;
      await pool.acceptanceRestartWhenBurstSaved().catch(() => { /* The control requires the saved restart fault receipt. */ });
      throw new Error('proof_acceptance_lost_reply_after_commit');
    }
    if (scenario === 'G06' && await this.fault('G06-lost-proof-reply')) {
      if (await this.fault('G06-restart-game')) this.ctx.abort('proof_acceptance_saved_game_delivery');
      throw new Error('proof_acceptance_lost_reply_after_commit');
    }
    if (scenario === 'G08') {
      // Delivery ordinals are journalled separately from the two search credits.
      for (let delivery = 1; delivery <= 2; delivery++) {
        if (await this.fault('G08-lost-proof-reply', delivery)) throw new Error('proof_acceptance_lost_reply_after_commit');
      }
    }
    return response;
  }
  private async settlementReply(stub: DurableObjectStub<Competition>, result: GameResult) {
    const receipt = await stub.settle(result);
    if (this.scenario() === 'G00' && receipt.accepted && await this.fault('G00-duplicate-result')) {
      if (!(await stub.settle(result)).accepted) throw new Error('proof_acceptance_duplicate_settlement_changed');
    }
    if (this.scenario() === 'G03' && receipt.accepted && await this.fault('G03-lost-settlement-ack')) {
      await (stub as unknown as DurableObjectStub<AcceptanceCompetition>).acceptanceRestart().catch(() => {});
      throw new Error('proof_acceptance_lost_settlement_reply_after_commit');
    }
    return receipt;
  }
  async acceptanceInspect() {
    const game = await this.status();
    const work = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM timeout_proof_work WHERE id=1').toArray()[0];
    const replies = this.ctx.storage.sql.exec<{ attempt: number; request: string; result: string }>(
      'SELECT attempt,request,result FROM proof_acceptance_replies ORDER BY attempt LIMIT 2').toArray();
    return { scenario: this.scenario(), game, work: work ? JSON.parse(work.value) : null,
      replies: replies.map(row => ({ attempt: row.attempt, request: JSON.parse(row.request), result: JSON.parse(row.result) })) };
  }
  async acceptanceLateReceipt(): Promise<boolean> {
    if (this.scenario() !== 'G08') throw new Error('proof_acceptance_scenario_invalid');
    const row = this.ctx.storage.sql.exec<{ result: string }>('SELECT result FROM proof_acceptance_replies ORDER BY attempt LIMIT 1').toArray()[0];
    if (!row || !await this.fault('G08-late-real-receipt')) return false;
    await control(this.raw).claimProofDelivery();
    return this.acceptTimeoutProof(JSON.parse(row.result));
  }
  async acceptanceStaleProbes(): Promise<boolean[]> {
    if (this.scenario() !== 'G08' || !await this.fault('G08-stale-probes')) return [];
    const row = this.ctx.storage.sql.exec<{ result: string }>('SELECT result FROM proof_acceptance_replies ORDER BY attempt LIMIT 1').one();
    const result = JSON.parse(row.result);
    for (let probe = 0; probe < 3; probe++) await control(this.raw).claimProofDelivery();
    return Promise.all([
      this.acceptTimeoutProof({ ...result, pendingVersion: result.pendingVersion + 1 }),
      this.acceptTimeoutProof({ ...result, positionDigest: '0'.repeat(64) }),
      this.acceptTimeoutProof({ ...result, gameId: 'proof-acceptance-unrelated-game' }),
    ]);
  }
}

export class AcceptanceCompetition extends Competition {
  readonly acceptanceBudget: ProofAcceptanceBudget;
  constructor(ctx: DurableObjectState<{}>, private raw: AcceptanceAdapterEnv) {
    const budget = new ProofAcceptanceBudget(ctx, 'Competition');
    const env = productEnv(raw); env.DB = budget.d1(raw.DB);
    super(ctx, env, budget.context); this.acceptanceBudget = budget;
    initializeProofRestoreAdapter(this, { ctx, env: raw, budget, role: 'Competition', validate: () => acceptanceIdentity(raw, true) });
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof_acceptance_pairs(scenario TEXT PRIMARY KEY,game_id TEXT UNIQUE)');
    budget.sealBootstrap();
  }
  async acceptanceJoin(scenario: AcceptanceScenario): Promise<{ status: 'pending' | 'reserved' | 'live' | 'settling'; gameId?: string }> {
    const actors = await acceptanceActors(this.raw, scenario);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO proof_acceptance_pairs(scenario) VALUES(?)', scenario);
    await this.ctx.storage.sync();
    // Reconcile the exact fixed pair before joining. A lost reply can never
    // buy a replacement Game, including after its first Game has finished.
    const matching = () => this.ctx.storage.sql.exec<{ id: string; status: string }>(
      'SELECT id,status FROM matches WHERE (white_id=? AND black_id=?) OR (white_id=? AND black_id=?) LIMIT 2',
      actors[0].id, actors[1].id, actors[1].id, actors[0].id).toArray();
    const existing = matching();
    if (existing.length > 1) throw new Error('proof_acceptance_duplicate_pair');
    if (existing.length) await this.queueStatus(actors[0]);
    else {
      await this.joinQueue(actors[0], 'blitz');
      await this.joinQueue(actors[1], 'blitz');
    }
    const matches = matching();
    if (matches.length > 1) throw new Error('proof_acceptance_duplicate_pair');
    const match = matches[0];
    if (!match) return { status: 'pending' };
    if (existing.length && existing[0].id !== match.id) throw new Error('proof_acceptance_game_replaced');
    this.ctx.storage.sql.exec('UPDATE proof_acceptance_pairs SET game_id=? WHERE scenario=? AND game_id IS NULL', match.id, scenario);
    await this.ctx.storage.sync();
    if (match.status === 'creating') return { status: 'pending', gameId: match.id };
    if (match.status !== 'reserved' && match.status !== 'live' && match.status !== 'settling') throw new Error('proof_acceptance_pair_closed');
    return { status: match.status, gameId: match.id };
  }
  async acceptanceInspect(gameId: string) {
    const match = this.ctx.storage.sql.exec('SELECT id,status,reservation_id FROM matches WHERE id=?', gameId).toArray()[0] ?? null;
    const results = this.ctx.storage.sql.exec('SELECT event_id,digest FROM processed_results WHERE game_id=?', gameId).toArray();
    const ratings = this.ctx.storage.sql.exec('SELECT sequence,score FROM rating_events WHERE game_id=?', gameId).toArray();
    const slots = this.ctx.storage.sql.exec('SELECT profile,released_at FROM ranked_proof_slots WHERE game_id=?', gameId).toArray();
    return { match, results, ratings, slots };
  }
  async acceptanceRestart() {
    await active(this.raw);
    const prover = this.raw.PROVER!.get(this.raw.PROVER!.idFromName(PROOF_INSTANCE)) as unknown as DurableObjectStub<AcceptanceTimeoutProver>;
    await prover.acceptanceWaitForBurstSaved();
    if (!await control(this.raw).claimAdapterFault('G03', 'G03-restart-competition', 1)) return;
    await this.ctx.storage.sync(); this.ctx.abort('proof_acceptance_committed_settlement');
  }
}

export class AcceptanceTimeoutProver extends TimeoutProver {
  readonly acceptanceBudget: ProofAcceptanceBudget;
  declare private acceptanceInitialSchedule?: Promise<void>;
  private current?: AcceptanceScenario;
  private startupException = false;
  constructor(ctx: DurableObjectState<{}>, private raw: AcceptanceAdapterEnv) {
    const budget = new ProofAcceptanceBudget(ctx, 'Prover');
    const env = productEnv(raw); env.DB = budget.d1(raw.DB);
    super(ctx, env, budget.context); this.acceptanceBudget = budget;
    initializeProofRestoreAdapter(this, { ctx, env: raw, budget, role: 'TimeoutProver', validate: () => acceptanceIdentity(raw, true) });
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof_acceptance_native(id INTEGER PRIMARY KEY CHECK(id=1),scenario TEXT,watcher TEXT)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof_acceptance_watcher(scenario TEXT PRIMARY KEY,evidence TEXT NOT NULL)');
    budget.sealBootstrap(this.acceptanceInitialSchedule);
  }
  override scheduleNextAlarm(ms?: number): Promise<void> {
    const scheduled = super.scheduleNextAlarm(ms);
    if (!this.acceptanceBudget) this.acceptanceInitialSchedule = scheduled;
    return scheduled;
  }
  private async fault(name: string, ordinal = 1): Promise<boolean> {
    if (!this.current) throw new Error('proof_acceptance_scenario_unset');
    return control(this.raw).claimAdapterFault(this.current, name, ordinal);
  }
  protected override async native(request: TimeoutProofRequest, signal: AbortSignal) {
    await active(this.raw);
    if (!request.gameId.startsWith('proof-acceptance-corpus-')) {
      const game = this.raw.GAME.get(this.raw.GAME.idFromName(request.gameId)) as unknown as DurableObjectStub<AcceptanceGame>;
      this.current = (await game.acceptanceInspect()).scenario;
    }
    this.ctx.storage.sql.exec('INSERT INTO proof_acceptance_native(id,scenario) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET scenario=excluded.scenario,watcher=NULL', this.current ?? null);
    await this.ctx.storage.sync();
    this.startupException = this.current === 'G04' && await this.fault('G04-before-platform-start');
    try {
      const result = await super.native(request, signal);
      return this.current === 'G11' ? unknownProof(request, 'interrupted') : result;
    }
    finally { this.current = undefined; this.startupException = false; }
  }
  protected override issueNativeStart(): void {
    if (this.startupException) throw new Error('proof_acceptance_startup_exception');
    // Keep the production synchronous fence. Only the sealed fixed tier may
    // select resources; no caller-supplied option reaches this platform API.
    this.ctx.container!.start({ enableInternet: false, instance: this.raw.PROOF_ACCEPTANCE_TIER });
  }
  protected override async nativeTransport(request: Request): Promise<Response> {
    if (this.current === 'G05' && await this.fault('G05-abort-prover')) {
      await this.ctx.storage.sync(); this.ctx.abort('proof_acceptance_charged_native_start');
    }
    if (this.current === 'G11' && await this.fault('G11-before-native-transport')) throw new Error('proof_acceptance_transport_exception');
    if (this.current === 'G07' && await this.fault('G07-kill-solver-child')) {
      // Fixed watcher, unchanged image. It never accepts a PID or command from
      // its caller. Failure to observe the exact child is missing evidence.
      const watcher = await this.ctx.container!.exec(['python3', '-c',
        "import os,time,signal,json,resource\nresource.setrlimit(resource.RLIMIT_AS,(33554432,33554432))\nresource.setrlimit(resource.RLIMIT_NOFILE,(32,32))\nresource.setrlimit(resource.RLIMIT_CPU,(1,1))\nsignal.setitimer(signal.ITIMER_PROF,.25)\nsignal.alarm(3)\nend=time.monotonic()+1\nfound=False\nwhile time.monotonic()<end:\n names=[n for n in os.listdir('/proc') if n.isdigit()]\n if len(names)>128: raise RuntimeError('process-limit')\n for n in names:\n  try:\n   pid=int(n)\n   if os.readlink('/proc/'+n+'/exe')!='/opt/cha/analyzer': continue\n   fields=open('/proc/'+n+'/stat').read().split()\n   group=os.getpgid(pid)\n   parent=int(fields[3])\n   command=open('/proc/'+str(parent)+'/cmdline','rb').read()\n   if group!=parent or group<=1 or group==os.getpgrp() or b'runner.py' not in command or b'--job' not in command: raise RuntimeError('unexpected-process-group')\n   start=fields[21]\n   os.killpg(group,signal.SIGKILL)\n   for check in range(100):\n    try:\n     after=open('/proc/'+n+'/stat').read().split()\n     if after[21]!=start or after[2]=='Z': break\n    except FileNotFoundError: break\n    time.sleep(.001)\n   else: raise RuntimeError('solver-stop-not-confirmed')\n   print(json.dumps({'pid':pid,'group':group,'start':start,'killed':True,'stopConfirmed':True}),flush=True)\n   found=True\n   break\n  except FileNotFoundError: pass\n if found: break\n time.sleep(.001)\nif not found: raise RuntimeError('solver-child-not-observed')"],
        { stdout: 'pipe', stderr: 'combined', signal: AbortSignal.any([request.signal, AbortSignal.timeout(3_000)]) });
      const outputs = Promise.allSettled([readJson<Record<string, unknown>>(new Response(watcher.stdout), 4096), watcher.exitCode]);
      try {
        const response = await super.nativeTransport(request);
        const [observation, exit] = await outputs;
        if (observation.status !== 'fulfilled' || exit.status !== 'fulfilled') throw new Error('proof_acceptance_watcher_unverified');
        const evidence = JSON.stringify({ ...observation.value, exitCode: exit.value });
        if (evidence.length > 2048) throw new Error('proof_acceptance_watcher_output_limit');
        this.ctx.storage.sql.exec('UPDATE proof_acceptance_native SET watcher=? WHERE id=1', evidence);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO proof_acceptance_watcher(scenario,evidence) VALUES('G07',?)", evidence);
        await this.ctx.storage.sync();
        return response;
      } finally { try { watcher.kill(9); } catch { /* A completed watcher has no live process to stop. */ } }
    }
    return super.nativeTransport(request);
  }
  protected override async stopNative(): Promise<void> {
    if (this.current === 'G10' && await this.fault('G10-lost-stop-ack')) {
      await super.stopNative(); throw new Error('proof_acceptance_lost_stop_ack_after_destroy');
    }
    if (this.current === 'G11') {
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        if (await this.fault('G11-stop-error', ordinal)) throw new Error('proof_acceptance_stop_exception');
      }
    }
    return super.stopNative();
  }
  async acceptanceRestart(scenario: 'G02' | 'G11') {
    await active(this.raw);
    const id = scenario === 'G02' ? 'G02-restart-completed-prover' : 'G11-restart-prover';
    if (!await control(this.raw).claimAdapterFault(scenario, id, 1)) return;
    await this.ctx.storage.sync(); this.ctx.abort('proof_acceptance_native_restart');
  }
  async acceptanceStop(scenario?: 'G10') {
    if (scenario) this.current = scenario;
    try { await this.stop('SIGKILL'); }
    finally { this.current = undefined; }
    return { ...this.lifecycleStatus(), nativeRunning: this.nativeRunning() };
  }
  async acceptanceInspect() {
    const receipts = this.ctx.storage.sql.exec<{ id: string; game_id: string; attempt: number; result: string | null }>(
      'SELECT id,game_id,attempt,result FROM proof_attempts ORDER BY id LIMIT 79').toArray();
    if (receipts.length > 78) throw new Error('proof_acceptance_receipt_limit');
    return { ...this.lifecycleStatus(), nativeRunning: this.nativeRunning(), receipts,
      diagnostic: this.ctx.storage.sql.exec('SELECT scenario,evidence AS watcher FROM proof_acceptance_watcher WHERE scenario=\'G07\'').toArray()[0] ?? null };
  }
  async acceptanceWaitForBurstSaved() {
    for (let read = 0; read < 8; read++) {
      const saved = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM proof_attempts WHERE game_id NOT LIKE 'proof-acceptance-corpus-%' AND result IS NOT NULL").one().count;
      if (saved >= 4) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('proof_acceptance_burst_receipts_missing');
  }
  async acceptanceRestartWhenBurstSaved() {
    await this.acceptanceWaitForBurstSaved();
    return this.acceptanceRestart('G02');
  }
  async acceptanceEmergencyCleanup() {
    if (!await control(this.raw).claimAdapterFault('G11', 'G11-emergency-cleanup', 1)) {
      return { ...this.lifecycleStatus(), nativeRunning: this.nativeRunning() };
    }
    await this.ctx.container!.destroy();
    return { ...this.lifecycleStatus(), nativeRunning: this.nativeRunning() };
  }
  async acceptanceReapplyCredits(ledger: ProofCreditLedger) {
    await acceptanceIdentity(this.raw);
    await validateProofCreditLedger(ledger);
    await this.stop('SIGKILL');
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => reapplyProofAttempts(this.ctx.storage.sql, ledger));
      await this.ctx.storage.sync();
    });
    return { ...this.lifecycleStatus(), nativeRunning: this.nativeRunning() };
  }
}

// Only these entry points are used by the fixed private caller and the actual
// product authorities. A direct inherited method with no event cannot touch
// the guarded product SQL, D1 or alarms. Nested product calls share one permit.
for (const [constructor, methods] of [
  [AcceptanceGame, ['init', 'snapshot', 'status', 'command', 'flush', 'acceptTimeoutProof', 'resolveTimeoutProof', 'alarm',
    'captureRecoveryPoint', 'acceptanceInspect', 'acceptanceLateReceipt', 'acceptanceStaleProbes']],
  [AcceptanceCompetition, ['joinQueue', 'queueStatus', 'settle', 'flush', 'maintenance', 'alarm', 'hasTimeoutProofReservation',
    'captureRecoveryPoint', 'acceptanceJoin', 'acceptanceInspect', 'acceptanceRestart']],
  [AcceptanceTimeoutProver, ['fetch', 'alarm', 'start', 'startAndWaitForPorts', 'stop', 'onActivityExpired', 'onStop', 'expireProofAllocation',
    'captureRecoveryPoint', 'proofRecoveryState', 'acceptanceRestart', 'acceptanceStop', 'acceptanceInspect',
    'acceptanceWaitForBurstSaved', 'acceptanceRestartWhenBurstSaved', 'acceptanceEmergencyCleanup', 'acceptanceReapplyCredits']],
] as const) {
  for (const method of methods) {
    const prototype = constructor.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const invoke = prototype[method];
    Object.defineProperty(prototype, method, { configurable: true, writable: true,
      value: function(this: { acceptanceBudget: ProofAcceptanceBudget }, ...args: unknown[]) {
        return this.acceptanceBudget.run(method, () => invoke.apply(this, args));
      } });
  }
}

export interface AcceptanceGame extends ProofRestoreAdapter {}
export interface AcceptanceCompetition extends ProofRestoreAdapter {}
export interface AcceptanceTimeoutProver extends ProofRestoreAdapter {}
for (const constructor of [AcceptanceGame, AcceptanceCompetition, AcceptanceTimeoutProver]) installProofRestoreAdapter(constructor.prototype);

/** Public legal commands only. No clock, position, receipt or authority write. */
export async function readyAcceptanceGame(env: AcceptanceAdapterEnv, scenario: AcceptanceScenario,
  gameId: string, prepareOnly = false): Promise<GameSnapshot> {
  const actors = await acceptanceActors(env, scenario);
  const game = env.GAME.get(env.GAME.idFromName(gameId));
  let snapshot: GameSnapshot = await game.snapshot(actors[0]);
  const white = actors.find(actor => actor.id === snapshot.white.id)!;
  const black = actors.find(actor => actor.id !== snapshot.white.id)!;
  for (const actor of [white, black]) {
    if (prepareOnly && actor.id === black.id) continue;
    if (snapshot.status === 'active' || (actor.id === white.id ? snapshot.white.ready : snapshot.black?.ready)) continue;
    const reply = await game.command(actor, { type: 'ready', id: `acceptance-${scenario}-${actor.id}-ready`, expectedVersion: snapshot.version });
    if (!reply.ok) throw new Error(`proof_acceptance_ready_${reply.code}`);
    snapshot = reply.snapshot;
  }
  if (prepareOnly) {
    if (snapshot.status !== 'ready' || !snapshot.white.ready || snapshot.black?.ready) throw new Error('proof_acceptance_prepared_state_invalid');
    return snapshot;
  }
  if ((scenario === 'G01' || scenario === 'G03') && snapshot.moves.length === 0) {
    const moved = await game.command(white, { type: 'move', id: `acceptance-${scenario}-e2e4`, expectedVersion: snapshot.version, from: 'e2', to: 'e4' });
    if (!moved.ok) throw new Error(`proof_acceptance_move_${moved.code}`);
    snapshot = moved.snapshot;
  }
  if (snapshot.rulesVersion !== PROOF_RULES_VERSION || snapshot.status !== 'active' || snapshot.clocks.deadline === null) {
    throw new Error('proof_acceptance_active_state_invalid');
  }
  return snapshot;
}
