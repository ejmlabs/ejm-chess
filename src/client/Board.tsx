import { useCallback } from 'react';
import { Chessboard, type ChessboardMove, type ChessboardProps } from '@ejm/ui/components/Chessboard';
import { getLegalDestinations } from './boardHints';

export type Move = ChessboardMove;
type Props = Omit<ChessboardProps, 'getLegalMoves'>;

/** Supply rules to the public visual surface. Accepted server snapshots own its position. */
export default function Board(props: Props) {
  const legalMoves = useCallback((square: string) => getLegalDestinations(props.fen, props.color, square), [props.fen, props.color]);
  return <Chessboard fen={props.fen} color={props.color} enabled={props.enabled} readOnly={props.readOnly} showLegalMoves={props.showLegalMoves} lastMove={props.lastMove} premove={props.premove} onMove={props.onMove} aria-label={props['aria-label']} getLegalMoves={legalMoves} />;
}
