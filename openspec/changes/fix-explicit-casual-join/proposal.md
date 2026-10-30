# Proposal

## Why

Opening a casual invitation URL while signed in flashes a "Join game" screen and then auto-claims the seat. Canary testing and real invitees need an explicit Join action so both players control when they enter the board.

## What Changes

- Stop auto-POSTing `/api/games/:id/join` when `/play/?game=` loads for a signed-in account.
- Keep the Join game screen until the invitee clicks **Join game**.
- After **Create invitation**, put the creator straight into their waiting board (copy-link / waiting UI) without a Join intermediary.
- Preserve existing API seat rules, expiry, and occupied-seat rejection; this is a client admission UX fix.
- Refresh player-facing copy only if the Join waiting state needs clearer instruction.

## Capabilities

### New Capabilities

- `chess-play`: Explicit casual invitation join confirmation before claiming an open seat from an invitation URL.

### Modified Capabilities

- (none in `openspec/specs/`; `chess-play` is not archived to main specs yet. The broader play capability remains in `add-cloudflare-chess`. This change adds the join-confirmation requirement.)

## Impact

- `src/pages/Play.tsx` join/`joinedId`/`joinAttempt` flow.
- Possible small guide/help wording if it implies auto-join.
- Worker `/api/games/:id/join` contract unchanged.
- No schema, binding, Access, or feature-flag changes.
- Protected canary verification for invite → join → ready becomes reliable.
