# ejm-chess

Build the simple multiplayer chess product described by the local
`openspec/changes/add-cloudflare-chess/` plan. On 2026-10-26, the owner corrected
repository placement to `ejmlabs/ejm-chess`. This repository now owns the migrated
OpenSpec root, implementation and product guides. Earlier references to the
Lab planning home are historical. Read `openspec/HANDOFF.md` before resuming.
Keep unfinished tasks unchecked and follow the existing OpenSpec workflow.

- Never use em dashes. Write plain, clear text.
- Keep runtime, CPU, memory, bundles, storage, and dependencies small within correctness and security. Measure before claiming speed or capacity.
- Use maintained chess.js, cm-chessboard, Better Auth, Glicko-2, and platform APIs through thin product adapters. Do not replace them with custom engines, credentials, or ratings.
- Consume public `@ejm/*` exports through declared dependencies. Shared visuals and site infrastructure belong in ejm-ui. No private sibling imports or harness dependency.
- Use ejm-ui throughout every route, including board and clock surfaces, prose, fields, actions, tables, disclosures, and states. Add missing visual contracts in the shared owner. Product components compose public exports, semantic HTML, and layout; they do not recreate visual primitives or override kit appearances. Chess rules, time estimation, account policy, and authoritative commands stay in the product.
- Use the shared Manrope and IBM Plex Mono fonts and token palette. No cards or decorative panels. Center the board, clocks, and moves.
- The server owns seats, history, clocks, legal moves, results, and ratings. Keep duplicate commands and result delivery idempotent.
- Require explicit username/password accounts for new games. Preserve legacy guest seats and history without promoting identities. Recovery email is optional at signup and for player competition. Use supplied private email for verification and recovery only, with no marketing; explain the lost-password limit when skipped. Keep internal placeholder addresses private and out of token/mail work. Competition requires eligible credential-backed accounts; owner administration retains real verified-email and Access checks. Keep ranked admission closed until the documented launch gates pass.
- Default to unattended operation. Reports and engine summaries are informational. Only exact `OPERATION_MODE=reviewed` permits new corroborated human case decisions. Never convict, restrict, or remove ratings from accuracy, shared IP, focus, or report counts alone.
- Resolve unknown timeout adjudication as an unrated technical void after 30 seconds. Recover deadlines and outboxes automatically; never invent a winner.
- Retire only proved finished unrated Game payloads after one hour, with no active seats, delivery, AI work, or evidence/appeal hold. Keep permanent Game tombstones, D1 ID ledgers, replay, and immutable rating history. Never recycle IDs, use deleteAll, or reset safety caps to hide growth.
- Protect real behavior and concrete failure risks with focused tests. Do not mirror implementation or test a dependency for its own sake.
- Keep product guides and operational limits current. Separate implemented, locally tested, staged, and released behavior.
- Preserve others' work. Do not create a remote, push, provision paid resources, or deploy without the required owner authorization.

## Less text, clear meaning

Use the fewest words that preserve meaning. Prefer a clear visual, or no added
content when context already explains the task. Keep meaningful labels,
accessible names, consent and security facts, honest state, and recovery steps.
Avoid cryptic icons and meaning conveyed only by color. Reveal supporting detail
when needed; keep operational docs complete.
