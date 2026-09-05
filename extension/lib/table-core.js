// lib/table-core.js — strict, deterministic, bounded local table engine.
// Full table bytes stay local. Callers expose only bounded metadata to models.

export const TABLE_VERSION = "cap.table/1";
export const TABLE_MEDIA_TYPE = "application/x-cap-table+json;version=1";

export const TABLE_LIMITS = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxJoinInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 1024,
  maxCells: 1_000_000,
  maxCellBytes: 16 * 1024,
  maxRowBytes: 256 * 1024,
  maxHeaderBytes: 256,
  maxHeaderTotalBytes: 64 * 1024,
  maxGroups: 4096,
  maxGroupColumns: 8,
  maxMetrics: 16,
  maxPredicateNodes: 64,
  maxPredicateDepth: 8,
  maxWorkUnits: 5_000_000,
  chunkSize: 64 * 1024,
  maxPreviewRows: 50,
  maxPreviewColumns: 20,
  maxPreviewCells: 1000,
  maxPreviewCellBytes: 512,
  maxProviderResultBytes: 16 * 1024,
});

export const TABLE_LOCALE_PROFILES = Object.freeze({
  "canonical-v1": Object.freeze({ decimal: "." }),
  "en-US-v1": Object.freeze({ decimal: "." }),
  "en-GB-v1": Object.freeze({ decimal: "." }),
  "de-DE-v1": Object.freeze({ decimal: "," }),
  "fr-FR-v1": Object.freeze({ decimal: "," }),
});

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const POW10 = [1n];
for (let i = 1; i <= 80; i++) POW10.push(POW10[i - 1] * 10n);

export class TableError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TableError";
    this.code = code;
  }
}

function fail(code, detail = "") {
  throw new TableError(code, detail);
}

export function tableUtf8Bytes(value) {
  return encoder.encode(String(value)).byteLength;
}

function ownObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("table_bad_request", label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("table_bad_request", label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail("table_bad_request", `${label}.${key}`);
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail("table_bad_request", label);
  return value;
}

function exactKeys(value, allowed, required, label) {
  ownObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("table_unknown_field", `${label}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("table_bad_request", `${label}.${key}`);
}

function safeArray(value, label, maximum = Infinity) {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > maximum) fail("table_bad_request", label);
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
    if (typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) fail("table_bad_request", `${label}.${String(key)}`);
  }
  return copy;
}

function codePointCompare(left, right) {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (d) return d;
  }
  return a.length - b.length;
}

function localeProfile(id) {
  const profile = TABLE_LOCALE_PROFILES[id];
  if (!profile) fail("table_locale_invalid", String(id));
  return profile;
}

export function normalizeTableType(input, label = "type") {
  const value = typeof input === "string" ? { kind: input } : input;
  exactKeys(value, ["kind", "scale"], ["kind"], label);
  const kind = value.kind;
  if (!["text", "boolean", "int64", "decimal", "date", "datetime"].includes(kind)) {
    fail("table_type_invalid", `${label}.kind`);
  }
  if (kind === "decimal") {
    if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 18) fail("table_type_invalid", `${label}.scale`);
    return Object.freeze({ kind, scale: value.scale });
  }
  if (Object.hasOwn(value, "scale")) fail("table_unknown_field", `${label}.scale`);
  return Object.freeze({ kind });
}

function decimalSyntax(text, separator) {
  const escaped = separator === "." ? "\\." : ",";
  return new RegExp(`^-?(?:0|[1-9]\\d*)(?:${escaped}\\d+)?$`, "u");
}

function parseDecimalToken(text, profile, { scale = null, maximumPrecision = 38 } = {}) {
  if (typeof text !== "string" || !decimalSyntax(text, profile.decimal).test(text) || text === "-0") {
    fail("table_type_mismatch", "decimal");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(profile.decimal);
  if (whole.length + fraction.length > maximumPrecision) fail("table_numeric_overflow", "decimal precision");
  if (scale != null && fraction.length > scale) fail("table_type_mismatch", "decimal scale");
  const outScale = scale ?? fraction.length;
  let coefficient = BigInt(whole + fraction.padEnd(outScale, "0"));
  if (negative && coefficient === 0n) fail("table_type_mismatch", "negative zero");
  if (negative) coefficient = -coefficient;
  return { coefficient, scale: outScale };
}

function decimalString(coefficient, scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale === 0) return `${negative && coefficient !== 0n ? "-" : ""}${digits}`;
  digits = digits.padStart(scale + 1, "0");
  const at = digits.length - scale;
  return `${negative && coefficient !== 0n ? "-" : ""}${digits.slice(0, at)}.${digits.slice(at)}`;
}

function numericParts(value, type) {
  if (type.kind === "int64") return { coefficient: BigInt(value), scale: 0 };
  if (type.kind === "decimal") return parseDecimalToken(value, TABLE_LOCALE_PROFILES["canonical-v1"], { scale: type.scale, maximumPrecision: 76 });
  fail("table_type_mismatch", "numeric column required");
}

function alignNumeric(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * POW10[scale - left.scale],
    right: right.coefficient * POW10[scale - right.scale],
    scale,
  };
}

function significantDigits(value) {
  return (value < 0n ? -value : value).toString().length;
}

function halfEvenDivide(numerator, denominator) {
  if (denominator === 0n) fail("table_divide_by_zero");
  let sign = 1n;
  if (numerator < 0n) { sign = -sign; numerator = -numerator; }
  if (denominator < 0n) { sign = -sign; denominator = -denominator; }
  let q = numerator / denominator;
  const r = numerator % denominator;
  const twice = r * 2n;
  if (twice > denominator || (twice === denominator && q % 2n !== 0n)) q += 1n;
  return sign * q;
}

export function tableNumericAdd(leftValue, leftType, rightValue, rightType, maximumDigits = 48) {
  const aligned = alignNumeric(numericParts(leftValue, leftType), numericParts(rightValue, rightType));
  const coefficient = aligned.left + aligned.right;
  if (significantDigits(coefficient) > maximumDigits) fail("table_numeric_overflow", "addition");
  if (leftType.kind === "int64" && rightType.kind === "int64") {
    if (coefficient < INT64_MIN || coefficient > INT64_MAX) fail("table_numeric_overflow", "int64");
    return { value: coefficient.toString(), type: { kind: "int64" } };
  }
  return { value: decimalString(coefficient, aligned.scale), type: { kind: "decimal", scale: aligned.scale } };
}

export function tableNumericAverage(sumValue, sumType, count, scale) {
  if (!Number.isSafeInteger(count) || count <= 0) fail("table_bad_request", "average count");
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) fail("table_type_invalid", "average scale");
  const parts = numericParts(sumValue, sumType);
  const numerator = parts.coefficient * POW10[Math.max(0, scale - parts.scale)];
  const denominator = BigInt(count) * POW10[Math.max(0, parts.scale - scale)];
  const coefficient = halfEvenDivide(numerator, denominator);
  if (significantDigits(coefficient) > 38) fail("table_numeric_overflow", "average");
  return { value: decimalString(coefficient, scale), type: { kind: "decimal", scale } };
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

function decodeTypedCell(raw, type, profile) {
  if (raw.text === "" && !raw.quoted) return null;
  const text = raw.text;
  switch (type.kind) {
    case "text": return text;
    case "boolean":
      if (text === "true") return true;
      if (text === "false") return false;
      break;
    case "int64": {
      if (/^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(text) && text !== "-0") {
        const value = BigInt(text);
        if (value >= INT64_MIN && value <= INT64_MAX) return value.toString();
        fail("table_numeric_overflow", "int64");
      }
      break;
    }
    case "decimal": {
      const value = parseDecimalToken(text, profile, { scale: type.scale });
      return decimalString(value.coefficient, type.scale);
    }
    case "date": if (validDate(text)) return text; break;
    case "datetime": if (validDateTime(text)) return text; break;
  }
  fail("table_type_mismatch", type.kind);
}

function inferType(rawRows, column, profile) {
  const cells = rawRows.map((row) => row[column]).filter((cell) => !(cell.text === "" && !cell.quoted));
  if (cells.length === 0) return { kind: "text" };
  if (cells.every((cell) => cell.text === "true" || cell.text === "false")) return { kind: "boolean" };
  if (cells.every((cell) => /^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(cell.text) && cell.text !== "-0")) {
    try {
      if (cells.every((cell) => { const n = BigInt(cell.text); return n >= INT64_MIN && n <= INT64_MAX; })) return { kind: "int64" };
    } catch { /* text fallback */ }
  }
  let maxScale = 0;
  try {
    if (cells.every((cell) => {
      const parsed = parseDecimalToken(cell.text, profile, { maximumPrecision: 38 });
      maxScale = Math.max(maxScale, parsed.scale);
      return maxScale <= 18;
    })) return { kind: "decimal", scale: maxScale };
  } catch { /* text fallback */ }
  return { kind: "text" };
}

class CsvByteParser {
  constructor({ delimiter, limits }) {
    this.delimiter = delimiter;
    this.limits = limits;
    this.state = "start";
    this.cell = [];
    this.cellQuoted = false;
    this.row = [];
    this.rows = [];
    this.rowBytes = 0;
    this.pendingCr = false;
    this.started = false;
    this.preamble = [];
    this.preambleDone = false;
  }
  append(byte) {
    if (this.cell.length >= this.limits.maxCellBytes) fail("table_cell_bound", String(this.limits.maxCellBytes));
    this.cell.push(byte);
  }
  finishCell() {
    let text;
    try { text = fatalDecoder.decode(Uint8Array.from(this.cell)); }
    catch { fail("table_invalid_utf8"); }
    this.row.push({ text, quoted: this.cellQuoted });
    if (this.row.length > this.limits.maxColumns) fail("table_column_bound", String(this.limits.maxColumns));
    this.cell = [];
    this.cellQuoted = false;
    this.state = "start";
  }
  finishRow() {
    this.rows.push(this.row);
    if (this.rows.length > this.limits.maxRows + 1) fail("table_row_bound", String(this.limits.maxRows));
    this.row = [];
    this.rowBytes = 0;
    this.started = false;
  }
  process(byte) {
    this.rowBytes++;
    if (this.rowBytes > this.limits.maxRowBytes) fail("table_row_byte_bound", String(this.limits.maxRowBytes));
    if (this.pendingCr) {
      if (byte !== 0x0a) fail("table_csv_syntax", "CR must be followed by LF");
      this.pendingCr = false;
      this.finishRow();
      return;
    }
    if (this.state === "quoted") {
      if (byte === 0x22) this.state = "afterQuote";
      else this.append(byte);
      return;
    }
    if (this.state === "afterQuote") {
      if (byte === 0x22) { this.append(byte); this.state = "quoted"; return; }
      if (byte === this.delimiter) { this.finishCell(); this.started = true; return; }
      if (byte === 0x0a) { this.finishCell(); this.finishRow(); return; }
      if (byte === 0x0d) { this.finishCell(); this.pendingCr = true; return; }
      fail("table_csv_syntax", "junk after closing quote");
    }
    if (byte === 0x22) {
      if (this.state !== "start" || this.cell.length) fail("table_csv_syntax", "quote inside unquoted cell");
      this.state = "quoted";
      this.cellQuoted = true;
      this.started = true;
      return;
    }
    if (byte === this.delimiter) { this.finishCell(); this.started = true; return; }
    if (byte === 0x0a) { this.finishCell(); this.finishRow(); return; }
    if (byte === 0x0d) { this.finishCell(); this.pendingCr = true; return; }
    this.state = "unquoted";
    this.started = true;
    this.append(byte);
  }
  push(bytes) {
    for (const byte of bytes) {
      if (!this.preambleDone) {
        this.preamble.push(byte);
        const p = this.preamble;
        const possible = p[0] === 0xef && (p.length < 2 || p[1] === 0xbb) && (p.length < 3 || p[2] === 0xbf);
        if (possible && p.length < 3) continue;
        this.preambleDone = true;
        if (p.length === 3 && p[0] === 0xef && p[1] === 0xbb && p[2] === 0xbf) {
          this.preamble = [];
          continue;
        }
        for (const buffered of p) this.process(buffered);
        this.preamble = [];
        continue;
      }
      this.process(byte);
    }
  }
  finish() {
    if (!this.preambleDone) {
      this.preambleDone = true;
      for (const byte of this.preamble) this.process(byte);
      this.preamble = [];
    }
    if (this.pendingCr) fail("table_csv_syntax", "CR must be followed by LF");
    if (this.state === "quoted") fail("table_csv_syntax", "unterminated quoted cell");
    if (this.started || this.row.length || this.cell.length || this.state === "afterQuote") {
      this.finishCell();
      this.finishRow();
    }
    return this.rows;
  }
}

function delimiterByte(format, delimiter) {
  if (delimiter != null) {
    if (delimiter !== "," && delimiter !== "\t") fail("table_delimiter_invalid");
    return delimiter.charCodeAt(0);
  }
  if (format === "csv") return 0x2c;
  if (format === "tsv") return 0x09;
  fail("table_format_invalid", String(format));
}

function tableFromRawRows(rawRows, options = {}) {
  const hasHeader = options.hasHeader !== false;
  if (!rawRows.length) return Object.freeze({ version: TABLE_VERSION, localeProfile: options.localeProfile, columns: Object.freeze([]), rows: Object.freeze([]) });
  const headerRow = hasHeader ? rawRows.shift() : null;
  const width = headerRow?.length ?? rawRows[0]?.length ?? 0;
  if (width > TABLE_LIMITS.maxColumns) fail("table_column_bound", String(TABLE_LIMITS.maxColumns));
  let headerTotal = 0;
  const headers = headerRow
    ? headerRow.map((cell, index) => {
      const bytes = tableUtf8Bytes(cell.text);
      if (bytes > TABLE_LIMITS.maxHeaderBytes) fail("table_header_bound", `c${index + 1}`);
      headerTotal += bytes;
      return cell.text;
    })
    : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  if (headerTotal > TABLE_LIMITS.maxHeaderTotalBytes) fail("table_header_bound", "total");
  for (const row of rawRows) {
    if (row.length > width) fail("table_row_width", String(row.length));
    while (row.length < width) row.push({ text: "", quoted: false });
  }
  if (rawRows.length > TABLE_LIMITS.maxRows) fail("table_row_bound", String(TABLE_LIMITS.maxRows));
  if (rawRows.length * width > TABLE_LIMITS.maxCells) fail("table_cell_count_bound", String(TABLE_LIMITS.maxCells));
  const profile = localeProfile(options.localeProfile);
  let types;
  if (options.schemaMode === "explicit") {
    const supplied = safeArray(options.columns, "columns", TABLE_LIMITS.maxColumns);
    if (supplied.length !== width) fail("table_schema_mismatch", "column count");
    types = supplied.map((column, index) => {
      exactKeys(column, ["type", "header"], ["type"], `columns[${index}]`);
      if (Object.hasOwn(column, "header") && column.header !== headers[index]) fail("table_schema_mismatch", `columns[${index}].header`);
      return normalizeTableType(column.type, `columns[${index}].type`);
    });
  } else if (options.schemaMode === "infer") {
    types = Array.from({ length: width }, (_, index) => normalizeTableType(inferType(rawRows, index, profile)));
  } else if (options.schemaMode === "text") {
    types = Array.from({ length: width }, () => Object.freeze({ kind: "text" }));
  } else {
    fail("table_schema_mode_invalid", String(options.schemaMode));
  }
  const columns = headers.map((header, index) => Object.freeze({ id: `c${index + 1}`, header, type: types[index] }));
  const rows = rawRows.map((row, rowIndex) => Object.freeze(row.map((cell, columnIndex) => {
    try { return decodeTypedCell(cell, types[columnIndex], profile); }
    catch (error) {
      if (error instanceof TableError) error.message += ` at row ${rowIndex + 1}, column c${columnIndex + 1}`;
      throw error;
    }
  })));
  return assertCanonicalTable({ version: TABLE_VERSION, localeProfile: options.localeProfile, columns, rows });
}

function parseOptions(options = {}) {
  ownObject(options, "options");
  const allowed = ["format", "delimiter", "hasHeader", "schemaMode", "columns", "localeProfile"];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) fail("table_unknown_field", `options.${key}`);
  return {
    format: options.format ?? (options.delimiter === "\t" ? "tsv" : "csv"),
    delimiter: options.delimiter,
    hasHeader: options.hasHeader !== false,
    schemaMode: options.schemaMode ?? "text",
    columns: options.columns ?? [],
    localeProfile: options.localeProfile ?? "canonical-v1",
  };
}

export function parseTableBytes(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) fail("table_bad_request", "bytes");
  if (bytes.byteLength > TABLE_LIMITS.maxInputBytes) fail("table_input_bound", String(TABLE_LIMITS.maxInputBytes));
  const parsedOptions = parseOptions(options);
  localeProfile(parsedOptions.localeProfile);
  const parser = new CsvByteParser({ delimiter: delimiterByte(parsedOptions.format, parsedOptions.delimiter), limits: TABLE_LIMITS });
  parser.push(bytes);
  return tableFromRawRows(parser.finish(), parsedOptions);
}

export async function parseTableFile(file, options = {}) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0) fail("table_bad_request", "file");
  if (file.size > TABLE_LIMITS.maxInputBytes) fail("table_input_bound", String(TABLE_LIMITS.maxInputBytes));
  const parsedOptions = parseOptions(options);
  localeProfile(parsedOptions.localeProfile);
  const parser = new CsvByteParser({ delimiter: delimiterByte(parsedOptions.format, parsedOptions.delimiter), limits: TABLE_LIMITS });
  for (let offset = 0; offset < file.size; offset += TABLE_LIMITS.chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + TABLE_LIMITS.chunkSize)).arrayBuffer());
    parser.push(chunk);
  }
  return tableFromRawRows(parser.finish(), parsedOptions);
}

function validateTypedValue(value, type, label) {
  if (value === null) return;
  switch (type.kind) {
    case "text": if (typeof value === "string" && tableUtf8Bytes(value) <= TABLE_LIMITS.maxCellBytes) return; break;
    case "boolean": if (typeof value === "boolean") return; break;
    case "int64": {
      if (typeof value === "string" && /^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(value) && value !== "-0") {
        const n = BigInt(value);
        if (n >= INT64_MIN && n <= INT64_MAX) return;
      }
      break;
    }
    case "decimal": {
      if (typeof value === "string") {
        const parsed = parseDecimalToken(value, TABLE_LOCALE_PROFILES["canonical-v1"], { scale: type.scale });
        if (decimalString(parsed.coefficient, type.scale) === value) return;
      }
      break;
    }
    case "date": if (typeof value === "string" && validDate(value)) return; break;
    case "datetime": if (typeof value === "string" && validDateTime(value)) return; break;
  }
  fail("table_schema_mismatch", label);
}

export function assertCanonicalTable(input) {
  exactKeys(input, ["version", "localeProfile", "columns", "rows"], ["version", "localeProfile", "columns", "rows"], "table");
  if (input.version !== TABLE_VERSION) fail("table_schema_mismatch", "version");
  localeProfile(input.localeProfile);
  const columnsInput = safeArray(input.columns, "table.columns", TABLE_LIMITS.maxColumns);
  const rowsInput = safeArray(input.rows, "table.rows", TABLE_LIMITS.maxRows);
  if (rowsInput.length * columnsInput.length > TABLE_LIMITS.maxCells) fail("table_cell_count_bound", String(TABLE_LIMITS.maxCells));
  const columns = columnsInput.map((column, index) => {
    exactKeys(column, ["id", "header", "type"], ["id", "header", "type"], `table.columns[${index}]`);
    if (column.id !== `c${index + 1}`) fail("table_schema_mismatch", `table.columns[${index}].id`);
    if (typeof column.header !== "string" || tableUtf8Bytes(column.header) > TABLE_LIMITS.maxHeaderBytes) fail("table_header_bound", column.id);
    return Object.freeze({ id: column.id, header: column.header, type: normalizeTableType(column.type, `table.columns[${index}].type`) });
  });
  if (columns.reduce((sum, column) => sum + tableUtf8Bytes(column.header), 0) > TABLE_LIMITS.maxHeaderTotalBytes) fail("table_header_bound", "total");
  const rows = rowsInput.map((row, ri) => {
    safeArray(row, `table.rows[${ri}]`, TABLE_LIMITS.maxColumns);
    if (row.length !== columns.length) fail("table_row_width", String(ri + 1));
    const copy = row.map((value, ci) => { validateTypedValue(value, columns[ci].type, `r${ri + 1}c${ci + 1}`); return value; });
    return Object.freeze(copy);
  });
  const table = Object.freeze({ version: TABLE_VERSION, localeProfile: input.localeProfile, columns: Object.freeze(columns), rows: Object.freeze(rows) });
  if (encoder.encode(JSON.stringify(table)).byteLength > TABLE_LIMITS.maxOutputBytes) fail("table_output_bound", String(TABLE_LIMITS.maxOutputBytes));
  return table;
}

export function canonicalTableJson(table) {
  return JSON.stringify(assertCanonicalTable(table));
}

export function sanitizeFormulaCell(value) {
  if (typeof value !== "string") return value;
  return /^\s*[=+\-@|]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
}

function formatCell(value, type, delimiter, profile = TABLE_LOCALE_PROFILES["canonical-v1"]) {
  if (value === null) return "";
  let text;
  if (type?.kind === "decimal") text = profile.decimal === "." ? value : value.replace(".", profile.decimal);
  else if (type?.kind === "int64" || type?.kind === "date" || type?.kind === "datetime") text = value;
  else if (type?.kind === "boolean") text = value ? "true" : "false";
  else text = String(sanitizeFormulaCell(value));
  if (text.includes('"') || text.includes(delimiter) || text.includes("\n") || text.includes("\r") || text === "") {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function formatTableDelimited(tableInput, { format = "csv" } = {}) {
  const table = assertCanonicalTable(tableInput);
  const delimiter = format === "csv" ? "," : format === "tsv" ? "\t" : fail("table_format_invalid", String(format));
  const profile = localeProfile(table.localeProfile);
  const lines = [table.columns.map((column) => formatCell(column.header, { kind: "text" }, delimiter, profile)).join(delimiter)];
  for (const row of table.rows) lines.push(row.map((value, index) => formatCell(value, table.columns[index].type, delimiter, profile)).join(delimiter));
  const output = lines.join("\n") + "\n";
  if (encoder.encode(output).byteLength > TABLE_LIMITS.maxOutputBytes) fail("table_output_bound", String(TABLE_LIMITS.maxOutputBytes));
  return output;
}

function columnIndex(table, id) {
  if (typeof id !== "string" || !/^c(?:[1-9]\d*)$/u.test(id)) fail("table_unknown_column", String(id));
  const index = Number(id.slice(1)) - 1;
  if (index < 0 || index >= table.columns.length || table.columns[index].id !== id) fail("table_unknown_column", id);
  return index;
}

function compareValues(left, leftType, right, rightType) {
  if ((leftType.kind === "int64" || leftType.kind === "decimal") && (rightType.kind === "int64" || rightType.kind === "decimal")) {
    const aligned = alignNumeric(numericParts(left, leftType), numericParts(right, rightType));
    return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0;
  }
  if (leftType.kind !== rightType.kind) fail("table_type_mismatch", "comparison");
  if (leftType.kind === "boolean") fail("table_type_mismatch", "boolean ordering");
  if (["text", "date", "datetime"].includes(leftType.kind)) return codePointCompare(left, right);
  return left === right ? 0 : left < right ? -1 : 1;
}

function typedConstant(value, type) {
  if (value === null) return null;
  validateTypedValue(value, type, "predicate.value");
  return value;
}

function work(state, amount = 1) {
  if (!state || !Number.isSafeInteger(state.units) || state.units < 0 || !Number.isSafeInteger(amount) || amount < 0) {
    fail("table_bad_request", "work state");
  }
  state.units += amount;
  if (state.units > TABLE_LIMITS.maxWorkUnits) fail("table_work_bound", String(TABLE_LIMITS.maxWorkUnits));
}

function predicateNode(table, node, state, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > TABLE_LIMITS.maxPredicateNodes || depth > TABLE_LIMITS.maxPredicateDepth) fail("table_predicate_bound");
  exactKeys(node, ["all", "any", "not", "column", "op", "value"], [], "predicate");
  const logical = ["all", "any", "not"].filter((key) => Object.hasOwn(node, key));
  const leaf = Object.hasOwn(node, "column") || Object.hasOwn(node, "op") || Object.hasOwn(node, "value");
  if (logical.length + (leaf ? 1 : 0) !== 1) fail("table_bad_request", "predicate shape");
  if (logical[0] === "not") {
    const child = predicateNode(table, node.not, state, depth + 1, budget);
    return (row) => { const value = child(row); return value === null ? null : !value; };
  }
  if (logical.length) {
    const key = logical[0];
    const children = safeArray(node[key], `predicate.${key}`, TABLE_LIMITS.maxPredicateNodes).map((child) => predicateNode(table, child, state, depth + 1, budget));
    if (!children.length) fail("table_bad_request", `predicate.${key}`);
    return (row) => {
      let unknown = false;
      for (const child of children) {
        const value = child(row);
        if (key === "all" && value === false) return false;
        if (key === "any" && value === true) return true;
        if (value === null) unknown = true;
      }
      return unknown ? null : key === "all";
    };
  }
  exactKeys(node, ["column", "op", "value"], ["column", "op"], "predicate");
  const index = columnIndex(table, node.column);
  const type = table.columns[index].type;
  const op = node.op;
  const unary = op === "is_missing" || op === "is_present";
  if (!unary && !Object.hasOwn(node, "value")) fail("table_bad_request", "predicate.value");
  if (unary && Object.hasOwn(node, "value")) fail("table_unknown_field", "predicate.value");
  const allowed = ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "is_missing", "is_present"];
  if (!allowed.includes(op)) fail("table_bad_request", "predicate.op");
  if (op === "contains" && type.kind !== "text") fail("table_type_mismatch", "contains");
  const constant = unary ? null : typedConstant(node.value, type);
  return (row) => {
    work(state);
    const value = row[index];
    if (op === "is_missing") return value === null;
    if (op === "is_present") return value !== null;
    if (value === null || constant === null) return null;
    if (op === "contains") return value.includes(constant);
    const cmp = compareValues(value, type, constant, type);
    return op === "eq" ? cmp === 0 : op === "neq" ? cmp !== 0 : op === "lt" ? cmp < 0 : op === "lte" ? cmp <= 0 : op === "gt" ? cmp > 0 : cmp >= 0;
  };
}

export function filterTable(tableInput, request, state = { units: 0 }) {
  const table = assertCanonicalTable(tableInput);
  exactKeys(request, ["predicate"], ["predicate"], "request");
  const predicate = predicateNode(table, request.predicate, state);
  return { table: assertCanonicalTable({ ...table, rows: table.rows.filter((row) => predicate(row) === true) }), workUnits: state.units };
}

export function selectTable(tableInput, request, state = { units: 0 }) {
  const table = assertCanonicalTable(tableInput);
  exactKeys(request, ["columns"], ["columns"], "request");
  const projections = safeArray(request.columns, "request.columns", TABLE_LIMITS.maxColumns).map((entry, index) => {
    exactKeys(entry, ["column", "header"], ["column"], `request.columns[${index}]`);
    const source = columnIndex(table, entry.column);
    const header = Object.hasOwn(entry, "header") ? entry.header : table.columns[source].header;
    if (typeof header !== "string" || tableUtf8Bytes(header) > TABLE_LIMITS.maxHeaderBytes) fail("table_header_bound", String(index));
    return { source, header, type: table.columns[source].type };
  });
  const columns = projections.map((entry, index) => ({ id: `c${index + 1}`, header: entry.header, type: entry.type }));
  const rows = table.rows.map((row) => {
    work(state, projections.length);
    return projections.map((entry) => row[entry.source]);
  });
  return { table: assertCanonicalTable({ version: TABLE_VERSION, localeProfile: table.localeProfile, columns, rows }), workUnits: state.units };
}

function groupKey(row, indices, columns) {
  return JSON.stringify(indices.map((index) => [columns[index].type.kind, row[index]]));
}

function aggregateMetricType(metric, sourceType) {
  if (metric.op === "count_rows" || metric.op === "count_values") return { kind: "int64" };
  if (metric.op === "avg") return { kind: "decimal", scale: metric.scale };
  return sourceType;
}

export function groupAggregateTable(tableInput, request, state = { units: 0 }) {
  const table = assertCanonicalTable(tableInput);
  exactKeys(request, ["groupBy", "metrics"], ["groupBy", "metrics"], "request");
  const groupIndices = safeArray(request.groupBy, "request.groupBy", TABLE_LIMITS.maxGroupColumns).map((id) => columnIndex(table, id));
  if (new Set(groupIndices).size !== groupIndices.length) fail("table_bad_request", "duplicate group column");
  const metrics = safeArray(request.metrics, "request.metrics", TABLE_LIMITS.maxMetrics).map((metric, index) => {
    exactKeys(metric, ["op", "column", "header", "scale"], ["op", "header"], `request.metrics[${index}]`);
    if (typeof metric.header !== "string" || tableUtf8Bytes(metric.header) > TABLE_LIMITS.maxHeaderBytes) fail("table_header_bound", `metric ${index}`);
    const allowed = ["count_rows", "count_values", "sum", "avg", "min", "max"];
    if (!allowed.includes(metric.op)) fail("table_bad_request", `request.metrics[${index}].op`);
    const needsColumn = metric.op !== "count_rows";
    if (needsColumn !== Object.hasOwn(metric, "column")) fail("table_bad_request", `request.metrics[${index}].column`);
    const source = needsColumn ? columnIndex(table, metric.column) : null;
    const sourceType = source == null ? null : table.columns[source].type;
    if (["sum", "avg"].includes(metric.op) && !["int64", "decimal"].includes(sourceType.kind)) fail("table_type_mismatch", metric.op);
    if (metric.op === "avg") {
      if (!Number.isInteger(metric.scale) || metric.scale < 0 || metric.scale > 18) fail("table_type_invalid", `request.metrics[${index}].scale`);
    } else if (Object.hasOwn(metric, "scale")) fail("table_unknown_field", `request.metrics[${index}].scale`);
    return { ...metric, source, sourceType, outputType: aggregateMetricType(metric, sourceType) };
  });
  const groups = new Map();
  const ensureGroup = (row) => {
    const key = groupKey(row, groupIndices, table.columns);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= TABLE_LIMITS.maxGroups) fail("table_group_bound", String(TABLE_LIMITS.maxGroups));
      group = { keys: groupIndices.map((index) => row[index]), count: 0, metrics: metrics.map(() => ({ count: 0, sum: null, min: null, max: null })) };
      groups.set(key, group);
    }
    return group;
  };
  for (const row of table.rows) {
    work(state, 1 + metrics.length);
    const group = ensureGroup(row);
    group.count++;
    metrics.forEach((metric, index) => {
      const acc = group.metrics[index];
      if (metric.op === "count_rows") return;
      const value = row[metric.source];
      if (value === null) return;
      acc.count++;
      if (metric.op === "sum" || metric.op === "avg") {
        if (acc.sum === null) acc.sum = { value, type: metric.sourceType };
        else acc.sum = tableNumericAdd(acc.sum.value, acc.sum.type, value, metric.sourceType);
      }
      if (metric.op === "min" && (acc.min === null || compareValues(value, metric.sourceType, acc.min, metric.sourceType) < 0)) acc.min = value;
      if (metric.op === "max" && (acc.max === null || compareValues(value, metric.sourceType, acc.max, metric.sourceType) > 0)) acc.max = value;
    });
  }
  if (!groups.size && !groupIndices.length) ensureGroup([]);
  const columns = [
    ...groupIndices.map((source, index) => ({ id: `c${index + 1}`, header: table.columns[source].header, type: table.columns[source].type })),
    ...metrics.map((metric, index) => ({ id: `c${groupIndices.length + index + 1}`, header: metric.header, type: metric.outputType })),
  ];
  const rows = [...groups.values()].map((group) => [
    ...group.keys,
    ...metrics.map((metric, index) => {
      const acc = group.metrics[index];
      if (metric.op === "count_rows") return String(group.count);
      if (metric.op === "count_values") return String(acc.count);
      if (metric.op === "sum") return acc.sum?.value ?? null;
      if (metric.op === "avg") return acc.sum ? tableNumericAverage(acc.sum.value, acc.sum.type, acc.count, metric.scale).value : null;
      if (metric.op === "min") return acc.min;
      return acc.max;
    }),
  ]);
  return { table: assertCanonicalTable({ version: TABLE_VERSION, localeProfile: table.localeProfile, columns, rows }), workUnits: state.units };
}

export function runBasicTableTool(toolId, table, request) {
  const state = { units: 0 };
  if (toolId === "table_filter") return filterTable(table, request, state);
  if (toolId === "table_select") return selectTable(table, request, state);
  if (toolId === "table_group_aggregate") return groupAggregateTable(table, request, state);
  fail("table_tool_unknown", String(toolId));
}
