# Implementation scope

The owner requested implementation on 2026-10-20. The planning home remains this change. Follow `openspec-apply-change` here. Product and UI work use their existing owner workflows; neither isolated owner has an OpenSpec root, and none is initialized.

| Owner | Isolated checkout | Scope |
| --- | --- | --- |
| `ejm-chess` | `/private/tmp/ejm-chess-2yz1VsKp/ejm-chess` | New standalone product repository on `codex/chess-foundation`: Cloudflare runtime, account integration, game and competition state, board, product guides, and meaningful tests. |
| `ejm-ui` | `/private/tmp/ejm-chess-2yz1VsKp/ejm-ui` | Local clone of `927e463b267567c6f90c49949518c37bd12a696d`, on `codex/chess-contracts`: public project/discovery contracts and owner checks/docs. Existing dirty TUI/capture files are excluded. No remote is created or pushed. |
| `ejmlabs` | Existing checkout | Apply tracking and evidence only until baseline reconciliation and publication prerequisites pass. Preserve unrelated dirty files and local commits. |

Read the studio and UI `AGENTS.md` before owner changes. Product instructions are recorded in its own `AGENTS.md`. Dependencies point from chess and studio to declared public UI exports. No harness dependency, sibling private imports, copied registry/header generator, or new design system is allowed.

The isolated checkouts use a common temporary parent so declared `file:../ejm-ui/packages/*` dependencies remain valid. Record the exact owner revision and patch with the product; a file link is not a source pin. Preserve the finished work in durable owner checkouts or reviewable patch bundles before ending implementation.

Task 1.2 remains a prerequisite for affected studio work and spec sync/archive. It does not block independent product development. No studio links or shared discovery flag may claim chess is released.

Local implementation and tests are authorized. Remote repository creation, owner pushes, hosted CI admission, paid resources, public deployment, and ranked launch keep their stated approval and readiness gates. No Cloudflare resources or live sign-in delivery are established by this file.

## Added scope on 2026-10-20

The later account request requires explicit username/password signup for every
new game. It supersedes guest admission. Product owns Better Auth composition,
additive username migration, admission predicates, account UI and guides. Use
optional private recovery email only for security, without marketing. Keep maintained
password/recovery APIs and existing public ejm-ui inputs; no shared API or
harness change is needed. Preserve legacy guest IDs, owned seats and records
without account promotion. Root owns planning and integration; workers may own
disjoint product backend and frontend files. This authorizes local work under
section 15, with release gates unchanged.

The owner's correction makes recovery email optional everywhere, including
ranked play, arenas and round-robin events. Task 15.4 applies that policy through
Better Auth's public placeholder helper without a schema migration or identity
rewrite. Backend owns auth, eligibility SQL, private `hasRecoveryEmail` and
regression tests; frontend owns public ejm-ui composition and player gates;
root owns guides, planning and integration. Owner administration keeps its real
verified-email and Cloudflare Access checks. No-email accounts have no email
password reset, and adding or changing email later is outside this correction.
The source and docs must explain that limit. No shared UI or harness contract
changes are needed.

User requested private replays, a chess logo, scheduled tournaments, and unattended routine operation. Product owns replay/tournament/runtime behavior and guides. Shared UI owns the chess asset family and its provenance. Root owns plan tracking and cross-owner integration. No shared harness work, premature discovery, deployment, remote creation, or spending is authorized by these additions.

The later request replaces OpenRouter practice with pinned browser Stockfish, including its lazy engine assets, license/source delivery, named strength settings, authoritative engine-move proposals, player flow, and product guidance. This remains local product work. Hundreds and thousands of tournament entrants are a new unmet requirement; its format/scale work remains in exploration. Party mode is explicitly brainstorming only.

## Browser practice verification, 2026-10-20

The replacement is implemented locally. Six upstream inputs match their pins;
the two runtime assets total 1,874,201 raw bytes. The real engine returned legal
moves at all four settings. The full product suite passed 141 tests, and the
final reconnect refinement passed both TypeScript programs and all 15 Game
tests. Final build budgets passed; the subsequent Worker dry run included all
83 emitted assets. Source and license endpoints matched all eight local files.

A guest played e4/e6, reloaded the game, continued d4/h6, resigned, and opened
the saved private history and replay. Keyboard strength selection and typed
moves worked; the live game fit a 390 by 844 viewport. Browser silent-network
recovery and physical-device performance remain untested. See the delivered
product `docs/verification.md` for methods, resource limits, and release gaps.
No remote push, deployment, live email, public capacity, or rated launch is
established by these checks.

## Shared form correction, 2026-10-20

All six product form choices now consume the existing public
`@ejm/ui/components/ui/select` contract. Product CSS no longer overrides shared
select styling. This is consumer work with no new shared API or dependency.
The platform still owns the open picker. Native handlers, labels, placeholder
validation, and disabled states are preserved.

Browser and Worker types, both route budget gates, final build, focused source
review, and the subsequent Worker dry run passed. The build emits 84 assets;
initial Play is 97.2 KiB gzip JavaScript and 14.6 KiB CSS, and guides are 93.1
and 13.3 KiB. Keyboard selection changed the real strength value. Shared field,
chevron, and focus styles fit a 360 by 844 viewport in light and dark themes.
The new browser tab recorded no warnings or errors. Owner-only and notice-gated
fields received source/type checks without bypassing access controls. Product
architecture, the public developer guide, and verification notes were updated;
player help, API, and configuration behavior did not change. Source and plan
snapshots accompany this local correction. Release gates remain incomplete.

## Legal-move hints verification, 2026-10-20

The product now owns a remembered default-on Show legal moves preference through
the public ejm-ui compact Switch. The lazy board uses chess.js from the full
authoritative FEN and the public cm-chessboard marker API. Dots mark empty legal
destinations; rings mark captures. Off-turn premoves and read-only replays show
no hints. No shared API, dependency, server protocol, or engine advice was added.

Both TypeScript programs and 24 focused hints/replay tests passed. The final
build, dynamic/static route budgets, and subsequent Worker dry run passed with
86 assets. Play initial JavaScript is 100.8 KiB gzip and CSS is 14.6; guides are
93.4 and 13.3. The lazy Board is 15.24 decimal kB gzip, shared rules are 11.64,
and the marker sprite is 1.11. No latency or device-memory improvement is claimed.

Real local practice verified pointer and keyboard selection, legal pawn/knight
destinations, queen capture rings, accepted drag moves and engine replies,
cancellation, persisted toggle-off, and terminal cleanup. A Vite inlining defect
was fixed with its public asset query. A narrow document bubble Escape hook
clears pointer selection without taking promotion handling from the package.
At 360 by 844 pixels, hints and shared switches fit in both themes. A nearby
clock wrapping defect was fixed. No warnings/errors were recorded, and the
test games were resigned. Physical touch, physical-phone performance, and live
promotion interaction remain untested in this pass. Product guides and durable
source/plan evidence accompany the local change; publication gates stay open.

## Site-wide ejm-ui scope, 2026-10-20

The owner requires ejm-ui on every chess page with no custom visual components.
The existing isolated UI scope now includes public RadioGroup, Disclosure,
rich Table, Prose, GameClock, and lazy Chessboard contracts, their package
metadata/docs/catalog/examples, meaningful tests, maintained cm-chessboard
integration, and lockfile updates. Product scope includes all routes and client
adapters, removal of copied visual rules, public-guide updates, and consumer
verification. The kit accepts generic props and never imports chess rules,
product DTOs, auth, or server modules. Semantic HTML, product content/layout,
legality, clock estimation, and command state stay in chess. Dependencies remain
chess into public @ejm exports. Preserve unrelated capture/TUI work. Refresh the
changed shared source and patch with durable product delivery. Local work only;
remote, release, spending, and scale gates remain unchanged.

## Site-wide ejm-ui verification, 2026-10-20

All chess routes now compose public kit controls, states, type, tables,
disclosures, board, clocks, and shell. The new reusable contracts live in the
shared owner with catalog entries, examples, and docs. Product CSS handles
layout only. A final source audit found no remaining copied visual primitives,
appearance overrides, private sibling imports, or dropped action gates.

Both product TypeScript programs and shared repository types passed. Product
hints/replay passed 23 tests; shared board/clock/helper checks passed eight
tests across four files. Radio, disclosure, rich-table, docs, and owner gates
passed. A full shared check exposed a class-merging gap fixed through the
maintained upstream config, with all four focused regressions passing. Its
other capture/cache/performance environment failures remain recorded in the
product verification guide; the whole shared gate is not claimed to pass.
The final shared gallery/docs build passed all 17 route budgets.

The final product build and both route-budget gates passed without raising
limits. Initial Play is 103.9 KiB gzip JavaScript and 13.8 KiB CSS; guides are
85.7 and 13.3. The lazy shared renderer is 15.18 decimal kB gzip JavaScript and
1.61 kB CSS. The subsequent Worker dry run included 93 assets, with unchanged
2,163.81 KiB raw and 407.57 KiB gzip Worker code.

An owned browser game played e4/e5 and Nf3/Nc6, reloaded, resigned, exported
PGN, and replayed through shared controls. The guest lobby, legal hints,
remembered switch, rich history, tournament selection/focus, disabled guest
entry, leaderboard, unavailable profile, Home, guides/client guide navigation,
and not-found page were checked. At 360 by 844, Play/replay/history/tournaments
fit without horizontal page overflow in the tested themes. No browser warnings
or errors were recorded. Theme and viewport were restored. Private forms were
reviewed and typechecked without bypassing access. Real email/accounts,
physical touch/phone performance, live promotion, deployment, capacity, and
ranked launch remain unverified. Durable product/shared sources, the owner
patch, hashes, provenance, screenshots, and this plan accompany the local work.

## Budget and large-event continuation, 2026-10-20

The owner authorized $100/month for chess and requested stops and alerts. This
supersedes earlier references to missing spending scope in this record. It does
not open public ranked admission, authorize unrelated resource changes, or
establish a deployed canary. The owner later confirmed `chess@ejmlabs.com` as
the sender and supplied a private delivery-test/alert destination. Sender
onboarding, delivery and alert readback remain unverified.
The current Cloudflare login can inventory Worker/D1/queue/container/email
resources. The chess Worker and D1 do not yet exist. Billing alert/subscription
API reads return 403 with the existing OAuth scopes. Other product resources
remain untouched. Record actual alert configuration separately from source work.

Task 10.3 is complete as design work. `design.md` records selected arena-v1
rules, maintained-package alternatives, bounded indexed state and public/private
reads, shared account authority, exact first/later qualification targets,
retirement arithmetic, and cost gates. Strict validation passes. Task 10.4
remains implementation and qualification work. No test target establishes live
capacity. Worker ownership remains product runtime; shared UI remains public
visual contracts, with no harness dependency.

The new shared UI gate passed 24 focused tests and the literal full check:
84 files, 782 tests, no skips. The optional fixture `public` directory was absent.
Only Chrome process cleanup and optional-public fixture handling changed after
the original delivery. Both stages preserved source bytes, modes, HEAD and
status; original failed-pass logs and delivery hashes remain intact. Evidence:
`shared-ui-gate-20261020T193322Z` in this chat's durable artifact directory.
This closes the recorded shared full-check failure without claiming release.

## Final local continuation, 2026-10-20

Task 5.1 is complete. Request counters are atomic, and private aggregate reads
require the owner session plus verified Cloudflare Access. Farming policy
`informational-2026-10-v2` covers accepted final ranked human results, including
pending rating-repair results. The five documented patterns remain informational
with no sanctions or rating changes. Indexed 1,001-row guards bound each
neighborhood; the 1,000-check fixture measured 4,002 actual SQLite row reads and
1,000 unique updates. Overflow reports incomplete coverage. Historical v1
catch-up has a durable cursor, advances at most eight checks per alarm, and
preserves its due time across ordinary requests and restart.

Shared casual and computer admission now reserves combined capacity before
initialization, retains uncertainty for recovery, and limits initialization to
32 attempts per second. Accepted work recovers through new-work stops and
disabled new computer admission. Timed arena authority, API, paged D1 projection,
cache boundary, and public UI are implemented but remain disabled by default.
Task 10.4 remains open for authenticated acceptance and capacity qualification.
Its sustained-load and retirement arithmetic is not hidden by raising caps.

The final full product suite passed 201 tests across 28 files in 8.99 seconds.
The prior 194-pass/seven-failure run remains preserved. All seven failures were
fixture drift; the focused repair passed 27 tests before the full rerun. Both
product TypeScript programs passed. The completed frontend build passed the
unchanged dynamic and guide budgets. Play measures 103.9 KiB gzip JavaScript
and 13.9 KiB CSS; tournaments 100.0 and 13.6; guides 85.7 and 13.3. The following
Worker dry run included 93 assets, 2,274.10 KiB raw and 431.29 KiB gzip. Worker
gzip adds 23.72 KiB over the earlier UI delivery for the required new behavior;
no speed improvement or deployed resource binding is claimed.

Local migrations 0008 and 0009 applied without resetting guest games. A separate
loopback preview verified the default-off arena page and, with an explicit
local override and minute-cron dispatch, automatic hourly/daily/weekly event
publication, keyboard selection and focus, truthful empty paged standings,
selection reload, and both themes at 360 by 844 without horizontal overflow.
No browser warnings or errors were recorded. Theme and viewport were restored;
the owned tab and preview were closed. No verified-account bypass or fabricated
browser identity was used. Private entry/actions, nonempty pagination, real
email, two-person acceptance, touch devices, deployment, and scale stay open.

Cloudflare MCP still needs OAuth authorization and exposes no callable tool in
this session. The existing Wrangler login cannot read billing alerts or
subscriptions. The user prefers MCP or a token; an existing token path or MCP
authorization is pending. No token values were requested in chat or copied to
delivery. Provider alerts, sender setup, actual delivery, and the invoice
exposure remain unverified. No remote creation, push, DNS edit, paid purchase,
resource provisioning, live email, or deployment occurred.

Public guides distinguish these local checks from launch qualification. A new
versioned source delivery will preserve earlier source bundles and failed logs,
include the latest shared render/performance fixes, omit local state and secrets,
and normalize the unrelated capture executable mode only in the copied snapshot.
The source checkout remains untouched. The planning change now has 38 of 50
tasks complete; incomplete gates are neither synced nor archived.

## Explicit account implementation, 2026-10-20

The owner's username/password request supersedes public guest and magic-link
creation. New casual, computer and competitive admission requires a normalized
username and a maintained password credential. Existing guest IDs, seats and
records remain intact, and guests cannot promote themselves. Private email
serves verification and password recovery only. Signup adds no marketing flow.
The product owns these rules and composes public Better Auth and ejm-ui APIs;
no harness or shared UI contract changed for accounts.

Task 15.1 passed the final native Worker suite: 213 tests in 29 files. It covers
native D1 credentials, unique usernames, generic errors, request/challenge
guards, token expiry, verification idempotence, single-use password reset,
session revocation, stable legacy explicit-account completion, and old guest
seat/replay access without new guest admission. Both TypeScript programs pass.

Task 15.2 passed owned browser acceptance across two local account sessions.
Signup, signin/reload/signout, wrong-password focus, invitation return, a real
10+5 game with e4/e5 and resignation, the active-game identity guard, private
mail outage and invalid-reset errors worked. At 360 by 844, account forms fit
both themes, with keyboard submission and password-manager fields. Theme and
viewport were restored. Successful recovery uses controlled native bindings;
real inbox delivery and the final post-reset identity screen remain deployed
acceptance checks. Existing user tabs and database game records were preserved.

The final build passes unchanged budgets: Account 94.6/13.3 KiB gzip JS/CSS,
Play 104.6/13.9, guides 85.8/13.3. The following Worker dry run includes 98
assets and 2,288.74 KiB raw, 433.98 KiB gzip Worker code. A focused native
password probe measured 69 ms signup and 36 ms signin wall time. It does not
qualify the unchanged 50 ms production CPU cap. Deployed CPU and capacity
measurements stay open. All 66 product documentation links resolve; local
Account/auth headers prevent caching and referrer disclosure.

The exact approved Keychain item could not release its secret during two
bounded attempts. No account API call or cloud change followed those attempts.
Live budget alerts, sender setup, delivery, and the provider stop connection
remain unverified. No credential values or local session state enter delivery.
The source and evidence remain local, with all previous release, adjudication,
screening, baseline-spec, capacity and discovery gates open.

The first immutable account source/plan snapshot verified all 1,196 files and
the unchanged shared-owner patch. Its checksum index is
`7980bcf0b82c69eda5c4e911524fcbdae4d5cdc93ec2b2cc38bab0c9c52c4b15`.
This closes task 15.3 after the documentation, hashing, integration and byte
checks. Tasks 15.1 to 15.3 bring the change to 41 of 53 tasks complete.
A final fresh snapshot includes this completion record. Keep the unfinished
change unsynced and unarchived.

## Optional recovery email implementation, 2026-10-20

Task 15.4 follows the owner's explicit optional-everywhere choice. Omitted or
blank email uses Better Auth's public `createPlaceholderEmail` helper, with a
direct pinned `@better-auth/core` 1.7.12 dependency already present transitively.
No migration or identity rewrite was needed. Placeholder accounts stay
unverified, skip native verification/reset tokens and mail/quota work, and do
not expose their private addresses. Only `hasRecoveryEmail` was added to private
account state. All player eligibility paths now check credentials and
restrictions without an email gate. Verified owner Access remains unchanged.

The final native suite passes 217 tests in 29 files in 9.61 seconds, including
no-email competition, stale credentials/restrictions, public privacy, real
recovery, and placeholder mail/token denial. Both TypeScript programs pass.
Independent source review found no blocker in this correction. Owned browser
acceptance passed blank-email signup, reload, signout/signin and casual lobby
access. The account page explains lost-password limits and hides verification
for no-email accounts. The test account was signed out, the owned tab closed,
and the isolated runtime stopped without changing user tabs or localhost data.

Frontend budgets stay unchanged and pass: Account 94.7/13.3 KiB gzip JS/CSS,
Play 104.6/13.9, guides 85.8/13.3. The Worker dry run followed the completed
frontend build and includes 98 assets and 2,289.77 KiB raw, 434.25 KiB gzip code.
Player, API, architecture, tournament, operations, deployment, license and owner
guidance were updated. Email add/change remains unavailable, and no-email
accounts have no email password reset. No shared UI or harness edits were needed.

The fresh immutable delivery is `chess-continuation-20261020-v5` under this
chat's durable artifact root; prior deliveries remain intact. The change now
has 42 of 54 tasks complete. Production CPU/email, protected-host acceptance,
baseline reconciliation, screening, capacity, provider alerts and release gates
remain incomplete. No remote creation, push, DNS, provisioning, deployment or
public ranked opening occurred. Keep the change unsynced and unarchived.

## Shared application layout implementation, 2026-10-20

The owner approved moving compact application spacing into reusable ejm-ui
contracts under section 17. Public Page and SectionHead now expose application
and stacked options. Field/content aliases derive from the existing scale;
caller overrides and marketing defaults stay compatible. The product uses
these options on 11 Pages and 12 SectionHeads and removes copied grouping rules.
No dependency, backend policy or new visual primitive was added.

The complete gallery fixture and existing capture tooling now enforce rendered
padding, alignment, gaps, inline flow, Table density, overflow and touch sizing.
Both the isolated and main local UI checkouts passed 360px/1280px light/dark
checks. Main first failed on its real loading-row padding defect, then passed
after the one-line Table correction. Main's focused suite passed 34 tests in
2.35 seconds. Shared types and both gallery builds passed unchanged budgets.
The normal local quality command invokes the geometry check; the full unrelated
quality pipeline was not rerun for this scoped change.

Main integration applied 18 reviewed files with hash/mode preconditions,
translated spacing aliases into main base.css, regenerated only its own catalog
and fixed Table density. It preserved the CSS entry point, dependencies and
unrelated TUI, shots and SSG work. Earlier isolated chess contracts and assets
remain excluded from main. Independent reviews found no integration or consumer
gate changes; all 1,128 non-layout product attribute signatures were retained.

Product types and final frontend budgets passed: Account 94.6/13.2 KiB gzip
JS/CSS, Play 104.5/13.7, Replay 90.7/13.6 and guides 85.6/13.2. The subsequent
Worker dry run read 99 asset files and stayed at 2,289.77 KiB raw, 434.25 KiB
gzip. The unchanged backend suite was not rerun. An owned isolated browser
preview passed no-email signup, Stockfish e4/e5, resignation, History and replay
stepping. Representative phone/desktop pages fit both themes. QA signed out,
restored settings, closed its tab and stopped its runtime while preserving
the user's preview and data. No physical-device or release claim follows.

The durable source delivery is chess-continuation-20261020-v7. Its main local
integration manifest, selective patch and measured browser evidence are retained
in ejm-ui-application-layout-20261020-v1 beside it. The package freezes task 17.5
before its delivery checkbox is completed; live tracking reaches 50 of 62 only
after the package integrity review. The twelve earlier launch, cost-alert,
capacity and ranked gates remain incomplete. Keep the change unsynced and
unarchived, with no push, publication, provisioning or deployment.

## Lifecycle checkpoint and follow-up preparation, 2026-10-21 UTC

At the 04:08 UTC source checkpoint, both product TypeScript programs passed
under Node v24.19.0. The integrated local native suite passed 307 tests in
39 files in 14.103 seconds, with no skipped or todo tests. It includes durable
proof start/stop debt and fixed private capacity ticket/retirement changes.
Independent reviews and the exact source hashes are retained with
`full-regression-summary-20261021-v4.json`, `proof-lifecycle-review-v1.md` and
`capacity-review-stable-input-v2.json` in the launch evidence directory. Later
controller, intent-observation, corpus and driver work is not covered by that
checkpoint. The private capacity gates remain disabled.

Task 18.6 is preparation only. Product `docs/capacity-follow-up.md` now contains
separate finite proposals for full-hour retention and holds, real nine-day
calendar scheduling, ranked proof cost/recovery, and the 10,000-entry/5,000-live
tier. An independent read-only review found no remaining preparation gap.
The proposals require their own planning review, sealed manifest, complete
fresh cost ledger and owner approval before provider work. They cannot reuse
the short run or spend the same core allocation twice. The $100 total, $20
proof share and separate $20 accepted-work reserve remain unchanged.

The retention proposal explicitly records its storage feasibility blocker:
at an assumed 4 KiB page size, 72,000 Game schema allocations alone exceed its
proposed 3 GiB ceiling. Native measurement and a reviewed revision are required
if that floor holds. The fixed retirement backlog avoids claiming 25 successful
retirements per second from a steady arrival rate of 20. No original capacity,
proof, recovery, calendar or public launch requirement is marked complete by
these proposals.

Six affected product Markdown files passed 50 relative file-target checks and
whitespace/em-dash checks. The preservation check found no changes to the
55 recorded frontend/shared/asset inputs or the 80 currently served files.
The redesigned site and logo, localhost preview, sealed candidates and provider
resources were preserved. Guides remain source updates, not newly published
documentation. Tracking reaches 55 of 70 tasks complete; keep this change
unsynced and unarchived while the 15 required tasks remain.

## Board and finite-work checkpoint, 2026-10-21 UTC

Tracking remains 55 of 70 tasks complete. No launch task was checked off in
this continuation. The complete redesign and logo remain the accepted source
baseline. Public new work, ranked play, proof execution and the private
capacity run remain closed.

Two disposable real account sessions completed a normal local 10+5 casual
game. A queued premove executed automatically after the opponent moved.
Promotion cancellation restored board focus; keyboard Knight underpromotion
and pointer Queen promotion appeared in both accepted histories. The private
replay reached the same final position after an agreed draw. Light and dark
views fit an actual 360 by 844 browser viewport without horizontal overflow.
Physical touch and browser reduced-motion qualification remain unrun, so
task 3.6 stays open. Temporary tabs, credentials and the local listener were
removed. Evidence is retained under `board-acceptance-v3` in the launch
evidence directory.

The product now streams frozen arena standings through bounded immutable
version windows, durably stages exact pages before D1 publication and keeps
the greatest version at or below an active build revision. Fourteen focused
Arena tests passed after append pruning, covering invisible anchors, restart,
stable cursors, legacy cleanup bounds, duplicate results and atomic rollback.
A separate read-only review found no concrete stream defect. The fresh and
legacy native probes each passed seven checks with one actual Game and
2,000 published entrants; their differing retained-history shapes do not
measure the complete workload or native alarm cadence.

Eight private capacity ledger tables now use `WITHOUT ROWID` only when newly
created. The controller/wrapper/meter suite passed 32 focused tests and both
controller probes passed eleven checks. In a paired fresh native fixture,
the thirteen-event Game lifecycle used 97 then 83 write rows and the same
65 projection advances used 336 then 271 write rows. Existing stored tables
are not converted. These observations do not prove a complete request, row,
storage, expiry or cost envelope; all capacity readiness gates remain off.

The private proof cost worksheet remains conditional and unqualified. Its
basic and lite calculations are about $17 before unresolved charges within
the $20 proof allocation. Registry, historical setup/log attribution, physical
stop bounds and current headroom still need evidence. It cannot authorize
another provider run or close task 3.8. The fixed ten-second capacity recovery
lead is already adopted; no further approval for that plan choice is needed.

The new proof acceptance entry has a fixed manifest and persisted command,
fault, expiry and stop journal. It always uses a null compiled seal, so every
execution command stays unavailable. Seven focused native tests and Worker
types passed. The adapters, full usage bounds, real scenario run and coherent
proof-aware restore remain missing. This is preparation under tasks 3.8 and
6.3, not a sealed candidate or a completed proof gate.

The final integrated native suite passed all 356 tests in 47 files in
18.178 seconds, with no skipped or todo tests. Both product TypeScript programs
passed under Node v24.19.0. An isolated frontend build passed the normal and
stricter guide budgets; Play used 117.5 KB gzip JavaScript and 13.0 KB CSS.
The subsequent production-config Worker dry run used those isolated assets
and reported 2,370.41 KiB raw and 453.08 KiB gzip. It uploaded nothing. The
user's existing localhost output was not replaced.

A fresh disjoint capacity review found that protocol claims and ordinary
maintenance were absent from earlier partial write products. Neither a
complete fit nor impossibility has been proved. The next source work must
fund the final stop's SQL tail and separately measure maintenance stages
before it can bound automatic work or add prepaid Game grants. Sample
savings cannot be spent as approved headroom.

The product owns domain behavior, private qualification adapters and guides.
The active Desktop `ejm-ui` owner supplies public visual contracts, including
the promotion chooser correction. The product developer guide now reflects
that owner's mandatory source guard and obsolete `enforceDesignKit` option.
No harness dependency, paid resource, production binding or public route was
added by these checks. The fresh source delivery target is
`chess-continuation-20261021-v8` beside the launch evidence directory. Use it
only with a `COMPLETE.json` record and matching `SHA256SUMS`; its manifests
must confirm unchanged capture inputs and indexes. It preserves the exact
consumed Desktop UI source, including unrelated dirty work, rather than a
chess-only upstream patch. Product guides are source updates until publication
is verified.

## Once-only capacity policy verification, 21 October 2026 UTC

Task 18.1 is complete. The scoped audit in
`chess-launch-20261020-v1/capacity-run-policy-audit-20261021-v1` compared the
unchanged receipt, identity, clock, expiry and retirement paths with retained
passing evidence. Six existing native cases then passed on the current prepaid
workflow and controller plan, including lost replies, cold reconstruction and
interrupted reservations with fresh and retained tables. The focused result
in `capacity-run-policy-focused-20261021-v2` records 6 passed, 36 skipped,
zero failures and unchanged source inputs. Its earlier v1 attempt stopped
during sandboxed runtime startup before any test ran and reported a denied
Wrangler log path. That failed startup remains recorded.

This verifies the private policy contract. It does not qualify the complete
capacity envelope, a provider redeployment, ranked play or public release.
Tasks 18.2 through 18.5 remain open. Public documentation has no new behavior
to describe because this pass changed only planning and private evidence.

## Critical-path capacity corrections, 21 October 2026 UTC

The approved initial release keeps ranked play and the first measured large
arena tier. Real proof/recovery, the full first-tier provider workload,
protected player flows and live privacy/spending controls remain required.
Longer calendar, endurance and regional measurements remain unfinished
follow-up work. Tracking is 57 of 71 tasks complete; this checkpoint completes
no additional task.

The once-only local V11 rehearsal failed during registration after all 6,000
preparations. It stopped at registration step 591 under the unchanged
256-request in-flight limit. All offered calls drained, with no missed slots,
unknown replies or provider requests. The registration stall's cause remains
unproved. Its sealed failure and unchanged source are retained in
`chess-launch-20261020-v1/capacity-launch-local-v11`; it is not passing capacity
evidence.

The product transport now cancels unread HTTP error bodies before recording
denials or uncertain failures. Cancellation failure stops the run without a
retry. Two focused transport cases passed. This corrects response ownership;
both earlier passing and failed lanes had the gap, so it does not explain V11.
Evidence is retained in `capacity-transport-cleanup-20261021-v1` beside V11.

The private capacity alarm wrapper now persists a stopped workflow, attempts
alarm deletion and always requests abort with automatic retries disabled,
including uncertain cleanup. It preserves unfinished reservations and permits,
and a scheduled tail rejects before product work. Four focused Game and
Competition cases and Worker types passed. The tests verify the requested
abort policy, not physical eviction or a shutdown receipt. A named two-callback
reserve funds 1,024 reads and three writes per authority. The resulting static
plan reserves 975,758 native requests, 480,917,044 reads and 4,996,908 writes
inside unchanged ceilings. Only 3,092 write rows remain. These are allocation
figures, not observed complete-workload fit or a numerical bound on every
possible at-least-once provider duplicate. Exact counters, patch, source pins
and the first failed fixture attempt are in
`capacity-alarm-failure-20261021-v1`.

These edits belong to the chess product's private qualification adapters and
guides. They add no shared UI contract, dependency or production behavior.
Affected product operational guides were updated in source; publication is
not claimed. No provider capacity resource, live load, proof allocation or
public opening is authorized by these local checks. Keep tasks 18.2 through
18.5 and the ranked and release gates open, with all actual readiness flags
disabled. A separately reviewed draft sealer must also reject a native review
that retains unresolved findings, rather than treating its hash as approval.

## Financial adoption and launch checkpoint, 21 October 2026 UTC

The owner approved the reviewed $25 proof and $45 core shares within the same
$100 monthly target. Base remains $5, security email $5 and accepted work and
recovery $20. The full $25 capacity reservation stays inside core. The policy
names one $5 pretax reserve for unknown proof costs, discloses planning tax
and residual pricing and provider-stop risk, and raises no admission or work
limit. The exact human decision and reviewed references are retained in
`chess-launch-20261020-v1/proof-cost-policy-adoption-20261021-v1`.

The five planning artifacts adopted that financial delta and passed strict
validation. The product adopted the reviewed private eight-file gate patch,
budget reporting and affected guides. Cost review, source-permit review,
owner residual-cost acceptance and later provider qualification remain
separate. Six selected native gate cases and Worker types passed; the first
collection and socket-permission failures remain recorded. Checked-in
execution and adapter flags stay off, reviews pending and runtime identity
null. Evidence and exact source pins are in
`proof-financial-private-gates-adoption-20261021-v1`.

Frontend types, same-host Stockfish asset checks, the normal frontend build,
normal bundle budgets and stricter guide budgets passed. Build output used
a separate temporary directory and preserved the existing localhost output.
The guide and operational documentation changes are source updates, with no
publication claim. No shared UI or harness contract changed.

The two selected driver cases passed for the fixed eight-second preparation
startup window and actual single-egress coverage. The resulting local prefix
v2 acknowledged all 6,000 preparations, then missed its fixed seal time.
Both runtime samplers paused for about 244 seconds. A narrow power-log read
confirmed a clamshell sleep at 13:23:08 UTC and wake at 13:27:13 UTC, matching
the gap. The failed run was disposed, all 676 source hashes remained unchanged
and no provider request ran. This explains that interruption; it does not
resolve the earlier V11 registration stall. Evidence remains in
`capacity-startup-window-20261021-v1`,
`capacity-registration-prefix-20261021-v2` and
`capacity-prefix-host-gap-20261021-v1`.

The reviewed capacity sealer v3 is now integrated. It checks native review
acceptance, permitted unresolved external boundary, exact local identity and
source/controller/envelope/workflow hashes before deriving native flags.
Its retained 23 focused extracted-stage checks passed. The actual integrated
CLI rejected the failed V11 report with
`capacity_seal_full_local_pass_required`, created no candidate and changed no
source. This is negative evidence only. Task 18.3 remains open. See
`capacity-provider-sealer-draft-20261021-v3` and
`capacity-sealer-integration-20261021-v1`.

The owner reported a successful normal sign-in after the expired Access
session was refreshed and confirmed that the Mac is open and ready. The
verified account opened the protected Operations page. All three saved stops
and the deployment-wide stop were visibly active. No stop was cleared.
Tracking remains 57 of 71 tasks complete. Real proof and saved recovery,
the full provider capacity workload, protected player flows and final
release readbacks still gate public opening. No new task is complete here.
### Operations spending labels, 2026-10-21 UTC

The owner questioned the low limits shown on the protected Operations page.
Fresh signed-in browser readback showed the private launch configuration:
zero signup and game caps, two used email attempts out of twenty, and all saved
and deployment stops active. These were not measured capacity for the $100
monthly target.

Task 6.3 now separates the spending target from configured work caps in the
product Operations labels and developer and budget guides. Zero explicitly
disables new work. No quota, budget policy, API or provider setting changed.
Frontend types, a separate frontend/SSG build, normal route budgets and stricter
guide budgets passed. Localhost output was preserved. An initial guide CLI
path was invalid; the package's declared bin passed. This text change is not
published and task 6.3 remains open for its existing qualification requirements.
Evidence: `chess-launch-20261020-v1/operations-cap-labels-20261021-v1`.

### Operations wording publication, 2026-10-21 UTC

The owner explicitly approved publishing the prepared wording and budget guide.
Production version `e78aab7c-f58a-4f78-8293-13213e6dad17` now serves those assets.
Signed-in browser readback confirmed "Spending target and work caps" on the
Operations page, the $100 monthly target, and the explanation that zero closes
new work. The server module, bindings, variables, limits, stops and private
Access protection were preserved. Signup and game caps remain zero, and email
remains two attempts used out of twenty. This publication completes no ranked,
capacity or launch gate. Evidence:
`chess-launch-20261020-v1/operations-cap-labels-publication-results-20261021-v1`.

### Registration correction and proof checkpoint, 2026-10-21 UTC

The product now enables Better Auth 1.7.12's native D1 join for session and
user reads. Admission still checks the current password credential separately,
without cookie caching. The measured authentication path uses two D1
statements and writes no rows. Three focused native cases passed, including
tampered identity, removed credentials and revoked sessions, and Worker types
passed. This is a product auth configuration change, with no shared UI or
harness contract change. The product architecture guide describes it. It has
not been deployed.

The local profiler now accepts valid void inspector acknowledgements and
still requires a valid final CPU profile. A no-load inspector check confirmed
that the earlier failure was in this diagnostic client. The original failed
attempts remain preserved; neither an output-path collision nor the rejected
acknowledgement is passing workload evidence.

The corrected local registration prefix acknowledged all 17,254 operations,
including 6,000 preparations and 11,250 registration steps. It recorded 3,548
accepted steps and 7,702 expected rate-limit replies, with no missed,
saturated, dependency, uncertain or unexpected-denial slots. Registration
response time was 45.21 ms at the 95th percentile and 102.76 ms at the 99th.
All 676 frozen source hashes matched, and the runtime was disposed. Its stop
readback retained one unresolved dispatch. It admitted no Games and ran no
full final audit, so it passes no complete capacity or final-accounting gate.
The sampled local profile does not measure provider CPU. Evidence:
`chess-launch-20261020-v1/capacity-authjoin-profile-local-20261021T155708Z-686c9bba`.

One full local rehearsal on the same immutable source graph started on the
fixed 16:12 UTC schedule and stopped with a failed result at 16:17:15 UTC.
Registration passed, but one early-game batch produced two server errors and
one five-second timeout, retaining three uncertain intents. It acknowledged
24,325 of 24,328 offered operations and observed 217 usable Game bindings.
It ran no regular 900-second stream or final audit. All 676 source hashes
matched, and the runtime exited. It used no diagnostic mode or provider
requests. The failed result remains in
`chess-launch-20261020-v1/capacity-authjoin-full-local-20261021T161200Z-c41b0d93`.
The retained records do not establish the server errors' cause. The next local
diagnostic is restricted to the early-game prefix and bounded fixed codes;
it cannot pass a full capacity gate. No automatic retry is authorized.
The separate frozen provider candidate, current costs and owner load approval
are still required before provisioning or paid load.

The five changed auth, profiler, test and guide files are preserved with
hashes and provenance in
`chess-launch-20261020-v1/authjoin-profiler-source-delivery-20261021-v1`.
The product branch still has no committed HEAD; this source delivery does not
claim a remote repository, push, CI result or server publication.

The native proof candidate failed during its initial lifecycle capture,
before any solver job, corpus case or Game ran. Control is permanently closed.
Provider readback confirmed that all chess proof applications have zero caps,
no active or assigned instances, and no native deployments or instances. The
unrelated application was preserved. Evidence:
`chess-launch-20261020-v1/proof-final-physical-stop-20261021-v1`.
The separately reviewed one-use private constructor diagnostic completed. Its
fixed marker confirmed the expected class, singleton and native container
handle before product wrapping. The original module and native metadata were
restored and read back at version `f2981fed-8caa-40cb-8df2-cfe7dedaa229`.
The app cap, active instances and assigned instances remained zero, with no
native application writes or solver jobs. The proxy was disposed. The consumed
candidate stayed closed. Evidence:
`chess-launch-20261020-v1/proof-native-context-probe-execution-review-20261021-v1`.
This narrows source diagnosis but qualifies no proof case. Tracking remains
57 of 71 complete; ranked and public opening remain gated.

### Early-game diagnostic outcome, 2026-10-21 UTC

The unconsumed 16:36 UTC local schedule was closed without execution. One
separately reviewed diagnostic started on the fixed 16:42 UTC schedule and
stopped during registration at 16:44:57 UTC, before any native Game began.
It reached the unchanged 256-request driver ceiling. All 12,996 dispatched
operations were acknowledged, with no uncertain or pending requests at close.
The runtime was disposed, all 676 frozen source pins matched, and no provider
request or production change ran. The controller readback retained one
unresolved dispatch, so this is not a passing final-accounting result.

The 256 active registration requests drained within 712 milliseconds after
the halt. The driver used little CPU. Retained evidence does not isolate
Competition scheduling, local storage, runtime transport or host contention.
The response's `serverNow` was captured before the awaited scheduling tail;
the later delay is not a measurement taken after native return. The earlier
passing registration profile and this failed prefix share product and
dependency source pins. Their differing local latencies establish no source
fix and no provider capacity claim.

The registration saturation is distinct from the earlier full rehearsal's
two early-game server errors and one timeout. Both failures remain preserved.
Evidence: `chess-launch-20261020-v1/capacity-early-native-diagnostic-review-20261021-v2`.
Task 18.2 remains incomplete. No workload retry, driver concurrency increase,
provider load approval, policy exception or completed launch gate follows
from these observations. This private progress record changes no public
behavior or guide contract.

### Registration timing and stopped proof setup, 2026-10-21 UTC

A scratch-only registration timing candidate adds 16 numeric observations and
preserves the original 256-request cap. Review corrected its local cutoff so
the last scheduled requests retain their 25-millisecond lateness allowance and
five-second drain. JavaScript syntax and the affected server import closure
passed. The first narrow type command omitted the installed Node declarations;
adding them passed without a source or dependency change.

The one authorized 17:26 UTC diagnostic exited during setup, before its fixed
schedule. It produced a bundle and fixture, but no workload trace or report.
All 677 source pins remained unchanged, its owned process group exited, and no
provider request ran. The error bytes were not retained, so this result does
not identify a runtime defect. A separate bounded startup-only check was
authorized to isolate conversion, construction, readiness and disposal without
players, requests, arming or Games. Evidence:
`chess-launch-20261020-v1/capacity-registration-stage-review-20261021-v1`.

The separately authorized stopped proof bootstrap created one new isolated D1
database, `ca440e3d-be86-46dc-9838-e5d79a7324c7`. Its first metadata action
halted on a local append-mode ledger error. One claimed GET is permanently
consumed with unknown read outcome. The successful create is retained and must
not repeat. No migration, Worker upload, proof runtime or native job followed.
A mode-only correction passed real-file reopen, concurrent-claim and unresolved
claim checks. Its proposed reconciled ledger stays halted pending review of a
distinct recovery read. Original evidence and stop markers remain preserved.
Evidence: `chess-launch-20261020-v1/proof-next-attempt-bootstrap-review-20261021-v1/registration-execution`.

Neither observation completes a launch gate or changes the approved limits,
spending target, public access, native-unknown policy or task checkboxes.
Progress remains 57 of 71 tasks. This private factual record changes no public
behavior or guide contract.

The ensuing startup-only check isolated a loopback-listener `EPERM` under the
local sandbox. Conversion and construction passed; normal disposal did not,
but the owned process group exited. Offline comparison also resolved the
freeze mismatch: 618 symlink-resolved dependency paths changed their spelling,
while all 677 file hashes matched. The next freeze used the actual bundler map.

With local-listener permission and that exact map, one 17:37 UTC registration
diagnostic completed at 17:40:06 UTC. All 16,004 scheduled operations were
acknowledged; 7,704 expected denials occurred. It had no missed, saturated,
uncertain, pending or unexpected-denial result. Peak concurrency was 71 of
256. All 16 numeric timing rows were captured. Stop acknowledgement, runtime
disposal, owned-group exit and all 677 source pins were confirmed. No provider
request or native Game ran. Evidence:
`chess-launch-20261020-v1/capacity-registration-stage-review-20261021-v1/local-loopback-execution-v2`.
This registration-only result does not reproduce the prior slowdown, resolve
the separate early-game errors, or pass task 18.2 or provider qualification.

The distinct proof-database recovery read completed once. It confirmed the
expected identity and 12,288-byte file. GET1 remains consumed with unknown
outcome; GET2 was received, leaving 62 of the original 64 metadata reads. The
recovery ledger remains halted, with all original evidence and stops intact.
No migration, upload, proof runtime or native job is implied by that readback.
Evidence: `chess-launch-20261020-v1/proof-next-attempt-bootstrap-review-20261021-v1/registration-execution/ledger-append-correction-review-20261021-v1/recovery-execution/result.json`.

After a separate exact root review, the seven remaining stopped-bootstrap
commands completed at 17:51:22 UTC. Fifteen pinned migrations produced the
expected 51-table schema, and all nine product-table counts were zero. Four
private stopped Workers and five fresh SQLite namespaces were verified, with
zero objects and no new routes, domains or Container applications. The fixed
52 metadata reads brought the shared ledger to 54 of 64 consumed GETs. Both
inherited claims and all prior halt evidence remain unchanged. No runtime,
native solver, account or capacity workload ran. Evidence:
`chess-launch-20261020-v1/proof-next-attempt-bootstrap-review-20261021-v1/registration-continuation-review-20261021-v1/final-metadata-readback.json`.
This completes stopped registration only. Proof attachment, real proof and
settlement qualification, the unknown-result policy decision and public
opening remain incomplete. Task checkboxes and public behavior are unchanged;
this factual operations record has no public docs impact.

The separately reviewed 17:59 UTC early-native diagnostic stopped at
18:02:01.793 UTC during registration. It offered and acknowledged 13,895
operations, including 6,131 expected denials, and reached the unchanged
256-request limit once. No native Game started. There were no missed slots,
uncertain replies, dependency failures or unexpected denials. Normal stop,
runtime disposal, owned-process-group exit and all 676 source pins were
confirmed. No provider request ran. Evidence:
`chess-launch-20261020-v1/capacity-early-native-boundary-review-20261021-v1`.
The final controller counters include conservative prepaid allowances and
must not be described as measured provider usage. This failed diagnostic
does not resolve the earlier Game errors, qualify capacity or authorize a
retry, larger concurrency limit or provider workload. Task 18.2 remains
unchecked. This private factual record has no public docs impact.

The separately reviewed 18:26 UTC registration timestamp diagnostic finished
at 18:29:02.592 UTC. It offered and acknowledged 13,468 operations, including
5,847 expected denials, and reached the unchanged 256-request limit once.
There were no missed slots, uncertain replies, dependency failures,
unexpected denials or requests pending at close. The registration prefix did
not finish. It stopped before all 16 fixed sample indices, so it captured zero
timestamp rows, with zero invalid rows. Its `diagnosticCompleted` field records
the observed stop and cleanup, not a passing schedule or useful stage timings.

Stop acknowledgement, runtime disposal, owned-process-group exit and all 677
source pins were confirmed. No native Game or provider request ran. Evidence:
`chess-launch-20261020-v1/capacity-registration-timestamps-review-20261021-v1`.
The final controller counters retain conservative prepaid allowances and are
not measured provider usage. The failed prefix identifies no source fix and
does not resolve the separate early-game errors or qualify capacity. Offline
analysis must precede another experiment. Task 18.2 remains unchecked; no cap,
policy, public behavior or launch gate changed. This private factual record
has no public docs impact.

The separately reviewed 18:48 UTC stride diagnostic finished at 18:51:06.168
UTC. It preserved the original 16,004 operations and request limits. All
operations were acknowledged, including 7,706 expected denials. It had no
saturation, missed slots, uncertain replies, dependency failures, unexpected
denials or pending requests at close. Peak concurrency was 113 of 256. All
157 sampled headers were valid; the collector retained the latest 16 numeric
rows with no missing fields, duplicates or invalid observations. The prefix
and timing capture completed. Stop acknowledgement, runtime disposal,
owned-process-group exit and all 677 source pins were confirmed. No native
Game or provider request ran. Evidence:
`chess-launch-20261020-v1/capacity-registration-stride-review-20261021-v1`.

This passing registration prefix did not reproduce the variable stall and
establishes no source fix. It does not resolve the earlier Game failures,
complete the full workload or qualify task 18.2 or provider capacity. The
qualification and public-access gates remain closed. Controller allowance
counters are not measured provider usage. This private factual record changes
no public behavior or guide contract.


## 2026-10-22: simplify spending controls

The owner explicitly replaced repeated cost optimization with one $100 monthly
target and practical adjustable caps. The current decision in proposal/design
and both affected specs supersedes older mandatory dollar allocations and
repeated financial reviews. Correctness and provider qualification remain open.

Deployed version `bc95b733-1f09-4823-8fd5-8fc28dcfac4a` raised monthly signup and
game caps to 10,000 each, email to 5,000 and lifetime signup attempts to 100,000.
The deployment stop is false. The normal owner Operations form saved account/
game and email stops false; browser readback showed all three Available.
Analysis remains stopped. The three $45/$70/$85 usage policies were read back
as enabled. The existing server bundle hash was unchanged. No public Access
policy or ranked/tournament feature gate was changed. Billing remains delayed
and account-wide, so the target is not a guaranteed invoice cap.

Evidence: `chess-launch-20261020-v1/simple-budget-20261022-v1`.
OpenSpec strict validation and the normal frontend/guide build passed. No load
test or chess regression rerun was needed for these settings and guide edits.
No outstanding qualification task is marked complete by this change.

The generated developer guide was published and read back on the canonical
host in version `592cb559-a9ad-4072-a6e5-c5a17ed34edf`. Its current policy,
cleared stops and removed per-service allocation gates match this decision.
Other route HTML and the server bundle were preserved. The owner Operations
confirmation is retained as `simple-budget-20261022-v1/live-caps.png`.
