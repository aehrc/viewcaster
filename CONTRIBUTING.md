# Contributing to viewcaster

Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation
(CSIRO) ABN 41 687 119 230.

## Getting started

Prerequisites: [bun](https://bun.sh) >= 1.1, Node.js >= 20, Docker (for a local
test database), and access to an Oracle Database instance for integration
tests.

```bash
bun install
bunx tsc --noEmit
bun run lint
```

## Development workflow

### Local test database

The `docker-compose.yml` in the repository root runs Oracle 23ai Free
(ARM64-native on Apple Silicon), which covers the default `BLOB` storage and
the native `JSON` storage types:

```bash
docker compose up -d
# Wait for "DATABASE IS READY TO USE!" in `docker compose logs -f oracle`.
# First boot takes several minutes; the fhir/fhir app user is created
# automatically in FREEPDB1 (docker/init/01_create_user.sql).
```

Connection settings for the tests: `ORACLE_HOST=localhost ORACLE_PORT=1521
ORACLE_SERVICE_NAME=FREEPDB1 ORACLE_USER=fhir ORACLE_PASSWORD=fhir`.

### Unit tests

Unit tests need no database:

```bash
bun run test
```

### Integration tests and the official compliance suite

The integration tests execute generated SQL against a live Oracle instance and
skip cleanly when no `ORACLE_*` environment is set. They use dedicated test
tables and never touch an existing `fhir_resources` table.

The official SQL on FHIR compliance suite is vendored as the `sqlonfhir/`
git submodule. Run it with:

```bash
git submodule update --init
SQLONFHIR_TEST_PATH=./sqlonfhir/tests bun run test
```

Set `ORACLE_RESOURCE_JSON_DATA_TYPE=JSON` to run the suite over a native
`JSON` column. A JSON report is written to `out/test-report.json`.

### Linting and formatting

```bash
bun run lint
bun run format:check
bunx jscpd          # duplication check
```

Prettier with default settings formats the code. ESLint follows the standard
TypeScript static-analysis setup (typescript-eslint, jsdoc, import, unicorn,
vitest plugins).

### CI

`.github/workflows/test.yml` runs the full matrix on every push: Oracle 19c EE
(BLOB), 21c XE (BLOB and JSON) and 23ai Free (BLOB and JSON). The 19c job
pulls the private `ghcr.io/aehrc/oracle-database-ee:19.3.0` package using the
workflow `GITHUB_TOKEN`; it is skipped on fork pull requests, which cannot
read the package.

To set up the GHCR access locally for reproducing the 19c job, log in to the
registry with a personal access token that has `read:packages` scope for the
`aehrc` organisation.

## Pull requests

- All pull requests start as drafts.
- Commits should be atomic, with imperative subjects of 50 characters or less.
- New test code must follow the existing patterns: unit tests co-located in
  `src/`, live-database integration tests in `test/`.
- Every behaviour change is covered by a test written before (or with) the
  change.

## Licensing

By contributing you agree that your contributions are licensed under the
Apache License 2.0, with copyright assigned to CSIRO as noted above.
