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
 * Unit tests for pure table DDL generation, existing-column-type resolution,
 * storage-type mismatch warnings and the native-JSON version gate
 * (FR-011/FR-014, data-model.md lifecycle rules).
 *
 * These exercise the string-building and comparison logic without a database,
 * so the DDL contract, the storage variants and the fail-fast decisions can be
 * verified in isolation.
 */

import oracledb from "oracledb";
import { describe, expect, it } from "vitest";

import {
  assertNativeJsonSupported,
  buildCreateTableStatements,
  buildJsonTypeMismatchWarning,
  resolveColumnJsonDataType,
  getExistingJsonColumnType,
  tableExists,
} from "./tables";

describe("buildCreateTableStatements", () => {
  describe("default BLOB json column (19c+)", () => {
    const statements = buildCreateTableStatements(
      undefined,
      "fhir_resources",
      "BLOB",
    );

    it("types the json column as BLOB NOT NULL with the IS JSON check", () => {
      expect(statements.createTable).toContain(
        "json          BLOB NOT NULL CHECK (json IS JSON)",
      );
    });

    it("creates the surrogate id as an identity column", () => {
      expect(statements.createTable).toContain(
        "id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
      );
    });

    it("keeps the resource_type column unchanged", () => {
      expect(statements.createTable).toContain(
        "resource_type VARCHAR2(64) NOT NULL",
      );
    });

    it("leaves the table unqualified when no schema is given", () => {
      expect(statements.createTable).toContain("CREATE TABLE fhir_resources");
      expect(statements.createTable).not.toContain(".");
    });

    it("builds the resource_type index", () => {
      expect(statements.createIndex).toContain(
        "ix_fhir_resources_resource_type",
      );
      expect(statements.createIndex).toContain(
        "ON fhir_resources (resource_type)",
      );
    });
  });

  describe("native JSON json column (21c+)", () => {
    const statements = buildCreateTableStatements(
      undefined,
      "fhir_resources",
      "JSON",
    );

    it("types the json column as native JSON NOT NULL", () => {
      expect(statements.createTable).toContain("json          JSON NOT NULL");
    });

    it("does not emit a BLOB or check constraint for the json column", () => {
      expect(statements.createTable).not.toContain("BLOB");
      expect(statements.createTable).not.toContain("CHECK");
    });

    it("keeps the resource_type column unchanged", () => {
      expect(statements.createTable).toContain(
        "resource_type VARCHAR2(64) NOT NULL",
      );
    });

    it("leaves the index statement identical to the default", () => {
      const defaultStatements = buildCreateTableStatements(
        undefined,
        "fhir_resources",
        "BLOB",
      );
      expect(statements.createIndex).toBe(defaultStatements.createIndex);
    });
  });

  describe("schema qualification", () => {
    it("qualifies the table with the schema when given", () => {
      const statements = buildCreateTableStatements(
        "fhir",
        "resources",
        "JSON",
      );
      expect(statements.createTable).toContain("CREATE TABLE fhir.resources");
      expect(statements.createIndex).toContain("ix_resources_resource_type");
      expect(statements.createIndex).toContain(
        "ON fhir.resources (resource_type)",
      );
    });
  });
});

describe("resolveColumnJsonDataType", () => {
  it("resolves a BLOB column to the BLOB storage type", () => {
    // The IS JSON check constraint is not visible in ALL_TAB_COLUMNS; the
    // column data type alone identifies the BLOB variant.
    expect(resolveColumnJsonDataType("BLOB", 0)).toBe("BLOB");
  });

  it("resolves the native JSON type to JSON", () => {
    expect(resolveColumnJsonDataType("JSON", 0)).toBe("JSON");
  });

  it("is case-insensitive on the data type name", () => {
    expect(resolveColumnJsonDataType("blob", 0)).toBe("BLOB");
    expect(resolveColumnJsonDataType("json", 0)).toBe("JSON");
  });

  it("tolerates surrounding whitespace on the data type name", () => {
    expect(resolveColumnJsonDataType("  BLOB  ", 0)).toBe("BLOB");
    expect(resolveColumnJsonDataType(" JSON ", 0)).toBe("JSON");
  });

  // An existing column that is neither the BLOB variant nor the native JSON
  // type cannot faithfully hold a serialised FHIR resource. Such a column must
  // be rejected at the boundary, naming the offending type, rather than
  // silently coerced - coercion would let the loader write into a column that
  // cannot hold the data (data-model.md lifecycle table).
  describe("rejects column types that cannot hold a FHIR resource", () => {
    it("throws for CLOB, naming the offending type", () => {
      expect(() => resolveColumnJsonDataType("CLOB", 0)).toThrow(/CLOB/);
    });

    it("throws for a bounded VARCHAR2, naming the offending type", () => {
      expect(() => resolveColumnJsonDataType("VARCHAR2", 255)).toThrow(
        /VARCHAR2\(255\)/,
      );
    });
    it("throws for NCLOB, naming the offending type", () => {
      expect(() => resolveColumnJsonDataType("NCLOB", 0)).toThrow(/NCLOB/);
    });

    it("names both acceptable types in the error message", () => {
      let message = "";
      try {
        resolveColumnJsonDataType("CLOB", 0);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("BLOB");
      expect(message).toContain("JSON");
    });
  });
});

describe("buildJsonTypeMismatchWarning", () => {
  it("returns null when the existing and requested types are equal", () => {
    expect(
      buildJsonTypeMismatchWarning(undefined, "t", "BLOB", "BLOB"),
    ).toBeNull();
    expect(
      buildJsonTypeMismatchWarning("fhir", "t", "JSON", "JSON"),
    ).toBeNull();
  });

  it("returns a warning naming both types and the table when they differ", () => {
    const warning = buildJsonTypeMismatchWarning(
      undefined,
      "fhir_resources",
      "BLOB",
      "JSON",
    );
    expect(warning).not.toBeNull();
    expect(warning).toContain("BLOB");
    expect(warning).toContain("JSON");
    expect(warning).toContain("fhir_resources");
  });

  it("names both the existing and the requested type in either direction", () => {
    const warning = buildJsonTypeMismatchWarning("fhir", "t", "JSON", "BLOB");
    expect(warning).toMatch(/JSON/);
    expect(warning).toMatch(/BLOB/);
  });
});

describe("assertNativeJsonSupported", () => {
  it("accepts a 21c server version", () => {
    expect(() => assertNativeJsonSupported(2_100_000_000)).not.toThrow();
  });

  it("accepts a 23ai server version", () => {
    expect(() => assertNativeJsonSupported(2_300_000_000)).not.toThrow();
  });

  it("fails fast on 19c, naming the required version and the server version", () => {
    let message = "";
    try {
      assertNativeJsonSupported(1_930_000_000);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("21c");
    expect(message).toContain("19");
  });

  it("fails fast on any pre-21c version", () => {
    expect(() => assertNativeJsonSupported(1_800_000_000)).toThrow(/21c/);
    expect(() => assertNativeJsonSupported(1_202_000_000)).toThrow(/21c/);
  });
});

describe("tableExists and getExistingJsonColumnType", () => {
  /**
   * Builds a fake pool whose connection records every execute options object,
   * so the row-shape contract (explicit OUT_FORMAT_OBJECT) can be pinned
   * without a database. The default oracledb thin mode returns rows as
   * arrays, which would silently break the object-shaped reads.
   * @param rows - Rows the fake connection returns.
   * @returns The pool stub and the captured options.
   */
  function fakePool(rows: unknown[]): {
    pool: { getConnection: () => Promise<unknown> };
    capturedOptions: unknown[];
  } {
    const capturedOptions: unknown[] = [];
    const connection = {
      execute: async (
        _sql: string,
        _binds?: unknown,
        options?: unknown,
      ) => {
        capturedOptions.push(options);
        return { rows };
      },
      close: async () => undefined,
    };
    return {
      pool: { getConnection: async () => connection } as never,
      capturedOptions,
    };
  }

  it("tableExists reads rows as objects even without a global outFormat", async () => {
    const { pool, capturedOptions } = fakePool([{ N: 1 }]);
    await expect(tableExists(pool as never, undefined, "T")).resolves.toBe(true);
    expect(capturedOptions).toEqual([{ outFormat: oracledb.OUT_FORMAT_OBJECT }]);
  });

  it("tableExists reports absent tables through the same row shape", async () => {
    const { pool } = fakePool([{ N: 0 }]);
    await expect(tableExists(pool as never, undefined, "nope")).resolves.toBe(
      false,
    );
  });

  it("getExistingJsonColumnType reads column rows as objects", async () => {
    const { pool, capturedOptions } = fakePool([
      { DATA_TYPE: "BLOB", CHAR_LENGTH: 0 },
    ]);
    await expect(
      getExistingJsonColumnType(pool as never, undefined, "fhir_resources"),
    ).resolves.toBe("BLOB");
    expect(capturedOptions).toEqual([{ outFormat: oracledb.OUT_FORMAT_OBJECT }]);
  });
});
