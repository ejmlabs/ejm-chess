# Proposal

## Why

`npm run build` and `npm run budget` call `ejm-ssg budget`, which `@ejm/ssg` on ejm-ui `main`
removed (ejm-ui #35). Once the sibling `../ejm-ui` checkout is on `main`, the build exits with an
unknown-command error after a successful prerender, and the documented check list fails. The same
change removed the `budget` option of `defineSite`, which `src/site.tsx` still passes, so
`npm run typecheck` fails with TS2353.

## What Changes

- `package.json`: `build` ends after `ejm-ssg build`; the `budget` and `budget:guides` scripts are
  removed.
- `src/site.tsx` drops the `budget` option from `defineSite`.
- The README, `docs/deployment.md`, `docs/operations.md` and the public guide page in
  `src/pages/Guide.tsx` stop listing `npm run budget` and stop describing size budget checks.
- The lockfile is refreshed if the ejm-ui link targets' manifests changed, with no other dependency
  movement.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. No spec under `openspec/specs/` describes size budgets, so this change sets `skip_specs`.

## Impact

- Build configuration and contributor docs only. No route, Worker, rule or data behavior changes.
- Order: land this after ejm-ui's `add-chess-board` change is on ejm-ui `main`, and move the
  sibling `../ejm-ui` checkout to `main` before building, because the `file:` links resolve to
  whatever that checkout holds.

Out of scope:

- A replacement performance gate. ejm-ui measures load time with `scripts/perf.mjs` against a
  baseline each product keeps; recording one for this site is a separate change.
- Historical run records, such as `docs/provider-inventory.md`, which describe what ran at the time.
- The in-flight `add-cloudflare-chess` change's artifacts, which mention a budget pass in their plan.
