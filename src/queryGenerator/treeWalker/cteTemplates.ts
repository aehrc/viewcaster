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
 * SQL string templates for the recursive CTE produced by `repeat`.
 *
 * The Oracle form unrolls each level with a chained CROSS APPLY JSON_TABLE
 * (sources after the first wrapped in JSON_QUERY, per the ORA-40556 spike
 * finding) instead of OPENJSON. The `elem_order` accumulator uses LPAD over the
 * FOR ORDINALITY column so lexical ordering matches depth-first (pre-order)
 * traversal.
 */

import { jsonTableColumns } from "../../fhirpath/visitor.js";

import type { CarriedColumn, CteDefinition, PartitionKey } from "./types.js";

export interface BuildRepeatCteArgs {
  cteAlias: string;
  /** FHIRPath strings - first is the anchor path; all are recursive paths. */
  paths: string[];
  /** JSON source expression for the anchor (e.g. "r.json", "forEach_0.value"). */
  source: string;
  /** "FROM <table> r" - the resource table reference for the anchor. */
  fromClause: string;
  /** CROSS/OUTER APPLY chain inherited from ancestors (each starts with "\n"). */
  ancestorApplies: string;
  /** Partition keys propagated through anchor and recursive members. */
  partitionKeys: PartitionKey[];
  /**
   * Spine mode (research R4): the anchor reads an enclosing repeat CTE
   * (`FROM <baseAlias>`) instead of the resource table. `baseAlias` and the
   * trace APPLY aliases are the only outer expressions in scope for anchor
   * projections; partition key expressions referencing anything else are
   * re-pointed at the base CTE's own projection of that key.
   */
  spine?: { baseAlias: string; traceAliases: string[] };
  /** Ancestor context columns carried through anchor and recursive members. */
  carried?: CarriedColumn[];
  resourcePredicate: string | null;
  /** The JSON storage type the query targets. */
  storage: "BLOB" | "JSON";
}

/**
 * Builds the SQL body of the recursive CTE used by the Repeat operator.
 *
 * Produces a `CteDefinition` whose body is an anchor SELECT followed by one
 * `UNION ALL` recursive SELECT per path in `args.paths`. The anchor starts
 * at the resource root and expands each array element via `JSON_TABLE`; each
 * recursive member re-expands from the CTE's own `item_json` column, appending
 * the element index to the `elem_path` accumulator for stable per-element
 * identity. Multi-segment paths (e.g. `"a.b.c"`) produce a chain of nested
 * `CROSS APPLY JSON_TABLE` calls.
 * @param args - Parameters controlling CTE generation.
 * @returns A `CteDefinition` with `alias` set to `args.cteAlias` and `body`
 *   containing the full anchor + recursive SQL (without the outer
 *   `alias AS (...)` wrapper, which `renderRoot` adds).
 */
export function buildRepeatCte(args: BuildRepeatCteArgs): CteDefinition {
  const anchor = buildAnchorMember(args);
  const recBlock = buildRecursiveMember(args);
  const body = `${anchor}
  UNION ALL
${recBlock}`;
  const columnList = args.partitionKeys
    .map((k) => k.name)
    .concat((args.carried ?? []).map((c) => c.name))
    .concat("elem_path", "elem_order", "item_json", "item_scalar", "depth")
    .join(", ");
  const cycleClause = `CYCLE ${args.partitionKeys
    .map((k) => k.name)
    .join(", ")}, elem_path SET cyc TO '1' DEFAULT '0'`;
  return { alias: args.cteAlias, body, columnList, cycleClause };
}

function buildAnchorMember(args: BuildRepeatCteArgs): string {
  const {
    paths,
    source,
    fromClause,
    ancestorApplies,
    partitionKeys,
    resourcePredicate,
    storage,
  } = args;
  const spine = args.spine;
  const scopeAliases = spine
    ? [spine.baseAlias, ...spine.traceAliases]
    : null;
  const keyLines = partitionKeys.map((k) => {
    if (scopeAliases === null || spine === undefined) {
      return `${k.sqlExpr} AS ${k.name}`;
    }
    const lead = /^([A-Za-z0-9_]+)\./.exec(k.sqlExpr)?.[1];
    const inScope = lead !== undefined && scopeAliases.includes(lead);
    // A key defined above the spine (e.g. the resource `id`) re-points at the
    // base CTE's own projection of that key; keys defined at the base or at a
    // trace APPLY level are already in anchor scope.
    return `${inScope ? k.sqlExpr : `${spine.baseAlias}.${k.name}`} AS ${k.name}`;
  });
  const carriedLines = (args.carried ?? []).map(
    (c) => `${c.sqlExpr} AS ${c.name}`,
  );
  const projLines = [...keyLines, ...carriedLines].join(",\n    ");
  const chain = buildJsonTableChain(source, paths[0], "anchor", storage);
  const wherePart = resourcePredicate ? `\n  ${resourcePredicate}` : "";

  return `  SELECT
    ${projLines},
    CAST(${chain.lastAlias}.idx AS VARCHAR2(4000)) AS elem_path,
    ${orderSegment(chain.lastAlias)} AS elem_order,
    ${chain.lastAlias}.value AS item_json,
    ${chain.lastAlias}.scalar AS item_scalar,
    0 AS depth
  ${fromClause}${ancestorApplies}
  ${chain.applyClauses}${wherePart}`;
}

function buildRecursiveMember(args: BuildRepeatCteArgs): string {
  const { cteAlias, partitionKeys, storage, paths } = args;
  const head = qualifiedKeyCols("cte", partitionKeys);
  const carried = (args.carried ?? [])
    .map((c) => `cte.${c.name}`)
    .join(", ");
  const carriedPart = carried ? `,\n    ${carried}` : "";
  const fmt = storage === "BLOB" ? " FORMAT JSON" : "";
  const chains = paths
    .map(
      (path) =>
        `      SELECT child.value AS v, child.idx AS idx, child.scalar AS scalar
        FROM JSON_TABLE(cte.item_json${fmt}, '$.${path}[*]' COLUMNS (idx FOR ORDINALITY, value CLOB${fmt} PATH '$', scalar VARCHAR2(4000) PATH '$')) child`,
    )
    .join("\n      UNION ALL\n");
  return `  SELECT
    ${head}${carriedPart},
    cte.elem_path || '.' || CAST(u.idx AS VARCHAR2(4000)) AS elem_path,
    cte.elem_order || '.' || LPAD(CAST(u.idx AS VARCHAR2(10)), 10, '0') AS elem_order,
    u.v AS item_json,
    u.scalar AS item_scalar,
    cte.depth + 1
  FROM ${cteAlias} cte
  CROSS APPLY (
${chains}
  ) u`;
}

/**
 * Width, in characters, that each `elem_order` segment is zero-padded to. A level
 * with up to 10^ORDER_SEGMENT_WIDTH elements still sorts correctly; ten digits
 * assume no single level exceeds 10^10 elements.
 */
const ORDER_SEGMENT_WIDTH = 10;

/**
 * Builds one segment of the `elem_order` accumulator: the element's ordinality
 * zero-padded to a fixed width so that lexical ordering of the `.`-joined
 * order string is equivalent to numeric depth-first (pre-order) traversal.
 * This is what `%rowIndex` orders by inside a `repeat`.
 * @param alias - The JSON_TABLE alias providing the `idx` column.
 * @returns An SQL expression yielding the zero-padded order segment.
 */
function orderSegment(alias: string): string {
  return `LPAD(CAST(${alias}.idx AS VARCHAR2(${ORDER_SEGMENT_WIDTH})), ${ORDER_SEGMENT_WIDTH}, '0')`;
}

/**
 * Renders the partition keys as a comma-separated list of unquoted columns
 * qualified by `alias` (e.g. `cte.id, cte.fe_0_idx`). Shared by the
 * recursive-member projection and the repeat `%rowIndex` window's PARTITION
 * BY.
 * @param alias - The alias qualifying the keys.
 * @param keys - The partition keys.
 * @returns The qualified column list.
 */
export function qualifiedKeyCols(alias: string, keys: PartitionKey[]): string {
  return keys.map((k) => `${alias}.${k.name}`).join(", ");
}

/**
 * Builds the CROSS APPLY JSON_TABLE chain for a (possibly multi-segment)
 * path. For "a.b.c" produces three chained APPLYs; intermediate levels consume
 * the previous level's `value` column wrapped in JSON_QUERY (ORA-40556); the
 * last alias is `finalAlias`.
 * @param source - The JSON source expression for the first level.
 * @param path - The dotted path below the source.
 * @param finalAlias - The alias of the last level.
 * @param storage - The targeted JSON storage type.
 * @returns The APPLY clauses and the last alias.
 */
function buildJsonTableChain(
  source: string,
  path: string,
  finalAlias: string,
  storage: "BLOB" | "JSON",
): { applyClauses: string; lastAlias: string } {
  const segments = path.split(".");
  const fmt = storage === "BLOB" ? " FORMAT JSON" : "";
  const columns = jsonTableColumns(storage);

  // A JSON_TABLE-produced column (an APPLY alias's `value`, or a repeat CTE's
  // `item_json`) cannot be consumed directly by another JSON_TABLE
  // (ORA-40556): the first path segment moves into a JSON_QUERY wrap.
  const wrapsSource = /\.value$/.test(source) || /\.item_json$/.test(source);

  let chain = "";
  let currentSource = source;
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const alias = isLast ? finalAlias : `${finalAlias}_${i}`;
    if (i > 0) chain += "\n  ";
    if (i === 0) {
      chain += wrapsSource
        ? `CROSS APPLY JSON_TABLE(JSON_QUERY(${currentSource}${fmt}, '$.${segments[i]}' RETURNING CLOB), '$[*]' COLUMNS (${columns})) ${alias}`
        : `CROSS APPLY JSON_TABLE(${currentSource}${fmt}, '$.${segments[i]}[*]' COLUMNS (${columns})) ${alias}`;
    } else {
      chain += `\n  CROSS APPLY JSON_TABLE(JSON_QUERY(${currentSource}, '$.${segments[i]}' RETURNING CLOB), '$[*]' COLUMNS (${columns})) ${alias}`;
    }
    currentSource = `${alias}.value`;
  }
  return { applyClauses: chain, lastAlias: finalAlias };
}
