import { describe, expect, it } from 'vitest';
import { clockText, endedConnection, endedText, historyResult, lastMoveText, ratingText, resultText } from '../src/client/gameText';
import type { GameOutcome, GameSnapshot } from '../src/shared/protocol';

const seat = { id: 'b', name: 'Bob', isAnonymous: false, ready: true };
const finished = (outcome: GameOutcome, black: GameSnapshot['black'] = seat) => ({ status: 'finished' as const, outcome, black });

describe('result text', () => {
  it('names the winner from the reader’s side', () => {
    const flag = finished({ winner: 'w', score: 1, reason: 'timeout-win' });
    expect(resultText(flag, 'w')).toBe('You won on time.');
    expect(resultText(flag, 'b')).toBe('You lost on time.');
    expect(resultText(finished({ winner: 'b', score: 0, reason: 'resignation' }), 'w')).toBe('You resigned.');
  });

  it('reports a timeout without mating material as a draw', () => {
    expect(resultText(finished({ winner: null, score: 0.5, reason: 'timeout-insufficient-material' }), 'w'))
      .toBe('Draw. Time ran out, but the other side cannot checkmate.');
  });

  it('keeps unscored endings and pending results honest', () => {
    expect(resultText({ status: 'pending-adjudication', outcome: null, black: seat }, 'b')).toMatch(/result follows/);
    expect(resultText(finished({ winner: null, score: null, reason: 'readiness-expired' }, null), 'w')).toBe('The invitation expired unused.');
    expect(resultText(finished({ winner: null, score: null, reason: 'readiness-expired' }), 'w')).toBe('Not started. A player was not ready in time.');
    expect(resultText(finished({ winner: null, score: null, reason: 'technical-void' }), 'w')).toBe('Game voided. No rating change.');
  });

  it('formats clocks by whole seconds without going negative', () => {
    expect(clockText(299_001)).toBe('5:00');
    expect(clockText(59_000)).toBe('0:59');
    expect(clockText(-5)).toBe('0:00');
  });

  it('says a rating changed only for a settled scored ranked game', () => {
    const scored = { winner: 'w', score: 1, reason: 'timeout-win' } as GameOutcome;
    const unstarted = { winner: null, score: null, reason: 'readiness-expired' } as GameOutcome;
    expect(ratingText({ rated: true, settlement: 'settled', outcome: scored }, true)).toBe('Rating updated');
    expect(ratingText({ rated: true, settlement: 'settled', outcome: unstarted }, true)).toBe('No rating change');
    expect(ratingText({ rated: true, settlement: 'pending', outcome: scored }, true)).toBe('Rating pending');
    expect(ratingText({ rated: true, settlement: 'pending', outcome: null }, false)).toBe('Rated');
    expect(ratingText({ rated: false, settlement: 'unrated', outcome: scored }, true)).toBe('Unrated');
  });

  it('reads a history result from the player’s own color', () => {
    expect(historyResult('0-1', 'b')).toBe('Won');
    expect(historyResult('0-1', 'w')).toBe('Lost');
    expect(historyResult('1-0', 'w')).toBe('Won');
    expect(historyResult('½-½', 'b')).toBe('Draw');
    expect(historyResult('Void', 'w')).toBe('Void');
    expect(historyResult('Pending adjudication', 'b')).toBe('Pending');
  });

  it('stops reconnecting for a close the server chose, and says why without promising a retry', () => {
    expect(endedConnection(4001)).toBe('replaced');
    for (const code of [4003, 4004, 4009, 4401, 4403, 4409]) expect(endedConnection(code)).toBe('closed');
    for (const code of [1000, 1001, 1006, 1008, 1009, 1011]) expect(endedConnection(code)).toBeNull();
    expect(endedText.replaced).toBe('This game is open in another tab.');
    expect(Object.values(endedText).join(' ')).not.toMatch(/reconnecting|clocks keep running/i);
  });

  it('names the side that moved for a screen reader, and says nothing before the first move', () => {
    expect(lastMoveText([])).toBe('');
    expect(lastMoveText([{ san: 'e4' }])).toBe('White played e4.');
    expect(lastMoveText([{ san: 'e4' }, { san: 'Nf6' }])).toBe('Black played Nf6.');
  });
});
