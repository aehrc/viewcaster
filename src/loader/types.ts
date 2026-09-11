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
 * Type definitions for the NDJSON loader.
 * @author John Grimes
 */

/**
 * Database connection configuration.
 *
 * An explicit {@link DatabaseOptions.connectString} overrides the EZConnect
 * string assembled from {@link DatabaseOptions.host}, {@link
 * DatabaseOptions.port} and {@link DatabaseOptions.serviceName}.
 */
export interface DatabaseOptions {
  /** Database host (default: `localhost`; env `ORACLE_HOST`). */
  host?: string;
  /** Listener port (default: `1521`; env `ORACLE_PORT`). */
  port?: number;
  /** Database service name (default: `FREEPDB1`; env `ORACLE_SERVICE_NAME`). */
  serviceName?: string;
  /** Database username (env `ORACLE_USER`). */
  user: string;
  /** Database password (env `ORACLE_PASSWORD`). */
  password: string;
  /** Full connect string; overrides host/port/serviceName (env `ORACLE_CONNECT_STRING`). */
  connectString?: string;
}

/**
 * Discovered NDJSON file with metadata.
 */
export interface DiscoveredFile {
  /** Full path to the file. */
  path: string;
  /** FHIR resource type extracted from filename. */
  resourceType: string;
  /** File size in bytes. */
  size: number;
}

/**
 * A file present in the loading directory that was not selected for loading.
 */
export interface SkippedFile {
  /** Name of the skipped file. */
  file: string;
  /** Why the file was skipped. */
  reason: string;
}

/**
 * The result of scanning a directory for NDJSON files.
 */
export interface DiscoveryResult {
  /** Files selected for loading. */
  files: DiscoveredFile[];
  /** Files skipped, with a reason for each (FR: skipped with a report). */
  skipped: SkippedFile[];
}

/**
 * Options for the NDJSON loader.
 */
export interface LoadOptions {
  /** Directory containing NDJSON files. */
  directory: string;
  /** Database connection configuration. */
  database: DatabaseOptions;
  /** Filter to specific resource type. */
  resourceType?: string;
  /** Table name for storing resources (default: fhir_resources). */
  tableName?: string;
  /** Schema name (default: the connected user's schema). */
  schemaName?: string;
  /**
   * Storage type for the resources table `json` column. One of `BLOB`
   * (default, Oracle 19c+, `CHECK (json IS JSON)`) or `JSON` (native type,
   * 21c+). Matching is case-insensitive. `JSON` on a pre-21c server fails
   * fast. The value is validated against the allowlist before any database
   * connection is opened.
   */
  resourceJsonDataType?: string;
  /** Create the table if it doesn't exist (default: true). */
  createTable?: boolean;
  /** Truncate the table before loading. */
  truncate?: boolean;
  /** Number of rows per `executeMany` batch (default: 1000). */
  batchSize?: number;
  /** Number of files to process in parallel (default: 4). */
  parallel?: number;
  /** Continue loading other files if one fails. */
  continueOnError?: boolean;
  /** Show what would be loaded without loading. */
  dryRun?: boolean;
  /** Enable verbose logging. */
  verbose?: boolean;
  /** Minimal output. */
  quiet?: boolean;
  /** Show progress line. */
  progress?: boolean;
}

/**
 * Progress information for a file being loaded.
 */
export interface FileProgress {
  /** File being processed. */
  file: DiscoveredFile;
  /** Number of rows loaded. */
  rowsLoaded: number;
  /** Number of rows that failed to load. */
  rowsFailed: number;
  /** Whether the file has completed loading. */
  completed: boolean;
  /** Error message if the file failed to load. */
  error?: string;
}

/**
 * Overall progress for the loading operation.
 */
export interface LoaderProgress {
  /** Total number of files to process. */
  totalFiles: number;
  /** Number of files completed. */
  filesCompleted: number;
  /** Total rows loaded across all files. */
  totalRowsLoaded: number;
  /** Total rows failed across all files. */
  totalRowsFailed: number;
  /** Progress for each file. */
  fileProgress: Map<string, FileProgress>;
}

/**
 * Result of loading a single file.
 */
export interface FileLoadResult {
  /** File that was loaded. */
  file: DiscoveredFile;
  /** Number of rows successfully loaded. */
  rowsLoaded: number;
  /** Number of rows that failed to load. */
  rowsFailed: number;
  /** Error messages encountered while loading the file. */
  errors: string[];
  /** Duration in milliseconds. */
  durationMs: number;
  /** Primary error message if the file failed to load. */
  error?: string;
}

/**
 * Result of a loading operation.
 */
export interface LoadResult {
  /** Per-file outcome, one entry per loaded file. */
  files: Array<{
    /** Path of the loaded file. */
    file: string;
    /** FHIR resource type derived from the file name. */
    resourceType: string;
    /** Number of rows successfully loaded from the file. */
    rowsLoaded: number;
    /** Error messages for rows or the whole file. */
    errors: string[];
  }>;
  /** Total rows loaded across all files. */
  totalRows: number;
  /** Whether any file failed to load. */
  failed: boolean;
}
