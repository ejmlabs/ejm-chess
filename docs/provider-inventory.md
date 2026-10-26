# Provider inventory and protected deployments

## Evidence boundary

This is a dated record of the dedicated chess resources. Worker, binding and
alias metadata was read on **21 October 2026 at 00:43 UTC**. Namespace ownership,
SQLite mode, canonical DNS and zone route scope were checked at **00:50 UTC**.
The final local candidate build and production dry run passed at **00:57 UTC**,
or **20 October 2026 at 17:57 Pacific**. Provider metadata describes a stopped
private deployment. The later local build does not establish a new deployment
or that public or ranked play is open.

Later protected mail and stopped deployments are recorded below. They
supersede the original version and stop-setting snapshot, without changing
the dedicated resource identities.

The owner retains the provider responses in the private evidence record
`chess-launch-20261020-v1/cloudflare-readback.ndjson`. Each record includes its
label, UTC check time, HTTP status, provider success flag and returned metadata.
The selected account and zone, recipient addresses, policy membership and
credentials remain private. Resource identifiers below are metadata, not
credentials. Never substitute another project's resource because its name is
similar.

## Later protected deployments and account acceptance

The Guide correction deployed version
`[id in private provider record]`, deployment
`[id in private provider record]`, at
`2026-10-21T09:41:22.92925Z`, with 100% traffic. It reuses the signup-cap
Worker bundle below and updates static Guide assets. The normal 16-route
and nine-route guide budgets passed. A protected browser refresh confirmed
the published sentence: signup-limit enforcement is deployed with new signup
stopped, and the proof profile remains off.

The upload finished before the local receipt writer failed. Its original
stdout and exit code were not retained. No upload was repeated: a read-only
provider reconciliation at `2026-10-21T09:44:21Z` confirmed the new deployment,
all expected settings and bindings, aliases disabled, Operations version 3
with all stops on, zero monthly signup attempts and two lifetime attempts.
The private v2 manifest preserves the 83 uploaded inputs. Separate v2
deployment and readback records retain the receipt failure and reconciliation.

The signup-cap update deployed version
`[id in private provider record]`, deployment
`[id in private provider record]`, at
`2026-10-21T09:33:04.870183Z`, with 100% traffic. Its exact Worker bundle
SHA-256 is `a0693be14624cad21c74dfefa02c98f95a62ccfaa9f440c1f8a87bdd0de230cb`.
The source-bundle dry run and final `--no-bundle` dry run used identical bytes.
All 16 normal routes and nine guide routes passed their existing budgets.
The three focused native signup-budget checks remain applicable because all
six tested code, migration and test inputs matched their recorded hashes.

The only added variables are `MONTHLY_SIGNUP_LIMIT=0` and
`SIGNUP_ATTEMPT_LIMIT=10000`. All existing variables, resource bindings and
secret names match the preflight. Readback confirms the 50 ms CPU cap, global
stop, all game flags false, proof profile off, provider aliases disabled and
Operations version 3 with all stops on. The migration and both stored signup
counts are unchanged. No signup, email, game or proof work was admitted.
The private `signup-cap-deploy-manifest-20261021-v1.json` and associated
deployment/readback records retain the exact 83 files and provider metadata.
The approved Keychain token was not printed or saved. Access policies were
not changed. This remains a stopped protected deployment.

The account-preview update deployed version
`[id in private provider record]`, deployment
`[id in private provider record]`, at
`2026-10-21T07:33:25.152722Z`. Fresh provider readback confirmed 100% traffic
to that version, a 50 ms CPU limit, `NEW_WORK_STOPPED=true`, all game flags
false, proof profile off with zero allowance, and unchanged 0/20/0
game/email/analysis limits. Existing secret names and resource bindings were
retained. The full-host Access login was enforced and renewed through the
existing owner identity; no Access policy changed.

This publication uses the verified v8 source and current redesign, with seven
account-related files changed for an 8 to 128 character password policy and
one submit action per account view. Four focused native auth cases, both
TypeScript programs, the normal build and its budgets passed. Browser checks
confirmed the published signin/signup views and password guidance. Unrelated
game and capacity tests were not repeated. No new real account or recovery
email was used for this correction.

Additive migrations `0013_timeout_proofs.sql` and
`0014_account_privacy.sql` passed before upload, after recording a native
D1 Time Travel recovery bookmark. No restore or private-data export ran.
The exact dry-run Worker bundle was uploaded with `--no-bundle`; its SHA256 is
`eb54a106d70dc4f96f3595496651e690ee34209f3d698762d9a4a28ec8091d5e`.
The private `account-preview-20261021-v1` record retains source, patch,
configuration, artifact hashes and checks. Deployment used the existing
Wrangler login. No Keychain credential was read. Public launch, ranked play,
capacity and remaining operational acceptance gates stay open.

## Signup counter migration, 21 October 2026

Migration `0015_signup_budget.sql` passed at `2026-10-21T09:12:11Z` using
Wrangler 4.151.3 and the existing dedicated D1 database. A native Time Travel
bookmark was saved first, and the pending-migration readback named only that
file. Its SHA-256 is
`278052b3e7505f0f164914723d46973f7240426328f5d8d94bd6eb3eee9493aa`.

Readback confirmed one signup aggregate row, zero monthly attempts and two
lifetime attempts matching the two existing identities. Operations remained
at version 3 with games, email and analysis stopped. No Worker upload, account
creation, restore, counter reset or privacy export ran. Remote migrations are
now through `0015`; the later stopped Worker update installed signup-limit
enforcement and settings. The approved Keychain credential stayed in process memory and the
child environment; its value was neither printed nor retained. The private
`signup-migration-20261021-v2` record contains the source, migration output and
readback. The earlier failed OAuth attempt remains in its separate v1 record.

## Earlier protected mail deployments

The records below describe earlier deployments and their evidence limits.

The mail test deployed version `[id in private provider record]`,
deployment `[id in private provider record]`, at
`2026-10-21T01:13:08.494998Z`. Its frozen Worker bundle SHA256 was
`4d84f3382f9a1691d1cc611f447a83fed03419bdb51dcc6b5c695707ecc2596b`.
The dry run and `--no-bundle` upload used identical bytes. Game and analysis
allowances stayed zero, every game flag stayed false, and full-host and admin
Access remained in force. Only mail was temporarily open, with a 20-attempt
allowance.

The [account acceptance report](qualification/provider-accounts-20261021.md)
records normal signup with and without email, live Turnstile, actual recipient
verification and password recovery, new-password sign-in, old-session
revocation and the application-authorized restoration of all persistent stops.
The aggregate readback recorded two email attempts and control version 3.

Version `[id in private provider record]`, deployment
`[id in private provider record]`, then restored the global stop at
`2026-10-21T01:33:00.170369Z`. The same exact Worker bundle was used. The
production config SHA256 was
`84442f276ceda7b51adc40b926378781801fb12046de4ee118dab280de480852`.
The provider readback confirmed 100% traffic to this version,
`NEW_WORK_STOPPED=true`, game/email/analysis allowances of 0/20/0, all game
flags false and the unchanged 50 ms CPU limit. Persistent games, email and
analysis stops are separately set. No proof service was deployed by either
operation. Updated source guides are not yet published.

A temporary narrower deployment credential was used for both deployments
above. Its creation time, expiry and permission set are kept in the private
provider record. Its value stayed in process memory. The owner's broad
credential was not altered or revoked. Remove the temporary credential after qualification or
let its recorded expiry close it.

## Selected resources, original deployment

| Resource | Identity and observed association |
| --- | --- |
| Production Worker | `ejm-chess` |
| Deployed version | `[id in private provider record]`, receiving 100% of the Worker's configured traffic |
| Deployment record | `[id in private provider record]`, created `2026-10-21T00:21:22.842223Z` |
| D1 binding `DB` | Dedicated database `ejm-chess`, UUID `[id in private provider record]` |
| DO binding `GAME` | Class `Game`, namespace `[id in private provider record]` |
| DO binding `COMPETITION` | Class `Competition`, namespace `[id in private provider record]` |
| Custom domain | `chess.ejmlabs.com`, ID `[id in private provider record]`, service `ejm-chess`, environment `production` |
| Private Access canary | Application `[id in private provider record]`, canonical-host destination |
| Separate admin Access | Application `[id in private provider record]`, `/admin` and `/api/admin` destinations |
| Static assets | Worker binding `ASSETS` |
| Account mail | Binding `EMAIL`, restricted to sender `chess@ejmlabs.com` |

The Worker settings and deployment records returned HTTP 200 with provider
success at `00:43:18.826943Z` and `00:43:19.186896Z`. The namespace IDs above
match those deployed bindings. The `game-namespace-ownership-and-sqlite` and
`competition-namespace-ownership-and-sqlite` readbacks at `00:50:14.989671Z`
and `00:50:15.194037Z` confirm both namespaces belong to script `ejm-chess`,
have their expected classes and report `use_sqlite=true`. The complete
namespace inventory fit on the provider's one returned page. The source's
additive `v1` migration declares these same two new SQLite classes. No private
object contents were needed for this ownership check.

The domain inventory at `00:21:57.758946Z` contained one custom domain for
this Worker: the canonical hostname above, enabled, with previews disabled.
The `canonical-dns-fresh` readback at `00:50:15.657132Z` returned one proxied
`AAAA` record for `chess.ejmlabs.com`, with content `100::`, automatic TTL and
read-only metadata whose `origin_worker_id` matches that custom-domain ID.
The `zone-worker-route-scope` response at `00:50:15.888062Z` contained 36 zone
routes. None had a host pattern matching `chess.ejmlabs.com`, including host
wildcards. The filtered canonical-host match list was empty; the entire zone
route list was not empty. These checks returned HTTP 200 with provider success.

The canary and admin application metadata were read at `00:15:07.149613Z` and
created at `00:13:41.531337Z`, respectively. These times are separate from the
later Worker readback. Any later policy change needs its own saved readback;
an older full-host policy record alone does not prove the exact current
budget-notification exception or its delivery.

## Original effective stopped settings

The `deployed-worker-settings-fresh` record confirms:

```text
AUTH_BASE_URL=https://chess.ejmlabs.com
LOCAL_DEV=false
OPERATION_MODE=unattended
NEW_WORK_STOPPED=true
RANKED_ENABLED=false
TOURNAMENTS_ENABLED=false
ARENAS_ENABLED=false
AI_ENABLED=false
ANALYSIS_ENABLED=false
cpu_ms=50
compatibility_date=2026-10-19
compatibility_flags=nodejs_compat
```

The `deployed-worker-subdomain-aliases` record at `00:43:19.040955Z` confirms
both `enabled=false` and `previews_enabled=false`. These are the provider's
Worker subdomain settings corresponding to disabled `workers.dev` and version
preview aliases. The checked-in config also sets `workers_dev=false` and
`preview_urls=false`. Do not create another hostname to bypass the canary.

`readback-chess-crons` at `00:21:57.973299Z` confirms the minute schedule
`* * * * *` and daily schedule `15 3 * * *`. It proves configured schedules,
not an actual trigger invocation or successful recovery cycle.

The settings expose secret names `AUTH_SECRET`, `TURNSTILE_SECRET_KEY`,
`OWNER_EMAILS` and `BUDGET_STOP_WEBHOOK_SECRET` as `secret_text`. Their values
were hidden in the retained deployment log and are not included here. No
server-analysis queue or Container binding appears in the deployed settings.
The mail binding restricts the permitted sender. This metadata does not prove
inbox delivery or successful application-level owner authentication.

The later `provision-account-token-status-metadata` and
`provision-account-token-policy-metadata` readbacks at `00:59:47.819705Z` and
`01:00:09.640936Z` confirm that the account-owned provisioning token was active
and had broad permissions beyond this product's deployment needs. Least
privilege was therefore a known gap in that original deployment. The later
temporary narrower credential and its use are recorded above. Token values
and account identifiers remain private.

## Migrations, source and build provenance

The original deployment applied additive D1 migrations `0001` through `0011`.
The saved `d1-migrations-after.json` command exited zero and reported no pending
migrations for that snapshot. The later `report-expiry-migration.json` records
successful application of `0012_report_expiry.sql`. That additive schema update
does not change the deployed Worker version or establish that later expiry
code is running. Refresh the remote ledger before the next deployment.

The retained `initial-protected-deployment.json` records a successful Wrangler
4.151.3 deployment, with 80 uploaded asset changes, Worker upload size
2,295.59 KiB raw / 435.60 KiB gzip, the dedicated bindings, hidden secret values,
stopped flags and the version ID above. The source archive and per-file hash
manifest are `initial-stopped-source.tar.gz` and
`initial-stopped-source-manifest.json` in the same private evidence record.

The frozen `wrangler.jsonc` SHA-256 is
`ae90ae1ca93ea08cdbac908f4a395e67d0a9ac573c6c1540b15cd0971ed92d7f`.
It matched the current canonical source config during this review. Current
`src/server/index.ts`, `src/server/game.ts`, `src/server/competition.ts` and
`src/pages/Guide.tsx` differ from their frozen deployed-source hashes. The
working tree therefore contains later changes that this deployment record
does not establish as live.

Earlier local Worker dry runs are retained in the optional-email and shared
application-layout evidence records. They reached `--dry-run: exiting now`
with Wrangler 4.151.3. They used earlier feature flags and did not include the
final dedicated D1 binding. They are historical build evidence; the fresh
production-config check below closes that local dry-run gap for its source
snapshot.

## Final local candidate check

The private evidence directory
`chess-launch-20261020-v1/task-6-1-final-20261021T005716Z/` retains command logs,
before/after source manifests, built artifact manifests and `checks.json`.
Checks ran with Node **v24.19.0**, npm **11.17.0**, Vite **8.3.4** and Wrangler
**4.151.3**. All times below are on 21 October 2026 in UTC.

| Command | Started | Finished | Result |
| --- | --- | --- | --- |
| `npm run build` | `00:57:17.280058` | `00:57:20.196079` | Exit 0; pinned Stockfish inputs and both build budgets passed |
| `npm run budget` | `00:57:20.196226` | `00:57:20.574507` | Exit 0; all-route and tighter guide budgets passed |
| `npm run worker:check` | `00:57:20.574594` | `00:57:21.944201` | Exit 0; canonical production config, ending `--dry-run: exiting now` |

The source aggregate SHA-256 is
`ce2dc7479e6fe1973c6a33945d70ee2c1add3ce33aa7d35ed3f6157f19e30f1f`.
It covers 727 product and linked public ejm-ui package files. The manifest
defines the exact scope and digest method: SHA-256 over compact, sorted UTF-8
JSON mapping each included path to its byte count and SHA-256. Product source,
public assets, scripts, migrations, build configuration and package locks are
included; dependency directories and secrets are excluded. The before/after
aggregates match, so those inputs stayed unchanged through all three checks.

The canonical config SHA-256 remained
`ae90ae1ca93ea08cdbac908f4a395e67d0a9ac573c6c1540b15cd0971ed92d7f`.
The checked Guide source SHA-256 was
`1d2704babd329162860a16706eb133271656257849578acb8525c5c4e6f26756`.
This is a dated source snapshot. Subsequent isolated recovery-drill fixture,
test or documentation edits do not become part of it. A later production
input change needs its own relevant checks and new provenance.

The dry run included the dedicated `DB`, `GAME`, `COMPETITION`, `EMAIL` and
`ASSETS` bindings, canonical `AUTH_BASE_URL`, `LOCAL_DEV=false`,
`NEW_WORK_STOPPED=true` and disabled ranked, tournament, arena, AI and analysis
flags. Wrangler reported **2,307.97 KiB raw / 438.65 KiB gzip** Worker upload.
The generated Worker `index.js` was **2,363,363 bytes**, SHA-256
`4d84f3382f9a1691d1cc611f447a83fed03419bdb51dcc6b5c695707ecc2596b`.
This was a local dry run, with no provider mutation or deployment.

The built `dist` manifest contains **81 files / 4,492,222 raw bytes**, aggregate
SHA-256 `5e0fd47ccd6b6f651012f0221254bc1d018f5fa164b3f1b266eef66a815a29c4`.
That includes lazy engine files and source/license distribution; it is not an
initial page transfer measurement. The route budget reports at most **104.5 KB
JavaScript**, **13.7 KB CSS**, **33.7 KB fonts** and **7.0 KB HTML** under the
existing budget tool's compressed accounting. All routes fit the general
180/20/70/30 KB limits. The selected guide/account/home routes also fit their
tighter 95 KB JavaScript and 14 KB CSS limits. These bytes do not establish
regional latency, concurrent-player capacity or monthly cost.

## Repeatable readback

Use the owner's existing private credential bridge with the selected account
and zone. These are read-only HTTP methods under
`https://api.cloudflare.com/client/v4`; placeholders are private ledger values.
Do not put token values in command arguments, source, screenshots or chat.

```text
GET /accounts/{account_id}/workers/scripts/ejm-chess/settings
GET /accounts/{account_id}/workers/scripts/ejm-chess/deployments
GET /accounts/{account_id}/workers/scripts/ejm-chess/subdomain
GET /accounts/{account_id}/workers/scripts/ejm-chess/schedules
GET /accounts/{account_id}/workers/domains
GET /accounts/{account_id}/workers/durable_objects/namespaces
GET /accounts/{account_id}/d1/database/[id in private provider record]
GET /zones/{zone_id}/workers/routes
GET /zones/{zone_id}/dns_records?name=chess.ejmlabs.com
```

Paginate any account-wide inventory. Retain only chess entries in the public
summary, and compare namespace IDs, class names, owning script, SQLite mode,
database ID, custom-domain service, route patterns, flags and active version.
An enabled percentage deployment does not imply the feature gates are open.
Recheck zone routes as well as custom domains after any routing change. The
dated empty canonical-host match list above does not guarantee future scope.

The pinned Wrangler also supports these read-only checks from this product:

```sh
npx wrangler deployments list --env '' --json
npx wrangler versions view "$CHESS_DEPLOYED_VERSION" --env '' --json
npx wrangler d1 info ejm-chess --env '' --json
npx wrangler d1 migrations list DB --remote --env ''
npx wrangler secret list --env ''
```

Set `CHESS_DEPLOYED_VERSION` to the actual active version read back from the
provider. Listing secret names does not justify reading their values. Retain
the timestamp, command exit/provider success, source/configuration hash and
redacted result for each check.

## Recovery and acceptance still in progress

The deployment and operations runbooks cover stopped admission, dedicated
resource ownership, additive migrations, protected canary/admin access,
compatible rollback, private exports and exact-target restore approval.
The newer recovery drill guide distinguishes read-only production capture
from isolated native restore/restart hooks. Local guard and integration checks
do not establish a provider restore or a coherent cross-store recovery point.
The source snapshot above passed its local build, budgets and production dry
run. It still needs its own authorized deployment and provider acceptance.
Later production source changes need refreshed local checks. Application
secret values were hidden and bindings were scoped. Later deployments used
the temporary narrower credential described above. The fresh readbacks and dry run also
cannot establish that every check occurred before the initial resource
creation.

Configured namespaces and alias closure do not prove the other launch gates.
The dated account and isolated recovery reports record their successful
boundaries. Two-player board acceptance, complete restoration and undo,
real threshold alert delivery, scheduled recovery, regional latency,
sustained admission, storage growth and monthly spending remain separate launch
gates. Keep public and ranked play closed until their evidence and release
scope are accepted.
