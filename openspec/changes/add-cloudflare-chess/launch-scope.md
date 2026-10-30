# Authorized launch continuation

Historical authorization record. See [the current handoff](HANDOFF.md) for
source recovery, the latest stopped runs and the remaining launch gates.

On 2026-10-20 the owner requested: "we need to implement ranked and the rest of
the tasks" and "then we need to go live". This authorizes completing the existing
change and deploying the verified chess product. It supersedes the earlier
local-only boundary for the necessary chess release work. It does not waive
the remaining correctness, privacy, cost, recovery or capacity gates.

## Owners and scope

- Product source belongs to its own repository and consumes public exports
  from its declared ejm-ui checkout. The historical temporary checkout is gone;
  the current handoff records retained source recovery. This planning home owns
  tracking, baseline reconciliation and studio adoption. Preserve all other work.
- Use only the selected Cloudflare account and its existing `ejmlabs.com` zone.
  Create dedicated chess resources. Do not modify another product's resources,
  subscriptions, mail routing, alerts or Access policies.
- Initial deployment uses a protected `chess.ejmlabs.com` canary. Public aliases
  stay disabled. Keep ranked and new work closed while checking deployment,
  recovery, mail, cost and capacity. Open the approved features only after their
  gates pass, then verify the public host and guides before studio discovery.
- The approved budget remains $100 per month. Workers Paid already exists.
  Keep conservative application quotas and preserve accepted work when stopped.
  The notification thresholds are kept in the private provider record in account-wide usage
  charges. These delayed notices cannot enforce a hard invoice cap.
- Sender remains `chess@ejmlabs.com`; delivery tests and budget alerts use the
  previously approved private owner address. Recovery email stays optional.
  Use only security email, never marketing. Preserve existing domain mail DNS.
- Use the approved locally stored Cloudflare credential. Its
  credential stays in process memory and child environments, outside source,
  outputs and delivery. Generate independent auth and webhook secrets.
- Browser Stockfish remains a maintained, pinned, same-host engine loaded
  automatically only for computer play. No separate application install or
  external model service is required. Do not fork the engine without a need.

## Review and evidence

Start from 50/62 tasks complete. Read back provider changes and record resource
ownership, configuration, deployment identities and sanitized verification.
Measure the existing large-event targets without changing them into capacity
claims. Keep unresolved gates unchecked. Restore drills use isolated resources;
never replace accepted production data with an older snapshot. Preserve prior
immutable deliveries. Sync/archive only after all required work is verified.

## Planning location, 2026-10-26

The owner corrected the PR destination to `ejmlabs/ejm-chess`. The recovered
product source and this existing planning root now live in the product owner
repository. Read [the relocation record](../../RELOCATION.md) and
[current handoff](HANDOFF.md). This supersedes earlier location and no-root
guidance only; launch scope, budgets, gates and task status remain unchanged.
Shared UI and Studio changes still belong to their respective owners.
