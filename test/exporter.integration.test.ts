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
 * Integration tests for the NDJSON exporter against a live Oracle instance:
 * the byte-for-byte round trip under BLOB storage, the equivalent round trip
 * under native JSON storage, one file per resource type, the resource type
 * filter, the pre-flight guards (missing table, existing output files, an
 * unusable `resource_type`), the multi-line abort, and streaming a resource
 * type larger than one fetch batch.
 *
 * Skips cleanly when no ORACLE_* environment is configured.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLoaderIntegrationHarness } from "./loaderHarness.js";
import { hasOracleEnvironment } from "./testDatabase.js";
import { exportNdjsonFiles } from "../src/exporter/index.js";

import type { ExportOptions, ExportResult } from "../src/exporter/types.js";

const harness = createLoaderIntegrationHarness();
const oracleAvailable = hasOracleEnvironment();

/**
 * Patient resources with content that is easy to corrupt: non-ASCII text, a
 * decimal with a trailing zero, and insignificant whitespace between members.
 */
const PATIENT_LINES = [
  '{"resourceType":"Patient","id":"p1","name":"Café Ünïcode 🩺","score":1.0}',
  '{"resourceType":"Patient",  "id":"p2","active":false}',
  '{"resourceType":"Patient","id":"p3","birthDate":"2000-01-01"}',
];

const OBSERVATION_LINES = [
  '{"resourceType":"Observation","id":"o1","status":"final"}',
  '{"resourceType":"Observation","id":"o2","status":"amended"}',
];

beforeAll(() => harness.connect());
afterAll(() => harness.cleanup());

/**
 * Run an export with the harness connection, quiet by default.
 * @param directory - Output directory.
 * @param tableName - Table to export from.
 * @param options - Additional exporter options.
 * @returns The export result.
 */
function runExport(
  directory: string,
  tableName: string,
  options?: Omit<Partial<ExportOptions>, "database" | "directory">,
): Promise<ExportResult> {
  return exportNdjsonFiles({
    directory,
    database: harness.databaseConfig(),
    tableName,
    quiet: true,
    ...options,
  });
}

/**
 * Load a set of NDJSON files into a fresh table.
 * @param files - File name to JSON lines.
 * @param options - Loader options.
 * @param options.resourceJsonDataType - Storage type for the json column.
 * @returns The table name and the source directory.
 */
async function loadFixture(
  files: Record<string, string[]>,
  options?: { resourceJsonDataType?: string },
): Promise<{ tableName: string; directory: string }> {
  const tableName = harness.makeTableName();
  const directory = harness.writeNdjsonDir(files);
  await harness.loadDir(directory, tableName, { ...options, quiet: true });
  return { tableName, directory };
}

describe.skipIf(!oracleAvailable)("BLOB storage round trip", () => {
  it("reproduces the loaded file byte for byte", async () => {
    const { tableName, directory } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
    });
    const outputDir = harness.makeTempDir();

    const result = await runExport(outputDir, tableName);

    expect(result.totalRows).toBe(PATIENT_LINES.length);
    expect(result.files).toEqual([
      {
        resourceType: "Patient",
        path: join(outputDir, "Patient.ndjson"),
        rowsWritten: PATIENT_LINES.length,
      },
    ]);
    // BLOB storage holds the bytes as written, so the export is an exact copy
    // of the input, including the insignificant whitespace and the 1.0.
    expect(readFileSync(join(outputDir, "Patient.ndjson"))).toEqual(
      readFileSync(join(directory, "Patient.ndjson")),
    );
  });

  it("produces a directory the loader can read back", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
    });
    const outputDir = harness.makeTempDir();
    await runExport(outputDir, tableName);

    const reloadTable = harness.makeTableName();
    const reload = await harness.loadDir(outputDir, reloadTable, {
      quiet: true,
    });

    expect(reload.failed).toBe(false);
    expect(reload.totalRows).toBe(PATIENT_LINES.length);
    expect(await harness.getRowCount(reloadTable)).toBe(PATIENT_LINES.length);
  });

  it("writes one file per resource type", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
      "Observation.ndjson": OBSERVATION_LINES,
    });
    const outputDir = harness.makeTempDir();

    const result = await runExport(outputDir, tableName);

    expect(result.files.map((file) => file.resourceType)).toEqual([
      "Observation",
      "Patient",
    ]);
    expect(readdirSync(outputDir).sort()).toEqual([
      "Observation.ndjson",
      "Patient.ndjson",
    ]);
    expect(result.totalRows).toBe(
      PATIENT_LINES.length + OBSERVATION_LINES.length,
    );
  });

  it("exports only the requested resource type", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
      "Observation.ndjson": OBSERVATION_LINES,
    });
    const outputDir = harness.makeTempDir();

    const result = await runExport(outputDir, tableName, {
      resourceType: "Patient",
    });

    expect(readdirSync(outputDir)).toEqual(["Patient.ndjson"]);
    expect(result.totalRows).toBe(PATIENT_LINES.length);
  });

  it("creates the output directory, including missing parents", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
    });
    const outputDir = join(harness.makeTempDir(), "nested", "out");

    await runExport(outputDir, tableName);

    expect(existsSync(join(outputDir, "Patient.ndjson"))).toBe(true);
  });

  it("preserves row order across more rows than one fetch batch", async () => {
    // Enough rows to span many driver fetch batches and to exercise the write
    // stream's back-pressure path.
    const lines = Array.from(
      { length: 5000 },
      (_, index) => `{"resourceType":"Patient","id":"p${index}"}`,
    );
    const { tableName, directory } = await loadFixture({
      "Patient.ndjson": lines,
    });
    const outputDir = harness.makeTempDir();

    const result = await runExport(outputDir, tableName);

    expect(result.totalRows).toBe(lines.length);
    expect(readFileSync(join(outputDir, "Patient.ndjson"))).toEqual(
      readFileSync(join(directory, "Patient.ndjson")),
    );
  });
});

describe.skipIf(!oracleAvailable)("native JSON storage round trip", () => {
  it("exports resources that are equivalent and loadable again", async (ctx) => {
    if (harness.getMajorVersion() < 21) {
      // eslint-disable-next-line vitest/no-disabled-tests -- runtime gate, not a disabled test
      ctx.skip();
    }
    const { tableName } = await loadFixture(
      { "Patient.ndjson": PATIENT_LINES },
      { resourceJsonDataType: "JSON" },
    );
    const columnType = await harness.getJsonColumnType(tableName);
    expect(columnType?.dataType).toBe("JSON");
    const outputDir = harness.makeTempDir();

    const result = await runExport(outputDir, tableName);

    expect(result.totalRows).toBe(PATIENT_LINES.length);
    const exported = readFileSync(join(outputDir, "Patient.ndjson"), "utf8")
      .trimEnd()
      .split("\n");
    // Oracle normalises a document as it encodes it, so the export is
    // equivalent rather than byte identical: same resources, one per line.
    expect(exported).toHaveLength(PATIENT_LINES.length);
    expect(exported.map((line) => JSON.parse(line) as { id: string })).toEqual(
      PATIENT_LINES.map((line) => JSON.parse(line) as { id: string }),
    );

    const reloadTable = harness.makeTableName();
    const reload = await harness.loadDir(outputDir, reloadTable, {
      quiet: true,
    });
    expect(reload.failed).toBe(false);
    expect(await harness.getRowCount(reloadTable)).toBe(PATIENT_LINES.length);
  });
});

describe.skipIf(!oracleAvailable)("pre-flight guards", () => {
  it("fails when the table does not exist, naming it", async () => {
    const outputDir = harness.makeTempDir();
    const missingTable = "sof_missing_table";

    await expect(runExport(outputDir, missingTable)).rejects.toThrow(
      new RegExp(missingTable, "i"),
    );
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("rejects an invalid table name before opening a connection", async () => {
    const outputDir = harness.makeTempDir();

    await expect(
      exportNdjsonFiles({
        directory: outputDir,
        // An unroutable host: reaching the database would fail differently,
        // so a validation error proves no connection was attempted.
        database: { user: "u", password: "p", connectString: "0.0.0.0:1/X" },
        tableName: "bad table",
        quiet: true,
      }),
    ).rejects.toThrow(/Table name/);
  });

  it("refuses to overwrite an existing output file unless asked", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
    });
    const outputDir = harness.makeTempDir();
    const existing = join(outputDir, "Patient.ndjson");
    writeFileSync(existing, "untouched\n", "utf8");

    await expect(runExport(outputDir, tableName)).rejects.toThrow(
      /Patient\.ndjson.*--overwrite/s,
    );
    // The guard runs before anything is opened, so the file is intact.
    expect(readFileSync(existing, "utf8")).toBe("untouched\n");

    const result = await runExport(outputDir, tableName, { overwrite: true });
    expect(result.totalRows).toBe(PATIENT_LINES.length);
    expect(readFileSync(existing, "utf8").split("\n")).toHaveLength(
      PATIENT_LINES.length + 1,
    );
  });

  it("refuses to write a resource_type that is not a valid type name", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
    });
    await harness.insertRawResource(
      tableName,
      "../escape",
      Buffer.from('{"resourceType":"Patient","id":"bad"}', "utf8"),
    );
    const outputDir = harness.makeTempDir();

    await expect(runExport(outputDir, tableName)).rejects.toThrow(
      /'\.\.\/escape'/,
    );
    // The check precedes every file, so even the valid Patient file is absent.
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("reports that there is nothing to export for an absent resource type", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
    });
    const outputDir = harness.makeTempDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await runExport(outputDir, tableName, {
        resourceType: "Encounter",
        quiet: false,
      });

      expect(result.files).toEqual([]);
      expect(result.totalRows).toBe(0);
      expect(readdirSync(outputDir)).toEqual([]);
      expect(
        logSpy.mock.calls.map((call) => String(call[0])).join("\n"),
      ).toMatch(/nothing to export/i);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe.skipIf(!oracleAvailable)("resources that cannot be written", () => {
  it("aborts on a multi-line resource and removes the partial file", async () => {
    const { tableName } = await loadFixture({
      "Patient.ndjson": PATIENT_LINES,
      "Observation.ndjson": OBSERVATION_LINES,
    });
    // A pretty-printed document is valid JSON, so it satisfies the IS JSON
    // constraint, but it cannot be written as one NDJSON line.
    await harness.insertRawResource(
      tableName,
      "Patient",
      Buffer.from(
        '{\n  "resourceType": "Patient",\n  "id": "multi"\n}',
        "utf8",
      ),
    );
    const outputDir = harness.makeTempDir();

    await expect(runExport(outputDir, tableName)).rejects.toThrow(
      /multiple lines/i,
    );
    // Observation sorts before Patient and completed, so it stays; the
    // half-written Patient file is removed rather than left looking complete.
    expect(readdirSync(outputDir)).toEqual(["Observation.ndjson"]);
  });
});
