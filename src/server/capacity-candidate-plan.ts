import type { CapacityControllerPlan, CapacityWorkUnits } from './capacity-run';
import type { CapacityOperation } from './capacity-native';
import { CAPACITY_FREEZE_CALLBACK_WORK, CAPACITY_WORKFLOW_CANDIDATES, capacityCandidateRunWork } from './capacity-work-plan';
import { CAPACITY_D1_READ_ATTEMPTS } from './capacity-meter';
import { CAPACITY_CORPUS, CAPACITY_CONTROL_HTTP_REQUESTS, CAPACITY_INGRESS_BLOCK_REQUESTS,
  CAPACITY_REGISTRATION_DIAGNOSTIC, CAPACITY_PREPARATION_BATCH_SIZE } from '../shared/capacity-corpus';

const work = (values: Partial<CapacityWorkUnits>): CapacityWorkUnits => ({ workerRequests: 0,
  nativeDoRequests: 0, workerCpuMs: 0, doRowsWritten: 0, doRowsRead: 0, d1RowsWritten: 0,
  d1RowsRead: 0, doStorageBytes: 0, d1StorageBytes: 0, ...values });
const game = (writes: number, reads = 128, d1Reads = 64, d1Writes = 0) =>
  work({ nativeDoRequests: 1, doRowsWritten: writes, doRowsRead: reads, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * d1Reads,
    d1RowsWritten: d1Writes });
const competition = (writes: number, reads: number, d1Reads = 128, d1Writes = 16) =>
  work({ nativeDoRequests: 1, doRowsWritten: writes, doRowsRead: reads,
    d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * d1Reads, d1RowsWritten: d1Writes });

/**
 * Local rehearsal limits only. These limits fail closed when insufficient.
 * They are not measured upper bounds, provider approval or verified exports.
 * Cold calls use each workflow's separate maximum-event allowance instead.
 */
export const CAPACITY_NATIVE_CANDIDATE_ENVELOPES: Readonly<Record<CapacityOperation, CapacityWorkUnits>> = {
  'Game.status': game(4, 128, 0),
  'Game.init': game(16, 256, 128, 16),
  'Game.command': game(20, 256, 128, 16),
  // Better Auth's first session read performs native schema discovery. This
  // sample consumed 524 D1 rows, so keep that finite cold-auth step separate.
  'Game.qualificationReadyCold': game(16, 128, 640),
  'Game.qualificationReady': game(16),
  'Game.qualificationMove': game(16),
  'Game.qualificationResign': game(20, 256, 128, 16),
  'Game.qualificationObserve': game(4),
  'Game.qualificationDuplicate': game(4),
  'Game.qualificationRetire': game(4),
  'Game.qualificationSocket': game(8),
  'Game.observeQualificationGame': game(4, 128, 0),
  'Game.alarm': game(20, 256, 128, 16),
  'Game.webSocketMessage': game(4),
  'Game.webSocketClose': game(6),
  'Game.webSocketError': game(4),
  'Game.enforceTournamentDeadline': game(20, 256, 128, 16),
  'Game.archive': game(20, 256, 128, 16),
  'Game.flush': game(20, 256, 128, 16),
  'Game.finishWorkflow': game(4, 128, 0),
  // One raw retirement RPC, its barrier alarm and one possible lost-caller
  // cleanup. Paid separately by prepareRetirement, with no refund on failure.
  'Game.retire': work({ nativeDoRequests: 3, doRowsWritten: 6, doRowsRead: 32 }),
  // Three bounded read passes cover D1's two possible read-only retries.
  'Competition.prepareQualificationAccount': competition(12, 128, 640, 32),
  'Competition.prepareQualificationAccounts': competition(96, 512, 640, 1_024),
  'Competition.qualificationRegister': competition(64, 16_384),
  'Competition.qualificationQueue': competition(32, 512),
  'Competition.qualificationBinding': competition(16, 256),
  'Competition.qualificationFault': competition(64, 16_384),
  'Competition.qualificationStep': competition(64, 16_384),
  'Competition.settle': competition(128, 16_384),
  'Competition.prepareRestart': competition(8, 128),
  'Competition.finishWorkflow': competition(8, 128),
  'Competition.finishQualification': competition(32, 100_000, 4_096, 0),
  'Competition.alarm': competition(32_768, 1_000_000, 32_768, 4_096),
  'Competition.maintenance': competition(32_768, 1_000_000, 32_768, 4_096),
  'Competition.flush': competition(32_768, 1_000_000, 32_768, 4_096),
};

/** Named fixed-work counts plus finite failure room. Full native proof is pending. */
export const CAPACITY_CONTROLLER_CANDIDATE_CALLS = Object.freeze({
  arm: 1, stop: 32, status: 32, available: 56_000,
  reserveIngress: Math.floor((CAPACITY_CORPUS.maximumWorkerRequests - CAPACITY_CONTROL_HTTP_REQUESTS) / CAPACITY_INGRESS_BLOCK_REQUESTS),
  charge: 20_000, linkGame: 22_000, begin: 22_002, complete: 20_001,
  prepareRetirement: 19_000, confirmRetirement: 19_000,
  confirmShutdown: 1,
});

/** Safe to import in Node tooling: every runtime-owned import above is type-only. */
export function capacityControllerCandidatePlan(): CapacityControllerPlan {
  const profiles = CAPACITY_WORKFLOW_CANDIDATES;
  const gameEnvelope = work({});
  const eventEnvelope = work({});
  for (const key of Object.keys(gameEnvelope) as (keyof CapacityWorkUnits)[]) {
    gameEnvelope[key] = Math.max(...[profiles.regular, profiles.delayed, profiles.socket].map(plan => plan.envelope[key]));
    eventEnvelope[key] = Math.max(...[profiles.regular, profiles.delayed, profiles.socket].map(plan => plan.maximumEventWork[key]));
  }
  // Native retained-key and fresh/denied probes measured these write maxima.
  // The finite plan fails closed if any later path exceeds its allocation.
  const rows = { arm: [16, 16], stop: [16, 2], status: [16, 1], available: [16, 1],
    reserveIngress: [32, 4], charge: [32, 4], linkGame: [32, 7], begin: [64, 5],
    complete: [64, 6], prepareRetirement: [32, 5], confirmRetirement: [32, 4], confirmShutdown: [100_000, 4] } as const;
  return { maximumPhysicalBytes: 160 * 1024 ** 2, maximumIncarnations: 32,
    bootstrapEnvelope: work({ doRowsRead: 64, doRowsWritten: 32 }),
    methods: Object.fromEntries(Object.entries(CAPACITY_CONTROLLER_CANDIDATE_CALLS).map(([method, maximumCalls]) => {
      const [doRowsRead, doRowsWritten] = rows[method as keyof typeof rows];
      return [method, { maximumCalls, envelope: work({ nativeDoRequests: 1, doRowsRead, doRowsWritten }) }];
    })) as CapacityControllerPlan['methods'],
    runWork: capacityCandidateRunWork(),
    workflows: { Game: { maximumEvents: Math.max(profiles.regular.maximumEvents,
      profiles.delayed.maximumEvents, profiles.socket.maximumEvents), envelope: gameEnvelope,
      maximumEventWork: eventEnvelope }, Competition: profiles.competition } };
}

/** Enforced trial limits for one short registration diagnosis, with no Game funding. */
export function capacityRegistrationDiagnosticPlan(): CapacityControllerPlan {
  const plan = capacityControllerCandidatePlan();
  const zero = { maximumEvents: 1, envelope: work({}), maximumEventWork: work({}) };
  const competition = {
    maximumEvents: 1_024,
    envelope: work({ nativeDoRequests: 1_024, doRowsWritten: 4_600_000, doRowsRead: 160_000_000,
      d1RowsWritten: 600_000, d1RowsRead: 15_000_000, doStorageBytes: 16 * 1024 ** 2, d1StorageBytes: 64 * 1024 ** 2 }),
    maximumEventWork: { ...CAPACITY_WORKFLOW_CANDIDATES.competition.maximumEventWork,
      doStorageBytes: 16 * 1024 ** 2, d1StorageBytes: 64 * 1024 ** 2 },
  };
  // Every request may arrive on a fresh Worker. Fund its whole grant without
  // assuming an isolate count or returning any unused part of a lost grant.
  const ingress = Math.ceil(CAPACITY_REGISTRATION_DIAGNOSTIC.accounts / CAPACITY_PREPARATION_BATCH_SIZE)
    + CAPACITY_REGISTRATION_DIAGNOSTIC.registrations;
  const calls = { arm: 1, stop: 32, status: 8, available: 768, reserveIngress: ingress,
    charge: 0, linkGame: 0, begin: 2, complete: 1, prepareRetirement: 0, confirmRetirement: 0, confirmShutdown: 1 };
  const runWork = { ...competition.envelope };
  for (const key of Object.keys(runWork) as (keyof CapacityWorkUnits)[]) runWork[key] += CAPACITY_FREEZE_CALLBACK_WORK[key];
  return { ...plan, maximumPhysicalBytes: 8 * 1024 ** 2, maximumIncarnations: 8,
    methods: Object.fromEntries(Object.entries(plan.methods).map(([key, item]) =>
      [key, { ...item, maximumCalls: calls[key as keyof typeof calls] }])) as CapacityControllerPlan['methods'],
    runWork, workflows: { Game: zero, Competition: competition } };
}
