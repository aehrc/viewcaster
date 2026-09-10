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
 * Database connection management for NDJSON loader.
 *
 * @author John Grimes
 */

import oracledb from "oracledb";
import type { DatabaseOptions } from "./types.js";

/**
 * The defaults applied to connection attributes when neither flags nor
 * environment variables supply them (contracts/cli.md, research R13).
 */
const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 1521;
const DEFAULT_SERVICE_NAME = "FREEPDB1";

/**
 * Build the connect string for the Oracle driver: an explicit connect string
 * wins; otherwise an EZConnect string is assembled from host, port and
 * service name (research R13).
 *
 * @param config - Database connection configuration.
 * @returns The connect string for `oracledb`.
 */
export function buildConnectString(
  config: Pick<
    DatabaseOptions,
    "host" | "port" | "serviceName" | "connectString"
  >,
): string {
  if (config.connectString) {
    return config.connectString;
  }
  const host = config.host ?? DEFAULT_HOST;
  const port = config.port ?? DEFAULT_PORT;
  const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
  return `${host}:${port}/${serviceName}`;
}

/**
 * Create a connection pool to the Oracle database. Thin mode (research R2):
 * pure JavaScript, no Instant Client required.
 *
 * @param config - Database connection configuration.
 * @returns Promise that resolves to the connection pool.
 */
export async function createConnectionPool(
  config: DatabaseOptions,
): Promise<oracledb.Pool> {
  return oracledb.createPool({
    user: config.user,
    password: config.password,
    connectString: buildConnectString(config),
    poolMin: 0,
    poolMax: 10,
  });
}

/**
 * Close a connection pool safely.
 *
 * @param pool - The connection pool to close.
 */
export async function closeConnectionPool(
  pool: oracledb.Pool,
): Promise<void> {
  try {
    await pool.close(0);
  } catch {
    // Silently ignore errors when closing - we're likely cleaning up anyway.
  }
}

/**
 * Test database connection.
 *
 * @param pool - The connection pool to test.
 * @returns Promise that resolves to true if connection is successful.
 */
export async function testConnection(pool: oracledb.Pool): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    const result = await connection.execute("SELECT 1 AS test FROM DUAL");
    return (result.rows?.length ?? 0) === 1;
  } finally {
    await connection.close();
  }
}

/**
 * Get database connection configuration from environment variables, with
 * `ORACLE_*` fallbacks (research R13). Falls back to provided defaults or
 * throws if required credentials are missing.
 *
 * @param overrides - Optional configuration overrides.
 * @returns Database configuration.
 */
// eslint-disable-next-line complexity -- Configuration parsing is inherently complex
export function getDatabaseConfigFromEnv(
  overrides?: Partial<DatabaseOptions>,
): DatabaseOptions {
  const user = overrides?.user ?? process.env.ORACLE_USER;
  const password = overrides?.password ?? process.env.ORACLE_PASSWORD;

  if (!user || !password) {
    throw new Error(
      "Missing required database configuration. " +
        "Provide via --user and --password flags " +
        "or ORACLE_USER and ORACLE_PASSWORD environment variables.",
    );
  }

  const host = overrides?.host ?? process.env.ORACLE_HOST ?? DEFAULT_HOST;
  const port =
    overrides?.port ??
    (process.env.ORACLE_PORT
      ? Number.parseInt(process.env.ORACLE_PORT, 10)
      : DEFAULT_PORT);
  const serviceName =
    overrides?.serviceName ??
    process.env.ORACLE_SERVICE_NAME ??
    DEFAULT_SERVICE_NAME;
  const connectString =
    overrides?.connectString ?? process.env.ORACLE_CONNECT_STRING;

  return {
    host,
    port,
    serviceName,
    user,
    password,
    ...(connectString !== undefined && { connectString }),
  };
}
