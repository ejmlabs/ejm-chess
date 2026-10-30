import type { CapacityManifest } from '../src/server/capacity-run';

/** Next Sunday 17:50 UTC, so the weekly, daily and hourly fixture events all exist. */
export function capacityFixtureStart(now = Date.now()): number {
  const day = 86_400_000, date = new Date(now);
  const days = (7 - date.getUTCDay()) % 7;
  let start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, 17, 50);
  if (start <= now) start += 7 * day;
  return start;
}

/** Native local regression fixture. Never accepted by the private HTTP entry. */
export function capacityFixtureManifest(start = Date.now()): CapacityManifest {
  return { schema: 'ejm-chess-capacity-v1', runId: crypto.randomUUID(), digest: 'a'.repeat(64),
    sourceDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64), databaseId: crypto.randomUUID(),
    gameNamespaceId: '1'.repeat(32), competitionNamespaceId: '2'.repeat(32), controllerNamespaceId: '3'.repeat(32),
    workerName: 'ejm-chess-capacity-local-fixture', host: 'chess-capacity-local.ejmlabs.com',
    earliestArmAt: start, latestArmAt: start + 30_000, setupEndsAt: start + 600_000,
    streamStartsAt: start + 600_000, streamEndsAt: start + 1_500_000,
    admissionsCloseAt: start + 1_800_000, issueCloseAt: start + 2_700_000,
    hardCloseAt: start + 3_600_000, retentionEndsAt: start + 30 * 86_400_000,
    verified: { allNativePaths: true, worstNextOperation: true, nativeActivePermits: true,
      focusedLocalSafety: true, exactResourceReadback: true, ownerApprovedFrozenRun: true } };
}
