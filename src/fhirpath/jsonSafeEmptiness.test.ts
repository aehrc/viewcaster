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
 * Oracle emission tests for array-emptiness checks in the transpiler.
 *
 * The exists()/empty() FHIRPath functions detect an empty collection. The
 * T-SQL reference compared the extracted value to the literal '[]'; Oracle
 * instead emits JSON_EXISTS so the comparison never has to round-trip the
 * array text (a JSON_QUERY result over a BLOB column is RAW, and comparing it
 * to a string literal is invalid). These tests assert the generated SQL
 * invariant without a database, so they guard the behaviour on every Oracle
 * version.
 */

import { describe, expect, it } from "vitest";

import { SqlOnFhir } from "../index";

/**
 * Transpile a single boolean column for the given FHIRPath expression.
 * @param path - The FHIRPath expression to transpile.
 * @returns The generated SQL (default BLOB storage mode).
 */
function transpilePath(path: string): string {
  const sof = new SqlOnFhir();
  return sof.transpile({
    resource: "Patient",
    status: "active",
    select: [{ column: [{ name: "x", path, type: "boolean" }] }],
  }).sql;
}

describe("Oracle emptiness checks", () => {
  // Each of these expressions exercises an array-emptiness check in
  // exists()/empty().
  const arrayExpressions = [
    "name.exists()",
    "name.given.exists()",
    "name.empty()",
    "name.given.empty()",
  ];

  for (const path of arrayExpressions) {
    it(`emits no bare '[]' comparison for ${path}`, () => {
      const sql = transpilePath(path);
      expect(sql).not.toContain("'[]'");
    });
  }

  for (const path of arrayExpressions) {
    it(`emits a JSON_EXISTS predicate for ${path}`, () => {
      const sql = transpilePath(path);
      expect(sql).toContain("JSON_EXISTS");
    });
  }

  it("checks array non-emptiness with the [*] path for exists()", () => {
    // An empty array is a present-but-empty node: JSON_EXISTS over the array
    // itself would be true, so the emitted path iterates the elements.
    const sql = transpilePath("name.exists()");
    expect(sql).toContain("JSON_EXISTS(r.json FORMAT JSON, '$.name[*]')");
  });

  it("negates the same JSON_EXISTS predicate for empty()", () => {
    const sql = transpilePath("name.empty()");
    expect(sql).toContain("NOT JSON_EXISTS(r.json FORMAT JSON, '$.name[*]')");
  });

  it("uses a plain JSON_EXISTS path for scalar exists()", () => {
    const sql = transpilePath("family.exists()");
    expect(sql).toContain("JSON_EXISTS(r.json FORMAT JSON, '$.family')");
  });
});
