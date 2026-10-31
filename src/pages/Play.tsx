import { AppActions, AppField, AppFlow, AppForm, AppGroup, AppHeading, AppSection, BoardPlaceholder, GameWorkspace, MovePairs, PlayerStrip } from '@ejm/ui/layout/Application';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearch } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Select } from '@ejm/ui/components/ui/select';
import { Switch } from '@ejm/ui/components/ui/switch';
import { Input } from '@ejm/ui/components/ui/input';
import { Textarea } from '@ejm/ui/components/ui/textarea';
import { RadioGroup } from '@ejm/ui/components/ui/radio-group';
import { Disclosure } from '@ejm/ui/components/ui/disclosure';
import { GameClock } from '@ejm/ui/components/GameClock';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Page } from '@ejm/ui/layout/Band';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Text } from '@ejm/ui/layout/Text';
import { api, RequestFailure, type Me, type PublicConfig } from '../client/api';
import { accountPath, isPlayMode, type PlayMode } from '../client/accountPath';
import Challenge from '../client/Challenge';
import { useGame } from '../client/useGame';
import { useComputer } from '../client/useComputer';
import { submitLegalMove } from '../client/moveDispatch';
import { markOpenGame, readOpenGames } from '../client/openGames';
import { clockText, resultText } from '../client/gameText';
import type { Move } from '../client/Board';
import { FORMATS, type Color, type GameSnapshot, type Pool, type QueueState } from '../shared/protocol';
import { gamePath, isGameId } from '../shared/gamePath';
import { ENGINE_LEVELS, STOCKFISH_BUILD, type EngineLevel } from '../shared/engine';

const Board = lazy(() => import('../client/Board'));
const LEGAL_MOVES_KEY = 'chess.showLegalMoves';
const QUEUED = ['queued', 'reserved', 'settling', 'live'];
const poolName = (pool: Pool) => pool === 'blitz' ? 'Blitz' : 'Rapid';
const sideName = (color: Color) => color === 'w' ? 'White' : 'Black';
const unfinished = (state: GameSnapshot) => ['waiting', 'ready', 'active'].includes(state.status);

/** Re-render while a host-estimated countdown is visible. The server still owns every deadline. */
function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick(value => value + 1), 200);
    return () => clearInterval(timer);
  }, [active]);
}

function Clock({ state, color, receivedAt }: { state: GameSnapshot; color: Color; receivedAt: number }) {
  const running = state.status === 'active' && state.clocks.running === color;
  useTick(running);
  const remaining = Math.max(0, state.clocks[color] - (running ? Math.max(0, performance.now() - receivedAt) : 0));
  const seconds = Math.ceil(remaining / 1000);
  const low = remaining < 20_000;
  return <GameClock value={clockText(remaining)} running={running} low={low}
    label={`${sideName(color)} clock, ${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds${running ? ', running' : ''}${low ? ', low time' : ''}`} />;
}

/** Not a live region: a ticking countdown must not interrupt a screen reader every second. */
function Deadline({ state, receivedAt, children }: { state: GameSnapshot; receivedAt: number; children: string }) {
  useTick(true);
  if (state.readinessDeadline === null) return null;
  const left = state.readinessDeadline - state.serverNow - (performance.now() - receivedAt);
  return <Text as="p" variant="muted">{children.replace('{time}', clockText(left))}</Text>;
}

interface OpenGame { id: string; label: string; state: string }

function describeOpenGame(state: GameSnapshot, me: Me): OpenGame {
  const color: Color = state.white.id === me.id ? 'w' : 'b';
  const opponent = color === 'w' ? state.black : state.white;
  return {
    id: state.id,
    label: `${poolName(state.format)} ${FORMATS[state.format].label}${opponent ? ` vs ${opponent.name}` : ''}`,
    state: state.status === 'waiting' ? 'Waiting for an opponent' : state.status === 'ready' ? 'Get ready' : state.turn === color ? 'Your move' : 'Their move',
  };
}

export default function Play() {
  const search = useSearch();
  return <PlaySession key={search} search={search} />;
}

function PlaySession({ search }: { search: string }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [joinedId, setJoinedId] = useState<string | null>(null);
  // checking: reading the participant snapshot; open: this account has no seat yet.
  const [entry, setEntry] = useState<'checking' | 'open' | 'archived' | 'unavailable' | 'failed'>('checking');
  const [entryAttempt, setEntryAttempt] = useState(0);
  const [format, setFormat] = useState<Pool>('blitz');
  const [mode, setMode] = useState<PlayMode>('casual');
  const [engineLevel, setEngineLevel] = useState<EngineLevel>('club');
  const [openGames, setOpenGames] = useState<OpenGame[]>([]);
  const [openGamesAttempt, setOpenGamesAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [queue, setQueue] = useState<QueueState>({ status: 'idle' });
  const [sound, setSound] = useState(false);
  const [premoveEnabled, setPremoveEnabled] = useState(false);
  const [showLegalMoves, setShowLegalMoves] = useState(true);
  const [premove, setPremove] = useState<Move | null>(null);
  const [textMove, setTextMove] = useState('');
  const [confirmResign, setConfirmResign] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('engine-assistance');
  const [reportDetails, setReportDetails] = useState('');
  const [reportToken, setReportToken] = useState('');
  const [reportKey, setReportKey] = useState(0);
  const createId = useRef<string | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const soundedPly = useRef(0);
  const { snapshot: state, connection, pending, error: gameError, send, receivedAt } = useGame(joinedId);
  const color: Color = state?.white.id === me?.id ? 'w' : 'b';
  const active = state?.status === 'active';
  const computer = useComputer(state, me?.id, connection === 'online', pending, send);

  useEffect(() => {
    try { setShowLegalMoves(localStorage.getItem(LEGAL_MOVES_KEY) !== 'false'); }
    catch { /* Keep the default when browser storage is blocked. */ }
  }, []);

  function changeLegalMoves(value: boolean) {
    setShowLegalMoves(value);
    try { localStorage.setItem(LEGAL_MOVES_KEY, String(value)); }
    catch { /* The switch still works for this page. */ }
  }

  useEffect(() => {
    // Wait for the live query after the static hydration snapshot.
    if (search !== location.search) return;
    const query = new URLSearchParams(search);
    const invitation = query.get('game');
    if (invitation !== null && !isGameId(invitation)) setError('This invitation link is invalid.');
    else setId(invitation);
    if (query.get('format') === 'rapid') setFormat('rapid');
    const requested = query.get('mode');
    if (isPlayMode(requested)) setMode(requested);
    void Promise.all([api<PublicConfig>('/api/config'), api<Me | null>('/api/me')])
      .then(async ([value, actor]) => {
        setConfig(value); setMe(actor);
        if (actor && invitation === null) setQueue(await api<QueueState>('/api/queue'));
        setLoaded(true);
      })
      .catch(reason => { setError(String(reason.message)); setLoaded(true); });
  }, [search]);

  // A participant snapshot resumes the seat. Only a 404 offers Join, and only a click claims a seat.
  useEffect(() => {
    if (!id || !me || joinedId === id) return;
    let cancelled = false;
    setEntry('checking');
    void api<GameSnapshot>(gamePath(id)).then(() => { if (!cancelled) setJoinedId(id); })
      .catch(reason => {
        if (cancelled) return;
        const status = reason instanceof RequestFailure ? reason.status : 0;
        if (status === 410) setEntry('archived');
        else if (status === 404) setEntry('open');
        else { setEntry('failed'); setError(String(reason.message)); }
      });
    return () => { cancelled = true; };
  }, [id, me, joinedId, entryAttempt]);

  // Resume links for games this browser opened. The server answers only for this account's seats.
  useEffect(() => {
    if (!me || id) return;
    let cancelled = false;
    void Promise.all(readOpenGames().map(gameId => api<GameSnapshot>(gamePath(gameId)).then(game => {
      if (unfinished(game)) return describeOpenGame(game, me);
      markOpenGame(gameId, false);
      return null;
    }).catch(reason => {
      if (reason instanceof RequestFailure && [404, 410].includes(reason.status)) markOpenGame(gameId, false);
      return null;
    }))).then(games => { if (!cancelled) setOpenGames(games.filter(game => game !== null)); });
    return () => { cancelled = true; };
  }, [me, id, openGamesAttempt]);

  useEffect(() => {
    if (state) markOpenGame(state.id, unfinished(state));
  }, [state?.id, state?.status]);

  const openGame = useCallback((gameId: string, enter = false) => {
    const url = new URL('/play/', location.origin);
    url.searchParams.set('game', gameId);
    history.replaceState(null, '', url);
    setId(gameId);
    if (enter) setJoinedId(gameId);
    setMessage('');
    setError('');
  }, []);

  useEffect(() => {
    if (!QUEUED.includes(queue.status)) return;
    if ('gameId' in queue && joinedId === queue.gameId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<QueueState>('/api/queue');
        if (cancelled) return;
        setQueue(next);
        if ('gameId' in next) {
          // A reservation can precede successful Game initialization. Keep
          // its queue lease alive until the authority can return our seat.
          try { await api<GameSnapshot>(gamePath(next.gameId)); }
          catch (reason) {
            if (reason instanceof RequestFailure && reason.status === 404 && next.status === 'reserved') {
              if (!cancelled) timer = setTimeout(poll, 2000);
              return;
            }
            throw reason;
          }
          if (!cancelled) openGame(next.gameId, true);
        }
        if (!cancelled && QUEUED.includes(next.status)) timer = setTimeout(poll, 2000);
      } catch (reason) {
        if (!cancelled) { setError((reason as Error).message); timer = setTimeout(poll, 5000); }
      }
    }
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [queue.status, 'gameId' in queue ? queue.gameId : null, joinedId, openGame]);

  useEffect(() => {
    if (!state || !premove || pending || connection !== 'online') return;
    if (state.status !== 'active') { setPremove(null); return; }
    if (state.turn === color) {
      submitLegalMove(state, premove, send);
      setPremove(null);
    }
  }, [state, premove, pending, connection, color, send]);

  useEffect(() => {
    if (!state) return;
    if (state.moves.length > soundedPly.current && sound && audio.current) {
      const context = audio.current;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 520;
      gain.gain.setValueAtTime(0.025, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.055);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.06);
    }
    soundedPly.current = state.moves.length;
  }, [state?.moves.length, sound]);
  useEffect(() => () => { void audio.current?.close(); }, []);

  async function run(action: () => Promise<void>, reset?: 'report') {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); if (reset === 'report') { setReportToken(''); setReportKey(value => value + 1); } }
  }
  async function start() {
    await run(async () => {
      if (!me?.accountReady) throw new Error('Create an account or sign in before starting a new game.');
      if (mode === 'ranked') { setQueue(await api<QueueState>('/api/queue', { pool: format })); return; }
      createId.current ??= crypto.randomUUID();
      try {
        const created = await api<GameSnapshot>('/api/games', { id: createId.current, format, ...(mode === 'ai' ? { ai: { modelId: STOCKFISH_BUILD, level: engineLevel } } : {}) });
        createId.current = null;
        openGame(created.id, true);
      } catch (reason) {
        if (!(reason instanceof RequestFailure) || reason.code !== 'SEAT_UNAVAILABLE') throw reason;
        createId.current = null;
        setOpenGamesAttempt(value => value + 1);
        throw new Error(`${reason.message} Unused invitations expire after ten minutes.`);
      }
    });
  }
  async function join() {
    if (!id) return;
    await run(async () => {
      try {
        await api<GameSnapshot>(gamePath(id, 'join'), {});
        setJoinedId(id);
      } catch (reason) {
        if (reason instanceof RequestFailure && reason.status === 410) { setEntry('archived'); return; }
        if (reason instanceof RequestFailure && (reason.status === 404 || reason.code === 'INVITATION_UNAVAILABLE')) { setEntry('unavailable'); return; }
        throw reason;
      }
    });
  }
  function move(value: Move) {
    if (!state || !active || connection !== 'online' || pending) return;
    setConfirmResign(false);
    if (state.turn === color) { submitLegalMove(state, value, send); return; }
    if (premoveEnabled) setPremove(value);
  }
  function backToLobby() {
    createId.current = null;
    if (state) { setFormat(state.format); setMode(state.ai ? 'ai' : state.rated ? 'ranked' : 'casual'); }
    setId(null); setJoinedId(null); setEntry('checking'); setQueue({ status: 'idle' }); setPremove(null); setConfirmResign(false);
    setReportOpen(false); setReportDetails(''); setReportToken(''); setReportKey(value => value + 1);
    setError(''); setMessage('');
    history.replaceState(null, '', '/play/');
  }

  const opponent = state && (color === 'w' ? state.black : state.white);
  const self = state && (color === 'w' ? state.white : state.black);
  const opponentName = opponent?.name ?? 'Your opponent';
  const done = state?.status === 'finished' || state?.status === 'pending-adjudication';
  const returnTo = '/play/?' + new URLSearchParams({ ...(id ? { game: id } : {}), format, mode });
  const queued = QUEUED.includes(queue.status);
  const notice = (error || gameError) && <StateBlock kind="error" message={error || gameError} density="compact" />;
  const accountActions = me
    ? <Button asChild><Link href={accountPath(returnTo)}>{me.isAnonymous ? 'Account options' : 'Finish account'}</Link></Button>
    : <><Button asChild><Link href={accountPath(returnTo, 'sign-up')}>Create account</Link></Button><Button asChild variant="ghost"><Link href={accountPath(returnTo, 'sign-in')}>Sign in</Link></Button></>;

  if (state) {
    const tournamentLink = state.tournament && `/tournaments/?${state.tournament.format === 'arena-v1' ? 'arena' : 'event'}=${encodeURIComponent(state.tournament.id)}`;
    const kind = state.ai ? 'Stockfish practice' : state.tournament ? (state.tournament.format === 'arena-v1' ? 'Arena' : `Tournament round ${state.tournament.round}`) : state.rated ? 'Ranked' : 'Casual';
    const rating = !state.rated ? 'Unrated' : state.settlement === 'settled' ? 'Rating updated' : done ? 'Rating pending' : 'Rated';
    const status = done ? resultText(state, color)
      : connection !== 'online' ? 'Reconnecting. The clocks keep running.'
        : state.status === 'waiting' ? 'Waiting for your friend to join.'
          : state.status === 'ready' ? (state.ai
            ? computer.phase === 'loading' ? 'Loading Stockfish on this device…' : 'Press Ready to start the clocks.'
            : self?.ready ? `Waiting for ${opponentName} to get ready.` : opponent?.ready ? `${opponentName} is ready. Press Ready to start.` : 'Press Ready to start. Both players must be ready.')
            : state.drawOfferedBy && state.drawOfferedBy !== color ? `${opponentName} offers a draw.`
              : pending ? 'Sending your move…'
                : state.ai?.thinking ? 'Stockfish is thinking. Its clock is running.'
                  : state.turn === color ? 'Your move.' : `${opponentName} to move.`;
    const inviteUrl = typeof location === 'undefined' ? '' : `${location.origin}/play/?game=${state.id}`;
    return <Page variant="application">
      <GameWorkspace label="Chess game" detailsLabel="Game status, actions and moves" board={<AppGroup>
        <PlayerStrip name={state.status === 'waiting' ? 'Waiting for an opponent' : opponentName} detail={sideName(color === 'w' ? 'b' : 'w')}><Clock state={state} color={color === 'w' ? 'b' : 'w'} receivedAt={receivedAt.current} /></PlayerStrip>
        <Suspense fallback={<BoardPlaceholder><StateBlock kind="loading" message="Opening the chessboard." density="compact" skeleton={false} /></BoardPlaceholder>}><Board fen={state.fen} color={color} enabled={Boolean(active && connection === 'online' && !pending && (state.turn === color || premoveEnabled))} showLegalMoves={showLegalMoves} onMove={move} lastMove={state.moves.at(-1)} premove={premove} /></Suspense>
        <PlayerStrip name={<>{self?.name ?? 'You'} <Text variant="muted">(you)</Text></>} detail={sideName(color)}><Clock state={state} color={color} receivedAt={receivedAt.current} /></PlayerStrip>
      </AppGroup>}>
        <SectionHead purpose="application" as="h1" title={FORMATS[state.format].label}><Text as="p" variant="muted">{poolName(state.format)} · {kind} · {rating}</Text></SectionHead>
        <AppGroup>
          <Text as="p" role="status" aria-live="polite">{status}{premove && <> Premove {premove.from} to {premove.to}. <Button variant="link" density="compact" onClick={() => setPremove(null)}>Cancel premove</Button></>}</Text>
          {state.status === 'waiting' && <AppGroup>
            <AppActions><Button onClick={() => void run(async () => { await navigator.clipboard.writeText(inviteUrl); setMessage('Link copied.'); })}>Copy invitation link</Button></AppActions>
            <Input aria-label="Invitation link" readOnly value={inviteUrl} onFocus={event => event.target.select()} />
          </AppGroup>}
          {state.status === 'ready' && !self?.ready && <AppActions><Button disabled={pending || connection !== 'online' || Boolean(state.ai && !computer.ready)} onClick={() => send({ type: 'ready' })}>Ready</Button></AppActions>}
          {(state.status === 'waiting' || state.status === 'ready') && <Deadline state={state} receivedAt={receivedAt.current}>{state.status === 'waiting' ? 'The link expires in {time}.' : '{time} left to get ready.'}</Deadline>}
          {active && <AppActions>
            {!state.ai && (state.drawOfferedBy && state.drawOfferedBy !== color
              ? <><Button variant="secondary" density="compact" disabled={pending} onClick={() => send({ type: 'accept-draw' })}>Accept draw</Button><Button variant="ghost" density="compact" disabled={pending} onClick={() => send({ type: 'decline-draw' })}>Decline draw</Button></>
              : <Button variant="secondary" density="compact" disabled={pending || state.drawOfferedBy === color} onClick={() => send({ type: 'offer-draw' })}>{state.drawOfferedBy === color ? 'Draw offered' : 'Offer draw'}</Button>)}
            {confirmResign
              ? <><Button variant="danger" density="compact" disabled={pending} onClick={() => { send({ type: 'resign' }); setConfirmResign(false); }}>Confirm resign</Button><Button variant="ghost" density="compact" onClick={() => setConfirmResign(false)}>Keep playing</Button></>
              : <Button variant="ghost" density="compact" onClick={() => setConfirmResign(true)}>Resign</Button>}
          </AppActions>}
          {state.ai && (computer.error || (gameError && state.turn === 'b' && active)) && <AppGroup>{computer.error && <StateBlock kind="error" message={computer.error} density="compact" />}<div><Button variant="secondary" disabled={pending || connection !== 'online'} onClick={computer.retry}>Retry Stockfish</Button></div></AppGroup>}
          {done && <AppActions>
            {tournamentLink ? <Button asChild><Link href={tournamentLink}>Back to {state.tournament?.format === 'arena-v1' ? 'arena' : 'tournament'}</Link></Button> : <Button onClick={backToLobby}>New game</Button>}
            {state.status === 'finished' && <><Button asChild variant="secondary" density="compact"><Link href={`/replay/?game=${encodeURIComponent(state.id)}`}>Replay</Link></Button><Button asChild variant="ghost" density="compact"><a href={gamePath(state.id, 'pgn')}>Download PGN</a></Button></>}
          </AppActions>}
          {notice}
          {message && <Text as="p" role="status">{message}</Text>}
        </AppGroup>
        {state.moves.length > 0
          ? <MovePairs label="Moves" moves={Array.from({ length: Math.ceil(state.moves.length / 2) }, (_, index) => ({ number: index + 1, white: state.moves[index * 2]?.san, black: state.moves[index * 2 + 1]?.san }))} />
          : <Text as="p" variant="muted">No moves yet.</Text>}
        <AppActions role="group" aria-label="Board settings">
          <Switch density="compact" label="Legal moves" checked={showLegalMoves} onCheckedChange={changeLegalMoves} />
          <Switch density="compact" label="Premove" checked={premoveEnabled} onCheckedChange={value => { setPremoveEnabled(value); if (!value) setPremove(null); }} />
          <Switch density="compact" label="Sound" checked={sound} onCheckedChange={value => { setSound(value); if (value) { audio.current ??= new AudioContext(); void audio.current.resume(); } }} />
        </AppActions>
        {active && <Disclosure summary="Type a move"><AppForm onSubmit={event => { event.preventDefault(); const match = /^([a-h][1-8])\s*([a-h][1-8])([qrbn])?$/.exec(textMove.trim().toLowerCase()); if (!match) { setError('Enter a move such as e2e4 or a7a8n.'); return; } move({ from: match[1], to: match[2], promotion: match[3] as Move['promotion'] }); setTextMove(''); }}><label htmlFor="text-move">From and to squares, plus a promotion letter if needed</label><AppActions><Input id="text-move" placeholder="e2e4" value={textMove} onChange={event => setTextMove(event.target.value)} maxLength={8} autoComplete="off" /><Button type="submit" variant="secondary" disabled={pending || connection !== 'online'}>Move</Button></AppActions></AppForm></Disclosure>}
        {state.status === 'finished' && !state.ai && config && <Disclosure open={reportOpen} onToggle={event => setReportOpen(event.currentTarget.open)} summary="Report a concern"><AppFlow>{!config.reviewAvailable && <Text as="p" variant="muted">Reports are stored privately. No reviewer is active, and reports never cause automatic penalties.</Text>}<AppForm onSubmit={event => { event.preventDefault(); void run(async () => { await api('/api/reports', { gameId: state.id, reason: reportReason, details: reportDetails }, reportToken); setMessage(config.reviewAvailable ? 'Your report was recorded for private review.' : 'Your report was recorded privately. No reviewer is active, and no automatic penalty follows.'); setReportOpen(false); }, 'report'); }}><AppField><label htmlFor="report-reason">Concern</label><Select id="report-reason" value={reportReason} onChange={event => setReportReason(event.target.value)}><option value="engine-assistance">Outside assistance</option><option value="rating-manipulation">Rating manipulation</option><option value="account-abuse">Account abuse</option><option value="other">Other</option></Select></AppField><AppField><label htmlFor="report-details">Details</label><Textarea required minLength={10} id="report-details" value={reportDetails} maxLength={1000} onChange={event => setReportDetails(event.target.value)} /></AppField><Challenge key={reportKey} config={config} action="report" onToken={setReportToken} /><div><Button type="submit" variant="secondary" disabled={busy || !reportToken}>Send report</Button></div></AppForm></AppFlow></Disclosure>}
        <Text as="p" variant="muted">{tournamentLink && !done && <><Link href={tournamentLink}>{state.tournament?.format === 'arena-v1' ? 'Arena' : 'Tournament'}</Link> · </>}<Link href="/help/">Help</Link> · <Link href="/rules/">Rules</Link></Text>
      </GameWorkspace>
    </Page>;
  }

  if (id) {
    const signedIn = Boolean(me);
    const title = !loaded || (signedIn && entry === 'checking') ? 'Opening game' : entry === 'archived' ? 'Game finished' : entry === 'unavailable' ? 'Invitation unavailable' : 'Join game';
    return <Page variant="application"><AppSection>
      <SectionHead purpose="application" as="h1" title={title}>
        {loaded && entry === 'open' && me?.accountReady && <Text as="p">The first player to join takes the open seat.</Text>}
        {loaded && (!me || (entry === 'open' && !me.accountReady)) && <Text as="p">{me?.isAnonymous ? 'New games need an account. This guest session can still resume its own games.' : 'Sign in to join this invitation.'}</Text>}
        {entry === 'unavailable' && <Text as="p">Unused invitations expire after ten minutes. Ask your friend for a new link.</Text>}
        {entry === 'archived' && <Text as="p">This game is in Replay.</Text>}
      </SectionHead>
      {(!loaded || (signedIn && entry === 'checking')) && <StateBlock kind="loading" message="Opening the game…" density="compact" />}
      {loaded && entry === 'open' && me?.accountReady && <AppActions><Button disabled={busy} onClick={() => void join()}>{busy ? 'Joining…' : 'Join game'}</Button></AppActions>}
      {loaded && (!me || (entry === 'open' && !me.accountReady)) && <AppActions>{accountActions}</AppActions>}
      {entry === 'archived' && <AppActions><Button asChild><Link href={`/replay/?game=${encodeURIComponent(id)}`}>Open replay</Link></Button><Button variant="ghost" onClick={backToLobby}>New game</Button></AppActions>}
      {entry === 'unavailable' && <AppActions><Button onClick={backToLobby}>New game</Button></AppActions>}
      {entry === 'failed' && <AppActions><Button variant="secondary" onClick={() => { setError(''); setEntryAttempt(value => value + 1); }}>Try again</Button></AppActions>}
      {notice}
    </AppSection></Page>;
  }

  const modes = [
    { value: 'casual', label: 'Friend', description: 'Share a link. Unrated.' },
    { value: 'ranked', label: 'Ranked', description: config && !config.ranked ? 'Closed now.' : 'Matched opponent. Rated.', disabled: Boolean(config && !config.ranked) || queued },
    ...(config?.ai ? [{ value: 'ai', label: 'Stockfish', description: 'Practice on this device. Unrated.' }] : []),
  ];
  return <Page variant="application"><AppSection>
    <SectionHead purpose="application" as="h1" title="Play" />
    {!loaded && <StateBlock kind="loading" message="Loading…" density="compact" />}
    {openGames.length > 0 && <AppGroup as="section" aria-labelledby="open-games-heading">
      <AppHeading as="h2" id="open-games-heading">Your open games</AppHeading>
      <AppGroup as="ul">{openGames.map(game => <li key={game.id}><Link href={`/play/?game=${encodeURIComponent(game.id)}`}>{game.label}</Link> <Text variant="muted">· {game.state}</Text></li>)}</AppGroup>
    </AppGroup>}
    {loaded && <AppFlow>
      <RadioGroup label="Opponent" name="mode" value={mode} disabled={queued}
        onValueChange={value => { if (isPlayMode(value)) setMode(value); createId.current = null; }} options={modes} />
      <RadioGroup label="Time control" name="format" value={format} disabled={queued} onValueChange={value => { setFormat(value as Pool); createId.current = null; }}
        options={(Object.keys(FORMATS) as Pool[]).map(value => ({ value, label: FORMATS[value].label, description: poolName(value) }))} />
      {mode === 'ai' && <AppField><label htmlFor="engine-level">Stockfish strength</label><Select id="engine-level" value={engineLevel} disabled={busy} onChange={event => { setEngineLevel(event.target.value as EngineLevel); createId.current = null; }}>{ENGINE_LEVELS.map(level => <option key={level.id} value={level.id}>{level.name}</option>)}</Select><Text as="p" variant="muted">You play White. Strength varies by device. Keep this tab open: the clocks keep running.</Text></AppField>}
      <AppGroup>
        {me?.accountReady
          ? <AppActions><Button disabled={busy || queued || (mode === 'ranked' && !config?.ranked)} onClick={() => void start()}>{busy ? 'Starting…' : mode === 'ranked' ? 'Find opponent' : mode === 'ai' ? 'Play Stockfish' : 'Create invitation'}</Button></AppActions>
          : <AppGroup><Text as="p">{me?.isAnonymous ? 'New games need an account. This guest session can still resume its own games.' : me ? 'Set a username and password to start games.' : 'Create a free account to play. Recovery email is optional.'}</Text><AppActions>{accountActions}</AppActions></AppGroup>}
        {queue.status === 'queued' && <AppActions><Text role="status">Looking for a {poolName(queue.pool).toLowerCase()} {FORMATS[queue.pool].label} opponent…</Text><Button variant="ghost" density="compact" onClick={() => void run(async () => setQueue(await api('/api/queue/cancel', {})))}>Cancel search</Button></AppActions>}
        {['reserved', 'live', 'settling'].includes(queue.status) && <Text as="p" role="status">Opponent found. Opening the board…</Text>}
        {queue.status === 'closed' && <Text as="p" role="status">{queue.reason}</Text>}
        {queue.status === 'tournament' && <Text as="p" role="status">You are in a tournament. <Link href={`/tournaments/?event=${encodeURIComponent(queue.tournamentId)}`}>Open your tournament</Link>.</Text>}
        {notice}
      </AppGroup>
      {me && !me.isAnonymous && <Text as="p" variant="muted">Playing as {me.username ?? me.name}. <Link href="/rules/">Rules</Link> · <Link href="/fair-play/">Fair play</Link></Text>}
    </AppFlow>}
  </AppSection></Page>;
}
