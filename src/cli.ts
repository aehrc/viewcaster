#!/usr/bin/env node

/**
 * CLI for SQL on FHIR tooling.
 * Supports transpiling ViewDefinitions to Oracle SQL.
 * @author John Grimes
 */

import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";

import { SqlOnFhir } from "./index.js";
import { createLoadCommand } from "./load.js";
import { normaliseResourceJsonDataType } from "./validation.js";

/**
 * Read input from stdin or file.
 * @param inputFile - Optional path to read from; stdin when absent.
 * @returns The input text.
 */
async function readInput(inputFile?: string): Promise<string> {
  if (inputFile) {
    return readFileSync(inputFile, "utf8");
  }

  // Read from stdin.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Write output to stdout or file.
 * @param sql - The SQL to write.
 * @param outputFile - Optional path to write to; stdout when absent.
 */
function writeOutput(sql: string, outputFile?: string): void {
  if (outputFile) {
    writeFileSync(outputFile, sql, "utf8");
  } else {
    process.stdout.write(sql);
  }
}

/**
 * Create the transpile command.
 * @returns The configured commander command.
 */
function createTranspileCommand(): Command {
  const command = new Command("transpile");

  command
    .description("Transpile SQL on FHIR ViewDefinitions to Oracle SQL queries")
    .option(
      "-i, --input <file>",
      "Input ViewDefinition JSON file (default: stdin)",
    )
    .option("-o, --output <file>", "Output SQL file (default: stdout)")
    .option(
      "--resource-json-data-type <type>",
      "JSON storage type the SQL targets: BLOB (default, 19c+) or JSON (21c+)",
    )
    .option("--table-name <name>", "Source table name")
    .option("--schema-name <name>", "Source schema name")
    .option("--resource-id-column <name>", "Surrogate id column name")
    .option("--resource-json-column <name>", "JSON column name")
    .action(
      async (options: {
        input?: string;
        output?: string;
        resourceJsonDataType?: string;
        tableName?: string;
        schemaName?: string;
        resourceIdColumn?: string;
        resourceJsonColumn?: string;
      }) => {
        try {
          // Read ViewDefinition from stdin or file.
          const input = await readInput(options.input);

          // Parse and validate JSON.
          const viewDefinition: unknown = JSON.parse(input);

          // Validate the storage type before anything else, so an invalid
          // value never reaches the database-facing layers.
          const resourceJsonDataType = options.resourceJsonDataType
            ? normaliseResourceJsonDataType(options.resourceJsonDataType)
            : undefined;

          // Transpile to SQL.
          const sqlOnFhir = new SqlOnFhir({
            ...(options.tableName !== undefined && {
              tableName: options.tableName,
            }),
            ...(options.schemaName !== undefined && {
              schemaName: options.schemaName,
            }),
            ...(options.resourceIdColumn !== undefined && {
              resourceIdColumn: options.resourceIdColumn,
            }),
            ...(options.resourceJsonColumn !== undefined && {
              resourceJsonColumn: options.resourceJsonColumn,
            }),
            ...(resourceJsonDataType !== undefined && {
              resourceJsonDataType,
            }),
          });
          const result = sqlOnFhir.transpile(viewDefinition as object);

          // Write SQL to stdout or file. The SQL is exactly one SELECT
          // statement; nothing is written on failure (the write happens after
          // a successful transpile).
          writeOutput(result.sql, options.output);
        } catch (error) {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(1);
        }
      },
    );

  return command;
}

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name("sof-oracle")
    .description("SQL on FHIR tooling for Oracle Database")
    .version("0.1.0");

  // Add subcommands.
  program.addCommand(createTranspileCommand());
  program.addCommand(createLoadCommand());
  // Parse arguments.
  await program.parseAsync(process.argv);

  // If no command specified, show help.
  if (process.argv.length <= 2) {
    program.help();
  }
}

void main();
