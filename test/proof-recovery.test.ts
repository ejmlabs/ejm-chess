import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/server/env';
import { reserveProofAdmission } from '../src/server/proof-budget';
import { PROOF_PROFILE, PROOF_RULES_VERSION, proofHash } from '../src/server/proof-contract';
import { initializeProofPool } from '../src/server/proof-pool';
import { proofLifecycle } from '../src/server/proof-lifecycle';
import { RECOVERY_SCHEMA, type RecoveryPoint } from '../src/server/recovery';
import { captureProofCreditLedger, reapplyProofAdmissions, reapplyProofAttempts, validateRankedRecoveryManifest,
  type ProofCreditLedger, type RankedRecoveryManifest } from '../src/server/proof-recovery';
import { RATING_VERSION } from '../src/shared/protocol';

const config = { ...env, NEW_WORK_STOPPED: 'false', TIMEOUT_PROOF_PROFILE: PROOF_PROFILE,
  MONTHLY_PROOF_LIMIT: '1000', PROVER: {} as Env['PROVER'] };
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM timeout_proof_admissions'),
    env.DB.prepare('DELETE FROM timeout_proof_months'),
    env.DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'"),
  ]);
});

async function fixture(): Promise<{ ledger: ProofCreditLedger; gameId: string }> {
  const gameId = crypto.randomUUID();
  expect(await reserveProofAdmission(config, gameId)).toBe(true);
  const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
  const pool = await runInDurableObject(carrier, (_instance, ctx) => {
    initializeProofPool(ctx.storage.sql);
    return { attempts: [], lifecycle: proofLifecycle(ctx.storage.sql) };
  });
  return { gameId, ledger: await captureProofCreditLedger({ ...env, NEW_WORK_STOPPED: 'true' }, pool) };
}
async function seal(ledger: ProofCreditLedger): Promise<ProofCreditLedger> {
  return { ...ledger, sha256: await proofHash([ledger.schema, ledger.profile, ledger.capturedAt,
    ledger.admissions, ledger.months, ledger.attempts, ledger.lifecycle]) };
}

describe('four-authority proof recovery', () => {
  it('restores the admission union and monthly high-water once, including later preserved admissions', async () => {
    const { ledger, gameId } = await fixture();
    const later = crypto.randomUUID();
    expect(await reserveProofAdmission(config, later)).toBe(true);
    // Isolated rollback fixture: the first receipt is absent, while a later
    // authority survived. Reapplying must preserve their union without refund.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM timeout_proof_admissions WHERE game_id=?').bind(gameId),
      env.DB.prepare('UPDATE timeout_proof_months SET used=1'),
    ]);
    const stopped = { ...env, NEW_WORK_STOPPED: 'true' };
    await reapplyProofAdmissions(stopped, ledger);
    await reapplyProofAdmissions(stopped, ledger);
    expect(await env.DB.prepare('SELECT game_id FROM timeout_proof_admissions ORDER BY game_id').all())
      .toMatchObject({ results: [gameId, later].sort().map(id => ({ game_id: id })) });
    expect(await env.DB.prepare('SELECT used FROM timeout_proof_months').first('used')).toBe(2);
    await expect(reapplyProofAdmissions({ ...env, NEW_WORK_STOPPED: 'false' }, ledger))
      .rejects.toMatchObject({ code: 'PROOF_RECOVERY_UNVERIFIED' });
    await expect(reapplyProofAdmissions(stopped, { ...ledger, admissions: [] }))
      .rejects.toMatchObject({ code: 'PROOF_RECOVERY_UNVERIFIED' });
  });

  it('preserves consumed attempts and unresolved stop debt instead of starting a search after restore', async () => {
    const { ledger, gameId } = await fixture();
    const saved = await seal({ ...ledger, attempts: [1, 2].map(attempt => ({ id: `timeout:${gameId}:3:${attempt}`,
      game_id: gameId, attempt: attempt as 1 | 2, digest: String(attempt).repeat(64), created_at: ledger.capturedAt,
      native_generation: attempt })), lifecycle: { ...ledger.lifecycle, generation: 2, phase: 'stopping',
      reserved_at: ledger.capturedAt, observed_at: ledger.capturedAt, deadline: ledger.capturedAt + 22_500,
      reserved_ms: 45_000, stop_attempts: 3, stop_pending: 1, start_issued: 1, stop_debt: 1 } });
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, (_instance, ctx) => {
      initializeProofPool(ctx.storage.sql);
      ctx.storage.transactionSync(() => reapplyProofAttempts(ctx.storage.sql, saved));
      expect(ctx.storage.sql.exec('SELECT attempt,result FROM proof_attempts ORDER BY attempt').toArray())
        .toEqual([{ attempt: 1, result: null }, { attempt: 2, result: null }]);
      expect(proofLifecycle(ctx.storage.sql)).toMatchObject({ generation: 2, phase: 'stopping', reserved_ms: 45_000,
        stop_attempts: 3, stop_pending: 1, stop_debt: 1, destroy_confirmed: 0 });
      // A caller cannot erase unresolved debt by replaying an older idle ledger.
      expect(() => ctx.storage.transactionSync(() => reapplyProofAttempts(ctx.storage.sql, ledger)))
        .toThrow('Preserve the complete proof-credit ledger');
    });
  });

  it('requires D1, Competition, Prover and every admitted Game in the same reviewed recovery manifest', async () => {
    const { ledger, gameId } = await fixture();
    const point = (kind: RecoveryPoint['kind'], name: string, digit: string): RecoveryPoint => ({
      schema: RECOVERY_SCHEMA, kind, name, objectId: digit.repeat(64), bookmark: `native-${name}`,
      capturedAt: ledger.capturedAt, alarm: null, policies: { rules: PROOF_RULES_VERSION, ratings: RATING_VERSION },
      authority: { sha256: digit.repeat(64), rows: 1, bytes: 100 }, metadata: {},
    });
    const manifest: RankedRecoveryManifest = { schema: 'ejm-chess-four-authority-recovery-v1',
      databaseId: '11111111-1111-1111-1111-111111111111', d1Bookmark: 'native-d1', credits: ledger,
      competition: point('Competition', 'global', '1'), prover: point('TimeoutProver', 'timeout-proof-v1-singleton', '2'),
      games: [point('Game', gameId, '3')] };
    await expect(validateRankedRecoveryManifest(manifest)).resolves.toBeUndefined();
    for (const changed of [{ ...manifest, games: [] }, { ...manifest, prover: manifest.competition },
      { ...manifest, games: [{ ...manifest.games[0], capturedAt: ledger.capturedAt + 1 }] },
      { ...manifest, d1Bookmark: '' }]) {
      await expect(validateRankedRecoveryManifest(changed)).rejects.toMatchObject({ code: 'PROOF_RECOVERY_UNVERIFIED' });
    }
  });
});
