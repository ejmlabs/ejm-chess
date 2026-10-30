import { useEffect, useRef, useState } from 'react';
import { getEngineLevel, STOCKFISH_BUILD } from '../shared/engine';
import type { GameCommand, GameSnapshot } from '../shared/protocol';
import type { StockfishEngine } from './stockfish';

type EngineMove = Extract<GameCommand, { type: 'move' | 'engine-move' }>;
type Send = (move: Omit<EngineMove, 'id' | 'expectedVersion'>, expectedVersion?: number) => boolean;
type Phase = 'idle' | 'loading' | 'ready' | 'thinking' | 'failed';

/** Local calculation proposes a move. The Game authority still accepts it. */
export function useComputer(state: GameSnapshot | null, ownerId: string | undefined, online: boolean, pending: boolean, send: Send) {
  const [engine, setEngine] = useState<StockfishEngine | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [settledSearch, setSettledSearch] = useState(0);
  const current = useRef({ state, online, pending });
  current.current = { state, online, pending };
  const running = useRef<StockfishEngine | null>(null);
  const searching = useRef<StockfishEngine | null>(null);
  const submitted = useRef<string | null>(null);
  const level = getEngineLevel(state?.ai?.level);
  const enabled = Boolean(state && state.white.id === ownerId && state.ai?.modelId === STOCKFISH_BUILD
    && level && online && ['ready', 'active'].includes(state.status));
  const gameId = enabled ? state!.id : null;

  useEffect(() => {
    submitted.current = null;
    setEngine(null);
    setError('');
    if (!gameId) { setPhase('idle'); return; }
    const controller = new AbortController();
    let instance: StockfishEngine | null = null;
    setPhase('loading');
    void import('./stockfish').then(module => module.createStockfish(controller.signal)).then(value => {
      if (controller.signal.aborted) { value.dispose(); return; }
      instance = value;
      running.current = value;
      setEngine(value);
      setPhase('ready');
    }).catch(() => {
      if (!controller.signal.aborted) {
        setError('Stockfish could not load on this device. Check your connection and retry.');
        setPhase('failed');
      }
    });
    return () => {
      controller.abort();
      instance?.dispose();
      if (running.current === instance) running.current = null;
      if (searching.current === instance) searching.current = null;
    };
  }, [gameId, attempt]);

  useEffect(() => {
    if (!engine || engine !== running.current || searching.current || !state || !level || !online || pending
      || phase === 'failed' || state.status !== 'active' || state.turn !== 'b') return;
    const key = `${state.id}:${state.version}`;
    if (submitted.current === key) return;
    const version = state.version;
    const fen = state.fen;
    const id = state.id;
    searching.current = engine;
    setPhase('thinking');
    const moves = state.moves.map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
    void engine.bestMove(moves, level.id).then(uci => {
      const latest = current.current;
      if (engine !== running.current || !latest.online || latest.pending || latest.state?.id !== id
        || latest.state.version !== version || latest.state.fen !== fen || latest.state.status !== 'active'
        || latest.state.turn !== 'b') return;
      const move = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
      if (!move) throw new Error('Invalid engine move');
      if (send({ type: 'engine-move', from: move[1], to: move[2],
        ...(move[3] ? { promotion: move[3] as 'q' | 'r' | 'b' | 'n' } : {}) }, version)) submitted.current = key;
    }).catch(() => {
      if (engine === running.current) {
        setError('Stockfish could not finish its search. Retry the computer. The server clocks keep running.');
        setPhase('failed');
      }
    }).finally(() => {
      if (searching.current === engine) searching.current = null;
      if (engine === running.current) {
        setPhase(value => value === 'failed' ? value : 'ready');
        setSettledSearch(value => value + 1);
      }
    });
  }, [engine, state?.id, state?.version, level?.id, online, pending, settledSearch]);

  return { phase, error, ready: phase === 'ready' || phase === 'thinking', retry: () => setAttempt(value => value + 1) };
}
