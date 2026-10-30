# Live-ready prep (canary checklist paused)

Recorded 2026-10-30. Protected canary player checklist steps 8+ stay paused.
This note tracks offline prep for the ranked-inclusive critical path. It does
not mark OpenSpec tasks complete and does not authorize live tests or ranked
enablement.

## Critical path reminder

1. Canary player proof (**7.1** / **3.6**) — **paused**
2. Ops / privacy readiness (**6.2** / **6.3**)
3. Timeout proofs (**3.8**) then ranked gate (**7.2**)
4. Ranked docs verify (**4.5**) and discovery (**7.3**)

Follow-up load tasks **6.4**, **10.4**, **18.3–18.5** stay off this spine except
where **7.2** needs a first-tier run result.

## Prep status

| Area | Offline prep | Still needs live |
| --- | --- | --- |
| Specialty Wrangler templates | `config-examples/*.example.jsonc` + copy README | Private ID fill-in, deploy, dry-run against provider |
| Timeout-proof public status JSON | `public/qualification/timeout-proofs.json` (honest default-off) | Provider corpus, tier pin, proof-acceptance re-run |
| Ranked player/ops docs | Color balance + examples in Guide / architecture; ops cross-links | Two-session verify of game/history/leaderboard (**4.5**) |
| Provisioning checklist | [Below](#provisioning-checklist-62) | Fresh Paid/Email/DNS/alert inbox readback |
| Privacy / stops / closure | Code and docs present under 2026-10-30 policy | Stop-webhook / restore / outage drills; recovery-drill config with real IDs |
| ejm-ui discovery | Chess stays `discoverable: false` on `wip/preserve-all-20261025`; draft guide URL inventory below | Flip + Studio publish only after public open |
| OpenSpec checkboxes | Left unchecked | Check only from verified live results |

## Provisioning checklist (6.2)

| Check | Offline note | Live verify later |
| --- | --- | --- |
| Workers Paid on chess account | Historical inventory recorded Paid subscription | Confirm current plan and permissions |
| Email Sending + DNS for `chess@ejmlabs.com` | Documented in deployment guide; approved-recipient test 2026-10-21 | Re-check DNS/signing/bounce and a live verification mail |
| Turnstile on `chess.ejmlabs.com` | Bound in production `wrangler.jsonc` | Challenge success on canary session |
| Access full-host + admin policy | Canary remains Access-protected | Owner session still required |
| Budget alerts + `$85` stop webhook | Policy docs; application monthly caps off | Inbox delivery of an alert still unverified |
| Canary deploy scope | Worker `6aa3ef0c…` includes Join + material timeout | Checklist 8+ and release readback |
| Analysis cold-start costs | Analysis stays disabled | Measure only if analysis is approved |
| Cost estimate vs $100 target | See [cost estimate](cost-estimate.md) and [budget](cloudflare-budget.md) | Update from current invoice/alerts before ranked open |

## Specialty config reconstruction order

1. Copy examples from `config-examples/` (see that README).
2. `wrangler.recovery-drill.jsonc` — enables local recovery Vitest config path.
3. `wrangler.proof-acceptance.jsonc` — unarmed until reviewed seal; needed before proof-acceptance re-run.
4. `wrangler.proof-qualification.jsonc` — isolated corpus harness; fresh non-production resources only.
5. `wrangler.proof-service.jsonc` — private production prover; Container only after tier qualification.
6. `wrangler.capacity.jsonc` — keep exact unsealed example until a seal review rewrites private IDs.

## Discovery draft inventory (7.3, unpublished)

Keep `PROJECTS.chess.discoverable === false` until public open is approved.
Intended chess guide destinations once the host is public:

| Label | Path on `chess.ejmlabs.com` |
| --- | --- |
| Help | `/help/` |
| Rules | `/rules/` |
| Fair play | `/fair-play/` |
| Privacy | `/privacy/` |
| Developer guide | `/docs/developer-guide/` |
| Timeout-proof status | `/qualification/timeout-proofs.json` |

Studio / `ejmlabs` Projects row, Play action, marks and shared-registry adoption
stay drafted offline on the sibling UI/Studio owners. Do not merge discovery
enablement for the protected canary alone.

## When unpausing live work

1. Finish canary checklist + record in `verification.md`.
2. Reconstruct specialty configs from private inventory.
3. Run proof qualification / acceptance against material-timeout expectations.
4. Complete **6.2** / **6.3** live rows above.
5. Open ranked only through **7.2**; then verify **4.5** and publish **7.3**.
