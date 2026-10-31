import type { Actor, GameResult, GameSnapshot, Pool } from '../shared/protocol';
import { acquireTournamentSeat, competitiveAccountEligibility, revalidateActor } from './auth';
import type { Env } from './env';
import { ApiError } from './security';

/** Account, seat and result rules that tournaments and arenas share. */
export const NEW_GAMES_PAUSED = 'New games are paused. Existing games will finish.';

/** Competition-owned account slots, closure fences and ratings. */
export interface EventBridge {
  closing(userId: string): boolean;
  busy(userId: string, eventId: string): boolean;
  reserve(userId: string, eventId: string, pool: Pool): void;
  releaseMember(userId: string, eventId: string): void;
  rating(pool: Pool, userId: string): number;
  settle(result: GameResult): Promise<{ accepted: boolean; pending: boolean }>;
}

/** A Game waiting on settlement stays polled until Competition accepts its result. */
export function gamePhase(status: GameSnapshot['status'] | undefined): 'creating' | 'live' | 'settling' {
  return status === 'pending-adjudication' || status === 'finished' ? 'settling' : status ? 'live' : 'creating';
}

export function assertNotClosing(bridge: Pick<EventBridge, 'closing'>, userId: string): void {
  if (bridge.closing(userId)) throw new ApiError(409, 'ACCOUNT_CLOSING', 'Account closure is pending. Try again shortly.');
}

export async function requireSession(actor: Actor, env: Env): Promise<void> {
  if (!await revalidateActor(actor, env)) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in again.');
}

/**
 * Seats are held only while both accounts stay eligible. Game rechecks eligibility
 * and writes an immediate zero-score result for a revoked account.
 */
export async function seatPair(env: Env, eventId: string, gameId: string, whiteId: string, blackId: string): Promise<void> {
  const eligible = async () => (await Promise.all([whiteId, blackId].map(id => competitiveAccountEligibility(env, id)))).every(check => check.eligible);
  if (!await eligible()) return;
  const whiteSeat = await acquireTournamentSeat(env, whiteId, gameId, eventId);
  const blackSeat = await acquireTournamentSeat(env, blackId, gameId, eventId);
  if ((!whiteSeat || !blackSeat) && await eligible()) throw new Error('event_seat_unavailable');
}
