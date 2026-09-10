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
 * File discovery for NDJSON loader.
 * Scans directories and matches files against configurable patterns.
 * @author John Grimes
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import type {
  DiscoveredFile,
  DiscoveryResult,
  LoadOptions,
  SkippedFile,
} from "./types.js";

/**
 * Default file pattern.
 * Format: {ResourceType}.ndjson
 * Example: Patient.ndjson
 */
const DEFAULT_PATTERN = "{ResourceType}.ndjson";

/**
 * Discover NDJSON files in a directory matching the specified pattern.
 * Files not matching the pattern are skipped and reported (data-model.md:
 * non-matching filenames are skipped with a report).
 * @param options - Loader options containing directory and resource type.
 * @returns Selected files plus a report of skipped files.
 */
export function discoverFiles(options: LoadOptions): DiscoveryResult {
  const files: DiscoveredFile[] = [];
  const skipped: SkippedFile[] = [];

  // Get all entries from the directory.
  const entries = readdirSync(options.directory);

  for (const entry of entries) {
    const filePath = path.join(options.directory, entry);
    const stats = statSync(filePath);

    // Skip directories.
    if (stats.isDirectory()) {
      continue;
    }

    // Parse the filename against the pattern.
    const metadata = parseFilename(entry, DEFAULT_PATTERN);

    // Report files that don't match the pattern.
    if (!metadata) {
      skipped.push({
        file: entry,
        reason: `does not match {ResourceType}.ndjson`,
      });
      continue;
    }

    // Apply resource type filter if specified.
    if (options.resourceType && metadata.resourceType !== options.resourceType)
 {
      skipped.push({
        file: entry,
        reason: `resource type ${metadata.resourceType} does not match the requested type ${options.resourceType}`,
      });
      continue;
    }

    files.push({
      path: filePath,
      resourceType: metadata.resourceType,
      size: stats.size,
    });
  }

  return { files, skipped };
}

/**
 * Parse a filename against the pattern to extract resource type.
 *
 * Pattern placeholders:
 * - {ResourceType} - Required, matches the FHIR resource type.
 *
 * Example:
 * - Pattern: "{ResourceType}.ndjson" matches "Patient.ndjson" -> { resourceType: "Patient" }
 * @param filename - The filename to parse.
 * @param pattern - The pattern to match against.
 * @returns Metadata if the filename matches, undefined otherwise.
 */
export function parseFilename(
  filename: string,
  pattern: string,
): { resourceType: string } | undefined {
  // Convert the pattern to a regular expression.
  // Replace {ResourceType} with a named capture group that matches word characters.
  // FHIR resource types are PascalCase (e.g., Patient, Observation).
  let regexPattern = pattern.replace(
    "{ResourceType}",
    "(?<resourceType>[A-Z][A-Za-z0-9]*)",
  );

  // Escape special regex characters in the pattern (dots, etc.).
  regexPattern = regexPattern.replaceAll(".", String.raw`\.`);

  // Anchor the pattern to match the entire filename.
  regexPattern = `^${regexPattern}$`;

  const regex = new RegExp(regexPattern);
  const match = regex.exec(filename);

  if (!match?.groups) {
    return undefined;
  }

  const { resourceType } = match.groups;

  if (!resourceType) {
    return undefined;
  }

  return {
    resourceType,
  };
}

/**
 * Group discovered files by resource type.
 * @param files - Array of discovered files.
 * @returns Map of resource type to files.
 */
export function groupFilesByResourceType(
  files: DiscoveredFile[],
): Map<string, DiscoveredFile[]> {
  const grouped = new Map<string, DiscoveredFile[]>();

  for (const file of files) {
    const existing = grouped.get(file.resourceType) ?? [];
    existing.push(file);
    grouped.set(file.resourceType, existing);
  }

  return grouped;
}
