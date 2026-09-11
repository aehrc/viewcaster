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
 * Public API tests: exercise only the package root - the export surface,
 * transpile input forms, TranspileResult shape, custom SqlOnFhirOptions
 * reflected in generated SQL, and the error contract.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SqlOnFhir,
  Transpiler,
  ViewDefinitionParser,
  loadNdjsonFiles,
} from "../src/index";

import type { QueryGeneratorOptions } from "../src/index";

describe("public API export surface", () => {
  it("exports SqlOnFhir as a constructible class", () => {
    expect(typeof SqlOnFhir).toBe("function");
    expect(new SqlOnFhir()).toBeInstanceOf(SqlOnFhir);
  });

  it("exports loadNdjsonFiles as a function", () => {
    expect(typeof loadNdjsonFiles).toBe("function");
  });

  it("exports the documented companion API", () => {
    expect(typeof ViewDefinitionParser.parseViewDefinition).toBe("function");
    expect(typeof Transpiler.transpile).toBe("function");
  });
});

describe("transpile input forms", () => {
  const view = {
    resource: "Patient",
    status: "active",
    select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
  };

  it("accepts a ViewDefinition object", () => {
    const result = new SqlOnFhir().transpile(view);
    expect(result.sql).toContain("SELECT");
  });

  it("accepts a JSON string", () => {
    const result = new SqlOnFhir().transpile(JSON.stringify(view));
    expect(result.sql).toContain("SELECT");
  });

  it("accepts a FHIR resource with resourceType ViewDefinition", () => {
    const result = new SqlOnFhir().transpile({
      resourceType: "ViewDefinition",
      ...view,
    });
    expect(result.sql).toContain("SELECT");
  });

  it("throws on an invalid ViewDefinition naming the element", () => {
    expect(() =>
      new SqlOnFhir().transpile({
        resource: "Patient",
        status: "active",
        select: [
          {
            forEach: "name",
            forEachOrNull: "address",
            column: [{ name: "x", path: "family" }],
          },
        ],
      }),
    ).toThrow(/iteration directives/);
  });
});

describe("TranspileResult shape", () => {
  it("exposes columns with name, Oracle type and nullability", () => {
    const result = new SqlOnFhir().transpile({
      resource: "Patient",
      status: "active",
      select: [
        {
          column: [
            { name: "id", path: "id", type: "id" },
            { name: "active", path: "active", type: "boolean" },
            { name: "n", path: "multipleBirthInteger", type: "integer" },
          ],
        },
      ],
    });
    const columns = result.columns;
    expect(columns.map((c) => c.name)).toEqual(["id", "active", "n"]);
    expect(columns[0].type).toBe("VARCHAR2(64)");
    expect(columns[1].type).toBe("NUMBER(1)");
    expect(columns[2].type).toBe("NUMBER(10)");
    expect(columns.every((c) => typeof c.nullable === "boolean")).toBe(true);
  });

  it("emits a single SELECT statement", () => {
    const result = new SqlOnFhir().transpile({
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "id", path: "id" }] }],
    });
    expect(result.sql.trim().startsWith("SELECT")).toBe(true);
    expect(result.sql).not.toContain("INSERT");
  });
});

describe("custom SqlOnFhirOptions", () => {
  it("reflects table, schema and column overrides in generated SQL", () => {
    const options: QueryGeneratorOptions = {
      tableName: "custom_resources",
      schemaName: "fhir",
      resourceIdColumn: "rid",
      resourceJsonColumn: "fhir_json",
      resourceJsonDataType: "JSON",
    };
    const result = new SqlOnFhir(options).transpile({
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
    });
    expect(result.sql).toContain("FROM fhir.custom_resources r");
    expect(result.sql).toContain("r.fhir_json");
    expect(result.sql).not.toContain("FORMAT JSON");
  });

  it("defaults to fhir_resources in the current schema", () => {
    const result = new SqlOnFhir().transpile({
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "id", path: "id" }] }],
    });
    expect(result.sql).toContain("FROM fhir_resources r");
  });
});

describe("load API error contract", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "viewcaster-api-"));
    delete process.env.ORACLE_HOST;
    delete process.env.ORACLE_PORT;
    delete process.env.ORACLE_SERVICE_NAME;
    delete process.env.ORACLE_USER;
    delete process.env.ORACLE_PASSWORD;
    delete process.env.ORACLE_CONNECT_STRING;
  });

  it("rejects an invalid resourceJsonDataType before opening a connection", async () => {
    // An unroutable address guarantees no connection could open; the invalid
    // type must be rejected before that would even be attempted.
    await expect(
      loadNdjsonFiles({
        directory: tempDir,
        database: {
          host: "10.255.255.1",
          port: 1521,
          serviceName: "NOPE",
          user: "nobody",
          password: "nothing",
        },
        resourceJsonDataType: "CLOB",
      }),
    ).rejects.toThrow(/Invalid resource JSON data type/);
  });
});

describe("parser round trip via public API", () => {
  it("parses a valid ViewDefinition", () => {
    const viewDef = ViewDefinitionParser.parseViewDefinition({
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "id", path: "id" }] }],
    });
    expect(viewDef.resource).toBe("Patient");
  });
});
