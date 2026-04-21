# Quin Calendar — Working Notes for Claude

Project-level guidance for Claude when making changes in this repository. Read this before starting new work.

## Code Quality

### Variable Declaration Safety

Always declare variables at the top of their scope before use. Before committing, scan modified JS files for reference-before-declaration errors (e.g., `isTuesdaySeries` used in a conditional before its `const`/`let` declaration).

## Debugging Guidelines

### Scope of Changes

Do not add speculative fixes or properties (e.g., CREATED/LAST-MODIFIED/SEQUENCE on ICS events) that weren't in the previously-working version. When debugging, first verify what changed from the last known-good state before adding new fields.

## Scheduled Workflows

### Scheduled Workflow Safety

Before iterating on failing scheduled workflows (especially booking/reservation systems), DISABLE the cron trigger first. Failed runs can hold locks or consume resources that interfere with the user's manual actions.

## Deployment / Setup

### Secrets & Setup Steps

When introducing new environment variables or secrets (e.g., `QUIN_SESSION_TOKEN`), explicitly list setup steps the user must do BEFORE testing, in a numbered checklist. Don't assume the user will infer secret creation from code.
