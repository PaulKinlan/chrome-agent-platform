// lib/table-join-pivot.js — bounded deterministic table joins and pivots.
// chrome-agent-platform-def.2 (CAP-FB-20260822-SPREADSHEET-TOOLKIT-01, def alignment).
//
// Operates on the cap.table/1 canonical model defined by the def tranche (no
// route / tool / service-worker wiring here — this module is adopted by the
// OPEN chrome-agent-platform-def.2 tracker entry):
//
//   table := { version: 'cap.table/1', localeProfile: <string>,
//              columns: [{ id, header, type }, ...], rows: [[cell, ...], ...] }
//
//   * column type ∈ { 'string', 'number', 'boolean' }; a cell is null (missing)
//     or a value of its column's declared type; number cells must be finite.
//     Extra keys on the table/column objects are tolerated (forward
//     compatibility with the parser lane); the keys consumed here are
//     validated strictly.
//
// Guarantees:
//   * Deterministic pure functions of their inputs. Input order is preserved:
//     inner/left/full joins and pivots are left/input-major, right joins are
//     right-major, matched pairs always iterate the indexed side in its input
//     order. No localeCompare, no string-concatenated hash keys (typed keys
//     walk nested Maps, so no delimiter collisions), no header-name lookup —
//     columns are addressed by id only.
//   * Typed matching: key cells match only when both sides declare the same
//     column type at that position AND the stored values are equal. A null key
//     cell never matches anything. Duplicate keys complete the full Cartesian
//     pair set. Pivot groups treat null key cells as one shared bucket (SQL
//     GROUP BY semantics) and are emitted in first-seen order.
//   * Strict and fail-whole-job: one invalid cell, unknown category, or
//     exceeded bound aborts the op; nothing partial is returned or published.
//   * Bounded: every job runs against TABLE_OP_BOUNDS (input rows/cells,
//     output bytes, a coarse work backstop, join-key width, pivot width).
//     Bounds may be overridden per call for testing (exact/+1 KATs).
//
// Work accounting (the coarse "5m work" backstop): 1 unit per validated input
// row, 1 per row placed in the join index, 1 per probe row, 1 per full-join
// unmatched-right scan row, and 1 per emitted output row. Output bytes are
// accounted exactly as the running Σ of JSON.stringify(outputRow).length and
// are checked before each row is accepted.
//
// Arithmetic seam (exact decimals): aggregates run through a narrow injected
// adapter (add / div / min / max; default DOUBLE_ARITHMETIC over plain finite
// doubles, which is what the current parser produces). This repo has no
// exact-decimal core yet; when cap.table/1 gains decimal cells, wire a decimal
// adapter here at the call site and widen the column-type gate with it —
// shared core is deliberately not edited by this lane (integration note in the
// def.2 acceptance report).

export const TABLE_VERSION = "cap.table/1";

export const TABLE_COLUMN_TYPES = Object.freeze(["string", "number", "boolean"]);

export const TABLE_OP_BOUNDS = Object.freeze({
  maxTableRows: 100_000, // per input table
  maxTableCells: 1_000_000, // per input table (rows.length * columns.length)
  maxOutputBytes: 8 * 1024 * 1024, // running Σ JSON.stringify(outputRow).length
  maxWorkUnits: 5_000_000, // coarse backstop — see work accounting above
  maxJoinKeys: 8, // join key pairs must be 1..8
  maxPivotCategories: 128, // explicit ordered category list width
  maxPivotMetrics: 16,
  maxPivotRowGroups: 4096, // distinct first-seen row groups in the output
});

export const DOUBLE_ARITHMETIC = Object.freeze({
  id: "double",
  add: (a, b) => a + b,
  div: (a, b) => a / b,
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
});

const AGGREGATORS = Object.freeze(["count", "sum", "avg", "min", "max"]);
const JOIN_KINDS = new Set(["inner", "left", "right", "full"]);

/** Error thrown for every closed-input violation. `code` is stable for KATs. */
export class TableOpError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TableOpError";
    this.code = code;
  }
}

// Sentinel stored at the leaf level of every key trie. Symbol keys cannot
// collide with cell values (strings/numbers/booleans/null).
const LEAF = Symbol("table-join-pivot.leaf");

const NUMBER_TYPE = "number";
const EMPTY_CELL = Object.freeze({ count: 0, sum: null, avg: null, min: null, max: null });

// ---------------------------------------------------------------------------
// Work meter + bounds
// ---------------------------------------------------------------------------

class WorkMeter {
  constructor(maxUnits) {
    this.max = maxUnits;
    this.spent = 0;
  }
  spend(n) {
    if (!Number.isInteger(n) || n < 0) throw new TableOpError("ERR_BOUNDS", `work meter spend(${n}) is invalid`);
    this.spent += n;
    if (this.spent > this.max) {
      throw new TableOpError(
        "ERR_WORK_LIMIT",
        `work budget of ${this.max} units exceeded (spent ${this.spent})`,
      );
    }
  }
}

function checkBounds(bounds) {
  const out = { ...TABLE_OP_BOUNDS };
  if (bounds === undefined || bounds === null) return out;
  if (typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new TableOpError("ERR_BOUNDS", "bounds must be an object");
  }
  for (const [key, value] of Object.entries(bounds)) {
    if (!(key in TABLE_OP_BOUNDS)) {
      throw new TableOpError("ERR_BOUNDS", `unknown bound "${key}"`);
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new TableOpError("ERR_BOUNDS", `bound ${key} must be a non-negative integer, got ${value}`);
    }
    out[key] = value;
  }
  return out;
}

function checkOptions(options, allowed) {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TableOpError("ERR_BOUNDS", "options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TableOpError("ERR_BOUNDS", `unknown option "${key}"`);
  }
  return options;
}

function checkArithmetic(arithmetic) {
  if (arithmetic === undefined || arithmetic === null) return DOUBLE_ARITHMETIC;
  if (typeof arithmetic !== "object" || Array.isArray(arithmetic)) {
    throw new TableOpError("ERR_ARITHMETIC", "arithmetic must be an object");
  }
  for (const fn of ["add", "div", "min", "max"]) {
    if (typeof arithmetic[fn] !== "function") {
      throw new TableOpError("ERR_ARITHMETIC", `arithmetic.${fn} must be a function`);
    }
  }
  return arithmetic;
}

// ---------------------------------------------------------------------------
// Canonical table validation
// ---------------------------------------------------------------------------

/**
 * Strictly validate a cap.table/1 table against the model and TABLE_OP_BOUNDS.
 * Returns { rows, cols }. Throws TableOpError on the first violation.
 */
export function validateTable(table, options = {}) {
  const allowed = new Set(["bounds"]);
  const opts = checkOptions(options, allowed);
  const bounds = checkBounds(opts.bounds);
  return validateTableShape(table, bounds, null);
}

function validateTableShape(table, bounds, meter) {
  if (table === null || typeof table !== "object" || Array.isArray(table)) {
    throw new TableOpError("ERR_TABLE_SHAPE", "table must be a plain object");
  }
  if (table.version !== TABLE_VERSION) {
    throw new TableOpError("ERR_TABLE_SHAPE", `table.version must be "${TABLE_VERSION}", got ${JSON.stringify(table.version)}`);
  }
  if (typeof table.localeProfile !== "string") {
    throw new TableOpError("ERR_TABLE_SHAPE", "table.localeProfile must be a string");
  }
  const columns = table.columns;
  const rows = table.rows;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TableOpError("ERR_TABLE_SHAPE", "table.columns must be a non-empty array");
  }
  if (!Array.isArray(rows)) throw new TableOpError("ERR_TABLE_SHAPE", "table.rows must be an array");
  if (rows.length > bounds.maxTableRows) {
    throw new TableOpError(
      "ERR_TABLE_TOO_LARGE",
      `table has ${rows.length} rows, exceeding maxTableRows ${bounds.maxTableRows}`,
    );
  }
  const cells = rows.length * columns.length;
  if (cells > bounds.maxTableCells) {
    throw new TableOpError(
      "ERR_TABLE_TOO_LARGE",
      `table has ${cells} cells, exceeding maxTableCells ${bounds.maxTableCells}`,
    );
  }
  const seenIds = new Set();
  for (const col of columns) {
    if (col === null || typeof col !== "object" || Array.isArray(col)) {
      throw new TableOpError("ERR_TABLE_SHAPE", "each column must be an object");
    }
    if (typeof col.id !== "string" || col.id.length === 0) {
      throw new TableOpError("ERR_TABLE_SHAPE", "each column needs a non-empty string id");
    }
    if (seenIds.has(col.id)) throw new TableOpError("ERR_TABLE_SHAPE", `duplicate column id "${col.id}"`);
    seenIds.add(col.id);
    if (typeof col.header !== "string") {
      throw new TableOpError("ERR_TABLE_SHAPE", `column "${col.id}" needs a string header`);
    }
    if (!TABLE_COLUMN_TYPES.includes(col.type)) {
      throw new TableOpError(
        "ERR_TABLE_SHAPE",
        `column "${col.id}" has unsupported type ${JSON.stringify(col.type)}`,
      );
    }
  }
  if (meter) meter.spend(rows.length);
  const width = columns.length;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length !== width) {
      throw new TableOpError(
        "ERR_ROW_WIDTH",
        `row ${r} has length ${Array.isArray(row) ? row.length : typeof row}, expected ${width} cells`,
      );
    }
    for (let c = 0; c < width; c++) {
      const cell = row[c];
      if (cell === null) continue; // null = missing, allowed in every column
      const type = columns[c].type;
      const ok =
        type === "string"
          ? typeof cell === "string"
          : type === "number"
            ? typeof cell === "number" && Number.isFinite(cell)
            : type === "boolean"
              ? typeof cell === "boolean"
              : false;
      if (!ok) {
        throw new TableOpError(
          "ERR_CELL_TYPE",
          `row ${r} column "${columns[c].id}": expected ${type}, got ${JSON.stringify(cell)}`,
        );
      }
    }
  }
  return { rows: rows.length, cols: width };
}

function columnIndexById(table) {
  const index = new Map();
  for (let i = 0; i < table.columns.length; i++) index.set(table.columns[i].id, i);
  return index;
}

// ---------------------------------------------------------------------------
// Key tries (typed tuples; never string-concatenated)
// ---------------------------------------------------------------------------

/** Row key over key column indices. Returns null when ANY key cell is null. */
function keyTupleOrNull(row, keyIdx) {
  const key = new Array(keyIdx.length);
  for (let i = 0; i < keyIdx.length; i++) {
    const v = row[keyIdx[i]];
    if (v === null) return null;
    key[i] = v;
  }
  return key;
}

/** Row key over group column indices. Null cells are allowed and group together. */
function tupleOf(row, idx) {
  const tuple = new Array(idx.length);
  for (let i = 0; i < idx.length; i++) tuple[i] = row[idx[i]];
  return tuple;
}

function trieGet(root, key) {
  let node = root;
  for (const v of key) {
    node = node.get(v);
    if (node === undefined) return null;
  }
  const leaf = node.get(LEAF);
  return leaf === undefined ? null : leaf;
}

/** trieAdd(root, key, value): stores `value` at the trie leaf for `key`. */
function trieAdd(root, key, value) {
  let node = root;
  for (const v of key) {
    let child = node.get(v);
    if (child === undefined) {
      child = new Map();
      node.set(v, child);
    }
    node = child;
  }
  let leaf = node.get(LEAF);
  if (leaf === undefined) {
    leaf = [];
    node.set(LEAF, leaf);
  }
  leaf.push(value);
}

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

/**
 * Typed-tuple relational join over two cap.table/1 tables.
 *
 * Options:
 *   kind:      'inner' | 'left' | 'right' | 'full' (default 'inner')
 *   leftKeys:  column ids on the left table (1..maxJoinKeys)
 *   rightKeys: column ids on the right table, positionally paired with leftKeys
 *   bounds:    TABLE_OP_BOUNDS overrides (testing)
 *   arithmetic: adapter accepted for symmetry; joins never aggregate
 *
 * Output: left columns (ids preserved) followed by right columns; a right
 * column whose id collides with an emitted left column is deterministically
 * renamed (suffix ".r", repeated until unique). Row order is left-major for
 * inner/left/full, right-major for 'right'; within a match the indexed side
 * iterates in its input order; null keys never match; outer joins pad the
 * missing side with nulls (full join appends unmatched right rows in right
 * input order after the left-major emission).
 */
export function joinTables(left, right, options = {}) {
  const allowed = new Set(["kind", "leftKeys", "rightKeys", "bounds", "arithmetic"]);
  const opts = checkOptions(options, allowed);
  const bounds = checkBounds(opts.bounds);
  const meter = new WorkMeter(bounds.maxWorkUnits);
  checkArithmetic(opts.arithmetic); // accepted for call-site symmetry; joins never aggregate

  const kind = opts.kind === undefined ? "inner" : opts.kind;
  if (!JOIN_KINDS.has(kind)) {
    throw new TableOpError("ERR_KEY_SPEC", `unknown join kind ${JSON.stringify(kind)}`);
  }
  validateTableShape(left, bounds, meter);
  validateTableShape(right, bounds, meter);

  const lKeys = opts.leftKeys;
  const rKeys = opts.rightKeys;
  if (!Array.isArray(lKeys) || !Array.isArray(rKeys)) {
    throw new TableOpError("ERR_KEY_SPEC", "leftKeys and rightKeys arrays are required");
  }
  const nKeys = lKeys.length;
  if (nKeys !== rKeys.length) {
    throw new TableOpError("ERR_KEY_SPEC", "leftKeys and rightKeys must have the same length");
  }
  if (nKeys < 1 || nKeys > bounds.maxJoinKeys) {
    throw new TableOpError(
      "ERR_KEY_SPEC",
      `joins need 1..${bounds.maxJoinKeys} key columns, got ${nKeys}`,
    );
  }
  const leftIdx = columnIndexById(left);
  const rightIdx = columnIndexById(right);
  const lKeyIdx = new Array(nKeys);
  const rKeyIdx = new Array(nKeys);
  const lSeen = new Set();
  const rSeen = new Set();
  for (let i = 0; i < nKeys; i++) {
    if (typeof lKeys[i] !== "string" || lKeys[i].length === 0) {
      throw new TableOpError("ERR_KEY_SPEC", `leftKeys[${i}] must be a non-empty column id`);
    }
    if (typeof rKeys[i] !== "string" || rKeys[i].length === 0) {
      throw new TableOpError("ERR_KEY_SPEC", `rightKeys[${i}] must be a non-empty column id`);
    }
    if (lSeen.has(lKeys[i])) throw new TableOpError("ERR_KEY_SPEC", `duplicate left key "${lKeys[i]}"`);
    if (rSeen.has(rKeys[i])) throw new TableOpError("ERR_KEY_SPEC", `duplicate right key "${rKeys[i]}"`);
    lSeen.add(lKeys[i]);
    rSeen.add(rKeys[i]);
    if (!leftIdx.has(lKeys[i])) throw new TableOpError("ERR_KEY_SPEC", `left table has no column "${lKeys[i]}"`);
    if (!rightIdx.has(rKeys[i])) throw new TableOpError("ERR_KEY_SPEC", `right table has no column "${rKeys[i]}"`);
    lKeyIdx[i] = leftIdx.get(lKeys[i]);
    rKeyIdx[i] = rightIdx.get(rKeys[i]);
    const lType = left.columns[lKeyIdx[i]].type;
    const rType = right.columns[rKeyIdx[i]].type;
    if (lType !== rType) {
      throw new TableOpError(
        "ERR_KEY_SPEC",
        `key position ${i}: left column "${lKeys[i]}" is ${lType} but right column "${rKeys[i]}" is ${rType}`,
      );
    }
  }

  // Output columns: left ids as-is; colliding right ids renamed deterministically.
  const usedIds = new Set(left.columns.map((c) => c.id));
  const rightOutCols = right.columns.map((col) => {
    let id = col.id;
    if (usedIds.has(id)) {
      do {
        id = `${id}.r`;
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    return { ...col, id };
  });
  const outCols = [...left.columns, ...rightOutCols];
  const nullsLeft = new Array(left.columns.length).fill(null);
  const nullsRight = new Array(right.columns.length).fill(null);

  const probeIsLeft = kind !== "right";
  const probeTab = probeIsLeft ? left : right;
  const indexTab = probeIsLeft ? right : left;
  const probeKeyIdx = probeIsLeft ? lKeyIdx : rKeyIdx;
  const indexKeyIdx = probeIsLeft ? rKeyIdx : lKeyIdx;

  meter.spend(indexTab.rows.length); // index build
  const root = new Map();
  const indexRows = indexTab.rows;
  for (let i = 0; i < indexRows.length; i++) {
    const key = keyTupleOrNull(indexRows[i], indexKeyIdx);
    if (key !== null) trieAdd(root, key, i); // null keys never match: stay out of the index
  }
  meter.spend(probeTab.rows.length); // probe pass

  // For 'full', the left-major pass marks every right row it emits; the rest
  // are appended afterwards in right input order.
  const matchedRight = kind === "full" ? new Uint8Array(right.rows.length) : null;

  const out = [];
  let totalBytes = 0;
  const emitRow = (row) => {
    const rowBytes = JSON.stringify(row).length;
    if (totalBytes + rowBytes > bounds.maxOutputBytes) {
      throw new TableOpError(
        "ERR_OUTPUT_LIMIT",
        `output exceeds maxOutputBytes ${bounds.maxOutputBytes} (already ${totalBytes} bytes, next row ${rowBytes})`,
      );
    }
    meter.spend(1);
    out.push(row);
    totalBytes += rowBytes;
  };
  const emitProbeMatch = (prow, mIdx) => {
    const mrow = indexRows[mIdx];
    if (probeIsLeft) emitRow([...prow, ...mrow]);
    else emitRow([...mrow, ...prow]);
  };
  const emitProbeUnmatched = (prow) => {
    if (probeIsLeft) emitRow([...prow, ...nullsRight]);
    else emitRow([...nullsLeft, ...prow]);
  };

  for (let p = 0; p < probeTab.rows.length; p++) {
    const prow = probeTab.rows[p];
    const key = keyTupleOrNull(prow, probeKeyIdx);
    const leaf = key === null ? null : trieGet(root, key);
    if (leaf !== null && leaf.length > 0) {
      if (matchedRight !== null) {
        for (const m of leaf) matchedRight[m] = 1;
      }
      for (const m of leaf) emitProbeMatch(prow, m);
    } else if (kind !== "inner") {
      emitProbeUnmatched(prow); // left/right outer keep the probe row, null-padded
    }
  }

  if (kind === "full") {
    meter.spend(right.rows.length); // unmatched-right scan
    for (let r = 0; r < right.rows.length; r++) {
      if (matchedRight[r] === 0) emitRow([...nullsLeft, ...right.rows[r]]);
    }
  }

  // Sanity invariant for reviewers: every emitted row has the full output width.
  for (const row of out) {
    if (row.length !== outCols.length) {
      throw new TableOpError("ERR_TABLE_SHAPE", `internal error: emitted row width ${row.length} != ${outCols.length}`);
    }
  }

  return { version: TABLE_VERSION, localeProfile: left.localeProfile, columns: outCols, rows: out };
}

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

/**
 * Explicit ordered-category pivot over one cap.table/1 table.
 *
 * Options (all required):
 *   rowIds:      group-by column ids (1..maxJoinKeys) — distinct first-seen
 *                row groups become output rows (≤ maxPivotRowGroups).
 *   categoryId:  column whose typed values become pivot columns.
 *   categories:  explicit ordered list of category values (1..maxPivotCategories,
 *                non-null, typed like the category column, no duplicates).
 *                Data rows whose category cell is NOT in this list fail the
 *                whole job. Output value columns follow this exact order.
 *   metrics:     1..maxPivotMetrics entries { column, agg, id? } with
 *                agg ∈ count|sum|avg|min|max. 'count' accepts any column type;
 *                the numeric aggs require a 'number' column. `id` (default
 *                "<column>.<agg>") is the output id prefix; the final value
 *                column id is "<id>#<category index>" and must not collide
 *                with a group column or another value column.
 *   bounds / arithmetic: optional overrides (see module header).
 *
 * Output columns: the rowIds columns (defs copied) followed by one 'number'
 * value column per (metric, category), metrics in def order then categories in
 * list order. Buckets with no non-null metric value emit count 0 and null for
 * sum/avg/min/max (missing buckets stay present, never skipped).
 */
export function pivotTable(table, options = {}) {
  const allowed = new Set(["rowIds", "categoryId", "categories", "metrics", "bounds", "arithmetic"]);
  const opts = checkOptions(options, allowed);
  const bounds = checkBounds(opts.bounds);
  const meter = new WorkMeter(bounds.maxWorkUnits);
  const arithmetic = checkArithmetic(opts.arithmetic);

  validateTableShape(table, bounds, meter);

  // ---- pivot spec: rowIds ----
  const rowIds = opts.rowIds;
  if (!Array.isArray(rowIds) || rowIds.length < 1 || rowIds.length > bounds.maxJoinKeys) {
    throw new TableOpError(
      "ERR_PIVOT_SPEC",
      `rowIds needs 1..${bounds.maxJoinKeys} column ids, got ${Array.isArray(rowIds) ? rowIds.length : typeof rowIds}`,
    );
  }
  const colIdx = columnIndexById(table);
  const rowIdx = [];
  const seenRowIds = new Set();
  for (const id of rowIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TableOpError("ERR_PIVOT_SPEC", "rowIds entries must be non-empty column ids");
    }
    if (seenRowIds.has(id)) throw new TableOpError("ERR_PIVOT_SPEC", `duplicate row id "${id}"`);
    seenRowIds.add(id);
    if (!colIdx.has(id)) throw new TableOpError("ERR_PIVOT_SPEC", `table has no column "${id}"`);
    rowIdx.push(colIdx.get(id));
  }

  // ---- pivot spec: category column + ordered categories ----
  const categoryId = opts.categoryId;
  if (typeof categoryId !== "string" || categoryId.length === 0 || !colIdx.has(categoryId)) {
    throw new TableOpError("ERR_PIVOT_SPEC", `categoryId must name an existing column, got ${JSON.stringify(categoryId)}`);
  }
  const catColIdx = colIdx.get(categoryId);
  const catType = table.columns[catColIdx].type;
  const categories = opts.categories;
  if (!Array.isArray(categories)) throw new TableOpError("ERR_PIVOT_SPEC", "categories must be an array");
  if (categories.length < 1) throw new TableOpError("ERR_PIVOT_SPEC", "categories must not be empty");
  if (categories.length > bounds.maxPivotCategories) {
    throw new TableOpError(
      "ERR_PIVOT_WIDTH",
      `${categories.length} categories exceed maxPivotCategories ${bounds.maxPivotCategories}`,
    );
  }
  const catSet = new Set();
  for (const v of categories) {
    const valid =
      v !== null &&
      (catType === "string"
        ? typeof v === "string"
        : catType === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : catType === "boolean"
            ? typeof v === "boolean"
            : false);
    if (!valid) {
      throw new TableOpError("ERR_PIVOT_SPEC", `category ${JSON.stringify(v)} is not a valid ${catType} value`);
    }
    if (catSet.has(v)) throw new TableOpError("ERR_PIVOT_SPEC", `duplicate category ${JSON.stringify(v)}`);
    catSet.add(v);
  }

  // ---- pivot spec: metrics ----
  const metrics = opts.metrics;
  if (!Array.isArray(metrics) || metrics.length < 1) {
    throw new TableOpError("ERR_PIVOT_SPEC", "metrics must be a non-empty array");
  }
  if (metrics.length > bounds.maxPivotMetrics) {
    throw new TableOpError(
      "ERR_PIVOT_WIDTH",
      `${metrics.length} metrics exceed maxPivotMetrics ${bounds.maxPivotMetrics}`,
    );
  }
  const metricDefs = [];
  const metricIdPrefixes = new Set();
  const groupColIds = new Set(rowIds);
  for (let m = 0; m < metrics.length; m++) {
    const def = metrics[m];
    if (def === null || typeof def !== "object" || Array.isArray(def)) {
      throw new TableOpError("ERR_PIVOT_SPEC", `metrics[${m}] must be an object`);
    }
    const column = def.column;
    if (typeof column !== "string" || column.length === 0 || !colIdx.has(column)) {
      throw new TableOpError("ERR_PIVOT_SPEC", `metrics[${m}].column must name an existing column`);
    }
    const agg = def.agg;
    if (!AGGREGATORS.includes(agg)) {
      throw new TableOpError("ERR_PIVOT_SPEC", `metrics[${m}].agg must be one of ${AGGREGATORS.join("|")}, got ${JSON.stringify(agg)}`);
    }
    const colType = table.columns[colIdx.get(column)].type;
    if (agg !== "count" && colType !== NUMBER_TYPE) {
      throw new TableOpError(
        "ERR_PIVOT_SPEC",
        `metrics[${m}]: agg "${agg}" needs a number column, "${column}" is ${colType}`,
      );
    }
    const id = def.id === undefined ? `${column}.${agg}` : def.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new TableOpError("ERR_PIVOT_SPEC", `metrics[${m}].id must be a non-empty string`);
    }
    if (metricIdPrefixes.has(id)) {
      throw new TableOpError("ERR_PIVOT_SPEC", `duplicate metric output id "${id}"`);
    }
    metricIdPrefixes.add(id);
    metricDefs.push({ column, agg, id, col: colIdx.get(column) });
  }

  // ---- value columns (metric-major, then category list order) ----
  const valueCols = [];
  for (const def of metricDefs) {
    for (let j = 0; j < categories.length; j++) {
      const colId = `${def.id}#${j}`;
      if (groupColIds.has(colId)) {
        throw new TableOpError(
          "ERR_PIVOT_SPEC",
          `value column id "${colId}" collides with a row group column`,
        );
      }
      valueCols.push({
        id: colId,
        header: `${def.agg}(${table.columns[def.col].header}) ${String(categories[j])}`,
        type: NUMBER_TYPE,
      });
    }
  }
  // Structural uniqueness: distinct metric prefixes and distinct category
  // indices make "#<j>" suffixes unique; verify rather than assume.
  const allIds = new Set();
  for (const col of [...rowIds.map((id) => id), ...valueCols.map((c) => c.id)]) {
    if (allIds.has(col)) {
      throw new TableOpError("ERR_PIVOT_SPEC", `duplicate output column id "${col}"`);
    }
    allIds.add(col);
  }
  const outCols = [...rowIds.map((id) => table.columns[colIdx.get(id)]), ...valueCols];

  // ---- scan: group rows (first-seen order), bucket by category, aggregate ----
  meter.spend(table.rows.length);
  const root = new Map();
  const groups = [];
  const rows = table.rows;
  const catCellIdx = catColIdx;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cat = row[catCellIdx];
    if (!catSet.has(cat)) {
      throw new TableOpError(
        "ERR_CATEGORY_UNKNOWN",
        `row ${r} has category ${JSON.stringify(cat)} not in the ordered categories list`,
      );
    }
    const tuple = tupleOf(row, rowIdx);
    // Pivot tries store exactly one group object per tuple; the trie leaf is a
    // single-element array (shared trieAdd shape with the join index).
    const leaf = trieGet(root, tuple);
    let group = leaf === null ? null : leaf[0];
    if (group === null) {
      if (groups.length >= bounds.maxPivotRowGroups) {
        throw new TableOpError(
          "ERR_PIVOT_GROUPS",
          `${groups.length} row groups already discovered; exceeds maxPivotRowGroups ${bounds.maxPivotRowGroups}`,
        );
      }
      group = { cells: tuple, accs: metricDefs.map(() => new Map()) };
      groups.push(group);
      trieAdd(root, tuple, group);
    }
    for (let m = 0; m < metricDefs.length; m++) {
      const v = row[metricDefs[m].col];
      if (v === null) continue;
      const accMap = group.accs[m];
      let acc = accMap.get(cat);
      if (acc === undefined) {
        acc = { n: 0, sum: null, min: null, max: null };
        accMap.set(cat, acc);
      }
      acc.n += 1;
      const agg = metricDefs[m].agg;
      if (agg === "sum" || agg === "avg") {
        if (acc.sum === null) acc.sum = v;
        else acc.sum = arithmetic.add(acc.sum, v);
      } else if (agg === "min") {
        if (acc.min === null) acc.min = v;
        else acc.min = arithmetic.min(acc.min, v);
      } else if (agg === "max") {
        if (acc.max === null) acc.max = v;
        else acc.max = arithmetic.max(acc.max, v);
      }
      // 'count' needs only acc.n.
    }
  }

  // ---- emit ----
  const out = [];
  let totalBytes = 0;
  for (const group of groups) {
    const row = group.cells.slice();
    for (let m = 0; m < metricDefs.length; m++) {
      const agg = metricDefs[m].agg;
      const accMap = group.accs[m];
      for (let j = 0; j < categories.length; j++) {
        const acc = accMap.get(categories[j]);
        let cell = EMPTY_CELL[agg];
        if (acc !== undefined) {
          if (agg === "count") cell = acc.n;
          else if (agg === "sum") cell = acc.sum;
          else if (agg === "avg") cell = acc.sum === null ? null : arithmetic.div(acc.sum, acc.n);
          else if (agg === "min") cell = acc.min;
          else cell = acc.max;
        }
        if (cell !== null && (typeof cell !== "number" || !Number.isFinite(cell))) {
          throw new TableOpError(
            "ERR_AGG_RESULT",
            `aggregate ${agg} produced ${JSON.stringify(cell)}, which is not a finite number`,
          );
        }
        row.push(cell);
      }
    }
    const rowBytes = JSON.stringify(row).length;
    if (totalBytes + rowBytes > bounds.maxOutputBytes) {
      throw new TableOpError(
        "ERR_OUTPUT_LIMIT",
        `output exceeds maxOutputBytes ${bounds.maxOutputBytes} (already ${totalBytes} bytes, next row ${rowBytes})`,
      );
    }
    meter.spend(1);
    out.push(row);
    totalBytes += rowBytes;
  }

  return { version: TABLE_VERSION, localeProfile: table.localeProfile, columns: outCols, rows: out };
}
