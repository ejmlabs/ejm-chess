import type { Pool, RatingState } from '../shared/protocol';

const DAY = 86_400_000;

/**
 * Published established-player requirements. Account age and recent activity move
 * with the clock and a restriction moves with fair play, so every read checks
 * them. The stored `eligible` flag holds only the rating standard; folding the
 * rest into it would strand a player off the board until their next game.
 */
export const ESTABLISHED = { games: 20, opponents: 8, deviation: 100, accountAgeMs: 7 * DAY, activeWithinMs: 30 * DAY } as const;

export function meetsRatingStandard(games: number, distinctOpponents: number, deviation: number): boolean {
  return games >= ESTABLISHED.games && distinctOpponents >= ESTABLISHED.opponents && deviation <= ESTABLISHED.deviation;
}

export const LEADERBOARD_COLUMNS = 'pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,'
  + 'account_created_at,last_played_at,eligible,epoch,version,projected_at';
export const LEADERBOARD_VALUES = LEADERBOARD_COLUMNS.split(',').map(() => '?').join(',');

/** Values in `LEADERBOARD_COLUMNS` order for one player's rating at a projection version. */
export async function leaderboardRow(db: D1Database, pool: Pool, userId: string, state: RatingState, distinctOpponents: number,
  epoch: number, version: number): Promise<Array<string | number>> {
  const user = await db.prepare('SELECT name,createdAt FROM user WHERE id=?').bind(userId).first<{ name: string; createdAt: string }>();
  if (!user) throw new Error('rating_profile_missing');
  const createdAt = Date.parse(user.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error('invalid_account_age');
  const eligible = meetsRatingStandard(state.games, distinctOpponents, state.rd);
  return [pool, userId, user.name.slice(0, 80), state.rating, Math.round(state.rating), state.rd, state.vol, state.games, distinctOpponents,
    createdAt, state.lastPlayedAt ?? 0, eligible ? 1 : 0, epoch, version, Date.now()];
}
