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
 * Shared harness for database-backed loader integration tests.
 *
 * Encapsulates the connection pool lifecycle, database version probe, sample
 * NDJSON generation, and per-test table/temp-directory cleanup so the
 * individual integration test files stay focused on assertions. The native
 * JSON column type is only available on Oracle 21c+, so callers gate
 * JSON-specific cases on the major version returned by `getMajorVersion()`.
 *
 * Tests use dedicated, randomly-named tables so the preloaded
 * `fhir_resources` dataset in the shared dev schema is never touched.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import oracledb from "oracledb";

import {
  closeConnectionPool,
  createConnectionPool,
  getDatabaseConfigFromEnv,
} from "../src/loader/connection.js";
import { loadNdjsonFiles } from "../src/loader/index.js";

import type {
  DatabaseOptions,
  LoadOptions,
  LoadResult,
} from "../src/loader/types.js";

// Rows are returned as objects and BLOB columns as Buffers, so result rows
// can be asserted on directly.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsBuffer = [oracledb.BLOB];

/** A small, representative set of FHIR resources used by the integration tests. */
export const SAMPLE_PATIENTS = [
  { resourceType: "Patient", id: "p1", active: true, name: "Café Ünïcode 🩺" },
  { resourceType: "Patient", id: "p2", active: false, gender: "female" },
  { resourceType: "Patient", id: "p3", birthDate: "2000-01-01" },
];

/** The effective type of a json column read from ALL_TAB_COLUMNS. */
export interface JsonColumnType {
  /** The ALL_TAB_COLUMNS DATA_TYPE (e.g. `BLOB` or `JSON`). */
  dataType: string;
}

/** Helpers bound to a single connection pool for one integration test file. */
export interface LoaderIntegrationHarness {
  /** Open the pool. Call from beforeAll. */
  connect(): Promise<void>;
  /** Drop created tables, remove temp dirs and close the pool. Call from afterAll. */
  cleanup(): Promise<void>;
  /** The connected database's major version (e.g. 19, 21, 23). */
  getMajorVersion(): number;
  /** Generate and register a unique, valid table name. */
  makeTableName(): string;
  /** The open pool, for direct assertions. */
  pool(): oracledb.Pool;
  /**
   * Write an NDJSON fixture directory. Keys are file names, values are arrays
   * of JSON lines.
   */
  writeNdjsonDir(files: Record<string, string[]>): string;
  /** Load an arbitrary NDJSON directory into a table, returning the result. */
  loadDir(
    directory: string,
    tableName: string,
    options?: Omit<Partial<LoadOptions>, "database" | "directory">,
  ): Promise<LoadResult>;
  /** Load the sample patients into a table, returning the load result. */
  loadSample(
    tableName: string,
    options?: { resourceJsonDataType?: string; truncate?: boolean },
  ): Promise<LoadResult>;
  /** Read the effective type of a table's json column. */
  getJsonColumnType(tableName: string): Promise<JsonColumnType | undefined>;
  /** Count the rows in a table. */
  getRowCount(tableName: string): Promise<number>;
  /** Whether a table exists in the connected user's schema. */
  tableExists(tableName: string): Promise<boolean>;
  /** Drop a table if it exists, without registering it for cleanup. */
  dropTable(tableName: string): Promise<void>;
}

/**
 * Create a loader integration harness.
 * @returns A harness whose lifecycle is driven by connect()/cleanup().
 */
export function createLoaderIntegrationHarness(): LoaderIntegrationHarness {
  let pool: oracledb.Pool | null = null;
  let databaseConfig: DatabaseOptions | null = null;
  let majorVersion = 0;
  const createdTables: string[] = [];
  const createdDirs: string[] = [];

  function requirePool(): oracledb.Pool {
    if (!pool) {
      throw new Error("Harness not connected; call connect() first.");
    }
    return pool;
  }

  function requireConfig(): DatabaseOptions {
    if (!databaseConfig) {
      throw new Error("Harness not connected; call connect() first.");
    }
    return databaseConfig;
  }

  async function connect(): Promise<void> {
    databaseConfig = getDatabaseConfigFromEnv();
    pool = await createConnectionPool(databaseConfig);
    const connection = await requirePool().getConnection();
    try {
      majorVersion = Math.floor(connection.oracleServerVersion / 100_000_000);
    } finally {
      await connection.close();
    }
  }

  async function cleanup(): Promise<void> {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (pool) {
      const connection = await pool.getConnection();
      try {
        for (const tableName of createdTables) {
          try {
            await connection.execute(`DROP TABLE ${tableName} PURGE`);
          } catch {
            // Best-effort cleanup; ignore failures.
          }
        }
      } finally {
        await connection.close();
      }
      await closeConnectionPool(pool);
      pool = null;
    }
  }

  function makeTableName(): string {
    const tableName = `sof_load_${randomBytes(4).toString("hex")}`;
    createdTables.push(tableName);
    return tableName;
  }

  function writeNdjsonDir(files: Record<string, string[]>): string {
    const dir = mkdtempSync(join(tmpdir(), "sof-loader-it-"));
    createdDirs.push(dir);
    for (const [name, lines] of Object.entries(files)) {
      writeFileSync(join(dir, name), lines.join("\n") + "\n", "utf8");
    }
    return dir;
  }

  async function loadDir(
    directory: string,
    tableName: string,
    options?: Omit<Partial<LoadOptions>, "database" | "directory">,
  ): Promise<LoadResult> {
    return loadNdjsonFiles({
      directory,
      database: requireConfig(),
      tableName,
      ...options,
    });
  }

  async function loadSample(
    tableName: string,
    options?: { resourceJsonDataType?: string; truncate?: boolean },
  ): Promise<LoadResult> {
    return loadNdjsonFiles({
      directory: writeNdjsonDir({
        "Patient.ndjson": SAMPLE_PATIENTS.map((patient) =>
          JSON.stringify(patient),
        ),
      }),
      database: requireConfig(),
      tableName,
      ...options,
      quiet: true,
    });
  }

  async function getJsonColumnType(
    tableName: string,
  ): Promise<JsonColumnType | undefined> {
    const connection = await requirePool().getConnection();
    try {
      const result = await connection.execute(
        `SELECT DATA_TYPE
         FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = :tableName AND COLUMN_NAME = 'JSON'`,
        [tableName.toUpperCase()],
      );
      const row = result.rows?.[0] as { DATA_TYPE: string } | undefined;
      return row ? { dataType: row.DATA_TYPE } : undefined;
    } finally {
      await connection.close();
    }
  }

  async function getRowCount(tableName: string): Promise<number> {
    const connection = await requirePool().getConnection();
    try {
      const result = await connection.execute(
        `SELECT COUNT(*) AS n FROM ${tableName}`,
      );
      const row = result.rows?.[0] as { N: number } | undefined;
      return row?.N ?? 0;
    } finally {
      await connection.close();
    }
  }

  async function tableExists(tableName: string): Promise<boolean> {
    const connection = await requirePool().getConnection();
    try {
      const result = await connection.execute(
        `SELECT COUNT(*) AS n FROM user_tables WHERE table_name = :tableName`,
        [tableName.toUpperCase()],
      );
      const row = result.rows?.[0] as { N: number } | undefined;
      return (row?.N ?? 0) > 0;
    } finally {
      await connection.close();
    }
  }

  async function dropTable(tableName: string): Promise<void> {
    const connection = await requirePool().getConnection();
    try {
      await connection.execute(`DROP TABLE ${tableName} PURGE`);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("ORA-00942"))) {
        throw error;
      }
    } finally {
      await connection.close();
    }
  }

  return {
    connect,
    cleanup,
    getMajorVersion: () => majorVersion,
    makeTableName,
    pool: requirePool,
    writeNdjsonDir,
    loadDir,
    loadSample,
    getJsonColumnType,
    getRowCount,
    tableExists,
    dropTable,
  };
}
