import { describe, expect, it, vi } from 'vitest';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import { submitLegalMove } from '../src/client/moveDispatch';

describe('local move dispatch', () => {
  it('does not submit illegal destinations or change the accepted position', () => {
    const send = vi.fn(() => true);
    const state = { fen: DEFAULT_POSITION, version: 7 };
    expect(submitLegalMove(state, { from: 'e2', to: 'e5' }, send)).toBe(false);
    expect(submitLegalMove({ ...state, fen: '4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1' }, { from: 'e2', to: 'd2' }, send)).toBe(false);
    expect(submitLegalMove({ ...state, fen: 'invalid' }, { from: 'e2', to: 'e4' }, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(state).toEqual({ fen: DEFAULT_POSITION, version: 7 });
  });

  it('sends legal moves and the chosen underpromotion against their checked version', () => {
    const send = vi.fn(() => true);
    expect(submitLegalMove({ fen: DEFAULT_POSITION, version: 7 }, { from: 'e2', to: 'e4' }, send)).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ type: 'move', from: 'e2', to: 'e4' }, 7);
    expect(submitLegalMove({ fen: '1r5k/P7/8/8/8/8/8/7K w - - 0 1', version: 21 }, { from: 'a7', to: 'b8', promotion: 'n' }, send)).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ type: 'move', from: 'a7', to: 'b8', promotion: 'n' }, 21);
    send.mockReturnValue(false);
    expect(submitLegalMove({ fen: DEFAULT_POSITION, version: 7 }, { from: 'e2', to: 'e4' }, send)).toBe(false);
  });

  it('checks a matured premove after the opponent move, including en passant rights', () => {
    const send = vi.fn(() => true);
    const premove = { from: 'e5', to: 'd6' };
    const before = new Chess('rnbqkbnr/pppppppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2');
    const declined = new Chess(before.fen());
    declined.move('a6');
    expect(submitLegalMove({ fen: declined.fen(), version: 4 }, premove, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    before.move('d5');
    expect(submitLegalMove({ fen: before.fen(), version: 4 }, premove, send)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'move', ...premove }, 4);
  });
});
