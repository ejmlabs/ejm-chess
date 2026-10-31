import { isGameId } from '../shared/gamePath';

export const PLAY_MODES = ['casual', 'ranked', 'ai'] as const;
export type PlayMode = typeof PLAY_MODES[number];
export const isPlayMode = (value: unknown): value is PlayMode => PLAY_MODES.includes(value as PlayMode);

/** Authentication may return only to Play with a validated invitation, format and mode. */
export function playReturnPath(value: string | null): string | null {
  if (!value?.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'https://chess.ejmlabs.com');
    if (url.origin !== 'https://chess.ejmlabs.com' || !['/play', '/play/'].includes(url.pathname)) return null;
    const query = new URLSearchParams();
    const game = url.searchParams.get('game');
    if (game !== null) {
      if (!isGameId(game)) return null;
      query.set('game', game);
    }
    const format = url.searchParams.get('format');
    if (format === 'blitz' || format === 'rapid') query.set('format', format);
    const mode = url.searchParams.get('mode');
    if (isPlayMode(mode)) query.set('mode', mode);
    return '/play/' + (query.size ? `?${query}` : '');
  } catch { return null; }
}

export function accountPath(returnTo?: string, view?: 'sign-in' | 'sign-up'): string {
  const query = new URLSearchParams();
  const safe = playReturnPath(returnTo ?? null);
  if (safe) query.set('returnTo', safe);
  if (view) query.set('view', view);
  return '/account/' + (query.size ? `?${query}` : '');
}
