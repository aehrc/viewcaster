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
 * Oracle emission tests for array indexing applied to filtered-collection
 * subqueries.
 *
 * A `where()` compiles to a scalar subquery over a JSON_TABLE
 * (`(SELECT value FROM JSON_TABLE(...) whereItem WHERE <cond> AND ROWNUM = 1)`),
 * and member navigation splices the field into that subquery's SELECT list.
 * Array indexing applied after the where() must splice into the subquery the
 * same way: the collapsed forms either emit a bare `JSON_VALUE(value, ...)`
 * that silently binds to an unrelated lateral column, or re-target the where
 * condition's own fragment. Both are wrong-scoped SQL, so the tests assert
 * the subquery-spliced emission and that unrepresentable indexes are
 * rejected. These tests run without a database.
 */

import { describe, expect, it } from "vitest";

import { SqlOnFhir } from "../index";

/**
 * Transpile a single string column for the given FHIRPath expression.
 * @param path - The FHIRPath expression to transpile.
 * @returns The generated SQL (default BLOB storage mode).
 */
function transpilePath(path: string): string {
  const sof = new SqlOnFhir();
  return sof.transpile({
    resource: "Patient",
    status: "active",
    select: [{ column: [{ name: "x", path, type: "string" }] }],
  }).sql;
}

describe("indexing a where() subquery", () => {
  it("splices the index into the field path inside the subquery", () => {
    // name.where(...).given[0] must keep the subquery: ROWNUM = 1 selects the
    // first matching name, and the index applies within that element.
    const sql = transpilePath("name.where(use = 'official').given[0]");
    expect(sql).toContain(
      "(SELECT JSON_VALUE(value FORMAT JSON, '$.given[0]' RETURNING VARCHAR2(4000)) FROM JSON_TABLE(r.json FORMAT JSON, '$.name[*]'",
    );
    expect(sql).toContain("whereItem");
  });

  it("splices a non-zero index into the field path inside the subquery", () => {
    const sql = transpilePath("name.where(use = 'official').given[2]");
    expect(sql).toContain(
      "'$.given[2]' RETURNING VARCHAR2(4000)) FROM JSON_TABLE(r.json FORMAT JSON, '$.name[*]'",
    );
  });

  it("keeps the subquery for an explicit [0] on the filtered collection", () => {
    // The subquery already selects only the first match (ROWNUM = 1), so [0]
    // is the subquery itself.
    const sql = transpilePath("name.where(use = 'official')[0]");
    expect(sql).toContain(
      "(SELECT value FROM JSON_TABLE(r.json FORMAT JSON, '$.name[*]'",
    );
    expect(sql).toContain("ROWNUM = 1");
    expect(sql).not.toContain("'$.use[0]'");
  });

  it("navigates members after an explicit [0] on the filtered collection", () => {
    const sql = transpilePath("name.where(use = 'official')[0].given");
    expect(sql).toContain(
      "(SELECT JSON_VALUE(value FORMAT JSON, '$.given' RETURNING VARCHAR2(4000)) FROM JSON_TABLE(r.json FORMAT JSON, '$.name[*]'",
    );
  });

  it("rejects an index beyond the first element of a filtered collection", () => {
    // The subquery is a ROWNUM = 1 singleton; a second matching element
    // cannot be selected by appending to the singleton's path.
    expect(() => transpilePath("name.where(use = 'official')[1]")).toThrow(
      /first|index/i,
    );
  });
});

describe("indexing preserved forms", () => {
  it("indexes a JSON_QUERY array extraction with the '$[i]' form", () => {
    // A plain array member indexed directly is the legitimate bare form over
    // the extracted array text.
    const sql = transpilePath("name[0]");
    expect(sql).toContain(
      "JSON_VALUE(JSON_QUERY(r.json FORMAT JSON, '$.name'), '$[0]')",
    );
  });
});

describe("indexing rejected forms", () => {
  it("rejects indexing an expression with no array semantics", () => {
    // Indexing a scalar count subquery cannot be expressed as JSON path
    // navigation; emitting wrong-scoped SQL silently is worse than failing.
    expect(() => transpilePath("name.count()[0]")).toThrow(/index/i);
  });
});
