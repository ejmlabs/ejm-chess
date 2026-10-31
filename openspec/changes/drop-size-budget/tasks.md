# Tasks

## 1. Scripts

- [x] 1.1 Remove `&& npm run budget:guides` from `build` and delete the `budget` and `budget:guides` scripts in `package.json`, and verify `git grep -n "ejm-ssg budget"` finds nothing outside archived OpenSpec changes and `docs/provider-inventory.md`
- [x] 1.2 Refresh `package-lock.json` with `npm install --ignore-scripts --no-audit --no-fund` against ejm-ui with `add-chess-board`, and verify the lock diff is limited to the `../ejm-ui/packages/*` entries
- [ ] 1.3 Remove the `budget` option from `defineSite` in `src/site.tsx`, and verify `npm run typecheck` passes with no TS2353 error

## 2. Docs and guide page

- [x] 2.1 Drop `npm run budget` and the size budget sentences from `README.md`, `docs/deployment.md` and `docs/operations.md`, and verify `git grep -n "npm run budget"` finds only historical records
- [x] 2.2 Drop `npm run budget` and "bundle budget checks" from the local development section of `src/pages/Guide.tsx`, and verify the prerendered guide page lists the remaining commands

## 3. Verification

- [ ] 3.1 Against ejm-ui with `add-chess-board`, run `npm run typecheck`, `npm test` and `npm run build`, and verify each passes (if the Stockfish assets or Wrangler configuration are absent, report which steps did not run)

## Workflow follow-up

- Open the PR after ejm-ui's `add-chess-board` PR, and merge it once that one is on ejm-ui `main`.
- Archive the change after merge.
