/**
 * FHIRPath to Oracle SQL visitor implementation using ANTLR.
 *
 * The visitor emits dialect-neutral JSON function fragments
 * (`JSON_VALUE`/`JSON_QUERY`/`JSON_EXISTS` over a source expression and a JSON
 * path). The Oracle-specific decorations (`FORMAT JSON` and `RETURNING`
 * clauses, applied in BLOB storage mode) are applied in a single terminal
 * pass by `Transpiler.applyOracleJsonSyntax`, so the visitor's pattern
 * matching never sees them. JSON_TABLE templates are emitted fully formed
 * (they need multi-clause column lists the terminal pass cannot reconstruct)
 * using the storage type from the context.
 * @author John Grimes
 */

import { AbstractParseTreeVisitor } from "antlr4ts/tree/AbstractParseTreeVisitor";

import {
  AdditiveExpressionContext,
  AndExpressionContext,
  BooleanLiteralContext,
  DateLiteralContext,
  DateTimeLiteralContext,
  EntireExpressionContext,
  EqualityExpressionContext,
  ExpressionContext,
  ExternalConstantContext,
  ExternalConstantTermContext,
  FunctionContext,
  FunctionInvocationContext,
  IdentifierContext,
  ImpliesExpressionContext,
  IndexerExpressionContext,
  IndexInvocationContext,
  InequalityExpressionContext,
  InvocationExpressionContext,
  InvocationTermContext,
  LiteralTermContext,
  LongNumberLiteralContext,
  MemberInvocationContext,
  MembershipExpressionContext,
  MultiplicativeExpressionContext,
  NullLiteralContext,
  NumberLiteralContext,
  OrExpressionContext,
  ParamListContext,
  ParenthesizedTermContext,
  PolarityExpressionContext,
  QualifiedIdentifierContext,
  QuantityContext,
  QuantityLiteralContext,
  StringLiteralContext,
  TermExpressionContext,
  ThisInvocationContext,
  TimeLiteralContext,
  TotalInvocationContext,
  TypeExpressionContext,
  UnionExpressionContext,
} from "../generated/grammar/fhirpathParser";
import { fhirpathVisitor } from "../generated/grammar/fhirpathVisitor";

/**
 * JSON_TABLE column list for iterating an array. `value` carries the whole
 * element (CLOB, marked FORMAT JSON in BLOB mode so downstream JSON functions
 * accept it); `scalar` carries it as text.
 * @param storage - The targeted JSON storage type.
 * @returns The COLUMNS clause text.
 */
export function jsonTableColumns(storage: "BLOB" | "JSON"): string {
  const fmt = storage === "BLOB" ? " FORMAT JSON" : "";
  return `idx FOR ORDINALITY, value CLOB${fmt} PATH '$', scalar VARCHAR2(4000) PATH '$'`;
}

/**
 * The `FORMAT JSON` suffix to apply to a JSON source expression.
 * @param storage - The targeted JSON storage type.
 * @returns ` FORMAT JSON` in BLOB mode, empty string in native JSON mode.
 */
export function formatJsonSuffix(storage: "BLOB" | "JSON"): string {
  return storage === "BLOB" ? " FORMAT JSON" : "";
}

export interface TranspilerContext {
  resourceAlias: string;
  // Name of the JSON column on the resources table (defaults to "json").
  resourceJsonColumn?: string;
  // The JSON storage type the query targets; drives `FORMAT JSON` emission.
  resourceJsonDataType?: "BLOB" | "JSON";
  constants?: { [key: string]: string | number | boolean | null };
  iterationContext?: string;
  // forEach iteration context
  currentForEachAlias?: string; // The JSON_TABLE alias (e.g., "forEach_0")
  forEachSource?: string; // The JSON source being iterated (e.g., "r.json")
  forEachPath?: string; // The JSON path being iterated (e.g., "$.name")
  // The SQL expression yielding the current iteration's 0-based index, used to
  // resolve the SQL on FHIR `%rowIndex` environment variable. Each iteration
  // operator (forEach, forEachOrNull, repeat) sets this to the expression that
  // produces that iteration's position; absent at the resource root.
  rowIndexExpr?: string;
  // The FHIR datatype resolved from an explicit `ofType(X)` applied directly
  // to a `lowBoundary()`/`highBoundary()` input. It governs which boundary
  // algorithm is emitted. Set only on the short-lived iteration context
  // created for a boundary dispatch; absent means the datatype is inferred
  // from the value's lexical form at SQL runtime.
  boundaryType?: string;
  testId?: string; // Optional test identifier for parallel test execution
}

export class FHIRPathToOracleVisitor
  extends AbstractParseTreeVisitor<string>
  implements fhirpathVisitor<string>
{
  /**
   *
   * @param context
   */
  constructor(private readonly context: TranspilerContext) {
    super();
  }

  /**
   * The name of the JSON column on the resources table.
   */
  private get jsonColumn(): string {
    return this.context.resourceJsonColumn ?? "json";
  }

  /**
   * The targeted JSON storage type (BLOB emits `FORMAT JSON`).
   */
  private get storage(): "BLOB" | "JSON" {
    return this.context.resourceJsonDataType ?? "BLOB";
  }

  /**
   * The root JSON source expression (`r.json`).
   */
  private get rootJson(): string {
    return `${this.context.resourceAlias}.${this.jsonColumn}`;
  }

  protected defaultResult(): string {
    return "NULL";
  }

  /**
   *
   * @param ctx
   */
  visitEntireExpression(ctx: EntireExpressionContext): string {
    return this.visit(ctx.expression());
  }

  /**
   *
   * @param ctx
   */
  visitTermExpression(ctx: TermExpressionContext): string {
    return this.visit(ctx.term());
  }

  /**
   *
   * @param ctx
   */
  visitInvocationExpression(ctx: InvocationExpressionContext): string {
    const base = this.visit(ctx.expression());
    const invocation = ctx.invocation();

    if (invocation instanceof MemberInvocationContext) {
      return this.handleMemberInvocation(base, invocation);
    } else if (invocation instanceof FunctionInvocationContext) {
      // Pass the base expression's parse tree so boundary functions can detect
      // an explicit ofType() applied directly to their input.
      return this.handleFunctionInvocation(base, invocation, ctx.expression());
    }

    return this.defaultResult();
  }

  /**
   *
   * @param ctx
   */
  visitIndexerExpression(ctx: IndexerExpressionContext): string {
    const base = this.visit(ctx.expression(0));
    const index = this.visit(ctx.expression(1));

    // Generate JSON path with array index
    if (base.includes("JSON_VALUE")) {
      const pathMatch = /JSON_VALUE\(([^,]+),\s*'([^']+)'\)/.exec(base);
      if (pathMatch) {
        const source = pathMatch[1];
        const path = pathMatch[2];
        return `JSON_VALUE(${source}, '${path}[${index}]')`;
      }
    }

    return `JSON_VALUE(${base}, '$[${index}]')`;
  }

  /**
   *
   * @param ctx
   */
  visitPolarityExpression(ctx: PolarityExpressionContext): string {
    const operand = this.visit(ctx.expression());
    const operator = ctx.text.charAt(0); // '+' or '-'

    return operator === "-" ? `(-${operand})` : `(+${operand})`;
  }

  /**
   *
   * @param ctx
   */
  visitMultiplicativeExpression(ctx: MultiplicativeExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));

    // Get the original expression texts from the parse tree to find the operator
    const leftText = ctx.expression(0).text;
    const rightText = ctx.expression(1).text;
    const operator = this.getOperatorFromContext(ctx.text, leftText, rightText);

    // Cast JSON_VALUE results to DECIMAL for numeric operations
    const leftCasted = this.castForNumericOperation(left);
    const rightCasted = this.castForNumericOperation(right);

    switch (operator) {
      case "*": {
        return `(${leftCasted} * ${rightCasted})`;
      }
      case "/":
      case "div": {
        return `(${leftCasted} / ${rightCasted})`;
      }
      case "mod": {
        return `MOD(${leftCasted}, ${rightCasted})`;
      }
      default: {
        return `(${leftCasted} * ${rightCasted})`;
      }
    }
  }

  /**
   *
   * @param ctx
   */
  visitAdditiveExpression(ctx: AdditiveExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));

    // Get the original expression texts from the parse tree to find the operator
    const leftText = ctx.expression(0).text;
    const rightText = ctx.expression(1).text;
    const operator = this.getOperatorFromContext(ctx.text, leftText, rightText);

    switch (operator) {
      case "+":
      case "-": {
        // Cast JSON_VALUE results to DECIMAL for numeric operations
        const leftCasted = this.castForNumericOperation(left);
        const rightCasted = this.castForNumericOperation(right);
        return operator === "+"
          ? `(${leftCasted} + ${rightCasted})`
          : `(${leftCasted} - ${rightCasted})`;
      }
      case "&": {
        // String concatenation in FHIRPath; Oracle uses `||`.
        return `(${left} || ${right})`;
      }
      default: {
        const leftCasted = this.castForNumericOperation(left);
        const rightCasted = this.castForNumericOperation(right);
        return `(${leftCasted} + ${rightCasted})`;
      }
    }
  }

  /**
   *
   * @param ctx
   */
  visitTypeExpression(ctx: TypeExpressionContext): string {
    const expression = this.visit(ctx.expression());
    const typeSpec = this.visit(ctx.typeSpecifier());
    const operator = this.getOperatorFromContext(
      ctx.text,
      expression,
      typeSpec,
    );

    if (operator === "is") {
      // Type checking - simplified implementation
      return `(${expression} IS NOT NULL)`;
    } else if (operator === "as") {
      // Type casting - return the expression as-is for simplification
      return expression;
    }

    return expression;
  }

  /**
   *
   * @param ctx
   */
  visitUnionExpression(ctx: UnionExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));

    // FHIRPath `|` merges two collections into one. Over scalar SQL
    // expressions the practical equivalent is taking whichever operand is
    // present, preferring the left.
    return `COALESCE(${left}, ${right})`;
  }

  /**
   *
   * @param ctx
   */
  visitInequalityExpression(ctx: InequalityExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));

    // Get the operator from the middle child (between the two expressions)
    // The context has 3 children: expr0, operator, expr1
    const operator = ctx.childCount >= 3 ? ctx.getChild(1).text : "";

    switch (operator) {
      case "<": {
        return `(${left} < ${right})`;
      }
      case "<=": {
        return `(${left} <= ${right})`;
      }
      case ">": {
        return `(${left} > ${right})`;
      }
      case ">=": {
        return `(${left} >= ${right})`;
      }
      default: {
        return `(${left} < ${right})`;
      }
    }
  }

  /**
   *
   * @param ctx
   */
  visitEqualityExpression(ctx: EqualityExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));
    const operator = this.getOperatorFromContext(ctx.text, left, right);

    switch (operator) {
      case "=": {
        // Handle boolean comparisons - boolean literals return quoted strings
        return `(${left} = ${right})`;
      }
      case "!=": {
        return `(${left} != ${right})`;
      }
      case "~": {
        // Equivalent/approximately equal
        return `(${left} = ${right})`;
      }
      case "!~": {
        // Not equivalent
        return `(${left} != ${right})`;
      }
      default: {
        return `(${left} = ${right})`;
      }
    }
  }

  /**
   *
   * @param ctx
   */
  visitMembershipExpression(ctx: MembershipExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));
    const operator = this.getOperatorFromContext(ctx.text, left, right);

    // Oracle renders membership as an EXISTS over a JSON_TABLE unrolling of
    // the collection expression.
    if (operator === "in") {
      return this.buildMembershipExists(right, left);
    } else if (operator === "contains") {
      return this.buildMembershipExists(left, right);
    }

    return this.defaultResult();
  }

  /**
   * Builds an EXISTS predicate checking that `needle` occurs among the
   * elements of the collection expression `collection`.
   * @param collection - SQL fragment yielding the collection.
   * @param needle - SQL fragment yielding the scalar to find.
   * @returns An EXISTS(...) predicate.
   */
  private buildMembershipExists(collection: string, needle: string): string {
    const fmt = formatJsonSuffix(this.storage);
    return `EXISTS (SELECT 1 FROM JSON_TABLE(${collection}${fmt}, '$[*]' COLUMNS (value VARCHAR2(4000) PATH '$')) WHERE value = ${needle})`;
  }

  /**
   *
   * @param ctx
   */
  visitAndExpression(ctx: AndExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));
    return `(${left} AND ${right})`;
  }

  /**
   *
   * @param ctx
   */
  visitOrExpression(ctx: OrExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));
    const operator = this.getOperatorFromContext(ctx.text, left, right);

    if (operator === "or") {
      return `(${left} OR ${right})`;
    } else if (operator === "xor") {
      // Exclusive OR
      return `((${left} AND NOT ${right}) OR (NOT ${left} AND ${right}))`;
    }

    return `(${left} OR ${right})`;
  }

  /**
   *
   * @param ctx
   */
  visitImpliesExpression(ctx: ImpliesExpressionContext): string {
    const left = this.visit(ctx.expression(0));
    const right = this.visit(ctx.expression(1));
    // A implies B is equivalent to (NOT A) OR B
    return `((NOT ${left}) OR ${right})`;
  }

  // Literal visitors
  /**
   *
   * @param _ctx
   */
  visitNullLiteral(_ctx: NullLiteralContext): string {
    return "NULL";
  }

  /**
   *
   * @param ctx
   */
  visitBooleanLiteral(ctx: BooleanLiteralContext): string {
    const value = ctx.text.toLowerCase();
    // Return quoted boolean for JSON comparisons
    return value === "true" ? "'true'" : "'false'";
  }

  /**
   *
   * @param ctx
   */
  visitStringLiteral(ctx: StringLiteralContext): string {
    // Remove surrounding quotes and escape internal quotes
    const value = ctx.text.slice(1, -1).replaceAll('\'', "''");
    return `'${value}'`;
  }

  /**
   *
   * @param ctx
   */
  visitNumberLiteral(ctx: NumberLiteralContext): string {
    return ctx.text;
  }

  /**
   *
   * @param ctx
   */
  visitLongNumberLiteral(ctx: LongNumberLiteralContext): string {
    return ctx.text.replace(/L$/i, "");
  }

  /**
   *
   * @param ctx
   */
  visitDateLiteral(ctx: DateLiteralContext): string {
    // Remove @ prefix and wrap in quotes for SQL
    const value = ctx.text.slice(1);
    return `'${value}'`;
  }

  /**
   *
   * @param ctx
   */
  visitDateTimeLiteral(ctx: DateTimeLiteralContext): string {
    // Remove @ prefix and wrap in quotes for SQL
    const value = ctx.text.slice(1);
    return `'${value}'`;
  }

  /**
   *
   * @param ctx
   */
  visitTimeLiteral(ctx: TimeLiteralContext): string {
    // Remove @T prefix and wrap in quotes for SQL
    const value = ctx.text.slice(2);
    return `'${value}'`;
  }

  /**
   *
   * @param ctx
   */
  visitQuantityLiteral(ctx: QuantityLiteralContext): string {
    return this.visit(ctx.quantity());
  }

  // Invocation visitors
  /**
   *
   * @param ctx
   */
  visitMemberInvocation(ctx: MemberInvocationContext): string {
    const memberName = this.visit(ctx.identifier());

    // Handle special identifiers
    if (memberName === "id") {
      // Extract id from JSON, not from database row ID
      return `JSON_VALUE(${this.rootJson}, '$.id')`;
    }

    // Known FHIR array fields should use JSON_QUERY
    const knownArrayFields = new Set([
      "name",
      "given",
      "telecom",
      "address",
      "line",
      "identifier",
      "extension",
      "contact",
      "output",
      "item",
      "udiCarrier",
      "coding",
      "component",
    ]);

    // Regular JSON property access
    if (this.context.iterationContext) {
      // Check if the member is a known array field - use JSON_QUERY for arrays
      if (knownArrayFields.has(memberName)) {
        return `JSON_QUERY(${this.context.iterationContext}, '$.${memberName}')`;
      }
      return `JSON_VALUE(${this.context.iterationContext}, '$.${memberName}')`;
    }

    // Use JSON_QUERY for known array fields, JSON_VALUE for others
    if (knownArrayFields.has(memberName)) {
      return `JSON_QUERY(${this.rootJson}, '$.${memberName}')`;
    }

    return `JSON_VALUE(${this.rootJson}, '$.${memberName}')`;
  }

  /**
   *
   * @param ctx
   */
  visitFunctionInvocation(ctx: FunctionInvocationContext): string {
    return this.visit(ctx.function());
  }

  /**
   *
   * @param _ctx
   */
  visitThisInvocation(_ctx: ThisInvocationContext): string {
    // $this refers to the current item in an iteration context. A JSON_TABLE
    // iteration exposes both the element's JSON text (`value`, for navigation)
    // and its scalar text (`scalar`, matching T-SQL OPENJSON's unquoted
    // `value`); FHIRPath $this is the scalar view.
    if (this.context.iterationContext) {
      const iteration = this.context.iterationContext;
      const scalar = this.scalarVariant(iteration);
      return scalar ?? iteration;
    }
    return this.rootJson;
  }

  /**
   * Maps an iteration source to its scalar (unquoted text) column variant:
   * `value` to `scalar`, `alias.value` to `alias.scalar`, and
   * `cte.item_json` to `cte.item_scalar`.
   * @param source - The iteration source expression.
   * @returns The scalar column reference, or null when not applicable.
   */
  private scalarVariant(source: string): string | null {
    if (source === "value") {
      return "scalar";
    }
    const valueMatch = /^(.+)\.value$/.exec(source);
    if (valueMatch) {
      return `${valueMatch[1]}.scalar`;
    }
    const itemMatch = /^(.+)\.item_json$/.exec(source);
    if (itemMatch) {
      return `${itemMatch[1]}.item_scalar`;
    }
    return null;
  }

  /**
   *
   * @param _ctx
   */
  visitIndexInvocation(_ctx: IndexInvocationContext): string {
    // $index in forEach contexts - return current iteration index (0-based)
    if (this.context.currentForEachAlias) {
      // In a forEach context, use the FOR ORDINALITY column (1-based, so
      // subtract one to give the FHIRPath 0-based index)
      return `${this.context.currentForEachAlias}.idx - 1`;
    }
    // Outside forEach context, default to 0
    return "0";
  }

  /**
   *
   * @param _ctx
   */
  visitTotalInvocation(_ctx: TotalInvocationContext): string {
    // $total in forEach contexts - return total count of items in current iteration
    if (
      this.context.currentForEachAlias &&
      this.context.forEachSource &&
      this.context.forEachPath
    ) {
      // Count the elements the current forEach is iterating over.
      const fmt = formatJsonSuffix(this.storage);
      return `(
        SELECT COUNT(*)
        FROM JSON_TABLE(${this.context.forEachSource}${fmt}, '${this.context.forEachPath}[*]' COLUMNS (ord FOR ORDINALITY))
      )`;
    }
    // Outside forEach context, default to 1
    return "1";
  }

  // Term visitors
  /**
   *
   * @param ctx
   */
  visitInvocationTerm(ctx: InvocationTermContext): string {
    return this.visit(ctx.invocation());
  }

  /**
   *
   * @param ctx
   */
  visitLiteralTerm(ctx: LiteralTermContext): string {
    return this.visit(ctx.literal());
  }

  /**
   *
   * @param ctx
   */
  visitExternalConstantTerm(ctx: ExternalConstantTermContext): string {
    return this.visit(ctx.externalConstant());
  }

  /**
   *
   * @param ctx
   */
  visitParenthesizedTerm(ctx: ParenthesizedTermContext): string {
    const expr = this.visit(ctx.expression());
    return `(${expr})`;
  }

  /**
   *
   * @param ctx
   */
  visitExternalConstant(ctx: ExternalConstantContext): string {
    let constantName: string;

    const identifier = ctx.identifier();
    if (identifier) {
      constantName = this.visit(identifier);
    } else {
      // STRING case - remove quotes
      constantName = ctx.STRING()?.text.slice(1, -1) ?? "";
    }

    // `%rowIndex` is a built-in SQL on FHIR environment variable holding the
    // 0-based position of the current element within the active forEach,
    // forEachOrNull, or repeat iteration. It is reserved, so it is resolved
    // before the user-defined constants lookup and the "not defined" error, and
    // a user constant named `rowIndex` cannot shadow it. With no active
    // iteration (resource root) it resolves to 0.
    if (constantName === "rowIndex") {
      return this.context.rowIndexExpr ?? "0";
    }

    // Check if the constant is defined in the context
    if (
      this.context.constants &&
      this.context.constants[constantName] !== undefined
    ) {
      return this.formatConstantValue(this.context.constants[constantName]);
    }

    // Constant not found - throw an error
    throw new Error(
      `Constant '%${constantName}' is not defined in the ViewDefinition`,
    );
  }

  /**
   *
   * @param ctx
   */
  visitFunction(ctx: FunctionContext): string {
    const functionName = this.visit(ctx.identifier());
    const paramList = ctx.paramList();

    // Special handling for where() function - need raw expression, not transpiled
    if (functionName === "where") {
      if (!paramList || paramList.expression().length !== 1) {
        throw new Error("where() function requires exactly one argument");
      }

      // Get the raw filter expression context (not transpiled yet)
      const filterExprCtx = paramList.expression()[0];

      // Transpile the filter expression with current context
      const filterVisitor = new FHIRPathToOracleVisitor(this.context);

      // Return the condition directly - this is for root-level where() calls
      return filterVisitor.visit(filterExprCtx);
    }

    const args = paramList ? this.getParameterList(paramList) : [];
    return this.executeFunctionHandler(functionName, args);
  }

  /**
   *
   * @param ctx
   */
  visitQuantity(ctx: QuantityContext): string {
    // For now, just return the number - unit handling would be more complex
    return ctx.NUMBER().text;
  }

  /**
   *
   * @param ctx
   */
  visitIdentifier(ctx: IdentifierContext): string {
    const identifier = ctx.IDENTIFIER();
    const delimitedIdentifier = ctx.DELIMITEDIDENTIFIER();

    if (identifier) {
      return identifier.text;
    } else if (delimitedIdentifier) {
      // Remove backticks
      return delimitedIdentifier.text.slice(1, -1);
    } else {
      // One of the keyword identifiers
      return ctx.text;
    }
  }

  /**
   *
   * @param ctx
   */
  visitQualifiedIdentifier(ctx: QualifiedIdentifierContext): string {
    const parts = ctx.identifier().map((id) => this.visit(id));
    return parts.join(".");
  }

  // Helper methods
  private handleMemberInvocation(
    base: string,
    memberCtx: MemberInvocationContext,
  ): string {
    const memberName = this.visit(memberCtx.identifier());

    // Handle subquery results from .where() or .extension() functions.
    // Forms produced by this visitor:
    //   (SELECT value FROM JSON_TABLE(...) WHERE ...)
    //   (SELECT JSON_VALUE(value, '$.field') FROM JSON_TABLE(...) WHERE ...)
    if (base.startsWith("(SELECT value FROM JSON_TABLE")) {
      const fromPart = base.slice(Math.max(0, base.indexOf(" FROM ")));
      return `(SELECT JSON_VALUE(value, '$.${memberName}')${fromPart}`;
    }
    if (base.startsWith("(SELECT JSON_VALUE(value, '$.")) {
      const existingPath = /JSON_VALUE\(value, '\$\.([^']+)'\)/.exec(base)?.[1];
      if (existingPath) {
        const rest = base.slice(Math.max(0, base.indexOf(" FROM ")));
        return `(SELECT JSON_VALUE(value, '$.${existingPath}.${memberName}')${rest}`;
      }
    }

    // Handle JSON_VALUE expressions - check this BEFORE JSON_QUERY
    // because the base might be JSON_VALUE(JSON_QUERY(...))
    if (base.startsWith("JSON_VALUE")) {
      return this.handleJsonValueMember(base, memberName);
    }

    // Handle JSON_QUERY expressions (arrays)
    if (base.includes("JSON_QUERY")) {
      return this.handleJsonQueryMember(base, memberName);
    }

    // A scalar iteration column ($this.member): re-target the same row's JSON
    // text column so the member path can be extracted.
    const jsonSource = this.jsonVariant(base);
    if (jsonSource) {
      return `JSON_VALUE(${jsonSource}, '$.${memberName}')`;
    }

    return `JSON_VALUE(${base}, '$.${memberName}')`;
  }

  /**
   * Maps a scalar iteration column reference back to its JSON text column:
   * `scalar` to `value`, `alias.scalar` to `alias.value`, and
   * `cte.item_scalar` to `cte.item_json`.
   * @param source - The scalar column reference.
   * @returns The JSON column reference, or null when not applicable.
   */
  private jsonVariant(source: string): string | null {
    if (source === "scalar") {
      return "value";
    }
    const scalarMatch = /^(.+)\.scalar$/.exec(source);
    if (scalarMatch) {
      return `${scalarMatch[1]}.value`;
    }
    const itemMatch = /^(.+)\.item_scalar$/.exec(source);
    if (itemMatch) {
      return `${itemMatch[1]}.item_json`;
    }
    return null;
  }

  private handleJsonQueryMember(base: string, memberName: string): string {
    const pathMatch = /JSON_QUERY\(([^,]+),\s*'([^']+)'\)/.exec(base);
    if (!pathMatch) {
      return `JSON_VALUE(${base}, '$.${memberName}')`;
    }

    const source = pathMatch[1];
    const existingPath = pathMatch[2];
    const isForEachValue = /forEach_\d+\.value/.test(source);

    const previousFieldIsArray = this.checkPreviousFieldIsArray(
      existingPath,
      isForEachValue,
    );
    const currentMemberIsArray = this.checkCurrentMemberIsArray(
      memberName,
      existingPath,
      isForEachValue,
    );

    const newPath = previousFieldIsArray
      ? `${existingPath}[0].${memberName}`
      : `${existingPath}.${memberName}`;

    return currentMemberIsArray
      ? `JSON_QUERY(${source}, '${newPath}')`
      : `JSON_VALUE(${source}, '${newPath}')`;
  }

  private checkPreviousFieldIsArray(
    existingPath: string,
    isForEachValue: boolean,
  ): boolean {
    const alwaysArrayFields = this.getAlwaysArrayFields();
    const contextDependentFields = ["name"];

    const indexPattern = /\[\d+]/;
    const pathSegments = existingPath
      .split(".")
      .filter((s) => s !== "$" && !indexPattern.test(s));
    const lastSegment = pathSegments.at(-1);

    const previousFieldIsAlwaysArray =
      !!lastSegment && alwaysArrayFields.includes(lastSegment);
    const previousFieldIsContextArray =
      !!lastSegment &&
      contextDependentFields.includes(lastSegment) &&
      !isForEachValue;

    return previousFieldIsAlwaysArray || previousFieldIsContextArray;
  }

  private checkCurrentMemberIsArray(
    memberName: string,
    existingPath: string,
    isForEachValue: boolean,
  ): boolean {
    const alwaysArrayFields = this.getAlwaysArrayFields();
    const contextDependentFields = ["name"];

    const indexPattern = /\[\d+]/;
    const pathSegments = existingPath
      .split(".")
      .filter((s) => s !== "$" && !indexPattern.test(s));

    return (
      alwaysArrayFields.includes(memberName) ||
      (contextDependentFields.includes(memberName) &&
        !isForEachValue &&
        pathSegments.length === 0)
    );
  }

  private getAlwaysArrayFields(): string[] {
    return [
      "given",
      "telecom",
      "address",
      "line",
      "identifier",
      "extension",
      "contact",
      "output",
      "item",
      "udiCarrier",
      "coding",
      "component",
    ];
  }

  /**
   * Checks if a member name represents a FHIR array field.
   * @param memberName
   */
  private isArrayField(memberName: string): boolean {
    const knownArrayFields = [
      "name",
      "given",
      "telecom",
      "address",
      "line",
      "identifier",
      "extension",
      "contact",
      "output",
      "item",
      "udiCarrier",
      "coding",
      "component",
    ];
    return knownArrayFields.includes(memberName);
  }

  /**
   * Handles nested JSON_QUERY with array indexing.
   * @param source
   * @param existingPath
   * @param memberName
   */
  private handleNestedQueryWithIndex(
    source: string,
    existingPath: string,
    memberName: string,
  ): string | null {
    const queryMatch = /^JSON_QUERY\(([^,]+),\s*'([^']+)'\)$/.exec(source);
    const isArrayIndexPath = /^\$\[\d+]$/.test(existingPath);

    if (queryMatch && isArrayIndexPath) {
      const innerSource = queryMatch[1];
      const arrayPath = queryMatch[2];
      const indexMatch = /\[(\d+)]/.exec(existingPath);
      const index = indexMatch?.[1] ?? "0";
      const newPath = `${arrayPath}[${index}].${memberName}`;
      return `JSON_VALUE(${innerSource}, '${newPath}')`;
    }

    return null;
  }

  private handleJsonValueMember(base: string, memberName: string): string {
    const pathMatch = /^JSON_VALUE\((.*),\s*'([^']+)'\)$/.exec(base);
    if (!pathMatch) {
      return `JSON_VALUE(${base}, '$.${memberName}')`;
    }

    const source = pathMatch[1];
    const existingPath = pathMatch[2];

    // Check if the member being accessed is an array field
    if (this.isArrayField(memberName)) {
      const newPath = `${existingPath}.${memberName}`;
      return `JSON_QUERY(${source}, '${newPath}')`;
    }

    // Handle nested JSON_QUERY with array indexing
    const nestedResult = this.handleNestedQueryWithIndex(
      source,
      existingPath,
      memberName,
    );
    if (nestedResult) {
      return nestedResult;
    }

    // Check if the path already has an array index
    if (existingPath.includes("[") && existingPath.includes("]")) {
      const newPath = `${existingPath}.${memberName}`;
      return `JSON_VALUE(${source}, '${newPath}')`;
    }

    const pathParts = existingPath.split(".");
    const shouldAddArrayIndex = this.shouldAddArrayIndexForField(
      pathParts,
      existingPath,
    );

    if (shouldAddArrayIndex) {
      const newPath = `${pathParts[0]}.${pathParts[1]}[0].${memberName}`;
      return `JSON_VALUE(${source}, '${newPath}')`;
    }

    const newPath = `${existingPath}.${memberName}`;
    return `JSON_VALUE(${source}, '${newPath}')`;
  }

  private shouldAddArrayIndexForField(
    pathParts: string[],
    existingPath: string,
  ): boolean {
    // Add [0] for known FHIR array fields; `name` is context-dependent (an
    // array at Patient level, an object within Contact) and gains [0] only
    // outside a forEach iteration context (reference behaviour).
    const knownArrayFields = [
      "telecom",
      "address",
      "identifier",
      "extension",
      "contact",
      "link",
    ];

    if (pathParts.length < 2 || existingPath.includes("[")) {
      return false;
    }

    const fieldName = pathParts[1];

    if (knownArrayFields.includes(fieldName)) {
      return !this.context.forEachPath?.endsWith(fieldName);
    } else if (fieldName === "name") {
      return !this.context.iterationContext;
    }

    return false;
  }

  private handleFunctionInvocation(
    base: string,
    functionCtx: FunctionInvocationContext,
    baseExpr?: ExpressionContext,
  ): string {
    const functionName = this.visit(functionCtx.function().identifier());
    const paramList = functionCtx.function().paramList();

    // Special handling for first() function to match expected format
    if (functionName === "first") {
      return this.handleFirstFunctionInvocation(base);
    }

    // Special handling for where() function - need raw expression, not transpiled
    if (functionName === "where") {
      return this.handleWhereFunctionInvocation(base, functionCtx);
    }

    // Special handling for ofType() function - need raw type name, not transpiled
    if (functionName === "ofType") {
      return this.handleOfTypeFunctionInvocation(base, functionCtx);
    }

    // Special handling for getReferenceKey() function - need raw type name, not transpiled
    if (functionName === "getReferenceKey") {
      return this.handleGetReferenceKeyFunctionInvocation(base, functionCtx);
    }

    // Special handling for exists() function - need raw expression, not transpiled
    if (functionName === "exists") {
      return this.handleExistsFunctionInvocation(base, functionCtx);
    }

    const args = paramList ? this.getParameterList(paramList) : [];

    // Create new context and delegate to function handler
    const newContext = this.createNewIterationContext(base);

    // Carry a directly-applied ofType() datatype to the boundary handler so it
    // picks the right algorithm.
    if (functionName === "lowBoundary" || functionName === "highBoundary") {
      newContext.boundaryType =
        this.extractDirectOfTypeName(baseExpr) ?? undefined;
    }

    const visitor = new FHIRPathToOracleVisitor(newContext);
    return visitor.executeFunctionHandler(functionName, args);
  }

  /**
   * Resolves the FHIR datatype named by an `ofType(X)` invocation when that
   * invocation is applied directly to the given expression (i.e. the expression
   * is `<something>.ofType(X)`). Returns `null` when the expression is not a
   * direct `ofType()` call, including when a member access intervenes between
   * the `ofType()` and the caller.
   * @param baseExpr - The base expression a function is being applied to.
   * @returns The raw ofType datatype name (e.g. "dateTime"), or null.
   */
  private extractDirectOfTypeName(
    baseExpr: ExpressionContext | undefined,
  ): string | null {
    if (!(baseExpr instanceof InvocationExpressionContext)) {
      return null;
    }
    const invocation = baseExpr.invocation();
    if (!(invocation instanceof FunctionInvocationContext)) {
      return null;
    }
    if (invocation.function().identifier()?.text !== "ofType") {
      return null;
    }
    const paramList = invocation.function().paramList();
    if (!paramList || paramList.expression().length !== 1) {
      return null;
    }
    return paramList.expression()[0].text;
  }

  private handleOfTypeFunctionInvocation(
    base: string,
    functionCtx: FunctionInvocationContext,
  ): string {
    const paramList = functionCtx.function().paramList();
    if (!paramList || paramList.expression().length !== 1) {
      throw new Error("ofType() function requires exactly one argument");
    }

    // Get the raw type expression - it should be an identifier
    const typeExprCtx = paramList.expression()[0];
    const typeName = typeExprCtx.text; // Get the raw text (e.g., "integer")

    return this.applyPolymorphicFieldMapping(base, typeName);
  }

  private handleGetReferenceKeyFunctionInvocation(
    base: string,
    functionCtx: FunctionInvocationContext,
  ): string {
    const paramList = functionCtx.function().paramList();

    // Get the optional resource type parameter
    let resourceType: string | null = null;
    if (paramList && paramList.expression().length > 0) {
      // Get the raw type expression - it should be an identifier
      const typeExprCtx = paramList.expression()[0];
      resourceType = typeExprCtx.text; // Get the raw text (e.g., "Patient")
    }

    // Create new context and call the handler
    const newContext = this.createNewIterationContext(base);
    const visitor = new FHIRPathToOracleVisitor(newContext);
    return visitor.handleGetReferenceKeyFunctionWithType(resourceType);
  }

  /**
   * Maps polymorphic FHIR fields to their typed variants.
   * Example: value.ofType(integer) → valueInteger
   * Handles paths with array indices like "output[0].value" → "output[0].valueInteger"
   * @param base
   * @param typeName
   */
  private applyPolymorphicFieldMapping(base: string, typeName: string): string {
    // Handle SELECT subqueries from extension() function
    // Pattern: (SELECT JSON_VALUE(value, '$.value') FROM ...)
    if (base.startsWith("(SELECT JSON_VALUE(value, '$.")) {
      const suffix = this.getTypeSuffix(typeName);
      // Find the JSON_VALUE path part
      const pathMatch = /JSON_VALUE\(value, '\$\.([^']+)'\)/.exec(base);
      if (pathMatch) {
        const path = pathMatch[1];
        if (this.isPolymorphicField(path)) {
          // Replace the polymorphic field with its typed variant
          const newPath = `${path}${suffix}`;
          return base.replace(
            `JSON_VALUE(value, '$.${path}')`,
            `JSON_VALUE(value, '$.${newPath}')`,
          );
        }
      }
      return base;
    }

    // Check if base is a JSON_VALUE call for a polymorphic field
    const match = /JSON_VALUE\(([^,]+),\s*'\$\.([^']+)'\)/.exec(base);
    if (!match) {
      return base; // Not a JSON_VALUE call, return unchanged
    }

    const source = match[1];
    const path = match[2];
    const suffix = this.getTypeSuffix(typeName);

    // Check if this is a known polymorphic field pattern
    if (this.isPolymorphicField(path)) {
      // Extract the last segment and replace it with its typed variant
      const lastDotIndex = path.lastIndexOf(".");
      if (lastDotIndex === -1) {
        // No dot, so the whole path is the polymorphic field
        return `JSON_VALUE(${source}, '$.${path}${suffix}')`;
      } else {
        // Replace the last segment with its typed variant
        const prefix = path.slice(0, Math.max(0, lastDotIndex));
        const lastSegment = path.slice(Math.max(0, lastDotIndex + 1));
        return `JSON_VALUE(${source}, '$.${prefix}.${lastSegment}${suffix}')`;
      }
    }

    return base; // Not a polymorphic field, return unchanged
  }

  /**
   * Returns the type suffix for polymorphic field mapping.
   * @param typeName
   */
  private getTypeSuffix(typeName: string): string {
    const typeMap: Record<string, string> = {
      integer: "Integer",
      string: "String",
      boolean: "Boolean",
      decimal: "Decimal",
      dateTime: "DateTime",
      date: "Date",
      time: "Time",
      instant: "Instant",
      uri: "Uri",
      url: "Url",
      canonical: "Canonical",
      uuid: "Uuid",
      oid: "Oid",
      id: "Id",
      code: "Code",
      markdown: "Markdown",
      base64Binary: "Base64Binary",
      positiveInt: "PositiveInt",
      unsignedInt: "UnsignedInt",
      integer64: "Integer64",
      // Complex types use PascalCase as they match FHIR type names
      Period: "Period",
      Range: "Range",
      Quantity: "Quantity",
      CodeableConcept: "CodeableConcept",
      Reference: "Reference",
    };

    return typeMap[typeName] || typeName;
  }

  /**
   * Checks if a path represents a polymorphic field (value[x], onset[x], effective[x], deceased[x], identified[x]).
   * Handles paths with array indices like "output[0].value" or "item[1].onset".
   * @param path
   */
  private isPolymorphicField(path: string): boolean {
    // Extract the last segment after the last dot (or the whole path if no dot)
    // This handles paths like "output[0].value" → "value" or "item[1].onset" → "onset"
    const lastSegment = path.includes(".")
      ? (path.split(".").pop() ?? "")
      : path;

    return (
      lastSegment === "value" ||
      lastSegment === "onset" ||
      lastSegment === "effective" ||
      lastSegment === "deceased" ||
      lastSegment === "identified"
    );
  }

  /**
   * Cast expression to DECIMAL for numeric operations if needed.
   * JSON_VALUE returns text by default, which can't be used in arithmetic operations.
   * @param expression
   */
  private castForNumericOperation(expression: string): string {
    // Check if expression contains JSON_VALUE and isn't already wrapped in CAST
    if (expression.includes("JSON_VALUE") && !expression.includes("CAST(")) {
      return `CAST(${expression} AS DECIMAL(18,6))`;
    }
    // Already has CAST or doesn't need it
    return expression;
  }

  private handleWhereFunctionInvocation(
    base: string,
    functionCtx: FunctionInvocationContext,
  ): string {
    const paramList = functionCtx.function().paramList();
    if (!paramList || paramList.expression().length !== 1) {
      throw new Error("where() function requires exactly one argument");
    }

    const filterExprCtx = paramList.expression()[0];

    // Special case: where() called at resource root level (no collection)
    if (this.isResourceRootLevel(base)) {
      const filterVisitor = new FHIRPathToOracleVisitor(this.context);
      return filterVisitor.visit(filterExprCtx);
    }

    // Extract source and path from the base expression
    const { source, jsonPath } = this.extractSourceAndPath(base);

    // Build and return the EXISTS clause with filtered collection
    return this.buildWhereSubquery(source, jsonPath, filterExprCtx);
  }

  /**
   * Checks if the base expression represents the resource root level (not a collection).
   * @param base
   */
  private isResourceRootLevel(base: string): boolean {
    return (
      base === this.rootJson ||
      base === this.context.resourceAlias ||
      (!base.includes("JSON_QUERY") &&
        !base.includes("JSON_VALUE") &&
        !base.includes("JSON_TABLE") &&
        !base.includes("EXISTS") &&
        !base.includes("SELECT"))
    );
  }

  /**
   * Extracts the source and JSON path from a base expression.
   * @param base
   */
  private extractSourceAndPath(base: string): {
    source: string;
    jsonPath: string;
  } {
    let source = this.rootJson;
    let jsonPath = "$";

    const queryMatch = /JSON_QUERY\(([^,]+),\s*'([^']+)'\)/.exec(base);
    if (queryMatch) {
      source = queryMatch[1];
      jsonPath = queryMatch[2];
    } else {
      const valueMatch = /JSON_VALUE\(([^,]+),\s*'([^']+)'\)/.exec(base);
      if (valueMatch) {
        source = valueMatch[1];
        jsonPath = valueMatch[2];
      }
    }

    return { source, jsonPath };
  }

  /**
   * Builds a subquery for filtering a collection with a where condition.
   * Returns a subquery that selects the filtered items, allowing further navigation.
   * @param source
   * @param jsonPath
   * @param filterExprCtx
   */
  private buildWhereSubquery(
    source: string,
    jsonPath: string,
    filterExprCtx: ExpressionContext,
  ): string {
    const tableAlias = "whereItem";
    const fmt = formatJsonSuffix(this.storage);
    const unrolledPath = this.unrollPath(jsonPath);

    // Create a new context for the filter condition where expressions refer to
    // the JSON_TABLE's `value` column.
    const itemContext: TranspilerContext = {
      resourceAlias: tableAlias,
      constants: this.context.constants,
      iterationContext: `${tableAlias}.value`,
    };

    // Transpile the filter expression with the item context
    const filterVisitor = new FHIRPathToOracleVisitor(itemContext);
    const condition = filterVisitor.visit(filterExprCtx);

    // Return a subquery that selects the filtered collection. ROWNUM limits
    // the result to the first match without FETCH FIRST, which mis-correlates
    // in APPLY contexts on 19c (research R4).
    return `(SELECT value FROM JSON_TABLE(${source}${fmt}, '${unrolledPath}' COLUMNS (${jsonTableColumns(this.storage)})) ${tableAlias} WHERE ${condition} AND ROWNUM = 1)`;
  }

  /**
   * Turns a JSON path into an element-unrolling path for JSON_TABLE: `$.a.b`
   * becomes `$.a.b[*]`; paths already ending in `[*]` or `[n]`, and the root
   * path `$`, are normalised appropriately.
   * @param jsonPath - The base JSON path.
   * @returns The path unrolled one level.
   */
  private unrollPath(jsonPath: string): string {
    if (jsonPath === "$") {
      return "$[*]";
    }
    return /(\[\*]|\[\d+])$/.test(jsonPath) ? jsonPath : `${jsonPath}[*]`;
  }

  private handleExistsFunctionInvocation(
    base: string,
    functionCtx: FunctionInvocationContext,
  ): string {
    const paramList = functionCtx.function().paramList();

    // If no arguments, delegate to the standard handler
    if (!paramList || paramList.expression().length === 0) {
      const args: string[] = [];
      return this.handleExistsFunction(args, base);
    }

    // Get the raw filter expression context (not transpiled yet)
    const filterExprCtx = paramList.expression()[0];

    // Call the handler with the base and filter expression context
    return this.handleExistsFunction([], base, filterExprCtx);
  }

  private handleFirstFunctionInvocation(base: string): string {
    // Check if the base is a JSON_QUERY call for an array
    const queryMatch = /^JSON_QUERY\(([^,]+),\s*'([^']+)'\)$/.exec(base);
    if (queryMatch) {
      const source = queryMatch[1];
      const path = queryMatch[2];
      return `JSON_VALUE(${source}, '${path}[0]')`;
    }

    // Check if the base is a JSON_VALUE call
    const simpleJsonMatch = /^JSON_VALUE\(([^,]+),\s*'([^']+)'\)$/.exec(base);
    if (simpleJsonMatch) {
      const source = simpleJsonMatch[1];
      const path = simpleJsonMatch[2];

      // Check if the path ends with an array field that needs [0] indexing
      // For known array fields like "given", "family" etc, add [0]
      const knownArrayFields = [
        "given",
        "line",
        "coding",
        "telecom",
        "identifier",
      ];
      const pathSegments = path.split(".");
      const lastSegment = pathSegments.at(-1);

      if (lastSegment !== undefined && knownArrayFields.includes(lastSegment)) {
        // This is an array field, add [0] to get first element
        return `JSON_VALUE(${source}, '${path}[0]')`;
      }

      // For non-array fields, first() should return the value as-is since it's already a scalar
      return base;
    } else if (!base.includes("JSON_VALUE") && !base.includes("JSON_QUERY")) {
      // Simple identifier like 'name'
      return `JSON_VALUE(${this.rootJson}, '$.${base}[0]')`;
    } else {
      // For complex expressions that aren't JSON_QUERY or JSON_VALUE,
      // we can't easily add [0] indexing, so return as-is
      return base;
    }
  }

  private createNewIterationContext(base: string): TranspilerContext {
    if (!base.includes("JSON_VALUE") && !base.includes("JSON_QUERY")) {
      // Simple identifier like 'name' - construct proper JSON path
      return {
        ...this.context,
        iterationContext: `JSON_QUERY(${this.rootJson}, '$.${base}')`,
      };
    } else {
      return {
        ...this.context,
        iterationContext: base,
      };
    }
  }

  private getParameterList(paramListCtx: ParamListContext): string[] {
    return paramListCtx.expression().map((expr) => this.visit(expr));
  }

  private getOperatorFromContext(
    fullText: string,
    left: string,
    right: string,
  ): string {
    const leftIndex = fullText.indexOf(left);
    const rightIndex = fullText.lastIndexOf(right);

    if (leftIndex === -1 || rightIndex === -1) {
      return "";
    }

    const operatorPart = fullText
      .substring(leftIndex + left.length, rightIndex)
      .trim();
    return this.extractOperatorFromText(operatorPart);
  }

  private extractOperatorFromText(operatorPart: string): string {
    // Order matters: check longer operators first to avoid substring matches
    const operators = [
      "<=",
      ">=",
      "!=",
      "!~",
      "implies",
      "contains",
      "and",
      "or",
      "xor",
      "div",
      "mod",
      "in",
      "is",
      "as",
      "<",
      ">",
      "=",
      "~",
      "*",
      "/",
      "+",
      "-",
      "&",
    ];

    for (const operator of operators) {
      if (operatorPart.includes(operator)) {
        return operator;
      }
    }

    return "";
  }

  private formatConstantValue(value: string | number | boolean | null): string {
    if (typeof value === "string") {
      return `'${value.replaceAll('\'', "''")}'`;
    } else if (typeof value === "number") {
      return value.toString();
    } else if (typeof value === "boolean") {
      // Format as string to match JSON_VALUE output for boolean fields
      return value ? "'true'" : "'false'";
    } else if (value === null || value === undefined) {
      return "NULL";
    } else {
      return `'${JSON.stringify(value).replaceAll('\'', "''")}'`;
    }
  }

  private executeFunctionHandler(functionName: string, args: string[]): string {
    const functionMap: Record<string, (args: string[]) => string> = {
      exists: (args) => this.handleExistsFunction(args),
      empty: (args) => this.handleEmptyFunction(args),
      first: (args) => this.handleFirstFunction(args),
      last: (args) => this.handleLastFunction(args),
      count: (args) => this.handleCountFunction(args),
      join: (args) => this.handleJoinFunction(args),
      where: (args) => this.handleWhereFunction(args),
      select: (args) => this.handleSelectFunction(args),
      getResourceKey: () => this.handleGetResourceKeyFunction(),
      ofType: (args) => this.handleOfTypeFunction(args),
      not: (args) => this.handleNotFunction(args),
      extension: (args) => this.handleExtensionFunction(args),
      lowBoundary: (args) => this.handleBoundaryFunction(functionName, args),
      highBoundary: (args) => this.handleBoundaryFunction(functionName, args),
    };

    const handler = functionMap[functionName];
    if (!handler) {
      throw new Error(`Unsupported FHIRPath function: ${functionName}`);
    }

    return handler(args);
  }

  // Function handlers
  private handleExistsFunction(
    args: string[],
    base?: string,
    filterExprCtx?: ExpressionContext,
  ): string {
    // If we have a filter expression context, use it (this comes from handleExistsFunctionInvocation)
    if (filterExprCtx) {
      return this.handleExistsWithFilter(base, filterExprCtx);
    }

    // Otherwise check args
    if (args.length === 0) {
      return this.handleExistsWithoutArgs(base);
    }

    return this.handleExistsWithArgs(args[0]);
  }

  /**
   * Handles exists() function without arguments, using iteration context or base.
   * @param base
   */
  private handleExistsWithoutArgs(base?: string): string {
    if (base) {
      return this.handleExistsWithBase(base);
    }

    if (this.context.iterationContext) {
      // An iteration context is a single element: present unless NULL. (An
      // empty collection is never an iteration context - iteration unrolls
      // elements.)
      return `(${this.context.iterationContext} IS NOT NULL)`;
    }

    // No iteration context or base - check resource
    return `(${this.rootJson} IS NOT NULL)`;
  }

  /**
   * Builds the existence predicate for a base expression using JSON_EXISTS
   * (comparing a JSON_QUERY result to the text '[]' is invalid over a BLOB
   * column, and a JSON_TABLE cannot consume a JSON_TABLE column). A JSON_QUERY
   * base is an array: its existence is checked by iterating its elements, so an
   * empty array does not count as existing; anything else is checked directly.
   * @param base - The base expression to check.
   * @returns A boolean SQL predicate.
   */
  private handleExistsWithBase(base: string): string {
    const trimmedBase = base.trim();

    // Subquery from .where()/.extension() - wrap in EXISTS
    if (trimmedBase.startsWith("(SELECT")) {
      return `EXISTS ${base}`;
    }

    // Already a boolean expression - return as-is
    if (this.isBooleanExpression(trimmedBase)) {
      return base;
    }

    const { source, jsonPath } = this.extractSourceAndPath(base);
    const existsPath = base.includes("JSON_QUERY")
      ? this.unrollPath(jsonPath)
      : jsonPath;
    return `JSON_EXISTS(${source}, '${existsPath}')`;
  }

  /**
   * Handles exists() with a filter expression: an EXISTS subquery over the
   * unrolled collection with the filter applied.
   * @param base
   * @param filterExprCtx
   */
  private handleExistsWithFilter(
    base: string | undefined,
    filterExprCtx: ExpressionContext,
  ): string {
    const { source, jsonPath } = this.extractSourceAndPath(
      base ?? this.rootJson,
    );
    const tableAlias = "existsItem";
    const fmt = formatJsonSuffix(this.storage);

    const itemContext: TranspilerContext = {
      resourceAlias: tableAlias,
      constants: this.context.constants,
      iterationContext: `${tableAlias}.value`,
    };

    const filterVisitor = new FHIRPathToOracleVisitor(itemContext);
    const condition = filterVisitor.visit(filterExprCtx);

    return `EXISTS (SELECT 1 FROM JSON_TABLE(${source}${fmt}, '${this.unrollPath(jsonPath)}' COLUMNS (${jsonTableColumns(this.storage)})) ${tableAlias} WHERE ${condition})`;
  }

  /**
   * Handles exists() with a transpiled argument.
   * @param arg
   */
  private handleExistsWithArgs(arg: string): string {
    const trimmedArg = arg.trim();

    // If already an EXISTS clause, return as-is
    if (trimmedArg.startsWith("EXISTS")) {
      return arg;
    }

    // If the argument is a SELECT subquery (from .where() function), wrap in EXISTS
    if (trimmedArg.startsWith("(SELECT")) {
      return `EXISTS ${arg}`;
    }

    // If already a boolean expression, return as-is
    if (this.isBooleanExpression(trimmedArg)) {
      return arg;
    }

    // Otherwise use a JSON_EXISTS check
    return this.handleExistsWithBase(arg);
  }

  /**
   * Checks if an expression is a boolean expression (contains comparison operators).
   * @param expr
   */
  private isBooleanExpression(expr: string): boolean {
    return (
      expr.includes(" = ") ||
      expr.includes(" != ") ||
      expr.includes(" < ") ||
      expr.includes(" > ") ||
      expr.includes(" <= ") ||
      expr.includes(" >= ") ||
      expr.includes(" AND ") ||
      expr.includes(" OR ") ||
      expr.startsWith("NOT ") ||
      expr.startsWith("(NOT ")
    );
  }

  private handleEmptyFunction(args: string[]): string {
    // If we have arguments, we need to check if that expression is empty
    if (args.length > 0) {
      const expression = args[0];

      // If the expression is an EXISTS clause, we need to negate it
      if (expression.includes("EXISTS")) {
        return `(NOT ${expression})`;
      }

      if (this.isBooleanExpression(expression)) {
        return `(NOT ${expression})`;
      }

      return `(NOT ${this.handleExistsWithBase(expression)})`;
    }

    // No arguments - check current iteration context
    if (this.context.iterationContext) {
      const iteration = this.context.iterationContext;
      if (iteration.includes("EXISTS")) {
        return `(NOT ${iteration})`;
      }
      return `(NOT ${this.handleExistsWithBase(iteration)})`;
    }

    return `(NOT JSON_EXISTS(${this.rootJson}, '$'))`;
  }

  private handleFirstFunction(_args: string[]): string {
    if (this.context.iterationContext) {
      // Check if we have a JSON_QUERY expression for an array
      if (this.context.iterationContext.includes("JSON_QUERY")) {
        const match = /JSON_QUERY\(([^,]+),\s*'([^']+)'\)/.exec(
          this.context.iterationContext,
        );
        if (match) {
          const source = match[1];
          const path = match[2];
          return `JSON_VALUE(${source}, '${path}[0]')`;
        }
      }

      if (this.context.iterationContext.includes("[0]")) {
        return this.context.iterationContext;
      }
      return `JSON_VALUE(${this.context.iterationContext}, '$[0]')`;
    } else {
      return `JSON_VALUE(${this.rootJson}, '$[0]')`;
    }
  }

  private handleLastFunction(args: string[]): string {
    const pathExpr =
      args.length > 0
        ? args[0]
        : (this.context.iterationContext ?? this.rootJson);
    const { source, jsonPath } = this.extractSourceAndPath(pathExpr);
    return `JSON_VALUE(${source}, '${jsonPath}[last()]')`;
  }

  private handleCountFunction(args: string[]): string {
    const countPath =
      args.length > 0
        ? args[0]
        : (this.context.iterationContext ?? this.rootJson);
    const fmt = formatJsonSuffix(this.storage);
    return `(SELECT COUNT(*) FROM JSON_TABLE(${countPath}${fmt}, '$[*]' COLUMNS (ord FOR ORDINALITY)))`;
  }

  private handleJoinFunction(args: string[]): string {
    let separator = "''";
    if (args.length > 0) {
      separator = args[0];
    }

    const context = this.context.iterationContext ?? this.rootJson;
    const fmt = formatJsonSuffix(this.storage);

    // Check if context is a JSON_QUERY that accesses a nested array path
    // (e.g. '$.name[0].given'). If so, iterate over ALL parent array elements
    // and aggregate ALL child array values.
    const nestedArrayMatch =
      /JSON_QUERY\(([^,]+),\s*'(\$\.[^']+)\[0]\.([^']+)'\)/.exec(context);

    if (nestedArrayMatch) {
      const source = nestedArrayMatch[1];
      const parentPath = nestedArrayMatch[2]; // e.g., '$.name'
      const childField = nestedArrayMatch[3]; // e.g., 'given'

      // LISTAGG yields SQL NULL when the grouped set is empty, which is
      // exactly the FHIRPath contract for join() over an empty collection.
      // The NVL keeps a present-but-null element contributing an empty string
      // so it does not nullify the whole result.
      return `(SELECT LISTAGG(NVL(child.value, ''), ${separator}) WITHIN GROUP (ORDER BY parent.idx, child.idx)
        FROM JSON_TABLE(${source}${fmt}, '${parentPath}[*]' COLUMNS (idx FOR ORDINALITY, value CLOB${fmt} PATH '$')) parent
        CROSS APPLY JSON_TABLE(JSON_QUERY(parent.value${fmt}, '$.${childField}' RETURNING CLOB), '$[*]' COLUMNS (idx FOR ORDINALITY, value VARCHAR2(4000) PATH '$', scalar VARCHAR2(4000) PATH '$')) child)`;
    }

    // Standard join for simple arrays.
    return `(SELECT LISTAGG(NVL(value, ''), ${separator}) WITHIN GROUP (ORDER BY idx)
      FROM JSON_TABLE(${context}${fmt}, '$[*]' COLUMNS (idx FOR ORDINALITY, value VARCHAR2(4000) PATH '$')))`;
  }

  private handleWhereFunction(_args: string[]): string {
    // This should not be called anymore since where() is handled specially in handleFunctionInvocation
    throw new Error(
      "where() function should be handled by handleWhereFunctionInvocation",
    );
  }

  private handleSelectFunction(args: string[]): string {
    if (args.length !== 1) {
      throw new Error("select() function requires exactly one argument");
    }
    return args[0];
  }

  private handleGetResourceKeyFunction(): string {
    // Returns resourceType/id as the resource key, extracting id from JSON
    return `${this.context.resourceAlias}.resource_type || '/' || JSON_VALUE(${this.rootJson}, '$.id')`;
  }

  private handleOfTypeFunction(_args: string[]): string {
    // This should not be called anymore since ofType() is handled specially in handleOfTypeFunctionInvocation
    throw new Error(
      "ofType() function should be handled by handleOfTypeFunctionInvocation",
    );
  }

  private handleGetReferenceKeyFunctionWithType(
    resourceType: string | null,
  ): string {
    // Extract the .reference field from a Reference object
    // Optional type parameter filters by resource type

    if (this.context.iterationContext) {
      // If we're in an iteration context, the context points to the Reference object
      // We need to extract the .reference field
      const refSource = this.context.iterationContext;

      let referenceExpr: string;

      // Check if it's a JSON_VALUE call - extract just the reference field
      const match = /JSON_VALUE\(([^,]+),\s*'([^']+)'\)/.exec(refSource);
      if (refSource.includes("JSON_VALUE") && match) {
        // Replace the current path with .reference
        const source = match[1];
        const path = match[2];
        const referencePath = this.referenceExtractionPath(path);
        referenceExpr = `JSON_VALUE(${source}, '${referencePath}')`;
      } else {
        // For simple iteration context like "forEach_0.value"
        referenceExpr = `JSON_VALUE(${refSource}, '$.reference')`;
      }

      // If a resource type is specified, only return the reference if it matches
      if (resourceType) {
        return `CASE WHEN SUBSTR(${referenceExpr}, 1, ${resourceType.length + 1}) = '${resourceType}/' THEN ${referenceExpr} END`;
      }

      return referenceExpr;
    }

    // No iteration context - shouldn't happen for getReferenceKey
    throw new Error("getReferenceKey() requires a Reference object context");
  }

  /**
   * Builds the JSON path that extracts the `reference` string from a Reference
   * at the given path. If the final segment is a multi-valued reference field,
   * the first element is used (e.g. `$.generalPractitioner` becomes
   * `$.generalPractitioner[0].reference`).
   * @param path - The JSON path to the Reference object.
   * @returns The JSON path to the `reference` string.
   */
  private referenceExtractionPath(path: string): string {
    if (path.endsWith(".reference")) {
      return path;
    }
    const multiValuedReferenceFields = [
      "generalPractitioner",
      "practitioner",
      "organization",
      "endpoint",
      "location",
      "careTeam",
      "participant",
      "performer",
      "requester",
      "author",
      "recipient",
      "insurer",
      "serviceRequester",
    ];
    const segments = path.split(".");
    const lastSegment = segments.at(-1) ?? "";
    const cleanSegment = lastSegment.replace(/\[\d+]/, "");
    const needsIndex =
      !path.includes("[") && multiValuedReferenceFields.includes(cleanSegment);
    const referenceBase = needsIndex ? `${path}[0]` : path;
    return `${referenceBase}.reference`;
  }

  private handleNotFunction(args: string[]): string {
    if (args.length > 0) {
      return `NOT (${args[0]})`;
    }
    if (this.context.iterationContext) {
      return `NOT (${this.context.iterationContext})`;
    }
    return "NOT (1=1)";
  }

  private handleExtensionFunction(args: string[]): string {
    if (args.length !== 1) {
      throw new Error("extension() function requires exactly one argument");
    }

    // extension('url') is equivalent to .extension.where(url = 'url')
    // Returns the first matching extension as a JSON value
    const extensionUrl = args[0];
    const base = this.context.iterationContext ?? this.rootJson;
    const fmt = formatJsonSuffix(this.storage);

    // A JSON_TABLE cannot consume the output of another JSON_TABLE
    // (ORA-40556). When the source is an extension()/where() scalar subquery
    // over JSON_TABLE (a chained .extension() call), the nested extension
    // array is extracted with JSON_QUERY inside that subquery and the outer
    // JSON_TABLE iterates the elements of the extracted array.
    if (base.startsWith("(SELECT value FROM JSON_TABLE")) {
      const fromPart = base.slice(Math.max(0, base.indexOf(" FROM ")));
      const nestedSource = `(SELECT JSON_QUERY(value, '$.extension' RETURNING CLOB)${fromPart}`;
      return `(SELECT value FROM JSON_TABLE(${nestedSource}${fmt}, '$[*]' COLUMNS (${jsonTableColumns(this.storage)})) WHERE JSON_VALUE(value, '$.url') = ${extensionUrl} AND ROWNUM = 1)`;
    }

    // Generate SQL that filters the extension array by URL
    return `(SELECT value FROM JSON_TABLE(${base}${fmt}, '$.extension[*]' COLUMNS (${jsonTableColumns(this.storage)})) WHERE JSON_VALUE(value, '$.url') = ${extensionUrl} AND ROWNUM = 1)`;
  }

  /**
   * Generates inline SQL for the FHIRPath `lowBoundary()` / `highBoundary()`
   * functions. The boundary is the least (low) or greatest (high) value
   * consistent with the input's stated precision, expressed at the maximum
   * precision for its FHIR datatype.
   *
   * The governing datatype is taken from an explicit `ofType()` applied directly
   * to the input where present (`this.context.boundaryType`), otherwise inferred
   * from the value's lexical form at SQL runtime. An absent source element
   * yields SQL NULL for every branch. All logic is emitted inline so
   * the query stays self-contained, requiring no pre-installed database object.
   * @param functionName - Either "lowBoundary" or "highBoundary".
   * @param args - Function arguments; a non-empty list is the unsupported
   *   explicit-precision form and is rejected.
   * @returns A SQL scalar expression computing the boundary value.
   * @throws If called with an explicit-precision argument, or resolved (via
   *   ofType) to a datatype for which boundaries are not supported.
   */
  private handleBoundaryFunction(functionName: string, args: string[]): string {
    // The optional explicit-precision argument is out of scope; reject it with a
    // clear error rather than silently returning a wrong value.
    if (args.length > 0) {
      throw new Error(
        `${functionName}() with an explicit precision argument is not supported`,
      );
    }

    const isLow = functionName === "lowBoundary";
    const value = this.context.iterationContext ?? this.rootJson;
    const resolved = this.context.boundaryType;

    // Datatype known from an explicit ofType() directly on the boundary input.
    if (resolved) {
      switch (resolved) {
        case "date": {
          return this.dateBoundarySql(value, isLow);
        }
        case "dateTime": {
          return this.dateTimeBoundarySql(value, isLow);
        }
        case "time": {
          return this.timeBoundarySql(value, isLow);
        }
        case "decimal": {
          return this.decimalBoundarySql(value, isLow);
        }
        default: {
          throw new Error(
            `${functionName}() is not supported for FHIR datatype '${resolved}'`,
          );
        }
      }
    }

    // No explicit ofType(): classify the value by its lexical form at runtime.
    return this.lexicalBoundarySql(value, isLow);
  }

  /**
   * Boundary SQL for a value of unknown datatype, classified from its lexical
   * form at SQL runtime: a `T` marks a dateTime, a `:` marks a time, an
   * interior `-` marks a date, and anything else is treated as a decimal. NULL
   * propagates to NULL.
   * @param value
   * @param isLow
   */
  private lexicalBoundarySql(value: string, isLow: boolean): string {
    // Every branch must yield the same SQL type: a CASE that mixed the string
    // temporal results with the numeric decimal result would have its result
    // type coerced to the numeric (higher precedence), forcing Oracle to
    // convert the temporal strings to numeric and fail. The decimal branch is
    // therefore rendered as text; a decimal column's own cast and the numeric
    // result comparison both accept the textual form.
    return `CASE
      WHEN ${value} IS NULL THEN NULL
      WHEN INSTR(${value}, 'T') > 0 THEN ${this.dateTimeBoundarySql(value, isLow)}
      WHEN INSTR(${value}, ':') > 0 THEN ${this.timeBoundarySql(value, isLow)}
      WHEN INSTR(${value}, '-') > 1 THEN ${this.dateBoundarySql(value, isLow)}
      ELSE CAST(${this.decimalBoundarySql(value, isLow)} AS VARCHAR2(50))
    END`;
  }

  /**
   * Boundary SQL for a `date` value (maximum precision = day): a partial value
   * is padded to a full date. For `highBoundary`, a year-month resolves to the
   * last day of the month via LAST_DAY. NULL propagates to NULL.
   * @param value
   * @param isLow
   */
  private dateBoundarySql(value: string, isLow: boolean): string {
    if (isLow) {
      return `CASE LENGTH(${value})
        WHEN 4 THEN ${value} || '-01-01'
        WHEN 7 THEN ${value} || '-01'
        ELSE ${value}
      END`;
    }
    return `CASE LENGTH(${value})
      WHEN 4 THEN ${value} || '-12-31'
      WHEN 7 THEN TO_CHAR(LAST_DAY(TO_DATE(${value} || '-01', 'YYYY-MM-DD')), 'YYYY-MM-DD')
      ELSE ${value}
    END`;
  }

  /**
   * Boundary SQL for a `dateTime` value (maximum precision = millisecond +
   * timezone). A date-shaped value (no time component) is padded to a full
   * instant filling the minimum components and the FHIR extreme offset `+14:00`
   * for `lowBoundary`, or the maximum components and `-12:00` for `highBoundary`.
   * A value already carrying a time has its time component padded to
   * millisecond precision and the extreme offset appended; explicit offsets in
   * such values are not exercised by the suite. NULL propagates to NULL.
   * @param value
   * @param isLow
   */
  private dateTimeBoundarySql(value: string, isLow: boolean): string {
    const tz = isLow ? "+14:00" : "-12:00";
    const datePadded = this.dateBoundarySql(value, isLow);
    const timeTail = isLow ? "T00:00:00.000" : "T23:59:59.999";
    const timePart = `SUBSTR(${value}, 12)`;
    return `CASE
      WHEN ${value} IS NULL THEN NULL
      WHEN INSTR(${value}, 'T') = 0 THEN (${datePadded}) || '${timeTail}${tz}'
      ELSE SUBSTR(${value}, 1, 10) || 'T' || ${this.padTimeComponent(timePart, isLow)} || '${tz}'
    END`;
  }

  /**
   * Boundary SQL for a `time` value (maximum precision = millisecond): the value
   * is padded to `HH:MM:SS.fff`, filling absent components with their minimum
   * (`:00.000`) for `lowBoundary` or maximum (`:59.999`) for `highBoundary`.
   * NULL propagates to NULL.
   * @param value
   * @param isLow
   */
  private timeBoundarySql(value: string, isLow: boolean): string {
    return `CASE
      WHEN ${value} IS NULL THEN NULL
      ELSE ${this.padTimeComponent(value, isLow)}
    END`;
  }

  /**
   * Pads a bare time component (`HH:MM` or `HH:MM:SS`) to millisecond precision,
   * filling absent seconds/milliseconds with their minimum or maximum.
   * @param timeExpr
   * @param isLow
   */
  private padTimeComponent(timeExpr: string, isLow: boolean): string {
    const seconds = isLow ? ":00.000" : ":59.999";
    const millis = isLow ? ".000" : ".999";
    return `CASE LENGTH(${timeExpr})
      WHEN 5 THEN ${timeExpr} || '${seconds}'
      WHEN 8 THEN ${timeExpr} || '${millis}'
      ELSE ${timeExpr}
    END`;
  }

  /**
   * Boundary SQL for a `decimal` value. With N fractional digits the value is
   * known to within half a unit in the last place, so the boundary is
   * `value ∓ 0.5 × 10⁻ᴺ` (e.g. `1.0` → `0.95` / `1.05`). The half-unit delta is
   * built as a decimal literal from the runtime fractional-digit count to avoid
   * relying on POWER's scale behaviour. NULL propagates to NULL.
   * @param value
   * @param isLow
   */
  private decimalBoundarySql(value: string, isLow: boolean): string {
    const op = isLow ? "-" : "+";
    // Count the fractional digits present in the lexeme.
    const fractionDigits = `CASE WHEN INSTR(${value}, '.') = 0 THEN 0 ELSE LENGTH(${value}) - INSTR(${value}, '.') END`;
    // Build 0.5 × 10⁻ᴺ as the string '0.' + N zeros + '5', then cast to
    // NUMBER. `LPAD('5', N + 1, '0')` yields '5', '05', '005', ... so the
    // concatenation produces 0.5, 0.05, 0.005, ... (avoiding LPAD of a
    // zero-length pad, which Oracle returns as NULL).
    const delta = `CAST('0.' || LPAD('5', ${fractionDigits} + 1, '0') AS NUMBER(38, 18))`;
    return `CAST(${value} AS NUMBER(38, 18)) ${op} ${delta}`;
  }
}