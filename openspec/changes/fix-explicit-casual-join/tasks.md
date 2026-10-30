# Tasks

## 1. Client join admission

- [x] 1.1 Change `src/pages/Play.tsx` so a signed-in invitee on `/play/?game=` sees Join and does not POST join until they click **Join game**; verify by loading an invitation URL signed-in and confirming no seat claim until the click.
- [x] 1.2 After **Create invitation** (and computer create if it shares the path), enter the creator’s waiting board immediately without a Join screen; verify the creator sees copy-invitation / waiting UI and remains White.
- [x] 1.3 Keep signed-out invitees on signup/signin first, then Join; verify an open invitation still accepts Join after auth when unclaimed and unexpired.

## 2. Verification

- [x] 2.1 Run focused Worker/admission tests that cover join, occupied seat and expired invitation (`npm test` or the project’s focused vitest files for admission/worker); verify they still pass with unchanged API behavior.
- [x] 2.2 On the protected canary or local preview, re-check invite → explicit Join → both Ready → one move each; verify no auto-dump through the Join screen.
- [x] 2.3 Update `docs/verification.md` with the join UX check result when the canary retest is done; verify the note names explicit Join and the date.

## Workflow follow-up

- Merge or rebase with `add-cloudflare-chess` / main as needed so the `chess-play` join requirement lands cleanly beside the broader play specs.
- Archive this change after apply and canary confirmation (`/opsx-archive`).
