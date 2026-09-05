// lib/table-join-pivot.js — deterministic typed-tuple table joins and pivots
// over the canonical cap.table/1 strict core (extension/lib/table-core.js).
//
// Two public operations:
//   joinTables(left, right, request) → { table, workUnits }
//   pivotTable(table, request)       → { table, workUnits }
//
// Join kinds: inner, left, right, full.
// 1..8 key columns (TABLE_LIMITS.maxGroupColumns); null/undefined keys never
// match; duplicate keys complete the Cartesian product; left-major then
// right-major order for outer joins.
//
// Pivot: ordered-category row grouping (≤ maxGroups, stable first-seen order),
// 1..maxGroupColumns group-by columns, 1..maxMetrics aggregate metrics
// (count/sum/avg/min/max), unknown category value → TableError.
// All arithmetic uses the strict core's BigInt decimal/int64 helpers.

import {
  TABLE_VERSION,
  TABLE_LIMITS,
  TableError,
  assertCanonicalTable,
  tableUtf8Bytes,
  tableNumericAdd,
  tableNumericAverage,
} from "./table-core.js";

// ── internal helpers ──

function requireCanonical(table, label) {
  try { assertCanonicalTable(table); }
  catch (e) { throw new TableError("table_invalid", `${label}: ${e.message}`); }
}

function rowKey(row, colIds) {
  const parts = [];
  for (const id of colIds) {
    const v = row[id];
    if (v === null || v === undefined) return null; // null keys never match
    parts.push(String(v));
  }
  return parts.join("\x00");
}

// ── join ──

export function joinTables(left, right, request) {
  requireCanonical(left, "left");
  requireCanonical(right, "right");

  const kind = request.kind;
  if (kind !== "inner" && kind !== "left" && kind !== "right" && kind !== "full") {
    throw new TableError("join_kind_invalid", `unsupported join kind: ${kind}`);
  }

  const keys = request.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > TABLE_LIMITS.maxGroupColumns) {
    throw new TableError("join_keys_invalid", `expected 1..${TABLE_LIMITS.maxGroupColumns} key columns`);
  }
  for (const k of keys) {
    if (!k || typeof k.left !== "string" || typeof k.right !== "string") {
      throw new TableError("join_key_shape_invalid", "each key must have string left and right column ids");
    }
  }

  const leftKeyIds = keys.map(k => k.left);
  const rightKeyIds = keys.map(k => k.right);
  for (const id of leftKeyIds) {
    if (!left.columns.some(c => c.id === id)) {
      throw new TableError("join_key_missing", `left column "${id}" not found`);
    }
  }
  for (const id of rightKeyIds) {
    if (!right.columns.some(c => c.id === id)) {
      throw new TableError("join_key_missing", `right column "${id}" not found`);
    }
  }

  let workUnits = 0;

  // Build right-side index
  const rightIndex = new Map();
  for (const row of right.rows) {
    workUnits++;
    const key = rowKey(row, rightKeyIds);
    if (key === null) continue;
    if (!rightIndex.has(key)) rightIndex.set(key, []);
    rightIndex.get(key).push(row);
  }

  // Output columns: all left columns + non-key right columns
  const rightKeySet = new Set(rightKeyIds);
  const outColumns = [];
  for (const c of left.columns) outColumns.push({ ...c });
  for (const c of right.columns) {
    if (kind === "left" && rightKeySet.has(c.id)) continue;
    if (rightKeySet.has(c.id) && left.columns.some(lc => lc.id === c.id)) continue;
    outColumns.push({ ...c });
  }

  // Execute join
  const outRows = [];
  const rightMatched = new Set();

  for (const lrow of left.rows) {
    workUnits++;
    const key = rowKey(lrow, leftKeyIds);
    if (key === null) {
      if (kind === "left" || kind === "full") outRows.push({ ...lrow });
      continue;
    }
    const matches = rightIndex.get(key);
    if (matches && matches.length > 0) {
      for (const rrow of matches) {
        workUnits++;
        rightMatched.add(rrow);
        const combined = {};
        for (const c of left.columns) combined[c.id] = lrow[c.id];
        for (const c of right.columns) {
          if (!rightKeySet.has(c.id)) combined[c.id] = rrow[c.id];
        }
        outRows.push(combined);
      }
    } else {
      if (kind === "left" || kind === "full") outRows.push({ ...lrow });
    }
  }

  // Right-outer: unmatched right rows
  if (kind === "right" || kind === "full") {
    for (const rrow of right.rows) {
      workUnits++;
      const key = rowKey(rrow, rightKeyIds);
      if (key === null || !rightMatched.has(rrow)) {
        const combined = {};
        for (const c of right.columns) combined[c.id] = rrow[c.id];
        outRows.push(combined);
      }
    }
  }

  // Preflight
  const bytes = tableUtf8Bytes({ columns: outColumns, rows: outRows });
  if (bytes > TABLE_LIMITS.maxOutputBytes) {
    throw new TableError("output_too_large", `joined table exceeds ${TABLE_LIMITS.maxOutputBytes} bytes`);
  }
  if (outRows.length > TABLE_LIMITS.maxRows) {
    throw new TableError("too_many_rows", `${outRows.length} rows exceeds max ${TABLE_LIMITS.maxRows}`);
  }

  return {
    table: { version: TABLE_VERSION, localeProfile: left.localeProfile, columns: outColumns, rows: outRows },
    workUnits,
  };
}

// ── pivot ──

export function pivotTable(table, request) {
  requireCanonical(table, "input");

  const rowGroupBy = request.rowGroupBy;
  if (!Array.isArray(rowGroupBy) || rowGroupBy.length < 1 || rowGroupBy.length > TABLE_LIMITS.maxGroupColumns) {
    throw new TableError("pivot_group_invalid", `expected 1..${TABLE_LIMITS.maxGroupColumns} group-by columns`);
  }
  for (const id of rowGroupBy) {
    if (!table.columns.some(c => c.id === id)) {
      throw new TableError("pivot_group_missing", `group-by column "${id}" not found`);
    }
  }

  const pivotColumn = request.pivotColumn;
  if (typeof pivotColumn !== "string" || !table.columns.some(c => c.id === pivotColumn)) {
    throw new TableError("pivot_column_missing", `pivot column "${pivotColumn}" not found`);
  }

  const categories = request.categories;
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > 128) {
    throw new TableError("pivot_categories_invalid", `expected 1..128 categories`);
  }

  const metrics = request.metrics;
  if (!Array.isArray(metrics) || metrics.length < 1 || metrics.length > TABLE_LIMITS.maxMetrics) {
    throw new TableError("pivot_metrics_invalid", `expected 1..${TABLE_LIMITS.maxMetrics} metrics`);
  }

  let workUnits = 0;

  // Stable first-seen group order
  const groupOrder = [];
  const groupMap = new Map();

  for (const row of table.rows) {
    workUnits++;
    const groupKey = rowGroupBy.map(id => String(row[id] ?? "")).join("\x00");
    if (!groupMap.has(groupKey)) {
      const entry = { key: groupKey, values: rowGroupBy.map(id => row[id] ?? null), entries: [] };
      groupMap.set(groupKey, entry);
      groupOrder.push(entry);
    }
    groupMap.get(groupKey).entries.push(row);
  }

  if (groupOrder.length > TABLE_LIMITS.maxGroups) {
    throw new TableError("too_many_groups", `${groupOrder.length} groups exceeds max ${TABLE_LIMITS.maxGroups}`);
  }

  // Build output columns: group-by columns first, then metrics per category
  const outColumns = [];
  rowGroupBy.forEach((id, i) => {
    const src = table.columns.find(c => c.id === id);
    outColumns.push({ id: src?.id ?? id, header: src?.header ?? id, type: src?.type ?? "text" });
  });
  for (const cat of categories) {
    for (const m of metrics) {
      const header = m.header ?? `${m.op}(${cat.value ?? cat.header ?? "?"})`;
      outColumns.push({ id: `c${outColumns.length + 1}`, header, type: m.op === "count" ? "int64" : "decimal" });
    }
  }

  // Aggregate
  const outRows = [];
  for (const entry of groupOrder) {
    const row = {};
    rowGroupBy.forEach((id, i) => { row[id] = entry.values[i]; });

    for (const cat of categories) {
      for (const m of metrics) {
        const matching = entry.entries.filter(r => r[pivotColumn] === cat.value);
        let result;
        if (m.op === "count") {
          result = matching.length;
        } else {
          const col = m.column ?? pivotColumn;
          let acc = null;
          for (const r of matching) {
            workUnits++;
            const v = r[col];
            if (v === null || v === undefined) continue;
            const bn = typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
            if (acc === null) { acc = bn; continue; }
            if (m.op === "sum") acc = acc + bn;
            else if (m.op === "min") acc = bn < acc ? bn : acc;
            else if (m.op === "max") acc = bn > acc ? bn : acc;
          }
          result = acc === null ? null
            : m.op === "avg" ? tableNumericAverage(acc, "int64", BigInt(matching.filter(r => r[col] != null).length), 0)
            : acc;
        }
        row[`${cat.value}:${m.op}`] = result;
      }
    }
    outRows.push(row);
  }

  // Preflight
  const bytes = tableUtf8Bytes({ columns: outColumns, rows: outRows });
  if (bytes > TABLE_LIMITS.maxOutputBytes) {
    throw new TableError("output_too_large", `pivoted table exceeds ${TABLE_LIMITS.maxOutputBytes} bytes`);
  }

  return {
    table: { version: TABLE_VERSION, localeProfile: table.localeProfile, columns: outColumns, rows: outRows },
    workUnits,
  };
}
