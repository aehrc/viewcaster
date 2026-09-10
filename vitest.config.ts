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

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "!src/tests/**", "!src/loader/**"],
    // Database operations against live Oracle can be slow.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/generated/**",
        "src/tests/**",
      ],
      reportOnFailure: true,
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    // Custom reporter writes the SQL on FHIR compliance report to
    // out/test-report.json.
    reporters: ["default", "src/tests/utils/reporter"],
    // Parallel test execution with a thread pool.
    pool: "threads",
    poolOptions: {
      threads: {
        // Up to 16 concurrent threads (below the database connection pool max).
        maxThreads: 16,
        minThreads: 4,
      },
    },
    // Each test file's beforeAll sets up its own connection pool, and
    // it.concurrent() provides test-level parallelism.
    // Prevent test suite failure when all tests are filtered out.
    passWithNoTests: true,
  },
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      "@": "/src",
    },
  },
});
