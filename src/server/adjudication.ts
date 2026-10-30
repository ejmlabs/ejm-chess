import type { Chess } from 'chess.js';
import type { Color, GameOutcome } from '../shared/protocol';
import type { TimeoutProofResult } from './proof-contract';

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
 * see a fully blocked position where no mate is reachable; ranked proof games
 * ask the private proof service first and fall back to this rule.
 */
export function timeoutOutcome(chess: Chess, flagged: Color): GameOutcome {
  const survivor: Color = flagged === 'w' ? 'b' : 'w';
  const survivorHasOnlyKing = chess.board().flat().every(piece => !piece || piece.color !== survivor || piece.type === 'k');
  if (chess.isInsufficientMaterial() || survivorHasOnlyKing) {
    return { winner: null, score: 0.5, reason: 'timeout-insufficient-material' };
  }
  return { winner: survivor, score: survivor === 'w' ? 1 : 0, reason: 'timeout-win' };
}

/** Holds a flagged proof-policy game while the private service looks for a draw the material rule cannot see. */
export const TIMEOUT_AWAITING_PROOF: GameOutcome = { winner: null, score: null, reason: 'timeout-needs-review' };

/** Call only after the Game matched a private validated receipt to its request. */
export function provedTimeoutOutcome(proof: TimeoutProofResult): GameOutcome | null {
  if (proof.verdict === 'unknown') return null;
  const decisionId = `proof:${proof.profileVersion}:${proof.requestId}:${proof.attempt}`;
  return proof.verdict === 'unwinnable'
    ? { winner: null, score: 0.5, reason: 'timeout-proof-draw', decisionId }
    : { winner: proof.survivor, score: proof.survivor === 'w' ? 1 : 0, reason: 'timeout-proof-win', decisionId };
}
