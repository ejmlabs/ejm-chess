import { AppFlow, AppGroup, AppSection } from '@ejm/ui/layout/Application';
import { useEffect, useState } from 'react';
import { Link } from '@ejm/ssg';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Table } from '@ejm/ui/components/Table';
import { Page } from '@ejm/ui/layout/Band';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Status } from '@ejm/ui/layout/Status';
import { Text } from '@ejm/ui/layout/Text';
import { api, RequestFailure } from '../client/api';
import { FORMATS, type PublicProfile, type PublicRating } from '../shared/protocol';

type LoadState = { status: 'loading' | 'missing' | 'error' } | { status: 'ready'; profile: PublicProfile };
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const labels: Record<PublicRating['status'], string> = {
  established: 'Established', provisional: 'Provisional', inactive: 'Inactive', unranked: 'Unranked', pending: 'Settlement pending',
};

export default function Profile() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) { setState({ status: 'missing' }); return; }
    setState({ status: 'loading' });
    void api<PublicProfile>(`/api/players/${encodeURIComponent(id)}`)
      .then(profile => { if (current) setState({ status: 'ready', profile }); })
      .catch(error => { if (current) setState({ status: error instanceof RequestFailure && error.status === 404 ? 'missing' : 'error' }); });
    return () => { current = false; };
  }, [attempt]);

  return <Page variant="application"><AppSection>
    <SectionHead purpose="application" as="h1" title={state.status === 'ready' ? state.profile.name : 'Player'}>
      <Text as="p">Public ratings count settled ranked games. Casual and AI games add no rating credit.</Text>
    </SectionHead>
    <AppFlow aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <StateBlock kind="loading" message="Loading this player." density="compact" />}
      {state.status === 'missing' && <>
        <StateBlock kind="empty" message="This player profile is unavailable." density="compact" />
        <Text as="p">Choose a player from the <Link href="/leaderboard/">leaderboard</Link>.</Text>
      </>}
      {state.status === 'error' && <StateBlock kind="error" message="This profile could not be loaded." action={{ label: 'Retry' }} onAction={() => setAttempt(value => value + 1)} density="compact" />}
      {state.status === 'ready' && <>
        {!state.profile.rankedOpen && <Status status="info" label="New ranked play is closed." />}
        <Table label="Player ratings" caption="Settled ratings by time control"
          columns={[{ key: 'format', label: 'Format' }, { key: 'rating', label: 'Rating', align: 'right' }, { key: 'games', label: 'Games', align: 'right' }, { key: 'status', label: 'Status' }]}
          rows={state.profile.pools.map(pool => ({ id: pool.pool, format: `${pool.pool === 'blitz' ? 'Blitz' : 'Rapid'} ${FORMATS[pool.pool].label}`, rating: pool.rating ?? 'Not rated', games: pool.games, status: labels[pool.status] }))}
          rowHeader="format" rowKey="id" truncate={false} density="compact" />
        {state.profile.pools.some(pool => pool.pending) && <Status status="pending" label="A result is awaiting settlement. The displayed rating keeps its last settled value." />}
        {state.profile.pools.some(pool => pool.updatedAt !== null) && <AppGroup as="ul">{state.profile.pools.filter(pool => pool.updatedAt !== null).map(pool => <li key={pool.pool}><Text variant="muted">
          {pool.pool === 'blitz' ? 'Blitz' : 'Rapid'} updated{' '}
          <time dateTime={new Date(pool.updatedAt!).toISOString()}>{dateFormat.format(pool.updatedAt!)}</time>.
        </Text></li>)}</AppGroup>}
      </>}
    </AppFlow>
    <Text as="p" variant="muted">Read the <Link href="/rules/">rating rules</Link> for provisional and active status, or return to the <Link href="/leaderboard/">leaderboard</Link>.</Text>
  </AppSection></Page>;
}
