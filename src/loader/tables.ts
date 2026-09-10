/*
 * Copyright © 2026, Commonwealth Scientific and Industrial Research
 * Organisation (CSIRO) ABN 41 687 119 230.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * @author John Grimes
 */

/**
 * Table management for NDJSON loader.
 * Creates and manages the single fhir_resources table.
 *
 * @author John Grimes
 */

import oracledb from "oracledb";
import {
  type ResourceJsonDataType,
  validateOracleIdentifier,
} from "../validation.js";

/**
 * The major Oracle Database version that introduced the native JSON column
 * type (21c). Oracle encodes versions in `oracleServerVersion` as e.g.
 * 1900000000 for 19c.
 */
const NATIVE_JSON_MAJOR_VERSION = 21;

/**
 * The DDL statements needed to create the resources table and its index.
 */
export interface CreateTableStatements {
  /** The `CREATE TABLE` statement. */
  createTable: string;
  /** The `CREATE INDEX` statement for the `resource_type` column. */
  createIndex: string;
}

/**
 * Qualify a table name with its schema when a schema is given. Identifiers
 * are emitted unquoted (research R7) and must have been validated by the
 * caller.
 *
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Table name.
 * @returns The qualified table name.
 */
function qualifyTableName(
  schemaName: string | undefined,
  tableName: string,
): string {
  return schemaName ? `${schemaName}.${tableName}` : tableName;
}

/**
 * Build the DDL statements for the resources table and its index (DDL per
 * data-model.md).
 *
 * This is a pure function so the generated SQL can be unit-tested without a
 * database. The `json` column is typed with the resolved {@link
 * ResourceJsonDataType}; with the default `BLOB` variant the column carries
 * an `IS JSON` check constraint. Identifiers are assumed to have been
 * validated by the caller (see {@link createTable}).
 *
 * @param schemaName - Schema name (already validated), or undefined for the
 *   current schema.
 * @param tableName - Table name (already validated).
 * @param jsonType - Resolved canonical storage type for the `json` column.
 * @returns The `CREATE TABLE` and `CREATE INDEX` statements.
 */
export function buildCreateTableStatements(
  schemaName: string | undefined,
  tableName: string,
  jsonType: ResourceJsonDataType,
): CreateTableStatements {
  // Only the json column's type varies; every other part of the DDL is held
  // constant.
  const jsonColumn =
    jsonType === "JSON"
      ? "json          JSON NOT NULL"
      : "json          BLOB NOT NULL CHECK (json IS JSON)";
  const qualified = qualifyTableName(schemaName, tableName);

  const createTable = `CREATE TABLE ${qualified} (
  id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_type VARCHAR2(64) NOT NULL,
  ${jsonColumn}
)`;

  const createIndex = `CREATE INDEX ix_${tableName}_resource_type
  ON ${qualified} (resource_type)`;

  return { createTable, createIndex };
}

/**
 * Render an ALL_TAB_COLUMNS column type for a diagnostic message.
 *
 * Length-bearing types are shown with their declared character length; types
 * reported without a length (such as `BLOB`, `CLOB` or the native `JSON`
 * type) are shown as the bare type name.
 *
 * @param dataType - The ALL_TAB_COLUMNS DATA_TYPE.
 * @param charLength - The ALL_TAB_COLUMNS CHAR_LENGTH, when non-zero.
 * @returns A readable type such as `VARCHAR2(255)`, `CLOB` or `JSON`.
 */
function formatColumnType(dataType: string, charLength?: number | null): string {
  const baseType = dataType.trim().toUpperCase();
  if (!charLength) {
    return baseType;
  }
  return `${baseType}(${charLength})`;
}

/**
 * Resolve an ALL_TAB_COLUMNS column description to a canonical json type.
 *
 * Only two column shapes can faithfully hold a serialised FHIR resource (the
 * two variants of data-model.md): the BLOB variant (`DATA_TYPE = 'BLOB'`,
 * expected to carry the `IS JSON` check constraint) and the native type
 * (`DATA_TYPE = 'JSON'`, 21c+). Any other shape - a bounded `VARCHAR2`, a
 * `CLOB`, and so on - is rejected here rather than silently coerced to a
 * supported type. Coercion would let the mismatch check pass and the loader
 * write into a column that cannot hold the data, surfacing later as a
 * data-dependent error. Failing fast turns that late failure into an early,
 * actionable configuration error.
 *
 * @param dataType - The ALL_TAB_COLUMNS DATA_TYPE.
 * @param charLength - The ALL_TAB_COLUMNS CHAR_LENGTH, when non-zero.
 * @returns The canonical resource json data type (`BLOB` or `JSON`).
 * @throws Error if the column is neither the BLOB variant nor native `JSON`.
 *   The message names the offending type and the two acceptable types.
 */
export function resolveColumnJsonDataType(
  dataType: string,
  charLength?: number | null,
): ResourceJsonDataType {
  const normalised = dataType.trim().toUpperCase();
  if (normalised === "BLOB") {
    return "BLOB";
  }
  if (normalised === "JSON") {
    return "JSON";
  }
  throw new Error(
    `Existing json column is ` +
      `${formatColumnType(dataType, charLength)}, which cannot ` +
      `safely hold serialised FHIR resources. Expected BLOB or JSON. ` +
      `Alter or drop the column before loading.`,
  );
}

/**
 * Build a warning for an existing table whose json column type differs from
 * the requested type (data-model.md lifecycle: warn naming both types and
 * load into the existing table unchanged).
 *
 * @param schemaName - Schema name.
 * @param tableName - Table name.
 * @param existingType - The table's current json column type.
 * @param requestedType - The requested json column type.
 * @returns A warning message naming both types, or null when they match.
 */
export function buildJsonTypeMismatchWarning(
  schemaName: string | undefined,
  tableName: string,
  existingType: ResourceJsonDataType,
  requestedType: ResourceJsonDataType,
): string | null {
  if (existingType === requestedType) {
    return null;
  }
  const qualified = qualifyTableName(schemaName, tableName);
  return (
    `Warning: table ${qualified} already exists with a json ` +
    `column of type ${existingType}, but ${requestedType} was requested. The ` +
    `existing table is left unaltered and loading continues into it.`
  );
}

/**
 * Fail fast when native JSON storage is requested from a pre-21c database
 * (FR-014, data-model.md lifecycle).
 *
 * @param serverVersion - The database's `oracleServerVersion` (e.g.
 *   1900000000 for 19c).
 * @throws Error naming the required version and the server's version.
 */
export function assertNativeJsonSupported(serverVersion: number): void {
  const majorVersion = Math.floor(serverVersion / 100_000_000);
  if (majorVersion >= NATIVE_JSON_MAJOR_VERSION) {
    return;
  }
  throw new Error(
    `Native JSON storage requires Oracle Database 21c or later; ` +
      `this server is version ${majorVersion}. ` +
      `Use BLOB storage (the default) or upgrade the database.`,
  );
}

/**
 * Validate identifiers to prevent SQL injection before they are interpolated
 * into DDL. The json type is already a canonical, allowlisted value, so it
 * carries no injection risk.
 *
 * @param schemaName - Schema name, when given.
 * @param tableName - Table name.
 */
function validateIdentifiers(
  schemaName: string | undefined,
  tableName: string,
): void {
  if (schemaName !== undefined) {
    validateOracleIdentifier(schemaName, "Schema name");
  }
  validateOracleIdentifier(tableName, "Table name");
}

/**
 * Check if a table exists in the database.
 *
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table to check.
 * @returns Promise that resolves to true if the table exists.
 */
export async function tableExists(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    if (schemaName === undefined) {
      const result = await connection.execute(
        `SELECT COUNT(*) AS n
         FROM user_tables
         WHERE table_name = :tableName`,
        [tableName.toUpperCase()],
      );
      const row = result.rows?.[0] as { N: number } | undefined;
      return (row?.N ?? 0) > 0;
    }
    const result = await connection.execute(
      `SELECT COUNT(*) AS n
       FROM all_tables
       WHERE owner = :owner AND table_name = :tableName`,
      [schemaName.toUpperCase(), tableName.toUpperCase()],
    );
    const row = result.rows?.[0] as { N: number } | undefined;
    return (row?.N ?? 0) > 0;
  } finally {
    await connection.close();
  }
}

/**
 * Read the effective json column type for an existing table.
 *
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table.
 * @returns The canonical json column type, or null if the table or its `json`
 *   column does not exist.
 * @throws Error if the column exists but is neither the BLOB variant nor
 *   native `JSON` (see {@link resolveColumnJsonDataType}).
 */
export async function getExistingJsonColumnType(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
): Promise<ResourceJsonDataType | null> {
  const connection = await pool.getConnection();
  try {
    let result: oracledb.Result<unknown>;
    if (schemaName === undefined) {
      result = await connection.execute(
        `SELECT data_type, char_length
         FROM user_tab_columns
         WHERE table_name = :tableName AND column_name = 'JSON'`,
        [tableName.toUpperCase()],
      );
    } else {
      result = await connection.execute(
        `SELECT data_type, char_length
         FROM all_tab_columns
         WHERE owner = :owner AND table_name = :tableName
           AND column_name = 'JSON'`,
        [schemaName.toUpperCase(), tableName.toUpperCase()],
      );
    }

    const row = result.rows?.[0] as
      | { DATA_TYPE: string; CHAR_LENGTH: number }
      | undefined;
    if (!row) {
      return null;
    }
    return resolveColumnJsonDataType(
      row.DATA_TYPE,
      row.CHAR_LENGTH > 0 ? row.CHAR_LENGTH : null,
    );
  } finally {
    await connection.close();
  }
}

/**
 * Emit a warning if an existing table's json column type differs from the
 * requested type. The table is never altered; this only surfaces the mismatch
 * so it is visible rather than silently ignored.
 *
 * An existing column that is neither the BLOB variant nor native `JSON`
 * cannot hold a serialised FHIR resource, so it is rejected outright rather
 * than warned about: the error is raised here before any rows are loaded.
 *
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table.
 * @param requestedType - The requested json column type.
 * @throws Error if the existing `json` column is neither the BLOB variant nor
 *   native `JSON` (see {@link resolveColumnJsonDataType}).
 */
export async function warnIfJsonTypeMismatch(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
  requestedType: ResourceJsonDataType,
): Promise<void> {
  const existingType = await getExistingJsonColumnType(
    pool,
    schemaName,
    tableName,
  );
  if (existingType === null) {
    return;
  }
  const warning = buildJsonTypeMismatchWarning(
    schemaName,
    tableName,
    existingType,
    requestedType,
  );
  if (warning !== null) {
    // The warning is emitted regardless of quiet mode so the misconfiguration
    // is always visible.
    console.warn(warning);
  }
}

/**
 * Fail fast when native JSON storage is requested but the database does not
 * support it (FR-014). Reads the server version from a pooled connection.
 *
 * @param pool - Database connection pool.
 * @throws Error when the server is pre-21c; see {@link
 *   assertNativeJsonSupported}.
 */
export async function ensureNativeJsonSupported(
  pool: oracledb.Pool,
): Promise<void> {
  const connection = await pool.getConnection();
  try {
    assertNativeJsonSupported(connection.oracleServerVersion);
  } finally {
    await connection.close();
  }
}

/**
 * Create the resources table with an index on resource_type (DDL per
 * data-model.md).
 *
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table to create.
 * @param jsonType - Storage type for the `json` column.
 */
export async function createTable(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
  jsonType: ResourceJsonDataType = "BLOB",
): Promise<void> {
  validateIdentifiers(schemaName, tableName);

  const { createTable: createTableSql, createIndex: createIndexSql } =
    buildCreateTableStatements(schemaName, tableName, jsonType);

  const connection = await pool.getConnection();
  try {
    // Create the table.
    await connection.execute(createTableSql);

    // Create an index on resource_type for efficient filtering by resource
    // type.
    await connection.execute(createIndexSql);
  } finally {
    await connection.close();
  }
}

/**
 * Truncate a table (remove all rows).
 *
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table to truncate.
 */
export async function truncateTable(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
): Promise<void> {
  validateIdentifiers(schemaName, tableName);

  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `TRUNCATE TABLE ${qualifyTableName(schemaName, tableName)}`,
    );
  } finally {
    await connection.close();
  }
}

/**
 * Ensure the resources table exists, creating it if necessary, and return the
 * storage type the loader must use for its binds.
 *
 * When the table already exists it is never altered; the requested `json`
 * column type only governs creation of a new table. An existing table with the
 * other supported storage type yields a warning naming both types, and the
 * *existing* column type is returned so rows are bound in a form the column
 * accepts. The native-JSON version gate (FR-014) fires only when a new table
 * would actually be created as JSON.
 *
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table.
 * @param truncate - Whether to truncate the table if it exists.
 * @param jsonType - Storage type for the `json` column when creating the
 *   table.
 * @returns The effective json column storage type to load with.
 */
export async function ensureTable(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
  truncate: boolean = false,
  jsonType: ResourceJsonDataType = "BLOB",
): Promise<ResourceJsonDataType> {
  const exists = await tableExists(pool, schemaName, tableName);

  if (exists) {
    // The table already exists, so the requested type cannot take effect.
    // getExistingJsonColumnType rejects an unusable column outright; a
    // supported column of the other variant only warns.
    const existingType = await getExistingJsonColumnType(
      pool,
      schemaName,
      tableName,
    );
    if (existingType === null) {
      throw new Error(
        `Existing table ${qualifyTableName(schemaName, tableName)} has no json column.`,
      );
    }
    const warning = buildJsonTypeMismatchWarning(
      schemaName,
      tableName,
      existingType,
      jsonType,
    );
    if (warning !== null) {
      console.warn(warning);
    }
    if (truncate) {
      await truncateTable(pool, schemaName, tableName);
    }
    return existingType;
  }

  // Fail fast before any DDL when native JSON is requested from a pre-21c
  // server (FR-014, data-model.md lifecycle).
  if (jsonType === "JSON") {
    await ensureNativeJsonSupported(pool);
  }
  await createTable(pool, schemaName, tableName, jsonType);
  return jsonType;
}
