import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import manifest from '../proof/acceptance-manifest.json';
import { ProofAcceptance } from '../src/server/proof-acceptance';
import { AcceptanceGame } from '../src/server/proof-acceptance-adapters';
import { ProofAcceptanceJournal, PROOF_ACCEPTANCE_SCOPE, type ProofAcceptanceIdentity } from '../src/server/proof-acceptance-journal';

vi.mock('../proof/acceptance-manifest.json', async importOriginal => {
  // This in-memory seal exercises local guards. It grants no execution approval.
  const { default: original } = await importOriginal<{ default: typeof import('../proof/acceptance-manifest.json') }>();
  const reviews = { costReviewSha256: '6'.repeat(64), sourcePermitReviewSha256: '7'.repeat(64),
    ownerResidualCostAcceptanceSha256: '8'.repeat(64) };
  const fixture = { ...structuredClone(original), executionAvailable: true, adaptersAvailable: true,
    reviewGates: {
      costReview: { status: 'reviewed', sha256: reviews.costReviewSha256 },
      sourcePermitReview: { status: 'reviewed', sha256: reviews.sourcePermitReviewSha256 },
      ownerResidualCostAcceptance: { status: 'accepted', sha256: reviews.ownerResidualCostAcceptanceSha256 },
      providerResourceQualification: { status: 'pending', sha256: null },
    }, sealedRuntimeIdentity: null as ProofAcceptanceIdentity | null };
  const { proofHash } = await import('../src/server/proof-contract');
  fixture.sealedRuntimeIdentity = { scope: fixture.scope, manifestDigest: await proofHash([{ ...fixture }]),
    sourceDigest: 'b'.repeat(64), ...reviews, accountId: 'f'.repeat(32), controlNamespaceId: '1'.repeat(32),
    databaseId: '11111111-1111-1111-1111-111111111111', gameNamespaceId: '2'.repeat(32),
    competitionNamespaceId: '3'.repeat(32), liteProverNamespaceId: '4'.repeat(32), basicProverNamespaceId: '5'.repeat(32),
    privateCaller: fixture.privateCaller, expiresAt: Date.now() + 3_600_000 };
  return { default: fixture };
});

describe('persisted private proof identity', () => {
  it.each(['manifest', 'identity'] as const)('blocks proof admission after saved %s drift and still stops', async mismatch => {
    const seal = manifest.sealedRuntimeIdentity as unknown as ProofAcceptanceIdentity;
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      const priorDigest = mismatch === 'manifest' ? 'c'.repeat(64) : seal.manifestDigest;
      const priorSeal = { ...seal, manifestDigest: priorDigest, sourceDigest: 'a'.repeat(64) };
      const journal = new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), priorDigest, priorSeal);
      journal.arm(); await state.storage.sync();
      let control!: ProofAcceptance;
      const privateControl = { idFromName: () => state.id, get: () => ({
        inspect: () => control.inspect(), claimProofDelivery: () => control.claimProofDelivery(),
      }) } as unknown as DurableObjectNamespace;
      const configured = { PROOF_ACCEPTANCE_SCOPE, PROOF_ACCEPTANCE: privateControl, DB: env.DB,
        GAME: env.GAME, COMPETITION: env.COMPETITION, PROVER: env.GAME,
        PROOF_ACCEPTANCE_SOURCE_REVISION: seal.sourceDigest, PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID: seal.controlNamespaceId,
        PROOF_ACCEPTANCE_MANIFEST_SHA256: seal.manifestDigest, PROOF_ACCEPTANCE_EXECUTION: 'sealed-private',
        PROOF_ACCEPTANCE_TIER: 'lite', PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID: seal.liteProverNamespaceId,
        TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0', NEW_WORK_STOPPED: 'true', RANKED_ENABLED: 'false',
        TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false', ANALYSIS_ENABLED: 'false', AI_ENABLED: 'false',
        MONTHLY_GAME_LIMIT: '0', MONTHLY_EMAIL_LIMIT: '0', MONTHLY_ANALYSIS_LIMIT: '0' };
      control = new ProofAcceptance(state, configured);
      let proofTransports = 0;
      const prover = { fetch: async () => { proofTransports++; return new Response(null, { status: 503 }); } };
      const game = Object.assign(Object.create(AcceptanceGame.prototype), { raw: configured }) as {
        proofReply(stub: unknown, request: Request): Promise<Response>;
      };
      try {
        expect(await control.inspect()).toMatchObject({ armed: true, closed: false, configuredManifestMatches: true,
          manifestMatches: mismatch === 'identity', identityMatches: false, runnable: false });
        await expect(game.proofReply(prover, new Request('http://proof.internal/prove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }))).rejects.toThrow('proof_acceptance_closed');
        await expect(control.claimProofDelivery()).rejects.toThrow('proof_acceptance_delivery_limit');
        expect(state.storage.sql.exec<{ proof_calls: number }>('SELECT proof_calls FROM proof_acceptance_runtime WHERE id=1').one().proof_calls).toBe(0);
        expect(proofTransports).toBe(0);
        expect(JSON.parse(state.storage.sql.exec<{ identity: string }>('SELECT identity FROM proof_acceptance_control WHERE id=1').one().identity)).toEqual(priorSeal);
        await control.stop();
        expect(await control.inspect()).toMatchObject({ closed: true, runnable: false, commands: 1 });
      } finally { await control.stop(); }
    });
  });
});
