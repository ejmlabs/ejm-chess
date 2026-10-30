# Cloudflare provisioning and recovery

Source restored into `ejm-chess` on 2026-10-26. Provider records below are
historical; no live configuration was read or changed for this handoff. The
six private Wrangler configurations are excluded from Git. Restore reviewed
configuration before using deployment commands. See [source handoff](source-handoff.md).

## Status and scope

The recorded protected baseline at `https://chess.ejmlabs.com` used version `[id in private provider record]`, read back on
2026-10-22 at 10:17 UTC. It retains the redesign, 8-character password minimum,
single account-form submit action and signup-attempt enforcement. Its server
bundle is unchanged from the preceding protected revision. The
[provider inventory](provider-inventory.md) retains historical versions and
source hashes. This section records that protected baseline. Final ranked and
arena activation uses a separately checked release build with its own version
readback; source changes and these instructions do not claim publication.

D1 migrations `0001` through `0015` are applied remotely. They include bounded
proof bookkeeping, account-closure fences and the signup-attempt counter.
Migration `0015_signup_budget.sql` passed on 2026-10-21 UTC after a native
Time Travel bookmark was saved. On October 22, the owner enabled 10,000 signup
attempts and games and 5,000 account emails per UTC month, with 100,000 lifetime
signup attempts. The 2026-10-30 demand policy later removed those application
caps; the settings are usage counters only. `NEW_WORK_STOPPED=false`; saved
account/game and email stops are clear. Server analysis remains stopped. The recorded protected version
keeps ranked, tournaments, arenas and browser Stockfish disabled until the final
release. Both `workers_dev` and preview URLs are disabled. The public Worker
CPU limit is 50 ms. Minute and daily cron expressions are configured. Keep
scheduled-execution evidence separate from a saved cron expression.

The initial inventory found no chess Worker or database. The later approved
account token confirmed the existing $5/month Workers Paid subscription and
allowed dedicated provisioning. Email Sending is enabled for the approved
sender domain. The provider added bounce and signing DNS records, kept the
existing Google MX, root SPF and DMARC records, and disabled email body previews.
Protected signup with and without recovery email, live Turnstile, verification,
password recovery and new-password sign-in passed an approved-recipient test.
The old browser session was revoked. The test recorded two email attempts.
Its temporary stops were later cleared under the October 22 policy. See the
[account acceptance boundary](qualification/provider-accounts-20261021.md).
The usage alerts and automatic stop remain enabled. Existing unrelated
resources and alert policies are preserved.

Production `wrangler.jsonc` now binds the dedicated D1 database, restricted
email sender and canonical domain. Public access is protected during release
checks. Queues and server-analysis Containers remain absent. The local
placeholder is confined to `env.local`. The final release keeps the existing
production D1, Game and Competition identities and adds a fresh private
timeout-proof service. Never attach an acceptance namespace to production.

The owner approved one $100 monthly chess target, with alerts and an emergency
stop. Earlier per-service allocations no longer gate launch. Record the exact
release source, bindings and rollback version before a deployment. This guide
does not grant deployment permission. Alerts can lag and accepted work continues;
the target is not a hard Cloudflare invoice cap. See
[budget and admission stops](cloudflare-budget.md).

## Owned resources and access

Keep a private resource ledger with the selected account and zone, returned
resource IDs, purpose, creation approval, bindings, and deployed revision.
Public guides need resource types and intended ownership, not account IDs,
recipient addresses, credentials, or unrelated resource names.

| Resource | Intended chess ownership and initial use |
| --- | --- |
| Worker and static assets | `ejm-chess`, built from this product and its declared public UI packages |
| D1 | A dedicated `ejm-chess` database bound as `DB`; auth, replay, admissions, evidence, and budget records stay together in its checked-in schema |
| SQLite Durable Objects | `Game` through `GAME`, and `Competition` through `COMPETITION`, created by the Worker's `v1` migration |
| Private timeout proofs | `ejm-chess-timeout-proofs`, with a fresh `TimeoutProver` namespace, the same production `DB`, one qualified image instance, and no public route or aliases |
| Custom domain | Only `chess.ejmlabs.com` in the approved `ejmlabs.com` zone |
| Access | One full-host private canary policy and a separate owner policy covering the admin page and API |
| Turnstile | A chess widget restricted to the canonical hostname, with server-side action checks |
| Email Sending | A verified sending domain and `EMAIL` binding restricted to sender `chess@ejmlabs.com` |
| Notifications | Dedicated chess alert policies with approved private recipients and saved configuration readback; inbox delivery remains unverified |
| Optional analysis | Dedicated chess queues and private analyzer namespace/Container only after a separate tested configuration and cost approval; absent initially |

Use the smallest provider permissions that support the approved task. Limit
credentials to the selected account and zone where the provider permits it.
Some provider permissions cover a whole resource family; that does not grant
permission to change unrelated resources.

| Task | Required permission area to confirm before use |
| --- | --- |
| Local build, tests, dry run | No remote write permission |
| Inventory and readback | Read Worker deployments/bindings, D1, relevant namespaces, zone/DNS, Access, Turnstile, sending-domain status, and billing/notifications as needed |
| Create and migrate D1 | D1 create/edit for the selected account and dedicated database |
| Upload Worker, assets, bindings, cron, and secrets | Worker deployment/script and associated namespace/migration permissions for the selected account |
| Canonical domain and sender DNS | The required routing/custom-domain and DNS edit permissions for the approved zone |
| Private canary and admin protection | Access application/policy configuration for the chess destinations |
| Turnstile and email setup | The corresponding widget and Email Sending configuration permissions |
| Alerts | Notification policy/destination configuration and the billing read access needed to verify thresholds |
| Rollback or restore | The specific deployment or storage recovery permission, plus approval for the exact revision or recovery target |

Read the actual permission names and available scopes in the provider before
issuing a token. Do not resolve a permission failure by borrowing another
project's token, database, sender, queue, or Worker. Keep token values in the
approved secret store and out of files delivered with the site.

## Prepare the private canonical host

The only production `AUTH_BASE_URL` is `https://chess.ejmlabs.com`. The
`canonicalOrigin` guard rejects other production origin configurations.
Noncanonical API requests and writes fail; noncanonical page GET/HEAD requests
redirect to the canonical host. A different preview hostname is not a working
private deployment environment for this product.

Before attaching the domain, configure and read back Access protection for the
**entire canonical host**, including static pages, auth callbacks, HTTP APIs,
and WebSocket upgrades. Permit only the approved canary identities. Verify the
edge policy before making the first canonical route reachable. Keep:

```jsonc
"workers_dev": false,
"preview_urls": false
```

Keep those values in every deployed configuration and verify them through the
provider. Do not add a wildcard route or a second public hostname. Preserve
existing DNS, mail, routes, and Access policies outside this chess scope.

Use a separate owner Access application for `/admin`, `/admin/*`, `/api/admin`,
and `/api/admin/*`, with destination rules that cover both page and API paths.
Verify the provider's path precedence and audience selection. Set
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` to that owner application's actual
issuer domain and audience. The application also requires a verified,
nonanonymous account in `OWNER_EMAILS`, and its email must match the verified
Access JWT email. A canary login alone does not grant this application role.

Keep the owner allowlist and actual recipient addresses in private deployment
configuration. Test edge denial and application denial separately. Do not add
a header bypass or enable local mode to recover admin access.

The budget-stop notification endpoint uses a separate secret rather than an
Access browser session. Leave its destination unconfigured during the initial
full-host canary. A later approved, exact-path Access exception for that
endpoint requires separate review and the secret/policy tests in
[budget setup](cloudflare-budget.md#dedicated-automatic-stop-notification).
It must not open the rest of the host.

## Prepare configuration and build

Use Node 24 and the pinned Wrangler dependency from this product. Confirm the
selected account privately before any remote command. Commands below use the
top-level production configuration through `--env ''`; local work continues
to use explicit `--env local` and `--local`.

Prepare a reviewable production configuration with the following initial
values. Keep the reviewed monthly, retained-storage, permanent-ID, queue, and
CPU limits as well.

```jsonc
"AUTH_BASE_URL": "https://chess.ejmlabs.com",
"LOCAL_DEV": "false",
"OPERATION_MODE": "unattended",
"NEW_WORK_STOPPED": "true",
"RANKED_ENABLED": "false",
"TOURNAMENTS_ENABLED": "false",
"ARENAS_ENABLED": "false",
"ANALYSIS_ENABLED": "false",
"AI_ENABLED": "false"
```

Those values describe the initial stopped deployment. Current checked-in
production settings have `NEW_WORK_STOPPED=false` and practical monthly
allowances; game feature flags remain closed in the recorded protected build.
The final qualified release enables ranked, tournaments, arenas and browser
Stockfish. Keep server analysis disabled. A stop preserves accepted games,
clocks, result delivery, replay, receipts and scheduled recovery.

Run the normal checks and finish the frontend build before the Worker dry run:

```sh
npm run typecheck
npm test
npm run build
npm run worker:check
npm run budget
```

Record the product/shared-owner revisions, any dirty-source patch, lockfiles,
test results, route bytes, artifact hashes, and unrun gates. Inspect the built
guides and static assets. A successful local result is not a production result.

Then refresh the remote inventory without mutations. Read back the selected
account/zone, existing chess names, domain/routing conflicts, subscriptions,
sending-domain status, Access policies, and notification permissions. If a
chess resource already exists, establish its ownership and current data before
reusing it. Keep all unrelated resources intact.

Present the concrete configuration, resource list, caps, cost assumptions,
private canary protections, rollback choice, and remaining gates for the exact
deployment approval. Run the remote steps below only within that scope.

## Provision approved bindings and secrets

### Dedicated D1 and additive migrations

Create a dedicated database only if the fresh inventory confirms it is absent:

```sh
npx wrangler d1 create ejm-chess --env '' --update-config=false
```

Read back its returned identity and record it privately. Add the returned ID
to the top-level binding, keeping the local placeholder confined to `env.local`:

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "ejm-chess",
  "database_id": "<returned-chess-database-uuid>",
  "migrations_dir": "migrations"
}]
```

The placeholder above is not a deployable ID. Verify the account and actual
binding again before remote migration:

```sh
npx wrangler d1 info ejm-chess --env '' --json
npx wrangler d1 migrations list DB --remote --env ''
npx wrangler d1 migrations apply DB --remote --env ''
npx wrangler d1 migrations list DB --remote --env ''
```

Apply the checked-in migrations in order. Keep earlier migration files and
the provider migration ledger. Existing databases need a private backup and
compatible additive migration review before application. Do not reset tables,
rewrite accepted migration history, or import local fixtures into production.

Keep the existing `GAME` and `COMPETITION` bindings, class names, and `v1`
`new_sqlite_classes` migration. The first approved Worker deployment applies
that namespace migration. Future changes append reviewed migration tags.
Do not rename/delete namespaces, change script ownership, or introduce a new
global Competition identity to work around existing state.

### Email, Turnstile, and the canonical domain

Complete Email Sending onboarding for the approved domain. Review the exact
DNS records with their owner, preserve existing mail service, and read back
provider verification. Set `EMAIL_FROM=chess@ejmlabs.com` and use the native
structured Email Sending binding:

```jsonc
"send_email": [{
  "name": "EMAIL",
  "allowed_sender_addresses": ["chess@ejmlabs.com"]
}]
```

The current Workers Email Sending API accepts structured `from`, `to`,
`subject`, and `text` fields, matching the existing auth transport. There is no
MIME dependency to add. A typecheck or local mock does not establish beta
access, a verified sender, delivery quotas, or inbox delivery. Keep mail closed
until the real binding and an approved inbox are tested.

Configure a Turnstile widget for `chess.ejmlabs.com`. Put its public site key in
`TURNSTILE_SITE_KEY` and its private verification key in secret storage. Verify
the deployed `sign-up`, `sign-in`, `password-reset`, `verify-email`,
`account-complete` and `report` actions and hostname. The
loopback-only development marker is not accepted on this host.

After full-host Access protection is ready, prepare only this custom domain:

```jsonc
"routes": [{ "pattern": "chess.ejmlabs.com", "custom_domain": true }]
```

Verify any existing record before applying this change. Do not replace another
service's record or make a wildcard zone change. Read back the resulting Worker
domain, DNS/TLS state, Access coverage, and disabled provider aliases.

### Secrets and first deployment

Prepare `AUTH_SECRET` with at least 32 random characters and the Turnstile key
in an approved private secret file outside the repository, `dist`, and capture
artifacts. Keep file permissions limited to its owner. Include the private
owner Access configuration and allowlist through the approved deployment
secret/configuration path. Do not place secret values in Wrangler `vars`,
command arguments, shell history, logs, screenshots, or chat.

Pinned Wrangler 4.151.3 supports `deploy --secrets-file` for JSON or `.env`
input, applied additively. Set `CHESS_SECRETS_FILE` to that private file's path
through the approved local/CI setup. Refresh the dry run after binding edits,
review its output, and confirm the approved inventory and Access policy once
more. Then perform the approved deployment:

```sh
npm run worker:check
npx wrangler deploy --env '' --strict --secrets-file "$CHESS_SECRETS_FILE"
```

Keep analysis queues and Containers absent. Keep both cron expressions and the
accepted-work recovery bindings intact. Do not run a Container rollout as an
incidental part of this first deployment.

For a later approved secret rotation, use hidden input and read back names,
not values:

```sh
npx wrangler secret put AUTH_SECRET --env ''
npx wrangler secret list --env ''
```

Record the resulting deployed version and assess session/sign-in impact before
rotating auth secrets. Do not let a secret command silently create an
unreviewed placeholder Worker. Do not delete omitted secrets or change another
Worker's configuration.

## Read back the stopped canary

Save the actual Worker version, deployment, resource bindings, D1 migration
state, namespace identities, routes, cron, limits, and stop flags privately.
Read-only Wrangler commands include:

```sh
npx wrangler deployments list --env '' --json
npx wrangler versions view "$CHESS_DEPLOYED_VERSION" --env '' --json
npx wrangler d1 info ejm-chess --env '' --json
npx wrangler d1 migrations list DB --remote --env ''
npx wrangler secret list --env ''
```

Use the actual recorded version for `CHESS_DEPLOYED_VERSION`. Provider
readback must confirm `workers_dev=false`, `preview_urls=false`, full-host
Access, the separate admin audience, the sole canonical domain, and disabled
feature flags. Check unauthenticated denial before using any canary session.
Check static and API security headers separately, then canonical HTTPS/TLS,
same-origin cookies and WebSocket admission. Verify scheduled recovery from
real trigger evidence; a saved cron expression is not execution evidence.

The initial global stop also prevents verification and password-recovery sends. A later approved mail
canary must preserve game and analysis denial while allowing a small number of
email attempts. Set the versioned game and analysis stops, or
`NEW_WORK_STOPPED=true`, keep every feature gate false, choose the approved
small email allowance, then clear the global stop for that protected test.
Monthly limit settings are usage counters only. Record this separate
configuration change and restore the global stop afterward.

Use only the approved canary inboxes. Create explicit username/password accounts
with and without recovery email. Confirm that email is optional for player
eligibility, that no-email accounts cannot create recovery mail or tokens, and
that supplied addresses stay private. For accounts with a real email,
verify actual verification/recovery delivery, expiry for both token types,
idempotent verification, reset replay denial and reset session revocation,
and establish the matching verified owner session.
Check the additive username migration and guest-history preservation described
in [accounts](accounts.md). Once admin access
works, read and change D1 stops through the versioned Operations controls.
Do not bootstrap access through hand-edited account verification or fake
Access headers. A later gameplay canary needs its own explicit feature, unit,
participant, and recovery scope.

Configure and verify dedicated billing alerts as described in
[budget setup](cloudflare-budget.md). Record policy support, thresholds,
destination association, enabled state, delivery, shared-account costs, and
the fixed fee allocation. A Save/Test notification alone is not proof of a
real billing policy or automatic dollar stop. Delayed usage reporting, public
traffic, subscriptions, storage, and accepted work can exceed the envelope.

Keep public ranked admission, large arenas, analysis, shared project discovery,
and release claims closed until their own documented gates pass. Remove the
full-host canary restriction only under the approved release scope, retaining
the owner protection on admin page/API paths.

## Rollback and recovery

### Stop before changing a running service

Use the versioned Operations stop controls where available, record their
version and flags, and set `NEW_WORK_STOPPED=true` through the approved
configuration path if needed. Preserve Access, alarms, cron, bindings, current
state, and pending work. Record deployment IDs and capture a fixed-watermark
private authority export using the existing
[operations workflow](operations.md#export-the-authority-event-journal).

Never clear a permanent ID, budget receipt, accepted result, command receipt,
reservation, pending outbox, rating event, or tombstone to make a rollout pass.
A code rollback is not a database restore and must not erase accepted work.

### Choose a compatible code revision

Compare the candidate revision with the current D1 schema, DO classes and
migrations, rules versions, terminal/export formats, budget stops, and outbox
wire contracts. Use only a known compatible version. Provider rollback support
and migration restrictions must be checked for the actual deployment.

When those checks and the exact rollback target are approved, the native
command is:

```sh
npx wrangler rollback "$CHESS_ROLLBACK_VERSION" --env '' --message "Approved chess recovery rollback"
```

Use the recorded compatible version ID. If native rollback is unavailable or
would drop required safety behavior, prepare a compatible forward fix with new
admission stopped. A blind return to an older build can reopen work or stop
accepted result delivery.

After either path, read back the actual version, secrets/bindings, routes,
Access, cron, and effective stops. Reconcile accepted events with the current
Game and Competition authorities. Retry through their idempotent outboxes.
Preserve original clocks and outcome deadlines. Do not grant a winner or
rewrite one player's rating to compensate for deployment failure.

### Full restore remains a separate gate

Read-only native Game/Competition capture hooks and admitted-ID inventory are
implemented behind the existing owner and Access checks. The separate
`wrangler.recovery-drill.jsonc` entry point contains the only restore/restart
hooks, on separate rehearsal classes and D1 resources. Its current resource IDs
name the isolated rehearsal. Review the exact targets, source and manifest
before every provider run; a configured ID does not authorize a restore. Follow
the [recovery drill guide](recovery-drill.md) for exact provisioning, private
invocation, manifest approval, D1-before-DO restore, undo and local checks.
The dated [provider report](qualification/provider-recovery-20261021.md) records
completed and active casual-game restores, held acknowledgement recovery,
ranked correction replay, positive budget receipts, naturally aged tombstones
and complete native undo in the isolated resources. The separate
[privacy report](qualification/provider-privacy-20261021.md) records a D1-only
rollback followed by two reapplications of one saved closure receipt. These
bounded drills do not establish production recovery or a service-wide
recovery objective.

D1 Time Travel, D1 SQL export, and SQLite Durable Object point-in-time recovery
are provider tools, not a transaction across this service's stores. Confirm
plan access, retention windows, private storage, and exact supported recovery
operations before relying on them. Inspect the native recovery boundary with:

```sh
npx wrangler d1 time-travel info DB --env '' --json
```

Native provider history is not an independent downloaded backup. A SQL export
is a separate private copy and needs its own explicit approval, destination,
access and expiry. This runbook requires and authorizes no production
account/session SQL export. Synthetic isolated drills may use approved private
exports. Never put such files in public artifacts, fixtures, source or builds.
A D1 export does not capture Game objects or the Competition authority.

Rehearse a full restore on isolated, approved resources before production use:

1. Preserve the current stores, deployable code/configuration, and secret
   references. Record D1/DO recovery boundaries and the authority watermark.
2. Enumerate Game IDs from the permanent admission ledgers. Capture supported
   DO recovery bookmarks and preserve archived tombstones as well as active
   clocks, accepted commands, and result delivery.
3. Preserve all later closure receipts outside the restore targets. Restore D1
   and the authorities coherently. Reapply later closures through the idempotent
   lifecycle adapter and reconcile Competition fences before authentication or
   admission reopens. Keep access closed if the closure set is uncertain.
   Reconcile accepted work after the selected boundary through normal outbox
   and correction paths.
4. Verify accounts, sessions, seat ownership, immutable results, rating epochs,
   replay, reservations, and budget receipt totals. No permanent ID may vanish
   or be reused; no accepted event may be lost or applied twice.
5. Check minute/daily maintenance, reconnect, overdue outcomes, correction
   recovery, and private exports. Establish measured recovery time and data-loss
   bounds before reopening work.

This repository does not establish a complete cross-store restore coordinator,
production restore drill, an independent production backup, or measured recovery
objective. Keep full-service restore and public launch gates open. Do not run
a production Time Travel/DO restore, delete a namespace, or swap a database
binding as an unreviewed rollback step.

## References and verification limits

The command forms above were checked against pinned Wrangler 4.151.3 help.
The status section records completed provisioning and the initial stopped
protected deployment. Command examples elsewhere are instructions, not evidence
that each action ran. The approved recipient completed verification and password
recovery; the budget callback destination and association passed their bounded
test. The dated recovery and privacy reports record the extended isolated
native restores, undo and one account's closure reapplication. The separate
proof report records 31 native corpus/cold transport cases and partial usage.
Broad mail delivery, actual scheduled execution, a real billing threshold
event, service-wide recovery acceptance, regional behavior and complete
operating cost remain open.
Refresh the deployed revision, migration ledger and effective stops before any
later approved update.

- [Wrangler email binding configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#email-bindings)
- [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Email Sending binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
- [Email Sending onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Billing notifications](https://developers.cloudflare.com/billing/notifications/)
- [Notification webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [SQLite Durable Object point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)
