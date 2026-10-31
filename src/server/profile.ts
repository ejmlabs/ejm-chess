import type { Env } from './env';
import type { Pool, PublicProfile, PublicRating } from '../shared/protocol';
import { PASSWORD_ACCOUNT_SQL } from './auth';
import { ESTABLISHED, meetsRatingStandard } from './leaderboard';

interface Account { id: string; name: string; created_at: string; restricted: number }
interface RatingRow {
  pool: Pool; rating_display: number; rd: number; games: number; distinct_opponents: number;
  last_played_at: number; projected_at: number; eligible: number;
}

/** Public read model only. Private account, review, and live-game records never leave this adapter. */
export async function publicProfile(env: Pick<Env, 'DB' | 'RANKED_ENABLED'>, id: string, now = Date.now()): Promise<PublicProfile | null> {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return null;
  const [accountResult, ratingResult, pendingResult] = await env.DB.batch([
    env.DB.prepare(`SELECT u.id,u.name,u.createdAt AS created_at,
      EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=u.id AND r.revoked_at IS NULL AND r.expires_at>?) AS restricted
      FROM user u WHERE u.id=? AND (${PASSWORD_ACCOUNT_SQL}) LIMIT 1`).bind(now, id),
    env.DB.prepare(`SELECT pool,rating_display,rd,games,distinct_opponents,last_played_at,projected_at,eligible
      FROM leaderboard_entries WHERE user_id=? AND pool IN ('blitz','rapid') LIMIT 2`).bind(id),
    // Every game has one of these statuses. Naming them seeks the few pending settlements instead of walking this player's history.
    env.DB.prepare(`SELECT DISTINCT pool FROM games WHERE status IN ('finished','pending-adjudication') AND settlement='pending'
      AND rated=1 AND (white_id=? OR black_id=?) LIMIT 2`).bind(id, id),
  ]);
  const account = (accountResult.results as unknown as Account[])[0];
  if (!account) return null;
  const ratings = ratingResult.results as unknown as RatingRow[];
  const pendingPools = new Set((pendingResult.results as unknown as { pool: Pool }[]).map(row => row.pool));
  const createdAt = Date.parse(account.created_at);
  const pools = (['blitz', 'rapid'] as const).map((pool): PublicRating => {
    const row = ratings.find(rating => rating.pool === pool);
    const lastPlayedAt = row && row.last_played_at > 0 ? row.last_played_at : null;
    const inactive = lastPlayedAt !== null && lastPlayedAt < now - ESTABLISHED.activeWithinMs;
    const provisional = !row || !meetsRatingStandard(row.games, row.distinct_opponents, row.rd)
      || !Number.isFinite(createdAt) || createdAt > now - ESTABLISHED.accountAgeMs || lastPlayedAt === null;
    const pending = pendingPools.has(pool);
    const eligible = Boolean(row?.eligible && !account.restricted && !inactive && !provisional);
    const status = account.restricted ? 'unranked' : pending ? 'pending' : inactive ? 'inactive'
      : provisional ? 'provisional' : eligible ? 'established' : 'unranked';
    return {
      pool, rating: row?.rating_display ?? null, games: row?.games ?? 0, distinctOpponents: row?.distinct_opponents ?? 0,
      deviation: row?.rd ?? null, lastPlayedAt, updatedAt: row?.projected_at ?? null, status, pending, eligible,
    };
  });
  return { id: account.id, name: account.name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Player',
    rankedOpen: env.RANKED_ENABLED === 'true', pools };
}
