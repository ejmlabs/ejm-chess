import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../src/server/game';
import type { Env } from '../src/server/env';
import type { GameResult, GameSnapshot, RatingState } from '../src/shared/protocol';
import {
  PROOF_INSTANCE, PROOF_PROFILE, PROOF_RULES_VERSION, proofDigests, proofHash, unknownProof,
  type TimeoutProofRequest, type TimeoutProofResult,
} from '../src/server/proof-contract';
import { initializeProofPool, TimeoutProver } from '../src/server/proof-pool';
import { player } from './authority-helpers';

const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
type TestPool = Pick<TimeoutProver, 'fetch' | 'stop' | 'lifecycleStatus'>;
type Attempt = { id: string; game_id: string; attempt: number; digest: string; result: string; native_generation: number };
type Delivery = { result: GameResult; attempts: number; nextAttemptAt: number };
type ProofWork = { request: TimeoutProofRequest; pendingVersion: number; attempt: number; deliveries: number; done: boolean };

afterEach(() => { vi.restoreAllMocks(); });

function nativeReceipt(input: TimeoutProofRequest): TimeoutProofResult {
  return { ...unknownProof(input, 'solver-undetermined'), verdict: 'winnable', reason: null,
    witness: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] };
}

// Explicit native-platform and native-response adapters. All admission,
// identity, lifecycle, receipt, Game and rating logic below is production code.
// This is not a native Container, solver, cold-start, resource or billing test.
async function nativeAdapters() {
  const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
  let pool!: TestPool;
  let poolId!: DurableObjectId;
  let running = false;
  const nativeInputs: TimeoutProofRequest[] = [];
  const forwardErrors: string[] = [];
  const start = vi.fn(() => { running = true; });
  const destroy = vi.fn(async () => { running = false; });
  const transport = vi.fn(async (request: Request) => {
    const input = await request.json() as TimeoutProofRequest;
    nativeInputs.push(input);
    return Response.json(nativeReceipt(input));
  });
  const binding = {
    idFromName: (name: string) => name === PROOF_INSTANCE ? poolId : env.GAME.idFromName(name),
    get: (id: DurableObjectId) => {
      if (!id.equals(poolId)) throw new Error('test_proof_singleton_required');
      return { fetch: async (request: Request) => {
        const input = await request.json() as TimeoutProofRequest;
        return post(input);
      } };
    },
  } as unknown as NonNullable<Env['PROVER']>;
  const config: Env = { ...env, RANKED_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false',
    TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '1000', PROVER: binding };

  await runInDurableObject(carrier, (_instance, state) => {
    poolId = state.id;
    initializeProofPool(state.storage.sql);
    // The current test pool has no ctx.container. Replace only native handles
    // and SDK scheduling, preserving TimeoutProver.native/start/stop/fetch.
    pool = Object.assign(Object.create(TimeoutProver.prototype), { ctx: state, env: config,
      pending: new Map(), tail: Promise.resolve(), startCalls: 0, stopCalls: new Set(),
      allocationCancellation: new AbortController(), nativeRunning: () => running,
      issueNativeStart: start, stopNative: destroy, watchNative: () => {}, nativeTransport: transport,
      schedule: vi.fn(async () => ({})), deleteSchedules: vi.fn(), renewActivityTimeout: vi.fn(),
      waitForPort: vi.fn(async () => 0),
    }) as TestPool;
  });

  async function post(input: TimeoutProofRequest): Promise<Response> {
    // Buffer inside each request context, as a test-local transport adapter.
    const localCarrier = env.GAME.get(env.GAME.idFromString(poolId.toString()));
    const reply = await runInDurableObject(localCarrier, async () => {
      const response = await pool.fetch(new Request('http://proof.internal/prove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }));
      return { status: response.status, body: await response.text() };
    }).catch(error => { forwardErrors.push(String(error)); throw error; });
    return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }

  return { binding, config, post, nativeInputs, forwardErrors, start, destroy, transport,
    attempts: () => runInDurableObject(carrier, (_instance, state) =>
      state.storage.sql.exec<Attempt>('SELECT id,game_id,attempt,digest,result,native_generation FROM proof_attempts').toArray()),
    status: () => runInDurableObject(carrier, () => pool.lifecycleStatus()),
    stop: () => runInDurableObject(carrier, () => pool.stop('SIGKILL')) };
}

async function rankedMatch(adapters: Awaited<ReturnType<typeof nativeAdapters>>) {
  await runInDurableObject(competition, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = adapters.config;
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
    for (const table of ['ranked_proof_slots', 'matches', 'slots', 'queue']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
  const [a, b] = await Promise.all([player(), player()]);
  await competition.joinQueue(a, 'blitz');
  const queue = await competition.joinQueue(b, 'blitz');
  if (queue.status !== 'reserved' && queue.status !== 'live') throw new Error('test_match_not_admitted');
  const game = env.GAME.get(env.GAME.idFromName(queue.gameId));
  await runInDurableObject(game, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = adapters.config;
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  const initial = await game.snapshot(a);
  const white = initial.white.id === a.id ? a : b;
  const black = initial.white.id === a.id ? b : a;
  const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
  const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  expect([first.ok, second.ok]).toEqual([true, true]);
  expect(second.snapshot.status).toBe('active');
  return { game, white, black, active: second.snapshot };
}

async function gameRecord<T>(game: DurableObjectStub<Game>, table: 'timeout_proof_work' | 'result_delivery'): Promise<T | null> {
  return runInDurableObject(game, (_instance, state) => {
    const row = state.storage.sql.exec<{ value: string }>(`SELECT value FROM ${table} WHERE id=1`).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  });
}

async function receiptIdentity(request: TimeoutProofRequest, active: GameSnapshot, pending: GameSnapshot, flagAt: number) {
  expect(request).toMatchObject({ gameId: active.id, reservationId: active.id, pendingVersion: pending.version,
    requestId: `timeout:${active.id}:${pending.version}`, attempt: 1, rulesVersion: PROOF_RULES_VERSION,
    initialFen: active.fen, fen: pending.fen, moves: [], survivor: 'b', expiresAt: flagAt + 30_000 });
  expect(await proofDigests(request)).toEqual({ historyDigest: request.historyDigest, positionDigest: request.positionDigest });
}

async function onceOnlySettlement(game: DurableObjectStub<Game>, result: GameResult, flagAt: number) {
  expect(result).toMatchObject({ status: 'finished', rated: true, endedAt: flagAt,
    rulesVersion: PROOF_RULES_VERSION, outcome: { winner: 'b', score: 0, reason: 'timeout-proof-win' } });
  const receipts = await runInDurableObject(competition, (_instance, state) => ({
    results: state.storage.sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE game_id=?', result.id).toArray(),
    final: state.storage.sql.exec('SELECT event_id,digest FROM processed_results WHERE game_id=?', result.id).toArray(),
    ratings: state.storage.sql.exec('SELECT score FROM rating_events WHERE game_id=?', result.id).toArray(),
    players: state.storage.sql.exec<{ value: string }>('SELECT value FROM ratings WHERE pool=? AND user_id IN (?,?)',
      result.format, result.white.id, result.black!.id).toArray().map(row => JSON.parse(row.value) as RatingState),
    slots: state.storage.sql.exec('SELECT profile,released_at FROM ranked_proof_slots WHERE game_id=?', result.id).toArray(),
  }));
  expect(receipts.results.map(row => JSON.parse(row.payload))).toEqual([result]);
  expect(receipts.final).toEqual([{ event_id: result.eventId, digest: result.terminalDigest }]);
  expect(receipts.ratings).toEqual([{ score: 0 }]);
  expect(receipts.players).toHaveLength(2);
  expect(receipts.players.map(rating => rating.games)).toEqual([1, 1]);
  expect(receipts.slots).toEqual([{ profile: PROOF_PROFILE, released_at: expect.any(Number) }]);
  expect(await env.DB.prepare('SELECT credits FROM timeout_proof_admissions WHERE game_id=?').bind(result.id).all())
    .toMatchObject({ results: [{ credits: 2 }] });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM budget_receipts WHERE kind='games' AND id=?")
    .bind(`ranked:${result.id}`).first('count')).toBe(1);
  expect(await gameRecord<Delivery>(game, 'result_delivery')).toBeNull();
}

async function oneNativeReceipt(adapters: Awaited<ReturnType<typeof nativeAdapters>>, request: TimeoutProofRequest) {
  const attempts = await adapters.attempts();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ id: `${request.requestId}:1`, game_id: request.gameId, attempt: 1,
    native_generation: 1, digest: await proofHash([request.requestId, 1, request.positionDigest, request.expiresAt]) });
  expect(JSON.parse(attempts[0].result)).toEqual(nativeReceipt(request));
  expect(adapters.nativeInputs).toEqual([request]);
  expect(adapters.start).toHaveBeenCalledOnce();
  expect(adapters.transport).toHaveBeenCalledOnce();
  expect(await adapters.status()).toMatchObject({ generation: 1, phase: 'active', startIssued: true, invoiceHardCap: false });
  await adapters.stop();
  expect(adapters.destroy).toHaveBeenCalledOnce();
  expect(await adapters.status()).toMatchObject({ generation: 1, phase: 'idle', stopDebt: false,
    pendingStops: 0, destroyConfirmed: true, invoiceHardCap: false });
}

describe('local timeout acceptance with explicit native adapters', () => {
  it('reuses one proof receipt through duplicate deliveries and settles one admitted ranked game once', async () => {
    const adapters = await nativeAdapters();
    try {
      const match = await rankedMatch(adapters);
      const flagAt = match.active.clocks.deadline!;
      vi.spyOn(Date, 'now').mockReturnValue(flagAt);
      const pending = await match.game.snapshot(match.white);
      expect(pending.status).toBe('pending-adjudication');
      expect((await competition.health()).timeoutProof.reserved).toBe(1);
      await match.game.resolveTimeoutProof();
      expect(adapters.forwardErrors).toEqual([]);
      const request = adapters.nativeInputs[0];
      await receiptIdentity(request, match.active, pending, flagAt);
      const duplicates = await Promise.all([adapters.post(request), adapters.post(request)]);
      const proof = await duplicates[0].json();
      expect(await duplicates[1].json()).toEqual(proof);
      expect(await match.game.acceptTimeoutProof(proof)).toBe(false);
      const result = (await match.game.status())!.result!;
      await match.game.flush();
      expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
      await match.game.flush();
      await onceOnlySettlement(match.game, result, flagAt);
      await oneNativeReceipt(adapters, request);
    } finally { await adapters.stop(); }
  });

  it('recovers omitted proof and settlement replies without another native credit or rating update', async () => {
    const adapters = await nativeAdapters();
    try {
      const match = await rankedMatch(adapters);
      const proofDeliveries: TimeoutProofRequest[] = [];
      const resultDeliveries: GameResult[] = [];
      await runInDurableObject(match.game, instance => {
        const internal = instance as unknown as { env: Env };
        internal.env = { ...internal.env,
          PROVER: { idFromName: adapters.binding.idFromName.bind(adapters.binding), get: () => ({ fetch: async (raw: Request) => {
            const request = await raw.json() as TimeoutProofRequest;
            proofDeliveries.push(request);
            const response = await adapters.post(request);
            if (response.ok && proofDeliveries.length === 1) throw new Error('test_proof_reply_omitted_after_commit');
            return response;
          } }) } as unknown as Env['PROVER'],
          COMPETITION: { idFromName: env.COMPETITION.idFromName.bind(env.COMPETITION), get: () => ({ settle: async (result: GameResult) => {
            resultDeliveries.push(result);
            const authority = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
            const acknowledgement = await authority.settle(result);
            if (acknowledgement.accepted && resultDeliveries.length === 1) throw new Error('test_settlement_reply_omitted_after_commit');
            return acknowledgement;
          } }) } as unknown as Env['COMPETITION'],
        };
      });
      const flagAt = match.active.clocks.deadline!;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(flagAt);
      const pending = await match.game.snapshot(match.white);
      await match.game.resolveTimeoutProof();
      expect(adapters.forwardErrors).toEqual([]);
      const interrupted = (await gameRecord<ProofWork>(match.game, 'timeout_proof_work'))!;
      expect(interrupted).toMatchObject({ attempt: 1, deliveries: 1, done: false });
      expect((await match.game.status())!.result!.status).toBe('pending-adjudication');
      expect((await adapters.attempts())[0].result).toEqual(expect.any(String));
      expect((await competition.health()).timeoutProof.reserved).toBe(1);
      clock.mockReturnValue(flagAt + 250);
      await match.game.resolveTimeoutProof();
      const request = interrupted.request;
      await receiptIdentity(request, match.active, pending, flagAt);
      expect(proofDeliveries).toEqual([request, request]);
      const result = (await match.game.status())!.result!;
      await match.game.flush();
      const retained = (await gameRecord<Delivery>(match.game, 'result_delivery'))!;
      expect(retained).toEqual({ result, attempts: 1, nextAttemptAt: flagAt + 2_250 });
      expect((await competition.health()).timeoutProof.reserved).toBe(0);
      await match.game.flush();
      expect(resultDeliveries).toEqual([result]);
      clock.mockReturnValue(retained.nextAttemptAt);
      await match.game.flush();
      expect(resultDeliveries).toEqual([result, result]);
      expect(await match.game.acceptTimeoutProof(await (await adapters.post(request)).json())).toBe(false);
      await onceOnlySettlement(match.game, result, flagAt);
      await oneNativeReceipt(adapters, request);
    } finally { await adapters.stop(); }
  });
});
