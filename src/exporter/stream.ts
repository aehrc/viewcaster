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
 * Streaming NDJSON exporter.
 *
 * Reads one resource type at a time out of Oracle and appends each resource to
 * its output file as it arrives, so a table far larger than available memory
 * can be exported. The query stream, the line formatter and the file are
 * joined with `pipeline`, which propagates back-pressure: when the file cannot
 * accept more data the driver stops fetching rows.
 * @author John Grimes
 */

import { createWriteStream, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import oracledb from "oracledb";

import { buildResourceExportQuery } from "./queries.js";

import type { ResourceJsonDataType } from "../validation.js";

/** How often, in rows, to report progress while streaming. */
const PROGRESS_INTERVAL_ROWS = 1000;

/**
 * Rows fetched from the database per round trip. Matches the driver's default;
 * named here because it also bounds how many resources are held in memory at
 * once.
 */
const FETCH_ARRAY_SIZE = 100;

/** The NDJSON record separator. */
const NEWLINE = Buffer.from("\n", "utf8");

/** A running count, shared between the transform and its caller. */
interface RowCounter {
  /** Rows written so far. */
  rowsWritten: number;
}

/**
 * Convert one row of the export query to the bytes of an NDJSON line.
 *
 * The `json` value arrives as a Buffer: the stored bytes for a BLOB column, or
 * the UTF-8 serialisation of a native JSON column. Writing bytes rather than a
 * decoded string is what keeps a BLOB export byte for byte identical to what
 * was loaded.
 * @param resourceType - Resource type being exported, for error messages.
 * @param counter - Running row count, incremented here.
 * @param onProgress - Optional callback invoked every
 *   {@link PROGRESS_INTERVAL_ROWS} rows.
 * @returns A transform stream from query rows to NDJSON bytes.
 */
function createNdjsonTransform(
  resourceType: string,
  counter: RowCounter,
  onProgress?: (rowsWritten: number) => void,
): Transform {
  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding, callback): void {
      const rowNumber = counter.rowsWritten + 1;
      // The query runs with OUT_FORMAT_ARRAY and selects one column, so every
      // row is a single-element array holding the json value.
      if (!Array.isArray(chunk)) {
        callback(
          new Error(
            `Row ${rowNumber} of ${resourceType} was not returned in the ` +
              `expected array form.`,
          ),
        );
        return;
      }
      const json: unknown = chunk[0];

      if (json === null || json === undefined) {
        callback(
          new Error(
            `Row ${rowNumber} of ${resourceType} has a null json value.`,
          ),
        );
        return;
      }
      if (!Buffer.isBuffer(json)) {
        callback(
          new Error(
            `Row ${rowNumber} of ${resourceType} returned an unexpected ` +
              `json value of type ${typeof json}.`,
          ),
        );
        return;
      }
      // NDJSON carries one resource per line, so a stored document containing
      // a line break cannot be written verbatim without producing a file that
      // cannot be loaded again.
      if (json.includes("\n") || json.includes("\r")) {
        callback(
          new Error(
            `Row ${rowNumber} of ${resourceType} spans multiple lines, which ` +
              `cannot be represented in NDJSON. Store each resource as a ` +
              `single line of JSON.`,
          ),
        );
        return;
      }

      counter.rowsWritten = rowNumber;
      if (onProgress && counter.rowsWritten % PROGRESS_INTERVAL_ROWS === 0) {
        onProgress(counter.rowsWritten);
      }
      callback(null, Buffer.concat([json, NEWLINE]));
    },
  });
}

/**
 * Tear a query stream down and wait for it to settle.
 *
 * The connection cannot be returned to the pool while a result set is still
 * open on it, so an aborted export waits for the stream to close before the
 * caller releases the connection.
 * @param rows - The query stream.
 */
async function closeQueryStream(rows: Readable): Promise<void> {
  if (!rows.destroyed) {
    rows.destroy();
  }
  // A stream destroyed mid-flight reports a premature close; that is the
  // expected outcome here and the original failure is the useful one.
  await finished(rows).catch(() => {
    // Deliberately ignored; see above.
  });
}

/**
 * Remove a partially written file.
 *
 * A half-written file would look like a complete export, so it is removed. If
 * the removal itself fails - the path is a directory, say, or the parent is not
 * writable - the original error is still the useful one, so the cleanup failure
 * is swallowed rather than allowed to replace it.
 * @param path - Path of the file to remove.
 */
function removePartialFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Deliberately ignored; see above.
  }
}

/**
 * Export a single resource type to an NDJSON file.
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Name of the table to read from.
 * @param jsonType - Storage type of the table's json column.
 * @param resourceType - FHIR resource type to export.
 * @param path - Path of the file to write; truncated if it exists.
 * @param onProgress - Optional callback invoked with the running row count.
 * @returns Promise that resolves to the number of resources written.
 * @throws {Error} if the query fails, the file cannot be written, or a stored
 *   resource is null or spans multiple lines. Any partially written file is
 *   removed.
 */
export async function exportResourceType(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
  jsonType: ResourceJsonDataType,
  resourceType: string,
  path: string,
  onProgress?: (rowsWritten: number) => void,
): Promise<number> {
  const query = buildResourceExportQuery(schemaName, tableName, jsonType);
  const counter: RowCounter = { rowsWritten: 0 };
  const connection = await pool.getConnection();

  try {
    const rows = connection.queryStream(
      query,
      { resourceType },
      {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        // Fetch the json column as a Buffer rather than a Lob, so each
        // resource is handed over as the bytes to be written.
        fetchTypeHandler: () => ({ type: oracledb.BUFFER }),
        fetchArraySize: FETCH_ARRAY_SIZE,
      },
    ) as unknown as Readable;

    try {
      await pipeline(
        rows,
        createNdjsonTransform(resourceType, counter, onProgress),
        // Truncates any existing file, which is only reachable once the
        // caller's overwrite pre-flight has passed.
        createWriteStream(path, { flags: "w" }),
      );
    } finally {
      await closeQueryStream(rows);
    }

    onProgress?.(counter.rowsWritten);
    return counter.rowsWritten;
  } catch (error) {
    removePartialFile(path);
    throw error;
  } finally {
    await connection.close();
  }
}
