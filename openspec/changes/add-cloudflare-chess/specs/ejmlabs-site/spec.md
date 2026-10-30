# Spec Delta

## MODIFIED Requirements

### Requirement: Home page

The home page SHALL lead with display type, public project copy and direct actions, SHALL NOT show project previews or simulated product windows, SHALL list ejm-cli, ejm-ide and ejm-harness as external rows to their own sites, use a Sage band, and end with the Ink footer. Once chess is publicly released and its destination verified, it SHALL also list chess as an external row to its canonical site.

#### Scenario: No imitation on the home page

- **WHEN** the home page is parsed
- **THEN** it contains no simulated product window

#### Scenario: Project rows

- **WHEN** the home page is parsed
- **THEN** the CLI, IDE and harness project links continue to point to their own ejmlabs.com subdomains and carry `rel="external"`

#### Scenario: Project marks beside names

- **WHEN** a visitor reads Current projects at phone or desktop widths in either page theme
- **THEN** each name has its approved mark beside it with clear contrast on Sage, reserved dimensions and one accessible project link without a duplicate image label

#### Scenario: Chess is ready for discovery

- **WHEN** the chess product has been published and its canonical destination verified
- **THEN** Current projects includes a chess link to `https://chess.ejmlabs.com` with `rel="external"`, without removing the existing projects

## ADDED Requirements

### Requirement: Accurate chess discovery

Chess discovery SHALL describe a multiplayer browser game and use a Play action to its verified canonical site. Its status, source access, license, and availability SHALL match the product's published facts. It SHALL NOT inherit coding-tool setup instructions, simulated showcase links, or claims that every studio project has the same license.

#### Scenario: Chess project action

- **WHEN** a visitor opens the published chess entry on Projects
- **THEN** its primary action opens the real game, its copy states any beta limits, and guide links lead to verified chess-owned pages

#### Scenario: Chess has not been released

- **WHEN** the chess destination is not yet published and checked
- **THEN** studio source changes are kept unpublished or clearly label the project as planned without an active Play claim

#### Scenario: Shared packages support an unreleased chess identity

- **WHEN** the studio rebuilds against shared packages that include the unlaunched chess identity
- **THEN** shared cross-site navigation omits chess until its product and guide destinations are published and verified
