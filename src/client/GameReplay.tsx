import { lazy, Suspense, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@ejm/ui/components/ui/button';
import { Disclosure } from '@ejm/ui/components/ui/disclosure';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { AppActions, AppGroup, AppPre, BoardPlaceholder, GameWorkspace, MoveHistory } from '@ejm/ui/layout/Application';
import { Text } from '@ejm/ui/layout/Text';
import { parseReplay, ReplayError } from './replay';
import type { Color } from '../shared/protocol';
import { STOCKFISH_BUILD } from '../shared/engine';

const Board = lazy(() => import('./Board'));

function resultLabel(result: string): string {
  if (result === '1-0') return 'White won';
  if (result === '0-1') return 'Black won';
  if (result === '1/2-1/2') return 'Draw';
  return 'No scored result';
}

/** Read the authority's PGN with the same maintained rules package as play. */
export default function GameReplay({ pgn, heading }: { pgn: string; heading?: ReactNode }) {
  const parsed = useMemo(() => {
    try { return { record: parseReplay(pgn) }; }
    catch (error) { return { error: error instanceof ReplayError ? error.message : 'This recorded game could not be replayed.' }; }
  }, [pgn]);
  const [navigation, setNavigation] = useState({ source: pgn, ply: 0, color: 'w' as Color });
  const helpId = useId();
  const sameSource = navigation.source === pgn;
  if (!sameSource) setNavigation({ source: pgn, ply: 0, color: 'w' });
  const moves = parsed.record?.moves ?? [];
  const cursor = sameSource ? Math.min(navigation.ply, moves.length) : 0;
  const color = sameSource ? navigation.color : 'w';
  if (!parsed.record) return <StateBlock kind="error" density="compact" message={parsed.error ?? 'This recorded game could not be replayed.'} />;
  const record = parsed.record;
  const move = moves[cursor - 1];
  function choose(ply: number) {
    setNavigation(current => ({ source: pgn, ply: Math.max(0, Math.min(ply, moves.length)), color: current.source === pgn ? current.color : 'w' }));
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable], summary, a'))) return;
    const destination = event.key === 'ArrowLeft' ? cursor - 1 : event.key === 'ArrowRight' ? cursor + 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? moves.length : null;
    if (destination === null) return;
    event.preventDefault();
    choose(destination);
  }
  return <GameWorkspace label="Recorded game" detailsLabel="Recorded players and moves" aria-describedby={helpId}
    tabIndex={0} onKeyDown={keyboard} aria-keyshortcuts="ArrowLeft ArrowRight Home End"
    board={<AppGroup>
      <Suspense fallback={<BoardPlaceholder><StateBlock kind="loading" density="compact" skeleton={false} message="Opening the recorded board…" /></BoardPlaceholder>}>
        <Board fen={move?.after ?? record.initialFen} color={color} enabled={false} readOnly onMove={() => { }} lastMove={move} premove={null} />
      </Suspense>
      <Text as="p" variant="code" role="status" aria-live="polite" aria-atomic="true">
        {move ? `${move.number}${move.color === 'w' ? '.' : '…'} ${move.san}` : 'Starting position'} · {cursor} of {moves.length} half-moves
      </Text>
      <AppActions role="group" aria-label="Replay navigation">
        <Button variant="ghost" density="compact" disabled={!cursor} onClick={() => choose(0)}>Start</Button>
        <Button variant="secondary" density="compact" disabled={!cursor} onClick={() => choose(cursor - 1)}>Previous</Button>
        <Button variant="secondary" density="compact" disabled={cursor === moves.length} onClick={() => choose(cursor + 1)}>Next</Button>
        <Button variant="ghost" density="compact" disabled={cursor === moves.length} onClick={() => choose(moves.length)}>End</Button>
        <Button variant="ghost" density="compact" aria-pressed={color === 'b'} onClick={() => setNavigation({ source: pgn, ply: cursor, color: color === 'w' ? 'b' : 'w' })}>Flip board</Button>
      </AppActions>
    </AppGroup>}
    after={<Disclosure summary="Recorded PGN"><AppPre>{pgn}</AppPre></Disclosure>}>
    {heading}
    <AppGroup><Text as="strong" variant="strong">{record.white}</Text><Text variant="muted">vs</Text><Text as="strong" variant="strong">{record.black}</Text></AppGroup>
    <Text as="p">{resultLabel(record.result)}{record.timeControl && <Text variant="muted"> · {record.timeControl}</Text>}</Text>
    {record.ai && <Text as="p" variant="muted">{record.ai.model === STOCKFISH_BUILD ? 'Stockfish practice · Unrated' : <>AI game · Unrated{(record.ai.actualModel || record.ai.model) && <> · {record.ai.actualModel || record.ai.model}</>}</>}</Text>}
    {moves.length ? <MoveHistory items={moves.map((item, index) => ({ id: index + 1, number: item.number, color: item.color, san: item.san }))}
      label="Recorded moves" selectedId={cursor} onSelect={choose} />
      : <StateBlock kind="empty" density="compact" message="No moves were played in this game." />}
    <Text as="p" variant="muted" id={helpId}>Keyboard: Left and Right step through moves. Home and End jump to the start and the end.</Text>
  </GameWorkspace>;
}
