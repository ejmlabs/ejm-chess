import { AppActions, AppFlow } from '@ejm/ui/layout/Application';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Page } from '@ejm/ui/layout/Band';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Text } from '@ejm/ui/layout/Text';
import { gamePath, isGameId } from '../shared/gamePath';

const GameReplay = lazy(() => import('../client/GameReplay'));

type LoadState = { status: 'loading' | 'invalid-link' | 'signed-out' | 'unavailable' | 'error' }
  | { status: 'too-large' | 'invalid-record'; id: string }
  | { status: 'ready'; id: string; pgn: string };

export default function Replay() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('game');
    if (!isGameId(id)) { setState({ status: 'invalid-link' }); return; }
    const controller = new AbortController();
    let current = true;
    setState({ status: 'loading' });
    // The rules package and board stay out of this route's initial loading chunk.
    void import('../client/replay').then(async ({ loadReplayPgn, ReplayError }) => {
      try {
        const pgn = await loadReplayPgn(id, controller.signal);
        if (current) setState({ status: 'ready', id, pgn });
      } catch (error) {
        if (!current) return;
        const code = error instanceof ReplayError ? error.code : 'LOAD_FAILED';
        if (code === 'SIGN_IN_REQUIRED') setState({ status: 'signed-out' });
        else if (code === 'UNAVAILABLE') setState({ status: 'unavailable' });
        else if (code === 'RECORD_TOO_LARGE') setState({ status: 'too-large', id });
        else if (code === 'INVALID_RECORD') setState({ status: 'invalid-record', id });
        else setState({ status: 'error' });
      }
    }).catch(() => { if (current) setState({ status: 'error' }); });
    return () => { current = false; controller.abort(); };
  }, [attempt]);

  const retry = () => setAttempt(value => value + 1);

  return <Page variant="application"><AppFlow as="section" aria-labelledby="replay-heading">
    <SectionHead purpose="application" as="h1" id="replay-heading" title="Match replay">
      <Text as="p">Step through the recorded moves of your completed game.</Text>
    </SectionHead>
    <AppFlow aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <StateBlock kind="loading" density="compact" skeleton={false} message="Loading your recorded game…" />}
      {state.status === 'invalid-link' && <>
        <StateBlock kind="error" density="compact" message="This replay link is invalid." />
        <Button asChild variant="link" density="compact"><Link href="/history/">Choose a game from your history</Link></Button>
      </>}
      {state.status === 'signed-out' && <AppFlow>
        <StateBlock kind="empty" density="compact" message="Sign in with the account that played this game." />
        <Text as="p">Legacy guest games need the original browser session.</Text>
        <Button asChild variant="link" density="compact"><Link href="/account/">Sign in</Link></Button>
      </AppFlow>}
      {state.status === 'unavailable' && <StateBlock kind="error" density="compact"
        message="This completed game is not available to this account yet; its result may still be recording."
        action={{ label: 'Retry replay' }} onAction={retry} />}
      {state.status === 'error' && <StateBlock kind="error" density="compact"
        message="Your replay could not be loaded; check your connection and try again."
        action={{ label: 'Retry replay' }} onAction={retry} />}
      {state.status === 'too-large' && <StateBlock kind="error" density="compact" message="This replay exceeds the 1 MiB record limit; you can still download the PGN." />}
      {state.status === 'invalid-record' && <StateBlock kind="error" density="compact" message="This recorded PGN is invalid and cannot be replayed; you can still download the source." />}
      {state.status === 'ready' && <Suspense fallback={<StateBlock kind="loading" density="compact" skeleton={false} message="Opening your replay…" />}>
        <GameReplay key={state.id} pgn={state.pgn} />
      </Suspense>}
    </AppFlow>
    {'id' in state && <Button asChild variant="link" density="compact"><a href={gamePath(state.id, 'pgn')} download>Download PGN</a></Button>}
    <Text as="p" variant="muted">Replays are private to the players and make no changes to the game.</Text>
    <AppActions>
      <Button asChild variant="link" density="compact"><Link href="/history/">Your games</Link></Button>
      <Button asChild variant="link" density="compact"><Link href="/play/">Play chess</Link></Button>
    </AppActions>
  </AppFlow></Page>;
}
