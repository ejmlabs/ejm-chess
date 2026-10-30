import { getEngineLevel, STOCKFISH_BUILD, type EngineLevel } from '../shared/engine';

export interface StockfishEngine {
  bestMove(uciMoves: readonly string[], level: EngineLevel): Promise<string>;
  dispose(): void;
}

const STARTUP_MS = 30_000;
const SEARCH_GRACE_MS = 5_000;
const MAX_LINE_CHARS = 8_192;
const MAX_OUTPUT_CHARS = 262_144;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const BEST_MOVE = /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)(?: ponder [a-h][1-8][a-h][1-8][qrbn]?)?$/;

// Keep this public platform boundary usable by the separate Worker test runtime.
interface EngineWorkerPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { preventDefault(): void }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(command: string): void;
  terminate(): void;
}

/** Load only after computer play is chosen. No engine enters the main bundle. */
export async function createStockfish(signal?: AbortSignal): Promise<StockfishEngine> {
  if (signal?.aborted) throw new DOMException('Computer play was stopped.', 'AbortError');
  const { Worker } = globalThis as unknown as { Worker: new (url: string, options: { name: string }) => EngineWorkerPort };
  if (typeof Worker !== 'function') throw new Error('This browser cannot run the computer opponent.');
  const worker = new Worker(`/engines/${STOCKFISH_BUILD}/stockfish-19-lite-single.js`, { name: STOCKFISH_BUILD });
  let phase: 'uci' | 'ready' | 'idle' | 'barrier' | 'search' | 'disposed' = 'uci';
  let stopped: Error | null = null;
  let outputChars = 0;
  let timer: ReturnType<typeof setTimeout>;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let search: {
    moves: string;
    setting: NonNullable<ReturnType<typeof getEngineLevel>>;
    resolve: (move: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  function dispose(error = new Error('Computer play was stopped.')) {
    if (phase === 'disposed') return;
    phase = 'disposed';
    stopped = error;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try { worker.postMessage('stop'); worker.postMessage('quit'); } catch { /* The worker may already have failed. */ }
    worker.terminate();
    rejectReady(error);
    search?.reject(error);
    search = null;
  }
  function abort() { dispose(new DOMException('Computer play was stopped.', 'AbortError')); }
  function send(command: string) {
    try { worker.postMessage(command); }
    catch { dispose(new Error('The computer engine could not receive a command.')); }
  }

  const engine: StockfishEngine = {
    async bestMove(moves, level) {
      if (stopped) throw stopped;
      if (phase !== 'idle') throw new Error('The computer is already thinking.');
      const setting = getEngineLevel(level);
      if (!setting || !Array.isArray(moves) || moves.length > 4_096 || moves.some(move => typeof move !== 'string' || !UCI_MOVE.test(move))) {
        throw new Error('The computer could not read this game.');
      }
      phase = 'barrier';
      outputChars = 0;
      return new Promise<string>((resolve, reject) => {
        search = { moves: moves.join(' '), setting, resolve, reject };
        timer = setTimeout(() => dispose(new Error('The computer search timed out. Try again.')), setting.moveTimeMs + SEARCH_GRACE_MS);
        // Flush the previous completed search before accepting another result.
        send('isready');
      });
    },
    dispose: () => dispose(),
  };

  worker.onmessage = event => {
    if (phase === 'disposed') return;
    if (typeof event.data !== 'string' || event.data.length > MAX_OUTPUT_CHARS - outputChars) {
      dispose(new Error('The computer returned too much output. Try again.'));
      return;
    }
    outputChars += event.data.length;
    for (const raw of event.data.split('\n')) {
      if (raw.length > MAX_LINE_CHARS) { dispose(new Error('The computer returned invalid output. Try again.')); return; }
      const line = raw.trim();
      if (line === 'uciok' && phase === 'uci') {
        phase = 'ready';
        for (const option of ['Threads value 1', 'Hash value 16', 'Ponder value false', 'MultiPV value 1', 'UCI_LimitStrength value false']) {
          send(`setoption name ${option}`);
          if (stopped) return;
        }
        send('ucinewgame');
        send('isready');
      } else if (line === 'readyok' && phase === 'ready') {
        clearTimeout(timer);
        phase = 'idle';
        outputChars = 0;
        resolveReady();
      } else if (line === 'readyok' && phase === 'barrier' && search) {
        phase = 'search';
        send(`setoption name Skill Level value ${search.setting.skill}`);
        if (stopped || !search) return;
        send(`position startpos${search.moves ? ` moves ${search.moves}` : ''}`);
        if (stopped || !search) return;
        send(`go movetime ${search.setting.moveTimeMs}`);
      } else if (line.startsWith('bestmove')) {
        const match = BEST_MOVE.exec(line);
        if (phase !== 'search' || !search || !match) {
          dispose(new Error('The computer returned an invalid or old move. Try again.'));
          return;
        }
        const completed = search;
        search = null;
        phase = 'idle';
        clearTimeout(timer);
        outputChars = 0;
        completed.resolve(match[1]);
      }
    }
  };
  worker.onerror = event => { event.preventDefault(); dispose(new Error('The computer engine could not load. Try again.')); };
  worker.onmessageerror = () => dispose(new Error('The computer returned unreadable output. Try again.'));
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => dispose(new Error('The computer engine took too long to load. Try again.')), STARTUP_MS);
  send('uci');
  await ready;
  return engine;
}
