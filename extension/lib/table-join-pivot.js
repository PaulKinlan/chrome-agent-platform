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
// (tableNumericAdd / tableNumericAverage), so sums/averages are exact.
//
// ── join semantics ─────────────────────────────────────────────────────────
// request: { kind: "inner"|"left"|"right"|"full",
//            keys: [{ left: colId, right: colId }] }  — 1..8 key pairs.
//   * A key pair requires the two columns to have the IDENTICAL type
//     (kind and scale): matching is typed no-coercion. Mismatch fails the job.
//   * A row whose key cell is null never matches anything (it only ever
//     appears in outer joins as an unmatched row).
//   * Duplicate key values complete the Cartesian product of matching rows.
//   * Output columns: every left column (its keys included) followed by the
//     right columns that are not right keys. Right key columns are dropped:
//     matched rows already carry the key value in the left key slots.
//   * Row order: inner/left/full iterate the left table in input order
//     (matched pairs immediately after their left row, unmatched left rows in
//     place); "full" appends unmatched right rows in right input order;
//     "right" iterates the right table in input order, each right row followed
//     by its left matches. Unmatched right rows write their key values into
//     the left key slots (SQL USING-style coalescing) so no key data is lost.
//
// ── pivot semantics ────────────────────────────────────────────────────────
// request: { rowGroupBy: [colId] (1..8), pivotColumn: colId,
//            categories: [{ value, header? }] (1..128),
//            metrics: [{ op, column?, header? }] (1..16) }
//   * Output rows = distinct first-seen combinations of the rowGroupBy
//     columns (≤ 4096 groups). Output columns = the group-by columns followed
//     by one value column per (metric, category) pair — metrics-major,
//     categories in their declared order.
//   * Every input row's pivot cell must equal a declared category value
//     exactly (typed, canonical-form equality); null and undeclared values
//     fail the whole job. Categories must be non-null, unique, and valid
//     cells for the pivot column type.
//   * metric ops: count (column optional — counts non-null cells when a
//     column is given, bucket rows otherwise), sum/avg (int64|decimal
//     columns), min/max (any ordered non-boolean column). Missing buckets
//     stay present: count 0, other metrics null. min/max ignore null cells.
//   * Output metric types: count → int64; sum/min/max → the source column
//     type; avg → decimal at the source decimal scale, or decimal scale 6
//     for int64 sources (the repository's half-even division default).
//
// ── bounds and work ────────────────────────────────────────────────────────
// Bounds come from the frozen TABLE_LIMITS. Output is preflighted DURING
// emission — row count (maxRows), cell count (rows × width, maxCells), and
// exact serialized bytes (maxOutputBytes, counted identically to the final
// assertCanonicalTable) each fail the whole job the moment they would be
// exceeded, before a runaway join/pivot is materialized. The work meter
// charges one unit per input row visit and per emitted row; maxWorkUnits is a
// coarse backstop that output-bound enforcement already outruns on every
// reachable input today.
//
// Error codes reuse the strict core family: table_unknown_field,
// table_bad_request, table_unknown_column, table_type_mismatch,
// table_column_bound, table_row_bound, table_cell_count_bound,
// table_output_bound, table_work_bound, table_group_bound,
// table_header_bound, table_numeric_overflow, and table_category_unknown
// (an input pivot cell outside the declared categories).

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
const PIVOT_OPS = new Set(["count", "sum", "avg", "min", "max"]);
const MAX_PIVOT_CATEGORIES = 128;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const MAX_AVG_SCALE = 6; // int64-source averages: decimal scale 6 (half-even), matching the repo division default.
const POW10 = [1n];
for (let i = 1; i <= 80; i++) POW10.push(POW10[i - 1] * 10n);

function fail(code, detail = "") {
  throw new TableError(code, detail);
}

// Own-data object with exactly the allowed keys (mirrors the core's request
// validation so table_* codes stay coherent across the strict core family).
function exactData(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("table_bad_request", label);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail("table_bad_request", label);
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("table_unknown_field", `${label}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("table_bad_request", `${label}.${key}`);
}

function idArray(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("table_bad_request", label);
  return value;
}

function columnIndex(table, id) {
  if (typeof id !== "string" || !/^c(?:[1-9]\d*)$/u.test(id)) fail("table_unknown_column", String(id));
  const index = Number(id.slice(1)) - 1;
  if (index < 0 || index >= table.columns.length || table.columns[index].id !== id) fail("table_unknown_column", id);
  return index;
}

function sameType(left, right) {
  return left.kind === right.kind && (left.scale ?? -1) === (right.scale ?? -1);
}

// Canonical value → BigInt coefficient plus scale (int64 scale 0, decimal at
// its column scale). Inputs are already canonical typed cells.
function numericParts(value, type) {
  if (type.kind === "int64") return { coefficient: BigInt(value), scale: 0 };
  const digits = value.split(".");
  const fraction = digits[1] ?? "";
  return { coefficient: BigInt(digits[0] + fraction.padEnd(type.scale, "0")), scale: type.scale };
}

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
      if (typeof value !== "string" || value === "-0") return false;
      const match = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
      if (!match) return false;
      return (match[1] ?? "").length === type.scale;
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

// A null key never matches. Composite keys serialize each typed cell with
// JSON so text values containing any separator byte cannot collide.
function compositeKey(cells) {
  for (const cell of cells) if (cell === null) return null;
  return JSON.stringify(cells);
}

// Exact output preflight: row cap, cell cap, and a byte meter that counts
// UTF-8 bytes exactly as the final assertCanonicalTable does (JSON structure
// is ASCII, so byte lengths are additive over the serialized parts).
class OutputBudget {
  constructor(columns, localeProfile) {
    if (columns.length > TABLE_LIMITS.maxColumns) fail("table_column_bound", String(TABLE_LIMITS.maxColumns));
    this.columns = columns;
    this.localeProfile = localeProfile;
    this.width = columns.length;
    this.outRows = [];
    // Prefix through `,"rows":[`; each emitted row then adds its own JSON
    // bytes plus one structural byte (comma separators and the closing bracket
    // of the rows array net out to one byte per row).
    this.bytes = tableUtf8Bytes(JSON.stringify({ version: TABLE_VERSION, localeProfile, columns })) + 9;
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
  exactData(request, ["kind", "keys"], ["kind", "keys"], "request");
  const kind = request.kind;
  if (!JOIN_KINDS.has(kind)) fail("table_bad_request", `request.kind: ${String(kind)}`);
  const keys = idArray(request.keys, "request.keys", 1, TABLE_LIMITS.maxGroupColumns);

  const leftKeyPos = [];
  const rightKeyPos = [];
  for (let i = 0; i < keys.length; i++) {
    const pair = keys[i];
    exactData(pair, ["left", "right"], ["left", "right"], `request.keys[${i}]`);
    if (typeof pair.left !== "string" || typeof pair.right !== "string") {
      fail("table_bad_request", `request.keys[${i}]`);
    }
    const l = columnIndex(left, pair.left);
    const r = columnIndex(right, pair.right);
    const leftType = left.columns[l].type;
    const rightType = right.columns[r].type;
    if (!sameType(leftType, rightType)) {
      fail("table_type_mismatch", `request.keys[${i}]: ${pair.left} (${leftType.kind}) vs ${pair.right} (${rightType.kind})`);
    }
    leftKeyPos.push(l);
    rightKeyPos.push(r);
  }

  // Output columns: all left columns, then right columns that are not keys.
  const rightKeySet = new Set(rightKeyPos);
  const rightValuePos = [];
  for (let i = 0; i < right.columns.length; i++) if (!rightKeySet.has(i)) rightValuePos.push(i);
  const budget = new OutputBudget(
    [...left.columns, ...rightValuePos.map((i) => right.columns[i])].map((column, i) => ({ ...column, id: `c${i + 1}` })),
    left.localeProfile,
  );

  // Key passes (null keys never match). Right rows additionally build the
  // bucket index; "right" joins build the left index instead.
  const leftKeys = left.rows.map((row) => { budget.work(); return compositeKey(leftKeyPos.map((i) => row[i])); });
  const rightKeys = right.rows.map((row) => { budget.work(); return compositeKey(rightKeyPos.map((i) => row[i])); });
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

  const emit = (lrow, rrow) => {
    budget.work();
    budget.push([...lrow, ...rightValuePos.map((i) => rrow[i])]);
  };
  const emitLeftLone = (lrow) => {
    budget.work();
    budget.push([...lrow, ...new Array(rightValuePos.length).fill(null)]);
  };
  const emitRightLone = (rrow, rKey) => {
    budget.work();
    const cells = new Array(left.columns.length).fill(null);
    for (let i = 0; i < leftKeyPos.length; i++) if (rKey !== null) cells[leftKeyPos[i]] = rKey[i];
    budget.push([...cells, ...rightValuePos.map((i) => rrow[i])]);
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
      else emitRightLone(right.rows[r], rightKeys[r] === null ? null : rightKeyPos.map((i) => right.rows[r][i]));
    }
  } else {
    const matchedRight = new Array(right.rows.length).fill(false);
    for (let l = 0; l < left.rows.length; l++) {
      const bucket = leftKeys[l] === null ? null : rightIndex.get(leftKeys[l]);
      if (bucket) {
        for (const r of bucket) {
          matchedRight[r] = true;
          emit(left.rows[l], right.rows[r]);
        }
      } else emitLeftLone(left.rows[l]);
    }
    for (let r = 0; r < right.rows.length; r++) {
      if (matchedRight[r]) continue; // null-key right rows are never matched and still appear here.
      emitRightLone(right.rows[r], rightKeyPos.map((i) => right.rows[r][i]));
    }
  }

  return { table: budget.table(), workUnits: budget.workUnits };
}

// ── pivot ──────────────────────────────────────────────────────────────────

export function pivotTable(tableInput, request) {
  const table = assertCanonicalTable(tableInput);
  exactData(request, ["rowGroupBy", "pivotColumn", "categories", "metrics"], ["rowGroupBy", "pivotColumn", "categories", "metrics"], "request");

  const groupPos = [];
  const groupBy = idArray(request.rowGroupBy, "request.rowGroupBy", 1, TABLE_LIMITS.maxGroupColumns);
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
    exactData(entry, ["value", "header"], ["value"], `request.categories[${i}]`);
    const value = entry.value;
    if (value === null) fail("table_type_mismatch", `request.categories[${i}].value: null`);
    if (!validTypedValue(value, pivotType, `request.categories[${i}].value`)) {
      fail("table_type_mismatch", `request.categories[${i}].value`);
    }
    if (categorySet.has(value)) fail("table_bad_request", `request.categories[${i}].value: duplicate`);
    categorySet.add(value);
    const header = Object.hasOwn(entry, "header") ? entry.header : String(value);
    if (typeof header !== "string") fail("table_bad_request", `request.categories[${i}].header`);
    categoryList.push({ value, header });
  }

  const metrics = idArray(request.metrics, "request.metrics", 1, TABLE_LIMITS.maxMetrics);
  const metricDefs = metrics.map((metric, i) => {
    exactData(metric, ["op", "column", "header"], ["op"], `request.metrics[${i}]`);
    const op = metric.op;
    if (!PIVOT_OPS.has(op)) fail("table_bad_request", `request.metrics[${i}].op`);
    const hasColumn = Object.hasOwn(metric, "column");
    if (hasColumn && (typeof metric.column !== "string" || columnIndex(table, metric.column) < 0)) {
      fail("table_unknown_column", `request.metrics[${i}].column`);
    }
    if (op !== "count" && !hasColumn) fail("table_bad_request", `request.metrics[${i}].column`);
    const pos = hasColumn ? columnIndex(table, metric.column) : null;
    const sourceType = pos === null ? null : table.columns[pos].type;
    const numeric = sourceType !== null && (sourceType.kind === "int64" || sourceType.kind === "decimal");
    if ((op === "sum" || op === "avg") && !numeric) fail("table_type_mismatch", `request.metrics[${i}].op ${op}`);
    if ((op === "min" || op === "max") && sourceType !== null && sourceType.kind === "boolean") {
      fail("table_type_mismatch", `request.metrics[${i}].op ${op}`);
    }
    if (Object.hasOwn(metric, "header") && typeof metric.header !== "string") {
      fail("table_bad_request", `request.metrics[${i}].header`);
    }
    const header = metric.header ??
      (pos === null ? "count" : `${op}(${table.columns[pos].header})`);
    let outputType = { kind: "int64" };
    if (op === "sum" || op === "min" || op === "max") outputType = sourceType;
    if (op === "avg") outputType = sourceType.kind === "decimal" ? { kind: "decimal", scale: sourceType.scale } : { kind: "decimal", scale: MAX_AVG_SCALE };
    return { op, pos, header, sourceType, outputType };
  });

  // Output columns: group-by columns, then metrics-major over categories.
  const budgetColumns = [
    ...groupPos.map((pos) => table.columns[pos]),
  ];
  for (const metric of metricDefs) {
    for (const category of categoryList) {
      const header = category.header === "" ? metric.header : `${metric.header} ${category.header}`;
      if (tableUtf8Bytes(header) > TABLE_LIMITS.maxHeaderBytes) fail("table_header_bound", header);
      budgetColumns.push({ header, type: metric.outputType });
    }
  }
  const budget = new OutputBudget(budgetColumns.map((column, i) => ({ ...column, id: `c${i + 1}` })), table.localeProfile);

  // One scan: group rows (first-seen order), require the pivot cell to be a
  // declared category, then update each metric accumulator for the bucket.
  const groups = [];
  const groupByKey = new Map();
  for (const row of table.rows) {
    budget.work(1 + metricDefs.length);
    const categoryValue = row[pivotPos];
    if (!categorySet.has(categoryValue)) fail("table_category_unknown", String(categoryValue));
    const groupKey = JSON.stringify(groupPos.map((pos) => row[pos]));
    let group = groupByKey.get(groupKey);
    if (group === undefined) {
      if (groups.length >= TABLE_LIMITS.maxGroups) fail("table_group_bound", String(TABLE_LIMITS.maxGroups));
      group = { cells: groupPos.map((pos) => row[pos]), accs: metricDefs.map(() => new Map()) };
      groups.push(group);
      groupByKey.set(groupKey, group);
    }
    for (let m = 0; m < metricDefs.length; m++) {
      const metric = metricDefs[m];
      const value = metric.pos === null ? null : row[metric.pos];
      if (metric.op === "count" && metric.pos !== null && value === null) continue; // COUNT(col) counts non-null cells only.
      if (metric.op !== "count" && value === null) continue; // sum/avg/min/max skip null cells.
      let acc = group.accs[m].get(categoryValue);
      if (acc === undefined) {
        acc = { n: 0, sum: null, min: null, max: null };
        group.accs[m].set(categoryValue, acc);
      }
      acc.n += 1;
      if (metric.op === "sum" || metric.op === "avg") {
        acc.sum = acc.sum === null ? { value, type: metric.sourceType } : tableNumericAdd(acc.sum.value, acc.sum.type, value, metric.sourceType);
      } else if (metric.op === "min") {
        if (acc.min === null || compareCells(value, metric.sourceType, acc.min, metric.sourceType) < 0) acc.min = value;
      } else if (metric.op === "max") {
        if (acc.max === null || compareCells(value, metric.sourceType, acc.max, metric.sourceType) > 0) acc.max = value;
      }
    }
  }

  for (const group of groups) {
    budget.work();
    const row = [...group.cells];
    for (let m = 0; m < metricDefs.length; m++) {
      const metric = metricDefs[m];
      for (const category of categoryList) {
        const acc = group.accs[m].get(category.value);
        let cell = null;
        if (acc !== undefined) {
          if (metric.op === "count") cell = String(acc.n);
          else if (metric.op === "sum") cell = acc.sum === null ? null : acc.sum.value;
          else if (metric.op === "avg") cell = acc.sum === null ? null : tableNumericAverage(acc.sum.value, acc.sum.type, acc.n, metric.outputType.scale).value;
          else if (metric.op === "min") cell = acc.min;
          else cell = acc.max;
        } else if (metric.op === "count") {
          cell = "0";
        }
        row.push(cell);
      }
    }
    budget.push(row);
  }
  return { table: budget.table(), workUnits: budget.workUnits };
}
