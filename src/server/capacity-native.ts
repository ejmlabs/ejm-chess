import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { Game } from './game';
import { Competition } from './competition';
import type { Env } from './env';
import { CapacityNativeMeter, type CapacityNativeUsage } from './capacity-meter';
import { bindIsolatedGameBudget } from './capacity-policy';
import { CapacityAccountFixtures, type CapacityAccountCredential } from './capacity-fixtures';
import { readCapacityStandings } from './capacity-standings';
import { CapacityIntentLedger } from './capacity-intents';
import { CapacityProtocol, CapacityRegistrationClaims, capacityGameStep, capacityGameSocket, claimCapacityStep,
  initializeCapacitySteps, type CapacityProtocolHooks } from './capacity-protocol';
import { signCapacityBinding } from './capacity-binding';
import { capacityStep, CAPACITY_D1_READ_ATTEMPTS, CAPACITY_PREPARATION_SINGLE_ATTEMPT_READS,
  CAPACITY_REGISTRATION_DIAGNOSTIC, capacityRegistrationDiagnosticStep, type CapacityStepReply } from '../shared/capacity-corpus';
import { CapacityWorkflowLedger, capacityUsageWork, type CapacityWorkflowPlan } from './capacity-workflow';
import { VERIFIED_GAME_WORKFLOW_PLAN, VERIFIED_COMPETITION_WORKFLOW_PLAN,
  VERIFIED_SOCKET_GAME_WORKFLOW_PLAN, VERIFIED_DELAYED_GAME_WORKFLOW_PLAN, CAPACITY_FREEZE_CALLBACK_WORK } from './capacity-work-plan';
import { CapacityFaults } from './capacity-faults';
import { capacityRetirementAck, CapacityTicketCodec, emptyCapacityWork, SEALED_CAPACITY_MANIFEST,
  type CapacityDispatch, type CapacityDrain, type CapacityManifest, type CapacityRetirement,
  type CapacityRun, type CapacityShutdownReceipt, type CapacityTicket, type CapacityWorkUnits } from './capacity-run';
import type { Actor, GameCommand, GameResult, InitGame } from '../shared/protocol';
import type { CasualGameInput } from './casual';
import type { Actor as AuthActor } from './auth';
import { capacityNativeFailure, type CapacityFailureStage } from '../shared/capacity-failure';

export interface CapacityEnv {
  DB: D1Database;
  GAME: DurableObjectNamespace<CapacityGame>;
  COMPETITION: DurableObjectNamespace<CapacityCompetition>;
  CAPACITY_RUN: DurableObjectNamespace<CapacityRun>;
  CAPACITY_TOKEN: string;
  AUTH_SECRET: string;
}

export type CapacityOperation = `Game.${string}` | `Competition.${string}`;
/** No guessed operation envelope can arm the private candidate. */
export const VERIFIED_NATIVE_ENVELOPES: Readonly<Record<CapacityOperation, CapacityWorkUnits>> | null = null;
export const CAPACITY_RETIREMENT_ALARM_WAIT_MS = 70_000;

interface NativeEvent {
  meter: CapacityNativeMeter;
  pending: Set<Promise<unknown>>;
  failed: boolean;
  alarmPossible: boolean;
  socketPossible: boolean;
  stage: CapacityFailureStage;
  envelope: CapacityWorkUnits | null;
}
export interface CapacityControl {
  begin(id: string, objectKey: string, operation: string, envelope: CapacityWorkUnits,
    mode?: 'rpc' | 'automatic' | 'workflow'): Promise<CapacityTicket<CapacityDispatch> | null>;
  complete(ticket: CapacityTicket<CapacityDispatch>, actual: CapacityWorkUnits, drained: CapacityDrain): Promise<boolean>;
  charge(id: string, units: number): Promise<boolean>;
  linkGame(id: string, receiptId: string): Promise<boolean>;
  available(): Promise<boolean>;
  prepareRetirement(objectKey: string, envelope: CapacityWorkUnits): Promise<CapacityTicket<CapacityRetirement> | null>;
  confirmRetirement(value: CapacityTicket<CapacityRetirement>, acknowledgment: string): Promise<boolean>;
  confirmShutdown?(ticket: CapacityTicket<CapacityDispatch>, receipt: CapacityShutdownReceipt): Promise<boolean>;
}
export interface CapacityNativeReply<R> {
  ticketId: string; value: R; usage: CapacityNativeUsage; actual: CapacityWorkUnits; drained: CapacityDrain;
  workflowActual?: CapacityWorkUnits;
  loseAcknowledgment?: boolean;
  nativeTiming?: CapacityNativeTiming;
}
/** Private in-memory milestones. They add no storage work or control calls. */
export interface CapacityNativeTiming {
  enteredAt: number; ticketAt: number; claimedAt: number; methodFinishedAt: number; returningAt: number;
}
export interface CapacityNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): unknown;
}
export interface CapacityWorkflowPlans {
  Game: CapacityWorkflowPlan; Competition: CapacityWorkflowPlan;
  delayed?: CapacityWorkflowPlan; socket?: CapacityWorkflowPlan;
}

export function capacityNativeBudgetOperation(kind: 'Game' | 'Competition', method: string, args: unknown[]): CapacityOperation {
  if (method !== 'qualificationStep') return `${kind}.${method}`;
  const step = capacityStep(args[1] as number);
  if (kind === 'Competition') return ({ register: 'Competition.qualificationRegister', queue: 'Competition.qualificationQueue',
    'observe-binding': 'Competition.qualificationBinding', fault: 'Competition.qualificationFault' } as const)
    [step.action as 'register' | 'queue' | 'observe-binding' | 'fault'] ?? 'Competition.qualificationStep';
  if (step.action === 'command') return step.command!.type === 'ready' && step.command!.expectedVersion === 0
    ? 'Game.qualificationReadyCold'
    : `Game.qualification${step.command!.type[0].toUpperCase()}${step.command!.type.slice(1)}`;
  return ({ 'observe-settlement': 'Game.qualificationObserve', 'duplicate-result': 'Game.qualificationDuplicate',
    retire: 'Game.qualificationRetire' } as const)[step.action as 'observe-settlement' | 'duplicate-result' | 'retire']
    ?? 'Game.qualificationStep';
}

function allowed(manifest: CapacityManifest): void {
  const now = Date.now();
  if (now < manifest.earliestArmAt || now >= manifest.issueCloseAt) throw new Error('capacity_native_work_expired');
}

/** A non-run ID is denied before a native Game stub is called. */
export async function linkNativeCapacityGame(db: D1Database, control: CapacityControl, id: string): Promise<boolean> {
  if (!/^[\w-]{8,100}$/.test(id)) return false;
  const admission = await db.prepare(`SELECT 'arena:'||game_id AS receipt FROM tournament_game_admissions WHERE game_id=?
    UNION ALL SELECT 'casual:'||game_id AS receipt FROM casual_game_admissions WHERE game_id=? LIMIT 1`).bind(id, id).first<{ receipt: string }>();
  if (!admission) return false;
  if (await control.linkGame(id, admission.receipt)) return true;
  // A preview reserves its finite group before the individual IDs exist.
  const preview = await db.prepare('SELECT tournament_id FROM tournament_game_admissions WHERE game_id=?').bind(id).first<{ tournament_id: string }>();
  return Boolean(preview && await control.linkGame(id, `tournament:${preview.tournament_id}`));
}

/**
 * The only RPC call path. A durable reservation precedes namespace.get. The
 * exact ticket is sent once; failures never retry it or release its lifetime.
 * Settle only after the actual wrapper reply, with no in-wrapper control RPC.
 */
export async function callCapacityNative<R>(namespace: CapacityNamespace, control: CapacityControl,
  objectKey: string, operation: CapacityOperation, envelope: CapacityWorkUnits, args: unknown[] = []): Promise<R> {
  const ticket = await control.begin(crypto.randomUUID(), objectKey, operation, envelope);
  if (!ticket) throw new Error('capacity_native_work_denied');
  const name = objectKey === 'competition' ? 'global' : objectKey.slice(5);
  const stub = namespace.get(namespace.idFromName(name)) as unknown as Record<string, (...values: unknown[]) => Promise<CapacityNativeReply<R>>>;
  const member = operation.slice(operation.indexOf('.') + 1);
  const method = member === 'fetch' ? 'openSocket' : member;
  const invoke = stub[method];
  if (typeof invoke !== 'function') throw new Error('capacity_native_method_missing');
  // Native RPC method handles are callable capabilities, not normal Function
  // objects. Reading .apply would issue an RPC for a method named "apply".
  const reply = await invoke(...args, ticket);
  if (!reply || reply.ticketId !== ticket.id) throw new Error('capacity_native_reply_invalid');
  if (!await control.complete(ticket, reply.actual, reply.drained)) throw new Error('capacity_native_completion_unresolved');
  return reply.value;
}

/** The durable local workflow guard accounts for each call without controller I/O. */
export async function callCapacityWorkflow<R>(namespace: CapacityNamespace, ticket: CapacityTicket<CapacityDispatch>,
  operation: CapacityOperation, args: unknown[] = []): Promise<CapacityNativeReply<R>> {
  if (ticket.mode !== 'workflow' || !operation.startsWith(ticket.objectKey === 'competition' ? 'Competition.' : 'Game.')) {
    throw new Error('capacity_workflow_ticket_invalid');
  }
  const name = ticket.objectKey === 'competition' ? 'global' : ticket.objectKey.slice(5);
  const stub = namespace.get(namespace.idFromName(name)) as Record<string, (...values: unknown[]) => Promise<CapacityNativeReply<R>>>;
  const member = operation.slice(operation.indexOf('.') + 1);
  const reply = await stub[member === 'fetch' ? 'openSocket' : member](...args, ticket);
  if (!reply || reply.ticketId !== ticket.id) throw new Error('capacity_native_reply_invalid');
  if (reply.loseAcknowledgment) throw new Error('capacity_result_acknowledgment_lost');
  return reply;
}

/**
 * Compose the unchanged native authority. AsyncLocalStorage assigns nested
 * native work to its event across awaits and waitUntil. Composition exposes
 * only the explicit methods below and never inherits an unguarded Game RPC.
 *
 * The verified envelope map and sealed manifest are deliberately absent until
 * exact source review and focused native safety pass. Provider performance
 * still needs the complete approved workload.
 */
export class CapacityNativeHost<T extends Game | Competition> {
  private scopes = new AsyncLocalStorage<NativeEvent>();
  private native: T | null = null;
  private nativeContext: DurableObjectState;
  private nativeEnv: Env;
  private tickets: CapacityTicketCodec;
  private fixtures: CapacityAccountFixtures | null = null;
  private protocol: CapacityProtocol | null = null;
  private registrationClaims: CapacityRegistrationClaims | null = null;
  private workflow: CapacityWorkflowLedger | null = null;
  private workflowClaims = new WeakSet<CapacityNativeMeter>();
  private faults: CapacityFaults | null = null;
  private funded = new Map<string, Promise<CapacityTicket<CapacityDispatch>>>();
  private inFlight = 0;
  get activeInvocations(): number { return this.inFlight; }
  workflowClaimed(meter: CapacityNativeMeter): boolean { return this.workflowClaims.has(meter); }

  private async finishGameWorkflow(): Promise<void> {
    const status = await (this.native as Game).status();
    if (!status?.result || status.result.status !== 'finished'
      || this.nativeContext.storage.sql.exec('SELECT 1 FROM result_delivery LIMIT 1').toArray().length) {
      throw new Error('capacity_shutdown_game_pending');
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Qualification complete');
    await this.nativeContext.storage.deleteAlarm();
    const deadline = Date.now() + 10_000;
    while (this.ctx.getWebSockets().length !== 0 || this.inFlight !== 1) {
      if (Date.now() >= deadline || Date.now() >= this.manifest.issueCloseAt) throw new Error('capacity_shutdown_socket_pending');
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }

  private async finishQualification(): Promise<CapacityShutdownReceipt> {
    if (Date.now() < this.manifest.admissionsCloseAt) throw new Error('capacity_shutdown_early');
    const sql = this.nativeContext.storage.sql;
    const counts = sql.exec<{ bindings: number; unresolved: number; outboxes: number; builds: number; pending: number }>(`SELECT
      (SELECT COUNT(*) FROM capacity_intents WHERE game_id IS NOT NULL) AS bindings,
      (SELECT COUNT(*) FROM arena_intents WHERE status NOT IN ('finished','cancelled')) AS unresolved,
      (SELECT COUNT(*) FROM outbox) AS outboxes,
      (SELECT COUNT(*) FROM arena_projection_builds) AS builds,
      (SELECT COUNT(*) FROM pending_results) AS pending`).one();
    const diagnostic = this.manifest.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile;
    const registration = diagnostic ? {
      fixtures: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM capacity_fixture_accounts WHERE ready=1').one().count,
      entrants: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM arena_entries WHERE state!='withdrawn'").one().count,
      queues: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM arena_entries WHERE state NOT IN ('registered','withdrawn')").one().count,
      steps: sql.exec<{ issued: number }>('SELECT issued FROM capacity_protocol_steps').toArray()
        .reduce((sum, row) => sum + row.issued.toString(2).replaceAll('0', '').length, 0),
    } : null;
    if (counts.bindings !== (diagnostic ? 0 : 20_000) || counts.unresolved || counts.outboxes || counts.builds || counts.pending
      || (registration && (registration.fixtures > CAPACITY_REGISTRATION_DIAGNOSTIC.accounts
        || registration.entrants > registration.fixtures || registration.queues
        || registration.steps > CAPACITY_REGISTRATION_DIAGNOSTIC.registrations))) {
      throw new Error('capacity_shutdown_competition_pending');
    }
    await this.nativeContext.storage.deleteAlarm();
    const games = sql.exec<{ game_id: string }>('SELECT game_id FROM capacity_intents WHERE intent_index>=19000 ORDER BY intent_index').toArray();
    if (games.length !== (diagnostic ? 0 : 1_000)) throw new Error('capacity_shutdown_socket_cohort_invalid');
    let cursor = 0, finished = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (cursor < games.length) {
        const game = games[cursor++], ticket = await this.fundWorkflow(`game:${game.game_id}`);
        const reply = await callCapacityWorkflow<void>(this.env.GAME, ticket, 'Game.finishWorkflow');
        if (!reply.workflowActual || reply.drained.pendingNative || reply.drained.alarm || reply.drained.sockets
          || !await this.control.complete(ticket, reply.workflowActual, reply.drained)) throw new Error('capacity_shutdown_game_unconfirmed');
        finished++;
      }
    }));
    const deadline = Date.now() + 10_000;
    while (this.inFlight !== 1) {
      if (Date.now() >= deadline || Date.now() >= this.manifest.issueCloseAt) throw new Error('capacity_shutdown_native_pending');
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    await this.nativeContext.storage.deleteAlarm();
    return { at: Date.now(), games: counts.bindings, socketWorkflows: finished, pendingNative: 0,
      gameOutboxes: 0, competitionOutboxes: counts.outboxes, projectionBuilds: counts.builds,
      unfinishedGames: counts.unresolved, sockets: this.ctx.getWebSockets().length, alarms: 0,
      ...(registration ? { registration } : {}) };
  }

  constructor(private ctx: DurableObjectState, private env: CapacityEnv,
    private kind: 'Game' | 'Competition', private manifest: CapacityManifest,
    private control: CapacityControl, private envelopes: Readonly<Record<CapacityOperation, CapacityWorkUnits>>,
    private workflows?: CapacityWorkflowPlans) {
    this.tickets = new CapacityTicketCodec(env.AUTH_SECRET);
    const scope = () => {
      const event = this.scopes.getStore();
      if (!event) throw new Error('capacity_native_event_missing');
      allowed(this.manifest);
      return event;
    };
    const track = <R>(promise: Promise<R>): Promise<R> => {
      const event = scope();
      const tracked = promise.catch(error => { event.failed = true; throw error; });
      event.pending.add(tracked);
      void tracked.then(() => event.pending.delete(tracked), () => event.pending.delete(tracked));
      return tracked;
    };
    // Native control bridges retain this SQL handle after construction. Resolve
    // the meter for every call, so a later event cannot charge the first event.
    const sql = new Proxy(ctx.storage.sql, { get(target, key) {
      const measured = scope().meter.sql(target);
      const value = Reflect.get(measured, key, measured);
      return typeof value === 'function' ? value.bind(measured) : value;
    } });
    const storage = new Proxy(ctx.storage, { get: (target, key) => {
      if (key === 'sql') { scope(); return sql; }
      if (key === 'transactionSync') return <R>(run: () => R) => { scope(); return target.transactionSync(run); };
      if (key === 'sync') return () => { scope(); return track(target.sync()); };
      if (key === 'getAlarm' || key === 'deleteAlarm') return () => {
        const event = scope();
        const recovery = this.kind === 'Game' ? this.workflow?.recoveryAt(manifest.setupEndsAt) : null;
        if (key === 'deleteAlarm' && recovery !== null && recovery !== undefined) {
          event.alarmPossible = true;
          return track(event.meter.alarm('write', () => target.setAlarm(Math.min(manifest.issueCloseAt, Math.max(Date.now() + 1, recovery)))));
        }
        return track(event.meter.alarm(key === 'getAlarm' ? 'read' : 'write', () => target[key]() as Promise<unknown>));
      };
      if (key === 'setAlarm') return (time: number | Date) => {
        const event = scope();
        event.alarmPossible = true;
        const recovery = this.kind === 'Game' ? this.workflow?.recoveryAt(manifest.setupEndsAt) : null;
        return track(event.meter.alarm('write', () => target.setAlarm(Math.min(Number(time), manifest.issueCloseAt,
          recovery === null || recovery === undefined ? Infinity : Math.max(Date.now() + 1, recovery)))));
      };
      throw new Error('capacity_unmetered_native_storage');
    } });
    this.nativeContext = new Proxy(ctx, { get(target, key) {
      if (key === 'storage') return storage;
      if (key === 'waitUntil') return (promise: Promise<unknown>) => { target.waitUntil(track(promise)); };
      if (key === 'blockConcurrencyWhile') return <R>(run: () => Promise<R>) => {
        scope(); return track(target.blockConcurrencyWhile(run));
      };
      if (key === 'acceptWebSocket') return (socket: WebSocket, tags?: string[]) => {
        const event = scope(); event.socketPossible = true;
        event.meter.sql(target.storage.sql).exec('UPDATE capacity_wrapper_state SET socket_ever=1 WHERE id=1');
        return target.acceptWebSocket(socket, tags);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const db = new Proxy(env.DB, { get: (target, member) => {
      const measured = scope().meter.d1(target);
      if (member === 'batch' && this.kind === 'Competition' && workflows) return (statements: D1PreparedStatement[]) => {
        this.faults ??= new CapacityFaults(sql, manifest);
        if (this.faults.projectionUnavailable()) throw new Error('capacity_projection_transport_unavailable');
        return measured.batch(statements);
      };
      const value = Reflect.get(measured, member, measured);
      return typeof value === 'function' ? value.bind(measured) : value;
    } });
    const gameNamespace = new Proxy(env.GAME, { get: (namespace, key) => {
      if (key === 'get') return (id: DurableObjectId) => {
        if (manifest.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile) throw new Error('capacity_diagnostic_game_denied');
        const name = id.name;
        if (!name || !/^[\w-]{8,100}$/.test(name)) throw new Error('capacity_unknown_game');
        return new Proxy({ id }, { get: (_stub, member) => {
          if (member === 'id') return id;
          if (typeof member !== 'string') throw new Error('capacity_game_method_invalid');
          return async (...args: unknown[]) => {
            scope();
            const operation = `Game.${member}` as CapacityOperation;
            if (workflows) {
              const ticket = await this.fundWorkflow(`game:${name}`, db);
              return (await callCapacityWorkflow(namespace, ticket, operation, args)).value;
            }
            if (!await linkNativeCapacityGame(db, control, name)) throw new Error('capacity_unknown_game');
            const envelope = envelopes[operation];
            if (!envelope) throw new Error('capacity_native_envelope_missing');
            return callCapacityNative(namespace, control, `game:${name}`, operation, envelope, args);
          };
        } });
      };
      const value = Reflect.get(namespace, key, namespace);
      return typeof value === 'function' ? value.bind(namespace) : value;
    } });
    // No optional service can be reached by this exact native environment.
    this.nativeEnv = { DB: db, GAME: gameNamespace as unknown as Env['GAME'],
      COMPETITION: new Proxy(env.COMPETITION, { get: (namespace, key) => {
        if (key === 'get') return (id: DurableObjectId) => {
          if (id.name !== 'global') throw new Error('capacity_unknown_competition');
          return new Proxy({ id }, { get: (_stub, member) => {
            if (member === 'id') return id;
            if (typeof member !== 'string') throw new Error('capacity_competition_method_invalid');
            return async (...args: unknown[]) => {
              scope();
              const operation = `Competition.${member}` as CapacityOperation;
              if (workflows) {
                const ticket = await this.fundWorkflow('competition', db);
                return (await callCapacityWorkflow(namespace, ticket, operation, args)).value;
              }
              const envelope = envelopes[operation];
              if (!envelope) throw new Error('capacity_native_envelope_missing');
              return callCapacityNative(namespace, control, 'competition', operation, envelope, args);
            };
          } });
        };
        const value = Reflect.get(namespace, key, namespace);
        return typeof value === 'function' ? value.bind(namespace) : value;
      } }) as unknown as Env['COMPETITION'],
      ASSETS: { fetch: async () => { throw new Error('capacity_no_assets'); }, connect: () => { throw new Error('capacity_no_assets'); } },
      AUTH_SECRET: env.AUTH_SECRET, AUTH_BASE_URL: 'https://chess.ejmlabs.com',
      LOCAL_DEV: 'false', RANKED_ENABLED: 'false', TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0',
      NEW_WORK_STOPPED: 'false', MONTHLY_GAME_LIMIT: '10000', MONTHLY_EMAIL_LIMIT: '0', MONTHLY_ANALYSIS_LIMIT: '0',
      OPERATION_MODE: 'unattended', AI_ENABLED: 'false', ANALYSIS_ENABLED: 'false',
      TOURNAMENTS_ENABLED: 'true', ARENAS_ENABLED: 'true', ARENA_ENTRANT_LIMIT: '2000', ARENA_GAME_LIMIT: '1000',
      ARENA_RETAINED_GAME_LIMIT: '20000', ARENA_GAME_ID_LIMIT: '20000', ARENA_AUTHORITY_BYTE_LIMIT: '2147483648',
      CASUAL_GAME_LIMIT: '1000', CASUAL_GAME_ID_LIMIT: '20000', GAME_RETIREMENT_MODE: 'scaled' };
    bindIsolatedGameBudget(this.nativeEnv, { manifestDigest: manifest.digest, maximum: 20_000,
      arenaStarts: { weekly: manifest.earliestArmAt - 110 * 60_000,
        daily: manifest.earliestArmAt + 10 * 60_000, hourly: manifest.earliestArmAt + 10 * 60_000 },
      available: () => control.available(), reserve: (id, units) => control.charge(id, units) });
  }

  async fundWorkflow(objectKey: string, db: D1Database = this.nativeEnv.DB): Promise<CapacityTicket<CapacityDispatch>> {
    if (!this.workflows) throw new Error('capacity_workflow_plan_missing');
    let funding = this.funded.get(objectKey);
    if (!funding) {
      funding = (async () => {
        if (objectKey !== 'competition' && !await linkNativeCapacityGame(db, this.control, objectKey.slice(5))) {
          throw new Error('capacity_unknown_game');
        }
        const kind = objectKey === 'competition' ? 'Competition' : 'Game';
        const plans = this.workflows!;
        const envelope = kind === 'Game' && plans.socket ? Object.fromEntries(Object.keys(plans.Game.envelope)
          .map(key => [key, Math.max(plans.Game.envelope[key as keyof CapacityWorkUnits],
            plans.socket!.envelope[key as keyof CapacityWorkUnits], plans.delayed?.envelope[key as keyof CapacityWorkUnits] ?? 0)])) as CapacityWorkUnits
          : plans[kind].envelope;
        const ticket = await this.control.begin(crypto.randomUUID(), objectKey, `${kind}.workflow`, envelope, 'workflow');
        if (!ticket) throw new Error('capacity_native_work_denied');
        return ticket;
      })();
      this.funded.set(objectKey, funding);
    }
    return funding;
  }

  workflowTicket(meter: CapacityNativeMeter): CapacityTicket<CapacityDispatch> | null {
    const sql = meter.sql(this.ctx.storage.sql);
    const exists = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='capacity_wrapper_workflow'").toArray().length;
    return exists ? JSON.parse(sql.exec<{ ticket: string }>('SELECT ticket FROM capacity_wrapper_workflow WHERE id=1').one().ticket) as CapacityTicket<CapacityDispatch> : null;
  }

  async invoke<R>(ticket: CapacityTicket<CapacityDispatch>, method: string, args: unknown[] = [],
    meter = new CapacityNativeMeter()): Promise<CapacityNativeReply<R>> {
    const event: NativeEvent = { meter, pending: new Set(), failed: false, alarmPossible: false,
      socketPossible: false, stage: 'native-envelope', envelope: null };
    try { return await this.invokeMeasured<R>(ticket, method, args, event); }
    catch (error) {
      // Keep the failed native reservation unresolved. The receipt travels
      // through the existing thrown RPC and private driver trace, without I/O.
      throw capacityNativeFailure(error, { kind: this.kind, stage: event.stage,
        index: method === 'qualificationStep' && Number.isSafeInteger(args[1]) ? args[1] as number : null,
        readBound: meter.readBound(), usage: meter.snapshot(), envelope: event.envelope });
    }
  }

  private async invokeMeasured<R>(ticket: CapacityTicket<CapacityDispatch>, method: string, args: unknown[],
    event: NativeEvent): Promise<CapacityNativeReply<R>> {
    const { meter } = event;
    const enteredAt = this.kind === 'Competition' && method === 'qualificationStep' ? Date.now() : null;
    allowed(this.manifest);
    if (this.manifest.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile) {
      const permitted = this.kind === 'Competition' && (
        (method === 'prepareQualificationAccount' && args[0] === 0)
        || (method === 'prepareQualificationAccounts' && Number.isSafeInteger(args[0])
          && Number(args[0]) >= 0 && Number(args[0]) < CAPACITY_REGISTRATION_DIAGNOSTIC.accounts && Number(args[0]) % 32 === 0)
        || (method === 'qualificationStep' && capacityRegistrationDiagnosticStep(args[1] as number))
        || ['finishQualification', 'alarm', 'maintenance', 'flush'].includes(method));
      if (!permitted) throw new Error('capacity_competition_method_invalid');
    }
    const operation = `${this.kind}.${method}` as CapacityOperation;
    const envelope = this.envelopes[capacityNativeBudgetOperation(this.kind, method, args)] ?? this.envelopes[operation];
    event.envelope = envelope ?? null;
    const workflowPlan = ticket?.mode === 'workflow' ? this.workflows?.[this.kind] : null;
    if (workflowPlan && envelope) event.envelope = this.native === null ? workflowPlan.maximumEventWork : {
      ...envelope, doStorageBytes: workflowPlan.maximumEventWork.doStorageBytes,
      d1StorageBytes: workflowPlan.maximumEventWork.d1StorageBytes,
    };
    if (!workflowPlan && !envelope) throw new Error('capacity_native_envelope_missing');
    if (this.kind === 'Competition' && (method === 'prepareQualificationAccount' || method === 'prepareQualificationAccounts')) {
      if (!envelope || envelope.d1RowsRead < CAPACITY_D1_READ_ATTEMPTS * CAPACITY_PREPARATION_SINGLE_ATTEMPT_READS) {
        throw new Error('capacity_native_retry_reservation_missing');
      }
      meter.allowD1ReadRetries(CAPACITY_PREPARATION_SINGLE_ATTEMPT_READS);
    } else {
      // The workflow funds a separate cold event, including auth startup.
      const reads = (workflowPlan && this.native === null ? workflowPlan.maximumEventWork : envelope)?.d1RowsRead ?? 0;
      if (reads > 0) meter.allowD1ReadRetries(Math.floor(reads / CAPACITY_D1_READ_ATTEMPTS));
    }
    const name = this.kind === 'Game' ? this.ctx.id.name : 'global';
    if (!name) throw new Error('capacity_native_name_missing');
    const objectKey = this.kind === 'Game' ? `game:${name}` : 'competition';
    event.stage = 'native-ticket';
    if (!await this.tickets.validDispatch(ticket, this.manifest, objectKey, workflowPlan ? `${this.kind}.workflow` : operation)) throw new Error('capacity_native_ticket_invalid');
    const ticketAt = enteredAt === null ? null : Date.now();
    this.inFlight++;
    try { return await this.scopes.run(event, async () => {
      try {
        const sql = this.nativeContext.storage.sql;
        event.stage = 'workflow-claim';
        this.workflow ??= workflowPlan ? new CapacityWorkflowLedger(sql, run => this.nativeContext.storage.transactionSync(run), workflowPlan,
          this.kind === 'Game' && this.workflows?.delayed && this.workflows.socket ? { delayed: this.workflows.delayed, socket: this.workflows.socket } : undefined) : null;
        if (workflowPlan && !envelope) throw new Error('capacity_native_envelope_missing');
        const registration = workflowPlan && this.native !== null && this.kind === 'Competition'
          && method === 'qualificationStep' && this.manifest.profile !== CAPACITY_REGISTRATION_DIAGNOSTIC.profile
          ? (this.registrationClaims ??= new CapacityRegistrationClaims(sql)).claim(args[1] as number, this.workflow!, ticket, envelope!)
          : undefined;
        const workflowOrdinal = workflowPlan
          ? registration?.ordinal ?? this.workflow!.claim(ticket, envelope!, this.native === null) : null;
        if (workflowOrdinal !== null) this.workflowClaims.add(meter);
        // A cold registration already owns its funded event. Claim its exact
        // step before authentication can yield to a warm block prepayment.
        const coldRegistration = workflowPlan && this.native === null && this.kind === 'Competition'
          && method === 'qualificationStep' && this.manifest.profile !== CAPACITY_REGISTRATION_DIAGNOSTIC.profile
          && capacityStep(args[1] as number).action === 'register';
        let coldRegistrationClaim: boolean | null = null;
        if (coldRegistration) {
          initializeCapacitySteps(sql);
          coldRegistrationClaim = claimCapacityStep(sql, run => this.nativeContext.storage.transactionSync(run), args[1] as number);
        }
        const consumeRegistration = coldRegistrationClaim === null ? registration?.consume : () => {
          const claimed = coldRegistrationClaim === true;
          coldRegistrationClaim = false;
          return claimed;
        };
        sql.exec(`CREATE TABLE IF NOT EXISTS capacity_wrapper_state(id INTEGER PRIMARY KEY CHECK(id=1),
          generation INTEGER NOT NULL,retiring_nonce TEXT,socket_ever INTEGER NOT NULL)`);
        if (!workflowPlan) sql.exec(`CREATE TABLE IF NOT EXISTS capacity_wrapper_dispatches(id TEXT PRIMARY KEY,generation INTEGER NOT NULL) WITHOUT ROWID`);
        this.nativeContext.storage.transactionSync(() => {
          const current = sql.exec<{ generation: number; retiring_nonce: string | null }>('SELECT generation,retiring_nonce FROM capacity_wrapper_state WHERE id=1').toArray()[0];
          if (current && (ticket.generation < current.generation || (current.retiring_nonce !== null && ticket.generation === current.generation)
            || (ticket.generation > current.generation && this.native !== null))) throw new Error('capacity_native_generation_invalid');
          if (!workflowPlan) sql.exec('INSERT INTO capacity_wrapper_dispatches VALUES(?,?)', ticket.id, ticket.generation);
          if (!current) sql.exec('INSERT INTO capacity_wrapper_state VALUES(1,?,NULL,0)', ticket.generation);
          else if (current.generation !== ticket.generation) sql.exec('UPDATE capacity_wrapper_state SET generation=?,retiring_nonce=NULL,socket_ever=0 WHERE id=1', ticket.generation);
        });
        event.stage = 'native-initialize';
        this.native ??= (this.kind === 'Game' ? new Game(this.ctx, this.nativeEnv, this.nativeContext)
          : new Competition(this.ctx, this.nativeEnv, this.nativeContext)) as T;
        const claimedAt = enteredAt === null ? null : Date.now();
        let value: R;
        event.stage = 'native-method';
        let loseAcknowledgment = false;
        if (this.kind === 'Game' && (method === 'qualificationStep' || method === 'qualificationSocket')) {
          const context = { authority: this.native as Game, env: this.nativeEnv, sql, manifest: this.manifest, ticket,
            transactionSync: <R>(run: () => R) => this.nativeContext.storage.transactionSync(run),
            bindIntent: (index: number) => this.workflow!.bindIntent(index) };
          value = await (method === 'qualificationStep' ? capacityGameStep(context, args[0] as Request, args[1] as number)
            : capacityGameSocket(context, args[0] as Request, args[1] as number)) as R;
        } else if (this.kind === 'Competition' && method === 'prepareRestart') {
          this.faults ??= new CapacityFaults(sql, this.manifest);
          if (!this.faults.restart()) throw new Error('capacity_restart_not_armed');
          value = undefined as R;
        } else if (method === 'finishQualification' && this.kind === 'Competition') {
          value = await this.finishQualification() as R;
        } else if (method === 'finishWorkflow') {
          if (this.kind === 'Game') await this.finishGameWorkflow();
          value = undefined as R;
        } else if (this.kind === 'Competition' && method === 'prepareQualificationAccount') {
          this.fixtures ??= new CapacityAccountFixtures(this.nativeEnv.DB, sql, this.nativeEnv, this.manifest);
          value = await this.fixtures.prepare(args[0] as number) as R;
        } else if (this.kind === 'Competition' && method === 'prepareQualificationAccounts') {
          this.fixtures ??= new CapacityAccountFixtures(this.nativeEnv.DB, sql, this.nativeEnv, this.manifest);
          value = await this.fixtures.prepareBatch(args[0] as number) as R;
        } else if (this.kind === 'Competition' && method === 'authenticateQualificationAccount') {
          this.fixtures ??= new CapacityAccountFixtures(this.nativeEnv.DB, sql, this.nativeEnv, this.manifest);
          value = await this.fixtures.authenticate(args[0] as Request, args[1] as number) as R;
        } else if (this.kind === 'Competition' && method === 'readQualificationStandings') {
          value = await readCapacityStandings(this.nativeEnv.DB, this.manifest, args[0] as number) as R;
        } else if (this.kind === 'Competition' && (method === 'qualificationStep' || method === 'qualificationSocket')) {
          this.fixtures ??= new CapacityAccountFixtures(this.nativeEnv.DB, sql, this.nativeEnv, this.manifest);
          this.protocol ??= new CapacityProtocol({ authority: this.native as Competition, env: this.nativeEnv,
            sql, transactionSync: run => this.nativeContext.storage.transactionSync(run), manifest: this.manifest,
            fixtures: this.fixtures, intents: new CapacityIntentLedger(sql, run => this.nativeContext.storage.transactionSync(run), this.manifest),
            hooks: {
              stage: stage => { this.scopes.getStore()!.stage = stage; },
              authorizeBinding: this.workflows ? async binding => {
                const workflow = await this.fundWorkflow(`game:${binding.gameId}`);
                return signCapacityBinding({ ...binding, generation: workflow.generation, workflowNonce: workflow.id }, this.manifest, this.env.AUTH_SECRET);
              } : undefined,
              retireGame: async gameId => {
                const envelope = this.envelopes['Game.retire'];
                if (!envelope) throw new Error('capacity_native_envelope_missing');
                return retireCapacityGame(this.env.GAME, this.control, `game:${gameId}`, envelope);
              },
              observeGame: gameId => {
                const game = this.nativeEnv.GAME.get(this.nativeEnv.GAME.idFromName(gameId)) as unknown as {
                  observeQualificationGame(): ReturnType<CapacityProtocolHooks['observeGame']>;
                };
                return game.observeQualificationGame();
              },
              fault: async fault => {
                this.faults ??= new CapacityFaults(sql, this.manifest);
                return this.faults.apply(fault, this.native as Competition);
              },
            } });
          value = await (method === 'qualificationStep'
            ? this.protocol.step(args[0] as Request, args[1] as number, args[2] as AuthActor | null, consumeRegistration)
            : this.protocol.socket(args[0] as Request, args[1] as number)) as R;
        } else if (this.kind === 'Game' && method === 'observeQualificationGame') {
          const observed = await (this.native as Game).status();
          if (!observed) throw new Error('capacity_game_observation_unavailable');
          value = { result: observed.result, terminalVersion: observed.version,
            deliveryPending: sql.exec('SELECT 1 FROM result_delivery LIMIT 1').toArray().length !== 0 } as R;
        } else if (this.kind === 'Competition' && method === 'settle' && this.workflows) {
          this.faults ??= new CapacityFaults(sql, this.manifest);
          if (this.faults.hold(args[0] as GameResult)) value = { accepted: false, pending: true } as R;
          else {
            value = await (this.native as Competition).settle(args[0] as GameResult) as R;
            if ((value as { accepted: boolean; pending: boolean }).accepted && !(value as { pending: boolean }).pending) {
              loseAcknowledgment = this.faults.loseAcknowledgment();
            }
          }
        } else {
          const recovery = this.kind === 'Game' && method === 'alarm' ? this.workflow?.recoveryAt(this.manifest.setupEndsAt) : null;
          if (recovery !== null && recovery !== undefined && Date.now() >= recovery) {
            const result = (await (this.native as Game).status())?.result;
            if (!result || result.status !== 'finished') throw new Error('capacity_recovery_result_unresolved');
            this.workflow!.claimRecovery();
            if (!await (this.native as Game).retryResultDelivery({ eventId: result.eventId, terminalDigest: result.terminalDigest })) {
              throw new Error('capacity_recovery_delivery_unresolved');
            }
          }
          const invoke = (this.native as unknown as Record<string, (...values: unknown[]) => Promise<R>>)[method];
          if (typeof invoke !== 'function') throw new Error('capacity_native_method_missing');
          value = await invoke.apply(this.native, args);
        }
        const methodFinishedAt = enteredAt === null ? null : Date.now();
        event.stage = 'native-follow-on';
        // Follow-on tasks belong to this native event and its permit.
        for (let turn = 0; event.pending.size && turn < 256; turn++) await Promise.all([...event.pending]);
        if (event.pending.size || event.failed) throw new Error('capacity_native_follow_on_unresolved');
        const alarm = await this.nativeContext.storage.getAlarm();
        const close = method === 'finishWorkflow' || method === 'finishQualification' || (this.kind === 'Game' && method === 'qualificationStep'
          && capacityStep(args[1] as number).action === 'retire' && (value as CapacityStepReply).accepted);
        event.stage = 'native-finish';
        const workflowActual = workflowOrdinal !== null ? this.workflow!.finish(workflowOrdinal, meter, close) : undefined;
        event.stage = 'native-metrics';
        const usage = meter.snapshot();
        if (usage.uncertain || usage.unresolvedD1) throw new Error('capacity_native_metrics_uncertain');
        const actual = capacityUsageWork(usage);
        const sockets = this.ctx.getWebSockets().length;
        return { ticketId: ticket.id, value, usage, actual, ...(workflowActual ? { workflowActual } : {}),
          ...(loseAcknowledgment ? { loseAcknowledgment: true } : {}),
          ...(enteredAt === null ? {} : { nativeTiming: { enteredAt, ticketAt: ticketAt!, claimedAt: claimedAt!,
            methodFinishedAt: methodFinishedAt!, returningAt: Date.now() } }),
          drained: { pendingNative: 0, alarm: alarm !== null, sockets, alarmPossible: event.alarmPossible, socketPossible: event.socketPossible } };
      } catch (error) {
        // No release on an uncertain reply, rejected bound or incomplete I/O.
        // The same native object and its durable dispatch remain charged.
        throw error;
      }
    }); } finally { this.inFlight--; }
  }
}

export class CapacityNativeWrapper<T extends Game | Competition> {
  private host: CapacityNativeHost<T> | null = null;
  private retiring: CapacityTicket<CapacityRetirement> | null = null;
  private alarmRunning = false;
  private alarmDrained = false;
  private resolveAlarm: (() => void) | null = null;
  private releaseAlarm: (() => void) | null = null;
  constructor(private ctx: DurableObjectState, private env: CapacityEnv, private kind: 'Game' | 'Competition',
    private localFixture?: { manifest: CapacityManifest; envelopes: Readonly<Record<CapacityOperation, CapacityWorkUnits>>; control: CapacityControl;
      workflows?: CapacityWorkflowPlans }) {}

  private qualification() {
    const manifest = this.localFixture?.manifest ?? SEALED_CAPACITY_MANIFEST;
    const envelopes = this.localFixture?.envelopes ?? VERIFIED_NATIVE_ENVELOPES;
    if (!manifest || !envelopes) throw new Error('capacity_candidate_unqualified');
    const control = this.localFixture?.control ?? this.env.CAPACITY_RUN.get(this.env.CAPACITY_RUN.idFromName(manifest.runId));
    const workflows = this.localFixture?.workflows ?? (VERIFIED_GAME_WORKFLOW_PLAN && VERIFIED_COMPETITION_WORKFLOW_PLAN
      ? { Game: VERIFIED_GAME_WORKFLOW_PLAN, Competition: VERIFIED_COMPETITION_WORKFLOW_PLAN,
        ...(VERIFIED_DELAYED_GAME_WORKFLOW_PLAN ? { delayed: VERIFIED_DELAYED_GAME_WORKFLOW_PLAN } : {}),
        ...(VERIFIED_SOCKET_GAME_WORKFLOW_PLAN ? { socket: VERIFIED_SOCKET_GAME_WORKFLOW_PLAN } : {}) } : undefined);
    this.host ??= new CapacityNativeHost<T>(this.ctx, this.env, this.kind, manifest, control, envelopes, workflows);
    return { manifest, envelopes, control, host: this.host, workflows };
  }

  async rpc<R>(method: string, args: unknown[], ticket: CapacityTicket<CapacityDispatch>): Promise<CapacityNativeReply<R>> {
    if (this.retiring || (ticket?.mode !== 'rpc' && ticket?.mode !== 'workflow')) throw new Error('capacity_native_generation_fenced');
    return this.qualification().host.invoke<R>(ticket, method, args);
  }

  async automatic<R>(method: string, args: unknown[] = [], meter?: CapacityNativeMeter): Promise<R | undefined> {
    const { manifest, envelopes, control, host, workflows } = this.qualification();
    allowed(manifest);
    if (workflows) {
      const measured = meter ?? new CapacityNativeMeter();
      const ticket = host.workflowTicket(measured);
      if (!ticket) return;
      return (await host.invoke<R>(ticket, method, args, measured)).value;
    }
    const operation = `${this.kind}.${method}` as CapacityOperation;
    const envelope = envelopes[operation];
    if (!envelope) throw new Error('capacity_native_envelope_missing');
    const objectKey = this.kind === 'Game' ? `game:${this.ctx.id.name}` : 'competition';
    const ticket = await control.begin(crypto.randomUUID(), objectKey, operation, envelope, 'automatic');
    // A retirement may fence an already delivered alarm before it asks for
    // work. Do no native work and do not create an alarm retry in that case.
    if (!ticket) return;
    const reply = await host.invoke<R>(ticket, method, args, meter);
    if (!await control.complete(ticket, reply.actual, reply.drained)) throw new Error('capacity_native_completion_unresolved');
    return reply.value;
  }

  private async holdAlarm(): Promise<void> {
    this.alarmDrained = true;
    const hold = new Promise<void>(resolve => { this.releaseAlarm = resolve; });
    this.resolveAlarm?.();
    // Lost callers retain their lifetime permit. They cannot leave a local
    // pending promise past this prepaid finite barrier.
    const timer = setTimeout(() => this.releaseAlarm?.(), CAPACITY_RETIREMENT_ALARM_WAIT_MS);
    try { await hold; } finally { clearTimeout(timer); this.releaseAlarm = null; }
  }

  async alarm(): Promise<void> {
    const { manifest, host } = this.qualification();
    const meter = new CapacityNativeMeter();
    let workflowPresent = false;
    this.alarmRunning = true;
    this.alarmDrained = false;
    try {
      if (this.retiring) { await this.holdAlarm(); return; }
      // A cold interrupted retirement has lost its caller. Clear its finite
      // trigger and retain the controller fence and lifetime permit.
      const sql = meter.sql(this.ctx.storage.sql);
      const saved = sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='capacity_wrapper_state'").toArray().length
        ? sql.exec<{ retiring_nonce: string | null }>('SELECT retiring_nonce FROM capacity_wrapper_state WHERE id=1').toArray()[0] : null;
      if (saved?.retiring_nonce) {
        await meter.alarm('write', () => this.ctx.storage.deleteAlarm());
        await this.ctx.storage.sync();
        this.retirementUsage(meter);
        return;
      }
      workflowPresent = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='capacity_wrapper_workflow'").toArray().length !== 0;
      const workflow = workflowPresent
        ? sql.exec<{ closed: number; stopped: number }>('SELECT closed,stopped FROM capacity_wrapper_workflow WHERE id=1').toArray()[0] : null;
      if (workflow?.closed || workflow?.stopped) { await freezeCapacity(this.ctx, meter, manifest.runId, Boolean(workflow.stopped)); return; }
      if (Date.now() >= manifest.issueCloseAt) { await freezeCapacity(this.ctx, meter, manifest.runId); return; }
      await this.automatic<void>('alarm', [], meter);
      if (this.retiring) await this.holdAlarm();
    } catch {
      // An admitted failed event keeps its whole reservation. A rejected claim
      // instead spends this authority's prepaid terminal callback, including
      // its schema/ledger prefix. Never refund either or retry the alarm.
      const cleanup = host.workflowClaimed(meter) ? new CapacityNativeMeter() : meter;
      try {
        if (workflowPresent) cleanup.sql(this.ctx.storage.sql)
          .exec('UPDATE capacity_wrapper_workflow SET stopped=1 WHERE id=1 AND stopped=0');
      } finally {
        // The durable stop/unresolved claim fences a later scheduled delivery.
        // Abort still runs if the fence or alarm deletion has uncertain I/O.
        await freezeCapacity(this.ctx, cleanup, manifest.runId, true);
      }
    } finally { this.alarmRunning = false; this.alarmDrained = false; }
  }

  async restart(ticket: CapacityTicket<CapacityDispatch>): Promise<never> {
    const { manifest, host } = this.qualification();
    if (this.kind !== 'Competition' || this.retiring) throw new Error('capacity_restart_invalid');
    await this.rpc<void>('prepareRestart', [], ticket);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (host.activeInvocations !== 0) throw new Error('capacity_restart_not_drained');
      await this.ctx.storage.sync();
      this.ctx.abort(`capacity-restarted:${manifest.runId}`, { retryAlarm: false });
      throw new Error('capacity_restart_abort_returned');
    });
  }

  /** One fresh-stub call only. Its only success signal is the raw abort error. */
  async retire(value: CapacityTicket<CapacityRetirement>): Promise<never> {
    const { manifest, host } = this.qualification();
    allowed(manifest);
    const codec = new CapacityTicketCodec(this.env.AUTH_SECRET);
    if (this.kind !== 'Game' || !await codec.validRetirement(value, manifest)
      || value.objectKey !== `game:${this.ctx.id.name}` || this.retiring) throw new Error('capacity_retirement_invalid');
    this.retiring = value;
    const barrier = new Promise<void>(resolve => { this.resolveAlarm = resolve; });
    const meter = new CapacityNativeMeter();
    const sql = meter.sql(this.ctx.storage.sql);
    const saved = sql.exec<{ generation: number; socket_ever: number; retiring_nonce: string | null }>(
      'SELECT generation,socket_ever,retiring_nonce FROM capacity_wrapper_state WHERE id=1').toArray()[0];
    if (!saved || saved.generation !== value.generation || saved.socket_ever !== 0 || saved.retiring_nonce !== null
      || host.activeInvocations !== 0 || this.ctx.getWebSockets().length !== 0) throw new Error('capacity_retirement_not_drained');
    sql.exec('UPDATE capacity_wrapper_state SET retiring_nonce=? WHERE id=1', value.nonce);
    await this.ctx.storage.sync();
    // Supersede future product scheduling with one prepaid private trigger.
    // getAlarm=null is never used to infer that a handler is not running.
    await meter.alarm('write', () => this.ctx.storage.setAlarm(Date.now() + 1));
    await this.ctx.storage.sync();
    if (this.alarmRunning && this.alarmDrained) this.resolveAlarm?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([barrier, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('capacity_retirement_alarm_unconfirmed')), CAPACITY_RETIREMENT_ALARM_WAIT_MS);
      })]);
      return await this.ctx.blockConcurrencyWhile(async () => {
        if (!this.alarmRunning || !this.alarmDrained || host.activeInvocations !== 0 || this.ctx.getWebSockets().length !== 0
          || Date.now() >= manifest.hardCloseAt) throw new Error('capacity_retirement_barrier_lost');
        await meter.alarm('write', () => this.ctx.storage.deleteAlarm());
        await this.ctx.storage.sync();
        this.retirementUsage(meter);
        // Only this private emitter produces this exact one-use message.
        this.ctx.abort(capacityRetirementAck(value), { retryAlarm: false });
        throw new Error('capacity_abort_returned');
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.resolveAlarm = null;
      this.releaseAlarm?.();
      // No release is inferred from this path, including an abort whose reply
      // is lost. The controller holds the generation until the exact ack.
    }
  }

  private retirementUsage(meter: CapacityNativeMeter): void {
    const { envelopes } = this.qualification(), limit = envelopes['Game.retire'], usage = meter.snapshot();
    if (!limit || usage.uncertain || usage.unresolvedD1 || usage.doRowsRead > limit.doRowsRead
      || usage.doRowsWritten > limit.doRowsWritten || usage.d1RowsRead || usage.d1RowsWritten) {
      throw new Error('capacity_retirement_envelope_exceeded');
    }
  }
}

export async function retireCapacityGame(namespace: CapacityNamespace, control: CapacityControl,
  objectKey: string, envelope: CapacityWorkUnits): Promise<boolean> {
  const value = await control.prepareRetirement(objectKey, envelope);
  if (!value) return false;
  // An exception poisons a Durable Object stub. Never reuse an earlier stub
  // or retry this one: a repeated error is not evidence of a second reset.
  const stub = namespace.get(namespace.idFromName(objectKey.slice(5))) as unknown as { retire(value: CapacityTicket<CapacityRetirement>): Promise<never> };
  try { await stub.retire(value); }
  catch (error) {
    const acknowledgment = capacityRetirementAck(value);
    if (error instanceof Error && error.message === acknowledgment) return control.confirmRetirement(value, acknowledgment);
  }
  return false;
}

async function freezeCapacity(ctx: DurableObjectState, meter: CapacityNativeMeter, runId: string, failed = false): Promise<void> {
  // Private synthetic state only. Preserve unfinished payloads and permits.
  try {
    for (const socket of ctx.getWebSockets()) socket.close(1001, 'Qualification expired');
    await meter.alarm('write', () => ctx.storage.deleteAlarm());
    await ctx.storage.sync();
  }
  finally {
    // Stop a delivered stale/expired alarm without a platform retry. This is
    // never a permit release acknowledgment and cannot qualify retirement.
    const usage = meter.snapshot();
    const exceeded = usage.uncertain || usage.unresolvedD1 || usage.d1RowsRead || usage.d1RowsWritten
      || usage.doRowsRead > CAPACITY_FREEZE_CALLBACK_WORK.doRowsRead / CAPACITY_FREEZE_CALLBACK_WORK.nativeDoRequests
      || usage.doRowsWritten > CAPACITY_FREEZE_CALLBACK_WORK.doRowsWritten - 1;
    const reason = exceeded ? 'capacity-freeze-envelope-exceeded' : failed ? 'capacity-alarm-failed' : 'capacity-frozen';
    ctx.abort(`${reason}:${runId}`, { retryAlarm: false });
  }
}

export class CapacityGame extends DurableObject<CapacityEnv> {
  #native = new CapacityNativeWrapper<Game>(this.ctx, this.env, 'Game');
  async qualificationStep(request: Request, index: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<CapacityStepReply>('qualificationStep', [request, index], ticket); }
  async qualificationSocket(request: Request, index: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Response>('qualificationSocket', [request, index], ticket); }
  async finishWorkflow(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<void>('finishWorkflow', [], ticket); }
  async init(input: InitGame, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['init']>>>('init', [input], ticket); }
  async join(actor: Actor, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['join']>>>('join', [actor], ticket); }
  async claimSeat(actor: Actor, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['claimSeat']>>>('claimSeat', [actor], ticket); }
  async snapshot(actor: Actor, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['snapshot']>>>('snapshot', [actor], ticket); }
  async lookup(actor: Actor, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['lookup']>>>('lookup', [actor], ticket); }
  async status(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['status']>>>('status', [], ticket); }
  async observeQualificationGame(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<CapacityProtocolHooks['observeGame']>>>('observeQualificationGame', [], ticket); }
  async command(actor: Actor, command: GameCommand, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['command']>>>('command', [actor, command], ticket); }
  async enforceTournamentDeadline(id: string, round: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['enforceTournamentDeadline']>>>('enforceTournamentDeadline', [id, round], ticket); }
  async archive(input: Parameters<Game['archive']>[0], ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Game['archive']>>>('archive', [input], ticket); }
  async openSocket(request: Request, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Response>('fetch', [request], ticket); }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) { await this.#native.automatic<void>('webSocketMessage', [socket, message]); }
  async webSocketClose(socket: WebSocket, code: number, reason: string) { await this.#native.automatic<void>('webSocketClose', [socket, code, reason]); }
  async webSocketError(socket: WebSocket) { await this.#native.automatic<void>('webSocketError', [socket]); }
  async flush(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<void>('flush', [], ticket); }
  async alarm() { await this.#native.alarm(); }
  async retire(value: CapacityTicket<CapacityRetirement>) { return this.#native.retire(value); }
}

export class CapacityCompetition extends DurableObject<CapacityEnv> {
  #native = new CapacityNativeWrapper<Competition>(this.ctx, this.env, 'Competition');
  async finishWorkflow(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<void>('finishWorkflow', [], ticket); }
  async finishQualification(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<CapacityShutdownReceipt>('finishQualification', [], ticket); }
  async restart(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.restart(ticket); }
  async prepareQualificationAccount(index: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<CapacityAccountCredential>('prepareQualificationAccount', [index], ticket); }
  async prepareQualificationAccounts(first: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<CapacityAccountCredential[]>('prepareQualificationAccounts', [first], ticket); }
  async authenticateQualificationAccount(request: Request, index: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<CapacityAccountFixtures['authenticate']>>>('authenticateQualificationAccount', [request, index], ticket); }
  async readQualificationStandings(index: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<typeof readCapacityStandings>>>('readQualificationStandings', [index], ticket); }
  async qualificationStep(request: Request, index: number, actor: AuthActor | null, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<CapacityProtocol['step']>>>('qualificationStep', [request, index, actor], ticket); }
  async qualificationSocket(request: Request, index: number, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Response>('qualificationSocket', [request, index], ticket); }
  async createCasualGame(actor: Actor, input: CasualGameInput, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['createCasualGame']>>>('createCasualGame', [actor, input], ticket); }
  async listTournaments(actor: Actor | undefined, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['listTournaments']>>>('listTournaments', [actor], ticket); }
  async getTournament(id: string, actor: Actor | undefined, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['getTournament']>>>('getTournament', [id, actor], ticket); }
  async registerTournament(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['registerTournament']>>>('registerTournament', [actor, id], ticket); }
  async withdrawTournament(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['withdrawTournament']>>>('withdrawTournament', [actor, id], ticket); }
  async getArenaMe(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['getArenaMe']>>>('getArenaMe', [actor, id], ticket); }
  async observeArenaReservation(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['observeArenaReservation']>>>('observeArenaReservation', [actor, id], ticket); }
  async registerArena(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['registerArena']>>>('registerArena', [actor, id], ticket); }
  async withdrawArena(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['withdrawArena']>>>('withdrawArena', [actor, id], ticket); }
  async queueArena(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['queueArena']>>>('queueArena', [actor, id], ticket); }
  async pauseArena(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['pauseArena']>>>('pauseArena', [actor, id], ticket); }
  async resumeArena(actor: Actor, id: string, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['resumeArena']>>>('resumeArena', [actor, id], ticket); }
  async settle(result: GameResult, ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['settle']>>>('settle', [result], ticket); }
  async flush(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<void>('flush', [], ticket); }
  async health(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['health']>>>('health', [], ticket); }
  async maintenance(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['maintenance']>>>('maintenance', [], ticket); }
  async retirePayloads(ticket: CapacityTicket<CapacityDispatch>) { return this.#native.rpc<Awaited<ReturnType<Competition['retirePayloads']>>>('retirePayloads', [], ticket); }
  async alarm() { await this.#native.alarm(); }
}
