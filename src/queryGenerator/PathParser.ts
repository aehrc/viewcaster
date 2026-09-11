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
 * Parses and interprets FHIRPath expressions for SQL generation.
 */

import { Transpiler, type TranspilerContext } from "../fhirpath/transpiler.js";

/**
 * Result of parsing a FHIRPath expression with .where() function.
 */
export interface FhirPathWhereResult {
  path: string;
  whereCondition: string | null;
  useFirst: boolean;
}

/**
 * Result of parsing array indexing from a path.
 */
export interface ArrayIndexingResult {
  path: string;
  arrayIndex: number | null;
}

/**
 * Result of parsing a path segment with array indexing.
 */
export interface SegmentIndexingResult {
  cleanSegment: string;
  segmentIndex: number | null;
}

/**
 * Handles parsing and interpretation of FHIRPath expressions.
 */
export class PathParser {
  private static readonly knownArrayFields = [
    "name",
    "telecom",
    "address",
    "contact",
    "identifier",
    "communication",
    "link",
  ];

  /**
   * Find the matching closing parenthesis for .where() using balanced counting.
   * @param path - The FHIRPath expression.
   * @param whereStart - The position after ".where(".
   * @returns The index of the matching closing parenthesis, or -1 if not found.
   */
  private findWhereClosingParen(path: string, whereStart: number): number {
    let parenCount = 0;

    for (let i = whereStart; i < path.length; i++) {
      if (path[i] === "(") {
        parenCount++;
      } else if (path[i] === ")") {
        if (parenCount === 0) {
          return i;
        }
        parenCount--;
      }
    }

    return -1;
  }

  /**
   * Transpile a where condition to SQL.
   * @param condition - The FHIRPath condition expression from within .where().
   * @param context - The transpiler context carrying storage type and constants.
   * @returns The SQL expression for the condition.
   * @throws {Error} when the condition cannot be transpiled.
   */
  private transpileWhereCondition(
    condition: string,
    context: TranspilerContext,
  ): string {
    const itemContext: TranspilerContext = {
      resourceAlias: "forEach_item",
      constants: context.constants,
      iterationContext: "value",
    };

    try {
      return Transpiler.transpile(condition, itemContext);
    } catch (error) {
      throw new Error(
        `Failed to transpile .where() condition "${condition}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Parse FHIRPath .where() function from a forEach path.
   * Transpiles the where condition to SQL using the FHIRPath transpiler.
   * @param path - The FHIRPath expression potentially containing .where() and .first().
   * @param context - The transpiler context carrying storage type and constants.
   * @returns The parsed path with where condition and first-element flag.
   */
  parseFhirPathWhere(
    path: string,
    context: TranspilerContext,
  ): FhirPathWhereResult {
    const whereIndex = path.indexOf(".where(");
    if (whereIndex === -1) {
      return { path, whereCondition: null, useFirst: false };
    }

    const basePath = path.slice(0, Math.max(0, whereIndex));
    const whereStart = whereIndex + 7; // Position after ".where(".
    const conditionEnd = this.findWhereClosingParen(path, whereStart);

    if (conditionEnd === -1) {
      throw new Error(`Unmatched parentheses in .where() function: ${path}`);
    }

    const condition = path.substring(whereStart, conditionEnd).trim();
    let remainingPath = path.slice(Math.max(0, conditionEnd + 1));

    // Detect .first() to apply TOP 1 in SQL generation.
    const useFirst = remainingPath === ".first()";
    if (useFirst) {
      remainingPath = ""; // Remove .first() from path - it will be handled via TOP 1
    }

    const fullPath = remainingPath ? `${basePath}${remainingPath}` : basePath;

    // Handle .where(false) - filter out everything.
    if (condition === "false") {
      return {
        path: fullPath,
        whereCondition: "1 = 0",
        useFirst: false,
      };
    }

    return {
      path: fullPath,
      whereCondition: this.transpileWhereCondition(condition, context),
      useFirst,
    };
  }

  /**
   * Parse array indexing from a forEach path.
   * For paths like "contact.telecom[0]", interpret as "contact[0].telecom[0]" - apply index to all array segments.
   * @param path - The FHIRPath expression with optional array index.
   * @returns The parsed path and array index.
   */
  parseArrayIndexing(path: string): ArrayIndexingResult {
    const match = /^(.+)\[(\d+)]$/.exec(path);
    if (!match) {
      return { path, arrayIndex: null };
    }

    const basePath = match[1];
    const arrayIndex = Number.parseInt(match[2], 10);

    // Check if this is a multi-segment path (e.g., contact.telecom[0]).
    const segments = basePath.split(".");
    if (segments.length > 1) {
      // For contact.telecom[0], interpret as contact[0].telecom[0].
      const indexedPath = segments
        .map((seg) => {
          const cleanSeg = seg.replace(/\[.*]/, "");
          if (PathParser.knownArrayFields.includes(cleanSeg)) {
            return `${cleanSeg}[${arrayIndex}]`;
          }
          return cleanSeg;
        })
        .join(".");

      return {
        path: indexedPath,
        arrayIndex: null, // Index already applied in path.
      };
    }

    return {
      path: basePath,
      arrayIndex: arrayIndex,
    };
  }

  /**
   * Parse array indexing from a path segment.
   * @param pathSegment - A single path segment with optional array index.
   * @returns The segment without indexing and the extracted index.
   */
  parseSegmentIndexing(pathSegment: string): SegmentIndexingResult {
    const segmentMatch = /^(.+)\[(\d+)]$/.exec(pathSegment);
    return {
      cleanSegment: segmentMatch ? segmentMatch[1] : pathSegment,
      segmentIndex: segmentMatch ? Number.parseInt(segmentMatch[2], 10) : null,
    };
  }

  /**
   * Detect if a forEach path requires array flattening.
   * Returns array of path segments that are arrays in FHIR Patient resource.
   * @param path - The FHIRPath expression.
   * @returns Array of path segments that correspond to FHIR array fields.
   */
  detectArrayFlatteningPaths(path: string): string[] {
    const segments = path.split(".");
    const arraySegments: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const cleanSegment = segment.replace(/\[.*]/, "");

      if (PathParser.knownArrayFields.includes(cleanSegment)) {
        arraySegments.push(segments.slice(0, i + 1).join("."));
      }
    }

    return arraySegments;
  }

  /**
   * Extract path segment for a specific level in array paths.
   * @param arrayPaths - Array of paths to array fields from detectArrayFlatteningPaths.
   * @param index - The level index to extract.
   * @returns The path segment relative to the previous level.
   */
  extractPathSegment(arrayPaths: string[], index: number): string {
    const fullPath = arrayPaths[index];
    const previousPath = index > 0 ? arrayPaths[index - 1] : "";
    return previousPath
      ? fullPath.slice(Math.max(0, previousPath.length + 1))
      : fullPath;
  }
}
