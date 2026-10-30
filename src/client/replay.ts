import { Chess } from 'chess.js';
import { gamePath, isGameId } from '../shared/gamePath';
import { MAX_GAME_PLIES, type Color } from '../shared/protocol';

export const REPLAY_MAX_BYTES = 1_048_576;
export const REPLAY_MAX_PLIES = MAX_GAME_PLIES;

export type ReplayErrorCode = 'INVALID_LINK' | 'SIGN_IN_REQUIRED' | 'UNAVAILABLE' | 'LOAD_FAILED'
  | 'INVALID_RECORD' | 'RECORD_TOO_LARGE' | 'TOO_MANY_MOVES';

const messages: Record<ReplayErrorCode, string> = {
  INVALID_LINK: 'This replay link is invalid.',
  SIGN_IN_REQUIRED: 'Sign in with the account that played this game.',
  UNAVAILABLE: 'This completed game is not available to this account yet.',
  LOAD_FAILED: 'This replay could not be loaded. Try again.',
  INVALID_RECORD: 'This recorded PGN is invalid and cannot be replayed. You can still download the source.',
  RECORD_TOO_LARGE: 'This replay exceeds the 1 MiB record limit. You can still download the PGN.',
  TOO_MANY_MOVES: `This replay exceeds the ${REPLAY_MAX_PLIES} half-move limit. You can still download the PGN.`,
};

export class ReplayError extends Error {
  constructor(readonly code: ReplayErrorCode) { super(messages[code]); }
}

export interface ReplayMove {
  from: string;
  to: string;
  san: string;
  color: Color;
  number: number;
  before: string;
  after: string;
}

export interface ReplayRecord {
  initialFen: string;
  moves: ReplayMove[];
  white: string;
  black: string;
  result: string;
  timeControl: string | null;
  ai: { model: string | null; actualModel: string | null } | null;
}

function label(value: string | undefined, fallback: string, limit = 80): string {
  return value?.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit) || fallback;
}

/** chess.js owns PGN syntax, legality, SAN, and every recorded position. */
export function parseReplay(pgn: string): ReplayRecord {
  if (typeof pgn !== 'string' || !pgn.trim()) throw new ReplayError('INVALID_RECORD');
  if (pgn.length > REPLAY_MAX_BYTES || new TextEncoder().encode(pgn).byteLength > REPLAY_MAX_BYTES) throw new ReplayError('RECORD_TOO_LARGE');
  const game = new Chess();
  try { game.loadPgn(pgn, { strict: true }); }
  catch { throw new ReplayError('INVALID_RECORD'); }
  const history = game.history({ verbose: true });
  if (history.length > REPLAY_MAX_PLIES) throw new ReplayError('TOO_MANY_MOVES');
  const headers = game.getHeaders();
  return {
    initialFen: history[0]?.before ?? game.fen(),
    moves: history.map(move => ({ from: move.from, to: move.to, san: move.san, color: move.color,
      number: Number(move.before.split(' ')[5]), before: move.before, after: move.after })),
    white: label(headers.White, 'White'), black: label(headers.Black, 'Black'), result: headers.Result || '*',
    timeControl: headers.TimeControl ? label(headers.TimeControl, '', 40) : null,
    ai: headers.Mode === 'AI' || headers.AIModel ? {
      model: headers.AIModel ? label(headers.AIModel, '', 200) : null,
      actualModel: headers.AIActualModel ? label(headers.AIActualModel, '', 200) : null,
    } : null,
  };
}

/** Fetch only a participant's completed export. Never join a seat or open a live socket. */
export async function loadReplayPgn(id: string, signal?: AbortSignal): Promise<string> {
  if (!isGameId(id)) throw new ReplayError('INVALID_LINK');
  try {
    const options = { method: 'GET', credentials: 'same-origin' as const, cache: 'no-store' as const,
      headers: { Accept: 'application/x-chess-pgn' },
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) };
    const response = await fetch(gamePath(id, 'pgn'), options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReplayError(response.status === 401 ? 'SIGN_IN_REQUIRED' : response.status === 403 || response.status === 404 ? 'UNAVAILABLE' : 'LOAD_FAILED');
    }
    const declared = response.headers.get('Content-Length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > REPLAY_MAX_BYTES) {
      await response.body?.cancel();
      throw new ReplayError('RECORD_TOO_LARGE');
    }
    if (!response.body) throw new ReplayError('INVALID_RECORD');
    let bytes = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > REPLAY_MAX_BYTES) throw new ReplayError('RECORD_TOO_LARGE');
        controller.enqueue(chunk);
      },
    }));
    const buffer = await new Response(bounded).arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer); }
    catch { throw new ReplayError('INVALID_RECORD'); }
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError('LOAD_FAILED');
  }
}
