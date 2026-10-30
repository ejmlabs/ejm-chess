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

export function timeoutOutcome(chess: Chess, flagged: Color): GameOutcome {
  const survivor: Color = flagged === 'w' ? 'b' : 'w';
  const survivorHasOnlyKing = chess.board().flat().every(piece => !piece || piece.color !== survivor || piece.type === 'k');
  if (chess.isInsufficientMaterial() || survivorHasOnlyKing) {
    return { winner: null, score: 0.5, reason: 'timeout-insufficient-material' };
  }
  // chess.js cannot prove possible mate for one side in every blocked position.
  // Bounded private proof work may resolve new ranked-policy games. Otherwise
  // the saved pending deadline produces an unrated technical void.
  return { winner: null, score: null, reason: 'timeout-needs-review' };
}

/** Call only after the Game matched a private validated receipt to its request. */
export function provedTimeoutOutcome(proof: TimeoutProofResult): GameOutcome | null {
  if (proof.verdict === 'unknown') return null;
  const decisionId = `proof:${proof.profileVersion}:${proof.requestId}:${proof.attempt}`;
  return proof.verdict === 'unwinnable'
    ? { winner: null, score: 0.5, reason: 'timeout-proof-draw', decisionId }
    : { winner: proof.survivor, score: proof.survivor === 'w' ? 1 : 0, reason: 'timeout-proof-win', decisionId };
}
