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
 * FHIRPath expression transpiler to Oracle SQL.
 *
 * Converts FHIRPath expressions to equivalent Oracle SQL expressions. The
 * visitor emits dialect-neutral JSON_VALUE/JSON_QUERY fragments; this module
 * applies the Oracle-specific syntax (FORMAT JSON in BLOB storage mode,
 * RETURNING clauses) in a single terminal pass, so the visitor's pattern
 * matching never sees the Oracle decorations.
 */

import { CharStreams, CommonTokenStream } from "antlr4ts";
import { fhirpathLexer } from "../generated/grammar/fhirpathLexer";
import {
  EntireExpressionContext,
  fhirpathParser,
} from "../generated/grammar/fhirpathParser";
import type { ViewDefinitionColumnTag } from "../types.js";
import { validateAnsiSqlType, validateOracleType } from "../validation.js";
import { FHIRPathToOracleVisitor, type TranspilerContext } from "./visitor";

// Re-export TranspilerContext type from visitor
export type { TranspilerContext } from "./visitor";

export class Transpiler {
  /**
   * Transpile a FHIRPath expression to Oracle SQL.
   *
   * @param expression - The FHIRPath expression.
   * @param context - The transpiler context (aliases, constants, storage).
   * @returns The Oracle SQL expression.
   * @throws {Error} On syntax errors, unknown constants, or unsupported
   *   constructs; the message names the offending element (FR-004).
   */
  static transpile(expression: string, context: TranspilerContext): string {
    // Check for syntax errors first, before any try-catch
    const parseResult = this.parseExpression(expression);
    if (!parseResult.success || !parseResult.tree) {
      throw new Error(`Syntax error in FHIRPath expression '${expression}'`);
    }

    try {
      // Create visitor and visit the parse tree
      const visitor = new FHIRPathToOracleVisitor(context);
      const fragment = visitor.visit(parseResult.tree);
      return this.applyOracleJsonSyntax(
        fragment,
        context.resourceJsonDataType ?? "BLOB",
      );
    } catch (error) {
      throw new Error(
        `Failed to transpile FHIRPath expression '${expression}': ${error}`,
      );
    }
  }

  private static parseExpression(expression: string): {
    success: boolean;
    tree: EntireExpressionContext | null;
  } {
    // Create ANTLR input stream
    const inputStream = CharStreams.fromString(expression);

    // Create lexer
    const lexer = new fhirpathLexer(inputStream);
    const tokenStream = new CommonTokenStream(lexer);

    // Create parser
    const parser = new fhirpathParser(tokenStream);

    // Remove default error listeners to avoid console output
    parser.removeErrorListeners();

    // Parse the entire expression
    const tree = parser.entireExpression();

    // Check for parse errors
    if (parser.numberOfSyntaxErrors > 0) {
      return { success: false, tree: null };
    }

    return { success: true, tree };
  }

  /**
   * Applies Oracle-specific JSON syntax to the visitor's dialect-neutral
   * fragments.
   *
   * JSON_VALUE/JSON_QUERY calls whose source is a simple column reference get
   * `FORMAT JSON` after the source in BLOB storage mode (mandatory there per
   * research R3) and a `RETURNING VARCHAR2(4000)` clause on JSON_VALUE (the
   * documented default, emitted explicitly). Calls with a nested function
   * call as the source (e.g. JSON_VALUE(JSON_QUERY(...))) are left alone: the
   * inner function already yields JSON-typed text and the default return type
   * applies. Idempotent on already-Oracle-shaped input.
   *
   * @param expr - The dialect-neutral SQL fragment.
   * @param storage - The targeted JSON storage type.
   * @returns The Oracle-shaped SQL fragment.
   */
  static applyOracleJsonSyntax(
    expr: string,
    storage: "BLOB" | "JSON",
  ): string {
    const formatSuffix = storage === "BLOB" ? " FORMAT JSON" : "";
    const decorated = expr.replace(
      /JSON_VALUE\(([^(),]+),\s*'([^']+)'\)/g,
      (_match, source: string, path: string) =>
        `JSON_VALUE(${source}${formatSuffix}, '${path}' RETURNING VARCHAR2(4000))`,
    );
    const withJsonQuery = decorated.replace(
      /JSON_QUERY\(([^(),]+),\s*'([^']+)'\)/g,
      (_match, source: string, path: string) =>
        `JSON_QUERY(${source}${formatSuffix}, '${path}')`,
    );
    return withJsonQuery.replace(
      /JSON_EXISTS\(([^(),]+),\s*'([^']+)'\)/g,
      (_match, source: string, path: string) =>
        `JSON_EXISTS(${source}${formatSuffix}, '${path}')`,
    );
  }

  /**
   * Get the SQL data type for a FHIR type, with optional tag-based override.
   *
   * Type precedence (FR-006): oracle/type > ansi/type > FHIR type defaults.
   *
   * @param fhirType - FHIR primitive type name (e.g. 'string', 'integer').
   * @param tags - Optional array of column tags for type hints.
   * @returns Oracle SQL type specification.
   */
  static inferSqlType(
    fhirType?: string,
    tags?: ViewDefinitionColumnTag[],
  ): string {
    // Check for oracle/type tag override.
    const tagOverride = this.getTagTypeOverride(tags);
    if (tagOverride) {
      return tagOverride;
    }

    // Use default FHIR type mapping.
    return this.getDefaultFhirTypeMapping(fhirType);
  }

  /**
   * Get type override from oracle/type or ansi/type tag if present.
   */
  private static getTagTypeOverride(
    tags?: ViewDefinitionColumnTag[],
  ): string | null {
    if (!tags) {
      return null;
    }

    // Check for oracle/type tag first (highest precedence).
    const oracleTypeTag = tags.find((tag) => tag.name === "oracle/type");
    if (oracleTypeTag) {
      validateOracleType(oracleTypeTag.value);
      return oracleTypeTag.value;
    }

    // Check for ansi/type tag (lower precedence).
    const ansiTypeTag = tags.find((tag) => tag.name === "ansi/type");
    if (ansiTypeTag) {
      return validateAnsiSqlType(ansiTypeTag.value);
    }

    return null;
  }

  /**
   * Get the default Oracle type mapping for a FHIR primitive type
   * (research R9). Text is the default so FHIR semantics (partial dates,
   * arbitrary-precision decimals, Unicode) are preserved; native types are an
   * explicit opt-in via type tags.
   */
  private static getDefaultFhirTypeMapping(fhirType?: string): string {
    const typeMap: Record<string, string> = {
      id: "VARCHAR2(64)",
      boolean: "NUMBER(1)",
      integer: "NUMBER(10)",
      positiveint: "NUMBER(10)",
      unsignedint: "NUMBER(10)",
      integer64: "NUMBER(19)",

      uuid: "VARCHAR2(100)",
      oid: "VARCHAR2(255)",
      decimal: "VARCHAR2(4000)",
      date: "VARCHAR2(10)",
      datetime: "VARCHAR2(50)",
      instant: "VARCHAR2(50)",
      time: "VARCHAR2(20)",

      string: "VARCHAR2(4000)",
      markdown: "VARCHAR2(4000)",
      code: "VARCHAR2(4000)",

      uri: "VARCHAR2(4000)",
      url: "VARCHAR2(4000)",
      canonical: "VARCHAR2(4000)",

      base64binary: "VARCHAR2(4000)",
    };

    if (!fhirType) {
      return "VARCHAR2(4000)";
    }

    return typeMap[fhirType.toLowerCase()] ?? "VARCHAR2(4000)";
  }
}
