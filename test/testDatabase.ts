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
 * Shared live-database helper for integration tests.
 *
 * Connects to Oracle with the oracledb driver in Thin mode using the
 * `ORACLE_*` environment variables, and provides table lifecycle and raw insert
 * utilities for a dedicated test table. The test table name is deliberately
 * distinct from the loader's default `fhir_resources` so that a preloaded
 * dataset on a shared development instance is never touched.
 */

import { LosslessNumber, stringify as losslessStringify } from "lossless-json";
import oracledb from "oracledb";

/**
 * The storage variant of the JSON column (data-model.md).
 */
export type StorageType = "BLOB" | "JSON";

/**
 * Name of the table used by integration tests. Never `fhir_resources`.
 */
export const TEST_TABLE_NAME = "sof_test_resources";

/**
 * Connection attributes derived from the environment.
 */
export interface TestDatabaseConfig {
  user: string;
  password: string;
  connectString: string;
}

/**
 * Reports whether the environment carries enough `ORACLE_*` variables to reach
 * a database. Used by integration tests to skip cleanly when no database is
 * configured.
 * @returns True when a user, password and either a connect string or host are
 *   present.
 */
export function hasOracleEnvironment(): boolean {
  const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING, ORACLE_HOST } =
    process.env;
  return Boolean(
    ORACLE_USER && ORACLE_PASSWORD && (ORACLE_CONNECT_STRING ?? ORACLE_HOST),
  );
}

/**
 * Builds the connection configuration from `ORACLE_*` environment variables.
 *
 * `ORACLE_CONNECT_STRING` overrides the EZConnect string assembled from
 * `ORACLE_HOST` (default `localhost`), `ORACLE_PORT` (default `1521`) and
 * `ORACLE_SERVICE_NAME` (default `FREEPDB1`), per research R13.
 * @returns The connection attributes.
 * @throws {Error} When `ORACLE_USER` or `ORACLE_PASSWORD` is missing.
 */
export function getTestDatabaseConfig(): TestDatabaseConfig {
  const user = process.env.ORACLE_USER;
  const password = process.env.ORACLE_PASSWORD;
  if (!user || !password) {
    throw new Error(
      "ORACLE_USER and ORACLE_PASSWORD must be set to run integration tests",
    );
  }
  const host = process.env.ORACLE_HOST ?? "localhost";
  const port = process.env.ORACLE_PORT ?? "1521";
  const serviceName = process.env.ORACLE_SERVICE_NAME ?? "FREEPDB1";
  const connectString =
    process.env.ORACLE_CONNECT_STRING ?? `${host}:${port}/${serviceName}`;
  return { user, password, connectString };
}

/**
 * Opens a standalone Thin-mode connection to the test database.
 *
 * Also applies driver-wide fetch defaults suited to tests: rows are returned
 * as objects, BLOB columns as Buffers and CLOB columns as strings, so that
 * result rows can be asserted on directly.
 * @returns An open connection; the caller must close it.
 */
export async function openTestConnection(): Promise<oracledb.Connection> {
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
  oracledb.fetchAsBuffer = [oracledb.BLOB];
  oracledb.fetchAsString = [oracledb.CLOB];
  return oracledb.getConnection(getTestDatabaseConfig());
}

/**
 * Returns the major version of the connected database (e.g. 19, 21, 23).
 * @param connection - An open connection.
 * @returns The major version number.
 */
export function getMajorVersion(connection: oracledb.Connection): number {
  // oracleServerVersion encodes the version as e.g. 1900000000 or 2300000000.
  return Math.floor(connection.oracleServerVersion / 100_000_000);
}

/**
 * Creates the resources table in the requested storage variant, with the
 * resource type index, using the DDL from data-model.md. Fails if the table
 * already exists; call {@link dropTestTable} first for a clean slate.
 * @param connection - An open connection.
 * @param storageType - JSON column storage variant.
 * @param tableName - Table name; defaults to {@link TEST_TABLE_NAME}.
 */
export async function createTestTable(
  connection: oracledb.Connection,
  storageType: StorageType,
  tableName: string = TEST_TABLE_NAME,
): Promise<void> {
  const jsonColumn =
    storageType === "JSON"
      ? "json          JSON NOT NULL"
      : "json          BLOB NOT NULL CHECK (json IS JSON)";
  await connection.execute(
    `CREATE TABLE ${tableName} (
  id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_type VARCHAR2(64) NOT NULL,
  test_id       VARCHAR2(255) NOT NULL,
  ${jsonColumn}
)`,
  );
  await connection.execute(
    `CREATE INDEX ix_${tableName}_resource_type ON ${tableName} (resource_type)`,
  );
}

/**
 * Drops the test table if it exists. A missing table is not an error.
 * @param connection - An open connection.
 * @param tableName - Table name; defaults to {@link TEST_TABLE_NAME}.
 */
export async function dropTestTable(
  connection: oracledb.Connection,
  tableName: string = TEST_TABLE_NAME,
): Promise<void> {
  try {
    await connection.execute(`DROP TABLE ${tableName} PURGE`);
  } catch (error) {
    // ORA-00942: table or view does not exist.
    if (!(error instanceof Error && error.message.startsWith("ORA-00942"))) {
      throw error;
    }
  }
}
/**
 * Converts a lossless-json parsed object into plain JSON for a `DB_TYPE_JSON`
 * bind. `LosslessNumber` instances would otherwise be serialised as nested
 * objects (`{"value":"1.2","isLosslessNumber":true}`), corrupting every
 * numeric field in the stored resource.
 * @param value - Arbitrary parsed JSON value.
 * @returns A structurally equal object with plain numbers.
 */
function toPlainJson(value: unknown): unknown {
  if (value instanceof LosslessNumber) return Number(value.value);
  if (Array.isArray(value)) return value.map((entry) => toPlainJson(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toPlainJson(entry),
      ]),
    );
  }
  return value;
}

/**
 * Inserts FHIR resources into the test table with a single batched statement
 * and commits.
 *
 * For `BLOB` storage the resource is serialised with lossless-json (so decimal
 * lexemes such as `1.0` survive if the resource was parsed losslessly) and
 * bound as a UTF-8 Buffer. For native `JSON` storage the resource object is
 * bound directly as `DB_TYPE_JSON`, letting the driver encode it in Oracle's
 * binary JSON format.
 * @param connection - An open connection.
 * @param resources - FHIR resources; each must carry `resourceType`.
 * @param storageType - JSON column storage variant of the target table.
 * @param tableName - Table name; defaults to {@link TEST_TABLE_NAME}.
 * @returns The number of rows inserted.
 */
export async function insertTestResources(
  connection: oracledb.Connection,
  resources: ReadonlyArray<{ resourceType: string }>,
  storageType: StorageType,
  tableName: string = TEST_TABLE_NAME,
): Promise<number> {
  if (resources.length === 0) {
    return 0;
  }
  const rows =
    storageType === "JSON"
      ? resources.map((resource) => [
          resource.resourceType,
          { type: oracledb.DB_TYPE_JSON, val: toPlainJson(resource) },
        ])
      : resources.map((resource) => [
          resource.resourceType,
          Buffer.from(losslessStringify(resource) ?? "null", "utf8"),
        ]);
  const result = await connection.executeMany(
    `INSERT INTO ${tableName} (resource_type, json) VALUES (:1, :2)`,
    rows,
    {
      autoCommit: true,
      bindDefs: [
        { type: oracledb.DB_TYPE_VARCHAR, maxSize: 64 },
        {
          type:
            storageType === "JSON"
              ? oracledb.DB_TYPE_JSON
              : oracledb.DB_TYPE_BLOB,
        },
      ],
    },
  );
  return result.rowsAffected ?? 0;
}

/**
 * Inserts one FHIR resource into the test table and returns the generated
 * surrogate id, so integration tests can clean up exactly the rows they
 * inserted.
 *
 * For `BLOB` storage the resource is serialised with lossless-json and bound
 * as a UTF-8 Buffer; for native `JSON` storage it is bound directly as
 * `DB_TYPE_JSON`.
 * @param connection - An open connection.
 * @param resource - The FHIR resource; must carry `resourceType`.
 * @param resource.resourceType
 * @param testId - Test-isolation identifier stored with the row.
 * @param storageType - JSON column storage variant of the target table.
 * @param tableName - Table name; defaults to {@link TEST_TABLE_NAME}.
 * @returns The generated id.
 */
export async function insertTestResourceReturningId(
  connection: oracledb.Connection,
  resource: { resourceType: string },
  testId: string,
  storageType: StorageType,
  tableName: string = TEST_TABLE_NAME,
): Promise<number> {
  // Native JSON storage needs a typed bind: a raw JS object passed as a
  // positional value fails with NJS-044 ("bind object must contain ... val").
  const json =
    storageType === "JSON"
      ? { type: oracledb.DB_TYPE_JSON, val: toPlainJson(resource) }
      : Buffer.from(losslessStringify(resource) ?? "null", "utf8");
  const result = await connection.execute(
    `INSERT INTO ${tableName} (resource_type, test_id, json) VALUES (:1, :2, :3) RETURNING id INTO :4`,
    [
      resource.resourceType,
      testId,
      json,
      { type: oracledb.DB_TYPE_NUMBER, dir: oracledb.BIND_OUT },
    ],
    { autoCommit: true },
  );
  const outBinds = result.outBinds as unknown[][] | undefined;
  const generatedId = outBinds?.[0]?.[0];
  if (generatedId === undefined || generatedId === null) {
    throw new Error("INSERT RETURNING id produced no id");
  }
  return Number(generatedId);
}
