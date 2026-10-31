import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { Actor, GameSnapshot, Pool } from '../src/shared/protocol';
import type { Env } from '../src/server/env';
import type { Game } from '../src/server/game';
import { PROOF_PROFILE, PROOF_RULES_VERSION, proofDigests, unknownProof, type TimeoutProofRequest } from '../src/server/proof-contract';
import { enableRanked, player } from './authority-helpers';

const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));

async function pauseGame(game: DurableObjectStub<Game>): Promise<void> {
  await runInDurableObject(game, async (instance, state) => {
    (instance as unknown as { schedule(): Promise<void> }).schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

async function prover(game: DurableObjectStub<Game>, fetcher: (request: Request) => Promise<Response>): Promise<void> {
  await runInDurableObject(game, instance => {
    const internal = instance as unknown as { env: Env };
    internal.env = { ...internal.env, PROVER: { idFromName: (name: string) => name, get: () => ({ fetch: fetcher }) } as unknown as Env['PROVER'] };
  });
}

async function pair(pool: Pool = 'blitz') {
  const [a, b] = await Promise.all([player(), player()]);
  await competition.joinQueue(a, pool);
  const queue = await competition.joinQueue(b, pool);
  if (queue.status !== 'reserved' && queue.status !== 'live') throw new Error('not_paired');
  const game = env.GAME.get(env.GAME.idFromName(queue.gameId));
  await enableRanked(game);
  await pauseGame(game);
  const initial = await game.snapshot(a);
  return { game, initial, white: initial.white.id === a.id ? a : b, black: initial.white.id === a.id ? b : a };
}

async function ready(match: Awaited<ReturnType<typeof pair>>): Promise<GameSnapshot> {
  const first = await match.game.command(match.white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: match.initial.version });
  const second = await match.game.command(match.black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  expect([first.ok, second.ok]).toEqual([true, true]);
  return second.snapshot;
}

async function savedRequest(game: DurableObjectStub<Game>): Promise<TimeoutProofRequest> {
  return runInDurableObject(game, (_instance, state) => {
    const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM timeout_proof_work').one();
    return (JSON.parse(row.value) as { request: TimeoutProofRequest }).request;
  });
}

// Game arbitration tests receive an already validated private receipt. The
// separate native corpus establishes whether this witness is actually proved.
function supported(input: TimeoutProofRequest, verdict: 'winnable' | 'unwinnable' = 'winnable') {
  return { ...unknownProof(input, 'solver-undetermined'), verdict, reason: null,
    witness: verdict === 'winnable' ? ['f2f3', 'e7e5', 'g2g4', 'd8h4'] : [] };
}

beforeEach(async () => {
  await runInDurableObject(competition, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...env, TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
    for (const table of ['ranked_proof_slots', 'matches', 'slots', 'queue']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
  await enableRanked(competition);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ranked timeout proof admission', () => {
  it('requires the exact profile and spend authority before creating a ranked game', async () => {
    const actor = await player();
    await runInDurableObject(competition, instance => {
      const internal = instance as unknown as { env: Env };
      internal.env = { ...internal.env, TIMEOUT_PROOF_PROFILE: 'off' };
    });
    expect(await competition.joinQueue(actor, 'blitz')).toMatchObject({ status: 'closed' });
    await enableRanked(competition);
    await env.DB.prepare("UPDATE operations_control SET games_stopped=1 WHERE id='product'").run();
    try { expect(await competition.joinQueue(actor, 'rapid')).toMatchObject({ status: 'closed' }); }
    finally { await env.DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'").run(); }
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const black = await player();
    await runInDurableObject(game, async instance => {
      await expect(instance.init({ id: crypto.randomUUID(), reservationId: crypto.randomUUID(), format: 'blitz', rated: true,
        white: actor, black, timeoutProof: { reservationId: crypto.randomUUID(), profileVersion: PROOF_PROFILE } }))
        .rejects.toThrow('ranked_proof_admission_required');
    });
  });

  it('holds four shared slots across formats until terminal acceptance, then admits one waiting pair', async () => {
    const matches = [];
    for (const pool of ['blitz', 'rapid', 'blitz', 'rapid'] as const) matches.push(await pair(pool));
    const [a, b] = await Promise.all([player(), player()]);
    expect(await competition.joinQueue(a, 'blitz')).toMatchObject({ status: 'queued' });
    expect(await competition.joinQueue(b, 'blitz')).toMatchObject({ status: 'queued' });
    expect((await competition.health()).timeoutProof).toMatchObject({ reserved: 4, creditsPerGame: 2 });
    const active = await ready(matches[0]);
    const flag = vi.spyOn(Date, 'now').mockReturnValue(active.clocks.deadline!);
    expect((await matches[0].game.snapshot(matches[0].white)).status).toBe('pending-adjudication');
    await matches[0].game.flush();
    expect((await competition.health()).timeoutProof.reserved).toBe(4);
    flag.mockReturnValue(active.clocks.deadline! + 30_000);
    expect((await matches[0].game.snapshot(matches[0].white)).outcome?.reason).toBe('timeout-win');
    await matches[0].game.flush();
    expect((await competition.health()).timeoutProof.reserved).toBe(3);
    flag.mockRestore();
    const next = await competition.queueStatus(a);
    expect(next.status).toBe('reserved');
    expect((await competition.health()).timeoutProof.reserved).toBe(4);
    const old = await runInDurableObject(competition, (_instance, state) =>
      state.storage.sql.exec('SELECT released_at FROM ranked_proof_slots WHERE game_id=?', active.id).one());
    expect(old.released_at).toEqual(expect.any(Number));
  });

  it('reconciles a lost initialization reply with one game, receipt and pair of proof credits', async () => {
    await runInDurableObject(competition, instance => {
      const internal = instance as unknown as { env: Env };
      const binding = internal.env.GAME;
      internal.env = { ...internal.env, GAME: { idFromName: binding.idFromName.bind(binding), get: (id: DurableObjectId) => {
        const game = binding.get(id);
        return { status: () => game.status(), init: async (input: Parameters<Game['init']>[0]) => {
          await game.init(input);
          throw new Error('initialization_reply_lost');
        } };
      } } as unknown as Env['GAME'] };
    });
    const match = await pair();
    await evictDurableObject(competition);
    await enableRanked(competition);
    expect(await competition.queueStatus(match.white)).toMatchObject({ status: 'reserved', gameId: match.initial.id });
    expect((await competition.health()).timeoutProof).toMatchObject({ reserved: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM timeout_proof_admissions WHERE game_id=?').bind(match.initial.id).first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT credits FROM timeout_proof_admissions WHERE game_id=?').bind(match.initial.id).first('credits')).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM budget_receipts WHERE kind='games' AND id=?").bind(`ranked:${match.initial.id}`).first('count')).toBe(1);
  });
});

describe('timeout proof result arbitration', () => {
  it('sends complete authoritative history once and rates the material timeout rule at the original deadline after a deterministic unknown', async () => {
    const match = await pair();
    let current = await ready(match);
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
    for (const move of moves) {
      const actor = current.turn === 'w' ? match.white : match.black;
      const reply = await match.game.command(actor, { type: 'move', id: crypto.randomUUID(), expectedVersion: current.version,
        from: move.slice(0, 2), to: move.slice(2, 4) });
      expect(reply.ok).toBe(true);
      current = reply.snapshot;
    }
    const flagAt = current.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    const fetcher = vi.fn(async (request: Request) => Response.json(unknownProof(await request.json() as TimeoutProofRequest, 'solver-undetermined')));
    await prover(match.game, fetcher);
    const pending = await match.game.snapshot(match.white);
    expect(pending).toMatchObject({ status: 'pending-adjudication', rulesVersion: PROOF_RULES_VERSION, endedAt: flagAt });
    await match.game.resolveTimeoutProof();
    const request = await savedRequest(match.game);
    expect(request).toMatchObject({ initialFen: new Chess().fen(), fen: pending.fen, moves, survivor: 'b',
      gameId: current.id, reservationId: current.id, pendingVersion: pending.version, attempt: 1, expiresAt: flagAt + 30_000 });
    expect(await proofDigests(request)).toEqual({ historyDigest: request.historyDigest, positionDigest: request.positionDigest });
    clock.mockReturnValue(flagAt + 1_000);
    await match.game.resolveTimeoutProof();
    expect(fetcher).toHaveBeenCalledOnce();
    clock.mockReturnValue(flagAt + 30_000);
    const ended = await match.game.snapshot(match.black);
    expect(ended).toMatchObject({ status: 'finished', endedAt: flagAt + 30_000, outcome: { winner: 'b', score: 0, reason: 'timeout-win' } });
    await match.game.flush();
    const ratings = await runInDurableObject(competition, (_instance, state) =>
      state.storage.sql.exec('SELECT 1 FROM rating_events WHERE game_id=?', ended.id).toArray());
    expect(ratings).toHaveLength(1);
  });

  it('finishes a ranked proof game with insufficient material at the flag without starting proof work', async () => {
    const match = await pair();
    const active = await ready(match);
    await runInDurableObject(match.game, (_instance, state) => {
      const stored = JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one().value);
      stored.initialFen = '7k/8/5KB1/8/8/8/8/8 w - - 0 1';
      stored.moves = [];
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(stored));
    });
    vi.spyOn(Date, 'now').mockReturnValue(active.clocks.deadline!);
    expect(await match.game.snapshot(match.white)).toMatchObject({ status: 'finished',
      outcome: { winner: null, score: 0.5, reason: 'timeout-insufficient-material' } });
    expect(await runInDurableObject(match.game, (_instance, state) => state.storage.sql.exec('SELECT 1 FROM timeout_proof_work').toArray())).toEqual([]);
  });

  it('accepts one exact private proof, rejects mismatches and duplicates, and rates only its final event', async () => {
    const match = await pair();
    const active = await ready(match);
    const flagAt = active.clocks.deadline!;
    vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    await match.game.snapshot(match.white);
    await match.game.resolveTimeoutProof();
    const request = await savedRequest(match.game);
    const proof = supported(request);
    for (const change of [{ survivor: 'w' }, { reservationId: crypto.randomUUID() }, { pendingVersion: request.pendingVersion + 1 },
      { historyDigest: 'a'.repeat(64) }, { positionDigest: 'b'.repeat(64) }, { expiresAt: request.expiresAt + 1 }]) {
      expect(await match.game.acceptTimeoutProof({ ...proof, ...change })).toBe(false);
    }
    const responses = await Promise.all([match.game.acceptTimeoutProof(proof), match.game.acceptTimeoutProof(proof)]);
    expect(responses.filter(Boolean)).toHaveLength(1);
    const final = await match.game.status();
    expect(final?.result).toMatchObject({ endedAt: flagAt, rulesVersion: PROOF_RULES_VERSION,
      outcome: { winner: 'b', score: 0, reason: 'timeout-proof-win' } });
    await match.game.flush();
    await match.game.flush();
    expect(await match.game.acceptTimeoutProof(proof)).toBe(false);
    const events = await runInDurableObject(competition, (_instance, state) =>
      state.storage.sql.exec('SELECT score FROM rating_events WHERE game_id=?', active.id).toArray());
    expect(events).toEqual([{ score: 0 }]);
  });

  it('rejects a proof at the original fallback deadline and cannot overwrite or re-rate its terminal result', async () => {
    const match = await pair();
    const active = await ready(match);
    const flagAt = active.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    await match.game.snapshot(match.white);
    await match.game.resolveTimeoutProof();
    const proof = supported(await savedRequest(match.game));
    clock.mockReturnValue(flagAt + 30_000);
    expect(await match.game.acceptTimeoutProof(proof)).toBe(false);
    const final = (await match.game.status())!.result!;
    expect(final.outcome).toMatchObject({ winner: 'b', score: 0, reason: 'timeout-win' });
    await match.game.flush();
    expect(await match.game.acceptTimeoutProof(proof)).toBe(false);
    expect((await match.game.status())!.result).toEqual(final);
    await match.game.flush();
    const ratings = await runInDurableObject(competition, (_instance, state) =>
      state.storage.sql.exec('SELECT score FROM rating_events WHERE game_id=?', active.id).toArray());
    expect(ratings).toEqual([{ score: 0 }]);
  });

  it('falls back to the material rule after both lost deliveries and rates the game once', async () => {
    const match = await pair();
    const active = await ready(match);
    const flagAt = active.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    const fetcher = vi.fn(async () => { throw new Error('reply_lost_after_pool_committed'); });
    await prover(match.game, fetcher);
    await match.game.snapshot(match.white);
    for (const offset of [0, 250, 500, 10_000]) {
      clock.mockReturnValue(flagAt + offset);
      await match.game.resolveTimeoutProof();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await match.game.status())!.status).toBe('pending-adjudication');
    clock.mockReturnValue(flagAt + 30_000);
    expect(await match.game.snapshot(match.black)).toMatchObject({ status: 'finished', endedAt: flagAt + 30_000,
      outcome: { winner: 'b', score: 0, reason: 'timeout-win' } });
    await match.game.flush();
    const ratings = await runInDurableObject(competition, (_instance, state) =>
      state.storage.sql.exec('SELECT score FROM rating_events WHERE game_id=?', active.id).toArray());
    expect(ratings).toEqual([{ score: 0 }]);
  });

  it('resolves a supported negative proof as a draw without granting either player a win', async () => {
    const match = await pair();
    const active = await ready(match);
    vi.spyOn(Date, 'now').mockReturnValue(active.clocks.deadline!);
    await match.game.snapshot(match.white);
    await match.game.resolveTimeoutProof();
    expect(await match.game.acceptTimeoutProof(supported(await savedRequest(match.game), 'unwinnable'))).toBe(true);
    expect((await match.game.status())!.result!.outcome).toMatchObject({ winner: null, score: 0.5, reason: 'timeout-proof-draw' });
  });

  it('uses at most one further native credit after a transient result and never extends its expiry', async () => {
    const match = await pair();
    const active = await ready(match);
    const flagAt = active.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    const requests: TimeoutProofRequest[] = [];
    const fetcher = vi.fn(async (raw: Request) => {
      const input = await raw.json() as TimeoutProofRequest;
      requests.push(input);
      return Response.json(unknownProof(input, input.attempt === 1 ? 'transient-start' : 'resource-limit'));
    });
    await prover(match.game, fetcher);
    await match.game.snapshot(match.white);
    await match.game.resolveTimeoutProof();
    clock.mockReturnValue(flagAt + 250);
    await match.game.resolveTimeoutProof();
    clock.mockReturnValue(flagAt + 1_000);
    await match.game.resolveTimeoutProof();
    expect(requests.map(input => input.attempt)).toEqual([1, 2]);
    expect(requests.map(input => input.expiresAt)).toEqual([flagAt + 30_000, flagAt + 30_000]);
    expect(requests[1].requestId).toBe(requests[0].requestId);
    clock.mockReturnValue(flagAt + 30_000);
    expect((await match.game.snapshot(match.white)).outcome).toMatchObject({ winner: 'b', reason: 'timeout-win' });
  });

  it('reconciles a lost proof reply after restart using the same request and credit', async () => {
    const match = await pair();
    const active = await ready(match);
    const flagAt = active.clocks.deadline!;
    vi.spyOn(Date, 'now').mockReturnValue(flagAt);
    const delivered: TimeoutProofRequest[] = [];
    await prover(match.game, async raw => {
      delivered.push(await raw.json() as TimeoutProofRequest);
      throw new Error('reply_lost_after_pool_committed');
    });
    await match.game.snapshot(match.white);
    await match.game.resolveTimeoutProof();
    await runInDurableObject(match.game, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM timeout_proof_work').one();
      const work = JSON.parse(row.value);
      work.nextAttemptAt = work.request.expiresAt;
      state.storage.sql.exec('UPDATE timeout_proof_work SET value=?', JSON.stringify(work));
    });
    await evictDurableObject(match.game);
    await pauseGame(match.game);
    await prover(match.game, async raw => {
      delivered.push(await raw.json() as TimeoutProofRequest);
      return Response.json(supported(delivered[0]));
    });
    await match.game.resolveTimeoutProof();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual(delivered[0]);
    expect((await match.game.status())!.result!.outcome.reason).toBe('timeout-proof-win');
  });
});
