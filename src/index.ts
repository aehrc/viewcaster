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
 * SQL on FHIR runner for Oracle Database.
 * Main API for transpiling ViewDefinitions to Oracle SQL queries, and for bulk
 * loading and exporting FHIR NDJSON resources.
 * @author John Grimes
 */

export type {
  ViewDefinition,
  ViewDefinitionSelect,
  ViewDefinitionColumn,
  ViewDefinitionWhere,
  TranspilationResult,
  ColumnInfo,
  TestSuite,
  TestCase,
} from "./types.js";
export { ViewDefinitionParser } from "./parser.js";
export { QueryGenerator } from "./queryGenerator";
export type { QueryGeneratorOptions } from "./queryGenerator";
export { Transpiler } from "./fhirpath/transpiler";
export type { TranspilerContext } from "./fhirpath/transpiler";
export { loadNdjsonFiles } from "./loader/index.js";
export type {
  DatabaseOptions,
  LoadOptions,
  LoadResult,
} from "./loader/types.js";
export { exportNdjsonFiles } from "./exporter/index.js";
export type {
  ExportOptions,
  ExportResult,
  ExportedFile,
} from "./exporter/types.js";

import { ViewDefinitionParser } from "./parser.js";
import { QueryGenerator, QueryGeneratorOptions } from "./queryGenerator";

import type { TranspilationResult, ViewDefinition } from "./types.js";

/**
 * Type alias for ViewDefinition input that can be a parsed object, JSON string, or raw object.
 */
export type ViewDefinitionInput = ViewDefinition | string | object;

/**
 * Main class for SQL on FHIR operations.
 */
export class SqlOnFhir {
  private readonly queryGenerator: QueryGenerator;

  /**
   * Create a transpiler with the given source-table configuration.
   * @param options - Table/schema/column names and the JSON storage type the
   *   generated SQL targets.
   */
  constructor(options: QueryGeneratorOptions = {}) {
    this.queryGenerator = new QueryGenerator(options);
  }

  /**
   * Transpile a ViewDefinition to an Oracle SQL query.
   * @param viewDefinition - The ViewDefinition to transpile: a parsed object,
   *   a JSON string, or a FHIR resource with `resourceType:
   *   "ViewDefinition"`. Invalid input throws naming the offending element; partial SQL is never returned.
   * @param testId - Optional test-isolation identifier. When given, the
   *   generated SQL filters on a `test_id` column, used by the integration
   *   harness to run concurrently against a shared table.
   * @returns The SQL and ordered column metadata (name, Oracle type,
   *   nullability).
   * @example
   * const result = new SqlOnFhir().transpile(viewDefinition);
   * console.log(result.sql, result.columns);
   */
  transpile(
    viewDefinition: ViewDefinitionInput,
    testId?: string,
  ): TranspilationResult {
    // Always validate on intake: string and resourceType-wrapped inputs are
    // parsed, raw objects are structurally validated, so an invalid
    // ViewDefinition can never reach the SQL generator.
    const viewDef = ViewDefinitionParser.parseViewDefinition(viewDefinition);
    return this.queryGenerator.generateQuery(viewDef, testId);
  }
}
