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
 * Database-backed integration tests for the loader's JSON storage variants
 * (data-model.md lifecycle table, FR-011/FR-014).
 *
 * Exercises the loader end to end against a real Oracle database: the default
 * `BLOB IS JSON` column (19c+, every supported version) and the native `JSON`
 * column (21c+ only). The native-JSON cases skip automatically on older
 * servers, so the same file is safe to run across the whole CI matrix.
 *
 * Runs against both dev databases: the shared 19c instance (BLOB only) and
 * the local 23ai container (BLOB and native JSON).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import oracledb from "oracledb";

import {
  createLoaderIntegrationHarness,
  SAMPLE_PATIENTS,
} from "./loaderHarness.js";
import { hasOracleEnvironment } from "./testDatabase.js";

const harness = createLoaderIntegrationHarness();

const oracleAvailable = (() => {
  try {
    return hasOracleEnvironment();
  } catch {
    return false;
  }
})();

beforeAll(() => harness.connect());
afterAll(() => harness.cleanup());

describe.skipIf(!oracleAvailable)(
  "loadNdjsonFiles json column type (US2)",
  () => {
    it("creates a BLOB IS JSON column and loads every row when the type is omitted", async () => {
      // The default path must work on every supported version (FR-011).
      const tableName = harness.makeTableName();
      const result = await harness.loadSample(tableName);

      expect(result.failed).toBe(false);
      expect(result.totalRows).toBe(SAMPLE_PATIENTS.length);

      const columnType = await harness.getJsonColumnType(tableName);
      expect(columnType?.dataType).toBe("BLOB");

      expect(await harness.getRowCount(tableName)).toBe(SAMPLE_PATIENTS.length);
    });

    it("round-trips resources byte-equivalent through the BLOB column", async () => {
      // data-model.md: BLOB storage must round-trip byte-equivalent, including
      // multi-byte characters and resources larger than 32 KiB.
      const tableName = harness.makeTableName();
      const largeText = "x".repeat(40_000);
      const resources = [
        { resourceType: "Patient", id: "u1", text: "Café Ünïcode 🩺 中文" },
        { resourceType: "Patient", id: "big", text: largeText },
      ];
      const directory = harness.writeNdjsonDir({
        "Patient.ndjson": resources.map((resource) => JSON.stringify(resource)),
      });
      const loadResult = await harness.loadDir(directory, tableName);
      expect(loadResult.failed).toBe(false);
      expect(loadResult.totalRows).toBe(2);

      const connection = await harness.pool().getConnection();
      try {
        const queryResult = await connection.execute<{
          JSON: Buffer;
        }>(
          `SELECT json FROM ${tableName} ORDER BY id`,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const blobs = queryResult.rows?.map((row) => row.JSON) ?? [];
        expect(blobs).toHaveLength(2);
        expect(blobs[0].toString("utf8")).toBe(JSON.stringify(resources[0]));
        expect(blobs[1].toString("utf8")).toBe(JSON.stringify(resources[1]));
      } finally {
        await connection.close();
      }
    });

    it("creates a native JSON column and loads every row when JSON is requested", async (ctx) => {
      if (harness.getMajorVersion() < 21) {
        ctx.skip();
      }
      const tableName = harness.makeTableName();
      const result = await harness.loadSample(tableName, {
        resourceJsonDataType: "JSON",
      });

      expect(result.failed).toBe(false);
      expect(result.totalRows).toBe(SAMPLE_PATIENTS.length);

      const columnType = await harness.getJsonColumnType(tableName);
      expect(columnType?.dataType).toBe("JSON");

      expect(await harness.getRowCount(tableName)).toBe(SAMPLE_PATIENTS.length);

      // Value round-trip: the resource is readable through the native type.
      const connection = await harness.pool().getConnection();
      try {
        const queryResult = await connection.execute<{ ID: string }>(
          `SELECT JSON_VALUE(json, '$.id') AS id FROM ${tableName} ORDER BY id`,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const ids = queryResult.rows?.map((row) => row.ID) ?? [];
        expect(ids).toEqual(["p1", "p2", "p3"]);
      } finally {
        await connection.close();
      }
    });

    it("accepts a lower-case json value and still creates the native type", async (ctx) => {
      if (harness.getMajorVersion() < 21) {
        ctx.skip();
      }
      const tableName = harness.makeTableName();
      await harness.loadSample(tableName, { resourceJsonDataType: "json" });
      const columnType = await harness.getJsonColumnType(tableName);
      expect(columnType?.dataType).toBe("JSON");
    });

    it("accepts a lower-case blob value and still creates the BLOB variant", async () => {
      const tableName = harness.makeTableName();
      await harness.loadSample(tableName, { resourceJsonDataType: "blob" });
      const columnType = await harness.getJsonColumnType(tableName);
      expect(columnType?.dataType).toBe("BLOB");
    });
  },
);

describe.skipIf(!oracleAvailable)(
  "loadNdjsonFiles existing json column lifecycle (data-model.md)",
  () => {
    it("warns on the other supported storage type and loads into the table unchanged", async () => {
      // First load creates the table as the default BLOB.
      const tableName = harness.makeTableName();
      await harness.loadSample(tableName);

      // Second load requests JSON against the now-existing BLOB table.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let warnings: string[] = [];
      try {
        const result = await harness.loadSample(tableName, {
          resourceJsonDataType: "JSON",
          truncate: true,
        });
        expect(result.failed).toBe(false);
        warnings = warnSpy.mock.calls.map((call) => call.join(" "));
      } finally {
        warnSpy.mockRestore();
      }

      // A warning naming both the existing and requested types must be emitted.
      const mismatchWarning = warnings.find(
        (w) =>
          w.includes("BLOB") && w.includes("JSON") && w.includes(tableName),
      );
      expect(mismatchWarning).toBeDefined();

      // The table must be left unaltered (still BLOB) and hold the fresh load.
      const columnType = await harness.getJsonColumnType(tableName);
      expect(columnType?.dataType).toBe("BLOB");
      expect(await harness.getRowCount(tableName)).toBe(SAMPLE_PATIENTS.length);
    });

    it("fails fast when an existing json column cannot hold a FHIR resource", async () => {
      // A pre-existing table whose json column is a CLOB cannot be a supported
      // target. The loader must reject it before writing any rows, naming the
      // offending column type.
      const tableName = harness.makeTableName();
      const connection = await harness.pool().getConnection();
      try {
        await connection.execute(`CREATE TABLE ${tableName} (
        id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        resource_type VARCHAR2(64) NOT NULL,
        json CLOB NOT NULL
      )`);
      } finally {
        await connection.close();
      }

      await expect(harness.loadSample(tableName)).rejects.toThrow(/CLOB/);

      // No rows must have been written into the unusable column.
      expect(await harness.getRowCount(tableName)).toBe(0);
    });

    it("fails fast naming 21c when native JSON is requested on a pre-21c server", async (ctx) => {
      if (harness.getMajorVersion() >= 21) {
        ctx.skip();
      }
      const tableName = harness.makeTableName();
      await expect(
        harness.loadSample(tableName, { resourceJsonDataType: "JSON" }),
      ).rejects.toThrow(/21c/);

      // The gate must fire before any DDL: the table must not exist.
      expect(await harness.tableExists(tableName)).toBe(false);
    });
  },
);
