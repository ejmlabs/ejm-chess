import { AppActions, AppFlow, AppSection } from '@ejm/ui/layout/Application';
import { useEffect, useState } from 'react';
import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Table } from '@ejm/ui/components/Table';
import { Page } from '@ejm/ui/layout/Band';
import { Rule } from '@ejm/ui/layout/Rule';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Status } from '@ejm/ui/layout/Status';
import { Text } from '@ejm/ui/layout/Text';
import { api, type PublicConfig } from '../client/api';
import { FORMATS, type Pool } from '../shared/protocol';

interface LeaderboardPage {
  pool: Pool;
  entries: { id: string; name: string; rating: number; games: number }[];
  updatedAt: number | null;
  nextCursor: string | null;
}

type LoadState = { status: 'loading' } | { status: 'error' }
  | { status: 'ready'; page: LeaderboardPage; ranked: boolean };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

export default function Leaderboard() {
  const [pool, setPool] = useState<Pool>('blitz');
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    const query = new URLSearchParams({ pool, ...(cursor ? { cursor } : {}) });
    void Promise.all([
      api<LeaderboardPage>(`/api/leaderboard?${query}`),
      api<PublicConfig>('/api/config'),
    ]).then(([page, config]) => {
      if (current) setState({ status: 'ready', page, ranked: config.ranked });
    }).catch(() => { if (current) setState({ status: 'error' }); });
    return () => { current = false; };
  }, [pool, cursor, attempt]);

  function choosePool(next: Pool) {
    setPool(next);
    setCursor(null);
  }

  return <Page variant="application"><AppSection>
    <SectionHead purpose="application" as="h1" title="Leaderboard">
      <Text as="p">Glicko-2 ratings from settled ranked games.</Text>
    </SectionHead>
    <Rule />
    <AppActions role="group" aria-label="Leaderboard time control">
      {(['blitz', 'rapid'] as const).map(format => <Button key={format}
        variant={pool === format ? 'primary' : 'ghost'}
        aria-pressed={pool === format} onClick={() => choosePool(format)}>
        {format === 'blitz' ? 'Blitz' : 'Rapid'} {FORMATS[format].label}
      </Button>)}
    </AppActions>
    <Rule />
    <AppFlow aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <StateBlock kind="loading" message="Loading the leaderboard." />}
      {state.status === 'error' && <StateBlock kind="error" message="The leaderboard could not be loaded." action={{ label: 'Retry' }} onAction={() => setAttempt(value => value + 1)} />}
      {state.status === 'ready' && <>
        {!state.ranked && <Status status="info" label="Ranked play is closed." />}
        {state.page.entries.length === 0
          ? <AppFlow><StateBlock kind="empty" message="No players qualify for this view yet." /><AppActions>{state.ranked && <Button asChild><Link href={`/play/?mode=ranked&format=${pool}`}>Play ranked</Link></Button>}<Link href="/rules/">How to qualify</Link></AppActions></AppFlow>
          : <Table label="Leaderboard ratings" caption={`${pool === 'blitz' ? 'Blitz' : 'Rapid'} ratings`}
            columns={[{ key: 'player', label: 'Player' }, { key: 'rating', label: 'Rating', align: 'right' }, { key: 'games', label: 'Games', align: 'right' }]}
            rows={state.page.entries.map(player => ({ id: player.id, player: <Link href={`/player/?id=${encodeURIComponent(player.id)}`}>{player.name}</Link>, rating: Math.round(player.rating), games: player.games }))}
            rowHeader="player" rowKey="id" truncate={false} />}
        {state.page.updatedAt !== null && <Text as="p" variant="muted">
          Updated <time dateTime={new Date(state.page.updatedAt).toISOString()}>{dateFormat.format(state.page.updatedAt)}</time>.
        </Text>}
        {(cursor || state.page.nextCursor) && <AppActions>
          {cursor && <Button variant="ghost" onClick={() => setCursor(null)}>First page</Button>}
          {state.page.nextCursor && <Button variant="ghost"
            onClick={() => setCursor(state.page.nextCursor)}>Next page</Button>}
        </AppActions>}
      </>}
    </AppFlow>
    <Text as="p" variant="muted">Pending games do not change ratings. <Link href="/rules/">Rating rules</Link> · <Link href="/fair-play/">Fair play</Link></Text>
  </AppSection></Page>;
}
