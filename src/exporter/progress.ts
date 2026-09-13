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
 * Progress reporting for the NDJSON exporter.
 *
 * The exporter writes one file at a time and fails fast, so its progress model
 * is simpler than the loader's: a file count, a running row count, and the
 * resource type currently being written. Duration and throughput formatting is
 * shared with the loader.
 * @author John Grimes
 */

import { formatDuration, formatThroughput } from "../loader/progress.js";

import type { ExportedFile, ExportResult } from "./types.js";

/**
 * Progress of an export in flight.
 */
export interface ExportProgress {
  /** Number of resource types to be written. */
  totalFiles: number;
  /** Number of files completed so far. */
  filesCompleted: number;
  /** Rows written across all completed files. */
  totalRowsWritten: number;
  /** Resource type currently being written, if any. */
  currentResourceType: string | null;
  /** Rows written so far for the current resource type. */
  currentRowsWritten: number;
}

/**
 * Create a progress tracker.
 * @param totalFiles - Number of resource types to be written.
 * @returns A tracker with no progress recorded.
 */
export function createExportProgress(totalFiles: number): ExportProgress {
  return {
    totalFiles,
    filesCompleted: 0,
    totalRowsWritten: 0,
    currentResourceType: null,
    currentRowsWritten: 0,
  };
}

/**
 * Format progress as a status string.
 *
 * The row total includes the file in flight, so a table with one large
 * resource type still shows movement.
 * @param progress - Progress tracker.
 * @returns Formatted status string.
 * @example
 * // "[1/2 files (50%)] Observation: 2500 rows written"
 */
export function formatExportProgressStatus(progress: ExportProgress): string {
  const percentage = (
    (progress.filesCompleted / progress.totalFiles) *
    100
  ).toFixed(0);
  const total = progress.totalRowsWritten + progress.currentRowsWritten;
  const current = progress.currentResourceType
    ? ` ${progress.currentResourceType}:`
    : "";
  return `[${progress.filesCompleted}/${progress.totalFiles} files (${percentage}%)]${current} ${total} rows written`;
}

/**
 * Print a single, overwritable progress line.
 * @param progress - Progress tracker.
 */
export function printSimpleExportProgress(progress: ExportProgress): void {
  process.stdout.write(`\r${formatExportProgressStatus(progress)}`);
}

/**
 * Print a line for a completed file.
 * @param file - The file that was written.
 */
export function printVerboseExportProgress(file: ExportedFile): void {
  console.log(
    `  COMPLETE ${file.resourceType}: ${file.rowsWritten} rows written -> ${file.path}`,
  );
}

/**
 * Print a summary of the export operation.
 * @param result - The export result.
 */
export function printExportSummary(result: ExportResult): void {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("NDJSON Exporter Summary");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const file of result.files) {
    console.log(`  ${file.resourceType}: ${file.rowsWritten} rows written`);
  }
  console.log(`Total rows written: ${result.totalRows}`);
  console.log(`Duration:       ${formatDuration(result.durationMs)}`);
  console.log(
    `Throughput:     ${formatThroughput(result.totalRows, result.durationMs)} rows/sec`,
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}
