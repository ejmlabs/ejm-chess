# Tasks

## 1. Test narrowing

- [x] 1.1 Replace the `expect(...).toContain(queue.status)` line in `test/replay-api.test.ts` with the guard pattern from `test/competition-policy.test.ts:56`, and verify `npx tsc -p tsconfig.worker.json` reports no errors
- [x] 1.2 Verify `npx vitest run test/replay-api.test.ts` passes, using the local uncommitted `wrangler.jsonc` linked read-only and removed afterwards

## 2. Finish drop-size-budget

- [x] 2.1 With the sibling `../ejm-ui` on `main`, run `npm run typecheck`, `npm test` and `npm run build`, verify each passes, then tick `drop-size-budget` tasks 1.3 and 3.1

## Workflow follow-up

- Archive this change and `drop-size-budget` in the same PR.
