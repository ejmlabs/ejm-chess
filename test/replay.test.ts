import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { loadReplayPgn, parseReplay, ReplayError, REPLAY_MAX_BYTES } from '../src/client/replay';

afterEach(() => vi.unstubAllGlobals());

function errorCode(pgn: string) {
  try { parseReplay(pgn); return null; }
  catch (error) { return error instanceof ReplayError ? error.code : 'UNEXPECTED'; }
}

describe('private recorded-game parsing', () => {
  it('keeps the recorded initial position, move numbers, players, and AI labels', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K3 b Q - 0 21';
    const record = parseReplay(`[SetUp "1"]\n[FEN "${fen}"]\n[White "Ada"]\n[Black "Model (AI)"]\n[Mode "AI"]\n[AIModel "test/chess:free"]\n[AIActualModel "test/routed:free"]\n[TimeControl "300+3"]\n[Result "1/2-1/2"]\n\n21... Kf7 22. O-O-O 1/2-1/2`);
    expect(record).toMatchObject({ initialFen: fen, white: 'Ada', black: 'Model (AI)', result: '1/2-1/2',
      timeControl: '300+3', ai: { model: 'test/chess:free', actualModel: 'test/routed:free' } });
    expect(record.moves).toMatchObject([
      { number: 21, color: 'b', san: 'Kf7', from: 'e8', to: 'f7', before: fen },
      { number: 22, color: 'w', san: 'O-O-O', from: 'e1', to: 'c1', after: '8/5k2/8/8/8/8/8/2KR4 b - - 2 22' },
    ]);
    expect(record.moves[0].after).toBe(record.moves[1].before);
  });

  it('preserves a zero-move custom starting position', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K3 b Q - 0 21';
    const record = parseReplay(`[SetUp "1"]\n[FEN "${fen}"]\n[Result "*"]\n\n*`);
    expect(record.initialFen).toBe(fen);
    expect(record.moves).toEqual([]);
    expect(record.ai).toBeNull();
  });

  it.each([
    ['en passant', '1. e4 a6 2. e5 d5 3. exd6 *', 'exd6', 'rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3'],
    ['castling', '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 *', 'Nf6', 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 5'],
    ['promotion', '[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=Q+ *', 'a8=Q+', 'Q6k/8/8/8/8/8/8/7K b - - 0 1'],
    ['underpromotion', '[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=N *', 'a8=N', 'N6k/8/8/8/8/8/8/7K b - - 0 1'],
  ])('replays %s at its recorded position', (_name, pgn, san, fen) => {
    const move = parseReplay(pgn).moves.at(-1)!;
    expect(move.san).toBe(san);
    expect(move.after).toBe(fen);
  });

  it('rejects an illegal move after a legal prefix without returning a partial record', () => {
    expect(errorCode('1. e4 e5 2. e5 *')).toBe('INVALID_RECORD');
    expect(errorCode('')).toBe('INVALID_RECORD');
  });

  it('measures the source limit in UTF-8 bytes, including comments', () => {
    const start = '[White "Élodie"]\n\n1. e4 {';
    const end = '} *';
    const padding = 'a'.repeat(REPLAY_MAX_BYTES - new TextEncoder().encode(start + end).byteLength);
    const pgn = start + padding + end;
    expect(new TextEncoder().encode(pgn).byteLength).toBe(REPLAY_MAX_BYTES);
    expect(parseReplay(pgn).moves).toHaveLength(1);
    // This remains below the character limit but crosses the byte limit.
    expect((start + padding + 'é' + end).length).toBeLessThanOrEqual(REPLAY_MAX_BYTES);
    expect(errorCode(start + padding + 'é' + end)).toBe('RECORD_TOO_LARGE');
  });

  it('replays beyond the old 4,096 limit through 12,700 plies and rejects the next move', () => {
    const game = new Chess();
    const cycle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
    // Legal repeated SAN exercises the parser bound, not the server's automatic draw policy.
    for (let index = 0; index < 12_700; index++) game.move(cycle[index % cycle.length]);
    expect(parseReplay(game.pgn()).moves).toHaveLength(12_700);
    game.move('Nf3');
    expect(errorCode(game.pgn())).toBe('TOO_MANY_MOVES');
  });
});

describe('private replay loading', () => {
  it('validates links before making an authenticated request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(loadReplayPgn('../another-game?join=1')).rejects.toMatchObject({ code: 'INVALID_LINK' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('only reads the participant PGN endpoint and retains the exact source', async () => {
    const pgn = '[White "Élodie"]\n\n1. e4 *';
    const fetch = vi.fn(async () => new Response(pgn));
    vi.stubGlobal('fetch', fetch);
    const id = crypto.randomUUID();
    expect(await loadReplayPgn(id)).toBe(pgn);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`/api/games/${id}/pgn`, expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/x-chess-pgn' },
    }));
  });

  it.each([[401, 'SIGN_IN_REQUIRED'], [403, 'UNAVAILABLE'], [404, 'UNAVAILABLE'], [503, 'LOAD_FAILED']])(
    'shows a safe error for HTTP %s without exposing or parsing its body', async (status, code) => {
      const cancel = vi.fn();
      const body = new ReadableStream({ cancel });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: Number(status) })));
      await expect(loadReplayPgn(crypto.randomUUID())).rejects.toMatchObject({ code });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('refuses an oversized declared source before reading its body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Length': String(REPLAY_MAX_BYTES + 1) },
    })));
    await expect(loadReplayPgn(crypto.randomUUID())).rejects.toMatchObject({ code: 'RECORD_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([null, '1'])('bounds actual streamed bytes when Content-Length is %s', async declared => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(REPLAY_MAX_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      headers: declared ? { 'Content-Length': declared } : {},
    })));
    await expect(loadReplayPgn(crypto.randomUUID())).rejects.toMatchObject({ code: 'RECORD_TOO_LARGE' });
  });

  it('rejects malformed UTF-8 instead of silently changing the record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]))));
    await expect(loadReplayPgn(crypto.randomUUID())).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  });
});
