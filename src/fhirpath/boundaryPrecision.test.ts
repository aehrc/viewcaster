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
 * Oracle emission tests for the source extraction used by lowBoundary() and
 * highBoundary().
 *
 * A boundary is defined by the precision of the input's lexical form: with N
 * fractional digits the value is known to within half a unit in the last
 * place, so `1.0` has boundaries 0.95 and 1.05 while `1` has 0.5 and 1.5.
 * Oracle's JSON_VALUE normalises a JSON number before returning it, so `1.0`
 * arrives as `1` and every trailing zero, and with it the precision the
 * function depends on, is lost. JSON_QUERY returns the value's original text.
 *
 * These tests assert the extraction the transpiler emits, without needing a
 * database, so the invariant is guarded on every Oracle version. The
 * end-to-end values are covered by the fn_boundary suite in the SQL on FHIR
 * conformance tests.
 */

import { describe, expect, it } from "vitest";

import { SqlOnFhir } from "../index";

/**
 * Transpile a single decimal column for the given FHIRPath expression.
 * @param path - The FHIRPath expression to transpile.
 * @returns The generated SQL (default BLOB storage mode).
 */
function transpilePath(path: string): string {
  const sof = new SqlOnFhir();
  return sof.transpile({
    resource: "Observation",
    status: "active",
    select: [{ column: [{ name: "boundary", path, type: "decimal" }] }],
  }).sql;
}

describe("boundary source extraction", () => {
  // The inferred form classifies the datatype from the lexeme at runtime; the
  // explicit ofType form resolves it at transpile time, and in doing so
  // resolves the polymorphic element to a different JSON path. Both read a
  // scalar source element, so both must preserve its lexeme.
  const cases = [
    {
      path: "value.ofType(Quantity).value.lowBoundary()",
      jsonPath: "$.valueQuantity.value",
    },
    {
      path: "value.ofType(Quantity).value.highBoundary()",
      jsonPath: "$.valueQuantity.value",
    },
    {
      path: "value.ofType(Quantity).value.ofType(decimal).lowBoundary()",
      jsonPath: "$.valueQuantity.valueDecimal",
    },
    {
      path: "value.ofType(Quantity).value.ofType(decimal).highBoundary()",
      jsonPath: "$.valueQuantity.valueDecimal",
    },
  ];

  for (const { path, jsonPath } of cases) {
    it(`reads the source lexeme with JSON_QUERY for ${path}`, () => {
      const sql = transpilePath(path);
      expect(sql).toContain(
        `JSON_QUERY(r.json FORMAT JSON, '${jsonPath}' RETURNING VARCHAR2(4000) WITH WRAPPER)`,
      );
    });

    it(`does not read the source with JSON_VALUE for ${path}`, () => {
      const sql = transpilePath(path);
      // JSON_VALUE would silently drop the trailing zeros that carry the
      // input's precision.
      expect(sql).not.toContain(`JSON_VALUE(r.json FORMAT JSON, '${jsonPath}'`);
    });
  }

  // The array wrapper and the surrounding quotes of a JSON string have to be
  // removed, otherwise a date boundary would operate on `["2010-10-10"]`.
  it("strips the array wrapper and any string quotes", () => {
    const sql = transpilePath("value.ofType(Quantity).value.lowBoundary()");
    expect(sql).toContain("TRIM(BOTH '\"' FROM SUBSTR(JSON_QUERY(");
  });
});
