import { AppSection } from '@ejm/ui/layout/Application';
import { Link } from '@ejm/ssg';
import { Page } from '@ejm/ui/layout/Band';
import { Row, Rows } from '@ejm/ui/layout/Rows';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Text } from '@ejm/ui/layout/Text';

export default function Home() {
  return <Page variant="application"><AppSection>
    <SectionHead purpose="application" as="h1" title="Chess">
      <Text as="p">Blitz 5 + 3 and rapid 10 + 5.</Text>
    </SectionHead>
    <Rows aria-label="Ways to play">
      <Row title="Play a friend" description="Send an invitation link. Unrated." href="/play/?mode=casual" />
      <Row title="Ranked" description="Get matched with a player. Rated." href="/play/?mode=ranked" />
      <Row title="Stockfish" description="Practice in your browser. Unrated." href="/play/?mode=ai" />
      <Row title="Events" description="Hourly arenas and round-robins. Unrated." href="/tournaments/" />
    </Rows>
    <Text as="p" variant="muted">Games need a free account; recovery email is optional. <Link href="/account/?view=sign-up">Create account</Link> · <Link href="/account/">Sign in</Link> · <Link href="/help/">Help</Link></Text>
  </AppSection></Page>;
}
