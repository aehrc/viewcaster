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
 * Main orchestration for the NDJSON exporter.
 *
 * Reads FHIR resources out of the resources table and writes one
 * `{ResourceType}.ndjson` file per distinct resource type, so an exported
 * directory can be fed straight back into the loader.
 * @author John Grimes
 */

import path from "node:path";
import oracledb from "oracledb";

import {
  assertDistinctOutputFileNames,
  assertNoExistingOutputFiles,
  assertSafeResourceTypeNames,
  ensureOutputDirectory,
  exportFileName,
} from "./files.js";
import {
  createExportProgress,
  printExportSummary,
  printSimpleExportProgress,
  printVerboseExportProgress,
} from "./progress.js";
import {
  buildDistinctResourceTypesQuery,
  validateTableIdentifiers,
} from "./queries.js";
import { exportResourceType } from "./stream.js";
import {
  closeConnectionPool,
  createConnectionPool,
  testConnection,
} from "../loader/connection.js";
import { getExistingJsonColumnType, tableExists } from "../loader/tables.js";

import type { ResourceJsonDataType } from "../validation.js";
import type { ExportProgress } from "./progress.js";
import type { ExportedFile, ExportOptions, ExportResult } from "./types.js";

/** Table read from when none is given, matching the loader. */
const DEFAULT_TABLE_NAME = "fhir_resources";

/**
 * The table an export reads from, and how its json column is stored.
 */
interface ExportTarget {
  /** Schema name, or undefined for the connected user's schema. */
  schemaName: string | undefined;
  /** Table name. */
  tableName: string;
  /** Storage type of the table's json column. */
  jsonType: ResourceJsonDataType;
}

/**
 * Render a table name for a message, qualified when a schema is given.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Table name.
 * @returns The qualified table name.
 */
function describeTable(
  schemaName: string | undefined,
  tableName: string,
): string {
  return schemaName ? `${schemaName}.${tableName}` : tableName;
}

/**
 * List the distinct resource types held in the table.
 * @param pool - Database connection pool.
 * @param schemaName - Schema name, or undefined for the current schema.
 * @param tableName - Table name.
 * @param resourceType - Optional single resource type to restrict the list to.
 * @returns The distinct resource types, in name order.
 */
async function listResourceTypes(
  pool: oracledb.Pool,
  schemaName: string | undefined,
  tableName: string,
  resourceType?: string,
): Promise<string[]> {
  const connection = await pool.getConnection();
  try {
    const result = await connection.execute<{ RESOURCE_TYPE: string }>(
      buildDistinctResourceTypesQuery(
        schemaName,
        tableName,
        resourceType !== undefined,
      ),
      resourceType === undefined ? {} : { resourceType },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((row) => row.RESOURCE_TYPE);
  } finally {
    await connection.close();
  }
}

/**
 * Write one resource type's file, updating the progress tracker.
 * @param pool - Database connection pool.
 * @param options - Exporter options.
 * @param target - Table to read from.
 * @param resourceType - Resource type to write.
 * @param progress - Progress tracker to update.
 * @param showProgress - Whether to print the progress line.
 * @returns The file that was written.
 */
async function writeResourceTypeFile(
  pool: oracledb.Pool,
  options: ExportOptions,
  target: ExportTarget,
  resourceType: string,
  progress: ExportProgress,
  showProgress: boolean,
): Promise<ExportedFile> {
  progress.currentResourceType = resourceType;
  progress.currentRowsWritten = 0;
  const file = path.join(options.directory, exportFileName(resourceType));

  const rowsWritten = await exportResourceType(
    pool,
    target.schemaName,
    target.tableName,
    target.jsonType,
    resourceType,
    file,
    (rows) => {
      progress.currentRowsWritten = rows;
      if (showProgress) {
        printSimpleExportProgress(progress);
      }
    },
  );

  progress.filesCompleted++;
  progress.totalRowsWritten += rowsWritten;
  progress.currentResourceType = null;
  progress.currentRowsWritten = 0;

  return { resourceType, path: file, rowsWritten };
}

/**
 * Write one file per resource type, in turn.
 * @param pool - Database connection pool.
 * @param options - Exporter options.
 * @param target - Table to read from.
 * @param resourceTypes - Resource types to export.
 * @returns The files written, in the order they were produced.
 */
async function writeResourceTypeFiles(
  pool: oracledb.Pool,
  options: ExportOptions,
  target: ExportTarget,
  resourceTypes: string[],
): Promise<ExportedFile[]> {
  const showProgress =
    options.progress === true && !options.verbose && !options.quiet;
  const progress = createExportProgress(resourceTypes.length);
  const files: ExportedFile[] = [];

  for (const resourceType of resourceTypes) {
    const file = await writeResourceTypeFile(
      pool,
      options,
      target,
      resourceType,
      progress,
      showProgress,
    );
    files.push(file);
    if (options.verbose && !options.quiet) {
      printVerboseExportProgress(file);
    }
    if (showProgress) {
      printSimpleExportProgress(progress);
    }
  }

  if (showProgress) {
    // Clear the progress line before the summary is printed.
    process.stdout.write("\r" + " ".repeat(80) + "\r");
  }

  return files;
}

/**
 * Resolve the table to export from, failing if it cannot be read.
 * @param pool - Database connection pool.
 * @param options - Exporter options.
 * @returns The export target, including the json column's storage type.
 * @throws {Error} if the table does not exist, or its json column is missing
 *   or of a type that cannot hold a serialised FHIR resource.
 */
async function resolveTarget(
  pool: oracledb.Pool,
  options: ExportOptions,
): Promise<ExportTarget> {
  const schemaName = options.schemaName;
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  const qualified = describeTable(schemaName, tableName);

  if (!(await tableExists(pool, schemaName, tableName))) {
    throw new Error(
      `Table ${qualified} does not exist. Load resources before exporting, ` +
        `or pass --table-name.`,
    );
  }

  // The storage type decides how the column is read: BLOB bytes are written
  // verbatim, while a native JSON column has to be serialised first.
  const jsonType = await getExistingJsonColumnType(pool, schemaName, tableName);
  if (jsonType === null) {
    throw new Error(
      `Table ${qualified} has no json column, so it holds no resources to ` +
        `export.`,
    );
  }

  return { schemaName, tableName, jsonType };
}

/**
 * Work out which resource types to export, rejecting anything that cannot be
 * written safely.
 *
 * Every check here runs before a single file is opened, so a failure leaves the
 * output directory exactly as it was.
 * @param pool - Database connection pool.
 * @param options - Exporter options.
 * @param target - Table to read from.
 * @returns The resource types to export, empty if there is nothing to do.
 * @throws {Error} if a `resource_type` value is unusable as a file name, or an
 *   output file already exists and overwrite was not requested.
 */
async function planExport(
  pool: oracledb.Pool,
  options: ExportOptions,
  target: ExportTarget,
): Promise<string[]> {
  const resourceTypes = await listResourceTypes(
    pool,
    target.schemaName,
    target.tableName,
    options.resourceType,
  );

  if (resourceTypes.length === 0) {
    if (!options.quiet) {
      const scope = options.resourceType
        ? ` of type ${options.resourceType}`
        : "";
      console.log(
        `No resources${scope} found in ` +
          `${describeTable(target.schemaName, target.tableName)}; ` +
          `nothing to export.`,
      );
    }
    return [];
  }

  assertSafeResourceTypeNames(resourceTypes);
  assertDistinctOutputFileNames(resourceTypes);
  assertNoExistingOutputFiles(
    options.directory,
    resourceTypes,
    options.overwrite === true,
  );
  return resourceTypes;
}

/**
 * Run the export against an open pool.
 * @param pool - Database connection pool.
 * @param options - Exporter options.
 * @returns The files written.
 * @throws {Error} if the connection is unusable or the export cannot proceed.
 */
async function performExport(
  pool: oracledb.Pool,
  options: ExportOptions,
): Promise<ExportedFile[]> {
  if (!(await testConnection(pool))) {
    throw new Error("Failed to connect to database");
  }
  if (!options.quiet) {
    console.log("Connected successfully\n");
  }

  const target = await resolveTarget(pool, options);
  const resourceTypes = await planExport(pool, options, target);
  if (resourceTypes.length === 0) {
    return [];
  }

  ensureOutputDirectory(options.directory);
  if (!options.quiet) {
    console.log(
      `Exporting ${resourceTypes.length} resource type(s) to ${options.directory}...\n`,
    );
  }

  return writeResourceTypeFiles(pool, options, target, resourceTypes);
}

/**
 * Export FHIR resources from Oracle Database into NDJSON files.
 *
 * Writes one `{ResourceType}.ndjson` file per distinct resource type, streaming
 * rows so a table larger than available memory can be exported. A BLOB column
 * is written verbatim, so the export reproduces what was loaded byte for byte;
 * a native JSON column (21c+) is serialised by the database, which is
 * equivalent but not byte identical, because Oracle normalises a document as it
 * encodes it.
 * @param options - Exporter options.
 * @returns Promise that resolves to the export result.
 * @throws {Error} if the schema or table name is invalid, the table or its json
 *   column is missing, a `resource_type` value is not a valid FHIR resource
 *   type name, an output file already exists and overwrite was not requested,
 *   or the export fails part way through.
 * @example
 * await exportNdjsonFiles({
 *   directory: "./out",
 *   database: { user: "fhir", password: "fhir" },
 * });
 */
export async function exportNdjsonFiles(
  options: ExportOptions,
): Promise<ExportResult> {
  // Reject a malformed schema or table name before a connection is opened, so
  // misconfiguration is reported immediately.
  validateTableIdentifiers(
    options.schemaName,
    options.tableName ?? DEFAULT_TABLE_NAME,
  );

  const startTime = Date.now();
  if (!options.quiet) {
    const { host, port, serviceName } = options.database;
    console.log(
      `Connecting to Oracle Database at ${host}:${String(port ?? 1521)}/${serviceName ?? "FREEPDB1"}...`,
    );
  }

  const pool = await createConnectionPool(options.database);
  let files: ExportedFile[];
  try {
    files = await performExport(pool, options);
  } finally {
    await closeConnectionPool(pool);
  }

  const result: ExportResult = {
    files,
    totalRows: files.reduce((total, file) => total + file.rowsWritten, 0),
    durationMs: Date.now() - startTime,
  };

  if (!options.quiet && files.length > 0) {
    printExportSummary(result);
  }

  return result;
}

/**
 * Export all exporter functionality.
 */
export * from "./types.js";
export * from "./files.js";
export * from "./queries.js";
export * from "./stream.js";
export * from "./progress.js";
