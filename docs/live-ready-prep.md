# Live-ready prep and Level 2 go-live

Updated 2026-10-31. The owner chose Level 2: open public ranked play and
first-tier arenas (OpenSpec **7.2**), critical path only. This file orders the
work. It authorizes nothing and checks no task. The owner runs every provider
step on their own machine with private configs. Record each result, the
deployed revision and every unrun check in [verification](verification.md).

## Critical path reminder

1. Shared UI published (**1.5**), specialty configs rebuilt, proof qualified (**3.9**)
2. Private prover bound; real ranked proof, settlement and recovery checked (**3.9**, **7.2**)
3. First-tier provider run: diagnostic, full run, reconciliation (**18.3** to **18.5**)
4. Protected-host player flows and live readbacks (**3.6**, **7.1**, **6.2**, **6.3**)
5. Open: production values, Access removal, public verification (**7.2**)
6. Discovery (**7.3**)

Not on the path: **6.4**, **10.4**, the nine-day calendar, full-hour endurance,
regional runs and the later tier. Report them unrun.

## Prep status

| Area | OpenSpec | Still needs live |
| --- | --- | --- |
| Shared UI contracts | **1.3**, **1.5** checked; `useSearch` unpublished | Publish (step 1) |
| Specialty Wrangler templates | `config-examples/*.example.jsonc` (**3.8**) | Private fill-in (step 2); prover container entry (step 4) |
| Timeout-proof source and status JSON | **3.8** checked; default-off | Acceptance re-run and tier pin (step 3, **3.9**); sealed acceptance entry absent from source |
| Ranked, privacy and ops docs | **4.5**, **6.2**, **6.3** checked | Two-session verify (steps 5, 7); mail, alert, cron, stop readback (step 8) |
| First-tier capacity | **18.1**, **18.2** checked; every seal gate closed in source | Repaired sealed candidate, diagnostic, full run (step 6) |
| ejm-ui discovery draft | **7.3a** checked (`discoverable: false`) | Enable and Studio publish (step 12) |
| Player checklist, ranked and arena open | **3.6**, **7.1** open; **7.2** waits on **3.9**, real ranked proof, the first-tier run and **7.1** | Steps 5 to 11 |

## Provisioning checklist (6.2)

| Check | Offline note | Live verify later |
| --- | --- | --- |
| Workers Paid on chess account | Historical inventory recorded Paid subscription | Confirm current plan and permissions |
| Email Sending + DNS for `chess@ejmlabs.com` | Documented in deployment guide; approved-recipient test 2026-10-21 | Re-check DNS/signing/bounce and a live verification mail |
| Turnstile on `chess.ejmlabs.com` | Bound in production `wrangler.jsonc` | Challenge success on canary session |
| Access full-host + admin policy | Canary remains Access-protected | Owner session still required |
| Budget alerts + `$85` stop webhook | Policy docs; application monthly caps off | Inbox delivery of an alert still unverified |
| Canary deploy scope | Worker `6aa3ef0c…` includes Join + material timeout | Release readback (step 9) |
| Analysis cold-start costs | Analysis stays disabled | Measure only if analysis is approved |
| Cost estimate vs $100 target | See [cost estimate](cost-estimate.md) and [budget](cloudflare-budget.md) | Update from current invoice and alerts (step 8) |

## Level 2 production values

Names and values only. They live in the private production `wrangler.jsonc`
`vars`; unset means the code default. All other variables stay as deployed.

| Variable | Level 2 value | Set at |
| --- | --- | --- |
| `RANKED_ENABLED` | `true` | step 5 |
| `TIMEOUT_PROOF_PROFILE` | `cha-native-3484c7e6-v1` | step 5 |
| `MONTHLY_PROOF_LIMIT` | `1000` | step 5 |
| `ARENAS_ENABLED` | `true` | step 7 |
| `AI_ENABLED` | `true` | canary build |
| `NEW_WORK_STOPPED` | `false` | canary build |
| `OPERATION_MODE` | `unattended` | canary build |
| `GAME_RETIREMENT_MODE` | `scaled` | canary build |
| `ANALYSIS_ENABLED` | `false` | canary build |
| `TOURNAMENTS_ENABLED` | `false` | canary build |
| `ARENA_*`, `RANKED_*_LIMIT`, `CASUAL_*` | unset (no product caps, 2026-10-30 policy) | none |

- Step 4 adds one binding, not a variable: `PROVER`, class `TimeoutProver`,
  `script_name` `ejm-chess-timeout-proofs`. The public Worker needs no Durable
  Object migration for it.
- Set the three ranked rows together. `/api/config` reports `ranked` from
  `RANKED_ENABLED` alone, so one flag would show a queue the server refuses.
- Typos: `MONTHLY_PROOF_LIMIT` outside 1 to 1000 closes ranked. `0` or a
  malformed `ARENA_*` or `CASUAL_*` value closes that mode. A malformed
  `RANKED_*_LIMIT` silently removes its cap. `NEW_WORK_STOPPED` stops new work
  for any value except unset or exact `false`.
- Ranked ends for good after 1,000 admitted games: proof receipts are permanent
  (`PROOF_RETAINED_LIMIT`, migration `0013`) and each canary game spends one.
  Raising it is a reviewed source change.
- `TOURNAMENTS_ENABLED` stays `false`: round-robin and arenas share one D1 game
  ledger, and the preview keeps fixed limits of 128 retained payloads and 10,000
  IDs (`TOURNAMENT_LIMITS`). Arena games would close the preview. Record its
  **7.1** rounds as unrun unless the owner decides otherwise.
- `wrangler deploy` replaces dashboard vars with the config's vars, so the
  private config must hold the full set.

## Stop levers

| Need | Lever |
| --- | --- |
| All new work now | Operations stop form, `gamesStopped` (also blocks signup). With D1 or Access down, deploy `NEW_WORK_STOPPED=true`. |
| Ranked only | Deploy `MONTHLY_PROOF_LIMIT=0` and keep `PROVER`. Accepted games settle. Not `RANKED_ENABLED=false`: it voids ready games and marks new leaderboard rows ineligible. |
| Arenas only | Deploy `ARENAS_ENABLED=false`. Unstarted events cancel; running events drain. |
| The host | Recreate the full-host Access application from its saved settings (after step 10). |
| Code | `npx wrangler rollback "$CHESS_ROLLBACK_VERSION" --env ''` to a version that still binds `PROVER` once ranked games exist. See [rollback](deployment.md#rollback-and-recovery). |

## Sequence

Run from the product root with Node 24. `--env ''` selects the production
config. Read-only commands come first in each block. A failed step stops the
sequence. Keep its receipts and never rearm a consumed identity.

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
cd ../ejm-chess
npm ci && npm run typecheck && npm test && npm run build && npm run worker:check && npm run budget
```

**Pass:** ejm-ui is clean at a commit on `origin/main`; the chess commands pass
with no `useSearch` or `Chessboard` type error; both SHAs are recorded.
**Stop:** unpushed or dirty shared source. Nothing is deployed yet.

### 2. Reconstruct the specialty configs (3.9 prerequisite)

```sh
git check-ignore -v wrangler.capacity.jsonc wrangler.proof-service.jsonc wrangler.proof-qualification.jsonc wrangler.proof-acceptance.jsonc wrangler.recovery-drill.jsonc
# change: the five cp commands in config-examples/README.md, then fill private IDs
cmp config-examples/wrangler.capacity.example.jsonc wrangler.capacity.jsonc
npx vitest run --config vitest.recovery-drill.config.ts
npx wrangler deploy --config wrangler.recovery-drill.jsonc --dry-run --outdir /private/tmp/chess-dry-recovery
```

- Account, D1 and namespace IDs come from the private inventory. Every
  specialty resource is fresh and distinct from production and from each other.
- Keep `wrangler.capacity.jsonc` identical to its example. The sealer rejects
  any difference and takes IDs from its private review packet.
- Add the private var `PRODUCTION_RESOURCE_IDS` (production D1, Game and
  Competition IDs) to the recovery-drill, proof-qualification and sealed
  proof-acceptance configs. The proof-qualification example omits it, and
  without it `assertProofQualification` refuses every run.
- Leave every feature var off. The proof-service `containers` entry waits for step 4.

**Pass:** all five files are Git-ignored and untracked; the capacity file is
identical; the recovery test and dry run pass; no ID repeats across files or
production. **Stop:** any production ID in a specialty config.

### 3. Proof acceptance re-run and provider qualification (3.9)

Methods, limits and command order are in [timeout proofs](timeout-proofs.md)
("Further acceptance controller", "Private four-authority restore preparation").

```sh
node scripts/rehearse-proof-local.mjs --describe
node scripts/restore-proof-acceptance.mjs --describe
npx vitest run proof
# change: provider run through ProofAcceptanceCaller, then the restore drill, per the guide
npx wrangler containers list
npx wrangler containers instances "$CHESS_ACCEPTANCE_APP_ID"
```

- Source gap: sealed execution is unavailable. `proof/acceptance-manifest.json`
  has `executionAvailable: false` and a null `sealedRuntimeIdentity`, so
  `proofAcceptanceExecutionAvailable()` is false. A reviewed compiled seal is a
  source change, not config.
- The retained 2026-10-21 Basic corpus (27 fixtures, 4 cold requests, same
  image) is reused. The re-run covers Game and Competition settlement against
  the material-timeout fallback (G00 to G11), Prover recovery and physical
  shutdown. Lite first; Basic only after a lite resource failure and confirmed
  lite stop.

**Pass:** C00 to C26 and G00 to G11 pass; stop confirmed; no running instance;
restore review passes; tier and image digest recorded in a new dated report
beside `qualification/provider-proof-20261021.md`. **Stop:** a failed or
incomplete case, `proof_acceptance_work_exhausted`, or an unconfirmed stop.
Ranked stays closed and a new sealed identity is required.

### 4. Deploy and bind the private prover (3.9, 7.2)

Private `wrangler.proof-service.jsonc` gets the container for the passed tier.
Production runs the exact qualified image, so use its registry reference, not a
Dockerfile path:

```jsonc
"containers": [{ "class_name": "TimeoutProver", "image": "<qualified image ref>", "max_instances": 1, "instance_type": "<tier pinned by 3.9>" }]
```

Private `wrangler.jsonc` gets this in `durable_objects.bindings`. Add the new
prover namespace ID to `PRODUCTION_RESOURCE_IDS` in the specialty configs.

```jsonc
{ "name": "PROVER", "class_name": "TimeoutProver", "script_name": "ejm-chess-timeout-proofs" }
```

```sh
npx wrangler d1 migrations list DB --remote --env ''
npx wrangler containers images list
npx wrangler deploy --config wrangler.proof-service.jsonc --dry-run --outdir /private/tmp/chess-proof-service-dry
# change: service first, since a binding to a missing script fails the public deploy
npx wrangler deploy --config wrangler.proof-service.jsonc --strict --message "Private timeout prover"
npx wrangler deployments list --config wrangler.proof-service.jsonc --json
npx wrangler containers instances "$CHESS_PROVER_APP_ID"
npm run worker:check
npx wrangler deploy --env '' --strict --message "Bind private timeout prover"
npx wrangler versions view "$CHESS_DEPLOYED_VERSION" --env '' --json
```

Diff the private `wrangler.jsonc` against the last deployed copy. Only the
`PROVER` binding may differ. Flags stay as deployed.

**Pass:** no pending D1 migration; the service has no route, `workers_dev` and
`preview_urls` false, `max_instances` 1, and the 3.9 tier and image digest; its
namespace ID differs from every acceptance and qualification ID and its D1 is
production; the public version shows `PROVER` bound to that script; Operations
(`/api/admin/operations` in the owner browser) shows `authority.rankedOpen` false.
**Stop:** any other difference. Roll the public Worker back (no reserved games
exist yet). After step 5 never remove the binding, the service or its namespace.

### 5. Real ranked proof, settlement and recovery check (3.9, 7.2)

Set the three ranked rows and deploy with
`npx wrangler deploy --env '' --strict --message "Protected ranked enablement"`.
Access still limits the host to canary identities, and the games stop stays
clear. Use at least three credential-backed accounts: one pair may start only two ranked games per rolling
24 hours (`pairAllowed`). Plan about six games.

Play a mate or resignation; a flag with mating material (`timeout-proof-win`
within 30 seconds of the flag); an insufficient-material flag (immediate draw);
and a flag with both browsers closed for 60 seconds, then reopened. The
blocked-wall `timeout-proof-draw` and the unknown-result fallback count as
covered only by the step 3 corpus unless reached by hand.

```sh
npx wrangler d1 execute DB --remote --env '' --command "SELECT id,status,settlement,reason,ended_at FROM games WHERE rated=1 ORDER BY ended_at DESC LIMIT 10"
npx wrangler d1 execute DB --remote --env '' --command "SELECT COUNT(*) AS admitted FROM timeout_proof_admissions"
npx wrangler containers instances "$CHESS_PROVER_APP_ID"
```

**Pass:** every rated game is `finished` and `settled` with the expected reason;
timeouts resolve within the flag plus 30 seconds; Operations export kinds
`results` and `ratings` hold one result and one rating event per game;
`admitted` equals games played; `authority.timeoutProof.reserved`, `unsettled`,
`outbox` and `pendingResults` are 0; `lastMaintenanceError` is null; no prover
instance runs 60 seconds after the last proof. **Stop:** a result pending past
the flag plus 90 seconds, a repeated rating event, or an instance running after
5 minutes. Deploy `MONTHLY_PROOF_LIMIT=0`, stop the instance in the provider
dashboard, record the debt, and keep the binding.

### 6. First-tier provider run (18.3, 18.4, 18.5)

Methods, schedule, ledger and sealing review are in
[capacity qualification](capacity-qualification.md) ("Short registration
diagnostic", "Sealing and provider approval") and
[local rehearsal](capacity-local-rehearsal.md). Today every seal gate
(`SEALED_CAPACITY_MANIFEST`, `VERIFIED_*`, `CAPACITY_PROTOCOL_READY`,
`CAPACITY_DRIVER_EXECUTION_READY`) is closed in source and `--describe` lists
the blockers. A reviewed repaired candidate is a source change first.

```sh
node scripts/capacity-driver.mjs --describe
node scripts/qualify-capacity-safety.mjs --execute --output /private/tmp/chess-capacity-safety-UNIQUE --prior-failure "$CHESS_FAILED_LOCAL_REPORT"
node scripts/seal-capacity-provider.mjs --check --review "$CHESS_CAPACITY_REVIEW"
node scripts/seal-capacity-provider.mjs --seal --review "$CHESS_CAPACITY_REVIEW" --output /private/tmp/chess-capacity-candidate-UNIQUE
node "$CHESS_CAPACITY_DIR/stage/scripts/capacity-driver.mjs" --verify-candidate --candidate "$CHESS_CAPACITY_DIR/candidate.json"
# change, only after the owner approves the frozen candidate: provision and deploy its wrangler.deploy.json per the capacity guide, then run the driver, which arms and runs
node "$CHESS_CAPACITY_DIR/stage/scripts/capacity-driver.mjs" --execute --candidate "$CHESS_CAPACITY_DIR/candidate.json" --seed "$CHESS_CAPACITY_SEED" --sessions-artifact "$CHESS_CAPACITY_SESSIONS" --trace "$CHESS_CAPACITY_TRACE" --region us-west
```

Run it twice, each with its own candidate: the registration-only diagnostic
first (review `profile` `registration-diagnostic-v1`, 18.3), then the full
profile (18.4). Then reconcile (18.5).

**Pass:** the diagnostic prints `diagnosticPassed: true` with an exact native
zero-Game stop; the full run prints `passed: true` (19,000 required results,
900-second stream, at most 1,000 unfinished games) with audited native shutdown
inside the shared $25 ledger; the reconciliation covers all six earlier
failures, permits, dispatches, charges and IDs; the named US West egress and
measured limits are in the guides; isolated resources are stopped and read back.
**Stop:** any failure. Keep the trace and stop. Never restart an old job, reuse
an identity, refund or reset. **7.2** stays blocked.

### 7. Canary player checklist (3.6, 7.1)

Set `ARENAS_ENABLED=true` and deploy with
`npx wrangler deploy --env '' --strict --message "Protected arenas"`. Access
still limits players. Use two distinct people on separate browsers and at least
three accounts. Record each row as pass, fail or unrun.

- Accounts: signup with and without recovery email, signin, invitation, legacy
  guest reconnect. Reuse the 2026-10-21 mail evidence unless mail code changed.
- Board (**3.6**): touch, drag, click, keyboard, promotion and underpromotion,
  cancellable premove, focus, phone layout, muted sound, reduced motion.
- Ranked (step 5 games count): reconnect, history, replay, PGN, report receipt.
- Profile and leaderboard (**4.5**): a provisional rating shows. The leaderboard
  stays truthfully empty: a row needs 20 games, 8 opponents, a 7-day account and
  RD at most 100.
- Arena: register, queue, play, pause, resume, standings, result. Entry opens 15
  minutes before an event (hourly blitz, daily and weekly rapid).
- Browser Stockfish game; unattended recovery (close both browsers through a
  flag, reopen); canonical HTTPS, static and API headers, same-origin cookies,
  WebSocket admission.
- Round-robin rounds: unrun while `TOURNAMENTS_ENABLED` is `false`.

**Pass:** every row recorded with the deployed version and no failure.
**Stop:** a failed board, settlement or arena row. Use the matching lever, fix,
retest.

### 8. Live mail, alert, cron and stop readbacks (6.2, 6.3)

```sh
npx wrangler secret list --env ''
npx wrangler d1 time-travel info DB --env '' --json
npx wrangler tail --env '' --format json --status ok
```

- Secrets: `secret list` shows the four canary secret names. Add none.
- Mail: a real-email account receives verification and recovery mail in the
  approved inbox; the sending domain's DNS, signing and bounce records still
  read back as verified; Operations shows the email stop clear.
- Alerts: send Test from each saved usage policy to the approved inbox. Send the
  webhook Save/Test: it stops all three categories. Clear them in the owner form
  with the latest `expectedVersion`. Compare account usage with the $100
  envelope and update the [cost estimate](cost-estimate.md).
- Cron: `tail` shows a scheduled event with cron `* * * * *`, outcome `ok` and no
  `maintenance_failed` log. The daily `15 3 * * *` event needs a wait past 03:15
  UTC. No stored heartbeat exists, so these logs are the evidence.
- Stops: set `gamesStopped`; a new signup and a new queue join are refused and a
  running game still moves; clear it. Read `outboxLagMs`, `outboxFailures`,
  `correctionLagMs` and `lastMaintenanceError`. The `NEW_WORK_STOPPED` deploy
  path stays unexercised; record it.
- Recovery without restore: `POST /api/admin/operations/recovery/competition`
  returns a bookmark and Time Travel info reads. Export and close one throwaway
  account with its password. Production restore stays unrun.

**Pass:** each bullet recorded. **Stop:** an alert, webhook or cron failure.
Ranked and arenas do not open until it is fixed and reread.

### 9. Production variable change (7.2)

Build the release from published sources (step 1). It must update
`public/qualification/timeout-proofs.json` (admission values, status and
`claimsRankedOpen`, from the 3.9 report and step 5 readback) and any guide copy
that still says ranked admission is closed. Apply any row of the values table
not yet applied, then deploy.

```sh
npm run typecheck && npm test && npm run build && npm run worker:check && npm run budget
npx wrangler deploy --env '' --strict --message "Level 2 production values"
npx wrangler versions view "$CHESS_DEPLOYED_VERSION" --env '' --json
```

Open `/api/config`, `/api/arenas` and `/api/admin/operations` in the owner
browser.

**Pass:** `ranked` and `ai` true, `tournaments` false; arenas `enabled` true;
`authority.rankedOpen` true; `timeoutProof.limit` 1000; `retirement.mode`
`scaled`; each unset product limit reads `9007199254740991` and
`authorityBytes` `4294967296`; `analysis.enabled` false; `budget.stoppedByEnv`
false; provider readback confirms `workers_dev` and `preview_urls` false, both
cron triggers and the `PROVER` binding. **Stop:** any other value. Fix and
redeploy, or roll back.

### 10. Remove full-host Access, keep owner protection (7.2)

Proceed only after steps 1 to 9 pass and the owner says go.

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

### 11. Public host and guide verification (7.2, 4.5)

```sh
for p in / /help/ /rules/ /fair-play/ /privacy/ /docs/developer-guide/ /credits/ /leaderboard/ /tournaments/ /qualification/timeout-proofs.json; do curl -sS -o /dev/null -w "%{http_code} $p\n" "https://chess.ejmlabs.com$p"; done
curl -sS https://chess.ejmlabs.com/api/config
curl -sS https://chess.ejmlabs.com/api/arenas
curl -sSI https://chess.ejmlabs.com/ | grep -iE 'content-security|strict-transport|x-content-type|x-frame|referrer|permissions'
curl -sS -X POST -o /dev/null -w '%{http_code}\n' https://chess.ejmlabs.com/api/operations/budget-stop
```

From a non-canary network, sign up a fresh account, sign in and start a game.
Guides must state ranked and arenas open, four concurrent ranked games, the
1,000-game ranked total, no arena product cap beyond the Cloudflare budget stop,
and the unrun follow-up measurements. Watch the first hour: `retirement.pending`
and `oldestDue`, `outboxLagMs`, arena `unresolvedGames`.

**Pass:** every route 200; `/api/config` matches step 9; the budget-stop POST
returns 403 (404 means its secret is missing or malformed); headers present; Turnstile, signup, signin and a game work
publicly; guides match. **Stop:** use the stop levers, then fix.

### 12. Discovery (7.3)

After step 11 passes. In ejm-ui set `PROJECTS.chess.discoverable` true in
`packages/site/src/projects.mjs`, replace its tagline (it says ranked and public
release are not available), update `projects.test.ts`, run `npm run check` and
release through its `RELEASING.md`. Its guide links are `/help/` and
`/docs/developer-guide/`. In `ejmlabs`, update the Projects row, Play action,
shared-registry adoption and guide links, run its build, type, budget and link
checks, and publish through its owner process. Verify current products, guide
links, marks and downloads.

**Pass:** the shared lists and Studio show chess with working links and other
products unchanged. **Stop:** revert the registry change; chess stays open.
