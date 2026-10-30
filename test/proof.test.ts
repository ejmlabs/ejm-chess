import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { Container } from '@cloudflare/containers';
import type { Env } from '../src/server/env';
import {
  PROOF_INSTANCE, PROOF_PROFILE, PROOF_RULES_VERSION, PROOF_SOLVER_COMMIT, PROOF_VALIDATOR_VERSION,
  parseProofRequest, parseProofResult, proofDigests, proofHash, unknownProof, type TimeoutProofRequest,
} from '../src/server/proof-contract';
import { hasProofAdmission, proofBudgetAvailable, proofBudgetStatus, proofConfigured, reserveProofAdmission } from '../src/server/proof-budget';
import { initializeProofPool, TimeoutProver } from '../src/server/proof-pool';
import { proofLifecycle, PROOF_ALLOCATION_MS, PROOF_STOP_ATTEMPTS } from '../src/server/proof-lifecycle';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM timeout_proof_admissions'),
    env.DB.prepare('DELETE FROM timeout_proof_months'),
    env.DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'"),
  ]);
});

function configured(): Env {
  return { ...env, TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '1000',
    PROVER: {} as Env['PROVER'] };
}

async function request(gameId = crypto.randomUUID()): Promise<TimeoutProofRequest> {
  const chess = new Chess();
  const source = { rulesVersion: PROOF_RULES_VERSION as typeof PROOF_RULES_VERSION, gameId, pendingVersion: 3,
    initialFen: chess.fen(), fen: chess.fen(), moves: [] as string[], survivor: 'b' as const };
  return { ...source, ...await proofDigests(source), v: 1, profileVersion: PROOF_PROFILE,
    reservationId: gameId, requestId: `timeout:${gameId}:3`, expiresAt: Date.now() + 30_000, attempt: 1 };
}

function post(value: unknown, url = 'http://proof.internal/prove'): Request {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

describe('private proof boundary and spend authority', () => {
  it('binds strict pinned results to the entire saved identity and rejects unsafe witnesses', async () => {
    const input = await request();
    expect(parseProofRequest(input)).toEqual(input);
    for (const change of [{ enginePath: '/bin/sh' }, { rulesVersion: 'online-2026-10-v2-unattended' },
      { attempt: 3 }, { reservationId: crypto.randomUUID() }, { moves: ['e2e9'] }, { fen: 'x'.repeat(129) },
      { moves: Array(12_701).fill('a2a3') }, { pendingVersion: 0 }, { requestId: 'another-request' }]) {
      expect(parseProofRequest({ ...input, ...change })).toBeNull();
    }
    const unknown = unknownProof(input, 'solver-undetermined');
    expect(parseProofResult(unknown, input)).toEqual(unknown);
    const positive = { ...unknown, verdict: 'winnable', reason: null, witness: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] };
    expect(parseProofResult(positive, input)).toEqual(positive);
    for (const change of [{ gameId: crypto.randomUUID() }, { pendingVersion: 4 }, { survivor: 'w' },
      { historyDigest: 'f'.repeat(64) }, { positionDigest: '0'.repeat(64) }, { expiresAt: input.expiresAt + 1 },
      { attempt: 2 }, { solverCommit: 'latest' }, { validatorVersion: 'unvalidated' }, { witness: [] },
      { witness: ['a7a8k'] }, { witness: Array(513).fill('a2a3') }, { arbitrary: true }]) {
      expect(parseProofResult({ ...positive, ...change }, input)).toBeNull();
    }
    expect(parseProofResult({ ...unknown, verdict: 'unwinnable', reason: null }, input)).not.toBeNull();
    expect(parseProofResult({ ...unknown, witness: ['e2e4'] }, input)).toBeNull();
    expect(parseProofResult({ ...unknown, reason: null }, input)).toBeNull();
    expect(unknown).toMatchObject({ solverCommit: PROOF_SOLVER_COMMIT, validatorVersion: PROOF_VALIDATOR_VERSION });
  });

  it('admits only the last monthly credit once and drains its stable receipt through stops and rollover', async () => {
    const now = Date.UTC(2026, 9, 31, 23, 59, 59);
    const next = Date.UTC(2026, 10, 1);
    const config = { ...configured(), MONTHLY_PROOF_LIMIT: '1' };
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const admissions = await Promise.all(ids.map(id => reserveProofAdmission(config, id, now)));
    expect(admissions.filter(Boolean)).toHaveLength(1);
    const accepted = ids[admissions.indexOf(true)];
    expect(await reserveProofAdmission(config, accepted, now)).toBe(true);
    await env.DB.prepare("UPDATE operations_control SET games_stopped=1 WHERE id='product'").run();
    const stopped = { ...config, TIMEOUT_PROOF_PROFILE: 'off', PROVER: undefined, NEW_WORK_STOPPED: 'true' };
    expect(await reserveProofAdmission(stopped, accepted, next)).toBe(true);
    expect(await hasProofAdmission(stopped, accepted)).toBe(true);
    expect(await reserveProofAdmission(config, crypto.randomUUID(), next)).toBe(false);
    expect(await proofBudgetAvailable(config, next)).toBe(false);
    await env.DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'").run();
    expect(await reserveProofAdmission(config, crypto.randomUUID(), next)).toBe(true);
    expect(await proofBudgetStatus(config, next)).toMatchObject({ used: 1, retained: 2, creditsPerGame: 2, invoiceHardCap: false });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM timeout_proof_months').first('COUNT(*)')).toBe(2);
  });

  it('closes invalid configuration, unavailable authority and permanent receipt exhaustion', async () => {
    const config = configured();
    for (const value of ['0', '-1', '1001', '1.5', 'NaN', '']) {
      const invalid = { ...config, MONTHLY_PROOF_LIMIT: value };
      expect(proofConfigured(invalid)).toBe(false);
      expect(await reserveProofAdmission(invalid, crypto.randomUUID())).toBe(false);
    }
    expect(await proofBudgetAvailable({ ...config, PROVER: undefined })).toBe(false);
    expect(await proofBudgetAvailable({ ...config, TIMEOUT_PROOF_PROFILE: 'unknown' })).toBe(false);
    const id = crypto.randomUUID();
    expect(await reserveProofAdmission(config, id)).toBe(true);
    const ids = Array.from({ length: 999 }, () => crypto.randomUUID());
    await env.DB.prepare(`INSERT INTO timeout_proof_admissions(game_id,rules_version,profile_version,credits,period,created_at)
      SELECT value,?,?,2,period,? FROM json_each(?) CROSS JOIN timeout_proof_months LIMIT 999`)
      .bind(PROOF_RULES_VERSION, PROOF_PROFILE, Date.now(), JSON.stringify(ids)).run();
    const nextMonth = Date.UTC(2028, 0, 1);
    expect(await reserveProofAdmission(config, crypto.randomUUID(), nextMonth)).toBe(false);
    expect(await reserveProofAdmission(config, id, nextMonth)).toBe(true);
    expect(await proofBudgetStatus(config, nextMonth)).toMatchObject({ used: 0, retained: 1000, retainedLimit: 1000 });
    const unavailable = { ...config, DB: { prepare: () => { throw new Error('outage'); } } } as unknown as Env;
    await expect(reserveProofAdmission(unavailable, crypto.randomUUID())).rejects.toMatchObject({ code: 'PROOF_BUDGET_UNAVAILABLE', status: 503 });
    await expect(proofBudgetAvailable(unavailable)).rejects.toMatchObject({ code: 'PROOF_BUDGET_UNAVAILABLE', status: 503 });
  });
});

type Harness = Pick<TimeoutProver, 'fetch' | 'start' | 'stop' | 'lifecycleStatus' | 'expireProofAllocation' | 'startAndWaitForPorts'> & {
  pending: Map<string, Promise<unknown>>;
  recoverInterrupted(): Promise<void>;
  native(request: TimeoutProofRequest, signal: AbortSignal): Promise<unknown>;
  nativeTransport(request: Request): Promise<Response>;
  waitForPort: ReturnType<typeof vi.fn>;
};
type Platform = { running: boolean; start: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; schedule: ReturnType<typeof vi.fn> };

async function withPool(test: (pool: Harness, state: DurableObjectState, native: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>, platform: Platform) => Promise<void>) {
  const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
  await runInDurableObject(carrier, async (_instance, state) => {
    initializeProofPool(state.storage.sql);
    const native = vi.fn(async (input: TimeoutProofRequest) => unknownProof(input, 'solver-undetermined'));
    const platform = { running: false, start: vi.fn(), destroy: vi.fn(), schedule: vi.fn(async () => ({})) };
    platform.start.mockImplementation(() => { platform.running = true; });
    platform.destroy.mockImplementation(async () => { platform.running = false; });
    const config = { ...configured(), PROVER: { idFromName: (name: string) => name === PROOF_INSTANCE ? state.id : env.GAME.idFromName(name) } as unknown as Env['PROVER'] };
    const pool = Object.assign(Object.create(TimeoutProver.prototype), { ctx: state, env: config, pending: new Map(),
      tail: Promise.resolve(), native, startCalls: 0, stopCalls: new Set(), allocationCancellation: new AbortController(),
      nativeRunning: () => platform.running, issueNativeStart: platform.start, stopNative: platform.destroy,
      schedule: platform.schedule, deleteSchedules: vi.fn(), renewActivityTimeout: vi.fn(), watchNative: vi.fn(), waitForPort: vi.fn(async () => 0),
    }) as Harness;
    const stop = vi.spyOn(pool, 'stop');
    await test(pool, state, native, stop, platform);
  });
}

describe('finite private proof pool', () => {
  it('rejects public URLs, malformed or unreserved requests before starting a native job', async () => {
    await withPool(async (pool, _state, native) => {
      const input = await request();
      expect((await pool.fetch(post(input, 'https://chess.ejmlabs.com/prove'))).status).toBe(404);
      expect((await pool.fetch(new Request('http://proof.internal/prove'))).status).toBe(404);
      expect((await pool.fetch(post(input, 'http://proof.internal/prove?fen=arbitrary'))).status).toBe(404);
      expect((await pool.fetch(post({ ...input, cpu: 100 }))).status).toBe(422);
      expect((await pool.fetch(post({ ...input, positionDigest: '0'.repeat(64) }))).status).toBe(422);
      expect((await pool.fetch(post(input))).status).toBe(403);
      expect(native).not.toHaveBeenCalled();
    });
  });

  it('reuses acknowledged receipts, permits only a transient second attempt and enforces two credits per game', async () => {
    await withPool(async (pool, _state, native) => {
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      native.mockImplementation(async (value: TimeoutProofRequest) => unknownProof(value, 'transient-start'));
      const first = await (await pool.fetch(post(input))).json();
      expect(await (await pool.fetch(post(input))).json()).toEqual(first);
      expect(native).toHaveBeenCalledOnce();
      expect((await pool.fetch(post({ ...input, expiresAt: input.expiresAt - 1 }))).status).toBe(409);
      expect((await pool.fetch(post({ ...input, attempt: 2, survivor: 'w', ...await proofDigests({ ...input, survivor: 'w' }) }))).status).toBe(409);
      const second = { ...input, attempt: 2 };
      native.mockImplementation(async (value: TimeoutProofRequest) => unknownProof(value, 'solver-undetermined'));
      expect(await (await pool.fetch(post(second))).json()).toMatchObject({ attempt: 2, reason: 'solver-undetermined' });
      expect(await (await pool.fetch(post(second))).json()).toMatchObject({ attempt: 2 });
      const changed = { ...input, pendingVersion: 4, requestId: `timeout:${input.gameId}:4` };
      Object.assign(changed, await proofDigests(changed));
      expect((await pool.fetch(post(changed))).status).toBe(409);
      expect(native).toHaveBeenCalledTimes(2);
      const deterministic = await request();
      await reserveProofAdmission(configured(), deterministic.gameId);
      await pool.fetch(post(deterministic));
      expect((await pool.fetch(post({ ...deterministic, attempt: 2 }))).status).toBe(409);
      expect(native).toHaveBeenCalledTimes(3);
    });
  });

  it('serializes four admitted requests, shares one in-flight receipt and rejects excess live work', async () => {
    await withPool(async (pool, _state, native) => {
      const inputs = await Promise.all(Array.from({ length: 5 }, () => request()));
      await Promise.all(inputs.map(input => reserveProofAdmission(configured(), input.gameId)));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let active = 0;
      let peak = 0;
      native.mockImplementation(async (input: TimeoutProofRequest) => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return unknownProof(input, 'solver-undetermined');
      });
      const calls = inputs.slice(0, 4).map(input => pool.fetch(post(input)));
      await vi.waitFor(() => { expect(pool.pending.size).toBe(4); });
      const duplicate = pool.fetch(post(inputs[0]));
      expect((await pool.fetch(post(inputs[4]))).status).toBe(429);
      expect(native).toHaveBeenCalledOnce();
      release();
      const responses = await Promise.all([...calls, duplicate]);
      expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
      expect(native).toHaveBeenCalledTimes(4);
      expect(peak).toBe(1);
    });
  });

  it('kills orphaned work on controller recovery and consumes its receipt without rerunning it', async () => {
    await withPool(async (pool, state, native, stop) => {
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const digest = await proofHash([input.requestId, input.attempt, input.positionDigest, input.expiresAt]);
      state.storage.sql.exec('INSERT INTO proof_attempts(id,game_id,attempt,digest,created_at) VALUES(?,?,?,?,?)',
        `${input.requestId}:1`, input.gameId, 1, digest, Date.now());
      await state.storage.sync();
      await pool.recoverInterrupted();
      expect(stop).toHaveBeenCalledWith('SIGKILL');
      expect(await (await pool.fetch(post(input))).json()).toMatchObject({ verdict: 'unknown', reason: 'interrupted' });
      expect(native).not.toHaveBeenCalled();
      expect(await (await pool.fetch(post({ ...input, attempt: 2 }))).json()).toMatchObject({ attempt: 2, verdict: 'unknown' });
      expect(native).toHaveBeenCalledOnce();
    });
  });

  it('stops the whole Container after a failed native transport and never starts an expired job', async () => {
    await withPool(async (pool, _state, native, stop, platform) => {
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      native.mockImplementation((value: TimeoutProofRequest, signal: AbortSignal) => TimeoutProver.prototype['native'].call(pool as unknown as TimeoutProver, value, signal));
      pool.waitForPort.mockRejectedValue(new Error('cold-start failure'));
      expect(await (await pool.fetch(post(input))).json()).toMatchObject({ verdict: 'unknown', reason: 'transient-start' });
      expect(stop).toHaveBeenCalledWith('SIGKILL');
      expect(platform.running).toBe(false);
      const expired = await request();
      await reserveProofAdmission(configured(), expired.gameId);
      vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt);
      expect(await (await pool.fetch(post(expired))).json()).toMatchObject({ verdict: 'unknown', reason: 'expired' });
      expect(platform.start).toHaveBeenCalledOnce();
    });
  });
});

describe('durable proof allocation lifecycle', () => {
  function starting(pool: Harness, native: ReturnType<typeof vi.fn>) {
    native.mockImplementation(async (value: TimeoutProofRequest) => {
      await pool.start();
      return unknownProof(value, 'solver-undetermined');
    });
  }

  it('keeps one fixed allocation deadline during traffic, clips it to Game expiry and ignores stale callbacks', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      starting(pool, native);
      const first = await request();
      await reserveProofAdmission(configured(), first.gameId);
      await pool.fetch(post(first));
      const initial = pool.lifecycleStatus();
      expect(initial).toMatchObject({ generation: 1, deadline: now + PROOF_ALLOCATION_MS,
        reservedMilliseconds: PROOF_ALLOCATION_MS, startIssued: true, invoiceHardCap: false });
      clock.mockReturnValue(now + 2_000);
      const next = await request();
      await reserveProofAdmission(configured(), next.gameId);
      await pool.fetch(post(next));
      expect(pool.lifecycleStatus()).toMatchObject({ generation: 1, deadline: initial.deadline,
        reservedMilliseconds: initial.reservedMilliseconds, observedMilliseconds: 2_000 });
      expect(platform.start).toHaveBeenCalledOnce();
      expect(platform.schedule).toHaveBeenCalledOnce();
      await pool.expireProofAllocation({ generation: 0 });
      expect(platform.destroy).not.toHaveBeenCalled();
      await pool.expireProofAllocation({ generation: 1 });
      expect(platform.running).toBe(false);
      const short = { ...await request(), expiresAt: now + 2_900 };
      await reserveProofAdmission(configured(), short.gameId);
      await pool.fetch(post(short));
      expect(pool.lifecycleStatus()).toMatchObject({ generation: 2, deadline: short.expiresAt,
        reservedMilliseconds: PROOF_ALLOCATION_MS + 900 });
    });
  });

  it('stops a completed allocation on controller recovery without rerunning or recharging its receipt', async () => {
    await withPool(async (pool, state, native, _stop, platform) => {
      starting(pool, native);
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const saved = await (await pool.fetch(post(input))).json();
      expect(platform.running).toBe(true);
      const before = pool.lifecycleStatus();
      await pool.recoverInterrupted();
      expect(platform.destroy).toHaveBeenCalledOnce();
      expect(pool.lifecycleStatus()).toMatchObject({ phase: 'idle', stopDebt: false, destroyConfirmed: true,
        generation: before.generation, reservedMilliseconds: before.reservedMilliseconds });
      expect(await (await pool.fetch(post(input))).json()).toEqual(saved);
      expect(native).toHaveBeenCalledOnce();
      expect(state.storage.sql.exec<{ native_generation: number }>('SELECT native_generation FROM proof_attempts').one().native_generation).toBe(1);
    });
  });

  it('retains three failed stops across restart, blocks new work and keeps saved results readable', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      starting(pool, native);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const saved = await (await pool.fetch(post(input))).json();
      platform.destroy.mockRejectedValue(new Error('provider unavailable'));
      await pool.recoverInterrupted();
      expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: true, stopExhausted: true, stopAttempts: PROOF_STOP_ATTEMPTS });
      // A restarted controller has no local calls, but a false native bit alone
      // cannot fence the previously issued start without a saved destroy reply.
      platform.running = false;
      await pool.recoverInterrupted();
      expect(platform.destroy).toHaveBeenCalledTimes(PROOF_STOP_ATTEMPTS);
      expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: true, destroyConfirmed: false });
      expect(log).toHaveBeenCalledTimes(1);
      expect(await (await pool.fetch(post(input))).json()).toEqual(saved);
      const next = await request();
      await reserveProofAdmission(configured(), next.gameId);
      expect((await pool.fetch(post(next))).status).toBe(503);
      expect(native).toHaveBeenCalledOnce();
    });
  });

  it('accepts a late known destroy after exhaustion without a fourth stop or fresh lifetime', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      starting(pool, native);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      await pool.fetch(post(input));
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      platform.destroy.mockImplementation(async () => { await gate; platform.running = false; });
      const stopped = pool.stop('SIGKILL').catch(() => {});
      await vi.waitFor(() => { expect(platform.destroy).toHaveBeenCalledTimes(1); });
      // Keep the real bounded waits here: fake timers do not exercise workerd's
      // storage sync and outstanding platform promise settlement together.
      await stopped;
      expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: true, stopExhausted: true, destroyConfirmed: false });
      expect(platform.destroy).toHaveBeenCalledTimes(PROOF_STOP_ATTEMPTS);
      expect(log).toHaveBeenCalledOnce();
      const reserved = pool.lifecycleStatus().reservedMilliseconds;
      finish();
      await vi.waitFor(() => { expect(pool.lifecycleStatus()).toMatchObject({ phase: 'idle', stopDebt: false, destroyConfirmed: true }); });
      await pool.recoverInterrupted();
      expect(platform.destroy).toHaveBeenCalledTimes(PROOF_STOP_ATTEMPTS);
      expect(pool.lifecycleStatus().reservedMilliseconds).toBe(reserved);
    });
  });

  it('requires a destructive barrier for a pending start after restart even while native running is false', async () => {
    await withPool(async (pool, state, native, _stop, platform) => {
      starting(pool, native);
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      await pool.fetch(post(input));
      platform.running = false;
      await pool.recoverInterrupted();
      expect(platform.destroy).toHaveBeenCalledOnce();
      expect(pool.lifecycleStatus()).toMatchObject({ phase: 'idle', destroyConfirmed: true, stopDebt: false });
      expect(proofLifecycle(state.storage.sql).generation).toBe(1);
      expect(native).toHaveBeenCalledOnce();
    });
  });

  it('keeps other lost stop replies as durable debt after one destroy succeeds and the controller restarts', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      starting(pool, native);
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const saved = await (await pool.fetch(post(input))).json();
      let finishFirst!: () => void;
      let finishRest!: () => void;
      const first = new Promise<void>(resolve => { finishFirst = resolve; });
      const rest = new Promise<void>(resolve => { finishRest = resolve; });
      platform.destroy.mockImplementationOnce(async () => { await first; platform.running = false; })
        .mockImplementation(async () => { await rest; platform.running = false; });
      const stopped = pool.stop('SIGKILL').catch(() => {});
      await vi.waitFor(() => { expect(platform.destroy).toHaveBeenCalledTimes(2); }, { timeout: 2_000 });
      finishFirst();
      await stopped;
      expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: true, destroyConfirmed: true, pendingStops: 2,
        stopAttempts: PROOF_STOP_ATTEMPTS });
      const restarted = Object.assign(Object.create(TimeoutProver.prototype), pool, {
        stopCalls: new Set(), stopping: undefined, startCalls: 0,
      }) as Harness;
      await restarted.recoverInterrupted();
      expect(restarted.lifecycleStatus()).toMatchObject({ stopDebt: true, pendingStops: 2, destroyConfirmed: true });
      expect(platform.destroy).toHaveBeenCalledTimes(PROOF_STOP_ATTEMPTS);
      expect(await (await restarted.fetch(post(input))).json()).toEqual(saved);
      const next = await request();
      await reserveProofAdmission(configured(), next.gameId);
      expect((await restarted.fetch(post(next))).status).toBe(503);
      // Settle the original test promises so the fixture leaves no local work.
      finishRest();
      await vi.waitFor(() => { expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: false, pendingStops: 0 }); });
    });
  });

  it('migrates legacy receipts without granting fresh native lifetime', async () => {
    await withPool(async (pool, state, native, _stop, platform) => {
      state.storage.sql.exec('DROP TABLE proof_attempts');
      state.storage.sql.exec('DROP TABLE proof_lifecycle');
      state.storage.sql.exec(`CREATE TABLE proof_attempts
        (id TEXT PRIMARY KEY,game_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
        digest TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,UNIQUE(game_id,attempt))`);
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const digest = await proofHash([input.requestId, input.attempt, input.positionDigest, input.expiresAt]);
      const saved = unknownProof(input, 'solver-undetermined');
      state.storage.sql.exec('INSERT INTO proof_attempts VALUES(?,?,?,?,?,?)', `${input.requestId}:1`, input.gameId, 1,
        digest, JSON.stringify(saved), Date.now());
      initializeProofPool(state.storage.sql);
      expect(pool.lifecycleStatus()).toMatchObject({ generation: 0, stopDebt: true, startIssued: true });
      await pool.recoverInterrupted();
      expect(platform.destroy).toHaveBeenCalledOnce();
      expect(pool.lifecycleStatus()).toMatchObject({ generation: 0, reservedMilliseconds: 0, destroyConfirmed: true, stopDebt: false });
      expect(await (await pool.fetch(post(input))).json()).toEqual(saved);
      expect(native).not.toHaveBeenCalled();
      expect(state.storage.sql.exec('SELECT native_generation FROM proof_attempts').one().native_generation).toBeNull();
    });
  });

  it('retains stop debt while local readiness is pending even after native destruction resolves', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let ready!: () => void;
      const gate = new Promise<void>(resolve => { ready = resolve; });
      pool.waitForPort.mockImplementation(async () => { await gate; return 0; });
      native.mockImplementation((value: TimeoutProofRequest, signal: AbortSignal) => TimeoutProver.prototype['native'].call(pool as unknown as TimeoutProver, value, signal));
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const response = pool.fetch(post(input));
      await vi.waitFor(() => { expect(pool.waitForPort).toHaveBeenCalledOnce(); });
      await expect(pool.stop('SIGKILL')).rejects.toThrow('proof_stop_unconfirmed');
      expect(platform.running).toBe(false);
      expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: true, destroyConfirmed: true });
      ready();
      expect(await (await response).json()).toMatchObject({ verdict: 'unknown', reason: 'transient-start' });
      expect(pool.lifecycleStatus()).toMatchObject({ stopDebt: false, phase: 'idle' });
      expect(platform.destroy).toHaveBeenCalledTimes(PROOF_STOP_ATTEMPTS);
    });
  });

  it('fails closed before a native start when the persisted absolute stop schedule fails', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      starting(pool, native);
      platform.schedule.mockRejectedValue(new Error('alarm unavailable'));
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const saved = await (await pool.fetch(post(input))).json();
      expect(saved).toMatchObject({ verdict: 'unknown', reason: 'interrupted' });
      expect(platform.start).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      expect(pool.lifecycleStatus()).toMatchObject({ scheduleFailed: true, startIssued: false });
      await pool.recoverInterrupted();
      expect(await (await pool.fetch(post(input))).json()).toEqual(saved);
      const next = await request();
      await reserveProofAdmission(configured(), next.gameId);
      expect((await pool.fetch(post(next))).status).toBe(503);
    });
  });

  it('fences public SDK start entry points and never reissues a synchronously failed charged start', async () => {
    await withPool(async (pool, _state, native, _stop, platform) => {
      // Model an unhealthy SDK cache to exercise its inherited auto-start path.
      // This metadata is never used by the product as native stop confirmation.
      Object.assign(pool, { state: { getState: async () => ({ status: 'stopped' }) } });
      Object.defineProperty(pool, 'container', { value: { get running() { return platform.running; } } });
      await expect(pool.start()).rejects.toThrow('proof_start_closed');
      await expect(pool.startAndWaitForPorts(8080)).rejects.toThrow('proof_start_closed');
      expect((await Container.prototype.containerFetch.call(pool as unknown as TimeoutProver,
        new Request('http://proof.internal/prove'), 8080)).status).toBe(500);
      platform.start.mockImplementation(() => { throw new Error('start validation failed'); });
      native.mockImplementation(async (value: TimeoutProofRequest) => {
        await expect(pool.startAndWaitForPorts({ ports: 8080 })).rejects.toThrow('start validation failed');
        await expect(pool.startAndWaitForPorts(8080)).rejects.toThrow('proof_generation_already_started');
        await expect(pool.start()).rejects.toThrow('proof_generation_already_started');
        expect((await Container.prototype.containerFetch.call(pool as unknown as TimeoutProver,
          new Request('http://proof.internal/prove'), 8080)).status).toBe(500);
        return unknownProof(value, 'interrupted');
      });
      const input = await request();
      await reserveProofAdmission(configured(), input.gameId);
      const saved = await (await pool.fetch(post(input))).json();
      expect(platform.start).toHaveBeenCalledOnce();
      expect(pool.lifecycleStatus()).toMatchObject({ generation: 1, startIssued: true });
      expect(await (await pool.fetch(post(input))).json()).toEqual(saved);
      expect(native).toHaveBeenCalledOnce();
    });
  });
});
