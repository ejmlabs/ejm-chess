import { describe, expect, it } from 'vitest';
import { DEFAULT_POSITION } from 'chess.js';
import { getLegalDestinations } from '../src/client/boardHints';

describe('legal destinations supplied to the shared board', () => {
  it('uses king-safe destinations and classifies captures', () => {
    expect(getLegalDestinations(DEFAULT_POSITION, 'w', 'e2')).toEqual([
      { square: 'e3', capture: false }, { square: 'e4', capture: false },
    ]);
    expect(getLegalDestinations('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1', 'w', 'e2')).toEqual([
      ...['e3', 'e4', 'e5', 'e6', 'e7'].map(square => ({ square, capture: false })), { square: 'e8', capture: true },
    ]);
  });

  it('retains full-FEN castling rights', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(getLegalDestinations(fen, 'w', 'e1')).toEqual(expect.arrayContaining([
      { square: 'g1', capture: false }, { square: 'c1', capture: false },
    ]));
    const withoutRights = getLegalDestinations(fen.replace('KQkq', '-'), 'w', 'e1').map(move => move.square);
    expect(withoutRights).not.toContain('g1');
    expect(withoutRights).not.toContain('c1');
  });

  it('classifies en passant and deduplicates promotion destinations', () => {
    expect(getLegalDestinations('rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', 'w', 'e5')).toEqual([
      { square: 'e6', capture: false }, { square: 'd6', capture: true },
    ]);
    expect(getLegalDestinations('1r5k/P7/8/8/8/8/8/7K w - - 0 1', 'w', 'a7')).toEqual([
      { square: 'a8', capture: false }, { square: 'b8', capture: true },
    ]);
  });

  it('returns no future-premove, opponent, empty-square, or invalid destinations', () => {
    expect(getLegalDestinations(DEFAULT_POSITION, 'b', 'e7')).toEqual([]);
    expect(getLegalDestinations(DEFAULT_POSITION.replace(' w ', ' b '), 'w', 'e2')).toEqual([]);
    expect(getLegalDestinations('invalid', 'w', 'e2')).toEqual([]);
    for (const square of ['e7', 'e4', 'e9', 'outside']) expect(getLegalDestinations(DEFAULT_POSITION, 'w', square)).toEqual([]);
  });
});
