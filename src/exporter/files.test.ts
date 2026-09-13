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
 * Unit tests for output file naming and the exporter's pre-flight checks:
 * resource type values are table data rather than trusted input, so they are
 * validated before they are ever joined onto a path, and an existing output
 * file stops the export before anything is written.
 */

import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoExistingOutputFiles,
  assertSafeResourceTypeNames,
  ensureOutputDirectory,
  exportFileName,
} from "./files.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "viewcaster-export-files-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("exportFileName", () => {
  it("follows the {ResourceType}.ndjson convention the loader reads", () => {
    expect(exportFileName("Patient")).toBe("Patient.ndjson");
    expect(exportFileName("MedicationRequest")).toBe(
      "MedicationRequest.ndjson",
    );
  });
});

describe("assertSafeResourceTypeNames", () => {
  it("accepts FHIR resource type names", () => {
    expect(() =>
      assertSafeResourceTypeNames(["Patient", "Observation", "List"]),
    ).not.toThrow();
  });

  it("rejects a value that would escape the output directory", () => {
    expect(() => assertSafeResourceTypeNames(["../escape"])).toThrow(
      /'\.\.\/escape'/,
    );
  });

  it("rejects values the loader would not read back as the same type", () => {
    // A lower-case name, a name with a space and an empty name all produce
    // files that `load` skips, so they fail here rather than being sanitised.
    expect(() => assertSafeResourceTypeNames(["patient"])).toThrow(/'patient'/);
    expect(() => assertSafeResourceTypeNames(["Pat ient"])).toThrow(
      /'Pat ient'/,
    );
    expect(() => assertSafeResourceTypeNames([""])).toThrow();
    expect(() => assertSafeResourceTypeNames(["Pat-ient"])).toThrow(
      /'Pat-ient'/,
    );
  });

  it("names every offending value, not just the first", () => {
    expect(() =>
      assertSafeResourceTypeNames(["Patient", "../escape", "patient"]),
    ).toThrow(/'\.\.\/escape'.*'patient'/s);
  });
});

describe("ensureOutputDirectory", () => {
  it("creates the directory, including missing parents", () => {
    const target = join(tempDir, "nested", "out");
    ensureOutputDirectory(target);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("is a no-op when the directory already exists", () => {
    ensureOutputDirectory(tempDir);
    expect(statSync(tempDir).isDirectory()).toBe(true);
  });

  it("fails when the path already exists as a file", () => {
    const target = join(tempDir, "not-a-directory");
    writeFileSync(target, "", "utf8");
    expect(() => ensureOutputDirectory(target)).toThrow();
  });
});

describe("assertNoExistingOutputFiles", () => {
  it("passes when no output file exists", () => {
    expect(() =>
      assertNoExistingOutputFiles(tempDir, ["Patient"], false),
    ).not.toThrow();
  });

  it("names the colliding file and points at --overwrite", () => {
    const existing = join(tempDir, "Patient.ndjson");
    writeFileSync(existing, "existing\n", "utf8");
    expect(() =>
      assertNoExistingOutputFiles(tempDir, ["Patient", "Observation"], false),
    ).toThrow(/Patient\.ndjson.*--overwrite/s);
    // The check must not have touched the file it complained about.
    expect(existsSync(existing)).toBe(true);
  });

  it("allows a collision when overwrite is requested", () => {
    writeFileSync(join(tempDir, "Patient.ndjson"), "existing\n", "utf8");
    expect(() =>
      assertNoExistingOutputFiles(tempDir, ["Patient"], true),
    ).not.toThrow();
  });
});
