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
 * Integration tests for the `viewcaster export` subcommand run as a child
 * process: commander wiring, the ORACLE_* environment fallbacks, the summary
 * written to stdout, and the exit codes.
 *
 * Skips cleanly when no ORACLE_* environment is configured.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLoaderIntegrationHarness } from "./loaderHarness.js";
import { hasOracleEnvironment } from "./testDatabase.js";

const harness = createLoaderIntegrationHarness();
const oracleAvailable = hasOracleEnvironment();

const PATIENT_LINES = [
  '{"resourceType":"Patient","id":"p1","active":true}',
  '{"resourceType":"Patient","id":"p2","active":false}',
];
const OBSERVATION_LINES = [
  '{"resourceType":"Observation","id":"o1","status":"final"}',
];

beforeAll(() => harness.connect());
afterAll(() => harness.cleanup());

/**
 * Run the export subcommand, taking connection details from the environment.
 * @param args - CLI arguments after the subcommand.
 * @returns The spawn result.
 */
function runExportCli(args: string[]) {
  return spawnSync("bunx", ["tsx", "src/cli.ts", "export", ...args], {
    encoding: "utf-8",
    cwd: process.cwd(),
    env: process.env,
  });
}

describe.skipIf(!oracleAvailable)("viewcaster export", () => {
  it("writes one file per resource type and reports the summary", async () => {
    const tableName = harness.makeTableName();
    await harness.loadDir(
      harness.writeNdjsonDir({
        "Patient.ndjson": PATIENT_LINES,
        "Observation.ndjson": OBSERVATION_LINES,
      }),
      tableName,
      { quiet: true },
    );
    const outputDir = harness.makeTempDir();

    const result = runExportCli([outputDir, "--table-name", tableName]);

    expect(result.status).toBe(0);
    expect(readdirSync(outputDir).sort()).toEqual([
      "Observation.ndjson",
      "Patient.ndjson",
    ]);
    expect(readFileSync(join(outputDir, "Patient.ndjson"), "utf8")).toBe(
      PATIENT_LINES.join("\n") + "\n",
    );
    expect(result.stdout).toContain("Total rows written: 3");
  });

  it("exports only the requested resource type", async () => {
    const tableName = harness.makeTableName();
    await harness.loadDir(
      harness.writeNdjsonDir({
        "Patient.ndjson": PATIENT_LINES,
        "Observation.ndjson": OBSERVATION_LINES,
      }),
      tableName,
      { quiet: true },
    );
    const outputDir = harness.makeTempDir();

    const result = runExportCli([
      outputDir,
      "--table-name",
      tableName,
      "--resource-type",
      "Observation",
    ]);

    expect(result.status).toBe(0);
    expect(readdirSync(outputDir)).toEqual(["Observation.ndjson"]);
  });

  it("exits non-zero and reports the error when the table is missing", () => {
    const outputDir = harness.makeTempDir();

    const result = runExportCli([
      outputDir,
      "--table-name",
      "sof_no_such_table",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/sof_no_such_table/i);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("exits non-zero when an output file already exists", async () => {
    const tableName = harness.makeTableName();
    await harness.loadDir(
      harness.writeNdjsonDir({ "Patient.ndjson": PATIENT_LINES }),
      tableName,
      { quiet: true },
    );
    const outputDir = harness.makeTempDir();

    const first = runExportCli([outputDir, "--table-name", tableName]);
    expect(first.status).toBe(0);

    const second = runExportCli([outputDir, "--table-name", tableName]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/--overwrite/);

    const third = runExportCli([
      outputDir,
      "--table-name",
      tableName,
      "--overwrite",
    ]);
    expect(third.status).toBe(0);
  });
});
