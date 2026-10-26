import { Chess, type Square } from 'chess.js';
import type { Color } from '../shared/protocol';

/** Decorations only. The server still decides whether a move is accepted. */
export function getLegalDestinations(fen: string, color: Color, square: string) {
  if (!/^[a-h][1-8]$/.test(square)) return [];
  let chess: Chess;
  try { chess = new Chess(fen); }
  catch { return []; }
  if (chess.turn() !== color || chess.get(square as Square)?.color !== color) return [];
  const destinations = new Map<string, boolean>();
  for (const move of chess.moves({ square: square as Square, verbose: true })) {
    destinations.set(move.to, move.isCapture() || move.isEnPassant());
  }
  return Array.from(destinations, ([destination, capture]) => ({ square: destination, capture }));
}
