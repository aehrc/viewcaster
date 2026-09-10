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
 * @param _deps - Unused (columns are projected by the branch walks).
 * @returns A union Fragment carrying one branch Fragment per unionAll entry.
 * @throws When the unionAll array is empty, or when a branch itself is a
 *   union (nested unionAll branches are not supported).
 */
export function walkUnionAll(
  node: ViewDefinitionSelect,
  ctx: Context,
  walk: (n: ViewDefinitionSelect, c: Context) => Fragment,
  _deps: UnionAllDeps,
): Fragment {
  const branches = node.unionAll ?? [];
  if (branches.length === 0) throw new Error("walkUnionAll: empty unionAll");

  const branchFragments = branches.map((b) => {
    const fragment = walk(b, ctx);
    if (fragment.kind === "union") {
      throw new Error(
        "Nested unionAll branches are not supported by this implementation",
      );
    }
    // Every branch is a self-contained SELECT: it must re-establish the
    // enclosing APPLY chain accumulated above this node.
    return {
      ...fragment,
      fromExtensions: ctx.ancestorApplies + fragment.fromExtensions,
    };
  });

  return {
    kind: "union",
    ctes: [],
    fromExtensions: "",
    columns: [],
    partitionKeys: ctx.partitionKeys,
    branches: branchFragments,
  };
}