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
 * Unit tests for NDJSON file discovery (data-model.md NDJSON file set):
 * `{ResourceType}.ndjson` matching, non-matching files skipped with a report,
 * and the resource-type filter.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverFiles,
  groupFilesByResourceType,
  parseFilename,
} from "./discovery.js";

import type { LoadOptions } from "./types.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/**
 * Write a fixture directory with the given files and return loader options
 * pointing at it.
 * @param files - Map of file name to content.
 * @param extra - Extra loader options.
 * @returns Loader options for the fixture directory.
 */
function optionsWith(
  files: Record<string, string>,
  extra: Partial<LoadOptions> = {},
): LoadOptions {
  tempDir = mkdtempSync(path.join(tmpdir(), "sof-discovery-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(tempDir, name), content, "utf8");
  }
  return {
    directory: tempDir,
    database: { user: "unused", password: "unused" },
    ...extra,
  };
}

describe("discoverFiles", () => {
  it("discovers {ResourceType}.ndjson files with metadata", () => {
    const options = optionsWith({
      "Patient.ndjson": "{}\n{}\n",
      "Observation.ndjson": "{}\n",
      "CoverageEligibilityRequest.ndjson": "{}\n",
    });
    const { files } = discoverFiles(options);
    const types = files.map((file) => file.resourceType).sort((a, b) => a.localeCompare(b)) // eslint-disable-line unicorn/no-array-sort -- lib lacks ES2023 toSorted;
    expect(types).toEqual([
      "CoverageEligibilityRequest",
      "Observation",
      "Patient",
    ]);
    const patient = files.find((file) => file.resourceType === "Patient");
    expect(patient?.path).toBe(path.join(options.directory, "Patient.ndjson"));
    expect(patient?.size).toBe(6);
  });

  it("skips non-matching files with a report", () => {
    const options = optionsWith({
      "Patient.ndjson": "{}\n",
      "README.md": "not data",
      "lowercase-observation.ndjson": "{}\n",
      "Patient.ndjson.bak": "{}\n",
    });
    const { files, skipped } = discoverFiles(options);
    expect(files.map((file) => file.resourceType)).toEqual(["Patient"]);
    const skippedNames = skipped
      .map((entry) => entry.file)
      .sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
    expect(skippedNames).toEqual([
      "Patient.ndjson.bak",
      "README.md",
      "lowercase-observation.ndjson",
    ]);
    for (const entry of skipped) {
      expect(entry.reason).toContain("ndjson");
    }
  });

  it("ignores subdirectories", () => {
    const options = optionsWith({});
    mkdirSync(path.join(options.directory, "nested"));
    const { files, skipped } = discoverFiles(options);
    expect(files).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("filters to the requested resource type and reports the excluded files", () => {
    const options = optionsWith(
      {
        "Patient.ndjson": "{}\n",
        "Observation.ndjson": "{}\n",
      },
      { resourceType: "Patient" },
    );
    const { files, skipped } = discoverFiles(options);
    expect(files.map((file) => file.resourceType)).toEqual(["Patient"]);
    expect(skipped.map((entry) => entry.file)).toEqual(["Observation.ndjson"]);
  });

  it("returns no files for an empty directory", () => {
    const options = optionsWith({});
    const { files, skipped } = discoverFiles(options);
    expect(files).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe("parseFilename", () => {
  it("extracts the resource type from a matching filename", () => {
    expect(parseFilename("Patient.ndjson", "{ResourceType}.ndjson")).toEqual({
      resourceType: "Patient",
    });
    expect(
      parseFilename(
        "CoverageEligibilityRequest.ndjson",
        "{ResourceType}.ndjson",
      ),
    ).toEqual({ resourceType: "CoverageEligibilityRequest" });
  });

  it("accepts digits and mixed case after the leading capital", () => {
    expect(parseFilename("MedicationRequest1.ndjson", "{ResourceType}.ndjson"))
      .toEqual({ resourceType: "MedicationRequest1" });
  });

  it("rejects filenames that do not match the pattern", () => {
    expect(parseFilename("patient.ndjson", "{ResourceType}.ndjson"))
      .toBeUndefined();
    expect(parseFilename("Patient.txt", "{ResourceType}.ndjson"))
      .toBeUndefined();
    expect(parseFilename("Patient.ndjson.extra", "{ResourceType}.ndjson"))
      .toBeUndefined();
    expect(parseFilename(".ndjson", "{ResourceType}.ndjson"))
      .toBeUndefined();
  });

  it("rejects an empty resource type", () => {
    expect(parseFilename(".ndjson", "{ResourceType}.ndjson")).toBeUndefined();
  });
});

describe("groupFilesByResourceType", () => {
  it("groups files by their resource type", () => {
    const grouped = groupFilesByResourceType([
      { path: "/a/Patient.ndjson", resourceType: "Patient", size: 1 },
      { path: "/a/Observation.ndjson", resourceType: "Observation", size: 1 },
      { path: "/b/Patient.ndjson", resourceType: "Patient", size: 1 },
    ]);
    expect(grouped.get("Patient")).toHaveLength(2);
    expect(grouped.get("Observation")).toHaveLength(1);
    expect(grouped.size).toBe(2);
  });
});
