import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { Chess } from 'chess.js';
import { capacityNativeFailure } from '../src/shared/capacity-failure.ts';
import { ARENA_POLICY } from '../src/server/arena-policy.ts';
import WebSocket, { WebSocketServer } from 'ws';
import { CAPACITY_BINDING_HEADER, CAPACITY_COMPETITION_HEADER, CAPACITY_CORPUS, CAPACITY_STEP_COUNT, capacityAccountId, capacityCommand, capacityEventId,
  capacityIntent, capacityIntentStepIndex, capacityRecoveryReleaseAt, capacityStep,
  CAPACITY_PREPARATION_BATCH_SIZE, capacityPreparationAccounts,
  CAPACITY_REGISTRATION_DIAGNOSTIC, capacityRegistrationDiagnosticSchedule } from '../src/shared/capacity-corpus.ts';
import { CAPACITY_DRIVER_LIMITS, CAPACITY_DRIVER_TIMING, CAPACITY_REGIONS, CapacityBindings, CapacityRegistrationRecovery, CapacityTrace, CapacityTransport,
  capacityAccountCredential, capacityCalendarSchedule, capacityEgressRegions, capacityRequest,
  capacityDriverDigests, capacityFinalAudit, awaitCapacityStop, sequenceCapacityInitialControls, capacityRunnerSchedule, capacityRegistrationProviderSchedule,
  mergeCapacitySchedule, runCapacitySchedule,
  runLocalCapacityRehearsal, localCapacityFetch,
  loadCapacityCredentialArtifact, readCapacitySeed, sealCapacityCredentialArtifact,
  validateCapacityCandidate, validateCapacityPreflight } from './capacity-driver.mjs';

const anchor = Date.parse('2026-10-25T17:50:00Z');
const manifest = capacityCalendarSchedule(anchor);
const clockFixture = () => {
  let wall = 1_000;
  let mono = 0;
  return { now: () => wall, monotonic: () => mono,
    wait: async ms => { wall += ms; mono += ms; },
    advance: ms => { wall += ms; mono += ms; }, drift: ms => { wall += ms; } };
};

test('provider registration diagnostic offers only its fixed 256-account prefix and seals complete cookies', async () => {
  const sealed = { ...capacityRegistrationDiagnosticSchedule(anchor), profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile,
    runId: 'a'.repeat(36), digest: 'b'.repeat(64) };
  const jobs = [...capacityRegistrationProviderSchedule(sealed)];
  const registrations = jobs.filter(job => job.kind === 'step');
  assert.equal(registrations.length, 768);
  assert.equal(new Set(registrations.map(job => job.index)).size, 768);
  assert.equal(new Set(registrations.map(job => capacityStep(job.index).actor.accountIndex)).size, 256);
  assert.ok(registrations.every(job => capacityStep(job.index).action === 'register'));
  assert.ok(registrations.every((job, index) => job.at === anchor + 30_000 + index * 3));
  assert.equal(jobs.filter(job => job.kind === 'prepare').reduce((sum, job) => sum + job.count, 0), 256);
  assert.ok(jobs.every(job => ['arm', 'status', 'prepare', 'credential-seal', 'credential-load', 'step', 'stop'].includes(job.kind)));
  const directory = await mkdtemp(join(tmpdir(), 'capacity-registration-cookies-'));
  try {
    const accounts = Array.from({ length: 256 }, (_, accountIndex) => ({ accountIndex,
      cookie: 'private-cookie-' + String(accountIndex).padStart(10, '0'), expiresAt: sealed.hardCloseAt }));
    const credentials = { runId: sealed.runId, manifestDigest: sealed.digest, token: 'a'.repeat(43), accounts };
    const path = join(directory, 'sessions.json');
    await assert.rejects(() => sealCapacityCredentialArtifact(path, { ...credentials, accounts: accounts.slice(1) }, sealed, anchor + 25_000));
    assert.equal((await sealCapacityCredentialArtifact(path, credentials, sealed, anchor + 25_000)).accounts, 256);
    assert.equal((await loadCapacityCredentialArtifact(path, { ...credentials, accounts: Array(256).fill(null) }, sealed, anchor + 27_000)).accounts, 256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider registration diagnostic accepts only the normal throttling receipt', async () => {
  const sealed = { ...capacityRegistrationDiagnosticSchedule(anchor), profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile };
  let code = 'ARENA_RETRY';
  let timing = 'auth;dur=12.5,authority;dur=3.0';
  const native = { sentAt: anchor, enteredAt: anchor + 1, ticketAt: anchor + 2,
    claimedAt: anchor + 3, methodFinishedAt: anchor + 4, returningAt: anchor + 5, receivedAt: anchor + 6 };
  let nativeTiming = JSON.stringify(native);
  const transport = new CapacityTransport({ ...sealed, origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials: { token: 'a'.repeat(43), accounts: [{ cookie: 'private-cookie-fixture' }] },
    bindings: new CapacityBindings(), now: () => anchor + 30_000,
    fetcher: async () => Response.json({ index: 0, accepted: false, acceptedAt: null, code }, { status: 429,
      headers: { 'X-Capacity-Timing': timing, 'X-Capacity-Native-Timing': nativeTiming,
        'Server-Timing': 'cfL4;desc="proto=TCP,rtt=100"' } }) });
  assert.deepEqual(await transport.issue({ kind: 'step', index: 0 }), { status: 429, accepted: false, acceptedAt: null,
    code: 'ARENA_RETRY', stageTiming: { workerAuthMs: 12.5, authorityMs: 3 }, nativeTiming: native });
  nativeTiming = JSON.stringify({ ...native, claimedAt: native.enteredAt - 1 });
  await assert.rejects(() => transport.issue({ kind: 'step', index: 0 }));
  nativeTiming = JSON.stringify({ ...native, receivedAt: native.sentAt + 60_001 });
  await assert.rejects(() => transport.issue({ kind: 'step', index: 0 }));
  nativeTiming = JSON.stringify(native);
  timing = 'auth;dur=60000.1,authority;dur=3.0';
  await assert.rejects(() => transport.issue({ kind: 'step', index: 0 }));
  timing = 'auth;dur=12.5,authority;dur=3.0';
  code = 'OTHER_THROTTLE';
  await assert.rejects(() => transport.issue({ kind: 'step', index: 0 }));
});

test('the private driver carries one signed Competition workflow ticket without recording it', async () => {
  const credentials = { runId: '00000000-0000-4000-8000-000000000001', manifestDigest: 'b'.repeat(64),
    token: 'a'.repeat(43), accounts: [{ cookie: 'private-cookie-fixture' }] };
  const ticket = { runId: credentials.runId, manifestDigest: credentials.manifestDigest,
    id: '00000000-0000-4000-8000-000000000002', objectKey: 'competition', generation: 1,
    operation: 'Competition.workflow', mode: 'workflow', signature: 'c'.repeat(43) };
  let calls = 0;
  const transport = new CapacityTransport({ ...manifest, origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials, bindings: new CapacityBindings(), now: () => anchor + 30_000,
    fetcher: async (url, options) => {
      calls++;
      if (url.endsWith('/arm')) return Response.json({ armed: true, manifestDigest: credentials.manifestDigest, competitionTicket: ticket });
      assert.deepEqual(JSON.parse(options.headers[CAPACITY_COMPETITION_HEADER]), ticket);
      return Response.json({ index: 0, accepted: false, acceptedAt: null, code: 'ARENA_RETRY' }, { status: 429 });
    } });
  const armed = await transport.issue({ kind: 'arm' });
  assert.equal(JSON.stringify(armed).includes(ticket.signature), false);
  assert.deepEqual(await transport.issue({ kind: 'step', index: 0 }),
    { status: 429, accepted: false, acceptedAt: null, code: 'ARENA_RETRY' });
  assert.equal(calls, 2);
});

test('the final read follows a failed or uncertain single stop without repeating it', async () => {
  await assert.rejects(() => awaitCapacityStop(null), /capacity_stop_unacknowledged/);
  for (const failed of [false, true]) {
    let calls = 0;
    const stop = (async () => {
      calls++;
      if (failed) throw new Error('lost_stop_reply');
      return { control: { stopReason: 'controller-call-allowance' } };
    })();
    await awaitCapacityStop(stop);
    assert.equal(calls, 1);
  }
});

test('sealed corpus keeps native IDs distinct from intents, legal commands and strict versions', () => {
  const ids = new Set();
  for (let intent = 0; intent < CAPACITY_CORPUS.gameIntents; intent++) {
    const fixture = capacityIntent(intent);
    assert.notEqual(fixture.queueAccounts[0], fixture.queueAccounts[1]);
    for (const account of fixture.queueAccounts) assert.equal(Math.floor(account / 2_000), fixture.eventIndex);
    for (let command = 0; command < 7; command++) {
      const value = capacityCommand(intent, command);
      assert.equal(value.command.expectedVersion, command);
      assert.equal(value.role, command % 2 === 0 ? 'white' : 'black');
      assert.ok(!ids.has(value.command.id));
      ids.add(value.command.id);
    }
  }
  const chess = new Chess();
  for (let index = 2; index < 6; index++) assert.ok(chess.move(capacityCommand(0, index).command));
  assert.equal(chess.isGameOver(), false);
  assert.equal(capacityCommand(0, 6).command.type, 'resign');
  for (const invalid of [-1, NaN, 1.2, 20_000]) assert.throws(() => capacityIntent(invalid));
  assert.throws(() => capacityStep(CAPACITY_STEP_COUNT));
});

test('fixed isolated dates and recovery preserve event windows and the 900-second stream', () => {
  assert.equal(capacityEventId(0, anchor), `arena-weekly-${Date.parse('2026-10-25T16:00:00Z')}`);
  assert.equal(capacityEventId(1, anchor), `arena-daily-${Date.parse('2026-10-25T18:00:00Z')}`);
  assert.equal(capacityEventId(2, anchor), `arena-hourly-${Date.parse('2026-10-25T18:00:00Z')}`);
  assert.equal(manifest.streamEndsAt - manifest.streamStartsAt, 900_000);
  assert.equal(capacityRecoveryReleaseAt(399, manifest.setupEndsAt), manifest.streamStartsAt - 25);
  assert.equal(capacityRecoveryReleaseAt(400, manifest.setupEndsAt), manifest.streamStartsAt);
  assert.equal(capacityRecoveryReleaseAt(999, manifest.setupEndsAt), manifest.setupEndsAt + 39_950);
  assert.throws(() => capacityEventId(0, anchor + 1));
  const weekday = Date.parse('2026-10-21T09:00:00Z');
  assert.equal(capacityEventId(0, weekday), `arena-weekly-${weekday - 110 * 60_000}`);
  assert.equal(capacityEventId(1, weekday), `arena-daily-${weekday + 10 * 60_000}`);
  assert.equal(capacityCalendarSchedule(weekday).streamEndsAt - capacityCalendarSchedule(weekday).streamStartsAt, 900_000);
  assert.equal(capacityIntent(999).eventIndex, 0);
  assert.equal(capacityIntent(1_000).eventIndex, 1);
  assert.equal(capacityIntent(1_001).eventIndex, 2);
});

test('full six-region arithmetic schedule never compresses slots or exceeds request ceiling', () => {
  const streams = Array.from({ length: 6 }, (_, index) => capacityRunnerSchedule(manifest, index));
  const terminalBins = new Uint16Array(900);
  const steps = new Set();
  let reads = 0;
  let sockets = 0;
  let prior = -Infinity;
  let latestRegular = 0;
  let firstSocketQueue = Infinity;
  let delayedBefore = 0;
  let delayedDuring = 0;
  let controls = 0;
  let socketClosures = 0;
  let preparations = 0;
  const preparedAccounts = new Set();
  let artifactActions = 0;
  let lastPreparation = 0;
  const firstQueues = new Map();
  const confirmations = [];
  for (const job of mergeCapacitySchedule(streams)) {
    assert.ok(job.at >= prior);
    assert.ok(job.at < manifest.hardCloseAt - 5_000);
    prior = job.at;
    if (['arm', 'status', 'stop'].includes(job.kind)) { controls++; continue; }
    if (job.kind === 'close-sockets') { socketClosures++; continue; }
    if (job.kind.startsWith('credential-')) { artifactActions++; continue; }
    if (job.kind === 'prepare') {
      preparations++;
      for (const index of capacityPreparationAccounts(job.index)) {
        assert.ok(!preparedAccounts.has(index));
        preparedAccounts.add(index);
      }
      lastPreparation = job.at;
      continue;
    }
    assert.ok(job.at < manifest.admissionsCloseAt);
    if (job.kind === 'standings') { reads++; continue; }
    if (job.kind === 'socket') { sockets++; continue; }
    assert.ok(!steps.has(job.index));
    steps.add(job.index);
    const step = capacityStep(job.index);
    if (step.action === 'register' && step.index >= 10_000) confirmations.push(job);
    if (step.action === 'queue') firstQueues.set(step.actor.accountIndex,
      Math.min(firstQueues.get(step.actor.accountIndex) ?? Infinity, job.at));
    if (step.phase === 'socket' && step.action === 'queue') firstSocketQueue = Math.min(firstSocketQueue, job.at);
    if (step.phase === 'regular' && step.command?.type === 'resign') {
      terminalBins[Math.floor((job.at - manifest.streamStartsAt) / 1_000)]++;
      latestRegular = Math.max(latestRegular, job.at);
    }
    if (step.action === 'observe-settlement' && step.phase === 'delayed') {
      const release = capacityRecoveryReleaseAt(step.intentIndex, manifest.setupEndsAt);
      if (release < manifest.streamStartsAt) delayedBefore++; else delayedDuring++;
    }
  }
  assert.equal(reads, 900_000);
  assert.equal(sockets, 4_000);
  assert.equal(steps.size, 280_006);
  assert.ok(terminalBins.every(count => count === 20));
  assert.equal(latestRegular, manifest.streamEndsAt - 50);
  assert.ok(firstSocketQueue > manifest.streamEndsAt);
  assert.equal(delayedBefore, 400);
  assert.equal(delayedDuring, 600);
  assert.equal(controls, 14);
  assert.equal(socketClosures, 6);
  assert.equal(artifactActions, 8);
  assert.equal(preparations, Math.ceil(CAPACITY_CORPUS.accounts / CAPACITY_PREPARATION_BATCH_SIZE));
  assert.equal(preparedAccounts.size, 6_000);
  assert.ok(lastPreparation < manifest.earliestArmAt + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs);
  assert.equal(confirmations.length, CAPACITY_CORPUS.accounts);
  assert.equal(new Set(confirmations.map(job => capacityStep(job.index).actor.accountIndex)).size, CAPACITY_CORPUS.accounts);
  assert.ok(confirmations.every(job => !job.expectedDenials));
  assert.ok(confirmations.every(job => job.at + CAPACITY_DRIVER_LIMITS.fetchTimeoutMs
    < firstQueues.get(capacityStep(job.index).actor.accountIndex)));
  assert.ok(confirmations.at(-1).at + CAPACITY_DRIVER_LIMITS.fetchTimeoutMs < manifest.setupEndsAt);
  const minimumSpacing = 1_000 / ARENA_POLICY.registrationRate;
  for (let index = 1; index < confirmations.length; index++) {
    assert.ok(confirmations[index].at - confirmations[index - 1].at > minimumSpacing);
  }
  // Six metadata preflights precede these fixed schedules.
  assert.equal(reads + sockets + steps.size + preparations + controls + 6, 1_184_214);
  assert.ok(reads + sockets + steps.size + preparations + controls + 6 < CAPACITY_CORPUS.maximumWorkerRequests);
});

test('initial status waits for the validated arm reply and never shifts the first fixture', async () => {
  for (const outcome of ['delayed', 'slow', 'invalid', 'failed']) {
    const clock = clockFixture();
    const start = clock.now();
    const prefix = [];
    for (const job of capacityRunnerSchedule(manifest, 0, 'single-egress')) {
      prefix.push({ ...job, at: start + job.at - manifest.earliestArmAt,
        ...(job.replyDeadlineAt === undefined ? {} : {
          replyDeadlineAt: start + job.replyDeadlineAt - manifest.earliestArmAt,
        }) });
      if (job.kind === 'prepare') break;
    }
    assert.deepEqual(prefix.map(job => job.kind), ['arm', 'status', 'prepare']);
    const preparation = prefix.at(-1);
    assert.equal(prefix[1].at, start + 1_000);
    assert.equal(preparation.at, start + 8_000);
    const pending = [], events = [];
    let statusReady = false;
    const wait = clock.wait;
    clock.wait = async ms => {
      await wait(ms);
      for (const response of pending) {
        if (!response.done && clock.now() >= response.at) {
          response.done = true;
          events.push({ type: 'reply', kind: response.kind, at: clock.now() });
          if (response.kind === 'arm' && outcome === 'failed') response.reject(new Error('lost_arm_reply'));
          else response.resolve({ accepted: true, control: { armed: true, stopReason: null,
            manifestDigest: response.kind === 'arm' && outcome === 'invalid' ? 'wrong-digest' : 'fixed-digest' } });
        }
      }
      await new Promise(resolve => setImmediate(resolve));
    };
    const issue = sequenceCapacityInitialControls(async job => {
      events.push({ type: 'request', kind: job.kind, at: clock.now() });
      if (job.kind === 'prepare') return { accepted: true };
      return new Promise((resolve, reject) => pending.push({ kind: job.kind, resolve, reject, done: false,
        at: clock.now() + (job.kind === 'arm' && outcome !== 'slow' ? 1_834 : CAPACITY_DRIVER_LIMITS.fetchTimeoutMs) }));
    }, 'fixed-digest');
    const result = await runCapacitySchedule(prefix, {
      clock, record: async () => {},
      ready: job => job.kind !== 'prepare' || statusReady,
      issue: async job => {
        const result = await issue(job);
        if (job.kind === 'status') statusReady = true;
        return result;
      },
      issueCloseAt: preparation.replyDeadlineAt + 1,
      hardCloseAt: preparation.replyDeadlineAt + 1 + CAPACITY_DRIVER_LIMITS.fetchTimeoutMs,
      stopOnFailure: true,
    });
    const requests = kind => events.filter(event => event.type === 'request' && event.kind === kind);
    assert.equal(requests('arm').length, 1);
    assert.equal(requests('status').length, ['delayed', 'slow'].includes(outcome) ? 1 : 0);
    assert.equal(requests('prepare').length, outcome === 'delayed' ? 1 : 0);
    assert.equal(result.passed, outcome === 'delayed');
    if (requests('status').length) {
      assert.ok(requests('status')[0].at >= events.find(event => event.type === 'reply' && event.kind === 'arm').at);
    }
    if (outcome === 'delayed') assert.equal(requests('prepare')[0].at, preparation.at);
    if (outcome === 'slow') assert.equal(result.dependencies, 1);
    if (['invalid', 'failed'].includes(outcome)) assert.equal(result.uncertain, 2);
  }
});

test('one actual egress runs every fixed work shard and leaves other regions unqualified', () => {
  const totals = { step: 0, standings: 0, socket: 0, prepare: 0, controls: 0, artifact: 0 };
  const steps = new Set();
  let previous = -Infinity;
  const endingControls = [];
  for (const job of capacityRunnerSchedule(manifest, 0, 'single-egress')) {
    assert.ok(job.at >= previous);
    previous = job.at;
    if (job.at >= manifest.admissionsCloseAt) endingControls.push(job);
    if (job.kind === 'step') {
      assert.equal(steps.has(job.index), false);
      steps.add(job.index);
      totals.step++;
    } else if (job.kind in totals) totals[job.kind]++;
    else if (['arm', 'status', 'stop'].includes(job.kind)) totals.controls++;
    else if (job.kind.startsWith('credential-')) {
      assert.notEqual(job.kind, 'credential-transfer');
      totals.artifact++;
    }
  }
  assert.deepEqual(totals, { step: 280_006, standings: 900_000, socket: 4_000, prepare: 188, controls: 4, artifact: 2 });
  assert.equal(totals.step + totals.standings + totals.socket + totals.prepare + totals.controls + 1, 1_184_199);
  assert.deepEqual(endingControls.map(job => [job.kind, job.finalAudit ?? false, job.at]), [
    ['close-sockets', false, manifest.admissionsCloseAt],
    ['stop', false, manifest.admissionsCloseAt],
    ['status', true, manifest.admissionsCloseAt],
  ]);
  assert.deepEqual(capacityEgressRegions('single-egress'), ['us-west']);
  assert.deepEqual(CAPACITY_REGIONS.filter(region => !capacityEgressRegions('single-egress').includes(region)),
    ['us-east', 'europe', 'asia-pacific', 'australia', 'south-america']);
  assert.throws(() => [...capacityRunnerSchedule(manifest, 1, 'single-egress')]);
});

test('six runner cost ceilings must fit the single approved incremental allowance', () => {
  const digests = { driverDigest: 'b'.repeat(64), corpusDigest: 'c'.repeat(64) };
  const candidate = { schema: 'ejm-chess-capacity-driver-candidate-v1', ...digests,
    incrementalMaximumCents: 2_500, ledgerDigest: 'd'.repeat(64),
    manifest: { ...manifest, runId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64),
      host: 'chess-capacity-test.ejmlabs.com', verified: { ownerApprovedFrozenRun: true } },
    runners: CAPACITY_REGIONS.map(region => ({ region, runnerId: region, transportPath: 'private-reviewed-path',
      evidenceReference: 'local-fixture-only', maximumCostCents: 400 })) };
  assert.equal(validateCapacityCandidate(candidate, digests), candidate);
  assert.throws(() => validateCapacityCandidate({ ...candidate,
    runners: candidate.runners.map(runner => ({ ...runner, maximumCostCents: 500 })) }, digests));
  const single = { ...candidate, egressMode: 'single-egress', runners: [candidate.runners[0]] };
  assert.equal(validateCapacityCandidate(single, digests), single);
  assert.throws(() => validateCapacityCandidate({ ...single, egressMode: 'six-regions' }, digests));
  assert.throws(() => validateCapacityCandidate({ ...single, egressMode: 'unknown' }, digests));
  assert.throws(() => validateCapacityCandidate({ ...single, runners: [candidate.runners[1]] }, digests));
});

test('preflight pins compiled metadata', () => {
  const sealed = { ...manifest, digest: 'a'.repeat(64) };
  const reply = { accepted: true, control: { ready: true, armed: null, blockers: [],
    manifestDigest: sealed.digest, schedule: manifest } };
  assert.equal(validateCapacityPreflight(reply, sealed).armed, null);
  assert.throws(() => validateCapacityPreflight({ ...reply, control: { ...reply.control, armed: false } }, sealed));
  assert.throws(() => validateCapacityPreflight({ ...reply, control: { ...reply.control,
    schedule: { ...manifest, streamStartsAt: manifest.streamStartsAt + 1 } } }, sealed));
});

test('final audit requires the complete native shutdown receipt while retaining lifetime permits', async () => {
  const sealed = { ...manifest, digest: 'a'.repeat(64) };
  const now = manifest.admissionsCloseAt + 1_000;
  const nativeShutdown = { at: manifest.admissionsCloseAt, games: 20_000, socketWorkflows: 1_000,
    pendingNative: 0, gameOutboxes: 0, competitionOutboxes: 0, projectionBuilds: 0,
    unfinishedGames: 0, sockets: 0, alarms: 0, completedWorkflows: 20_001,
    confirmedRetirements: 19_000, retainedLifetimePermits: 1_002 };
  const control = { armed: true, manifestDigest: sealed.digest, stopReason: 'owner-stop',
    charges: 20_000, activeObjects: 1_002, unresolvedDispatches: 0, physicalBytes: 123_456,
    reserved: { doRequests: 50 }, observed: { doRequests: 45 }, nativeShutdown };
  const audit = value => capacityFinalAudit(value, sealed, now);
  const held = audit(control);
  assert.equal(held.heldObjects, 1_002);
  assert.equal(held.nativeClosurePassed, true);
  assert.deepEqual(held.nativeShutdown, nativeShutdown);
  assert.deepEqual(held.reserved, { doRequests: 50 });
  for (const change of [
    { nativeShutdown: null }, { activeObjects: 0 }, { activeObjects: 1_001 }, { unresolvedDispatches: 1 },
    { charges: 19_999 }, { stopReason: null }, { manifestDigest: 'b'.repeat(64) },
  ]) assert.equal(audit({ ...control, ...change }).nativeClosurePassed, false);
  for (const key of Object.keys(nativeShutdown)) {
    const incomplete = { ...nativeShutdown };
    delete incomplete[key];
    assert.equal(audit({ ...control, nativeShutdown: incomplete }).nativeClosurePassed, false, key);
    assert.equal(audit({ ...control, nativeShutdown: { ...nativeShutdown, [key]: 0.5 } }).nativeClosurePassed, false, key);
  }
  for (const key of ['pendingNative', 'gameOutboxes', 'competitionOutboxes', 'projectionBuilds', 'unfinishedGames', 'sockets', 'alarms']) {
    assert.equal(audit({ ...control, nativeShutdown: { ...nativeShutdown, [key]: 1 } }).nativeClosurePassed, false, key);
  }
  for (const [key, value] of [
    ['games', 19_999], ['socketWorkflows', 999], ['completedWorkflows', 20_000],
    ['confirmedRetirements', 18_999], ['retainedLifetimePermits', 0],
    ['at', manifest.admissionsCloseAt - 1], ['at', manifest.hardCloseAt], ['at', now + 1],
  ]) assert.equal(audit({ ...control, nativeShutdown: { ...nativeShutdown, [key]: value } }).nativeClosurePassed, false, key);
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials: { token: 'private-token-fixture', manifestDigest: sealed.digest, accounts: [] },
    bindings: new CapacityBindings(), issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt,
    now: () => now, fetcher: async () => Response.json({ ...control,
      secret: 'private-response-fixture', nativeShutdown: { ...nativeShutdown, secret: 'private-receipt-fixture' } }),
  });
  const readback = (await transport.issue({ kind: 'status' })).control;
  assert.deepEqual(readback.nativeShutdown, nativeShutdown);
  assert.equal(audit(readback).nativeClosurePassed, true);
  assert.equal(JSON.stringify(readback).includes('private-'), false);
});

test('authority seat binding cannot be replaced, reused or guessed from queue order', () => {
  const bindings = new CapacityBindings();
  const intent = 1_000;
  const fixture = capacityIntent(intent);
  const binding = { intentIndex: intent, gameId: 'native-game-uuid-one', eventIndex: fixture.eventIndex,
    whiteAccountIndex: fixture.queueAccounts[1], blackAccountIndex: fixture.queueAccounts[0] };
  const step = capacityStep(capacityIntentStepIndex(intent, 4));
  assert.equal(bindings.actor(step), null);
  bindings.bind(binding);
  bindings.bind(binding);
  assert.equal(bindings.actor(step), fixture.queueAccounts[1]);
  assert.throws(() => bindings.bind({ ...binding, gameId: 'native-game-uuid-two' }));
  assert.throws(() => bindings.bind({ ...binding, intentIndex: intent + 2 }));
  assert.equal(bindings.ready(capacityStep(capacityIntentStepIndex(intent, 5))), false);
});

test('binding observations wait for both queue acknowledgements and the second fixed poll is final', () => {
  const bindings = new CapacityBindings();
  const steps = Array.from({ length: 5 }, (_, within) => capacityStep(capacityIntentStepIndex(0, within)));
  assert.equal(bindings.ready(steps[2]), false);
  bindings.accept(steps[0], { accepted: true });
  assert.equal(bindings.ready(steps[2]), false);
  bindings.accept(steps[1], { accepted: true });
  assert.equal(bindings.ready(steps[2]), true);
  assert.equal(bindings.ready(steps[3]), false);
  bindings.accept(steps[2], { accepted: true });
  assert.equal(bindings.ready(steps[3]), true);
  assert.throws(() => bindings.accept(steps[3], { accepted: true }));
  assert.equal(bindings.ready(steps[4]), false);
  const fixture = capacityIntent(0);
  const binding = { intentIndex: 0, gameId: 'native-game-uuid-bound', eventIndex: 0,
    whiteAccountIndex: fixture.queueAccounts[1], blackAccountIndex: fixture.queueAccounts[0] };
  const complete = new CapacityBindings();
  complete.accept(steps[0], { accepted: true }); complete.accept(steps[1], { accepted: true });
  complete.accept(steps[2], { accepted: true });
  assert.throws(() => complete.accept(steps[3], { accepted: true, binding }));
  complete.accept(steps[3], { accepted: true, binding, bindingProof: 'private-fixture-proof' });
  assert.equal(complete.ready(steps[4]), true);
});

test('fixed transport selectors keep spectator reads free of cookies', () => {
  const credentials = { token: 'not-a-real-token', accounts: [{ cookie: 'test=not-secret' }] };
  const request = capacityRequest({ kind: 'standings', pageIndex: 188 }, credentials, new CapacityBindings());
  assert.equal(request.path, '/capacity/standings/188');
  assert.equal(Object.hasOwn(request.init.headers, 'Cookie'), false);
  assert.throws(() => capacityRequest({ kind: 'standings', pageIndex: 189 }, credentials, new CapacityBindings()));
  const step = capacityRequest({ kind: 'step', index: 0 }, credentials, new CapacityBindings());
  assert.equal(step.init.body, '{}');
  assert.equal(step.init.headers.Cookie, 'test=not-secret');
});

test('spectator replies require the exact page, fresh cache evidence and native D1 allowance', async () => {
  const now = manifest.streamStartsAt;
  const page = { id: capacityEventId(0, anchor), format: 'arena-v1', generation: 3,
    generatedAt: now, watermark: 1, provisional: false, standings: [], nextCursor: '3:1' };
  const headers = { 'Cache-Control': 'public, max-age=10, s-maxage=10', Age: '0',
    'X-Capacity-Cache': 'MISS', 'X-Capacity-D1-Rows-Read': '4', 'X-Capacity-D1-Retry-Read-Surcharge': '0' };
  const read = (value = page, evidence = headers) => new CapacityTransport({
    origin: 'https://chess-capacity-test.ejmlabs.com', credentials: { token: 'fixture', accounts: [] },
    bindings: new CapacityBindings(), earliestArmAt: anchor, issueCloseAt: manifest.issueCloseAt,
    hardCloseAt: manifest.hardCloseAt, now: () => now, fetcher: async () => Response.json(value, { headers: evidence }),
  }).issue({ kind: 'standings', pageIndex: 0 });
  assert.deepEqual((await read()).cache, { age: 0, status: 'MISS', d1RowsRead: 4, d1RetryReadSurcharge: 0 });
  assert.deepEqual((await read(page, { ...headers, 'X-Capacity-D1-Retry-Read-Surcharge': '16' })).cache,
    { age: 0, status: 'MISS', d1RowsRead: 4, d1RetryReadSurcharge: 16 });
  assert.deepEqual((await read(page, { ...headers, Age: '9', 'X-Capacity-Cache': 'HIT',
    'X-Capacity-D1-Rows-Read': '0' })).cache, { age: 9, status: 'HIT', d1RowsRead: 0, d1RetryReadSurcharge: 0 });
  for (const evidence of [
    { ...headers, Age: '10' }, { ...headers, 'X-Capacity-D1-Rows-Read': '9' },
    { ...headers, 'X-Capacity-Cache': 'HIT' }, { ...headers, 'X-Capacity-Cache': '' },
    { ...headers, 'X-Capacity-D1-Rows-Read': '' }, { ...headers, 'Cache-Control': 'no-store' },
    { ...headers, 'X-Capacity-D1-Retry-Read-Surcharge': '' },
    { ...headers, 'X-Capacity-D1-Retry-Read-Surcharge': '1' },
    { ...headers, 'X-Capacity-D1-Retry-Read-Surcharge': '24' },
    { ...headers, 'X-Capacity-Cache': 'HIT', 'X-Capacity-D1-Rows-Read': '0', 'X-Capacity-D1-Retry-Read-Surcharge': '8' },
  ]) await assert.rejects(() => read(page, evidence));
  await assert.rejects(() => read({ ...page, id: capacityEventId(1, anchor) }));
  await assert.rejects(() => read({ ...page, nextCursor: '3:2' }));
});

test('opaque routing proofs stay stable, reach only direct Game requests and never enter trace replies', async () => {
  const bindings = new CapacityBindings();
  const proof = 'private-opaque-routing-fixture-only';
  const fixture = capacityIntent(0);
  const binding = { intentIndex: 0, gameId: 'native-game-proof-fixture', eventIndex: fixture.eventIndex,
    whiteAccountIndex: fixture.queueAccounts[0], blackAccountIndex: fixture.queueAccounts[1] };
  for (let within = 0; within < 2; within++) bindings.accept(capacityStep(capacityIntentStepIndex(0, within)), { accepted: true });
  const credentials = { token: 'a'.repeat(43), accounts: Array.from({ length: 6_000 }, () => ({ cookie: 'fixture=not-secret' })) };
  const index = capacityIntentStepIndex(0, 2);
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com', credentials, bindings,
    issueCloseAt: 2_000, hardCloseAt: 3_000, now: () => 1_000,
    fetcher: async (_url, init) => {
      assert.equal(Object.hasOwn(init.headers, CAPACITY_BINDING_HEADER), false);
      return Response.json({ index, accepted: true, acceptedAt: 1_000, binding: { ...binding, accidentalProof: proof }, bindingProof: proof,
        result: { settled: false, deliveryPending: true, terminalVersion: 0, accidentalProof: proof } });
    } });
  const reply = await transport.issue({ kind: 'step', index });
  assert.equal(JSON.stringify(reply).includes(proof), false);
  for (const within of [4, 11, 12]) {
    const request = capacityRequest({ kind: 'step', index: capacityIntentStepIndex(0, within) }, credentials, bindings);
    assert.equal(request.init.headers[CAPACITY_BINDING_HEADER], proof);
  }
  assert.equal(capacityRequest({ kind: 'step', index: 276_000 }, credentials, bindings).init.headers[CAPACITY_BINDING_HEADER], proof);
  assert.throws(() => bindings.bind(binding, 'different-private-proof'));
  assert.throws(() => bindings.bind(binding, 'invalid\nproof'));
  const socketIntent = capacityIntent(19_000);
  bindings.bind({ intentIndex: 19_000, gameId: 'native-socket-proof-fixture', eventIndex: socketIntent.eventIndex,
    whiteAccountIndex: socketIntent.queueAccounts[0], blackAccountIndex: socketIntent.queueAccounts[1] }, proof);
  assert.equal(capacityRequest({ kind: 'socket', index: 0 }, credentials, bindings).init.headers[CAPACITY_BINDING_HEADER], proof);
});

test('401 or unexpected 429 cannot pass; only declared registration throttles are expected', async () => {
  for (const status of [401, 429]) {
    const result = await runCapacitySchedule([{ kind: 'step', index: 0, at: 1_000 }], {
      clock: clockFixture(), issue: async () => ({ accepted: false, status }), record: async () => {},
      issueCloseAt: 2_000, hardCloseAt: 3_000,
    });
    assert.equal(result.passed, false);
    assert.equal(result.unexpectedDenials, 1);
  }
  const clock = clockFixture();
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials: { token: 'private-token-fixture', manifestDigest: 'a'.repeat(64),
      accounts: [{ cookie: 'fixture=session', expiresAt: 4_000 }] },
    bindings: new CapacityBindings(), issueCloseAt: 2_000, hardCloseAt: 3_000,
    now: clock.now, fetcher: async () => Response.json({ index: 0, accepted: false,
      acceptedAt: null, httpStatus: 429, code: 'ARENA_RETRY' }, { status: 429 }),
  });
  const result = await runCapacitySchedule([{ kind: 'step', index: 0, at: 1_000, expectedDenials: [429] }], {
    clock, issue: job => transport.issue(job), record: async () => {},
    issueCloseAt: 2_000, hardCloseAt: 3_000,
  });
  assert.equal(result.passed, true);
  assert.equal(result.denied, 1);
});

test('HTTP200 rejections retain only known codes and still fail the workload', async () => {
  for (const code of ['capacity_step_already_issued', 'private_account_fixture_secret']) {
    const clock = clockFixture(), records = [];
    const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
      credentials: { token: 'private-token-fixture', manifestDigest: 'a'.repeat(64),
        accounts: [{ cookie: 'fixture=session', expiresAt: 4_000 }] },
      bindings: new CapacityBindings(), issueCloseAt: 2_000, hardCloseAt: 3_000,
      now: clock.now, fetcher: async () => Response.json({ index: 0, accepted: false, acceptedAt: null, code }),
    });
    const result = await runCapacitySchedule([{ kind: 'step', index: 0, at: 1_000 }], {
      clock, issue: job => transport.issue(job), record: async value => { records.push(value); },
      issueCloseAt: 2_000, hardCloseAt: 3_000,
    });
    assert.equal(result.passed, false);
    assert.equal(result.unexpectedDenials, 1);
    const reply = records.find(row => row.type === 'acknowledged');
    assert.equal(reply.status, 200);
    assert.equal(reply.accepted, false);
    assert.equal(reply.code, code === 'capacity_step_already_issued' ? code : undefined);
    if (code !== 'capacity_step_already_issued') assert.equal(JSON.stringify(records).includes(code), false);
  }
});

test('denied and uncertain HTTP replies release unread bodies without retrying', async () => {
  for (const [status, header, privateCode] of [
    [429, null, null],
    [503, 'capacity_workflow_unresolved', 'capacity_workflow_unresolved'],
    [503, 'NEW_GAMES_PAUSED', 'NEW_GAMES_PAUSED'],
    [503, 'capacity_private_fixture_secret', null],
    [503, 'capacity_workflow_unresolved:private-fixture-id', null],
  ]) {
    let cancelled = false, calls = 0;
    const records = [];
    const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
      credentials: { token: 'private-token-fixture', manifestDigest: 'a'.repeat(64),
        accounts: [{ cookie: 'fixture=session', expiresAt: 4_000 }] },
      bindings: new CapacityBindings(), issueCloseAt: 2_000, hardCloseAt: 3_000,
      record: async value => { records.push(value); },
      now: () => 1_000, fetcher: async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
          { status, headers: header ? { 'X-Capacity-Failure': header } : {} });
      },
    });
    const index = capacityIntentStepIndex(0, 0);
    const reply = transport.issue({ kind: 'step', index, at: 1_000 });
    if (status === 429) {
      assert.deepEqual(await reply, { status, accepted: false, acceptedAt: null });
      assert.deepEqual(records, []);
    } else {
      await assert.rejects(reply, /capacity_request_uncertain/);
      assert.deepEqual(records, [{ type: 'request-failure', kind: 'step', index, at: 1_000,
        code: 'capacity_provider_uncertain', httpStatus: status, privateCode }]);
      if (privateCode === null) assert.equal(JSON.stringify(records).includes(header), false);
    }
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  }
});

const failureUsage = { doRowsRead: 3, doRowsWritten: 1, doStorageBytes: 4096, d1RowsRead: 5, d1RowsWritten: 0,
  d1StorageBytes: 8192, d1Statements: 2, d1Retries: 0, d1RetryReadSurcharge: 0, unresolvedD1: 0, uncertain: true };
const failureReceipt = (index, stage = 'native-follow-on') => {
  const { message } = capacityNativeFailure(new Error('capacity_native_follow_on_unresolved',
    { cause: new Error('SQLITE_BUSY: private-fixture-secret') }),
  { kind: 'Competition', stage, index, readBound: 128, usage: failureUsage, envelope: null });
  return message.slice(message.indexOf('{'));
};
const failureTransport = (fetcher, records) => new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
  credentials: { token: 'private-token-fixture', manifestDigest: 'a'.repeat(64),
    accounts: [{ cookie: 'fixture=session', expiresAt: 4_000 }] },
  bindings: new CapacityBindings(), issueCloseAt: 2_000, hardCloseAt: 3_000, now: () => 1_000,
  record: async value => { records.push(value); }, fetcher });
const failureReply = (status, code, receipt) => async () => new Response(null, { status, headers: {
  ...(code ? { 'X-Capacity-Failure': code } : {}), ...(receipt ? { 'X-Capacity-Audit': receipt } : {}) } });

test('a failed 503 keeps only its own validated receipt, and every reply stays a failure', async () => {
  const index = capacityIntentStepIndex(0, 0), code = 'capacity_native_follow_on_unresolved', good = failureReceipt(index);
  const secret = 'private-fixture-secret';
  const tampered = change => JSON.stringify({ ...JSON.parse(good), ...change });
  const cases = [
    ['matching receipt', 503, code, good, true],
    ['status is not 503', 500, code, good, false],
    ['code differs from the failure header', 503, 'capacity_native_method_missing', good, false],
    ['another step', 503, code, failureReceipt(index + 1), false],
    ['unknown stage', 503, code, tampered({ stage: secret }), false],
    ['unknown code', 503, code, tampered({ code: 'capacity_private_fixture_secret' }), false],
    ['unknown field', 503, code, tampered({ extra: secret }), false],
    ['negative count', 503, code, tampered({ readBound: -1 }), false],
    // Headers trim outer spaces. Inner padding keeps the receipt valid JSON but too large.
    ['oversized', 503, code, good.replace('"version"', '"version"' + ' '.repeat(4_096)), false],
    ['malformed', 503, code, good.slice(0, -1), false],
    ['no failure header', 503, null, good, false],
  ];
  for (const [name, status, header, receipt, kept] of cases) {
    const records = [], transport = failureTransport(failureReply(status, header, receipt), records);
    await assert.rejects(transport.issue({ kind: 'step', index, at: 1_000 }), /capacity_request_uncertain/, name);
    assert.deepEqual(records, [{ type: 'request-failure', kind: 'step', index, at: 1_000, code: 'capacity_provider_uncertain',
      httpStatus: status, privateCode: header, ...(kept ? { nativeFailure: JSON.parse(good) } : {}) }], name);
    assert.equal(transport.counts.failureReceipts, kept ? 1 : 0, name);
    assert.equal(JSON.stringify(records).includes(secret), false, name);
  }
  const records = [], lost = failureTransport(async () => { throw new DOMException(secret, 'TimeoutError'); }, records);
  await assert.rejects(lost.issue({ kind: 'step', index, at: 1_000 }), /capacity_request_uncertain/);
  assert.deepEqual(records, [{ type: 'request-failure', kind: 'step', index, at: 1_000, code: 'TimeoutError',
    httpStatus: null, privateCode: null }]);
});

test('a shutdown receipt has no step, and only the first bounded receipts are kept', async () => {
  const code = 'capacity_native_follow_on_unresolved', records = [];
  const stop = failureTransport(failureReply(503, code, failureReceipt(null)), records);
  await assert.rejects(stop.issue({ kind: 'stop' }), /capacity_request_uncertain/);
  assert.deepEqual(records[0].nativeFailure, JSON.parse(failureReceipt(null)));
  records.length = 0;
  const mismatched = failureTransport(failureReply(503, code, failureReceipt(7)), records);
  await assert.rejects(mismatched.issue({ kind: 'stop' }), /capacity_request_uncertain/);
  assert.equal('nativeFailure' in records[0], false);
  records.length = 0;
  const bounded = failureTransport(failureReply(503, code, failureReceipt(null)), records);
  for (let attempt = 0; attempt <= CAPACITY_DRIVER_LIMITS.maximumFailureReceipts; attempt++) {
    await assert.rejects(bounded.issue({ kind: 'status' }), /capacity_request_uncertain/);
  }
  assert.equal(records.filter(row => row.nativeFailure).length, CAPACITY_DRIVER_LIMITS.maximumFailureReceipts);
  assert.equal(records.length, CAPACITY_DRIVER_LIMITS.maximumFailureReceipts + 1);
  assert.equal(records.at(-1).privateCode, code);
  assert.equal('nativeFailure' in records.at(-1), false);
  assert.equal(bounded.counts.failureReceipts, CAPACITY_DRIVER_LIMITS.maximumFailureReceipts);
});

test('trace stalls and saturation fail without replaying or bunching missed traffic', async () => {
  const clock = clockFixture();
  let calls = 0;
  const stalled = await runCapacitySchedule([0, 1, 2].map(index => ({ kind: 'step', index, at: 1_000 + index })), {
    clock, issue: async () => { calls++; return { accepted: true }; },
    record: async value => { if (value.type === 'dispatch-intent') clock.advance(100); },
    issueCloseAt: 2_000, hardCloseAt: 3_000,
  });
  assert.equal(stalled.passed, false);
  assert.equal(stalled.missed, 3);
  assert.equal(calls, 0);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const saturated = await runCapacitySchedule([0, 1].map(index => ({ kind: 'step', index, at: 1_000 })), {
    clock: clockFixture(), issue: () => pending, record: async () => {}, concurrency: 1,
    issueCloseAt: 2_000, hardCloseAt: 3_000,
  });
  assert.equal(saturated.passed, false);
  assert.equal(saturated.saturated, 1);
  assert.equal(saturated.pendingAtClose, 1);
  release({ accepted: true });
});

test('full registration burst keeps every fixed offer when replies take the five-second limit', async () => {
  const clock = clockFixture();
  const wait = clock.wait;
  const pending = [];
  clock.wait = async ms => {
    await wait(ms);
    while (pending[0]?.at <= clock.now()) pending.shift().resolve({ accepted: true });
  };
  const offers = [];
  const schedule = Array.from({ length: CAPACITY_CORPUS.registrationBurst }, (_, index) => ({
    kind: 'step', index, at: 1_000 + index * 3,
  }));
  const result = await runCapacitySchedule(schedule, {
    clock, issue: job => {
      offers.push({ index: job.index, at: clock.now() });
      return new Promise(resolve => pending.push({ at: clock.now() + CAPACITY_DRIVER_LIMITS.fetchTimeoutMs, resolve }));
    }, record: async () => {}, issueCloseAt: 40_000, hardCloseAt: 45_000,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(offers, schedule.map(job => ({ index: job.index, at: job.at })));
  assert.equal(result.acknowledged, CAPACITY_CORPUS.registrationBurst);
  assert.equal(result.saturated, 0);
  assert.equal(result.pendingAtClose, 0);
  assert.ok(result.maximumInflight > CAPACITY_DRIVER_LIMITS.registrationDiagnosticConcurrentFetches);
  assert.ok(result.maximumInflight <= Math.ceil(CAPACITY_DRIVER_LIMITS.fetchTimeoutMs / 3) + 1);
});

test('preparation timer slips keep 50/s, a two-offer burst and the aggregate deadline without relaxing other slots', async () => {
  const clock = clockFixture();
  clock.advance(37);
  const offers = [];
  const preparation = await runCapacitySchedule([0, 1, 2].map(index => ({ kind: 'prepare', index,
    at: 1_000 + index * 20, replyDeadlineAt: 2_000 })), {
    clock, issue: async job => { offers.push({ index: job.index, at: clock.now() }); return { accepted: true }; },
    record: async () => {}, issueCloseAt: 3_000, hardCloseAt: 4_000,
  });
  assert.equal(preparation.passed, true);
  assert.deepEqual(offers, [{ index: 0, at: 1_037 }, { index: 1, at: 1_037 }, { index: 2, at: 1_057 }]);
  const fixedClock = clockFixture();
  fixedClock.advance(37);
  const fixed = await runCapacitySchedule([{ kind: 'step', index: 0, at: 1_000 }], {
    clock: fixedClock, issue: async () => { throw new Error('must_not_offer_missed_slot'); },
    record: async () => {}, issueCloseAt: 3_000, hardCloseAt: 4_000,
  });
  assert.equal(fixed.passed, false);
  assert.equal(fixed.missed, 1);
});

test('preparation pacing does not accumulate timer overhead across all 6,000 identities', async () => {
  const clock = clockFixture();
  const wait = clock.wait;
  clock.wait = async ms => { await wait(ms); clock.advance(2); };
  let count = 0, previousAt = null, sameTime = 0, maximumBurst = 0;
  const result = await runCapacitySchedule(Array.from({ length: 6_000 }, (_, index) => ({
    kind: 'prepare', index, at: 1_000 + index * 20, replyDeadlineAt: 127_000,
  })), { clock, issue: async job => {
    assert.equal(job.index, count++);
    sameTime = previousAt === clock.now() ? sameTime + 1 : 1;
    maximumBurst = Math.max(maximumBurst, sameTime);
    previousAt = clock.now();
    return { accepted: true };
  }, record: async () => {}, issueCloseAt: 200_000, hardCloseAt: 210_000 });
  assert.equal(result.passed, true);
  assert.equal(count, 6_000);
  assert.ok(maximumBurst <= CAPACITY_DRIVER_TIMING.fixturePrepareBurst);
  assert.ok(previousAt <= 127_000);
});

test('lost calls retain the original intent and stop a local run without exposing exception text', async () => {
  const bindings = new CapacityBindings();
  const records = [];
  const record = async value => { records.push(value); };
  let calls = 0;
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials: { token: 'test-token', accounts: [{ cookie: 'test=not-secret' }] }, bindings,
    issueCloseAt: 2_000, hardCloseAt: 3_000, now: () => 1_000,
    record, fetcher: async () => { calls++; throw new Error('provider lost reply; private fixture=test-secret'); },
  });
  const job = { kind: 'step', index: capacityIntentStepIndex(0, 0), at: 1_000 };
  const clock = clockFixture();
  const wait = clock.wait;
  clock.wait = async ms => { await wait(ms); await new Promise(resolve => setImmediate(resolve)); };
  const result = await runCapacitySchedule([job, { ...job, index: 1, at: 1_100 }], {
    clock, issue: item => transport.issue(item), record,
    issueCloseAt: 2_000, hardCloseAt: 3_000, stopOnFailure: true });
  assert.equal(result.uncertain, 1);
  assert.equal(result.passed, false);
  assert.equal(calls, 1);
  assert.equal(bindings.counts.uncertainIntents, 1);
  assert.equal(records.find(value => value.type === 'request-failure').code, 'unknown-error');
  assert.equal(JSON.stringify(records).includes('test-secret'), false);
});

test('a lost burst reply resolves only through its fixed same-account native confirmation', async () => {
  for (const failureName of ['TimeoutError', 'TypeError', 'AbortError']) {
  const recovery = new CapacityRegistrationRecovery(manifest);
  const records = [];
  const credentials = { token: 'test-token', accounts: Array.from({ length: CAPACITY_CORPUS.accounts },
    () => ({ cookie: 'private-cookie-fixture' })) };
  let nativeEvent = { eventIndex: 0, eventId: capacityEventId(0, anchor) };
  const transport = new CapacityTransport({ ...manifest, origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials, bindings: new CapacityBindings(), now: () => anchor + 200_000,
    record: async row => { records.push(row); }, fetcher: async url => {
      const index = Number(url.split('/').at(-1));
      if (index < CAPACITY_CORPUS.registrationBurst) throw failureName === 'TypeError'
        ? new TypeError('private network detail') : new DOMException('private network detail', failureName);
      return Response.json({ index, accepted: true, acceptedAt: anchor + 200_000, event: nativeEvent });
    } });
  const lost = { kind: 'step', index: 118 };
  let error;
  try { await transport.issue(lost); } catch (caught) { error = caught; }
  assert.equal(recovery.defer(lost, error), true);
  assert.equal(records[0].code, failureName);
  assert.equal(records[0].httpStatus, null);
  assert.equal(JSON.stringify(records).includes('private network detail'), false);
  recovery.acknowledge({ kind: 'step', index: 10_119 }, { accepted: true, registration: nativeEvent });
  assert.equal(recovery.counts.resolvedUncertainReplies, 0);
  const confirm = { kind: 'step', index: 10_118 };
  nativeEvent = { eventIndex: 0, eventId: capacityEventId(1, anchor) };
  await assert.rejects(() => transport.issue(confirm), /capacity_request_uncertain/);
  recovery.acknowledge(confirm, { accepted: true, registration: nativeEvent });
  assert.equal(recovery.counts.resolvedUncertainReplies, 0);
  nativeEvent = { eventIndex: 0, eventId: capacityEventId(0, anchor) };
  recovery.acknowledge(confirm, await transport.issue(confirm));
  assert.deepEqual(recovery.counts, { uncertainBurstReplies: 1,
    timedOutBurstReplies: failureName === 'TimeoutError' ? 1 : 0,
    transportErrorBurstReplies: failureName === 'TimeoutError' ? 0 : 1,
    resolvedUncertainReplies: 1, unresolvedUncertainReplies: 0, confirmedAccounts: 2 });
  for (const job of [{ kind: 'arm' }, { kind: 'stop' }, confirm,
    { kind: 'step', index: capacityIntentStepIndex(0, 0) }]) assert.equal(recovery.defer(job, error), false);
  assert.equal(new CapacityRegistrationRecovery({ ...manifest, profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile }).defer(lost, error), false);
  for (const fetcher of [async () => new Response('', { status: 503 }),
    async () => Response.json({ index: 118, accepted: true, acceptedAt: null }),
    async () => { throw new Error('unclassified private failure'); }]) {
    const rejected = new CapacityTransport({ ...manifest, origin: 'https://chess-capacity-test.ejmlabs.com',
      credentials, bindings: new CapacityBindings(), now: () => anchor + 200_000, fetcher });
    let rejectedError;
    try { await rejected.issue(lost); } catch (caught) { rejectedError = caught; }
    assert.equal(recovery.defer(lost, rejectedError), false);
  }
  }
});

test('a resolved registration timeout stays counted and an unresolved reply still fails', async () => {
  for (const confirm of [false, true]) {
    const recovery = new CapacityRegistrationRecovery(manifest);
    const clock = clockFixture();
    const records = [];
    const result = await runCapacitySchedule([{ kind: 'step', index: 118, at: 1_000 },
      { kind: 'step', index: 10_118, at: 1_100 }], {
      clock, record: async row => { records.push(row); }, issueCloseAt: 2_000, hardCloseAt: 3_000,
      resolvedUncertainties: () => recovery.counts.resolvedUncertainReplies,
      issue: async job => {
        if (job.index === 118) {
          const error = Object.assign(new Error('capacity_request_uncertain'), {
            burstRegistrationUncertainIndex: 118, burstRegistrationFailureCode: 'TimeoutError' });
          assert.equal(recovery.defer(job, error), true);
          throw error;
        }
        const result = { accepted: true, ...(confirm ? { registration: { eventIndex: 0, eventId: capacityEventId(0, anchor) } } : {}) };
        recovery.acknowledge(job, result);
        return result;
      },
    });
    assert.equal(result.offered, 2);
    assert.equal(result.uncertain, 1);
    assert.equal(result.resolvedUncertain, confirm ? 1 : 0);
    assert.equal(result.unresolvedUncertain, confirm ? 0 : 1);
    assert.equal(result.passed, confirm);
    assert.equal(records.filter(row => row.type === 'uncertain').length, 1);
  }
});

test('native ingress grant overlap retains one charge across distinct Worker requests', { timeout: 10_000 }, async () => {
  const { build } = await import('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const built = await build({ bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], logLevel: 'silent',
    stdin: { resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'capacity-ingress-regression.ts',
      contents: `
import { DurableObject } from 'cloudflare:workers';
import { CapacityIngressBudget } from './src/server/capacity-ingress';
import { readJson } from './src/server/security';
let budget = null;
export class Counter extends DurableObject {
  constructor(ctx, env) { super(ctx, env); ctx.storage.sql.exec('CREATE TABLE grants(id TEXT PRIMARY KEY)'); }
  async reserveIngress(id) {
    this.ctx.storage.sql.exec('INSERT INTO grants VALUES(?)', id);
    await new Promise(resolve => setTimeout(resolve, 100));
    return true;
  }
  async count() { return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM grants').one().n; }
}
const entry = { async fetch(request, env) {
  const control = env.COUNTER.get(env.COUNTER.idFromName('only'));
  if (new URL(request.url).pathname === '/count') return Response.json({ grants: await control.count() });
  budget ??= new CapacityIngressBudget(Date.now() + 30_000);
  try {
    const body = await readJson(request, 128);
    const accepted = await budget.consume(id => control.reserveIngress(id));
    return Response.json({ accepted, body });
  }
  catch (error) { return Response.json({ accepted: false,
    code: /Cannot perform I\\/O on behalf/.test(error.message) ? 'cross-request-io' : 'native-error' }, { status: 503 }); }
} };
export default { fetch(request, env) {
  return entry.fetch(new Request('https://chess-capacity-test.ejmlabs.com' + new URL(request.url).pathname, request), env);
} };` } });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
    durableObjects: { COUNTER: { className: 'Counter', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
  try {
    const origin = (await runtime.ready).origin;
    const consume = async index => {
      const response = await localCapacityFetch(origin + '/consume', { method: 'POST', body: JSON.stringify({ index }),
        headers: { 'Content-Type': 'application/json' } });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body);
    };
    for (let index = 0; index < 256; index++) {
      const reply = await consume(index);
      assert.equal(reply.accepted, true);
      assert.deepEqual(reply.body, { index });
    }
    const replies = await Promise.all(Array.from({ length: 40 }, (_, index) => consume(index)));
    assert.equal(replies.filter(reply => reply.accepted).length, 40, JSON.stringify(replies));
    assert.deepEqual(replies.map(reply => reply.body), Array.from({ length: 40 }, (_, index) => ({ index })));
    assert.deepEqual(await (await fetch(origin + '/count')).json(), { grants: 2 });
  } finally { await runtime.dispose(); }
});

test('an accepted observation cannot count an unsettled native result as success', async () => {
  const bindings = new CapacityBindings();
  const fixture = capacityIntent(0);
  bindings.bind({ intentIndex: 0, gameId: 'native-settlement-fixture', eventIndex: fixture.eventIndex,
    whiteAccountIndex: fixture.queueAccounts[0], blackAccountIndex: fixture.queueAccounts[1] }, 'private-settlement-fixture-proof');
  const index = capacityIntentStepIndex(0, 11);
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com',
    credentials: { token: 'test-token', accounts: [{ cookie: 'fixture=not-secret' }] }, bindings,
    issueCloseAt: 2_000, hardCloseAt: 3_000, now: () => 1_000,
    fetcher: async (_url, init) => {
      assert.equal(init.headers.Origin, 'https://chess-capacity-test.ejmlabs.com');
      assert.equal(init.headers.Cookie, 'fixture=not-secret');
      assert.equal(init.body, '{}');
      return Response.json({ index, accepted: true, acceptedAt: 1_000,
        result: { settled: false, deliveryPending: true, terminalVersion: 7 } });
    },
  });
  await assert.rejects(() => transport.issue({ kind: 'step', index }));
  assert.equal(bindings.counts.uncertainIntents, 1);
});

test('execution stays disabled before private files or transport regardless of environment flags', () => {
  const result = spawnSync(process.execPath, [new URL('./capacity-driver.mjs', import.meta.url).pathname,
    '--execute', '--candidate', '/does-not-exist/candidate.json', '--seed', '/does-not-exist/seed.json',
    '--sessions-artifact', '/does-not-exist/sessions.json',
    '--region', 'us-west', '--trace', '/does-not-exist/trace.gz'], {
    encoding: 'utf8', env: { ...process.env, CAPACITY_DRIVER_EXECUTION_READY: 'true', CAPACITY_PROTOCOL_READY: 'true' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /remains unarmed/);
  assert.equal(result.stderr.includes('/does-not-exist'), false);
});

test('local rehearsal refuses remote origins before I/O and reaches only loopback with canonical Host', { timeout: 5_000 }, async () => {
  for (const loopbackOrigin of ['https://chess-capacity-test.ejmlabs.com', 'http://localhost.example.com',
    'http://fixture@localhost', 'http://127.0.0.1/path', 'ftp://localhost']) {
    await assert.rejects(() => runLocalCapacityRehearsal({ loopbackOrigin }), /capacity_local_origin_invalid/);
  }
  const directory = await mkdtemp(join(tmpdir(), 'capacity-local-runner-'));
  let request;
  const server = createServer((incoming, response) => {
    request = incoming;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ready: false }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sealed = { ...capacityCalendarSchedule(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000),
    runId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64),
    host: 'chess-capacity-test.ejmlabs.com', verified: { ownerApprovedFrozenRun: true } };
  const candidate = { schema: 'ejm-chess-capacity-driver-candidate-v1', ...await capacityDriverDigests(),
    incrementalMaximumCents: 2_500, ledgerDigest: 'd'.repeat(64), manifest: sealed, egressMode: 'single-egress',
    runners: [{ region: 'us-west', runnerId: 'local-only', transportPath: 'loopback',
      evidenceReference: 'local-only-fixture', maximumCostCents: 0 }] };
  const credentials = { runId: sealed.runId, manifestDigest: sealed.digest,
    token: 'localOnlyFixtureToken'.padEnd(43, '_'), accounts: Array(6_000).fill(null) };
  const tracePath = join(directory, 'trace.ndjson.gz');
  try {
    await assert.rejects(() => runLocalCapacityRehearsal({ candidate, credentials, tracePath,
      sessionsArtifactPath: join(directory, 'sessions.json'), loopbackOrigin: `http://127.0.0.1:${server.address().port}` }),
    /capacity_preflight_unqualified/);
    assert.equal(request.url, '/capacity/manifest');
    assert.equal(request.headers.host, sealed.host);
    assert.equal(request.headers.authorization, `Bearer ${credentials.token}`);
    const lines = gunzipSync(await readFile(tracePath)).toString('utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].localOnly, true);
    assert.equal(lines[0].qualificationPassed, false);
    assert.equal(JSON.stringify(lines).includes(credentials.token), false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('native preparation keeps the real cookie private and permits hard-close equality', async () => {
  const sealed = { ...manifest, runId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64) };
  const cookie = 'fixture=private-local-test-only';
  const credentials = { runId: sealed.runId, manifestDigest: sealed.digest,
    token: 'a'.repeat(43), accounts: Array(6_000).fill(null) };
  const credential = capacityAccountCredential({ accountIndex: 0, cookie, expiresAt: sealed.hardCloseAt }, 0, sealed);
  assert.equal(credential.expiresAt, sealed.hardCloseAt);
  assert.throws(() => capacityAccountCredential({ ...credential, expiresAt: sealed.hardCloseAt - 1 }, 0, sealed));
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com', credentials,
    bindings: new CapacityBindings(), earliestArmAt: anchor,
    issueCloseAt: sealed.issueCloseAt, hardCloseAt: sealed.hardCloseAt, now: () => anchor + 2_000,
    fetcher: async (url, init) => {
      assert.equal(new URL(url).pathname, '/capacity/prepare/0');
      assert.equal(init.headers.Origin, 'https://chess-capacity-test.ejmlabs.com');
      assert.equal(Object.hasOwn(init.headers, 'Cookie'), false);
      assert.equal(init.body, '{}');
      return Response.json({ accountIndex: 0, cookie, expiresAt: sealed.hardCloseAt });
    } });
  const reply = await transport.issue({ kind: 'prepare', index: 0,
    replyDeadlineAt: anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs });
  assert.equal(reply.preparedAccountIndex, 0);
  assert.equal(JSON.stringify(reply).includes(cookie), false);
  assert.equal(credentials.accounts[0].cookie, cookie);
  const arm = capacityRequest({ kind: 'arm' }, credentials, new CapacityBindings());
  assert.equal(Object.hasOwn(arm.init.headers, 'Cookie'), false);
});

test('a preparation reply after the fixed artifact deadline cannot populate credentials', async () => {
  const deadline = anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs;
  const credentials = { token: 'a'.repeat(43), accounts: Array(6_000).fill(null) };
  let now = deadline - 1;
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com', credentials,
    bindings: new CapacityBindings(), earliestArmAt: anchor,
    issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt, now: () => now,
    fetcher: async () => { now = deadline + 1;
      return Response.json({ accountIndex: 0, cookie: 'fixture=private-local-test-only', expiresAt: manifest.hardCloseAt }); },
  });
  await assert.rejects(() => transport.issue({ kind: 'prepare', index: 0, replyDeadlineAt: deadline }), /capacity_request_uncertain/);
  assert.equal(credentials.accounts[0], null);
});

test('batch preparation installs every validated credential atomically and traces only counters', async () => {
  const credentials = { token: 'a'.repeat(43), accounts: Array(6_000).fill(null) };
  let malformed = true;
  const indexes = capacityPreparationAccounts(0);
  const cookie = 'fixture=private-batch-cookie';
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com', credentials,
    bindings: new CapacityBindings(), earliestArmAt: anchor,
    issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt, now: () => anchor + 8_000,
    fetcher: async url => {
      assert.equal(new URL(url).pathname, '/capacity/prepare-batch/0');
      return Response.json({ accounts: indexes.map(index => ({ accountIndex: malformed && index === 31 ? 30 : index,
        cookie, expiresAt: manifest.hardCloseAt })), usage: { d1RowsRead: 192, d1RowsWritten: 768,
        d1Retries: 2, d1RetryReadSurcharge: 1_280, privateCookie: cookie } });
    } });
  const job = { kind: 'prepare', index: 0, count: 32, replyDeadlineAt: anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs };
  await assert.rejects(() => transport.issue(job), /capacity_request_uncertain/);
  assert.equal(credentials.accounts.filter(Boolean).length, 0);
  malformed = false;
  const reply = await transport.issue(job);
  assert.deepEqual(reply.preparedAccountIndexes, indexes);
  assert.equal(credentials.accounts.filter(Boolean).length, 32);
  assert.equal(JSON.stringify(reply).includes(cookie), false);
  assert.equal(Object.hasOwn(reply.preparationUsage, 'privateCookie'), false);
  await assert.rejects(() => transport.issue(job), /capacity_request_uncertain/);
  assert.equal(credentials.accounts.filter(Boolean).length, 32);
});

test('slow native setup may exceed five seconds once while the credential deadline still aborts it', { timeout: 20_000 }, async () => {
  const deadline = anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs;
  const credentials = { token: 'a'.repeat(43), accounts: Array(6_000).fill(null) };
  let requests = 0;
  const started = performance.now();
  const transport = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com', credentials,
    bindings: new CapacityBindings(), earliestArmAt: anchor,
    issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt,
    now: () => anchor + 8_000 + Math.floor(performance.now() - started),
    fetcher: async (_url, init) => {
      requests++;
      await delay(5_100, undefined, { signal: init.signal });
      return Response.json({ accountIndex: 0, cookie: 'fixture=private-local-test-only', expiresAt: manifest.hardCloseAt });
    } });
  const reply = await transport.issue({ kind: 'prepare', index: 0, replyDeadlineAt: deadline });
  assert.equal(reply.preparedAccountIndex, 0);
  assert.equal(requests, 1);
  assert.equal(transport.counts.requests, 1);
  assert.equal(credentials.accounts[0].cookie, 'fixture=private-local-test-only');

  const lateCredentials = { token: 'a'.repeat(43), accounts: Array(6_000).fill(null) };
  let clippedSignal;
  const nearDeadline = new CapacityTransport({ origin: 'https://chess-capacity-test.ejmlabs.com', credentials: lateCredentials,
    bindings: new CapacityBindings(), earliestArmAt: anchor,
    issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt, now: () => deadline - 25,
    fetcher: async (_url, init) => { clippedSignal = init.signal;
      await delay(1_000, undefined, { signal: init.signal });
      throw new Error('late fixture fetch should have aborted');
    } });
  await assert.rejects(() => nearDeadline.issue({ kind: 'prepare', index: 0, replyDeadlineAt: deadline }), /capacity_request_uncertain/);
  assert.equal(clippedSignal.aborted, true);
  assert.equal(nearDeadline.counts.requests, 1);
  assert.equal(lateCredentials.accounts[0], null);
});

test('one private credential artifact is bound to its seed, manifest, complete corpus and fixed slots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capacity-credentials-'));
  try {
    const sealed = { ...manifest, runId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64) };
    const seed = { schema: 'ejm-chess-capacity-seed-v1', runId: sealed.runId, manifestDigest: sealed.digest, token: 's'.repeat(43) };
    const seedPath = join(directory, 'seed.json');
    await writeFile(seedPath, JSON.stringify(seed), { flag: 'wx', mode: 0o600 });
    const credentials = await readCapacitySeed(seedPath, sealed);
    assert.equal(credentials.accounts.filter(Boolean).length, 0);
    const path = join(directory, 'sessions.json');
    const sealAt = anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs;
    const loadAt = anchor + CAPACITY_DRIVER_TIMING.credentialLoadOffsetMs;
    await assert.rejects(() => sealCapacityCredentialArtifact(path, credentials, sealed, sealAt));
    credentials.accounts = Array.from({ length: 6_000 }, (_, index) => ({ index, accountId: capacityAccountId(index),
      cookie: `fixture_${index}=private-local-test-only`, expiresAt: sealed.hardCloseAt }));
    const result = await sealCapacityCredentialArtifact(path, credentials, sealed, sealAt);
    assert.equal(result.accounts, 6_000);
    assert.equal((await readFile(path, 'utf8')).includes(seed.token), false);
    const recipient = await readCapacitySeed(seedPath, sealed);
    await assert.rejects(() => loadCapacityCredentialArtifact(path, recipient, sealed, loadAt + 26));
    await assert.rejects(() => loadCapacityCredentialArtifact(join(directory, 'missing.json'), recipient, sealed, loadAt));
    const loaded = await loadCapacityCredentialArtifact(path, recipient, sealed, loadAt);
    assert.equal(loaded.sha256, result.sha256);
    assert.deepEqual(recipient.accounts, credentials.accounts);
    await assert.rejects(() => loadCapacityCredentialArtifact(path, recipient, sealed, loadAt));
    await assert.rejects(() => sealCapacityCredentialArtifact(path, credentials, sealed, sealAt));
    const tampered = JSON.parse(await readFile(path, 'utf8'));
    tampered.snapshot.accounts[0].cookie = 'fixture=tampered-local-test-only';
    const tamperedPath = join(directory, 'tampered.json');
    await writeFile(tamperedPath, JSON.stringify(tampered), { flag: 'wx', mode: 0o600 });
    await assert.rejects(() => loadCapacityCredentialArtifact(tamperedPath, { ...seed, accounts: Array(6_000).fill(null) }, sealed, loadAt));
    await chmod(tamperedPath, 0o644);
    await assert.rejects(() => loadCapacityCredentialArtifact(tamperedPath, { ...seed, accounts: Array(6_000).fill(null) }, sealed, loadAt));
    await assert.rejects(() => readCapacitySeed(seedPath, { ...sealed, digest: 'b'.repeat(64) }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('compressed private trace preserves every record and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capacity-trace-'));
  try {
    const path = join(directory, 'events.ndjson.gz');
    const trace = new CapacityTrace(path);
    await trace.write({ type: 'offered', index: 1, at: 1_000 });
    await trace.write({ type: 'uncertain', index: 1, at: 1_001 });
    await trace.close();
    const lines = gunzipSync(await readFile(path)).toString('utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines, [{ type: 'offered', index: 1, at: 1_000 }, { type: 'uncertain', index: 1, at: 1_001 }]);
    const other = new CapacityTrace(path);
    await assert.rejects(async () => { await other.write({ type: 'replacement' }); await other.close(); });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real WebSocket handshake carries bearer, session, origin and routing proof from the capacity transport', { timeout: 5_000 }, async () => {
  assert.match(process.version, /^v24\./);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const origin = 'https://chess-capacity-local.ejmlabs.com';
  const binding = { intentIndex: 19_000, gameId: 'native-socket-handshake-fixture',
    eventIndex: capacityIntent(19_000).eventIndex,
    whiteAccountIndex: capacityIntent(19_000).queueAccounts[0],
    blackAccountIndex: capacityIntent(19_000).queueAccounts[1] };
  const bindings = new CapacityBindings();
  bindings.bind(binding, 'fixture-routing-proof');
  const credentials = { token: 'a'.repeat(43),
    accounts: Array.from({ length: 6_000 }, () => ({ cookie: 'fixture=not-secret' })) };
  const records = [];
  let received;
  const messageRecorded = new Promise(resolve => { received = resolve; });
  // Route this real package client to loopback. All protocol headers and the
  // socket path still come from CapacityTransport, as in the actual driver.
  class LoopbackWebSocket extends WebSocket {
    constructor(url, options) {
      const destination = new URL(url);
      assert.equal(destination.origin, origin.replace('https:', 'wss:'));
      super(`ws://127.0.0.1:${server.address().port}${destination.pathname}`, options);
    }
  }
  const transport = new CapacityTransport({ origin, credentials, bindings,
    issueCloseAt: 2_000, hardCloseAt: 3_000, now: () => 1_000,
    WebSocketClass: LoopbackWebSocket, record: async value => { records.push(value); received(); } });
  const connection = once(server, 'connection');
  try {
    const reply = await transport.issue({ kind: 'socket', index: 0 });
    const [socket, request] = await connection;
    assert.equal(reply.status, 101);
    assert.equal(request.url, '/capacity/socket/0');
    assert.equal(request.headers.cookie, 'fixture=not-secret');
    assert.equal(request.headers.authorization, `Bearer ${credentials.token}`);
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers[CAPACITY_BINDING_HEADER.toLowerCase()], 'fixture-routing-proof');
    socket.send(JSON.stringify({ type: 'snapshot', snapshot: { version: 2 } }));
    await messageRecorded;
    assert.equal(records[0].version, 2);
    assert.equal(JSON.stringify(records).includes('fixture-routing-proof'), false);
    assert.equal(JSON.stringify(records).includes(credentials.token), false);
  } finally {
    transport.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
