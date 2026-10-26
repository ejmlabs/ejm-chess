import { AppActions, AppField, AppFlow, AppForm, AppGroup, AppSection, BoardPlaceholder, GameWorkspace, MovePairs, PlayerStrip } from '@ejm/ui/layout/Application';
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
import { Rule } from '@ejm/ui/layout/Rule';
import { api, RequestFailure, type Me, type PublicConfig } from '../client/api';
import { accountPath } from '../client/accountPath';
import Challenge from '../client/Challenge';
import { useGame } from '../client/useGame';
import { useComputer } from '../client/useComputer';
import { submitLegalMove } from '../client/moveDispatch';
import type { Move } from '../client/Board';
import { FORMATS, type Color, type GameSnapshot, type Pool, type QueueState } from '../shared/protocol';
import { gamePath, isGameId } from '../shared/gamePath';
import { ENGINE_LEVELS, STOCKFISH_BUILD, type EngineLevel } from '../shared/engine';

const Board = lazy(() => import('../client/Board'));
const LEGAL_MOVES_KEY = 'chess.showLegalMoves';

function Clock({ state, color, receivedAt }: { state: GameSnapshot; color: Color; receivedAt: number }) {
  const [tick, setTick] = useState(0);
  const running = state.clocks.running === color;
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      setTick(value => value + 1);
      timer = setTimeout(update, 100);
    }
    timer = setTimeout(update, 100);
    return () => clearTimeout(timer);
  }, [running, state.version]);
  const remaining = Math.max(0, state.clocks[color] - (running ? Math.max(0, performance.now() - receivedAt) : 0));
  const seconds = Math.ceil(remaining / 1000);
  const display = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <GameClock value={display} running={running} low={remaining < 20_000} label={`${color === 'w' ? 'White' : 'Black'} has ${Math.floor(seconds / 60)} minutes and ${seconds % 60} seconds${remaining < 20_000 ? '. Low time.' : ''}`} data-tick={tick % 2} />;
}

const resultText = (state: GameSnapshot) => {
  if (state.status === 'pending-adjudication') return 'Time expired. An unknown result becomes a technical void after 30 seconds.';
  if (state.outcome?.reason === 'readiness-expired') return 'The invitation expired before both players were ready.';
  if (state.outcome?.reason === 'technical-void') return 'This game was voided. No rating change.';
  if (state.outcome?.reason === 'ai-unavailable') return 'Computer play became unavailable. This game ended without a score.';
  if (state.outcome) return state.outcome.score === 0.5 ? `Draw by ${state.outcome.reason.replaceAll('-', ' ')}.` : state.outcome.winner ? `${state.outcome.winner === 'w' ? 'White' : 'Black'} wins by ${state.outcome.reason.replaceAll('-', ' ')}.` : 'The game ended without a result.';
  return '';
};

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
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [format, setFormat] = useState<Pool>('blitz');
  const [mode, setMode] = useState<'casual' | 'ranked' | 'ai'>('casual');
  const [engineLevel, setEngineLevel] = useState<EngineLevel>('club');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [archived, setArchived] = useState(false);
  const [invitationUnavailable, setInvitationUnavailable] = useState(false);
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
  const gameModes = [
    { value: 'casual', label: 'Casual invitation' },
    ...(config?.ai ? [{ value: 'ai', label: 'Play Stockfish' }] : []),
    ...(config?.ranked ? [{ value: 'ranked', label: 'Ranked match', disabled: !me?.accountReady, description: !me?.accountReady ? 'Account required' : undefined }] : []),
  ];

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
    void Promise.all([api<PublicConfig>('/api/config'), api<Me | null>('/api/me')])
      .then(async ([value, actor]) => {
        setConfig(value); setMe(actor);
        if (actor && invitation === null) setQueue(await api<QueueState>('/api/queue'));
        setLoaded(true);
      })
      .catch(reason => { setError(String(reason.message)); setLoaded(true); });
  }, [search]);

  useEffect(() => {
    if (!id || !me || joinedId === id) return;
    let cancelled = false;
    setBusy(true);
    setArchived(false);
    setInvitationUnavailable(false);
    const request = me.accountReady ? api<GameSnapshot>(gamePath(id, 'join'), {}) : api<GameSnapshot>(gamePath(id));
    void request.then(() => {
      if (!cancelled) { setJoinedId(id); setError(''); }
    }).catch(reason => { if (!cancelled) {
      const unavailable = me.accountReady && reason instanceof RequestFailure && (reason.status === 404 || reason.code === 'INVITATION_UNAVAILABLE');
      const completed = reason instanceof RequestFailure && reason.status === 410;
      setError(completed ? '' : unavailable ? 'This invitation is no longer available. Ask your friend for a new link.' : String(reason.message));
      setArchived(completed);
      setInvitationUnavailable(unavailable);
    } })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [id, me, joinedId, joinAttempt]);

  const openGame = useCallback((gameId: string) => {
    const url = new URL('/play/', location.origin);
    url.searchParams.set('game', gameId);
    history.replaceState(null, '', url);
    setId(gameId);
    setArchived(false);
    setInvitationUnavailable(false);
    setMessage('');
    setError('');
  }, []);

  useEffect(() => {
    if (!['queued', 'reserved', 'settling', 'live'].includes(queue.status)) return;
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
          if (!cancelled) openGame(next.gameId);
        }
        if (!cancelled && ['queued', 'reserved', 'settling', 'live'].includes(next.status)) timer = setTimeout(poll, 2000);
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
  async function enter() {
    await run(async () => {
      if (!me?.accountReady) throw new Error('Create an account or sign in before starting a new game.');
      if (id) { setJoinAttempt(value => value + 1); return; }
      if (mode === 'ranked') { setQueue(await api<QueueState>('/api/queue', { pool: format })); return; }
      createId.current ??= crypto.randomUUID();
      const created = await api<GameSnapshot>('/api/games', { id: createId.current, format, ...(mode === 'ai' ? { ai: { modelId: STOCKFISH_BUILD, level: engineLevel } } : {}) });
      createId.current = null;
      openGame(created.id);
    });
  }
  function move(value: Move) {
    if (!state || !active || connection !== 'online' || pending) return;
    setConfirmResign(false);
    if (state.turn === color) { submitLegalMove(state, value, send); return; }
    if (premoveEnabled) setPremove(value);
  }
  function newInvitation() {
    createId.current = null;
    setId(null); setJoinedId(null); setQueue({ status: 'idle' }); setPremove(null);
    setReportOpen(false); setReportDetails(''); setReportToken(''); setReportKey(value => value + 1);
    setArchived(false); setInvitationUnavailable(false); setError(''); setMessage('');
    history.replaceState(null, '', '/play/');
  }
  const opponent = state && (color === 'w' ? state.black : state.white);
  const self = state && (color === 'w' ? state.white : state.black);
  const done = state?.status === 'finished' || state?.status === 'pending-adjudication';
  const returnTo = '/play/?' + new URLSearchParams({ ...(id ? { game: id } : {}), format });

  return <Page variant="application">
    {!state && <AppSection>
      <SectionHead purpose="application" as="h1" title={invitationUnavailable ? 'Invitation unavailable' : archived ? 'Completed game' : id ? 'Join game' : 'Play chess'}>
        <Text as="p" variant="muted">{invitationUnavailable ? 'Unused invitations expire after ten minutes.' : archived ? 'Open your completed game in Replay.' : id ? me?.accountReady ? 'The first opponent to join takes Black.' : 'Sign in to join this invitation. The first opponent to join takes Black.' : 'Choose a time control and invite a friend.'}</Text>
      </SectionHead>
      {!loaded && <StateBlock kind="loading" message="Opening the board…" density="compact" />}
      {loaded && !id && <AppFlow>
        <RadioGroup label="Time control" name="format" value={format} onValueChange={value => setFormat(value as Pool)}
          options={(Object.keys(FORMATS) as Pool[]).map(value => ({ value, label: FORMATS[value].label, description: value === 'blitz' ? 'Blitz' : 'Rapid' }))} />
        {gameModes.length > 1 && <RadioGroup label="Game type" name="mode" value={mode}
          onValueChange={value => { setMode(value as typeof mode); if (value !== 'ranked') createId.current = null; }}
          options={gameModes} />}
        {mode === 'ai' && <AppFlow>
          <Text as="p">Practice against Stockfish on your device. You play White. Every game is unrated, with no model API or tokens.</Text>
          <AppField><label htmlFor="engine-level">Computer strength</label><Select id="engine-level" value={engineLevel} disabled={busy} onChange={event => { setEngineLevel(event.target.value as EngineLevel); createId.current = null; }}>{ENGINE_LEVELS.map(level => <option key={level.id} value={level.id}>{level.name}</option>)}</Select></AppField>
          <Text as="p" variant="muted">No installation needed. Stockfish loads automatically from this site. Strength varies by device. Keep this tab open: the server clocks continue if it sleeps or disconnects. <Link href="/help/">Computer play help</Link>.</Text>
        </AppFlow>}
      </AppFlow>}
      {loaded && !me?.accountReady && <AppFlow>
        <Text as="p">{me?.isAnonymous ? 'This legacy guest session can resume its existing games. New games require an account.' : me ? 'Set a username and password to start new games.' : 'Create an account or sign in to start a game.'}</Text>
        <AppActions>{me ? <Button asChild><Link href={accountPath(returnTo)}>{me.isAnonymous ? 'Account options' : 'Finish account'}</Link></Button> : <><Button asChild><Link href={accountPath(returnTo, 'sign-up')}>Create account</Link></Button><Button asChild variant="ghost"><Link href={accountPath(returnTo, 'sign-in')}>Sign in</Link></Button></>}</AppActions>
      </AppFlow>}
      {loaded && me?.accountReady && !invitationUnavailable && !archived && <AppActions><Button disabled={busy || ['queued', 'reserved', 'live', 'settling'].includes(queue.status)} onClick={() => void enter()}>{busy ? 'Opening…' : id ? 'Join game' : mode === 'ranked' ? 'Find an opponent' : mode === 'ai' ? 'Play Stockfish' : 'Create invitation'}</Button></AppActions>}
      {invitationUnavailable && <AppActions><Button onClick={newInvitation}>New invitation</Button></AppActions>}
      {queue.status === 'queued' && <Text as="p" role="status">Looking for a {FORMATS[queue.pool].label} opponent. <Button variant="link" density="compact" onClick={() => void run(async () => setQueue(await api('/api/queue/cancel', {})))}>Cancel</Button></Text>}
      {['reserved', 'live', 'settling'].includes(queue.status) && <Text as="p" role="status">Your match is reserved. Preparing the board…</Text>}
      {queue.status === 'closed' && <Text as="p" role="status">{queue.reason}</Text>}
      {queue.status === 'tournament' && <Text as="p" role="status">You have a tournament reservation. <Link href={`/tournaments/?event=${encodeURIComponent(queue.tournamentId)}`}>Open your tournament</Link> for the next round.</Text>}
      {loaded && !id && <Text as="p" variant="muted">Invitations{config?.ai ? ' and computer games' : ''} are unrated.{!config?.ranked && ' Ranked play is not open yet.'}</Text>}
      {me && <Text as="p" variant="muted">Playing as {me.isAnonymous ? 'a legacy guest' : me.username ?? me.name}. <Link href={accountPath(returnTo)}>Account</Link>. {me.isAnonymous && 'Keep this browser session to return to your existing games.'}</Text>}
      <AppActions><Link href="/rules/">Online rules</Link><span>·</span><Link href="/fair-play/">Fair play</Link><span>·</span><Text variant="muted">Sound off by default</Text></AppActions>
    </AppSection>}
    {state && <GameWorkspace board={<AppFlow>
      <PlayerStrip name={opponent?.name ?? 'Waiting for a friend'} detail={color === 'w' ? 'Black' : 'White'}><Clock state={state} color={color === 'w' ? 'b' : 'w'} receivedAt={receivedAt.current} /></PlayerStrip>
      <Suspense fallback={<BoardPlaceholder><StateBlock kind="loading" message="Opening the chessboard." density="compact" skeleton={false} /></BoardPlaceholder>}><Board fen={state.fen} color={color} enabled={Boolean(active && connection === 'online' && !pending && (state.turn === color || premoveEnabled))} showLegalMoves={showLegalMoves} onMove={move} lastMove={state.moves.at(-1)} premove={premove} /></Suspense>
      <PlayerStrip name={<>{self?.name ?? 'You'} <Text variant="muted">(you)</Text></>} detail={color === 'w' ? 'White' : 'Black'}><Clock state={state} color={color} receivedAt={receivedAt.current} /></PlayerStrip>
      <AppFlow role="status" aria-live="polite"><Text>{done ? resultText(state) : state.status === 'waiting' ? 'Share your invitation to bring a friend to the board.' : connection !== 'online' ? 'Reconnecting. The server clock keeps running.' : computer.phase === 'loading' ? 'Loading Stockfish on your device…' : state.status === 'ready' ? state.ai ? 'Ready when you are. The clocks start when you confirm.' : 'Both players must get ready before the clocks start.' : pending ? 'Sending the move…' : computer.phase === 'failed' ? 'Stockfish needs a retry. The server clocks keep running.' : state.ai?.thinking ? 'Stockfish is choosing a move on your device. Its clock keeps running.' : state.turn === color ? 'Your move.' : 'Their move.'}{premove && <span> Premove: {premove.from} → {premove.to}. <Button variant="link" density="compact" onClick={() => setPremove(null)}>Cancel</Button></span>}</Text></AppFlow>
      {state.status === 'waiting' && <AppActions><Input aria-label="Invitation link" readOnly value={typeof location === 'undefined' ? '' : `${location.origin}/play/?game=${state.id}`} onFocus={event => event.target.select()} /><Button variant="secondary" onClick={() => void run(async () => { await navigator.clipboard.writeText(`${location.origin}/play/?game=${state.id}`); setMessage('Invitation copied.'); })}>Copy invitation</Button></AppActions>}
      {state.status === 'ready' && <Button disabled={pending || self?.ready || connection !== 'online' || Boolean(state.ai && !computer.ready)} onClick={() => send({ type: 'ready' })}>{self?.ready ? 'Waiting for opponent…' : 'Ready to play'}</Button>}
      {state.ai && (computer.error || (gameError && state.turn === 'b' && active)) && <AppGroup>{computer.error && <StateBlock kind="error" message={computer.error} density="compact" />}<Button variant="secondary" disabled={pending || connection !== 'online'} onClick={computer.retry}>Retry computer</Button></AppGroup>}
      <AppActions><Switch density="compact" label="Show legal moves" checked={showLegalMoves} onCheckedChange={changeLegalMoves} /><Switch density="compact" label="Premove" checked={premoveEnabled} onCheckedChange={value => { setPremoveEnabled(value); if (!value) setPremove(null); }} /><Switch density="compact" label="Sound" checked={sound} onCheckedChange={value => { setSound(value); if (value) { audio.current ??= new AudioContext(); void audio.current.resume(); } }} /><Link href="/help/">Controls & reconnect help</Link></AppActions>
      {active && <Disclosure summary="Type a move"><AppForm onSubmit={event => { event.preventDefault(); const match = /^([a-h][1-8])\s*([a-h][1-8])([qrbn])?$/.exec(textMove.trim().toLowerCase()); if (!match) { setError('Enter a move such as e2e4 or a7a8n.'); return; } move({ from: match[1], to: match[2], promotion: match[3] as Move['promotion'] }); setTextMove(''); }}><label htmlFor="text-move">From and to squares, with a promotion letter if needed</label><AppActions><Input id="text-move" placeholder="e2e4" value={textMove} onChange={event => setTextMove(event.target.value)} maxLength={8} autoComplete="off" /><Button type="submit" variant="secondary" disabled={pending || connection !== 'online'}>Move</Button></AppActions></AppForm></Disclosure>}
    </AppFlow>}><SectionHead purpose="application" as="h1" title={FORMATS[state.format].label}><AppGroup><Text as="p" variant="muted">{state.format} · {state.ai ? 'Computer · Unrated' : state.rated ? 'Ranked' : 'Casual'} · {connection === 'online' ? 'Connected' : 'Reconnecting'}</Text>{state.ai && <Text as="p">{state.ai.name}</Text>}</AppGroup></SectionHead>
      <Rule />
      {state.moves.length > 0 && <MovePairs label="Accepted moves" moves={Array.from({ length: Math.ceil(state.moves.length / 2) }, (_, index) => ({ number: index + 1, white: state.moves[index * 2]?.san, black: state.moves[index * 2 + 1]?.san }))} />}
      {!state.moves.length && <StateBlock kind="empty" message="Your moves will appear here." density="compact" />}
      {active && <><Rule /><AppActions>{!state.ai && (state.drawOfferedBy && state.drawOfferedBy !== color ? <><Text as="p">Your opponent offers a draw.</Text><Button variant="secondary" density="compact" disabled={pending} onClick={() => send({ type: 'accept-draw' })}>Accept draw</Button><Button variant="ghost" density="compact" disabled={pending} onClick={() => send({ type: 'decline-draw' })}>Decline</Button></> : <Button variant="secondary" density="compact" disabled={pending || state.drawOfferedBy === color} onClick={() => send({ type: 'offer-draw' })}>{state.drawOfferedBy === color ? 'Draw offered' : 'Offer draw'}</Button>)}{confirmResign ? <><Text as="p">Resign this game?</Text><Button variant="danger" density="compact" disabled={pending} onClick={() => { send({ type: 'resign' }); setConfirmResign(false); }}>Confirm resignation</Button><Button variant="ghost" density="compact" onClick={() => setConfirmResign(false)}>Keep playing</Button></> : <Button variant="ghost" density="compact" onClick={() => setConfirmResign(true)}>Resign</Button>}</AppActions></>}
      {state.tournament && <Text as="p"><Link href={`/tournaments/?event=${encodeURIComponent(state.tournament.id)}`}>Return to your tournament</Link> · Round {state.tournament.round}, unrated.</Text>}
      {done && <><Rule /><AppActions><Text as="p">{state.settlement === 'pending' ? 'Rating settlement is pending.' : state.rated ? 'Rating result recorded.' : 'This game does not affect ratings.'}</Text>{state.status === 'finished' && <><Button variant="link" density="compact" asChild><Link href={`/replay/?game=${encodeURIComponent(state.id)}`}>Replay game</Link></Button><Button variant="link" density="compact" asChild><a href={gamePath(state.id, 'pgn')}>Download PGN</a></Button></>}<Button variant="secondary" onClick={newInvitation}>Play another game</Button></AppActions></>}
      {state.status === 'finished' && !state.ai && config && <Disclosure open={reportOpen} onToggle={event => setReportOpen(event.currentTarget.open)} summary="Report a concern"><AppFlow>{!config.reviewAvailable && <Text as="p" variant="muted">Concerns are stored privately. No reviewer is active and reports do not trigger automatic penalties.</Text>}<AppForm onSubmit={event => { event.preventDefault(); void run(async () => { await api('/api/reports', { gameId: state.id, reason: reportReason, details: reportDetails }, reportToken); setMessage(config.reviewAvailable ? 'Your report was recorded for private review.' : 'Your concern was recorded privately. No reviewer is active and no automatic penalty follows.'); setReportOpen(false); }, 'report'); }}><AppField><label htmlFor="report-reason">Concern</label><Select id="report-reason" value={reportReason} onChange={event => setReportReason(event.target.value)}><option value="engine-assistance">Outside assistance</option><option value="rating-manipulation">Rating manipulation</option><option value="account-abuse">Account abuse</option><option value="other">Other</option></Select></AppField><AppField><label htmlFor="report-details">Details about your concern</label><Textarea required minLength={10} id="report-details" value={reportDetails} maxLength={1000} onChange={event => setReportDetails(event.target.value)} /></AppField><Challenge key={reportKey} config={config} action="report" onToken={setReportToken} /><div><Button type="submit" variant="secondary" disabled={busy || !reportToken}>Send report</Button></div></AppForm></AppFlow></Disclosure>}
    </GameWorkspace>}
    {(error || gameError) && <StateBlock kind="error" message={error || gameError} density="compact" />}
    {archived && id && <Text as="p"><Link href={`/replay/?game=${encodeURIComponent(id)}`}>Replay this completed game</Link></Text>}
    {message && <Text as="p" role="status">{message}</Text>}
  </Page>;
}
