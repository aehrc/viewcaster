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
 * Oracle identifier, type and FHIR resource type validation utilities.
 */

/**
 * Canonical JSON storage types allowed for the resources table `json` column
 * (data-model.md): `BLOB` with an IS JSON check constraint on 19c+, and the
 * native `JSON` type on 21c+.
 */
export type ResourceJsonDataType = "BLOB" | "JSON";

/**
 * The strict allowlist of canonical resource JSON data types. Kept as a set of
 * the canonical (upper-case) forms so membership checks are exact.
 */
const RESOURCE_JSON_DATA_TYPES = new Set<ResourceJsonDataType>([
  "BLOB",
  "JSON",
]);

/**
 * Type predicate that narrows a string to a canonical {@link ResourceJsonDataType}.
 * @param value - The value to test.
 * @returns True when the value is a canonical storage type.
 */
export function validateResourceJsonDataType(
  value: string,
): value is ResourceJsonDataType {
  return RESOURCE_JSON_DATA_TYPES.has(value as ResourceJsonDataType);
}

/**
 * Validate and normalise a configured resource JSON data type.
 *
 * Accepts case-insensitive input, trims surrounding whitespace and returns the
 * canonical form. Rejects any value outside the allowlist with a message that
 * names the offending value (SC-004).
 * @param value - The configured storage type (e.g. from the CLI).
 * @returns The canonical storage type.
 * @throws {Error} When the value is empty or not an allowed storage type.
 */
export function normaliseResourceJsonDataType(
  value: string,
): ResourceJsonDataType {
  // Reject empty or whitespace-only input before anything else, so the user
  // gets a precise message rather than a confusing "not allowed" error.
  if (!value || value.trim().length === 0) {
    throw new Error("Resource JSON data type cannot be empty.");
  }

  // Normalise to the canonical form: trim surrounding whitespace and upper-case.
  const canonical = value.trim().toUpperCase();

  // The predicate enforces the strict allowlist and narrows the type.
  if (!validateResourceJsonDataType(canonical)) {
    throw new Error(
      `Invalid resource JSON data type: '${value}'. Must be one of: BLOB, JSON.`,
    );
  }

  return canonical;
}

/**
 * FHIR R4 resource types.
 * Complete list of all resource types defined in FHIR R4 specification.
 */
const FHIR_R4_RESOURCE_TYPES = new Set([
  "Account",
  "ActivityDefinition",
  "AdverseEvent",
  "AllergyIntolerance",
  "Appointment",
  "AppointmentResponse",
  "AuditEvent",
  "Basic",
  "Binary",
  "BiologicallyDerivedProduct",
  "BodyStructure",
  "Bundle",
  "CapabilityStatement",
  "CarePlan",
  "CareTeam",
  "CatalogEntry",
  "ChargeItem",
  "ChargeItemDefinition",
  "Claim",
  "ClaimResponse",
  "ClinicalImpression",
  "CodeSystem",
  "Communication",
  "CommunicationRequest",
  "CompartmentDefinition",
  "Composition",
  "ConceptMap",
  "Condition",
  "Consent",
  "Contract",
  "Coverage",
  "CoverageEligibilityRequest",
  "CoverageEligibilityResponse",
  "DetectedIssue",
  "Device",
  "DeviceDefinition",
  "DeviceMetric",
  "DeviceRequest",
  "DeviceUseStatement",
  "DiagnosticReport",
  "DocumentManifest",
  "DocumentReference",
  "DomainResource",
  "EffectEvidenceSynthesis",
  "Encounter",
  "Endpoint",
  "EnrollmentRequest",
  "EnrollmentResponse",
  "EpisodeOfCare",
  "EventDefinition",
  "Evidence",
  "EvidenceVariable",
  "ExampleScenario",
  "ExplanationOfBenefit",
  "FamilyMemberHistory",
  "Flag",
  "Goal",
  "GraphDefinition",
  "Group",
  "GuidanceResponse",
  "HealthcareService",
  "ImagingStudy",
  "Immunization",
  "ImmunizationEvaluation",
  "ImmunizationRecommendation",
  "ImplementationGuide",
  "InsurancePlan",
  "Invoice",
  "Library",
  "Linkage",
  "List",
  "Location",
  "Measure",
  "MeasureReport",
  "Media",
  "Medication",
  "MedicationAdministration",
  "MedicationDispense",
  "MedicationKnowledge",
  "MedicationRequest",
  "MedicationStatement",
  "MedicinalProduct",
  "MedicinalProductAuthorization",
  "MedicinalProductContraindication",
  "MedicinalProductIndication",
  "MedicinalProductIngredient",
  "MedicinalProductInteraction",
  "MedicinalProductManufactured",
  "MedicinalProductPackaged",
  "MedicinalProductPharmaceutical",
  "MedicinalProductUndesirableEffect",
  "MessageDefinition",
  "MessageHeader",
  "MolecularSequence",
  "NamingSystem",
  "NutritionOrder",
  "Observation",
  "ObservationDefinition",
  "OperationDefinition",
  "OperationOutcome",
  "Organization",
  "OrganizationAffiliation",
  "Parameters",
  "Patient",
  "PaymentNotice",
  "PaymentReconciliation",
  "Person",
  "PlanDefinition",
  "Practitioner",
  "PractitionerRole",
  "Procedure",
  "Provenance",
  "Questionnaire",
  "QuestionnaireResponse",
  "RelatedPerson",
  "RequestGroup",
  "ResearchDefinition",
  "ResearchElementDefinition",
  "ResearchStudy",
  "ResearchSubject",
  "Resource",
  "RiskAssessment",
  "RiskEvidenceSynthesis",
  "Schedule",
  "SearchParameter",
  "ServiceRequest",
  "Slot",
  "Specimen",
  "SpecimenDefinition",
  "StructureDefinition",
  "StructureMap",
  "Subscription",
  "Substance",
  "SubstanceNucleicAcid",
  "SubstancePolymer",
  "SubstanceProtein",
  "SubstanceReferenceInformation",
  "SubstanceSourceMaterial",
  "SubstanceSpecification",
  "SupplyDelivery",
  "SupplyRequest",
  "Task",
  "TerminologyCapabilities",
  "TestReport",
  "TestScript",
  "ValueSet",
  "VerificationResult",
  "VisionPrescription",
]);


/**
 * Oracle reserved words that cannot be used as unquoted identifiers. This is a
 * subset of commonly used reserved words.
 */
const ORACLE_RESERVED_WORDS = new Set([
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE",
  "ALTER", "TABLE", "INDEX", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER",
  "DATABASE", "SCHEMA", "USER", "ROLE", "GRANT", "REVOKE", "JOIN", "UNION",
  "ORDER", "GROUP", "HAVING", "AS", "ON", "IN", "EXISTS", "BETWEEN", "LIKE",
  "AND", "OR", "NOT", "NULL", "IS", "LEVEL", "SIZE", "TYPE", "RESOURCE",
  "CHECK", "UNIQUE", "WITH", "VALUES",
]);

/**
 * Validate an Oracle identifier (table name, schema name, etc.).
 *
 * Oracle identifier rules:
 * - Can start with a letter
 * - Followed by: letters, digits (0-9), underscore, $ or #
 * - Maximum length: 128 bytes
 * - Must not be a reserved word
 * @param identifier - The identifier to validate
 * @param type - The type of identifier (for error messages)
 * @throws Error if the identifier is invalid
 */
export function validateOracleIdentifier(
  identifier: string,
  type: string,
): void {
  // Check for empty identifier
  if (!identifier || identifier.trim().length === 0) {
    throw new Error(`${type} cannot be empty.`);
  }

  // Check length (Oracle's 12.2+ limit is 128 bytes).
  if (identifier.length > 128) {
    throw new Error(
      `${type} '${identifier}' exceeds maximum length of 128 characters.`,
    );
  }

  // Check pattern: must start with a letter, followed by letters, digits,
  // underscore, $ or #.
  if (!/^[a-zA-Z][a-zA-Z0-9_$#]*$/.test(identifier)) {
    throw new Error(
      `${type} '${identifier}' contains invalid characters. Must start with a letter, followed by letters, digits, underscore, $ or #.`,
    );
  }

  // Check for reserved words (case-insensitive)
  if (ORACLE_RESERVED_WORDS.has(identifier.toUpperCase())) {
    throw new Error(
      `${type} '${identifier}' is an Oracle reserved word and cannot be used as an identifier.`,
    );
  }
}

/**
 * Validate a FHIR resource type against the R4 specification.
 * @param resourceType - The resource type to validate
 * @throws Error if the resource type is not valid
 */
export function validateResourceType(resourceType: string): void {
  if (!resourceType || resourceType.trim().length === 0) {
    throw new Error("Resource type cannot be empty.");
  }

  if (!FHIR_R4_RESOURCE_TYPES.has(resourceType)) {
    throw new Error(
      `Invalid FHIR resource type: '${resourceType}'. Must be a valid FHIR R4 resource type.`,
    );
  }
}

/**
 * Valid Oracle base type names.
 */
const VALID_ORACLE_TYPES = new Set([
  "NUMBER", "INTEGER", "INT", "SMALLINT", "FLOAT", "BINARY_FLOAT",
  "BINARY_DOUBLE", "DECIMAL", "NUMERIC", "REAL", "DOUBLE PRECISION",
  "DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE",
  "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND",
  "CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "VARCHAR", "CLOB", "NCLOB",
  "BLOB", "BFILE", "RAW", "LONG RAW", "JSON", "BOOLEAN", "XMLTYPE",
]);

/**
 * Validate an Oracle SQL type specification.
 * @param sqlType - Oracle type string (e.g. 'VARCHAR2(4000)', 'NUMBER(10,2)', 'CLOB').
 * @throws Error if the type is invalid
 */
export function validateOracleType(sqlType: string): void {
  if (!sqlType || sqlType.trim().length === 0) {
    throw new Error("Oracle type cannot be empty.");
  }

  const trimmedType = sqlType.trim();

  // Extract base type and parameters by finding the opening parenthesis
  const openParenIndex = trimmedType.indexOf("(");
  const baseTypePart =
    openParenIndex === -1
      ? trimmedType
      : trimmedType.slice(0, Math.max(0, openParenIndex)).trim();
  const paramsPart =
    openParenIndex === -1 ? "" : trimmedType.slice(Math.max(0, openParenIndex));

  // Validate base type name: letters and spaces (multi-word base types).
  if (!/^[A-Z][A-Z0-9_ ]*$/i.test(baseTypePart)) {
    throw new Error(
      `Invalid Oracle type format: '${sqlType}'. Must be a valid Oracle data type such as VARCHAR2(4000), NUMBER(10), TIMESTAMP, or CLOB.`,
    );
  }

  // Validate parameters if present: (size), (precision,scale) or (precision) ...
  if (paramsPart && !/^\(\s*\d+(\s*(CHAR|BYTE))?\s*(\s*,\s*\d+\s*)?\)$/.test(paramsPart)) {
    throw new Error(
      `Invalid Oracle type format: '${sqlType}'. Must be a valid Oracle data type such as VARCHAR2(4000), NUMBER(10), or NUMBER(38,18).`,
    );
  }

  // Check if base type is valid
  const baseType = baseTypePart.toUpperCase();
  if (!VALID_ORACLE_TYPES.has(baseType)) {
    throw new Error(
      `Unknown Oracle type: '${baseType}'. Must be a valid Oracle data type such as VARCHAR2, NUMBER, TIMESTAMP, or CLOB.`,
    );
  }
}

/**
 * Mapping of ANSI/ISO SQL standard types to Oracle equivalents.
 * Based on ISO/IEC 9075 and Oracle's ANSI type synonyms.
 */
const ANSI_TO_ORACLE_TYPE_MAP = new Map<string, string>([
  // Character types (SQL-92 and later)
  ["CHARACTER", "CHAR"],
  ["CHAR", "CHAR"],
  ["CHARACTER VARYING", "VARCHAR2"],
  ["CHAR VARYING", "VARCHAR2"],
  ["NATIONAL CHARACTER", "NCHAR"],
  ["NATIONAL CHAR", "NCHAR"],
  ["NATIONAL CHARACTER VARYING", "NVARCHAR2"],
  ["NATIONAL CHAR VARYING", "NVARCHAR2"],

  // Numeric types - exact (SQL-92)
  ["INTEGER", "NUMBER(10)"],
  ["INT", "NUMBER(10)"],
  ["SMALLINT", "NUMBER(5)"],
  ["BIGINT", "NUMBER(19)"],
  ["DECIMAL", "NUMBER"],
  ["DEC", "NUMBER"],
  ["NUMERIC", "NUMBER"],

  // Numeric types - approximate (SQL-92)
  ["FLOAT", "FLOAT"],
  ["REAL", "FLOAT"],
  ["DOUBLE PRECISION", "BINARY_DOUBLE"],

  // Date/time types (SQL-92 and later)
  ["DATE", "DATE"],
  ["TIME", "DATE"],
  // ANSI TIMESTAMP maps to Oracle TIMESTAMP.
  ["TIMESTAMP", "TIMESTAMP"],

  // Boolean (SQL:1999)
  // Oracle before 23ai has no SQL BOOLEAN; NUMBER(1) is the established
  // convention and keeps one SQL text across 19c-23ai (research R6).
  ["BOOLEAN", "NUMBER(1)"],

  // Binary types
  ["BINARY VARYING", "RAW"],
]);

/**
 * Parse an ANSI/ISO SQL type into base type and parameters.
 * @param typeString - The ANSI type string.
 * @returns Object with baseType and parameters.
 */
function parseAnsiSqlType(typeString: string): {
  baseType: string;
  parameters: string;
} {
  const openParenIndex = typeString.indexOf("(");
  const baseTypePart =
    openParenIndex === -1
      ? typeString
      : typeString.slice(0, Math.max(0, openParenIndex)).trim();
  const paramsPart =
    openParenIndex === -1 ? "" : typeString.slice(Math.max(0, openParenIndex));

  return {
    baseType: baseTypePart.trim().toUpperCase(),
    parameters: paramsPart,
  };
}

/**
 * Validate and convert ANSI/ISO SQL type specification to an Oracle type.
 *
 * Examples:
 * - 'INTEGER' -> 'NUMBER(10)'
 * - 'CHARACTER(50)' -> 'CHAR(50)'
 * - 'BOOLEAN' -> 'NUMBER(1)'
 * - 'TIMESTAMP' -> 'TIMESTAMP'
 * @param ansiType - ANSI/ISO SQL type string (e.g. 'INTEGER', 'CHARACTER(20)').
 * @returns Oracle equivalent type.
 * @throws Error if type is invalid or unsupported.
 */
export function validateAnsiSqlType(ansiType: string): string {
  if (!ansiType || ansiType.trim().length === 0) {
    throw new Error("ANSI SQL type cannot be empty.");
  }

  const trimmedType = ansiType.trim();
  const { baseType, parameters } = parseAnsiSqlType(trimmedType);

  // Validate base type: must start with letter, followed by letters and spaces
  if (!/^[A-Z][A-Z\s]*$/i.test(baseType)) {
    throw new Error(
      `Invalid ANSI SQL type format: '${ansiType}'. Must be a valid ANSI/ISO SQL type such as INTEGER, CHARACTER(50), or DECIMAL(10,2).`,
    );
  }

  // Validate parameters if present: (size) or (precision,scale)
  if (parameters && !/^\(\s*\d+(\s*(CHAR|BYTE))?\s*(\s*,\s*\d+\s*)?\)$/i.test(parameters)) {
    throw new Error(
      `Invalid ANSI SQL type format: '${ansiType}'. Must be a valid ANSI/ISO SQL type such as INTEGER, CHARACTER(50), or DECIMAL(10,2).`,
    );
  }

  // Look up Oracle equivalent
  const oracleBaseType = ANSI_TO_ORACLE_TYPE_MAP.get(baseType);

  if (!oracleBaseType) {
    // Check if it's already a valid Oracle type (pass-through)
    const oracleType = baseType + parameters;
    try {
      validateOracleType(oracleType);
      return oracleType;
    } catch {
      throw new Error(
        `Unsupported ANSI SQL type: '${baseType}'. Must be a valid ANSI/ISO SQL standard type such as INTEGER, CHARACTER, DECIMAL, TIMESTAMP, or BOOLEAN.`,
      );
    }
  }

  // Construct the Oracle type with parameters (only for types that take them).
  const oracleType = parameters
    ? `${oracleBaseType}${parameters}`
    : oracleBaseType;

  // Validate the resulting Oracle type where it is not a size-carrying
  // translation (e.g. NUMBER(10) with a size would be NUMBER(10)(10)).
  if (!oracleType.includes(")(")) {
    try {
      validateOracleType(oracleType);
    } catch {
      // Mapped types that take no parameters (e.g. NUMBER(10)(3)) are not
      // representable; fall back to the base mapping.
      return oracleBaseType;
    }
  }

  return oracleType;
}
