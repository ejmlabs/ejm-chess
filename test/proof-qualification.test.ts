import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { assertProofQualification, initializeQualification, parseQualificationCommand,
  ProofQualification, QualificationTimeoutProver, type ProofQualificationEnv } from '../src/server/proof-qualification';
import { unknownProof, type TimeoutProofRequest } from '../src/server/proof-contract';

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM timeout_proof_admissions'),
    env.DB.prepare('DELETE FROM timeout_proof_months'),
    env.DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'"),
  ]);
});

function isolated(): ProofQualificationEnv {
  return { ...env, GAME: undefined, COMPETITION: undefined, ASSETS: undefined, EMAIL: undefined,
    ANALYZER: undefined, ANALYSIS_QUEUE: undefined, ANALYSIS_DEAD_LETTER_QUEUE: undefined,
    TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0', NEW_WORK_STOPPED: 'true',
    RANKED_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false',
    ANALYSIS_ENABLED: 'false', AI_ENABLED: 'false', PROOF_QUALIFICATION_TOKEN: 'private-test-qualification-token-32-bytes',
    PROOF_QUALIFICATION_SCOPE: 'ejm-chess-proof-qualification-test',
    PROOF_QUALIFICATION_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
    PROOF_QUALIFICATION_CONTROL_NAMESPACE_ID: '1'.repeat(32), PROOF_QUALIFICATION_PROVER_NAMESPACE_ID: '2'.repeat(32),
    PROOF_QUALIFICATION_SOURCE_REVISION: 'a'.repeat(40), PROOF_QUALIFICATION_EXPIRES_AT: String(Date.now() + 60 * 60_000),
    PROOF_QUALIFICATION_TIER: 'lite', PROOF_QUALIFICATION: {}, PROVER: {},
  } as unknown as ProofQualificationEnv;
}

type Harness = Pick<ProofQualification, 'execute' | 'alarm'>;
async function withQualification(test: (harness: Harness, state: DurableObjectState, config: ProofQualificationEnv,
  fetch: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>, cold: ReturnType<typeof vi.fn>, restart: () => Harness) => Promise<void>) {
  const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
  await runInDurableObject(carrier, async (_instance, state) => {
    initializeQualification(state.storage.sql);
    const fetch = vi.fn(async (request: Request) => Response.json(unknownProof(await request.json() as TimeoutProofRequest, 'solver-undetermined')));
    const stop = vi.fn(async () => {});
    const cold = vi.fn(async () => {});
    const config = { ...isolated(), PROVER: { idFromName: () => state.id, get: () => ({ fetch, stopQualification: stop, coldQualification: cold }) } } as unknown as ProofQualificationEnv;
    const restart = () => Object.assign(Object.create(ProofQualification.prototype), { ctx: state, env: config, running: null }) as Harness;
    await test(restart(), state, config, fetch, stop, cold, restart);
    await state.storage.deleteAlarm();
  });
}

describe('isolated timeout qualification', () => {
  it('accepts only fixed commands and exact authenticated POST before reaching its private controller', async () => {
    expect(parseQualificationCommand({ operation: 'run', batch: 0 })).toEqual({ operation: 'run', batch: 0 });
    for (const body of [{ operation: 'run', batch: -1 }, { operation: 'run', batch: 32 }, { operation: 'run', batch: 0, fen: 'arbitrary' },
      { operation: 'inspect', batch: 0 }, { operation: 'stop', reset: true }, [], null]) expect(parseQualificationCommand(body)).toBeNull();
    const execute = vi.fn(async () => ({ ok: true as const, value: { reserved: 0 } }));
    const config = { ...isolated(), PROOF_QUALIFICATION: { idFromName: () => 'fixed', get: () => ({ execute }) } } as unknown as ProofQualificationEnv;
    const post = (url: string, authorization?: string, body = '{"operation":"inspect"}') => new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body,
    });
    const auth = `Bearer ${config.PROOF_QUALIFICATION_TOKEN}`;
    for (const request of [new Request('https://private.invalid/qualify'), post('https://private.invalid/qualify?batch=0', auth),
      post('https://private.invalid/another', auth), post('https://private.invalid/qualify'), post('https://private.invalid/qualify', 'Bearer wrong'),
      post('https://private.invalid/qualify', auth, '{"operation":"run","batch":0,"fen":"x"}')]) {
      expect((await worker.fetch(request, config)).ok).toBe(false);
    }
    expect(execute).not.toHaveBeenCalled();
    expect((await worker.fetch(post('https://private.invalid/qualify', auth), config)).status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects unreviewed tiers, expiry, source and any public gameplay binding', () => {
    const config = isolated();
    expect(assertProofQualification(config)).toBe(Number(config.PROOF_QUALIFICATION_EXPIRES_AT));
    for (const change of [{ PROOF_QUALIFICATION_TIER: 'unset' }, { PROOF_QUALIFICATION_EXPIRES_AT: String(Date.now() + 3 * 60 * 60_000) },
      { PROOF_QUALIFICATION_SOURCE_REVISION: 'latest' }, { PROOF_QUALIFICATION_DATABASE_ID: '00000000-0000-0000-0000-000000000000' },
      { GAME: env.GAME }, { EMAIL: {} }, { TIMEOUT_PROOF_PROFILE: 'cha-native-3484c7e6-v1' }]) {
      expect(() => assertProofQualification({ ...config, ...change } as ProofQualificationEnv)).toThrow();
    }
  });

  it('persists stop before initialization and retries an unacknowledged whole-Container stop after config changes', async () => {
    await withQualification(async (harness, state, config, fetch, stop, _cold, restart) => {
      stop.mockRejectedValueOnce(new Error('lost stop reply'));
      expect(await harness.execute({ operation: 'stop' })).toMatchObject({ ok: false });
      expect(await state.storage.getAlarm()).not.toBeNull();
      config.PROOF_QUALIFICATION_TIER = 'unset';
      harness = restart();
      await harness.alarm();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(await state.storage.getAlarm()).toBeNull();
      config.PROOF_QUALIFICATION_TIER = 'lite';
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_FROZEN' } });
      expect(await harness.execute({ operation: 'stop' })).toMatchObject({ ok: true, value: { stopped: true } });
      expect(stop).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('fences concurrent preparation, persists original requests and reuses a completed batch after restart', async () => {
    await withQualification(async (harness, state, _config, fetch, _stop, _cold, restart) => {
      const first = harness.execute({ operation: 'run', batch: 0 });
      expect(await harness.execute({ operation: 'run', batch: 1 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_BUSY' } });
      expect(await first).toMatchObject({ ok: true, value: { reserved: 4, activeBatch: null } });
      const saved = state.storage.sql.exec('SELECT id,request FROM qualification_jobs ORDER BY position').toArray();
      expect(fetch).toHaveBeenCalledTimes(4);
      harness = restart();
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: true, value: { reserved: 4 } });
      expect(state.storage.sql.exec('SELECT id,request FROM qualification_jobs ORDER BY position').toArray()).toEqual(saved);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM timeout_proof_admissions').first('n')).toBe(4);
    });
  });

  it('retains the original attempt and deadline through lost replies, then uses only a transient second credit', async () => {
    await withQualification(async (harness, state, _config, fetch, _stop, _cold, restart) => {
      const delivered: TimeoutProofRequest[] = [];
      fetch.mockImplementation(async (message: Request) => {
        const input = await message.json() as TimeoutProofRequest;
        delivered.push(input);
        if (input.gameId.endsWith('-0') && delivered.filter(item => item.gameId === input.gameId).length === 1) throw new Error('lost reply');
        return Response.json(unknownProof(input, input.gameId.endsWith('-0') && input.attempt === 1 ? 'transient-start' : 'solver-undetermined'));
      });
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: true });
      const first = delivered.filter(item => item.gameId.endsWith('-0'));
      expect(first.map(item => item.attempt)).toEqual([1, 1, 2]);
      expect(new Set(first.map(item => item.expiresAt)).size).toBe(1);
      expect(new Set(first.map(item => item.requestId)).size).toBe(1);
      const request = JSON.parse(state.storage.sql.exec<{ request: string }>('SELECT request FROM qualification_jobs WHERE position=1').one().request) as TimeoutProofRequest;
      state.storage.sql.exec("UPDATE qualification_jobs SET status='running',result=NULL,deliveries=1 WHERE position=1");
      state.storage.sql.exec('UPDATE qualification_control SET active_batch=0');
      harness = restart();
      expect(await harness.execute({ operation: 'run', batch: 1 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_BUSY' } });
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: true });
      expect(delivered.filter(item => item.gameId === request.gameId).at(-1)).toEqual(request);
    });
  });

  it('keeps the batch fence until all siblings settle after one admission call fails', async () => {
    await withQualification(async (harness, _state, config, fetch) => {
      let admissions = 0;
      config.DB = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
        if (++admissions === 1) throw new Error('one admission unavailable');
        return env.DB.batch(statements);
      } } as D1Database;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      fetch.mockImplementation(async (message: Request) => {
        const input = await message.json() as TimeoutProofRequest;
        await gate;
        return Response.json(unknownProof(input, 'solver-undetermined'));
      });
      const first = harness.execute({ operation: 'run', batch: 0 });
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(3); });
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_BUSY' } });
      release();
      expect(await first).toMatchObject({ ok: false });
      expect(await harness.execute({ operation: 'run', batch: 1 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_BUSY' } });
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(4);
    });
  });

  it('labels saved results with their original tier and disables changed configuration on inspection', async () => {
    await withQualification(async (harness, state, config) => {
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: true,
        value: { tier: 'lite', configuredTier: 'lite', configurationMatches: true, enabled: true } });
      config.PROOF_QUALIFICATION_TIER = 'basic';
      expect(await harness.execute({ operation: 'inspect' })).toMatchObject({ ok: true,
        value: { tier: 'lite', configuredTier: 'basic', configurationMatches: false, enabled: false } });
      config.PROOF_QUALIFICATION_TIER = 'lite';
      state.storage.sql.exec('UPDATE qualification_control SET corpus=?', 'f'.repeat(64));
      expect(await harness.execute({ operation: 'inspect' })).toMatchObject({ ok: true,
        value: { tier: 'lite', configuredTier: 'lite', configurationMatches: false, enabled: false } });
    });
  });

  it('runs only the fixed corpus and one four-request cold batch without minting more receipts', async () => {
    await withQualification(async (harness, _state, _config, fetch, _stop, cold, restart) => {
      const inspection = await harness.execute({ operation: 'inspect' });
      expect(inspection.ok).toBe(true);
      if (!inspection.ok) return;
      const count = inspection.value.batches;
      for (let batch = 0; batch < count; batch++) expect(await harness.execute({ operation: 'run', batch })).toMatchObject({ ok: true });
      const complete = await harness.execute({ operation: 'inspect' });
      expect(complete.ok).toBe(true);
      if (!complete.ok) return;
      expect(complete.value.reserved).toBeLessThanOrEqual(32);
      expect(complete.value.reserved).toBe(fetch.mock.calls.length);
      expect(complete.value.measurements.filter(item => item.batch === count - 1)).toHaveLength(4);
      expect(cold).toHaveBeenCalledOnce();
      harness = restart();
      expect(await harness.execute({ operation: 'run', batch: count - 1 })).toMatchObject({ ok: true, value: { reserved: complete.value.reserved } });
      expect(cold).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(complete.value.reserved);
    });
  });

  it('keeps inspect and run quota across restart while stop remains available', async () => {
    await withQualification(async (harness, state, _config, fetch, stop, _cold, restart) => {
      state.storage.sql.exec('UPDATE qualification_commands SET used=127');
      expect(await harness.execute({ operation: 'inspect' })).toMatchObject({ ok: true, value: { commands: 128 } });
      harness = restart();
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_QUOTA' } });
      expect(await harness.execute({ operation: 'inspect' })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_QUOTA' } });
      expect(await harness.execute({ operation: 'stop' })).toMatchObject({ ok: true, value: { stopped: true, commands: 128 } });
      expect(stop).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('freezes reviewed configuration and expires work without an unbounded stop-retry loop', async () => {
    await withQualification(async (harness, state, config, fetch, stop) => {
      expect(await harness.execute({ operation: 'run', batch: 0 })).toMatchObject({ ok: true });
      const original = config.PROOF_QUALIFICATION_EXPIRES_AT;
      config.PROOF_QUALIFICATION_EXPIRES_AT = String(Number(original) + 1_000);
      expect(await harness.execute({ operation: 'run', batch: 1 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_FROZEN' } });
      config.PROOF_QUALIFICATION_EXPIRES_AT = original;
      config.PROOF_QUALIFICATION_SOURCE_REVISION = 'b'.repeat(40);
      expect(await harness.execute({ operation: 'run', batch: 1 })).toMatchObject({ ok: false, error: { code: 'PROOF_QUALIFICATION_FROZEN' } });
      stop.mockRejectedValue(new Error('provider stop unavailable'));
      vi.spyOn(Date, 'now').mockReturnValue(Number(original));
      for (let attempt = 0; attempt < 6; attempt++) await expect(harness.alarm()).rejects.toThrow('provider stop unavailable');
      expect(await state.storage.getAlarm()).toBeNull();
      await harness.alarm();
      expect(stop).toHaveBeenCalledTimes(6);
      expect(await harness.execute({ operation: 'inspect' })).toMatchObject({ ok: true,
        value: { stopped: true, stopConfirmed: false, stopAttempts: 6 } });
      expect(fetch).toHaveBeenCalledTimes(4);
    });
  });

  it('prevents queued native work after a permanent qualification stop', async () => {
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE qualification_stop(id INTEGER PRIMARY KEY)');
      state.storage.sql.exec('INSERT INTO qualification_stop VALUES(1)');
      const input = { gameId: 'fixed-test-game' } as TimeoutProofRequest;
      const proof = Object.assign(Object.create(QualificationTimeoutProver.prototype), { ctx: state });
      expect(await proof.native(input, new AbortController().signal)).toMatchObject({ verdict: 'unknown', reason: 'interrupted' });
    });
  });
});
