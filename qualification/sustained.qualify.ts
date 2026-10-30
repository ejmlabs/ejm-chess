import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Env } from '../src/server/env';
import type { GameResult } from '../src/shared/protocol';
import { activeGame } from '../test/authority-helpers';

declare const __QUALIFICATION_DURATION_MS__: number;
const RATE = 20;

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1] ?? 0,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? 0, p99Ms: sorted[Math.ceil(sorted.length * .99) - 1] ?? 0,
    maxMs: sorted.at(-1) ?? 0 };
}

async function parallel<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await work(items[cursor++]);
  }));
}

it('measures 20 synthetic pre-admitted unique settlements/sec for an elapsed 15-minute window with outage catch-up', async ({ task }) => {
  const durationMs = __QUALIFICATION_DURATION_MS__;
  if (!Number.isInteger(durationMs) || durationMs < 10_000 || durationMs % 1_000) throw new Error('Use a whole-second duration of at least 10 seconds.');
  const seconds = durationMs / 1_000;
  const regular = seconds * RATE;
  const recoveryCount = durationMs >= 900_000 ? 1_000 : 40;
  const prefix = crypto.randomUUID();
  const seed = await activeGame();
  await seed.game.command(seed.white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: seed.snapshot.version });
  const template = (await seed.game.status())!.result!;
  const baseAt = Date.now();
  // This fixture replaces only terminal Game verification. It creates no
  // games, admissions or work receipts and cannot establish their capacity.
  function result(index: number): GameResult {
    const id = `${prefix}-${index}`;
    return { ...template, id, eventId: `${id}:${template.version}`, terminalDigest: `synthetic-pre-admitted:${id}`,
      createdAt: baseAt - 1_000, startedAt: baseAt - 500, endedAt: baseAt, reservationId: undefined };
  }
  const authorityName = crypto.randomUUID();
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName(authorityName));
  async function configure() {
    await runInDurableObject(competition, async (instance, state) => {
      const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
      internal.env = { ...internal.env, ARENAS_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'false',
        GAME: { idFromName: (name: string) => name, get: (name: string) => ({ status: async () => ({ result: result(Number(name.slice(prefix.length + 1))) }) }) } as unknown as Env['GAME'] };
      internal.schedule = async () => {};
      await state.storage.deleteAlarm();
    });
  }
  await configure();
  const samples: number[] = [];
  const batchTimes: number[] = [];
  const projectionCounts: number[] = [];
  const report: Record<string, unknown> = { kind: 'synthetic-pre-admitted-settlement', requestedDurationMs: durationMs,
    ratePerSecond: RATE, regularResults: regular, qualification: durationMs >= 900_000 ? 'full-duration' : 'smoke-only',
    scope: 'Native Competition SQLite/D1. Terminal Game.status is a deterministic synthetic fixture based on one native result. No game admission, credential load, sockets, rating calculation, monthly-window reset or production quota bypass. This isolates settlement/projection throughput; it does not qualify sustained production admission.' };
  task.meta.qualification = report;
  const start = performance.now();
  let recovery: Promise<void> | null = null;
  let recoveryMs = 0;
  let recoveryDuplicatesMs = 0;
  let restarted = false;
  const settle = async (index: number) => {
    const before = performance.now();
    expect(await competition.settle(result(index))).toEqual({ accepted: true, pending: false });
    samples.push(performance.now() - before);
  };
  for (let second = 0; second < seconds; second++) {
    const due = start + second * 1_000;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due - performance.now())));
    if (second === Math.floor(seconds / 3)) {
      await evictDurableObject(competition); await configure(); restarted = true;
    }
    if (second === Math.floor(seconds / 2)) {
      recovery = (async () => {
        const before = performance.now();
        await parallel(Array.from({ length: recoveryCount }, (_, index) => regular + index), 16, settle);
        recoveryMs = performance.now() - before;
        const duplicatesAt = performance.now();
        await parallel(Array.from({ length: recoveryCount * 5 }, (_, index) => regular + index % recoveryCount), 32, async index => {
          expect(await competition.settle(result(index))).toEqual({ accepted: true, pending: false });
        });
        recoveryDuplicatesMs = performance.now() - duplicatesAt;
      })();
    }
    const before = performance.now();
    await parallel(Array.from({ length: RATE }, (_, index) => second * RATE + index), 16, settle);
    await competition.maintenance();
    await competition.flush();
    batchTimes.push(performance.now() - before);
    projectionCounts.push(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox').one().count));
  }
  await recovery;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, start + durationMs - performance.now())));
  const elapsedMs = performance.now() - start;
  // Drain the ordinary 16-row projection batches without altering bounds.
  for (let pass = 0; pass < 256; pass++) {
    await competition.maintenance();
    if (!await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox').one().count)) break;
  }
  const accounting = await runInDurableObject(competition, (_instance, state) => ({
    results: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM result_events').one().count,
    identities: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM processed_results').one().count,
    outbox: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox').one().count,
    bytes: state.storage.sql.databaseSize,
  }));
  expect(accounting).toMatchObject({ results: regular + recoveryCount, identities: regular + recoveryCount, outbox: 0 });
  const projected = await env.DB.prepare('SELECT COUNT(*) AS count FROM games WHERE id LIKE ?').bind(`${prefix}-%`).first('count');
  expect(projected).toBe(regular + recoveryCount);
  report.elapsedMs = elapsedMs; report.regularPerSecond = regular / elapsedMs * 1_000;
  report.latency = latency(samples); report.perSecondBatch = latency(batchTimes);
  report.recovery = { unique: recoveryCount, elapsedMs: recoveryMs, uniquePerSecond: recoveryCount / recoveryMs * 1_000,
    duplicates: recoveryCount * 5, duplicateElapsedMs: recoveryDuplicatesMs,
    scope: 'Delayed synthetic verified terminal results released halfway through the elapsed run, alongside normal traffic.' };
  report.accounting = accounting; report.projected = projected; report.restarted = restarted;
  report.maxPendingProjections = Math.max(...projectionCounts);
  report.unqualified = ['production admission', 'native Game verification and game resources for this duration', 'rated Glicko work',
    'provider alarms', 'public HTTP/accounts', 'regional latency', 'live cost', '72000-payload retention steady state'];
  expect(elapsedMs).toBeGreaterThanOrEqual(durationMs);
  expect(elapsedMs).toBeLessThan(durationMs + 10_000);
  expect(latency(samples).p95Ms).toBeLessThanOrEqual(250);
  expect(recoveryMs).toBeLessThanOrEqual(60_000);
  expect(recoveryCount / recoveryMs * 1_000).toBeGreaterThanOrEqual(40);
});
