#!/usr/bin/env node
import { capacityPrivateFailureCode, readCapacityFailureAudit } from '../src/shared/capacity-failure.ts';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import {
  CAPACITY_BINDING_HEADER, CAPACITY_COMPETITION_HEADER, CAPACITY_CORPUS, CAPACITY_STEP_COUNT, CAPACITY_STEP_RANGES, capacityAccountId, capacityEventId, capacityIntent,
  capacityIntentStepIndex, capacityRecoveryReleaseAt, capacitySocketSlot, capacityStandingsPage, capacityStep,
  CAPACITY_PREPARATION_BATCH_SIZE, CAPACITY_D1_READ_ATTEMPTS, CAPACITY_WARM_D1_READ_ROWS, capacityPreparationAccounts,
  CAPACITY_REGISTRATION_DIAGNOSTIC, capacityRegistrationDiagnosticSchedule,
} from '../src/shared/capacity-corpus.ts';

export const CAPACITY_DRIVER_LIMITS = Object.freeze({
  concurrentFetches: 2_048, registrationDiagnosticConcurrentFetches: 256,
  fetchTimeoutMs: 5_000, preparationTimeoutMs: 15_000, maximumLatenessMs: 25,
  clockDriftMs: 50, sampleIntervalMs: 1_000, maximumTraceBytes: 512 * 1024 ** 2,
  maximumEncodedTraceBytes: 2 * 1024 ** 3,
  maximumResponseBytes: 64 * 1024, maximumCredentialsBytes: 16 * 1024 ** 2, maximumSeedBytes: 4 * 1024,
});
export const CAPACITY_REGIONS = Object.freeze(['us-west', 'us-east', 'europe', 'asia-pacific', 'australia', 'south-america']);
/** Changing this requires the reviewed frozen candidate and focused local safety. */
export const CAPACITY_DRIVER_EXECUTION_READY = false;
export const CAPACITY_DRIVER_BLOCKERS = Object.freeze([
  'complete-native-session-and-ordinal-paths', 'real-cache-and-finite-fault-paths',
  'verified-native-and-controller-envelopes', 'focused-native-safety-record',
  'reviewed-actual-egress-runner', 'frozen-owner-approved-provider-candidate',
  'native-shutdown-and-final-accounting',
]);
export const CAPACITY_DRIVER_FOLLOW_UPS = Object.freeze([
  'six-reviewed-regional-runners', 'reviewed-regional-credential-artifact-transfer',
]);
const CAPACITY_SHUTDOWN_FIELDS = Object.freeze([
  'at', 'games', 'socketWorkflows', 'pendingNative', 'gameOutboxes', 'competitionOutboxes',
  'projectionBuilds', 'unfinishedGames', 'sockets', 'alarms',
  'completedWorkflows', 'confirmedRetirements', 'retainedLifetimePermits',
]);

/** Keep only bounded counters in traces, including when a response is malformed. */
function capacityShutdownReadback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...Object.fromEntries(CAPACITY_SHUTDOWN_FIELDS.map(key =>
    [key, Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null])),
    ...(value.registration ? { registration: Object.fromEntries(['fixtures', 'entrants', 'steps', 'queues']
      .map(key => [key, Number.isSafeInteger(value.registration[key]) && value.registration[key] >= 0 ? value.registration[key] : null])) } : {}) };
}

/** Failure traces contain known codes, never request data or exception text. */
function capacityFailureCode(error) {
  if (error instanceof Error && /^capacity_[a-z0-9_:-]{1,120}$/.test(error.message)) return error.message;
  return ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error?.name) ? error.name : 'unknown-error';
}

// Match the private entry's fixed codes. Ignore unknown or decorated headers.

/** Approved relative workload. A dated candidate, complete qualification and all server gates are separate. */
export const CAPACITY_DRIVER_TIMING = Object.freeze({
  // Control calls keep five-second limits. Late setup fails the fixed first fixture.
  fixturePrepareOffsetMs: 8_000, fixturePrepareIntervalMs: 20, fixturePrepareBurst: 2,
  credentialSealOffsetMs: 134_000,
  credentialTransferOffsetMs: 136_000, credentialLoadOffsetMs: 151_000,
  registrationBurstOffsetMs: 156_000, registrationConfirmOffsetMs: 191_000,
  recoveryLeadMs: 10_000, queueLeadMs: 5_000,
  delayedFirstTerminalOffsetMs: 270_000, delayedTerminalIntervalMs: 200,
  socketQueueOffsetMs: 10_000, socketQueueIntervalMs: 50,
  socketOpenOffsetMs: 65_000, socketReplacementOffsetMs: 75_000, socketOpenIntervalMs: 1,
  socketMoveOffsetMs: 85_000, socketMovePassMs: 10_000, socketMoveIntervalMs: 10,
  socketResignOffsetMs: 130_000, socketResignIntervalMs: 50,
});

const checkedIndex = (index, count, code) => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error(code);
};
const sameBinding = (left, right) => left.intentIndex === right.intentIndex && left.gameId === right.gameId
  && left.whiteAccountIndex === right.whiteAccountIndex && left.blackAccountIndex === right.blackAccountIndex
  && left.eventIndex === right.eventIndex;

export class CapacityBindings {
  #intents = new Map();
  #games = new Map();
  #proofs = new Map();
  #acceptedCommands = new Map();
  #queued = new Map();
  #observations = new Map();
  #uncertain = new Set();

  bind(binding, proof) {
    checkedIndex(binding?.intentIndex, CAPACITY_CORPUS.gameIntents, 'capacity_binding_invalid');
    checkedIndex(binding.whiteAccountIndex, CAPACITY_CORPUS.accounts, 'capacity_binding_invalid');
    checkedIndex(binding.blackAccountIndex, CAPACITY_CORPUS.accounts, 'capacity_binding_invalid');
    checkedIndex(binding.eventIndex, CAPACITY_CORPUS.events, 'capacity_binding_invalid');
    const eventIndex = capacityIntent(binding.intentIndex).eventIndex;
    if (typeof binding.gameId !== 'string' || !/^[\w-]{8,100}$/.test(binding.gameId)
      || binding.whiteAccountIndex === binding.blackAccountIndex || binding.eventIndex !== eventIndex
      || Math.floor(binding.whiteAccountIndex / 2_000) !== eventIndex
      || Math.floor(binding.blackAccountIndex / 2_000) !== eventIndex) throw new Error('capacity_binding_invalid');
    const prior = this.#intents.get(binding.intentIndex);
    if (prior && !sameBinding(prior, binding)) throw new Error('capacity_binding_conflict');
    const linked = this.#games.get(binding.gameId);
    if (linked !== undefined && linked !== binding.intentIndex) throw new Error('capacity_game_reused');
    if (proof !== undefined) {
      if (typeof proof !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(proof)) throw new Error('capacity_binding_proof_invalid');
      const priorProof = this.#proofs.get(binding.intentIndex);
      if (priorProof !== undefined && priorProof !== proof) throw new Error('capacity_binding_proof_conflict');
      this.#proofs.set(binding.intentIndex, proof);
    }
    if (!prior) {
      this.#intents.set(binding.intentIndex, Object.freeze({ intentIndex: binding.intentIndex, gameId: binding.gameId,
        eventIndex: binding.eventIndex, whiteAccountIndex: binding.whiteAccountIndex, blackAccountIndex: binding.blackAccountIndex }));
      this.#games.set(binding.gameId, binding.intentIndex);
    }
  }

  actor(step) {
    if (step.actor.kind === 'account') return step.actor.accountIndex;
    const binding = this.#intents.get(step.actor.intentIndex);
    return binding?.[step.actor.role === 'white' ? 'whiteAccountIndex' : 'blackAccountIndex'] ?? null;
  }

  ready(step) {
    if (step.action === 'observe-binding') {
      const within = step.index - capacityIntentStepIndex(step.intentIndex, 0);
      return (this.#queued.get(step.intentIndex) ?? 0) === 3
        && (within !== 3 || (this.#observations.get(step.intentIndex) ?? 0) === 1);
    }
    if (step.action !== 'command') return this.actor(step) !== null;
    return this.actor(step) !== null && this.#proofs.has(step.intentIndex) && this.#observations.get(step.intentIndex) === 3
      && (this.#acceptedCommands.get(step.intentIndex) ?? 0) === step.command.expectedVersion;
  }

  accept(step, reply) {
    if (reply.binding && !reply.accepted) throw new Error('capacity_denied_binding_invalid');
    if (reply.binding) this.bind(reply.binding, reply.bindingProof);
    if (step.action === 'queue' && reply.accepted) {
      const within = step.index - capacityIntentStepIndex(step.intentIndex, 0);
      this.#queued.set(step.intentIndex, (this.#queued.get(step.intentIndex) ?? 0) | (1 << within));
    }
    if (step.action === 'observe-binding' && reply.accepted) {
      const within = step.index - capacityIntentStepIndex(step.intentIndex, 0);
      if ((this.#queued.get(step.intentIndex) ?? 0) !== 3
        || (within === 3 && (!reply.binding || !reply.bindingProof || this.#observations.get(step.intentIndex) !== 1))) {
        throw new Error('capacity_binding_deadline_unresolved');
      }
      this.#observations.set(step.intentIndex, (this.#observations.get(step.intentIndex) ?? 0) | (1 << (within - 2)));
    }
    if (step.action === 'command' && reply.accepted) {
      const before = this.#acceptedCommands.get(step.intentIndex) ?? 0;
      if (before !== step.command.expectedVersion) throw new Error('capacity_command_order_conflict');
      this.#acceptedCommands.set(step.intentIndex, before + 1);
    }
  }

  uncertain(step) { if (step.intentIndex !== undefined) this.#uncertain.add(step.intentIndex); }
  binding(intentIndex) { return this.#intents.get(intentIndex) ?? null; }
  proof(intentIndex) {
    const proof = this.#proofs.get(intentIndex);
    if (!proof) throw new Error('capacity_binding_proof_unresolved');
    return proof;
  }
  get counts() { return { boundIntents: this.#intents.size, usableBindings: this.#proofs.size, uncertainIntents: this.#uncertain.size }; }
}

/** The fixed final confirmation can resolve a lost idempotent burst reply. */
export class CapacityRegistrationRecovery {
  #uncertain = new Map();
  #confirmed = new Set();
  constructor(manifest) { this.enabled = !diagnostic(manifest); this.earliestArmAt = manifest.earliestArmAt; }
  defer(job, error) {
    if (!this.enabled || job.kind !== 'step' || !Number.isSafeInteger(job.index)
      || job.index < 0 || job.index >= CAPACITY_CORPUS.registrationBurst
      || error?.burstRegistrationUncertainIndex !== job.index) return false;
    this.#uncertain.set(job.index, error.burstRegistrationFailureCode);
    return true;
  }
  acknowledge(job, result) {
    const first = CAPACITY_STEP_RANGES.registrationConfirm.start;
    if (!this.enabled || job.kind !== 'step' || !Number.isSafeInteger(job.index)
      || job.index < first || job.index >= first + CAPACITY_CORPUS.registrationConfirm
      || !result.accepted || !result.registration) return;
    const step = capacityStep(job.index);
    if (result.registration.eventIndex === step.eventIndex
      && result.registration.eventId === capacityEventId(step.eventIndex, this.earliestArmAt)) {
      this.#confirmed.add(step.actor.accountIndex);
    }
  }
  get counts() {
    let resolved = 0, timedOut = 0;
    for (const [index, code] of this.#uncertain) {
      if (code === 'TimeoutError') timedOut++;
      if (this.#confirmed.has(capacityStep(index).actor.accountIndex)) resolved++;
    }
    return { uncertainBurstReplies: this.#uncertain.size, timedOutBurstReplies: timedOut,
      transportErrorBurstReplies: this.#uncertain.size - timedOut, resolvedUncertainReplies: resolved,
      unresolvedUncertainReplies: this.#uncertain.size - resolved, confirmedAccounts: this.#confirmed.size };
  }
}

/** Merge compact arithmetic streams. At most one head per stream is retained. */
export function* mergeCapacitySchedule(streams) {
  const heads = Array.from(streams, stream => ({ iterator: stream[Symbol.iterator](), head: null }));
  for (const entry of heads) entry.head = entry.iterator.next();
  let last = -Infinity;
  for (;;) {
    let selected = null;
    for (const entry of heads) {
      if (!entry.head.done && (!selected || entry.head.value.at < selected.head.value.at
        || (entry.head.value.at === selected.head.value.at && entry.head.value.order < selected.head.value.order))) selected = entry;
    }
    if (!selected) return;
    const value = selected.head.value;
    if (!Number.isSafeInteger(value.at) || value.at < last) throw new Error('capacity_schedule_order_invalid');
    last = value.at;
    yield value;
    selected.head = selected.iterator.next();
  }
}

export function* capacityReadSchedule(streamStartsAt, regionIndex) {
  checkedIndex(regionIndex, CAPACITY_REGIONS.length, 'capacity_region_invalid');
  if (!Number.isSafeInteger(streamStartsAt)) throw new Error('capacity_schedule_time_invalid');
  for (let index = regionIndex; index < CAPACITY_CORPUS.spectatorReads; index += CAPACITY_REGIONS.length) {
    const viewer = index % 10_000;
    const eventIndex = viewer % CAPACITY_CORPUS.events;
    const page = viewer % 2 === 0 ? 0 : 1 + (Math.floor(viewer / 6) % (CAPACITY_CORPUS.standingsPagesPerEvent - 1));
    yield { kind: 'standings', index, pageIndex: eventIndex * CAPACITY_CORPUS.standingsPagesPerEvent + page,
      at: streamStartsAt + index * CAPACITY_CORPUS.spectatorIntervalMs, order: CAPACITY_STEP_COUNT + index };
  }
}

export function capacityCalendarSchedule(earliestArmAt) {
  capacityEventId(0, earliestArmAt);
  return { earliestArmAt, latestArmAt: earliestArmAt + 30_000, setupEndsAt: earliestArmAt + 600_000,
    streamStartsAt: earliestArmAt + 610_000, streamEndsAt: earliestArmAt + 1_510_000,
    admissionsCloseAt: earliestArmAt + 1_800_000, issueCloseAt: earliestArmAt + 2_700_000,
    hardCloseAt: earliestArmAt + 3_600_000 };
}

const diagnostic = manifest => manifest.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile;
const accountCount = manifest => diagnostic(manifest) ? CAPACITY_REGISTRATION_DIAGNOSTIC.accounts : CAPACITY_CORPUS.accounts;
const credentialTiming = manifest => diagnostic(manifest) ? CAPACITY_REGISTRATION_DIAGNOSTIC : CAPACITY_DRIVER_TIMING;
export const capacityManifestSchedule = manifest => diagnostic(manifest)
  ? capacityRegistrationDiagnosticSchedule(manifest.earliestArmAt) : capacityCalendarSchedule(manifest.earliestArmAt);

/** Same fixed protocol ordinals, real auth and transport, with no later workload. */
export function* capacityRegistrationProviderSchedule(manifest) {
  if (!diagnostic(manifest)) throw new Error('capacity_candidate_unqualified');
  const at = offset => manifest.earliestArmAt + offset;
  const controls = [
    { kind: 'arm', at: at(0), order: -3 }, { kind: 'status', at: at(1_000), order: -2 },
    { kind: 'credential-seal', at: at(25_000), order: -2 }, { kind: 'credential-load', at: at(27_000), order: -2 },
    { kind: 'stop', at: at(55_000), order: -1 }, { kind: 'status', finalAudit: true, at: at(61_000), order: 0 },
  ];
  const preparation = (function* () {
    for (let index = 0; index < CAPACITY_REGISTRATION_DIAGNOSTIC.accounts; index += CAPACITY_PREPARATION_BATCH_SIZE) {
      yield { kind: 'prepare', index, count: CAPACITY_PREPARATION_BATCH_SIZE, order: -10_000 + index,
        at: at(8_000 + index * CAPACITY_DRIVER_TIMING.fixturePrepareIntervalMs), replyDeadlineAt: at(25_000) };
    }
  })();
  const registrations = (function* () {
    for (let offset = 0; offset < CAPACITY_REGISTRATION_DIAGNOSTIC.registrations; offset++) {
      const index = [0, 6_000, 10_000][Math.floor(offset / 256)] + offset % 256;
      yield { kind: 'step', index, order: index, at: at(30_000 + offset * 3), expectedDenials: [429] };
    }
  })();
  yield* mergeCapacitySchedule([controls, preparation, registrations]);
}

function intentStepAt(intentIndex, within, manifest) {
  const intent = capacityIntent(intentIndex);
  const local = intentIndex - (intent.kind === 'delayed' ? 0 : intent.kind === 'regular' ? 1_000 : 19_000);
  if (intent.kind === 'socket') {
    const queue = manifest.streamEndsAt + CAPACITY_DRIVER_TIMING.socketQueueOffsetMs + local * CAPACITY_DRIVER_TIMING.socketQueueIntervalMs;
    if (within < 4) return queue + [0, 50, 1_500, 2_500][within];
    if (within < 6) return queue + (within === 4 ? 3_200 : 3_500);
    if (within < 10) return manifest.streamEndsAt + CAPACITY_DRIVER_TIMING.socketMoveOffsetMs
      + (within - 6) * CAPACITY_DRIVER_TIMING.socketMovePassMs + local * CAPACITY_DRIVER_TIMING.socketMoveIntervalMs;
    const terminal = manifest.streamEndsAt + CAPACITY_DRIVER_TIMING.socketResignOffsetMs + local * CAPACITY_DRIVER_TIMING.socketResignIntervalMs;
    return terminal + [0, 500, 1_000][within - 10];
  }
  const terminal = intent.kind === 'delayed'
    ? manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.delayedFirstTerminalOffsetMs + local * CAPACITY_DRIVER_TIMING.delayedTerminalIntervalMs
    : manifest.streamStartsAt + local * CAPACITY_CORPUS.regularIntervalMs;
  if (within < 4) return terminal + [-5_000, -4_950, -3_500, -2_500][within];
  if (within < 11) return terminal - (10 - within) * 300;
  const delivery = intent.kind === 'delayed' ? capacityRecoveryReleaseAt(local, manifest.setupEndsAt) : terminal;
  return delivery + (within === 11 ? 500 : intent.kind === 'delayed' ? 1_500 : 1_000);
}

/** Fixed streams avoid materializing a million-entry schedule in each runner. */
export function* capacityWorkSchedule(manifest, regionIndex) {
  checkedIndex(regionIndex, CAPACITY_REGIONS.length, 'capacity_region_invalid');
  const streams = [];
  for (let pass = 0; pass < 2; pass++) streams.push((function* () {
    const count = pass === 0 ? 10_000 : 6_000;
    for (let offset = 0; offset < count; offset++) {
      const index = (pass === 0 ? 0 : 10_000) + offset;
      const step = capacityStep(index);
      if (step.actor.accountIndex % CAPACITY_REGIONS.length !== regionIndex) continue;
      yield { kind: 'step', index, order: index,
        at: manifest.earliestArmAt + (pass === 0 ? CAPACITY_DRIVER_TIMING.registrationBurstOffsetMs + offset * 3
          : CAPACITY_DRIVER_TIMING.registrationConfirmOffsetMs + offset * CAPACITY_CORPUS.registrationConfirmIntervalMs),
        ...(pass === 0 ? { expectedDenials: [429] } : {}) };
    }
  })());
  if (regionIndex === 0) streams.push((function* () {
    for (let index = 0; index < CAPACITY_CORPUS.accounts; index += CAPACITY_PREPARATION_BATCH_SIZE) yield { kind: 'prepare', index,
      count: capacityPreparationAccounts(index).length,
      order: -10_000 + index, at: manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.fixturePrepareOffsetMs
        + index * CAPACITY_DRIVER_TIMING.fixturePrepareIntervalMs,
      replyDeadlineAt: manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs };
  })());
  for (const [first, count] of [[0, 1_000], [1_000, 18_000], [19_000, 1_000]]) {
    for (let within = 0; within < 13; within++) {
      // A socket incarnation retains its lifetime permit through shutdown.
      if (first === 19_000 && within === 12) continue;
      streams.push((function* () {
        for (let intent = first; intent < first + count; intent++) {
          if (intent % CAPACITY_REGIONS.length !== regionIndex) continue;
          const index = capacityIntentStepIndex(intent, within);
          yield { kind: 'step', index, at: intentStepAt(intent, within, manifest), order: index };
        }
      })());
    }
  }
  for (let copy = 0; copy < 5; copy++) streams.push((function* () {
    for (let intent = 0; intent < 1_000; intent++) {
      if (intent % CAPACITY_REGIONS.length !== regionIndex) continue;
      const index = CAPACITY_STEP_RANGES.duplicates.start + intent * 5 + copy;
      yield { kind: 'step', index, order: index, at: capacityRecoveryReleaseAt(intent, manifest.setupEndsAt) + 500 + copy * 100 };
    }
  })());
  if (regionIndex === 0) streams.push((function* () {
    const times = [manifest.earliestArmAt + 250_000, manifest.setupEndsAt, manifest.streamStartsAt + 120_000,
      manifest.streamStartsAt + 300_000, manifest.streamStartsAt + 449_900, manifest.streamStartsAt + 451_000];
    for (let offset = 0; offset < times.length; offset++) {
      const index = CAPACITY_STEP_RANGES.faults.start + offset;
      yield { kind: 'step', index, order: index, at: times[offset] };
    }
  })());
  streams.push((function* () {
    for (let index = 0; index < 4_000; index++) {
      const slot = capacitySocketSlot(index);
      if (slot.intentIndex % CAPACITY_REGIONS.length !== regionIndex) continue;
      yield { kind: 'socket', index, order: CAPACITY_STEP_COUNT + CAPACITY_CORPUS.spectatorReads + index,
        at: manifest.streamEndsAt + (slot.generation === 0 ? CAPACITY_DRIVER_TIMING.socketOpenOffsetMs
          : CAPACITY_DRIVER_TIMING.socketReplacementOffsetMs) + (index % 2_000) * CAPACITY_DRIVER_TIMING.socketOpenIntervalMs };
    }
  })());
  streams.push(capacityReadSchedule(manifest.streamStartsAt, regionIndex));
  yield* mergeCapacitySchedule(streams);
}

export function validateCapacityCandidate(value, digests) {
  const manifest = value?.manifest;
  if (value?.schema !== 'ejm-chess-capacity-driver-candidate-v1' || !manifest
    || value.driverDigest !== digests.driverDigest || value.corpusDigest !== digests.corpusDigest
    || value.incrementalMaximumCents !== 2_500 || !/^[a-f0-9]{64}$/.test(value.ledgerDigest)
    || !/^[a-f0-9-]{36}$/.test(manifest.runId) || !/^[a-f0-9]{64}$/.test(manifest.digest)
    || manifest.verified?.ownerApprovedFrozenRun !== true) throw new Error('capacity_candidate_unqualified');
  capacityOrigin(`https://${manifest.host}`);
  if (manifest.profile !== undefined && !diagnostic(manifest)) throw new Error('capacity_candidate_unqualified');
  const schedule = capacityManifestSchedule(manifest);
  for (const key of Object.keys(schedule)) if (manifest[key] !== schedule[key]) throw new Error('capacity_candidate_schedule_invalid');
  const regions = capacityEgressRegions(value.egressMode);
  if (!Array.isArray(value.runners) || value.runners.length !== regions.length) throw new Error('capacity_runners_unqualified');
  let runnerCostCents = 0;
  for (let index = 0; index < value.runners.length; index++) {
    const runner = value.runners[index];
    if (runner.region !== regions[index]
      || !['runnerId', 'transportPath', 'evidenceReference'].every(key => typeof runner[key] === 'string' && runner[key].length > 0 && runner[key].length <= 256)
      || !Number.isSafeInteger(runner.maximumCostCents) || runner.maximumCostCents < 0 || runner.maximumCostCents > 2_500) throw new Error('capacity_runner_invalid');
    runnerCostCents += runner.maximumCostCents;
    if (!Number.isSafeInteger(runnerCostCents) || runnerCostCents > value.incrementalMaximumCents) throw new Error('capacity_runner_budget_exceeded');
  }
  return value;
}

/** Logical schedule shards do not establish geographic coverage. */
export function capacityEgressRegions(mode = 'six-regions') {
  if (mode === 'single-egress') return [CAPACITY_REGIONS[0]];
  if (mode === 'six-regions') return [...CAPACITY_REGIONS];
  throw new Error('capacity_egress_mode_invalid');
}

function capacityOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]*capacity[a-z0-9-]*\.ejmlabs\.com$/.test(url.hostname)
    || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('capacity_origin_invalid');
  return url.origin;
}

/** Manifest metadata is read before any native controller is instantiated. */
export function validateCapacityPreflight(reply, manifest) {
  const control = reply?.control;
  if (!reply?.accepted || !control || control.ready !== true || control.armed !== null
    || control.manifestDigest !== manifest.digest || !Array.isArray(control.blockers) || control.blockers.length
    || !control.schedule) throw new Error('capacity_preflight_unqualified');
  for (const [key, value] of Object.entries(capacityManifestSchedule(manifest))) {
    if (control.schedule[key] !== value) throw new Error('capacity_preflight_schedule_mismatch');
  }
  return control;
}

/** Native shutdown closes work evidence without releasing historical permits. */
export function capacityFinalAudit(control, manifest, now = Date.now()) {
  const short = diagnostic(manifest), games = short ? 0 : CAPACITY_CORPUS.gameIntents;
  const sockets = short ? 0 : CAPACITY_CORPUS.socketGames;
  const valid = control?.armed === true && control.manifestDigest === manifest.digest
    && control.stopReason === 'owner-stop'
    && ['charges', 'activeObjects', 'unresolvedDispatches', 'physicalBytes'].every(key => Number.isSafeInteger(control[key]) && control[key] >= 0)
    && control.charges <= games;
  const shutdown = capacityShutdownReadback(control?.nativeShutdown);
  const nativeShutdownPassed = shutdown !== null
    && CAPACITY_SHUTDOWN_FIELDS.every(key => Number.isSafeInteger(shutdown[key]) && shutdown[key] >= 0)
    && Number.isSafeInteger(now) && shutdown.at >= manifest.admissionsCloseAt
    && shutdown.at < manifest.hardCloseAt && shutdown.at <= now
    && shutdown.games === games && shutdown.socketWorkflows === sockets
    && CAPACITY_SHUTDOWN_FIELDS.slice(3, 10).every(key => shutdown[key] === 0)
    && shutdown.completedWorkflows === games + 1
    && shutdown.confirmedRetirements === (short ? 0 : CAPACITY_CORPUS.gameIntents - CAPACITY_CORPUS.socketGames)
    && shutdown.retainedLifetimePermits === sockets + 2
    && (!short || (shutdown.registration?.fixtures === 256 && shutdown.registration.steps === 768
      && shutdown.registration.entrants > 0 && shutdown.registration.entrants <= 256 && shutdown.registration.queues === 0));
  return { verifiedIdentityAndStop: valid, chargedGameIds: control?.charges ?? null,
    heldObjects: control?.activeObjects ?? null, unresolvedDispatches: control?.unresolvedDispatches ?? null,
    reserved: control?.reserved ?? null, observed: control?.observed ?? null,
    physicalBytes: control?.physicalBytes ?? null, nativeShutdown: shutdown,
    nativeClosurePassed: valid && nativeShutdownPassed && control.charges === games
      && control.activeObjects === shutdown.retainedLifetimePermits && control.unresolvedDispatches === 0 };
}

/** One scheduled read still records a failed or uncertain stop. Never resend it. */
export async function awaitCapacityStop(stopCompletion) {
  if (!stopCompletion) throw new Error('capacity_stop_unacknowledged');
  try { await stopCompletion; } catch { /* The following read retains the durable state. */ }
}

/** The arm-owning runner sends initial status only after its validated arm reply. */
export function sequenceCapacityInitialControls(issue, manifestDigest) {
  let armCompletion = null;
  return async job => {
    if (job.kind === 'status' && !job.finalAudit) {
      if (!armCompletion) throw new Error('capacity_arm_unacknowledged');
      await armCompletion;
    }
    const request = issue(job);
    if (job.kind !== 'arm') return request;
    armCompletion = request.then(result => {
      const control = result.control;
      if (!result.accepted || control?.armed !== true || control.manifestDigest !== manifestDigest
        || control.stopReason !== null) throw new Error('capacity_control_unqualified');
      return result;
    });
    return armCompletion;
  };
}

/** A single actual egress runs the entire corpus without claiming six regions. */
export function* capacityRunnerSchedule(manifest, regionIndex, egressMode = 'six-regions') {
  checkedIndex(regionIndex, CAPACITY_REGIONS.length, 'capacity_region_invalid');
  capacityEgressRegions(egressMode);
  const single = egressMode === 'single-egress';
  if (single && regionIndex !== 0) throw new Error('capacity_egress_region_invalid');
  const controls = [];
  if (regionIndex === 0) controls.push({ kind: 'arm', at: manifest.earliestArmAt, order: -3 });
  controls.push({ kind: 'status', at: manifest.earliestArmAt + 1_000, order: -2 });
  if (regionIndex === 0) {
    controls.push({ kind: 'credential-seal', at: manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs, order: -2 });
    if (!single) controls.push({ kind: 'credential-transfer', at: manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.credentialTransferOffsetMs, order: -2 });
  }
  controls.push({ kind: 'credential-load', at: manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.credentialLoadOffsetMs, order: -2 });
  // Socket closure is local on every runner. Only runner 0 calls the native stop.
  controls.push({ kind: 'close-sockets', at: manifest.admissionsCloseAt, order: -1 });
  if (regionIndex === 0) controls.push({ kind: 'stop', at: manifest.admissionsCloseAt, order: 0 });
  controls.push({ kind: 'status', finalAudit: true,
    at: single ? manifest.admissionsCloseAt : manifest.hardCloseAt - 10_000, order: 1 });
  const streams = single ? CAPACITY_REGIONS.map((_region, index) => capacityWorkSchedule(manifest, index))
    : [capacityWorkSchedule(manifest, regionIndex)];
  yield* mergeCapacitySchedule([...streams, controls]);
}

export const CAPACITY_LOCAL_REGISTRATION_PROFILE_MS = 60_000;

/** Local diagnostic prefix. Every retained job keeps its original slot and rules. */
export function* capacityLocalRegistrationProfileSchedule(manifest) {
  const cutoff = manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.registrationBurstOffsetMs
    + CAPACITY_LOCAL_REGISTRATION_PROFILE_MS;
  for (const job of capacityRunnerSchedule(manifest, 0, 'single-egress')) {
    if (job.at >= cutoff) return;
    yield job;
  }
}

export function capacityRequest(job, credentials, bindings) {
  const common = { Authorization: `Bearer ${credentials.token}` };
  if (job.kind === 'standings') {
    capacityStandingsPage(job.pageIndex);
    return { path: `/capacity/standings/${job.pageIndex}`, init: { method: 'GET', headers: common } };
  }
  if (job.kind === 'step') {
    const step = capacityStep(job.index);
    const actor = bindings.actor(step);
    if (actor === null) throw new Error('capacity_binding_unresolved');
    const direct = ['command', 'observe-settlement', 'retire', 'duplicate-result'].includes(step.action);
    return { path: `/capacity/step/${job.index}`, init: { method: 'POST',
      headers: { ...common, Cookie: credentials.accounts[actor].cookie, 'Content-Type': 'application/json',
        ...(direct ? { [CAPACITY_BINDING_HEADER]: bindings.proof(step.intentIndex) } : {}) }, body: '{}' } };
  }
  if (job.kind === 'socket') {
    const slot = capacitySocketSlot(job.index);
    const actor = bindings.actor({ actor: { kind: 'bound-seat', ...slot } });
    if (actor === null) throw new Error('capacity_binding_unresolved');
    return { path: `/capacity/socket/${job.index}`, init: { headers: { ...common, Cookie: credentials.accounts[actor].cookie,
      [CAPACITY_BINDING_HEADER]: bindings.proof(slot.intentIndex) } } };
  }
  if (job.kind === 'prepare') {
    capacityAccountId(job.index);
    if (job.count !== undefined && job.count !== capacityPreparationAccounts(job.index).length) throw new Error('capacity_fixture_batch_invalid');
    return { path: `/capacity/${job.count === undefined ? 'prepare' : 'prepare-batch'}/${job.index}`, init: { method: 'POST',
      headers: { ...common, 'Content-Type': 'application/json' }, body: '{}' } };
  }
  if (!['manifest', 'arm', 'status', 'stop'].includes(job.kind)) throw new Error('capacity_job_invalid');
  const mutation = job.kind === 'arm' || job.kind === 'stop';
  return { path: `/capacity/${job.kind}`, init: { method: mutation ? 'POST' : 'GET',
    headers: mutation ? { ...common, 'Content-Type': 'application/json' } : common,
    ...(mutation ? { body: '{}' } : {}) } };
}

export function validateStepReply(index, value) {
  if (!value || value.index !== index || typeof value.accepted !== 'boolean'
    || (value.acceptedAt !== null && (!Number.isSafeInteger(value.acceptedAt) || value.acceptedAt < 0))
    || (value.accepted && value.acceptedAt === null)) throw new Error('capacity_reply_invalid');
  if (value.result && (typeof value.result.settled !== 'boolean' || typeof value.result.deliveryPending !== 'boolean'
    || !Number.isSafeInteger(value.result.terminalVersion) || value.result.terminalVersion < 0)) throw new Error('capacity_reply_invalid');
  return value;
}

async function limitedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('capacity_response_missing');
  let size = 0;
  const chunks = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > CAPACITY_DRIVER_LIMITS.maximumResponseBytes) {
      await reader.cancel();
      throw new Error('capacity_response_too_large');
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Transport never retries or interpolates an authority selector supplied by a response. */
export class CapacityTransport {
  #sockets = new Set();
  #requests = 0;
  #competitionTicket = null;
  constructor({ origin, credentials, bindings, earliestArmAt, issueCloseAt, hardCloseAt, profile, fetcher = fetch,
    WebSocketClass = WebSocket, now = Date.now, record = async () => {} }) {
    Object.assign(this, { origin: capacityOrigin(origin), credentials, bindings, earliestArmAt, issueCloseAt, hardCloseAt, profile, fetcher, WebSocketClass, now, record });
  }

  async issue(job) {
    if (this.now() >= (['manifest', 'stop', 'status'].includes(job.kind) ? this.hardCloseAt : this.issueCloseAt)
      || ++this.#requests > (diagnostic(this) ? 1_024 : CAPACITY_CORPUS.maximumWorkerRequests)) throw new Error('capacity_driver_expired');
    if (job.kind === 'prepare' && (!Number.isSafeInteger(this.earliestArmAt)
      || job.replyDeadlineAt !== this.earliestArmAt + credentialTiming(this).credentialSealOffsetMs
      || this.now() > job.replyDeadlineAt)) throw new Error('capacity_preparation_deadline');
    const step = job.kind === 'step' ? capacityStep(job.index) : null;
    const request = capacityRequest(job, this.credentials, this.bindings);
    if (this.#competitionTicket && (job.kind === 'prepare' || (step && step.actor.kind === 'account'))) {
      request.init.headers[CAPACITY_COMPETITION_HEADER] = this.#competitionTicket;
    }
    if (request.init.method === 'POST' || job.kind === 'socket') request.init.headers.Origin = this.origin;
    let httpStatus = null, privateCode = null, nativeFailure = null;
    try {
      if (job.kind === 'socket') return await this.#socket(job, request);
      const timeoutMs = job.kind === 'prepare'
        ? Math.min(CAPACITY_DRIVER_LIMITS.preparationTimeoutMs, Math.max(0, job.replyDeadlineAt - this.now()))
        : CAPACITY_DRIVER_LIMITS.fetchTimeoutMs;
      const response = await this.fetcher(this.origin + request.path, { ...request.init,
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      httpStatus = response.status;
      const rawTiming = step ? response.headers.get('X-Capacity-Timing') : null;
      const stageTiming = rawTiming?.match(/^auth;dur=(\d{1,5}\.\d),authority;dur=(\d{1,5}\.\d)$/);
      if (rawTiming && (!stageTiming || Number(stageTiming[1]) > 60_000 || Number(stageTiming[2]) > 60_000)) {
        throw new Error('capacity_response_invalid');
      }
      const rawNativeTiming = step ? response.headers.get('X-Capacity-Native-Timing') : null;
      let nativeTiming;
      if (rawNativeTiming) {
        if (rawNativeTiming.length > 512) throw new Error('capacity_response_invalid');
        nativeTiming = JSON.parse(rawNativeTiming);
        if (!nativeTiming || typeof nativeTiming !== 'object' || Array.isArray(nativeTiming)
          || Object.keys(nativeTiming).sort().join(',') !== 'claimedAt,enteredAt,methodFinishedAt,receivedAt,returningAt,sentAt,ticketAt'
          || Object.values(nativeTiming).some(at => !Number.isSafeInteger(at) || at < 1_600_000_000_000)) {
          throw new Error('capacity_response_invalid');
        }
        const { sentAt, receivedAt, enteredAt, ticketAt, claimedAt, methodFinishedAt, returningAt } = nativeTiming;
        const stages = [enteredAt, ticketAt, claimedAt, methodFinishedAt, returningAt];
        if (!stageTiming || receivedAt < sentAt || receivedAt - sentAt > 60_000 || returningAt - enteredAt > 60_000
          || stages.some((at, index) => index > 0 && at < stages[index - 1])) throw new Error('capacity_response_invalid');
      }
      const timing = { ...(stageTiming ? { stageTiming: { workerAuthMs: Number(stageTiming[1]), authorityMs: Number(stageTiming[2]) } } : {}),
        ...(nativeTiming ? { nativeTiming } : {}) };
      if (!response.ok) {
        privateCode = capacityPrivateFailureCode(response.headers.get('X-Capacity-Failure'));
        nativeFailure = readCapacityFailureAudit(response.headers.get('X-Capacity-Audit'));
        if (nativeFailure && (nativeFailure.code !== privateCode
          || (step && nativeFailure.index !== job.index))) nativeFailure = null;
        if (step?.action === 'register' && response.status === 429) {
          const reply = validateStepReply(job.index, await limitedJson(response));
          if (reply.accepted || reply.code !== 'ARENA_RETRY') throw new Error('capacity_response_invalid');
          return { status: 429, accepted: false, acceptedAt: null, code: 'ARENA_RETRY', ...timing };
        }
        await response.body?.cancel();
        if (response.status >= 500) throw new Error('capacity_provider_uncertain');
        return { status: response.status, accepted: false, acceptedAt: null };
      }
      if (job.kind === 'prepare') {
        const value = await limitedJson(response);
        const indexes = job.count === undefined ? [job.index] : capacityPreparationAccounts(job.index);
        const values = job.count === undefined ? [value] : value.accounts;
        if (!Array.isArray(values) || values.length !== indexes.length) throw new Error('capacity_credentials_invalid');
        const accounts = indexes.map((index, offset) => capacityAccountCredential(values[offset], index,
          { hardCloseAt: this.hardCloseAt, profile: this.profile }));
        if (this.now() > job.replyDeadlineAt) throw new Error('capacity_preparation_deadline');
        if (indexes.some(index => this.credentials.accounts[index])) throw new Error('capacity_credentials_replacement_denied');
        if (job.count !== undefined && (!value.usage || ['d1RowsRead', 'd1RowsWritten', 'd1Retries', 'd1RetryReadSurcharge']
          .some(key => !Number.isSafeInteger(value.usage[key]) || value.usage[key] < 0))) throw new Error('capacity_native_metrics_unavailable');
        indexes.forEach((index, offset) => { this.credentials.accounts[index] = accounts[offset]; });
        return { status: response.status, accepted: true, acceptedAt: null,
          ...(job.count === undefined ? { preparedAccountIndex: job.index } : { preparedAccountIndexes: indexes,
            preparationUsage: Object.fromEntries(['d1RowsRead', 'd1RowsWritten', 'd1Retries', 'd1RetryReadSurcharge']
              .map(key => [key, value.usage[key]])) }) };
      }
      if (job.kind === 'step') {
        const reply = validateStepReply(job.index, await limitedJson(response));
        if (step.action === 'register' && reply.accepted
          && (reply.event?.eventIndex !== step.eventIndex
            || reply.event.eventId !== capacityEventId(step.eventIndex, this.earliestArmAt))) {
          throw new Error('capacity_native_event_conflict');
        }
        if (step.action === 'observe-settlement' && reply.accepted
          && (reply.result?.settled !== true || reply.result.deliveryPending !== false || reply.result.terminalVersion !== 7)) {
          throw new Error('capacity_settlement_unproved');
        }
        this.bindings.accept(step, reply);
        return { status: response.status, accepted: reply.accepted, acceptedAt: reply.acceptedAt, ...timing,
          ...(step.action === 'register' && reply.accepted ? { registration: reply.event } : {}),
          ...(capacityPrivateFailureCode(reply.code) ? { code: reply.code } : {}),
          binding: reply.binding ? this.bindings.binding(step.intentIndex) : null,
          result: reply.result ? { settled: reply.result.settled, deliveryPending: reply.result.deliveryPending,
            terminalVersion: reply.result.terminalVersion } : null };
      }
      if (job.kind === 'standings') {
        const page = await limitedJson(response);
        const { eventIndex, page: pageIndex } = capacityStandingsPage(job.pageIndex);
        const age = response.headers.get('Age');
        const cache = response.headers.get('X-Capacity-Cache');
        const nativeRows = response.headers.get('X-Capacity-D1-Rows-Read');
        const retryReads = response.headers.get('X-Capacity-D1-Retry-Read-Surcharge');
        if (page.id !== capacityEventId(eventIndex, this.earliestArmAt) || page.format !== 'arena-v1'
          || !Number.isSafeInteger(page.generation) || page.generation < 1
          || !Array.isArray(page.standings) || page.standings.length > CAPACITY_CORPUS.standingsPageRows
          || !Number.isSafeInteger(page.generatedAt) || page.generatedAt > this.now() + CAPACITY_DRIVER_LIMITS.clockDriftMs
          || !Number.isSafeInteger(page.watermark) || page.watermark < 0
          || (page.nextCursor !== null && page.nextCursor !== `${page.generation}:${pageIndex + 1}`)
          || !/^[0-9]$/.test(age ?? '') || !/^(?:0|[1-9][0-9]?)$/.test(nativeRows ?? '')
          || Number(nativeRows) > CAPACITY_WARM_D1_READ_ROWS
          || !/^(?:0|[1-9][0-9]?)$/.test(retryReads ?? '')
          || Number(retryReads) % CAPACITY_WARM_D1_READ_ROWS !== 0
          || Number(retryReads) > (CAPACITY_D1_READ_ATTEMPTS - 1) * CAPACITY_WARM_D1_READ_ROWS
          || Number(nativeRows) + Number(retryReads) > CAPACITY_D1_READ_ATTEMPTS * CAPACITY_WARM_D1_READ_ROWS
          || (cache !== 'HIT' && cache !== 'MISS')
          || (cache === 'HIT' && (nativeRows !== '0' || retryReads !== '0'))
          || (cache === 'MISS' && (age !== '0' || Number(nativeRows) < 1))
          || response.headers.get('Cache-Control') !== 'public, max-age=10, s-maxage=10') {
          throw new Error('capacity_standings_invalid');
        }
        return { status: response.status, accepted: true, acceptedAt: null,
          projection: { id: page.id, generation: page.generation, generatedAt: page.generatedAt,
            watermark: page.watermark, rows: page.standings.length },
          cache: { age: Number(age), status: cache, d1RowsRead: Number(nativeRows), d1RetryReadSurcharge: Number(retryReads) } };
      }
      const reply = await limitedJson(response);
      if (job.kind === 'arm' && reply.armed === true) {
        const ticket = reply.competitionTicket;
        if (!ticket || Object.keys(ticket).sort().join(',') !== 'generation,id,manifestDigest,mode,objectKey,operation,runId,signature'
          || ticket.runId !== this.credentials.runId || ticket.manifestDigest !== this.credentials.manifestDigest
          || ticket.objectKey !== 'competition' || ticket.operation !== 'Competition.workflow'
          || ticket.mode !== 'workflow' || ticket.generation !== 1 || !/^[a-f0-9-]{36}$/.test(ticket.id)
          || !/^[A-Za-z0-9_-]{43}$/.test(ticket.signature)) throw new Error('capacity_workflow_ticket_invalid');
        this.#competitionTicket = JSON.stringify(ticket);
      }
      if (job.kind === 'status' && (reply.ready === false || reply.manifestDigest !== this.credentials.manifestDigest)) {
        throw new Error('capacity_status_unqualified');
      }
      return { status: response.status, accepted: true, acceptedAt: this.now(), control: {
        ready: reply.ready ?? null, armed: reply.armed ?? null, manifestDigest: reply.manifestDigest ?? null,
        blockers: reply.blockers ?? [], schedule: reply.schedule ?? null, stopReason: reply.stopReason ?? null,
        charges: reply.charges ?? null, activeObjects: reply.activeObjects ?? null,
        reserved: reply.reserved ?? null, observed: reply.observed ?? null,
        unresolvedDispatches: reply.unresolvedDispatches ?? null, physicalBytes: reply.physicalBytes ?? null,
        nativeShutdown: capacityShutdownReadback(reply.nativeShutdown),
      } };
    } catch (error) {
      if (step) this.bindings.uncertain(step);
      await this.record({ type: 'request-failure', kind: job.kind, index: job.index ?? null,
        at: this.now(), code: capacityFailureCode(error), httpStatus, privateCode,
        ...(nativeFailure ? { nativeFailure } : {}) });
      const failure = new Error('capacity_request_uncertain');
      if (!diagnostic(this) && step?.action === 'register' && job.index < CAPACITY_CORPUS.registrationBurst
        && httpStatus === null && privateCode === null
        && ['TimeoutError', 'TypeError', 'AbortError'].includes(error?.name)) {
        failure.burstRegistrationUncertainIndex = job.index;
        failure.burstRegistrationFailureCode = capacityFailureCode(error);
      }
      throw failure;
    }
  }

  async #socket(job, request) {
    const url = new URL(this.origin + request.path);
    url.protocol = 'wss:';
    const socket = new this.WebSocketClass(url.href, { headers: { ...request.init.headers, Origin: this.origin } });
    this.#sockets.add(socket);
    socket.addEventListener('close', () => this.#sockets.delete(socket), { once: true });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > CAPACITY_DRIVER_LIMITS.maximumResponseBytes) {
        socket.close(1000, 'bounded message');
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { socket.close(1000, 'invalid message'); return; }
      // Record only counts/versions. Messages can contain private names and complete history.
      this.record({ type: 'socket-message', index: job.index, at: this.now(),
        messageType: ['snapshot', 'command', 'error'].includes(message.type) ? message.type : 'invalid',
        version: Number.isSafeInteger(message.snapshot?.version) ? message.snapshot.version : null }).catch(() => socket.close(1000, 'trace failure'));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('capacity_socket_uncertain')); }, CAPACITY_DRIVER_LIMITS.fetchTimeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('capacity_socket_uncertain')); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('capacity_socket_uncertain')); }, { once: true });
    });
    return { status: 101, accepted: true, acceptedAt: this.now(), sockets: this.#sockets.size };
  }

  close() { for (const socket of this.#sockets) socket.close(1000, 'fixed run stop'); }
  get counts() { return { requests: this.#requests, openSockets: this.#sockets.size }; }
}

export function capacityResourceSample(previous = null) {
  const at = performance.now();
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const elapsedMs = previous ? at - previous.at : 0;
  const cpuMicroseconds = previous ? cpu.user + cpu.system - previous.cpu.user - previous.cpu.system : 0;
  return { at, cpu, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
    elapsedMs, cpuMicroseconds, coreUtilization: elapsedMs > 0 ? cpuMicroseconds / (elapsedMs * 1_000) : null };
}

/** No secrets or provider exception strings enter a trace. */
export class CapacityTrace {
  #stream;
  #completion;
  #bytes = 0;
  #encodedBytes = 0;
  #failed = false;
  #draining = null;
  #backpressure = { count: 0, totalMs: 0, maximumMs: 0 };
  constructor(path) {
    const destination = createWriteStream(path, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 });
    this.#stream = createGzip({ level: 1, chunkSize: 64 * 1024 });
    this.#stream.on('data', chunk => {
      this.#bytes += chunk.byteLength;
      if (this.#bytes > CAPACITY_DRIVER_LIMITS.maximumTraceBytes) this.#stream.destroy(new Error('capacity_trace_full'));
    });
    this.#completion = pipeline(this.#stream, destination).then(() => true, () => { this.#failed = true; return false; });
  }
  async write(value) {
    if (this.#draining) await this.#draining;
    if (this.#failed) throw new Error('capacity_trace_failed');
    const encoded = JSON.stringify(value) + '\n';
    this.#encodedBytes += Buffer.byteLength(encoded);
    if (this.#encodedBytes > CAPACITY_DRIVER_LIMITS.maximumEncodedTraceBytes) throw new Error('capacity_trace_full');
    if (!this.#stream.write(encoded)) {
      const started = performance.now();
      this.#backpressure.count++;
      this.#draining = once(this.#stream, 'drain').then(() => {
        const elapsed = performance.now() - started;
        this.#backpressure.totalMs += elapsed;
        this.#backpressure.maximumMs = Math.max(this.#backpressure.maximumMs, elapsed);
      }).finally(() => { this.#draining = null; });
      await this.#draining;
    }
    if (this.#failed) throw new Error('capacity_trace_failed');
  }
  async close() {
    if (this.#draining) await this.#draining;
    this.#stream.end();
    if (!await this.#completion) throw new Error('capacity_trace_failed');
  }
  get bytes() { return this.#bytes; }
  get stats() { return { encodedBytes: this.#encodedBytes, compressedBytes: this.#bytes, backpressure: { ...this.#backpressure } }; }
}

export const capacityClock = () => ({
  now: Date.now, monotonic: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
});

/** Fixed slots fail when missed. Preparation is paced within its aggregate deadline. */
export async function runCapacitySchedule(schedule, { clock = capacityClock(), issue, record,
  ready = () => true, issueCloseAt, hardCloseAt, concurrency = CAPACITY_DRIVER_LIMITS.concurrentFetches,
  stopOnFailure = false, resolvedUncertainties = () => 0 }) {
  if (!Number.isSafeInteger(issueCloseAt) || !Number.isSafeInteger(hardCloseAt) || hardCloseAt <= issueCloseAt
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > CAPACITY_DRIVER_LIMITS.concurrentFetches) {
    throw new Error('capacity_schedule_limits_invalid');
  }
  const initialWall = clock.now();
  const initialMono = clock.monotonic();
  const active = new Set();
  const totals = { offered: 0, acknowledged: 0, denied: 0, unexpectedDenials: 0, missed: 0, saturated: 0, dependencies: 0, uncertain: 0,
    maximumInflight: 0, clockRegressed: false, hardCloseReached: false };
  let failed = false;
  let halted = false;
  let preparationDueAt = initialWall;
  const finish = async (job, offeredAt, offeredMono) => {
    try {
      const result = await issue(job);
      totals.acknowledged++;
      if (result.accepted === false) {
        totals.denied++;
        if (!job.expectedDenials?.includes(result.status)) {
          totals.unexpectedDenials++;
          halted = stopOnFailure;
        }
      }
      await record({ type: 'acknowledged', kind: job.kind, index: job.index ?? null, scheduledAt: job.at,
        offeredAt, acknowledgedAt: clock.now(), elapsedMs: clock.monotonic() - offeredMono, ...result });
    } catch {
      totals.uncertain++;
      halted = stopOnFailure;
      await record({ type: 'uncertain', kind: job.kind, index: job.index ?? null, scheduledAt: job.at,
        offeredAt, acknowledgedAt: clock.now(), elapsedMs: clock.monotonic() - offeredMono });
    }
  };
  for (const job of schedule) {
    if (failed || halted) break;
    const preparation = job.kind === 'prepare';
    if (preparation && (!Number.isSafeInteger(job.replyDeadlineAt) || job.replyDeadlineAt <= job.at
      || job.replyDeadlineAt >= issueCloseAt)) throw new Error('capacity_preparation_deadline');
    const deadline = preparation ? job.replyDeadlineAt : job.at + CAPACITY_DRIVER_LIMITS.maximumLatenessMs;
    if (job.at >= issueCloseAt) {
      totals.missed++;
      await record({ type: 'scheduled-after-cutoff', kind: job.kind, index: job.index ?? null, scheduledAt: job.at });
      break;
    }
    const earliest = preparation ? Math.max(job.at, preparationDueAt
      - (CAPACITY_DRIVER_TIMING.fixturePrepareBurst - 1) * CAPACITY_DRIVER_TIMING.fixturePrepareIntervalMs) : job.at;
    while (clock.now() < earliest) await clock.wait(Math.min(1_000, earliest - clock.now()));
    if (halted) break;
    const now = clock.now();
    const drift = Math.abs(now - initialWall - (clock.monotonic() - initialMono));
    if (drift > CAPACITY_DRIVER_LIMITS.clockDriftMs) {
      totals.clockRegressed = true;
      await record({ type: 'clock-drift', at: now, driftMs: drift });
      break;
    }
    if (now >= issueCloseAt) break;
    const late = now - job.at;
    if (now > deadline) {
      totals.missed++;
      await record({ type: 'missed', kind: job.kind, index: job.index ?? null, scheduledAt: job.at, at: now, lateMs: late });
      halted = stopOnFailure;
      continue;
    }
    if (active.size >= concurrency) {
      totals.saturated++;
      await record({ type: 'saturated', kind: job.kind, index: job.index ?? null, scheduledAt: job.at, at: now, inflight: active.size });
      halted = stopOnFailure;
      continue;
    }
    if (!ready(job)) {
      totals.dependencies++;
      await record({ type: 'dependency-unresolved', kind: job.kind, index: job.index ?? null, scheduledAt: job.at, at: now });
      halted = stopOnFailure;
      continue;
    }
    // Record the original indexed intent before dispatch. A lost reply is never retried here.
    const offeredMono = clock.monotonic();
    await record({ type: 'dispatch-intent', kind: job.kind, index: job.index ?? null, scheduledAt: job.at, at: now, lateMs: late });
    if (clock.now() > deadline || clock.now() >= issueCloseAt) {
      totals.missed++;
      await record({ type: 'trace-stall', kind: job.kind, index: job.index ?? null, scheduledAt: job.at, at: clock.now() });
      halted = stopOnFailure;
      continue;
    }
    totals.offered++;
    const offeredAt = clock.now();
    if (preparation) preparationDueAt = Math.max(preparationDueAt, offeredAt) + CAPACITY_DRIVER_TIMING.fixturePrepareIntervalMs;
    const pending = finish(job, offeredAt, offeredMono).catch(() => { failed = true; });
    active.add(pending);
    pending.finally(() => active.delete(pending));
    totals.maximumInflight = Math.max(totals.maximumInflight, active.size);
    await record({ type: 'offered', kind: job.kind, index: job.index ?? null, scheduledAt: job.at, at: offeredAt,
      lateMs: offeredAt - job.at, inflight: active.size });
  }
  while (active.size && clock.now() < hardCloseAt && !failed) {
    await Promise.race([Promise.allSettled(active), clock.wait(Math.min(100, hardCloseAt - clock.now()))]);
  }
  totals.hardCloseReached = active.size > 0;
  const resolvedUncertain = resolvedUncertainties();
  if (!Number.isSafeInteger(resolvedUncertain) || resolvedUncertain < 0 || resolvedUncertain > totals.uncertain) {
    throw new Error('capacity_uncertainty_resolution_invalid');
  }
  const unresolvedUncertain = totals.uncertain - resolvedUncertain;
  return { ...totals, resolvedUncertain, unresolvedUncertain, pendingAtClose: active.size,
    passed: !failed && !active.size && !totals.missed && !totals.saturated
      && !totals.unexpectedDenials && !totals.dependencies && !unresolvedUncertain && !totals.clockRegressed };
}

async function privateJson(path, maximumBytes) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximumBytes || (info.mode & 0o077)) throw new Error('capacity_private_file_invalid');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readCapacitySeed(path, manifest) {
  const value = await privateJson(path, CAPACITY_DRIVER_LIMITS.maximumSeedBytes);
  if (value.schema !== 'ejm-chess-capacity-seed-v1' || value.runId !== manifest.runId
    || value.manifestDigest !== manifest.digest || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value.token)
    || Object.keys(value).some(key => !['schema', 'runId', 'manifestDigest', 'token'].includes(key))) throw new Error('capacity_seed_invalid');
  return { ...value, accounts: Array(accountCount(manifest)).fill(null) };
}

/** Normalize the private native helper response without tracing its cookie. */
export function capacityAccountCredential(value, index, manifest) {
  checkedIndex(index, accountCount(manifest), 'capacity_credentials_invalid');
  if (!value || (value.index ?? value.accountIndex) !== index
    || (value.index !== undefined && value.index !== index) || (value.accountIndex !== undefined && value.accountIndex !== index)
    || (value.accountId !== undefined && value.accountId !== capacityAccountId(index))
    || typeof value.cookie !== 'string' || value.cookie.length < 20 || value.cookie.length > 2_048 || /[\r\n]/.test(value.cookie)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < manifest.hardCloseAt) throw new Error('capacity_credentials_invalid');
  return { index, accountId: capacityAccountId(index), cookie: value.cookie, expiresAt: value.expiresAt };
}

function credentialArtifactMac(token, sha256) {
  return createHmac('sha256', token).update(`ejm-chess-capacity-sessions-v1:${sha256}`).digest('hex');
}

function credentialArtifactTime(at, manifest, offset) {
  if (!Number.isSafeInteger(at) || at < manifest.earliestArmAt + offset
    || at > manifest.earliestArmAt + offset + CAPACITY_DRIVER_LIMITS.maximumLatenessMs) throw new Error('capacity_credential_artifact_late');
}

/** The final path appears only after a complete private write. Nothing is overwritten. */
export async function sealCapacityCredentialArtifact(path, credentials, manifest, at) {
  credentialArtifactTime(at, manifest, credentialTiming(manifest).credentialSealOffsetMs);
  if (credentials.runId !== manifest.runId || credentials.manifestDigest !== manifest.digest
    || !Array.isArray(credentials.accounts) || credentials.accounts.length !== accountCount(manifest)) throw new Error('capacity_credentials_invalid');
  const snapshot = { schema: 'ejm-chess-capacity-sessions-v1', runId: manifest.runId, manifestDigest: manifest.digest,
    sealedAt: at, accounts: credentials.accounts.map((account, index) => capacityAccountCredential(account, index, manifest)) };
  const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const bytes = JSON.stringify({ schema: 'ejm-chess-capacity-session-artifact-v1', sha256,
    mac: credentialArtifactMac(credentials.token, sha256), snapshot }) + '\n';
  if (Buffer.byteLength(bytes) > CAPACITY_DRIVER_LIMITS.maximumCredentialsBytes) throw new Error('capacity_credentials_too_large');
  const pending = path + '.pending';
  await writeFile(pending, bytes, { flag: 'wx', mode: 0o600 });
  await link(pending, path);
  await unlink(pending);
  return { sha256, bytes: Buffer.byteLength(bytes), accounts: accountCount(manifest) };
}

/** One fixed read after authenticated runner transport, with no poll or fallback. */
export async function loadCapacityCredentialArtifact(path, credentials, manifest, at) {
  credentialArtifactTime(at, manifest, credentialTiming(manifest).credentialLoadOffsetMs);
  if (credentials.runId !== manifest.runId || credentials.manifestDigest !== manifest.digest
    || credentials.artifactSha256 !== undefined) throw new Error('capacity_seed_invalid');
  const envelope = await privateJson(path, CAPACITY_DRIVER_LIMITS.maximumCredentialsBytes);
  const snapshot = envelope?.snapshot;
  if (envelope?.schema !== 'ejm-chess-capacity-session-artifact-v1' || !/^[a-f0-9]{64}$/.test(envelope.sha256)
    || !/^[a-f0-9]{64}$/.test(envelope.mac) || snapshot?.schema !== 'ejm-chess-capacity-sessions-v1'
    || snapshot.runId !== manifest.runId || snapshot.manifestDigest !== manifest.digest
    || !Array.isArray(snapshot.accounts) || snapshot.accounts.length !== accountCount(manifest)) throw new Error('capacity_credential_artifact_invalid');
  credentialArtifactTime(snapshot.sealedAt, manifest, credentialTiming(manifest).credentialSealOffsetMs);
  const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (sha256 !== envelope.sha256 || !timingSafeEqual(Buffer.from(envelope.mac, 'hex'),
    Buffer.from(credentialArtifactMac(credentials.token, sha256), 'hex'))) throw new Error('capacity_credential_artifact_invalid');
  const accounts = snapshot.accounts.map((account, index) => capacityAccountCredential(account, index, manifest));
  for (let index = 0; index < accounts.length; index++) {
    const previous = credentials.accounts[index];
    if (previous && (previous.cookie !== accounts[index].cookie || previous.expiresAt !== accounts[index].expiresAt)) {
      throw new Error('capacity_credentials_replacement_denied');
    }
  }
  credentials.accounts = accounts;
  credentials.artifactSha256 = sha256;
  return { sha256, accounts: accountCount(manifest) };
}

export async function capacityDriverDigests() {
  const digest = async url => createHash('sha256').update(await readFile(url)).digest('hex');
  return { driverDigest: await digest(new URL(import.meta.url)),
    corpusDigest: await digest(new URL('../src/shared/capacity-corpus.ts', import.meta.url)) };
}

/** Reachable from the CLI only after the static execution gate is reviewed. */
async function runQualifiedCapacityRunner(candidate, credentials, regionIndex, tracePath, artifactPath,
  { transportFactory = options => new CapacityTransport(options), localOnly = false, registrationProfile = null } = {}) {
  if (registrationProfile !== null && (!localOnly || typeof registrationProfile?.ready !== 'function'
    || Object.keys(registrationProfile).some(key => key !== 'ready'))) throw new Error('capacity_local_profile_invalid');
  const manifest = candidate.manifest;
  const short = diagnostic(manifest);
  const profileCutoff = registrationProfile === null ? null
    : manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.registrationBurstOffsetMs + CAPACITY_LOCAL_REGISTRATION_PROFILE_MS;
  let profileJobs = 0;
  function* jobs() {
    const source = short ? capacityRegistrationProviderSchedule(manifest)
      : profileCutoff === null ? capacityRunnerSchedule(manifest, regionIndex, candidate.egressMode)
      : capacityLocalRegistrationProfileSchedule(manifest);
    for (const job of source) { if (profileCutoff !== null) profileJobs++; yield job; }
  }
  const clock = capacityClock();
  if (!process.version.startsWith('v24.') || clock.now() >= manifest.earliestArmAt) throw new Error('capacity_driver_start_invalid');
  const trace = new CapacityTrace(tracePath);
  const record = value => {
    if (short && ['clock-drift', 'missed', 'saturated', 'dependency-unresolved', 'trace-stall', 'uncertain'].includes(value.type)) {
      workAllowed = false; admissionsFailed = true;
    }
    return trace.write({ region: CAPACITY_REGIONS[regionIndex], ...value });
  };
  const bindings = new CapacityBindings();
  const transport = transportFactory({ origin: `https://${manifest.host}`, credentials, bindings,
    earliestArmAt: manifest.earliestArmAt, issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt,
    profile: manifest.profile, record });
  const issueTransport = regionIndex === 0
    ? sequenceCapacityInitialControls(job => transport.issue(job), manifest.digest)
    : job => transport.issue(job);
  let workAllowed = false;
  let admissionsFailed = false;
  let credentialsReady = false;
  let finalAudit = null;
  let stopCompletion = null;
  const registeredAccounts = new Set();
  const registrationReplies = { accepted: 0, throttled: 0 };
  const registrationRecovery = new CapacityRegistrationRecovery(manifest);
  let sample = capacityResourceSample();
  let sampleWrite = null;
  const resources = { samples: 0, skipped: 0, traceFailed: false, maximumRssBytes: sample.rssBytes, maximumCoreUtilization: 0 };
  const sampleResources = () => {
    if (sampleWrite) { resources.skipped++; workAllowed = false; admissionsFailed = true; return; }
    sample = capacityResourceSample(sample);
    resources.samples++;
    resources.maximumRssBytes = Math.max(resources.maximumRssBytes, sample.rssBytes);
    resources.maximumCoreUtilization = Math.max(resources.maximumCoreUtilization, sample.coreUtilization ?? 0);
    sampleWrite = record({ type: 'resources', at: clock.now(), sample }).catch(() => {
      resources.traceFailed = true; workAllowed = false; admissionsFailed = true;
    }).finally(() => { sampleWrite = null; });
  };
  let timer = null;
  try {
    await record({ type: 'runner-start', at: clock.now(), runId: manifest.runId, manifestDigest: manifest.digest,
      localOnly, qualificationPassed: false,
      ...(!short && registrationProfile === null ? {} : { fullWorkload: false, providerQualification: false }),
      driverDigest: candidate.driverDigest, corpusDigest: candidate.corpusDigest,
      ledgerDigest: candidate.ledgerDigest, runnerId: candidate.runners[regionIndex].runnerId,
      egressMode: candidate.egressMode ?? 'six-regions',
      unrunRegions: CAPACITY_REGIONS.filter(region => !capacityEgressRegions(candidate.egressMode).includes(region)) });
    const preflight = await transport.issue({ kind: 'manifest' });
    validateCapacityPreflight(preflight, manifest);
    await record({ type: 'manifest-preflight', at: clock.now(), ...preflight });
    if (clock.now() >= manifest.earliestArmAt) throw new Error('capacity_preflight_late');
    sampleResources();
    timer = setInterval(sampleResources, CAPACITY_DRIVER_LIMITS.sampleIntervalMs);
    const totals = await runCapacitySchedule(jobs(), {
      clock, record, issueCloseAt: profileCutoff ?? manifest.hardCloseAt - 5_000,
      hardCloseAt: profileCutoff === null ? manifest.hardCloseAt : profileCutoff + CAPACITY_DRIVER_LIMITS.fetchTimeoutMs,
      concurrency: short ? CAPACITY_DRIVER_LIMITS.registrationDiagnosticConcurrentFetches : CAPACITY_DRIVER_LIMITS.concurrentFetches,
      stopOnFailure: localOnly,
      resolvedUncertainties: () => registrationRecovery.counts.resolvedUncertainReplies,
      ready: job => {
        if (['arm', 'status', 'stop', 'close-sockets'].includes(job.kind)) return true;
        if (!workAllowed || admissionsFailed || resources.traceFailed || resources.skipped) return false;
        if (['prepare', 'credential-seal', 'credential-transfer', 'credential-load'].includes(job.kind)) return true;
        if (registrationProfile !== null && !registrationProfile.ready()) return false;
        const ready = credentialsReady && (job.kind !== 'step' || bindings.ready(capacityStep(job.index)));
        if (!ready) { workAllowed = false; admissionsFailed = true; }
        return ready;
      },
      issue: async job => {
        if (job.kind === 'close-sockets') {
          workAllowed = false;
          transport.close();
          return { status: null, accepted: true, acceptedAt: clock.now(), local: true, ...transport.counts };
        }
        try {
          if (job.kind === 'credential-seal' || job.kind === 'credential-load') {
            const artifact = await (job.kind === 'credential-seal' ? sealCapacityCredentialArtifact : loadCapacityCredentialArtifact)(
              artifactPath, credentials, manifest, clock.now());
            if (job.kind === 'credential-load') credentialsReady = true;
            return { status: null, accepted: true, acceptedAt: clock.now(), local: true, artifact };
          }
          if (job.kind === 'credential-transfer') {
            // No executable or shell text may come from candidate.transportPath.
            // Actual authenticated runner transports and their timing are not qualified.
            throw new Error('capacity_credential_transfer_unqualified');
          }
          if (job.finalAudit && candidate.egressMode === 'single-egress') {
            // Preserve the one scheduled status even when the preceding stop
            // reports a failed run. Its reason remains a qualification failure.
            await awaitCapacityStop(stopCompletion);
          }
          const request = issueTransport(job);
          if (job.kind === 'stop') stopCompletion = request;
          const result = await request;
          registrationRecovery.acknowledge(job, result);
          if (short && job.kind === 'step') {
            if (result.accepted) {
              registrationReplies.accepted++;
              registeredAccounts.add(capacityStep(job.index).actor.accountIndex);
            } else if (result.status === 429 && result.code === 'ARENA_RETRY') registrationReplies.throttled++;
          }
          if (['arm', 'status', 'stop'].includes(job.kind)) {
            const control = result.control;
            if (!result.accepted || control?.armed !== true || control.manifestDigest !== manifest.digest) {
              throw new Error('capacity_control_unqualified');
            }
            if (job.finalAudit) finalAudit = capacityFinalAudit(control, manifest, clock.now());
            else if (job.kind === 'status') {
              if (control.stopReason !== null) throw new Error('capacity_run_already_stopped');
              workAllowed = !admissionsFailed;
            }
          } else if (result.accepted === false && !job.expectedDenials?.includes(result.status)) {
            workAllowed = false; admissionsFailed = true;
          }
          return result;
        } catch (error) {
          if (!registrationRecovery.defer(job, error)) { workAllowed = false; admissionsFailed = true; }
          await record({ type: 'runner-failure', kind: job.kind, index: job.index ?? null,
            at: clock.now(), code: capacityFailureCode(error) });
          throw new Error('capacity_runner_uncertain');
        }
      },
    });
    clearInterval(timer); timer = null;
    if (sampleWrite) await sampleWrite;
    const report = { type: 'runner-final', at: clock.now(), totals, resources, bindings: bindings.counts,
      transport: transport.counts, finalAudit,
      registrationRecovery: registrationRecovery.counts,
      localOnly, qualificationPassed: false,
      ...(short ? { fullWorkload: false, providerQualification: false,
        registration: { ...registrationReplies, uniqueAcceptedAccounts: registeredAccounts.size },
        diagnosticPassed: totals.passed && !resources.traceFailed && resources.skipped === 0
          && registrationReplies.accepted + registrationReplies.throttled === CAPACITY_REGISTRATION_DIAGNOSTIC.registrations
          && registrationReplies.accepted > 0 && registrationReplies.throttled > 0
          && finalAudit?.nativeClosurePassed === true
          && finalAudit.nativeShutdown.registration.entrants === registeredAccounts.size } : {}),
      ...(registrationProfile === null ? {} : { fullWorkload: false, providerQualification: false,
        diagnosticScheduleCompleted: totals.passed && totals.offered === profileJobs && !resources.traceFailed && resources.skipped === 0 }),
      passed: !short && registrationProfile === null && totals.passed && !resources.traceFailed && resources.skipped === 0 && finalAudit?.nativeClosurePassed === true };
    await record(report);
    return report;
  } finally {
    if (timer) clearInterval(timer);
    if (short && !stopCompletion && clock.now() < manifest.hardCloseAt) {
      // One owner stop after a scheduler failure. Never repeat an uncertain stop.
      stopCompletion = transport.issue({ kind: 'stop' });
      try { await record({ type: 'emergency-stop', at: clock.now(), ...await stopCompletion }); }
      catch { await record({ type: 'emergency-stop-uncertain', at: clock.now() }); }
      try { await record({ type: 'emergency-status', at: clock.now(), ...await transport.issue({ kind: 'status' }) }); }
      catch { await record({ type: 'emergency-status-uncertain', at: clock.now() }); }
    }
    transport.close();
    if (sampleWrite) await sampleWrite;
    await trace.close();
  }
}

// Node fetch rewrites Host. The standard HTTP client preserves the canonical
// host on loopback without DNS, redirects or another dependency.
export function localCapacityFetch(value, init) {
  return new Promise((resolveResponse, reject) => {
    const url = new URL(value);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init.method ?? 'GET', headers: init.headers, signal: init.signal,
    }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
      }
      const status = response.statusCode;
      const empty = [204, 205, 304].includes(status);
      if (empty) response.resume();
      resolveResponse(new Response(empty ? null : Readable.toWeb(response), { status, headers }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

/** Local-only full rehearsal. Calendar, corpus and all timing checks stay intact. */
export async function runLocalCapacityRehearsal({ candidate, credentials, tracePath, sessionsArtifactPath,
  loopbackOrigin, fetcher = localCapacityFetch, WebSocketClass = WebSocket, registrationProfile = null }) {
  if (registrationProfile !== null && (typeof registrationProfile?.ready !== 'function'
    || Object.keys(registrationProfile).some(key => key !== 'ready'))) throw new Error('capacity_local_profile_invalid');
  if (!process.version.startsWith('v24.')) throw new Error('capacity_local_node_invalid');
  let loopback;
  try { loopback = new URL(loopbackOrigin); } catch { throw new Error('capacity_local_origin_invalid'); }
  if (!['http:', 'https:'].includes(loopback.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(loopback.hostname)
    || loopback.username || loopback.password || loopback.pathname !== '/' || loopback.search || loopback.hash) {
    throw new Error('capacity_local_origin_invalid');
  }
  if (candidate?.egressMode !== 'single-egress') throw new Error('capacity_local_egress_invalid');
  validateCapacityCandidate(candidate, await capacityDriverDigests());
  const manifest = candidate.manifest;
  const canonical = capacityOrigin(`https://${manifest.host}`);
  if (credentials?.runId !== manifest.runId || credentials.manifestDigest !== manifest.digest
    || typeof credentials.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credentials.token)
    || !Array.isArray(credentials.accounts) || credentials.accounts.length !== accountCount(manifest)) {
    throw new Error('capacity_seed_invalid');
  }
  const translate = (value, socket = false) => {
    const input = new URL(value);
    if (input.origin !== (socket ? canonical.replace('https:', 'wss:') : canonical)) {
      throw new Error('capacity_local_destination_invalid');
    }
    const destination = new URL(loopback);
    destination.pathname = input.pathname;
    destination.search = input.search;
    if (socket) destination.protocol = destination.protocol === 'https:' ? 'wss:' : 'ws:';
    return destination.href;
  };
  class LocalWebSocket extends WebSocketClass {
    constructor(value, options) {
      super(translate(value, true), { ...options, headers: { ...options.headers, Host: manifest.host } });
    }
  }
  return runQualifiedCapacityRunner(candidate, credentials, 0, tracePath, sessionsArtifactPath, {
    localOnly: true, registrationProfile,
    transportFactory: options => new CapacityTransport({ ...options,
      fetcher: (value, init) => fetcher(translate(value), { ...init, headers: { ...init.headers, Host: manifest.host } }),
      WebSocketClass: LocalWebSocket }),
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    describe: { type: 'boolean' }, execute: { type: 'boolean' }, 'verify-candidate': { type: 'boolean' },
    candidate: { type: 'string' }, seed: { type: 'string' }, 'sessions-artifact': { type: 'string' },
    region: { type: 'string' }, trace: { type: 'string' },
  }, strict: true });
  if (values.describe && Object.keys(values).length === 1) {
    process.stdout.write(JSON.stringify({ schema: 'ejm-chess-capacity-driver-v1', ready: CAPACITY_DRIVER_EXECUTION_READY,
      blockers: CAPACITY_DRIVER_BLOCKERS, corpus: CAPACITY_CORPUS,
      followUpQualifications: CAPACITY_DRIVER_FOLLOW_UPS,
      stepCount: CAPACITY_STEP_COUNT, limits: CAPACITY_DRIVER_LIMITS, regions: CAPACITY_REGIONS,
      schedule: 'Fixed real UTC minute anchor, ten-second recovery lead, full 900-second regular stream',
      qualification: 'First tier uses one reviewed actual US West egress for the complete corpus. Native workload, shutdown and provider costs remain unqualified. Six-region transport is a separate unrun qualification.',
      ...await capacityDriverDigests() }, null, 2) + '\n');
    return;
  }
  if (values['verify-candidate'] && !values.execute && values.candidate && !values.seed && !values['sessions-artifact']
    && !values.region && !values.trace && !values.describe) {
    const candidate = validateCapacityCandidate(await privateJson(values.candidate, 1024 ** 2), await capacityDriverDigests());
    process.stdout.write(JSON.stringify({ schema: 'ejm-chess-capacity-candidate-check-v1', sourceAndScheduleValid: true,
      executionReady: CAPACITY_DRIVER_EXECUTION_READY, blockers: CAPACITY_DRIVER_BLOCKERS,
      egressMode: candidate.egressMode ?? 'six-regions', plannedEgressRegions: capacityEgressRegions(candidate.egressMode),
      unrunRegions: CAPACITY_REGIONS.filter(region => !capacityEgressRegions(candidate.egressMode).includes(region)),
      runId: candidate.manifest.runId, manifestDigest: candidate.manifest.digest,
      schedule: capacityManifestSchedule(candidate.manifest),
      incrementalMaximumCents: candidate.incrementalMaximumCents }, null, 2) + '\n');
    return;
  }
  // No argument, environment variable or timing file can bypass this source gate.
  if (!values.execute || !CAPACITY_DRIVER_EXECUTION_READY) throw new Error('capacity_driver_unqualified');
  if (!values.candidate || !values.seed || !values['sessions-artifact'] || !values.trace || values.describe || values['verify-candidate']
    || !CAPACITY_REGIONS.includes(values.region)) throw new Error('capacity_driver_arguments_invalid');
  const candidate = validateCapacityCandidate(await privateJson(values.candidate, 1024 ** 2), await capacityDriverDigests());
  // External credential transfer stays closed until its own reviewed path exists.
  if (candidate.egressMode !== 'single-egress' || values.region !== 'us-west') throw new Error('capacity_regional_transport_unqualified');
  const credentials = await readCapacitySeed(values.seed, candidate.manifest);
  const report = await runQualifiedCapacityRunner(candidate, credentials, CAPACITY_REGIONS.indexOf(values.region), values.trace,
    values['sessions-artifact']);
  process.stdout.write(JSON.stringify({ passed: report.passed, diagnosticPassed: report.diagnosticPassed ?? false,
    registration: report.registration ?? null, totals: report.totals, finalAudit: report.finalAudit }) + '\n');
  if (!report.passed && !report.diagnosticPassed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { process.stderr.write('Capacity driver remains unarmed or failed qualification. Run --describe for the current gates.\n'); process.exitCode = 1; });
}
