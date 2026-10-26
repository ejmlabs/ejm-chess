import { AppActions, AppFlow, AppGroup, AppHeading } from '@ejm/ui/layout/Application';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Table } from '@ejm/ui/components/Table';
import { Page } from '@ejm/ui/layout/Band';
import { Prose } from '@ejm/ui/layout/Prose';
import { Rule } from '@ejm/ui/layout/Rule';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Status } from '@ejm/ui/layout/Status';
import { Text } from '@ejm/ui/layout/Text';
import { api, RequestFailure, type Me } from '../client/api';
import { FORMATS } from '../shared/protocol';
import type { ArenaList, ArenaMe, ArenaStandingsPage, ArenaSummary } from '../shared/arenas';
import type { TournamentList, TournamentView } from '../shared/tournaments';

const date = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const title = (event: Pick<TournamentView, 'cadence' | 'pool'>) => `${event.cadence === 'hourly' ? 'Hourly' : event.cadence === 'daily' ? 'Daily' : 'Weekly'} ${event.pool === 'blitz' ? 'blitz' : 'rapid'}`;
const status = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');
const active = (event: TournamentView) => ['starting', 'running', 'intermission'].includes(event.status);

function timeLeft(deadline: number, now: number) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type ArenaAction = 'register' | 'withdraw' | 'queue' | 'pause' | 'resume';
type PrivateArena = { accountId: string; value: ArenaMe };
type ArenaNotice = { eventId: string; accountId: string; text: string };
const failureMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'This request failed. Try again.';

async function arenaStandings(id: string, cursor: string | null): Promise<ArenaStandingsPage> {
  const page = await api<ArenaStandingsPage>('/api/arenas/' + encodeURIComponent(id) + '/standings'
    + (cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor)));
  if (page.id !== id || page.standings.length > 32
    || (cursor !== null && page.generation !== Number(cursor.split(':')[0]))) {
    throw new Error('This standings page could not be verified. Refresh from the first page.');
  }
  return page;
}

function ArenaEvents({ me, accountReady, now }: { me: Me | null; accountReady: boolean; now: number }) {
  const [data, setData] = useState<ArenaList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<ArenaSummary | null>(null);
  const [standings, setStandings] = useState<ArenaStandingsPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [privateData, setPrivateData] = useState<PrivateArena | null>(null);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [privateError, setPrivateError] = useState<ArenaNotice | null>(null);
  const [actionError, setActionError] = useState<ArenaNotice | null>(null);
  const [notice, setNotice] = useState<ArenaNotice | null>(null);
  const [pageNotice, setPageNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const actionPending = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const accountId = me?.accountReady ? me.id : null;
  const current = useRef({ selectedId, cursor, accountId });
  current.current = { selectedId, cursor, accountId };

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const id = selectedId;
    setLoading(true);
    const [events, detail, page, own] = await Promise.allSettled([
      api<ArenaList>('/api/arenas'),
      id ? api<ArenaSummary>('/api/arenas/' + encodeURIComponent(id)) : Promise.resolve(null),
      id ? arenaStandings(id, cursor) : Promise.resolve(null),
      id && accountId ? api<ArenaMe>('/api/arenas/' + encodeURIComponent(id) + '/me') : Promise.resolve(null),
    ] as const);
    if (!mounted.current || generation !== requestGeneration.current
      || current.current.selectedId !== id || current.current.cursor !== cursor || current.current.accountId !== accountId) return;
    setLoading(false);
    if (events.status === 'fulfilled') { setData(events.value); setListError(''); }
    else setListError(failureMessage(events.reason));
    if (!id) return;
    if (detail.status === 'fulfilled') setSummary(detail.value);
    if (page.status === 'fulfilled') {
      setStandings(page.value); setDetailError('');
      if (cursor === null) setPageNotice(previous => previous ? 'Standings restarted from the latest first page.' : '');
    } else if (cursor !== null && page.reason instanceof RequestFailure && page.reason.status === 409) {
      setStandings(null); setCursor(null); setDetailError('');
      setPageNotice('This standings snapshot expired. Loading the latest first page.');
    } else {
      setDetailError(failureMessage(page.reason));
    }
    if (detail.status === 'rejected') {
      setSummary(null); setDetailError(failureMessage(detail.reason));
    }
    if (own.status === 'fulfilled') {
      setPrivateData(accountId && own.value ? { accountId, value: own.value } : null); setPrivateError(null);
    } else {
      setPrivateData(null); setPrivateError(accountId ? { eventId: id, accountId, text: failureMessage(own.reason) } : null);
    }
  }, [selectedId, cursor, accountId]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  useEffect(() => {
    mounted.current = true;
    const query = new URLSearchParams(location.search).get('arena');
    if (query && /^arena-[a-z0-9-]{1,74}$/.test(query)) {
      current.current.selectedId = query;
      setSelectedId(query);
    }
    return () => { mounted.current = false; requestGeneration.current++; };
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!live) return;
      if (!document.hidden && !actionPending.current) await refresh();
      if (live) timer = setTimeout(poll, 10_000);
    }
    void poll();
    return () => { live = false; requestGeneration.current++; clearTimeout(timer); };
  }, [refresh]);

  const selected = summary?.id === selectedId ? summary : data?.events.find(event => event.id === selectedId) ?? null;
  const own = privateData?.accountId === accountId && privateData.value.id === selectedId ? privateData.value : null;
  const activePrivateError = privateError?.eventId === selectedId && privateError.accountId === accountId ? privateError.text : '';
  const activeNotice = notice?.eventId === selectedId && notice.accountId === accountId ? notice.text : '';
  const activeError = actionError?.eventId === selectedId && actionError.accountId === accountId ? actionError.text : '';
  useEffect(() => { if (selectedId && detailHeading.current) detailHeading.current.focus(); }, [selectedId, Boolean(selected)]);

  function select(event: ArenaSummary) {
    if (selectedId === event.id && cursor === null) {
      detailHeading.current?.focus();
      void refresh();
      return;
    }
    requestGeneration.current++;
    current.current = { selectedId: event.id, cursor: null, accountId };
    setSelectedId(event.id); setSummary(event); setCursor(null); setStandings(null); setPrivateData(null);
    setDetailError(''); setPrivateError(null); setActionError(null); setNotice(null); setPageNotice('');
    const url = new URL(location.href);
    url.searchParams.set('arena', event.id);
    history.replaceState(null, '', url.pathname + url.search);
  }

  function choosePage(next: string | null) {
    requestGeneration.current++;
    current.current.cursor = next;
    setCursor(next); setStandings(null); setDetailError(''); setPageNotice('');
  }

  function restartStandings() {
    if (cursor !== null) choosePage(null);
    else void refresh();
  }

  async function action(kind: ArenaAction) {
    const id = selectedId;
    const actorId = accountId;
    if (!id || !actorId || actionPending.current) return;
    actionPending.current = true;
    requestGeneration.current++;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const value = await api<ArenaMe>('/api/arenas/' + encodeURIComponent(id) + '/' + kind, {});
      if (!mounted.current || current.current.selectedId !== id || current.current.accountId !== actorId) return;
      requestGeneration.current++;
      setPrivateData({ accountId: actorId, value }); setPrivateError(null);
      const messages = {
        register: 'Registered. Join the queue when you are ready to play.',
        withdraw: 'You withdrew from this arena.',
        queue: 'Queue request accepted. Your status below confirms when the reservation is ready.',
        pause: 'Pause requested. Wait for the reservation to release before resuming.',
        resume: 'Resume requested. Your status below confirms when you can be paired.',
      };
      setNotice({ eventId: id, accountId: actorId, text: messages[kind] });
    } catch (reason) {
      if (mounted.current && current.current.selectedId === id && current.current.accountId === actorId) {
        setActionError({ eventId: id, accountId: actorId, text: failureMessage(reason) });
      }
    } finally {
      actionPending.current = false;
      if (mounted.current) { setBusy(false); void latestRefresh.current(); }
    }
  }

  const eventState = own?.status ?? selected?.status;
  const entryOpen = Boolean(selected && data?.enabled && ['scheduled', 'running'].includes(eventState ?? '')
    && now >= selected.registrationOpensAt && now < selected.closesAt);
  const canAct = Boolean(accountId && own && !activePrivateError && !busy);
  const canWithdraw = Boolean(selected && now < selected.startsAt && !own?.gameId
    && ['registered', 'paused'].includes(own?.state ?? ''));
  const pageNumber = cursor === null ? 0 : Number(cursor.split(':')[1]);
  const stateMessages = {
    registered: 'Registered. Join the queue when you are ready.',
    reserving: 'Reserving your place in the queue. Wait for confirmation before choosing another game.',
    queued: 'Waiting for an allowed opponent. Keep this page open and watch for your game.',
    playing: own?.gameId ? 'Your board is ready. Open it and confirm readiness.' : 'Preparing your board. Your reservation remains held.',
    paused: 'Queue paused. Resume when you are ready to play.',
    releasing: 'Releasing your previous reservation. Wait before queueing again.',
    withdrawn: 'You have withdrawn from this arena.',
  };

  return <AppFlow as="section" aria-labelledby="arena-heading">
    <AppGroup as="header"><AppHeading as="h2" id="arena-heading"><Text variant="strong">Arena events</Text></AppHeading>
      <Text as="p">Play successive unrated games while pairing is open. Register, then join the queue when you are ready.</Text>
    </AppGroup>
    <Text as="p" variant="muted">Pairing lasts one hour for blitz and two for rapid. Equal points share a rank. <Link href="#arena-rules">Arena rules</Link>.</Text>
    {listError && <AppGroup><StateBlock kind="error" message={listError} density="compact" /><div><Button variant="link" density="compact" disabled={loading} onClick={() => void refresh()}>Retry arena schedule</Button></div></AppGroup>}
    {!data && !listError && <StateBlock kind="loading" message="Loading arena events." density="compact" />}
    {data && <>
      {!data.enabled && <div><Status status="info" label="New arena entry is closed on this service. Accepted games can finish." /></div>}
      {data.events.length === 0
        ? <StateBlock kind="empty" message="No arena events are published yet. This schedule refreshes automatically." density="compact" />
        : <AppFlow><Rule />{data.events.map(event => <div key={event.id}><AppFlow as="article">
          <AppGroup><AppHeading as="h3"><Button variant="link" aria-expanded={event.id === selectedId} onClick={() => select(event)}>{title(event)} arena</Button></AppHeading>
            <Text as="p"><time dateTime={new Date(event.startsAt).toISOString()}>{date.format(event.startsAt)}</time> · {FORMATS[event.pool].label}</Text>
            <Text as="p" variant="muted">{status(event.status)} · {event.entrants} / {event.maxEntrants} registered
              {event.status === 'running' && <> · Pairing closes in {timeLeft(event.closesAt, now)}</>}
              {event.status === 'draining' && <> · {event.unresolvedGames} accepted games still resolving</>}
            </Text>
            {event.reason && <Text as="p" variant="muted">{event.reason}</Text>}
          </AppGroup>
          <AppActions><Button variant="ghost" density="compact" onClick={() => select(event)}>View arena</Button></AppActions>
        </AppFlow><Rule /></div>)}</AppFlow>}
    </>}
    {selectedId && <AppFlow as="section" aria-labelledby="arena-detail-heading" aria-busy={loading}>
      <AppGroup as="header"><AppHeading as="h3" id="arena-detail-heading" tabIndex={-1} ref={detailHeading}>{selected ? title(selected) + ' arena' : 'Arena details'}</AppHeading>
        {selected && <Text as="p">{status(selected.status)}. Pairing closes <time dateTime={new Date(selected.closesAt).toISOString()}>{date.format(selected.closesAt)}</time>.
          {selected.status === 'draining' && <> Accepted games are still resolving. Standings remain provisional.</>}
        </Text>}
      </AppGroup>
      {detailError && <AppGroup><StateBlock kind="error" message={detailError} density="compact" /><div><Button variant="link" density="compact" disabled={loading} onClick={restartStandings}>Refresh from first page</Button></div></AppGroup>}
      {selected && <AppFlow as="section" aria-label="Your arena entry">
        <AppHeading as="h4">Your entry</AppHeading>
        {!accountReady ? <Text as="p">Checking your account.</Text>
          : !accountId ? <Text as="p">Use a username and password account to enter. <Link href="/account/">Open Account</Link> to sign in or finish your account, then return here. Recovery email is optional. You can read standings without signing in.</Text>
            : <>
              {activePrivateError && <StateBlock kind="error" message={activePrivateError} density="compact" />}
              {activeError && <StateBlock kind="error" message={activeError} density="compact" />}
              {activeNotice && <div role="status"><Status status="info" label={activeNotice} /></div>}
              {!own && !activePrivateError && <StateBlock kind="loading" message="Loading your private arena status." density="compact" />}
              {own && <AppGroup><Text as="p">{own.state ? stateMessages[own.state] : 'You have not registered for this arena.'}</Text>
                {own.registered && <Text as="p" variant="muted">Your accepted score: {own.points} points from {own.games} settled games. Published standings may follow later.</Text>}
                {own.reason && <Text as="p">{own.reason}</Text>}
              </AppGroup>}
              <AppActions>
                {own && !own.registered && <Button density="compact" disabled={!canAct || !entryOpen || selected.entrants >= selected.maxEntrants} onClick={() => void action('register')}>Register for arena</Button>}
                {own?.state === 'registered' && <Button density="compact" disabled={!canAct || !entryOpen} onClick={() => void action('queue')}>{own.games ? 'Queue for another game' : 'Join queue'}</Button>}
                {own?.state === 'paused' && <Button density="compact" disabled={!canAct || !entryOpen} onClick={() => void action('resume')}>Resume queue</Button>}
                {own?.state === 'queued' && <Button variant="secondary" density="compact" disabled={!canAct} onClick={() => void action('pause')}>Pause queue</Button>}
                {canWithdraw && <Button variant="ghost" density="compact" disabled={!canAct} onClick={() => void action('withdraw')}>Withdraw</Button>}
                {own?.gameId && <Button asChild density="compact"><Link href={'/play/?game=' + encodeURIComponent(own.gameId)}>{own.state === 'releasing' ? 'View your game' : 'Open your game'}</Link></Button>}
                <Button variant="link" density="compact" disabled={busy || loading} onClick={() => void refresh()}>Refresh your status</Button>
              </AppActions>
              {!entryOpen && !['playing', 'reserving', 'releasing'].includes(own?.state ?? '') && <Text as="p" variant="muted">New entry and queueing need an open arena. Registration opens 15 minutes before the start.</Text>}
            </>}
      </AppFlow>}
      {pageNotice && <Text as="p" role="status">{pageNotice}</Text>}
      {!standings && !detailError && <StateBlock kind="loading" message="Loading a standings page." density="compact" />}
      {standings && standings.id === selectedId && <>
        <Text as="p" variant="muted">{standings.provisional ? 'Provisional standings' : 'Final standings'} · Snapshot {standings.generation} · Updated <time dateTime={new Date(standings.generatedAt).toISOString()}>{date.format(standings.generatedAt)}</time></Text>
        {standings.standings.length === 0 ? <StateBlock kind="empty" message="No entrants appear in this standings snapshot yet. Refresh after registration." density="compact" />
          : <Table label="Arena standings" caption="One page of up to 32 players. Equal points share a rank."
            columns={[{ key: 'rank', label: 'Rank', align: 'right' }, { key: 'player', label: 'Player' }, { key: 'points', label: 'Points', align: 'right' }, { key: 'games', label: 'Games', align: 'right' }]}
            rows={standings.standings.map(player => ({ id: player.id, rank: player.rank, player: <Link href={'/player/?id=' + encodeURIComponent(player.id)}>{player.name}</Link>, points: player.points, games: player.games }))}
            rowHeader="player" rowKey="id" truncate={false} density="compact" />}
        <AppGroup><AppActions as="nav" aria-label="Arena standings pages">
          <Button variant="secondary" density="compact" disabled={loading || pageNumber === 0} onClick={() => choosePage(standings.generation + ':' + (pageNumber - 1))}>Previous page</Button>
          <Text>Page {pageNumber + 1}</Text>
          <Button variant="secondary" density="compact" disabled={loading || !standings.nextCursor} onClick={() => { if (standings.nextCursor) choosePage(standings.nextCursor); }}>Next page</Button>
          <Button variant="link" density="compact" disabled={loading} onClick={restartStandings}>Latest first page</Button>
        </AppActions>
          <Text as="p" variant="muted">Pages stay within one snapshot. Latest first page restarts with the newest published standings.</Text></AppGroup>
      </>}
    </AppFlow>}
    <section id="arena-rules"><Prose>
      <AppHeading as="h3">Arena rules</AppHeading>
      <p>Register from 15 minutes before the start until pairing closes. Registration alone leaves your account free. Join the queue to reserve it.
        Finish or pause and release that reservation before choosing another game or event.</p>
      <p>Open your assigned game and confirm readiness within two minutes. This page never opens a game for you. After each settled game, queue again explicitly.
        A no-show pauses your queue until you resume.</p>
      <p>A win earns one point, a draw half a point. Losses, no-shows, waiting without an opponent, and technical voids earn zero. There are no byes or streak bonuses.
        A pair may meet twice only with another opponent between meetings.</p>
      <p>Accepted games finish after pairing closes, with an 18-minute blitz or 40-minute rapid wall limit including readiness.
        Games unfinished at the wall limit become technical voids. Service delays can keep an event draining while accepted results recover.</p>
      <p>Games are unrated and do not affect the global leaderboard. Published standings may lag your private score.
        The shown entrant limit is a configured admission cap; larger public capacity has not been verified.</p>
    </Prose></section>
  </AppFlow>;
}

export default function Tournaments() {
  const [data, setData] = useState<TournamentList | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [accountReady, setAccountReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(0);
  const [offset, setOffset] = useState(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const actionPending = useRef(false);
  const eligible = Boolean(me?.accountReady);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const [events, account] = await Promise.allSettled([api<TournamentList>('/api/tournaments'), api<Me | null>('/api/me')]);
      if (!mounted.current || generation !== requestGeneration.current) return;
      if (events.status === 'fulfilled') {
        setData(events.value); setOffset(events.value.serverNow - Date.now()); setNow(events.value.serverNow);
      }
      setMe(account.status === 'fulfilled' ? account.value : null); setAccountReady(true);
      setError(events.status === 'rejected' ? failureMessage(events.reason) : account.status === 'rejected' ? failureMessage(account.reason) : '');
    } catch (reason) {
      if (mounted.current && generation === requestGeneration.current) setError((reason as Error).message);
    }
  }, []);

  useEffect(() => {
    let current = true;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const query = new URLSearchParams(location.search).get('event');
    if (query && /^[a-z0-9-]{1,80}$/.test(query)) setSelectedId(query);
    async function poll() {
      if (!current) return;
      if (!document.hidden && !actionPending.current) await refresh();
      if (current) timer = setTimeout(poll, 15_000);
    }
    void poll();
    return () => { current = false; mounted.current = false; requestGeneration.current++; clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset), 1_000);
    return () => clearInterval(timer);
  }, [offset]);

  const selected = data?.events.find(event => event.id === selectedId) ?? null;
  useEffect(() => { if (selectedId && detailHeading.current) detailHeading.current.focus(); }, [selectedId, Boolean(selected)]);
  function select(event: TournamentView) {
    setSelectedId(event.id);
    const url = new URL(location.href);
    url.searchParams.set('event', event.id);
    history.replaceState(null, '', url.pathname + url.search);
  }

  async function action(event: TournamentView, kind: 'register' | 'withdraw') {
    if (actionPending.current) return;
    actionPending.current = true;
    requestGeneration.current++;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/tournaments/${encodeURIComponent(event.id)}/${kind}`, {});
      if (!mounted.current) return;
      setMessage(kind === 'register' ? `You joined ${title(event)}. Return before it starts.` : 'You left this tournament.');
      await refresh();
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }

  return <Page variant="application"><AppFlow as="section">
    <SectionHead purpose="application" as="h1" title="Tournaments">
      <Text as="p">Choose a timed arena or the small round-robin preview. All event games are unrated.</Text>
    </SectionHead>
    <Text as="p" variant="muted">Hourly blitz at the hour. Daily rapid at 18:00 UTC. Weekly rapid on Sundays at 16:00 UTC.</Text>
    {error && <AppGroup><StateBlock kind="error" message={error} density="compact" /><div><Button variant="link" density="compact" disabled={busy} onClick={() => void refresh()}>Retry</Button></div></AppGroup>}
    {message && <div role="status"><Status status="info" label={message} /></div>}
    <ArenaEvents me={me} accountReady={accountReady} now={now} />
    <AppFlow as="section"><AppGroup as="header"><AppHeading as="h2"><Text variant="strong">Round-robin preview</Text></AppHeading>
      <Text as="p">Three or four players. Three rounds. The next round starts automatically.</Text>
    </AppGroup>
      {!data && !error && <StateBlock kind="loading" message="Loading tournaments." density="compact" />}
      {data && <>
        {!data.enabled && <div><Status status="info" label="New round-robin preview entry is closed on this service." /></div>}
        {!eligible && <Text as="p">Join with a username and password account. <Link href="/account/">Open Account</Link> to sign in or finish your account, then return here. Recovery email is optional.</Text>}
        <Text as="p">Three or four players, three rounds, no prizes. Games are unrated and event points stay separate from global ratings.
          {' '}Stay on the tournament page between rounds. <Link href="#event-rules">Read the time and no-show rules</Link> before joining.</Text>
        {data.events.length === 0 ? <StateBlock kind="empty" message="No events are scheduled yet; this page refreshes automatically." density="compact" /> : <AppFlow>
          <Rule />
          {data.events.map(event => <div key={event.id}><AppFlow as="article">
            <AppGroup><AppHeading as="h3"><Button variant="link" aria-expanded={event.id === selectedId} onClick={() => select(event)}>{title(event)}</Button></AppHeading>
              <Text as="p"><time dateTime={new Date(event.startsAt).toISOString()}>{date.format(event.startsAt)}</time> · {FORMATS[event.pool].label}</Text>
              <Text as="p" variant="muted">{status(event.status)} · {event.players.filter(player => player.status === 'registered' || player.status === 'admitted').length} / {event.maxPlayers} players
                {event.status === 'registering' && <> · Starts in {timeLeft(event.startsAt, now)}</>}
                {event.status === 'scheduled' && <> · Registration opens <time dateTime={new Date(event.registrationOpensAt).toISOString()}>{date.format(event.registrationOpensAt)}</time></>}
                {active(event) && <> · Round {event.round} of {event.rounds}</>}
              </Text>
              {event.reason && <Text as="p" variant="muted">{status(event.reason)}</Text>}
              {event.myStatus === 'skipped-busy' && <Text as="p">You were busy in another game when this event started.</Text>}
              {event.myStatus === 'skipped-ineligible' && <Text as="p">Your account could not enter when this event started. Check your account status.</Text>}
            </AppGroup>
            <AppActions>
              <Button variant="ghost" density="compact" onClick={() => select(event)}>Standings</Button>
              {event.status === 'registering' && event.myStatus === 'registered'
                ? <Button variant="secondary" density="compact" disabled={busy} onClick={() => void action(event, 'withdraw')}>Leave</Button>
                : event.status === 'registering' && <Button density="compact" disabled={busy || !eligible || !data.enabled || event.players.length >= event.maxPlayers} onClick={() => void action(event, 'register')}>Join tournament</Button>}
              {event.myGameId && <Button asChild density="compact"><Link href={`/play/?game=${encodeURIComponent(event.myGameId)}`}>Open your game</Link></Button>}
            </AppActions>
          </AppFlow><Rule /></div>)}
        </AppFlow>}
        {selectedId && !selected && <AppGroup><StateBlock kind="empty" message="This event is outside the current schedule." density="compact" /><Text as="p">Completed games remain in your private <Link href="/history/">History</Link>.</Text></AppGroup>}
        {selected && <AppFlow as="section" aria-labelledby="event-heading">
          <AppGroup as="header"><AppHeading as="h3" id="event-heading" tabIndex={-1} ref={detailHeading}>{title(selected)} standings</AppHeading>
            <Text as="p"><time dateTime={new Date(selected.startsAt).toISOString()}>{date.format(selected.startsAt)}</time>. {status(selected.status)}.
              {selected.roundDeadlineAt && active(selected) && <> Round ends in {timeLeft(selected.roundDeadlineAt, now)}.</>}
              {selected.nextRoundAt && selected.status === 'intermission' && <> Next round in {timeLeft(selected.nextRoundAt, now)}.</>}
            </Text></AppGroup>
          {selected.standings.length === 0 ? <StateBlock kind="empty" message="Standings appear when the event starts." density="compact" /> : <Table label="Tournament standings" caption="Equal points share a rank."
            columns={[{ key: 'rank', label: 'Rank', align: 'right' }, { key: 'player', label: 'Player' }, { key: 'points', label: 'Points', align: 'right' }]}
            rows={selected.standings.map(player => ({ id: player.id, rank: player.rank, player: <Link href={`/player/?id=${encodeURIComponent(player.id)}`}>{player.name}</Link>, points: player.points }))}
            rowHeader="player" rowKey="id" truncate={false} density="compact" />}
          {selected.games.length > 0 && <AppFlow as="section"><AppHeading as="h4">Games</AppHeading><AppGroup as="ol">{selected.games.map(game => <li key={game.id}><AppGroup>
            <Text>Round {game.round}: {selected.players.find(player => player.id === game.whiteId)?.name ?? 'White'} vs {selected.players.find(player => player.id === game.blackId)?.name ?? 'Black'}</Text>
            <Text>{game.whitePoints === null ? status(game.status) : `${game.whitePoints} : ${game.blackPoints}`}{game.reason ? ` · ${status(game.reason)}` : ''}</Text>
            {game.status === 'creating' && <Text variant="muted">Preparing the board</Text>}
            {me && (me.id === game.whiteId || me.id === game.blackId) && game.status !== 'creating' && (game.status === 'finished'
              ? <Link href={`/replay/?game=${encodeURIComponent(game.id)}`}>Replay</Link>
              : <Link href={`/play/?game=${encodeURIComponent(game.id)}`}>Open game</Link>)}
          </AppGroup><Rule /></li>)}</AppGroup></AppFlow>}
        </AppFlow>}
      </>}
      <section id="event-rules"><Prose>
        <AppHeading as="h3">Round-robin rules</AppHeading>
        <p>Registration opens 15 minutes before the start. You need a username and password account and a free seat when it starts. Recovery email is optional.
          Fewer than three available players cancels the event. Once admitted, finish the event before joining another game.</p>
        <p>Each player meets every opponent once. With three players, each receives one bye. A win or bye earns one point, a draw half a point.
          Tied points share a rank.</p>
        <p>Confirm readiness within two minutes. If only one player is ready, that player earns one event point.
          Two absent players earn zero. These points do not claim a played win.</p>
        <p>Each blitz round lasts at most 18 minutes and each rapid round at most 40, including readiness. There is a one-minute break between rounds.
          An unfinished or unresolved game is void and gives both players zero points. No operator is needed to advance rounds.</p>
        <p>Times and countdowns can shift during an outage. No event contains undisclosed bots.
          Read the <Link href="/rules/">online rules</Link> and <Link href="/fair-play/">fair play limits</Link>.</p>
      </Prose></section>
    </AppFlow></AppFlow></Page>;
}
