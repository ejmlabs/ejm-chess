import type { Env } from './env';
import { HISTORY_MS, REGISTRATION_MS } from './schedule';

export const ARENA_POLICY = {
  version: 'arena-v1', registrationMs: REGISTRATION_MS,
  historyMs: HISTORY_MS, candidateWindow: 64, pairBatch: 8, initBatch: 8,
  externalConcurrency: 4, workBatch: 32, pageRows: 32, pageBytes: 32 * 1024,
  snapshotIntervalMs: 10_000, retryMs: 1_000, startRate: 32, registrationRate: 50, registrationBurst: 100,
  registrationAuthConcurrency: 16, registrationConcurrency: 256,
  resultReserveBytes: 1_310_720,
  entryReserveBytes: 32 * 1024,
} as const;

function limit(value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : 0;
}

/**
 * Product ceilings are off by default. The one default is a platform bound: a SQLite-backed
 * Durable Object stops at 10 GB, and 4 GiB leaves room for accepted games to finish.
 */
export function arenaLimits(env: Pick<Env, 'ARENA_ENTRANT_LIMIT' | 'ARENA_GAME_LIMIT' | 'ARENA_RETAINED_GAME_LIMIT' | 'ARENA_GAME_ID_LIMIT' | 'ARENA_AUTHORITY_BYTE_LIMIT'>) {
  return {
    maxEntrants: limit(env.ARENA_ENTRANT_LIMIT, Number.MAX_SAFE_INTEGER),
    liveGames: limit(env.ARENA_GAME_LIMIT, Number.MAX_SAFE_INTEGER),
    retainedGames: limit(env.ARENA_RETAINED_GAME_LIMIT, Number.MAX_SAFE_INTEGER),
    permanentGameIds: limit(env.ARENA_GAME_ID_LIMIT, Number.MAX_SAFE_INTEGER),
    authorityBytes: limit(env.ARENA_AUTHORITY_BYTE_LIMIT, 4 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
  };
}
