// lib/table-formula.js — bounded deterministic formulas over cap.table/1.
// Formula text is parsed as data by the closed grammar below. The evaluator has
// no dynamic-code, network, clock, random, indirect-reference, or storage path.
// Whitespace is the space character only (tabs/newlines are syntax errors), and
// unary +/-/NOT apply exactly once (chained unary like `- - 5` is a syntax error).

import {
  assertCanonicalTable,
  normalizeTableType,
  tableUtf8Bytes,
  TABLE_LIMITS,
  TABLE_VERSION,
  TableError,
} from "./table-core.js";

export const FORMULA_LIMITS = Object.freeze({
  maxSourceBytes: 4096,
  maxAstNodes: 256,
  maxAstDepth: 32,
  maxCellVisits: 5_000_000,
  maxWorkUnits: TABLE_LIMITS.maxWorkUnits,
});

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const STORED_PRECISION = 38;
const STORED_SCALE = 18;
const SUM_PRECISION = 48;
const INTERMEDIATE_PRECISION = 76;
const INTERMEDIATE_SCALE = 36;
const POW10 = [1n];
for (let index = 1; index <= 80; index++) POW10.push(POW10[index - 1] * 10n);

const SCALAR_FUNCTIONS = new Set(["ABS", "ROUND", "IF", "COALESCE"]);
const AGGREGATE_FUNCTIONS = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNTA"]);
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function fail(code, detail = "") {
  throw new TableError(code, detail);
}

function ownData(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("table_formula_request", label);
  let descriptors;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("table_formula_request", label);
  }
  if (prototype !== Object.prototype && prototype !== null) fail("table_formula_request", label);
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("table_formula_request", label);
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail("table_formula_request", `${label}.${key}`);
    }
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return copy;
}

function exactData(value, allowed, required, label) {
  const copy = ownData(value, label);
  for (const key of Object.keys(copy)) if (!allowed.includes(key)) fail("table_unknown_field", `${label}.${key}`);
  for (const key of required) if (!Object.hasOwn(copy, key)) fail("table_formula_request", `${label}.${key}`);
  return copy;
}

function positiveCoordinate(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail("table_formula_request", label);
  return value;
}

function parseReadRange(value, table) {
  const range = exactData(value, ["r1", "c1", "r2", "c2"], ["r1", "c1", "r2", "c2"], "request.readRange");
  const out = Object.freeze({
    r1: positiveCoordinate(range.r1, "request.readRange.r1"),
    c1: positiveCoordinate(range.c1, "request.readRange.c1"),
    r2: positiveCoordinate(range.r2, "request.readRange.r2"),
    c2: positiveCoordinate(range.c2, "request.readRange.c2"),
  });
  if (out.r2 < out.r1 || out.c2 < out.c1 || out.r2 > table.rows.length || out.c2 > table.columns.length) {
    fail("table_formula_reference_out_of_range", "request.readRange");
  }
  return out;
}

function parseTargetRows(value, table) {
  const rows = exactData(value, ["r1", "r2"], ["r1", "r2"], "request.targetRows");
  const out = Object.freeze({
    r1: positiveCoordinate(rows.r1, "request.targetRows.r1"),
    r2: positiveCoordinate(rows.r2, "request.targetRows.r2"),
  });
  if (out.r2 < out.r1 || out.r2 > table.rows.length) fail("table_formula_reference_out_of_range", "request.targetRows");
  return out;
}

function parseResult(value) {
  const result = exactData(value, ["header", "type"], ["header", "type"], "request.result");
  if (typeof result.header !== "string" || tableUtf8Bytes(result.header) > TABLE_LIMITS.maxHeaderBytes) {
    fail("table_header_bound", "request.result.header");
  }
  return Object.freeze({ header: result.header, type: normalizeTableType(ownData(result.type, "request.result.type"), "request.result.type") });
}

function parseNumericPolicy(value) {
  const policy = exactData(value, ["divisionScale", "rounding"], ["divisionScale", "rounding"], "request.numericPolicy");
  if (!Number.isInteger(policy.divisionScale) || policy.divisionScale < 0 || policy.divisionScale > STORED_SCALE) {
    fail("table_formula_request", "request.numericPolicy.divisionScale");
  }
  if (policy.rounding !== "half_even") fail("table_formula_request", "request.numericPolicy.rounding");
  return Object.freeze({ divisionScale: policy.divisionScale, rounding: policy.rounding });
}

function formulaRequest(value, table) {
  const request = ownData(value, "request");
  const append = request.mode === "append_column";
  const scalar = request.mode === "scalar";
  if (!append && !scalar) fail("table_formula_request", "request.mode");
  const allowed = append
    ? ["mode", "readRange", "targetRows", "expression", "result", "numericPolicy"]
    : ["mode", "readRange", "expression", "result", "numericPolicy"];
  const exact = exactData(request, allowed, allowed, "request");
  if (typeof exact.expression !== "string") fail("table_formula_request", "request.expression");
  return Object.freeze({
    mode: exact.mode,
    readRange: parseReadRange(exact.readRange, table),
    targetRows: append ? parseTargetRows(exact.targetRows, table) : null,
    expression: exact.expression,
    result: parseResult(exact.result),
    numericPolicy: parseNumericPolicy(exact.numericPolicy),
  });
}

export function createFormulaBudget() {
  let workUnits = 0;
  let cellVisits = 0;
  const spend = (amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0) fail("table_formula_request", "work amount");
    workUnits += amount;
    if (workUnits > FORMULA_LIMITS.maxWorkUnits) fail("table_formula_work_bound", String(FORMULA_LIMITS.maxWorkUnits));
  };
  return Object.freeze({
    spend,
    visit(amount = 1) {
      if (!Number.isSafeInteger(amount) || amount < 0) fail("table_formula_request", "visit amount");
      cellVisits += amount;
      if (cellVisits > FORMULA_LIMITS.maxCellVisits) fail("table_formula_visit_bound", String(FORMULA_LIMITS.maxCellVisits));
      spend(amount);
    },
    snapshot() {
      return Object.freeze({ workUnits, cellVisits });
    },
  });
}

function syntax(detail) {
  fail("table_formula_syntax", detail);
}

class Lexer {
  constructor(source) {
    this.source = source;
    this.offset = 0;
  }
  next() {
    while (this.source[this.offset] === " ") this.offset++;
    if (this.offset >= this.source.length) return Object.freeze({ kind: "eof", value: "", at: this.offset });
    const at = this.offset;
    const rest = this.source.slice(at);
    const pair = rest.slice(0, 2);
    if (["<=", ">=", "<>"].includes(pair)) {
      this.offset += 2;
      return Object.freeze({ kind: "operator", value: pair, at });
    }
    const character = this.source[at];
    if ("+-*/=<>(),".includes(character)) {
      this.offset++;
      return Object.freeze({ kind: "operator", value: character, at });
    }
    if (character === '"') {
      let index = at + 1;
      let escaped = false;
      for (; index < this.source.length; index++) {
        const current = this.source[index];
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === '"') break;
      }
      if (index >= this.source.length) syntax("unterminated string");
      const spelling = this.source.slice(at, index + 1);
      let decoded;
      try { decoded = JSON.parse(spelling); } catch { syntax("invalid string escape"); }
      if (typeof decoded !== "string" || CONTROL_OR_BIDI.test(decoded)) syntax("control character");
      this.offset = index + 1;
      return Object.freeze({ kind: "string", value: decoded, at });
    }
    const number = /^(?:0|[1-9]\d*)(?:\.\d+)?/u.exec(rest);
    if (number) {
      this.offset += number[0].length;
      return Object.freeze({ kind: "number", value: number[0], at });
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
    if (identifier) {
      this.offset += identifier[0].length;
      return Object.freeze({ kind: "identifier", value: identifier[0].toUpperCase(), at });
    }
    syntax(`unexpected token at ${at}`);
  }
}

function astNode(state, kind, fields = {}, children = []) {
  state.nodes++;
  const depth = 1 + children.reduce((maximum, child) => Math.max(maximum, child.depth), 0);
  if (state.nodes > FORMULA_LIMITS.maxAstNodes) fail("table_formula_ast_bound", String(FORMULA_LIMITS.maxAstNodes));
  if (depth > FORMULA_LIMITS.maxAstDepth) fail("table_formula_depth_bound", String(FORMULA_LIMITS.maxAstDepth));
  return Object.freeze({ kind, ...fields, depth });
}

function coordinateToken(token, label) {
  if (token.kind !== "number" || token.value.includes(".")) syntax(`${label} must be an unsigned integer`);
  const value = BigInt(token.value);
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) syntax(`${label} out of range`);
  return Number(value);
}

class Parser {
  constructor(source) {
    this.lexer = new Lexer(source);
    this.state = { nodes: 0 };
    this.current = this.lexer.next();
  }
  take(value = null) {
    const token = this.current;
    if (value !== null && token.value !== value) syntax(`expected ${value} at ${token.at}`);
    this.current = this.lexer.next();
    return token;
  }
  parse() {
    const expression = this.parseOr();
    if (this.current.kind !== "eof") syntax(`unexpected token at ${this.current.at}`);
    return Object.freeze({ expression, nodes: this.state.nodes, depth: expression.depth });
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.current.kind === "identifier" && this.current.value === "OR") {
      this.take();
      const right = this.parseAnd();
      left = astNode(this.state, "binary", { operator: "OR", left, right }, [left, right]);
    }
    return left;
  }
  parseAnd() {
    let left = this.parseComparison();
    while (this.current.kind === "identifier" && this.current.value === "AND") {
      this.take();
      const right = this.parseComparison();
      left = astNode(this.state, "binary", { operator: "AND", left, right }, [left, right]);
    }
    return left;
  }
  parseComparison() {
    let left = this.parseAdditive();
    if (this.current.kind === "operator" && ["=", "<>", "<", "<=", ">", ">="].includes(this.current.value)) {
      const operator = this.take().value;
      const right = this.parseAdditive();
      left = astNode(this.state, "binary", { operator, left, right }, [left, right]);
    }
    return left;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.current.kind === "operator" && ["+", "-"].includes(this.current.value)) {
      const operator = this.take().value;
      const right = this.parseMultiplicative();
      left = astNode(this.state, "binary", { operator, left, right }, [left, right]);
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.current.kind === "operator" && ["*", "/"].includes(this.current.value)) {
      const operator = this.take().value;
      const right = this.parseUnary();
      left = astNode(this.state, "binary", { operator, left, right }, [left, right]);
    }
    return left;
  }
  parseUnary() {
    if ((this.current.kind === "operator" && ["+", "-"].includes(this.current.value)) ||
        (this.current.kind === "identifier" && this.current.value === "NOT")) {
      const operator = this.take().value;
      const argument = this.parsePrimary();
      return astNode(this.state, "unary", { operator, argument }, [argument]);
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    if (this.current.kind === "number") return astNode(this.state, "number", { value: this.take().value });
    if (this.current.kind === "string") return astNode(this.state, "string", { value: this.take().value });
    if (this.current.kind === "identifier") {
      const name = this.take().value;
      if (["TRUE", "FALSE", "NULL"].includes(name)) return astNode(this.state, "literal", { value: name });
      if (name === "CELL") return this.parseCell();
      if (AGGREGATE_FUNCTIONS.has(name)) return this.parseAggregate(name);
      if (SCALAR_FUNCTIONS.has(name)) return this.parseScalarCall(name);
      fail("table_formula_forbidden", name);
    }
    if (this.current.value === "(") {
      this.take("(");
      const expression = this.parseOr();
      this.take(")");
      return expression;
    }
    syntax(`expected expression at ${this.current.at}`);
  }
  parseCell() {
    this.take("(");
    let row;
    if (this.current.kind === "identifier" && this.current.value === "ROW") {
      this.take();
      row = "ROW";
    } else {
      row = coordinateToken(this.take(), "CELL row");
    }
    this.take(",");
    const column = coordinateToken(this.take(), "CELL column");
    this.take(")");
    return astNode(this.state, "cell", { row, column });
  }
  parseRange() {
    if (this.current.kind !== "identifier" || this.current.value !== "RANGE") syntax("aggregate requires RANGE");
    this.take();
    this.take("(");
    const values = [];
    for (let index = 0; index < 4; index++) {
      values.push(coordinateToken(this.take(), `RANGE coordinate ${index + 1}`));
      if (index < 3) this.take(",");
    }
    this.take(")");
    return astNode(this.state, "range", { r1: values[0], c1: values[1], r2: values[2], c2: values[3] });
  }
  parseAggregate(name) {
    this.take("(");
    const range = this.parseRange();
    this.take(")");
    return astNode(this.state, "aggregate", { name, range }, [range]);
  }
  parseScalarCall(name) {
    this.take("(");
    const args = [];
    if (this.current.value !== ")") {
      while (true) {
        args.push(this.parseOr());
        if (this.current.value !== ",") break;
        this.take(",");
      }
    }
    this.take(")");
    const valid = name === "ABS" ? args.length === 1
      : name === "ROUND" ? args.length === 2 && args[1].kind === "number" && !args[1].value.includes(".")
        : name === "IF" ? args.length === 3
          : args.length >= 2;
    if (!valid) fail("table_formula_arity", name);
    return astNode(this.state, "call", { name, args: Object.freeze(args) }, args);
  }
}

export function parseTableFormula(source) {
  if (typeof source !== "string") fail("table_formula_request", "expression");
  const bytes = tableUtf8Bytes(source);
  if (bytes > FORMULA_LIMITS.maxSourceBytes) fail("table_formula_source_bound", String(FORMULA_LIMITS.maxSourceBytes));
  if (!bytes || CONTROL_OR_BIDI.test(source)) syntax("empty or control character");
  if (!source.startsWith("=")) syntax("formula must start with =");
  const body = source.slice(1);
  if (!body.trim()) syntax("empty formula");
  return new Parser(body).parse();
}

function digits(value) {
  return (value < 0n ? -value : value).toString().length;
}

function int64(coefficient) {
  if (coefficient < INT64_MIN || coefficient > INT64_MAX) fail("table_numeric_overflow", "int64 formula");
  return Object.freeze({ tag: "number", domain: "int64", coefficient, scale: 0 });
}

function decimal(coefficient, scale, maximumPrecision = INTERMEDIATE_PRECISION, maximumScale = INTERMEDIATE_SCALE) {
  if (!Number.isInteger(scale) || scale < 0 || scale > maximumScale || digits(coefficient) > maximumPrecision) {
    fail("table_numeric_overflow", "decimal formula");
  }
  return Object.freeze({ tag: "number", domain: "decimal", coefficient, scale });
}

function parseNumber(spelling) {
  const [whole, fraction] = spelling.split(".");
  if (fraction === undefined) return int64(BigInt(whole));
  if (whole.length + fraction.length > STORED_PRECISION || fraction.length > STORED_SCALE) {
    fail("table_numeric_overflow", "formula literal");
  }
  return decimal(BigInt(whole + fraction), fraction.length, STORED_PRECISION, STORED_SCALE);
}

function halfEven(numerator, denominator) {
  if (denominator === 0n) fail("table_divide_by_zero");
  let sign = 1n;
  if (numerator < 0n) { numerator = -numerator; sign = -sign; }
  if (denominator < 0n) { denominator = -denominator; sign = -sign; }
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n)) quotient++;
  return quotient * sign;
}

function roundCoefficient(value, scale) {
  if (value.scale === scale) return value.coefficient;
  if (value.scale < scale) return value.coefficient * POW10[scale - value.scale];
  return halfEven(value.coefficient, POW10[value.scale - scale]);
}

function aligned(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * POW10[scale - left.scale],
    right: right.coefficient * POW10[scale - right.scale],
    scale,
  };
}

function add(left, right, subtract = false) {
  if (left.domain === "int64" && right.domain === "int64") {
    return int64(left.coefficient + (subtract ? -right.coefficient : right.coefficient));
  }
  const values = aligned(left, right);
  return decimal(values.left + (subtract ? -values.right : values.right), values.scale);
}

function multiply(left, right) {
  if (left.domain === "int64" && right.domain === "int64") return int64(left.coefficient * right.coefficient);
  return decimal(left.coefficient * right.coefficient, left.scale + right.scale);
}

function divide(left, right, scale) {
  if (right.coefficient === 0n) fail("table_divide_by_zero");
  const numerator = left.coefficient * POW10[right.scale + scale];
  const denominator = right.coefficient * POW10[left.scale];
  return decimal(halfEven(numerator, denominator), scale, STORED_PRECISION, STORED_SCALE);
}

function decimalString(value, scale) {
  const coefficient = roundCoefficient(value, scale);
  if (digits(coefficient) > STORED_PRECISION) fail("table_numeric_overflow", "decimal result");
  const negative = coefficient < 0n;
  let text = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  if (scale) text = `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  return `${negative && coefficient !== 0n ? "-" : ""}${text}`;
}

const NULL_VALUE = Object.freeze({ tag: "null" });
function booleanValue(value) { return Object.freeze({ tag: "boolean", value }); }
function textValue(value, tag = "text") { return Object.freeze({ tag, value }); }

function cellValue(value, type) {
  if (value === null) return NULL_VALUE;
  if (type.kind === "int64") return int64(BigInt(value));
  if (type.kind === "decimal") {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    return decimal(BigInt(unsigned.replace(".", "")) * (negative ? -1n : 1n), type.scale, STORED_PRECISION, STORED_SCALE);
  }
  if (type.kind === "boolean") return booleanValue(value);
  return textValue(value, type.kind);
}

function requireNumber(value) {
  if (value.tag !== "number") fail("table_formula_type", "number required");
  return value;
}

function requireBoolean(value) {
  if (value.tag !== "boolean") fail("table_formula_type", "boolean required");
  return value;
}

function codePointCompare(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

function compare(left, right, ordering) {
  if (left.tag === "null" || right.tag === "null") return null;
  if (left.tag === "number" && right.tag === "number") {
    const values = aligned(left, right);
    return values.left < values.right ? -1 : values.left > values.right ? 1 : 0;
  }
  if (left.tag !== right.tag) fail("table_formula_type", "comparison domains");
  if (left.tag === "boolean") {
    if (ordering) fail("table_formula_type", "boolean ordering");
    return left.value === right.value ? 0 : 1;
  }
  if (["text", "date", "datetime"].includes(left.tag)) return codePointCompare(left.value, right.value);
  fail("table_formula_type", "comparison");
}

function inside(inner, outer) {
  return inner.r1 >= outer.r1 && inner.r2 <= outer.r2 && inner.c1 >= outer.c1 && inner.c2 <= outer.c2;
}

function resolveCell(node, context) {
  const row = node.row === "ROW" ? (context.row === null ? null : context.row + 1) : node.row;
  const reference = row === null ? null : { r1: row, r2: row, c1: node.column, c2: node.column };
  if (!reference || !inside(reference, context.readRange)) fail("table_formula_reference_out_of_range", "CELL");
  context.budget.visit();
  return cellValue(context.table.rows[row - 1][node.column - 1], context.table.columns[node.column - 1].type);
}

function addToSum(state, value) {
  if (value.domain === "decimal") state.domain = "decimal";
  if (value.scale > state.scale) {
    const factor = POW10[value.scale - state.scale];
    state.positive *= factor;
    state.negative *= factor;
    state.scale = value.scale;
  }
  const coefficient = value.coefficient * POW10[state.scale - value.scale];
  if (coefficient < 0n) state.negative += -coefficient;
  else state.positive += coefficient;
  if (digits(state.positive) > SUM_PRECISION || digits(state.negative) > SUM_PRECISION) {
    fail("table_numeric_overflow", "formula sum");
  }
}

function summedValue(state) {
  const coefficient = state.positive - state.negative;
  if (state.domain === "int64" && coefficient >= INT64_MIN && coefficient <= INT64_MAX) return int64(coefficient);
  return decimal(coefficient, state.scale, SUM_PRECISION, STORED_SCALE);
}

function aggregate(node, context) {
  const range = node.range;
  if (range.r2 < range.r1 || range.c2 < range.c1 || !inside(range, context.readRange)) {
    fail("table_formula_reference_out_of_range", "RANGE");
  }
  const sum = { domain: "int64", scale: 0, positive: 0n, negative: 0n };
  let countNumeric = 0;
  let countPresent = 0;
  let extremum = null;
  for (let row = range.r1; row <= range.r2; row++) {
    for (let column = range.c1; column <= range.c2; column++) {
      context.budget.visit();
      const value = cellValue(context.table.rows[row - 1][column - 1], context.table.columns[column - 1].type);
      if (value.tag === "null") continue;
      countPresent++;
      if (value.tag === "number") countNumeric++;
      if (node.name === "SUM" || node.name === "AVG") {
        if (value.tag !== "number") fail("table_formula_type", `${node.name} numeric range`);
        addToSum(sum, value);
      } else if (node.name === "MIN" || node.name === "MAX") {
        if (value.tag === "boolean") fail("table_formula_type", `${node.name} ordered range`);
        if (extremum === null) extremum = value;
        else {
          const order = compare(value, extremum, true);
          if ((node.name === "MIN" && order < 0) || (node.name === "MAX" && order > 0)) extremum = value;
        }
      }
    }
  }
  if (node.name === "COUNT") return int64(BigInt(countNumeric));
  if (node.name === "COUNTA") return int64(BigInt(countPresent));
  if (!countPresent) return NULL_VALUE;
  if (node.name === "MIN" || node.name === "MAX") return extremum;
  const value = summedValue(sum);
  return node.name === "AVG" ? divide(value, int64(BigInt(countPresent)), context.divisionScale) : value;
}

function integerLiteralValue(node, label) {
  if (node.kind !== "number" || node.value.includes(".")) fail("table_formula_type", label);
  const value = BigInt(node.value);
  if (value > BigInt(STORED_SCALE)) fail("table_formula_type", label);
  return Number(value);
}

function evaluateCall(node, context) {
  if (node.name === "IF") {
    const condition = evaluate(node.args[0], context);
    if (condition.tag === "null") return NULL_VALUE;
    return evaluate(requireBoolean(condition).value ? node.args[1] : node.args[2], context);
  }
  if (node.name === "COALESCE") {
    for (const argument of node.args) {
      const value = evaluate(argument, context);
      if (value.tag !== "null") return value;
    }
    return NULL_VALUE;
  }
  if (node.name === "ABS") {
    const value = evaluate(node.args[0], context);
    if (value.tag === "null") return value;
    const number = requireNumber(value);
    return number.domain === "int64"
      ? int64(number.coefficient < 0n ? -number.coefficient : number.coefficient)
      : decimal(number.coefficient < 0n ? -number.coefficient : number.coefficient, number.scale);
  }
  if (node.name === "ROUND") {
    const value = evaluate(node.args[0], context);
    if (value.tag === "null") return value;
    const number = requireNumber(value);
    const scale = integerLiteralValue(node.args[1], "ROUND scale");
    if (number.domain === "int64") return number;
    return decimal(roundCoefficient(number, scale), scale, STORED_PRECISION, STORED_SCALE);
  }
  fail("table_formula_forbidden", node.name);
}

function evaluate(node, context) {
  context.budget.spend();
  if (node.kind === "number") return parseNumber(node.value);
  if (node.kind === "string") return textValue(node.value);
  if (node.kind === "literal") return node.value === "NULL" ? NULL_VALUE : booleanValue(node.value === "TRUE");
  if (node.kind === "cell") return resolveCell(node, context);
  if (node.kind === "aggregate") return aggregate(node, context);
  if (node.kind === "call") return evaluateCall(node, context);
  if (node.kind === "unary") {
    if (node.operator === "-" && node.argument.kind === "number" && !node.argument.value.includes(".") &&
        BigInt(node.argument.value) === INT64_MAX + 1n) {
      context.budget.spend();
      return int64(INT64_MIN);
    }
    const value = evaluate(node.argument, context);
    if (value.tag === "null") return value;
    if (node.operator === "NOT") return booleanValue(!requireBoolean(value).value);
    const number = requireNumber(value);
    if (node.operator === "+") return number;
    if (number.coefficient === 0n) return number;
    return number.domain === "int64" ? int64(-number.coefficient) : decimal(-number.coefficient, number.scale);
  }
  if (node.kind === "binary") {
    if (node.operator === "AND" || node.operator === "OR") {
      const left = evaluate(node.left, context);
      if (left.tag !== "null") {
        const condition = requireBoolean(left);
        if (node.operator === "AND" && !condition.value) return condition;
        if (node.operator === "OR" && condition.value) return condition;
      }
      const right = evaluate(node.right, context);
      if (right.tag !== "null") {
        const condition = requireBoolean(right);
        if (node.operator === "AND" && !condition.value) return condition;
        if (node.operator === "OR" && condition.value) return condition;
      }
      if (left.tag === "null" || right.tag === "null") return NULL_VALUE;
      return booleanValue(node.operator === "AND");
    }
    const left = evaluate(node.left, context);
    const right = evaluate(node.right, context);
    if (["+", "-", "*", "/"].includes(node.operator)) {
      if (left.tag === "null" || right.tag === "null") return NULL_VALUE;
      const a = requireNumber(left);
      const b = requireNumber(right);
      if (node.operator === "+") return add(a, b);
      if (node.operator === "-") return add(a, b, true);
      if (node.operator === "*") return multiply(a, b);
      return divide(a, b, context.divisionScale);
    }
    const order = compare(left, right, !["=", "<>"].includes(node.operator));
    if (order === null) return NULL_VALUE;
    return booleanValue(node.operator === "=" ? order === 0
      : node.operator === "<>" ? order !== 0
        : node.operator === "<" ? order < 0
          : node.operator === "<=" ? order <= 0
            : node.operator === ">" ? order > 0
              : order >= 0);
  }
  syntax("unknown AST node");
}

function outputValue(value, type) {
  if (value.tag === "null") return null;
  if (type.kind === "int64") {
    const number = requireNumber(value);
    const divisor = POW10[number.scale];
    if (number.coefficient % divisor !== 0n) fail("table_formula_result_type", "int64 fraction");
    return int64(number.coefficient / divisor).coefficient.toString();
  }
  if (type.kind === "decimal") return decimalString(requireNumber(value), type.scale);
  if (type.kind === "boolean") {
    if (value.tag !== "boolean") fail("table_formula_result_type", "boolean");
    return value.value;
  }
  if (value.tag !== type.kind) fail("table_formula_result_type", type.kind);
  return value.value;
}

export function formulaTable(tableInput, requestInput) {
  const table = assertCanonicalTable(tableInput);
  const request = formulaRequest(requestInput, table);
  if (request.mode === "append_column" && table.columns.length >= TABLE_LIMITS.maxColumns) {
    fail("table_column_bound", String(TABLE_LIMITS.maxColumns));
  }
  const parsed = parseTableFormula(request.expression);
  const budget = createFormulaBudget();
  const context = {
    table,
    readRange: request.readRange,
    divisionScale: request.numericPolicy.divisionScale,
    budget,
    row: null,
  };
  let output;
  if (request.mode === "append_column") {
    const columns = [...table.columns, {
      id: `c${table.columns.length + 1}`,
      header: request.result.header,
      type: request.result.type,
    }];
    const rows = table.rows.map((row, index) => {
      const rowNumber = index + 1;
      if (rowNumber < request.targetRows.r1 || rowNumber > request.targetRows.r2) return [...row, null];
      context.row = index;
      return [...row, outputValue(evaluate(parsed.expression, context), request.result.type)];
    });
    output = assertCanonicalTable({ version: TABLE_VERSION, localeProfile: table.localeProfile, columns, rows });
  } else {
    output = assertCanonicalTable({
      version: TABLE_VERSION,
      localeProfile: table.localeProfile,
      columns: [{ id: "c1", header: request.result.header, type: request.result.type }],
      rows: [[outputValue(evaluate(parsed.expression, context), request.result.type)]],
    });
  }
  return Object.freeze({
    table: output,
    astNodes: parsed.nodes,
    astDepth: parsed.depth,
    ...budget.snapshot(),
  });
}
