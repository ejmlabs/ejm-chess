# Spec Delta

## MODIFIED Requirements

### Requirement: Worldwide public access

The public hosts `ejmlabs.com`, `ide.ejmlabs.com`, `cli.ejmlabs.com`, `harness.ejmlabs.com`, and `chess.ejmlabs.com` SHALL NOT block or challenge requests solely because of their source country.

#### Scenario: Ordinary visitor outside the United States

- **WHEN** a visitor outside the United States requests a public page without triggering a threat control
- **THEN** the site serves it without a country restriction or private-service sign-in

#### Scenario: Chess game connection

- **WHEN** an authorized player outside the United States connects to their game without triggering an abuse control
- **THEN** the chess host accepts the authorized connection without a country-only block or challenge

### Requirement: Public production entry points retain edge protection

The public production sites, including chess, SHALL serve traffic through their protected custom domains. Unnecessary production workers.dev addresses and version URLs SHALL be disabled. Deployment configuration SHALL preserve these limits. Intentional previews SHALL have a separate, verified access policy before publication.

#### Scenario: Alternate production URL

- **WHEN** an anonymous client requests an unwanted alternate production Worker hostname
- **THEN** that hostname does not serve the production application

#### Scenario: Production redeployment

- **WHEN** a public site is redeployed from its checked-in configuration
- **THEN** it does not reopen a production workers.dev address or version URL

#### Scenario: Intentional preview

- **WHEN** a preview is published outside the production zone's protection
- **THEN** its access policy is enforced and verified independently of the production WAF

#### Scenario: Canonical clients remain compatible

- **WHEN** alternate production URLs are disabled
- **THEN** canonical pages, documentation, release metadata, and existing digest-bound downloads retain their expected browser and machine-client behavior

#### Scenario: Chess account and game routes

- **WHEN** the checked chess build is published
- **THEN** canonical sign-in, live game connections, and public leaderboard reads work under explicit host protection without a blanket WAF or authentication bypass

## ADDED Requirements

### Requirement: Qualified initial chess publication

Chess SHALL open public access only after real ranked proof/recovery, the full
approved first-tier large-arena workload, protected-host player flows and live
privacy/spending/signup/accepted-work controls pass. It SHALL retain separate
private administration and canonical-domain protection. Longer calendar,
endurance and regional benchmarks SHALL remain visible unfinished qualification
and SHALL NOT be required for this initial release or claimed as passed.

#### Scenario: The initial ranked and large-arena release passes

- **WHEN** the approved initial release gates pass and the canonical host opens
- **THEN** public players can use the measured ranked and large-arena tier, private admin routes remain protected, and published limits distinguish measured capacity from unfinished benchmarks
