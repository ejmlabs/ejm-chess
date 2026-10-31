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
