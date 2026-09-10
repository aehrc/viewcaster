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
 * Main orchestration for NDJSON loader.
 * Coordinates file discovery, table management, and loading operations.
 * @author John Grimes
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import oracledb from "oracledb";

import {
  normaliseResourceJsonDataType,
  type ResourceJsonDataType,
} from "../validation.js";
import {
  closeConnectionPool,
  createConnectionPool,
  testConnection,
} from "./connection.js";
import { discoverFiles, groupFilesByResourceType } from "./discovery.js";
import {
  completeFileProgress,
  createLoadResult,
  createProgressTracker,
  initializeFileProgress,
  printSimpleProgress,
  printSummary,
  printVerboseProgress,
  updateFileProgress,
} from "./progress.js";
import { loadFile } from "./stream.js";
import {
  buildJsonTypeMismatchWarning,
  ensureTable,
  getExistingJsonColumnType,
} from "./tables.js";

import type {
  DiscoveredFile,
  LoadOptions,
  LoaderProgress,
  LoadResult,
} from "./types.js";

/**
 * The canonical default storage type for the resources table `json` column
 * (data-model.md): BLOB with an `IS JSON` check constraint, supported from
 * Oracle 19c.
 */
const DEFAULT_JSON_TYPE: ResourceJsonDataType = "BLOB";

/**
 * Discover and log files to be loaded.
 * @param options - Loader options.
 * @returns Discovered files.
 */
function discoverAndLogFiles(options: LoadOptions): DiscoveredFile[] {
  if (options.verbose) {
    console.log(`Discovering NDJSON files in ${options.directory}...`);
  }

  const { files, skipped } = discoverFiles(options);

  if (!options.quiet && skipped.length > 0) {
    // Non-matching filenames are skipped with a report (data-model.md).
    console.log(
      `Skipping ${skipped.length} file(s) that do not match {ResourceType}.ndjson:`,
    );
    for (const entry of skipped) {
      console.log(`  ${entry.file}: ${entry.reason}`);
    }
  }

  if (files.length === 0) {
    if (!options.quiet) {
      console.log("No NDJSON files found matching the criteria");
    }
    return [];
  }

  if (!options.quiet) {
    const filesByResourceType = groupFilesByResourceType(files);
    console.log(
      `Found ${files.length} file(s) for ${filesByResourceType.size} resource type(s):\n`,
    );
    for (const [resourceType, resourceFiles] of filesByResourceType) {
      console.log(`  ${resourceType}: ${resourceFiles.length} file(s)`);
    }
    console.log();
  }

  return files;
}

/**
 * Count the loadable (non-blank) lines of an NDJSON file, for dry-run
 * reporting. The loader does not parse resources beyond JSON well-formedness,
 * so the dry run only counts non-blank lines.
 * @param file - The file to count.
 * @returns The number of non-blank lines.
 */
async function countNdjsonLines(file: DiscoveredFile): Promise<number> {
  const fileStream = createReadStream(file.path, { encoding: "utf8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  let count = 0;
  for await (const line of rl) {
    if (line.trim()) {
      count++;
    }
  }
  return count;
}

/**
 * Prepare database table for loading.
 * @param pool - Database connection pool.
 * @param options - Loader options.
 * @param jsonType - Requested storage type.
 * @returns Table schema, name and the effective storage type to load with.
 */

async function prepareTable(
  pool: oracledb.Pool,
  options: LoadOptions,
  jsonType: ResourceJsonDataType,
): Promise<{
  schemaName: string | undefined;
  tableName: string;
  jsonType: ResourceJsonDataType;
}> {
  const schemaName = options.schemaName;
  const tableName = options.tableName ?? "fhir_resources";

  let effective: ResourceJsonDataType;
  if (options.createTable === false) {
    // Table creation is disabled: an absent table is an error, and an
    // existing table's own column type governs the binds.
    const existingType = await getExistingJsonColumnType(
      pool,
      schemaName,
      tableName,
    );
    if (existingType === null) {
      throw new Error(
        `Table ${schemaName ? `${schemaName}.` : ""}${tableName} does not exist and table creation is disabled.`,
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
    effective = existingType;
  } else {
    if (options.verbose) {
      console.log(
        `Ensuring table ${schemaName ? `${schemaName}.` : ""}${tableName} exists as ${jsonType}${options.truncate ? " (will truncate)" : ""}...`,
      );
    }
    effective = await ensureTable(
      pool,
      schemaName,
      tableName,
      options.truncate ?? false,
      jsonType,
    );
  }

  return { schemaName, tableName, jsonType: effective };
}

/**
 * Load files in parallel chunks.
 * @param pool - Database connection pool.
 * @param files - Files to load.
 * @param options - Loader options.
 * @param schemaName - Schema name.
 * @param tableName - Table name.
 * @param jsonType - Resolved storage type.
 * @param progress - Progress tracker.
 */

async function loadFilesInChunks(
  pool: oracledb.Pool,
  files: DiscoveredFile[],
  options: LoadOptions,
  schemaName: string | undefined,
  tableName: string,
  jsonType: ResourceJsonDataType,
  progress: LoaderProgress,
): Promise<void> {
  const parallel = options.parallel ?? 4;
  const continueOnError = options.continueOnError ?? false;
  const chunks: DiscoveredFile[][] = [];
  for (let i = 0; i < files.length; i += parallel) {
    chunks.push(files.slice(i, i + parallel));
  }

  for (const chunk of chunks) {
    const loadPromises = chunk.map(async (file) => {
      initializeFileProgress(progress, file);

      const result = await loadFile(
        pool,
        file,
        schemaName,
        tableName,
        jsonType,
        options.batchSize ?? 1000,
        continueOnError,
        (rowsLoaded) => {
          updateFileProgress(progress, file.path, rowsLoaded);
          if (options.progress && !options.verbose) {
            printSimpleProgress(progress);
          }
        },
      );

      completeFileProgress(progress, result);

      if (options.verbose) {
        printVerboseProgress(progress);
      }

      if (result.error && !continueOnError) {
        throw new Error(`Failed to load ${file.path}: ${result.error}`);
      }

      return result;
    });

    await Promise.all(loadPromises);
  }
}

/**
 * Report the files that would be loaded without touching the database.
 * @param files - Discovered files.
 * @param options - Loader options.
 * @returns The load result, with counts per file.
 */
async function performDryRun(
  files: DiscoveredFile[],
  options: LoadOptions,
): Promise<LoadResult> {
  if (!options.quiet) {
    console.log("Dry run - no data will be loaded\n");
  }
  const progress = createProgressTracker(files);
  const fileCounts = await Promise.all(
    files.map(async (file) => ({
      file,
      rows: await countNdjsonLines(file),
    })),
  );
  for (const { file, rows } of fileCounts) {
    if (!options.quiet) {
      console.log(`  ${file.resourceType}: ${rows} rows would be loaded`);
    }
    initializeFileProgress(progress, file);
    completeFileProgress(progress, {
      file,
      rowsLoaded: rows,
      rowsFailed: 0,
      errors: [],
      durationMs: 0,
    });
  }
  return createLoadResult(progress);
}

/**
 * Perform the actual loading process.
 * @param pool - Database connection pool.
 * @param files - Files to load.
 * @param options - Loader options.
 * @param jsonType - Resolved storage type.
 * @returns The load result.
 */
async function performLoad(
  pool: oracledb.Pool,
  files: DiscoveredFile[],
  options: LoadOptions,
  jsonType: ResourceJsonDataType,
): Promise<LoadResult> {
  const connected = await testConnection(pool);
  if (!connected) {
    throw new Error("Failed to connect to database");
  }

  if (!options.quiet) {
    console.log("Connected successfully\n");
  }

  const startTime = Date.now();
  const progress = createProgressTracker(files);
  const {
    schemaName,
    tableName,
    jsonType: effectiveType,
  } = await prepareTable(pool, options, jsonType);

  if (!options.quiet) {
    console.log("Loading files...\n");
  }

  await loadFilesInChunks(
    pool,
    files,
    options,
    schemaName,
    tableName,
    effectiveType,
    progress,
  );

  if (options.progress && !options.verbose && !options.quiet) {
    process.stdout.write("\r" + " ".repeat(80) + "\r");
  }

  const result = createLoadResult(progress);
  if (!options.quiet) {
    printSummary(result, Date.now() - startTime);
  }
  return result;
}

/**
 * Load NDJSON files from a directory into Oracle Database.
 * @param options - Loader options.
 * @returns Promise that resolves to the load result.
 */
export async function loadNdjsonFiles(
  options: LoadOptions,
): Promise<LoadResult> {
  // Resolve and validate the json column storage type before any file
  // discovery, connection or DDL. An invalid value throws synchronously here,
  // so misconfiguration is reported before a connection is opened.
  const jsonType: ResourceJsonDataType =
    options.resourceJsonDataType === undefined
      ? DEFAULT_JSON_TYPE
      : normaliseResourceJsonDataType(options.resourceJsonDataType);

  const files = discoverAndLogFiles(options);

  if (files.length === 0) {
    return createLoadResult(createProgressTracker([]));
  }

  if (options.dryRun) {
    return performDryRun(files, options);
  }

  if (!options.quiet) {
    const { host, port, serviceName } = options.database;
    console.log(
      `Connecting to Oracle Database at ${host}:${String(port ?? 1521)}/${serviceName ?? "FREEPDB1"}...`,
    );
  }

  const pool = await createConnectionPool(options.database);

  try {
    return await performLoad(pool, files, options, jsonType);
  } finally {
    await closeConnectionPool(pool);
  }
}

/**
 * Export all loader functionality.
 */
export * from "./types.js";
export * from "./connection.js";
export * from "./discovery.js";
export * from "./tables.js";
export * from "./stream.js";
export * from "./progress.js";
