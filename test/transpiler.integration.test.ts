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
 * Official SQL on FHIR compliance harness against a live Oracle database.
 *
 * For every official test case: load the suite's resources into a dedicated
 * test table, transpile the ViewDefinition with `SqlOnFhir`, execute the
 * generated SQL on Oracle, and compare the rows with the expected output
 * using the ported comparison semantics plus the documented '' ≡ NULL
 * equivalence (research R8). Results are stored in `globalThis.testResults`
 * and written by the Vitest reporter to out/test-report.json.
 *
 * The test path comes from SQLONFHIR_TEST_PATH (default ./sqlonfhir/tests).
 * The storage variant comes from ORACLE_RESOURCE_JSON_DATA_TYPE
 * (default BLOB; `JSON` exercises the native JSON type on 21c+). The suite
 * skips cleanly when no ORACLE_* environment is configured.
 */

import { parse as losslessParse } from "lossless-json";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestTable,
  dropTestTable,
  hasOracleEnvironment,
  insertTestResourceReturningId,
  openTestConnection,
  TEST_TABLE_NAME,
  type StorageType,
} from "./testDatabase";
import { SqlOnFhir } from "../src/index";
import { ViewDefinitionParser } from "../src/parser";

import type { TestReportEntry } from "./support/testReportTypes";
import type { TestSuite, ViewDefinition } from "../src/types";
import type oracledb from "oracledb";

declare global {
  // Set by the harness for the custom Vitest reporter (out/test-report.json).
  var testResults: Record<string, { tests: TestReportEntry[] }> | undefined;
}

/**
 * Normalises ORACLE_RESOURCE_JSON_DATA_TYPE to a storage variant.
 * @param value - The env value (case-insensitive).
 * @returns The storage variant.
 */
function parseStorageEnv(value: string): StorageType {
  const canonical = value.trim().toUpperCase();
  if (canonical === "BLOB" || canonical === "JSON") return canonical;
  throw new Error(
    `Invalid ORACLE_RESOURCE_JSON_DATA_TYPE: '${value}'. Must be BLOB or JSON.`,
  );
}

const storage: StorageType = process.env.ORACLE_RESOURCE_JSON_DATA_TYPE
  ? parseStorageEnv(process.env.ORACLE_RESOURCE_JSON_DATA_TYPE)
  : "BLOB";

let connection: oracledb.Connection | null = null;
let setupDone = false;

/**
 * Sets up the shared test table once for the whole run.
 */
async function setupTestDatabase(): Promise<void> {
  if (setupDone) return;
  connection = await openTestConnection();
  await dropTestTable(connection, TEST_TABLE_NAME);
  await createTestTable(connection, storage, TEST_TABLE_NAME);
  setupDone = true;
}

/**
 * Closes the shared connection after the run.
 */
async function cleanupTestDatabase(): Promise<void> {
  if (connection) {
    try {
      await connection.close();
    } catch {
      // Ignore cleanup errors.
    } finally {
      connection = null;
      setupDone = false;
    }
  }
}

/**
 * Inserts the suite's resources, returning the generated ids for cleanup.
 * @param resources - Resources parsed losslessly upstream.
 * @param testId - Test-isolation identifier stored with the rows.
 * @returns The inserted surrogate ids.
 */
async function insertSuiteResources(
  resources: Record<string, unknown>[],
  testId: string,
): Promise<number[]> {
  if (!connection) throw new Error("Database not connected");
  const ids: number[] = [];
  for (const resource of resources) {
    ids.push(
      await insertTestResourceReturningId(
        connection,
        resource as { resourceType: string },
        testId,
        storage,
        TEST_TABLE_NAME,
      ),
    );
  }
  return ids;
}

/**
 * Deletes the rows inserted for a single test case.
 * @param ids - Surrogate ids returned by insertSuiteResources.
 */
async function deleteTestRows(ids: number[]): Promise<void> {
  if (!connection || ids.length === 0) return;
  const binds = ids.map((_, i) => `:${i + 1}`).join(", ");
  await connection.execute(
    `DELETE FROM ${TEST_TABLE_NAME} WHERE id IN (${binds})`,
    ids,
    { autoCommit: true },
  );
}

interface ExecutionResult {
  results: Record<string, unknown>[];
  columns: string[];
}

/**
 * Transpiles a ViewDefinition and executes it on Oracle.
 * @param viewDef - The parsed ViewDefinition.
 * @param testId - The test-isolation identifier used to insert the rows.
 * @returns The rows and the output column names in SQL order.
 */
async function executeViewDefinition(
  viewDef: ViewDefinition,
  testId: string,
): Promise<ExecutionResult> {
  if (!connection) throw new Error("Database not connected");
  const sqlOnFhir = new SqlOnFhir({
    tableName: TEST_TABLE_NAME,
    resourceJsonDataType: storage,
  });
  const result = sqlOnFhir.transpile(viewDef, testId);
  const queryResult = await connection.execute<Record<string, unknown>>(result.sql);
  const columns = (queryResult.metaData ?? []).map((m) => m.name);
  return {
    results: parseJsonStringsInResults(
      queryResult.rows ?? [],
      extractBooleanColumns(viewDef),
    ),
    columns,
  };
}
/**
 * Extracts boolean-typed column names from a ViewDefinition.
 * @param viewDefinition - The parsed ViewDefinition.
 * @returns The boolean column names.
 */
function extractBooleanColumns(viewDefinition: ViewDefinition): Set<string> {
  const booleanColumns = new Set<string>();

  function extractFromSelect(selectDef: Record<string, unknown>): void {
    const column = selectDef.column as
      | Array<Record<string, unknown>>
      | undefined;
    if (column) {
      for (const col of column) {
        if (col.type === "boolean") booleanColumns.add(col.name as string);
      }
    }
    const select = selectDef.select as
      | Array<Record<string, unknown>>
      | undefined;
    if (select) for (const nested of select) extractFromSelect(nested);
    const unionAll = selectDef.unionAll as
      | Array<Record<string, unknown>>
      | undefined;
    if (unionAll) for (const branch of unionAll) extractFromSelect(branch);
  }

  if (viewDefinition.select) {
    for (const selectDef of viewDefinition.select) extractFromSelect(selectDef);
  }
  return booleanColumns;
}

/**
 * Parses JSON-looking strings in query results into arrays/objects and
 * converts numeric boolean columns (1/0) to booleans.
 * @param results - Raw rows.
 * @param booleanColumns - Names of boolean-typed columns.
 * @returns Parsed rows.
 */
function parseJsonStringsInResults(
  results: Record<string, unknown>[],
  booleanColumns: Set<string>,
): Record<string, unknown>[] {
  return results.map((row) => {
    const parsedRow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (booleanColumns.has(key) && typeof value === "number") {
        parsedRow[key] = Boolean(value);
      } else if (typeof value === "string" && looksLikeJson(value)) {
        try {
          parsedRow[key] = JSON.parse(value);
        } catch {
          parsedRow[key] = value;
        }
      } else {
        parsedRow[key] = value;
      }
    }
    return parsedRow;
  });
}

/**
 * Checks whether a string looks like JSON.
 * @param value - The string to inspect.
 * @returns True when the trimmed string starts with `[` or `{`.
 */
function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("{");
}

/**
 * Deep equality with FHIR type handling and the documented '' ≡ NULL
 * equivalence (research R8): Oracle cannot distinguish the empty string from
 * SQL NULL, so the comparison treats them as equivalent.
 * @param a - Actual value.
 * @param b - Expected value.
 * @returns True when equivalent.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (bothNullOrUndefined(a, b)) return true;
  if (eitherNullOrUndefined(a, b)) return false;
  if (isNumeric(a) && isNumeric(b)) return Math.abs(Number(a) - Number(b)) < 1e-10;
  if (typeof a !== typeof b) return handleBooleanNumberConversion(a, b);
  if (typeof a === "object" && typeof b === "object") return compareObjects(a, b);
  return false;
}

/**
 * Checks whether both values are null/undefined/empty-string equivalent
 * (research R8).
 * @param a - First value.
 * @param b - Second value.
 * @returns True when indistinguishable on Oracle.
 */
function bothNullOrUndefined(a: unknown, b: unknown): boolean {
  const absent = (v: unknown) => v === null || v === undefined || v === "";
  return absent(a) && absent(b);
}

/**
 * Checks whether either value is null/undefined (but not both).
 * @param a - First value.
 * @param b - Second value.
 * @returns True when exactly one is absent.
 */
function eitherNullOrUndefined(a: unknown, b: unknown): boolean {
  const absent = (v: unknown) => v === null || v === undefined;
  return absent(a) !== absent(b);
}

/**
 * Checks whether a value is a number or a numeric string.
 * @param value - The value to inspect.
 * @returns True when numeric.
 */
function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  );
}

/**
 * Handles boolean/number conversions between expected and actual values.
 * @param a - First value.
 * @param b - Second value.
 * @returns True when one is a boolean and the other its 1/0 form.
 */
function handleBooleanNumberConversion(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" && (b === 1 || b === 0)) return a === (b === 1);
  if (typeof b === "boolean" && (a === 1 || a === 0)) return b === (a === 1);
  return false;
}

/**
 * Compares two object values (arrays or plain objects).
 * @param a - First value.
 * @param b - Second value.
 * @returns True when equal.
 */
function compareObjects(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((val, i) => deepEqual(val, b[i]))
    );
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  if (keysA.length !== Object.keys(objB).length) return false;
  return keysA.every((key) => deepEqual(objA[key], objB[key]));
}

/**
 * Compares actual rows with expected rows, ignoring row order but honouring
 * column order when the test declares expectedColumns.
 * @param actualResults - The executed rows.
 * @param expectedResults - The suite's expected rows.
 * @param expectedColumns - Optional expected column ordering.
 * @param actualColumns - The SQL output column ordering.
 * @returns True when rows match.
 */
function compareResults(
  actualResults: Record<string, unknown>[],
  expectedResults: Record<string, unknown>[],
  expectedColumns?: string[],
  actualColumns?: string[],
): boolean {
  if (expectedColumns && expectedColumns.length > 0) {
    const columnsToCheck =
      actualColumns ??
      (actualResults.length > 0 ? Object.keys(actualResults[0]) : []);
    if (!arraysEqual(columnsToCheck, expectedColumns)) return false;
  }
  // Sort by a canonical form (keys sorted) so differing column order between
  // actual and expected rows cannot misalign the positional pairing.
  const canonical = (row: Record<string, unknown>) =>
    JSON.stringify(
      Object.keys(row)
        .sort()
        .map((key) => [key, row[key]]),
    );
  const sortedActual = [...actualResults].sort((x, y) =>
    canonical(x).localeCompare(canonical(y)),
  );
  const sortedExpected = [...expectedResults].sort((x, y) =>
    canonical(x).localeCompare(canonical(y)),
  );
  if (sortedActual.length !== sortedExpected.length) return false;
  return sortedActual.every((row, i) => deepEqual(row, sortedExpected[i]));
}

/**
 * Checks whether two arrays are element-wise equal.
 * @param a - First array.
 * @param b - Second array.
 * @returns True when equal.
 */
function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((val, i) => val === b[i]);
}

/**
 * Loads one suite file, re-parsing its resources losslessly so decimal
 * lexemes (e.g. 1.0) survive insertion.
 * @param filePath - The suite JSON file path.
 * @returns The parsed suite with lossless resources.
 */
function loadSuiteFile(filePath: string): TestSuite {
  const testSuiteJson = readFileSync(filePath, "utf8");
  const suite = ViewDefinitionParser.parseTestSuite(testSuiteJson);
  const parsed = losslessParse(testSuiteJson) as { resources?: unknown };
  if (Array.isArray(parsed.resources)) {
    suite.resources = parsed.resources as TestSuite["resources"];
  }
  return suite;
}

/**
 * Resolves every JSON suite file under the test path (file or directory).
 * @param testPath - The SQLONFHIR_TEST_PATH value.
 * @returns Suite file paths sorted by name.
 */
function resolveSuiteFiles(testPath: string): string[] {
  if (statSync(testPath).isFile()) return [testPath];
  return readdirSync(testPath)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => join(testPath, file));
}

const testPath = process.env.SQLONFHIR_TEST_PATH ?? "./sqlonfhir/tests";

describe.skipIf(!hasOracleEnvironment())(
  `SQL on FHIR compliance tests (storage=${storage})`,
  () => {
    beforeAll(async () => {
      await setupTestDatabase();
    });

    afterAll(async () => {
      await cleanupTestDatabase();
    });

    for (const filePath of resolveSuiteFiles(testPath)) {
      const fileName = filePath.split("/").pop() ?? filePath;
      const suite = loadSuiteFile(filePath);
      const suiteResults: TestReportEntry[] = [];

      describe(suite.title ?? fileName, () => {
        afterAll(async () => {
          if (typeof globalThis !== "undefined") {
            globalThis.testResults = globalThis.testResults ?? {};
            globalThis.testResults[fileName] = { tests: suiteResults };
          }
        });

        for (const testCase of suite.tests) {
          it.concurrent(testCase.title, async () => {
            const entry: TestReportEntry = {
              name: testCase.title,
              result: { passed: true },
            };
            let insertedIds: number[] = [];
            const testId = `t_${testCase.title.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}_${Math.random().toString(36).slice(2, 10)}`;
            try {
              insertedIds = await insertSuiteResources(suite.resources, testId);
              if (testCase.expectError) {
                try {
                  await executeViewDefinition(
                    testCase.view,
                    testId,
                  );
                  entry.result = {
                    passed: false,
                    error: "Expected an error but the test passed",
                  };
                  expect.fail("Expected an error but the test passed");
                } catch {
                  entry.result = { passed: true };
                  suiteResults.push(entry);
                }
                return;
              }
              const result = await executeViewDefinition(
                testCase.view,
                testId,
              );
              const passed = compareResults(
                result.results,
                (testCase.expect ?? []),
                testCase.expectColumns,
                result.columns,
              );
              if (!passed) {
                const errorMessage = `Results don't match. Expected: ${JSON.stringify(testCase.expect)}, Actual: ${JSON.stringify(result.results)}`;
                entry.result = { passed: false, error: errorMessage };
                suiteResults.push(entry);
                expect.fail(errorMessage);
              }
              suiteResults.push(entry);
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              entry.result = { passed: false, error: errorMessage };
              suiteResults.push(entry);
              throw error;
            } finally {
              await deleteTestRows(insertedIds);
            }
          });
        }
      });
    }
  },
);
