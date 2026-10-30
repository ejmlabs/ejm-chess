import { describe, expect, it } from 'vitest';
import { gamePath, isGameId } from '../src/shared/gamePath';

describe('invitation request targets', () => {
  it('rejects links that would normalize into another authenticated mutation', () => {
    for (const value of ['../auth/sign-out?', '../auth/revoke-other-sessions?', '../queue/cancel?', '%2e%2e%2fauth/sign-out?', '', 'not-a-game']) {
      const query = new URLSearchParams({ game: value });
      const supplied = query.get('game');
      expect(isGameId(supplied)).toBe(false);
      expect(() => gamePath(supplied!, 'join')).toThrow('This invitation link is invalid.');
    }
  });

  it('keeps every supported game action beneath its canonical game ID', () => {
    const id = crypto.randomUUID();
    expect(isGameId(id)).toBe(true);
    for (const action of [undefined, 'join', 'connect', 'pgn'] as const) {
      const target = new URL(gamePath(id, action), 'https://chess.ejmlabs.com');
      expect(target.pathname).toBe(`/api/games/${id}${action ? `/${action}` : ''}`);
      expect(target.search).toBe('');
      expect(target.origin).toBe('https://chess.ejmlabs.com');
    }
  });
});
