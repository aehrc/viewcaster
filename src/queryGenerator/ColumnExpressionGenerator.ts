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
 * Generates SQL expressions for ViewDefinition columns.
 *
 * The default type mapping treats text as the preservation medium (research
 * R9): boolean becomes a CASE over the 'true'/'false' text yielding
 * NUMBER(1), and numeric/temporal FHIR types are CAST to their Oracle
 * equivalents from the extracted text.
 */

import { Transpiler, TranspilerContext } from "../fhirpath/transpiler.js";
import { formatJsonSuffix } from "../fhirpath/visitor.js";

import type { ViewDefinitionColumn } from "../types.js";

/**
 * Handles generation of column expressions with type casting.
 */
export class ColumnExpressionGenerator {
  /**
   * Generate SQL expression for a column.
   * @param column - The ViewDefinition column descriptor.
   * @param context - The transpiler context (aliases, storage type).
   * @returns The SQL expression for the column.
   * @throws When the column's FHIRPath cannot be transpiled; the message
   *   names the column and path (FR-004).
   */
  generateExpression(
    column: ViewDefinitionColumn,
    context: TranspilerContext,
  ): string {
    try {
      let expression: string;

      // Handle collection property.
      expression =
        column.collection === true
          ? this.generateCollectionExpression(column.path, context)
          : Transpiler.transpile(column.path, context);

      // Handle type casting if specified.
      if (column.type && column.collection !== true) {
        expression = this.applyTypeCasting(expression, column);
      }

      return expression;
    } catch (error) {
      throw new Error(
        `Failed to transpile column '${column.name}' with path '${column.path}': ${error}`,
      );
    }
  }

  /**
   * Apply type casting to an expression.
   *
   * Type precedence (FR-006): oracle/type > ansi/type > FHIR type defaults.
   * Casting applies only to text-extracted values; expressions already
   * yielding SQL-native values (e.g. `%rowIndex` arithmetic) stand.
   * @param expression - The SQL expression yielding the raw value.
   * @param column - The ViewDefinition column descriptor carrying the type
   *   and tags.
   * @returns The expression cast to the mapped Oracle type.
   */
  private applyTypeCasting(
    expression: string,
    column: ViewDefinitionColumn,
  ): string {
    const sqlType = Transpiler.inferSqlType(column.type, column.tag);

    // Special handling for boolean type: compare the extracted text.
    if (sqlType === "NUMBER(1)") {
      return this.generateBooleanCaseExpression(expression);
    }

    // VARCHAR2(4000) is the default text mapping; re-casting would add noise
    // without changing semantics, so the expression stands.
    if (sqlType === "VARCHAR2(4000)") {
      return expression;
    }

    // Expressions already yielding SQL-native values need no text cast.
    if (!expression.includes("JSON_VALUE")) {
      return expression;
    }

    return `CAST(${expression} AS ${sqlType})`;
  }

  /**
   * Generate a CASE expression for boolean conversion.
   * Handles both simple JSON_VALUE fields and boolean expressions.
   * @param expression - The SQL expression yielding 'true'/'false' or a
   *   boolean predicate.
   * @returns A CASE expression yielding 1/0/NULL.
   */
  private generateBooleanCaseExpression(expression: string): string {
    const hasComparisonOperator =
      expression.includes("=") ||
      expression.includes("<") ||
      expression.includes(">") ||
      expression.includes("NOT") ||
      expression.includes(" OR ") ||
      expression.includes(" AND ") ||
      expression.includes("JSON_EXISTS");

    if (expression.includes("JSON_VALUE") && !hasComparisonOperator) {
      // Simple JSON_VALUE - compare to 'true'/'false' strings.
      return `CASE WHEN ${expression} = 'true' THEN 1 WHEN ${expression} = 'false' THEN 0 ELSE NULL END`;
    }

    // Boolean expression - use as-is in CASE.
    return `CASE WHEN ${expression} THEN 1 WHEN NOT ${expression} THEN 0 ELSE NULL END`;
  }

  /**
   * Generate collection expression that returns an array.
   * @param path - The FHIRPath of the collection.
   * @param context - The transpiler context.
   * @returns A SQL expression yielding the JSON array text.
   */
  private generateCollectionExpression(
    path: string,
    context: TranspilerContext,
  ): string {
    if (context.iterationContext) {
      return `JSON_QUERY(${context.iterationContext}, '$.${path}')`;
    }

    return this.buildCollectionJsonPath(path, context);
  }

  /**
   * Build a JSON path expression for collection=true.
   *
   * `name.family` and `name.given` aggregate across all `name` elements into
   * one array (reference behaviour); other paths yield the whole collection
   * node via JSON_QUERY.
   * @param path - The FHIRPath of the collection.
   * @param context - The transpiler context.
   * @returns A SQL expression yielding the JSON array text.
   */
  private buildCollectionJsonPath(
    path: string,
    context: TranspilerContext,
  ): string {
    const pathParts = path.split(".");

    if (
      pathParts.length === 2 &&
      pathParts[0] === "name" &&
      pathParts[1] === "family"
    ) {
      return this.buildNameFamilyCollectionQuery(context);
    }

    if (
      pathParts.length === 2 &&
      pathParts[0] === "name" &&
      pathParts[1] === "given"
    ) {
      return this.buildNameGivenCollectionQuery(context);
    }

    const jsonColumn = context.resourceJsonColumn ?? "json";
    return `JSON_QUERY(${context.resourceAlias}.${jsonColumn}, '$.${path}')`;
  }

  /**
   * Build a collection query for the name.family path: an array of every
   * Patient name's family across all name elements. An empty collection yields
   * `[]` (JSON_ARRAYAGG yields NULL over an empty set).
   * @param context - The transpiler context.
   * @returns The SQL expression.
   */
  private buildNameFamilyCollectionQuery(context: TranspilerContext): string {
    const storage = context.resourceJsonDataType ?? "BLOB";
    const fmt = formatJsonSuffix(storage);
    const jsonColumn = context.resourceJsonColumn ?? "json";
    return `(SELECT CASE WHEN COUNT(scalar) = 0 THEN JSON_QUERY('[]' FORMAT JSON, '$') ELSE JSON_ARRAYAGG(scalar ORDER BY idx) END
      FROM JSON_TABLE(${context.resourceAlias}.${jsonColumn}${fmt}, '$.name[*]' COLUMNS (idx FOR ORDINALITY, scalar VARCHAR2(4000) PATH '$.family')))`;
  }

  /**
   * Build a collection query for the name.given path: an array of every given
   * across all name elements (nested JSON_TABLE, wrapped per ORA-40556).
   * @param context - The transpiler context.
   * @returns The SQL expression.
   */
  private buildNameGivenCollectionQuery(context: TranspilerContext): string {
    const storage = context.resourceJsonDataType ?? "BLOB";
    const fmt = formatJsonSuffix(storage);
    const jsonColumn = context.resourceJsonColumn ?? "json";
    return `(SELECT CASE WHEN COUNT(n.scalar) = 0 THEN JSON_QUERY('[]' FORMAT JSON, '$') ELSE JSON_ARRAYAGG(n.scalar ORDER BY p.idx, n.idx) END
      FROM JSON_TABLE(${context.resourceAlias}.${jsonColumn}${fmt}, '$.name[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$')) p
      CROSS APPLY JSON_TABLE(JSON_QUERY(p.value${fmt}, '$.given' RETURNING CLOB), '$[*]' COLUMNS (idx FOR ORDINALITY, scalar VARCHAR2(4000) PATH '$')) n)`;
  }
}
