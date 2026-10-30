import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import manifest from '../proof/acceptance-manifest.json';
import acceptanceEntry, { ProofAcceptance, proofAcceptanceScopeAllowed } from '../src/server/proof-acceptance';
import { parseProofAcceptanceCommand, ProofAcceptanceJournal, proofAcceptanceManifestDigest,
  proofAcceptanceReviewDigests, proofAcceptanceExecutionAvailable,
  PROOF_ACCEPTANCE_LIMITS, PROOF_ACCEPTANCE_SCOPE, type ProofAcceptanceIdentity } from '../src/server/proof-acceptance-journal';
import { proofDigests, unknownProof, PROOF_PROFILE, PROOF_RULES_VERSION,
  type TimeoutProofRequest, type TimeoutProofResult } from '../src/server/proof-contract';

const T0 = 1_792_500_000_000;
function identity(manifestDigest: string): ProofAcceptanceIdentity {
  return { scope: PROOF_ACCEPTANCE_SCOPE, manifestDigest, sourceDigest: 'a'.repeat(64),
    costReviewSha256: '6'.repeat(64), sourcePermitReviewSha256: '7'.repeat(64),
    ownerResidualCostAcceptanceSha256: '8'.repeat(64), accountId: 'f'.repeat(32),
    controlNamespaceId: '1'.repeat(32), databaseId: '11111111-1111-1111-1111-111111111111',
    gameNamespaceId: '2'.repeat(32), competitionNamespaceId: '3'.repeat(32),
    liteProverNamespaceId: '4'.repeat(32), basicProverNamespaceId: '5'.repeat(32),
    privateCaller: 'ejm-chess-proof-acceptance-caller-v1', expiresAt: T0 + 7_200_000 };
}
async function journalCase<T>(run: (state: DurableObjectState, digest: string) => T): Promise<T> {
  const digest = await proofAcceptanceManifestDigest();
  const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
  // Test carrier only. No Game state, native handle or production binding is changed.
  return runInDurableObject(carrier, (_instance, state) => run(state, digest));
}
function scope() {
  return { PROOF_ACCEPTANCE_SCOPE, PROOF_ACCEPTANCE_SOURCE_REVISION: 'unconfigured',
    PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID: 'unconfigured', PROOF_ACCEPTANCE_MANIFEST_SHA256: 'unconfigured',
    PROOF_ACCEPTANCE_EXECUTION: 'disabled', TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0',
    NEW_WORK_STOPPED: 'true', RANKED_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false',
    ANALYSIS_ENABLED: 'false', AI_ENABLED: 'false', MONTHLY_GAME_LIMIT: '0', MONTHLY_EMAIL_LIMIT: '0', MONTHLY_ANALYSIS_LIMIT: '0' };
}

type G07Evidence = {
  replies: { attempt: number; request: TimeoutProofRequest; result: TimeoutProofResult }[];
  receipts: { id: string; game_id: string; attempt: number; result: string | null }[];
  watcher: { exitCode: number; stopConfirmed: boolean; killed: boolean; pid: number; group: number };
  settlement: { results: object[]; slots: { released_at: number | null }[]; ratings: object[] };
};
const g07Cases: { name: string; passed?: boolean; change: (evidence: G07Evidence) => void }[] = [
  { name: 'matching retained results', passed: true, change: () => {} },
  { name: 'missing native result', change: saved => { saved.receipts = []; } },
  { name: 'null native result', change: saved => { saved.receipts[0].result = null; } },
  { name: 'missing Game reply', change: saved => { saved.replies = []; } },
  { name: 'native row names another game', change: saved => { saved.receipts[0].game_id = 'another-game'; } },
  { name: 'native row names another request', change: saved => { saved.receipts[0].id = 'timeout:another-game:1:1'; } },
  { name: 'native row names another attempt', change: saved => { saved.receipts[0].attempt = 2; } },
  { name: 'Game request names another game', change: saved => {
    Object.assign(saved.replies[0].request, { gameId: 'another-game', reservationId: 'another-game', requestId: 'timeout:another-game:1' });
  } },
  { name: 'Game reply names another attempt', change: saved => { saved.replies[0].attempt = 2; } },
  { name: 'malformed native JSON', change: saved => { saved.receipts[0].result = '{'; } },
  { name: 'Game result has another pending version', change: saved => { saved.replies[0].result.pendingVersion = 2; } },
  { name: 'native result has another history digest', change: saved => {
    const result = JSON.parse(saved.receipts[0].result!); result.historyDigest = 'b'.repeat(64);
    saved.receipts[0].result = JSON.stringify(result);
  } },
  { name: 'Game result has another validator version', change: saved => {
    Object.assign(saved.replies[0].result, { validatorVersion: 'unsupported-validator' });
  } },
  { name: 'native result has another solver version', change: saved => {
    const result = JSON.parse(saved.receipts[0].result!); result.solverCommit = 'b'.repeat(40);
    saved.receipts[0].result = JSON.stringify(result);
  } },
  { name: 'Game result is interrupted', change: saved => { saved.replies[0].result.reason = 'interrupted'; } },
  { name: 'native result is solver-undetermined', change: saved => {
    const result = JSON.parse(saved.receipts[0].result!); result.reason = 'solver-undetermined';
    saved.receipts[0].result = JSON.stringify(result);
  } },
  { name: 'duplicate matching native rows', change: saved => { saved.receipts.push({ ...saved.receipts[0] }); } },
  { name: 'unconfirmed child stop', change: saved => { saved.watcher.stopConfirmed = false; } },
  { name: 'unreleased proof slot', change: saved => { saved.settlement.slots[0].released_at = null; } },
  { name: 'duplicate settlement', change: saved => { saved.settlement.results.push({}); } },
  { name: 'missing rating update for a material timeout', change: saved => { saved.settlement.ratings.pop(); } },
];

describe('unarmed proof acceptance control', () => {
  it.each(g07Cases)('retained G07 native receipt: $name', async ({ change, passed = false }) => {
    const gameId = 'proof-acceptance-g07-test';
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const partial: Omit<TimeoutProofRequest, 'historyDigest' | 'positionDigest'> = { v: 1, rulesVersion: PROOF_RULES_VERSION, profileVersion: PROOF_PROFILE,
      gameId, reservationId: gameId, pendingVersion: 1, requestId: `timeout:${gameId}:1`, survivor: 'w',
      initialFen: fen, fen, moves: [], expiresAt: T0 + 30_000, attempt: 1 };
    const request: TimeoutProofRequest = { ...partial, ...await proofDigests(partial) };
    const result = unknownProof(request, 'resource-limit');
    const saved: G07Evidence = { replies: [{ attempt: 1, request, result }],
      receipts: [{ id: `${request.requestId}:1`, game_id: gameId, attempt: 1, result: JSON.stringify(result) }],
      watcher: { exitCode: 0, stopConfirmed: true, killed: true, pid: 123, group: 123 },
      settlement: { results: [{}], slots: [{ released_at: T0 }], ratings: [{}] } };
    change(saved);
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE proof_acceptance_jobs(id TEXT PRIMARY KEY,complete INTEGER DEFAULT 0,passed INTEGER DEFAULT 0,observation TEXT)');
      state.storage.sql.exec('CREATE TABLE proof_acceptance_runtime(id INTEGER PRIMARY KEY,failed INTEGER DEFAULT 0)');
      state.storage.sql.exec("INSERT INTO proof_acceptance_jobs(id) VALUES('G07')");
      state.storage.sql.exec('INSERT INTO proof_acceptance_runtime(id) VALUES(1)');
      const game = { acceptanceInspect: vi.fn(async () => ({ game: { status: 'finished',
        result: { status: 'finished', outcome: { reason: 'timeout-win' } } }, replies: saved.replies })), flush: vi.fn(async () => {}) };
      const competition = { flush: vi.fn(async () => {}), acceptanceInspect: vi.fn(async () => saved.settlement) };
      const prover = { acceptanceInspect: vi.fn(async () => ({ receipts: saved.receipts, diagnostic: { watcher: JSON.stringify(saved.watcher) } })) };
      // Call the actual observer. Only its fixed inspection/flush RPCs exist in this local harness.
      const observer = Object.assign(Object.create(ProofAcceptance.prototype), { ctx: state,
        game: () => game, competition: () => competition, prover: () => prover,
        store: async () => ({ inspect: () => ({ faultReceipts: [{ fault: 'G07-kill-solver-child' }] }) }) }) as {
          observeGame(job: { id: string; game_id: string }): Promise<void> };
      await observer.observeGame({ id: 'G07', game_id: gameId });
      const job = state.storage.sql.exec<{ complete: number; passed: number; observation: string }>(
        "SELECT complete,passed,observation FROM proof_acceptance_jobs WHERE id='G07'").one();
      expect({ complete: job.complete, passed: job.passed }).toEqual({ complete: 1, passed: Number(passed) });
      expect(state.storage.sql.exec('SELECT failed FROM proof_acceptance_runtime WHERE id=1').one().failed).toBe(Number(!passed));
      expect(JSON.parse(job.observation)).toMatchObject({ settlement: saved.settlement, native: { receipts: saved.receipts } });
      expect(game.acceptanceInspect).toHaveBeenCalledOnce(); expect(game.flush).toHaveBeenCalledOnce();
      expect(competition.flush).toHaveBeenCalledOnce(); expect(competition.acceptanceInspect).toHaveBeenCalledExactlyOnceWith(gameId);
      expect(prover.acceptanceInspect).toHaveBeenCalledOnce();
    });
  });

  it('rejects production bindings, extra inputs and every execution command', async () => {
    expect(proofAcceptanceScopeAllowed(scope())).toBe(true);
    for (const binding of ['GAME', 'COMPETITION', 'PROVER', 'DB', 'ASSETS', 'EMAIL', 'ANALYZER', 'ANALYSIS_QUEUE', 'AUTH_SECRET', 'OTHER_SERVICE']) {
      expect(proofAcceptanceScopeAllowed({ ...scope(), [binding]: {} })).toBe(false);
    }
    expect(proofAcceptanceScopeAllowed({ ...scope(), PROOF_ACCEPTANCE_SCOPE: 'ejm-chess-production' })).toBe(false);
    expect(proofAcceptanceScopeAllowed({ ...scope(), RANKED_ENABLED: 'true' })).toBe(false);
    expect(proofAcceptanceScopeAllowed({ ...scope(), PROOF_ACCEPTANCE_EXECUTION: 'enabled' })).toBe(false);
    for (const input of [null, [], { operation: { toString: () => 'arm' } }, Object.assign(Object.create({ operation: 'arm' }), { extra: true }),
      { operation: 'inspect', sql: 'DELETE FROM games' }, { operation: 'advance', id: 'arbitrary' },
      { operation: 'advance', id: 'G00', fen: 'arbitrary' }, { operation: 'fault', id: 'G08-lost-proof-reply', ordinal: 3 }]) {
      expect(parseProofAcceptanceCommand(input)).toBeNull();
    }
    const entry = Object.create(ProofAcceptance.prototype) as ProofAcceptance;
    for (const input of [{ operation: 'arm' }, { operation: 'advance', id: 'G00' },
      { operation: 'advance', id: 'C00' }, { operation: 'fault', id: 'G08-lost-proof-reply', ordinal: 1 }]) {
      expect(await entry.command(input)).toEqual({ ok: false, reason: 'execution-unavailable', runnable: false });
    }
    expect(entry.fetch().status).toBe(404);
    expect(acceptanceEntry.fetch().status).toBe(404);
  });

  it('keeps private inspection and stop available when configured identity drifts', async () => {
    const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(carrier, async (_instance, state) => {
      const entry = new ProofAcceptance(state, { ...scope(), PROOF_ACCEPTANCE_MANIFEST_SHA256: 'd'.repeat(64) });
      expect(await entry.inspect()).toMatchObject({ configuredManifestMatches: false, armed: false, runnable: false });
      expect(await entry.command({ operation: 'arm' })).toMatchObject({ ok: false, reason: 'execution-unavailable' });
      const stopped = await entry.stop();
      expect(await entry.stop()).toEqual(stopped);
      expect(await entry.inspect()).toMatchObject({ closed: true, closeReason: 'stopped', commands: 0 });
    });
  });

  it('keeps admission closed for pending or missing prerequisite reviews', async () => {
    const original = structuredClone(manifest);
    const mutable = manifest as unknown as { executionAvailable: boolean; adaptersAvailable: boolean;
      sealedRuntimeIdentity: ProofAcceptanceIdentity | null; reviewGates: Record<string, unknown> | undefined };
    const reviewed = { ...original.reviewGates,
      costReview: { status: 'reviewed', sha256: '6'.repeat(64) },
      sourcePermitReview: { status: 'reviewed', sha256: '7'.repeat(64) },
      ownerResidualCostAcceptance: { status: 'accepted', sha256: '8'.repeat(64) } };
    try {
      // Synthetic records check only the interface. No Control is armed by them.
      Object.assign(mutable, { executionAvailable: true, adaptersAvailable: true,
        sealedRuntimeIdentity: identity('c'.repeat(64)), reviewGates: reviewed });
      expect(proofAcceptanceReviewDigests()).toEqual({ costReviewSha256: '6'.repeat(64),
        sourcePermitReviewSha256: '7'.repeat(64), ownerResidualCostAcceptanceSha256: '8'.repeat(64) });
      expect(proofAcceptanceExecutionAvailable()).toBe(true);
      const rejected: (Record<string, unknown> | undefined)[] = [undefined];
      for (const field of ['costReview', 'sourcePermitReview', 'ownerResidualCostAcceptance']) {
        rejected.push({ ...reviewed, [field]: { status: 'pending', sha256: null } });
        const missing: Record<string, unknown> = { ...reviewed }; delete missing[field]; rejected.push(missing);
      }
      for (const records of rejected) {
        mutable.reviewGates = records;
        expect(proofAcceptanceReviewDigests()).toBeNull();
        expect(proofAcceptanceExecutionAvailable()).toBe(false);
        const carrier = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
        await runInDurableObject(carrier, async (_instance, state) => {
          const entry = new ProofAcceptance(state, scope());
          expect(await entry.command({ operation: 'arm' })).toEqual({ ok: false, reason: 'execution-unavailable', runnable: false });
          expect(await entry.inspect()).toMatchObject({ armed: false, runnable: false, executionAvailable: false });
          const stopped = await entry.stop(); expect(await entry.stop()).toEqual(stopped);
          expect(await entry.inspect()).toMatchObject({ closed: true, closeReason: 'stopped', commands: 0 });
        });
      }
    } finally { Object.assign(mutable, original); }
  });

  it('retains one arm, command intent and consumed fault across lost replies and reconstruction', async () => {
    const result = await journalCase((state, digest) => {
      let now = T0;
      const create = () => new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), digest, identity(digest), () => now);
      let store = create();
      const arm = store.arm();
      const command = store.claimCommand('G02');
      const first = store.consumeFault('G02', 'G02-lost-proof-reply', 1);
      // The acknowledgements above are discarded. Their saved identities remain.
      now += 10; store = create();
      const repeated = store.consumeFault('G02', 'G02-lost-proof-reply', 1);
      expect(store.arm()).toEqual(arm);
      expect(store.claimCommand('G02')).toEqual(command);
      expect(repeated).toEqual({ receipt: first.receipt, fresh: false });
      return { first, status: store.inspect() };
    });
    expect(result.first.fresh).toBe(true);
    expect(result.status).toMatchObject({ armed: true, closed: false, commands: 2, runnable: false, executionAvailable: false });
    expect(result.status.commandReceipts).toHaveLength(2);
    expect(result.status.faultReceipts).toHaveLength(1);
  });

  it('keeps expired time after a rejected command, restart and wall-clock rollback', async () => {
    await journalCase((state, digest) => {
      let now = T0;
      const create = () => new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), digest, identity(digest), () => now);
      let store = create(); const arm = store.arm(); const saved = store.claimCommand('G02');
      now = identity(digest).expiresAt;
      expect(() => store.claimCommand('G03')).toThrow('proof_acceptance_closed');
      now = T0 + 1; store = create();
      expect(() => store.claimCommand('G04')).toThrow('proof_acceptance_closed');
      expect(store.arm()).toEqual(arm);
      expect(store.claimCommand('G02')).toEqual(saved);
      expect(store.inspect()).toMatchObject({ closed: true, closeReason: 'expired',
        lastNow: identity(digest).expiresAt, commands: 2 });
      expect(store.stop()).toMatchObject({ reason: 'expired' });
    });
  });

  it('rejects identity or manifest replacement and cannot arm after a prior stop', async () => {
    await journalCase((state, digest) => {
      const create = (seal: ProofAcceptanceIdentity | null, expected = digest) =>
        new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), expected, seal, () => T0);
      const unsealed = create(null);
      expect(() => unsealed.arm()).toThrow('proof_acceptance_unsealed');
      const seal = identity(digest); const store = create(seal); store.arm();
      for (const changed of [{ ...seal, sourceDigest: 'b'.repeat(64) }, { ...seal, expiresAt: seal.expiresAt + 1 },
        { ...seal, databaseId: '22222222-2222-2222-2222-222222222222' }]) {
        expect(() => create(changed).arm()).toThrow('proof_acceptance_identity_mismatch');
      }
      const otherDigest = 'c'.repeat(64);
      const changedManifest = create({ ...seal, manifestDigest: otherDigest }, otherDigest);
      expect(() => changedManifest.arm()).toThrow('proof_acceptance_unsealed');
      expect(changedManifest.inspect().manifestMatches).toBe(false);
      expect(() => create({ ...seal, gameNamespaceId: seal.controlNamespaceId })).toThrow('proof_acceptance_identity_invalid');
      expect(store.inspect().commands).toBe(1);
    });
    await journalCase((state, digest) => {
      const create = () => new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), digest, identity(digest), () => T0);
      const first = create().stop();
      expect(create().stop()).toEqual(first);
      expect(() => create().arm()).toThrow('proof_acceptance_closed');
      expect(create().inspect()).toMatchObject({ armed: false, closed: true, commands: 0, faultReceipts: [] });
    });
  });

  it('rejects missing review digests and replacement after arm', async () => {
    await journalCase((state, digest) => {
      const create = (seal: ProofAcceptanceIdentity) =>
        new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), digest, seal, () => T0);
      const seal = identity(digest);
      const fields = ['costReviewSha256', 'sourcePermitReviewSha256', 'ownerResidualCostAcceptanceSha256'] as const;
      for (const field of fields) {
        const missing = { ...seal }; delete (missing as Partial<ProofAcceptanceIdentity>)[field];
        expect(() => create(missing)).toThrow('proof_acceptance_identity_invalid');
        expect(() => create({ ...seal, [field]: '0'.repeat(64) })).toThrow('proof_acceptance_identity_invalid');
      }
      const store = create(seal); const arm = store.arm();
      for (const field of fields) {
        expect(() => create({ ...seal, [field]: 'b'.repeat(64) }).arm()).toThrow('proof_acceptance_identity_mismatch');
      }
      expect(create(seal).arm()).toEqual(arm);
      expect(store.inspect()).toMatchObject({ commands: 1, faultReceipts: [] });
    });
  });

  it('consumes only the fixed sequential fault allowance and never refunds it', async () => {
    await journalCase((state, digest) => {
      const create = () => new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), digest, identity(digest), () => T0);
      let store = create(); store.arm();
      expect(() => store.consumeFault('G08', 'G08-lost-proof-reply', 1)).toThrow('proof_acceptance_intent_missing');
      store.claimCommand('G08');
      expect(() => store.consumeFault('G08', 'G08-lost-proof-reply', 2)).toThrow('proof_acceptance_fault_order');
      const first = store.consumeFault('G08', 'G08-lost-proof-reply', 1);
      const second = store.consumeFault('G08', 'G08-lost-proof-reply', 2);
      expect(() => store.consumeFault('G08', 'G08-lost-proof-reply', 3)).toThrow('proof_acceptance_fault_invalid');
      expect(() => store.consumeFault('G03', 'G08-lost-proof-reply', 1)).toThrow('proof_acceptance_fault_invalid');
      expect(() => store.claimCommand('arbitrary')).toThrow('proof_acceptance_command_invalid');
      store.stop(); store = create();
      expect(store.consumeFault('G08', 'G08-lost-proof-reply', 1)).toEqual({ receipt: first.receipt, fresh: false });
      expect(store.consumeFault('G08', 'G08-lost-proof-reply', 2)).toEqual({ receipt: second.receipt, fresh: false });
      expect(store.inspect()).toMatchObject({ commands: 2, closed: true, faultReceipts: [first.receipt, second.receipt] });
    });
  });

  it('retains the fixed alarm fuse after reconstruction and permits bounded inspection and stop', async () => {
    await journalCase((state, digest) => {
      const create = () => new ProofAcceptanceJournal(state.storage.sql, run => state.storage.transactionSync(run), digest, identity(digest), () => T0);
      let store = create(); const arm = store.arm();
      for (let i = 0; i < PROOF_ACCEPTANCE_LIMITS.controlAlarmEntries; i++) expect(store.noteAlarm()).toBe(true);
      expect(store.noteAlarm()).toBe(false);
      store = create();
      expect(store.noteAlarm()).toBe(false);
      expect(store.arm()).toEqual(arm);
      expect(() => store.claimCommand('G00')).toThrow('proof_acceptance_closed');
      expect(store.inspect()).toMatchObject({ alarms: PROOF_ACCEPTANCE_LIMITS.controlAlarmEntries, commands: 1,
        closed: true, closeReason: 'alarm-limit', runnable: false, invoiceHardCap: false });
      expect(store.stop()).toMatchObject({ reason: 'alarm-limit' });
    });
  });
});
