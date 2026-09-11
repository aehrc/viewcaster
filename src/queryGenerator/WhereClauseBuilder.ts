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
 * Builds WHERE clauses for SQL queries.
 * @author John Grimes
 */

import { Transpiler, type TranspilerContext } from "../fhirpath/transpiler.js";
import { validateResourceType } from "../validation.js";

import type { ViewDefinitionWhere } from "../types.js";

/**
 * Handles generation of WHERE clauses.
 */
export class WhereClauseBuilder {
  /**
   * Build complete WHERE clause combining the resource type filter, the
   * optional test-id filter, and view-level filters. Validates inputs to
   * prevent SQL injection.
   * @param resourceType - The FHIR resource type being queried.
   * @param resourceAlias - The alias the resources table is referenced by.
   * @param testId - Optional test-isolation identifier (only used in the test
   *   table, which carries a test_id column).
   * @param whereConditions - Optional view-level WHERE filter conditions.
   * @param context - The transpiler context carrying storage type and constants.
   * @returns The WHERE clause string, or null if no conditions apply.
   */
  buildWhereClause(
    resourceType: string,
    resourceAlias: string,
    testId: string | undefined,
    whereConditions: ViewDefinitionWhere[] | undefined,
    context: TranspilerContext,
  ): string | null {
    const conditions: string[] = [];

    // Validate and add test_id filter for concurrent test isolation (only
    // used in the test table, which carries a test_id column).
    if (testId) {
      if (!/^[A-Za-z0-9_-]+$/.test(testId)) {
        throw new Error(`Invalid test id: '${testId}'.`);
      }
      conditions.push(`${resourceAlias}.test_id = '${testId}'`);
    }

    // Validate and add resource type filter.
    validateResourceType(resourceType);
    conditions.push(`${resourceAlias}.resource_type = '${resourceType}'`);

    // Add view-level WHERE conditions.
    const viewWhereClause = this.generateViewWhereClause(
      whereConditions,
      context,
    );
    if (viewWhereClause) {
      conditions.push(viewWhereClause);
    }

    if (conditions.length === 0) {
      return null;
    }

    return `WHERE ${conditions.join(" AND ")}`;
  }

  /**
   * Generate the WHERE clause for view-level filters.
   * @param whereConditions - Optional view-level WHERE filter conditions.
   * @param context - The transpiler context carrying storage type and constants.
   * @returns The WHERE clause string, or null if no conditions apply.
   */
  private generateViewWhereClause(
    whereConditions: ViewDefinitionWhere[] | undefined,
    context: TranspilerContext,
  ): string | null {
    if (!whereConditions || whereConditions.length === 0) {
      return null;
    }

    const conditions: string[] = [];
    const booleanFields = ["active", "deceased", "multipleBirth"];

    for (const where of whereConditions) {
      try {
        const condition = Transpiler.transpile(where.path, context);

        // Check if this looks like a simple boolean field reference that needs
        // to be cast. The transpiler emits 'true'/'false' string comparisons
        // for booleans, which are not valid predicates on their own.
        const simpleBooleanFieldPattern = new RegExp(
          String.raw`^\(?JSON_VALUE\([^,]+,\s*'\$\.(${booleanFields.join("|")})'[^)]*\)\)?$`,
        );

        if (simpleBooleanFieldPattern.test(condition.trim())) {
          conditions.push(
            `(CASE WHEN ${condition} = 'true' THEN 1 ELSE 0 END = 1)`,
          );
        } else {
          conditions.push(condition);
        }
      } catch (error) {
        throw new Error(
          `Failed to transpile where condition '${where.path}': ${error}`,
        );
      }
    }

    return `(${conditions.join(") AND (")})`;
  }
}
