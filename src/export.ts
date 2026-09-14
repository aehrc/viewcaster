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
 * CLI command for exporting FHIR resources from Oracle Database to NDJSON
 * files.
 *
 * The inverse of the `load` command: it writes one `{ResourceType}.ndjson` file
 * per distinct resource type, so an exported directory can be loaded again.
 * @author John Grimes
 */

import { Command } from "commander";

import { exportNdjsonFiles } from "./exporter/index.js";
import { getDatabaseConfigFromEnv } from "./loader/index.js";

import type { ExportOptions } from "./exporter/types.js";

/**
 * Build exporter options from command options.
 *
 * Connection details fall back to the `ORACLE_*` environment variables,
 * exactly as they do for `load`.
 * @param directory - Directory to export into.
 * @param commandOptions - Command options as parsed by commander.
 * @returns Exporter options.
 * @throws {Error} if the database configuration is incomplete.
 */
export function buildExporterOptions(
  directory: string,
  commandOptions: Record<string, unknown>,
): ExportOptions {
  return {
    directory,
    database: getDatabaseConfigFromEnv({
      host: commandOptions.host as string | undefined,
      port: commandOptions.port as number | undefined,
      serviceName: commandOptions.serviceName as string | undefined,
      user: commandOptions.user as string | undefined,
      password: commandOptions.password as string | undefined,
      connectString: commandOptions.connectString as string | undefined,
    }),
    resourceType: commandOptions.resourceType as string | undefined,
    tableName: commandOptions.tableName as string | undefined,
    schemaName: commandOptions.schemaName as string | undefined,
    overwrite: commandOptions.overwrite as boolean | undefined,
    verbose: commandOptions.verbose as boolean | undefined,
    quiet: commandOptions.quiet as boolean | undefined,
    progress: commandOptions.progress as boolean | undefined,
  };
}

/**
 * Handle the export command action.
 * @param directory - Directory to export into.
 * @param commandOptions - Command options.
 */
async function handleExportCommand(
  directory: string,
  commandOptions: Record<string, unknown>,
): Promise<void> {
  try {
    await exportNdjsonFiles(buildExporterOptions(directory, commandOptions));
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

/**
 * Create the export command.
 * @returns Commander command for exporting NDJSON files.
 */
export function createExportCommand(): Command {
  const command = new Command("export");

  command
    .description("Export FHIR resources from Oracle Database to NDJSON files")
    .argument("<directory>", "Directory to write NDJSON files into")
    .option("--host <host>", "Database host")
    .option("--port <port>", "Database listener port", Number.parseInt)
    .option("--service-name <name>", "Database service name")
    .option("--user <user>", "Database username")
    .option("--password <password>", "Database password")
    .option(
      "--connect-string <str>",
      "Full connect string; overrides host/port/service-name",
    )
    .option("--resource-type <type>", "Only export specific resource type")
    .option("--table-name <name>", "Table name (default: fhir_resources)")
    .option("--schema-name <name>", "Schema name (default: current schema)")
    .option("--overwrite", "Replace existing output files", false)
    .option("--verbose", "Enable verbose logging", false)
    .option("--quiet", "Minimal output", false)
    .option("--progress", "Show progress line", false)
    .action(handleExportCommand);

  return command;
}
