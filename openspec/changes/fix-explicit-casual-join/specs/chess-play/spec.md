# Spec Delta

## Purpose

Human multiplayer play through casual invitations, including when an open seat is claimed from an invitation link.

## ADDED Requirements

### Requirement: Explicit casual invitation join

Opening a valid casual invitation URL while signed in SHALL present a Join confirmation and SHALL NOT claim the open seat until the player explicitly joins. Creating an invitation SHALL place the creator into their waiting board without a Join confirmation. Seat occupancy, invitation expiry, account requirements and participant-only private reads SHALL keep their existing rules.

#### Scenario: Invitee must confirm before claiming the seat

- **WHEN** a signed-in eligible player opens a valid casual invitation that still has an open Black seat
- **THEN** the play page shows a Join confirmation and does not claim the seat until they choose Join
- **AND** after they join, they become Black and see the waiting or ready board for that game

#### Scenario: Creator skips Join after creating an invitation

- **WHEN** a signed-in eligible player creates a casual invitation
- **THEN** they enter the waiting board for that game without a Join confirmation
- **AND** they can copy or share the invitation while the seat remains open

#### Scenario: Signed-out invitee still must authenticate first

- **WHEN** a signed-out player opens a valid casual invitation
- **THEN** the service still requires signup or signin before Join is available
- **AND** the invitation remains available through that authentication flow when it has not expired or been claimed
