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

/**
 * A Game arms its own alarm for every deadline and pushes its result, so polling it is only a backstop.
 * A poll follows the Game's reported due time, but never waits past this: if a Game alarm or a push
 * was lost, or a move brought a deadline forward, the game is still read again within five minutes.
 * A flag keeps its original deadline as the result time, so a late read delays delivery only.
 */
const RECONCILE_SAFETY_MS = 300_000;
/** A due time already passed leaves work only the Game's own retry owns, so it is not polled in a tight loop. */
const RECONCILE_RETRY_MS = 1_000;

export function nextReconcileAt(now: number, dueAt: number | null | undefined): number {
  const due = dueAt === null || dueAt === undefined ? Number.POSITIVE_INFINITY : dueAt > now ? dueAt : now + RECONCILE_RETRY_MS;
  return Math.min(now + RECONCILE_SAFETY_MS, due);
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
