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
  | "ColumnsOnly"
  | "Group"
  | "ForEach"
  | "ForEachOrNull"
  | "Repeat"
  | "UnionAll";

export interface PartitionKey {
  /** Logical name, e.g. "id", "fe_0_key", "repeat_2_path". */
  name: string;
  /** SQL expression that yields it in the *defining* scope. */
  sqlExpr: string;
  /** Type used when projecting it through a CTE column list. */
  sqlType: string;
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
   * so repeat CTEs declare the identity columns explicitly (research R4).
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
}
