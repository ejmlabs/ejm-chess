import type { Chess } from 'chess.js';
import type { Color, GameOutcome } from '../shared/protocol';

export function positionOutcome(chess: Chess): GameOutcome | null {
  if (chess.isCheckmate()) {
    const winner: Color = chess.turn() === 'w' ? 'b' : 'w';
    return { winner, score: winner === 'w' ? 1 : 0, reason: 'checkmate' };
  }
  if (chess.isStalemate()) return { winner: null, score: 0.5, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, score: 0.5, reason: 'insufficient-material' };
  if (chess.isThreefoldRepetition()) return { winner: null, score: 0.5, reason: 'threefold-repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, score: 0.5, reason: 'fifty-move-rule' };
  return null;
}

/**
 * Final result when `flagged` runs out of time. The other side wins when it
 * has mating material and otherwise the game is a draw. A material test cannot
 * see a fully blocked position where no mate is reachable, so that position
 * scores as a loss on time.
 */
export function timeoutOutcome(chess: Chess, flagged: Color): GameOutcome {
  const survivor: Color = flagged === 'w' ? 'b' : 'w';
  const survivorHasOnlyKing = chess.board().flat().every(piece => !piece || piece.color !== survivor || piece.type === 'k');
  if (chess.isInsufficientMaterial() || survivorHasOnlyKing) {
    return { winner: null, score: 0.5, reason: 'timeout-insufficient-material' };
  }
  return { winner: survivor, score: survivor === 'w' ? 1 : 0, reason: 'timeout-win' };
}
