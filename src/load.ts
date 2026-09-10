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
 * CLI command for loading NDJSON files into Oracle Database.
 * @author John Grimes
 */

import { Command } from "commander";

import { getDatabaseConfigFromEnv, loadNdjsonFiles } from "./loader/index.js";
import { normaliseResourceJsonDataType } from "./validation.js";

import type { LoadOptions } from "./loader/types.js";

/**
 * Get database configuration for dry-run mode. A dry run never opens a
 * connection, so placeholder credentials suffice.
 * @param commandOptions - Command options.
 * @returns Database configuration with dummy credential values.
 */
function getDryRunDatabaseConfig(commandOptions: Record<string, unknown>): {
  host: string;
  port: number | undefined;
  serviceName: string;
  user: string;
  password: string;
  connectString: string | undefined;
} {
  return {
    host: (commandOptions.host as string | undefined) ?? "localhost",
    port: (commandOptions.port as number | undefined) ?? 1521,
    serviceName:
      (commandOptions.serviceName as string | undefined) ?? "FREEPDB1",
    user: (commandOptions.user as string | undefined) ?? "dry-run",
    password: (commandOptions.password as string | undefined) ?? "dry-run",
    connectString: commandOptions.connectString as string | undefined,
  };
}

/**
 * Resolve the requested resource JSON data type from the command options and
 * its environment fallback (contracts/cli.md:
 * `ORACLE_RESOURCE_JSON_DATA_TYPE`), rejecting invalid values before any
 * database connection is opened.
 * @param commandOptions - Command options.
 * @returns The normalised storage type, or undefined for the loader default.
 */
function resolveResourceJsonDataType(
  commandOptions: Record<string, unknown>,
): "BLOB" | "JSON" | undefined {
  const value =
    (commandOptions.resourceJsonDataType as string | undefined) ??
    process.env.ORACLE_RESOURCE_JSON_DATA_TYPE;
  if (value === undefined) {
    return undefined;
  }
  return normaliseResourceJsonDataType(value);
}

/**
 * Build loader options from command options.
 * @param directory - Directory to load from.
 * @param commandOptions - Command options.
 * @returns Loader options.
 */
export function buildLoaderOptions(
  directory: string,
  commandOptions: Record<string, unknown>,
): LoadOptions {
  // An invalid resource JSON data type is rejected here, before the database
  // configuration (and therefore any connection) is assembled.
  const resourceJsonDataType = resolveResourceJsonDataType(commandOptions);

  const database = commandOptions.dryRun
    ? getDryRunDatabaseConfig(commandOptions)
    : getDatabaseConfigFromEnv({
        host: commandOptions.host as string | undefined,
        port: commandOptions.port as number | undefined,
        serviceName: commandOptions.serviceName as string | undefined,
        user: commandOptions.user as string | undefined,
        password: commandOptions.password as string | undefined,
        connectString: commandOptions.connectString as string | undefined,
      });

  return {
    directory,
    database,
    resourceType: commandOptions.resourceType as string | undefined,
    tableName: commandOptions.tableName as string | undefined,
    schemaName: commandOptions.schemaName as string | undefined,
    resourceJsonDataType,
    createTable: commandOptions.createTable as boolean | undefined,
    truncate: commandOptions.truncate as boolean | undefined,
    batchSize: commandOptions.batchSize as number | undefined,
    parallel: commandOptions.parallel as number | undefined,
    continueOnError: commandOptions.continueOnError as boolean | undefined,
    dryRun: commandOptions.dryRun as boolean | undefined,
    verbose: commandOptions.verbose as boolean | undefined,
    quiet: commandOptions.quiet as boolean | undefined,
    progress: commandOptions.progress as boolean | undefined,
  };
}

/**
 * Handle the load command action.
 * @param directory - Directory to load from.
 * @param commandOptions - Command options.
 */

async function handleLoadCommand(
  directory: string,
  commandOptions: Record<string, unknown>,
): Promise<void> {
  try {
    const options = buildLoaderOptions(directory, commandOptions);
    const result = await loadNdjsonFiles(options);

    // Non-zero exit when any file failed, even with --continue-on-error
    // (contracts/cli.md).
    if (result.failed) {
      process.exit(1);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

/**
 * Create the load command.
 * @returns Commander command for loading NDJSON files.
 */
export function createLoadCommand(): Command {
  const command = new Command("load");

  command
    .description("Load NDJSON files into Oracle Database")
    .argument("<directory>", "Directory containing NDJSON files")
    .option("--host <host>", "Database host")
    .option("--port <port>", "Database listener port", Number.parseInt)
    .option("--service-name <name>", "Database service name")
    .option("--user <user>", "Database username")
    .option("--password <password>", "Database password")
    .option(
      "--connect-string <str>",
      "Full connect string; overrides host/port/service-name",
    )
    .option("--resource-type <type>", "Only load specific resource type")
    .option("--table-name <name>", "Table name (default: fhir_resources)")
    .option("--schema-name <name>", "Schema name (default: current schema)")
    .option(
      "--resource-json-data-type <type>",
      "Storage type for the json column: BLOB (default, 19c+) or JSON (21c+)",
    )
    .option("--no-create-table", "Do not create the table if it doesn't exist")
    .option("--truncate", "Truncate table before loading", false)
    .option(
      "--batch-size <size>",
      "Rows per executeMany batch",
      Number.parseInt,
      1000,
    )
    .option(
      "--parallel <count>",
      "Number of files to process in parallel",
      Number.parseInt,
      4,
    )
    .option(
      "--continue-on-error",
      "Continue loading other files if one fails",
      false,
    )
    .option("--dry-run", "Report what would be loaded without loading", false)
    .option("--verbose", "Enable verbose logging", false)
    .option("--quiet", "Minimal output", false)
    .option("--progress", "Show progress line", false)
    .action(handleLoadCommand);

  return command;
}
