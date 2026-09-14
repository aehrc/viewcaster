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
 * Type definitions for the NDJSON exporter.
 * @author John Grimes
 */

import type { DatabaseOptions } from "../loader/types.js";

/**
 * Options for the NDJSON exporter.
 */
export interface ExportOptions {
  /** Directory to write the NDJSON files into; created if missing. */
  directory: string;
  /** Database connection configuration. */
  database: DatabaseOptions;
  /** Export only this resource type. */
  resourceType?: string;
  /** Table holding the resources (default: fhir_resources). */
  tableName?: string;
  /** Schema name (default: the connected user's schema). */
  schemaName?: string;
  /** Replace existing output files instead of failing. */
  overwrite?: boolean;
  /** Enable verbose logging. */
  verbose?: boolean;
  /** Minimal output. */
  quiet?: boolean;
  /** Show progress line. */
  progress?: boolean;
}

/**
 * A single file written by the exporter.
 */
export interface ExportedFile {
  /** FHIR resource type written to the file. */
  resourceType: string;
  /** Full path to the written file. */
  path: string;
  /** Number of resources written. */
  rowsWritten: number;
}

/**
 * Result of an export operation.
 */
export interface ExportResult {
  /** The files written, in the order they were produced. */
  files: ExportedFile[];
  /** Total resources written across all files. */
  totalRows: number;
  /** Duration in milliseconds. */
  durationMs: number;
}
