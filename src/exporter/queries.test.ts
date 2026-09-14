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
 * Unit tests for the exporter's query builders: the shape of the generated
 * SQL per storage type, the resource type filter as a bind rather than an
 * interpolation, and identifier validation.
 */

import { describe, expect, it } from "vitest";

import {
  buildDistinctResourceTypesQuery,
  buildResourceExportQuery,
  validateTableIdentifiers,
} from "./queries.js";

describe("buildDistinctResourceTypesQuery", () => {
  it("lists distinct resource types in name order", () => {
    const sql = buildDistinctResourceTypesQuery(
      undefined,
      "fhir_resources",
      false,
    );
    expect(sql).toMatch(/SELECT\s+DISTINCT\s+resource_type/);
    expect(sql).toMatch(/FROM\s+fhir_resources/);
    expect(sql).toMatch(/ORDER BY\s+resource_type/);
    // Without a filter there is nothing to bind, so no WHERE clause.
    expect(sql).not.toMatch(/WHERE/);
  });

  it("qualifies the table with the schema when one is given", () => {
    const sql = buildDistinctResourceTypesQuery(
      "fhir",
      "fhir_resources",
      false,
    );
    expect(sql).toMatch(/FROM\s+fhir\.fhir_resources/);
  });

  it("filters on a bind variable rather than an interpolated value", () => {
    const sql = buildDistinctResourceTypesQuery(
      undefined,
      "fhir_resources",
      true,
    );
    expect(sql).toMatch(/WHERE\s+resource_type\s+=\s+:resourceType/);
  });

  it("rejects an identifier that is not a valid Oracle identifier", () => {
    expect(() =>
      buildDistinctResourceTypesQuery(
        undefined,
        "resources; DROP TABLE x",
        false,
      ),
    ).toThrow(/Table name/);
    expect(() =>
      buildDistinctResourceTypesQuery("bad schema", "fhir_resources", false),
    ).toThrow(/Schema name/);
  });
});

describe("buildResourceExportQuery", () => {
  it("reads a BLOB column verbatim, ordered by the surrogate id", () => {
    const sql = buildResourceExportQuery(undefined, "fhir_resources", "BLOB");
    // The stored bytes must not pass through any Oracle JSON function, or the
    // document would be re-serialised and the byte-for-byte guarantee lost.
    expect(sql).not.toMatch(/JSON_SERIALIZE/);
    expect(sql).toMatch(/SELECT\s+json/);
    expect(sql).toMatch(/WHERE\s+resource_type\s+=\s+:resourceType/);
    expect(sql).toMatch(/ORDER BY\s+id/);
  });

  it("serialises a native JSON column to UTF-8 bytes", () => {
    const sql = buildResourceExportQuery(undefined, "fhir_resources", "JSON");
    // A native JSON column holds Oracle's binary format, so it has to be
    // serialised; BLOB is requested so both storage types yield UTF-8 bytes.
    expect(sql).toMatch(/JSON_SERIALIZE\(json RETURNING BLOB\)\s+AS json/);
    expect(sql).toMatch(/ORDER BY\s+id/);
  });

  it("qualifies the table with the schema when one is given", () => {
    const sql = buildResourceExportQuery("fhir", "fhir_resources", "BLOB");
    expect(sql).toMatch(/FROM\s+fhir\.fhir_resources/);
  });

  it("rejects an identifier that is not a valid Oracle identifier", () => {
    expect(() => buildResourceExportQuery(undefined, "1bad", "BLOB")).toThrow(
      /Table name/,
    );
  });
});

describe("validateTableIdentifiers", () => {
  it("accepts valid identifiers and ignores an absent schema", () => {
    expect(() =>
      validateTableIdentifiers(undefined, "fhir_resources"),
    ).not.toThrow();
    expect(() =>
      validateTableIdentifiers("fhir", "fhir_resources"),
    ).not.toThrow();
  });

  it("rejects an injection attempt in either identifier", () => {
    expect(() =>
      validateTableIdentifiers(undefined, "t; DELETE FROM x"),
    ).toThrow(/Table name/);
    expect(() => validateTableIdentifiers("s--", "fhir_resources")).toThrow(
      /Schema name/,
    );
  });
});
