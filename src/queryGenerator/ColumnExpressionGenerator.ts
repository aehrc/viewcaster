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
 * equivalents from the extracted text. Expressions that already yield a
 * SQL-native type (no JSON extraction involved) are cast only via their
 * mapped type when a type is declared.
 */

import { Transpiler, TranspilerContext } from "../fhirpath/transpiler.js";
import { ViewDefinitionColumn } from "../types.js";

/**
 * Handles generation of column expressions with type casting.
 */
export class ColumnExpressionGenerator {
  /**
   * Generate SQL expression for a column.
   *
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
      if (column.collection === true) {
        expression = this.generateCollectionExpression(column.path, context);
      } else {
        expression = Transpiler.transpile(column.path, context);
      }

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
   * Casting applies only to text-extracted values; expressions that are
   * already SQL-native (e.g. `%rowIndex` arithmetic) are left alone because
   * they carry no text round-trip.
   *
   * @param expression - The SQL expression yielding the raw value.
   * @param column - The column descriptor carrying the type and tags.
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
   *
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
   *
   * @param path - The FHIRPath of the collection.
   * @param context - The transpiler context.
   * @returns A JSON_QUERY expression yielding the array.
   */
  private generateCollectionExpression(
    path: string,
    context: TranspilerContext,
  ): string {
    if (context.iterationContext) {
      return `JSON_QUERY(${context.iterationContext}, '$.${path}')`;
    }

    const jsonColumn = context.resourceJsonColumn ?? "json";
    return `JSON_QUERY(${context.resourceAlias}.${jsonColumn}, '$.${path}')`;
  }
}