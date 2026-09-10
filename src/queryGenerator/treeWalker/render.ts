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
 * Renders a root Fragment into the final Oracle SELECT statement:
 *
 *   WITH <ctes> SELECT <cols> FROM <root> <fromExtensions> WHERE <pred>
 *
 * Output column aliases are double-quoted to preserve the ViewDefinition's
 * exact column names; base table/column identifiers are unquoted (research
 * R7).
 */

import type { TranspilerContext } from "../../fhirpath/transpiler.js";
import type { ViewDefinition } from "../../types.js";
import type { WhereClauseBuilder } from "../WhereClauseBuilder.js";
import type { Fragment } from "./types.js";

export interface RenderOptions {
  resourceAlias: string;
  schemaName?: string;
  tableName: string;
  testId?: string;
  whereClauseBuilder: WhereClauseBuilder;
  transpilerCtx: TranspilerContext;
}

/**
 * Renders a root Fragment into the final Oracle SELECT statement.
 *
 * Assembles the optional `WITH <ctes>` preamble, the `SELECT <cols>` list,
 * the `FROM <table>` clause, any `fromExtensions` (APPLY / JOIN chains), and
 * the optional `WHERE` predicate built by `WhereClauseBuilder`.
 *
 * A unionAll scope renders as top-level UNION ALL branches: UNION ALL inside
 * a lateral scope mis-correlates on 19c (research R4). Each branch is a
 * self-contained SELECT from the resource table, and the shared WHERE clause
 * (resource type filter and view-level predicates) is applied to every branch.
 *
 * @param fragment - The root Fragment produced by walking the select tree.
 * @param viewDef - The ViewDefinition supplying the resource type, WHERE
 *   predicates, and other metadata needed to construct the WHERE clause.
 * @param options - Render options including table/schema names, resource alias,
 *   optional test-isolation ID, the where-clause builder, and the transpiler
 *   context.
 * @returns The complete Oracle SELECT statement ready for execution.
 */
export function renderRoot(
  fragment: Fragment,
  viewDef: ViewDefinition,
  options: RenderOptions,
): string {
  const { resourceAlias, schemaName, tableName } = options;
  const tableRef = schemaName ? `${schemaName}.${tableName}` : tableName;

  const cteSection =
    fragment.ctes.length > 0
      ? `WITH\n${fragment.ctes.map((c) => `${c.alias} AS (\n${c.body}\n)`).join(",\n")}\n`
      : "";

  const fromClause = `FROM ${tableRef} ${resourceAlias}`;

  const whereClause = options.whereClauseBuilder.buildWhereClause(
    viewDef.resource,
    resourceAlias,
    options.testId,
    viewDef.where,
    options.transpilerCtx,
  );

  if (fragment.kind === "union" && fragment.branches) {
    const branchSqls = fragment.branches.map((branch) => {
      const selectList = branch.columns
        .map((c) => `${c.sqlExpr} AS "${c.name}"`)
        .join(",\n  ");
      let body = `SELECT\n  ${selectList}\n${fromClause}${branch.fromExtensions}`;
      if (whereClause !== null) {
        body += `\n${whereClause}`;
      }
      return body;
    });
    return `${cteSection}${branchSqls.join("\nUNION ALL\n")}`;
  }

  const selectList = fragment.columns
    .map((c) => `${c.sqlExpr} AS "${c.name}"`)
    .join(",\n  ");

  let body = `SELECT\n  ${selectList}\n${fromClause}${fragment.fromExtensions}`;
  if (whereClause !== null) {
    body += `\n${whereClause}`;
  }

  return `${cteSection}${body}`;
}