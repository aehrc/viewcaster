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
 * Core types for the tree-walker query generator.
 *
 * Each select-tree node produces a Fragment; sibling fragments are merged
 * via partition-key joins. Context threads through descent, accumulating
 * the current JSON source, partition keys, and APPLY chain.
 */

import type { TranspilerContext } from "../../fhirpath/transpiler.js";

export const SQL_INT = "NUMBER(19)";

export type NodeKind =
  "ColumnsOnly" | "Group" | "ForEach" | "ForEachOrNull" | "Repeat" | "UnionAll";

export interface PartitionKey {
  /** Logical name, e.g. "id", "fe_0_key", "repeat_2_path". */
  name: string;
  /** SQL expression that yields it in the *defining* scope. */
  sqlExpr: string;
  /** Type used when projecting it through a CTE column list. */
  sqlType: string;
}

/**
 * A column of an ancestor repeat scope carried through a nested repeat's
 * "spine" CTE. Ancestor identity columns (partition keys and
 * `elem_path`) are projected as regular keys; `item_json`, `item_scalar` and
 * `elem_order` are carried so enclosing-scope column expressions keep
 * resolving after the outer repeat's join is dropped.
 */
export interface CarriedColumn {
  /** Column name inside the spine CTE, e.g. "repeat_0_item_json". */
  name: string;
  /** Expression referencing it in the spine base CTE's scope. */
  sqlExpr: string;
  sqlType: string;
  /**
   * The original ancestor-level reference, e.g. "repeat_0.item_json" — the
   * form enclosing-scope SQL mentions and that sibling rewrites replace.
   */
  origin: string;
}

/** One forEach level between a spine base CTE and a nested repeat. */
export interface SpineTraceStep {
  alias: string;
  applyClause: string;
}

/**
 * Present when the current scope descends from a repeat CTE's iteration
 * context. A nested repeat anchors on `baseAlias` (single "spine" recursion)
 * instead of the resource table, carrying `carried` columns and folding the
 * `trace` APPLY levels into its anchor.
 */
export interface SpineContext {
  baseAlias: string;
  carried: CarriedColumn[];
  trace: SpineTraceStep[];
}

/**
 * Rewrites enclosing-scope sibling fragments onto a nested repeat's spine
 * CTE: textual column-expression replacements plus the ancestor aliases whose
 * JOIN clauses siblings must drop (the outer repeat CTE is now referenced
 * only inside the spine anchor; ORA-32036).
 */
export interface RebaseInfo {
  /** The spine CTE alias siblings are re-pointed onto. */
  spineAlias: string;
  /** The CTE the spine anchored on (the enclosing repeat's CTE). */
  anchoredBase: string;
  /** Every alias (spine base and trace levels) out of scope at top level. */
  ancestorAliases: string[];
  /** Ordered textual replacements applied to sibling SQL. */
  replacements: Array<{ from: string; to: string }>;
}

export interface ProjectedColumn {
  /** Bracketed identifier as it appears in the final SELECT list. */
  name: string;
  sqlExpr: string;
}

export interface CteDefinition {
  alias: string;
  /** Full SQL body without the "alias AS (...)" wrapper. */
  body: string;
  /**
   * Column alias list, required for recursive (repeat) CTEs on Oracle
   * (ORA-32039); rendered as `alias (cols) AS (...)` when present.
   */
  columnList?: string;
  /**
   * CYCLE clause text, rendered directly after the CTE's closing paren.
   * Oracle's implicit whole-row cycle detection mis-fires on CLOB columns,
   * so repeat CTEs declare the identity columns explicitly.
   */
  cycleClause?: string;
}

export interface Context {
  resourceAlias: string;
  /** Current JSON source expression, e.g. "r.json", "forEach_0.value". */
  source: string;
  /** Ordered, monotonically appended as the walker descends. */
  partitionKeys: PartitionKey[];
  /**
   * CROSS/OUTER APPLY chain accumulated above this point, needed so any
   * enclosed Repeat CTE anchor can reach `ctx.source`. Each element starts
   * with "\n".
   */
  ancestorApplies: string;
  /** Shared mutable counter for unique CTE/alias names across the whole compile. */
  cteCounter: { value: number };
  /** Pass-through context for the FHIRPath transpiler. */
  transpilerCtx: TranspilerContext;
  /**
   * Present when the scope is inside a repeat CTE's iteration context; a
   * nested repeat uses it to emit a single spine CTE.
   */
  spine?: SpineContext;
}

/**
 * A branch of a unionAll: a self-contained SELECT body rendered by renderRoot
 * and joined with top-level UNION ALL.
 */
export type UnionBranch = Fragment;

export interface Fragment {
  /** "union" when the fragment carries UNION ALL branches. */
  kind?: "rows" | "union";
  ctes: CteDefinition[];
  /**
   * Ordered sequence of FROM-clause extensions: a mix of CROSS/OUTER APPLY
   * and INNER/LEFT/FULL OUTER JOIN clauses, each prefixed by "\n". Order is
   * preserved so that aliases are always introduced before they are
   * referenced.
   */
  fromExtensions: string;
  columns: ProjectedColumn[];
  /** Keys exposed by this fragment for use by sibling joins. */
  partitionKeys: PartitionKey[];
  /** Branch SELECT bodies, present only when kind is "union". */
  branches?: Fragment[];
  /**
   * Set by a nested repeat that anchored on an enclosing repeat CTE; the
   * parent scope's sibling fragments must be rewritten onto the spine CTE.
   */
  rebase?: RebaseInfo;
}
