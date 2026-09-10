/**
 * Walker for Repeat nodes - emits a recursive CTE and returns a set Fragment.
 *
 * The CTE projects the current partition keys and a content-derived `elem_path`
 * for stable identity across re-evaluations. The Fragment's `fromExtensions`
 * is an INNER JOIN to the CTE on the partition keys; sibling-level
 * composite-key joins are added by `mergeSiblings`.
 *
 * When the scope already descends from another repeat CTE (a nested repeat),
 * the CTE is emitted as a single "spine" recursion anchored on the enclosing
 * CTE instead of the resource table (research R4, ORA-32036): a lateral
 * recursive CTE cannot be referenced more than once per query block on 19c,
 * so the enclosing CTE is referenced exactly once - inside the spine anchor -
 * and its context columns are carried through the recursion.
 * @author John Grimes
 */

import { freshAlias } from "../aliasGenerator.js";
import { buildRepeatCte, qualifiedKeyCols } from "../cteTemplates.js";
import { applyTextReplacements } from "../mergeSiblings.js";
import {
  type CarriedColumn,
  type Context,
  type CteDefinition,
  type Fragment,
  type PartitionKey,
  type RebaseInfo,
  type SpineContext,
} from "../types.js";

import type { TranspilerContext } from "../../../fhirpath/transpiler.js";
import type { ViewDefinitionSelect } from "../../../types.js";

export interface RepeatDeps {
  schemaName: string;
  tableName: string;
}

/**
 * Walker for Repeat nodes — emits a recursive CTE and returns a set Fragment.
 *
 * Generates a `WITH RECURSIVE`-style CTE (via `buildRepeatCte`) whose anchor
 * member starts at the resource root (or, in spine mode, at the enclosing
 * repeat CTE) and whose recursive members re-expand each element's
 * `item_json` using the same path list. The CTE accumulates an `elem_path`
 * string for stable per-element identity across recursion levels.
 *
 * The returned Fragment contains the CTE plus an `INNER JOIN` to it in
 * `fromExtensions`; the join is keyed on the current partition keys that are
 * still in scope at the top-level query block. The inner context updates
 * `source` to `<cteAlias>.item_json`, appends a new `<cteAlias>_path`
 * partition key, and sets a `SpineContext` so nested operators can anchor on
 * this CTE.
 *
 * When the inner sub-tree is a unionAll whose branches share an identical
 * FROM-extension chain (plain column branches), the branches are merged into
 * a single SELECT over the CTE via a row-duplicating CROSS APPLY and CASE
 * expressions, because a top-level UNION ALL over the same lateral recursive
 * CTE raises ORA-32036 on 19c.
 * @param node - The Repeat select node; `node.repeat` supplies the ordered
 *   list of FHIRPath strings used as the anchor and recursive paths.
 * @param ctx - The current walker context; the inner context is derived from
 *   it by updating `source`, `partitionKeys`, `ancestorApplies`, `spine`, and
 *   `transpilerCtx`.
 * @param walk - The recursive walk function used to visit the inner sub-tree
 *   (`column`, `select`, `unionAll`) in the repeat-item context.
 * @param deps - Schema and table name needed to construct the resource FROM
 *   clause inside the CTE anchor.
 * @returns A Fragment whose `ctes` list begins with the recursive CTE,
 *   `fromExtensions` begins with the INNER JOIN to that CTE (omitted when the
 *   inner sub-tree rebased onto the spine), and `columns` are those produced
 *   by the inner walk.
 * @throws {Error} When `node.repeat` is absent or empty.
 */
export function walkRepeat(
  node: ViewDefinitionSelect,
  ctx: Context,
  walk: (n: ViewDefinitionSelect, c: Context) => Fragment,
  deps: RepeatDeps,
): Fragment {
  const cteAlias = freshAlias(ctx, "repeat");
  const paths = node.repeat ?? [];
  if (paths.length === 0) {
    throw new Error("walkRepeat: repeat node has empty paths array");
  }
  const spine = ctx.spine;

  const tableRef = deps.schemaName
    ? `${deps.schemaName}.${deps.tableName}`
    : deps.tableName;
  // In spine mode the anchor row source is the enclosing repeat CTE plus the
  // forEach APPLY levels recorded between it and this repeat; its `item_json`
  // is expanded by the anchor's JSON_TABLE chain. The spine context already
  // carries every ancestor context column, including the trace levels' own
  // `value`/`scalar` (recorded by forEach's buildInnerCtx).
  const carried = spine ? spine.carried : undefined;
  const cte = buildRepeatCte({
    cteAlias,
    paths,
    source: ctx.source,
    fromClause: spine
      ? `FROM ${spine.baseAlias}`
      : `FROM ${tableRef} ${ctx.resourceAlias}`,
    ancestorApplies: spine
      ? spine.trace.map((t) => t.applyClause).join("")
      : ctx.ancestorApplies,
    partitionKeys: ctx.partitionKeys,
    resourcePredicate: null, // Resource-level WHERE goes in the outer SELECT.
    storage: ctx.transpilerCtx.resourceJsonDataType ?? "BLOB",
    spine: spine
      ? {
          baseAlias: spine.baseAlias,
          traceAliases: spine.trace.map((t) => t.alias),
        }
      : undefined,
    carried,
  });

  // The join keeps only conditions whose defining expression is in scope at
  // the top-level query block. In spine mode the enclosing repeat CTE and
  // trace aliases exist only inside the anchor, so ancestor identity travels
  // in the spine's own columns and only resource-alias conditions survive.
  const joinKeys = spine
    ? ctx.partitionKeys.filter((k) =>
        k.sqlExpr.startsWith(`${ctx.resourceAlias}.`),
      )
    : ctx.partitionKeys;
  const joinClause = buildJoinClause(cteAlias, joinKeys);

  const innerCtx = buildRepeatInnerCtx(
    ctx,
    cteAlias,
    paths,
    joinClause,
    carried,
  );
  const innerNode: ViewDefinitionSelect = {
    column: node.column,
    select: node.select,
    unionAll: node.unionAll,
  };
  const inner = walk(innerNode, innerCtx);

  if (inner.kind === "union" && inner.branches !== undefined) {
    return mergeRepeatUnion({ ...inner, branches: inner.branches }, cte, innerCtx);
  }

  // When the inner sub-tree anchored its own spine CTE on this repeat's CTE,
  // this CTE is already referenced inside that anchor; re-joining it at the
  // top level would raise ORA-32036. The inner fragment's FROM extensions
  // (a join to the spine CTE) take over, and enclosing-scope siblings are
  // rewritten onto the spine by mergeSiblings via the rebase info. When this
  // repeat is itself nested, its own rebase targets are composed through the
  // inner rebase so they land on the deepest spine CTE (the only one still
  // referenced outside the WITH section).
  const innerRebase = inner.rebase;
  const innerRebased = innerRebase?.anchoredBase === cteAlias;
  const ownRebase = spine ? buildRebaseInfo(ctx, cteAlias) : undefined;
  const rebase =
    ownRebase && innerRebase !== undefined && innerRebased
      ? {
          ...ownRebase,
          spineAlias: innerRebase.spineAlias,
          replacements: ownRebase.replacements.map(({ from, to }) => ({
            from,
            to: applyTextReplacements(to, innerRebase.replacements),
          })),
        }
      : ownRebase;
  return {
    ctes: [cte, ...inner.ctes],
    fromExtensions: innerRebased
      ? inner.fromExtensions
      : joinClause + inner.fromExtensions,
    columns: inner.columns,
    partitionKeys: innerCtx.partitionKeys,
    rebase,
  };
}

/**
 * Merges a unionAll sub-tree walked inside this repeat's scope.
 *
 * When every branch shares an identical FROM extension chain (plain column
 * branches over the repeat CTE), the branches are folded into one SELECT: a
 * non-correlated row-duplicating CROSS APPLY assigns each branch a number and
 * a CASE expression picks the branch's projection. A top-level UNION ALL of
 * the branches would reference the lateral recursive CTE once per branch and
 * raise ORA-32036 on 19c (research R4). Branches with their own APPLY chains
 * fall back to the top-level UNION ALL emission (not exercised by the suite;
 * such a query cannot reference the recursive CTE twice on 19c anyway).
 * @param inner - The union Fragment returned by the inner walk.
 * @param cte - This repeat's recursive CTE definition.
 * @param innerCtx - The repeat's inner context (post-recursion scope).
 * @returns A Fragment carrying either the merged single-SELECT projection or
 *   the propagated union branches with the CTE hoisted.
 */
function mergeRepeatUnion(
  inner: Fragment & { branches: Fragment[] },
  cte: CteDefinition,
  innerCtx: Context,
): Fragment {
  const branches = inner.branches;
  const first = branches[0];
  const uniform = branches.every(
    (b) => b.fromExtensions === first.fromExtensions,
  );
  if (uniform) {
    const dupRows = branches
      .map((_, i) => `'${i}' AS b FROM dual`)
      .join(" UNION ALL SELECT ");
    const dupApply = `\nCROSS APPLY (SELECT ${dupRows}) dup`;
    const names: string[] = [];
    for (const branch of branches) {
      for (const column of branch.columns) {
        if (!names.includes(column.name)) names.push(column.name);
      }
    }
    const columns = names.map((name) => {
      const whens = branches
        .map((branch, i) => {
          const column = branch.columns.find((c) => c.name === name);
          return column ? `WHEN '${i}' THEN ${column.sqlExpr}` : null;
        })
        .filter((w) => w !== null)
        .join(" ");
      return {
        name,
        sqlExpr: `CASE dup.b ${whens} ELSE NULL END`,
      };
    });
    const branchCtes = uniqueByAlias(
      branches.flatMap((b) => b.ctes),
    );
    return {
      kind: "rows",
      ctes: [cte, ...branchCtes],
      fromExtensions: first.fromExtensions + dupApply,
      columns,
      partitionKeys: innerCtx.partitionKeys,
    };
  }
  const unionCtes = uniqueByAlias([
    ...inner.ctes,
    ...branches.flatMap((b) => b.ctes),
  ]);
  return {
    kind: "union",
    ctes: [cte, ...unionCtes],
    // The branches already re-establish the enclosing chain via
    // ancestorApplies (which carries this repeat's join); the fragment-level
    // extensions are unused for union fragments.
    fromExtensions: inner.fromExtensions,
    columns: inner.columns,
    partitionKeys: innerCtx.partitionKeys,
    branches: branches.map((branch) => ({
      ...branch,
      ctes: [cte, ...uniqueByAlias(branch.ctes)],
    })),
  };
}
/**
 * Deduplicates CTE definitions by alias, preserving first occurrence order.
 *
 * Union branches fold a shared row-CTE list into every branch; hoisting them
 * into one WITH section must not emit the same alias twice.
 * @param ctes - CTE definitions possibly containing duplicates.
 * @returns Definitions keyed by unique alias, in first-seen order.
 */
function uniqueByAlias(ctes: CteDefinition[]): CteDefinition[] {
  const seen = new Set<string>();
  const out: CteDefinition[] = [];
  for (const cte of ctes) {
    if (seen.has(cte.alias)) continue;
    seen.add(cte.alias);
    out.push(cte);
  }
  return out;
}

function buildJoinClause(cteAlias: string, keys: PartitionKey[]): string {
  const joinConditions = keys
    .map((k) => `${cteAlias}.${k.name} = ${k.sqlExpr}`)
    .join(" AND ");
  return `\nINNER JOIN ${cteAlias} ON ${joinConditions}`;
}

function buildRepeatInnerCtx(
  ctx: Context,
  cteAlias: string,
  paths: string[],
  joinClause: string,
  carried: CarriedColumn[] | undefined,
): Context {
  const newKey: PartitionKey = {
    name: `${cteAlias}_path`,
    sqlExpr: `${cteAlias}.elem_path`,
    sqlType: "VARCHAR2(4000)",
  };
  // `%rowIndex` inside a repeat is the 0-based position within the flattened
  // depth-first traversal. The CTE exposes a padded `elem_order` accumulator whose
  // lexical order matches pre-order; ROW_NUMBER over it (less one) yields the
  // index. Partitioning on the ancestor keys captured before the repeat key is
  // appended (the resource, any enclosing forEach element, and any carried
  // ancestor-repeat identity) restarts the sequence per partition. The window
  // lives in the outer SELECT, which already INNER JOINs the CTE, so the
  // reference is in scope.
  const partitionCols = qualifiedKeyCols(cteAlias, ctx.partitionKeys);
  const partitionClause = partitionCols ? `PARTITION BY ${partitionCols} ` : "";
  const innerTranspilerCtx: TranspilerContext = {
    ...ctx.transpilerCtx,
    iterationContext: `${cteAlias}.item_json`,
    currentForEachAlias: cteAlias,
    forEachSource: ctx.source,
    forEachPath: paths.map((p) => `$.${p}`).join(", "),
    rowIndexExpr: `(ROW_NUMBER() OVER (${partitionClause}ORDER BY ${cteAlias}.elem_order) - 1)`,
  };
  // Columns this CTE exposes for the enclosing scope: its own iteration view
  // plus (re-qualified) everything a deeper spine would need to carry.
  const ownCarried: CarriedColumn[] = [
    {
      name: `${cteAlias}_item_json`,
      sqlExpr: `${cteAlias}.item_json`,
      sqlType: "CLOB",
      origin: `${cteAlias}.item_json`,
    },
    {
      name: `${cteAlias}_item_scalar`,
      sqlExpr: `${cteAlias}.item_scalar`,
      sqlType: "VARCHAR2(4000)",
      origin: `${cteAlias}.item_scalar`,
    },
    {
      name: `${cteAlias}_elem_order`,
      sqlExpr: `${cteAlias}.elem_order`,
      sqlType: "VARCHAR2(4000)",
      origin: `${cteAlias}.elem_order`,
    },
  ];
  const spine: SpineContext = {
    baseAlias: cteAlias,
    carried: [
      ...(carried ?? []).map((c) => ({ ...c, sqlExpr: `${cteAlias}.${c.name}` })),
      ...ownCarried,
    ],
    trace: [],
  };
  // Propagate the join into ancestorApplies so any *nested* Repeat builds
  // its CTE anchor with this CTE in scope.
  return {
    ...ctx,
    source: `${cteAlias}.item_json`,
    partitionKeys: [...ctx.partitionKeys, newKey],
    ancestorApplies: ctx.ancestorApplies + joinClause,
    transpilerCtx: innerTranspilerCtx,
    spine,
  };
}

/**
 * Builds the rebase info a spine repeat hands to `mergeSiblings`: sibling
 * fragments in the enclosing scope are re-pointed from the outer repeat CTE
 * (and trace aliases) onto the spine CTE's carried columns, and their JOIN
 * clauses referencing those aliases are dropped.
 * @param ctx
 * @param cteAlias
 */
function buildRebaseInfo(ctx: Context, cteAlias: string): RebaseInfo {
  const spine = ctx.spine;
  if (!spine) {
    throw new Error("walkRepeat: buildRebaseInfo requires a spine context");
  }
  const base = spine.baseAlias;
  const replacements: Array<{ from: string; to: string }> = [];
  for (const k of ctx.partitionKeys) {
    // The original defining-scope expression (e.g. "r.id", "forEach_1.idx")
    // and the base CTE-qualified form (e.g. "repeat_0.id") both occur in
    // sibling SQL; the spine CTE projects every key under its name.
    replacements.push({ from: k.sqlExpr, to: `${cteAlias}.${k.name}` }, {
      from: `${base}.${k.name}`,
      to: `${cteAlias}.${k.name}`,
    });
  }
  replacements.push({
    from: `${base}.elem_path`,
    to: `${cteAlias}.${base}_path`,
  }, {
    from: `${base}.elem_order`,
    to: `${cteAlias}.${base}_elem_order`,
  }, {
    from: `${base}.item_json`,
    to: `${cteAlias}.${base}_item_json`,
  }, {
    from: `${base}.item_scalar`,
    to: `${cteAlias}.${base}_item_scalar`,
  });
  for (const c of spine.carried) {
    // The original ancestor-level form (composition target: an outer spine's
    // own rebase points at this base-qualified form) and the base CTE's own
    // qualified reference both occur in sibling SQL.
    replacements.push({ from: c.origin, to: `${cteAlias}.${c.name}` }, {
      from: `${base}.${c.name}`,
      to: `${cteAlias}.${c.name}`,
    });
  }
  for (const t of spine.trace) {
    for (const col of ["idx", "value", "scalar"] as const) {
      replacements.push({
        from: `${t.alias}.${col}`,
        to: `${cteAlias}.${t.alias}_${col}`,
      });
    }
  }
  return {
    spineAlias: cteAlias,
    anchoredBase: base,
    ancestorAliases: [base, ...spine.trace.map((t) => t.alias)],
    replacements,
  };
}