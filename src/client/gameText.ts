import type { Color, GameSnapshot } from '../shared/protocol';

const draws: Partial<Record<string, string>> = {
  stalemate: 'Draw by stalemate.',
  'threefold-repetition': 'Draw by repetition.',
  'fifty-move-rule': 'Draw by the fifty-move rule.',
  'insufficient-material': 'Draw. Neither side can checkmate.',
  'draw-agreement': 'Draw agreed.',
  'timeout-insufficient-material': 'Draw. Time ran out, but the other side cannot checkmate.',
};

const wins: Partial<Record<string, [won: string, lost: string]>> = {
  checkmate: ['You won by checkmate.', 'You lost by checkmate.'],
  resignation: ['You won. Your opponent resigned.', 'You resigned.'],
  'timeout-win': ['You won on time.', 'You lost on time.'],
};

/** A settled ranked game changes ratings only when it has a score; an unstarted or void game does not. */
export function ratingText(state: Pick<GameSnapshot, 'rated' | 'settlement' | 'outcome'>, done: boolean): string {
  if (!state.rated) return 'Unrated';
  if (state.settlement === 'settled') return state.outcome?.score == null ? 'No rating change' : 'Rating updated';
  return done ? 'Rating pending' : 'Rated';
}

/** Put the server's accepted outcome in the player's own terms. The server decides every result. */
export function resultText(state: Pick<GameSnapshot, 'status' | 'outcome' | 'black'>, color: Color): string {
  if (state.status === 'pending-adjudication') return 'Time ran out. The result follows within 30 seconds.';
  const outcome = state.outcome;
  if (!outcome) return '';
  if (outcome.reason === 'readiness-expired') return state.black ? 'Not started. A player was not ready in time.' : 'The invitation expired unused.';
  if (outcome.reason === 'technical-void') return 'Game voided. No rating change.';
  if (outcome.reason === 'ai-unavailable') return 'Stockfish stopped. No score.';
  if (outcome.score === 0.5) return draws[outcome.reason] ?? 'Draw.';
  if (!outcome.winner) return 'The game ended without a result.';
  const [won, lost] = wins[outcome.reason] ?? ['You won.', 'You lost.'];
  return outcome.winner === color ? won : lost;
}

/** What a screen reader hears after each accepted move, from either side. */
export function lastMoveText(moves: readonly { san: string }[]): string {
  const last = moves.at(-1);
  return last ? `${moves.length % 2 ? 'White' : 'Black'} played ${last.san}.` : '';
}

export function clockText(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Read a history result from this account's side. */
export function historyResult(result: string | null, color: Color): string {
  if (result === '1/2-1/2' || result === '½-½') return 'Draw';
  if (result === 'Void') return 'Void';
  if (result !== '1-0' && result !== '0-1') return 'Pending';
  return (result === '1-0' ? 'w' : 'b') === color ? 'Won' : 'Lost';
}

export type EndedConnection = 'replaced' | 'closed';

/** Codes the server closes a socket with on purpose. Reconnecting cannot help, so the client stops and says why. */
export function endedConnection(code: number): EndedConnection | null {
  if (code === 4001) return 'replaced';
  return [4003, 4004, 4009, 4401, 4403, 4409].includes(code) ? 'closed' : null;
}

export const endedText: Record<EndedConnection, string> = {
  replaced: 'This game is open in another tab.',
  closed: 'This connection has ended. Reopen the game in this tab to continue.',
};
