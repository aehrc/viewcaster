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

import {
  type CteDefinition,
  type PartitionKey,
} from "./types.js";
import { jsonTableColumns } from "../../fhirpath/visitor.js";

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
  /** Resource-level WHERE applied to the anchor (or null to omit). */
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
 *
 * @param args - Parameters controlling CTE generation.
 * @returns A `CteDefinition` with `alias` set to `args.cteAlias` and `body`
 *   containing the full anchor + recursive SQL (without the outer
 *   `alias AS (...)` wrapper, which `renderRoot` adds).
 */
export function buildRepeatCte(args: BuildRepeatCteArgs): CteDefinition {
  const anchor = buildAnchorMember(args);
  const recBlocks = args.paths.map((p, i) => buildRecursiveMember(args, p, i));
  const body = `${anchor}
  UNION ALL
${recBlocks.join("\n  UNION ALL\n")}`;
  const columnList = args.partitionKeys
    .map((k) => k.name)
    .concat("elem_path", "elem_order", "item_json", "item_scalar", "cyc", "depth")
    .join(", ");
  const cycleClause = `CYCLE ${args.partitionKeys
    .map((k) => `${args.cteAlias}.${k.name}`)
    .join(", ")}, ${args.cteAlias}.elem_path SET cyc TO '1' DEFAULT '0'`;
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
  const projLines = partitionKeys
    .map((k) => `${k.sqlExpr} AS ${k.name}`)
    .join(",\n    ");
  const chain = buildJsonTableChain(source, paths[0], "anchor", storage);
  const wherePart = resourcePredicate ? `\n  ${resourcePredicate}` : "";

  return `  SELECT
    ${projLines},
    CAST(${chain.lastAlias}.idx AS VARCHAR2(4000)) AS elem_path,
    ${orderSegment(chain.lastAlias)} AS elem_order,
    ${chain.lastAlias}.value AS item_json,
    ${chain.lastAlias}.scalar AS item_scalar,
    '0' AS cyc,
    0 AS depth
  ${fromClause}${ancestorApplies}
  ${chain.applyClauses}${wherePart}`;
}

function buildRecursiveMember(
  args: BuildRepeatCteArgs,
  path: string,
  index: number,
): string {
  const { cteAlias, partitionKeys, storage } = args;
  const head = qualifiedKeyCols("cte", partitionKeys);
  const chain = buildJsonTableChain(
    "cte.item_json",
    path,
    `child_${index}`,
    storage,
  );
  return `  SELECT
    ${head},
    cte.elem_path || '.' || CAST(${chain.lastAlias}.idx AS VARCHAR2(4000)) AS elem_path,
    cte.elem_order || '.' || ${orderSegment(chain.lastAlias)} AS elem_order,
    ${chain.lastAlias}.value AS item_json,
    ${chain.lastAlias}.scalar AS item_scalar,
    '0' AS cyc,
    cte.depth + 1
  FROM ${cteAlias} cte
  ${chain.applyClauses}`;
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
 *
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
 *
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
 *
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
  if (segments.length === 1) {
    return {
      applyClauses: `CROSS APPLY JSON_TABLE(${source}${fmt}, '$.${segments[0]}[*]' COLUMNS (${jsonTableColumns(storage)})) ${finalAlias}`,
      lastAlias: finalAlias,
    };
  }

  let chain = "";
  let currentSource = source;
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const alias = isLast ? finalAlias : `${finalAlias}_${i}`;
    if (i > 0) chain += "\n  ";
    const columns = jsonTableColumns(storage);
    const tableInput = i === 0
      ? `${currentSource}${fmt}`
      : `JSON_QUERY(${currentSource} RETURNING CLOB)`;
    chain += `CROSS APPLY JSON_TABLE(${tableInput}, '$.${segments[i]}[*]' COLUMNS (${columns})) ${alias}`;
    currentSource = `${alias}.value`;
  }
  return { applyClauses: chain, lastAlias: finalAlias };
}
