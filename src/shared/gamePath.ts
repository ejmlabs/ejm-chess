const GAME_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function isGameId(value: unknown): value is string {
  return typeof value === 'string' && GAME_ID.test(value);
}

/** Keep invitation text inside one path segment before any authenticated request. */
export function gamePath(id: string, action?: 'join' | 'connect' | 'pgn'): string {
  if (!isGameId(id)) throw new Error('This invitation link is invalid.');
  return `/api/games/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
}
