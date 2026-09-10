/**
 * SQL on FHIR runner for Oracle Database.
 * Main API for transpiling ViewDefinitions to Oracle SQL queries.
 *
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

  constructor(options: QueryGeneratorOptions = {}) {
    this.queryGenerator = new QueryGenerator(options);
  }

  /**
   * Transpile a ViewDefinition to an Oracle SQL query.
   *
   * @param viewDefinition - The ViewDefinition to transpile: a parsed object,
   *   a JSON string, or a FHIR resource with `resourceType:
   *   "ViewDefinition"`. Invalid input throws naming the offending element
   *   (FR-004); partial SQL is never returned.
   * @param testId - Optional test-isolation identifier. When given, the
   *   generated SQL filters on a `test_id` column, used by the integration
   *   harness to run concurrently against a shared table.
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
