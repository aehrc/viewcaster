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
 * Public entry point for the tree-walker query generator.
 *
 * Wraps viewDef.select as a synthetic Group node, walks it, and renders
 * the resulting Fragment as a single Oracle SELECT statement.
 * @author John Grimes
 */

import {
  Transpiler,
  type TranspilerContext,
} from "../../fhirpath/transpiler.js";
import { ColumnExpressionGenerator } from "../ColumnExpressionGenerator.js";
import { PathParser } from "../PathParser.js";
import { WhereClauseBuilder } from "../WhereClauseBuilder.js";
import { renderRoot } from "./render.js";
import { type Context, type PartitionKey, SQL_INT } from "./types.js";
import { makeWalker } from "./walker.js";

import type {
  ColumnInfo,
  TranspilationResult,
  ViewDefinition,
  ViewDefinitionSelect,
} from "../../types.js";

const columnGenerator = new ColumnExpressionGenerator();
const pathParser = new PathParser();
const whereClauseBuilder = new WhereClauseBuilder();

export interface CompileOptions {
  tableName: string;
  schemaName: string;
  testId?: string;
  transpilerCtx: TranspilerContext;
}

/**
 * Compiles a ViewDefinition into an Oracle SQL query string and column
 * metadata.
 * @param viewDef - The ViewDefinition to compile.
 * @param options - Compilation options including table/schema names and transpiler context.
 * @returns The SQL query string and column metadata.
 */
export function compileViewDefinition(
  viewDef: ViewDefinition,
  options: CompileOptions,
): TranspilationResult {
  const resourceAlias = options.transpilerCtx.resourceAlias;
  const ctx = buildRootContext(resourceAlias, options.transpilerCtx);

  const rootNode: ViewDefinitionSelect = { select: viewDef.select };
  const walk = makeWalker({
    columnGenerator,
    pathParser,
    schemaName: options.schemaName,
    tableName: options.tableName,
  });
  const fragment = walk(rootNode, ctx);

  const sql = renderRoot(fragment, viewDef, {
    resourceAlias,
    schemaName: options.schemaName,
    tableName: options.tableName,
    testId: options.testId,
    whereClauseBuilder,
    transpilerCtx: options.transpilerCtx,
  });

  return { sql, columns: collectColumnMetadata(viewDef.select) };
}

function buildRootContext(
  resourceAlias: string,
  transpilerCtx: TranspilerContext,
): Context {
  const idKey: PartitionKey = {
    name: "id",
    sqlExpr: `${resourceAlias}.id`,
    sqlType: SQL_INT,
  };
  return {
    resourceAlias,
    source: `${resourceAlias}.${transpilerCtx.resourceJsonColumn ?? "json"}`,
    partitionKeys: [idKey],
    ancestorApplies: "",
    cteCounter: { value: 0 },
    transpilerCtx,
  };
}

/**
 * Walk the select tree and collect ColumnInfo metadata in lexical order.
 * Mirrors the behaviour of QueryGenerator.collectAllColumns so the public
 * TranspilationResult.columns shape is unchanged.
 * @param selects - The select items to collect column metadata from.
 * @returns Array of ColumnInfo objects in lexical order.
 */
function collectColumnMetadata(selects: ViewDefinitionSelect[]): ColumnInfo[] {
  const out: ColumnInfo[] = [];
  for (const select of selects) {
    if (select.column) {
      for (const column of select.column) {
        out.push({
          name: column.name,
          type: Transpiler.inferSqlType(column.type, column.tag),
          nullable: true,
          description: column.description,
        });
      }
    }
    if (select.select) out.push(...collectColumnMetadata(select.select));
    if (select.unionAll) out.push(...collectColumnMetadata(select.unionAll));
  }
  return out;
}
