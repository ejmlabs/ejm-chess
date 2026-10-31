# Proposal

## Launch policy, 2026-10-31

The owner said: "i do not like these arbitrary caps. we just need a billing
ceiling in cloudflare. we don't want to over optimize here." These decisions are
authoritative and supersede conflicting text in this change.

1. **No arbitrary product caps.** Cloudflare budget alerts and the existing $85
   stop webhook are the economic limit. This is not a hard invoice cap; alerts
   can lag. Keep security and abuse limits, protocol and input bounds, bounded
   per-request and per-alarm work, fair-play rules (including the ranked pair
   limit), platform-safety bounds that prevent a hard platform failure, ID
   non-recycling and the explicit stops.
2. **No first-tier load-test gate.** The first-tier 2,000-player provider load
   test no longer gates opening ranked play or arenas. Its harness is deleted
   (see the tooling decision below); tasks 6.4, 10.4 and 18.x are superseded.
   Measure real demand after opening.
3. **Ranked uses the material timeout rule only,** the same as casual: at the
   flag, a loss for the player who ran out when the opponent has mating
   material, otherwise a draw. The private CHA-Solver timeout-proof path is
   retired, with no proof Container, proof qualification, proof-slot
   concurrency cap or proof admission budget (task 3.9, rewritten as the
   retirement task; task 3.8 is superseded).

Opening ranked play and arenas still requires task 3.9 (proof path retired),
the protected-host player checks (3.6, 7.1) now including ranked and arena
play, and the live mail, alert, cron and stop readbacks (6.2, 6.3). Access
removal and public verification follow. Discovery (7.3) comes after that.

### Tooling decision, 2026-10-31

The owner decided later the same day to delete tooling the launch does not need:

1. **Delete the 2,000-player capacity harness.** Its follow-up measurements are
   no longer planned work. If demand ever needs checking, write a small staging
   load script then.
2. **Delete server-side Stockfish analysis.** The postgame engine-screening
   Container, queue and Python image are gone. Reports stay informational, with
   no engine screening. Browser Stockfish practice stays.
3. **The restore-and-replay provider drill is follow-up only,** not a launch gate
   (task 6.3 drops it from its live gates). Its code stays.

## Demand policy, 2026-10-30

The owner rejected further pre-qualified demand caps. The monthly billing stop
is the economic limit. Keep security, correctness and platform-safety ceilings;
do not gate casual public opening on a pre-run 2,000-player workload. Measure
demand after opening. Tasks 6.4, 10.4 and 18.3–18.5 remained follow-up evidence,
not launch gates; the 2026-10-31 tooling decision supersedes them. Task 6.3 no longer requires enforced monthly application
caps; it still requires privacy, recovery, stops, counters and alert readback.
Superseded on 2026-10-31: task 7.2 no longer requires the full first-tier
provider run before opening public ranked play and first-tier arenas. The
launch policy above sets their gates.

## Current spending decision, 2026-10-22

The owner directs one $100 monthly chess spending target, existing
usage alerts and emergency stop to leave headroom for accepted work.
This supersedes the earlier mandatory per-service dollar allocations, tax and
unknown-cost reserves, and repeated financial-review gates in this change.
Those dated calculations are historical estimates, not launch requirements.
The 2026-10-30 demand policy removes monthly application caps. Use Cloudflare
budget alerts and the stop webhook. Preserve abuse rate limits, authentication
and accepted-work recovery. Ranked correctness still applies; since 2026-10-31
no tournament or first-tier workload run is planned. Public Access is
removed only through the existing launch sequence. The $100 target is not a
hard provider invoice cap: alerts can lag and accepted work continues.
Owner authorization covers this configuration and financial-policy change;
do not request another approval for the same decision. Runtime test bounds
and source integrity remain required; repeated cost optimization does not.
The product owns these controls and docs; no shared UI API changes are needed.


## Why

Create `chess.ejmlabs.com`: a small, dependable online chess game where people worldwide can find opponents and compete on global leaderboards. Chess players need a clear board, correct clocks and results, and a fair play process they can trust.

## What Changes

- Plan a separate `ejm-chess` product, hosted entirely on Cloudflare, with a responsive board, live human opponents, reconnects, game history, and PGN export.
- Require explicit username/password accounts for all new games, as requested by the owner on 2026-10-20. This supersedes guest casual admission. Preserve existing guest games and history without promoting their identities. Recovery email is optional at signup and for competition. Use any supplied private email for verification and password recovery only, with no marketing; explain that skipping it leaves no email password reset. Start with proposed 5+3 blitz and 10+5 rapid formats, separate ratings, and one worldwide leaderboard per format. Friendly invitations are unrated.
- Accept passwords of 8 to 128 characters when creating, resetting, or completing an account, as requested on 2026-10-21. Keep existing-password verification compatible. Show one submit action per account form and only the navigation needed to reach another account view.
- Make the server authoritative for seats, legal moves, clocks, and outcomes. Use maintained chess, board, auth, and rating packages rather than writing replacements.
- Superseded on 2026-10-31 (retired): ranked uses the material timeout rule only, and no private timeout-proof path, proof Container, proof-slot cap or proof admission budget remains. Earlier plan: adopt the pinned MIT CHA-Solver package for bounded private timeout proofs under a new saved rules profile. Reserve proof capacity and two finite attempt credits before ranked game admission; validate positive mating witnesses against retained history through an independent maintained rules package. Preserve the original 30-second deadline, after which unknown results fall back to the material timeout rule. Qualify difficult positions, failure recovery, provider bounds, and a small proof pool within the existing $100 monthly budget before enabling the profile. This follow-up extends completed package feasibility and does not claim full FIDE adjudication.
- Add layered fair play controls: abuse prevention, server records, farming checks, reports, private review, appeals, and rating compensation. Server-side engine screening was deleted on 2026-10-31. The latest unattended-operation request supersedes the earlier offer to review flags. Reports remain informational when no reviewer is active. Do not promise that a browser game can prevent all engine assistance.
- Keep the interface focused on playing. Support touch, mouse, keyboard, underpromotion, reduced motion, and clear connection states. Add a remembered Show legal moves toggle, on by default, with legal destination dots and capture rings when selecting a piece on the player's turn.
- Add private match replays from authoritative PGN, with move selection, keyboard navigation, board flipping, and download.
- Add a chess logo and favicon family in the shared token owner and consume public exports. Keep unreleased discovery disabled.
- Run opt-in, bounded round-robin tournaments automatically at fixed UTC cadences, with no-show handling, standings, and restart recovery. Use unrated games and separate event standings until competitive gates pass.
- Make ordinary runtime unattended through automatic expiry, bounded recovery and retention, and the material timeout rule for every flag in casual, ranked, tournament and arena games (a loss for the player who ran out when the opponent has mating material, otherwise a draw), with no proof wait. Never automate cheating convictions from statistical signals.
- Replace the earlier OpenRouter opponent with optional unrated browser Stockfish practice, as requested on 2026-10-20. Serve a pinned maintained single-thread engine from the Cloudflare site, load it only for computer play, and offer named difficulty settings without claimed Elo. The server still validates every move, clock, and result. No model API, provider key, or token quota is needed.
- Support hundreds and thousands of entrants through versioned timed arenas with continuous bounded pairing, pause/resume, shared account reservations, and paged cached standings. The four-player round-robin preview remains a separate format. Treat 2,000 entrants with 1,000 combined live games, and the proposed 10,000-entry/5,000-live tier, as reference targets only; since 2026-10-31 no load run is planned, and these targets are neither product caps, launch gates nor public capacity claims. Party mode remains a separate brainstorm with no approved implementation scope.
- Superseded on 2026-10-31: the approved isolated native capacity harness is deleted and no run is planned. Its six failed attempts (the fifth `f92e8db1-9991-4432-8c30-487eedaf6d17`, the sixth `56089a5b-0826-45e2-85ed-8a7bae106eb0`) stay recorded as dated history in `design.md`, with their held permits and unresolved dispatches and no passing full candidate. They are not capacity evidence.
- Superseded on 2026-10-31: the owner's 2026-10-21 critical-path release decision required real proof/recovery qualification and the full approved first-tier load run before launching ranked play and the first large-arena tier. Current rule: launch ranked play and arenas together after the timeout-proof path is retired (task 3.9), the protected-host player flows (including ranked and arena play) and the live mail, alert, cron and stop readbacks. The first-tier load run, nine-day calendar observation, full-hour retention/endurance run, six-region WAN benchmarks and later tier are no longer planned (tooling decision above). Do not claim those measurements passed or promise their unmeasured performance.
- Superseded on 2026-10-31 (timeout-proof path retired): the retained 2026-10-21 Basic native corpus evidence and the 12-Game candidate preparation are dated history with no current effect.
- Use ejm-ui throughout every chess route, including the board surface, clocks, prose, fields, radio choices, disclosures, tables, notices, loading states, and actions. Add missing reusable contracts in the shared owner before consumer adoption; product components compose public exports and retain domain behavior without custom visual primitives. Reuse public `@ejm/*` contracts, including the shared Select for product form choices. Add upstream chess identity and an unreleased-project discovery gate; use existing public header/build options and extend them only for verified policy gaps. Retain product-specific game behavior in chess. Existing cross-site menus must not expose chess before verified publication.
- Use compact, consistent page spacing for application routes. Stack descriptions beneath page titles, group fields and actions by purpose, keep links within sentences inline, and let loading tables honor the selected density. Preserve shared component appearances, useful form and table widths, and the centered board.
- Make compact application layouts a supported shared ejm-ui contract. Extend existing Page and SectionHead options, publish named spacing aliases and a complete gallery example, add browser geometry checks in both themes at phone and desktop widths, migrate chess, and integrate only these shared changes into the main local ejm-ui checkout. Preserve marketing defaults and unrelated work; local integration does not publish or deploy a package.
- Publish product help, rules, fair play, privacy, and operations guidance with the product. Add studio discovery links only after their destinations are live and verified.
- Use one $100 monthly Cloudflare spending target with usage alerts and an emergency stop. The 2026-10-22 decision supersedes earlier per-service allocations and repeated financial-review gates. Since 2026-10-31 the existing $85 stop webhook and budget alerts are the economic limit, with no arbitrary product admission caps. Keep separate stops for games and email, bounded per-request and per-alarm work, and accepted-work recovery. Count actual billing units once and state unknown prices and delayed billing plainly. Alerts and stops do not impose a hard invoice cap or qualify correctness, capacity or release.

## Capabilities

### New Capabilities

- `chess-play`: Live chess, casual invitations, board interaction, authoritative clocks and adjudication, reconnects, and completed game records.
- `chess-competition`: Account eligibility, ranked matchmaking, ratings, settlement, and global leaderboards.
- `chess-fair-play`: Preventive controls, private evidence, review, appeals, and rating repair.

### Modified Capabilities

- `ejmlabs-site`: Discover the chess product and use an accurate Play action without treating it as a coding tool or a simulated showcase.
- `documentation-discovery`: Link to chess-owned player and developer guides after publication.
- `public-web-access`: Extend public access and protected canonical-host requirements to `chess.ejmlabs.com`.

## Impact

| Owner | Planned responsibility and public contracts |
| --- | --- |
| New `ejm-chess` product | Game Worker and assets, game and competition Durable Objects, D1 auth and read models, product guides. The private bounded timeout-proof pool is retired (2026-10-31). Consume published package exports through declared dependencies. |
| `ejm-ui` | `@ejm/site/projects` chess identity and discovery gating, existing public head/header policy options and any verified extensions, tokens, controls, and shell contracts. No chess rules or account state in shared UI. |
| `ejmlabs` | Studio discovery/content, affected public docs links, and chess-host security operations. Preserve current site migration and unrelated dirty files. |

Dependency direction is chess and studio into public UI packages. Chess does not depend on the agent harness. This repo-local change is the planning home; it does not grant write access to a sibling product or to `ejm-ui`. Apply must establish the owner checkouts and scoped work before edits there, using OpenSpec where an owner already has a root and working normally otherwise.

The three modified capability deltas extend four requirements present in the accepted local studio migration. GitHub main `c92a4a0df2944e6ac6c22498ad4d132f0518d569` still lacks those specification paths. The separate reviewed change `reconcile-chess-planning-baseline` records only the four prerequisite blocks for those absent remote paths and proves actual OpenSpec mergeability; it preserves the richer local specs and imports no migration code. Product verification proceeds independently. Studio discovery waits for verified product and guide destinations, and spec sync or archive waits for the baseline proof. Strict change validation alone does not prove mergeability.

Cloudflare services proposed: Workers Static Assets, Workers, SQLite-backed Durable Objects, D1, Turnstile, and Email Service. The Queues and capped Stockfish Container pool originally proposed for optional analysis, and the separate private CHA-Solver Container pool, were dropped on 2026-10-31 (server analysis deleted, proof path retired). Email Sending is in public beta; paid-plan access, domain onboarding, delivery, and regional latency are deployment gates. At the initial proposal, no resources had been provisioned and no live behavior had been verified. The dated 2026-10-21 UTC product evidence now records a protected canonical-host canary, the existing Workers Paid subscription, sender onboarding, saved budget alerts and a tested stop webhook, and account verification/password recovery for one approved recipient. Public new work remains stopped. Complete recovery, regional latency, and public ranked launch remain open, and capacity is measured after opening; the earlier deployed-proof cost work is retired. See `implementation-scope.md` for the publication boundary and evidence limits.

This proposal changes no production code or public pages. Product implementation, publication, and fair play readiness require the apply workflow and its checks. Public ranked and arena launch requires a tested unattended adjudication (the material timeout rule), abuse, privacy and recovery policy with honest engine-detection limits. Capacity is measured after opening, not before. The release gates are defined in the launch policy above and the design's critical-path release section; measurements that are no longer planned do not block that release and cannot be reported as complete.
