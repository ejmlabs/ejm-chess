import type { Env } from './env';

export const ARENA_POLICY = {
  version: 'arena-v1', maxOpen: 3, maxEvents: 256, registrationMs: 15 * 60_000,
  historyMs: 7 * 86_400_000, candidateWindow: 64, pairBatch: 8, initBatch: 8,
  externalConcurrency: 4, workBatch: 32, pageRows: 32, pageBytes: 32 * 1024,
  snapshotIntervalMs: 10_000, startRate: 32, registrationRate: 50, registrationBurst: 100,
  registrationAuthConcurrency: 16, registrationConcurrency: 256,
  resultReserveBytes: 1_310_720,
  entryReserveBytes: 32 * 1024, eventReserveBytes: 16 * 1024,
} as const;

function limit(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : 0;
}

/** Larger settings are qualification inputs, not evidence of measured capacity. */
export function arenaLimits(env: Pick<Env, 'ARENA_ENTRANT_LIMIT' | 'ARENA_GAME_LIMIT' | 'ARENA_RETAINED_GAME_LIMIT' | 'ARENA_GAME_ID_LIMIT' | 'ARENA_AUTHORITY_BYTE_LIMIT'>) {
  return {
    maxEntrants: limit(env.ARENA_ENTRANT_LIMIT, 2_000, 2_000),
    liveGames: limit(env.ARENA_GAME_LIMIT, 1_000, 1_000),
    retainedGames: limit(env.ARENA_RETAINED_GAME_LIMIT, 100_000, 100_000),
    permanentGameIds: limit(env.ARENA_GAME_ID_LIMIT, 1_000_000, 1_000_000),
    authorityBytes: limit(env.ARENA_AUTHORITY_BYTE_LIMIT, 4 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
  };
}
