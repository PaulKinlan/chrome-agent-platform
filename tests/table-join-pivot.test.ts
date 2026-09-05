// @ts-nocheck
// tests/table-join-pivot.test.ts — chrome-agent-platform-def.2 KATs
// (CAP-FB-20260822-SPREADSHEET-TOOLKIT-01, def alignment).
//
// Coverage (per the def.2 acceptance criteria):
//   * joins: many-to-many Cartesian completion, composite and null keys,
//     stable left/right-major ordering, deterministic reruns, id-collision
//     renaming, typed no-coercion matching, strict closed inputs
//   * pivots: explicit ordered categories, unknown/null category failure,
//     missing buckets, stable first-seen group order, count/sum/avg/min/max,
//     the arithmetic-adapter seam
//   * bounds: width (join keys, categories, metrics, row groups), input
//     cell/row caps, exact output-byte preflight, and work-budget — all at
//     the exact limit (passes) and +1 past it (fails whole job)

import { assertEquals } from "jsr:@std/assert@1";
import {
  joinTables,
  pivotTable,
  validateTable,
  TableOpError,
} from "../extension/lib/table-join-pivot.js";

const C = (id, type, header = id) => ({ id, type, header });
const T = (columns, rows, localeProfile = "en-US") => ({
  version: "cap.table/1",
  localeProfile,
  columns,
  rows,
});

/** Run fn and return the TableOpError code, or null when it does not throw. */
function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof TableOpError) return error.code;
    throw error;
  }
}
const rowBytes = (row) => JSON.stringify(row).length;
const bytesOf = (rows) => rows.reduce((sum, r) => sum + rowBytes(r), 0);

// ---------------------------------------------------------------------------
// Joins — determinism, ordering, duplicates, outer padding, id renaming
// ---------------------------------------------------------------------------

Deno.test("def2 join: inner/left/right/full over many-to-many keys in exact stable order", () => {
  const L = T(
    [C("k", "string"), C("v", "number")],
    [
      ["x", 1],
      ["x", 2],
      ["y", 3],
      ["z", 4],
    ],
    "en-GB",
  );
  const R = T(
    [C("k", "string"), C("w", "string")],
    [
      ["x", "p"],
      ["x", "q"],
      ["w", "r"],
    ],
    "fr-FR",
  );
  const cols = [C("k", "string"), C("v", "number"), C("k.r", "string", "k"), C("w", "string")];
  const joinOpts = { leftKeys: ["k"], rightKeys: ["k"] };

  // inner: left-major; the right side iterates in right input order per left row.
  assertEquals(joinTables(L, R, { kind: "inner", ...joinOpts }), T(cols, [
    ["x", 1, "x", "p"],
    ["x", 1, "x", "q"],
    ["x", 2, "x", "p"],
    ["x", 2, "x", "q"],
  ], "en-GB"));

  // left: inner plus unmatched left rows null-padded in place.
  assertEquals(joinTables(L, R, { kind: "left", ...joinOpts }), T(cols, [
    ["x", 1, "x", "p"],
    ["x", 1, "x", "q"],
    ["x", 2, "x", "p"],
    ["x", 2, "x", "q"],
    ["y", 3, null, null],
    ["z", 4, null, null],
  ], "en-GB"));

  // right: right-major; each right row precedes its left matches (left input order).
  assertEquals(joinTables(L, R, { kind: "right", ...joinOpts }), T(cols, [
    ["x", 1, "x", "p"],
    ["x", 2, "x", "p"],
    ["x", 1, "x", "q"],
    ["x", 2, "x", "q"],
    [null, null, "w", "r"],
  ], "en-GB"));

  // full: left-major emission (pairs + unmatched left) then unmatched right rows.
  assertEquals(joinTables(L, R, { kind: "full", ...joinOpts }), T(cols, [
    ["x", 1, "x", "p"],
    ["x", 1, "x", "q"],
    ["x", 2, "x", "p"],
    ["x", 2, "x", "q"],
    ["y", 3, null, null],
    ["z", 4, null, null],
    [null, null, "w", "r"],
  ], "en-GB"));

  // 'inner' is the default kind; identical calls produce identical results.
  const first = joinTables(L, R, joinOpts);
  assertEquals(joinTables(L, R, joinOpts), first);
});

Deno.test("def2 join: null keys never match — dropped, padded, or trailed per kind", () => {
  const L = T([C("k", "string"), C("v", "number")], [
    ["x", 1],
    [null, 2],
  ]);
  const R = T([C("k", "string"), C("w", "string")], [
    ["x", "p"],
    [null, "q"],
  ]);
  const opts = { leftKeys: ["k"], rightKeys: ["k"] };
  const cols = [C("k", "string"), C("v", "number"), C("k.r", "string", "k"), C("w", "string")];

  assertEquals(joinTables(L, R, opts), T(cols, [["x", 1, "x", "p"]]));
  assertEquals(joinTables(L, R, { kind: "left", ...opts }), T(cols, [
    ["x", 1, "x", "p"],
    [null, 2, null, null],
  ]));
  assertEquals(joinTables(L, R, { kind: "right", ...opts }), T(cols, [
    ["x", 1, "x", "p"],
    [null, null, null, "q"],
  ]));
  assertEquals(joinTables(L, R, { kind: "full", ...opts }), T(cols, [
    ["x", 1, "x", "p"],
    [null, 2, null, null],
    [null, null, null, "q"],
  ]));
});

Deno.test("def2 join: composite key of 8 columns matches exactly; 9 keys fail whole job", () => {
  const keyCols = Array.from({ length: 8 }, (_, i) => C(`k${i}`, "string"));
  const L = T([...keyCols, C("v", "number")], [[...Array.from({ length: 8 }, (_, i) => `a${i}`), 1]]);
  const R = T([...keyCols.map((c) => ({ ...c })), C("w", "string")], [
    [...Array.from({ length: 8 }, (_, i) => `a${i}`), "hit"],
  ]);
  const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
  const out = joinTables(L, R, { leftKeys: keys, rightKeys: keys });
  assertEquals(out.rows.length, 1);
  assertEquals(out.rows[0], [...Array.from({ length: 8 }, (_, i) => `a${i}`), 1, ...Array.from({ length: 8 }, (_, i) => `a${i}`), "hit"]);
  // right key columns all collide with left keys → all renamed deterministically
  assertEquals(out.columns.slice(9).map((c) => c.id), [...keys.map((k) => `${k}.r`), "w"]);

  const nine = [...keys, "k8"];
  assertEquals(codeOf(() => joinTables(L, R, { leftKeys: nine, rightKeys: nine })), "ERR_KEY_SPEC");
  assertEquals(codeOf(() => joinTables(L, R, { leftKeys: [], rightKeys: [] })), "ERR_KEY_SPEC");
});

Deno.test("def2 join: composite key with one null cell never matches; typed keys do not coerce", () => {
  const L = T([C("a", "string"), C("b", "number"), C("v", "number")], [
    ["x", 1, 10],
    ["x", null, 20],
  ]);
  const R = T([C("a", "string"), C("b", "number"), C("w", "string")], [
    ["x", 1, "p"],
  ]);
  const opts = { leftKeys: ["a", "b"], rightKeys: ["a", "b"] };
  const cols = [
    C("a", "string"),
    C("b", "number"),
    C("v", "number"),
    C("a.r", "string", "a"),
    C("b.r", "number", "b"),
    C("w", "string"),
  ];
  assertEquals(joinTables(L, R, opts), T(cols, [["x", 1, 10, "x", 1, "p"]]));

  // number keys match by value; string "1" never matches number 1.
  const NL = T([C("id", "number"), C("v", "number")], [[1, 10]]);
  const NR = T([C("id", "number"), C("w", "number")], [[1, 100]]);
  assertEquals(joinTables(NL, NR, { leftKeys: ["id"], rightKeys: ["id"] }).rows, [[1, 10, 1, 100]]);
  const SL = T([C("id", "string"), C("v", "number")], [["1", 10]]);
  const SR = T([C("id", "string"), C("w", "number")], [["2", 100]]);
  assertEquals(joinTables(SL, SR, { leftKeys: ["id"], rightKeys: ["id"] }).rows, []);
});

Deno.test("def2 join: closed inputs — kind, key spec, and key type mismatches fail whole job", () => {
  const L = T([C("k", "string"), C("v", "number")], [["x", 1]]);
  const R = T([C("k", "string"), C("w", "string")], [["x", "p"]]);
  const opts = { leftKeys: ["k"], rightKeys: ["k"] };
  assertEquals(codeOf(() => joinTables(L, R, { kind: "semi", ...opts })), "ERR_KEY_SPEC");
  assertEquals(codeOf(() => joinTables(L, R, { leftKeys: ["k"], rightKeys: ["k", "k"] })), "ERR_KEY_SPEC");
  assertEquals(codeOf(() => joinTables(L, R, { leftKeys: ["k"], rightKeys: ["nope"] })), "ERR_KEY_SPEC");
  assertEquals(codeOf(() => joinTables(L, R, { leftKeys: ["k", "k"], rightKeys: ["k", "k"] })), "ERR_KEY_SPEC");
  assertEquals(codeOf(() => joinTables(L, R, {})), "ERR_KEY_SPEC"); // no keys at all

  const RN = T([C("k", "number"), C("w", "number")], [[1, 100]]);
  assertEquals(codeOf(() => joinTables(L, RN, opts)), "ERR_KEY_SPEC"); // string vs number key
  assertEquals(codeOf(() => joinTables(L, R, { kind: "left", ...opts, extra: 1 })), "ERR_BOUNDS"); // unknown option
});

// ---------------------------------------------------------------------------
// Joins — table model validation and preflight bounds
// ---------------------------------------------------------------------------

Deno.test("def2 join: strict table model — shape, width, types fail closed", () => {
  const good = T([C("k", "string"), C("v", "number")], [["x", 1]]);
  assertEquals(codeOf(() => joinTables({ ...good, version: "cap.table/2" }, good, { leftKeys: ["k"], rightKeys: ["k"] })), "ERR_TABLE_SHAPE");
  assertEquals(codeOf(() => joinTables({ ...good, localeProfile: 7 }, good, { leftKeys: ["k"], rightKeys: ["k"] })), "ERR_TABLE_SHAPE");
  assertEquals(codeOf(() => joinTables({ ...good, columns: [] }, good, { leftKeys: ["k"], rightKeys: ["k"] })), "ERR_TABLE_SHAPE");
  assertEquals(
    codeOf(() =>
      joinTables(T([C("k", "string"), C("k", "string")], []), good, { leftKeys: ["k"], rightKeys: ["k"] })
    ),
    "ERR_TABLE_SHAPE",
  );
  assertEquals(
    codeOf(() => joinTables(T([C("", "string")], []), good, { leftKeys: ["k"], rightKeys: ["k"] })),
    "ERR_TABLE_SHAPE",
  );
  assertEquals(
    codeOf(() => joinTables(T([{ id: "k", type: "string", header: 9 }], []), good, { leftKeys: ["k"], rightKeys: ["k"] })),
    "ERR_TABLE_SHAPE",
  );
  assertEquals(
    codeOf(() => joinTables(T([C("k", "datetime")], []), good, { leftKeys: ["k"], rightKeys: ["k"] })),
    "ERR_TABLE_SHAPE",
  );
  const badRows = T([C("k", "string"), C("v", "number")], [["x"]]); // row width 1
  assertEquals(codeOf(() => joinTables(badRows, good, { leftKeys: ["k"], rightKeys: ["k"] })), "ERR_ROW_WIDTH");
  const badCell = T([C("k", "string"), C("v", "number")], [["x", "1"]]);
  assertEquals(codeOf(() => joinTables(badCell, good, { leftKeys: ["k"], rightKeys: ["k"] })), "ERR_CELL_TYPE");
  const nanCell = T([C("k", "string"), C("v", "number")], [["x", Number.NaN]]);
  assertEquals(codeOf(() => joinTables(nanCell, good, { leftKeys: ["k"], rightKeys: ["k"] })), "ERR_CELL_TYPE");
});

Deno.test("def2 join: input row and cell caps hold at the exact default limit and fail at +1", () => {
  const good = T([C("k", "string"), C("v", "number")], [["z", 1]]);
  const row1 = T([C("k", "string")], new Array(100000).fill(["a"]));
  const big = T([C("k", "string")], new Array(100001).fill(["a"]));
  assertEquals(validateTable(row1), { rows: 100000, cols: 1 });
  assertEquals(codeOf(() => validateTable(big)), "ERR_TABLE_TOO_LARGE");
  // 100,000 rows x 10 cols = exactly maxTableCells; an 11th column crosses it
  // (rows stay at the 100k limit, isolating the cell cap).
  const cellExact = T(
    Array.from({ length: 10 }, (_, i) => C(`c${i}`, "number")),
    new Array(100000).fill(new Array(10).fill(null)),
  );
  assertEquals(validateTable(cellExact), { rows: 100000, cols: 10 });
  const cellOver = T(
    Array.from({ length: 11 }, (_, i) => C(`c${i}`, "number")),
    new Array(100000).fill(new Array(11).fill(null)),
  );
  assertEquals(codeOf(() => validateTable(cellOver)), "ERR_TABLE_TOO_LARGE");
  // joined output respects the same caps through the same validator.
  assertEquals(joinTables(row1, good, { leftKeys: ["k"], rightKeys: ["k"] }).rows.length, 0);
});

Deno.test("def2 join: exact output-byte preflight — fits at the limit, fails one byte past it", () => {
  const L = T([C("k", "string"), C("v", "number")], [
    ["x", 1],
    ["x", 2],
    ["y", 3],
    ["z", 4],
  ]);
  const R = T([C("k", "string"), C("w", "string")], [
    ["x", "p"],
    ["x", "q"],
    ["w", "r"],
  ]);
  const expectedRows = [
    ["x", 1, "x", "p"],
    ["x", 1, "x", "q"],
    ["x", 2, "x", "p"],
    ["x", 2, "x", "q"],
  ];
  const total = bytesOf(expectedRows);
  const run = (maxOutputBytes) =>
    joinTables(L, R, { leftKeys: ["k"], rightKeys: ["k"], bounds: { maxOutputBytes } });
  assertEquals(run(total).rows.length, 4); // exact limit fits
  assertEquals(codeOf(() => run(total - 1)), "ERR_OUTPUT_LIMIT"); // +1 byte fails whole job
});

Deno.test("def2 join: default 8MiB output bound trips on a real left join before publication", () => {
  const filler = "x".repeat(80); // each emitted row stringifies to 96 bytes
  const bigL = T([C("k", "string"), C("v", "number")], new Array(100000).fill([filler, 1]));
  const emptyR = T([C("k", "string"), C("w", "string")], []);
  const err = (() => {
    try {
      joinTables(bigL, emptyR, { kind: "left", leftKeys: ["k"], rightKeys: ["k"] });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assertEquals(err instanceof TableOpError, true);
  assertEquals(err.code, "ERR_OUTPUT_LIMIT");
});

Deno.test("def2 join: coarse work budget holds at the exact unit count and fails at -1", () => {
  const L = T([C("k", "string"), C("v", "number")], [
    ["a", 1],
    ["b", 2],
  ]);
  const R = T([C("k", "string"), C("w", "number")], [
    ["c", 1],
    ["d", 2],
    ["e", 3],
  ]);
  // No matches: units = validation (2+3) + index build (3) + probe pass (2) = 10.
  const run = (maxWorkUnits) =>
    joinTables(L, R, { leftKeys: ["k"], rightKeys: ["k"], bounds: { maxWorkUnits } });
  assertEquals(run(10).rows.length, 0); // exact budget fits
  assertEquals(codeOf(() => run(9)), "ERR_WORK_LIMIT"); // one fewer unit fails whole job
});

// ---------------------------------------------------------------------------
// Pivots — ordered categories, aggregates, missing buckets, group order
// ---------------------------------------------------------------------------

const PIVOT_DATA = T([C("region", "string"), C("product", "string"), C("qty", "number")], [
  ["east", "A", 4],
  ["east", "A", 6],
  ["east", "B", 5],
  ["west", "A", 2],
  ["west", "A", 8],
  ["west", "B", 1],
]);

Deno.test("def2 pivot: sum/count/avg/min/max over explicit categories, stable first-seen groups", () => {
  const cats = ["A", "B"];
  const metrics = ["sum", "count", "avg", "min", "max"].map((agg) => ({ column: "qty", agg }));
  const out = pivotTable(PIVOT_DATA, { rowIds: ["region"], categoryId: "product", categories: cats, metrics });
  const valueCols = [];
  for (const metric of metrics) {
    for (let j = 0; j < cats.length; j++) {
      valueCols.push(C(`qty.${metric.agg}#${j}`, "number", `${metric.agg}(qty) ${cats[j]}`));
    }
  }
  assertEquals(out, T([C("region", "string"), ...valueCols], [
    ["east", 10, 5, 2, 1, 5, 5, 4, 5, 6, 5],
    ["west", 10, 1, 2, 1, 5, 1, 2, 1, 8, 1],
  ]));
});

Deno.test("def2 pivot: value columns follow the explicit category order, not first-seen data order", () => {
  const out = pivotTable(PIVOT_DATA, {
    rowIds: ["region"],
    categoryId: "product",
    categories: ["B", "A"],
    metrics: [{ column: "qty", agg: "sum" }],
  });
  assertEquals(out.columns.map((c) => c.id), ["region", "qty.sum#0", "qty.sum#1"]);
  assertEquals(out.rows, [
    ["east", 5, 10], // B bucket first because the list says so
    ["west", 1, 10],
  ]);
});

Deno.test("def2 pivot: row groups emit in first-seen data order", () => {
  const data = T([C("region", "string"), C("product", "string"), C("qty", "number")], [
    ["west", "A", 2],
    ["west", "B", 1],
    ["east", "A", 6],
    ["west", "A", 8],
  ]);
  const out = pivotTable(data, {
    rowIds: ["region"],
    categoryId: "product",
    categories: ["A", "B"],
    metrics: [{ column: "qty", agg: "sum" }],
  });
  assertEquals(out.rows, [
    ["west", 10, 1],
    ["east", 6, null],
  ]);
});

Deno.test("def2 pivot: missing buckets stay present — count 0, numeric aggs null", () => {
  const data = T([C("region", "string"), C("product", "string"), C("qty", "number")], [
    ["north", "A", 2],
    ["north", "B", 3],
    ["south", "A", 1],
  ]);
  const out = pivotTable(data, {
    rowIds: ["region"],
    categoryId: "product",
    categories: ["A", "B", "C"],
    metrics: [
      { column: "qty", agg: "sum" },
      { column: "qty", agg: "count" },
    ],
  });
  assertEquals(out.columns.map((c) => c.id), [
    "region",
    "qty.sum#0",
    "qty.sum#1",
    "qty.sum#2",
    "qty.count#0",
    "qty.count#1",
    "qty.count#2",
  ]);
  assertEquals(out.rows, [
    ["north", 2, 3, null, 1, 1, 0],
    ["south", 1, null, null, 1, 0, 0],
  ]);
});

Deno.test("def2 pivot: null metric cells are skipped; empty buckets count 0 and aggregate to null", () => {
  const data = T([C("g", "string"), C("c", "string"), C("v", "number")], [
    ["g1", "A", 1],
    ["g1", "A", null],
  ]);
  const out = pivotTable(data, {
    rowIds: ["g"],
    categoryId: "c",
    categories: ["A", "B"],
    metrics: [
      { column: "v", agg: "sum" },
      { column: "v", agg: "count" },
      { column: "v", agg: "avg" },
    ],
  });
  assertEquals(out.rows, [["g1", 1, null, 1, 0, 1, null]]);
});

Deno.test("def2 pivot: unknown and null category cells fail the whole job; matching is typed", () => {
  const base = { rowIds: ["region"], categoryId: "product", categories: ["A", "B"], metrics: [{ column: "qty", agg: "sum" }] };
  const withZ = T([C("region", "string"), C("product", "string"), C("qty", "number")], [
    ["north", "Z", 9],
  ]);
  assertEquals(codeOf(() => pivotTable(withZ, base)), "ERR_CATEGORY_UNKNOWN");
  const withNullCat = T([C("region", "string"), C("product", "string"), C("qty", "number")], [
    ["north", null, 9],
  ]);
  assertEquals(codeOf(() => pivotTable(withNullCat, base)), "ERR_CATEGORY_UNKNOWN");
  // number-typed category column: a valid number cell outside the ordered list fails
  const tiers = T([C("region", "string"), C("tier", "number"), C("qty", "number")], [
    ["north", 2, 9],
  ]);
  assertEquals(
    codeOf(() =>
      pivotTable(tiers, { rowIds: ["region"], categoryId: "tier", categories: [1], metrics: [{ column: "qty", agg: "sum" }] })
    ),
    "ERR_CATEGORY_UNKNOWN",
  );
});

Deno.test("def2 pivot: count works on string columns; numeric aggs require number columns", () => {
  const data = T([C("region", "string"), C("product", "string")], [
    ["north", "A"],
    ["north", "B"],
  ]);
  const out = pivotTable(data, {
    rowIds: ["region"],
    categoryId: "product",
    categories: ["A", "B"],
    metrics: [{ column: "product", agg: "count" }],
  });
  assertEquals(out.rows, [["north", 1, 1]]);
  assertEquals(
    codeOf(() =>
      pivotTable(data, { rowIds: ["region"], categoryId: "product", categories: ["A"], metrics: [{ column: "product", agg: "sum" }] })
    ),
    "ERR_PIVOT_SPEC",
  );
});

Deno.test("def2 pivot: null group key cells group together as one row", () => {
  const data = T([C("g", "string"), C("c", "string"), C("v", "number")], [
    [null, "A", 1],
    [null, "A", 2],
    ["g2", "A", 5],
  ]);
  const out = pivotTable(data, { rowIds: ["g"], categoryId: "c", categories: ["A"], metrics: [{ column: "v", agg: "sum" }] });
  assertEquals(out.rows, [
    [null, 3],
    ["g2", 5],
  ]);
});

// ---------------------------------------------------------------------------
// Pivots — width, groups, output bytes, work, arithmetic adapter
// ---------------------------------------------------------------------------

Deno.test("def2 pivot: category width holds at 128 and fails at 129; metric width at 16/17", () => {
  const data = T([C("region", "string"), C("product", "string"), C("qty", "number")], [
    ["north", "c0", 1],
  ]);
  const cats128 = Array.from({ length: 128 }, (_, i) => `c${i}`);
  const ok = pivotTable(data, { rowIds: ["region"], categoryId: "product", categories: cats128, metrics: [{ column: "qty", agg: "count" }] });
  assertEquals(ok.rows, [["north", ...Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0))]]);
  const cats129 = [...cats128, "c128"];
  assertEquals(
    codeOf(() => pivotTable(data, { rowIds: ["region"], categoryId: "product", categories: cats129, metrics: [{ column: "qty", agg: "count" }] })),
    "ERR_PIVOT_WIDTH",
  );

  // 16 metrics fit (4 number columns × sum/avg/min/max); a 17th fails before scanning.
  const wide = T(
    [C("region", "string"), C("product", "string"), ...Array.from({ length: 4 }, (_, i) => C(`n${i}`, "number"))],
    [["north", "A", 1, 2, 3, 4]],
  );
  const numAggs = ["sum", "avg", "min", "max"];
  const sixteen = Array.from({ length: 4 }, (_, i) =>
    numAggs.map((agg) => ({ column: `n${i}`, agg, id: `n${i}.${agg}` })),
  ).flat();
  assertEquals(pivotTable(wide, { rowIds: ["region"], categoryId: "product", categories: ["A"], metrics: sixteen }).rows, [
    ["north", 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4],
  ]);
  const seventeen = [...sixteen, { column: "n0", agg: "count", id: "n0.count" }];
  assertEquals(
    codeOf(() => pivotTable(wide, { rowIds: ["region"], categoryId: "product", categories: ["A"], metrics: seventeen })),
    "ERR_PIVOT_WIDTH",
  );
});

Deno.test("def2 pivot: row groups hold at 4096 and fail at 4097", () => {
  const many = T([C("g", "number"), C("c", "string"), C("v", "number")], [
    ...Array.from({ length: 4096 }, (_, i) => [i, "A", 1]),
  ]);
  const opts = { rowIds: ["g"], categoryId: "c", categories: ["A"], metrics: [{ column: "v", agg: "count" }] };
  assertEquals(pivotTable(many, opts).rows.length, 4096);
  const over = T([C("g", "number"), C("c", "string"), C("v", "number")], [
    ...Array.from({ length: 4097 }, (_, i) => [i, "A", 1]),
  ]);
  assertEquals(codeOf(() => pivotTable(over, opts)), "ERR_PIVOT_GROUPS");
});

Deno.test("def2 pivot: exact output-byte preflight fits at the limit and fails one byte past it", () => {
  const data = T([C("g", "string"), C("c", "string"), C("v", "number")], [
    ["g1", "A", 1],
    ["g1", "A", 2],
  ]);
  const opts = { rowIds: ["g"], categoryId: "c", categories: ["A"], metrics: [{ column: "v", agg: "sum" }] };
  const expectedRow = ["g1", 3];
  const total = bytesOf([expectedRow]);
  const run = (maxOutputBytes) => pivotTable(data, { ...opts, bounds: { maxOutputBytes } });
  assertEquals(run(total).rows, [expectedRow]);
  assertEquals(codeOf(() => run(total - 1)), "ERR_OUTPUT_LIMIT");
});

Deno.test("def2 pivot: coarse work budget holds at the exact unit count and fails at -1", () => {
  const data = T([C("g", "string"), C("c", "string"), C("v", "number")], [
    ["g1", "A", 1],
    ["g1", "A", 2],
    ["g1", "A", 3],
    ["g1", "A", 4],
  ]);
  // One group: units = validation (4) + scan (4) + emission (1) = 9.
  const opts = { rowIds: ["g"], categoryId: "c", categories: ["A"], metrics: [{ column: "v", agg: "sum" }] };
  const run = (maxWorkUnits) => pivotTable(data, { ...opts, bounds: { maxWorkUnits } });
  assertEquals(run(9).rows.length, 1);
  assertEquals(codeOf(() => run(8)), "ERR_WORK_LIMIT");
});

Deno.test("def2 pivot: the arithmetic adapter is injectable and its results are used", () => {
  const data = T([C("g", "string"), C("c", "string"), C("v", "number")], [
    ["g1", "A", 1],
    ["g1", "A", 2],
  ]);
  const opts = { rowIds: ["g"], categoryId: "c", categories: ["A"], metrics: [{ column: "v", agg: "sum" }] };
  const inflated = {
    id: "test+1000",
    add: (a, b) => a + b + 1000, // proves each fold goes through the adapter
    div: (a, b) => a / b,
    min: (a, b) => Math.min(a, b),
    max: (a, b) => Math.max(a, b),
  };
  assertEquals(pivotTable(data, { ...opts, arithmetic: inflated }).rows, [["g1", 1003]]);
  assertEquals(codeOf(() => pivotTable(data, { ...opts, arithmetic: { ...inflated, add: "nope" } })), "ERR_ARITHMETIC");
});

Deno.test("def2 pivot: non-finite aggregate results fail the whole job", () => {
  const data = T([C("g", "string"), C("c", "string"), C("v", "number")], [
    ["g1", "A", 1e308],
    ["g1", "A", 1e308],
  ]);
  assertEquals(
    codeOf(() => pivotTable(data, { rowIds: ["g"], categoryId: "c", categories: ["A"], metrics: [{ column: "v", agg: "sum" }] })),
    "ERR_AGG_RESULT",
  );
});

Deno.test("def2 pivot: closed spec — row ids, categories, metrics, and derived id collisions", () => {
  const data = PIVOT_DATA;
  const goodSpec = { rowIds: ["region"], categoryId: "product", categories: ["A"], metrics: [{ column: "qty", agg: "sum" }] };
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, rowIds: [] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, rowIds: ["region", "region"] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, rowIds: ["missing"] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, categoryId: "missing" })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, categories: [] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, categories: ["A", "A"] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, categories: [7] })), "ERR_PIVOT_SPEC"); // wrong type for a string column
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, categories: [null] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, metrics: [] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, metrics: [{ column: "missing", agg: "sum" }] })), "ERR_PIVOT_SPEC");
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, metrics: [{ column: "qty", agg: "median" }] })), "ERR_PIVOT_SPEC");
  // duplicate metric definitions share a derived output id
  assertEquals(
    codeOf(() =>
      pivotTable(data, { ...goodSpec, metrics: [{ column: "qty", agg: "sum" }, { column: "qty", agg: "sum" }] })
    ),
    "ERR_PIVOT_SPEC",
  );
  // a group column that collides with a derived value-column id
  const colliding = T([C("qty.sum#0", "string"), C("product", "string"), C("qty", "number")], [["g", "A", 1]]);
  assertEquals(
    codeOf(() =>
      pivotTable(colliding, { rowIds: ["qty.sum#0"], categoryId: "product", categories: ["A"], metrics: [{ column: "qty", agg: "sum" }] })
    ),
    "ERR_PIVOT_SPEC",
  );
  assertEquals(codeOf(() => pivotTable(data, { ...goodSpec, nope: 1 })), "ERR_BOUNDS"); // unknown option
  assertEquals(
    codeOf(() => pivotTable(data, { ...goodSpec, bounds: { maxPivotCategories: 2.5 } })),
    "ERR_BOUNDS",
  );
  // a narrower category bound is honored without error when the data fits
  const onlyA = T([C("region", "string"), C("product", "string"), C("qty", "number")], [["north", "A", 1]]);
  assertEquals(
    codeOf(() =>
      pivotTable(onlyA, {
        rowIds: ["region"],
        categoryId: "product",
        categories: ["A"],
        metrics: [{ column: "qty", agg: "sum" }],
        bounds: { maxPivotCategories: 10 },
      })
    ),
    null,
  );
});

Deno.test("def2 pivot: empty input table still yields deterministic group columns and headers", () => {
  const data = T([C("region", "string"), C("product", "string"), C("qty", "number")], []);
  const out = pivotTable(data, {
    rowIds: ["region"],
    categoryId: "product",
    categories: ["A"],
    metrics: [{ column: "qty", agg: "sum", id: "total" }],
  });
  assertEquals(out, T([C("region", "string"), C("total#0", "number", "sum(qty) A")], []));
});
