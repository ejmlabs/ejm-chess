# Spec Delta

## MODIFIED Requirements

### Requirement: Direct guide links

The studio site SHALL offer a user guide and a developer guide for ejm-cli, ejm-harness, and ejm-ide. Each link SHALL open the corresponding guide on that project's domain. Once chess and its guides are published and checked, the studio SHALL also link to the chess player guide and developer guide on `chess.ejmlabs.com`.

#### Scenario: Find a project guide

- **WHEN** a visitor opens the studio documentation section
- **THEN** each published project has named user or player and developer guide links
- **AND** the links use the project's canonical domain

#### Scenario: Find chess rules and contribution guidance

- **WHEN** chess has been released and its guide destinations have been verified
- **THEN** the studio documentation section links to the chess player guide and developer guide without replacing the existing six product guide links

## ADDED Requirements

### Requirement: Chess owns its guides

The chess product SHALL own its player, developer, fair play, privacy, and operations documentation and build checks. Player guidance SHALL cover time controls, online adjudication, reconnects, ranked eligibility, ratings, reporting, and appeals. Developer guidance SHALL cover setup, public APIs, deployment, data recovery, and measured service limits.

#### Scenario: Player opens fair play guidance

- **WHEN** a player follows the chess guide's fair play link
- **THEN** the published policy explains permitted play, reports, review, appeals, retained data, and detection limits without exposing private detection thresholds or credentials

#### Scenario: Contributor prepares a release

- **WHEN** chess behavior or configuration changes
- **THEN** its guides, examples, navigation, API reference, and relevant recovery steps are updated and checked with the owning product build before publication is claimed
