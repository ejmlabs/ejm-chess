# Design

## Context

See `proposal.md` for motivation. `Play.tsx` today runs a `useEffect` that POSTs join whenever `id` (from `?game=`) and a signed-in `me` are set, so the Join button is raced by automatic admission. Create invitation calls `openGame(created.id)`, which trips the same effect.

## Goals / Non-Goals

**Goals:**
- Gate invitee seat claim on an explicit Join click.
- Keep creator (and shared create paths) on the waiting board immediately after create.
- Leave Worker join semantics unchanged.

**Non-Goals:**
- Ranked queue / tournament admission UX.
- Changing invitation expiry, occupancy, or auth requirements.
- Removing the Join screen for invitees.

## Decisions

1. **Join effect only after explicit intent**  
   Drive the join/fetch effect from a user intent signal (existing `joinAttempt` or equivalent) so `joinAttempt === 0` shows Join and does not POST. Clicking Join increments intent and runs the existing join request.  
   *Alternative considered:* probe with GET then auto-join if empty — rejected; still claims without confirmation and adds a race.

2. **Creator bypasses Join via direct seat entry**  
   After successful create, set `joinedId` from the create response (or bump join intent in the same turn) so the waiting board mounts without a Join flash.  
   *Alternative considered:* require creators to click Join too — rejected for canary and normal create flow.

3. **API unchanged**  
   Continue using POST `/api/games/:id/join` for invitees and existing error mapping for unavailable/archived games.

## Risks / Trade-offs

- **[Risk] Refresh on an already-joined game shows Join again** → Mitigation: Join remains idempotent for a seated participant; one click returns them to the board. Optional later: GET-first to detect an existing seat and skip Join.
- **[Risk] Deep links bookmark Join forever** → Mitigation: intended; confirmation is the product rule.

## Migration Plan

- Ship with the next Worker/assets deploy of this client change.
- No migration, secret, or Access change.
- Rollback: redeploy prior assets; API remains compatible.

## Open Questions

None.
