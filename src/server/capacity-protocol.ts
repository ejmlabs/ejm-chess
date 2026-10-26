import { CAPACITY_CORPUS, CAPACITY_STEP_COUNT, capacityEventId, capacitySocketSlot, capacityStep,
  type CapacityFault, type CapacityStepReply } from '../shared/capacity-corpus';
import type { GameResult } from '../shared/protocol';
import type { Competition } from './competition';
import type { Game } from './game';
import type { Actor } from './auth';
import type { Env } from './env';
import type { CapacityAccountFixtures } from './capacity-fixtures';
import { authenticateCapacitySession } from './capacity-fixtures';
import { readCapacityBinding, type CapacityBindingAuthorization } from './capacity-binding';
import type { CapacityBoundIntent, CapacityIntentLedger } from './capacity-intents';
import type { CapacityDispatch, CapacityManifest, CapacityTicket, CapacityWorkUnits } from './capacity-run';
import type { CapacityWorkflowLedger } from './capacity-workflow';
import { ApiError } from './security';
import type { CapacityFailureStage } from '../shared/capacity-failure';

export interface CapacityProtocolHooks {
  stage?(stage: CapacityFailureStage): void;
  retireGame(gameId: string): Promise<boolean>;
  observeGame(gameId: string): Promise<{ result: GameResult | null; deliveryPending: boolean; terminalVersion: number }>;
  fault(fault: CapacityFault): Promise<boolean>;
  authorizeBinding?(binding: CapacityBoundIntent): Promise<string>;
}

export interface CapacityProtocolContext {
  authority: Competition;
  env: Env;
  sql: SqlStorage;
  transactionSync<T>(work: () => T): T;
  manifest: CapacityManifest;
  fixtures: CapacityAccountFixtures;
  intents: CapacityIntentLedger;
  hooks: CapacityProtocolHooks;
}

export function initializeCapacitySteps(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS capacity_protocol_steps(block_index INTEGER PRIMARY KEY,issued INTEGER NOT NULL)');
}

/** One durable corpus ordinal per native object, including socket replacements. */
export function claimCapacityStep(sql: SqlStorage, transact: <R>(work: () => R) => R, index: number): boolean {
  const block = Math.floor(index / 30), bit = 1 << (index % 30);
  return transact(() => {
    const row = sql.exec<{ issued: number }>('SELECT issued FROM capacity_protocol_steps WHERE block_index=?', block).toArray()[0];
    if ((row?.issued ?? 0) & bit) return false;
    sql.exec(`INSERT INTO capacity_protocol_steps(block_index,issued) VALUES(?,?)
      ON CONFLICT(block_index) DO UPDATE SET issued=excluded.issued`, block, (row?.issued ?? 0) | bit);
    return true;
  });
}

/** Only the full fixed burst prepays 32 exact once-only registration slots. */
export class CapacityRegistrationClaims {
  private blocks = new Map<number, { firstOrdinal: number; issued: number }>();
  constructor(private sql: SqlStorage) {}

  claim(index: number, ledger: CapacityWorkflowLedger, ticket: CapacityTicket<CapacityDispatch>,
    envelope: CapacityWorkUnits): { ordinal: number; consume(): boolean } | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= CAPACITY_CORPUS.registrationBurst) return;
    const first = Math.floor(index / 32) * 32;
    let block = this.blocks.get(first);
    if (!block) {
      const count = Math.min(32, CAPACITY_CORPUS.registrationBurst - first);
      let firstOrdinal: number;
      try {
        firstOrdinal = ledger.claimBlock(ticket, envelope, count, () => {
          initializeCapacitySteps(this.sql);
          const masks = new Map<number, number>();
          for (let offset = 0; offset < count; offset++) {
            const step = first + offset, row = Math.floor(step / 30);
            masks.set(row, (masks.get(row) ?? 0) | (1 << (step % 30)));
          }
          const rows = [...masks].map(([row, mask]) => ({ row, mask,
            issued: this.sql.exec<{ issued: number }>('SELECT issued FROM capacity_protocol_steps WHERE block_index=?', row).toArray()[0]?.issued ?? 0 }));
          if (rows.some(row => row.issued & row.mask)) throw new Error('capacity_registration_block_issued');
          for (const row of rows) this.sql.exec(`INSERT INTO capacity_protocol_steps(block_index,issued) VALUES(?,?)
            ON CONFLICT(block_index) DO UPDATE SET issued=excluded.issued`, row.row, row.issued | row.mask);
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'capacity_registration_block_issued') return;
        throw error;
      }
      block = { firstOrdinal, issued: 0 };
      this.blocks.set(first, block);
    }
    const offset = index - first, bit = 1 << offset;
    if (block.issued & bit) return;
    const ordinal = block.firstOrdinal + offset;
    ledger.claimReserved(ticket, ordinal);
    block.issued = (block.issued | bit) >>> 0;
    // The permission belongs only to this invocation. A rejected actor or a
    // lost native reply cannot leave a reusable permission for a later call.
    let used = false;
    return { ordinal, consume: () => { if (used) return false; used = true; return true; } };
  }
}

interface CapacityGameProtocolContext {
  authority: Game; env: Env; sql: SqlStorage; manifest: CapacityManifest;
  ticket: CapacityTicket<CapacityDispatch>; transactionSync<R>(work: () => R): R;
  bindIntent(index: number): void;
}

async function boundGameActor(context: CapacityGameProtocolContext, request: Request, intentIndex: number,
  role: 'white' | 'black'): Promise<{ binding: CapacityBindingAuthorization; actor: Awaited<ReturnType<typeof authenticateCapacitySession>> }> {
  const { manifest, env, ticket } = context;
  const binding = await readCapacityBinding(request, manifest, env.AUTH_SECRET, intentIndex);
  if (ticket.objectKey !== `game:${binding.gameId}` || ticket.generation !== binding.generation
    || ticket.id !== binding.workflowNonce) throw new Error('capacity_binding_invalid');
  context.bindIntent(intentIndex);
  const actor = await authenticateCapacitySession(env.DB, env, manifest, request,
    binding[role === 'white' ? 'whiteAccountIndex' : 'blackAccountIndex']);
  return { binding, actor };
}

/** Primary auth and signed seats are checked again inside the prepaid Game. */
export async function capacityGameStep(context: CapacityGameProtocolContext, request: Request, index: number): Promise<CapacityStepReply> {
  const step = capacityStep(index);
  if (step.intentIndex === undefined || step.actor.kind !== 'bound-seat'
    || !['command', 'observe-settlement', 'retire', 'duplicate-result'].includes(step.action)) throw new Error('capacity_game_step_invalid');
  const { binding, actor } = await boundGameActor(context, request, step.intentIndex, step.actor.role);
  initializeCapacitySteps(context.sql);
  const reply = (accepted: boolean, acceptedAt: number | null, code?: string): CapacityStepReply => ({ index, accepted, acceptedAt, ...(code ? { code } : {}) });
  if (!claimCapacityStep(context.sql, context.transactionSync, index)) return reply(false, null, 'capacity_step_already_issued');
  if (step.action === 'command') {
    const result = await context.authority.command(actor, step.command!);
    return result.ok ? reply(true, result.receipt.acceptedAt) : reply(false, null, result.code);
  }
  const status = await context.authority.status(), result = status?.result;
  const pending = context.sql.exec('SELECT 1 FROM result_delivery WHERE id=1').toArray().length !== 0;
  if (!result || result.id !== binding.gameId || result.reservationId !== binding.reservationId
    || result.tournament?.id !== binding.eventId || result.white.id !== binding.whiteId
    || result.black?.id !== binding.blackId) throw new Error('capacity_terminal_observation_unresolved');
  if (step.action === 'duplicate-result') {
    const settled = await context.env.COMPETITION.get(context.env.COMPETITION.idFromName('global')).settle(result);
    const accepted = settled.accepted && !settled.pending;
    return { ...reply(accepted, accepted ? Date.now() : null, accepted ? undefined : 'capacity_settlement_pending'),
      result: { settled: accepted, deliveryPending: pending, terminalVersion: status!.version } };
  }
  const accepted = result.status === 'finished' && !pending;
  return { ...reply(accepted, accepted ? Date.now() : null, accepted ? undefined : 'capacity_settlement_pending'),
    result: { settled: accepted, deliveryPending: pending, terminalVersion: status!.version } };
}

export async function capacityGameSocket(context: CapacityGameProtocolContext, request: Request, index: number): Promise<Response> {
  const slot = capacitySocketSlot(index);
  const { actor } = await boundGameActor(context, request, slot.intentIndex, slot.role);
  initializeCapacitySteps(context.sql);
  if (!claimCapacityStep(context.sql, context.transactionSync, CAPACITY_STEP_COUNT + index)) return new Response('Socket slot already issued', { status: 409 });
  return context.authority.fetch(new Request('https://game.internal/connect', {
    headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(actor) },
  }));
}

/** Fixed addresses compose normal authorities. No request supplies a selector. */
export class CapacityProtocol {
  constructor(private context: CapacityProtocolContext) {
    initializeCapacitySteps(context.sql);
  }

  #window(): void {
    const now = Date.now(), { manifest } = this.context;
    if (now < manifest.earliestArmAt || now >= manifest.issueCloseAt) throw new Error('capacity_protocol_expired');
  }

  #claim(index: number, prepaid?: () => boolean): boolean {
    // Thirty bits fit SQLite's and JavaScript's integer bit operations. A
    // compact durable bitmap fences request replay without storing payloads.
    return prepaid ? prepaid() : claimCapacityStep(this.context.sql, this.context.transactionSync, index);
  }

  #binding(index: number): CapacityBoundIntent {
    const binding = this.context.intents.binding(index);
    if (!binding) throw new Error('capacity_binding_unresolved');
    return binding;
  }

  async step(request: Request, index: number, authenticatedActor: Actor | null, prepaid?: () => boolean): Promise<CapacityStepReply> {
    const step = capacityStep(index);
    this.#window();
    const { authority, env, manifest, fixtures, intents, hooks } = this.context;
    const bound = step.intentIndex !== undefined && !['queue', 'observe-binding'].includes(step.action)
      ? this.#binding(step.intentIndex) : null;
    const actorIndex = step.actor.kind === 'account' ? step.actor.accountIndex
      : bound![step.actor.role === 'white' ? 'whiteAccountIndex' : 'blackAccountIndex'];
    // Registration uses the product's global auth guard before any primary
    // authentication. A supplied actor never substitutes for its real cookie.
    let primaryActor = authenticatedActor;
    if (step.action === 'register') {
      hooks.stage?.('registration-auth');
      try { primaryActor = await authority.authenticateArenaRegistration(request); }
      catch (error) {
        if (error instanceof ApiError) return { index, accepted: false, acceptedAt: null,
          code: error.code, httpStatus: error.status };
        throw error;
      }
    }
    hooks.stage?.(step.action === 'register' ? 'registration-account' : 'native-method');
    const actor = fixtures.authenticatedActor(primaryActor as Actor, actorIndex);
    this.#window();
    if (bound && actor.id !== bound.whiteId && actor.id !== bound.blackId) throw new Error('capacity_session_invalid');
    if ((step.action === 'queue' || step.action === 'register') && Date.now() >= manifest.admissionsCloseAt) {
      throw new Error('capacity_admissions_expired');
    }
    hooks.stage?.(step.action === 'register' ? 'registration-step' : 'native-method');
    if (!this.#claim(index, prepaid)) return { index, accepted: false, acceptedAt: null, code: 'capacity_step_already_issued' };
    const eventId = capacityEventId(step.eventIndex, manifest.earliestArmAt);
    const reply = (accepted: boolean, acceptedAt: number | null, code?: string): CapacityStepReply => ({ index, accepted, acceptedAt, ...(code ? { code } : {}) });

    if (step.action === 'register' || step.action === 'queue') {
      // This durable pending record must exist before either normal queue call.
      if (step.action === 'queue') intents.reserve(step.intentIndex!);
      const { id, name, isAnonymous, sessionId, sessionExpiresAt } = actor;
      hooks.stage?.(step.action === 'register' ? 'arena-register' : 'native-method');
      const result = step.action === 'register'
        ? await authority.registerArena({ id, name, isAnonymous, sessionId, sessionExpiresAt }, eventId)
        : await authority.queueArena(actor, eventId);
      if (!result.ok) return { ...reply(false, null, result.error.code), httpStatus: result.error.status };
      if (result.value.id !== eventId) throw new Error('capacity_native_event_conflict');
      return { ...reply(true, result.value.serverNow), event: { eventIndex: step.eventIndex, eventId } };
    }
    if (step.action === 'observe-binding') {
      const binding = intents.discover(step.intentIndex!);
      if (!binding) return reply(true, Date.now(), 'capacity_binding_unresolved');
      const bindingProof = await hooks.authorizeBinding?.(binding);
      return { ...reply(true, Date.now()), binding, ...(bindingProof ? { bindingProof } : {}) };
    }
    if (step.action === 'fault') {
      const accepted = await hooks.fault(step.fault!);
      return reply(accepted, accepted ? Date.now() : null, accepted ? undefined : 'capacity_fault_unqualified');
    }
    if (!bound) throw new Error('capacity_binding_unresolved');
    if (step.action === 'command') {
      const game = env.GAME.get(env.GAME.idFromName(bound.gameId));
      const result = await game.command(actor, step.command!);
      return result.ok ? reply(true, result.receipt.acceptedAt) : reply(false, null, result.code);
    }
    if (step.action === 'retire') {
      const accepted = await hooks.retireGame(bound.gameId);
      return reply(accepted, accepted ? Date.now() : null, accepted ? undefined : 'capacity_retirement_unconfirmed');
    }
    const observed = await hooks.observeGame(bound.gameId);
    if (!observed.result || observed.result.id !== bound.gameId || observed.result.reservationId !== bound.reservationId
      || observed.result.tournament?.id !== bound.eventId || observed.result.white.id !== bound.whiteId
      || observed.result.black?.id !== bound.blackId) throw new Error('capacity_terminal_observation_unresolved');
    if (step.action === 'duplicate-result') {
      const result = await authority.settle(observed.result);
      return { ...reply(result.accepted && !result.pending, result.accepted && !result.pending ? Date.now() : null,
        result.accepted && !result.pending ? undefined : 'capacity_settlement_pending'),
        result: { settled: result.accepted && !result.pending, deliveryPending: observed.deliveryPending, terminalVersion: observed.terminalVersion } };
    }
    const settled = observed.result.status === 'finished' && !observed.deliveryPending;
    return { ...reply(settled, settled ? Date.now() : null, settled ? undefined : 'capacity_settlement_pending'),
      result: { settled, deliveryPending: observed.deliveryPending, terminalVersion: observed.terminalVersion } };
  }

  async socket(request: Request, index: number): Promise<Response> {
    const slot = capacitySocketSlot(index);
    this.#window();
    const { env, fixtures } = this.context;
    const bound = this.#binding(slot.intentIndex);
    const actor = await fixtures.authenticate(request, bound[slot.role === 'white' ? 'whiteAccountIndex' : 'blackAccountIndex']);
    this.#window();
    if (!this.#claim(CAPACITY_STEP_COUNT + index)) return new Response('Socket slot already issued', { status: 409 });
    const headers = new Headers({ Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(actor) });
    return env.GAME.get(env.GAME.idFromName(bound.gameId)).fetch(new Request('https://game.internal/connect', { headers }));
  }
}
