import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStockfish } from '../src/client/stockfish';

class EngineWorker {
  static instances: EngineWorker[] = [];
  readonly commands: string[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(readonly url: string, readonly options: { name: string; type?: string }) { EngineWorker.instances.push(this); }
  postMessage(command: string) { this.commands.push(command); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

function latest() { return EngineWorker.instances.at(-1)!; }
async function ready(signal?: AbortSignal) {
  const loading = createStockfish(signal);
  latest().emit('id name Stockfish 19 Lite WASM\nuciok');
  latest().emit('readyok');
  return loading;
}

beforeEach(() => { EngineWorker.instances = []; vi.stubGlobal('Worker', EngineWorker); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded browser Stockfish adapter', () => {
  it('uses the pinned classic worker, fixed resource options, and full accepted move history', async () => {
    const engine = await ready();
    const worker = latest();
    expect(worker.url).toBe('/engines/stockfish-19.0.1-lite-single/stockfish-19-lite-single.js');
    expect(worker.options.type).toBeUndefined();
    expect(worker.commands).toEqual(['uci', 'setoption name Threads value 1', 'setoption name Hash value 16',
      'setoption name Ponder value false', 'setoption name MultiPV value 1', 'setoption name UCI_LimitStrength value false', 'ucinewgame', 'isready']);
    const move = engine.bestMove(['e2e4', 'e7e5', 'g1f3'], 'strong');
    expect(worker.commands.at(-1)).toBe('isready');
    worker.emit('readyok');
    expect(worker.commands.slice(-3)).toEqual(['setoption name Skill Level value 12', 'position startpos moves e2e4 e7e5 g1f3', 'go movetime 600']);
    worker.emit('info depth 8 score cp 10 pv b8c6\nbestmove b8c6 ponder f1b5');
    expect(await move).toBe('b8c6');
    engine.dispose();
    expect(worker.commands.slice(-2)).toEqual(['stop', 'quit']);
    expect(worker.terminated).toBe(true);
  });

  it('rejects concurrent searches and cancellation, and isolates a fresh retry from old worker output', async () => {
    const controller = new AbortController();
    const engine = await ready(controller.signal);
    const old = latest();
    const first = engine.bestMove(['e2e4'], 'club');
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    old.emit('readyok');
    await expect(engine.bestMove(['d2d4'], 'club')).rejects.toThrow('already thinking');
    controller.abort();
    await rejected;
    expect(old.terminated).toBe(true);
    const retry = await ready();
    const move = retry.bestMove(['e2e4'], 'club');
    latest().emit('readyok');
    old.emit('bestmove e7e5');
    latest().emit('bestmove c7c5');
    expect(await move).toBe('c7c5');
    retry.dispose();
  });

  it('can cancel startup and rejects a pre-aborted load without creating a worker', async () => {
    const controller = new AbortController();
    const loading = createStockfish(controller.signal);
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(latest().terminated).toBe(true);
    latest().emit('uciok\nreadyok');
    await expect(createStockfish(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(EngineWorker.instances).toHaveLength(1);
  });

  it('terminates when startup or a bounded search fails to complete', async () => {
    vi.useFakeTimers();
    const loading = createStockfish();
    const loadError = expect(loading).rejects.toThrow('too long to load');
    await vi.advanceTimersByTimeAsync(30_000);
    await loadError;
    expect(latest().terminated).toBe(true);
    const engine = await ready();
    const move = engine.bestMove(['e2e4'], 'maximum');
    const searchError = expect(move).rejects.toThrow('search timed out');
    latest().emit('readyok');
    await vi.advanceTimersByTimeAsync(6_200);
    await searchError;
    expect(latest().terminated).toBe(true);
  });

  it('rejects malformed, oversized, and out-of-order output without a fallback move', async () => {
    for (const output of ['bestmove (none)', 'bestmove 0000', 'bestmove e7e5\n'.repeat(20_000), { move: 'e7e5' }]) {
      const engine = await ready();
      const move = engine.bestMove(['e2e4'], 'relaxed');
      const rejected = expect(move).rejects.toThrow();
      latest().emit('readyok');
      latest().emit(output);
      await rejected;
      expect(latest().terminated).toBe(true);
    }
    const engine = await ready();
    const move = engine.bestMove(['e2e4'], 'relaxed');
    const rejected = expect(move).rejects.toThrow('old move');
    latest().emit('bestmove e7e5');
    await rejected;
    expect(latest().commands).not.toContain('go movetime 150');
  });

  it('bounds accumulated output and rejects input that could inject UCI commands', async () => {
    const engine = await ready();
    await expect(engine.bestMove(['e2e4\ngo infinite'], 'club')).rejects.toThrow('could not read');
    await expect(engine.bestMove(Array(4_097).fill('e2e4'), 'club')).rejects.toThrow('could not read');
    const move = engine.bestMove(['e2e4'], 'relaxed');
    const rejected = expect(move).rejects.toThrow('too much output');
    latest().emit('readyok');
    for (let index = 0; index < 34; index++) latest().emit('info ' + 'x'.repeat(8_000));
    await rejected;
    expect(latest().terminated).toBe(true);
  });

  it('terminates and rejects an in-flight search on worker transport failure', async () => {
    const engine = await ready();
    const move = engine.bestMove(['e2e4'], 'relaxed');
    const rejected = expect(move).rejects.toThrow('could not load');
    latest().onerror?.({ preventDefault() {} });
    await rejected;
    expect(latest().terminated).toBe(true);
    await expect(engine.bestMove(['e2e4'], 'relaxed')).rejects.toThrow('could not load');
  });
});
