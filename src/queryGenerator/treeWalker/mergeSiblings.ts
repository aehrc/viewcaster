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
 * Merges sibling fragments produced by walking children of a Group.
 *
 * Row siblings concatenate normally. When one sibling is a union fragment,
 * every row sibling's columns and FROM extensions are distributed into each
 * union branch (unionAll rows carry the enclosing scope's columns), and the
 * merged result is the union fragment.
 */

import type { Context, Fragment } from "./types.js";

/**
 * Merges sibling Fragments produced by walking children of a Group node.
 *
 * Flattens each fragment's `ctes` list, concatenates `fromExtensions` strings
 * (preserving order so aliases are introduced before they are referenced), and
 * concatenates `columns` arrays in lexical order. When any fragment is a union
 * fragment, the row fragments' columns and extensions are folded into each of
 * the union's branches instead, since each branch is a self-contained SELECT.
 *
 * @param fragments - Ordered array of sibling Fragments to merge.
 * @param ctx - The context of the parent Group node, used to supply
 *   `partitionKeys` for the merged result.
 * @returns A single merged Fragment.
 * @throws When two union fragments appear in the same scope (not supported).
 */
export function mergeSiblings(fragments: Fragment[], ctx: Context): Fragment {
  if (fragments.length === 0) {
    return {
      kind: "rows",
      ctes: [],
      fromExtensions: "",
      columns: [],
      partitionKeys: ctx.partitionKeys,
    };
  }

  if (fragments.length === 1) return fragments[0];

  const rowFragments = fragments.filter((f) => f.kind !== "union");
  const unionFragments = fragments.filter((f) => f.kind === "union");

  if (unionFragments.length === 0) {
    return {
      kind: "rows",
      ctes: fragments.flatMap((f) => f.ctes),
      fromExtensions: fragments.map((f) => f.fromExtensions).join(""),
      columns: fragments.flatMap((f) => f.columns),
      partitionKeys: ctx.partitionKeys,
    };
  }

  if (unionFragments.length > 1) {
    throw new Error(
      "Multiple unionAll elements at the same select level are not supported by this implementation",
    );
  }

  const union = unionFragments[0];
  const rowCtes = rowFragments.flatMap((f) => f.ctes);
  const rowFromExtensions = rowFragments
    .map((f) => f.fromExtensions)
    .join("");
  const rowColumns = rowFragments.flatMap((f) => f.columns);

  return {
    kind: "union",
    ctes: [...rowCtes, ...union.ctes],
    fromExtensions: "",
    columns: union.columns,
    partitionKeys: ctx.partitionKeys,
    branches: (union.branches ?? []).map((branch) => ({
      ...branch,
      ctes: [...rowCtes, ...branch.ctes],
      // Row siblings' APPLY/JOIN chains come before the branch's own, and the
      // union fragment's branches already carry the enclosing ancestor chain.
      // Their columns follow the branch's in the projection, matching select
      // entry order.
      fromExtensions: rowFromExtensions + branch.fromExtensions,
      columns: [...branch.columns, ...rowColumns],
    })),
  };
}