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
 * Unit tests for the tree-walker query compiler's Oracle emission:
 * forEach -> CROSS APPLY JSON_TABLE, forEachOrNull -> OUTER APPLY, nested
 * selects, unionAll as top-level UNION ALL branches, %rowIndex via
 * FOR ORDINALITY, and constants.
 */

import { describe, expect, it } from "vitest";
import { SqlOnFhir } from "../../index";

/**
 * Transpile a ViewDefinition object to SQL.
 *
 * @param viewDef - The ViewDefinition (unvalidated shape is fine).
 * @param options - Optional SqlOnFhir options.
 * @returns The generated SQL.
 */
function transpile(
  viewDef: Record<string, unknown>,
  options: Record<string, unknown> = {},
): string {
  return new SqlOnFhir(options).transpile(viewDef).sql;
}

describe("tree walker Oracle emission", () => {
  it("emits CROSS APPLY JSON_TABLE for forEach", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          forEach: "name",
          column: [{ name: "family", path: "family", type: "string" }],
        },
      ],
    });
    expect(sql).toContain(
      "CROSS APPLY JSON_TABLE(r.json FORMAT JSON, '$.name[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$', scalar VARCHAR2(4000) PATH '$')) forEach_0",
    );
  });

  it("emits OUTER APPLY JSON_TABLE for forEachOrNull", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          forEachOrNull: "name",
          column: [{ name: "family", path: "family", type: "string" }],
        },
      ],
    });
    expect(sql).toContain("OUTER APPLY JSON_TABLE(r.json");
  });

  it("wraps nested forEach sources in JSON_QUERY (ORA-40556)", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          forEach: "name",
          select: [
            {
              forEach: "given",
              column: [{ name: "given", path: "$this", type: "string" }],
            },
          ],
        },
      ],
    });
    expect(sql).toContain(
      "CROSS APPLY JSON_TABLE(JSON_QUERY(forEach_0.value FORMAT JSON, '$.given' RETURNING CLOB), '$[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$', scalar VARCHAR2(4000) PATH '$')) forEach_1",
    );
  });

  it("resolves %rowIndex to the FOR ORDINALITY column minus one", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          forEach: "name",
          column: [{ name: "i", path: "%rowIndex", type: "integer" }],
        },
      ],
    });
    expect(sql).toContain("COALESCE(forEach_0.idx - 1, 0) AS \"i\"");
  });

  it("resolves %rowIndex at the resource root to 0", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "i", path: "%rowIndex", type: "integer" }] }],
    });
    expect(sql).toContain("0 AS \"i\"");
  });

  it("composes unionAll as top-level UNION ALL branches", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        { column: [{ name: "id", path: "id", type: "id" }] },
        {
          unionAll: [
            {
              forEach: "telecom",
              column: [{ name: "value", path: "value", type: "string" }],
            },
            {
              forEach: "contact.telecom",
              column: [{ name: "value", path: "value", type: "string" }],
            },
          ],
        },
      ],
    });
    const branchCount = sql.split("\nUNION ALL\n").length;
    expect(branchCount).toBe(2);
    // Both branches project the enclosing id column first, then the union
    // columns, and each carries the resource type filter.
    expect(sql.match(/r\.resource_type = 'Patient'/g)?.length).toBe(2);
    expect(sql).toContain('AS "id"');
    expect(sql).toContain('AS "value"');
  });

  it("emits nested select columns in the enclosing APPLY scope", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          forEach: "contact",
          column: [{ name: "system", path: "telecom.system" }],
          select: [{ column: [{ name: "gender", path: "gender" }] }],
        },
      ],
    });
    expect(sql).toContain(
      "CROSS APPLY JSON_TABLE(r.json FORMAT JSON, '$.contact[*]' COLUMNS",
    );
    expect(sql).toContain(
      "JSON_VALUE(contact_0.value FORMAT JSON, '$.telecom.system' RETURNING VARCHAR2(4000))",
    );
  });

  it("filters forEach collections with a where() predicate", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          forEach: "telecom.where(system = 'phone')",
          column: [{ name: "value", path: "value", type: "string" }],
        },
      ],
    });
    expect(sql).toContain(
      "JSON_VALUE(value FORMAT JSON, '$.system' RETURNING VARCHAR2(4000)) = 'phone'",
    );
    expect(sql).toContain("WHERE 1 = 0") === false;
  });

  it("resolves ViewDefinition constants referenced with %name", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      constant: [{ name: "smoking", valueString: "smoking" }],
      select: [
        {
          forEach: "telecom",
          column: [
            {
              name: "is_phone",
              path: "system.where($this = %smoking).exists()",
              type: "boolean",
            },
          ],
        },
      ],
    });
    expect(sql).toContain("'smoking'");
  });

  it("rejects unknown constants naming the constant", () => {
    expect(() =>
      transpile({
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "x", path: "%missing" }] }],
      }),
    ).toThrow(/%missing/);
  });

  it("emits quoted output aliases with unquoted base identifiers", () => {
    const sql = transpile({
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "family", path: "name.family" }] }],
    });
    expect(sql).toContain('AS "family"');
    expect(sql).toContain("FROM fhir_resources r");
  });

  it("supports schema-qualified table names", () => {
    const sql = transpile(
      {
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
      },
      { schemaName: "fhir", tableName: "resources" },
    );
    expect(sql).toContain("FROM fhir.resources r");
  });

  it("honours custom id and json column names", () => {
    const sql = transpile(
      {
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
      },
      { resourceJsonColumn: "fhir_json" },
    );
    expect(sql).toContain("JSON_VALUE(r.fhir_json FORMAT JSON, '$.id'");
  });
});
