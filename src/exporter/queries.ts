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
 * Oracle SQL query builders for the NDJSON exporter.
 *
 * Kept as pure functions so the generated SQL can be unit-tested without a
 * database. Identifiers are validated here before interpolation; the resource
 * type filter is always the `:resourceType` bind, never interpolated.
 * @author John Grimes
 */

import {
  type ResourceJsonDataType,
  validateOracleIdentifier,
} from "../validation.js";

/**
 * Validate a schema and table name pair.
 *
 * Exposed so the exporter can reject a bad identifier before it opens a
 * connection.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Table name.
 * @throws {Error} if either identifier is not a valid Oracle identifier.
 */
export function validateTableIdentifiers(
  schemaName: string | undefined,
  tableName: string,
): void {
  if (schemaName !== undefined) {
    validateOracleIdentifier(schemaName, "Schema name");
  }
  validateOracleIdentifier(tableName, "Table name");
}

/**
 * Qualify a table name with its schema when one is given. Identifiers are
 * emitted unquoted, as the loader does, and must already be validated.
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
 * Build the query that lists the distinct resource types held in the table.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Table name.
 * @param filterByResourceType - Whether to restrict the result to the
 *   `:resourceType` bind.
 * @returns The Oracle SQL query.
 * @throws {Error} if either identifier is not a valid Oracle identifier.
 * @example
 * buildDistinctResourceTypesQuery(undefined, "fhir_resources", false);
 */
export function buildDistinctResourceTypesQuery(
  schemaName: string | undefined,
  tableName: string,
  filterByResourceType: boolean,
): string {
  validateTableIdentifiers(schemaName, tableName);
  const where = filterByResourceType
    ? "\nWHERE resource_type = :resourceType"
    : "";
  return (
    `SELECT DISTINCT resource_type\n` +
    `FROM ${qualifyTableName(schemaName, tableName)}${where}\n` +
    `ORDER BY resource_type`
  );
}

/**
 * Build the query that streams the resources of a single resource type.
 *
 * The two storage types are read differently so that both yield UTF-8 bytes:
 * a BLOB column is selected as it stands, which returns the exact bytes the
 * loader wrote, while a native JSON column holds Oracle's binary format and
 * must be serialised. `RETURNING BLOB` serialises to AL32UTF8 bytes, so the
 * caller has one write path for both. Rows are ordered by the surrogate id so
 * the output is deterministic and preserves the order they were loaded in.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Table name.
 * @param jsonType - Storage type of the table's json column.
 * @returns The Oracle SQL query, parameterised on `:resourceType`.
 * @throws {Error} if either identifier is not a valid Oracle identifier.
 * @example
 * buildResourceExportQuery(undefined, "fhir_resources", "BLOB");
 */
export function buildResourceExportQuery(
  schemaName: string | undefined,
  tableName: string,
  jsonType: ResourceJsonDataType,
): string {
  validateTableIdentifiers(schemaName, tableName);
  const jsonColumn =
    jsonType === "JSON"
      ? "JSON_SERIALIZE(json RETURNING BLOB) AS json"
      : "json";
  return (
    `SELECT ${jsonColumn}\n` +
    `FROM ${qualifyTableName(schemaName, tableName)}\n` +
    `WHERE resource_type = :resourceType\n` +
    `ORDER BY id`
  );
}
