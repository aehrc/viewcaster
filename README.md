# viewcaster

[![Build and test](https://github.com/aehrc/viewcaster/actions/workflows/test.yml/badge.svg)](https://github.com/aehrc/viewcaster/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/viewcaster)](https://www.npmjs.com/package/viewcaster)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

A TypeScript library and CLI tool for bulk loading FHIR resources into Oracle
Database, and transpiling [SQL on FHIR](https://sql-on-fhir.org/) view
definitions into Oracle SQL queries.

## Features

- **SQL on FHIR v2 compliance** - passes the official SQL on FHIR test suite
  against Oracle Database 19c, 21c, 23ai and 26ai
- **FHIRPath support** - the FHIRPath subset exercised by the official test
  suite: literals, path navigation, indexers, `where`, `exists`, `empty`,
  `extension`, `ofType`, `first`, `join`, arithmetic, boolean logic,
  `getResourceKey()`, `getReferenceKey([Type])`, and `%rowIndex`
- **Oracle JSON optimisation** - generates queries over `JSON_VALUE`,
  `JSON_QUERY`, `JSON_TABLE` and `JSON_EXISTS`, with `CROSS APPLY`/`OUTER
APPLY` for array unrolling
- **Two JSON storage types** - a `BLOB CHECK (json IS JSON)` column (default,
  19c+) and the native `JSON` type (21c+ opt-in)
- **Type casting** - automatic Oracle type mapping from FHIR data types, with
  `oracle/type` and `ansi/type` column tags for explicit control
- **WHERE clauses** - view-level filtering with FHIRPath expressions
- **Bulk NDJSON loader** - batched parallel loader for `{ResourceType}.ndjson`
  directories

## Quick start

The easiest way to use viewcaster is via `npx`:

```bash
# 1. Load FHIR resources from NDJSON files into Oracle.
npx viewcaster load ./data --host localhost --port 1521 \
  --service-name FREEPDB1 --user fhir --password fhir

# 2. Transpile a ViewDefinition to Oracle SQL.
npx viewcaster transpile --input patient_demographics.ViewDefinition.json \
  --output patient_demographics.sql

# 3. Create a view from the generated SQL and query it (sqlplus/sqlcl).
CREATE VIEW patient_demographics AS
<contents of patient_demographics.sql>;
SELECT * FROM patient_demographics FETCH FIRST 10 ROWS ONLY;
```

Connection details can also be supplied via environment variables
(`ORACLE_HOST`, `ORACLE_PORT`, `ORACLE_SERVICE_NAME`, `ORACLE_USER`,
`ORACLE_PASSWORD`, `ORACLE_CONNECT_STRING`).

## Table structure

The loader creates a single table shared by all resource types (default
`fhir_resources`):

```sql
CREATE TABLE fhir_resources (
  id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_type VARCHAR2(64) NOT NULL,
  json          BLOB NOT NULL CHECK (json IS JSON)
);

CREATE INDEX ix_fhir_resources_resource_type
  ON fhir_resources (resource_type);
```

With `--resource-json-data-type JSON` (21c+) the JSON column is the native
`JSON` type instead. `getResourceKey()` extracts the FHIR resource id from the
JSON, not the surrogate `id` column.

## CLI reference

### `viewcaster transpile`

Reads a ViewDefinition (JSON) and writes one Oracle `SELECT` statement
(suitable for `CREATE VIEW ... AS` or `INSERT INTO ... SELECT`).

| Option                             | Default          | Description                                                                                                       |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `-i, --input <file>`               | stdin            | ViewDefinition JSON file.                                                                                         |
| `-o, --output <file>`              | stdout           | Output SQL file.                                                                                                  |
| `--resource-json-data-type <type>` | `BLOB`           | Storage type the SQL targets: `BLOB` (19c+, emits `FORMAT JSON`) or `JSON` (21c+, native type). Case-insensitive. |
| `--table-name <name>`              | `fhir_resources` | Source table.                                                                                                     |
| `--schema-name <name>`             | current schema   | Schema qualifier.                                                                                                 |
| `--resource-id-column <name>`      | `id`             | Surrogate id column.                                                                                              |
| `--resource-json-column <name>`    | `json`           | JSON column.                                                                                                      |

Invalid ViewDefinitions exit non-zero, name the offending element on stderr,
and write nothing.

### `viewcaster load <directory>`

Bulk loads `{ResourceType}.ndjson` files into the resources table.

Connection options (environment fallback in parentheses): `--host`
(`ORACLE_HOST`, default `localhost`), `--port` (`ORACLE_PORT`, default `1521`),
`--service-name` (`ORACLE_SERVICE_NAME`, default `FREEPDB1`), `--user`
(`ORACLE_USER`), `--password` (`ORACLE_PASSWORD`), `--connect-string`
(`ORACLE_CONNECT_STRING`, overrides host/port/service-name for TNS aliases and
wallets).

Loading options: `--table-name` (default `fhir_resources`), `--schema-name`,
`--resource-type <type>` (load only `{type}.ndjson`),
`--resource-json-data-type BLOB|JSON` (`ORACLE_RESOURCE_JSON_DATA_TYPE`),
`--truncate`, `--no-create-table`, `--batch-size <n>` (default `1000`),
`--parallel <n>` (default `4`), `--dry-run`, `--continue-on-error`,
`--verbose` / `--progress` / `--quiet`.

The loader prints a per-file summary (rows loaded, failures) and exits
non-zero if any file failed, even with `--continue-on-error`.

## Programmatic API

```typescript
import { SqlOnFhir, loadNdjsonFiles } from "viewcaster";

// Transpile.
const result = new SqlOnFhir({ resourceJsonDataType: "BLOB" }).transpile({
  resource: "Patient",
  select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
});
console.log(result.sql); // single Oracle SELECT statement
console.log(result.columns); // [{ name, type, nullable }, ...]

// Load.
await loadNdjsonFiles({
  directory: "./data",
  database: { user: "fhir", password: "fhir" },
});
```

`transpile` accepts a ViewDefinition object, a JSON string, or a FHIR resource
with `resourceType: "ViewDefinition"`. It throws on invalid input, naming the
offending element, and never returns partial SQL.

## Default type mappings

Text is the default target: it preserves FHIR semantics (partial dates,
arbitrary-precision decimals, Unicode) that native Oracle types would coerce.
Use `oracle/type` or `ansi/type` column tags for explicit control; precedence
is `oracle/type` > `ansi/type` > the defaults below.

| FHIR type                                               | Oracle type                                               |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `id`                                                    | `VARCHAR2(64)`                                            |
| `boolean`                                               | `NUMBER(1)` (1/0/NULL via `CASE`)                         |
| `integer`, `positiveInt`, `unsignedInt`                 | `NUMBER(10)`                                              |
| `integer64`                                             | `NUMBER(19)`                                              |
| `decimal`                                               | `VARCHAR2(4000)` (preserves precision and trailing zeros) |
| `date`                                                  | `VARCHAR2(10)`                                            |
| `dateTime`                                              | `VARCHAR2(50)`                                            |
| `instant`                                               | `VARCHAR2(50)`                                            |
| `time`                                                  | `VARCHAR2(20)`                                            |
| `string`, `markdown`, `code`, `uri`, `url`, `canonical` | `VARCHAR2(4000)`                                          |
| `uuid`                                                  | `VARCHAR2(100)`                                           |
| `oid`                                                   | `VARCHAR2(255)`                                           |
| `base64Binary`                                          | `VARCHAR2(4000)` (base64 text)                            |

Type tags are FHIR column tags:

```json
{
  "name": "birth_date",
  "path": "birthDate",
  "type": "date",
  "tag": [{ "name": "oracle/type", "value": "DATE" }]
}
```

An `ansi/type` tag holds an ISO/IEC 9075 type, translated to its Oracle
equivalent (`INTEGER` -> `NUMBER(10)`, `BOOLEAN` -> `NUMBER(1)`, `TIMESTAMP`
-> `TIMESTAMP`, `CHARACTER VARYING` -> `VARCHAR2`, ...).

## Creating views and materialised tables

The generated SQL is exactly one `SELECT` statement with no trailing
terminator, so it can be wrapped directly:

```sql
CREATE VIEW patient_demographics AS
SELECT
  JSON_VALUE(r.json FORMAT JSON, '$.name[0].family' RETURNING VARCHAR2(4000)) AS "family_name",
  ...
FROM fhir_resources r
WHERE r.resource_type = 'Patient';

-- Or materialise:
CREATE TABLE patient_demographics_cache AS
<same SELECT>;
```

Output column aliases are double-quoted so the ViewDefinition's exact column
names (case included) are preserved.

## Oracle-specific caveats

- **Empty string is NULL.** Oracle treats `''` and NULL as indistinguishable
  in `VARCHAR2` results, so a FHIR string of `""` selected through a view is
  indistinguishable from an absent element.
- **Storage-specific SQL.** Generated SQL targets one storage type: `BLOB`
  mode emits `FORMAT JSON` after the JSON column reference; native `JSON`
  mode omits it there, but both modes emit `CLOB FORMAT JSON` on `JSON_TABLE`
  value columns (the column is character data, so it must be marked as JSON
  regardless of the storage type). Changing storage type requires
  retranspiling.
- **Version requirements.** Default `BLOB` storage works on Oracle 19c and
  later. Native `JSON` storage requires 21c or later; requesting it against an
  older database fails fast, naming the required version.
- **4,000-byte scalar limit (19c).** On the default storage mode, individual
  scalar values extracted by a view are limited to 4,000 bytes (`JSON_VALUE
RETURNING VARCHAR2(4000)`); resources themselves are unlimited.
- **Decimal lexical forms.** Oracle normalises a JSON number on extraction, so
  a lexical `1.0` comes back from `JSON_VALUE` as `1`, and the default
  `VARCHAR2` decimal mapping returns that normalised form. Where the original
  precision is what is being asked for, as in `lowBoundary()` and
  `highBoundary()`, the value is read with `JSON_QUERY` instead, which returns
  the source text. That works only under `BLOB` storage, where the document is
  held as written. The native `JSON` type normalises the number as it encodes
  it, so `{"v":1.0}` is stored as `{"v":1}` and the precision is gone before
  any query runs: under that storage type a decimal boundary is
  unrecoverable.
- **Identifiers.** Table, schema and base-column names are unquoted (folded
  to upper case by Oracle); output column aliases are double-quoted, so
  ViewDefinition column names keep their exact case.

## Development

```bash
bun install
bunx tsc --noEmit       # type check
bun run lint            # ESLint
bun run test:coverage   # unit tests with coverage
docker compose up -d    # local Oracle AI Database 26ai Free for integration tests
SQLONFHIR_TEST_PATH=./sqlonfhir/tests bun run test   # official suite (needs ORACLE_* env)
```

See `CONTRIBUTING.md` for the full development workflow, including CI.
Security issues should be reported as described in `SECURITY.md`, not through
public issues.

## Licence

Apache License 2.0. See `LICENSE`. Third party content bundled with or derived
from this project, including the HL7 FHIRPath grammar, is listed in `NOTICE`.

Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation
(CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
