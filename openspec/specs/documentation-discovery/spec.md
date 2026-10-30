# documentation-discovery Specification

## Purpose

Records the existing product guide discovery contract used by the chess additions while preserving richer local specifications.

## Requirements

### Requirement: Direct guide links

The studio site SHALL offer a user guide and a developer guide for ejm-cli, ejm-harness, and ejm-ide. Each link SHALL open the corresponding guide on that project's domain.

#### Scenario: Find a project guide

- **WHEN** a visitor opens the studio documentation section
- **THEN** each project has named user and developer guide links
- **AND** the links use the project's canonical domain
