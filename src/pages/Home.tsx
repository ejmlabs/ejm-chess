import { AppActions, AppSection } from '@ejm/ui/layout/Application';
import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Page } from '@ejm/ui/layout/Band';
import { Prose } from '@ejm/ui/layout/Prose';
import { Rule } from '@ejm/ui/layout/Rule';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Text } from '@ejm/ui/layout/Text';

export default function Home() {
  return <Page variant="application"><AppSection>
    <SectionHead purpose="application" as="h1" kicker="Chess by ejmlabs" title="Chess">
      <Text as="p">Play a friend, challenge Stockfish, or compete in ranked chess.</Text>
    </SectionHead>
    <Rule />
    <AppActions role="group" aria-label="Choose a time control">
      <Button asChild arrow><Link href="/play/?format=blitz">Blitz 5 + 3</Link></Button>
      <Button asChild variant="ghost" arrow><Link href="/play/?format=rapid">Rapid 10 + 5</Link></Button>
    </AppActions>
    <Rule />
    <Text as="p" variant="muted">Minutes to start. Seconds added after each move.</Text>
    <Prose>
      <p>New games require an account. Read <Link href="/help/">how to play</Link> and the{' '}
        <Link href="/rules/">online rules</Link>, including how a timeout is scored.</p>
    </Prose>
  </AppSection></Page>;
}
