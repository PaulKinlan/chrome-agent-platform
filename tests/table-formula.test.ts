// @ts-nocheck
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  createFormulaBudget,
  FORMULA_LIMITS,
  formulaTable,
  parseTableFormula,
} from "../extension/lib/table-formula.js";
import {
  assertCanonicalTable,
  TABLE_LIMITS,
  TABLE_VERSION,
} from "../extension/lib/table-core.js";

function table(columns, rows) {
  return assertCanonicalTable({
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: columns.map((column, index) => ({ id: `c${index + 1}`, ...column })),
    rows,
  });
}

function request(source, expression, type, extra = {}) {
  const common = {
    mode: "scalar",
    readRange: { r1: 1, c1: 1, r2: source.rows.length, c2: source.columns.length },
    expression,
    result: { header: "Result", type },
    numericPolicy: { divisionScale: 6, rounding: "half_even" },
  };
  return { ...common, ...extra };
}

function scalar(source, expression, type = { kind: "decimal", scale: 2 }, extra = {}) {
  return formulaTable(source, request(source, expression, type, extra));
}

function throwsCode(fn, code) {
  const error = assertThrows(fn);
  assertEquals(error.code, code, error.message);
  return error;
}

const BASE = table([{ header: "base", type: { kind: "int64" } }], [["0"]]);

Deno.test("formula parser requires = and honors arithmetic, comparison, and boolean precedence", () => {
  assertEquals(scalar(BASE, "=1 + 2 * 3", { kind: "int64" }).table.rows, [["7"]]);
  assertEquals(scalar(BASE, "=1 + 2 * 3 = 7 AND NOT FALSE", { kind: "boolean" }).table.rows, [[true]]);
  assertEquals(scalar(BASE, "=(1 + 2) * 3", { kind: "int64" }).table.rows, [["9"]]);
  assertEquals(scalar(BASE, "=1 < 2 OR FALSE AND TRUE", { kind: "boolean" }).table.rows, [[true]]);
  throwsCode(() => parseTableFormula("1 + 2"), "table_formula_syntax");
});

Deno.test("append_column uses ROW and explicit positional cells, materializes target rows, and leaves input immutable", () => {
  const source = table([
    { header: "qty", type: { kind: "int64" } },
    { header: "price", type: { kind: "decimal", scale: 2 } },
  ], [
    ["2", "1.25"],
    ["3", "0.10"],
    [null, "9.99"],
    ["7", "2.00"],
  ]);
  const result = formulaTable(source, {
    mode: "append_column",
    readRange: { r1: 1, c1: 1, r2: 3, c2: 2 },
    targetRows: { r1: 1, r2: 3 },
    expression: "=CELL(ROW,1)*CELL(ROW,2)",
    result: { header: "Line total", type: { kind: "decimal", scale: 2 } },
    numericPolicy: { divisionScale: 6, rounding: "half_even" },
  });
  assertEquals(result.table.columns.map((column) => column.id), ["c1", "c2", "c3"]);
  assertEquals(result.table.rows, [
    ["2", "1.25", "2.50"],
    ["3", "0.10", "0.30"],
    [null, "9.99", null],
    ["7", "2.00", null],
  ]);
  assertEquals(source.rows[0], ["2", "1.25"]);
  assertEquals(result.cellVisits, 6);
});

Deno.test("scalar RANGE is explicit, rectangular, and implements every aggregate deterministically", () => {
  const source = table([
    { header: "amount", type: { kind: "decimal", scale: 2 } },
    { header: "label", type: { kind: "text" } },
  ], [
    ["2.50", "b"],
    ["0.34", "a"],
    ["8.50", null],
  ]);
  assertEquals(scalar(source, "=SUM(RANGE(1,1,3,1))").table.rows, [["11.34"]]);
  assertEquals(scalar(source, "=AVG(RANGE(1,1,3,1))").table.rows, [["3.78"]]);
  assertEquals(scalar(source, "=MIN(RANGE(1,1,3,1))").table.rows, [["0.34"]]);
  assertEquals(scalar(source, "=MAX(RANGE(1,1,3,1))").table.rows, [["8.50"]]);
  assertEquals(scalar(source, "=COUNT(RANGE(1,1,3,2))", { kind: "int64" }).table.rows, [["3"]]);
  assertEquals(scalar(source, "=COUNTA(RANGE(1,1,3,2))", { kind: "int64" }).table.rows, [["5"]]);
  assertEquals(scalar(source, "=MIN(RANGE(1,2,3,2))", { kind: "text" }).table.rows, [["a"]]);
  assertEquals(scalar(source, "=SUM(RANGE(1,1,3,1))").cellVisits, 3);
});

Deno.test("ABS, ROUND, IF, COALESCE, AND, and OR are exact and lazy", () => {
  assertEquals(scalar(BASE, "=ABS(-1.25)").table.rows, [["1.25"]]);
  assertEquals(scalar(BASE, "=ROUND(2.345,2)").table.rows, [["2.34"]]);
  assertEquals(scalar(BASE, "=ROUND(2.355,2)").table.rows, [["2.36"]]);
  assertEquals(scalar(BASE, "=IF(TRUE,1.25,1/0)").table.rows, [["1.25"]]);
  assertEquals(scalar(BASE, "=COALESCE(NULL,NULL,2.50)").table.rows, [["2.50"]]);
  assertEquals(scalar(BASE, "=FALSE AND (1/0=1)", { kind: "boolean" }).table.rows, [[false]]);
  assertEquals(scalar(BASE, "=TRUE OR (1/0=1)", { kind: "boolean" }).table.rows, [[true]]);
});

Deno.test("formula arithmetic uses BigInt coefficients, declared division scale, and half-even conversion", () => {
  assertEquals(scalar(BASE, "=0.1+0.2").table.rows, [["0.30"]]);
  assertEquals(scalar(BASE, "=-9223372036854775808", { kind: "int64" }).table.rows, [["-9223372036854775808"]]);
  assertEquals(scalar(BASE, "=1/3", { kind: "decimal", scale: 6 }).table.rows, [["0.333333"]]);
  assertEquals(scalar(BASE, "=5/2", { kind: "decimal", scale: 0 }, {
    numericPolicy: { divisionScale: 1, rounding: "half_even" },
  }).table.rows, [["2"]]);
  assertEquals(scalar(BASE, "=7/2", { kind: "decimal", scale: 0 }, {
    numericPolicy: { divisionScale: 1, rounding: "half_even" },
  }).table.rows, [["4"]]);
  throwsCode(() => scalar(BASE, "=9223372036854775807+1", { kind: "int64" }), "table_numeric_overflow");
  throwsCode(() => scalar(BASE, "=ABS(-9223372036854775808)", { kind: "int64" }), "table_numeric_overflow");
  throwsCode(() => scalar(BASE, "=1/0"), "table_divide_by_zero");
  throwsCode(() => scalar(BASE, "=1/2", { kind: "int64" }), "table_formula_result_type");
});

Deno.test("missing values propagate before type checks and aggregates ignore missing values", () => {
  const source = table([
    { header: "text", type: { kind: "text" } },
    { header: "amount", type: { kind: "decimal", scale: 2 } },
  ], [[null, null], ["x", "2.00"]]);
  assertEquals(scalar(source, "=CELL(1,1)+1").table.rows, [[null]]);
  assertEquals(scalar(source, "=TRUE AND NULL", { kind: "boolean" }).table.rows, [[null]]);
  assertEquals(scalar(source, "=FALSE AND NULL", { kind: "boolean" }).table.rows, [[false]]);
  assertEquals(scalar(source, "=TRUE OR NULL", { kind: "boolean" }).table.rows, [[true]]);
  assertEquals(scalar(source, "=IF(NULL,1,2)").table.rows, [[null]]);
  assertEquals(scalar(source, "=SUM(RANGE(1,2,2,2))").table.rows, [["2.00"]]);
  assertEquals(scalar(source, "=COUNT(RANGE(1,2,2,2))", { kind: "int64" }).table.rows, [["1"]]);
});

Deno.test("numeric cross-type comparison is exact while other domains remain strict", () => {
  const source = table([
    { header: "integer", type: { kind: "int64" } },
    { header: "decimal", type: { kind: "decimal", scale: 2 } },
    { header: "date", type: { kind: "date" } },
    { header: "earlier", type: { kind: "date" } },
  ], [["1", "1.00", "2026-09-05", "2026-01-01"]]);
  assertEquals(scalar(source, "=CELL(1,1)=CELL(1,2)", { kind: "boolean" }).table.rows, [[true]]);
  assertEquals(scalar(source, "=CELL(1,3)>CELL(1,4)", { kind: "boolean" }).table.rows, [[true]]);
  throwsCode(() => scalar(source, '=CELL(1,1)="1"', { kind: "boolean" }), "table_formula_type");
  throwsCode(() => scalar(source, "=TRUE<FALSE", { kind: "boolean" }), "table_formula_type");
});

Deno.test("references are literal coordinates inside readRange; ROW, A1, whole columns, and external functions fail closed", () => {
  const source = table([
    { header: "left", type: { kind: "int64" } },
    { header: "right", type: { kind: "int64" } },
  ], [["1", "2"], ["3", "4"]]);
  throwsCode(() => scalar(source, "=CELL(ROW,1)", { kind: "int64" }), "table_formula_reference_out_of_range");
  throwsCode(() => formulaTable(source, request(source, "=CELL(1,2)", { kind: "int64" }, {
    readRange: { r1: 1, c1: 1, r2: 2, c2: 1 },
  })), "table_formula_reference_out_of_range");
  throwsCode(() => scalar(source, "=SUM(RANGE(1,1,3,1))"), "table_formula_reference_out_of_range");
  for (const expression of [
    "=A1", "=c1", "=SUM(C:C)", "=INDIRECT(\"A1\")", "=OFFSET(1,1)", "=NOW()", "=RAND()",
    '=WEBSERVICE("https://example.com")', "=SUM(CELL(1,1))", "=RANGE(1,1,2,2)",
  ]) assertThrows(() => scalar(source, expression), undefined, undefined, expression);
});

Deno.test("request shapes are exact, nested own-data-only, and never invoke accessors", () => {
  const good = request(BASE, "=1", { kind: "int64" });
  throwsCode(() => formulaTable(BASE, { ...good, extra: true }), "table_unknown_field");
  throwsCode(() => formulaTable(BASE, { ...good, mode: "append" }), "table_formula_request");
  throwsCode(() => formulaTable(BASE, { ...good, numericPolicy: { divisionScale: 6, rounding: "up" } }), "table_formula_request");
  let reads = 0;
  const hostile = { ...good };
  Object.defineProperty(hostile, "expression", { enumerable: true, get() { reads++; return "=1"; } });
  throwsCode(() => formulaTable(BASE, hostile), "table_formula_request");
  assertEquals(reads, 0);

  const protoKey = Object.create(null);
  Object.assign(protoKey, good);
  Object.defineProperty(protoKey, "__proto__", { value: true, enumerable: true });
  throwsCode(() => formulaTable(BASE, protoKey), "table_unknown_field");
});

function balanced(count) {
  if (count === 1) return "1";
  const left = Math.floor(count / 2);
  return `(${balanced(left)}+${balanced(count - left)})`;
}

Deno.test("source, AST-node, and depth ceilings accept exact and reject +1", () => {
  const exactSource = `="${"x".repeat(FORMULA_LIMITS.maxSourceBytes - 3)}"`;
  assertEquals(new TextEncoder().encode(exactSource).byteLength, FORMULA_LIMITS.maxSourceBytes);
  assertEquals(scalar(BASE, exactSource, { kind: "text" }).table.rows[0][0].length, FORMULA_LIMITS.maxSourceBytes - 3);
  throwsCode(() => parseTableFormula(`${exactSource} `), "table_formula_source_bound");

  const body = balanced(128); // 128 literals + 127 binary operators.
  const exactNodes = `=-(${body})`; // plus one unary node = 256.
  assertEquals(parseTableFormula(exactNodes).nodes, FORMULA_LIMITS.maxAstNodes);
  throwsCode(() => parseTableFormula(`=+(-(${body}))`), "table_formula_ast_bound");

  const exactDepth = `=${"ABS(".repeat(FORMULA_LIMITS.maxAstDepth - 1)}1${")".repeat(FORMULA_LIMITS.maxAstDepth - 1)}`;
  assertEquals(parseTableFormula(exactDepth).depth, FORMULA_LIMITS.maxAstDepth);
  const tooDeep = `=ABS(${exactDepth.slice(1)})`;
  throwsCode(() => parseTableFormula(tooDeep), "table_formula_depth_bound");
});

Deno.test("visit and work meters accept exactly five million units and reject +1", () => {
  const work = createFormulaBudget();
  work.spend(FORMULA_LIMITS.maxWorkUnits);
  assertEquals(work.snapshot().workUnits, FORMULA_LIMITS.maxWorkUnits);
  throwsCode(() => work.spend(1), "table_formula_work_bound");

  const visits = createFormulaBudget();
  visits.visit(FORMULA_LIMITS.maxCellVisits);
  assertEquals(visits.snapshot(), {
    workUnits: FORMULA_LIMITS.maxWorkUnits,
    cellVisits: FORMULA_LIMITS.maxCellVisits,
  });
  throwsCode(() => visits.visit(1), "table_formula_visit_bound");
});

Deno.test("core table bounds remain authoritative for materialized formula output", () => {
  const columns = Array.from({ length: TABLE_LIMITS.maxColumns }, (_, index) => ({
    header: `h${index}`,
    type: { kind: "text" },
  }));
  const source = table(columns, [Array(TABLE_LIMITS.maxColumns).fill(null)]);
  throwsCode(() => formulaTable(source, {
    mode: "append_column",
    readRange: { r1: 1, c1: 1, r2: 1, c2: 1 },
    targetRows: { r1: 1, r2: 1 },
    expression: '="x"',
    result: { header: "extra", type: { kind: "text" } },
    numericPolicy: { divisionScale: 6, rounding: "half_even" },
  }), "table_column_bound");
});

Deno.test("aggregate type errors and malformed grammar abort without partial materialization", () => {
  const mixed = table([
    { header: "number", type: { kind: "int64" } },
    { header: "text", type: { kind: "text" } },
  ], [["1", "secret"], [null, null]]);
  throwsCode(() => scalar(mixed, "=SUM(RANGE(1,1,2,2))"), "table_formula_type");
  throwsCode(() => scalar(mixed, "=MIN(RANGE(1,1,2,2))", { kind: "int64" }), "table_formula_type");
  for (const expression of ["=", "=1+", "=01", '="unterminated', "=1==1", "=SUM()", "=IF(TRUE,1)"]) {
    assertThrows(() => scalar(mixed, expression), undefined, undefined, expression);
  }
  throwsCode(() => scalar(mixed, '="line\\nfeed"', { kind: "text" }), "table_formula_syntax");
});

Deno.test("formula source contains no dynamic-code, locale, or network execution sink", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/table-formula.js", import.meta.url));
  assert(!/\beval\s*\(/u.test(source));
  assert(!/new\s+Function\b/u.test(source));
  assert(!/\bfetch\s*\(/u.test(source));
  assert(!/XMLHttpRequest|WebSocket|importScripts/u.test(source));
  assert(!/localeCompare|\bIntl\b/u.test(source));
});
