import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../proof/acceptance-manifest.json';
import { prepareAcceptanceAccounts, type AcceptanceAdapterEnv } from '../src/server/proof-acceptance-adapters';
import { proofAcceptanceManifestDigest, type ProofAcceptanceIdentity } from '../src/server/proof-acceptance-journal';
import { ProofAcceptanceBudget, ACCEPTANCE_WORK, proofRecoveryBudgetPlan,
  type AcceptanceRecoveryBudget } from '../src/server/proof-acceptance-budget';
import { Game } from '../src/server/game';
import type { Env } from '../src/server/env';
import type { GameResult } from '../src/shared/protocol';
import { reserveProofAdmission } from '../src/server/proof-budget';
import { PROOF_PROFILE, unknownProof, type TimeoutProofRequest } from '../src/server/proof-contract';
import { player } from './authority-helpers';

afterEach(() => { vi.restoreAllMocks(); });

describe('private proof predispatch permits', () => {

  it('prepares all eight inert accounts and refreshes only matching sessions within one Control permit', async () => {
    const original = structuredClone(manifest);
    const mutable = manifest as unknown as { executionAvailable: boolean; adaptersAvailable: boolean;
      sealedRuntimeIdentity: ProofAcceptanceIdentity | null; reviewGates: Record<string, unknown> };
    const expiresAt = Date.now() + 600_000;
    const seal: ProofAcceptanceIdentity = { scope: manifest.scope, manifestDigest: await proofAcceptanceManifestDigest(),
      sourceDigest: 'a'.repeat(64), costReviewSha256: '6'.repeat(64), sourcePermitReviewSha256: '7'.repeat(64),
      ownerResidualCostAcceptanceSha256: '8'.repeat(64), accountId: 'f'.repeat(32), controlNamespaceId: '1'.repeat(32),
      databaseId: '11111111-1111-1111-1111-111111111111', gameNamespaceId: '2'.repeat(32),
      competitionNamespaceId: '3'.repeat(32), liteProverNamespaceId: '4'.repeat(32), basicProverNamespaceId: '5'.repeat(32),
      privateCaller: manifest.privateCaller, expiresAt };
    Object.assign(mutable, { executionAvailable: true, adaptersAvailable: true, sealedRuntimeIdentity: seal,
      reviewGates: { ...original.reviewGates, costReview: { status: 'reviewed', sha256: seal.costReviewSha256 },
        sourcePermitReview: { status: 'reviewed', sha256: seal.sourcePermitReviewSha256 },
        ownerResidualCostAcceptance: { status: 'accepted', sha256: seal.ownerResidualCostAcceptanceSha256 } } });
    try {
      // Synthetic manifest and Control handles test setup only. No Game or native proof starts.
      const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
      const measurements = await runInDurableObject(carrier, async (_instance, state) => {
        const budget = new ProofAcceptanceBudget(state, 'Control'); budget.sealBootstrap();
        const local = { DB: budget.d1(env.DB), GAME: {}, COMPETITION: {}, PROVER: {},
          PROOF_ACCEPTANCE: { idFromName: (name: string) => name, get: () => ({ inspect: async () => ({
            manifestMatches: true, identityMatches: true, armed: true, closed: false, expiresAt: seal.expiresAt }) }) },
          PROOF_ACCEPTANCE_SCOPE: manifest.scope, PROOF_ACCEPTANCE_EXECUTION: 'sealed-private',
          PROOF_ACCEPTANCE_SOURCE_REVISION: seal.sourceDigest, PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID: seal.controlNamespaceId,
          PROOF_ACCEPTANCE_MANIFEST_SHA256: seal.manifestDigest, PROOF_ACCEPTANCE_TIER: 'basic',
          PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID: seal.basicProverNamespaceId, NEW_WORK_STOPPED: 'true', RANKED_ENABLED: 'false',
          TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false', AI_ENABLED: 'false', ANALYSIS_ENABLED: 'false',
          TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0' } as unknown as AcceptanceAdapterEnv;
        await budget.run('first-account-setup', () => prepareAcceptanceAccounts(local));
        const sessions = await env.DB.prepare('SELECT id,userId,token,expiresAt FROM session ORDER BY id').all<{
          id: string; userId: string; token: string; expiresAt: string }>();
        expect(sessions.results).toHaveLength(8);
        expect(sessions.results.every(row => Date.parse(row.expiresAt) === expiresAt)).toBe(true);
        const wrong = sessions.results[0], wrongOwner = sessions.results[1];
        await env.DB.prepare('UPDATE session SET token=?,expiresAt=? WHERE id=?')
          .bind('different-identity', new Date(expiresAt - 60_000).toISOString(), wrong.id).run();
        await env.DB.prepare('UPDATE session SET userId=? WHERE id=?').bind(wrong.userId, wrongOwner.id).run();
        seal.expiresAt += 60_000;
        await budget.run('repeat-account-setup', () => prepareAcceptanceAccounts(local));
        const after = await env.DB.prepare('SELECT id,userId,token,expiresAt FROM session ORDER BY id').all<typeof wrong>();
        expect(after.results).toHaveLength(8);
        expect(after.results.find(row => row.id === wrong.id)).toMatchObject({ token: 'different-identity',
          userId: wrong.userId, expiresAt: new Date(expiresAt - 60_000).toISOString() });
        expect(after.results.find(row => row.id === wrongOwner.id)).toMatchObject({ userId: wrong.userId,
          token: wrongOwner.token, expiresAt: wrongOwner.expiresAt });
        expect(after.results.filter(row => row.id !== wrong.id && row.id !== wrongOwner.id)
          .every(row => Date.parse(row.expiresAt) === seal.expiresAt)).toBe(true);
        const setup = budget.inspect().events.filter(event => event.operation.endsWith('account-setup'));
        expect(setup).toHaveLength(2);
        for (const event of setup) {
          expect(event.complete).toBe(1); expect(event.usage!.uncertain).toBe(false);
          expect(event.usage!.d1Statements).toBe(24);
          expect(event.usage!.d1RowsRead).toBeLessThanOrEqual(ACCEPTANCE_WORK.Control.d1RowsRead);
          expect(event.usage!.d1RowsWritten).toBeLessThanOrEqual(ACCEPTANCE_WORK.Control.d1RowsWritten);
        }
        return setup.map(event => event.usage);
      });
      console.log('account-setup-native-local-usage', JSON.stringify(measurements));
    } finally { Object.assign(mutable, original); }
  });

  it('keeps an earlier synced permit after a product rollback and reconstruction', async () => {
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      const budget = new ProofAcceptanceBudget(state, 'Game');
      budget.context.storage.sql.exec('CREATE TABLE qualification_values(id INTEGER PRIMARY KEY)'); budget.sealBootstrap();
      await expect(budget.run('rollback', () => budget.context.storage.transactionSync(() => {
        budget.context.storage.sql.exec('INSERT INTO qualification_values(id) VALUES(1)');
        throw new Error('synthetic-product-rollback');
      }))).rejects.toThrow('synthetic-product-rollback');
      expect(state.storage.sql.exec('SELECT id FROM qualification_values').toArray()).toEqual([]);
      expect(budget.inspect().events.map(event => event.operation)).toEqual(['bootstrap', 'rollback']);
      const restored = new ProofAcceptanceBudget(state, 'Game'); restored.sealBootstrap();
      await restored.run('readback', () => undefined);
      expect(restored.inspect().events.map(event => event.operation)).toEqual(['bootstrap', 'rollback', 'bootstrap', 'readback']);
      const spent = restored.inspect().events.find(event => event.operation === 'rollback')!;
      expect(spent.complete).toBe(1); expect(spent.usage!.doRowsWritten).toBeGreaterThan(0);
    });
  });

  it('denies a D1 write before dispatch and preserves the finite invocation fuse', async () => {
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      const budget = new ProofAcceptanceBudget(state, 'Game'); budget.sealBootstrap();
      await expect(budget.run('forbidden-write', () => budget.d1(env.DB)
        .prepare("UPDATE operations_control SET games_stopped=1 WHERE id='product'").run()))
        .rejects.toThrow('proof_acceptance_d1_permit_exhausted');
      expect(budget.inspect().events.find(event => event.operation === 'forbidden-write')!.usage!.d1Statements).toBe(0);
      for (let event = 2; event < ACCEPTANCE_WORK.Game.events; event++) await budget.run('finite-read', () => undefined);
      await expect(budget.run('exhausted', () => undefined)).rejects.toThrow('proof_acceptance_work_exhausted');
      expect(budget.inspect().events).toHaveLength(ACCEPTANCE_WORK.Game.events);
    });
  });

  it('drains a real Game terminal outbox after five minutes of status reads and two reconstructions', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    const id = crypto.randomUUID(), reservationId = crypto.randomUUID(), startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const settlements: GameResult[] = [];
    const settle = vi.fn(async (result: GameResult) => {
      settlements.push(result);
      if (settlements.length === 1) throw new Error('local-lost-settlement-ack');
      return { accepted: true, pending: false };
    });
    // Only the native solver receipt and Competition transport are fixtures.
    // Game commands, timeout, outbox, D1 seat release and native row metrics
    // use production code. This is no provider or solver qualification.
    const config = { ...env, RANKED_ENABLED: 'true', NEW_WORK_STOPPED: 'false',
      TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '1000',
      PROVER: { idFromName: (name: string) => name, get: () => ({ fetch: async (raw: Request) => {
        const request = await raw.json() as TimeoutProofRequest;
        return Response.json({ ...unknownProof(request, 'solver-undetermined'), verdict: 'winnable', reason: null,
          witness: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] });
      } }) },
      COMPETITION: { idFromName: (name: string) => name,
        get: () => ({ hasTimeoutProofReservation: async () => true, settle }) },
    } as unknown as Env;
    expect(await reserveProofAdmission(config, id)).toBe(true);
    await env.DB.batch([white, black].map(actor => env.DB.prepare(
      'INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(actor.id, id, startedAt)));
    const carrier = env.GAME.get(env.GAME.idFromName(id));
    const measured = await runInDurableObject(carrier, async (_instance, state) => {
      let budget!: ProofAcceptanceBudget, game!: Game;
      const reconstruct = () => {
        budget = new ProofAcceptanceBudget(state, 'Game');
        game = new Game(state, { ...config, DB: budget.d1(env.DB) }, budget.context);
        budget.sealBootstrap();
      };
      reconstruct();
      await budget.run('init', () => game.init({ id, reservationId, format: 'blitz', rated: true, white, black,
        timeoutProof: { reservationId: id, profileVersion: PROOF_PROFILE } }));
      let snapshot = await budget.run('snapshot', () => game.snapshot(white));
      for (const actor of [white, black]) {
        const reply = await budget.run('command', () => game.command(actor,
          { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version }));
        expect(reply.ok).toBe(true); snapshot = reply.snapshot;
      }
      expect(snapshot.clocks.deadline).toBe(startedAt + 300_000);
      for (let poll = 1; poll < 20; poll++) {
        clock.mockReturnValue(startedAt + poll * 15_000);
        expect((await budget.run('status', () => game.status()))?.status).toBe('active');
        if (poll === 10) reconstruct();
      }
      clock.mockReturnValue(startedAt + 300_000);
      expect((await budget.run('status', () => game.status()))?.status).toBe('pending-adjudication');
      await budget.run('resolveTimeoutProof', () => game.resolveTimeoutProof());
      await budget.run('flush', () => game.flush());
      expect(state.storage.sql.exec('SELECT 1 FROM result_delivery').toArray()).toHaveLength(1);
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL')
        .bind(id).first('count')).toBe(2);
      reconstruct();
      clock.mockReturnValue(startedAt + 302_000);
      await budget.run('flush', () => game.flush());
      expect((await budget.run('status', () => game.status()))?.result?.outcome.reason).toBe('timeout-proof-win');
      await budget.run('flush', () => game.flush());
      expect(state.storage.sql.exec('SELECT 1 FROM result_delivery').toArray()).toEqual([]);
      const stored = JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one().value);
      expect(stored.settlement).toBe('settled');
      const measured = budget.inspect();
      expect(measured.closed).toBe(0);
      expect(measured.events.length).toBeLessThanOrEqual(ACCEPTANCE_WORK.Game.events);
      expect(measured.events.filter(event => event.operation === 'bootstrap')).toHaveLength(3);
      expect(measured.events.every(event => event.complete === 1 && event.usage?.uncertain === false)).toBe(true);
      const delivered = measured.events.filter(event => event.usage!.d1RowsWritten > 0);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].operation).toBe('flush');
      expect(delivered[0].usage!.d1RowsWritten).toBeLessThanOrEqual(ACCEPTANCE_WORK.Game.d1RowsWritten);
      return measured;
    });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settlements[1]).toEqual(settlements[0]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL')
      .bind(id).first('count')).toBe(0);
    console.log('game-terminal-native-local-usage', JSON.stringify(measured));
  });

  it('reapplies later spent permits and the reconstruction once after a native SQL rollback fixture', async () => {
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      const budget = new ProofAcceptanceBudget(state, 'Game'); budget.sealBootstrap();
      const before = await budget.recoveryBudget();
      await budget.run('spent-after-backup', () => undefined);
      const later = await budget.recoveryBudget();
      // This isolated SQL fixture tests permit replay, not provider PITR.
      state.storage.sql.exec('DELETE FROM proof_acceptance_usage WHERE id>?', before.events);
      state.storage.sql.exec('UPDATE proof_acceptance_budget SET events=?,emergencies=?,closed=? WHERE id=1',
        before.events, before.emergencies, before.closed);
      const reconstructed = new ProofAcceptanceBudget(state, 'Game'); reconstructed.sealBootstrap();
      await reconstructed.reapplyRecoveryBudget(before, later);
      const once = await reconstructed.recoveryBudget();
      await reconstructed.reapplyRecoveryBudget(before, later);
      expect(await reconstructed.recoveryBudget()).toEqual(once);
      expect(once.events).toBe(later.events + 1);
      expect(once.entries.map(row => row.operation)).toEqual(['bootstrap', 'spent-after-backup', 'bootstrap']);
      expect(once.entries.slice(0, later.events)).toEqual(later.entries);
    });
  });

  it('refuses restoration when the new constructor cannot fit its permanent permit', () => {
    const snapshot = (kind: AcceptanceRecoveryBudget['kind'], events: number, emergencies = 0, closed = 0): AcceptanceRecoveryBudget => ({
      kind, events, emergencies, closed,
      entries: Array.from({ length: events }, (_, index) => ({ id: index + 1, operation: 'bootstrap', complete: 1, usage: null })),
    });
    expect(() => proofRecoveryBudgetPlan(snapshot('Game', 1), snapshot('Game', ACCEPTANCE_WORK.Game.events)))
      .toThrow('proof_recovery_reconstruction_exhausted');
    const before = snapshot('Prover', 1), later = snapshot('Prover', ACCEPTANCE_WORK.Prover.events + 5, 5, 1);
    expect(proofRecoveryBudgetPlan(before, later)).toEqual({ events: later.events + 1, emergencies: 6, closed: 1 });
    expect(() => proofRecoveryBudgetPlan(before, snapshot('Prover', ACCEPTANCE_WORK.Prover.events + 6, 6, 1)))
      .toThrow('proof_recovery_reconstruction_exhausted');
  });
});
