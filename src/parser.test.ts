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
 * Tests for ViewDefinition validation on intake (FR-004): structural
 * violations, unknown constants, multi-value non-collection columns, and the
 * never-emit-partial-SQL contract. Errors must name the offending element.
 */

import { describe, expect, it } from "vitest";
import { SqlOnFhir } from "./index";
import { ViewDefinitionParser } from "./parser";

describe("ViewDefinition validation", () => {
  it("rejects a missing resource type", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        status: "active",
        select: [{ column: [{ name: "x", path: "id" }] }],
      }),
    ).toThrow(/resource type/);
  });

  it("rejects an empty select array", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        resource: "Patient",
        status: "active",
        select: [],
      }),
    ).toThrow(/select/);
  });

  it("rejects two iteration directives on one select, naming the element", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
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

  it("rejects a column without a name", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        resource: "Patient",
        status: "active",
        select: [{ column: [{ path: "family" }] }],
      }),
    ).toThrow(/name/);
  });

  it("rejects a column without a path", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "x" }] }],
      }),
    ).toThrow(/FHIRPath/);
  });

  it("rejects a column name that does not match sql-name", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "2bad", path: "family" }] }],
      }),
    ).toThrow(/'2bad'/);
  });

  it("rejects a non-collection column over a multi-valued path", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        resource: "Patient",
        status: "active",
        select: [
          {
            column: [
              {
                name: "family",
                path: "name.family",
                collection: false,
              },
            ],
          },
        ],
      }),
    ).toThrow(/multiple values/);
  });

  it("rejects inconsistent unionAll branches, naming the columns", () => {
    expect(() =>
      ViewDefinitionParser.parseViewDefinition({
        resource: "Patient",
        status: "active",
        select: [
          {
            unionAll: [
              { column: [{ name: "a", path: "id" }] },
              { column: [{ name: "b", path: "id" }] },
            ],
          },
        ],
      }),
    ).toThrow(/unionAll branches/);
  });

  it("parses a valid ViewDefinition", () => {
    const viewDef = ViewDefinitionParser.parseViewDefinition({
      resourceType: "ViewDefinition",
      resource: "Patient",
      status: "active",
      select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
    });
    expect(viewDef.resource).toBe("Patient");
    expect(viewDef.status).toBe("active");
  });

  it("parses from a JSON string", () => {
    const viewDef = ViewDefinitionParser.parseViewDefinition(
      JSON.stringify({
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "id", path: "id" }] }],
      }),
    );
    expect(viewDef.resource).toBe("Patient");
  });
});

describe("transpile-time validation", () => {
  it("rejects a constant with no value element", () => {
    expect(() =>
      new SqlOnFhir().transpile({
        resource: "Patient",
        status: "active",
        constant: [{ name: "c" }],
        select: [{ column: [{ name: "x", path: "id" }] }],
      }),
    ).toThrow(/Constant 'c'/);
  });

  it("rejects a constant with multiple value elements", () => {
    expect(() =>
      new SqlOnFhir().transpile({
        resource: "Patient",
        status: "active",
        constant: [{ name: "c", valueString: "a", valueInteger: 1 }],
        select: [{ column: [{ name: "x", path: "id" }] }],
      }),
    ).toThrow(/Constant 'c'/);
  });

  it("throws naming the column for an unsupported FHIRPath function", () => {
    expect(() =>
      new SqlOnFhir().transpile({
        resource: "Patient",
        status: "active",
        select: [
          { column: [{ name: "bad", path: "name.resolve()" }] },
          { column: [{ name: "good", path: "id", type: "id" }] },
        ],
      }),
    ).toThrow(/'bad'.*resolve|resolve.*'bad'/);
  });

  it("throws naming the constant when referenced but not defined", () => {
    expect(() =>
      new SqlOnFhir().transpile({
        resource: "Patient",
        status: "active",
        select: [{ column: [{ name: "x", path: "%nope" }] }],
      }),
    ).toThrow(/%nope/);
  });
});
