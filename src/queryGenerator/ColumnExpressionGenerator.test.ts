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
 * Unit tests for Oracle SQL emission of ViewDefinition columns:
 * JSON_VALUE/JSON_QUERY forms, storage-aware FORMAT JSON, quoted aliases,
 * type casts, tag precedence, and resource/reference key functions.
 */

import { describe, expect, it } from "vitest";
import { SqlOnFhir } from "../index";

/**
 * Transpile a single-column Patient view with the given column definition.
 *
 * @param column - The ViewDefinition column object.
 * @param options - Optional SqlOnFhir options (storage type et al).
 * @returns The generated SQL.
 */
function transpileColumn(
  column: Record<string, unknown>,
  options: Record<string, unknown> = {},
): { sql: string; type: string } {
  const sof = new SqlOnFhir(options);
  const result = sof.transpile({
    resource: "Patient",
    status: "active",
    select: [{ column: [column] }],
  });
  return { sql: result.sql, type: result.columns[0].type };
}

describe("Oracle column emission", () => {
  it("emits JSON_VALUE with FORMAT JSON and RETURNING in BLOB mode", () => {
    const { sql } = transpileColumn({ name: "family", path: "name.family" });
    expect(sql).toContain(
      `JSON_VALUE(r.json FORMAT JSON, '$.name.family' RETURNING VARCHAR2(4000)) AS "family"`,
    );
  });

  it("omits FORMAT JSON in native JSON mode", () => {
    const { sql } = transpileColumn(
      { name: "family", path: "name.family" },
      { resourceJsonDataType: "json" },
    );
    expect(sql).toContain(`JSON_VALUE(r.json, '$.name.family'`);
    expect(sql).not.toContain("FORMAT JSON");
  });

  it("emits JSON_QUERY for known array fields", () => {
    const { sql } = transpileColumn({ name: "names", path: "name" });
    expect(sql).toContain(
      `JSON_QUERY(r.json FORMAT JSON, '$.name') AS "names"`,
    );
  });

  it("quotes output aliases", () => {
    const { sql } = transpileColumn({ name: "family_name", path: "name.family" });
    expect(sql).toContain(`AS "family_name"`);
    expect(sql).not.toContain("AS [family_name]");
  });

  it("leaves base identifiers unquoted", () => {
    const { sql } = transpileColumn({ name: "id", path: "id", type: "id" });
    expect(sql).toContain("FROM fhir_resources r");
    expect(sql).toContain("r.resource_type = 'Patient'");
    expect(sql).not.toContain("[r]");
  });

  it("emits boolean columns as CASE over NUMBER(1)", () => {
    const { sql, type } = transpileColumn({
      name: "active",
      path: "active",
      type: "boolean",
    });
    expect(type).toBe("NUMBER(1)");
    expect(sql).toContain(
      "CASE WHEN JSON_VALUE(r.json FORMAT JSON, '$.active' RETURNING VARCHAR2(4000)) = 'true' THEN 1 WHEN JSON_VALUE(r.json FORMAT JSON, '$.active' RETURNING VARCHAR2(4000)) = 'false' THEN 0 ELSE NULL END",
    );
  });

  it("casts integer columns to NUMBER(10)", () => {
    const { sql, type } = transpileColumn({
      name: "multiple_birth",
      path: "multipleBirthInteger",
      type: "integer",
    });
    expect(type).toBe("NUMBER(10)");
    expect(sql).toContain(
      "CAST(JSON_VALUE(r.json FORMAT JSON, '$.multipleBirthInteger' RETURNING VARCHAR2(4000)) AS NUMBER(10))",
    );
  });

  it("maps decimal columns to VARCHAR2(4000) text", () => {
    const { type } = transpileColumn({
      name: "value",
      path: "valueDecimal",
      type: "decimal",
    });
    expect(type).toBe("VARCHAR2(4000)");
  });

  it("maps date columns to VARCHAR2(10)", () => {
    const { type, sql } = transpileColumn({
      name: "birth_date",
      path: "birthDate",
      type: "date",
    });
    expect(type).toBe("VARCHAR2(10)");
    expect(sql).toContain("CAST(");
  });

  it("honours oracle/type tags verbatim", () => {
    const { sql, type } = transpileColumn({
      name: "birth_date",
      path: "birthDate",
      type: "date",
      tag: [{ name: "oracle/type", value: "DATE" }],
    });
    expect(type).toBe("DATE");
    expect(sql).toContain(
      "CAST(JSON_VALUE(r.json FORMAT JSON, '$.birthDate' RETURNING VARCHAR2(4000)) AS DATE)",
    );
  });

  it("translates ansi/type tags to Oracle types", () => {
    const { type, sql } = transpileColumn({
      name: "count",
      path: "multipleBirthInteger",
      type: "integer",
      tag: [{ name: "ansi/type", value: "INTEGER" }],
    });
    expect(type).toBe("NUMBER(10)");
    expect(sql).toContain("AS NUMBER(10)");
  });

  it("gives oracle/type precedence over ansi/type", () => {
    const { type } = transpileColumn({
      name: "count",
      path: "multipleBirthInteger",
      type: "integer",
      tag: [
        { name: "ansi/type", value: "INTEGER" },
        { name: "oracle/type", value: "CLOB" },
      ],
    });
    expect(type).toBe("CLOB");
  });

  it("extracts the FHIR id for getResourceKey()", () => {
    const { sql } = transpileColumn({
      name: "key",
      path: "getResourceKey()",
      type: "id",
    });
    expect(sql).toContain(
      "r.resource_type || '/' || JSON_VALUE(r.json FORMAT JSON, '$.id' RETURNING VARCHAR2(4000))",
    );
  });

  it("emits getReferenceKey() without a type filter", () => {
    const { sql } = transpileColumn({
      name: "ref",
      path: "generalPractitioner.getReferenceKey()",
    });
    expect(sql).toContain(
      "JSON_VALUE(r.json FORMAT JSON, '$.generalPractitioner[0].reference' RETURNING VARCHAR2(4000))",
    );
  });

  it("emits getReferenceKey(Patient) with a type filter", () => {
    const { sql } = transpileColumn({
      name: "ref",
      path: "generalPractitioner.getReferenceKey(Patient)",
    });
    const referenceExpr =
      "JSON_VALUE(r.json FORMAT JSON, '$.generalPractitioner[0].reference' RETURNING VARCHAR2(4000))";
    expect(sql).toContain(
      `CASE WHEN SUBSTR(${referenceExpr}, 1, 8) = 'Patient/' THEN ${referenceExpr} END`,
    );
  });
});
