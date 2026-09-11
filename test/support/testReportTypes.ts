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
 * Type definitions for test reporting.
 *
 * Matches the SQL on FHIR test report schema:
 * https://raw.githubusercontent.com/FHIR/sql-on-fhir.js/refs/heads/main/test_report/test-report.schema.json
 */

export interface TestReportEntry {
  /** The name/description of the test case. */
  name: string;
  /** The test execution result. */
  result: {
    /** Whether the test passed (true) or failed (false). */
    passed: boolean;
    /** Optional error message if the test failed. */
    error?: string;
    /** Optional additional details about the test result. */
    details?: Record<string, unknown>;
  };
}

export interface TestReportSuite {
  /** Array of test cases within this test suite. */
  tests: TestReportEntry[];
}

export interface TestReport {
  /**
   * Each property represents a test suite file (e.g., 'basic.json', 'common.json').
   * The report should be a flat object where each key represents a test suite file.
   */
  [suiteName: string]: TestReportSuite;
}
