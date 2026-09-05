// lib/tool-tabular-contracts.js — Tabular & structured data streaming contracts.
// CAP-FB-20260822-WASM-TOOL-PLATFORM-01 (Pillar 3: Tabular & Structured Data, def alignment).
//
// Provides:
//   1. RFC 4180 CSV / TSV streaming parser and formatter with typed values
//   2. JSONL (ndjson) line-by-line parser and serializer
//   3. Tabular operations: select, filter, sort, aggregate (group-by), and slice
//   4. Spreadsheet formula injection defense (safe CSV export neutralizing =, +, -, @, \t, \r)
//   5. Stream-to-stream tabular transformations across OPFS capability references

import {
  createWasmStreamOutput,
  appendWasmStreamInput,
  sealWasmStreamOutput,
  validateSealedWasmStream,
  readWasmStreamWindow,
  discardWasmStream,
} from "./wasm-stream-files.js";
import { decodeCanonicalBase64 } from "./wasm-base64.js";

export const TABULAR_LIMITS = Object.freeze({
  maxCellBytes: 16 * 1024,
  maxColumns: 1024,
  maxPreviewRows: 100,
});

/**
 * Neutralize dangerous formula characters that could execute arbitrary commands
 * or trigger DDE/formula execution when a CSV is opened in Excel, LibreOffice, or Calc.
 */
export function sanitizeFormulaCell(val) {
  if (typeof val !== "string") return val;
  if (/^\s*[=+\-@|]/.test(val) || /^[\t\r\n]/.test(val)) {
    return `'${val}`;
  }
  return val;
}

/**
 * Parse an RFC 4180 CSV string into headers and rows with automatic type preservation.
 */
export function parseCsv(text, { delimiter = ",", hasHeader = true, autoCast = true } = {}) {
  const input = String(text ?? "");
  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const c = input[i];

    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          currentCell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentCell += c;
        i++;
        continue;
      }
    }

    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === delimiter) {
      currentRow.push(castValue(currentCell, autoCast));
      currentCell = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      currentRow.push(castValue(currentCell, autoCast));
      currentCell = "";
      if (currentRow.length > 1 || currentRow[0] !== null) {
        rows.push(currentRow);
      }
      currentRow = [];
      if (c === "\r" && i + 1 < input.length && input[i + 1] === "\n") {
        i += 2;
      } else {
        i++;
      }
    } else {
      currentCell += c;
      i++;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(castValue(currentCell, autoCast));
    if (currentRow.length > 1 || currentRow[0] !== null) {
      rows.push(currentRow);
    }
  }

  if (!rows.length) {
    return { headers: [], rows: [] };
  }

  if (hasHeader) {
    const rawHeaders = rows[0].map((h, idx) => (h != null ? String(h).trim() : `col_${idx}`));
    return { headers: rawHeaders, rows: rows.slice(1) };
  } else {
    const headers = rows[0].map((_, idx) => `col_${idx}`);
    return { headers, rows };
  }
}

function castValue(str, autoCast) {
  if (!autoCast) return str;
  const s = str.trim();
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const num = Number(s);
    if (!Number.isNaN(num)) return num;
  }
  return str;
}

/**
 * Format a tabular dataset into CSV or TSV, escaping quotes, commas, newlines,
 * and neutralizing formula injection characters.
 */
export function formatCsv(headers, rows, { delimiter = ",", sanitizeFormulas = true } = {}) {
  const lines = [];

  const formatCell = (val) => {
    if (val === null || val === undefined) return "";
    let s = sanitizeFormulas ? String(sanitizeFormulaCell(val)) : String(val);
    if (s.includes('"') || s.includes(delimiter) || s.includes("\n") || s.includes("\r")) {
      return `"${s.replaceAll('"', '""')}"`;
    }
    return s;
  };

  if (Array.isArray(headers) && headers.length > 0) {
    lines.push(headers.map(formatCell).join(delimiter));
  }

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    lines.push(row.map(formatCell).join(delimiter));
  }

  return lines.join("\n") + "\n";
}

/**
 * Parse JSONL (newline-delimited JSON) into row objects.
 */
export function parseJsonl(text) {
  const lines = String(text ?? "").split("\n");
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch { /* skip corrupted lines in streaming recovery */ }
  }
  return rows;
}

/**
 * Format array of objects into JSONL string.
 */
export function formatJsonl(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";
}

/**
 * Transform tabular data in memory across filtering, projection, sorting, and grouping.
 */
export function transformTabularData({ headers = [], rows = [] }, operations = []) {
  let currentHeaders = [...headers];
  let currentRows = rows.map((r) => [...r]);

  for (const op of operations) {
    if (!op || typeof op !== "object") continue;

    switch (op.op) {
      case "filter": {
        const colIdx = currentHeaders.indexOf(op.column);
        if (colIdx >= 0) {
          currentRows = currentRows.filter((row) => {
            const val = row[colIdx];
            switch (op.comparison) {
              case "eq": return val === op.value;
              case "neq": return val !== op.value;
              case "gt": return val > op.value;
              case "gte": return val >= op.value;
              case "lt": return val < op.value;
              case "lte": return val <= op.value;
              case "contains": return String(val ?? "").toLowerCase().includes(String(op.value ?? "").toLowerCase());
              default: return true;
            }
          });
        }
        break;
      }
      case "select": {
        if (Array.isArray(op.columns) && op.columns.length > 0) {
          const colIndices = op.columns.map((c) => currentHeaders.indexOf(c)).filter((i) => i >= 0);
          currentHeaders = colIndices.map((i) => currentHeaders[i]);
          currentRows = currentRows.map((r) => colIndices.map((i) => r[i]));
        }
        break;
      }
      case "sort": {
        const colIdx = currentHeaders.indexOf(op.column);
        if (colIdx >= 0) {
          const mult = op.direction === "desc" ? -1 : 1;
          currentRows.sort((a, b) => {
            const va = a[colIdx];
            const vb = b[colIdx];
            if (va === vb) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
            return String(va).localeCompare(String(vb)) * mult;
          });
        }
        break;
      }
      case "slice":
      case "limit": {
        const offset = Math.max(0, Number.isInteger(op.offset) ? op.offset : 0);
        const count = Number.isInteger(op.count) && op.count >= 0 ? op.count : currentRows.length;
        currentRows = currentRows.slice(offset, offset + count);
        break;
      }
      case "aggregate": {
        if (Array.isArray(op.groupBy) && Array.isArray(op.metrics)) {
          const groupIndices = op.groupBy.map((c) => currentHeaders.indexOf(c)).filter((i) => i >= 0);
          const groups = new Map();

          for (const row of currentRows) {
            const key = groupIndices.map((i) => String(row[i] ?? "")).join(":::");
            if (!groups.has(key)) {
              groups.set(key, { keyValues: groupIndices.map((i) => row[i]), items: [] });
            }
            groups.get(key).items.push(row);
          }

          const newHeaders = [
            ...groupIndices.map((i) => currentHeaders[i]),
            ...op.metrics.map((m) => m.as || `${m.metric}_${m.column}`),
          ];

          const newRows = [];
          for (const group of groups.values()) {
            const aggRow = [...group.keyValues];
            for (const m of op.metrics) {
              const cIdx = currentHeaders.indexOf(m.column);
              const vals = group.items.map((r) => (cIdx >= 0 ? r[cIdx] : null)).filter((v) => v != null);
              switch (m.metric) {
                case "count": aggRow.push(group.items.length); break;
                case "sum": aggRow.push(vals.reduce((acc, v) => acc + (Number(v) || 0), 0)); break;
                case "avg": aggRow.push(vals.length ? Math.round((vals.reduce((acc, v) => acc + (Number(v) || 0), 0) / vals.length) * 100) / 100 : 0); break;
                case "min": aggRow.push(vals.length ? Math.min(...vals.map(Number)) : null); break;
                case "max": aggRow.push(vals.length ? Math.max(...vals.map(Number)) : null); break;
                default: aggRow.push(vals.length); break;
              }
            }
            newRows.push(aggRow);
          }
          currentHeaders = newHeaders;
          currentRows = newRows;
        }
        break;
      }
    }
  }

  return { headers: currentHeaders, rows: currentRows };
}

/**
 * Execute a streaming tabular transformation reading from inputRef and writing to outputRef.
 */
export async function streamTabularTransform(inputRef, {
  operations = [],
  outputFormat = "csv",
  delimiter = ",",
  owner,
  storage,
} = {}) {
  const validated = await validateSealedWasmStream({ ref: inputRef, owner, storage });
  const file = await (await validated.directory.getFileHandle(validated.fileName)).getFile();
  const text = await file.text();

  let table;
  if (outputFormat === "jsonl" || validated.fileName.endsWith(".jsonl")) {
    const jsonRows = parseJsonl(text);
    if (jsonRows.length > 0) {
      const headers = Object.keys(jsonRows[0]);
      const rows = jsonRows.map((r) => headers.map((h) => r[h] ?? null));
      table = { headers, rows };
    } else {
      table = { headers: [], rows: [] };
    }
  } else {
    table = parseCsv(text, { delimiter });
  }

  const transformed = transformTabularData(table, operations);

  let outputText;
  if (outputFormat === "jsonl") {
    const objects = transformed.rows.map((row) => {
      const obj = {};
      transformed.headers.forEach((h, idx) => { obj[h] = row[idx]; });
      return obj;
    });
    outputText = formatJsonl(objects);
  } else {
    outputText = formatCsv(transformed.headers, transformed.rows, { delimiter });
  }

  const outputRef = await createWasmStreamOutput({ owner, storage });
  try {
    const dir = await storage?.getDirectory ? await storage.getDirectory() : await navigator.storage.getDirectory();
    const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
    const streamDir = await streams.getDirectoryHandle(outputRef.id);
    const stdoutFile = await streamDir.getFileHandle("stdout.bin");
    const writer = await stdoutFile.createWritable();
    const bytes = new TextEncoder().encode(outputText);
    await writer.write(bytes);
    await writer.close();

    await sealWasmStreamOutput({
      ref: outputRef,
      owner,
      bytes: bytes.byteLength,
      receipt: {
        operation: "tabular-transform",
        rowsIn: table.rows.length,
        rowsOut: transformed.rows.length,
      },
      storage,
    });

    return Object.freeze({
      ok: true,
      outputRef,
      rowsCount: transformed.rows.length,
      columnsCount: transformed.headers.length,
      headers: transformed.headers,
    });
  } catch (err) {
    await discardWasmStream({ ref: outputRef, owner, storage }).catch(() => {});
    throw err;
  }
}
