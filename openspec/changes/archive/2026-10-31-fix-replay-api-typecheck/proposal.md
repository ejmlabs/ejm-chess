# Proposal

## Why

`npm run typecheck` fails in its worker pass with one error, TS2339 at
`test/replay-api.test.ts:95`: `queue.gameId` is read after
`expect(['reserved', 'live']).toContain(queue.status)`, which does not narrow the
queue state union. It also fails on `main`, so the typecheck has not passed since the
earlier TS2353 that hid it was removed in `drop-size-budget`, whose tasks 1.3 and 3.1
wait on it.

## What Changes

- `test/replay-api.test.ts` narrows `queue` with the guard
  `test/competition-policy.test.ts` already uses
  (`if (state.status !== 'reserved' && state.status !== 'live') throw ...`), so the
  test still fails with a clear message on any other state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. A test's type narrowing changes no behavior a spec describes, so this change
sets `skip_specs`.

## Impact

- One test file. No server code, types or rules change.

Out of scope:

- Loosening the queue state types or changing `joinQueue`.
