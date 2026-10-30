import { AppField, AppFlow, AppForm, AppGroup, AppHeading } from '@ejm/ui/layout/Application';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Select } from '@ejm/ui/components/ui/select';
import { Textarea } from '@ejm/ui/components/ui/textarea';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Table } from '@ejm/ui/components/Table';
import { Page } from '@ejm/ui/layout/Band';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Status } from '@ejm/ui/layout/Status';
import { Text } from '@ejm/ui/layout/Text';
import { api, type Me } from '../client/api';
import { FORMATS, type Pool } from '../shared/protocol';
import { STOCKFISH_BUILD } from '../shared/engine';

interface HistoryGame {
  id: string;
  format: Pool;
  rated: number;
  aiModel: string | null;
  actualModel: string | null;
  result: string | null;
  endedAt: number;
  pgn?: string;
}

interface FairPlayState {
  reviewAvailable: boolean;
  notices: { id: string; caseId: string; outcome: string; reason: string; createdAt: number; appealUntil: number }[];
  restrictions: { id: string; reason: string; expiresAt: number }[];
  appeals: { id: string; decisionId: string; status: string; createdAt: number; resolvedAt: number | null; expiresAt: number }[];
}

type NoticeLoad = { status: 'loading' | 'error' } | { status: 'ready'; data: FairPlayState };

type LoadState = { status: 'loading' | 'signed-out' | 'error' }
  | { status: 'ready'; games: HistoryGame[]; guest: boolean };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const historyColumns = [
  { key: 'game', label: 'Game' },
  { key: 'finished', label: 'Finished' },
  { key: 'result', label: 'Result' },
  { key: 'save', label: 'Save' },
];

function resultLabel(result: string | null): string {
  if (result === '1-0') return 'White won';
  if (result === '0-1') return 'Black won';
  if (result === '1/2-1/2' || result === '½-½') return 'Draw';
  if (result === 'Void') return 'Void';
  return 'Pending';
}

function decisionLabel(outcome: string): string {
  if (outcome === 'restrict') return 'Ranked restriction';
  if (outcome === 'clear') return 'Case cleared';
  if (outcome === 'overturn') return 'Decision overturned';
  if (outcome === 'uphold') return 'Decision upheld';
  return 'Review decision';
}

function FairPlayNotices() {
  const [state, setState] = useState<NoticeLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [decisionId, setDecisionId] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    void api<FairPlayState>('/api/me/fair-play')
      .then(data => { if (current) setState({ status: 'ready', data }); })
      .catch(() => { if (current) setState({ status: 'error' }); });
    return () => { current = false; };
  }, [attempt]);

  async function appeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decisionId || reason.trim().length < 10 || reason.length > 2000 || sending) return;
    setSending(true);
    setError('');
    setMessage('');
    try {
      const receipt = await api<{ reviewAvailable: boolean; appeal: { id: string; status: string } }>('/api/appeals', { decisionId, reason: reason.trim() });
      setMessage(receipt.reviewAvailable ? 'Your appeal was recorded. Its status will appear here.'
        : 'Your appeal was recorded. Human review is unavailable; unreviewed appeals close after 14 days.');
      setReason('');
      setDecisionId('');
      setAttempt(value => value + 1);
    } catch {
      setError('Your appeal could not be recorded. Check the notice deadline and try again.');
    } finally { setSending(false); }
  }

  const appealable = state.status === 'ready' ? state.data.notices.filter(notice =>
    notice.outcome === 'restrict' && notice.appealUntil >= Date.now()
    && !state.data.appeals.some(item => item.decisionId === notice.id)) : [];

  return <AppFlow as="section" id="fair-play" aria-labelledby="fair-play-heading">
    <AppGroup as="header"><AppHeading as="h2" id="fair-play-heading"><Text variant="strong">Fair-play notices</Text></AppHeading>
      <Text as="p">Private decisions and appeals for this account. Read the{' '}
        <Link href="/fair-play/">review policy</Link>.
      </Text></AppGroup>
    {message && <Text as="p" role="status"><Status status="ok" label={message} /></Text>}
    {error && <StateBlock kind="error" density="compact" message={error} />}
    <div aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <StateBlock kind="loading" density="compact" skeleton={false} message="Loading your notices…" />}
      {state.status === 'error' && <StateBlock kind="error" density="compact" message="Your notices could not be loaded; try again."
        action={{ label: 'Retry notices' }} onAction={() => setAttempt(value => value + 1)} />}
      {state.status === 'ready' && <AppFlow>
        {!state.data.reviewAvailable && <Text as="p" variant="muted">Human review is unavailable. Appeals are recorded and close without a decision after 14 days if unreviewed.</Text>}
        {state.data.restrictions.map(item => <Text as="p" key={item.id}>
          <Status status="warn" label="Ranked play restricted" /> until <time dateTime={new Date(item.expiresAt).toISOString()}>{dateFormat.format(item.expiresAt)}</time>.
          {' '}{item.reason}
        </Text>)}
        {state.data.notices.length === 0 ? <StateBlock kind="empty" density="compact" message="No fair-play notices for this account." />
          : <AppFlow as="ul">{state.data.notices.map(notice => <AppGroup as="li" key={notice.id}>
            <AppHeading as="h3"><Text variant="strong">{decisionLabel(notice.outcome)}</Text></AppHeading>
            <Text as="p">{notice.reason}</Text>
            <Text as="p" variant="muted">Decided <time dateTime={new Date(notice.createdAt).toISOString()}>{dateFormat.format(notice.createdAt)}</time>.
              {notice.outcome === 'restrict' && <> Appeal deadline:{' '}
                <time dateTime={new Date(notice.appealUntil).toISOString()}>{dateFormat.format(notice.appealUntil)}</time>.</>}
            </Text>
          </AppGroup>)}</AppFlow>}
        {state.data.appeals.length > 0 && <AppFlow as="section">
          <AppHeading as="h3"><Text variant="strong">Your appeals</Text></AppHeading>
          <AppGroup as="ul">{state.data.appeals.map(item => <li key={item.id}><Text>
            {item.status === 'overturned' ? 'Decision overturned' : item.status === 'upheld' ? 'Decision upheld'
              : item.status === 'expired-unreviewed' ? 'Closed without review' : state.data.reviewAvailable ? 'Awaiting review' : 'Recorded, no review available'}.
            {' '}Submitted <time dateTime={new Date(item.createdAt).toISOString()}>{dateFormat.format(item.createdAt)}</time>.
            {item.status === 'pending' && <> Closes if unreviewed by{' '}
              <time dateTime={new Date(item.expiresAt).toISOString()}>{dateFormat.format(item.expiresAt)}</time>.</>}
          </Text></li>)}</AppGroup>
        </AppFlow>}
      </AppFlow>}
    </div>
    {appealable.length > 0 && <AppForm onSubmit={appeal}>
      <AppHeading as="h3"><Text variant="strong">Appeal a decision</Text></AppHeading>
      <AppField>
        <label htmlFor="appeal-decision">Decision</label>
        <Select id="appeal-decision" value={decisionId} onChange={event => setDecisionId(event.target.value)} required disabled={sending}>
          <option value="">Choose a decision</option>
          {appealable.map(notice => <option key={notice.id} value={notice.id}>
            {decisionLabel(notice.outcome)} of {dateFormat.format(notice.createdAt)}
          </option>)}
        </Select>
      </AppField>
      <AppField>
        <label htmlFor="appeal-reason">What should be reconsidered?</label>
        <Textarea id="appeal-reason" value={reason} onChange={event => setReason(event.target.value)}
          minLength={10} maxLength={2000} rows={5} required disabled={sending} aria-describedby="appeal-guidance" />
        <Text as="p" id="appeal-guidance" variant="muted">Use 10 to 2,000 characters. Give facts and context. Do not include secrets or another person’s private details.</Text>
      </AppField>
      <div><Button type="submit" density="compact" disabled={sending || !decisionId || reason.trim().length < 10}>
        {sending ? 'Sending appeal…' : 'Submit appeal'}
      </Button></div>
    </AppForm>}
  </AppFlow>;
}

function downloadPgn(game: HistoryGame) {
  if (!game.pgn) return;
  const url = URL.createObjectURL(new Blob([game.pgn], { type: 'application/x-chess-pgn;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `chess-${game.id.replace(/[^a-zA-Z0-9_-]/g, '')}.pgn`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function History() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [account, setAccount] = useState<Me | null>();

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    setAccount(undefined);
    void api<Me | null>('/api/me').then(async me => {
      if (!current) return;
      setAccount(me);
      if (!me) { setState({ status: 'signed-out' }); return; }
      const { games } = await api<{ games: HistoryGame[] }>('/api/history');
      if (current) setState({ status: 'ready', games, guest: me.isAnonymous });
    }).catch(() => { if (current) setState({ status: 'error' }); });
    return () => { current = false; };
  }, [attempt]);

  return <Page variant="application"><AppFlow as="section" aria-labelledby="history-heading">
    <SectionHead purpose="application" as="h1" id="history-heading" title="Your games">
      <Text as="p">Choose a completed game to replay its moves, or save the PGN file.</Text>
    </SectionHead>
    <AppFlow aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <StateBlock kind="loading" density="compact" skeleton={false} message="Loading your games…" />}
      {state.status === 'signed-out' && <Text as="p"><Link href="/account/">Sign in</Link> to see your games.
        Your games appear here for the current account.</Text>}
      {state.status === 'error' && <StateBlock kind="error" density="compact" message="Your games could not be loaded; try again."
        action={{ label: 'Retry' }} onAction={() => setAttempt(value => value + 1)} />}
      {state.status === 'ready' && <>
        {state.guest && <Text as="p" variant="muted">This history belongs to a legacy guest session. Clearing the browser cookie can lose access to it. New games require an account.</Text>}
        {state.games.length === 0 ? <>
          <StateBlock kind="empty" density="compact" message="No completed games yet." />
          <div><Button asChild variant="link" density="compact"><Link href="/play/">Invite a friend to play</Link></Button></div>
        </>
          : <Table label="Completed games" columns={historyColumns} rowHeader="game" rowKey="id" density="compact" truncate={false}
            caption="Results read from White’s side. Pending results remain unresolved."
            rows={state.games.map(game => ({
              id: game.id,
              game: <Link href={`/${game.pgn ? 'replay' : 'play'}/?game=${encodeURIComponent(game.id)}`}>
                <Text>{game.format === 'blitz' ? 'Blitz' : 'Rapid'} {FORMATS[game.format].label}</Text>
                <Text variant="muted">{game.aiModel === STOCKFISH_BUILD ? 'Stockfish · Unrated' : game.aiModel ? `AI · ${game.actualModel ?? game.aiModel} · Unrated` : game.rated ? 'Ranked' : 'Casual'}</Text>
              </Link>,
              finished: <time dateTime={new Date(game.endedAt).toISOString()}>{dateFormat.format(game.endedAt)}</time>,
              result: resultLabel(game.result),
              save: game.pgn ? <Button variant="link" density="compact" onClick={() => downloadPgn(game)}
                aria-label={`Download PGN for ${dateFormat.format(game.endedAt)}`}>PGN</Button> : 'Unavailable',
            }))} />}
      </>}
    </AppFlow>
    {state.status === 'ready' && state.games.length > 0 && <Text as="p" variant="muted">Showing your latest 50 games.</Text>}
    <Text as="p" variant="muted">Read the{' '}
      <Link href="/rules/">online rules</Link> for timeout adjudication and rating settlement.
    </Text>
    {account && <FairPlayNotices key={account.id} />}
  </AppFlow></Page>;
}
