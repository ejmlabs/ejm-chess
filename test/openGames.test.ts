import { describe, expect, it } from 'vitest';
import { markOpenGame, readOpenGames } from '../src/client/openGames';

const id = (n: number) => `a12b34c5-d67e-4f89-9123-${String(n).padStart(12, '0')}`;

function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [['chess.openGames', initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('open game shortcuts', () => {
  it('keeps the newest five valid game links without duplicates', () => {
    const storage = memory();
    for (const n of [1, 2, 3, 4, 5, 6, 3]) markOpenGame(id(n), true, storage);
    expect(readOpenGames(storage)).toEqual([id(3), id(6), id(5), id(4), id(2)]);
  });

  it('forgets a finished game', () => {
    const storage = memory(JSON.stringify([id(1), id(2)]));
    markOpenGame(id(1), false, storage);
    expect(readOpenGames(storage)).toEqual([id(2)]);
  });

  it('ignores tampered or unreadable storage', () => {
    expect(readOpenGames(memory(JSON.stringify(['../admin', id(1), 7])))).toEqual([id(1)]);
    expect(readOpenGames(memory('{not json'))).toEqual([]);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readOpenGames(blocked)).toEqual([]);
    expect(() => markOpenGame(id(1), true, blocked)).not.toThrow();
  });
});
