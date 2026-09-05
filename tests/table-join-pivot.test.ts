// @ts-nocheck
// tests/table-join-pivot.test.ts — chrome-agent-platform-def.2 rewrite KATs
// over the strict canonical table core (rows are ARRAYS, column types are
// { kind, scale? } objects, outputs pass assertCanonicalTable).
//
// These tests are written against the canonical ARRAY-row contract. A join or
// pivot implementation that models rows as OBJECTS (row["c1"], spread rows
// into objects, object-keyed output columns) fails every shape assertion
// below, as did the broken r5-style prior attempt (cap-def2-strict). All
// int64/decimal values are canonical strings produced by BigInt arithmetic.
//
// Coverage:
//   * joins: inner/left/right/full over many-to-many keys in exact stable
//     order, composite and null keys, duplicate Cartesian, coalesced right
//     keys in outer joins, typed no-coercion key columns
//   * pivots: explicit ordered categories (unknown/null value fails the
//     job), first-seen groups, count/sum/avg/min/max with exact BigInt
//     semantics (sum preserves the source type, avg is decimal half-even at
//     the source scale or scale 6 for int64), missing buckets stay present
//   * bounds at the real strict-core ceilings, exact and +1: output rows,
//     output cells, exact serialized output bytes, row groups, and output
//     column width

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
// Joins — kinds, ordering, duplicates, keys
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
const joinRequest = { kind: "inner", keys: [{ left: "c1", right: "c1" }] };

Deno.test("def2 join: inner/left/right/full over many-to-many keys in exact stable order", () => {
  const outputColumns = [
    { header: "k", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
    { header: "w", type: { kind: "text" } },
  ];
  // inner: left-major; per left row, right matches in right input order.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c1", right: "c1" }] })).table,
    table(outputColumns, [
      ["x", "1", "p"],
      ["x", "1", "q"],
      ["x", "2", "p"],
      ["x", "2", "q"],
    ]),
  );
  // left: inner plus unmatched left rows null-padded in place.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { kind: "left", keys: [{ left: "c1", right: "c1" }] })).table,
    table(outputColumns, [
      ["x", "1", "p"],
      ["x", "1", "q"],
      ["x", "2", "p"],
      ["x", "2", "q"],
      ["y", "3", null],
      ["z", "4", null],
    ]),
  );
  // right: right-major; each right row is followed by its left matches, and an
  // unmatched right row keeps its key value in the coalesced key column.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { kind: "right", keys: [{ left: "c1", right: "c1" }] })).table,
    table(outputColumns, [
      ["x", "1", "p"],
      ["x", "2", "p"],
      ["x", "1", "q"],
      ["x", "2", "q"],
      ["w", null, "r"],
    ]),
  );
  // full: left-major emission (pairs + unmatched left) then unmatched right rows.
  assertEquals(
    canonical(joinTables(LEFT, RIGHT, { kind: "full", keys: [{ left: "c1", right: "c1" }] })).table,
    table(outputColumns, [
      ["x", "1", "p"],
      ["x", "1", "q"],
      ["x", "2", "p"],
      ["x", "2", "q"],
      ["y", "3", null],
      ["z", "4", null],
      ["w", null, "r"],
    ]),
  );
});

Deno.test("def2 join: output rows are arrays with positional column access", () => {
  const out = canonical(joinTables(LEFT, RIGHT, joinRequest)).table;
  assert(Array.isArray(out.rows[0]), "joined rows must be arrays, not objects");
  assertEquals(out.rows[0][1], "1"); // column-index access, like the strict core
  assertEquals(out.rows[0].c1, undefined); // object access must not work
  assertEquals(out.columns.map((column) => column.id), ["c1", "c2", "c3"]);
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "int64" },
    { kind: "text" },
  ]);
  // Right key column c1 is dropped (left key slot carries it); right non-key
  // payload columns follow the left columns.
  assertEquals(out.columns.map((column) => column.header), ["k", "v", "w"]);
});

Deno.test("def2 join: composite keys complete the Cartesian product over duplicates", () => {
  const L = table([
    { header: "k", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["a", "1"],
    ["a", "1"],
    ["a", "2"],
    ["b", "1"],
  ]);
  const R = table([
    { header: "a", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
    { header: "m", type: { kind: "text" } },
  ], [
    ["a", "1", "m1"],
    ["a", "2", "m2"],
  ]);
  const out = canonical(joinTables(L, R, {
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }, { left: "c2", right: "c2" }],
  })).table;
  assertEquals(out.rows, [
    ["a", "1", "m1"],
    ["a", "1", "m1"],
    ["a", "2", "m2"],
  ]);
  // The two composite-key pairs share no textual separator: a text key that
  // contains the JSON of a sibling must not collide. ("a", "1x1") vs ("a1", "x1").
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
    })).table.rows,
    [
      ["a", "1\u0000x", "one"],
      ["a\u00001", "x", "two"],
    ],
  );
});

Deno.test("def2 join: null keys never match; outer joins keep every unmatched row", () => {
  const L = table([
    { header: "k", type: { kind: "text" } },
    { header: "v", type: { kind: "int64" } },
  ], [
    ["a", "1"],
    [null, "2"],
    ["a", "3"],
    [null, "4"],
  ]);
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], [
    [null, "n"],
    ["a", "p"],
    ["b", "q"],
  ]);
  // inner drops every null-key row on either side.
  assertEquals(
    canonical(joinTables(L, R, { kind: "inner", keys: [{ left: "c1", right: "c1" }] })).table.rows,
    [
      ["a", "1", "p"],
      ["a", "3", "p"],
    ],
  );
  // left keeps unmatched left rows (null keys included) in place.
  assertEquals(
    canonical(joinTables(L, R, { kind: "left", keys: [{ left: "c1", right: "c1" }] })).table.rows,
    [
      ["a", "1", "p"],
      [null, "2", null],
      ["a", "3", "p"],
      [null, "4", null],
    ],
  );
  // right is right-major and keeps unmatched right rows; null-key right rows
  // never match and appear as unmatched.
  assertEquals(
    canonical(joinTables(L, R, { kind: "right", keys: [{ left: "c1", right: "c1" }] })).table.rows,
    [
      [null, null, "n"],
      ["a", "1", "p"],
      ["a", "3", "p"],
      ["b", null, "q"],
    ],
  );
  // full appends every unmatched right row, coalescing its key into the left
  // key slot so no key data is lost.
  assertEquals(
    canonical(joinTables(L, R, { kind: "full", keys: [{ left: "c1", right: "c1" }] })).table.rows,
    [
      ["a", "1", "p"],
      [null, "2", null],
      ["a", "3", "p"],
      [null, "4", null],
      [null, null, "n"], // unmatched right rows append in right input order
      ["b", null, "q"],
    ],
  );
});

Deno.test("def2 join: key matching is typed no-coercion over canonical cells", () => {
  const L = table([
    { header: "id", type: { kind: "int64" } },
    { header: "v", type: { kind: "text" } },
  ], [
    ["5", "left"],
    ["-3", "neg"],
  ]);
  const sameInt64 = table([
    { header: "id", type: { kind: "int64" } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["5", "match"],
  ]);
  assertEquals(
    canonical(joinTables(L, sameInt64, { kind: "inner", keys: [{ left: "c1", right: "c1" }] })).table.rows,
    [["5", "left", "match"]],
  );
  // int64 "5" and decimal(0) "5" are numerically equal but typed differently:
  // join keys must declare the identical type, so this fails up front.
  const decZero = table([
    { header: "id", type: { kind: "decimal", scale: 0 } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["5", "dec"],
  ]);
  throwsCode(
    () => joinTables(L, decZero, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }),
    "table_type_mismatch",
  );
  // decimal scale must agree too: (2) vs (1) is a mismatch even for "1.50"/"1.5".
  const dec2 = table([
    { header: "id", type: { kind: "decimal", scale: 2 } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["1.50", "two"],
  ]);
  const dec1 = table([
    { header: "id", type: { kind: "decimal", scale: 1 } },
    { header: "v", type: { kind: "text" } },
  ], [
    ["1.5", "one"],
  ]);
  throwsCode(
    () => joinTables(dec2, dec1, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }),
    "table_type_mismatch",
  );
  // Boolean keys join by boolean equality, never by truthiness.
  const bools = table([
    { header: "b", type: { kind: "boolean" } },
    { header: "v", type: { kind: "text" } },
  ], [
    [true, "t1"],
    [false, "f1"],
    [null, "n1"],
  ]);
  const boolR = table([
    { header: "b", type: { kind: "boolean" } },
    { header: "w", type: { kind: "text" } },
  ], [
    [true, "t2"],
    [null, "n2"],
  ]);
  assertEquals(
    canonical(joinTables(bools, boolR, { kind: "full", keys: [{ left: "c1", right: "c1" }] })).table.rows,
    [
      [true, "t1", "t2"],
      [false, "f1", null],
      [null, "n1", null],
      [null, null, "n2"],
    ],
  );
});

Deno.test("def2 join: empty and single-column sides stay canonical", () => {
  const empty = table([{ header: "k", type: { kind: "text" } }], []);
  const one = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], [
    ["a", "p"],
  ]);
  assertEquals(canonical(joinTables(empty, one, { kind: "right", keys: [{ left: "c1", right: "c1" }] })).table.rows, [["a", "p"]]);
  assertEquals(canonical(joinTables(empty, one, { kind: "inner", keys: [{ left: "c1", right: "c1" }] })).table.rows, []);
  // Left join against an empty right side: every left row stays, and the right
  // key column (the only right column) is dropped from the output width.
  const leftOut = canonical(joinTables(one, empty, { kind: "left", keys: [{ left: "c1", right: "c1" }] })).table;
  assertEquals(leftOut.columns.map((column) => column.header), ["k", "w"]);
  assertEquals(leftOut.rows, [["a", "p"]]);
  // Pure-key right side (no payload columns): the output is the left columns
  // only, with unmatched right keys coalesced into the key slot.
  const pureKey = table([{ header: "k", type: { kind: "text" } }], [["b"]]);
  const pureOut = canonical(joinTables(one, pureKey, { kind: "full", keys: [{ left: "c1", right: "c1" }] })).table;
  assertEquals(pureOut.columns.map((column) => column.header), ["k", "w"]);
  assertEquals(pureOut.rows, [
    ["a", "p"],
    ["b", null],
  ]);
});

Deno.test("def2 join: localeProfile and headers flow from the inputs into the output", () => {
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
  const out = canonical(joinTables(de, en, { kind: "inner", keys: [{ left: "c1", right: "c1" }] })).table;
  assertEquals(out.localeProfile, "de-DE-v1"); // left table's profile wins
  assertEquals(out.columns.map((column) => column.header), ["k", "Betrag", "label"]);
  assertEquals(out.columns[1].type, { kind: "decimal", scale: 2 });
  assertEquals(out.rows, [["x", "1.25", "hello"]]);
});

Deno.test("def2 join: work units equal input row passes plus emitted rows", () => {
  // Charge model: one unit per left row key pass, one per right row key pass
  // (index build), one per emitted row. Kinds differ only in emissions.
  assertEquals(joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }).workUnits, 11); // 4+3+4
  assertEquals(joinTables(LEFT, RIGHT, { kind: "left", keys: [{ left: "c1", right: "c1" }] }).workUnits, 13); // +2 left lones
  assertEquals(joinTables(LEFT, RIGHT, { kind: "right", keys: [{ left: "c1", right: "c1" }] }).workUnits, 12); // +5 right emissions
  assertEquals(joinTables(LEFT, RIGHT, { kind: "full", keys: [{ left: "c1", right: "c1" }] }).workUnits, 14); // +7 emissions
  const noMatchL = table([{ header: "k", type: { kind: "text" } }], [["a"], ["b"]]);
  const noMatchR = table([{ header: "k", type: { kind: "text" } }], [["c"], ["d"], ["e"]]);
  const emptyJoin = joinTables(noMatchL, noMatchR, { kind: "inner", keys: [{ left: "c1", right: "c1" }] });
  assertEquals(emptyJoin.workUnits, 5); // 2 + 3 + 0 emissions
  assertEquals(emptyJoin.table.rows, []);
});

Deno.test("def2 join: request shapes are exact and errors carry stable codes", () => {
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "outer", keys: joinRequest.keys }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [] }), "table_bad_request");
  throwsCode(
    () => joinTables(LEFT, RIGHT, { kind: "inner", keys: Array.from({ length: 9 }, () => ({ left: "c1", right: "c1" })) }),
    "table_bad_request",
  );
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c9", right: "c1" }] }), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c1", right: "c9" }] }), "table_unknown_column");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c1" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: 1, right: "c1" }] }), "table_bad_request");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c1", right: "c1", extra: true }] }), "table_unknown_field");
  throwsCode(() => joinTables(LEFT, RIGHT, { kind: "inner", keys: [{ left: "c1", right: "c1" }], extra: 1 }), "table_unknown_field");
  throwsCode(() => joinTables(LEFT, null, joinRequest), "table_bad_request"); // assertCanonicalTable rejects null input
  // Inputs are strict canonical tables: non-array rows are rejected by the core.
  const broken = { version: TABLE_VERSION, localeProfile: "canonical-v1", columns: [{ id: "c1", header: "k", type: { kind: "text" } }], rows: [{ c1: "x" }] };
  throwsCode(() => joinTables(broken, RIGHT, joinRequest), "table_bad_request");
});

// ---------------------------------------------------------------------------
// Join bounds — exact and +1 at the real strict-core ceilings
// ---------------------------------------------------------------------------

Deno.test("def2 join: output row bound accepts exactly maxRows and fails one past it", () => {
  const L = table([{ header: "k", type: { kind: "text" } }], new Array(100).fill(["a"]));
  const R1000 = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], new Array(1000).fill(["a", "p"]));
  const exact = joinTables(L, R1000, { kind: "inner", keys: [{ left: "c1", right: "c1" }] });
  assertEquals(exact.table.rows.length, TABLE_LIMITS.maxRows); // 100 × 1000
  canonical(exact);
  const R1001 = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "text" } },
  ], new Array(1001).fill(["a", "p"]));
  throwsCode(
    () => joinTables(L, R1001, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }),
    "table_row_bound",
  );
});

Deno.test("def2 join: output cell bound accepts exactly maxCells and fails one past it", () => {
  // Output width 16: left 15 columns (key + 14 int64) + right 1 non-key.
  const makeL = (rows) => table(
    [{ header: "k", type: { kind: "text" } }, ...new Array(14).fill({ header: "z", type: { kind: "int64" } })],
    new Array(rows).fill(["a", ...new Array(14).fill("0")]),
  );
  const R = table([
    { header: "k", type: { kind: "text" } },
    { header: "w", type: { kind: "int64" } },
  ], [["a", "0"]]);
  // 62,500 rows × 16 columns = exactly 1,000,000 cells.
  assertEquals(TABLE_LIMITS.maxCells, 62_500 * 16);
  const exact = joinTables(makeL(62_500), R, { kind: "inner", keys: [{ left: "c1", right: "c1" }] });
  assertEquals(exact.table.rows.length, 62_500);
  canonical(exact);
  throwsCode(
    () => joinTables(makeL(62_501), R, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }),
    "table_cell_count_bound",
  );
});

Deno.test("def2 join: output bytes accept exactly maxOutputBytes and fail one row past it", () => {
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
  const oneOut = joinTables(one, R, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }).table;
  const prefix = utf8(JSON.stringify(oneOut)) - (rowBytes + 1); // strip the single row
  const maxRows = Math.floor((MAX_OUTPUT_BYTES - prefix) / (rowBytes + 1));
  assert(maxRows < TABLE_LIMITS.maxRows, "byte bound must trip before the row bound");
  const L = table([{ header: "k", type: { kind: "text" } }], new Array(maxRows).fill([key]));
  const exact = joinTables(L, R, { kind: "inner", keys: [{ left: "c1", right: "c1" }] });
  assertEquals(exact.table.rows.length, maxRows);
  assert(utf8(JSON.stringify(exact.table)) <= MAX_OUTPUT_BYTES);
  canonical(exact);
  const LOver = table([{ header: "k", type: { kind: "text" } }], new Array(maxRows + 1).fill([key]));
  throwsCode(
    () => joinTables(LOver, R, { kind: "inner", keys: [{ left: "c1", right: "c1" }] }),
    "table_output_bound",
  );
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
  categories: [{ value: "A" }, { value: "B" }],
  metrics: [
    { op: "sum", column: "c3" },
    { op: "count", column: "c3" },
    { op: "avg", column: "c3" },
    { op: "min", column: "c3" },
    { op: "max", column: "c3" },
  ],
};

Deno.test("def2 pivot: count/sum/avg/min/max over ordered categories with first-seen groups", () => {
  const out = canonical(pivotTable(PIVOT_DATA, pivotRequest)).table;
  assertEquals(out.columns.map((column) => column.header), [
    "region",
    "sum(qty) A", "sum(qty) B",
    "count(qty) A", "count(qty) B",
    "avg(qty) A", "avg(qty) B",
    "min(qty) A", "min(qty) B",
    "max(qty) A", "max(qty) B",
  ]);
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "int64" }, { kind: "int64" }, // sum keeps the int64 source type
    { kind: "int64" }, { kind: "int64" }, // count
    { kind: "decimal", scale: 6 }, { kind: "decimal", scale: 6 }, // avg of int64
    { kind: "int64" }, { kind: "int64" }, // min/max keep the source type
    { kind: "int64" }, { kind: "int64" },
  ]);
  assertEquals(out.rows, [
    // east A: sum 10, count 2, avg 5, min 4, max 6 | east B: 5/1/5/5/5
    ["east", "10", "5", "2", "1", "5.000000", "5.000000", "4", "5", "6", "5"],
    ["west", "10", "1", "2", "1", "5.000000", "1.000000", "2", "1", "8", "1"],
  ]);
  assertEquals(out.rows[0].length, out.columns.length); // rectangular arrays
});

Deno.test("def2 pivot: value columns follow the declared category order, not first-seen order", () => {
  const out = canonical(pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "B" }, { value: "A" }],
    metrics: [{ op: "sum", column: "c3" }],
  })).table;
  assertEquals(out.columns.map((column) => column.header), ["region", "sum(qty) B", "sum(qty) A"]);
  assertEquals(out.rows, [
    ["east", "5", "10"],
    ["west", "1", "10"],
  ]);
});

Deno.test("def2 pivot: row groups emit in first-seen data order and merge duplicates", () => {
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
    categories: [{ value: "A" }, { value: "B" }],
    metrics: [{ op: "sum", column: "c3" }],
  })).table;
  assertEquals(out.rows, [
    ["west", "10", "1"],
    ["east", "6", null],
  ]);
});

Deno.test("def2 pivot: missing buckets stay present — count 0, numeric aggregates null", () => {
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
    categories: [{ value: "A" }, { value: "B" }, { value: "C" }],
    metrics: [
      { op: "sum", column: "c3" },
      { op: "count", column: "c3" },
    ],
  })).table;
  assertEquals(out.rows, [
    ["north", "2", "3", null, "1", "1", "0"],
    ["south", "1", null, null, "1", "0", "0"],
  ]);
});

Deno.test("def2 pivot: null metric cells are skipped; COUNT counts non-null cells and COUNT(*) counts rows", () => {
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
    categories: [{ value: "A" }, { value: "B" }],
    metrics: [
      { op: "count", column: "c3" },
      { op: "count" },
      { op: "sum", column: "c3" },
      { op: "count", column: "c4" },
    ],
  })).table;
  assertEquals(out.columns.map((column) => column.header), [
    "g", "count(v) A", "count(v) B", "count A", "count B", "sum(v) A", "sum(v) B", "count(t) A", "count(t) B",
  ]);
  // Bucket A has 3 rows: one non-null v, two null v. COUNT(v)=1, COUNT(*)=3,
  // SUM(v)=1, COUNT(t)=2 (null t skipped). Bucket B is empty.
  assertEquals(out.rows, [["g1", "1", "0", "3", "0", "1", null, "2", "0"]]);
});

Deno.test("def2 pivot: decimal sums and averages stay exact at the source scale", () => {
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
    categories: [{ value: "A" }, { value: "B" }],
    metrics: [
      { op: "sum", column: "c3" },
      { op: "avg", column: "c3" },
    ],
  })).table;
  assertEquals(out.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "decimal", scale: 2 }, { kind: "decimal", scale: 2 }, // sum
    { kind: "decimal", scale: 2 }, { kind: "decimal", scale: 2 }, // avg at source scale
  ]);
  assertEquals(out.rows, [
    ["g1", "5.10", null, "1.70", null], // (1.25+3.75+0.10)=5.10; 5.10/3=1.70 exactly
    ["g2", "7.00", "0.01", "7.00", "0.01"],
  ]);
});

Deno.test("def2 pivot: int64 averages are decimal scale 6 half-even via BigInt", () => {
  const average = (rows) => canonical(pivotTable(table([
    { header: "c", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], rows.map((n) => ["A", n])), {
    rowGroupBy: ["c1"],
    pivotColumn: "c1",
    categories: [{ value: "A" }],
    metrics: [{ op: "avg", column: "c2" }],
  })).table.rows[0][1];
  assertEquals(average(["1", "2"]), "1.500000"); // exact half at scale 6
  assertEquals(average(["1", "2", "3"]), "2.000000");
  assertEquals(average(["1", "2", "4"]), "2.333333"); // 7/3 truncation to scale 6
  // Half-even rounding of the cents tie: (0.01+0.04)/2 = 0.025 -> 0.02 (even), not 0.03.
  const cents = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "amt", type: { kind: "decimal", scale: 2 } },
  ], [
    ["g1", "A", "0.01"],
    ["g1", "A", "0.04"],
  ]);
  const tie = canonical(pivotTable(cents, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A" }], metrics: [{ op: "avg", column: "c3" }],
  })).table.rows[0][1];
  assertEquals(tie, "0.02");
});

Deno.test("def2 pivot: min/max order text by code points and skip null cells", () => {
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
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A" }],
    metrics: [
      { op: "min", column: "c3" },
      { op: "max", column: "c3" },
      { op: "count", column: "c3" },
    ],
  })).table;
  assertEquals(out.rows, [["g1", "a", "b", "3"]]);
  // Date cells order canonically too.
  const dates = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
    { header: "d", type: { kind: "date" } },
  ], [
    ["g1", "A", "2026-01-15"],
    ["g1", "A", "2025-12-31"],
  ]);
  const dateOut = canonical(pivotTable(dates, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A" }],
    metrics: [{ op: "min", column: "c3" }, { op: "max", column: "c3" }],
  })).table;
  assertEquals(dateOut.rows, [["g1", "2025-12-31", "2026-01-15"]]);
  assertEquals(dateOut.columns[1].type, { kind: "date" });
});

Deno.test("def2 pivot: sum overflow on int64 fails the whole job exactly", () => {
  const data = table([
    { header: "c", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["A", "9223372036854775807"],
    ["A", "1"],
  ]);
  throwsCode(() => pivotTable(data, {
    rowGroupBy: ["c1"], pivotColumn: "c1", categories: [{ value: "A" }], metrics: [{ op: "sum", column: "c2" }],
  }), "table_numeric_overflow");
});

Deno.test("def2 pivot: custom metric and category headers name the value columns", () => {
  const out = canonical(pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "A", header: "Alpha" }, { value: "B" }],
    metrics: [{ op: "sum", column: "c3", header: "Volume" }],
  })).table;
  assertEquals(out.columns.map((column) => column.header), ["region", "Volume Alpha", "Volume B"]);
});

Deno.test("def2 pivot: outputs stay canonical for empty inputs and null group cells", () => {
  const empty = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
  ], []);
  const out = canonical(pivotTable(empty, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A" }],
    metrics: [{ op: "count" }],
  })).table;
  assertEquals(out.columns.length, 2);
  assertEquals(out.rows, []);
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
    categories: [{ value: "A" }],
    metrics: [{ op: "sum", column: "c3" }],
  })).table;
  assertEquals(grouped.rows, [[null, "3"], ["g1", "5"]]); // null groups group together
});

Deno.test("def2 pivot: unknown or null category values fail the whole job", () => {
  throwsCode(() => pivotTable(PIVOT_DATA, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "Z" }],
    metrics: [{ op: "count" }],
  }), "table_category_unknown");
  const nullCell = table([
    { header: "g", type: { kind: "text" } },
    { header: "c", type: { kind: "text" } },
  ], [
    ["g1", null],
  ]);
  throwsCode(() => pivotTable(nullCell, {
    rowGroupBy: ["c1"], pivotColumn: "c2",
    categories: [{ value: "A" }],
    metrics: [{ op: "count" }],
  }), "table_category_unknown");
});

Deno.test("def2 pivot: work units equal rows x (1 + metrics) plus emitted groups", () => {
  // 6 rows × (1 + 5 metrics) + 2 groups emitted = 38.
  assertEquals(pivotTable(PIVOT_DATA, pivotRequest).workUnits, 38);
});

Deno.test("def2 pivot: request shapes are exact and errors carry stable codes", () => {
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, extra: 1 }), "table_unknown_field");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [{ op: "mean", column: "c3" }] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [{ op: "sum" }] }), "table_bad_request"); // sum needs a column
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [{ op: "avg", column: "c1" }] }), "table_type_mismatch"); // text column
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [{ op: "sum", column: "c9" }] }), "table_unknown_column");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, rowGroupBy: ["c9"] }), "table_unknown_column");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, rowGroupBy: ["c1", "c1"] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, rowGroupBy: [] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, rowGroupBy: Array.from({ length: 9 }, () => "c1") }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: [] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, metrics: Array.from({ length: 17 }, () => ({ op: "count" })) }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, categories: [] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, categories: Array.from({ length: 129 }, (_, i) => ({ value: `v${i}` })) }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, categories: [{ value: "A" }, { value: "A" }] }), "table_bad_request");
  throwsCode(() => pivotTable(PIVOT_DATA, { ...pivotRequest, pivotColumn: "c9" }), "table_unknown_column");
  // Boolean columns cannot be min/max ordered, and sum/avg need numeric sources.
  const bools = table([
    { header: "b", type: { kind: "boolean" } },
    { header: "c", type: { kind: "text" } },
  ], [[true, "x"]]);
  throwsCode(() => pivotTable(bools, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "x" }], metrics: [{ op: "min", column: "c1" }],
  }), "table_type_mismatch");
  throwsCode(() => pivotTable(bools, {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "x" }], metrics: [{ op: "max", column: "c1" }],
  }), "table_type_mismatch");
});

Deno.test("def2 pivot: category values must be valid canonical cells for the pivot column type", () => {
  // int64 pivot column: canonical integer strings only.
  const ints = table([
    { header: "g", type: { kind: "text" } },
    { header: "n", type: { kind: "int64" } },
  ], [
    ["g1", "5"],
  ]);
  const base = { rowGroupBy: ["c1"], pivotColumn: "c2", metrics: [{ op: "count" }] };
  assertEquals(canonical(pivotTable(ints, { ...base, categories: [{ value: "5" }] })).table.rows, [["g1", "1"]]);
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: "05" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: null }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(ints, { ...base, categories: [{ value: "99999999999999999999999" }] }), "table_type_mismatch");
  // decimal(2) pivot column: canonical two-scale strings.
  const decs = table([
    { header: "g", type: { kind: "text" } },
    { header: "d", type: { kind: "decimal", scale: 2 } },
  ], [
    ["g1", "1.50"],
  ]);
  const decBase = { rowGroupBy: ["c1"], pivotColumn: "c2", metrics: [{ op: "count" }] };
  assertEquals(canonical(pivotTable(decs, { ...decBase, categories: [{ value: "1.50" }] })).table.rows, [["g1", "1"]]);
  throwsCode(() => pivotTable(decs, { ...decBase, categories: [{ value: "1.5" }] }), "table_type_mismatch");
  throwsCode(() => pivotTable(decs, { ...decBase, categories: [{ value: "1.500" }] }), "table_type_mismatch");
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
    categories: [{ value: true }, { value: false }],
    metrics: [{ op: "count" }],
  })).table;
  assertEquals(flagOut.rows, [["g1", "1", "1"], ["g2", "1", "0"]]);
});

// ---------------------------------------------------------------------------
// Pivot bounds — exact and +1 at the real strict-core ceilings
// ---------------------------------------------------------------------------

Deno.test("def2 pivot: row-group bound accepts exactly maxGroups and fails one past it", () => {
  const make = (groups) => {
    const rows = [];
    for (let i = 0; i < groups; i++) rows.push([`g${i}`, "A"]);
    return table([
      { header: "g", type: { kind: "text" } },
      { header: "c", type: { kind: "text" } },
    ], rows);
  };
  const exact = pivotTable(make(TABLE_LIMITS.maxGroups), {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A" }], metrics: [{ op: "count" }],
  });
  assertEquals(exact.table.rows.length, TABLE_LIMITS.maxGroups);
  canonical(exact);
  throwsCode(() => pivotTable(make(TABLE_LIMITS.maxGroups + 1), {
    rowGroupBy: ["c1"], pivotColumn: "c2", categories: [{ value: "A" }], metrics: [{ op: "count" }],
  }), "table_group_bound");
});

Deno.test("def2 pivot: output width accepts maxColumns and fails one past it", () => {
  // 8 group columns + 127 categories × 8 metrics = 1,024 output columns (exact).
  const cats = Array.from({ length: 127 }, (_, i) => ({ value: `v${i}` }));
  const wide = (categoryCount) => {
    const rows = [["g", "g", "g", "g", "g", "g", "g", "g", "v0"]];
    return table(
      [...new Array(8).fill({ header: "g", type: { kind: "text" } }), { header: "c", type: { kind: "text" } }],
      rows,
    );
  };
  const request = (count) => ({
    rowGroupBy: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"],
    pivotColumn: "c9",
    categories: Array.from({ length: count }, (_, i) => ({ value: `v${i}` })),
    metrics: Array.from({ length: 8 }, () => ({ op: "count" })),
  });
  const exact = pivotTable(wide(127), request(127));
  assertEquals(exact.table.columns.length, 8 + 127 * 8);
  assertEquals(exact.table.columns.length, TABLE_LIMITS.maxColumns);
  canonical(exact);
  throwsCode(() => pivotTable(wide(128), request(128)), "table_column_bound"); // 8 + 128×8 = 1032
});

Deno.test("def2 pivot: output cells enforce maxCells during emission", () => {
  // 16 categories × 16 metrics = 256 value columns + 1 group column = 257
  // wide. 3,891 groups × 257 = 999,987 cells fit exactly; the next group
  // trips the cell cap while the row cap (100k) and group cap (4096) hold.
  const categories = [];
  for (let i = 0; i < 16; i++) categories.push({ value: `v${i}` });
  const metrics = Array.from({ length: 16 }, () => ({ op: "count" }));
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
