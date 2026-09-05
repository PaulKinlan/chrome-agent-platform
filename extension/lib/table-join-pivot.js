// lib/table-join-pivot.js — bounded deterministic joins and pivots over the
// canonical strict table core (extension/lib/table-core.js).
//
// Two public operations:
//   joinTables(left, right, request) → { table, workUnits }
//   pivotTable(table, request)       → { table, workUnits }
//
// Both inputs and outputs are canonical cap.table/1 tables: rows are ARRAYS
// addressed by column index (never objects), column types are { kind, scale? }
// objects, and every returned table passes assertCanonicalTable(). All
// int64/decimal arithmetic runs through the core's BigInt helpers
// (tableNumericAdd / tableNumericAverage), so sums/averages are exact, and
// every bound comes from the frozen TABLE_LIMITS.
//
// ── join semantics (revised r7 contract) ───────────────────────────────────
// request: { kind: "inner"|"left"|"right"|"full",
//            keys: [{ left, right }] (1..8),
//            leftColumns: [{ column, header? }] (0..1024),
//            rightColumns: [{ column, header? }] (0..1024) }
//   * Output = EXACTLY the projected left columns followed by the projected
//     right columns, ids regenerated c1..cN. There is NO automatic right-key
//     dropping and NO key coalescing: an unmatched right row keeps its data
//     (its right key included) in the right-projected slots, with nulls in
//     every left slot. Empty projections are allowed (a side contributes no
//     columns; both empty yields one empty row per emitted pair).
//   * The same column may not appear in two key pairs on the same side
//     (duplicate key columns invalid).
//   * Key matching: int64/decimal keys interoperate — they match by EXACT
//     numeric value across kind and scale (int64 5 == decimal(0) "5" ==
//     decimal(2) "5.00"), normalized to a fixed scale-18 BigInt so bucket
//     keys never collide across spellings. Every other domain joins as the
//     identical typed kind (text/text, date/date, ...); a numeric key paired
//     with a non-numeric key (or text with date) fails the job up front.
//     A row whose key tuple contains any null component never matches.
//   * Duplicate key values complete the Cartesian product of matching rows.
//   * Row order: inner/left/full iterate the left table in input order
//     (matched pairs immediately after their left row, unmatched left rows in
//     place); "full" appends unmatched right rows in right input order;
//     "right" iterates the right table in input order, each right row
//     followed by its left matches.
//   * Multiplicity is PREFLIGHTED: the emitted row count and the row×width
//     cell count are computed from the indexes before a single output row is
//     materialized (table_row_bound / table_cell_count_bound). The exact
//     serialized-byte budget is still enforced during emission, row by row.
//
// ── pivot semantics (revised r7 contract) ──────────────────────────────────
// request: { rowGroupBy: [colId] (0..8, [] = whole table),
//            pivotColumn: colId,
//            categories: [{ value, header }] (1..128),
//            metrics: [{ op, column?, header, scale? }] (1..16) }
//   * Metric ops: count_rows | count_values | sum | avg | min | max.
//     count_rows forbids a column; every other op requires one. avg REQUIRES
//     an explicit integer scale 0..18 (only avg accepts scale). Category and
//     metric headers are REQUIRED; output value columns are category-major
//     (all metrics of the first category, then the second, ...) and their
//     header is `${category.header} · ${metric.header}`.
//   * Output rows = distinct first-seen rowGroupBy tuples ([] rowGroupBy is
//     the single whole-table group and still emits one row for empty input,
//     mirroring the core's group aggregate); output columns = the group-by
//     columns followed by the category-major value columns.
//   * Every input row's pivot cell must exactly equal a declared category
//     value; a null or undeclared pivot cell fails the whole job. Categories
//     must be non-null unique cells valid for the pivot column type
//     (canonical strict-core spelling, ≤ 38 decimal digits).
//   * Bucket aggregates: count_rows counts bucket rows, count_values counts
//     non-null cells of the metric column, sum/avg/min/max skip null cells.
//     Missing buckets stay present: counts "0", aggregates null. count types
//     are int64; sum/min/max keep the source type; avg is decimal at the
//     requested scale via the core's half-even tableNumericAverage.
//   * Request guards mirror the strict core (exactData/idArray): plain
//     own-data objects and dense index arrays only — accessors, symbols,
//     non-enumerables and holes are rejected from descriptors, so no
//     caller-controlled getter is ever read.
//   * Bounds are preflighted before aggregation where possible: the output
//     width (maxColumns) and per-column/header totals (maxHeaderBytes /
//     maxHeaderTotalBytes) fail in the OutputBudget constructor up front; the
//     distinct-group count is discovered in a first pass and the group×width
//     cell count (maxCells) is checked before any aggregation runs.
//
// Work accounting: join charges one unit per left key pass row, one per right
// key pass row, and one per emitted output row. Pivot charges one per input
// row in the discovery pass, metricDefs per input row in the aggregation
// pass, and one per emitted group row. The multiplicity/discovery passes are
// row/cell-bounded by construction and are not separately charged.
// maxWorkUnits stays a coarse backstop that the output bounds outrun.

import {
  TABLE_LIMITS,
  TABLE_VERSION,
  TableError,
  assertCanonicalTable,
  tableNumericAdd,
  tableNumericAverage,
  tableUtf8Bytes,
} from "./table-core.js";

const JOIN_KINDS = new Set(["inner", "left", "right", "full"]);
const PIVOT_OPS = new Set(["count_rows", "count_values", "sum", "avg", "min", "max"]);
const MAX_PIVOT_CATEGORIES = 128;
const MAX_DECIMAL_PRECISION = 38; // strict-core parseDecimalToken ceiling on literal coefficient digits.
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const KEY_FIXED_SCALE = 18; // join numeric keys normalize to fixed scale-18 BigInts (exact across kind/scale).
const POW10 = [1n];
for (let i = 1; i <= 80; i++) POW10.push(POW10[i - 1] * 10n);

function fail(code, detail = "") {
  throw new TableError(code, detail);
}

// Own-data object with exactly the allowed keys over plain data descriptors
// (mirrors the strict core's ownObject + exactKeys): no accessors, no
// non-enumerable properties, no symbol keys. Descriptor metadata alone is
// inspected, so caller-controlled getters are never invoked — a getter that
// would throw on read still yields a clean table_bad_request.
function exactData(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("table_bad_request", label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("table_bad_request", label);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { fail("table_bad_request", label); }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail("table_bad_request", `${label}.${key}`);
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail("table_bad_request", label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("table_unknown_field", `${label}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("table_bad_request", `${label}.${key}`);
}

// Dense index array (mirrors the strict core's safeArray over the
// [min, max] length window): elements are plain enumerable data properties,
// copied onto a fresh array so later element reads never hit caller-controlled
// accessors or holes; extra non-index or symbol keys are rejected.
function idArray(value, label, min, max) {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length < min || value.length > max) {
    fail("table_bad_request", label);
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { fail("table_bad_request", label); }
  const copy = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail("table_bad_request", `${label}[${i}]`);
    }
    copy[i] = descriptor.value;
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
      fail("table_bad_request", `${label}.${String(key)}`);
    }
  }
  return copy;
}

function columnIndex(table, id) {
  if (typeof id !== "string" || !/^c(?:[1-9]\d*)$/u.test(id)) fail("table_unknown_column", String(id));
  const index = Number(id.slice(1)) - 1;
  if (index < 0 || index >= table.columns.length || table.columns[index].id !== id) fail("table_unknown_column", id);
  return index;
}

function isNumeric(type) {
  return type.kind === "int64" || type.kind === "decimal";
}

// Canonical typed cell → BigInt coefficient plus scale (int64 scale 0,
// decimal at its column scale). Inputs are already canonical typed cells.
function numericParts(value, type) {
  if (type.kind === "int64") return { coefficient: BigInt(value), scale: 0 };
  const digits = value.split(".");
  const fraction = digits[1] ?? "";
  return { coefficient: BigInt(digits[0] + fraction.padEnd(type.scale, "0")), scale: type.scale };
}

// Numeric cells of one column compare by exact aligned value, never lexically.
function compareCells(left, leftType, right, rightType) {
  if ((leftType.kind === "int64" || leftType.kind === "decimal") &&
      (rightType.kind === "int64" || rightType.kind === "decimal")) {
    const a = numericParts(left, leftType);
    const b = numericParts(right, rightType);
    const scale = Math.max(a.scale, b.scale);
    const av = a.coefficient * POW10[scale - a.scale];
    const bv = b.coefficient * POW10[scale - b.scale];
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  if (leftType.kind !== rightType.kind) fail("table_type_mismatch", "comparison");
  if (leftType.kind === "boolean") fail("table_type_mismatch", "boolean ordering");
  if (["text", "date", "datetime"].includes(leftType.kind)) {
    const a = [...left];
    const b = [...right];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = a[i].codePointAt(0) - b[i].codePointAt(0);
      if (d) return d < 0 ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

// Category values must be valid cells for the pivot column type (canonical
// form, like the strict core's typed-cell decoder).
function validTypedValue(value, type) {
  switch (type.kind) {
    case "text": return typeof value === "string" && tableUtf8Bytes(value) <= TABLE_LIMITS.maxCellBytes;
    case "boolean": return typeof value === "boolean";
    case "int64": {
      if (typeof value !== "string" || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(value)) return false;
      const n = BigInt(value);
      return n >= INT64_MIN && n <= INT64_MAX;
    }
    case "decimal": {
      // Canonical decimal cells at the column scale, exactly as the strict
      // core parses them (parseDecimalToken): canonical digit spelling, no
      // negative-zero representation, at most 38 literal coefficient digits.
      if (typeof value !== "string") return false;
      const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
      if (!match) return false;
      const fraction = match[3] ?? "";
      if (fraction.length !== type.scale) return false;
      if (match[1] && !/[1-9]/u.test(match[2] + fraction)) return false; // any negative-zero spelling
      return match[2].length + fraction.length <= MAX_DECIMAL_PRECISION;
    }
    case "date": return typeof value === "string" && validDate(value);
    case "datetime": return typeof value === "string" && validDateTime(value);
  }
  return false;
}

function validDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

function validDateTime(text) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text)) return false;
  const time = Date.parse(text);
  return Number.isFinite(time) && new Date(time).toISOString() === text;
}

// One join key component → a canonical comparable token. Numeric components
// normalize to a fixed scale-18 BigInt string, so int64 "5" and decimal(2)
// "5.00" (and every other exact numeric spelling) produce the SAME token;
// non-numeric components carry their kind tag so text/date/datetime/boolean
// tuples can never collide with numeric tokens or with each other.
function keyComponentToken(value, type) {
  if (isNumeric(type)) {
    const parts = numericParts(value, type);
    return ["n", (parts.coefficient * POW10[KEY_FIXED_SCALE - parts.scale]).toString()];
  }
  return [type.kind, value];
}

// A row's composite key over its key positions. Returns null when any
// component is null — a null key component never matches anything.
function compositeKey(cells, types) {
  const parts = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === null) return null;
    parts.push(keyComponentToken(cells[i], types[i]));
  }
  return JSON.stringify(parts);
}

// Exact output preflight: row cap, cell cap, and a byte meter that counts
// UTF-8 bytes exactly as the final assertCanonicalTable does (JSON structure
// is ASCII, so byte lengths are additive over the serialized parts).
// The constructor validates the output width and the header bytes (per column
// and total) UP FRONT, before any row work; emission enforces the remaining
// row/cell/byte budget.
class OutputBudget {
  constructor(columns, localeProfile) {
    if (columns.length > TABLE_LIMITS.maxColumns) fail("table_column_bound", String(TABLE_LIMITS.maxColumns));
    let headerTotal = 0;
    for (const column of columns) {
      if (typeof column.header !== "string" || tableUtf8Bytes(column.header) > TABLE_LIMITS.maxHeaderBytes) {
        fail("table_header_bound", String(column.header));
      }
      headerTotal += tableUtf8Bytes(column.header);
    }
    if (headerTotal > TABLE_LIMITS.maxHeaderTotalBytes) fail("table_header_bound", "total");
    this.columns = columns.map((column, index) => ({ id: `c${index + 1}`, header: column.header, type: column.type }));
    this.localeProfile = localeProfile;
    this.width = this.columns.length;
    this.outRows = [];
    // Prefix through `,"rows":[`; each emitted row then adds its own JSON
    // bytes plus one structural byte (comma separators and the closing bracket
    // of the rows array net out to one byte per row).
    this.bytes = tableUtf8Bytes(JSON.stringify({ version: TABLE_VERSION, localeProfile, columns: this.columns })) + 9;
    this.workUnits = 0;
  }
  work(amount = 1) {
    this.workUnits += amount;
    if (this.workUnits > TABLE_LIMITS.maxWorkUnits) fail("table_work_bound", String(TABLE_LIMITS.maxWorkUnits));
  }
  push(row) {
    if (this.outRows.length + 1 > TABLE_LIMITS.maxRows) fail("table_row_bound", String(TABLE_LIMITS.maxRows));
    if ((this.outRows.length + 1) * this.width > TABLE_LIMITS.maxCells) fail("table_cell_count_bound", String(TABLE_LIMITS.maxCells));
    this.outRows.push(row);
    this.bytes += tableUtf8Bytes(JSON.stringify(row)) + 1;
    if (this.bytes > TABLE_LIMITS.maxOutputBytes) fail("table_output_bound", String(TABLE_LIMITS.maxOutputBytes));
  }
  table() {
    return assertCanonicalTable({
      version: TABLE_VERSION,
      localeProfile: this.localeProfile,
      columns: this.columns,
      rows: this.outRows,
    });
  }
}

// ── join ───────────────────────────────────────────────────────────────────

export function joinTables(leftInput, rightInput, request) {
  const left = assertCanonicalTable(leftInput);
  const right = assertCanonicalTable(rightInput);
  exactData(request, ["kind", "keys", "leftColumns", "rightColumns"], ["kind", "keys", "leftColumns", "rightColumns"], "request");
  const kind = request.kind;
  if (!JOIN_KINDS.has(kind)) fail("table_bad_request", `request.kind: ${String(kind)}`);

  const keyPairs = idArray(request.keys, "request.keys", 1, TABLE_LIMITS.maxGroupColumns);
  const leftKeyPos = [];
  const rightKeyPos = [];
  for (let i = 0; i < keyPairs.length; i++) {
    const pair = keyPairs[i];
    exactData(pair, ["left", "right"], ["left", "right"], `request.keys[${i}]`);
    if (typeof pair.left !== "string" || typeof pair.right !== "string") {
      fail("table_bad_request", `request.keys[${i}]`);
    }
    const l = columnIndex(left, pair.left);
    const r = columnIndex(right, pair.right);
    const leftType = left.columns[l].type;
    const rightType = right.columns[r].type;
    // int64/decimal keys interoperate (exact numeric value across kind and
    // scale); every other domain requires the identical typed kind.
    if (isNumeric(leftType) !== isNumeric(rightType)) {
      fail("table_type_mismatch", `request.keys[${i}]: ${pair.left} (${leftType.kind}) vs ${pair.right} (${rightType.kind})`);
    }
    if (!isNumeric(leftType) && leftType.kind !== rightType.kind) {
      fail("table_type_mismatch", `request.keys[${i}]: ${pair.left} (${leftType.kind}) vs ${pair.right} (${rightType.kind})`);
    }
    if (leftKeyPos.includes(l)) fail("table_bad_request", `request.keys[${i}]: duplicate left column ${pair.left}`);
    if (rightKeyPos.includes(r)) fail("table_bad_request", `request.keys[${i}]: duplicate right column ${pair.right}`);
    leftKeyPos.push(l);
    rightKeyPos.push(r);
  }

  // Projections are explicit: output = exactly leftColumns then rightColumns,
  // in declared order, headers defaulting to the source header. Empty lists
  // are allowed. Nothing is dropped or coalesced automatically.
  const project = (entries, source, label) => entries.map((entry, index) => {
    exactData(entry, ["column", "header"], ["column"], `${label}[${index}]`);
    if (typeof entry.column !== "string") fail("table_bad_request", `${label}[${index}].column`);
    const pos = columnIndex(source, entry.column);
    const header = Object.hasOwn(entry, "header") ? entry.header : source.columns[pos].header;
    if (typeof header !== "string") fail("table_bad_request", `${label}[${index}].header`);
    return { pos, header, type: source.columns[pos].type };
  });
  const leftProjection = project(
    idArray(request.leftColumns, "request.leftColumns", 0, TABLE_LIMITS.maxColumns),
    left,
    "request.leftColumns",
  );
  const rightProjection = project(
    idArray(request.rightColumns, "request.rightColumns", 0, TABLE_LIMITS.maxColumns),
    right,
    "request.rightColumns",
  );

  const budget = new OutputBudget(
    [...leftProjection.map((p) => ({ header: p.header, type: p.type })), ...rightProjection.map((p) => ({ header: p.header, type: p.type }))],
    left.localeProfile,
  );

  // Key passes (null keys never match) + the right-side index. "right" joins
  // additionally build the left index.
  const leftKeyTypes = leftKeyPos.map((i) => left.columns[i].type);
  const rightKeyTypes = rightKeyPos.map((i) => right.columns[i].type);
  const leftKeys = left.rows.map((row) => { budget.work(); return compositeKey(leftKeyPos.map((i) => row[i]), leftKeyTypes); });
  const rightKeys = right.rows.map((row) => { budget.work(); return compositeKey(rightKeyPos.map((i) => row[i]), rightKeyTypes); });
  const rightIndex = new Map();
  for (let i = 0; i < right.rows.length; i++) {
    if (rightKeys[i] === null) continue;
    const bucket = rightIndex.get(rightKeys[i]);
    if (bucket) bucket.push(i);
    else rightIndex.set(rightKeys[i], [i]);
  }
  let leftIndex = null;
  if (kind === "right") {
    leftIndex = new Map();
    for (let i = 0; i < left.rows.length; i++) {
      if (leftKeys[i] === null) continue;
      const bucket = leftIndex.get(leftKeys[i]);
      if (bucket) bucket.push(i);
      else leftIndex.set(leftKeys[i], [i]);
    }
  }

  // Multiplicity preflight: count exactly what the emission passes below will
  // emit (per kind), failing table_row_bound the moment the output row count
  // would exceed maxRows and table_cell_count_bound when rows × width exceeds
  // maxCells — before ANY output row is materialized.
  let rowsOut = 0;
  const bump = (amount) => {
    rowsOut += amount;
    if (rowsOut > TABLE_LIMITS.maxRows) fail("table_row_bound", String(TABLE_LIMITS.maxRows));
  };
  let matchedRight = null;
  if (kind === "full") matchedRight = new Array(right.rows.length).fill(false);
  if (kind === "inner") {
    for (let l = 0; l < left.rows.length; l++) {
      if (leftKeys[l] === null) continue;
      const bucket = rightIndex.get(leftKeys[l]);
      if (bucket) bump(bucket.length);
    }
  } else if (kind === "left" || kind === "full") {
    for (let l = 0; l < left.rows.length; l++) {
      if (leftKeys[l] === null) { bump(1); continue; }
      const bucket = rightIndex.get(leftKeys[l]);
      if (bucket) {
        if (kind === "full") for (const r of bucket) matchedRight[r] = true;
        bump(bucket.length);
      } else bump(1);
    }
    if (kind === "full") {
      for (let r = 0; r < right.rows.length; r++) if (!matchedRight[r]) bump(1);
    }
  } else { // "right": every right row emits; matched pairs add their left matches.
    for (let r = 0; r < right.rows.length; r++) {
      if (rightKeys[r] === null) { bump(1); continue; }
      const bucket = leftIndex.get(rightKeys[r]);
      if (bucket) bump(bucket.length);
      else bump(1);
    }
  }
  if (rowsOut * budget.width > TABLE_LIMITS.maxCells) fail("table_cell_count_bound", String(TABLE_LIMITS.maxCells));

  const emit = (lrow, rrow) => {
    budget.work();
    budget.push([...leftProjection.map((p) => lrow[p.pos]), ...rightProjection.map((p) => rrow[p.pos])]);
  };
  const emitLeftLone = (lrow) => {
    budget.work();
    budget.push([...leftProjection.map((p) => lrow[p.pos]), ...new Array(rightProjection.length).fill(null)]);
  };
  const emitRightLone = (rrow) => {
    budget.work();
    budget.push([...new Array(leftProjection.length).fill(null), ...rightProjection.map((p) => rrow[p.pos])]);
  };

  if (kind === "inner") {
    for (let l = 0; l < left.rows.length; l++) {
      if (leftKeys[l] === null) continue;
      const bucket = rightIndex.get(leftKeys[l]);
      if (!bucket) continue;
      for (const r of bucket) emit(left.rows[l], right.rows[r]);
    }
  } else if (kind === "left") {
    for (let l = 0; l < left.rows.length; l++) {
      const bucket = leftKeys[l] === null ? null : rightIndex.get(leftKeys[l]);
      if (bucket) for (const r of bucket) emit(left.rows[l], right.rows[r]);
      else emitLeftLone(left.rows[l]);
    }
  } else if (kind === "right") {
    for (let r = 0; r < right.rows.length; r++) {
      const bucket = rightKeys[r] === null ? null : leftIndex.get(rightKeys[r]);
      if (bucket) for (const l of bucket) emit(left.rows[l], right.rows[r]);
      else emitRightLone(right.rows[r]);
    }
  } else {
    for (let l = 0; l < left.rows.length; l++) {
      const bucket = leftKeys[l] === null ? null : rightIndex.get(leftKeys[l]);
      if (bucket) for (const r of bucket) emit(left.rows[l], right.rows[r]);
      else emitLeftLone(left.rows[l]);
    }
    for (let r = 0; r < right.rows.length; r++) {
      if (matchedRight[r]) continue; // null-key right rows are never matched and still appear here.
      emitRightLone(right.rows[r]);
    }
  }

  return { table: budget.table(), workUnits: budget.workUnits };
}

// ── pivot ──────────────────────────────────────────────────────────────────

export function pivotTable(tableInput, request) {
  const table = assertCanonicalTable(tableInput);
  exactData(
    request,
    ["rowGroupBy", "pivotColumn", "categories", "metrics"],
    ["rowGroupBy", "pivotColumn", "categories", "metrics"],
    "request",
  );

  const groupBy = idArray(request.rowGroupBy, "request.rowGroupBy", 0, TABLE_LIMITS.maxGroupColumns);
  const groupPos = [];
  for (const id of groupBy) {
    if (typeof id !== "string") fail("table_bad_request", "request.rowGroupBy");
    const pos = columnIndex(table, id);
    if (groupPos.includes(pos)) fail("table_bad_request", "request.rowGroupBy: duplicate column");
    groupPos.push(pos);
  }

  const pivotPos = typeof request.pivotColumn === "string" ? columnIndex(table, request.pivotColumn) : null;
  if (pivotPos === null) fail("table_unknown_column", String(request.pivotColumn));
  const pivotType = table.columns[pivotPos].type;

  const categories = idArray(request.categories, "request.categories", 1, MAX_PIVOT_CATEGORIES);
  const categoryList = [];
  const categorySet = new Set();
  for (let i = 0; i < categories.length; i++) {
    const entry = categories[i];
    exactData(entry, ["value", "header"], ["value", "header"], `request.categories[${i}]`);
    const value = entry.value;
    if (value === null) fail("table_type_mismatch", `request.categories[${i}].value: null`);
    if (!validTypedValue(value, pivotType)) fail("table_type_mismatch", `request.categories[${i}].value`);
    if (categorySet.has(value)) fail("table_bad_request", `request.categories[${i}].value: duplicate`);
    categorySet.add(value);
    if (typeof entry.header !== "string") fail("table_bad_request", `request.categories[${i}].header`);
    categoryList.push({ value, header: entry.header });
  }

  const metrics = idArray(request.metrics, "request.metrics", 1, TABLE_LIMITS.maxMetrics);
  const metricDefs = metrics.map((metric, i) => {
    exactData(metric, ["op", "column", "header", "scale"], ["op", "header"], `request.metrics[${i}]`);
    const op = metric.op;
    if (!PIVOT_OPS.has(op)) fail("table_bad_request", `request.metrics[${i}].op`);
    if (typeof metric.header !== "string") fail("table_bad_request", `request.metrics[${i}].header`);
    const needsColumn = op !== "count_rows";
    if (needsColumn !== Object.hasOwn(metric, "column")) fail("table_bad_request", `request.metrics[${i}].column`);
    const pos = needsColumn
      ? (typeof metric.column === "string" ? columnIndex(table, metric.column) : fail("table_unknown_column", String(metric.column)))
      : null;
    const sourceType = pos === null ? null : table.columns[pos].type;
    if (op === "sum" || op === "avg") {
      if (!isNumeric(sourceType)) fail("table_type_mismatch", `request.metrics[${i}].op ${op}`);
    }
    if ((op === "min" || op === "max") && sourceType !== null && sourceType.kind === "boolean") {
      fail("table_type_mismatch", `request.metrics[${i}].op ${op}`);
    }
    if (op === "avg") {
      if (!Number.isInteger(metric.scale) || metric.scale < 0 || metric.scale > 18) {
        fail("table_type_invalid", `request.metrics[${i}].scale`);
      }
    } else if (Object.hasOwn(metric, "scale")) {
      fail("table_unknown_field", `request.metrics[${i}].scale`);
    }
    let outputType = { kind: "int64" }; // count_rows / count_values
    if (op === "sum" || op === "min" || op === "max") outputType = sourceType;
    if (op === "avg") outputType = { kind: "decimal", scale: metric.scale };
    return { op, pos, header: metric.header, sourceType, outputType };
  });

  // Output columns: group-by columns, then value columns category-major
  // (all metrics of the first category, then the second, ...) with the
  // composite header `${category.header} · ${metric.header}`.
  const outColumns = [];
  for (const pos of groupPos) outColumns.push({ header: table.columns[pos].header, type: table.columns[pos].type });
  for (const category of categoryList) {
    for (const metric of metricDefs) {
      outColumns.push({ header: `${category.header} · ${metric.header}`, type: metric.outputType });
    }
  }
  // Width, per-column header bytes and header totals fail here, before any row
  // is scanned.
  const budget = new OutputBudget(outColumns, table.localeProfile);

  // Discovery pass: every pivot cell must be a declared category (null or
  // undeclared fails the whole job) and rows group by first-seen rowGroupBy
  // tuples ([] rowGroupBy is the single whole-table group; an empty input
  // under [] rowGroupBy still emits that one group, like the core's aggregate).
  const groups = [];
  const groupByKey = new Map();
  for (const row of table.rows) {
    budget.work();
    const categoryValue = row[pivotPos];
    if (!categorySet.has(categoryValue)) fail("table_category_unknown", String(categoryValue));
    const groupKey = JSON.stringify(groupPos.map((pos) => [table.columns[pos].type.kind, row[pos]]));
    let group = groupByKey.get(groupKey);
    if (group === undefined) {
      if (groups.length >= TABLE_LIMITS.maxGroups) fail("table_group_bound", String(TABLE_LIMITS.maxGroups));
      group = { cells: groupPos.map((pos) => row[pos]), rows: [] };
      groups.push(group);
      groupByKey.set(groupKey, group);
    }
    group.rows.push(row);
  }
  if (groups.length === 0 && groupPos.length === 0) groups.push({ cells: [], rows: [] });

  // Cell-count preflight: group count is now known, so groups × width is
  // checked against maxCells before any aggregation runs.
  if (groups.length * budget.width > TABLE_LIMITS.maxCells) fail("table_cell_count_bound", String(TABLE_LIMITS.maxCells));

  // Aggregation pass: one accumulator per (group, metric) over category
  // buckets. count_rows counts every bucket row; every other op skips null
  // cells (count_values counts the non-null ones).
  for (const group of groups) {
    const accs = group.accs = metricDefs.map(() => new Map());
    for (const row of group.rows) {
      budget.work(metricDefs.length);
      const categoryValue = row[pivotPos];
      for (let m = 0; m < metricDefs.length; m++) {
        const metric = metricDefs[m];
        const value = metric.pos === null ? null : row[metric.pos];
        if (metric.op !== "count_rows" && value === null) continue;
        let acc = accs[m].get(categoryValue);
        if (acc === undefined) {
          acc = { n: 0, sum: null, min: null, max: null };
          accs[m].set(categoryValue, acc);
        }
        acc.n += 1;
        if (metric.op === "sum" || metric.op === "avg") {
          if (acc.sum === null) acc.sum = { value, type: metric.sourceType };
          else acc.sum = tableNumericAdd(acc.sum.value, acc.sum.type, value, metric.sourceType);
        } else if (metric.op === "min") {
          if (acc.min === null || compareCells(value, metric.sourceType, acc.min, metric.sourceType) < 0) acc.min = value;
        } else if (metric.op === "max") {
          if (acc.max === null || compareCells(value, metric.sourceType, acc.max, metric.sourceType) > 0) acc.max = value;
        }
      }
    }
  }

  for (const group of groups) {
    budget.work();
    const row = [...group.cells];
    for (const category of categoryList) {
      for (let m = 0; m < metricDefs.length; m++) {
        const metric = metricDefs[m];
        const acc = group.accs[m].get(category.value);
        let cell = null;
        if (acc !== undefined) {
          if (metric.op === "count_rows" || metric.op === "count_values") cell = String(acc.n);
          else if (metric.op === "sum") cell = acc.sum === null ? null : acc.sum.value;
          else if (metric.op === "avg") cell = acc.sum === null ? null : tableNumericAverage(acc.sum.value, acc.sum.type, acc.n, metric.outputType.scale).value;
          else if (metric.op === "min") cell = acc.min;
          else cell = acc.max;
        } else if (metric.op === "count_rows" || metric.op === "count_values") {
          cell = "0";
        }
        row.push(cell);
      }
    }
    budget.push(row);
  }
  return { table: budget.table(), workUnits: budget.workUnits };
}
