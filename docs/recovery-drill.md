# Native recovery capture and isolated drill

## Current status and limits

Game and Competition expose private, read-only `captureRecoveryPoint()` RPCs.
Production HTTP capture requires the existing verified owner account and
matching Cloudflare Access identity. Production exports no native restore or
restart method. The separate `wrangler.recovery-drill.jsonc` entry point owns
those methods on separate classes and resources.

The capture and isolated restore guards recognize historical
`online-2026-10-v2-unattended` and current `online-2026-10-v4-unattended` policy
metadata with the existing rating policy. Unknown policies, including the
retired `online-2026-10-v3-proof`, fail closed.
The authority fingerprint format and historical v2 evidence remain unchanged.
An updated source with new tables needs its own capture and source approval.
The timeout-proof path was retired on 2026-10-31 and the isolated config no
longer checks proof settings.

Focused workerd tests protect capture, bounded inventory, access denial,
manifest checks, later-work refusal and undo-before-restart. The guard tests use
explicit fake bookmarks. A separate local integration check exercises the
actual drill entry point with synthetic accounts, move retry and ranked result
delivery. Neither check establishes provider PITR support, production recovery,
complete cross-store restoration, retention or an RTO/RPO.

On 2026-10-21 UTC, a separate native Cloudflare rehearsal restored isolated D1,
Game and Competition for both a completed casual game and a still-active casual
game. The active fixture retained its accepted move receipt and original running
deadline, then completed through the original timeout policy. The recorded
restore sequences took 60.027 seconds and 56.755 seconds.
These are measured drill intervals, not service-wide RTO/RPO. See the
[dated provider report](qualification/provider-recovery-20261021.md) for the
source, exact scope, retained evidence and remaining checks. Its extended v3
matrix also passed held result delivery, ranked correction, positive budget
receipts, naturally aged tombstones and a complete native undo rehearsal.
The later [privacy rehearsal](qualification/provider-privacy-20261021.md)
verified one saved closure receipt reapplied twice after native D1 rollback,
with both DOs kept current. Task 6.3 remains open for enabled events, broader
concurrent accepted work, complete later-closure sets, proof lifecycle recovery,
independent backup and accepted retention policy.

Capture reads at most 128 application tables, 512 schema entries, 4,096 rows and
2 MiB of encoded schema and row data per object. It hashes table, index, trigger
and view definitions and ordered application rows. Provider-owned SQLite tables
are excluded. Binary application rows require a reviewed format change. Capture
fails closed on unsupported native APIs or exceeded bounds. A larger authority
needs a separately reviewed recovery plan; do not clear history to fit this one.

The envelope records format and policy versions, exact native object ID,
logical name, native bookmark, capture time, alarm, hashes and bounded state
metadata. It returns no raw actor, session, command, account or evidence rows.
Treat bookmarks, hashes, manifests and undo receipts as private.

## Production preparation

After closing new admission, use the protected routes with the same owner
session and Access token required by `/admin/`:

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/admin/operations/recovery/inventory?limit=50&after=<cursor>` | Keyset page of admitted IDs; omit `after` for the first page |
| POST | `/api/admin/operations/recovery/competition` | Capture Competition metadata; JSON body `{}` |
| POST | `/api/admin/operations/recovery/games/<id>` | Capture an admitted Game; JSON body `{}` |

Inventory merges bounded pages from permanent D1 admissions, seat and game
records, and Competition match/casual/tournament/arena records. It includes
pending ranked matches with no D1 game projection. Unknown IDs are rejected
before touching a Game. Follow `nextCursor` until null. Inventory and captures
are not a transaction across stores. Closing new admission does not freeze
active games, alarms, scheduled work or outboxes. Verify the boundary, preserve
later accepted work and retain original command arrival times and deadlines.

Pair the object captures with the exact D1 database ID, schema/migration state
and native bookmark. A private SQL export is a separate copy that needs an
approved destination, access rules and expiry. No production account/session
SQL export is required or authorized by this runbook. Record actual DO namespace IDs from
Cloudflare because runtime object APIs do not expose their namespace ID. Record
the approved source/configuration digest and fixed journal watermarks as well.
Keep the private manifest outside all restore targets. D1 projections cannot
replace Game or Competition authority.

Preserve all closure receipts accepted after a selected restore boundary
outside its targets. Keep authentication and admission closed, reapply those
receipts through `applyAccountClosure`, reconcile Competition closure fences,
and verify that credentials, recovery addresses and sessions remain removed
before access reopens. An incomplete closure set must keep access closed. The
[privacy policy](privacy.md) describes retained identity and native-history
retention. This requirement adds no production restore endpoint or approval.
The frozen v3 rehearsal predates the privacy migration. A separately sealed
single-account rehearsal passed under the later source/capture boundary;
that result does not prove complete multi-account or concurrent closure replay.

## Provision the isolated drill

Use an approved disposable Cloudflare scope within the chess budget. Never
substitute the production database, object classes, namespace bindings or
custom domain. Review the config before any provider command. It names only
`RecoveryDrillGame`, `RecoveryDrillCompetition` and an isolated D1 database.
There is no email, queue, Container, assets, cron or custom-domain binding.

```sh
npx wrangler d1 create ejm-chess-recovery-drill
```

Set the returned UUID in both `d1_databases[0].database_id` and
`vars.RECOVERY_DATABASE_ID` in `wrangler.recovery-drill.jsonc`. Set
`RECOVERY_SOURCE_REVISION` to the approved 40-character source commit or
64-character source snapshot digest. Keep the unique `RECOVERY_DRILL_SCOPE`.
Missing or invalid resource values deliberately reject requests.

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.recovery-drill.jsonc
npx wrangler deploy --config wrangler.recovery-drill.jsonc
npx wrangler secret put RECOVERY_DRILL_TOKEN --config wrangler.recovery-drill.jsonc
```

Use a private random 32 to 128 character base64url token. Do not put it in an
argument, source file, public artifact or chat. Requests fail until this secret
and the reviewed target values are present. Read back the actual two namespace
IDs from Cloudflare and put their 32-character hex IDs in
`RECOVERY_GAME_NAMESPACE_ID` and `RECOVERY_COMPETITION_NAMESPACE_ID`, then
redeploy the isolated config. Confirm those namespaces belong to this drill
Worker and differ from production. The runtime rejects the known production D1
ID, missing/equal namespace IDs, open admission and optional service bindings;
it cannot independently inspect the provider account's namespace registry.

The deployed flags remain stopped and all player features disabled. Only the
protected synthetic fixture route can create drill work. Synthetic actors use
invalid email addresses and real package-generated password hashes. Passwords,
tokens and session values are never returned. The isolated Game/Competition
adapters can exercise ranked settlement without opening a public ranked route.
Ranked fixture setup writes the normal reservation metadata, then calls the
normal Game initialization and account-seat guard. The private adapter records that optional postgame analysis was
omitted and drains only synthetic analysis outboxes, so the absence of an
analysis binding cannot be mistaken for a completed analysis job.

## Protected requests and private records

Only `POST /drill` exists. Every request requires the private bearer token.
Set these variables through the owner's private credential path:

```sh
export CHESS_RECOVERY_DRILL_URL=https://ejm-chess-recovery-drill.<account>.workers.dev
export CHESS_RECOVERY_PRIVATE_DIR=/private/tmp/chess-recovery-private
```

Also set `CHESS_RECOVERY_DRILL_TOKEN` privately. Create bounded request JSON
files in that private directory, then send them with:

```sh
node scripts/recovery-drill.mjs "$CHESS_RECOVERY_PRIVATE_DIR/request.json" response.json
```

The helper accepts only the named isolated Workers origin. It stores a new
0600 response file in the private directory and prints status/path/error only.
It refuses to overwrite an existing response or write inside the product.
Use a fresh output name after a retry. A response lost during native restart
is expected, so preserve the earlier successful prepare receipt first.

| Operation | Extra request fields | Result |
| --- | --- | --- |
| `inspect` | None | Reviewed scope, source and resource identities |
| `seed` | Fresh UUIDv4 `gameId`; optional `rated: true` | Credential-backed synthetic seats and a 5+3 active game |
| `command` | `gameId`, `color: "w"` or `"b"`, versioned `command` | Normal authority command result; stable command IDs support retry |
| `flush` | `gameId` | Normal result/outbox delivery and journal metadata |
| `fixture-status` | `gameId` | Read-only terminal-ack, delivery, tombstone, selected D1 projection and journal metadata |
| `reserve-budget` | `gameId` | One stable synthetic games receipt through the normal budget API, under a six-receipt monthly fixture allowance |
| `terminal-ack` | `gameId`, `action: "arm"` or `"release"` | Arms one simulated lost terminal acknowledgement or releases its accepted delivery |
| `correction` | `gameId`, `action: "restrict"` or `"clear"` | Imports one deterministic synthetic decision and advances at most one normal correction step |
| `retire-aged` | `gameId` | Runs the normal bounded payload-retirement path at the real current time |
| `inventory` | Optional `after` | Same bounded admitted-ID inventory |
| `capture` | `gameId`, real native `d1Bookmark` | Private manifest with D1 schema hash, both native object points and a versioned boundary for all three probes |
| `change-probes` | `gameId` | Changes only three harmless isolated probe values |
| `reset-probes` | `gameId` | Resets only those three markers to `original`; refused while any restore is armed |
| `probes` | `gameId` | D1, Game and Competition probe values |
| `prepare-restore` | `gameId`, `kind: "Game"` or `"Competition"`, reviewed `manifest` | Arms one native DO restore and saves its undo receipt |
| `restart` | `gameId`, `kind`, `manifestSha256`, `undoBookmark`, `privateReceiptSaved: true` | Native object abort; the next session performs the armed restore |
| `resume` | `gameId`, reviewed `manifest` | Verifies restored DO hashes, alarms and all three probe values; resumes original deadlines/outboxes |

The initial seed uses a running five-minute clock. Complete the capture and
restore sequence promptly. An overdue or changed authority is a failed
boundary, not permission to change a clock. Use another fresh fixture if needed.

If a failed attempt changed the probes, invoke `reset-probes` and verify all
three values are `original` before capturing and reviewing a new boundary.
It changes only the D1/Game/Competition markers;
it does not change accounts, commands, clocks, results, epochs or budget state.
It is refused while any isolated restore is armed. A reset does not make an
old manifest safe to restore. A terminal fixture with drained delivery and no
alarm provides a stable boundary for a native restore test; it does not prove
active-game recovery.

All new fixture mutations share the armed-restore denial with commands, seeds
and probe changes. They require a seeded fixture in this isolated D1 database.
Seeding refuses a finished, archived or differently rated identity, so it cannot
reopen a finished seat or revive a tombstone. The route accepts no replacement
clock, result time, rating value, epoch or SQL statement.

During the 2026-10-21 UTC provider rehearsal, both Game and Competition refused the
expired active fixture with HTTP 409 `RECOVERY_LATER_WORK`. This records safe
refusal after the captured boundary changed. It is not a successful restore.

## Native provider sequence

1. Invoke `inspect`, create the required synthetic fixtures, and verify account,
   credential, session and seat ownership in the isolated D1 database. Exercise
   an accepted move and save its stable command ID, receipt and original
   deadline. Record any other fixtures and untested cases in the private record.
2. With synthetic commands stopped, capture D1's native bookmark and SQL export:

   ```sh
   npx wrangler d1 time-travel info DB --config wrangler.recovery-drill.jsonc --json
   npx wrangler d1 export DB --remote --config wrangler.recovery-drill.jsonc --output "$CHESS_RECOVERY_PRIVATE_DIR/before.sql"
   ```

   Save native output privately. Pass the actual returned bookmark to `capture`
   and save the returned JSON as `manifest.json`. No local or invented bookmark
   is a substitute for a provider record.
3. Review exact resources, source, policies, schema, authority hashes, alarms,
   metadata and accepted-work boundary. Hash the compact JSON representation,
   preserving property order, with Node's maintained crypto API:

   ```sh
   node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); fs.writeFileSync(process.argv[2],crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")+"\n",{mode:0o600,flag:"wx"});' "$CHESS_RECOVERY_PRIVATE_DIR/manifest.json" "$CHESS_RECOVERY_PRIVATE_DIR/manifest.sha256"
   npx wrangler secret put RECOVERY_MANIFEST_SHA256 --config wrangler.recovery-drill.jsonc < "$CHESS_RECOVERY_PRIVATE_DIR/manifest.sha256"
   ```

   Read back the isolated deployment and target values after the secret update.
4. Invoke `change-probes` and verify all three probes say `changed`. Preserve
   current stores and the native D1 undo boundary outside every restore target.
   Record the exact restore approval and start time.
5. Restore **isolated D1 first**, using only the reviewed bookmark:

   ```sh
   npx wrangler d1 time-travel restore DB --bookmark "$CHESS_RECOVERY_D1_BOOKMARK" --config wrangler.recovery-drill.jsonc --json
   ```

   Record native output and its undo bookmark privately. Verify the D1 probe is
   `original` and compare accounts, sessions, seats, accepted projections and
   budget receipts against the preserved boundary. Restore D1 before arming
   DOs so it cannot erase their new armed audit records.
6. Invoke `prepare-restore` once for each kind. It requires the exact approved
   manifest digest, scope, resources, source, D1 schema, object, policy and
   unchanged authority/alarm. It rejects later accepted work. It records the
   native undo bookmark in the isolated D1 audit table before returning. Save
   both successful responses outside all rollback targets.
7. Invoke `restart` for each object using its saved receipt. The native abort
   can lose the HTTP reply or return 503. Reconnect and read `probes`. Both DO
   probes must now be `original`. While armed, this drill pauses its synthetic
   mutating routes and alarm handlers. This pause is isolated and is absent
   from production. Restart rechecks state and alarm before aborting.
8. Invoke `resume`. It compares both DO authority hashes and alarms with the
   reviewed capture and verifies the D1 and both DO probes. It then resumes normal game
   deadline and outbox paths. Independently verify D1 data, retry the exact
   accepted command, test an overdue deadline, terminal delivery with a lost
   reply, an accepted result, correction epochs, tombstone, budget receipt
   totals and enabled event state. Record uncovered cases as open gates.
9. Record elapsed time, the last retained accepted event and actual data-loss
   boundary, provider retention, native undo outputs, and every failed or unrun
   check. Do not infer full-service recovery from restored probe values alone.

Changing a manifest requires another review and digest approval. Test stale
object/namespace/schema/policy inputs and later accepted work before claiming
safe refusal. Never replay an old move with a new server arrival time. A stored
D1 projection is not permission to overwrite a newer Game or Competition event.

## Additional acceptance fixtures

These are implemented private fixture paths. Local tests cover their guards,
normal data flow and duplicate handling. Their native cross-store restore and
undo results remain separate provider acceptance checks. The dated v2 report
does not qualify the new v3 path.

### Positive budget receipt

For a seeded game, send:

```json
{"operation":"reserve-budget","gameId":"<synthetic-game-uuid>"}
```

This calls `reserveMonthlyWork` with a temporary six-game monthly fixture
allowance and stable receipt ID `recovery:<gameId>`. It leaves deployment flags,
the zero deployment allowances and persistent stop rows unchanged. A persistent
games stop still refuses a new receipt. A retry recognizes only the existing
matching receipt. No game, email, analysis or solver work is admitted by this
operation. Before capture, require `accepted: true`, one receipt and unchanged
stop/version values. Preserve its original period, units, creation time, receipt
count and month totals in the private D1 boundary comparison. Verify the exact
rows after native restoration and retry the operation only after resume.

### Lost terminal acknowledgement

Use a fresh casual fixture for a stable terminal boundary:

1. Seed it and verify two normal active account-seat rows.
2. Send `{"operation":"terminal-ack","gameId":"<id>","action":"arm"}`.
3. Send a normal versioned resignation command, then `flush`.
4. Require `fixture-status.game.terminalAck="held"`, `pendingDelivery=true`,
   a finished D1 projection and two unreleased account-seat rows. Preserve the
   result watermark and original accepted command receipt.
5. Capture, review and perform the normal native D1 plus both-DO restore.
   Resume leaves the explicit fixture hold intact.
6. Send `{"operation":"terminal-ack","gameId":"<id>","action":"release"}`
   and repeat it once. Require no pending Game delivery, zero unreleased seats
   and the same accepted-result and rating watermarks.

The adapter calls real Competition settlement, then deliberately leaves the
Game outbox unconsumed and pauses its terminal retry alarm. It preserves the
stored outbox, receipt, result and arrival times. The active game clock runs
normally before the terminal result. This simulates a lost acknowledgement in
native stores. It does not establish a real provider outage or restart failure.

### Correction epochs

Seed a rated fixture, finish it through a normal resignation and flush until
the D1 projection is settled. Verify a real immutable rating event exists.
Send the following repeatedly until `status.complete=true`:

```json
{"operation":"correction","gameId":"<synthetic-game-uuid>","action":"restrict"}
```

The operation uses fixed synthetic case and decision IDs, synthetic actors,
the normal immutable D1 decision/outbox schema and the normal bounded correction
APIs. It advances at most one correction step per request. It never restricts
a real account or represents a human review. Record the published epoch,
correction cursor/watermark, D1 `rating_voided=1` and matching D1 projection
epoch. Capture and perform the native restore at that stable boundary. After
resume, verify the epoch and immutable result/rating events, then repeat the
operation with `action="clear"` until complete. Require `rating_voided=0`, the
next published epoch, matching D1 projection and unchanged original
result/rating-event counts. No fabricated rating rows or epoch writes replace
the replay.

### Naturally aged tombstone

Finish and flush a casual fixture. Preserve its actual `ended_at`, terminal
version/digest and replay projection. Wait at least one real hour from that
terminal time, then send:

```json
{"operation":"retire-aged","gameId":"<synthetic-game-uuid>"}
```

The operation calls the existing bounded maintenance path. In preview mode it
may attempt up to four eligible isolated payloads per minute across callers;
it does not target or alter an ineligible record. An added request field such
as `now` does not change its clock. Require a permanent Game tombstone, archived
D1 admission, retained replay and no heavy Game payload. Capture and restore
the native boundary, then verify the same tombstone/digest and D1 replay.
Retrying `seed` for that ID must return HTTP 409 `DRILL_SEED_CONFLICT` with the
tombstone and ledger unchanged. No backdated timestamp or shortened retention
period is acceptable evidence. Local tests cover refusal of a fresh payload;
natural aging and native tombstone restoration require retained provider proof.

## Failure and undo

An unavailable native API yields an explicit failure. No local bookmark is
fabricated. A failed audit write attempts to rearm the returned native undo
bookmark. If cancellation fails, `DRILL_RESTORE_UNCERTAIN` requires preserving
both bookmarks from its private `undoReceipt` and stopping the drill. Typed RPC
results preserve refusal codes and the private receipt across the class boundary.
Native arming may take effect on any
later object session, so treat the successful prepare response as an armed
change even before an explicit restart.

Use the preserved native D1 undo bookmark through the same exact-target native
command. For a complete undo rehearsal, use a terminal fixture with drained
work and no alarm. Preserve the changed D1 boundary and both native DO undo
receipts before the first restart. After verifying the original restore, do
not issue commands, retries or other work before rehearsing undo. Copy the
private manifest and replace the D1 bookmark and both DO bookmarks with those
saved native undo targets. Set its exact expected markers as:

```json
{"probeBoundary":{"schema":"ejm-chess-drill-probes-v1","d1":"changed","game":"changed","competition":"changed"}}
```

Review the complete new manifest, approve its new digest, then restore D1 first
and repeat prepare/restart/resume for both DOs. Resume requires all three
changed markers. Compare the account, receipt, projection, budget and authority
boundaries as well. Historical manifests without `probeBoundary` still require
all three markers to be `original`; adding or changing it invalidates their
approved digest. An undo whose
authority or alarm differs needs an explicit reconciliation plan. Do not bypass
later-work checks or silently swap a bookmark. Keep new work closed until all
stores and authorities agree.

No scheduled job provisions, restores or deletes drill resources. After the
owner accepts the evidence and recovery/retention policy, remove only the
recorded disposable resources through a separately approved provider action.
Preserve the private evidence and undo record for the approved retention period.

## Local checks

```sh
npm run typecheck
npm test -- test/recovery.test.ts test/operations.test.ts
npx vitest run --config vitest.recovery-drill.config.ts
npx wrangler deploy --config wrangler.recovery-drill.jsonc --dry-run
npm run worker:check
```

The isolated test config uses local synthetic resource identifiers. Its fake
D1 bookmark is labelled as local-only and never establishes provider evidence.
The public guides must retain the distinction between implemented capture,
local guard/integration checks, an actual isolated provider rehearsal and an
approved production restore.

## Account closure after a native D1 restore

This additive private fixture requires a new reviewed source snapshot, migration
`0014_account_privacy.sql` and a fresh synthetic game UUID. It does not qualify
the earlier frozen rehearsals. It restores only isolated D1. Game and
Competition stay current, including the committed account-closure fence. All
authentication and admission remain closed throughout the drill and afterward.
No public route, restore guard, service binding, allowance or cap changes.

The normal seed path supplies the two synthetic accounts. Fresh account IDs use
an email-safe `recovery-<gameId>-<color>` form. Earlier fixture paths still
recognize their existing colon IDs, but those accounts cannot establish this
new privacy check. The private adapter derives fresh synthetic passwords and a
separate internal Better Auth secret from the private drill token. Keep that
token unchanged for the full fixture. It accepts no separate account selector,
email, password, cookie or credential hash. Reapplication accepts only the exact
synthetic identity inside the preserved receipt. Only the seeded white account
is selected. Maintained Better Auth owns password hashing, sign-in, session
cookies, password checks and sign-out.

One private Competition record retains the prepared cookie, baseline hashes,
native D1 boundary and accepted receipt across D1 rollback. There are at most
eight records, each at most 16 KiB. No cookie, token, password or credential hash
is returned. The accepted opaque closure receipt and boundary belong in the
same owner-controlled private evidence directory used by the other drill
records. The existing separately approved disposal process removes the fixture
stores; this feature schedules no cleanup or provider operation.

Every request below uses the existing private bearer token and `POST /drill`.
Send private JSON files through `scripts/recovery-drill.mjs` as documented above.

1. Seed a fresh rated fixture, finish it by a normal versioned resignation, and
   `flush` until its D1 result is settled and Game delivery is empty. Then send:

   ```json
   {"operation":"privacy","gameId":"<fresh-synthetic-game-uuid>","action":"prepare"}
   ```

   This signs in the existing synthetic white account and calls the ordinary
   password-confirmed profile and participant-game exports. Require
   `exported.profile=1`, `exported.games=1`, `exported.recoveryEmail=null`, retained
   identity/history/watermarks and `oldCookieDenied=false`. The cookie stays
   inside the private Competition record. This operation refuses an active or
   undrained game. Requests with account or password fields are rejected.
2. Capture isolated D1's real native bookmark after preparation and migration
   0014, using `wrangler d1 time-travel info`. Save the provider output privately.
   Then save the following response as a separate private boundary record:

   ```json
   {"operation":"privacy","gameId":"<id>","action":"boundary","d1Bookmark":"<real-native-D1-bookmark>"}
   ```

   Review its exact source, resources, schema hash and baseline. The adapter
   records a supplied bookmark; it cannot verify the provider history itself.
   Local test bookmarks explicitly say they are not provider evidence.
3. Close through the ordinary password-confirmed account lifecycle:

   ```json
   {"operation":"privacy","gameId":"<id>","action":"close"}
   ```

   Preserve the returned `receipt` outside every restore target before any
   native restore. Require zero credential, session and account-owned reset
   rows, one receipt, minimized profile, retained identity/history/watermarks,
   `closedFence=true`, `oldCookieDenied=true` and `signInDenied=true`. The last
   check calls maintained sign-in and requires its normal HTTP 401. A rate-limit
   response is not successful sign-in-denial evidence. A lost closure reply can
   be retried before restoration without accepting a second closure.
4. Preserve the current isolated D1 undo boundary. Perform only the separately
   reviewed native D1 restore to the saved pre-closure bookmark:

   ```sh
   npx wrangler d1 time-travel restore DB --bookmark "$CHESS_RECOVERY_PRIVACY_D1_BOOKMARK" --config wrangler.recovery-drill.jsonc --json
   ```

   Save native restore and undo output privately. Do not restore either DO, run
   `seed`, or reset probes. The existing DO later-work guard would reject a
   pre-closure Competition rollback. Confirm current state using:

   ```json
   {"operation":"privacy","gameId":"<id>","action":"status"}
   ```

   Require the committed closed fence to remain present, while restored D1 has
   the earlier credential/session rows and zero closure receipts. The internal
   old-cookie lookup can now report `oldCookieDenied=false`; no authentication
   endpoint is exposed and no sign-in is attempted in this temporary state.
   Compare the restored native rows with the saved boundary privately.
5. Supply the exact preserved receipt, with its original completion time:

   ```json
   {"operation":"privacy","gameId":"<id>","action":"reapply","privateReceiptSaved":true,"receipt":{"requestId":"<preserved-request-id>","userId":"<preserved-synthetic-user-id>","policyVersion":"account-2026-10-v1","completedAt":0}}
   ```

   Replace every receipt value, including the illustrative `0`, with the
   unchanged values from step 3. The adapter checks its retained receipt and
   closed fence, source/schema, history and journal boundary. It takes a fresh
   D1 identity lease, calls the same idempotent `applyAccountClosure` minimization
   path without a browser session guard, then removes that lease. It preserves
   the already-closed Competition fence. It does not reserve or release a new
   fence and cannot accept a replacement account or closure time.
6. Repeat the exact reapplication request once. Both responses must contain the
   same original receipt, one receipt row, zero credential/session/reset rows,
   minimized profile, old-cookie and maintained sign-in denial, and retained
   identity, historical names/PGN and rating/result watermarks. Keep access
   closed on any mismatch or incomplete set of later closures. Record elapsed
   time, native D1 restore/undo evidence and the unmodified DO boundary. This
   check establishes no multi-store rollback, production restore approval or
   service-wide RTO/RPO.

The local integration test reconstructs only the synthetic pre-closure D1 rows
to protect receipt reapplication, stale-history refusal, duplicate handling and
secret-output boundaries. It does not invoke or simulate a successful native
provider PITR operation. Run the existing local recovery integration command
before reviewing a new sealed candidate; native provider evidence remains a
separate required gate.
