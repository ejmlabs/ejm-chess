# Live-ready prep and go-live

Updated 2026-10-31. This file orders the work to open public ranked play,
arenas and tournaments (OpenSpec **7.2**). It authorizes nothing and checks no
task. The owner runs every provider step on their own machine with private
configs. Record each result, the deployed revision and every unrun check in
[verification](verification.md).

## Owner decision, 2026-10-31

- No arbitrary product caps. Cloudflare budget alerts and the existing `$85`
  stop webhook are the economic limit, not a hard invoice cap; alerts can lag.
  Security and abuse limits, input bounds, bounded work per request and alarm,
  fair-play rules (including 2 ranked games per pair per 24 hours), platform
  safety bounds, ID non-recycling and the explicit stops stay.
- The 2,000-player capacity harness is deleted, so no load run gates ranked
  play or arenas. Measure demand after opening; if it ever needs checking, write
  a small staging load script then.
- Server-side Stockfish analysis is deleted. Reports stay informational with no
  engine screening. Browser Stockfish practice stays.
- The restore-and-replay provider drill is follow-up only, not a gate. Its code
  stays.
- Ranked uses the material timeout rule, the same as casual. The private
  timeout-proof path is retired: no proof Container, qualification, proof
  limits or `PROVER` binding. Ranked opens with `RANKED_ENABLED=true`.

## Critical path

1. Publish the shared UI contracts (**1.5**)
2. Build
3. Deploy to the protected canary with ranked, arenas and tournaments on
4. Canary player checklist (**3.6**, **7.1**)
5. Live mail, alert, cron and stop readbacks (**6.2**, **6.3**)
6. Remove full-host Access, keep admin protection (**7.2**)
7. Public verification (**7.2**, **4.5**)
8. Discovery (**7.3**)

Not on the path, report as unrun: the restore-and-replay provider drill, the
regional and endurance measurements (**6.4**, **10.4**). The drill's
configuration is in [config examples](../config-examples/README.md).

## Prep status

| Area | OpenSpec | Still needs live |
| --- | --- | --- |
| Shared UI contracts | **1.3**, **1.5** checked; `useSearch` unpublished | Publish (step 1) |
| Ranked, privacy and ops docs | **4.5**, **6.2**, **6.3** checked | Two-session verify (step 4); mail, alert, cron, stop readback (step 5) |
| ejm-ui discovery draft | **7.3a** checked (`discoverable: false`) | Enable and Studio publish (step 8) |
| Player checklist, ranked, arena and tournament open | **3.6**, **7.1** open; **7.2** waits on them and on step 5 | Steps 3 to 7 |

## Provisioning checklist (6.2)

| Check | Offline note | Live verify later |
| --- | --- | --- |
| Workers Paid on chess account | Historical inventory recorded Paid subscription | Confirm current plan and permissions |
| Email Sending + DNS for `chess@ejmlabs.com` | Documented in deployment guide; approved-recipient test 2026-10-21 | Re-check DNS/signing/bounce and a live verification mail |
| Turnstile on `chess.ejmlabs.com` | Bound in production `wrangler.jsonc` | Challenge success on canary session |
| Access full-host + admin policy | Canary remains Access-protected | Owner session still required |
| Budget alerts + `$85` stop webhook | Policy docs; application monthly caps off | Inbox delivery of an alert still unverified; not a hard cap |
| Canary deploy scope | Worker `6aa3ef0c…` includes Join + material timeout | Release readback (step 3) |
| Cost estimate vs $100 target | See [cost estimate](cost-estimate.md) and [budget](cloudflare-budget.md) | Update from current invoice and alerts (step 5) |

## Production values

Names and values only. They live in the private production `wrangler.jsonc`
`vars`; unset means the code default. All other variables stay as deployed.

| Variable | Value | Set at |
| --- | --- | --- |
| `RANKED_ENABLED` | `true` | step 3 |
| `ARENAS_ENABLED` | `true` | step 3 |
| `TOURNAMENTS_ENABLED` | `true` | step 3 |
| `AI_ENABLED` | `true` | canary build |
| `NEW_WORK_STOPPED` | `false` | canary build |
| `OPERATION_MODE` | `unattended` | canary build |
| `GAME_RETIREMENT_MODE` | `scaled` | canary build |
| `ARENA_*`, `CASUAL_*`, `RANKED_*` limits | unset (no product caps) | none |

- `RANKED_ENABLED` alone opens ranked, and `/api/config` reports `ranked` from
  it. No proof setting or `PROVER` binding exists. Delete `TIMEOUT_PROOF_PROFILE`,
  `MONTHLY_PROOF_LIMIT`, any `ANALYSIS_*` or `ANALYZER` setting, and any
  `MONTHLY_*` or `SIGNUP_ATTEMPT_LIMIT` setting from the private config if still
  present.
- `TOURNAMENTS_ENABLED` can open now. The fixed round-robin limits (3 active
  events, 256 event records, 128 retained payloads, 10,000 game IDs) are
  removed, so shared arena games no longer close the preview.
- Leave every product limit variable unset. A `0` or malformed value can close
  a mode; see [operations](operations.md#configuration-contract).
  `NEW_WORK_STOPPED` stops new work for any value except unset or exact `false`.
- `wrangler deploy` replaces dashboard vars with the config's vars, so the
  private config must hold the full set.
- The assets block needs `"not_found_handling": "404-page"` with
  `run_worker_first: true`, so unknown pages get the built not-found page; see
  [deployment](deployment.md#prepare-configuration-and-build).

## Stop levers

| Need | Lever |
| --- | --- |
| All new work now | Operations stop form, `gamesStopped` (also blocks signup). With D1 or Access down, deploy `NEW_WORK_STOPPED=true`. |
| Ranked only | Deploy `RANKED_ENABLED=false`. Queueing and pairing close, a queued player is dropped, a match still being created is cancelled and its seats released, and a created game not yet started voids at its first Ready (`eligibility-revoked`: no winner, no rating change). Started games finish and settle. Leaderboard projections are unchanged: the stored flag holds only the rating standard, and readers check account age, activity and restrictions at read time. |
| Arenas only | Deploy `ARENAS_ENABLED=false`. Unstarted events cancel; running events drain. |
| Tournaments only | Deploy `TOURNAMENTS_ENABLED=false`. Unstarted events cancel; running events finish. |
| The host | Recreate the full-host Access application from its saved settings (after step 6). |
| Code | `npx wrangler rollback "$CHESS_ROLLBACK_VERSION" --env ''` to a version compatible with the saved rules versions and settlement. See [rollback](deployment.md#rollback-and-recovery). |

## Sequence

Run from the product root with Node 24. `--env ''` selects the production
config. Read-only commands come first in each block. A failed step stops the
sequence. Keep its receipts.

### 1. Publish the ejm-ui chess contracts (1.5)

`useSearch` from `@ejm/ssg` (used by `src/pages/Play.tsx`) is in no pushed
ejm-ui branch. Remote `codex/chess-public-contracts` has every other chess
contract. The owner's local `wip/preserve-all-20261025` must be pushed and
published before any release build.

```sh
cd ../ejm-ui
git status --short && git branch --show-current
git grep -n useSearch -- packages/ssg/src
git fetch origin && git log --oneline origin/main..HEAD && git branch -r --contains HEAD
# change
git push origin wip/preserve-all-20261025        # then PR, review, merge to main
git switch main && git pull --ff-only && git rev-parse HEAD
npm ci && npm run build
```

**Pass:** ejm-ui is clean at a commit on `origin/main`; its SHA is recorded.
**Stop:** unpushed or dirty shared source. Nothing is deployed yet.

### 2. Build

```sh
cd ../ejm-chess
npm ci && npm run typecheck && npm test && npm run build && npm run worker:check && npm run budget
```

**Pass:** every command passes with no `useSearch` or `Chessboard` type error;
the chess SHA is recorded. **Stop:** any failure.

### 3. Deploy to the protected canary (7.2)

Set the production values table in the private `wrangler.jsonc`. Diff it
against the last deployed copy; only the three flags and the removed proof,
analysis and monthly variables may change. Access still
limits the host to canary identities and the games stop stays clear.

```sh
npx wrangler d1 migrations list DB --remote --env ''
npx wrangler deploy --env '' --strict --message "Launch values on the protected canary"
npx wrangler versions view "$CHESS_DEPLOYED_VERSION" --env '' --json
```

Apply any pending migration first, as in the [deployment guide](deployment.md).
This revision adds `0016_cron_heartbeats.sql`. Operations status reads its
table and the minute run trims seats by its index, so apply it before this
deploy; without it the scheduled handler only logs `heartbeat_failed`.
Open `/api/config`, `/api/arenas`, `/api/tournaments` and
`/api/admin/operations` in the owner browser.

**Pass:** `/api/config` shows `ranked`, `ai` and `tournaments` true; arenas and
tournaments `enabled` true; `authority.rankedOpen` true; `retirement.mode`
`scaled`; each unset product limit reads `9007199254740991` and
`authorityBytes` `4294967296`; `budget.stoppedByEnv` false; provider readback confirms `workers_dev` and `preview_urls` false and
both cron triggers. **Stop:** any other value. Fix and redeploy, or roll back.

### 4. Canary player checklist (3.6, 7.1)

Use two distinct people on separate browsers and at least three
credential-backed accounts. A pair may start only two ranked games per rolling
24 hours (`pairAllowed`), so plan about six ranked games. Record each row as
pass, fail or unrun with the deployed version.

- Accounts: signup with and without recovery email, signin, invitation, legacy
  guest reconnect. Reuse the 2026-10-21 mail evidence unless mail code changed.
- Board (**3.6**): touch, drag, click, keyboard, promotion and underpromotion,
  cancellable premove, focus, phone layout, muted sound, reduced motion.
- Ranked: a mate or resignation; a flag with mating material (loss for the
  player who ran out, at the flag); an insufficient-material flag (draw); a flag
  with both browsers closed for 60 seconds, then reopened. Then reconnect,
  history, replay, PGN, report receipt.
- Profile and leaderboard (**4.5**): a provisional rating shows. The leaderboard
  stays truthfully empty: a row needs 20 games, 8 opponents, a 7-day account and
  RD at most 100.
- Arena: register, queue, play, pause, resume, standings, result. Entry opens 15
  minutes before an event (hourly blitz, daily and weekly rapid).
- Round-robin: three accounts register for one event; read rounds, points and
  standings.
- Browser Stockfish game; unattended recovery (close both browsers through a
  flag, reopen); canonical HTTPS, static and API headers, same-origin cookies,
  WebSocket admission.

```sh
npx wrangler d1 execute DB --remote --env '' --command "SELECT id,status,settlement,reason,ended_at FROM games WHERE rated=1 ORDER BY ended_at DESC LIMIT 10"
```

**Pass:** every row recorded; every rated game is `finished` and `settled` with
the expected reason; Operations export kinds `results` and `ratings` hold one
result and one rating event per game; `authority.unsettled`, `outbox` and
`pendingResults` are 0 and `lastMaintenanceError` is null. **Stop:** a failed board, settlement, arena
or round-robin row, or a repeated rating event. Use the matching lever, fix,
retest.

### 5. Live mail, alert, cron and stop readbacks (6.2, 6.3)

```sh
npx wrangler secret list --env ''
npx wrangler d1 time-travel info DB --env '' --json
```

- Secrets: `secret list` shows the four canary secret names. Add none.
- Mail: a real-email account receives verification and recovery mail in the
  approved inbox; the sending domain's DNS, signing and bounce records still
  read back as verified; Operations shows the email stop clear.
- Alerts: send Test from each saved usage policy to the approved inbox. Send the
  webhook Save/Test: it sets every stop. Clear them in the owner form
  with the latest `expectedVersion`. Compare account usage with the $100
  envelope and update the [cost estimate](cost-estimate.md). Alerts and the
  webhook are the economic limit; they are not a hard invoice cap.
- Cron: read the stored heartbeat in `/api/admin/operations` (`cron.minute` and
  `cron.daily`, from D1 `cron_heartbeats`, migration `0016`). The minute
  schedule passes when `finishedAt` is within the last three minutes, is not
  older than `startedAt`, and `lastErrorAt` is null or older than `startedAt`.
  Read it twice a few minutes apart: `startedAt` must advance. The daily
  schedule needs a wait past 03:15 UTC and then the same check. A `lastError`
  names the failed stage; see [operations](operations.md#cron-heartbeat).
- Stops: set `gamesStopped`; a new signup and a new queue join are refused and a
  running game still moves; clear it. Read `outboxLagMs`, `outboxFailures`,
  `correctionLagMs` and `lastMaintenanceError`. The `NEW_WORK_STOPPED` deploy
  path stays unexercised; record it.
- Recovery without restore: `POST /api/admin/operations/recovery/competition`
  with `{}` returns a bookmark and Time Travel info reads. A response with
  `"complete": false` is one page of a larger Competition: repeat with its
  `cursor` until the response has a `bookmark`. Export and close one throwaway
  account with its password. Production restore stays unrun.
- Public read protection: create the zone rate-limiting rule for `/api/players/`,
  `/api/leaderboard`, `/api/tournaments` and `/api/arenas` described in
  [operations](operations.md#public-read-cache), with a threshold you choose.
  The 10-second edge cache covers repeat reads only. Record the rule, or record
  that it was skipped, before step 6 removes full-host Access.

**Pass:** each bullet recorded. **Stop:** an alert, webhook or cron failure.
Do not remove Access until it is fixed and reread.

### 6. Remove full-host Access, keep owner protection (7.2)

Proceed only after steps 1 to 5 pass and the owner says go.

```sh
curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" | jq '.result[] | {name, domain, destinations}'
curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$CHESS_CANARY_ACCESS_APP_ID" > "$CHESS_PRIVATE_DIR/canary-access-app.json"
# change: delete only the full-host application
curl -sS -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$CHESS_CANARY_ACCESS_APP_ID"
curl -sS -o /dev/null -w '%{http_code}\n' https://chess.ejmlabs.com/
curl -sS -o /dev/null -w '%{http_code}\n' https://chess.ejmlabs.com/admin/
curl -sS -o /dev/null -w '%{http_code}\n' https://chess.ejmlabs.com/api/admin/operations
```

The separate owner application keeps `/admin`, `/admin/*`, `/api/admin` and
`/api/admin/*`, and its audience must equal `CF_ACCESS_AUD`. Save its settings
and policies privately too. Keep the budget-stop path exception and its
bot-filter skip.

**Pass:** `/` returns 200; `/admin/` and `/api/admin/operations` are denied by
Cloudflare Access (a login redirect or 403, not an application JSON body); the
owner browser still opens Operations. **Stop:** if `/admin/` or the admin API
answers without Access, close new work with the stop levers, then restore the
full-host application from its saved settings.

### 7. Public host and guide verification (7.2, 4.5)

```sh
for p in / /help/ /rules/ /fair-play/ /privacy/ /docs/developer-guide/ /credits/ /leaderboard/ /tournaments/; do curl -sS -o /dev/null -w "%{http_code} $p\n" "https://chess.ejmlabs.com$p"; done
curl -sS https://chess.ejmlabs.com/api/config
curl -sS https://chess.ejmlabs.com/api/arenas
curl -sSI https://chess.ejmlabs.com/ | grep -iE 'content-security|strict-transport|x-content-type|x-frame|referrer|permissions'
curl -sS -X POST -o /dev/null -w '%{http_code}\n' https://chess.ejmlabs.com/api/operations/budget-stop
curl -sS -w '\n%{http_code}\n' https://chess.ejmlabs.com/no-such-page/ | grep -E 'Page not found|^404$'
```

From a non-canary network, sign up a fresh account, sign in and start a game.
Guides must state that ranked, arenas and tournaments are open, the material
timeout rule, no product limits beyond fair-play rules, and that behavior
under heavy load is still being measured. Watch the first hour:
`retirement.pending` and `oldestDue`, `outboxLagMs`, arena `unresolvedGames`,
and spend against the alerts.

**Pass:** every route 200; `/api/config` matches step 3; the budget-stop POST
returns 403 (404 means its secret is missing or malformed); an unknown page
returns 404 with the "Page not found" page; headers present;
Turnstile, signup, signin and a game work publicly; guides match. **Stop:** use
the stop levers, then fix.

### 8. Discovery (7.3)

After step 7 passes. In ejm-ui set `PROJECTS.chess.discoverable` true in
`packages/site/src/projects.mjs`, replace its tagline (it says ranked and public
release are not available), update `projects.test.ts`, run `npm run check` and
release through its `RELEASING.md`. Its guide links are `/help/` and
`/docs/developer-guide/`. In `ejmlabs`, update the Projects row, Play action,
shared-registry adoption and guide links, run its build, type, budget and link
checks, and publish through its owner process. Verify current products, guide
links, marks and downloads.

**Pass:** the shared lists and Studio show chess with working links and other
products unchanged. **Stop:** revert the registry change; chess stays open.
