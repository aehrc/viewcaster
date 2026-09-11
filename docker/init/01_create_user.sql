-- Copyright © 2026, Commonwealth Scientific and Industrial Research
-- Organisation (CSIRO) ABN 41 687 119 230.
--
-- Licensed under the Apache License, Version 2.0 (the "License"); you may not
-- use this file except in compliance with the License. You may obtain a copy
-- of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
-- WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
-- License for the specific language governing permissions and limitations
-- under the License.
--
-- Author: John Grimes
--
-- Creates the viewcaster application user in the FREEPDB1 pluggable database.
-- Executed once by the Oracle container image after the database is created
-- (mounted at /opt/oracle/scripts/setup).

-- Abort on the first error rather than pressing on with a half-created user.
-- Without this, SQL*Plus reports the error and exits zero, so a missing grant
-- only surfaces later as ORA-01031 at CREATE TABLE time.
WHENEVER SQLERROR EXIT FAILURE

ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE USER fhir IDENTIFIED BY fhir
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

GRANT CREATE SESSION TO fhir;
GRANT CREATE TABLE TO fhir;
-- CREATE SEQUENCE is required for the identity column on the resource table.
-- Keep this comment on its own line: SQL*Plus folds a trailing comment into
-- the preceding statement and rejects it with ORA-00933.
GRANT CREATE SEQUENCE TO fhir;
GRANT CREATE VIEW TO fhir;
GRANT UNLIMITED TABLESPACE TO fhir;

EXIT;
