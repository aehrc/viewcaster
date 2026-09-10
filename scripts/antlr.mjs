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

/*
 * Regenerates the FHIRPath parser from grammar/fhirpath.g4 with antlr4ts, then
 * prepends a `@ts-nocheck` banner to each generated TypeScript file. The
 * antlr4ts output carries unused imports and locals that fail the project's
 * `noUnusedLocals` setting; generated code is not otherwise checked or linted.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputDirectory = "src/generated";
const grammarDirectory = path.join(outputDirectory, "grammar");
const banner = "// @ts-nocheck\n";

const result = spawnSync(
  "antlr4ts",
  ["-visitor", "grammar/fhirpath.g4", "-o", outputDirectory],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  throw new Error(`antlr4ts exited with status ${String(result.status)}`);
}

for (const file of readdirSync(grammarDirectory)) {
  if (!file.endsWith(".ts")) {
    continue;
  }
  const filePath = path.join(grammarDirectory, file);
  const content = readFileSync(filePath, "utf8");
  if (!content.startsWith(banner)) {
    writeFileSync(filePath, banner + content);
  }
}
