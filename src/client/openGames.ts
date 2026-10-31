import { isGameId } from '../shared/gamePath';

const KEY = 'chess.openGames';
const LIMIT = 5;

/** Reading localStorage itself throws when the browser blocks storage. */
function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** Game links this browser opened and has not seen finish. A convenience only: the server still decides every seat. */
export function readOpenGames(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isGameId).slice(0, LIMIT) : [];
  } catch { return []; }
}

export function markOpenGame(id: string, open: boolean, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = browserStorage()) {
  const rest = readOpenGames(storage).filter(value => value !== id);
  const next = open && isGameId(id) ? [id, ...rest].slice(0, LIMIT) : rest;
  try { storage?.setItem(KEY, JSON.stringify(next)); }
  catch { /* Blocked storage only loses the shortcut. */ }
}
