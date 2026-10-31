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

### Requirement: Initial chess publication

Chess SHALL open public ranked play and arenas only after the timeout-proof path is retired, protected-host player flows including ranked and arena play pass, and live mail, budget-alert, cron and stop-webhook readbacks pass, followed by Access removal and public verification. It SHALL keep private administration and canonical-domain protection. The first-tier run and longer benchmarks SHALL stay unfinished follow-up evidence, neither required nor claimed as passed.

#### Scenario: The initial ranked and arena release passes

- **WHEN** the launch checks pass and the canonical host opens
- **THEN** public players can use ranked play and arenas, private admin routes remain protected, and published limits distinguish measured capacity from unfinished benchmarks
