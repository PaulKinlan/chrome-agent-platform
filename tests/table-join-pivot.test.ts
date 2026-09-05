// @ts-nocheck
// tests/table-join-pivot.test.ts — chrome-agent-platform-def.2 r8 revision
// KATs over the strict canonical table core (rows are ARRAYS, column types are
// { kind, scale? } objects, outputs pass assertCanonicalTable).
//
// These tests pin the REVISED r8 contract (the r7 [{column,header?}] form is
// superseded and every one of these requests fails it):
//   * join request { kind, keys, leftColumns, rightColumns } — projections
//     are DENSE ARRAYS OF CANONICAL COLUMN-ID STRINGS (["c1","c2"]) exactly
//     as the toolkit contract (table_join §7.3) and the live management
//     schema require; headers and types are PRESERVED from the source
//     columns; object projection entries and non-string elements are
//     rejected; an unknown/non-canonical ID fails table_unknown_column;
//     either/both projections may be empty. Output is EXACTLY the projected
//     left columns then the projected right columns with regenerated ids;
//     right keys are never auto-dropped and never coalesced into left slots;
//     duplicate key columns are invalid.
//   * join keys: int64/decimal match by EXACT numeric value across kind and
//     scale; other domains join as the identical typed kind; a null key
//     component never matches. Right/full joins keep every unmatched right
//     row's projected data (partial-null composite keys included).
//   * workUnits follow the toolkit unit definition (a unit is one key-cell
//     hash/comparison or one emitted cell): join charges the key-pair count
//     per scanned key-pass row plus the output width per emitted row; pivot
//     charges rowGroupBy.length + 1 per discovery input row (each group-key
//     cell hash plus the pivot-category cell comparison) plus the metric
//     count per aggregation input row plus the output width per emitted
//     group row.
//   * pivot request { rowGroupBy ([] allowed), pivotColumn, categories,
//     metrics } with ops count_rows | count_values | sum | avg | min | max;
//     category and metric headers are REQUIRED; avg requires an explicit
//     integer scale 0..18 and only avg accepts scale; count_rows forbids a
//     column and every other op requires one; a null or undeclared pivot cell
//     fails the whole job. Value columns are CATEGORY-major with the header
//     `${category.header} · ${metric.header}`.
//   * exactData/idArray are own-data/descriptor-safe: getters, symbols,
//     non-enumerables, accessors and sparse arrays are rejected WITHOUT any
//     caller getter being invoked.
//   * join output multiplicity is preflighted (row/cell bounds before any
//     materialization) and the OutputBudget validates column width and header
//     totals up front.
//
// Coverage: inner/left/right/full ordering, projections (ID arrays, preserved
// source headers/types, empty lists, object-entry rejection), cross-kind
// numeric and composite/null keys, partial-null right/full data retention,
// request-shape and descriptor guards, exact row/cell/byte/header bounds at
// the real strict-core ceilings, pivots over every op with exact BigInt/
// half-even semantics, category-major headers, whole-table ([] rowGroupBy)
// pivots, and width/cell/group/header bounds.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  joinTables,
  pivotTable,
} from "../extension/lib/table-join-pivot.js";
import {
  assertCanonicalTable,
  TABLE_LIMITS,
  TABLE_VERSION,
  TableError,
} from "../extension/lib/table-core.js";

const MAX_OUTPUT_BYTES = TABLE_LIMITS.maxOutputBytes;

function table(columns, rows) {
  return assertCanonicalTable({
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: columns.map((column, index) => ({ id: `c${index + 1}`, ...column })),
    rows,
  });
}

/** Any output (join or pivot) must be a valid canonical strict-core table. */
function canonical(out) {
  const result = assertCanonicalTable(out.table);
  assertEquals(out.table, result);
  return out;
}

function throwsCode(fn, code) {
  const error = assertThrows(fn);
  assertEquals(error instanceof TableError, true, `expected TableError, got ${error}`);
  assertEquals(error.code, code, error.message);
  return error;
}

const enc = new TextEncoder();
const utf8 = (value) => enc.encode(value).length;

// ---------------------------------------------------------------------------
// Joins — projections, kinds, ordering, keys
// ---------------------------------------------------------------------------

const LEFT = table([
  { header: "k", type: { kind: "text" } },
  { header: "v", type: { kind: "int64" } },
], [
  ["x", "1"],
  ["x", "2"],
  ["y", "3"],
  ["z", "4"],
]);
const RIGHT = table([
  { header: "k", type: { kind: "text" } },
  { header: "w", type: { kind: "text" } },
], [
  ["x", "p"],
  ["x", "q"],
  ["w", "r"],
]);
const joinRequest = {
  kind: "inner",
  keys: [{ left: "c1", right: "c1" }],
  leftColumns: ["c1", "c2"],
  rightColumns: ["c1", "c2"],
};
const joinColumns = [
  { header: "k", type: { kind: "text" } },
  { header: "v", type: { kind: "int64" } },
  { header: "k", type: { kind: "text" } },
  { header: "w", type: { kind: "text" } },
];

Deno.test("def2 r8 join: inner/left/right/full project exactly leftColumns then rightColumns with regenerated ids", () => {
  // inner: left-major; per left row, right matches in right input order.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, joinRequest)).table,
    table(joinColumns, [
      ["x", "1", "x", "p"],
      ["x", "1", "x", "q"],
      ["x", "2", "x", "p"],
      ["x", "2", "x", "q"],
    ]),
  );
  // left: inner plus unmatched left rows null-padded in place.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { ...joinRequest, kind: "left" })).table,
    table(joinColumns, [
      ["x", "1", "x", "p"],
      ["x", "1", "x", "q"],
      ["x", "2", "x", "p"],
      ["x", "2", "x", "q"],
      ["y", "3", null, null],
      ["z", "4", null, null],
    ]),
  );
  // right: right-major; each right row followed by its left matches; the
  // unmatched right row keeps its own key in the RIGHT slots (no coalescing).
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { ...joinRequest, kind: "right" })).table,
    table(joinColumns, [
      ["x", "1", "x", "p"],
      ["x", "2", "x", "p"],
      ["x", "1", "x", "q"],
      ["x", "2", "x", "q"],
      [null, null, "w", "r"],
    ]),
  );
  // full: left-major emission (pairs + unmatched left) then unmatched right rows.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { ...joinRequest, kind: "full" })).table,
    table(joinColumns, [
      ["x", "1", "x", "p"],
      ["x", "1", "x", "q"],
      ["x", "2", "x", "p"],
      ["x", "2", "x", "q"],
      ["y", "3", null, null],
      ["z", "4", null, null],
      [null, null, "w", "r"],
    ]),
  );
});

Deno.test("def2 r8 join: output rows are arrays; right keys are never auto-dropped and never coalesced", () => {
  const out = canonical(joinTables(LEFT, RIGHT, { ...joinRequest, kind: "full" })).table;
  assert(Array.isArray(out.rows[0]), "joined rows must be arrays, not objects");
  assertEquals(out.rows[0].c1, undefined); // object access must not work
  // Column-id regeneration over the combined projection, INCLUDING the right
  // key column at its own projected position (no auto-dropping).
  assertEquals(out.columns.map((column) => column.id), ["c1", "c2", "c3", "c4"]);
  assertEquals(out.columns.map((column) => column.header), ["k", "v", "k", "w"]);
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "int64" },
    { kind: "text" },
    { kind: "text" },
  ]);
  // Positional access: left k/v then right k/w. The final unmatched right row
  // has nulls in the left slots and its own key "w" in the right key slot —
  // the r5-style coalescing ([..., "w", null, "r"]-shaped output) is gone.
  assertEquals(out.rows[0][0], "x");
  assertEquals(out.rows[0][1], "1");
  assertEquals(out.rows[0][2], "x");
  assertEquals(out.rows[0][3], "p");
  assertEquals(out.rows[out.rows.length - 1], [null, null, "w", "r"]);
});

Deno.test("def2 r8 join: composite and partial-null keys — projected right data survives right/full joins", () => {
  const L = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
  ], [
    ["a", null, "1"],
    [null, "b", "2"],
    ["a", "b", "3"],
    ["a", "b", "4"],
  ]);
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["a", null, "p"],
    [null, "b", "q"],
    ["a", "b", "r"],
    ["c", "d", "s"],
  ]);
  const request = (kind) => ({
    kind,
    keys: [{ left: "c1", right: "c1" }, { left: "c2", right: "c2" }],
    leftColumns: ["c1", "c2", "c3"],
    rightColumns: ["c1", "c2", "c3"],
  });
  const columns = [
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ];
  // Only the fully non-null ("a","b") tuples match; every partial-null right
  // row is unmatched yet keeps ALL of its projected data (key columns too).
  const fullOut = canonical(joinTables(L, R, request("full"))).table;
  assertEquals(fullOut.rows, [
    ["a", null, "1", null, null, null], // left row with a null key component never matches
    [null, "b", "2", null, null, null],
    ["a", "b", "3", "a", "b", "r"],
    ["a", "b", "4", "a", "b", "r"],
    [null, null, null, "a", null, "p"], // unmatched right rows append in right input order
    [null, null, null, null, "b", "q"],
    [null, null, null, "c", "d", "s"],
  ]);
  const rightOut = canonical(joinTables(L, R, request("right"))).table;
  assertEquals(rightOut.rows, [
    [null, null, null, "a", null, "p"],
    [null, null, null, null, "b", "q"],
    ["a", "b", "3", "a", "b", "r"],
    ["a", "b", "4", "a", "b", "r"],
    [null, null, null, "c", "d", "s"],
  ]);
  // Sanity: the same shape as the reference table built column by column.
  assertEquals(rightOut.columns, fullOut.columns);
  assertEquals(rightOut.columns, columns.map((column, i) => ({ id: `c${i + 1}`, ...column })));
});

Deno.test("def2 r8 join: duplicate key columns on either side are invalid", () => {
  // Both sides have two TEXT columns so the duplicate check is reached
  // without a type-relation failure masking it.
  const L = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
  ], [["a", "1"]]);
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
  ], [["a", "1"]]);
  const base = { kind: "inner", leftColumns: ["c1"], rightColumns: ["c1"] };
  throwsCode(() => joinTables(L, R, { ...base, keys: [{ left: "c1", right: "c1" }, { left: "c1", right: "c2" }] }), "table_bad_request");
  throwsCode(() => joinTables(L, R, { ...base, keys: [{ left: "c1", right: "c1" }, { left: "c2", right: "c1" }] }), "table_bad_request");
});

Deno.test("def2 r8 join: int64/decimal keys match by exact numeric value across kind and scale", () => {
  const intL = table([
    { header: "id", type: { kind: "int64" } },
    { header: "v", type: { kind: "text" } },
  ], [
    ["5", "five"],
    ["-3", "neg"],
    ["7", "seven"],
  ]);
  const projectAll = (kind, left, right) => canonical(joinTables(left, right, {
    kind,
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: ["c1", "c2"],
  })).table.rows;
  // decimal(2): "5.00" and "-3.00" match exactly; "5.01"/"7.10" do not.
  const dec2 = table([
    { header: "id", type: { kind: "decimal", scale: 2 } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["5.00", "exact"],
    ["5.01", "close"],
    ["-3.00", "neg3"],
    ["7.10", "near"],
  ]);
  assertEquals(projectAll("inner", intL, dec2), [
    ["5", "five", "5.00", "exact"],
    ["-3", "neg", "-3.00", "neg3"],
  ]);
  // decimal(0), decimal(1) and decimal(18) spellings of 5 all match int64 5.
  const dec0 = table([{ header: "id", type: { kind: "decimal", scale: 0 } }, { header: "w", type: { kind: "text" } }], [["5", "z0"]]);
  const dec1 = table([{ header: "id", type: { kind: "decimal", scale: 1 } }, { header: "w", type: { kind: "text" } }], [["5.0", "z1"]]);
  const dec18 = table([{ header: "id", type: { kind: "decimal", scale: 18 } }, { header: "w", type: { kind: "text" } }], [["5.000000000000000000", "z18"]]);
  assertEquals(projectAll("inner", intL, dec0), [["5", "five", "5", "z0"]]);
  assertEquals(projectAll("inner", intL, dec1), [["5", "five", "5.0", "z1"]]);
  assertEquals(projectAll("inner", intL, dec18), [["5", "five", "5.000000000000000000", "z18"]]);
  // Cross-scale decimals: "1.50" (scale 2) == "1.5" (scale 1); duplicates on
  // the left complete the Cartesian product.
  const decA = table([{ header: "id", type: { kind: "decimal", scale: 2 } }, { header: "v", type: { kind: "text" } }], [
    ["1.50", "a1"],
    ["1.50", "a2"],
  ]);
  const decB = table([{ header: "id", type: { kind: "decimal", scale: 1 } }, { header: "w", type: { kind: "text" } }], [["1.5", "b1"]]);
  assertEquals(projectAll("inner", decA, decB), [
    ["1.50", "a1", "1.5", "b1"],
    ["1.50", "a2", "1.5", "b1"],
  ]);
});

Deno.test("def2 r8 join: non-numeric key domains require the identical typed kind", () => {
  const textKey = table([{ header: "k", type: { kind: "text" } }, { header: "v", type: { kind: "text" } }], [["a", "v1"]]);
  const intKey = table([{ header: "k", type: { kind: "int64" } }, { header: "w", type: { kind: "text" } }], [["1", "w1"]]);
  const dateKey = table([{ header: "k", type: { kind: "date" } }, { header: "v", type: { kind: "text" } }], [["2026-01-01", "d1"]]);
  const datetimeKey = table([{ header: "k", type: { kind: "datetime" } }, { header: "w", type: { kind: "text" } }], [["2026-01-01T00:00:00.000Z", "dt1"]]);
  const req = (left, right) => ({
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: ["c1", "c2"],
  });
  // text vs int64, text vs date, date vs datetime: mismatched declaration.
  throwsCode(() => joinTables(textKey, intKey, req(textKey, intKey)), "table_type_mismatch");
  throwsCode(() => joinTables(textKey, dateKey, req(textKey, dateKey)), "table_type_mismatch");
  throwsCode(() => joinTables(dateKey, datetimeKey, req(dateKey, datetimeKey)), "table_type_mismatch");
  // Same-kind typed tuples join by exact cell equality.
  const textKey2 = table([{ header: "k", type: { kind: "text" } }, { header: "w", type: { kind: "text" } }], [["a", "w1"]]);
  assertEquals(canonical(joinTables(textKey, textKey2, req(textKey, textKey2))).table.rows, [["a", "v1", "a", "w1"]]);
  const dateKey2 = table([{ header: "k", type: { kind: "date" } }, { header: "w", type: { kind: "text" } }], [["2026-01-01", "w1"]]);
  assertEquals(canonical(joinTables(dateKey, dateKey2, req(dateKey, dateKey2))).table.rows, [["2026-01-01", "d1", "2026-01-01", "w1"]]);
  // Booleans join by equality, never by truthiness; null never matches.
  const boolL = table([{ header: "b", type: { kind: "boolean" } }, { header: "v", type: { kind: "text" } }], [
    [true, "t1"],
    [false, "f1"],
    [null, "n1"],
  ]);
  const boolR = table([{ header: "b", type: { kind: "boolean" } }, { header: "w", type: { kind: "text" } }], [
    [true, "t2"],
    [null, "n2"],
  ]);
  assertEquals(canonical(joinTables(boolL, boolR, { ...req(boolL, boolR), kind: "full" })).table.rows, [
    [true, "t1", true, "t2"],
    [false, "f1", null, null],
    [null, "n1", null, null],
    [null, null, null, "n2"],
  ]);
});

Deno.test("def2 r8 join: null key components never match, single or composite", () => {
  const L = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "v", type: { kind: "text" } },
  ], [
    ["a", "1", "L1"],
    [null, "1", "LN"],
    ["a", "1", "L2"],
  ]);
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["a", "1", "R1"],
    [null, "1", "RN"],
  ]);
  const request = {
    kind: "full",
    keys: [{ left: "c1", right: "c1" }, { left: "c2", right: "c2" }],
    leftColumns: ["c1", "c2", "c3"],
    rightColumns: ["c1", "c2", "c3"],
  };
  // [null,"1"] and ["a","1"] are different tuples: an equal-looking null-key
  // right row still never matches, and both null-key rows stay as lones.
  assertEquals(canonical(joinTables(L, R, request)).table.rows, [
    ["a", "1", "L1", "a", "1", "R1"],
    [null, "1", "LN", null, null, null],
    ["a", "1", "L2", "a", "1", "R1"],
    [null, null, null, null, "1", "RN"],
  ]);
});

Deno.test("def2 r8 join: composite text keys cannot collide across separator spellings", () => {
  const tricky = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
  ], [
    ["a", "1\u0000x"],
    ["a\u00001", "x"],
  ]);
  const trickyR = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "text" } },
    { header: "m", type: { kind: "text" } },
  ], [
    ["a", "1\u0000x", "one"],
    ["a\u00001", "x", "two"],
  ]);
  assertEquals(
    canonical(joinTables(tricky, trickyR, {
      kind: "inner",
      keys: [{ left: "c1", right: "c1" }, { left: "c2", right: "c2" }],
      leftColumns: ["c1", "c2"],
      rightColumns: ["c3"],
    })).table.rows,
    [
      ["a", "1\u0000x", "one"],
      ["a\u00001", "x", "two"],
    ],
  );
});

Deno.test("def2 r8 join: mixed typed numeric + text composite keys normalize per component", () => {
  const L = table([
    { header: "t", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["a", "5"],
    ["b", "1"],
  ]);
  const R = table([
    { header: "t", type: { kind: "text" } },
    { header: "n", type: { kind: "decimal", scale: 2 } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["a", "5.00", "match"],
    ["b", "2.00", "miss"],
  ]);
  assertEquals(
    canonical(joinTables(L, R, {
      kind: "inner",
      keys: [{ left: "c1", right: "c1" }, { left: "c2", right: "c2" }],
      leftColumns: ["c1", "c2"],
      rightColumns: ["c3"],
    })).table.rows,
    [["a", "5", "match"]],
  );
});

Deno.test("def2 r8 join: empty projections are allowed; both empty keeps one row per emission", () => {
  // No left columns: the output is exactly the right projection.
  const rightOnly = canonical(joinTables(LEFT, RIGHT, {
    kind: "left",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: [],
    rightColumns: ["c1", "c2"],
  })).table;
  assertEquals(rightOnly.columns.map((column) => column.header), ["k", "w"]);
  assertEquals(rightOnly.rows, [
    ["x", "p"],
    ["x", "q"],
    ["x", "p"],
    ["x", "q"],
    [null, null],
    [null, null],
  ]);
  // No right columns: the output is exactly the left projection.
  const leftOnly = canonical(joinTables(LEFT, RIGHT, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: [],
  })).table;
  assertEquals(leftOnly.columns.map((column) => column.header), ["k", "v"]);
  assertEquals(leftOnly.rows, [["x", "1"], ["x", "1"], ["x", "2"], ["x", "2"]]);
  // Both empty: zero-column output rows, one per emission (7 rows for full).
  const none = canonical(joinTables(LEFT, RIGHT, {
    kind: "full",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: [],
    rightColumns: [],
  })).table;
  assertEquals(none.columns, []);
  assertEquals(none.rows.length, 7);
  assert(none.rows.every((row) => Array.isArray(row) && row.length === 0));
});

Deno.test("def2 r8 join: projection headers and types are preserved from the source columns", () => {
  // Projections are ID arrays only: the source header and type flow through
  // unchanged, in declared order. There is no per-column rename field.
  const out = canonical(joinTables(LEFT, RIGHT, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: ["c2"],
  })).table;
  assertEquals(out.columns.map((column) => column.header), ["k", "v", "w"]);
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "int64" },
    { kind: "text" },
  ]);
  assertEquals(out.rows, [
    ["x", "1", "p"],
    ["x", "1", "q"],
    ["x", "2", "p"],
    ["x", "2", "q"],
  ]);
});

Deno.test("def2 r8 join: keys can stay out of the projection entirely", () => {
  const out = canonical(joinTables(LEFT, RIGHT, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c2"],
    rightColumns: ["c2"],
  })).table;
  assertEquals(out.columns.map((column) => column.header), ["v", "w"]);
  assertEquals(out.rows, [
    ["1", "p"],
    ["1", "q"],
    ["2", "p"],
    ["2", "q"],
  ]);
});

Deno.test("def2 r8 join: pure-key right sides and empty sides stay canonical under projections", () => {
  const empty = table([{ header: "k", type: { kind: "text" } }], []);
  const one = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["a", "p"],
  ]);
  const cols = (n) => Array.from({ length: n }, (_, i) => `c${i + 1}`);
  // Right join with an empty left side: the unmatched right row keeps its own
  // key data in the right slots; left slots stay null.
  assertEquals(
    canonical(joinTables(empty, one, { kind: "right", keys: [{ left: "c1", right: "c1" }], leftColumns: cols(1), rightColumns: cols(2) })).table.rows,
    [[null, "a", "p"]],
  );
  assertEquals(
    canonical(joinTables(empty, one, { kind: "inner", keys: [{ left: "c1", right: "c1" }], leftColumns: cols(1), rightColumns: cols(2) })).table.rows,
    [],
  );
  // Left join against an empty right side: every left row stays, right slots null.
  assertEquals(
    canonical(joinTables(one, empty, { kind: "left", keys: [{ left: "c1", right: "c1" }], leftColumns: cols(2), rightColumns: cols(1) })).table.rows,
    [["a", "p", null]],
  );
  // Pure-key right side: projecting its only column keeps the key data visible.
  const pureKey = table([{ header: "k", type: { kind: "text" } }], [["b"]]);
  const pureOut = canonical(joinTables(one, pureKey, {
    kind: "full",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: ["c1"],
  })).table;
  assertEquals(pureOut.columns.map((column) => column.header), ["k", "w", "k"]);
  // Nothing matches (left key "a" vs right key "b"): the left row stays with
  // null right slots and the pure-key right row keeps its key in its own slot.
  assertEquals(pureOut.rows, [
    ["a", "p", null],
    [null, null, "b"],
  ]);
});

Deno.test("def2 r8 join: localeProfile and typed headers flow from the inputs into the output", () => {
  const de = assertCanonicalTable({
    version: TABLE_VERSION,
    localeProfile: "de-DE-v1",
    columns: [
      { id: "c1", header: "k", type: { kind: "text" } },
      { id: "c2", header: "Betrag", type: { kind: "decimal", scale: 2 } },
    ],
    rows: [["x", "1.25"]],
  });
  const en = assertCanonicalTable({
    version: TABLE_VERSION,
    localeProfile: "en-US-v1",
    columns: [
      { id: "c1", header: "k", type: { kind: "text" } },
      { id: "c2", header: "label", type: { kind: "text" } },
    ],
    rows: [["x", "hello"]],
  });
  const out = canonical(joinTables(de, en, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: ["c2"],
  })).table;
  assertEquals(out.localeProfile, "de-DE-v1"); // left table's profile wins
  assertEquals(out.columns.map((column) => column.header), ["k", "Betrag", "label"]);
  assertEquals(out.columns[1].type, { kind: "decimal", scale: 2 });
  assertEquals(out.rows, [["x", "1.25", "hello"]]);
});

Deno.test("def2 r8 join: work units equal key-cell hashes plus emitted cells", () => {
  // Toolkit unit definition: a work unit is one key-cell hash/comparison or
  // one emitted cell. Charge model: the key-pair count (1 here) per scanned
  // key-pass row on each side, plus the output width (4) per emitted row.
  // Multiplicity preflight and index construction are not separately charged.
  const req = (kind) => ({ ...joinRequest, kind });
  assertEquals(joinTables(LEFT, RIGHT, req("inner")).workUnits, 23); // 4+3 keys, 4 rows × 4 cells
  assertEquals(joinTables(LEFT, RIGHT, req("left")).workUnits, 31); // +2 left lones × 4 cells
  assertEquals(joinTables(LEFT, RIGHT, req("right")).workUnits, 27); // +5 right rows × 4 cells
  assertEquals(joinTables(LEFT, RIGHT, req("full")).workUnits, 35); // +7 rows × 4 cells
  const noMatchL = table([{ header: "k", type: { kind: "text" } }], [["a"], ["b"]]);
  const noMatchR = table([{ header: "k", type: { kind: "text" } }], [["c"], ["d"], ["e"]]);
  const emptyReq = (kind) => ({
    kind,
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1"],
    rightColumns: ["c1"],
  });
  const emptyJoin = joinTables(noMatchL, noMatchR, emptyReq("inner"));
  assertEquals(emptyJoin.workUnits, 5); // 2 + 3 key cells, 0 emitted cells
  assertEquals(emptyJoin.table.rows, []);
  assertEquals(joinTables(noMatchL, noMatchR, emptyReq("left")).workUnits, 9); // +2 lones × 2 cells
  assertEquals(joinTables(noMatchL, noMatchR, emptyReq("right")).workUnits, 11); // +3 lones × 2 cells
  assertEquals(joinTables(noMatchL, noMatchR, emptyReq("full")).workUnits, 15); // +5 lones × 2 cells
});

Deno.test("def2 r8 join: request shapes are exact and errors carry stable codes", () => {
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, kind: "outer" }), "table_bad_request");
  // keys: 1..8 pairs, exact {left,right}, no extra fields.
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [] }), "table_bad_request");
  throwsCode(
    () => joinTables(LEFT, RIGHT, { ...joinRequest, keys: Array.from({ length: 9 }, () => ({ left: "c1", right: "c1" })) }),
    "table_bad_request",
  );
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [{ left: "c9", right: "c1" }] }), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [{ left: "c1", right: "c9" }] }), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [{ left: "c1" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [{ left: 1, right: "c1" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [{ left: "c1", right: "c1", extra: true }] }), "table_unknown_field");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, extra: 1 }), "table_unknown_field");
  // leftColumns/rightColumns are required; empty arrays are legal.
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: joinRequest.keys, rightColumns: [] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: joinRequest.keys, leftColumns: [] }), "table_bad_request");
  // Projections accept ONLY dense arrays of canonical column-ID strings:
  // object entries (any shape), numbers and other non-strings are rejected.
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: [{ column: "c1" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, rightColumns: [{ column: "c1", header: "x" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: [{ column: "c1", extra: 1 }], rightColumns: [] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, rightColumns: [{ header: "x" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: ["c1", 5] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: [null], rightColumns: [] }), "table_bad_request");
  // Unknown or non-canonical column IDs fail table_unknown_column.
  const unknownColumn = { kind: "inner", keys: joinRequest.keys, leftColumns: ["c9"], rightColumns: ["c1"] };
  throwsCode(() => joinTables(LEFT, RIGHT, unknownColumn), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: ["c0"], rightColumns: [] }), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: ["x"], rightColumns: [] }), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, rightColumns: ["c9"] }), "table_unknown_column");
  // Projecting the same source column twice is legal (two output columns).
  const duplicated = canonical(joinTables(LEFT, RIGHT, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c2", "c2"],
    rightColumns: ["c2"],
  })).table;
  assertEquals(duplicated.columns.map((column) => column.header), ["v", "v", "w"]);
  throwsCode(() => joinTables(LEFT, null, joinRequest), "table_bad_request"); // assertCanonicalTable rejects null input
  // Inputs are strict canonical tables: non-array rows are rejected by the core.
  const broken = { version: TABLE_VERSION, localeProfile: "canonical-v1", columns: [{ id: "c1", header: "k", type: { kind: "text" } }], rows: [{ c1: "x" }] };
  throwsCode(() => joinTables(broken, RIGHT, joinRequest), "table_bad_request");
});

Deno.test("def2 r8 join: request objects and arrays must be plain own enumerable data — zero getters invoked", () => {
  // Sanity: the plain request still joins (strictness must not reject honest callers).
  canonical(joinTables(LEFT, RIGHT, joinRequest));
  let reads = 0;
  const makeGetter = (label) => function () { reads++; throw new Error(`getter for ${label} was read`); };
  // Top-level getter that fabricates the keys array on read (would throw).
  const topGetter = { kind: "inner", keys: joinRequest.keys, leftColumns: joinRequest.leftColumns, rightColumns: joinRequest.rightColumns };
  Object.defineProperty(topGetter, "keys", { enumerable: true, get: () => joinRequest.keys });
  throwsCode(() => joinTables(LEFT, RIGHT, topGetter), "table_bad_request");
  // Top-level getter on the new projection fields.
  const projGetter = { ...joinRequest };
  Object.defineProperty(projGetter, "leftColumns", { enumerable: true, get: makeGetter("leftColumns") });
  throwsCode(() => joinTables(LEFT, RIGHT, projGetter), "table_bad_request");
  assertEquals(reads, 0, "no request getter may be invoked during validation");
  // Top-level symbol-keyed extra property.
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, [Symbol("x")]: 1 }), "table_bad_request");
  // Top-level non-enumerable extra property (invisible to Object.keys).
  const topHidden = { ...joinRequest };
  Object.defineProperty(topHidden, "extra", { value: 1 });
  throwsCode(() => joinTables(LEFT, RIGHT, topHidden), "table_bad_request");
  // Nested: a key-pair member backed by an accessor.
  const pairGetter = { left: "c1" };
  Object.defineProperty(pairGetter, "right", { enumerable: true, get: makeGetter("right") });
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [pairGetter] }), "table_bad_request");
  assertEquals(reads, 0);
  // Nested: symbol-keyed extras on key pairs. Projection entries are ID
  // strings only, so an object element is rejected without any of its own
  // properties (symbols, accessors, hidden fields) being read.
  throwsCode(
    () => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [{ left: "c1", right: "c1", [Symbol("x")]: 1 }] }),
    "table_bad_request",
  );
  const objectEntry = { column: "c1" };
  Object.defineProperty(objectEntry, "header", { value: "k", enumerable: false });
  throwsCode(
    () => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: [objectEntry], rightColumns: [] }),
    "table_bad_request",
  );
  const getterEntry = {};
  Object.defineProperty(getterEntry, "column", { enumerable: true, get: makeGetter("entry.column") });
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, rightColumns: [getterEntry] }), "table_bad_request");
  assertEquals(reads, 0, "an object projection entry is rejected without reading into it");
  // Nested: non-enumerable required property on a key pair.
  const pairHidden = { left: "c1" };
  Object.defineProperty(pairHidden, "right", { value: "c1" });
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: [pairHidden] }), "table_bad_request");
  // Arrays indexed by accessors, or carrying symbols/non-index extras/holes.
  const accessorIndexed = [];
  Object.defineProperty(accessorIndexed, 0, { enumerable: true, get: makeGetter("keys[0]") });
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: accessorIndexed }), "table_bad_request");
  assertEquals(reads, 0);
  const symbolArray = [{ left: "c1", right: "c1" }];
  symbolArray[Symbol("x")] = 1;
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: symbolArray }), "table_bad_request");
  const extraKeyArray = joinRequest.keys.slice();
  extraKeyArray.tag = "meta";
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: extraKeyArray }), "table_bad_request");
  const sparse = [];
  sparse[1] = { left: "c1", right: "c1" };
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, keys: sparse }), "table_bad_request");
  const sparseProj = [];
  sparseProj[1] = "c1";
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: sparseProj, rightColumns: [] }), "table_bad_request");
  const symbolProj = ["c1"];
  symbolProj[Symbol("x")] = 1;
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, leftColumns: symbolProj, rightColumns: [] }), "table_bad_request");
  const taggedProj = ["c1"];
  taggedProj.tag = "meta";
  throwsCode(() => joinTables(LEFT, RIGHT, { ...joinRequest, rightColumns: taggedProj }), "table_bad_request");
});

// ---------------------------------------------------------------------------
// Join bounds — exact and +1 at the real strict-core ceilings
// ---------------------------------------------------------------------------

Deno.test("def2 r8 join: output row bound is preflighted — accepts exactly maxRows, fails one past it", () => {
  const L = table([{ header: "k", type: { kind: "text" } }], new Array(100).fill(["a"]));
  const R1000 = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], new Array(1000).fill(["a", "p"]));
  const req = (kind) => ({
    kind,
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1"],
    rightColumns: ["c2"],
  });
  const exact = joinTables(L, R1000, req("inner"));
  assertEquals(exact.table.rows.length, TABLE_LIMITS.maxRows); // 100 × 1000
  canonical(exact);
  const R1001 = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], new Array(1001).fill(["a", "p"]));
  throwsCode(
    () => joinTables(L, R1001, req("inner")),
    "table_row_bound",
  );
});

Deno.test("def2 r8 join: output cell bound is preflighted — accepts exactly maxCells, fails one past it", () => {
  // Output width 16: left 15 projected columns (key + 14 int64) + right 1.
  const makeL = (rows) => table(
    [{ header: "k", type: { kind: "text" } }, ...new Array(14).fill({ header: "z", type: { kind: "int64" } })],
    new Array(rows).fill(["a", ...new Array(14).fill("0")]),
  );
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "int64" } },
  ], [["a", "0"]]);
  const req = {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: Array.from({ length: 15 }, (_, i) => `c${i + 1}`),
    rightColumns: ["c2"],
  };
  // 62,500 rows × 16 columns = exactly 1,000,000 cells.
  assertEquals(TABLE_LIMITS.maxCells, 62_500 * 16);
  const exact = joinTables(makeL(62_500), R, req);
  assertEquals(exact.table.rows.length, 62_500);
  canonical(exact);
  throwsCode(
    () => joinTables(makeL(62_501), R, req),
    "table_cell_count_bound",
  );
});

Deno.test("def2 r8 join: output bytes accept exactly maxOutputBytes and fail one row past it", () => {
  // Every emitted row is byte-identical, so the boundary is computable:
  // total(n) = prefix + n × (rowBytes + 1). The prefix is measured from one
  // real emitted row so the test tracks the module's exact accounting.
  const key = "a";
  const payload = "x".repeat(200);
  const rowBytes = utf8(JSON.stringify([key, payload]));
  const one = table([{ header: "k", type: { kind: "text" } }], [[key]]);
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], [[key, payload]]);
  const req = {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1"],
    rightColumns: ["c2"],
  };
  const oneOut = joinTables(one, R, req).table;
  const prefix = utf8(JSON.stringify(oneOut)) - (rowBytes + 1); // strip the single row
  const maxRows = Math.floor((MAX_OUTPUT_BYTES - prefix) / (rowBytes + 1));
  assert(maxRows < TABLE_LIMITS.maxRows, "byte bound must trip before the row bound");
  const L = table([{ header: "k", type: { kind: "text" } }], new Array(maxRows).fill([key]));
  const exact = joinTables(L, R, req);
  assertEquals(exact.table.rows.length, maxRows);
  assert(utf8(JSON.stringify(exact.table)) <= MAX_OUTPUT_BYTES);
  canonical(exact);
  const LOver = table([{ header: "k", type: { kind: "text" } }], new Array(maxRows + 1).fill([key]));
  throwsCode(
    () => joinTables(LOver, R, req),
    "table_output_bound",
  );
});

Deno.test("def2 r8 join: OutputBudget validates the projected header total up front", () => {
  // Each side alone fits the 64 KiB input header total (500 × 100 B); the
  // combined projection (1000 × 100 B = 100 KiB) must fail in the budget
  // constructor, before any row is materialized.
  const wide = (prefix) => {
    const columns = Array.from({ length: 500 }, () => ({ header: `${prefix}${"h".repeat(99)}`, type: { kind: "text" } }));
    return table(columns, []);
  };
  const L = wide("L");
  const R = wide("R");
  throwsCode(() => joinTables(L, R, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: Array.from({ length: 500 }, (_, i) => `c${i + 1}`),
    rightColumns: Array.from({ length: 500 }, (_, i) => `c${i + 1}`),
  }), "table_header_bound");
  // Projection headers come from the (already canonical) source columns, so
  // the per-column cap cannot be crossed by a request; the combined-total cap
  // above is the projection-reachable bound.
});

// ---------------------------------------------------------------------------
// Pivots — categories, metrics, ordering
// ---------------------------------------------------------------------------

const PIVOT_DATA = table([
  { header: "region", type: { kind: "text" } },
  { header: "product", type: { kind: "text" } },
  { header: "qty", type: { kind: "int64" } },
], [
  ["east", "A", "4"],
  ["east", "A", "6"],
  ["east", "B", "5"],
  ["west", "A", "2"],
  ["west", "A", "8"],
  ["west", "B", "1"],
]);
const pivotRequest = {
  rowGroupBy: ["c1"],
  pivotColumn: "c2",
  categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
  metrics: [
    { op: "count_rows", header: "Rows" },
    { op: "count_values", column: "c3", header: "Filled" },
    { op: "sum", column: "c3", header: "Total" },
    { op: "avg", column: "c3", scale: 2, header: "Mean" },
    { op: "min", column: "c3", header: "Low" },
    { op: "max", column: "c3", header: "High" },
  ],
};

Deno.test("def2 r8 pivot: category-major value columns with composite headers over every metric op", () => {
  const out = canonical(pivotTable(PIVOT_DATA, pivotRequest)).table;
  assertEquals(out.columns.map((column) => column.header), [
    "region",
    "Alpha · Rows", "Alpha · Filled", "Alpha · Total", "Alpha · Mean", "Alpha · Low", "Alpha · High",
    "Beta · Rows", "Beta · Filled", "Beta · Total", "Beta · Mean", "Beta · Low", "Beta · High",
  ]);
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "int64" }, { kind: "int64" }, { kind: "int64" }, { kind: "decimal", scale: 2 }, { kind: "int64" }, { kind: "int64" },
    { kind: "int64" }, { kind: "int64" }, { kind: "int64" }, { kind: "decimal", scale: 2 }, { kind: "int64" }, { kind: "int64" },
  ]);
  assertEquals(out.rows, [
    // east A: rows 2, filled 2, total 10, mean 5.00, low 4, high 6 | east B: 1/1/5/5.00/5/5
    ["east", "2", "2", "10", "5.00", "4", "6", "1", "1", "5", "5.00", "5", "5"],
    ["west", "2", "2", "10", "5.00", "2", "8", "1", "1", "1", "1.00", "1", "1"],
  ]);
  assertEquals(out.rows[0].length, out.columns.length); // rectangular arrays
});

Deno.test("def2 r8 pivot: value columns follow the declared category order, metrics within each category", () => {
  const out = canonical(pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "B", header: "Beta" }, { value: "A", header: "Alpha" }],
    metrics: [
      { op: "sum", column: "c3", header: "Total" },
      { op: "count_rows", header: "Rows" },
    ],
  })).table;
  assertEquals(out.columns.map((column) => column.header), [
    "region",
    "Beta · Total", "Beta · Rows",
    "Alpha · Total", "Alpha · Rows",
  ]);
  assertEquals(out.rows, [
    ["east", "5", "1", "10", "2"],
    ["west", "1", "1", "10", "2"],
  ]);
});

Deno.test("def2 r8 pivot: row groups emit in first-seen data order and merge duplicates", () => {
  const data = table([
    { header: "region", type: { kind: "text" } },
    { header: "product", type: { kind: "text" } },
    { header: "qty", type: { kind: "int64" } },
  ], [
    ["west", "A", "2"],
    ["west", "B", "1"],
    ["east", "A", "6"],
    ["west", "A", "8"],
  ]);
  const out = canonical(pivotTable(data, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
    metrics: [{ op: "sum", column: "c3", header: "Total" }],
  })).table;
  assertEquals(out.rows, [
    ["west", "10", "1"],
    ["east", "6", null],
  ]);
});

Deno.test("def2 r8 pivot: missing buckets stay present — counts 0, aggregates null", () => {
  const data = table([
    { header: "region", type: { kind: "text" } },
    { header: "product", type: { kind: "text" } },
    { header: "qty", type: { kind: "int64" } },
  ], [
    ["north", "A", "2"],
    ["north", "B", "3"],
    ["south", "A", "1"],
  ]);
  const out = canonical(pivotTable(data, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }, { value: "C", header: "Gamma" }],
    metrics: [
      { op: "sum", column: "c3", header: "Total" },
      { op: "count_values", column: "c3", header: "Filled" },
    ],
  })).table;
  assertEquals(out.rows, [
    ["north", "2", "1", "3", "1", null, "0"],
    ["south", "1", "1", null, "0", null, "0"],
  ]);
});

Deno.test("def2 r8 pivot: count_rows counts bucket rows; count_values counts non-null cells only", () => {
  const data = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
    { header: "t", type: { kind: "text" } },
  ], [
    ["g1", "A", "1", "x"],
    ["g1", "A", null, "y"],
    ["g1", "A", null, null],
  ]);
  const out = canonical(pivotTable(data, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "count_values", column: "c3", header: "Filled" },
      { op: "sum", column: "c3", header: "Total" },
      { op: "count_values", column: "c4", header: "Ticks" },
    ],
  })).table;
  assertEquals(out.columns.map((column) => column.header), [
    "g",
    "Alpha · Rows", "Alpha · Filled", "Alpha · Total", "Alpha · Ticks",
    "Beta · Rows", "Beta · Filled", "Beta · Total", "Beta · Ticks",
  ]);
  // Bucket A has 3 rows: Rows 3; v non-null 1; SUM(v)=1; t non-null 2.
  // Bucket B is empty: counts "0", aggregates null.
  assertEquals(out.rows, [["g1", "3", "1", "1", "2", "0", "0", null, "0"]]);
});

Deno.test("def2 r8 pivot: avg requires an explicit scale and rounds half-even at exactly it", () => {
  const average = (rows, scale) => canonical(pivotTable(table([
    { header: "c", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], rows.map((n) => ["A", n])), {
    rowGroupBy: ["c1"],
    pivotColumn: "c1",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "avg", column: "c2", scale, header: "Mean" }],
  })).table.rows[0][1];
  assertEquals(average(["1", "2"], 6), "1.500000"); // exact half at scale 6
  assertEquals(average(["1", "2"], 3), "1.500");
  assertEquals(average(["1", "2"], 0), "2"); // half-even at scale 0: 1.5 -> 2
  assertEquals(average(["1", "2", "3"], 0), "2");
  assertEquals(average(["1", "2", "4"], 2), "2.33"); // 7/3 truncation to scale 2
  assertEquals(average(["1", "2", "4"], 6), "2.333333");
  assertEquals(average(["2", "2"], 0), "2");
  // Output type is decimal at the requested scale (scale 0 included).
  const typed = canonical(pivotTable(table([
    { header: "c", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [["A", "1"], ["A", "2"]]), {
    rowGroupBy: ["c1"], pivotColumn: "c1",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "avg", column: "c2", scale: 0, header: "Mean" }],
  })).table;
  assertEquals(typed.columns[1].type, { kind: "decimal", scale: 0 });
  assertEquals(typed.rows[0][1], "2");
  // Half-even on decimal sources: (0.01+0.04)/2 = 0.025 -> 0.02 at scale 2
  // (even), 0.025 exact at scale 3.
  const cents = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "amt", type: { kind: "decimal", scale: 2 } },
  ], [
    ["g1", "A", "0.01"],
    ["g1", "A", "0.04"],
  ]);
  const avgAt = (scale) => canonical(pivotTable(cents, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "avg", column: "c3", scale, header: "Mean" }],
  })).table.rows[0][1];
  assertEquals(avgAt(2), "0.02");
  assertEquals(avgAt(3), "0.025");
});

Deno.test("def2 r8 pivot: decimal sums and averages stay exact at the requested scale", () => {
  const data = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "amt", type: { kind: "decimal", scale: 2 } },
  ], [
    ["g1", "A", "1.25"],
    ["g1", "A", "3.75"],
    ["g1", "A", "0.10"],
    ["g2", "A", "7.00"],
    ["g2", "B", "0.01"],
  ]);
  const out = canonical(pivotTable(data, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
    metrics: [
      { op: "sum", column: "c3", header: "Total" },
      { op: "avg", column: "c3", scale: 2, header: "Mean" },
    ],
  })).table;
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "decimal", scale: 2 }, { kind: "decimal", scale: 2 },
    { kind: "decimal", scale: 2 }, { kind: "decimal", scale: 2 },
  ]);
  assertEquals(out.rows, [
    ["g1", "5.10", "1.70", null, null], // (1.25+3.75+0.10)=5.10; 5.10/3=1.70 exactly
    ["g2", "7.00", "7.00", "0.01", "0.01"],
  ]);
});

Deno.test("def2 r8 pivot: min/max compare numerically across int64/decimal, never lexically", () => {
  const ints = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["g1", "A", "100"],
    ["g1", "A", "9"],
    ["g1", "A", "-2"],
    ["g1", "A", "80"],
    ["g1", "A", "-9"],
    ["g1", "A", "2"],
  ]);
  const intOut = canonical(pivotTable(ints, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "min", column: "c3", header: "Low" }, { op: "max", column: "c3", header: "High" }],
  })).table;
  assertEquals(intOut.rows, [["g1", "-9", "100"]]);
  const decs = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "d", type: { kind: "decimal", scale: 2 } },
  ], [
    ["g1", "A", "100.00"],
    ["g1", "A", "9.50"],
    ["g1", "A", "-2.25"],
    ["g1", "A", "80.00"],
    ["g1", "A", "-9.75"],
    ["g1", "A", "2.00"],
  ]);
  const decOut = canonical(pivotTable(decs, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "min", column: "c3", header: "Low" }, { op: "max", column: "c3", header: "High" }],
  })).table;
  assertEquals(decOut.rows, [["g1", "-9.75", "100.00"]]);
});

Deno.test("def2 r8 pivot: min/max order text by code points, dates canonically, and skip null cells", () => {
  const data = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "t", type: { kind: "text" } },
  ], [
    ["g1", "A", "b"],
    ["g1", "A", "a"],
    ["g1", "A", "aa"],
    ["g1", "A", null],
  ]);
  const out = canonical(pivotTable(data, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A", header: "Alpha" }],
    metrics: [
      { op: "min", column: "c3", header: "Low" },
      { op: "max", column: "c3", header: "High" },
      { op: "count_values", column: "c3", header: "Filled" },
    ],
  })).table;
  assertEquals(out.rows, [["g1", "a", "b", "3"]]);
  const dates = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "d", type: { kind: "date" } },
  ], [
    ["g1", "A", "2026-01-15"],
    ["g1", "A", "2025-12-31"],
  ]);
  const dateOut = canonical(pivotTable(dates, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "min", column: "c3", header: "Low" }, { op: "max", column: "c3", header: "High" }],
  })).table;
  assertEquals(dateOut.rows, [["g1", "2025-12-31", "2026-01-15"]]);
  assertEquals(dateOut.columns[1].type, { kind: "date" });
});

Deno.test("def2 r8 pivot: rowGroupBy [] pivots the whole table and still emits one row for empty input", () => {
  const whole = table([
    { header: "region", type: { kind: "text" } },
    { header: "product", type: { kind: "text" } },
    { header: "qty", type: { kind: "int64" } },
  ], [
    ["east", "A", "4"],
    ["west", "B", "1"],
  ]);
  const wholeRequest = {
    rowGroupBy: [],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "sum", column: "c3", header: "Total" },
    ],
  };
  const out = canonical(pivotTable(whole, wholeRequest)).table;
  assertEquals(out.columns.map((column) => column.header), [
    "Alpha · Rows", "Alpha · Total", "Beta · Rows", "Beta · Total",
  ]);
  assertEquals(out.rows, [["1", "4", "1", "1"]]);
  // Empty input under [] rowGroupBy still reports the single whole-table
  // group (the strict core's aggregate precedent): counts 0, aggregates null.
  const empty = table([
    { header: "region", type: { kind: "text" } },
    { header: "product", type: { kind: "text" } },
    { header: "qty", type: { kind: "int64" } },
  ], []);
  const emptyOut = canonical(pivotTable(empty, {
    rowGroupBy: [],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "sum", column: "c3", header: "Total" },
    ],
  })).table;
  assertEquals(emptyOut.rows, [["0", null]]);
  // The single whole-table group row emits one cell (width 1): 1 unit.
  assertEquals(pivotTable(empty, {
    rowGroupBy: [],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  }).workUnits, 1);
  // Non-empty rowGroupBy over empty input: no first-seen groups, no rows.
  const groupedEmpty = canonical(pivotTable(empty, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  })).table;
  assertEquals(groupedEmpty.rows, []);
});

Deno.test("def2 r8 pivot: outputs stay canonical and null group cells group together", () => {
  const nullGroup = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
  ], [
    [null, "A", "1"],
    [null, "A", "2"],
    ["g1", "A", "5"],
  ]);
  const grouped = canonical(pivotTable(nullGroup, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "sum", column: "c3", header: "Total" }],
  })).table;
  assertEquals(grouped.rows, [[null, "3"], ["g1", "5"]]); // null groups group together
});

Deno.test("def2 r8 pivot: unknown or null category values fail the whole job", () => {
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "Z", header: "Zed" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  }), "table_category_unknown");
  const nullCell = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
  ], [
    ["g1", null],
  ]);
  throwsCode(() => pivotTable(nullCell, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  }), "table_category_unknown");
});

Deno.test("def2 r8 pivot: sum overflow on int64 fails the whole job exactly", () => {
  const data = table([
    { header: "c", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["A", "9223372036854775807"],
    ["A", "1"],
  ]);
  throwsCode(() => pivotTable(data, {
    rowGroupBy: ["c1"], pivotColumn: "c1", categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "sum", column: "c2", header: "Total" }],
  }), "table_numeric_overflow");
});

Deno.test("def2 r8 pivot: category and metric headers are required and compose the column headers", () => {
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A" }, { value: "B", header: "Beta" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows" }],
  }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: 5 }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: 5 }],
  }), "table_bad_request");
  // The composite header is exactly `${category.header} · ${metric.header}`.
  const onlyA = table([
    { header: "region", type: { kind: "text" } },
    { header: "product", type: { kind: "text" } },
  ], [["east", "A"]]);
  const out = canonical(pivotTable(onlyA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  })).table;
  assertEquals(out.columns.map((column) => column.header), ["region", "Alpha · Rows"]);
});

Deno.test("def2 r8 pivot: request shapes are exact — op/column/scale rules and stable codes", () => {
  const base = () => ({ ...pivotRequest });
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), extra: 1 }), "table_unknown_field");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "mean", column: "c3", header: "M" }] }), "table_bad_request");
  // count_rows forbids a column; every other op requires one.
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "count_rows", column: "c3", header: "Rows" }] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "count_values", header: "Filled" }] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "sum", header: "Total" }] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", header: "Mean", scale: 2 }] }), "table_bad_request");
  // avg requires an explicit integer scale 0..18; only avg accepts scale.
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", column: "c3", header: "Mean" }] }), "table_type_invalid");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", column: "c3", scale: 19, header: "Mean" }] }), "table_type_invalid");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", column: "c3", scale: -1, header: "Mean" }] }), "table_type_invalid");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", column: "c3", scale: 2.5, header: "Mean" }] }), "table_type_invalid");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", column: "c3", scale: "2", header: "Mean" }] }), "table_type_invalid");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "sum", column: "c3", scale: 2, header: "Total" }] }), "table_unknown_field");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "count_rows", scale: 2, header: "Rows" }] }), "table_unknown_field");
  // Column references and source-type rules.
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "sum", column: "c9", header: "Total" }] }), "table_unknown_column");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "sum", column: "c1", header: "Total" }] }), "table_type_mismatch"); // text column
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "avg", column: "c1", scale: 2, header: "Mean" }] }), "table_type_mismatch"); // text column
  // rowGroupBy: [] is accepted (whole table); 1..8 ids, duplicates invalid.
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), rowGroupBy: ["c9"] }), "table_unknown_column");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), rowGroupBy: ["c1", "c1"] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), rowGroupBy: Array.from({ length: 9 }, () => "c1") }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: Array.from({ length: 17 }, () => ({ op: "count_rows", header: "R" })) }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), categories: [] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), categories: Array.from({ length: 129 }, (_, i) => ({ value: `v${i}`, header: `h${i}` })) }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), categories: [{ value: "A", header: "Alpha" }, { value: "A", header: "Alpha2" }] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), pivotColumn: "c9" }), "table_unknown_column");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), categories: [{ value: "A", header: "Alpha", extra: 1 }] }), "table_unknown_field");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...base(), metrics: [{ op: "sum", column: "c3", header: "Total", extra: 1 }] }), "table_unknown_field");
  // Boolean columns cannot be min/max ordered; sum/avg need numeric sources.
  const bools = table([
    { header: "b", type: { kind: "boolean" } },
    { header: "c", type: { kind: "text" } },
  ], [[true, "x"]]);
  throwsCode(() => pivotTable(bools, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "x", header: "X" }], metrics: [{ op: "min", column: "c1", header: "Low" }],
  }), "table_type_mismatch");
  throwsCode(() => pivotTable(bools, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "x", header: "X" }], metrics: [{ op: "max", column: "c1", header: "High" }],
  }), "table_type_mismatch");
});

Deno.test("def2 r8 pivot: request objects and nested entries must be plain own enumerable data — zero getters invoked", () => {
  canonical(pivotTable(PIVOT_DATA, pivotRequest));
  let reads = 0;
  const countingGetter = () => {
    reads++;
    throw new Error("getter read");
  };
  const topGetter = { ...pivotRequest };
  Object.defineProperty(topGetter, "metrics", { enumerable: true, get: countingGetter });
  throwsCode(() => pivotTable(PIVOT_DATA, topGetter), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, [Symbol("x")]: 1 }), "table_bad_request");
  const topHidden = { ...pivotRequest };
  Object.defineProperty(topHidden, "extra", { value: 1 });
  throwsCode(() => pivotTable(PIVOT_DATA, topHidden), "table_bad_request");
  const categoryGetter = { value: "A", header: "Alpha" };
  Object.defineProperty(categoryGetter, "header", { enumerable: true, get: countingGetter });
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, categories: [categoryGetter] }), "table_bad_request");
  assertEquals(reads, 0, "no request getter may be invoked during validation");
  const metricHidden = { op: "count_rows" };
  Object.defineProperty(metricHidden, "header", { value: "Rows" });
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [metricHidden] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [{ op: "count_rows", header: "Rows", [Symbol("x")]: 1 }] }), "table_bad_request");
  const symbolCategories = [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }];
  symbolCategories[Symbol("x")] = 1;
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, categories: symbolCategories }), "table_bad_request");
  const accessorGroup = [];
  Object.defineProperty(accessorGroup, 0, { enumerable: true, get: countingGetter });
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, rowGroupBy: accessorGroup }), "table_bad_request");
  assertEquals(reads, 0);
  const sparseCategories = [];
  sparseCategories[1] = { value: "A", header: "Alpha" };
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, categories: sparseCategories }), "table_bad_request");
  const sparseMetrics = [];
  sparseMetrics[1] = { op: "count_rows", header: "Rows" };
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: sparseMetrics }), "table_bad_request");
  const taggedMetrics = pivotRequest.metrics.slice();
  taggedMetrics.tag = "meta";
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: taggedMetrics }), "table_bad_request");
});

Deno.test("def2 r8 pivot: category values must be valid canonical cells for the pivot column type", () => {
  const ints = table([
    { header: "g", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["g1", "5"],
  ]);
  const base = { rowGroupBy: ["c1"], pivotColumn: "c2", metrics: [{ op: "count_rows", header: "Rows" }] };
  assertEquals(canonical(pivotTable(ints, { ...base, categories: [{ value: "5", header: "Five" }] })).table.rows, [["g1", "1"]]);
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: "05", header: "ZeroFive" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: null, header: "Null" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: 5, header: "Number" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: "99999999999999999999", header: "Big" }] }), "table_type_mismatch");
  // decimal(2) pivot column: canonical two-scale strings only.
  const decs = table([
    { header: "g", type: { kind: "text" } },
    { header: "d", type: { kind: "decimal", scale: 2 } },
  ], [
    ["g1", "1.50"],
  ]);
  const decBase = { rowGroupBy: ["c1"], pivotColumn: "c2", metrics: [{ op: "count_rows", header: "Rows" }] };
  assertEquals(canonical(pivotTable(decs, { ...decBase, categories: [{ value: "1.50", header: "OneFifty" }] })).table.rows, [["g1", "1"]]);
  throwsCode(() => pivotTable(decs, { ...decBase, categories: [{ value: "1.5", header: "OneFive" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(decs, { ...decBase, categories: [{ value: "1.500", header: "OneFiveZero" }] }), "table_type_mismatch");
  // Boolean pivot column: typed booleans.
  const flags = table([
    { header: "g", type: { kind: "text" } },
    { header: "b", type: { kind: "boolean" } },
  ], [
    ["g1", true],
    ["g1", false],
    ["g2", true],
  ]);
  const flagOut = canonical(pivotTable(flags, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: true, header: "True" }, { value: false, header: "False" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  })).table;
  assertEquals(flagOut.rows, [["g1", "1", "1"], ["g2", "1", "0"]]);
});

Deno.test("def2 r8 pivot: decimal categories must be canonical strict-core cells — negative zero and >38-digit values are rejected even on empty tables", () => {
  const empty = (scale) => table([
    { header: "g", type: { kind: "text" } },
    { header: "d", type: { kind: "decimal", scale } },
  ], []);
  const base = { rowGroupBy: ["c1"], pivotColumn: "c2", metrics: [{ op: "count_rows", header: "Rows" }] };
  throwsCode(() => pivotTable(empty(2), { ...base, categories: [{ value: "-0.00", header: "Nz" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(empty(1), { ...base, categories: [{ value: "-0.0", header: "Nz" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(empty(0), { ...base, categories: [{ value: "-0", header: "Nz" }] }), "table_type_mismatch");
  // 39 literal digits (37 whole + scale 2) exceed the core's 38-digit ceiling.
  throwsCode(
    () => pivotTable(empty(2), { ...base, categories: [{ value: `${["1", "0".repeat(36)].join("")}.00`, header: "Big" }] }), // eslint-disable-line
    "table_type_mismatch",
  );
  // Exactly 38 digits is the ceiling and stays usable on an empty table.
  const exact = canonical(pivotTable(empty(2), { ...base, categories: [{ value: `${["1", "0".repeat(35)].join("")}.00`, header: "Big" }] })).table;
  assertEquals(exact.rows, []);
});

Deno.test("def2 r8 pivot: work units equal input visits plus emitted cells", () => {
  // 6 discovery input rows × (1 rowGroupBy cell + 1 category visit) + 6 rows
  // × 6 metrics (aggregation visits) + 2 group rows × 13 emitted cells (1
  // group column + 2 categories × 6 metrics) = 12 + 36 + 26 = 74.
  assertEquals(pivotTable(PIVOT_DATA, pivotRequest).workUnits, 74);
  // Whole-table pivot of the same data: [] rowGroupBy charges only the
  // category visit per row, so 6 × 1 + 36 + 1 group × 12 cells (2 categories
  // × 6 metrics, no group column) = 6 + 36 + 12 = 54.
  assertEquals(pivotTable(PIVOT_DATA, { ...pivotRequest, rowGroupBy: [] }).workUnits, 54);
});

Deno.test("def2 r8 pivot: work units charge every group-key cell, the category visit, every metric visit and every emitted cell", () => {
  // The known cross-slice sample: 3 input rows, ONE rowGroupBy column, two
  // metrics, two categories → 2 output groups × 5 output columns (1 group
  // cell + 2 categories × 2 metric cells). Exact accounting:
  //   discovery:    3 rows × (1 group-key cell hash + 1 pivot-category cell
  //                 comparison)          = 6
  //   aggregation:  3 rows × 2 metric visits = 6
  //   emission:     2 groups × 5 emitted cells = 10
  //   total = 22. (A discovery pass charging one unit per row returns 19.)
  const cross = table([
    { header: "g", type: { kind: "text" } },
    { header: "p", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
  ], [
    ["g1", "A", "1"],
    ["g1", "B", "2"],
    ["g2", "A", "3"],
  ]);
  const crossRequest = {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "sum", column: "c3", header: "Total" },
    ],
  };
  const crossOut = canonical(pivotTable(cross, crossRequest));
  assertEquals(crossOut.table.rows.length, 2);
  assertEquals(crossOut.table.columns.length, 5);
  assertEquals(crossOut.workUnits, 22);

  // TWO rowGroupBy columns: discovery must charge each group-key cell, so
  // 4 rows × (2 key cells + 1 category visit) — a per-row discovery unit can
  // never reproduce this. Exact accounting:
  //   discovery:    4 rows × (2 + 1)       = 12
  //   aggregation:  4 rows × 2 metric visits = 8
  //   emission:     2 groups × (2 group cells + 2 categories × 2 metric
  //                 cells) = 2 × 6          = 12
  //   total = 32.
  const multi = table([
    { header: "g", type: { kind: "text" } },
    { header: "h", type: { kind: "text" } },
    { header: "p", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
  ], [
    ["a", "x", "A", "1"],
    ["a", "x", "A", "2"],
    ["b", "y", "A", "3"],
    ["b", "y", "B", "4"],
  ]);
  const multiRequest = {
    rowGroupBy: ["c1", "c2"],
    pivotColumn: "c3",
    categories: [{ value: "A", header: "Alpha" }, { value: "B", header: "Beta" }],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "sum", column: "c4", header: "Total" },
    ],
  };
  const multiOut = canonical(pivotTable(multi, multiRequest));
  assertEquals(multiOut.table.rows.length, 2);
  assertEquals(multiOut.table.columns.length, 6);
  assertEquals(multiOut.workUnits, 32);
});

// ---------------------------------------------------------------------------
// Pivot bounds — exact and +1 at the real strict-core ceilings
// ---------------------------------------------------------------------------

Deno.test("def2 r8 pivot: row-group bound accepts exactly maxGroups and fails one past it", () => {
  const make = (groups) => {
    const rows = [];
    for (let i = 0; i < groups; i++) rows.push([`g${i}`, "A"]);
    return table([
      { header: "g", type: { kind: "text" } },
      { header: "c", type: { kind: "text" } },
    ], rows);
  };
  const request = {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  };
  const exact = pivotTable(make(TABLE_LIMITS.maxGroups), request);
  assertEquals(exact.table.rows.length, TABLE_LIMITS.maxGroups);
  canonical(exact);
  throwsCode(() => pivotTable(make(TABLE_LIMITS.maxGroups + 1), request), "table_group_bound");
});

Deno.test("def2 r8 pivot: output width accepts maxColumns and fails one past it, before any scan", () => {
  const wide = () => {
    const rows = [["g", "g", "g", "g", "g", "g", "g", "g", "v0"]];
    return table(
      [...new Array(8).fill({ header: "g", type: { kind: "text" } }), { header: "c", type: { kind: "text" } }],
      rows,
    );
  };
  const request = (count) => ({
    rowGroupBy: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"],
    pivotColumn: "c9",
    categories: Array.from({ length: count }, (_, i) => ({ value: `v${i}`, header: `c${i}` })),
    metrics: Array.from({ length: 8 }, (_, i) => ({ op: "count_rows", header: `m${i}` })),
  });
  const exact = pivotTable(wide(), request(127));
  assertEquals(exact.table.columns.length, 8 + 127 * 8);
  assertEquals(exact.table.columns.length, TABLE_LIMITS.maxColumns);
  canonical(exact);
  throwsCode(() => pivotTable(wide(), request(128)), "table_column_bound"); // 8 + 128×8 = 1032
});

Deno.test("def2 r8 pivot: output cells are preflighted before aggregation — exact maxCells and one past it", () => {
  const categories = [];
  for (let i = 0; i < 16; i++) categories.push({ value: `v${i}`, header: `h${i}` });
  const metrics = Array.from({ length: 16 }, (_, i) => ({ op: "count_rows", header: `m${i}` }));
  const make = (groups) => {
    const rows = [];
    for (let i = 0; i < groups; i++) rows.push([`g${i}`, "v0"]);
    return table([
      { header: "g", type: { kind: "text" } },
      { header: "c", type: { kind: "text" } },
    ], rows);
  };
  const request = { rowGroupBy: ["c1"], pivotColumn: "c2", categories, metrics };
  assertEquals(3_891 * 257, 999_987); // sanity: within the cell cap
  const out = pivotTable(make(3_891), request);
  assertEquals(out.table.rows.length, 3_891);
  canonical(out);
  throwsCode(() => pivotTable(make(3_892), request), "table_cell_count_bound");
});

Deno.test("def2 r8 pivot: header byte limits fail up front — per column and total", () => {
  // A single composite header over maxHeaderBytes fails in the budget.
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }],
    metrics: [{ op: "count_rows", header: "m".repeat(TABLE_LIMITS.maxHeaderBytes + 1) }],
  }), "table_header_bound");
  // 1016 composite headers of ~203 bytes fit per column but blow the 64 KiB
  // header total — validated in the budget constructor before any scan.
  const wide = () => {
    const rows = [["g", "g", "g", "g", "g", "g", "g", "g", "v0"]];
    return table(
      [...new Array(8).fill({ header: "g", type: { kind: "text" } }), { header: "c", type: { kind: "text" } }],
      rows,
    );
  };
  throwsCode(() => pivotTable(wide(), {
    rowGroupBy: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"],
    pivotColumn: "c9",
    categories: Array.from({ length: 127 }, (_, i) => ({ value: `v${i}`, header: "c".repeat(180) })),
    metrics: Array.from({ length: 8 }, (_, i) => ({ op: "count_rows", header: "m".repeat(20) })),
  }), "table_header_bound");
});
