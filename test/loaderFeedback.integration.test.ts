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
 * Integration tests for loader feedback and failure behaviour (FR-015, US2
 * scenarios 2-5): invalid type rejected before any connection, progress and
 * per-file summaries, verbosity controls, --dry-run, --truncate,
 * --continue-on-error, malformed-line handling and non-zero exit on failure.
 *
 * Skips cleanly when no ORACLE_* environment is configured.
 */

import { spawnSync } from "child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasOracleEnvironment } from "./testDatabase.js";
import {
  createLoaderIntegrationHarness,
  SAMPLE_PATIENTS,
} from "./loaderHarness.js";
import { loadNdjsonFiles } from "../src/loader/index.js";

const harness = createLoaderIntegrationHarness();

beforeAll(() => harness.connect());
afterAll(() => harness.cleanup());

/** Anything a silencing spy needs to offer for cleanup. */
interface Restorable {
  mockRestore(): void;
}

/**
 * Silence loader console output for tests that do not assert on it.
 *
 * @returns The spies, for restoration in a finally block.
 */
function silence(): Restorable[] {
  return [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
}

/**
 * Restore a set of spies.
 *
 * @param spies - The spies to restore.
 */
function restore(spies: Restorable[]): void {
  for (const spy of spies) spy.mockRestore();
}

describe("invalid resourceJsonDataType (no database required)", () => {
  it("throws before opening a connection", async () => {
    // The database host is unroutable. If validation did not run first, the
    // call would fail with a connection error; instead it must fail with the
    // validation error, proving no connection was attempted.
    await expect(
      harness.loadDir("/nonexistent-directory", "unused_table", {
        resourceJsonDataType: "TEXT",
      }),
    ).rejects.toThrow(/Invalid resource JSON data type.*TEXT/s);
  });
});

describe("verbosity controls (US2)", () => {
  it("reports progress and a per-file summary with verbose output", async () => {
    const tableName = harness.makeTableName();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await harness.loadDir(
        harness.writeNdjsonDir({
          "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
            JSON.stringify(patient),
          ),
        }),
        tableName,
        { verbose: true },
      );
      expect(result.failed).toBe(false);
      const output = logSpy.mock.calls.map((call) => call.join(" "));
      // The per-file summary names the resource type and its row count.
      const summary = output.filter((line) => line.includes("Patient"));
      expect(summary.length).toBeGreaterThan(0);
      // Connected / found-files reporting is present in verbose mode.
      expect(output.some((line) => line.includes("Connected"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("suppresses all console output in quiet mode", async () => {
    const tableName = harness.makeTableName();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const progressSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const result = await harness.loadDir(
        harness.writeNdjsonDir({
          "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
            JSON.stringify(patient),
          ),
        }),
        tableName,
        { quiet: true },
      );
      expect(result.failed).toBe(false);
      expect(logSpy.mock.calls).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
      progressSpy.mockRestore();
    }
  });

  it("writes progress lines when progress mode is requested", async () => {
    const tableName = harness.makeTableName();
    const progressSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await harness.loadDir(
        harness.writeNdjsonDir({
          "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
            JSON.stringify(patient),
          ),
        }),
        tableName,
        { progress: true },
      );
      expect(result.failed).toBe(false);
      const written = progressSpy.mock.calls
        .map((call) => String(call[0]))
        .join("");
      expect(written).toContain("files");
    } finally {
      logSpy.mockRestore();
      progressSpy.mockRestore();
    }
  });
});

describe("dry run (US2 scenario 3)", () => {
  it("reports counts and creates nothing in the database", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      const result = await harness.loadDir(
        harness.writeNdjsonDir({
          "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
            JSON.stringify(patient),
          ),
          "Observation.ndjson": [
            JSON.stringify({ resourceType: "Observation", id: "o1" }),
          ],
        }),
        tableName,
        { dryRun: true },
      );
      // Row counts are reported per file.
      expect(result.totalRows).toBe(SAMPLE_PATIENTS.length + 1);
      expect(result.failed).toBe(false);
      const patientFile = result.files.find(
        (file) => file.resourceType === "Patient",
      );
      expect(patientFile?.rowsLoaded).toBe(SAMPLE_PATIENTS.length);
      // Nothing was written: the table does not exist.
      expect(await harness.tableExists(tableName)).toBe(false);
    } finally {
      restore(spies);
    }
  });

  it("does not require valid database credentials", async () => {
    // A dry run never opens a connection, so unusable credentials are fine.
    const result = await loadNdjsonFiles({
      directory: harness.writeNdjsonDir({
        "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
          JSON.stringify(patient),
        ),
      }),
      database: {
        host: "203.0.113.1",
        user: "unused",
        password: "unused",
      },
      dryRun: true,
      quiet: true,
    });
    expect(result.totalRows).toBe(SAMPLE_PATIENTS.length);
    expect(result.failed).toBe(false);
  });
});

describe("truncate (US2 scenario 2)", () => {
  it("empties the table before reloading", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      await harness.loadSample(tableName);
      expect(await harness.getRowCount(tableName)).toBe(
        SAMPLE_PATIENTS.length,
      );
      const result = await harness.loadSample(tableName, { truncate: true });
      expect(result.failed).toBe(false);
      expect(await harness.getRowCount(tableName)).toBe(
        SAMPLE_PATIENTS.length,
      );
    } finally {
      restore(spies);
    }
  });
});

describe("malformed-line handling (data-model.md)", () => {
  it("ignores blank lines", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      const directory = harness.writeNdjsonDir({
        "Patient.ndjson": [
          "",
          JSON.stringify(SAMPLE_PATIENTS[0]),
          "   ",
          JSON.stringify(SAMPLE_PATIENTS[1]),
          "",
        ],
      });
      const result = await harness.loadDir(directory, tableName);
      expect(result.failed).toBe(false);
      expect(result.totalRows).toBe(2);
      expect(await harness.getRowCount(tableName)).toBe(2);
    } finally {
      restore(spies);
    }
  });

  it("fails the file on a malformed line without continue-on-error", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      const directory = harness.writeNdjsonDir({
        "Patient.ndjson": [
          JSON.stringify(SAMPLE_PATIENTS[0]),
          "not json at all {",
        ],
      });
      await expect(harness.loadDir(directory, tableName)).rejects.toThrow(
        /Failed to load/,
      );
      // The rows in the failing batch must not all have been loaded.
      expect(await harness.getRowCount(tableName)).toBeLessThan(
        SAMPLE_PATIENTS.length,
      );
    } finally {
      restore(spies);
    }
  });

  it("reports and skips malformed lines with continue-on-error", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      const directory = harness.writeNdjsonDir({
        "Patient.ndjson": [
          JSON.stringify(SAMPLE_PATIENTS[0]),
          "not json at all {",
          JSON.stringify(SAMPLE_PATIENTS[1]),
        ],
      });
      const result = await harness.loadDir(directory, tableName, {
        continueOnError: true,
      });
      // The failure is reported and the file is marked failed...
      expect(result.failed).toBe(true);
      const patientFile = result.files.find(
        (file) => file.resourceType === "Patient",
      );
      expect(patientFile?.errors.length).toBeGreaterThan(0);
      // ...while the well-formed rows still load.
      expect(patientFile?.rowsLoaded).toBe(2);
      expect(await harness.getRowCount(tableName)).toBe(2);
    } finally {
      restore(spies);
    }
  });

  it("keeps going when a whole file fails with continue-on-error", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      const directory = harness.writeNdjsonDir({
        "Observation.ndjson": [
          JSON.stringify({ resourceType: "Observation", id: "o1" }),
        ],
        "Broken.ndjson": ["{definitely not json"],
      });
      const result = await harness.loadDir(directory, tableName, {
        continueOnError: true,
      });
      expect(result.failed).toBe(true);
      const observationFile = result.files.find(
        (file) => file.resourceType === "Observation",
      );
      expect(observationFile?.rowsLoaded).toBe(1);
      expect(observationFile?.errors).toHaveLength(0);
      const brokenFile = result.files.find(
        (file) => file.resourceType === "Broken",
      );
      expect(brokenFile?.rowsLoaded).toBe(0);
      expect(brokenFile?.errors.length).toBeGreaterThan(0);
    } finally {
      restore(spies);
    }
  });
});

describe("exit status through the CLI (US2 scenario 5)", () => {
  it("exits non-zero on failure even with --continue-on-error", async (ctx) => {
    if (!hasOracleEnvironment()) {
      ctx.skip();
    }
    const tableName = harness.makeTableName();
    const directory = harness.writeNdjsonDir({
      "Patient.ndjson": [JSON.stringify(SAMPLE_PATIENTS[0]), "broken {"],
    });
    const result = spawnSync(
      "bunx",
      [
        "tsx",
        "src/cli.ts",
        "load",
        directory,
        "--table-name",
        tableName,
        "--continue-on-error",
        "--quiet",
      ],
      { encoding: "utf-8", cwd: process.cwd() },
    );
    expect(result.status).not.toBe(0);
  });

  it("exits zero on a successful load", async (ctx) => {
    if (!hasOracleEnvironment()) {
      ctx.skip();
    }
    const tableName = harness.makeTableName();
    const directory = harness.writeNdjsonDir({
      "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
        JSON.stringify(patient),
      ),
    });
    const result = spawnSync(
      "bunx",
      [
        "tsx",
        "src/cli.ts",
        "load",
        directory,
        "--table-name",
        tableName,
        "--quiet",
      ],
      { encoding: "utf-8", cwd: process.cwd() },
    );
    expect(result.status).toBe(0);
    expect(await harness.getRowCount(tableName)).toBe(
      SAMPLE_PATIENTS.length,
    );
  });
});

describe("empty input (US2)", () => {
  it("loads zero rows and creates nothing when no files match", async () => {
    const tableName = harness.makeTableName();
    const spies = silence();
    try {
      const directory = harness.writeNdjsonDir({
        "README.md": "no data here",
      });
      const result = await harness.loadDir(directory, tableName);
      expect(result.totalRows).toBe(0);
      expect(result.failed).toBe(false);
      expect(await harness.tableExists(tableName)).toBe(false);
    } finally {
      restore(spies);
    }
  });
});
