import type { GameCommand } from './protocol';

/** Private direct-Game routing capability. Never include its value in evidence. */
export const CAPACITY_BINDING_HEADER = 'x-capacity-binding';
/** Private signed workflow permission. Never include its value in evidence. */
export const CAPACITY_COMPETITION_HEADER = 'x-capacity-competition';
export const CAPACITY_PREPARATION_BATCH_SIZE = 32;
export const CAPACITY_PREPARATION_SINGLE_ATTEMPT_READS = 640;
export const CAPACITY_D1_READ_ATTEMPTS = 3;
export const CAPACITY_INGRESS_BLOCK_REQUESTS = 256;
export const CAPACITY_CONTROL_HTTP_REQUESTS = 32;
/** Fixed primary fixtures and public projection point lookups, including indexes. */
export const CAPACITY_WARM_D1_READ_ROWS = 8;

/** Frozen short provider diagnosis. It never qualifies the complete corpus. */
export const CAPACITY_REGISTRATION_DIAGNOSTIC = Object.freeze({
  profile: 'registration-diagnostic-v1' as const, accounts: 256, registrations: 768,
  credentialSealOffsetMs: 25_000, credentialLoadOffsetMs: 27_000,
  registrationOffsetMs: 30_000, registrationIntervalMs: 3, stopOffsetMs: 55_000,
  finalStatusOffsetMs: 61_000,
});

export function capacityRegistrationDiagnosticStep(index: number): boolean {
  return Number.isSafeInteger(index) && ((index >= 0 && index < 256)
    || (index >= 6_000 && index < 6_256) || (index >= 10_000 && index < 10_256));
}

export function capacityRegistrationDiagnosticSchedule(start: number) {
  capacityEventId(0, start);
  return { earliestArmAt: start, latestArmAt: start + 5_000, setupEndsAt: start + 25_000,
    streamStartsAt: start + 40_000, streamEndsAt: start + 40_000,
    admissionsCloseAt: start + 40_000, issueCloseAt: start + 70_000, hardCloseAt: start + 90_000 };
}

/** Private workload labels only. Native event and Game IDs come from Competition. */
export const CAPACITY_CORPUS = Object.freeze({
  schema: 'ejm-chess-capacity-corpus-v1',
  accounts: 6_000, fixturePreparations: 6_000, events: 3, accountsPerEvent: 2_000,
  gameIntents: 20_000, delayedGames: 1_000, regularGames: 18_000, socketGames: 1_000,
  regularDurationMs: 900_000, regularIntervalMs: 50,
  registrationBurst: 10_000, registrationBurstMs: 30_000,
  registrationConfirm: 6_000, registrationConfirmIntervalMs: 67,
  commandsPerGame: 7, bindingObservationsPerGame: 2,
  duplicateResultsPerDelayedGame: 5,
  participantSockets: 2_000, socketGenerations: 2,
  standingsPageRows: 32, standingsPagesPerEvent: 63, spectatorReads: 900_000,
  spectatorIntervalMs: 1, spectatorRefreshMs: 10_000,
  maximumWorkerRequests: 1_200_000,
  recoveryLeadMs: 10_000, recoveryEarlyGames: 400, recoveryEarlyIntervalMs: 25,
  recoveryConcurrentIntervalMs: 50, recoveryDurationMs: 40_000,
});

/** One private fixture batch contains at most 96 D1 insert statements. */
export function capacityPreparationAccounts(first: number): number[] {
  capacityAccountId(first);
  if (first % CAPACITY_PREPARATION_BATCH_SIZE) throw new Error('capacity_fixture_batch_invalid');
  return Array.from({ length: Math.min(CAPACITY_PREPARATION_BATCH_SIZE, CAPACITY_CORPUS.accounts - first) }, (_, offset) => first + offset);
}

export type CapacityIntentKind = 'delayed' | 'regular' | 'socket';
export type CapacityRole = 'white' | 'black';
export type CapacityActor = { kind: 'account'; accountIndex: number }
  | { kind: 'bound-seat'; intentIndex: number; role: CapacityRole };
export type CapacityFault = 'hold-delayed-results' | 'release-delayed-results'
  | 'projection-unavailable-once' | 'competition-restart-once'
  | 'lose-result-ack-once' | 'conflicting-result-once';

/** A binding is permanent. An absent or uncertain binding never licenses another intent. */
export interface CapacityIntentBinding {
  intentIndex: number;
  gameId: string;
  whiteAccountIndex: number;
  blackAccountIndex: number;
  eventIndex: number;
}

export interface CapacityEventBinding { eventIndex: number; eventId: string }

export interface CapacityRunSchedule {
  earliestArmAt: number; latestArmAt: number; setupEndsAt: number;
  streamStartsAt: number; streamEndsAt: number; admissionsCloseAt: number;
  issueCloseAt: number; hardCloseAt: number;
}

export interface CapacityManifestReadback {
  ready: boolean; armed: null; manifestDigest: string | null;
  blockers: string[]; schedule: CapacityRunSchedule | null;
}

export interface CapacityStepReply {
  index: number;
  accepted: boolean;
  /** Real authority acceptance time, null when the outcome is unknown or denied. */
  acceptedAt: number | null;
  binding?: CapacityIntentBinding;
  bindingProof?: string;
  event?: CapacityEventBinding;
  result?: { settled: boolean; deliveryPending: boolean; terminalVersion: number };
  code?: string;
  httpStatus?: number;
}

export interface CapacityIntent {
  index: number;
  label: string;
  kind: CapacityIntentKind;
  eventIndex: number;
  /** Queue identities, never assumed to be the eventual white and black seats. */
  queueAccounts: readonly [number, number];
}

export type CapacityStep = {
  index: number; phase: CapacityIntentKind | 'registration' | 'recovery' | 'fault';
  action: 'register' | 'queue' | 'observe-binding' | 'command' | 'observe-settlement' | 'retire' | 'duplicate-result' | 'fault';
  actor: CapacityActor;
  eventIndex: number;
  intentIndex?: number;
  command?: GameCommand;
  fault?: CapacityFault;
};

const INTENT_STEPS = 2 + CAPACITY_CORPUS.bindingObservationsPerGame + CAPACITY_CORPUS.commandsPerGame + 2;
export const CAPACITY_STEP_RANGES = Object.freeze({
  registrationBurst: Object.freeze({ start: 0, count: 10_000 }),
  registrationConfirm: Object.freeze({ start: 10_000, count: 6_000 }),
  intents: Object.freeze({ start: 16_000, count: CAPACITY_CORPUS.gameIntents * INTENT_STEPS }),
  duplicates: Object.freeze({ start: 276_000, count: 5_000 }),
  faults: Object.freeze({ start: 281_000, count: 6 }),
});
export const CAPACITY_STEP_COUNT = 281_006;

const FAULTS: readonly CapacityFault[] = Object.freeze(['hold-delayed-results', 'release-delayed-results',
  'projection-unavailable-once', 'competition-restart-once', 'lose-result-ack-once', 'conflicting-result-once']);
const MOVES = Object.freeze([
  Object.freeze({ from: 'e2', to: 'e4' }), Object.freeze({ from: 'e7', to: 'e5' }),
  Object.freeze({ from: 'g1', to: 'f3' }), Object.freeze({ from: 'b8', to: 'c6' }),
]);

function indexIn(index: number, count: number, code: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError(code);
}

export function capacityAccountId(index: number): string {
  indexIn(index, CAPACITY_CORPUS.accounts, 'capacity_account_index_invalid');
  return `capacity-account-${index.toString(36).padStart(4, '0')}`;
}

export function capacityGameIntentId(index: number): string {
  indexIn(index, CAPACITY_CORPUS.gameIntents, 'capacity_intent_index_invalid');
  return `capacity-intent-${index.toString(36).padStart(4, '0')}`;
}

export function capacityIntent(index: number): CapacityIntent {
  indexIn(index, CAPACITY_CORPUS.gameIntents, 'capacity_intent_index_invalid');
  const kind: CapacityIntentKind = index < 1_000 ? 'delayed' : index < 19_000 ? 'regular' : 'socket';
  const local = index - (kind === 'delayed' ? 0 : kind === 'regular' ? 1_000 : 19_000);
  // Weekly ends at Sunday18:00. Daily/hourly start then under normal cadence.
  const eventIndex = kind === 'delayed' ? 0 : 1 + local % 2;
  const inEvent = kind === 'delayed' ? local : Math.floor(local / 2);
  const pair = inEvent % 1_000;
  const rotation = kind === 'delayed' ? 0 : kind === 'regular' ? 1 + Math.floor(inEvent / 1_000) : 10;
  const base = eventIndex * CAPACITY_CORPUS.accountsPerEvent;
  return { index, label: capacityGameIntentId(index), kind, eventIndex,
    queueAccounts: [base + pair, base + 1_000 + ((pair + rotation) % 1_000)] };
}

/** Fixed isolated dates. Native clocks and production calendar rules stay unchanged. */
export function capacityEventId(index: number, earliestArmAt: number): string {
  indexIn(index, CAPACITY_CORPUS.events, 'capacity_event_index_invalid');
  if (!Number.isSafeInteger(earliestArmAt) || earliestArmAt < 1
    || earliestArmAt % 60_000 !== 0) throw new RangeError('capacity_calendar_anchor_invalid');
  const startsAt = earliestArmAt + (index === 0 ? -110 : 10) * 60_000;
  return `arena-${index === 0 ? 'weekly' : index === 1 ? 'daily' : 'hourly'}-${startsAt}`;
}

export function capacityRecoveryReleaseAt(index: number, setupEndsAt: number): number {
  indexIn(index, CAPACITY_CORPUS.delayedGames, 'capacity_recovery_index_invalid');
  if (!Number.isSafeInteger(setupEndsAt) || setupEndsAt < 1) throw new RangeError('capacity_schedule_time_invalid');
  return setupEndsAt + (index < 400 ? index * 25 : 10_000 + (index - 400) * 50);
}

export function capacityCommand(intentIndex: number, commandIndex: number): { role: CapacityRole; command: GameCommand } {
  indexIn(intentIndex, CAPACITY_CORPUS.gameIntents, 'capacity_intent_index_invalid');
  indexIn(commandIndex, CAPACITY_CORPUS.commandsPerGame, 'capacity_command_index_invalid');
  const id = `capacity-${intentIndex.toString(36).padStart(4, '0')}-${commandIndex}`;
  const role: CapacityRole = commandIndex % 2 === 0 ? 'white' : 'black';
  const base = { id, expectedVersion: commandIndex };
  return { role, command: commandIndex < 2 ? { ...base, type: 'ready' }
    : commandIndex === 6 ? { ...base, type: 'resign' }
      : { ...base, type: 'move', ...MOVES[commandIndex - 2] } };
}

/** One bounded HTTP address derives every selector on the server. Bodies stay {}. */
export function capacityStep(index: number): CapacityStep {
  indexIn(index, CAPACITY_STEP_COUNT, 'capacity_step_index_invalid');
  if (index < 16_000) {
    const accountIndex = (index < 10_000 ? index : index - 10_000) % CAPACITY_CORPUS.accounts;
    return { index, phase: 'registration', action: 'register', actor: { kind: 'account', accountIndex },
      eventIndex: Math.floor(accountIndex / CAPACITY_CORPUS.accountsPerEvent) };
  }
  if (index < CAPACITY_STEP_RANGES.duplicates.start) {
    const local = index - CAPACITY_STEP_RANGES.intents.start;
    const intentIndex = Math.floor(local / INTENT_STEPS);
    const within = local % INTENT_STEPS;
    const intent = capacityIntent(intentIndex);
    const actor: CapacityActor = { kind: 'account', accountIndex: intent.queueAccounts[within === 1 ? 1 : 0] };
    const base = { index, phase: intent.kind, actor, eventIndex: intent.eventIndex, intentIndex };
    if (within < 2) return { ...base, action: 'queue' };
    if (within < 4) return { ...base, action: 'observe-binding' };
    if (within < 11) {
      const { role, command } = capacityCommand(intentIndex, within - 4);
      return { ...base, actor: { kind: 'bound-seat', intentIndex, role }, action: 'command', command };
    }
    return { ...base, actor: { kind: 'bound-seat', intentIndex, role: 'white' },
      action: within === 11 ? 'observe-settlement' : 'retire' };
  }
  if (index < CAPACITY_STEP_RANGES.faults.start) {
    const intentIndex = Math.floor((index - CAPACITY_STEP_RANGES.duplicates.start) / 5);
    const intent = capacityIntent(intentIndex);
    return { index, phase: 'recovery', action: 'duplicate-result', intentIndex, eventIndex: intent.eventIndex,
      actor: { kind: 'bound-seat', intentIndex, role: 'white' } };
  }
  return { index, phase: 'fault', action: 'fault', eventIndex: 0,
    actor: { kind: 'account', accountIndex: 0 }, fault: FAULTS[index - CAPACITY_STEP_RANGES.faults.start] };
}

export function capacityIntentStepIndex(intentIndex: number, within: number): number {
  indexIn(intentIndex, CAPACITY_CORPUS.gameIntents, 'capacity_intent_index_invalid');
  indexIn(within, INTENT_STEPS, 'capacity_intent_step_invalid');
  return CAPACITY_STEP_RANGES.intents.start + intentIndex * INTENT_STEPS + within;
}

/** Slots name only the 1,000 post-stream safety games; old generations stay charged. */
export function capacitySocketSlot(index: number): { index: number; intentIndex: number; role: CapacityRole; generation: number } {
  indexIn(index, CAPACITY_CORPUS.participantSockets * CAPACITY_CORPUS.socketGenerations, 'capacity_socket_index_invalid');
  const slot = index % CAPACITY_CORPUS.participantSockets;
  return { index, intentIndex: 19_000 + Math.floor(slot / 2), role: slot % 2 === 0 ? 'white' : 'black',
    generation: Math.floor(index / CAPACITY_CORPUS.participantSockets) };
}

export function capacityStandingsPage(index: number): { eventIndex: number; page: number } {
  indexIn(index, CAPACITY_CORPUS.events * CAPACITY_CORPUS.standingsPagesPerEvent, 'capacity_standings_index_invalid');
  return { eventIndex: Math.floor(index / CAPACITY_CORPUS.standingsPagesPerEvent), page: index % CAPACITY_CORPUS.standingsPagesPerEvent };
}
