/*
 * Copyright © 2026, Commonwealth Scientific and Industrial Research
 * Organisation (CSIRO) ABN 41 687 119 230.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
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
 * merged result is the union fragment. When one sibling is a nested repeat
 * whose spine CTE anchored on the enclosing repeat CTE, the remaining
 * siblings are re-pointed onto the spine CTE first.
 */

import type { Context, Fragment, RebaseInfo } from "./types.js";

/**
 * Applies ordered identifier-boundary textual replacements to a SQL string.
 *
 * Shared by sibling rewrites and rebase composition: each `from` pattern is
 * matched with identifier-boundary lookarounds so that e.g. "r.id" never
 * matches inside a longer identifier.
 * @param sql - The SQL text to rewrite.
 * @param replacements - Ordered from/to pairs.
 * @returns The rewritten SQL.
 */
export function applyTextReplacements(
  sql: string,
  replacements: Array<{ from: string; to: string }>,
): string {
  let out = sql;
  for (const { from, to } of replacements) {
    const escaped = from.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    out = out.replaceAll(
      new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g"),
      () => to,
    );
  }
  return out;
}

/**
 * Merges sibling Fragments produced by walking children of a Group node.
 *
 * Flattens each fragment's `ctes` list, concatenates `fromExtensions` strings
 * (preserving order so aliases are introduced before they are referenced), and
 * concatenates `columns` arrays in lexical order. When any fragment is a union
 * fragment, the row fragments' columns and extensions are folded into each of
 * the union's branches instead, since each branch is a self-contained SELECT.
 *
 * When one sibling carries `rebase` (a nested repeat that anchored a spine CTE
 * on the enclosing repeat), the other siblings are rewritten onto the spine
 * CTE and the rebase is carried on the merged result so the enclosing repeat
 * walker can drop its own join.
 * @param fragments - Ordered array of sibling Fragments to merge.
 * @param ctx - The context of the parent Group node, used to supply
 * `partitionKeys` for the merged result.
 * @returns A single merged Fragment.
 * @throws {Error} when two union fragments appear in the same scope, or when two
 * spine-rebasing repeats appear at the same level (not supported).
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

  const rebasers = fragments.filter((f) => f.rebase !== undefined);
  if (rebasers.length > 1) {
    throw new Error(
      "Multiple spine repeats anchoring the same enclosing repeat at one select level are not supported",
    );
  }
  const rebase = rebasers[0]?.rebase;
  const effective = rebase
    ? fragments.map((f) =>
        f.rebase === undefined ? rebaseSiblingFragment(f, rebase) : f,
      )
    : fragments;

  if (effective.length === 1) return effective[0];

  const rowFragments = effective.filter((f) => f.kind !== "union");
  const unionFragments = effective.filter((f) => f.kind === "union");

  if (unionFragments.length === 0) {
    return {
      kind: "rows",
      ctes: effective.flatMap((f) => f.ctes),
      fromExtensions: effective.map((f) => f.fromExtensions).join(""),
      columns: effective.flatMap((f) => f.columns),
      partitionKeys: ctx.partitionKeys,
      rebase,
    };
  }

  if (unionFragments.length > 1) {
    throw new Error(
      "Multiple unionAll elements at the same select level are not supported by this implementation",
    );
  }

  const union = unionFragments[0];
  const rowCtes = rowFragments.flatMap((f) => f.ctes);
  const rowFromExtensions = rowFragments.map((f) => f.fromExtensions).join("");
  const rowColumns = rowFragments.flatMap((f) => f.columns);

  return {
    kind: "union",
    ctes: [...rowCtes, ...union.ctes],
    fromExtensions: "",
    columns: union.columns,
    partitionKeys: ctx.partitionKeys,
    rebase,
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

/**
 * Re-points one sibling fragment onto a nested repeat's spine CTE.
 *
 * Column expressions are rewritten with the rebase's textual replacements
 * (ancestor CTE references become spine carried columns); FROM extensions
 * that reference an out-of-scope ancestor alias are dropped, because the
 * ancestor rows now surface only through the spine CTE that the rebasing
 * sibling joins.
 * @param fragment - The sibling fragment to rewrite.
 * @param rebase - The rebase info of the sibling that anchored the spine.
 * @returns The rewritten fragment.
 */
function rebaseSiblingFragment(
  fragment: Fragment,
  rebase: RebaseInfo,
): Fragment {
  const dropAncestors = (ext: string): string =>
    ext
      .split("\n")
      .filter(
        (clause) =>
          clause === "" ||
          !rebase.ancestorAliases.some((alias) =>
            new RegExp(String.raw`\b${alias}\.`).test(clause),
          ),
      )
      .join("\n");
  return {
    ...fragment,
    columns: fragment.columns.map((c) => ({
      ...c,
      sqlExpr: applyTextReplacements(c.sqlExpr, rebase.replacements),
    })),
    fromExtensions: dropAncestors(fragment.fromExtensions),
    partitionKeys: fragment.partitionKeys.map((k) => ({
      ...k,
      sqlExpr: applyTextReplacements(k.sqlExpr, rebase.replacements),
    })),
  };
}
