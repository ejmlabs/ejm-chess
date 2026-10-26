#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { CAPACITY_CORPUS, capacityIntent, capacityStep } from '../src/shared/capacity-corpus.ts';
import { CapacityTrace, capacityCalendarSchedule, capacityDriverDigests, capacityWorkSchedule,
  mergeCapacitySchedule } from './capacity-driver.mjs';

// Encode the complete successful trace without HTTP, sockets, native Games or a provider.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-driver-trace.mjs --output /private/tmp/report.json');
}
if (!process.version.startsWith('v24.')) throw new Error('Node24 is required');
const anchor = Date.parse('2026-10-25T17:50:00Z');
const manifest = capacityCalendarSchedule(anchor);
const trace = new CapacityTrace(args[1] + '.ndjson.gz');
const started = performance.now();
const cpu = process.cpuUsage();
const offeredBins = Array.from({ length: 6 }, () => new Float64Array(1_800));
const streams = Array.from({ length: 6 }, (_, region) => (function* () {
  for (const job of capacityWorkSchedule(manifest, region)) yield { ...job, region };
})());
const games = Array.from({ length: 20_000 }, (_, index) => {
  const digest = createHash('sha256').update(`fixed-trace-only-${index}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
});
const counts = { requests: 0, records: 0, resources: 0, sockets: 0, steps: 0, standings: 0, preparations: 0, controls: 20, localActions: 14 };
for (const job of mergeCapacitySchedule(streams)) {
  const before = trace.stats.encodedBytes;
  const common = { kind: job.kind, index: job.index, scheduledAt: job.at };
  await trace.write({ type: 'dispatch-intent', ...common, at: job.at + 25, lateMs: 25 });
  await trace.write({ type: 'offered', ...common, at: job.at + 25, lateMs: 25, inflight: 256 });
  const accepted = { type: 'acknowledged', ...common, offeredAt: job.at + 25,
    acknowledgedAt: job.at + 5_024, elapsedMs: 4_999, status: 200, accepted: true, acceptedAt: job.at + 4_999 };
  if (job.kind === 'standings') {
    counts.standings++;
    accepted.acceptedAt = null;
    accepted.projection = { generatedAt: job.at - 10_000, watermark: 20_000, rows: 32 };
    accepted.cache = { age: '10', status: 'REVALIDATED' };
  } else if (job.kind === 'socket') {
    counts.sockets++;
    accepted.status = 101;
    accepted.sockets = 4_000;
  } else if (job.kind === 'prepare') {
    counts.preparations++;
    accepted.acceptedAt = null;
    accepted.preparedAccountIndex = job.index;
  } else {
    counts.steps++;
    const step = capacityStep(job.index);
    if (step.intentIndex !== undefined) {
      const intent = capacityIntent(step.intentIndex);
      accepted.binding = { intentIndex: step.intentIndex, gameId: games[step.intentIndex],
        whiteAccountIndex: intent.queueAccounts[0], blackAccountIndex: intent.queueAccounts[1], eventIndex: intent.eventIndex };
      accepted.result = { settled: true, deliveryPending: false, terminalVersion: 7 };
    } else { accepted.binding = null; accepted.result = null; }
  }
  await trace.write(accepted);
  offeredBins[job.region][Math.floor((job.at - anchor) / 1_000)] += trace.stats.encodedBytes - before;
  counts.requests++;
  counts.records += 3;
}
// Conservatively encode three records for every finite HTTP control and local artifact/socket action.
for (let index = 0; index < counts.controls + counts.localActions; index++) {
  for (const type of ['dispatch-intent', 'offered', 'acknowledged']) {
    await trace.write({ type, kind: index < counts.controls ? 'control' : 'local', index,
      scheduledAt: manifest.hardCloseAt - 10_000, at: manifest.hardCloseAt - 9_975,
      status: 200, accepted: true, acceptedAt: manifest.hardCloseAt - 9_900,
      manifestDigest: 'f'.repeat(64), artifactSha256: 'a'.repeat(64), heldObjects: 1_002, unresolvedDispatches: 1_000 });
    counts.records++;
  }
}
counts.requests += counts.controls;
// Full 60-minute sampling for all six runners and bounded state/socket events.
for (let region = 0; region < 6; region++) {
  for (let second = 0; second <= 3_600; second++) {
    await trace.write({ type: 'resources', region, at: anchor + second * 1_000,
      sample: { at: second * 1_000, cpu: { user: 99_999_999, system: 99_999_999 }, rssBytes: 512 * 1024 ** 2,
        heapUsedBytes: 256 * 1024 ** 2, externalBytes: 64 * 1024 ** 2, elapsedMs: 1_000,
        cpuMicroseconds: 999_999, coreUtilization: 0.999999 } });
    counts.resources++;
    counts.records++;
  }
}
for (let index = 0; index < 4_000; index++) {
  // The legal corpus has at most 7 updates plus the initial snapshot per socket.
  for (let version = 0; version <= 7; version++) {
    await trace.write({ type: 'socket-message', index, at: manifest.streamEndsAt + 85_000 + version * 10_000,
      messageType: 'snapshot', version });
    counts.records++;
  }
}
await trace.close();
const wallMs = performance.now() - started;
const peakPerRunnerBytesPerSecond = Math.max(...offeredBins.map(bins => Math.max(...bins)));
const report = { schema: 'ejm-chess-capacity-driver-trace-local-v1', node: process.version,
  at: new Date().toISOString(), scope: 'Complete synthetic encoded trace only. No HTTP, native Game, provider or wall-clock workload.',
  source: { ...await capacityDriverDigests(), probeDigest: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') },
  counts, trace: { path: args[1] + '.ndjson.gz', ...trace.stats },
  wallMs, cpu: process.cpuUsage(cpu), maximumRssBytes: process.resourceUsage().maxRSS * 1024,
  peakPerRunnerBytesPerSecond, compressionEncodedBytesPerSecond: trace.stats.encodedBytes / (wallMs / 1_000),
  uncompressedFits512MiB: trace.stats.encodedBytes <= 512 * 1024 ** 2,
  compressedFits512MiB: trace.stats.compressedBytes <= 512 * 1024 ** 2,
  activationGateReady: false,
  limits: 'Timing records use bounded long successful values to measure encoding size. Fast encoding does not qualify live deadlines, native operation costs, regional paths, full workload or shutdown.',
};
await writeFile(args[1], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ report: args[1], counts, trace: report.trace,
  wallMs, cpu: report.cpu, maximumRssBytes: report.maximumRssBytes, peakPerRunnerBytesPerSecond,
  uncompressedFits512MiB: report.uncompressedFits512MiB, compressedFits512MiB: report.compressedFits512MiB }) + '\n');
if (!report.compressedFits512MiB || counts.requests > CAPACITY_CORPUS.maximumWorkerRequests) process.exitCode = 1;
