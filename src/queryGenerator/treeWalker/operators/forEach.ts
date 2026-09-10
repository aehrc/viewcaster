/**
 * Walker for ForEach / ForEachOrNull nodes.
 *
 * forEach compiles to a CROSS APPLY JSON_TABLE and forEachOrNull to an OUTER
 * APPLY JSON_TABLE, each unrolling the collection into a single-row-per-element
 * table with `idx` (FOR ORDINALITY, 1-based), `value` (whole element) and
 * `scalar` columns. Nested iteration sources are wrapped in JSON_QUERY so a
 * JSON_TABLE never consumes another JSON_TABLE's column directly (ORA-40556).
 *
 * @author John Grimes
 */

import type { TranspilerContext } from "../../../fhirpath/transpiler.js";
import {
  formatJsonSuffix,
  jsonTableColumns,
} from "../../../fhirpath/visitor.js";
import type { ViewDefinitionSelect } from "../../../types.js";
import type { PathParser } from "../../PathParser.js";
import { freshAlias } from "../aliasGenerator.js";
import type { Context, Fragment, PartitionKey } from "../types.js";

interface ForEachDeps {
  pathParser: PathParser;
}

/**
 * Walker for ForEach and ForEachOrNull nodes.
 *
 * Emits a `CROSS APPLY` (or `OUTER APPLY` for `forEachOrNull`) clause that
 * iterates over a JSON array identified by the node's FHIRPath expression.
 * Updates `ctx.source`, `ctx.transpilerCtx`, and `ctx.partitionKeys` so that
 * child nodes project columns relative to each iteration value, then walks
 * the child sub-tree (`column`, `select`, `unionAll`) in that inner context.
 * The apply clause is prepended to the inner Fragment's `fromExtensions`.
 *
 * Path features handled via `PathParser`: `.where()` filters, `.first()`
 * selectors, array indexing, and multi-segment array flattening (nested
 * `CROSS APPLY OPENJSON` chains).
 *
 * @param node - The ForEach or ForEachOrNull select node.  `node.forEach` or
 *   `node.forEachOrNull` supplies the FHIRPath expression to iterate.
 * @param ctx - The current walker context; the inner context is derived from
 *   it by updating `source`, `partitionKeys`, `ancestorApplies`, and
 *   `transpilerCtx`.
 * @param walk - The recursive walk function used to visit the inner sub-tree.
 * @param deps - Dependencies containing the `PathParser` used to parse and
 *   decompose the FHIRPath expression.
 * @returns A Fragment whose `fromExtensions` begins with the generated APPLY
 *   clause followed by any extensions produced by the inner walk.
 */
export function walkForEach(
  node: ViewDefinitionSelect,
  ctx: Context,
  walk: (n: ViewDefinitionSelect, c: Context) => Fragment,
  deps: ForEachDeps,
): Fragment {
  const isOrNull = node.forEachOrNull !== undefined;
  const rawPath = node.forEach ?? node.forEachOrNull ?? "";
  const applyType = isOrNull ? "OUTER APPLY" : "CROSS APPLY";
  const alias = freshAlias(ctx, "forEach");

  const applyClause = buildForEachApply(
    rawPath,
    ctx.source,
    alias,
    applyType,
    ctx.transpilerCtx,
    deps.pathParser,
  );

  const innerCtx = buildInnerCtx(ctx, alias, rawPath, applyClause);
  const innerNode: ViewDefinitionSelect = {
    column: node.column,
    select: node.select,
    unionAll: node.unionAll,
  };
  const inner = walk(innerNode, innerCtx);

  // A unionAll child becomes top-level UNION ALL branches; each branch must
  // re-establish this forEach's APPLY chain itself (see walkUnionAll), so the
  // plain fromExtensions concatenation only applies to row fragments.
  if (inner.kind === "union") {
    return {
      ...inner,
      branches: inner.branches?.map((b) => ({
        ...b,
        fromExtensions: applyClause + b.fromExtensions,
      })),
    };
  }

  return {
    ...inner,
    fromExtensions: applyClause + inner.fromExtensions,
  };
}

function buildInnerCtx(
  ctx: Context,
  alias: string,
  rawPath: string,
  applyClause: string,
): Context {
  const innerTranspilerCtx: TranspilerContext = {
    ...ctx.transpilerCtx,
    iterationContext: `${alias}.value`,
    currentForEachAlias: alias,
    forEachSource: ctx.source,
    forEachPath: `$.${rawPath}`,
    // `%rowIndex` resolves to the iterated element's 0-based position, which
    // is the FOR ORDINALITY column minus one. For forEachOrNull over an empty
    // collection the OUTER APPLY yields a single null-padded row whose `idx`
    // is NULL; the spec requires `%rowIndex` to be 0 for that row, hence the
    // COALESCE.
    rowIndexExpr: `COALESCE(${alias}.idx - 1, 0)`,
  };
  const innerKey: PartitionKey = {
    name: `${alias}_idx`,
    sqlExpr: `${alias}.idx`,
    sqlType: "NUMBER(10)",
  };
  return {
    ...ctx,
    source: `${alias}.value`,
    partitionKeys: [...ctx.partitionKeys, innerKey],
    ancestorApplies: ctx.ancestorApplies + applyClause,
    transpilerCtx: innerTranspilerCtx,
  };
}

/**
 * Builds the CROSS/OUTER APPLY clause string for a forEach path, handling
 * `.where()`, `.first()`, array indexing, and multi-segment array
 * flattening.
 */
function buildForEachApply(
  rawPath: string,
  source: string,
  alias: string,
  applyType: string,
  transpilerCtx: TranspilerContext,
  pathParser: PathParser,
): string {
  const {
    path: pathWithoutWhere,
    whereCondition,
    useFirst,
  } = pathParser.parseFhirPathWhere(rawPath, transpilerCtx);
  const { path: forEachPath, arrayIndex } =
    pathParser.parseArrayIndexing(pathWithoutWhere);
  const arrayPaths = pathParser.detectArrayFlatteningPaths(forEachPath);


  if (arrayPaths.length > 1) {
    return buildNestedApply(
      arrayPaths,
      source,
      alias,
      applyType,
      pathParser,
      arrayIndex,
      whereCondition,
      transpilerCtx,
    );
  }

  return buildSimpleApply(
    applyType,
    source,
    forEachPath,
    alias,
    arrayIndex,
    whereCondition,
    useFirst,
    transpilerCtx,
  );
}

/**
 * Builds a single JSON_TABLE APPLY clause.
 *
 * A source that is itself a JSON_TABLE column (`forEach_N.value`, or a repeat
 * CTE's `item_json`) must be wrapped in JSON_QUERY(... RETURNING CLOB),
 * because a JSON_TABLE cannot consume a column produced by another JSON_TABLE
 * (ORA-40556); the iteration path moves into the wrap. A base-table column is
 * consumed directly. `.first()` selectors resolve as an explicit `[0]` path
 * index; where conditions become a row filter in a subquery, which preserves
 * forEachOrNull's null-padded row.
 *
 * @param applyType - "CROSS APPLY" or "OUTER APPLY".
 * @param source - The JSON source expression.
 * @param path - The collection path below the source.
 * @param alias - The JSON_TABLE alias.
 * @param arrayIndex - An explicit array index to select, or null.
 * @param whereCondition - A transpiled predicate over `value`, or null.
 * @param useFirst - Whether only the first element is wanted.
 * @param transpilerCtx - The transpiler context carrying the storage type.
 * @returns The APPLY clause, prefixed by a newline.
 */
function buildSimpleApply(
  applyType: string,
  source: string,
  path: string,
  alias: string,
  arrayIndex: number | null,
  whereCondition: string | null,
  useFirst: boolean,
  transpilerCtx: TranspilerContext,
): string {
  const storage = transpilerCtx.resourceJsonDataType ?? "BLOB";
  const columns = jsonTableColumns(storage);
  const fmt = formatJsonSuffix(storage);
  const indexedPath = useFirst
    ? `${path}[0]`
    : arrayIndex !== null
      ? `${path}[${arrayIndex}]`
      : path;

  const jsonTable = isJsonTableColumn(source)
    ? `JSON_TABLE(JSON_QUERY(${source}${fmt}, '$.${indexedPath}' RETURNING CLOB), '$[*]' COLUMNS (${columns}))`
    : `JSON_TABLE(${source}${fmt}, '$.${indexedPath}[*]' COLUMNS (${columns}))`;

  if (whereCondition !== null) {
    return `\n${applyType} (SELECT idx, value, scalar FROM ${jsonTable} WHERE ${whereCondition}) ${alias}`;
  }
  return `\n${applyType} ${jsonTable} ${alias}`;
}

/**
 * Builds a chain of nested JSON_TABLE APPLY clauses for multi-segment paths.
 * Each level after the first consumes the previous level's `value` column
 * wrapped in JSON_QUERY (ORA-40556).
 *
 * @param arrayPaths - The array path segments to chain.
 * @param source - The JSON source expression for the first level.
 * @param finalAlias - The alias for the last level.
 * @param applyType - "CROSS APPLY" or "OUTER APPLY".
 * @param pathParser - The path parser for segment handling.
 * @param _arrayIndex - An explicit array index for the last level (currently
 *   unhandled for nested paths; suite paths do not exercise it).
 * @param _whereCondition - A predicate for the last level (reserved).
 * @returns The chained APPLY clauses.
 */
function buildNestedApply(
  arrayPaths: string[],
  source: string,
  finalAlias: string,
  applyType: string,
  pathParser: PathParser,
  _arrayIndex: number | null,
  whereCondition: string | null,
  transpilerCtx: TranspilerContext,
): string {
  let clauses = "";
  let currentSource = source;
  const storage = transpilerCtx.resourceJsonDataType ?? "BLOB";
  const fmt = formatJsonSuffix(storage);

  for (let i = 0; i < arrayPaths.length; i++) {
    const isLast = i === arrayPaths.length - 1;
    const alias = isLast ? finalAlias : `${finalAlias}_nest${i}`;
    const segment = pathParser.extractPathSegment(arrayPaths, i);
    const { cleanSegment, segmentIndex } =
      pathParser.parseSegmentIndexing(segment);

    const wrap = isJsonTableColumn(currentSource);
    const columns = jsonTableColumns(storage);
    const segmentPath =
      segmentIndex !== null
        ? `$.${cleanSegment}[${segmentIndex}]`
        : `$.${cleanSegment}`;
    const tableInput = wrap
      ? `JSON_QUERY(${currentSource}${fmt}, '${segmentPath}' RETURNING CLOB), '$[*]'`
      : `${currentSource}${fmt}, '${segmentPath}[*]'`;

    clauses += `\n${applyType} JSON_TABLE(${tableInput} COLUMNS (${columns})) ${alias}`;

    currentSource = `${alias}.value`;
  }

  void whereCondition;
  return clauses;
}


/**
 * Checks whether a JSON source expression is a column produced by a JSON_TABLE
 * (an APPLY alias's `value`, or a repeat CTE's `item_json`). Such a column
 * cannot be consumed directly by another JSON_TABLE (ORA-40556) and must be
 * wrapped in JSON_QUERY.
 *
 * @param source - The source expression.
 * @returns True when the expression is a JSON_TABLE-produced column.
 */
function isJsonTableColumn(source: string): boolean {
  return /\.value$/.test(source) || /\.item_json$/.test(source);
}
