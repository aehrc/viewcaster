/*
 * Scratch script: try candidate SQL forms for the nested extension chain
 * against the configured Oracle container.
 *
 * @author John Grimes
 */
import { readFileSync } from "node:fs";
import {
  createTestTable,
  dropTestTable,
  insertTestResourceReturningId,
  openTestConnection,
} from "./test/testDatabase";

const suite = JSON.parse(readFileSync("sqlonfhir/tests/fn_extension.json", "utf8"));
const connection = await openTestConnection();
const testId = `scratch-fnext2-${Date.now()}`;
await dropTestTable(connection, "sof_scratch_resources");
await createTestTable(connection, "BLOB", "sof_scratch_resources");
try {
  for (const resource of suite.resources) {
    await insertTestResourceReturningId(
      connection,
      resource,
      testId,
      "BLOB",
      "sof_scratch_resources",
    );
  }

  const candidates: Record<string, string> = {
    // Option B: rewrite the inner subquery's projection to JSON_QUERY the
    // extension array; outer JSON_TABLE iterates $[*].
    optionB: `SELECT
  CAST(JSON_VALUE(r.json FORMAT JSON, '$.id' RETURNING VARCHAR2(4000)) AS VARCHAR2(64)) AS "id",
  (SELECT JSON_VALUE(value FORMAT JSON, '$.valueCoding.code' RETURNING VARCHAR2(4000)) FROM JSON_TABLE(
    (SELECT JSON_QUERY(value, '$.extension' RETURNING CLOB) FROM JSON_TABLE(r.json FORMAT JSON, '$.extension[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$', scalar VARCHAR2(4000) PATH '$')) WHERE JSON_VALUE(value FORMAT JSON, '$.url' RETURNING VARCHAR2(4000)) = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race' AND ROWNUM = 1)
    FORMAT JSON, '$[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$', scalar VARCHAR2(4000) PATH '$'))
    WHERE JSON_VALUE(value FORMAT JSON, '$.url' RETURNING VARCHAR2(4000)) = 'ombCategory' AND ROWNUM = 1) AS "race_code"
FROM sof_scratch_resources r
WHERE r.test_id = '${testId}' AND r.resource_type = 'Patient'`,
    // Option A: JSON_QUERY over the whole scalar subquery as the JSON_TABLE
    // source, path moved into the wrap.
    optionA: `SELECT
  CAST(JSON_VALUE(r.json FORMAT JSON, '$.id' RETURNING VARCHAR2(4000)) AS VARCHAR2(64)) AS "id",
  (SELECT JSON_VALUE(value FORMAT JSON, '$.valueCoding.code' RETURNING VARCHAR2(4000)) FROM JSON_TABLE(
    JSON_QUERY((SELECT value FROM JSON_TABLE(r.json FORMAT JSON, '$.extension[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$', scalar VARCHAR2(4000) PATH '$')) WHERE JSON_VALUE(value FORMAT JSON, '$.url' RETURNING VARCHAR2(4000)) = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race' AND ROWNUM = 1), '$.extension' RETURNING CLOB),
    '$[*]' COLUMNS (idx FOR ORDINALITY, value CLOB FORMAT JSON PATH '$', scalar VARCHAR2(4000) PATH '$'))
    WHERE JSON_VALUE(value FORMAT JSON, '$.url' RETURNING VARCHAR2(4000)) = 'ombCategory' AND ROWNUM = 1) AS "race_code"
FROM sof_scratch_resources r
WHERE r.test_id = '${testId}' AND r.resource_type = 'Patient'`,
  };

  for (const [name, sql] of Object.entries(candidates)) {
    console.log(`=== ${name} ===`);
    try {
      const result = await connection.execute(sql);
      console.log(JSON.stringify(result.rows, null, 2));
    } catch (error) {
      console.log(`FAILED: ${(error as Error).message.split("\n")[0]}`);
    }
  }
} finally {
  await dropTestTable(connection, "sof_scratch_resources");
  await connection.close();
}