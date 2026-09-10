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
 * Progress tracking for NDJSON loader.
 * Provides real-time progress updates and statistics.
 * @author John Grimes
 */

import type {
  DiscoveredFile,
  FileLoadResult,
  FileProgress,
  LoadResult,
  LoaderProgress,
} from "./types.js";

/**
 * Create a new progress tracker.
 * @param files - Array of files to track.
 * @returns New progress tracker.
 */
export function createProgressTracker(files: DiscoveredFile[]): LoaderProgress {
  return {
    totalFiles: files.length,
    filesCompleted: 0,
    totalRowsLoaded: 0,
    totalRowsFailed: 0,
    fileProgress: new Map<string, FileProgress>(),
  };
}

/**
 * Initialize progress for a file.
 * @param progress - Progress tracker.
 * @param file - File to initialize.
 */
export function initializeFileProgress(
  progress: LoaderProgress,
  file: DiscoveredFile,
): void {
  progress.fileProgress.set(file.path, {
    file,
    rowsLoaded: 0,
    rowsFailed: 0,
    completed: false,
  });
}

/**
 * Update progress for a file.
 * @param progress - Progress tracker.
 * @param filePath - Path to the file.
 * @param rowsLoaded - Number of rows loaded.
 */
export function updateFileProgress(
  progress: LoaderProgress,
  filePath: string,
  rowsLoaded: number,
): void {
  const fileProgress = progress.fileProgress.get(filePath);
  if (fileProgress) {
    fileProgress.rowsLoaded = rowsLoaded;
  }
}

/**
 * Mark a file as completed.
 * @param progress - Progress tracker.
 * @param result - File load result.
 */
export function completeFileProgress(
  progress: LoaderProgress,
  result: FileLoadResult,
): void {
  const fileProgress = progress.fileProgress.get(result.file.path);
  if (fileProgress) {
    fileProgress.rowsLoaded = result.rowsLoaded;
    fileProgress.rowsFailed = result.rowsFailed;
    fileProgress.completed = true;
    fileProgress.error = result.error;

    progress.filesCompleted++;
    progress.totalRowsLoaded += result.rowsLoaded;
    progress.totalRowsFailed += result.rowsFailed;
  }
}

/**
 * Format progress as a status string.
 * @param progress - Progress tracker.
 * @returns Formatted status string.
 */
export function formatProgressStatus(progress: LoaderProgress): string {
  const percentage = (
    (progress.filesCompleted / progress.totalFiles) *
    100
  ).toFixed(0);
  return `[${progress.filesCompleted}/${progress.totalFiles} files (${percentage}%)] ${progress.totalRowsLoaded} rows loaded`;
}

/**
 * Print verbose progress to console.
 * @param progress - Progress tracker.
 */
export function printVerboseProgress(progress: LoaderProgress): void {
  console.log(formatProgressStatus(progress));
  for (const [, fileProgress] of progress.fileProgress) {
    if (fileProgress.completed) {
      const status = fileProgress.error ? "FAILED" : "COMPLETE";
      const rows = `${fileProgress.rowsLoaded} rows`;
      const failed =
        fileProgress.rowsFailed > 0
          ? ` (${fileProgress.rowsFailed} failed)`
          : "";
      console.log(
        `  ${status} ${fileProgress.file.resourceType}: ${rows}${failed}`,
      );
      if (fileProgress.error) {
        console.log(`    Error: ${fileProgress.error}`);
      }
    }
  }
}

/**
 * Print simple progress line to console (can be overwritten).
 * @param progress - Progress tracker.
 */
export function printSimpleProgress(progress: LoaderProgress): void {
  process.stdout.write(`\r${formatProgressStatus(progress)}`);
}

/**
 * Build the load result from the progress tracker (contracts/api.md
 * `LoadResult`).
 * @param progress - Progress tracker.
 * @returns The load result with one entry per file.
 */
export function createLoadResult(progress: LoaderProgress): LoadResult {
  const files: LoadResult["files"] = [];
  for (const [, fileProgress] of progress.fileProgress) {
    files.push({
      file: fileProgress.file.path,
      resourceType: fileProgress.file.resourceType,
      rowsLoaded: fileProgress.rowsLoaded,
      errors: fileProgress.error ? [fileProgress.error] : [],
    });
  }
  return {
    files,
    totalRows: progress.totalRowsLoaded,
    failed: progress.totalRowsFailed > 0,
  };
}

/**
 * Print a summary of the loading operation.
 * @param result - The load result.
 * @param durationMs - Duration in milliseconds.
 */
export function printSummary(result: LoadResult, durationMs: number): void {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("NDJSON Loader Summary");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const file of result.files) {
    const failed = file.errors.length > 0 ? " (FAILED)" : "";
    console.log(
      `  ${file.resourceType}: ${file.rowsLoaded} rows loaded${failed}`,
    );
    for (const error of file.errors) {
      console.log(`    Error: ${error}`);
    }
  }
  console.log(`Total rows loaded: ${result.totalRows}`);
  console.log(`Duration:       ${formatDuration(durationMs)}`);
  console.log(
    `Throughput:     ${formatThroughput(result.totalRows, durationMs)} rows/sec`,
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

/**
 * Format duration in human-readable format.
 * @param ms - Duration in milliseconds.
 * @returns Formatted duration string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else if (seconds > 0) {
    return `${seconds}s`;
  } else {
    return `${ms}ms`;
  }
}

/**
 * Format throughput in rows per second.
 * @param rows - Number of rows.
 * @param ms - Duration in milliseconds.
 * @returns Formatted throughput string.
 */
function formatThroughput(rows: number, ms: number): string {
  if (ms === 0) return "0";
  const rowsPerSec = (rows / ms) * 1000;
  return rowsPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
