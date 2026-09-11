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
 * Streaming NDJSON loader.
 * Loads NDJSON files line-by-line with batched `executeMany` inserts.
 * @author John Grimes
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import oracledb from "oracledb";

import {
  type ResourceJsonDataType,
  validateOracleIdentifier,
} from "../validation.js";

import type { DiscoveredFile, FileLoadResult } from "./types.js";

/**
 * The bind definition for the `json` column, per storage type: BLOB rows are
 * bound as UTF-8 buffers; native JSON rows are bound as parsed objects so the
 * driver encodes them in Oracle's binary JSON format.
 * @param jsonType - The storage type of the target column.
 * @returns The bind definition for the json column.
 */
function jsonBindDef(jsonType: ResourceJsonDataType): oracledb.BindDefinition {
  return {
    type: jsonType === "JSON" ? oracledb.DB_TYPE_JSON : oracledb.DB_TYPE_BLOB,
  };
}

/**
 * Convert a raw NDJSON line to the bind value for the json column.
 *
 * BLOB storage keeps the line's exact UTF-8 bytes, so resources round-trip
 * byte-equivalent (data-model.md). Native JSON storage parses the line so the
 * driver can encode the value; a malformed line therefore throws here for
 * JSON storage, while BLOB storage defers well-formedness to the database's
 * `IS JSON` constraint.
 * @param line - The raw NDJSON line to parse and bind.
 * @param jsonType - The storage type of the target column.
 * @returns The bind value for the json column: a UTF-8 Buffer for BLOB storage, or a parsed object for JSON storage.
 * @throws {Error} when the line is not well-formed JSON in native JSON mode.
 */
function toBindValue(
  line: string,
  jsonType: ResourceJsonDataType,
): Buffer | object {
  if (jsonType === "JSON") {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  }
  return Buffer.from(line, "utf8");
}

/**
 * The SQL statement used for every insert in this module. Binds are
 * positional so `executeMany` can batch them.
 * @param qualifiedTable - Qualified table name.
 * @returns The INSERT statement.
 */
function insertStatement(qualifiedTable: string): string {
  return `INSERT INTO ${qualifiedTable} (resource_type, json) VALUES (:1, :2)`;
}

/**
 * Insert a batch of rows using a batched `executeMany`.
 * @param connection - Database connection.
 * @param qualifiedTable - Qualified table name.
 * @param resourceType - FHIR resource type.
 * @param jsonType - Storage type of the target json column.
 * @param lines - Array of JSON lines to insert.
 */
async function insertBatch(
  connection: oracledb.Connection,
  qualifiedTable: string,
  resourceType: string,
  jsonType: ResourceJsonDataType,
  lines: string[],
): Promise<void> {
  const rows: Array<[string, Buffer | object]> = lines.map((line) => [
    resourceType,
    toBindValue(line, jsonType),
  ]);
  await connection.executeMany(insertStatement(qualifiedTable), rows, {
    // Each successfully inserted batch is committed, so progress survives a
    // later failure.
    autoCommit: true,
    bindDefs: [
      { type: oracledb.DB_TYPE_VARCHAR, maxSize: 64 },
      jsonBindDef(jsonType),
    ],
  });
}

/**
 * Insert a batch, salvaging it line by line when the batch fails and
 * `continueOnError` is set. Malformed lines are reported in `errors` and
 * skipped; without salvage the underlying error propagates.
 * @param connection - Database connection.
 * @param qualifiedTable - Qualified table name.
 * @param resourceType - FHIR resource type.
 * @param jsonType - Storage type of the target json column.
 * @param lines - The batch's JSON lines.
 * @param continueOnError - Whether to salvage the batch line by line.
 * @param errors - Accumulator for error messages.
 * @returns The number of rows successfully inserted.
 */
async function insertOrSalvageBatch(
  connection: oracledb.Connection,
  qualifiedTable: string,
  resourceType: string,
  jsonType: ResourceJsonDataType,
  lines: string[],
  continueOnError: boolean,
  errors: string[],
): Promise<number> {
  try {
    await insertBatch(
      connection,
      qualifiedTable,
      resourceType,
      jsonType,
      lines,
    );
    return lines.length;
  } catch (error) {
    if (!continueOnError) {
      throw error;
    }
    // The failed executeMany may have left earlier rows of the batch in the
    // open transaction; discard them so salvaging does not double-insert.
    await connection.rollback();
  }
  // Salvage: insert each line individually, reporting the lines the database
  // (or the JSON parser) rejected.
  let inserted = 0;
  for (const line of lines) {
    try {
      await insertBatch(connection, qualifiedTable, resourceType, jsonType, [
        line,
      ]);
      inserted++;
    } catch (lineError) {
      errors.push(
        lineError instanceof Error ? lineError.message : String(lineError),
      );
    }
  }
  return inserted;
}

/**
 * Load a single NDJSON file into the database.
 *
 * Lines are read lazily and inserted in batches of `batchSize`. When a batch
 * fails (e.g. a malformed line rejected by the database's `IS JSON`
 * constraint) the file fails with the underlying error; the caller decides
 * whether to continue with other files. Under `continueOnError` the loader
 * salvages the batch by inserting line by line, reporting each bad line and
 * loading the well-formed ones (data-model.md).
 * @param pool - Database connection pool.
 * @param file - File to load.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table to load into.
 * @param jsonType - Storage type of the target json column.
 * @param batchSize - Number of rows per batch (default 1000).
 * @param continueOnError - Salvage malformed lines line-by-line instead of
 *   failing the whole file.
 * @param onProgress - Optional callback for progress updates.
 * @returns Promise that resolves to the load result.
 */
export async function loadFile(
  pool: oracledb.Pool,
  file: DiscoveredFile,
  schemaName: string | undefined,
  tableName: string,
  jsonType: ResourceJsonDataType,
  batchSize: number = 1000,
  continueOnError: boolean = false,
  onProgress?: (rowsLoaded: number) => void,
): Promise<FileLoadResult> {
  validateOracleIdentifier(tableName, "Table name");
  if (schemaName !== undefined) {
    validateOracleIdentifier(schemaName, "Schema name");
  }

  const startTime = Date.now();
  let rowsLoaded = 0;
  let linesAttempted = 0;
  const errors: string[] = [];
  let batch: string[] = [];
  let failed = false;
  const qualifiedTable = schemaName ? `${schemaName}.${tableName}` : tableName;

  const connection = await pool.getConnection();
  try {
    // Create a readline interface to read the file line by line.
    const fileStream = createReadStream(file.path, { encoding: "utf8" });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity, // Treat \r\n as a single line break.
    });

    /**
     * Insert the current batch, salvaging when allowed.
     * @returns Whether the whole batch was inserted.
     */
    const flushBatch = async (): Promise<boolean> => {
      if (batch.length === 0) {
        return true;
      }
      const inserted = await insertOrSalvageBatch(
        connection,
        qualifiedTable,
        file.resourceType,
        jsonType,
        batch,
        continueOnError,
        errors,
      );
      rowsLoaded += inserted;
      linesAttempted += batch.length;
      const complete = inserted === batch.length;
      batch = [];
      return complete;
    };

    // Process each line as a raw string.
    for await (const line of rl) {
      // Skip empty lines.
      if (!line.trim()) {
        continue;
      }

      // Add to batch.
      batch.push(line);

      // If batch is full, insert it.
      if (batch.length >= batchSize) {
        const complete = await flushBatch();
        failed = failed || !complete;

        // Report progress.
        onProgress?.(rowsLoaded);
      }
    }

    // Insert any remaining rows in the final batch.
    const complete = await flushBatch();
    failed = failed || !complete;
    onProgress?.(rowsLoaded);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    failed = true;
  } finally {
    await connection.close();
  }

  const errorMessage = errors[0];
  return {
    file,
    rowsLoaded,
    rowsFailed: linesAttempted - rowsLoaded,
    errors,
    durationMs: Date.now() - startTime,
    ...(failed && errorMessage !== undefined && { error: errorMessage }),
  };
}
