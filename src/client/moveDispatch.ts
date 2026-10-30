import { Chess } from 'chess.js';
import type { GameCommand, GameSnapshot } from '../shared/protocol';

type Move = Pick<Extract<GameCommand, { type: 'move' | 'engine-move' }>, 'from' | 'to' | 'promotion'>;
type Send = (action: { type: 'move' } & Move, expectedVersion: number) => boolean;

/** Check a temporary position, then submit against the same accepted version. */
export function submitLegalMove(state: Pick<GameSnapshot, 'fen' | 'version'>, move: Move, send: Send) {
  try { new Chess(state.fen).move(move); }
  catch { return false; }
  return send({ type: 'move', ...move }, state.version);
}
