import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameCommand, GameSnapshot, ServerMessage } from '../shared/protocol';
import { gamePath } from '../shared/gamePath';
import { endedConnection, type EndedConnection } from './gameText';

type Action = GameCommand extends infer C ? C extends GameCommand ? Omit<C, 'id' | 'expectedVersion'> : never : never;

export function useGame(id: string | null) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline' | EndedConnection>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const current = useRef<GameSnapshot | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const command = useRef<GameCommand | null>(null);
  const transmit = useRef<((ws: WebSocket, next: GameCommand) => void) | null>(null);
  const reopen = useRef<(() => void) | null>(null);
  const receivedAt = useRef(0);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let ackTimer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    current.current = null;
    command.current = null;
    setSnapshot(null);
    setPending(false);
    setError('');
    transmit.current = null;
    reopen.current = null;
    if (!id) { setConnection('offline'); return; }
    function reconnect(ws: WebSocket) {
      if (closed || socket.current !== ws) return;
      clearTimeout(ackTimer);
      socket.current = null;
      setConnection('offline');
      ws.close();
      timer = setTimeout(open, Math.min(15_000, 500 * 2 ** Math.min(attempts++, 5)));
    }
    function watchCommand(ws: WebSocket, next: GameCommand) {
      clearTimeout(ackTimer);
      ackTimer = setTimeout(() => {
        if (command.current?.id === next.id) reconnect(ws);
      }, 10_000);
    }
    function write(ws: WebSocket, next: GameCommand) {
      try { ws.send(JSON.stringify(next)); }
      catch { reconnect(ws); return; }
      watchCommand(ws, next);
    }
    transmit.current = write;
    reopen.current = () => { if (!socket.current) { attempts = 0; open(); } };
    function open() {
      if (closed) return;
      setConnection('connecting');
      const url = new URL(gamePath(id!, 'connect'), location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url);
      let firstSnapshot = true;
      socket.current = ws;
      if (command.current) watchCommand(ws, command.current);
      ws.onopen = () => {
        if (closed || socket.current !== ws) return;
        attempts = 0;
        setConnection('online');
      };
      ws.onmessage = event => {
        if (closed || socket.current !== ws) return;
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === 'error') {
            setError(friendlyError(message.code));
            if (message.code === 'retry_later') reconnect(ws);
            else { clearTimeout(ackTimer); command.current = null; setPending(false); }
            return;
          }
          const state = message.type === 'snapshot' ? message.snapshot : message.reply.snapshot;
          if (!current.current || state.version > current.current.version || (state.version === current.current.version && state.serverNow >= current.current.serverNow)) {
            current.current = state;
            receivedAt.current = performance.now();
            setSnapshot(state);
          }
          if (message.type === 'command' && message.id === command.current?.id) {
            clearTimeout(ackTimer);
            command.current = null;
            setPending(false);
            setError(message.reply.ok ? '' : friendlyError(message.reply.code));
          } else if (message.type === 'snapshot' && firstSnapshot && command.current && ws.readyState === WebSocket.OPEN) {
            write(ws, command.current);
          }
          firstSnapshot = false;
        } catch {
          setError('The connection returned an unreadable message. Reconnecting to recover your action.');
          reconnect(ws);
        }
      };
      ws.onclose = event => {
        if (closed || socket.current !== ws) return;
        clearTimeout(ackTimer);
        const ended = endedConnection(event.code);
        if (!ended) { reconnect(ws); return; }
        socket.current = null;
        setConnection(ended);
        if (event.code === 4004) setError('This completed game has moved to Replay.');
      };
      ws.onerror = () => { if (!closed && socket.current === ws) setConnection('offline'); };
    }
    open();
    return () => { closed = true; clearTimeout(timer); clearTimeout(ackTimer); transmit.current = null; reopen.current = null; socket.current?.close(); socket.current = null; };
  }, [id]);

  const send = useCallback((action: Action, expectedVersion?: number) => {
    const ws = socket.current;
    if (!current.current || command.current || ws?.readyState !== WebSocket.OPEN) return false;
    if (expectedVersion !== undefined && current.current.version !== expectedVersion) return false;
    const next = { ...action, id: crypto.randomUUID(), expectedVersion: current.current.version } as GameCommand;
    command.current = next;
    setPending(true);
    setError('');
    transmit.current?.(ws, next);
    return true;
  }, []);
  /** Take the seat back from another tab. That tab is then the replaced one. */
  const resume = useCallback(() => reopen.current?.(), []);
  return { snapshot, connection, pending, error, send, resume, receivedAt };
}

function friendlyError(code: string) {
  const messages: Record<string, string> = {
    stale_version: 'The position changed. Please try your move again.',
    illegal_move: 'That move is not legal in this position.',
    not_your_turn: 'Wait for your turn.',
    game_over: 'The game has ended.',
    session_invalid: 'Your session has ended. Sign in again to reconnect.',
    retry_later: 'The server could not accept this action. Reconnect to retry it.',
    no_opponent_draw_offer: 'There is no opponent draw offer to answer.',
    draw_offer_pending: 'A draw offer is already waiting for a reply.',
    waiting_for_opponent: 'Wait for your opponent before getting ready.',
    ranked_eligibility_changed: 'This match could not start. Check your account notices.',
  };
  return messages[code] ?? 'This action could not be accepted. Check the position and try again.';
}
