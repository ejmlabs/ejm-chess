# ejmlabs-site Specification

## Purpose

Records the published studio home contract needed by chess discovery while source adoption is reviewed separately.

## Requirements

### Requirement: Home page
The home page SHALL lead with display type, public project copy and direct actions, SHALL NOT show project previews or simulated product windows, SHALL list ejm-cli, ejm-ide and ejm-harness as external rows to their own sites, use a Sage band, and end with the Ink footer.

#### Scenario: No imitation on the home page
- **WHEN** the home page is parsed
- **THEN** it contains no simulated product window

#### Scenario: Project rows
- **WHEN** the home page is parsed
- **THEN** the three project links point to cli, ide and harness on ejmlabs.com and carry `rel="external"`

#### Scenario: Project marks beside names
- **WHEN** a visitor reads Current projects at phone or desktop widths in either page theme
- **THEN** each name has its approved mark beside it with clear contrast on Sage, reserved dimensions and one accessible project link without a duplicate image label
