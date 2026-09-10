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
 * Walker for UnionAll nodes.
 *
 * Each branch becomes a self-contained SELECT whose FROM clause re-establishes
 * the enclosing APPLY chain; renderRoot joins the branches with top-level
 * UNION ALL. A derived-table `(branch UNION ALL branch) CROSS APPLY` is not
 * used because UNION ALL inside a lateral scope mis-correlates on 19c
 * (research R4).
 */

import type { ViewDefinitionSelect } from "../../../types.js";
import type { ColumnExpressionGenerator } from "../../ColumnExpressionGenerator.js";
import type { Context, Fragment } from "../types.js";

export interface UnionAllDeps {
  columnGenerator: ColumnExpressionGenerator;
}

/**
 * Walker for UnionAll nodes.
 *
 * Walks every branch in the current context. Enclosing sibling columns (the
 * same select's `column[]` and sibling `select[]` entries, which must appear
 * in every branch per the SQL on FHIR unionAll semantics) are distributed into
 * each branch by `mergeSiblings` at the parent scope.
 *
 * @param node - The unionAll select node.
 * @param ctx - The current walker context supplying the enclosing APPLY chain.
 * @param walk - The recursive walk function used to visit branches.
 * @param deps - The column generator used to project the node's own columns.
 * @returns A union Fragment carrying one branch Fragment per unionAll entry.
 * @throws When the unionAll array is empty, or when a branch itself is a
 *   union (nested unionAll branches are not supported).
 */
export function walkUnionAll(
  node: ViewDefinitionSelect,
  ctx: Context,
  walk: (n: ViewDefinitionSelect, c: Context) => Fragment,
  deps: UnionAllDeps,
): Fragment {
  const branches = node.unionAll ?? [];
  if (branches.length === 0) throw new Error("walkUnionAll: empty unionAll");
  // A branch may itself be a unionAll (nested); per SQL on FHIR semantics the
  // nested union's branches flatten into this scope's branch list.
  const branchFragments = branches.flatMap((b) => {
    const fragment = walk(b, ctx);
    if (fragment.kind === "union") {
      return fragment.branches ?? [];
    }
    // The enclosing APPLY chain is folded into every branch in the return
    // below; keep the leaf fragment unchanged here.
    return [fragment];
  });

  // The unionAll node's own column[] and sibling select[] entries belong to
  // the enclosing scope: per the SQL on FHIR unionAll semantics every branch
  // row carries them. Collect their columns and FROM extensions so they can
  // be folded into each branch.
  const outerFragments: Fragment[] = [];
  if (node.column && node.column.length > 0) {
    outerFragments.push({
      ctes: [],
      fromExtensions: "",
      columns: node.column.map((column) => ({
        name: column.name,
        sqlExpr: deps.columnGenerator.generateExpression(
          column,
          ctx.transpilerCtx,
        ),
      })),
      partitionKeys: ctx.partitionKeys,
    });
  }
  if (node.select) {
    for (const child of node.select) outerFragments.push(walk(child, ctx));
  }
  const rowCtes = outerFragments.flatMap((f) => f.ctes);
  const rowFromExtensions = outerFragments
    .map((f) => f.fromExtensions)
    .join("");
  const rowColumns = outerFragments.flatMap((f) => f.columns);

  return {
    kind: "union",
    ctes: [...rowCtes],
    fromExtensions: "",
    columns: [],
    partitionKeys: ctx.partitionKeys,
    branches: branchFragments.map((branch) => ({
      ...branch,
      // Every branch is a self-contained SELECT: it must re-establish the
      // enclosing APPLY chain accumulated above this node.
      ctes: [...rowCtes, ...branch.ctes],
      fromExtensions:
        ctx.ancestorApplies + rowFromExtensions + branch.fromExtensions,
      columns: [...rowColumns, ...branch.columns],
    })),
  };
}