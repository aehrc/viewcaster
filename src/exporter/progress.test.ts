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
 * Unit tests for exporter progress reporting: the running status line must
 * account for rows written to the file in flight, not just completed files.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createExportProgress,
  formatExportProgressStatus,
  printExportSummary,
} from "./progress.js";

describe("formatExportProgressStatus", () => {
  it("reports no progress for a tracker that has not started", () => {
    const status = formatExportProgressStatus(createExportProgress(2));
    expect(status).toContain("[0/2 files (0%)]");
    expect(status).toContain("0 rows written");
  });

  it("counts rows of the file in flight towards the running total", () => {
    const progress = createExportProgress(2);
    progress.filesCompleted = 1;
    progress.totalRowsWritten = 2000;
    progress.currentResourceType = "Observation";
    progress.currentRowsWritten = 500;

    const status = formatExportProgressStatus(progress);
    expect(status).toContain("[1/2 files (50%)]");
    expect(status).toContain("Observation");
    // 2000 completed plus 500 in flight; a total that ignored the file in
    // flight would stall visibly on a table with one large resource type.
    expect(status).toContain("2500 rows written");
  });
});

describe("printExportSummary", () => {
  it("reports the files, the row total and the duration", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printExportSummary({
        files: [
          {
            resourceType: "Patient",
            path: "/out/Patient.ndjson",
            rowsWritten: 3,
          },
          {
            resourceType: "Observation",
            path: "/out/Observation.ndjson",
            rowsWritten: 7,
          },
        ],
        totalRows: 10,
        durationMs: 1500,
      });
      const output = logSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(output).toContain("Patient: 3 rows written");
      expect(output).toContain("Observation: 7 rows written");
      expect(output).toContain("Total rows written: 10");
      expect(output).toContain("1s");
    } finally {
      logSpy.mockRestore();
    }
  });
});
