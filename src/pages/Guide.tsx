import { AppHeading, AppPre } from '@ejm/ui/layout/Application';
import type { ReactNode } from 'react';
import { Link, Static, usePath } from '@ejm/ssg';
import { Page } from '@ejm/ui/layout/Band';
import { Prose } from '@ejm/ui/layout/Prose';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { ExternalLink } from '@ejm/ui/shell/ExternalLink';
import { RATING_VERSION, RULES_VERSION } from '../shared/protocol';

interface GuideContent { title: string; body: ReactNode }

const server = import.meta.env.SSR || import.meta.env.DEV;
const guides: Record<string, GuideContent> = server ? {
  '/help': {
    title: 'How to play',
    body: <>
      <p>Open <Link href="/play/">Play</Link> and choose an opponent: a friend, a ranked match, or Stockfish. Then choose{' '}
        blitz 5 + 3 or rapid 10 + 5: minutes each, plus seconds added after every move.
        Games need a username and password account. <Link href="/account/">Create one or sign in</Link>.</p>
      <AppHeading as="h2">Play a friend</AppHeading>
      <p>Create an invitation and copy its link to your friend. Their Join takes the open seat; the first player to join gets it.
        An unused link expires after ten minutes. Once both of you are seated, you have two minutes to press Ready.
        The clocks start when both players are ready, and White moves first. Friend games are unrated.</p>
      <AppHeading as="h2">Move</AppHeading>
      <p>Drag or select a piece, or use the arrow keys and Enter on the focused board. Type a move, such as e2e4, under the moves list.
        The server checks every move and returns the accepted position. Choose a queen, rook, bishop or knight when a pawn promotes.</p>
      <p>Legal moves is on by default: select one of your pieces to see dots on legal squares and rings on captures. Hints respect checks and pins
        and never suggest a best move. The switch remembers your choice in this browser when storage is available.
        Premove queues one move during your opponent’s turn and checks it when your turn arrives; premoves show no hints.</p>
      <p>Offer a draw or resign beside the board. A draw needs your opponent’s acceptance, and your next move withdraws an offer.
        Resigning asks you to confirm.</p>
      <AppHeading as="h2">If the connection drops</AppHeading>
      <p>The clocks keep running. Reopen the same game link, signed in to the same account, and you return to your seat directly.
        Wait for the server position before moving again. Legacy guest seats still need their original browser cookie.</p>
      <p>A game follows one tab at a time. If it opens in another tab, this one says so. Choose Use this tab to take it back.</p>
      <AppHeading as="h2">After the game</AppHeading>
      <p>Open <Link href="/history/">History</Link> and choose a game to replay it. Step through moves, flip the board, or download the PGN.
        On a focused replay, Left and Right step, and Home and End jump. Replays are private to the players and limited to 1 MiB and 12,700 half-moves.</p>
      <AppHeading as="h2">Accounts</AppHeading>
      <p>Choose a unique username and a password of 8 to 128 characters. Password managers and pasted passwords work.
        A private recovery email is optional for signup, play, ranked games and events. It is used only for verification and password recovery. We send no marketing.</p>
      <p>Without a recovery email, a lost password cannot be reset, so keep it in a password manager. Adding or changing a recovery email is unavailable.
        A supplied email can receive a reset link before it is verified. Verification confirms the mailbox and does not affect play.</p>
      <p>For security, sign-in and sign-up allow only a few tries a minute from one network. The message says when to try again.
        Signup pauses only when the owner sets a stop; existing accounts can still sign in.</p>
      <p>Use <Link href="/account/">Account</Link> to sign out, download your data or close your account. Finish active games before changing sign-in.
        Legacy guests can finish and replay their existing games; new guest games are closed. Signing up does not transfer a guest’s history or ratings.</p>
      <AppHeading as="h2">Ranked</AppHeading>
      <p>Choose Ranked to be matched with another player in the blitz or rapid rating pool. Ratings use Glicko-2 and appear on the{' '}
        <Link href="/leaderboard/">Leaderboard</Link> once you qualify. Friend and Stockfish games are unrated.</p>
      <p>Ranked play and arenas are open. Apart from the fair-play rules, including two ranked games per pair in a rolling 24 hours, there are no product limits.
        Behavior under heavy load is still being measured.</p>
      <AppHeading as="h2">Events</AppHeading>
      <p><Link href="/tournaments/">Events</Link> lists automatic arenas and round-robins, with entry and standings. Both are unrated, and their points stay within the event.
        One account can hold only one ranked or event reservation at a time.</p>
      <p>Arenas pair for one hour in blitz or two in rapid. Register, then choose Join queue. When your game is ready, the Events page says so at the top:
        open it and press Ready within two minutes. After each game, queue again or pause. A no-show pauses your entry until you resume.</p>
      <p>An arena win earns one point and a draw half a point. Losses, no-shows and technical voids earn zero; there are no bye or streak points. Equal points share a rank.
        A pair may meet twice only with a different opponent between meetings. Arenas have no product entrant or unfinished-game cap; the Cloudflare budget stop and platform limits are the only bounds.</p>
      <p>New pairings stop at the cutoff. Accepted games finish within their 18-minute blitz or 40-minute rapid wall deadline. Standings stay provisional while games or updates are pending,
        and a refresh may briefly show an older complete snapshot.</p>
      <p>Round-robins have three or four players and three rounds, and each round starts automatically.</p>
      <AppHeading as="h2">Stockfish practice</AppHeading>
      <p>Choose Stockfish in <Link href="/play/?mode=ai">Play</Link>, then Relaxed, Club, Strong or Maximum. You play White. Practice games are unrated and stay off leaderboards.</p>
      <p>Stockfish loads automatically from this site and runs in your browser, with no installation, model API, provider key or token charge.
        Wait for it to load, then press Ready. Strength varies with your device; the names are not Elo ratings.
        Keep the tab open because the server clocks keep running. If the engine fails, choose Retry Stockfish.
        Never use outside assistance against a person.</p>
      <AppHeading as="h2">When new games pause</AppHeading>
      <p>New work pauses only when the owner sets a stop or the Cloudflare budget stop fires. There are no monthly game, signup or email caps.
        Games already accepted keep their clocks, results and private replays. Clearing a stop resumes new work.</p>
      <p>Read the <Link href="/rules/">online rules</Link>, including how a timeout is scored, and the <Link href="/fair-play/">fair play policy</Link>.</p>
    </>,
  },
  '/rules': {
    title: 'Online rules',
    body: <>
      <p>Rule version: <code>{RULES_VERSION}</code>, for casual, tournament, arena and ranked games.
        It does not claim full FIDE tournament compliance.</p>
      <AppHeading as="h2">Moves and results</AppHeading>
      <p>The server uses chess.js to validate moves, including castling, en passant, and promotion.
        Checkmate wins. Stalemate and recognized insufficient material draw.</p>
      <p>Threefold repetition and the fifty-move rule end the game automatically here.
        Players do not submit a separate claim. Resignation and an accepted draw offer also end play.</p>
      <AppHeading as="h2">Clocks</AppHeading>
      <p>Blitz starts with five minutes per player and adds three seconds after an accepted move.
        Rapid starts with ten minutes and adds five seconds. Both players confirm readiness before White’s clock starts.</p>
      <p>The server clock decides whether a move arrived in time. There is no network delay allowance.
        The clock continues through a disconnect. The displayed clock is an estimate of the server deadline.</p>
      <AppHeading as="h2">Timeouts need care</AppHeading>
      <p>A timeout is a draw when the rules library proves insufficient material, or when the player with time left has only a king.
        Otherwise the player who ran out of time loses. This applies to casual, tournament, arena and ranked games, and a disconnect does not stop the clock.</p>
      <p>The current rules library cannot recognise a fully blocked position where no side could ever mate, so a timeout there is scored as a loss.</p>
      <AppHeading as="h2">Ratings and leaderboards</AppHeading>
      <p>Blitz and rapid use separate Glicko-2 pools. Casual invitations do not affect ratings.
        A ranked game changes ratings only after the server accepts its final result.</p>
      <p>A new account starts each pool at 1,500 with high rating uncertainty. Each accepted ranked result updates both players together.
        Ratings can move more while uncertain. Whole inactive UTC weeks increase uncertainty without subtracting rating points.</p>
      <AppHeading as="h2">Finding a ranked opponent</AppHeading>
      <p>Choose one format. A queue ticket lasts two minutes; refresh it to keep waiting. Your account can reserve one game across both formats and tournaments.</p>
      <p>Matching starts within 100 rating points. The window widens by five points per second, up to 800, using the shorter wait of the two players.
        For example, a pair who have both waited 20 seconds can match within 200 points. Broad region preferences relax after both have waited 30 seconds; this does not guarantee network latency.</p>
      <p>When two players match, the account with the lower White-balance gets White. Equal balances choose White at random.
        Starting a ranked game adds one to White’s balance and subtracts one from Black’s, so colors even out over time.</p>
      <p>The same two accounts may start at most two ranked games in a rolling 24 hours across blitz and rapid.
        Choose another opponent while that limit applies. Computer games never use a ranked slot or rating pool.</p>
      <AppHeading as="h2">Getting onto the leaderboard</AppHeading>
      <p>Leaderboard eligibility requires at least 20 ranked games against eight distinct opponents,
        an account at least seven days old, rating uncertainty of 100 or less, and a game within the last 30 days.
        An active ranked restriction removes eligibility.</p>
      <p>Rating version: <code>{RATING_VERSION}</code>. A site rating is specific to this service.
        It is not a FIDE, national federation, or another chess site’s rating.</p>
      <p>Unestablished players remain provisional. An inactive account leaves the public rankings until it meets the activity rules again.
        Rankings sort by the displayed rounded rating; account identifiers give equal ratings a stable order. Updates can be pending while a result or projection recovers.</p>
      <p>An approved rating correction replays the affected pool from saved results in batches of 20. Admission to that pool pauses during repair.
        Results already accepted remain recorded, and the corrected rankings appear when a full generation is ready.</p>
      <p>Computer games are always unrated. Browser Stockfish strength depends on the device and search budget;
        the selected difficulty is not an audited engine result or Elo rating. Human-game assistance rules still apply.</p>
      <p>Ranked play pauses only when the owner sets a stop or the Cloudflare budget stop fires.
        See <Link href="/fair-play/">fair play</Link> for review and appeal limits.</p>
    </>,
  },
  '/fair-play': {
    title: 'Fair play',
    body: <>
      <p>Play each move yourself against other people. Do not use an engine, another player, an opening book, or outside analysis during a live human game.
        Do not share an account, arrange results, farm ratings, or create accounts to avoid a restriction.</p>
      <p>The optional AI opponent makes moves only in its labelled, unrated AI game.
        It is not permission to use AI assistance against a person. AI games cannot be reported.</p>
      <AppHeading as="h2">What the service can check</AppHeading>
      <p>The server controls legal moves, seats, clocks, and results. These checks stop invalid game commands.
        They cannot prove that a player used no help outside the browser.</p>
      <p>Account requests allow 120 reads, 30 writes, and 12 game-connection requests per minute in separate windows.
        Each game also allows each seat 30 commands per ten seconds and ten connections per minute. Reopening a tab does not clear the game limits.
        HTTP responses tell you how long to wait with Retry-After. Invalid or oversized frames are rejected.</p>
      <p>Server records check repeated opponents, reciprocal wins, very short resignations, three-account play clusters, and concentrated wins in accepted ranked human games.
        A play cluster means all three pairings occurred within 24 hours. Concentrated wins mean three wins from two opponents within 24 hours, including two resignations before ten half-moves.
        These facts are informational. They do not change a rating, find engine use, or establish that accounts share an owner. Players on a shared network are counted by account.</p>
      <p>There is no engine screening. Reports are informational. In unattended operation, reports never change ratings or account access.</p>
      <AppHeading as="h2">Report a game privately</AppHeading>
      <p>Use a completed game’s report form to identify a concern and give concrete details.
        Keep accusations and personal information out of public channels. A report records a concern and is not a finding. The receipt states whether review is available.</p>
      <p>In unattended mode, unreviewed reports become eligible to close as expired-unreviewed after seven days.
        Daily cleanup closes at most 500 eligible cases and preserves any human decision, unresolved appeal, or future evidence hold.
        Closure records no human finding and changes no rating or account access. The same private receipt and normal evidence retention remain.
        Duplicate reports cannot reopen the case, recreate deleted evidence, or extend retention.</p>
      <AppHeading as="h2">Unattended fair play</AppHeading>
      <p>This service defaults to unattended operation. Reports stay private and do not promise human review. No engine-use penalty follows automatically.
        Accuracy, a shared IP address, window focus, and report counts are never enough on their own to sanction a player.
        Engine-use findings need corroborated evidence and human review.</p>
      <p>Evidence and reviewer notes stay private. Review access requires an owner’s verified account and a valid Cloudflare Access identity.
        Local development does not bypass this requirement.</p>
      <AppHeading as="h2">Notices and appeals</AppHeading>
      <p>Affected players can read their <Link href="/history/#fair-play">private notices and submit an appeal</Link> from Your games.
        New case-based decisions are disabled in unattended mode. Existing decision notices remain visible. An appeal can record relevant context, but no reviewer response is promised.</p>
      <p>The current appeal window is 14 days. Ranked restrictions last at most seven days.
        The notice gives its deadline. An unreviewed appeal closes automatically after 14 days without claiming that a person reviewed it. This does not change a historical rating exclusion.</p>
    </>,
  },
  '/privacy': {
    title: 'Privacy',
    body: <>
      <p>Use <Link href="/account/">Account</Link> to download your data or close your account. These controls require your current password. We promise no staffed inbox or human response time.</p>
      <AppHeading as="h2">Account and game records</AppHeading>
      <p>The service stores player identifiers, public usernames, optional private recovery email addresses, password hashes, verification state, sessions, game moves, clocks, results and rating records. Better Auth handles password hashing and verification. Passwords and recovery secrets are excluded from public profiles and game records. Private account state exposes whether a recovery email exists, without returning its address.</p>
      <p>Recovery email is optional for signup and competition. It is used only for account verification and password recovery. Signup creates no marketing subscription, and we send no promotional email. Accounts without recovery email cannot reset passwords by email; adding or changing email is unavailable.</p>
      <p>New games require accounts. Existing guest records remain tied to their original browser cookie. Losing that cookie can lose access to those games. Guest records are not anonymous to the service and are never promoted to ranked accounts automatically.</p>
      <AppHeading as="h2">Sign-in cookies</AppHeading>
      <p>Better Auth stores sessions in Cloudflare D1. Session cookies are limited to this host, HttpOnly,
        and SameSite Lax. They use Secure outside the explicit loopback development mode.</p>
      <p>Sessions expire after seven days and do not refresh automatically. Password reset uses a short-lived, single-use token and revokes old sessions. Recovery email and passwords are not saved in browser preferences. Local development disables real email delivery without bypassing verification.</p>
      <AppHeading as="h2">Browser preferences</AppHeading>
      <p>Show legal moves saves an on/off value in this browser's local storage. It contains no account or game data and is not sent to the server. If storage is blocked, the switch works until the page reloads.</p>
      <AppHeading as="h2">Safety records</AppHeading>
      <p>Reports, game evidence, review decisions, restriction notices, and appeals support fair play review.
        Reviewers must protect reporter details, private evidence, and account information.</p>
      <p>Cloudflare handles network traffic and security challenges. Authentication and challenge checks can use connection
        information such as an IP address. It is not proof of cheating.</p>
      <p>Request windows and private denial counters support abuse limits. Ranked farming records retain game identifiers, account pairs, result order, and pattern facts inside the competition authority.
        Platform storage bounds limit growth. Permanent competition and minimal audit records remain under the retention rules below.</p>
      <AppHeading as="h2">Computer practice</AppHeading>
      <p>Stockfish runs in your browser using engine files served by this site. No position or account data is sent to an external inference provider.
        The service still receives accepted moves and records the selected engine and difficulty with your private game history and replay.</p>
      <p>Historical games retain their original AI metadata. The earlier OpenRouter catalog and inference paths have been removed.</p>
      <AppHeading as="h2">Visibility</AppHeading>
      <p>Leaderboards show eligible players’ names, ratings, and game counts. Tournament schedules, entrant display names, event points, and standings are public. Registration needs an account. Game positions, PGNs, and replays remain limited to the players.
        This site has no public chat, spectator mode, advertising, or configured analytics.</p>
      <AppHeading as="h2">Retention and account requests</AppHeading>
      <p>Ordinary game evidence is eligible for cleanup after 90 days. Appeal windows and timely appeals can hold it longer; unattended appeals close after their bounded deadline.
        Old report text can be cleared after the same period when no appeal hold applies.
        Private reviewer notes, corroboration and appeal text are eligible for minimization 90 days after final case action, once appeal windows and holds end. Bounded maintenance can run later than these eligibility times.</p>
      <p>Unreviewed report closure after seven days is separate from deletion. It preserves normal evidence expiry and private receipt metadata; duplicate reports do not extend retention.</p>
      <p>Decisions, public decision reasons, minimal case audit, completed PGNs, game/player IDs, historical names, tournament records and immutable rating/correction history remain stored. Proved eligible unrated game payloads can retire after one hour. Retirement preserves history and private replay access; it does not promise unlimited storage or close an account.</p>
      <p>In <Link href="/account/">Account</Link>, confirm your password to download your profile, own reports, appeals, notices and game metadata. Each JSON page contains at most 50 records and 256 KiB. Pages can reflect different moments. Passwords, session/reset tokens, other reporters' identities, reviewer notes and investigation evidence are excluded. Keep downloads private and download wanted PGNs before closure.</p>
      <p>To close an account, finish active games, leave events, confirm your password and type CLOSE. Closure removes credentials, sessions, recovery email and current profile details in one database transaction. A neutral account label, opaque player ID and minimal closure receipt remain. Old sign-in and reset requests cannot recreate access. Historical competition records remain, so closure is not full anonymization. Recovery email is not required.</p>
      <p>Sessions last seven days; expired sessions receive bounded daily cleanup. Reset/verification secrets last 15 minutes and become eligible for cleanup after expiry plus one day. Request windows become eligible after one day, released seats after 30 days, and email budget receipts after 62 days. Native recovery history rolls over 30 days on the verified Paid D1 and SQLite Durable Object backends. It is not an independent downloaded backup.</p>
      <p>Before an approved restore, preserve later closure receipts outside its targets and reapply closures before authentication or admission reopens. If that set is uncertain, keep access closed. A private SQL export needs its own approval, destination, access and expiry. This policy requires no production account/session export. Raw synthetic drill files are deleted after acceptance within 30 days; sanitized reports and hashes remain.</p>
    </>,
  },
  '/docs/developer-guide': {
    title: 'Developer guide',
    body: <>
      <p>ejm-chess is a Cloudflare Workers product with a prerendered React interface.
        Every page composes public ejm-ui controls, typography, states, tables, disclosures, board and clock surfaces, tokens, fonts, and site tools.</p>
      <p>Use public leaf exports from <code>@ejm/ui</code>. The kit owns visual components and interactions, including the maintained cm-chessboard surface. Fields keep native labels and validation. Shared application recipes arrange content; the product defines no visual classes, inline styles or CSS rules. Static guides use the shared Prose surface inside the prerender package’s Static boundary, so prose needs no browser script.</p>
      <p>Every route uses the public ejm-ui design. Use <code>Page variant="application"</code> for the page and <code>SectionHead purpose="application"</code> for its title. Public <code>@ejm/ui/layout/Application</code> exports own reading widths, content groups, actions, forms, fields, fieldsets, headings and records. <code>GameWorkspace</code>, <code>PlayerStrip</code>, <code>MovePairs</code> and <code>MoveHistory</code> own board, clock and move presentation. The product supplies game data, words, semantic labels and callbacks. The shared kit owns all visual choices and calm motion.</p>
      <p>The stylesheet only imports <code>@ejm/ui/styles.css</code>. The public <code>ejmSite</code> plugin always checks consumer source and rejects local visual classes, inline styles, CSS rules, raw HTML and opaque JSX prop spreads. The former <code>enforceDesignKit</code> option is obsolete. This checks source ownership; browser layout still needs verification. Add a missing reusable pattern in ejm-ui, then consume its public export. Native labels, validation, fieldsets and disclosure lifecycles remain intact. Account settings, export and closure controls load after the current session check. The security challenge loads with its form, and submit stays disabled until it provides a token. Native validation, the same request lock and password clearing remain intact. This migration does not open public play or alter account policy, rules, clocks, engine behavior or server authority.</p>
      <AppHeading as="h2">Hosting and access</AppHeading>
      <p>The canonical host is chess.ejmlabs.com. Cloudflare hosts the application, static assets, D1 database and SQLite Durable Objects. Production uses LOCAL_DEV=false, a 50-millisecond public Worker CPU limit, and disabled workers.dev and preview URLs.</p>
      <p>Private administration requires both the verified owner account and Cloudflare Access. The exact budget-stop callback requires its separate secret. Public player access grants neither permission. The repository deployment guide and qualification reports record exact release versions, bindings and measured limits.</p>
      <p>Minute and daily triggers recover saved work. Behavior under heavy load is still being measured.</p>
      <AppHeading as="h2">Owners</AppHeading>
      <p>ejm-chess owns chess rules, game state, matchmaking, ratings, account policy, and fair play composition.
        ejm-ui owns shared visuals and site infrastructure. The lab owns project discovery.
        The product does not depend on the agent harness.</p>
      <AppHeading as="h2">Player accounts</AppHeading>
      <p>Better Auth owns username and password authentication in native D1. Recovery email is optional. Private account state returns accountReady and hasRecoveryEmail without exposing an address. New game seats require a completed username and password account. Player ranked and tournament eligibility uses credentials, restrictions and feature flags, not email verification. Owner administration still requires a real verified email and Cloudflare Access.</p>
      <p>Accounts without recovery email cannot use email password reset or request verification. Adding or changing email is unavailable. A supplied recovery email can receive password reset before verification. The service sends only verification and recovery messages, with generic reset receipts and no marketing subscription.</p>
      <AppHeading as="h2">Server authority</AppHeading>
      <p>A Durable Object owns each game. The browser sends versioned commands with unique identifiers.
        The server checks the actor, seat, position, and deadline before accepting a command.
        Reconnection receives a server snapshot.</p>
      <p>The product uses chess.js to compute legal destinations and check moves against the full saved position before submitting its version. Premoves are checked after the opponent moves. The lazy public ejm-ui Chessboard draws dots and capture rings through cm-chessboard and owns input, promotion, orientation, focus, and cleanup. The kit imports no product rules or state types. The public Switch controls the browser preference. No engine or extra server request is needed, and every submitted move still needs server acceptance. GameClock displays the product’s local estimate without announcing each tick.</p>
      <p>The competition owner serializes ranked admission, tournament reservations and rounds, and rating settlement. D1 holds account and review records.
        A browser request cannot supply a game result.</p>
      <AppHeading as="h2">Computer practice</AppHeading>
      <p>Stockfish 19.0.1 lite single-thread runs in a lazy browser worker. Named strengths use bounded built-in skill settings.
        The White owner proposes Black moves through versioned engine commands; the server still checks every move, clock, and result.
        Computer games are unrated and cannot be reported. No external inference service is used.</p>
      <p>The engine assets total about 1.8 MiB. The upstream WASM starts with 128 MiB of memory and can grow; a 16 MiB hash table is only part of that memory.
        One worker searches for at most 1.2 seconds per normal turn, with no pondering, and is terminated when its game closes.</p>
      <AppHeading as="h2">Local development</AppHeading>
      <p>Use Node 24, install the sibling public ejm-ui packages, then install this product’s dependencies.
        The repository README and operations guide give the local commands, bindings, migration steps, and launch gates.</p>
      <AppPre><code>{'npm ci\nnpm run typecheck\nnpm test\nnpm run build\nnpm run worker:check\nnpm run budget'}</code></AppPre>
      <p>Run the type check, focused server tests, static build, Worker dry run, and bundle budget checks before review.
        Tests must protect a real rule or failure risk.</p>
      <AppHeading as="h2">Automatic operation</AppHeading>
      <p>Competition schedules bounded hourly, daily, and weekly tournaments. Durable game identities and result receipts prevent duplicate pairings or event points. Cron recovers scheduled work and retries outboxes. Timeouts end with a win or a draw under the material rule.</p>
      <p>Settled casual game payloads retire after at least one hour, at a bounded rate, only after matching terminal version, rules version, and digest checks. Durable tombstones prevent ID reuse; D1 keeps completed replays. Permanent game and rating records still grow. A stop can pause new admission; there is no product retention cap.</p>
      <p>CASUAL_GAME_LIMIT and CASUAL_GAME_ID_LIMIT are optional. Both default to no cap. Retirement frees a payload slot and keeps the old ID reserved.</p>
      <AppHeading as="h2">Budget controls</AppHeading>
      <p>The monthly spending target is $100. Cloudflare budget alerts give notice. When delivered, the final alert stops new work and leaves headroom for active games and recovery. Billing alerts can lag, so this is not a guaranteed invoice cap.</p>
      <p>There are no monthly game, signup or email caps in the application. Usage counters remain for the private Operations page. The Cloudflare budget stop and versioned feature stops are the admission controls.</p>
      <p>Signup spends an attempt after basic validation and Turnstile, before password hashing. Failures and retries stay counted for visibility. A stop closes new signup attempts; existing signin remains available.</p>
      <p>D1 records game and email operations through stable receipts. A retry reuses its receipt, including after a month changes or a stop is set.
        Explicit game and email stops persist across months.</p>
      <p>The private Operations page shows spending target, usage and versioned stop controls. A deployment-wide NEW_WORK_STOPPED setting closes all new budgeted work.
        Active games, accepted result delivery, replay, and required recovery continue.</p>
      <p>Three enabled usage-alert policies have been saved and read back for the approved inbox. The high policy also targets a dedicated secret-authenticated stop webhook whose provider creation/test succeeded. The existing $5 monthly Workers Paid subscription and sending-domain setup are verified. The approved recipient completed real verification and password recovery, then signed in with the new password. The earlier browser session was revoked. Two email attempts were recorded in that test. Account/game and email stops were cleared on October 22 after the owner approved practical quotas. No actual threshold-crossing billing event has been observed. Cloudflare budget alerts cover account-wide usage, exclude subscription fees, and can arrive late.
        Retained storage and rejected traffic can still incur charges after admission stops. Consult the repository budget and operations guides for live setup, alert verification, and recovery requirements.</p>
      <AppHeading as="h2">Feature gates and failures</AppHeading>
      <p>RANKED_ENABLED, TOURNAMENTS_ENABLED and ARENAS_ENABLED control new admission to their modes. Existing admitted work continues through a stop.
        Browser Stockfish needs no provider key. AI_ENABLED=false closes new practice.
        Loading or search failures show Retry computer while the server clocks continue.
        OPERATION_MODE defaults to unattended; only an explicit reviewed mode permits new private case decisions.</p>
      <AppHeading as="h2">Current limits</AppHeading>
      <p>Private recovery capture records native Game and Competition bookmarks, object identities, alarms, policies, bounded state hashes and pending work without changing play. Owner and Access checks protect its routes. A separate isolated recovery entry point provides reviewed restore and restart controls on synthetic resources; production exposes capture only. Native D1 and both object restores passed active/completed casual fixtures, held acknowledgments, ranked correction, budget receipts, aged tombstones and native undo. A separate single-account D1 rollback passed two reapplications of the original closure receipt, preserving history while rejecting old sign-in. It did not exercise populated reset records or concurrent later closures. The repository recovery guide records these bounded drills; full-service recovery remains unqualified.</p>
      <p>Signup with and without recovery email, live Turnstile, verification, recovery and sign-in passed a protected recipient test. That result does not guarantee delivery to every mailbox. Full-service restoration, long calendar and endurance runs, and regional latency remain unmeasured.</p>
      <p>Read the <Link href="/rules/">rule contract</Link>, <Link href="/privacy/">privacy limits</Link>, and{' '}
        <Link href="/credits/">asset credits</Link> before extending the product.</p>
    </>,
  },
  '/credits': {
    title: 'Piece credits',
    body: <>
      <p>The board uses the Wikimedia standard chess pieces by{' '}
        <ExternalLink href="https://en.wikipedia.org/wiki/User:Cburnett">Cburnett</ExternalLink> and{' '}
        <ExternalLink href="https://en.wikipedia.org/wiki/User:Rfc1394">Rfc1394</ExternalLink>,
        modified by <ExternalLink href="https://shaack.com">shaack</ExternalLink> for cm-chessboard.</p>
      <p>The pieces use the{' '}
        <ExternalLink href="https://creativecommons.org/licenses/by-sa/3.0/">Creative Commons Attribution-ShareAlike 3.0 Unported license</ExternalLink>.
        This product uses the standard sprite without further artwork changes.</p>
      <p><ExternalLink href="https://github.com/shaack/cm-chessboard/blob/master/assets/pieces/standard.svg">Original sprite and embedded notice</ExternalLink>.{' '}
        <ExternalLink href="https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard">Wikimedia source collection</ExternalLink>.</p>
      <AppHeading as="h2">Chess identity</AppHeading>
      <p>The original knight mark and chess wordmark belong to the shared ejm-ui token package. SVG wordmarks use outlined Manrope glyphs and the ejmlabs palette. The shared asset generator records provenance and produces the favicon family without a runtime renderer.</p>
      <AppHeading as="h2">Software and fonts</AppHeading>
      <p>cm-chessboard supplies the board interface under MIT. chess.js supplies legal moves under BSD-2-Clause.
        Glicko-2 ratings use glicko2, whose package declares MIT. Tournament pairing and standings use MIT-licensed @echecs packages. Better Auth, jose, React, and the shared ejm-ui code use MIT.</p>
      <p>Manrope and IBM Plex Mono use the SIL Open Font License 1.1. The repository’s third-party notices retain
        the applicable notices and font license text. The piece artwork has its own license, separate from board code.</p>
      <AppHeading as="h2">Browser Stockfish</AppHeading>
      <p>Computer practice uses the unmodified Stockfish.js 19.0.1 lite single-thread build, maintained by Nathan Rugg and Chess.com, under GPL-3.0.
        The exact source revision is 0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6. Its source and required network are available with the engine:</p>
      <p><a href="/engines/stockfish-19.0.1-lite-single/COPYING.txt">GPL license</a>{' · '}
        <a href="/engines/stockfish-19.0.1-lite-single/AUTHORS">Authors</a>{' · '}
        <a href="/engines/stockfish-19.0.1-lite-single/source.tar.gz">Corresponding source</a>{' · '}
        <a href="/engines/stockfish-19.0.1-lite-single/nn-61e7af4bb97d.nnue">Required network</a>{' · '}
        <a href="/engines/stockfish-19.0.1-lite-single/BUILD.md">Build instructions</a>{' · '}
        <a href="/engines/stockfish-19.0.1-lite-single/PROVENANCE.json">Pins and hashes</a></p>
    </>,
  },
} : {};

export default function Guide() {
  const path = usePath();
  return <Static render={server ? () => {
    const guide = guides[path] ?? guides['/help'];
    return <Page variant="application">
      <SectionHead purpose="application" as="h1" kicker="Chess by ejmlabs" title={guide.title} />
      <Prose as="article">{guide.body}</Prose>
    </Page>;
  } : undefined} />;
}
