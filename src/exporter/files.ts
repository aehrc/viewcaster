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
 * Output file naming and pre-flight checks for the NDJSON exporter.
 *
 * Exported file names are derived from the `resource_type` column, which is
 * ordinary table data rather than trusted input, so its values are validated
 * here before they are ever joined onto a path.
 * @author John Grimes
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The shape of a FHIR resource type name: an upper-case letter followed by
 * letters and digits, no longer than the `resource_type` column
 * (`VARCHAR2(64)`). This is deliberately the same shape the loader's file name
 * pattern accepts (`parseFilename` in `../loader/discovery.ts`, which matches
 * `[A-Z][A-Za-z0-9]*`): a value the loader would not recognise - a lower-case
 * `patient`, a path separator, a space - is rejected rather than sanitised,
 * because either would produce a file that `load` silently skips or reads back
 * as a different resource type.
 */
const RESOURCE_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]{0,63}$/;

/**
 * Build the output file name for a resource type.
 * @param resourceType - FHIR resource type.
 * @returns The file name, for example `Patient.ndjson`.
 * @example
 * exportFileName("Patient"); // "Patient.ndjson"
 */
export function exportFileName(resourceType: string): string {
  return `${resourceType}.ndjson`;
}

/**
 * Reject `resource_type` values that are unsafe or invalid as file names.
 * @param resourceTypes - Resource type values read from the table.
 * @throws {Error} naming every offending value if any value is not a valid
 *   FHIR resource type name.
 * @example
 * assertSafeResourceTypeNames(["Patient", "../escape"]); // throws
 */
export function assertSafeResourceTypeNames(resourceTypes: string[]): void {
  const offenders = resourceTypes.filter(
    (resourceType) => !RESOURCE_TYPE_PATTERN.test(resourceType),
  );
  if (offenders.length > 0) {
    throw new Error(
      `Cannot export rows whose resource_type is not a valid FHIR resource ` +
        `type name: ${offenders.map((offender) => `'${offender}'`).join(", ")}. ` +
        `Correct these values in the table before exporting.`,
    );
  }
}

/**
 * Create the output directory, including any missing parents.
 * @param directory - Output directory.
 * @throws {Error} if the directory cannot be created, including when the path
 *   already exists as a file.
 */
export function ensureOutputDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

/**
 * Reject the export when an output file already exists.
 *
 * Runs before any file is opened, so a collision leaves the output directory
 * exactly as it was rather than part-written.
 * @param directory - Output directory.
 * @param resourceTypes - Resource types about to be written.
 * @param overwrite - Whether existing files may be replaced.
 * @throws {Error} naming every colliding file when overwrite is not requested.
 */
export function assertNoExistingOutputFiles(
  directory: string,
  resourceTypes: string[],
  overwrite: boolean,
): void {
  if (overwrite) {
    return;
  }
  const existing = resourceTypes
    .map((resourceType) => path.join(directory, exportFileName(resourceType)))
    .filter((file) => existsSync(file));
  if (existing.length > 0) {
    throw new Error(
      `Output file(s) already exist: ${existing.join(", ")}. ` +
        `Pass --overwrite to replace them.`,
    );
  }
}
