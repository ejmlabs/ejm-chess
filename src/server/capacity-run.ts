import { DurableObject } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CapacityNativeMeter, CAPACITY_D1_READ_ATTEMPTS, CAPACITY_WARM_D1_READ_ROWS } from './capacity-meter';
import type { CapacityWorkflowPlan } from './capacity-workflow';
import { CAPACITY_CONTROL_HTTP_REQUESTS, CAPACITY_INGRESS_BLOCK_REQUESTS,
  CAPACITY_REGISTRATION_DIAGNOSTIC, capacityRegistrationDiagnosticSchedule } from '../shared/capacity-corpus';
export { CAPACITY_CONTROL_HTTP_REQUESTS, CAPACITY_INGRESS_BLOCK_REQUESTS } from '../shared/capacity-corpus';

export const CAPACITY_CEILINGS = Object.freeze({
  chargedGames: 20_000, accounts: 6_000, workerRequests: 1_200_000,
  nativeDoRequests: 1_000_000, workerCpuMs: 60_000_000,
  doRowsWritten: 5_000_000, doRowsRead: 500_000_000,
  d1RowsWritten: 1_000_000, d1RowsRead: 100_000_000,
  doStorageBytes: 3 * 1024 ** 3, d1StorageBytes: 512 * 1024 ** 2,
  activeObjects: 2_048, durationMs: 3_600_000,
});
export type CapacityWork = Pick<typeof CAPACITY_CEILINGS,
  'workerRequests' | 'nativeDoRequests' | 'workerCpuMs' | 'doRowsWritten' | 'doRowsRead'
  | 'd1RowsWritten' | 'd1RowsRead' | 'doStorageBytes' | 'd1StorageBytes'>;
export type CapacityWorkUnits = { -readonly [K in keyof CapacityWork]: number };
const WORK_KEYS = ['workerRequests', 'nativeDoRequests', 'workerCpuMs', 'doRowsWritten', 'doRowsRead',
  'd1RowsWritten', 'd1RowsRead', 'doStorageBytes', 'd1StorageBytes'] as const;
export const emptyCapacityWork = (): CapacityWorkUnits => Object.fromEntries(WORK_KEYS.map(key => [key, 0])) as CapacityWorkUnits;
export const CAPACITY_INGRESS_AUTH_STARTUP_ROWS = 640;

export interface CapacityManifest {
  schema: 'ejm-chess-capacity-v1';
  profile?: 'registration-diagnostic-v1';
  runId: string;
  digest: string;
  sourceDigest: string;
  configDigest: string;
  databaseId: string;
  gameNamespaceId: string;
  competitionNamespaceId: string;
  controllerNamespaceId: string;
  workerName: string;
  host: string;
  earliestArmAt: number;
  latestArmAt: number;
  setupEndsAt: number;
  streamStartsAt: number;
  streamEndsAt: number;
  admissionsCloseAt: number;
  issueCloseAt: number;
  hardCloseAt: number;
  retentionEndsAt: number;
  /** Source review, focused native safety and exact provider inputs supply these. */
  verified: {
    allNativePaths: true;
    worstNextOperation: true;
    nativeActivePermits: true;
    focusedLocalSafety: true;
    exactResourceReadback: true;
    ownerApprovedFrozenRun: true;
  };
}

/** No manifest can be supplied by HTTP or environment. A reviewed build replaces this file. */
export const SEALED_CAPACITY_MANIFEST: CapacityManifest | null = null;

export const CAPACITY_CONTROL_METHODS = ['arm', 'stop', 'status', 'available', 'reserveIngress', 'charge',
  'linkGame', 'begin', 'complete', 'prepareRetirement', 'confirmRetirement', 'confirmShutdown'] as const;
export type CapacityControlMethod = typeof CAPACITY_CONTROL_METHODS[number];
export interface CapacityControllerPlan {
  methods: Record<CapacityControlMethod, { maximumCalls: number; envelope: CapacityWorkUnits }>;
  /** The frozen caller must include failed and denied cold deliveries. */
  maximumIncarnations: number;
  bootstrapEnvelope: CapacityWorkUnits;
  maximumPhysicalBytes: number;
  /** All native workflows are permanently paid at arm, with no refunds. */
  runWork?: CapacityWorkUnits;
  workflows?: { Game: CapacityWorkflowPlan; Competition: CapacityWorkflowPlan };
}
/** Complete corpus counts and native retained-state measurements must supply this. */
export const VERIFIED_CONTROLLER_PLAN: CapacityControllerPlan | null = null;

interface RunRow extends Record<string, SqlStorageValue> {
  digest: string; manifest: string; controller_plan: string; armed_at: number; last_now: number; stop_reason: string | null;
  controller_calls: string; controller_incarnations: number;
  charges: number; active_objects: number; unresolved_dispatches: number; reserved: string; observed: string;
}
type RunUpdate = Partial<Pick<RunRow, 'controller_calls' | 'controller_incarnations' | 'last_now' | 'stop_reason'
  | 'charges' | 'active_objects' | 'unresolved_dispatches' | 'reserved' | 'observed'>>;
type SynchronousResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
interface PermitRow extends Record<string, SqlStorageValue> {
  object_key: string; open: number; unresolved: number; generation: number;
  retiring_nonce: string | null; trigger_uncertain: number;
}
interface DispatchRow extends Record<string, SqlStorageValue> {
  id: string; object_key: string; generation: number; operation: string; mode: string;
  envelope: string; completed: number; observed: string | null;
}
export interface CapacityDrain {
  pendingNative: number; alarm: boolean; sockets: number; alarmPossible: boolean; socketPossible: boolean;
}
export interface CapacityDispatch {
  runId: string; manifestDigest: string; id: string; objectKey: string;
  generation: number; operation: string; mode: 'rpc' | 'automatic' | 'workflow';
}
export interface CapacityRetirement {
  runId: string; manifestDigest: string; objectKey: string; generation: number; nonce: string;
}
export type CapacityTicket<T> = T & { signature: string };
export interface CapacityShutdownReceipt {
  at: number; games: number; socketWorkflows: number; pendingNative: number;
  gameOutboxes: number; competitionOutboxes: number; projectionBuilds: number;
  unfinishedGames: number; sockets: number; alarms: number;
  registration?: { fixtures: number; entrants: number; steps: number; queues: number };
}

function dispatchIdentity(value: CapacityDispatch): string {
  return JSON.stringify(['ejm-chess-capacity-dispatch-v1', value.runId, value.manifestDigest,
    value.id, value.objectKey, value.generation, value.operation, value.mode]);
}
function retirementIdentity(value: CapacityRetirement): string {
  return JSON.stringify(['ejm-chess-capacity-retirement-v1', value.runId, value.manifestDigest,
    value.objectKey, value.generation, value.nonce]);
}
const encoder = new TextEncoder();
/** The fresh private AUTH_SECRET is domain separated from account operations. */
export class CapacityTicketCodec {
  private key: Promise<CryptoKey>;
  constructor(secret: string) {
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('capacity_ticket_secret_invalid');
    this.key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  private async sign(identity: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await this.key, encoder.encode(identity)));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  private async verify(identity: string, signature: string): Promise<boolean> {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), value => value.charCodeAt(0));
    return crypto.subtle.verify('HMAC', await this.key, bytes, encoder.encode(identity));
  }
  async dispatch(value: CapacityDispatch): Promise<CapacityTicket<CapacityDispatch>> {
    return { ...value, signature: await this.sign(dispatchIdentity(value)) };
  }
  async validDispatch(value: CapacityTicket<CapacityDispatch>, manifest: CapacityManifest,
    objectKey: string, operation: string): Promise<boolean> {
    return Boolean(value && value.runId === manifest.runId && value.manifestDigest === manifest.digest
      && value.objectKey === objectKey && value.operation === operation && validId(value.id)
      && Number.isSafeInteger(value.generation) && value.generation > 0
      && (value.mode === 'rpc' || value.mode === 'automatic' || value.mode === 'workflow')
      && await this.verify(dispatchIdentity(value), value.signature));
  }
  async retirement(value: CapacityRetirement): Promise<CapacityTicket<CapacityRetirement>> {
    return { ...value, signature: await this.sign(retirementIdentity(value)) };
  }
  async validRetirement(value: CapacityTicket<CapacityRetirement>, manifest: CapacityManifest): Promise<boolean> {
    return Boolean(value && value.runId === manifest.runId && value.manifestDigest === manifest.digest
      && /^game:[\w-]{8,100}$/.test(value.objectKey) && Number.isSafeInteger(value.generation)
      && value.generation > 0 && /^[a-f0-9-]{36}$/.test(value.nonce)
      && await this.verify(retirementIdentity(value), value.signature));
  }
}
export function capacityRetirementAck(value: CapacityRetirement): string {
  return `capacity-retired:${value.runId}:${value.objectKey}:${value.generation}:${value.nonce}`;
}

function manifestIdentity(manifest: CapacityManifest): string {
  return JSON.stringify([manifest.schema, manifest.runId, manifest.digest, manifest.sourceDigest, manifest.configDigest,
    manifest.databaseId, manifest.gameNamespaceId, manifest.competitionNamespaceId, manifest.controllerNamespaceId,
    manifest.workerName, manifest.host, manifest.earliestArmAt, manifest.latestArmAt, manifest.setupEndsAt,
    manifest.streamStartsAt, manifest.streamEndsAt, manifest.admissionsCloseAt, manifest.issueCloseAt,
    manifest.hardCloseAt, manifest.retentionEndsAt, manifest.verified, manifest.profile ?? null]);
}

function validWork(value: CapacityWorkUnits): boolean {
  return value && Object.keys(value).length === WORK_KEYS.length
    && WORK_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= CAPACITY_CEILINGS[key]);
}
function equalWork(left: CapacityWorkUnits, right: CapacityWorkUnits): boolean { return WORK_KEYS.every(key => left[key] === right[key]); }
function validId(value: string): boolean { return /^[A-Za-z0-9_:.-]{1,200}$/.test(value); }
function controllerPlanIdentity(plan: CapacityControllerPlan): string {
  return JSON.stringify([plan.maximumPhysicalBytes, plan.maximumIncarnations, WORK_KEYS.map(key => plan.bootstrapEnvelope[key]),
    CAPACITY_CONTROL_METHODS.map(method =>
    [method, plan.methods[method].maximumCalls, WORK_KEYS.map(key => plan.methods[method].envelope[key])]),
    plan.runWork ?? null, plan.workflows ?? null]);
}
type ControllerCalls = Record<CapacityControlMethod, number>;
const emptyControllerCalls = (): ControllerCalls => Object.fromEntries(CAPACITY_CONTROL_METHODS.map(method => [method, 0])) as ControllerCalls;
function controllerCalls(value: string, plan: CapacityControllerPlan): ControllerCalls | null {
  let parsed: ControllerCalls;
  try { parsed = JSON.parse(value) as ControllerCalls; } catch { return null; }
  return parsed && Object.keys(parsed).length === CAPACITY_CONTROL_METHODS.length
    && CAPACITY_CONTROL_METHODS.every(method => Number.isSafeInteger(parsed[method]) && parsed[method] >= 0
      && parsed[method] <= plan.methods[method].maximumCalls) ? parsed : null;
}
/** Prepay the whole finite controller plan. No recursive self-metering refunds. */
export function capacityControllerAllowance(plan: CapacityControllerPlan): CapacityWorkUnits | null {
  if (!plan || !Number.isSafeInteger(plan.maximumPhysicalBytes) || plan.maximumPhysicalBytes < 1
    || plan.maximumPhysicalBytes > CAPACITY_CEILINGS.doStorageBytes
    || Object.keys(plan.methods ?? {}).length !== CAPACITY_CONTROL_METHODS.length
    || !Number.isSafeInteger(plan.maximumIncarnations) || plan.maximumIncarnations < 1
    || plan.maximumIncarnations > CAPACITY_CEILINGS.nativeDoRequests || !validWork(plan.bootstrapEnvelope)
    || WORK_KEYS.some(key => key !== 'doRowsRead' && key !== 'doRowsWritten' && plan.bootstrapEnvelope[key] !== 0)) return null;
  const total = { ...emptyCapacityWork(), doStorageBytes: plan.maximumPhysicalBytes };
  total.workerRequests = CAPACITY_CONTROL_HTTP_REQUESTS;
  total.workerCpuMs = CAPACITY_CONTROL_HTTP_REQUESTS * 50;
  if (plan.runWork && (!validWork(plan.runWork) || !plan.workflows)) return null;
  if (plan.workflows && (!plan.runWork || ['Game', 'Competition'].some(kind => {
    const workflow = plan.workflows![kind as 'Game' | 'Competition'];
    return !workflow || !Number.isSafeInteger(workflow.maximumEvents) || workflow.maximumEvents < 1
      || !validWork(workflow.envelope) || !validWork(workflow.maximumEventWork)
      || WORK_KEYS.some(key => workflow.maximumEventWork[key] > workflow.envelope[key]);
  }))) return null;
  if (plan.runWork) for (const key of WORK_KEYS) total[key] += plan.runWork[key];
  for (const key of WORK_KEYS) {
    total[key] += plan.maximumIncarnations * plan.bootstrapEnvelope[key];
    if (!Number.isSafeInteger(total[key]) || total[key] > CAPACITY_CEILINGS[key]) return null;
  }
  for (const method of CAPACITY_CONTROL_METHODS) {
    const item = plan.methods[method];
    if (!item || !Number.isSafeInteger(item.maximumCalls) || item.maximumCalls < 0
      || item.maximumCalls > CAPACITY_CEILINGS.nativeDoRequests || !validWork(item.envelope)
      || item.envelope.nativeDoRequests !== 1 || item.envelope.workerRequests !== 0 || item.envelope.workerCpuMs !== 0
      || item.envelope.d1RowsRead !== 0 || item.envelope.d1RowsWritten !== 0
      || item.envelope.d1StorageBytes !== 0 || item.envelope.doStorageBytes !== 0) return null;
    for (const key of WORK_KEYS) {
      total[key] += item.maximumCalls * item.envelope[key];
      if (!Number.isSafeInteger(total[key]) || total[key] > CAPACITY_CEILINGS[key]) return null;
    }
  }
  // A newly latched stop can add one final singleton write. Every finite
  // delivery also funds its possible final conditional stop read. These tails
  // are outside ordinary method envelopes and never require a metering RPC.
  total.doRowsWritten++;
  total.doRowsRead += CAPACITY_CONTROL_METHODS.reduce((sum, method) => sum + plan.methods[method].maximumCalls, 0);
  if (WORK_KEYS.some(key => total[key] > CAPACITY_CEILINGS[key])) return null;
  return plan.methods.arm.maximumCalls >= 1 ? total : null;
}
function manifestValid(manifest: CapacityManifest): boolean {
  const m = manifest;
  const timestamps = [m.earliestArmAt, m.latestArmAt, m.setupEndsAt, m.streamStartsAt, m.streamEndsAt,
    m.admissionsCloseAt, m.issueCloseAt, m.hardCloseAt, m.retentionEndsAt];
  let scheduleValid: boolean;
  if (m.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile) {
    try {
      scheduleValid = Object.entries(capacityRegistrationDiagnosticSchedule(m.earliestArmAt))
        .every(([key, value]) => m[key as keyof CapacityManifest] === value);
    } catch { scheduleValid = false; }
  } else scheduleValid = m.profile === undefined
    && m.earliestArmAt <= m.latestArmAt && m.latestArmAt <= m.setupEndsAt - 60_000
    && m.setupEndsAt <= m.earliestArmAt + 600_000 && m.streamStartsAt >= m.setupEndsAt
    && m.streamEndsAt - m.streamStartsAt === 900_000 && m.streamEndsAt <= m.admissionsCloseAt
    && m.admissionsCloseAt <= m.earliestArmAt + 1_800_000 && m.admissionsCloseAt <= m.issueCloseAt
    && m.issueCloseAt <= m.earliestArmAt + 2_700_000 && m.issueCloseAt <= m.hardCloseAt
    && m.hardCloseAt <= m.earliestArmAt + CAPACITY_CEILINGS.durationMs;
  return m.schema === 'ejm-chess-capacity-v1' && /^[a-f0-9-]{36}$/.test(m.runId)
    && [m.digest, m.sourceDigest, m.configDigest].every(value => /^[a-f0-9]{64}$/.test(value))
    && /^[a-f0-9-]{36}$/.test(m.databaseId)
    && [m.gameNamespaceId, m.competitionNamespaceId, m.controllerNamespaceId].every(value => /^[a-f0-9]{32}$/.test(value))
    && /^ejm-chess-capacity-[a-z0-9-]{8,64}$/.test(m.workerName)
    && /^[a-z0-9-]+\.ejmlabs\.com$/.test(m.host) && m.host !== 'chess.ejmlabs.com'
    && timestamps.every(value => Number.isSafeInteger(value) && value > 0)
    && scheduleValid
    && m.retentionEndsAt === m.earliestArmAt + 30 * 86_400_000
    && Object.keys(m.verified).length === 6 && Object.values(m.verified).every(value => value === true);
}

/**
 * Single SQLite authority. Tests use the same native store with a local sealed
 * fixture. The exported object below always uses the compiled manifest.
 * Callers cannot set clocks, ceilings, resource IDs or policy through RPC.
 */
export class CapacityRunStore {
  private pendingRun: { row: RunRow; updates: RunUpdate } | null = null;
  private fusingRun = false;
  private controllerPlan: CapacityControllerPlan | null = null;
  constructor(private sql: SqlStorage, private transact: <T>(run: () => T) => T,
    private manifest: CapacityManifest | null, private now: () => number = Date.now) {
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_run(id INTEGER PRIMARY KEY CHECK(id=1),digest TEXT NOT NULL,manifest TEXT NOT NULL,controller_plan TEXT NOT NULL,
      controller_calls TEXT NOT NULL,controller_incarnations INTEGER NOT NULL,
      armed_at INTEGER NOT NULL,last_now INTEGER NOT NULL,stop_reason TEXT,charges INTEGER NOT NULL,
      active_objects INTEGER NOT NULL,unresolved_dispatches INTEGER NOT NULL,reserved TEXT NOT NULL,observed TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_charges(receipt_id TEXT PRIMARY KEY,units INTEGER NOT NULL,charged_at INTEGER NOT NULL) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_game_ids(game_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL) WITHOUT ROWID`);
    sql.exec('CREATE INDEX IF NOT EXISTS capacity_receipt_games ON capacity_game_ids(receipt_id,game_id)');
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_permits(object_key TEXT PRIMARY KEY,open INTEGER NOT NULL,unresolved INTEGER NOT NULL,
      generation INTEGER NOT NULL,retiring_nonce TEXT,trigger_uncertain INTEGER NOT NULL) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_dispatches(id TEXT PRIMARY KEY,object_key TEXT NOT NULL,generation INTEGER NOT NULL,
      operation TEXT NOT NULL,mode TEXT NOT NULL,envelope TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,observed TEXT) WITHOUT ROWID`);
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS capacity_workflow_object ON capacity_dispatches(object_key) WHERE mode='workflow'");
    sql.exec('CREATE TABLE IF NOT EXISTS capacity_native_shutdown(id INTEGER PRIMARY KEY CHECK(id=1),receipt TEXT NOT NULL)');
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_retirements(object_key TEXT NOT NULL,generation INTEGER NOT NULL,
      nonce TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(object_key,generation)) WITHOUT ROWID`);
    sql.exec('CREATE TABLE IF NOT EXISTS capacity_object_storage(object_key TEXT PRIMARY KEY,peak_bytes INTEGER NOT NULL) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS capacity_ingress_blocks(id TEXT PRIMARY KEY,charged_at INTEGER NOT NULL) WITHOUT ROWID');
  }

  private row(): RunRow | null {
    return this.pendingRun ? { ...this.pendingRun.row, ...this.pendingRun.updates }
      : this.sql.exec<RunRow>('SELECT * FROM capacity_run WHERE id=1').toArray()[0] ?? null;
  }

  private updateRun(updates: RunUpdate): void {
    if (this.pendingRun) { Object.assign(this.pendingRun.updates, updates); return; }
    const fields = Object.entries(updates);
    if (fields.length) this.sql.exec(`UPDATE capacity_run SET ${fields.map(([key]) => `${key}=?`).join(',')} WHERE id=1`,
      ...fields.map(([, value]) => value as SqlStorageValue));
  }

  private transaction<T>(work: () => T): T {
    const pending = this.pendingRun;
    const updates = pending ? { ...pending.updates } : null;
    try { return this.transact(work); }
    catch (error) {
      if (pending && updates) pending.updates = updates;
      throw error;
    }
  }

  /** Commit a synchronous call claim even when its separate operation rolls back. */
  fuseRunUpdates<T>(work: () => T): SynchronousResult<T> {
    if (this.fusingRun) throw new Error('capacity_controller_reentrant');
    this.fusingRun = true;
    try {
      return this.transact(() => {
        const row = this.row();
        this.pendingRun = row ? { row, updates: {} } : null;
        let result: SynchronousResult<T>;
        try { result = { ok: true, value: work() }; }
        catch (error) { result = { ok: false, error }; }
        const updates = this.pendingRun?.updates;
        this.pendingRun = null;
        if (updates) this.updateRun(updates);
        return result;
      });
    } finally { this.pendingRun = null; this.fusingRun = false; }
  }
  private live(row: RunRow, admission = false): boolean {
    if (!this.manifest || row.digest !== this.manifest.digest || row.manifest !== manifestIdentity(this.manifest)) return false;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < row.last_now) { this.stop('clock-regressed'); return false; }
    if (now >= this.manifest.issueCloseAt) { this.stop('work-expired'); return false; }
    if (now > row.last_now) { this.updateRun({ last_now: now }); row.last_now = now; }
    if (admission && now >= this.manifest.admissionsCloseAt) { this.stop('admission-expired'); return false; }
    return !admission || row.stop_reason === null;
  }

  arm(controllerPlan?: CapacityControllerPlan): boolean {
    if (controllerPlan) return this.enterController('arm', controllerPlan, true)?.armedNow ?? false;
    return this.transaction(() => {
      if (this.row() || !this.manifest || !manifestValid(this.manifest)) return false;
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < this.manifest.earliestArmAt || now > this.manifest.latestArmAt) return false;
      this.insertRun(now, null, emptyCapacityWork(), emptyControllerCalls(), 0);
      return true;
    });
  }

  private insertRun(now: number, plan: CapacityControllerPlan | null, allowance: CapacityWorkUnits,
    calls: ControllerCalls, incarnations: number): void {
    const work = JSON.stringify(emptyCapacityWork());
    this.sql.exec(`INSERT INTO capacity_run(id,digest,manifest,controller_plan,controller_calls,controller_incarnations,
      armed_at,last_now,stop_reason,charges,active_objects,unresolved_dispatches,reserved,observed)
      VALUES(1,?,?,?,?,?,?,?,NULL,0,2,0,?,?)`,
    this.manifest!.digest, manifestIdentity(this.manifest!), plan ? controllerPlanIdentity(plan) : '',
    JSON.stringify(calls), incarnations, now, now, work, JSON.stringify(allowance));
    // Controller and Competition always retain two duration permits.
    this.sql.exec("INSERT INTO capacity_permits VALUES('controller',1,0,1,NULL,0),('competition',1,0,1,NULL,0)");
  }

  /**
   * First arm funding, its call slot and first incarnation commit together.
   * A later cold incarnation is consumed before ordinary method work, even
   * when that method is denied. Call and clock updates share one row write.
   */
  enterController(method: CapacityControlMethod, plan: CapacityControllerPlan, cold: boolean):
    { allowed: boolean; armedNow: boolean; incarnationClaimed: boolean } | null {
    const allowance = capacityControllerAllowance(plan);
    if (!allowance || !CAPACITY_CONTROL_METHODS.includes(method)) return null;
    this.controllerPlan = plan;
    return this.transaction(() => {
      const row = this.row();
      if (!row) {
        if (method !== 'arm' || !this.manifest || !manifestValid(this.manifest)) return null;
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < this.manifest.earliestArmAt || now > this.manifest.latestArmAt) return null;
        const calls = emptyControllerCalls(); calls.arm = 1;
        this.insertRun(now, plan, allowance, calls, 1);
        return { allowed: true, armedNow: true, incarnationClaimed: true };
      }
      if (!this.manifest || row.manifest !== manifestIdentity(this.manifest)
        || row.controller_plan !== controllerPlanIdentity(plan)) return null;
      const calls = controllerCalls(row.controller_calls, plan);
      if (!calls || !Number.isSafeInteger(row.controller_incarnations) || row.controller_incarnations < 1
        || row.controller_incarnations > plan.maximumIncarnations) {
        this.stop('controller-ledger-invalid'); return null;
      }
      if (cold && row.controller_incarnations >= plan.maximumIncarnations) {
        this.stop('controller-incarnation-allowance'); return null;
      }
      const now = this.now();
      const regressed = !Number.isSafeInteger(now) || now < row.last_now;
      const expired = Number.isSafeInteger(now) && now >= this.manifest.hardCloseAt;
      const allowed = !regressed && !expired && calls[method] < plan.methods[method].maximumCalls;
      if (allowed) calls[method]++;
      this.updateRun({ controller_calls: JSON.stringify(calls), controller_incarnations: row.controller_incarnations + (cold ? 1 : 0),
        last_now: regressed ? row.last_now : now });
      if (!allowed) this.stop(regressed ? 'clock-regressed' : expired ? 'compute-expired' : 'controller-call-allowance');
      return { allowed, armedNow: false, incarnationClaimed: cold };
    });
  }

  /** All cost is already paid at arm. Lost or denied calls never return a slot. */
  claimControllerCall(method: CapacityControlMethod, plan: CapacityControllerPlan, cold = false): boolean {
    return this.enterController(method, plan, cold)?.allowed ?? false;
  }

  stop(reason: string): void {
    if (!/^[a-z][a-z0-9-]{1,79}$/.test(reason)) throw new Error('capacity_stop_invalid');
    if (this.pendingRun) {
      if (this.row()?.stop_reason === null) this.updateRun({ stop_reason: reason });
    } else this.sql.exec('UPDATE capacity_run SET stop_reason=? WHERE id=1 AND stop_reason IS NULL', reason);
  }

  available(): boolean {
    return this.transaction(() => { const row = this.row(); return Boolean(row && this.live(row, true) && row.charges < CAPACITY_CEILINGS.chargedGames); });
  }

  /**
   * Grant a finite Worker-isolate block once. Charge its full request/CPU bound
   * forever, even when a reply or isolate is lost. No return or reset exists.
   */
  reserveIngress(id: string): boolean {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('capacity_ingress_invalid');
    return this.transaction(() => {
      const row = this.row();
      if (!row || !this.live(row) || row.stop_reason !== null) return false;
      if (this.sql.exec('SELECT 1 FROM capacity_ingress_blocks WHERE id=?', id).toArray().length) return false;
      const reserved = JSON.parse(row.reserved) as CapacityWorkUnits;
      const observed = JSON.parse(row.observed) as CapacityWorkUnits;
      const requests = CAPACITY_INGRESS_BLOCK_REQUESTS;
      // One isolate can initialize Better Auth only after an accepted grant.
      // Every grant prepays that whole startup too, including isolate loss.
      const cpu = requests * 50;
      const reads = CAPACITY_D1_READ_ATTEMPTS * (requests * CAPACITY_WARM_D1_READ_ROWS + CAPACITY_INGRESS_AUTH_STARTUP_ROWS);
      if (reserved.workerRequests + observed.workerRequests + requests > CAPACITY_CEILINGS.workerRequests
        || reserved.workerCpuMs + observed.workerCpuMs + cpu > CAPACITY_CEILINGS.workerCpuMs
        || reserved.d1RowsRead + observed.d1RowsRead + reads > CAPACITY_CEILINGS.d1RowsRead) {
        this.stop('ingress-allowance'); return false;
      }
      observed.workerRequests += requests;
      observed.workerCpuMs += cpu;
      observed.d1RowsRead += reads;
      this.sql.exec('INSERT INTO capacity_ingress_blocks VALUES(?,?)', id, this.now());
      this.updateRun({ observed: JSON.stringify(observed) });
      return true;
    });
  }

  /** A lost reply keeps the exact receipt permanently charged across all months. */
  charge(receiptId: string, units: number): boolean {
    if (!/^(?:arena|casual|tournament):[A-Za-z0-9_-]{8,100}$/.test(receiptId)
      || !Number.isSafeInteger(units) || units < 1 || units > 6) throw new Error('capacity_charge_invalid');
    return this.transaction(() => {
      const row = this.row();
      if (!row || !this.live(row)) return false;
      const existing = this.sql.exec<{ units: number }>('SELECT units FROM capacity_charges WHERE receipt_id=?', receiptId).toArray()[0];
      if (existing) return existing.units === units;
      if (!this.live(row, true) || row.charges + units > CAPACITY_CEILINGS.chargedGames) { this.stop('game-allowance'); return false; }
      this.sql.exec('INSERT INTO capacity_charges VALUES(?,?,?)', receiptId, units, this.now());
      this.updateRun({ charges: row.charges + units });
      return true;
    });
  }

  /** Resolve real native Game IDs only into already charged receipt slots. */
  linkGame(gameId: string, receiptId: string): boolean {
    if (!/^[\w-]{8,100}$/.test(gameId) || !validId(receiptId)) throw new Error('capacity_game_invalid');
    return this.transaction(() => {
      const row = this.row();
      if (!row || !this.live(row)) return false;
      const known = this.sql.exec<{ receipt_id: string }>('SELECT receipt_id FROM capacity_game_ids WHERE game_id=?', gameId).toArray()[0];
      if (known) {
        if (known.receipt_id !== receiptId || row.stop_reason !== null) return false;
        const permit = this.sql.exec<PermitRow>('SELECT * FROM capacity_permits WHERE object_key=?', `game:${gameId}`).toArray()[0];
        if (!permit || permit.retiring_nonce !== null) return false;
        if (permit.open === 1) return true;
        if (permit.unresolved !== 0 || permit.trigger_uncertain !== 0) throw new Error('capacity_permit_corrupt');
        if (row.active_objects >= CAPACITY_CEILINGS.activeObjects) { this.stop('active-object-allowance'); return false; }
        this.sql.exec('UPDATE capacity_permits SET open=1,generation=generation+1 WHERE object_key=?', `game:${gameId}`);
        this.updateRun({ active_objects: row.active_objects + 1 });
        return true;
      }
      if (row.stop_reason !== null) return false;
      const receipt = this.sql.exec<{ units: number; linked: number }>(`SELECT units,
        (SELECT COUNT(*) FROM capacity_game_ids WHERE receipt_id=?) AS linked FROM capacity_charges WHERE receipt_id=?`, receiptId, receiptId).toArray()[0];
      if (!receipt || receipt.linked >= receipt.units) return false;
      // Trusted callers acquire this lifetime permit before obtaining or
      // invoking a Game stub. The wrapper must never create its own permit.
      if (row.active_objects >= CAPACITY_CEILINGS.activeObjects) { this.stop('active-object-allowance'); return false; }
      this.sql.exec('INSERT INTO capacity_game_ids VALUES(?,?)', gameId, receiptId);
      this.sql.exec('INSERT INTO capacity_permits VALUES(?,1,0,1,NULL,0)', `game:${gameId}`);
      this.updateRun({ active_objects: row.active_objects + 1 });
      return true;
    });
  }

  /** Called by the trusted caller before obtaining any native stub. */
  begin(id: string, objectKey: string, operation: string, envelope: CapacityWorkUnits,
    mode: 'rpc' | 'automatic' | 'workflow' = 'rpc'): CapacityDispatch | null {
    if (!validId(id) || !validWork(envelope) || !(objectKey === 'competition' || /^game:[\w-]{8,100}$/.test(objectKey))
      || !/^(?:Game|Competition)\.[A-Za-z][A-Za-z0-9]{0,79}$/.test(operation)
      || operation.startsWith('Game.') !== objectKey.startsWith('game:') || !['rpc', 'automatic', 'workflow'].includes(mode)) {
      throw new Error('capacity_work_invalid');
    }
    return this.transaction(() => {
      const row = this.row();
      if (!row || !this.manifest || !this.live(row) || row.stop_reason !== null) return null;
      const kind = objectKey === 'competition' ? 'Competition' : 'Game';
      const prepaid = mode === 'workflow';
      if (prepaid && (operation !== `${kind}.workflow` || !this.controllerPlan?.workflows
        || !equalWork(envelope, this.controllerPlan.workflows[kind].envelope))) return null;
      if (prepaid) {
        const existing = this.sql.exec<DispatchRow>("SELECT * FROM capacity_dispatches WHERE object_key=? AND mode='workflow' LIMIT 1", objectKey).toArray()[0];
        if (existing) return existing.completed ? null : { runId: this.manifest.runId, manifestDigest: this.manifest.digest,
          id: existing.id, objectKey, generation: existing.generation, operation, mode };
      }
      const prior = this.sql.exec<DispatchRow>('SELECT * FROM capacity_dispatches WHERE id=?', id).toArray()[0];
      // A dispatch ID is never permission to repeat native work.
      if (prior) return null;
      if (objectKey.startsWith('game:') && !this.sql.exec('SELECT 1 FROM capacity_game_ids WHERE game_id=?', objectKey.slice(5)).toArray().length) return null;
      const permit = this.sql.exec<PermitRow>('SELECT * FROM capacity_permits WHERE object_key=?', objectKey).toArray()[0];
      if (!permit?.open || permit.retiring_nonce !== null) return null;
      const reserved = JSON.parse(row.reserved) as CapacityWorkUnits;
      const observed = JSON.parse(row.observed) as CapacityWorkUnits;
      if (!prepaid && WORK_KEYS.some(key => reserved[key] + observed[key] + envelope[key] > CAPACITY_CEILINGS[key])) {
        this.stop('native-work-allowance'); return null;
      }
      if (!prepaid) for (const key of WORK_KEYS) reserved[key] += envelope[key];
      this.sql.exec('INSERT INTO capacity_dispatches(id,object_key,generation,operation,mode,envelope) VALUES(?,?,?,?,?,?)',
        id, objectKey, permit.generation, operation, mode, JSON.stringify(envelope));
      this.sql.exec('UPDATE capacity_permits SET unresolved=unresolved+1 WHERE object_key=?', objectKey);
      this.updateRun({ unresolved_dispatches: row.unresolved_dispatches + 1, reserved: JSON.stringify(reserved) });
      return { runId: this.manifest.runId, manifestDigest: this.manifest.digest, id, objectKey,
        generation: permit.generation, operation, mode };
    });
  }

  /** Read an already paid Competition workflow after a stop. Never create one. */
  recoverCompetitionWorkflow(): CapacityDispatch | null {
    const row = this.row();
    if (!row || !this.manifest || !this.live(row)) return null;
    const existing = this.sql.exec<DispatchRow>("SELECT * FROM capacity_dispatches WHERE object_key='competition' AND mode='workflow' LIMIT 1").toArray()[0];
    if (!existing || existing.completed || existing.operation !== 'Competition.workflow') return null;
    return { runId: this.manifest.runId, manifestDigest: this.manifest.digest, id: existing.id,
      objectKey: 'competition', generation: existing.generation, operation: 'Competition.workflow', mode: 'workflow' };
  }

  /**
   * The trusted RPC caller submits measured work only after its actual native
   * reply. Lost calls keep the dispatch and lifetime reservation. Automatic
   * events also leave an explicit trigger uncertainty until separately proved.
   */
  complete(ticket: CapacityDispatch, actual: CapacityWorkUnits, drained: CapacityDrain): boolean {
    if (!ticket || !validId(ticket.id) || !validWork(actual) || !Number.isSafeInteger(drained.pendingNative) || drained.pendingNative < 0
      || !Number.isSafeInteger(drained.sockets) || drained.sockets < 0 || typeof drained.alarm !== 'boolean'
      || typeof drained.alarmPossible !== 'boolean' || typeof drained.socketPossible !== 'boolean') throw new Error('capacity_completion_invalid');
    return this.transaction(() => {
      const row = this.row();
      const dispatch = this.sql.exec<DispatchRow>('SELECT * FROM capacity_dispatches WHERE id=?', ticket.id).toArray()[0];
      if (!row || !dispatch) return false;
      if (!this.manifest || row.manifest !== manifestIdentity(this.manifest)) return false;
      if (ticket.runId !== this.manifest.runId || ticket.manifestDigest !== this.manifest.digest
        || ticket.objectKey !== dispatch.object_key || ticket.generation !== dispatch.generation
        || ticket.operation !== dispatch.operation || ticket.mode !== dispatch.mode) return false;
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < row.last_now) { this.stop('clock-regressed'); return false; }
      if (now >= this.manifest.hardCloseAt) { this.stop('compute-expired'); return false; }
      if (dispatch.completed) return dispatch.observed !== null && equalWork(JSON.parse(dispatch.observed) as CapacityWorkUnits, actual);
      const envelope = JSON.parse(dispatch.envelope) as CapacityWorkUnits;
      const reserved = JSON.parse(row.reserved) as CapacityWorkUnits;
      const observed = JSON.parse(row.observed) as CapacityWorkUnits;
      const previousStorage = this.sql.exec<{ peak_bytes: number }>('SELECT peak_bytes FROM capacity_object_storage WHERE object_key=?', dispatch.object_key).toArray()[0]?.peak_bytes ?? 0;
      // Storage measurements are physical high water marks. Reserve possible
      // growth before dispatch, then charge each byte only once across events.
      const prepaid = dispatch.mode === 'workflow';
      const charged = prepaid ? actual : { ...actual, doStorageBytes: Math.max(0, actual.doStorageBytes - previousStorage),
        d1StorageBytes: Math.max(0, actual.d1StorageBytes - observed.d1StorageBytes) };
      if (WORK_KEYS.some(key => charged[key] > envelope[key])) { this.stop('native-envelope-exceeded'); return false; }
      if (drained.pendingNative !== 0) { this.stop('native-work-unresolved'); return false; }
      const permit = this.sql.exec<PermitRow>('SELECT * FROM capacity_permits WHERE object_key=?', dispatch.object_key).one();
      if (!permit.open || permit.unresolved < 1 || permit.generation !== ticket.generation || permit.retiring_nonce !== null) throw new Error('capacity_permit_corrupt');
      if (!prepaid) for (const key of WORK_KEYS) { reserved[key] -= envelope[key]; observed[key] += charged[key]; }
      this.sql.exec('UPDATE capacity_dispatches SET completed=1,observed=? WHERE id=?', JSON.stringify(actual), ticket.id);
      const triggers = (drained.alarmPossible || drained.alarm || ticket.operation.endsWith('.alarm') ? 1 : 0)
        | (drained.socketPossible || drained.sockets > 0 || ticket.operation.includes('.webSocket') ? 2 : 0);
      this.sql.exec('UPDATE capacity_permits SET unresolved=unresolved-1,trigger_uncertain=trigger_uncertain|? WHERE object_key=?',
        triggers, dispatch.object_key);
      this.sql.exec(`INSERT INTO capacity_object_storage VALUES(?,?) ON CONFLICT(object_key)
        DO UPDATE SET peak_bytes=MAX(peak_bytes,excluded.peak_bytes)`, dispatch.object_key, actual.doStorageBytes);
      this.updateRun({ unresolved_dispatches: row.unresolved_dispatches - 1,
        last_now: now, reserved: JSON.stringify(reserved), observed: JSON.stringify(observed) });
      return true;
    });
  }

  /**
   * Fence a generation before the caller obtains its fresh retirement stub.
   * Pay the complete finite reset/alarm/cleanup allowance now, without refunds.
   * Socket generations remain held because a queued callback is not disproved.
   */
  prepareRetirement(objectKey: string, envelope: CapacityWorkUnits): CapacityRetirement | null {
    if (!/^game:[\w-]{8,100}$/.test(objectKey) || !validWork(envelope)) throw new Error('capacity_retirement_invalid');
    return this.transaction(() => {
      const row = this.row();
      if (!row || !this.manifest || !this.live(row)) return null;
      const permit = this.sql.exec<PermitRow>('SELECT * FROM capacity_permits WHERE object_key=?', objectKey).toArray()[0];
      if (!permit?.open || permit.unresolved !== 0 || permit.retiring_nonce !== null || (permit.trigger_uncertain & 2) !== 0) return null;
      const reserved = JSON.parse(row.reserved) as CapacityWorkUnits;
      const observed = JSON.parse(row.observed) as CapacityWorkUnits;
      if (WORK_KEYS.some(key => reserved[key] + observed[key] + envelope[key] > CAPACITY_CEILINGS[key])) {
        this.stop('retirement-work-allowance'); return null;
      }
      const nonce = crypto.randomUUID();
      for (const key of WORK_KEYS) observed[key] += envelope[key];
      this.sql.exec('INSERT INTO capacity_retirements(object_key,generation,nonce) VALUES(?,?,?)', objectKey, permit.generation, nonce);
      this.sql.exec('UPDATE capacity_permits SET retiring_nonce=? WHERE object_key=?', nonce, objectKey);
      this.updateRun({ observed: JSON.stringify(observed) });
      return { runId: this.manifest.runId, manifestDigest: this.manifest.digest, objectKey, generation: permit.generation, nonce };
    });
  }

  /** Only the exact private raw-abort emitter may establish this boundary. */
  confirmRetirement(value: CapacityRetirement, acknowledgment: string): boolean {
    if (!value || !/^game:[\w-]{8,100}$/.test(value.objectKey) || !Number.isSafeInteger(value.generation)
      || value.generation < 1 || !/^[a-f0-9-]{36}$/.test(value.nonce)) throw new Error('capacity_retirement_invalid');
    return this.transaction(() => {
      const row = this.row();
      if (!row || !this.manifest || row.manifest !== manifestIdentity(this.manifest)
        || value.runId !== this.manifest.runId || value.manifestDigest !== this.manifest.digest) return false;
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < row.last_now) { this.stop('clock-regressed'); return false; }
      if (now >= this.manifest.hardCloseAt) { this.stop('compute-expired'); return false; }
      const retirement = this.sql.exec<{ nonce: string; acknowledged: number }>(
        'SELECT nonce,acknowledged FROM capacity_retirements WHERE object_key=? AND generation=?', value.objectKey, value.generation).toArray()[0];
      const permit = this.sql.exec<PermitRow>('SELECT * FROM capacity_permits WHERE object_key=?', value.objectKey).toArray()[0];
      if (!retirement || retirement.acknowledged !== 0 || retirement.nonce !== value.nonce
        || acknowledgment !== capacityRetirementAck(value) || !permit?.open || permit.unresolved !== 0
        || permit.generation !== value.generation || permit.retiring_nonce !== value.nonce || (permit.trigger_uncertain & 2) !== 0) return false;
      this.sql.exec('UPDATE capacity_retirements SET acknowledged=1 WHERE object_key=? AND generation=?', value.objectKey, value.generation);
      this.sql.exec('UPDATE capacity_permits SET open=0,retiring_nonce=NULL,trigger_uncertain=0 WHERE object_key=?', value.objectKey);
      this.updateRun({ active_objects: row.active_objects - 1, last_now: now });
      return true;
    });
  }

  /** A private native receipt closes compute evidence without releasing historical permits. */
  confirmShutdown(ticket: CapacityDispatch, receipt: CapacityShutdownReceipt): boolean {
    return this.transaction(() => {
      const row = this.row();
      const keys = ['at', 'games', 'socketWorkflows', 'pendingNative', 'gameOutboxes', 'competitionOutboxes',
        'projectionBuilds', 'unfinishedGames', 'sockets', 'alarms'] as const;
      const diagnostic = this.manifest?.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile;
      const games = diagnostic ? 0 : 20_000, sockets = diagnostic ? 0 : 1_000;
      const registration = receipt?.registration;
      if (diagnostic && (!registration || Object.keys(registration).length !== 4
        || !['fixtures', 'entrants', 'steps', 'queues'].every(key =>
          Number.isSafeInteger(registration[key as keyof typeof registration]) && registration[key as keyof typeof registration] >= 0)
        || registration.fixtures > CAPACITY_REGISTRATION_DIAGNOSTIC.accounts
        || registration.entrants > registration.fixtures || registration.steps > CAPACITY_REGISTRATION_DIAGNOSTIC.registrations
        || registration.queues !== 0)) return false;
      if (!row || !this.manifest || !receipt || Object.keys(receipt).length !== keys.length + Number(diagnostic)
        || keys.some(key => !Number.isSafeInteger(receipt[key]) || receipt[key] < 0)
        || receipt.games !== games || receipt.socketWorkflows !== sockets
        || keys.slice(3).some(key => receipt[key] !== 0)
        || receipt.at < this.manifest.admissionsCloseAt || receipt.at > this.now() || this.now() >= this.manifest.hardCloseAt
        || row.charges !== games || row.unresolved_dispatches !== 0 || row.active_objects !== sockets + 2) return false;
      const dispatch = this.sql.exec<DispatchRow>('SELECT * FROM capacity_dispatches WHERE id=?', ticket.id).toArray()[0];
      if (!dispatch || !dispatch.completed || dispatch.mode !== 'workflow' || dispatch.object_key !== 'competition'
        || ticket.runId !== this.manifest.runId || ticket.manifestDigest !== this.manifest.digest
        || ticket.objectKey !== dispatch.object_key || ticket.generation !== dispatch.generation
        || ticket.mode !== dispatch.mode || ticket.operation !== dispatch.operation) return false;
      const proof = this.sql.exec<{ workflows: number; retirements: number }>(`SELECT
        (SELECT COUNT(*) FROM capacity_dispatches WHERE mode='workflow' AND completed=1) AS workflows,
        (SELECT COUNT(*) FROM capacity_retirements WHERE acknowledged=1) AS retirements`).one();
      if (proof.workflows !== games + 1 || proof.retirements !== (diagnostic ? 0 : 19_000)) return false;
      if (this.sql.exec('SELECT 1 FROM capacity_native_shutdown WHERE id=1').toArray().length) return false;
      this.sql.exec('INSERT INTO capacity_native_shutdown VALUES(1,?)', JSON.stringify({ ...receipt,
        completedWorkflows: proof.workflows, confirmedRetirements: proof.retirements, retainedLifetimePermits: row.active_objects }));
      return true;
    });
  }

  status() {
    const row = this.row();
    if (!row) return { armed: false as const, ready: this.manifest !== null };
    const shutdown = this.sql.exec<{ receipt: string }>('SELECT receipt FROM capacity_native_shutdown WHERE id=1').toArray()[0]?.receipt;
    return { armed: true as const, manifestDigest: row.digest, armedAt: row.armed_at,
      stopReason: row.stop_reason, charges: row.charges, activeObjects: row.active_objects,
      reserved: JSON.parse(row.reserved) as CapacityWorkUnits, observed: JSON.parse(row.observed) as CapacityWorkUnits,
      unresolvedDispatches: row.unresolved_dispatches,
      controllerIncarnations: row.controller_incarnations,
      nativeShutdown: shutdown ? JSON.parse(shutdown) as CapacityShutdownReceipt & {
        completedWorkflows: number; confirmedRetirements: number; retainedLifetimePermits: number } : null,
      physicalBytes: this.sql.databaseSize };
  }
}

/** Kept private and unarmed until the complete frozen candidate is approved. */
export class CapacityRun extends DurableObject<unknown> {
  private store: CapacityRunStore;
  private tickets: CapacityTicketCodec | null;
  private scopes = new AsyncLocalStorage<CapacityNativeMeter>();
  private bootstrap = new CapacityNativeMeter();
  #bootstrapAccounted = false;
  private plan = VERIFIED_CONTROLLER_PLAN;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = new Proxy(ctx.storage.sql, { get: (target, key) => {
      const measured = (this.scopes.getStore() ?? this.bootstrap).sql(target);
      const value = Reflect.get(measured, key, measured);
      return typeof value === 'function' ? value.bind(measured) : value;
    } });
    this.store = new CapacityRunStore(sql, run => ctx.storage.transactionSync(run), SEALED_CAPACITY_MANIFEST);
    const secret = (env as { AUTH_SECRET?: string })?.AUTH_SECRET;
    this.tickets = secret ? new CapacityTicketCodec(secret) : null;
  }
  async #run<R>(method: CapacityControlMethod, work: (plan: CapacityControllerPlan, armedNow: boolean) => R | Promise<R>,
    synchronous = false): Promise<R> {
    const plan = this.plan;
    if (!plan) throw new Error('capacity_controller_unqualified');
    return this.scopes.run(new CapacityNativeMeter(), async () => {
      try {
        let bootstrapAccepted = false;
        const execute = () => {
          const entry = this.store.enterController(method, plan, !this.#bootstrapAccounted);
          if (entry?.incarnationClaimed && !this.#bootstrapAccounted) {
            const bootstrap = this.bootstrap.snapshot();
            if (bootstrap.uncertain || bootstrap.doRowsRead > plan.bootstrapEnvelope.doRowsRead
              || bootstrap.doRowsWritten > plan.bootstrapEnvelope.doRowsWritten
              || this.ctx.storage.sql.databaseSize > plan.maximumPhysicalBytes) {
              this.store.stop('controller-bootstrap-exceeded');
              throw new Error('capacity_controller_bootstrap_exceeded');
            }
            bootstrapAccepted = true;
          }
          if (!entry?.allowed) throw new Error('capacity_controller_call_denied');
          return work(plan, entry.armedNow);
        };
        let result: SynchronousResult<R | Promise<R>>;
        if (synchronous) result = this.store.fuseRunUpdates(execute);
        else {
          try { result = { ok: true, value: execute() }; }
          catch (error) { result = { ok: false, error }; }
        }
        // Set this only after the claim has committed, even if ordinary work
        // failed. Signature-validation methods keep their pre-await claim.
        if (bootstrapAccepted) this.#bootstrapAccounted = true;
        if (!result.ok) throw result.error;
        return await result.value;
      }
      finally {
        const meter = this.scopes.getStore()!.snapshot();
        const envelope = plan.methods[method].envelope;
        if (meter.uncertain || meter.doRowsRead > envelope.doRowsRead
          || meter.doRowsWritten > envelope.doRowsWritten
          || this.ctx.storage.sql.databaseSize > plan.maximumPhysicalBytes) {
          this.store.stop('controller-envelope-exceeded');
          const stopped = this.scopes.getStore()!.snapshot();
          if (stopped.doRowsRead - meter.doRowsRead > 1 || stopped.doRowsWritten - meter.doRowsWritten > 1) {
            throw new Error('capacity_controller_stop_tail_exceeded');
          }
          throw new Error('capacity_controller_envelope_exceeded');
        }
      }
    });
  }
  async arm(): Promise<boolean> { return this.plan ? this.#run('arm', (_plan, armedNow) => armedNow, true) : false; }
  async stop(): Promise<void> { return this.#run('stop', () => this.store.stop('owner-stop'), true); }
  async status() { return this.#run('status', () => this.store.status(), true); }
  async available(): Promise<boolean> { return this.#run('available', () => this.store.available(), true); }
  async reserveIngress(id: string): Promise<boolean> { return this.#run('reserveIngress', () => this.store.reserveIngress(id), true); }
  async charge(id: string, units: number): Promise<boolean> { return this.#run('charge', () => this.store.charge(id, units), true); }
  async linkGame(gameId: string, receiptId: string): Promise<boolean> { return this.#run('linkGame', () => this.store.linkGame(gameId, receiptId), true); }
  async begin(id: string, objectKey: string, operation: string, envelope: CapacityWorkUnits,
    mode: 'rpc' | 'automatic' | 'workflow' = 'rpc'): Promise<CapacityTicket<CapacityDispatch> | null> {
    const dispatch = await this.#run('begin', () => {
      if (!this.tickets) return null;
      return this.store.begin(id, objectKey, operation, envelope, mode);
    }, true);
    return dispatch && this.tickets ? this.tickets.dispatch(dispatch) : null;
  }
  async complete(ticket: CapacityTicket<CapacityDispatch>, actual: CapacityWorkUnits, drained: CapacityDrain): Promise<boolean> {
    return this.#run('complete', async () => {
      if (!this.tickets || !SEALED_CAPACITY_MANIFEST
        || !await this.tickets.validDispatch(ticket, SEALED_CAPACITY_MANIFEST, ticket?.objectKey, ticket?.operation)) return false;
      return this.store.complete(ticket, actual, drained);
    });
  }
  async recoverCompetitionWorkflow(): Promise<CapacityTicket<CapacityDispatch> | null> {
    const dispatch = await this.#run('begin', () => this.store.recoverCompetitionWorkflow(), true);
    return dispatch && this.tickets ? this.tickets.dispatch(dispatch) : null;
  }
  async prepareRetirement(objectKey: string, envelope: CapacityWorkUnits): Promise<CapacityTicket<CapacityRetirement> | null> {
    const retirement = await this.#run('prepareRetirement', () => {
      if (!this.tickets) return null;
      return this.store.prepareRetirement(objectKey, envelope);
    }, true);
    return retirement && this.tickets ? this.tickets.retirement(retirement) : null;
  }
  async confirmRetirement(value: CapacityTicket<CapacityRetirement>, acknowledgment: string): Promise<boolean> {
    return this.#run('confirmRetirement', async () => {
      if (!this.tickets || !SEALED_CAPACITY_MANIFEST || !await this.tickets.validRetirement(value, SEALED_CAPACITY_MANIFEST)) return false;
      return this.store.confirmRetirement(value, acknowledgment);
    });
  }
  async confirmShutdown(ticket: CapacityTicket<CapacityDispatch>, receipt: CapacityShutdownReceipt): Promise<boolean> {
    return this.#run('confirmShutdown', async () => {
      if (!this.tickets || !SEALED_CAPACITY_MANIFEST
        || !await this.tickets.validDispatch(ticket, SEALED_CAPACITY_MANIFEST, 'competition', 'Competition.workflow')) return false;
      return this.store.confirmShutdown(ticket, receipt);
    });
  }
}
