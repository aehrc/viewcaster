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
 * Behaviour spike for the Oracle JSON features the transpiler relies on.
 * Runs against whichever Oracle the `ORACLE_*` environment points at and
 * exercises both storage variants where the version allows. Assertions pin
 * the behaviours the emission design depends on; version-dependent observations
 * are logged so CI runs on other versions can be compared for consistency.
 *
 * Deliberately absent: `RETURNING VARCHAR2(32767)` with values over 4,000
 * bytes. On 19c (MAX_STRING_SIZE=STANDARD) sorting such a value raises
 * ORA-00600 [17147] and kills the server process, so it is not probed here.
 */

/* eslint-disable vitest/no-disabled-tests -- the native JSON variant is skipped at run time on databases older than 21c. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestTable,
  dropTestTable,
  getMajorVersion,
  hasOracleEnvironment,
  insertTestResources,
  openTestConnection,
  type StorageType,
} from "../testDatabase";

import type oracledb from "oracledb";

const LONG_TEXT = "x".repeat(5000);

const RESOURCES = [
  {
    resourceType: "Patient",
    id: "p1",
    active: true,
    deceasedBoolean: false,
    multipleBirthInteger: 3,
    name: [
      { family: "Smith", given: ["Ann", "Bea"] },
      { family: "Jones", given: ["Cy"] },
    ],
    text: { div: "" },
    longText: LONG_TEXT,
  },
  { resourceType: "Patient", id: "p2" },
];

type Row = Record<string, unknown>;

/**
 * Executes a query and returns its rows, or the Oracle error code when the
 * statement fails.
 * @param connection - An open connection.
 * @param sql - Statement to execute.
 * @returns The rows, or the error code.
 */
async function probe(
  connection: oracledb.Connection,
  sql: string,
): Promise<
  { rows: Row[]; error?: undefined } | { rows?: undefined; error: string }
> {
  try {
    const result = await connection.execute<Row>(sql);
    return { rows: result.rows ?? [] };
  } catch (error) {
    // oracledb errors carry the ORA-/NJS- code in a `code` property.
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      return { error: error.code };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe.skipIf(!hasOracleEnvironment())("Oracle JSON feature spike", () => {
  let connection: oracledb.Connection;
  let majorVersion: number;
  const observations: string[] = [];

  beforeAll(async () => {
    connection = await openTestConnection();
    majorVersion = getMajorVersion(connection);
  });

  afterAll(async () => {
    console.info(
      [
        `Oracle ${connection.oracleServerVersionString} observations:`,
        ...observations.map((line) => `  - ${line}`),
      ].join("\n"),
    );
    await connection.close();
  });

  const variants: Array<{ storageType: StorageType; table: string }> = [
    { storageType: "BLOB", table: "sof_spike_blob" },
    { storageType: "JSON", table: "sof_spike_json" },
  ];

  describe.each(variants)("$storageType storage", ({ storageType, table }) => {
    // FORMAT JSON is emitted only for BLOB storage.
    const fj = storageType === "BLOB" ? " FORMAT JSON" : "";
    let supported = true;

    beforeAll(async () => {
      supported = storageType === "BLOB" || majorVersion >= 21;
      if (!supported) {
        observations.push(
          `${storageType}: native JSON type unavailable on ${majorVersion}c, variant skipped`,
        );
        return;
      }
      await dropTestTable(connection, table);
      await createTestTable(connection, storageType, table);
      await insertTestResources(
        connection,
        RESOURCES,
        storageType,
        table,
        "spike",
      );
    });

    afterAll(async () => {
      if (supported) {
        await dropTestTable(connection, table);
      }
    });

    /**
     * Runs the probe and records a one-line observation for the report.
     * @param label - Short description of the probe.
     * @param sql - Statement to execute.
     * @returns The probe outcome.
     */
    async function observe(label: string, sql: string) {
      const outcome = await probe(connection, sql);
      observations.push(
        `${storageType} ${label}: ${
          outcome.error ?? JSON.stringify(outcome.rows)
        }`,
      );
      return outcome;
    }

    it("Accepts FORMAT JSON on the column and tolerates its absence", async (context) => {
      if (!supported) return context.skip();
      const withFormat = await observe(
        "JSON_VALUE with FORMAT JSON",
        `SELECT JSON_VALUE(json FORMAT JSON, '$.id') AS "v" FROM ${table} ORDER BY id`,
      );
      expect(withFormat.rows?.map((row) => row.v)).toEqual(["p1", "p2"]);
      const withoutFormat = await observe(
        "JSON_VALUE without FORMAT JSON",
        `SELECT JSON_VALUE(json, '$.id') AS "v" FROM ${table} ORDER BY id`,
      );
      expect(withoutFormat.rows?.map((row) => row.v)).toEqual(["p1", "p2"]);
    });

    it("JSON_VALUE defaults to VARCHAR2(4000) and yields NULL for longer strings", async (context) => {
      if (!supported) return context.skip();
      const long = await observe(
        "long string default",
        `SELECT LENGTH(JSON_VALUE(json${fj}, '$.longText')) AS "l" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      expect(long.rows?.[0]?.l).toBeNull();
      const errorOnError = await observe(
        "long string ERROR ON ERROR",
        `SELECT JSON_VALUE(json${fj}, '$.longText' ERROR ON ERROR) AS "v" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      expect(errorOnError.error).toMatch(/^ORA-(40478|61723)$/);
      const truncated = await observe(
        "long string TRUNCATE",
        `SELECT LENGTH(JSON_VALUE(json${fj}, '$.longText' RETURNING VARCHAR2(4000) TRUNCATE)) AS "l" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      expect(truncated.rows?.[0]?.l).toBe(4000);
    });

    it("RETURNING CLOB extracts long strings but cannot be compared", async (context) => {
      if (!supported) return context.skip();
      const clob = await observe(
        "long string RETURNING CLOB",
        `SELECT LENGTH(JSON_VALUE(json${fj}, '$.longText' RETURNING CLOB)) AS "l" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      expect(clob.rows?.[0]?.l).toBe(5000);
      const compared = await observe(
        "RETURNING CLOB in WHERE",
        `SELECT COUNT(*) AS "n" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id' RETURNING CLOB) = 'p1'`,
      );
      expect(compared.error).toMatch(/^ORA-(00932|22848)$/);
      const inUnion = await observe(
        "RETURNING CLOB in UNION",
        `SELECT JSON_VALUE(json${fj}, '$.id' RETURNING CLOB) AS "v" FROM ${table} UNION SELECT JSON_VALUE(json${fj}, '$.id' RETURNING CLOB) FROM ${table}`,
      );
      expect(inUnion.error).toMatch(/^ORA-(00932|22848)$/);
    });

    it("RETURNING NUMBER converts JSON numbers and nulls non-numeric text", async (context) => {
      if (!supported) return context.skip();
      const numbers = await observe(
        "RETURNING NUMBER",
        `SELECT JSON_VALUE(json${fj}, '$.multipleBirthInteger' RETURNING NUMBER) AS "n", JSON_VALUE(json${fj}, '$.id' RETURNING NUMBER) AS "s" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      expect(numbers.rows?.[0]).toEqual({ n: 3, s: null });
    });

    it("Booleans extract as text and map to NUMBER(1) via CASE", async (context) => {
      if (!supported) return context.skip();
      const text = await observe(
        "boolean default",
        `SELECT JSON_VALUE(json${fj}, '$.active') AS "a", JSON_VALUE(json${fj}, '$.deceasedBoolean') AS "d" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      expect(text.rows?.[0]).toEqual({ a: "true", d: "false" });
      const viaCase = await observe(
        "boolean CASE",
        `SELECT CASE JSON_VALUE(json${fj}, '$.active') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS "a", CASE JSON_VALUE(json${fj}, '$.deceasedBoolean') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS "d" FROM ${table} ORDER BY id`,
      );
      expect(viaCase.rows).toEqual([
        { a: 1, d: 0 },
        { a: null, d: null },
      ]);
      // Version-dependent: 19c converts true/false to 1/0, 23ai yields NULL.
      await observe(
        "boolean RETURNING NUMBER",
        `SELECT JSON_VALUE(json${fj}, '$.active' RETURNING NUMBER) AS "a" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
      // Version-dependent: ORA-40449 before 23ai, native BOOLEAN on 23ai.
      await observe(
        "boolean RETURNING BOOLEAN",
        `SELECT JSON_VALUE(json${fj}, '$.active' RETURNING BOOLEAN) AS "a" FROM ${table} WHERE JSON_VALUE(json${fj}, '$.id') = 'p1'`,
      );
    });

    it("CROSS APPLY and OUTER APPLY JSON_TABLE with FOR ORDINALITY", async (context) => {
      if (!supported) return context.skip();
      const cross = await observe(
        "CROSS APPLY JSON_TABLE",
        `SELECT JSON_VALUE(t.json${fj}, '$.id') AS "id", n.idx - 1 AS "rowIndex", n.family AS "family" FROM ${table} t CROSS APPLY JSON_TABLE(t.json${fj}, '$.name[*]' COLUMNS (idx FOR ORDINALITY, family VARCHAR2(4000) PATH '$.family')) n ORDER BY 1, 2`,
      );
      expect(cross.rows).toEqual([
        { id: "p1", rowIndex: 0, family: "Smith" },
        { id: "p1", rowIndex: 1, family: "Jones" },
      ]);
      const outer = await observe(
        "OUTER APPLY JSON_TABLE",
        `SELECT JSON_VALUE(t.json${fj}, '$.id') AS "id", n.idx AS "idx", n.family AS "family" FROM ${table} t OUTER APPLY JSON_TABLE(t.json${fj}, '$.name[*]' COLUMNS (idx FOR ORDINALITY, family VARCHAR2(4000) PATH '$.family')) n ORDER BY 1, 2`,
      );
      expect(outer.rows).toEqual([
        { id: "p1", idx: 1, family: "Smith" },
        { id: "p1", idx: 2, family: "Jones" },
        { id: "p2", idx: null, family: null },
      ]);
    });

    it("Nested JSON_TABLE must not consume another JSON_TABLE column directly", async (context) => {
      if (!supported) return context.skip();
      const outerApply = `CROSS APPLY JSON_TABLE(t.json${fj}, '$.name[*]' COLUMNS (idx FOR ORDINALITY, item VARCHAR2(4000) FORMAT JSON PATH '$')) n`;
      const direct = await observe(
        "chained JSON_TABLE on JSON_TABLE column",
        `SELECT n.idx AS "idx", g.given AS "given" FROM ${table} t ${outerApply} CROSS APPLY JSON_TABLE(n.item, '$.given[*]' COLUMNS (given VARCHAR2(4000) PATH '$')) g`,
      );
      expect(direct.error).toBe("ORA-40556");
      const viaJsonQuery = await observe(
        "chained JSON_TABLE via JSON_QUERY",
        `SELECT n.idx AS "idx", g.gidx AS "gidx", g.given AS "given" FROM ${table} t ${outerApply} CROSS APPLY JSON_TABLE(JSON_QUERY(n.item, '$.given'), '$[*]' COLUMNS (gidx FOR ORDINALITY, given VARCHAR2(4000) PATH '$')) g ORDER BY 1, 2`,
      );
      expect(viaJsonQuery.rows).toEqual([
        { idx: 1, gidx: 1, given: "Ann" },
        { idx: 1, gidx: 2, given: "Bea" },
        { idx: 2, gidx: 1, given: "Cy" },
      ]);
      const viaNoMerge = await observe(
        "chained JSON_TABLE via NO_MERGE inline view",
        `SELECT /*+ NO_MERGE(x) */ x.idx AS "idx", g.given AS "given" FROM (SELECT n.idx, n.item FROM ${table} t ${outerApply}) x CROSS APPLY JSON_TABLE(x.item, '$.given[*]' COLUMNS (given VARCHAR2(4000) PATH '$')) g ORDER BY 1, 2`,
      );
      expect(viaNoMerge.rows).toEqual([
        { idx: 1, given: "Ann" },
        { idx: 1, given: "Bea" },
        { idx: 2, given: "Cy" },
      ]);
      const scalarViaJsonValue = await observe(
        "JSON_VALUE on JSON_TABLE FORMAT JSON column",
        `SELECT JSON_VALUE(n.item, '$.family') AS "f" FROM ${table} t ${outerApply} ORDER BY n.idx`,
      );
      expect(scalarViaJsonValue.rows?.map((row) => row.f)).toEqual([
        "Smith",
        "Jones",
      ]);
    });

    it("An empty JSON string extracts as NULL but still exists", async (context) => {
      if (!supported) return context.skip();
      const empty = await observe(
        "empty string",
        `SELECT JSON_VALUE(json${fj}, '$.text.div') AS "v", CASE WHEN JSON_EXISTS(json${fj}, '$.text.div') THEN 1 ELSE 0 END AS "ex" FROM ${table} ORDER BY id`,
      );
      expect(empty.rows).toEqual([
        { v: null, ex: 1 },
        { v: null, ex: 0 },
      ]);
    });
  });
});
