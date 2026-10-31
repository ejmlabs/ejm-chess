import type { Pool } from '../shared/protocol';
import type { TournamentCadence } from '../shared/tournaments';

/** The UTC calendar and windows that tournaments and arenas share. */
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const REGISTRATION_MS = 15 * MINUTE;
export const HISTORY_MS = 7 * DAY;
export const CADENCES = ['hourly', 'daily', 'weekly'] as const satisfies readonly TournamentCadence[];
export const CADENCE_POOL: Record<TournamentCadence, Pool> = { hourly: 'blitz', daily: 'rapid', weekly: 'rapid' };
/** One game or round ends by this window at the latest. */
export const GAME_WINDOW_MS: Record<Pool, number> = { blitz: 18 * MINUTE, rapid: 40 * MINUTE };

/** Fixed UTC cadences use platform dates; delayed maintenance never enumerates missed periods. */
export function occurrences(cadence: TournamentCadence, now: number): [number, number] {
  if (cadence === 'hourly') { const start = Math.floor(now / (60 * MINUTE)) * 60 * MINUTE; return [start, start + 60 * MINUTE]; }
  const date = new Date(now);
  let start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), cadence === 'daily' ? 18 : 16);
  if (cadence === 'weekly') start -= date.getUTCDay() * DAY;
  const interval = cadence === 'daily' ? DAY : 7 * DAY;
  return start > now ? [start - interval, start] : [start, start + interval];
}
