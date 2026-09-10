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
 * Tests for the `sof-oracle transpile` subcommand (contracts/cli.md):
 * stdin/stdout, --input/--output, --resource-json-data-type, non-zero exit
 * naming the offending element on invalid input, and exactly one SELECT
 * written on success.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VALID_VIEW = JSON.stringify({
  resource: "Patient",
  status: "active",
  select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
});
const INVALID_VIEW = JSON.stringify({
  resource: "Patient",
  status: "active",
  select: [
    {
      forEach: "name",
      forEachOrNull: "address",
      column: [{ name: "x", path: "family" }],
    },
  ],
});

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sof-oracle-cli-"));
});
afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Run the transpile subcommand with the given arguments and stdin.
 * @param args - CLI arguments after the subcommand.
 * @param stdin - Optional stdin content.
 * @returns The spawn result.
 */
function runCli(args: string[], stdin?: string) {
  return spawnSync("bunx", ["tsx", "src/cli.ts", "transpile", ...args], {
    input: stdin,
    encoding: "utf-8",
    cwd: process.cwd(),
  });
}

describe("sof-oracle transpile", () => {
  it("writes a single SELECT to stdout from stdin", () => {
    const result = runCli([], VALID_VIEW);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SELECT");
    expect(result.stdout).toContain('AS "id"');
    expect(result.stdout).toContain("FROM fhir_resources r");
    expect(result.stdout?.trim().startsWith("SELECT")).toBe(true);
  });

  it("writes a single SELECT to stdout from a file via --input", () => {
    const viewFile = join(tempDir, "view.json");
    writeFileSync(viewFile, VALID_VIEW, "utf-8");
    const result = runCli(["--input", viewFile]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SELECT");
  });

  it("writes SQL to a file via --output", () => {
    const outputFile = join(tempDir, "query.sql");
    const result = runCli(["--output", outputFile], VALID_VIEW);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const sql = readFileSync(outputFile, "utf-8");
    expect(sql).toContain("SELECT");
  });

  it("targets the default BLOB storage with FORMAT JSON", () => {
    const result = runCli([], VALID_VIEW);
    expect(result.stdout).toContain("FORMAT JSON");
  });

  it("targets native JSON with --resource-json-data-type JSON", () => {
    const result = runCli(["--resource-json-data-type", "json"], VALID_VIEW);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("FORMAT JSON");
  });

  it("rejects an invalid --resource-json-data-type naming the value", () => {
    const result = runCli(["--resource-json-data-type", "CLOB"], VALID_VIEW);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CLOB");
  });

  it("honours --table-name", () => {
    const result = runCli(["--table-name", "my_resources"], VALID_VIEW);
    expect(result.stdout).toContain("FROM my_resources r");
  });

  it("honours --schema-name", () => {
    const result = runCli(["--schema-name", "fhir"], VALID_VIEW);
    expect(result.stdout).toContain("FROM fhir.fhir_resources r");
  });

  it("honours --resource-json-column", () => {
    const result = runCli(["--resource-json-column", "fhir_json"], VALID_VIEW);
    expect(result.stdout).toContain("r.fhir_json");
  });

  it("exits non-zero on an invalid ViewDefinition naming the element", () => {
    const result = runCli([], INVALID_VIEW);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("iteration directives");
  });

  it("writes nothing to the output file on an invalid ViewDefinition", () => {
    const outputFile = join(tempDir, "never.sql");
    const result = runCli(["--output", outputFile], INVALID_VIEW);
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(outputFile, "utf-8")).toThrow();
  });
});
