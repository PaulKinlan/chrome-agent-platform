// lib/tool-tabular-contracts.js — OPFS facade for the strict bounded table engine.
// The model-facing toolkit and the owner-only tool-stream route share table-core;
// this file owns only compatibility helpers and stream publication.

import {
  createWasmStreamOutput,
  discardWasmStream,
  sealWasmStreamOutput,
  validateSealedWasmStream,
} from "./wasm-stream-files.js";
import {
  assertCanonicalTable,
  canonicalTableJson,
  filterTable,
  formatTableDelimited,
  groupAggregateTable,
  parseTableBytes,
  parseTableFile,
  runBasicTableTool,
  sanitizeFormulaCell,
  selectTable,
  TABLE_LIMITS,
  TABLE_LOCALE_PROFILES,
  TABLE_MEDIA_TYPE,
  TABLE_VERSION,
  TableError,
} from "./table-core.js";

export {
  assertCanonicalTable,
  canonicalTableJson,
  filterTable,
  formatTableDelimited,
  groupAggregateTable,
  parseTableBytes,
  parseTableFile,
  runBasicTableTool,
  sanitizeFormulaCell,
  selectTable,
  TABLE_LOCALE_PROFILES,
  TABLE_MEDIA_TYPE,
  TABLE_VERSION,
  TableError,
};

// Compatibility name retained for the landed Pillar-3 and Unix-isolation KATs.
export const TABULAR_LIMITS = TABLE_LIMITS;

const encoder = new TextEncoder();

function fail(code, detail = "") {
  throw new TableError(code, detail);
}

function legacyValue(value, type) {
  if (value == null) return null;
  if (type.kind === "int64" || type.kind === "decimal") return Number(value);
  return value;
}

function legacyCast(value, autoCast) {
  if (!autoCast || value == null) return value;
  const text = String(value);
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

/** Compatibility parser. Product execution uses parseTableBytes directly. */
export function parseCsv(text, { delimiter = ",", hasHeader = true, autoCast = true } = {}) {
  try {
    const table = parseTableBytes(encoder.encode(String(text ?? "")), {
      delimiter,
      hasHeader,
      schemaMode: "text",
      localeProfile: "canonical-v1",
    });
    return {
      headers: table.columns.map((column) => column.header),
      rows: table.rows.map((row) => row.map((value) => legacyCast(value, autoCast))),
    };
  } catch (error) {
    if (error?.code === "table_cell_bound") throw new Error(`Cell size exceeds ${TABLE_LIMITS.maxCellBytes} bytes`);
    if (error?.code === "table_column_bound") throw new Error(`Column count exceeds ${TABLE_LIMITS.maxColumns}`);
    throw error;
  }
}

export function formatCsvRow(row, { delimiter = ",", sanitizeFormulas = true } = {}) {
  if (delimiter !== "," && delimiter !== "\t") fail("table_delimiter_invalid");
  if (!Array.isArray(row)) fail("table_bad_request", "row");
  const cells = row.map((value) => {
    if (value == null) return "";
    let text = String(sanitizeFormulas ? sanitizeFormulaCell(value) : value);
    if (text.includes('"') || text.includes(delimiter) || text.includes("\n") || text.includes("\r")) {
      text = `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  });
  return cells.join(delimiter) + "\n";
}

/** Compatibility formatter. Safe formula neutralization remains mandatory by default. */
export function formatCsv(headers, rows, { delimiter = ",", sanitizeFormulas = true } = {}) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) fail("table_bad_request");
  return [
    ...(headers.length ? [formatCsvRow(headers, { delimiter, sanitizeFormulas })] : []),
    ...rows.map((row) => formatCsvRow(row, { delimiter, sanitizeFormulas })),
  ].join("");
}

export function parseJsonl(text) {
  const rows = [];
  for (const [index, line] of String(text ?? "").split("\n").entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { fail("table_jsonl_syntax", String(index + 1)); }
  }
  return rows;
}

export function formatJsonl(rows) {
  if (!Array.isArray(rows)) fail("table_bad_request", "rows");
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

/**
 * Compatibility row iterator. It now inherits the strict fatal-UTF8 parser and
 * byte/count bounds instead of maintaining a second permissive CSV parser.
 */
export async function* streamCsvRows(file, { delimiter = ",", autoCast = true } = {}) {
  const table = await parseTableFile(file, {
    delimiter,
    hasHeader: false,
    schemaMode: autoCast ? "infer" : "text",
    localeProfile: "canonical-v1",
  });
  for (const row of table.rows) {
    yield row.map((value, index) => legacyValue(value, table.columns[index].type));
  }
}

function uniqueHeaderIndex(headers, header) {
  const matches = [];
  headers.forEach((value, index) => { if (value === header) matches.push(index); });
  if (!matches.length) fail("table_unknown_column", String(header));
  if (matches.length !== 1) fail("table_ambiguous_header", String(header));
  return matches[0];
}

function typeForLegacyColumn(rows, index) {
  const present = rows.map((row) => row[index]).filter((value) => value != null);
  if (present.length && present.every((value) => typeof value === "boolean")) return { kind: "boolean" };
  if (present.length && present.every((value) => typeof value === "number" && Number.isSafeInteger(value))) return { kind: "int64" };
  if (present.length && present.every((value) => typeof value === "number" && Number.isFinite(value))) {
    const scale = Math.min(18, Math.max(...present.map((value) => (String(value).split(".")[1] ?? "").length)));
    return { kind: "decimal", scale };
  }
  return { kind: "text" };
}

function canonicalFromLegacy({ headers = [], rows = [] }) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) fail("table_bad_request");
  const columns = headers.map((header, index) => ({ id: `c${index + 1}`, header: String(header), type: typeForLegacyColumn(rows, index) }));
  const canonicalRows = rows.map((row) => row.map((value, index) => {
    if (value == null) return null;
    const type = columns[index].type;
    if (type.kind === "int64") return String(value);
    if (type.kind === "decimal") return Number(value).toFixed(type.scale);
    if (type.kind === "text") return String(value);
    return value;
  }));
  return assertCanonicalTable({ version: TABLE_VERSION, localeProfile: "canonical-v1", columns, rows: canonicalRows });
}

function legacyFromCanonical(table) {
  return {
    headers: table.columns.map((column) => column.header),
    rows: table.rows.map((row) => row.map((value, index) => legacyValue(value, table.columns[index].type))),
  };
}

function compareCanonical(left, right, type) {
  if (type.kind === "int64") {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (type.kind === "decimal") {
    const a = BigInt(left.replace(".", ""));
    const b = BigInt(right.replace(".", ""));
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = [...String(left)];
  const b = [...String(right)];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

function applyCompatibilityOperations(inputTable, operations) {
  let table = assertCanonicalTable(inputTable);
  if (!Array.isArray(operations) || operations.length > 16) fail("table_bad_request", "operations");
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") fail("table_bad_request", "operation");
    const headers = table.columns.map((column) => column.header);
    if (operation.op === "filter") {
      const index = uniqueHeaderIndex(headers, operation.column);
      const comparison = operation.comparison;
      const type = table.columns[index].type;
      let value = operation.value;
      if ((type.kind === "int64" || type.kind === "decimal") && typeof value === "number") {
        value = type.kind === "int64" ? String(value) : Number(value).toFixed(type.scale);
      }
      table = filterTable(table, { predicate: { column: `c${index + 1}`, op: comparison, value } }).table;
    } else if (operation.op === "select") {
      if (!Array.isArray(operation.columns) || !operation.columns.length) fail("table_bad_request", "select.columns");
      table = selectTable(table, { columns: operation.columns.map((header) => ({ column: `c${uniqueHeaderIndex(headers, header) + 1}` })) }).table;
    } else if (operation.op === "aggregate") {
      const groupBy = (operation.groupBy ?? []).map((header) => `c${uniqueHeaderIndex(headers, header) + 1}`);
      const metrics = (operation.metrics ?? []).map((metric) => ({
        op: metric.metric === "count" ? "count_rows" : metric.metric,
        ...(metric.metric === "count" ? {} : { column: `c${uniqueHeaderIndex(headers, metric.column) + 1}` }),
        header: metric.as || `${metric.metric}_${metric.column}`,
        ...(metric.metric === "avg" ? { scale: 2 } : {}),
      }));
      table = groupAggregateTable(table, { groupBy, metrics }).table;
    } else if (operation.op === "sort") {
      const index = uniqueHeaderIndex(headers, operation.column);
      const direction = operation.direction === "desc" ? -1 : operation.direction === "asc" || operation.direction == null ? 1 : fail("table_bad_request", "sort.direction");
      const rows = table.rows.map((row, order) => ({ row, order }));
      rows.sort((a, b) => {
        const left = a.row[index];
        const right = b.row[index];
        if (left === right) return a.order - b.order;
        if (left == null) return 1;
        if (right == null) return -1;
        return compareCanonical(left, right, table.columns[index].type) * direction || a.order - b.order;
      });
      table = assertCanonicalTable({ ...table, rows: rows.map((entry) => entry.row) });
    } else if (operation.op === "slice" || operation.op === "limit") {
      const offset = Number.isInteger(operation.offset) && operation.offset >= 0 ? operation.offset : 0;
      const count = Number.isInteger(operation.count) && operation.count >= 0 ? operation.count : table.rows.length;
      table = assertCanonicalTable({ ...table, rows: table.rows.slice(offset, offset + count) });
    } else {
      fail("table_tool_unknown", String(operation.op));
    }
  }
  return table;
}

/** Compatibility operation pipeline, now fail-closed and routed through strict operations. */
export function transformTabularData(input, operations = []) {
  return legacyFromCanonical(applyCompatibilityOperations(canonicalFromLegacy(input), operations));
}

async function writeChunks(writer, bytes) {
  for (let offset = 0; offset < bytes.byteLength; offset += TABLE_LIMITS.chunkSize) {
    await writer.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + TABLE_LIMITS.chunkSize)));
  }
}

/**
 * Owner/run-authorized OPFS transformation facade. The caller derives owner;
 * this function never accepts custody from table content or asset metadata.
 */
export async function streamTabularTransform(inputRef, {
  operations = [],
  outputFormat = "csv",
  delimiter = ",",
  owner,
  storage,
  schemaMode = "infer",
  columns = [],
  localeProfile = "canonical-v1",
} = {}) {
  const validated = await validateSealedWasmStream({ ref: inputRef, owner, storage });
  if (validated.bytes > TABLE_LIMITS.maxInputBytes) fail("table_input_bound", String(TABLE_LIMITS.maxInputBytes));
  const file = await (await validated.directory.getFileHandle(validated.fileName)).getFile();
  const parsed = await parseTableFile(file, {
    delimiter,
    schemaMode,
    columns,
    localeProfile,
  });
  const transformed = applyCompatibilityOperations(parsed, operations);
  const outputRef = await createWasmStreamOutput({ owner, storage });
  let writer = null;
  try {
    const root = storage?.getDirectory ? await storage.getDirectory() : await navigator.storage.getDirectory();
    const streams = await root.getDirectoryHandle("wasm-tool-streams-v1");
    const directory = await streams.getDirectoryHandle(outputRef.id);
    const handle = await directory.getFileHandle("stdout.bin");
    writer = await handle.createWritable();
    let output;
    if (outputFormat === "csv" || outputFormat === "tsv") {
      output = formatTableDelimited(transformed, { format: outputFormat });
    } else if (outputFormat === "jsonl") {
      output = transformed.rows.map((row) => JSON.stringify(Object.fromEntries(row.map((value, index) => [transformed.columns[index].id, value])))).join("\n") + "\n";
    } else if (outputFormat === "table-json") {
      output = canonicalTableJson(transformed);
    } else {
      fail("table_format_invalid", String(outputFormat));
    }
    const bytes = encoder.encode(output);
    if (bytes.byteLength > TABLE_LIMITS.maxOutputBytes) fail("table_output_bound", String(TABLE_LIMITS.maxOutputBytes));
    await writeChunks(writer, bytes);
    await writer.close();
    writer = null;
    await sealWasmStreamOutput({
      ref: outputRef,
      owner,
      bytes: bytes.byteLength,
      receipt: {
        operation: "tabular-transform",
        inputBytes: validated.bytes,
        rowsIn: parsed.rows.length,
        rowsOut: transformed.rows.length,
        columnsOut: transformed.columns.length,
        outputFormat,
        localeProfile,
        bounds: TABLE_LIMITS,
      },
      storage,
    });
    return Object.freeze({
      ok: true,
      outputRef,
      bytes: bytes.byteLength,
      rowsCount: transformed.rows.length,
      columnsCount: transformed.columns.length,
      headers: transformed.columns.map((column) => column.header),
      tableVersion: TABLE_VERSION,
    });
  } catch (error) {
    try { await writer?.abort?.(); } catch { /* cleanup continues */ }
    await discardWasmStream({ ref: outputRef, owner, storage }).catch(() => {});
    throw error;
  }
}
