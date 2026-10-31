import type { ReactNode } from 'react';
import { defineSite, Link, usePath } from '@ejm/ssg';
import { siteDefaults } from '@ejm/site/head';
import { SiteLayout } from '@ejm/ui/shell/SiteLayout';
import { Page } from '@ejm/ui/layout/Band';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Text } from '@ejm/ui/layout/Text';
import chessInk from '@ejm/tokens/assets/projects/chess/mark-ink.svg';
import chessPaper from '@ejm/tokens/assets/projects/chess/mark-paper.svg';
import './styles.css';

function App({ children }: { children: ReactNode }) {
  const path = usePath();
  return <SiteLayout
    linkComponent={Link}
    header={{
      homeLabel: 'Chess home', identity: { name: 'Chess', description: 'by ejmlabs', artwork: { src: chessInk, darkSrc: chessPaper, width: 64, height: 64 } }, nav: [
        { label: 'Play', href: '/play/', current: path === '/play' },
        { label: 'Events', href: '/tournaments/', current: path === '/tournaments' },
        { label: 'Leaderboard', href: '/leaderboard/', current: path === '/leaderboard' },
        { label: 'History', href: '/history/', current: path === '/history' },
        { label: 'Account', href: '/account/', current: path === '/account' },
      ]
    }}
    footer={{
      legal: 'Chess by ejmlabs.', columns: [
        { heading: 'Playing', links: [{ label: 'Help', href: '/help/' }, { label: 'Rules', href: '/rules/' }, { label: 'Fair play', href: '/fair-play/' }] },
        { heading: 'About', links: [{ label: 'Privacy', href: '/privacy/' }, { label: 'Developer guide', href: '/docs/developer-guide/' }, { label: 'Piece credits', href: '/credits/' }] },
      ]
    }}
  >{children}</SiteLayout>;
}

export default defineSite({
  ...siteDefaults('chess', { titleTemplate: '%s | chess', description: 'A clear board. A real opponent. Multiplayer chess by ejmlabs.' }),
  budget: { js: 180, css: 20, fonts: 70, html: 30 },
  App,
  routes: [
    { path: '/', load: () => import('./pages/Home'), head: { title: 'Chess' } },
    { path: '/play/', load: () => import('./pages/Play'), head: { title: 'Play' } },
    { path: '/account/', load: () => import('./pages/Account'), head: { title: 'Account', robots: 'noindex' } },
    { path: '/leaderboard/', load: () => import('./pages/Leaderboard'), head: { title: 'Leaderboard' } },
    { path: '/player/', load: () => import('./pages/Profile'), head: { title: 'Player', robots: 'noindex' } },
    { path: '/history/', load: () => import('./pages/History'), head: { title: 'Your games', robots: 'noindex' } },
    { path: '/replay/', load: () => import('./pages/Replay'), head: { title: 'Replay', robots: 'noindex' } },
    { path: '/tournaments/', load: () => import('./pages/Tournaments'), head: { title: 'Events' } },
    { path: '/help/', load: () => import('./pages/Guide'), head: { title: 'Help' } },
    { path: '/rules/', load: () => import('./pages/Guide'), head: { title: 'Rules' } },
    { path: '/fair-play/', load: () => import('./pages/Guide'), head: { title: 'Fair play' } },
    { path: '/privacy/', load: () => import('./pages/Guide'), head: { title: 'Privacy' } },
    { path: '/docs/developer-guide/', load: () => import('./pages/Guide'), head: { title: 'Developer guide' } },
    { path: '/credits/', load: () => import('./pages/Guide'), head: { title: 'Credits' } },
    { path: '/admin/', load: () => import('./pages/Admin'), head: { title: 'Review', robots: 'noindex' } },
  ],
  notFound: { component: () => <Page variant="application"><SectionHead purpose="application" as="h1" title="Page not found"><Text as="p"><Link href="/play/">Play</Link> or read <Link href="/help/">Help</Link>.</Text></SectionHead></Page> },
});
