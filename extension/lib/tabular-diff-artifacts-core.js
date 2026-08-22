// lib/tabular-diff-artifacts-core.js — pure, source-only table-diff custody.
//
// This module parses and validates complete canonical tabular-diff JSON, binds
// runtime/package identity, and plans deterministic opaque byte chunks. It has
// no artifact-store, route, OPFS, DOM, Worker, WebAssembly, network, package
// admission, execution, or mutation imports.

export const TABULAR_DIFF_MEDIA = "application/x-cap-tabular-diff@1";
export const TABULAR_MANIFEST_MEDIA =
  "application/x-cap-tabular-diff-manifest@1";
export const TABULAR_CHUNK_MEDIA = "application/x-cap-tabular-diff-chunk@1";
export const TABULAR_VIEW_MEDIA = "application/x-cap-tabular-diff-view@1";

export const TABULAR_DIFF_LIMITS = Object.freeze({
  maxContentBytes: 1024 * 1024,
  maxInputBytes: 8 * 1024 * 1024,
  maxChunkRawBytes: 180 * 1024,
  maxChunks: 8,
  maxChunkRawTotal: 1024 * 1024,
  maxChunkEnvelopeBytes: 256 * 1024,
  maxManifestBytes: 240 * 1024,
  maxAssetsPerResult: 9,
  maxDepth: 16,
  maxNodes: 200_000,
  maxArrayItems: 100_000,
  maxColumns: 1024,
  maxRows: 100_000,
  maxCellBytes: 16 * 1024,
  maxIdentityBytes: 2048,
  maxPathBytes: 1024,
  maxSegmentBytes: 255,
  maxViewRows: 200,
  maxViewCells: 2000,
  maxViewSourceCellBytes: 8 * 1024,
  maxViewCellBytes: 512,
  maxViewBytes: 512 * 1024,
  maxViewColumns: 256,
  maxAssetIdBytes: 128,
});

const HEX64 = /^[0-9a-f]{64}$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const TOOL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const FORBIDDEN_IDENTITY_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_COLUMN_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function utf8Length(value) {
  return encoder.encode(value).byteLength;
}

function codePointCompare(left, right) {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function canonicalTabularJson(value) {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    if (typeof value === "string" && hasLoneSurrogate(value)) {
      fail("artifact_bad_unicode");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      fail("artifact_invalid_number");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTabularJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") fail("artifact_invalid_value");
  const keys = Object.keys(value).sort(codePointCompare);
  return `{${
    keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalTabularJson(value[key])}`
    ).join(",")
  }}`;
}

export async function tabularSha256Hex(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  if (!bytes || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) {
    fail("hostile_input", "digest bytes");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownData(value, label, { array = false } = {}) {
  try {
    if (value == null || typeof value !== "object") {
      fail("hostile_input", label);
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) fail("hostile_input", label);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail("hostile_input", label);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (
        !descriptor || !("value" in descriptor) || descriptor.get ||
        descriptor.set || !descriptor.enumerable
      ) fail("hostile_input", `${label}.${key}`);
      output[key] = descriptor.value;
    }
    return {
      keys: keys.filter((key) => !(array && key === "length")),
      values: output,
    };
  } catch (error) {
    if (error?.code) throw error;
    fail("hostile_input", label);
  }
}

function snapshot(
  value,
  label = "input",
  depth = 0,
  seen = new WeakSet(),
  budget = { nodes: 0 },
) {
  if (++budget.nodes > 8192 || depth > 32) fail("identity_over_budget", label);
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("hostile_input", label);
    return value;
  }
  if (typeof value !== "object") fail("hostile_input", label);
  try {
    if (Object.getPrototypeOf(value) === Uint8Array.prototype) {
      return new Uint8Array(value);
    }
  } catch {
    fail("hostile_input", label);
  }
  if (seen.has(value)) fail("hostile_input", `${label}: cyclic`);
  seen.add(value);
  let isArray;
  try {
    isArray = Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    fail("hostile_input", label);
  }
  const { keys, values } = ownData(value, label, { array: isArray });
  let output;
  if (isArray) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = descriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) {
      fail("hostile_input", `${label}: sparse or exotic array`);
    }
    output = [];
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(values, String(index))) {
        fail("hostile_input", `${label}[${index}]`);
      }
      output.push(
        snapshot(values[index], `${label}[${index}]`, depth + 1, seen, budget),
      );
    }
  } else {
    output = {};
    for (const key of keys) {
      output[key] = snapshot(
        values[key],
        `${label}.${key}`,
        depth + 1,
        seen,
        budget,
      );
    }
  }
  seen.delete(value);
  return output;
}

function exactKeys(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("artifact_schema", label);
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      fail("artifact_unknown_field", `${label}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("artifact_missing_field", `${label}.${key}`);
    }
  }
}

// A bounded JSON parser is used instead of JSON.parse so duplicate decoded keys
// (including "x" versus "\u0078") cannot be silently collapsed.
function parseBoundedJson(source) {
  let offset = 0;
  const budget = { nodes: 0, items: 0 };
  const whitespace = () => {
    while (/[\u0009\u000a\u000d\u0020]/u.test(source[offset] ?? "")) offset++;
  };
  const node = (depth) => {
    if (
      depth > TABULAR_DIFF_LIMITS.maxDepth ||
      ++budget.nodes > TABULAR_DIFF_LIMITS.maxNodes
    ) fail("artifact_structure_over_budget");
    whitespace();
    const character = source[offset];
    if (character === '"') return string();
    if (character === "{") return object(depth + 1);
    if (character === "[") return array(depth + 1);
    if (source.startsWith("true", offset)) {
      offset += 4;
      return true;
    }
    if (source.startsWith("false", offset)) {
      offset += 5;
      return false;
    }
    if (source.startsWith("null", offset)) {
      offset += 4;
      return null;
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      source.slice(offset),
    );
    if (!match) fail("artifact_json_invalid", `offset ${offset}`);
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0)) {
      fail("artifact_invalid_number");
    }
    return number;
  };
  const string = () => {
    const start = offset++;
    let escaped = false;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (!escaped && code === 0x22) {
        offset++;
        let value;
        try {
          value = JSON.parse(source.slice(start, offset));
        } catch {
          fail("artifact_json_invalid", `offset ${start}`);
        }
        if (hasLoneSurrogate(value)) fail("artifact_bad_unicode");
        if (utf8Length(value) > TABULAR_DIFF_LIMITS.maxCellBytes) {
          fail("artifact_string_over_budget");
        }
        return value;
      }
      if (!escaped && code < 0x20) {
        fail("artifact_json_invalid", `offset ${offset}`);
      }
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      offset++;
    }
    fail("artifact_json_invalid", `offset ${start}`);
  };
  const object = (depth) => {
    offset++;
    whitespace();
    const output = Object.create(null);
    const seen = new Set();
    if (source[offset] === "}") {
      offset++;
      return output;
    }
    while (true) {
      whitespace();
      if (source[offset] !== '"') {
        fail("artifact_json_invalid", `offset ${offset}`);
      }
      const key = string();
      if (seen.has(key)) fail("artifact_duplicate_key", key);
      seen.add(key);
      whitespace();
      if (source[offset++] !== ":") {
        fail("artifact_json_invalid", `offset ${offset - 1}`);
      }
      output[key] = node(depth);
      if (++budget.items > TABULAR_DIFF_LIMITS.maxArrayItems) {
        fail("artifact_structure_over_budget");
      }
      whitespace();
      const separator = source[offset++];
      if (separator === "}") break;
      if (separator !== ",") {
        fail("artifact_json_invalid", `offset ${offset - 1}`);
      }
    }
    return output;
  };
  const array = (depth) => {
    offset++;
    whitespace();
    const output = [];
    if (source[offset] === "]") {
      offset++;
      return output;
    }
    while (true) {
      output.push(node(depth));
      if (++budget.items > TABULAR_DIFF_LIMITS.maxArrayItems) {
        fail("artifact_structure_over_budget");
      }
      whitespace();
      const separator = source[offset++];
      if (separator === "]") break;
      if (separator !== ",") {
        fail("artifact_json_invalid", `offset ${offset - 1}`);
      }
    }
    return output;
  };
  whitespace();
  const value = node(0);
  whitespace();
  if (offset !== source.length) {
    fail("artifact_json_invalid", `offset ${offset}`);
  }
  return value;
}

function bodyBytes(input) {
  if (typeof input === "string") {
    if (input.length > TABULAR_DIFF_LIMITS.maxContentBytes) {
      fail("artifact_size_bound");
    }
    if (hasLoneSurrogate(input)) fail("artifact_bad_unicode");
    const bytes = encoder.encode(input);
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > TABULAR_DIFF_LIMITS.maxContentBytes
    ) fail("artifact_size_bound");
    return { bytes, source: input };
  }
  try {
    if (!input || Object.getPrototypeOf(input) !== Uint8Array.prototype) {
      fail("hostile_input", "artifact bytes");
    }
    if (
      input.byteLength < 1 ||
      input.byteLength > TABULAR_DIFF_LIMITS.maxContentBytes
    ) fail("artifact_size_bound");
    const bytes = new Uint8Array(input);
    let source;
    try {
      source = fatalDecoder.decode(bytes);
    } catch {
      fail("artifact_bad_unicode");
    }
    return { bytes, source };
  } catch (error) {
    if (error?.code) throw error;
    fail("hostile_input", "artifact bytes");
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !HEX64.test(value)) {
    fail("artifact_digest_invalid", label);
  }
  return value;
}

function uint(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("artifact_count_invalid", label);
  }
  return value;
}

function boundedScalar(
  value,
  label,
  maxBytes = TABULAR_DIFF_LIMITS.maxCellBytes,
  { nonempty = false, controls = false } = {},
) {
  if (
    typeof value !== "string" || value.includes("\u0000") ||
    hasLoneSurrogate(value) || (nonempty && !value) ||
    utf8Length(value) > maxBytes ||
    (controls && FORBIDDEN_COLUMN_CONTROLS.test(value))
  ) fail("artifact_string_invalid", label);
  return value;
}

function stringList(
  value,
  label,
  { nonempty = true, max = TABULAR_DIFF_LIMITS.maxColumns } = {},
) {
  if (!Array.isArray(value) || value.length > max) {
    fail("artifact_column_bound", label);
  }
  const output = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const item = boundedScalar(
      value[index],
      `${label}[${index}]`,
      TABULAR_DIFF_LIMITS.maxCellBytes,
      { nonempty, controls: true },
    );
    if (seen.has(item)) fail("artifact_column_duplicate", label);
    seen.add(item);
    output.push(item);
  }
  return output;
}

function sameList(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function compareUtf8(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function compareLocator(left, right) {
  if (Object.hasOwn(left, "index")) return left.index - right.index;
  const length = Math.min(left.key.length, right.key.length);
  for (let index = 0; index < length; index++) {
    const difference = compareUtf8(left.key[index], right.key[index]);
    if (difference !== 0) return difference;
  }
  return left.key.length - right.key.length;
}

function locatorKey(locator) {
  return Object.hasOwn(locator, "index")
    ? `i:${locator.index}`
    : `k:${locator.key.map((part) => `${utf8Length(part)}:${part}`).join("|")}`;
}

function validateLocator(value, mode, keyCount, label) {
  if (mode === "keyed") {
    exactKeys(value, ["key"], ["key"], label);
    if (!Array.isArray(value.key) || value.key.length !== keyCount) {
      fail("artifact_locator_invalid", label);
    }
    return {
      key: value.key.map((part, index) =>
        boundedScalar(part, `${label}.key[${index}]`)
      ),
    };
  }
  exactKeys(value, ["index"], ["index"], label);
  return { index: uint(value.index, `${label}.index`) };
}

function validateRowObject(value, expectedColumns, label) {
  exactKeys(value, expectedColumns, expectedColumns, label);
  const output = Object.create(null);
  for (const column of [...expectedColumns].sort(codePointCompare)) {
    output[column] = boundedScalar(value[column], `${label}.${column}`);
  }
  return output;
}

function validateArtifactObject(raw) {
  exactKeys(raw, [
    "schema",
    "identity",
    "columns",
    "counts",
    "rows",
    "semanticDigest",
    "complete",
  ], [
    "schema",
    "identity",
    "columns",
    "counts",
    "rows",
    "semanticDigest",
    "complete",
  ], "$artifact");
  if (raw.schema !== "cap-tabular-diff-v1") fail("artifact_schema_version");
  if (raw.complete !== true) fail("artifact_incomplete");

  exactKeys(raw.identity, ["engineDigest", "left", "right", "optionsDigest"], [
    "engineDigest",
    "left",
    "right",
    "optionsDigest",
  ], "$artifact.identity");
  const validateBodyRef = (value, label) => {
    exactKeys(value, ["sha256", "size", "sourceGeneration"], [
      "sha256",
      "size",
      "sourceGeneration",
    ], label);
    const size = uint(value.size, `${label}.size`);
    if (size > TABULAR_DIFF_LIMITS.maxInputBytes) {
      fail("artifact_input_size_bound", label);
    }
    return {
      sha256: digest(value.sha256, `${label}.sha256`),
      size,
      sourceGeneration: (() => {
        const generation = boundedScalar(
          value.sourceGeneration,
          `${label}.sourceGeneration`,
          128,
          { nonempty: true, controls: true },
        );
        if (FORBIDDEN_IDENTITY_CONTROLS.test(generation)) {
          fail("artifact_string_invalid", `${label}.sourceGeneration`);
        }
        return generation;
      })(),
    };
  };
  const identity = {
    engineDigest: digest(raw.identity.engineDigest, "identity.engineDigest"),
    left: validateBodyRef(raw.identity.left, "identity.left"),
    right: validateBodyRef(raw.identity.right, "identity.right"),
    optionsDigest: digest(raw.identity.optionsDigest, "identity.optionsDigest"),
  };

  exactKeys(
    raw.columns,
    ["keys", "common", "added", "removed", "ignored", "compared"],
    ["keys", "common", "added", "removed", "ignored", "compared"],
    "$artifact.columns",
  );
  const columns = {
    keys: stringList(raw.columns.keys, "columns.keys"),
    common: stringList(raw.columns.common, "columns.common"),
    added: stringList(raw.columns.added, "columns.added"),
    removed: stringList(raw.columns.removed, "columns.removed"),
    ignored: stringList(raw.columns.ignored, "columns.ignored"),
    compared: stringList(raw.columns.compared, "columns.compared"),
  };
  const mode = columns.keys.length ? "keyed" : "ordered";
  if (columns.keys.length > 4) fail("artifact_key_bound");
  const commonSet = new Set(columns.common);
  const allSchema = [...columns.common, ...columns.added, ...columns.removed];
  if (new Set(allSchema).size !== allSchema.length) {
    fail("artifact_column_conflict");
  }
  for (
    const column of [...columns.keys, ...columns.ignored, ...columns.compared]
  ) if (!commonSet.has(column)) fail("artifact_column_conflict", column);
  const roleSet = new Set([
    ...columns.keys,
    ...columns.ignored,
    ...columns.compared,
  ]);
  if (
    roleSet.size !==
      columns.keys.length + columns.ignored.length + columns.compared.length
  ) fail("artifact_column_conflict");
  const comparedInHeaderOrder = columns.common.filter((column) =>
    columns.compared.includes(column)
  );
  const ignoredInHeaderOrder = columns.common.filter((column) =>
    columns.ignored.includes(column)
  );
  if (
    !sameList(comparedInHeaderOrder, columns.compared) ||
    !sameList(ignoredInHeaderOrder, columns.ignored)
  ) fail("artifact_column_order");

  exactKeys(
    raw.counts,
    ["leftRows", "rightRows", "added", "removed", "changed", "unchanged"],
    ["leftRows", "rightRows", "added", "removed", "changed", "unchanged"],
    "$artifact.counts",
  );
  const counts = {
    leftRows: uint(raw.counts.leftRows, "counts.leftRows"),
    rightRows: uint(raw.counts.rightRows, "counts.rightRows"),
    added: uint(raw.counts.added, "counts.added"),
    removed: uint(raw.counts.removed, "counts.removed"),
    changed: uint(raw.counts.changed, "counts.changed"),
    unchanged: uint(raw.counts.unchanged, "counts.unchanged"),
  };
  if (
    counts.leftRows > TABULAR_DIFF_LIMITS.maxRows ||
    counts.rightRows > TABULAR_DIFF_LIMITS.maxRows
  ) fail("artifact_row_bound");

  exactKeys(raw.rows, ["added", "removed", "changed"], [
    "added",
    "removed",
    "changed",
  ], "$artifact.rows");
  for (const key of ["added", "removed", "changed"]) {
    if (
      !Array.isArray(raw.rows[key]) ||
      raw.rows[key].length > TABULAR_DIFF_LIMITS.maxRows
    ) fail("artifact_row_bound", key);
  }
  const rightColumns = [...columns.common, ...columns.added];
  const leftColumns = [...columns.common, ...columns.removed];
  const seenLocators = new Set();
  const validateOrderAndUniqueness = (rows, label) => {
    let prior = null;
    for (const row of rows) {
      if (prior && compareLocator(prior, row.at) >= 0) {
        fail("artifact_row_order", label);
      }
      prior = row.at;
      const key = locatorKey(row.at);
      if (seenLocators.has(key)) fail("artifact_locator_duplicate", label);
      seenLocators.add(key);
    }
  };
  const validateWholeRows = (list, expectedColumns, label) =>
    list.map((value, index) => {
      exactKeys(value, ["at", "row"], ["at", "row"], `${label}[${index}]`);
      const at = validateLocator(
        value.at,
        mode,
        columns.keys.length,
        `${label}[${index}].at`,
      );
      const row = validateRowObject(
        value.row,
        expectedColumns,
        `${label}[${index}].row`,
      );
      if (
        mode === "keyed" &&
        !sameList(at.key, columns.keys.map((column) => row[column]))
      ) fail("artifact_locator_invalid", `${label}[${index}]`);
      return { at, row };
    });
  const added = validateWholeRows(raw.rows.added, rightColumns, "rows.added");
  validateOrderAndUniqueness(added, "rows.added");
  const removed = validateWholeRows(
    raw.rows.removed,
    leftColumns,
    "rows.removed",
  );
  validateOrderAndUniqueness(removed, "rows.removed");
  const changed = raw.rows.changed.map((value, index) => {
    const label = `rows.changed[${index}]`;
    exactKeys(value, ["at", "cells"], ["at", "cells"], label);
    if (
      !Array.isArray(value.cells) || value.cells.length < 1 ||
      value.cells.length > columns.compared.length
    ) fail("artifact_cell_bound", label);
    const cells = [];
    const seen = new Set();
    let previousColumnIndex = -1;
    for (let cellIndex = 0; cellIndex < value.cells.length; cellIndex++) {
      const cell = value.cells[cellIndex];
      exactKeys(cell, ["column", "before", "after"], [
        "column",
        "before",
        "after",
      ], `${label}.cells[${cellIndex}]`);
      const column = boundedScalar(
        cell.column,
        `${label}.cells[${cellIndex}].column`,
        TABULAR_DIFF_LIMITS.maxCellBytes,
        { nonempty: true, controls: true },
      );
      const comparedIndex = columns.compared.indexOf(column);
      if (
        comparedIndex < 0 || comparedIndex <= previousColumnIndex ||
        seen.has(column)
      ) fail("artifact_cell_order", label);
      previousColumnIndex = comparedIndex;
      seen.add(column);
      const before = boundedScalar(
        cell.before,
        `${label}.cells[${cellIndex}].before`,
      );
      const after = boundedScalar(
        cell.after,
        `${label}.cells[${cellIndex}].after`,
      );
      if (before === after) fail("artifact_cell_noop", label);
      cells.push({ column, before, after });
    }
    return {
      at: validateLocator(value.at, mode, columns.keys.length, `${label}.at`),
      cells,
    };
  });
  validateOrderAndUniqueness(changed, "rows.changed");
  const rows = { added, changed, removed };

  if (
    counts.added !== added.length || counts.removed !== removed.length ||
    counts.changed !== changed.length
  ) fail("artifact_count_mismatch");
  const leftMatched = counts.leftRows - counts.removed;
  const rightMatched = counts.rightRows - counts.added;
  if (
    leftMatched < 0 || rightMatched < 0 || leftMatched !== rightMatched ||
    leftMatched !== counts.changed + counts.unchanged
  ) fail("artifact_count_mismatch");
  if (mode === "ordered") {
    const matched = Math.min(counts.leftRows, counts.rightRows);
    if (
      added.some((row, index) => row.at.index !== matched + index) ||
      removed.some((row, index) => row.at.index !== matched + index) ||
      changed.some((row) => row.at.index >= matched)
    ) fail("artifact_locator_invalid");
  }

  return {
    artifact: {
      schema: "cap-tabular-diff-v1",
      identity,
      columns,
      counts,
      rows,
      semanticDigest: digest(raw.semanticDigest, "semanticDigest"),
      complete: true,
    },
    mode,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export async function validateTabularDiffBytes(input) {
  const { bytes, source } = bodyBytes(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("artifact_bom_unsupported");
  }
  const raw = parseBoundedJson(source);
  const validated = validateArtifactObject(raw);
  const canonical = canonicalTabularJson(validated.artifact);
  if (source !== canonical) fail("artifact_not_canonical");
  const semanticCanonical = canonicalTabularJson({
    columns: validated.artifact.columns,
    counts: validated.artifact.counts,
    rows: validated.artifact.rows,
  });
  const semanticDigest = await tabularSha256Hex(semanticCanonical);
  if (semanticDigest !== validated.artifact.semanticDigest) {
    fail("artifact_semantic_digest_mismatch");
  }
  const contentSha256 = await tabularSha256Hex(bytes);
  return deepFreeze({
    artifact: validated.artifact,
    canonical,
    contentSha256,
    contentSize: bytes.byteLength,
    semanticDigest,
    optionsDigest: validated.artifact.identity.optionsDigest,
    mode: validated.mode,
  });
}

function boundedIdentity(value, label, maxBytes = 256, nullable = false) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" || !value || hasLoneSurrogate(value) ||
    FORBIDDEN_IDENTITY_CONTROLS.test(value) || utf8Length(value) > maxBytes
  ) fail("identity_invalid", label);
  return value;
}

function validateProducer(input) {
  const producer = snapshot(input, "producer");
  const keys = [
    "sourceKind",
    "packageId",
    "toolId",
    "version",
    "sourceToolDigest",
    "packageManifestDigest",
    "packageInventoryDigest",
    "executableSha256",
    "capabilityDigest",
    "replayClass",
  ];
  exactKeys(producer, keys, keys, "producer");
  if (
    producer.sourceKind !== "bundled-package" ||
    producer.toolId !== "tabular_diff_bounded" ||
    producer.replayClass !== "idempotent"
  ) fail("producer_invalid");
  if (
    typeof producer.packageId !== "string" ||
    !PACKAGE_ID.test(producer.packageId) || producer.packageId.includes("..") ||
    producer.packageId.startsWith(".") || producer.packageId.endsWith(".")
  ) fail("producer_invalid", "packageId");
  if (
    typeof producer.toolId !== "string" || !TOOL_ID.test(producer.toolId) ||
    typeof producer.version !== "string" || !SEMVER.test(producer.version)
  ) fail("producer_invalid");
  return {
    sourceKind: "bundled-package",
    packageId: producer.packageId,
    toolId: "tabular_diff_bounded",
    version: producer.version,
    sourceToolDigest: digest(
      producer.sourceToolDigest,
      "producer.sourceToolDigest",
    ),
    packageManifestDigest: digest(
      producer.packageManifestDigest,
      "producer.packageManifestDigest",
    ),
    packageInventoryDigest: digest(
      producer.packageInventoryDigest,
      "producer.packageInventoryDigest",
    ),
    executableSha256: digest(
      producer.executableSha256,
      "producer.executableSha256",
    ),
    capabilityDigest: digest(
      producer.capabilityDigest,
      "producer.capabilityDigest",
    ),
    replayClass: "idempotent",
  };
}

function validateContext(input) {
  const context = snapshot(input, "context");
  const keys = [
    "workspace",
    "executionId",
    "callIndex",
    "runId",
    "agentId",
    "origin",
    "documentId",
  ];
  exactKeys(context, keys, keys, "context");
  if (!Number.isSafeInteger(context.callIndex) || context.callIndex < 0) {
    fail("identity_invalid", "context.callIndex");
  }
  return {
    workspace: boundedIdentity(context.workspace, "context.workspace"),
    executionId: boundedIdentity(
      context.executionId,
      "context.executionId",
      128,
    ),
    callIndex: context.callIndex,
    runId: boundedIdentity(context.runId, "context.runId", 128),
    agentId: boundedIdentity(context.agentId, "context.agentId", 128, true),
    origin: boundedIdentity(context.origin, "context.origin", 2048, true),
    documentId: boundedIdentity(
      context.documentId,
      "context.documentId",
      128,
      true,
    ),
  };
}

function canonicalInputPath(value, label) {
  const path = boundedIdentity(value, label, TABULAR_DIFF_LIMITS.maxPathBytes);
  if (
    !path.startsWith("inputs/") || path.startsWith("/") ||
    path.includes("\\") || path.includes("%") || path.normalize("NFC") !== path
  ) fail("input_path_invalid", label);
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) =>
      !segment || segment === "." || segment === ".." ||
      utf8Length(segment) > TABULAR_DIFF_LIMITS.maxSegmentBytes
    )
  ) fail("input_path_invalid", label);
  return path;
}

function validateInputs(input, artifact) {
  const inputs = snapshot(input, "inputs");
  if (!Array.isArray(inputs) || inputs.length !== 2) fail("inputs_invalid");
  const roles = ["left", "right"];
  return inputs.map((row, index) => {
    const label = `inputs[${index}]`;
    exactKeys(
      row,
      ["role", "relativePath", "sha256", "size", "sourceGeneration"],
      ["role", "relativePath", "sha256", "size", "sourceGeneration"],
      label,
    );
    if (row.role !== roles[index]) fail("inputs_invalid", label);
    const result = {
      role: roles[index],
      relativePath: canonicalInputPath(
        row.relativePath,
        `${label}.relativePath`,
      ),
      sha256: digest(row.sha256, `${label}.sha256`),
      size: uint(row.size, `${label}.size`),
      sourceGeneration: boundedIdentity(
        row.sourceGeneration,
        `${label}.sourceGeneration`,
        128,
      ),
    };
    const bodyRef = artifact.identity[roles[index]];
    if (
      result.sha256 !== bodyRef.sha256 || result.size !== bodyRef.size ||
      result.sourceGeneration !== bodyRef.sourceGeneration
    ) fail("source_receipt_mismatch", roles[index]);
    return result;
  });
}

function validateOptions(input, artifact, mode) {
  const options = snapshot(input, "options");
  const keys = [
    "dialect",
    "header",
    "mode",
    "keys",
    "ignoredColumns",
    "compareColumns",
  ];
  exactKeys(options, keys, keys, "options");
  if (
    options.dialect !== "rfc4180" || options.header !== true ||
    options.mode !== mode
  ) fail("options_invalid");
  const optionKeys = stringList(options.keys, "options.keys", { max: 4 });
  const ignored = stringList(options.ignoredColumns, "options.ignoredColumns");
  let compare = null;
  if (options.compareColumns !== null) {
    compare = stringList(options.compareColumns, "options.compareColumns");
  }
  if (
    !sameList(optionKeys, artifact.columns.keys) ||
    !sameList(ignored, artifact.columns.ignored)
  ) fail("options_mismatch");
  const expectedCompared = compare === null
    ? artifact.columns.common.filter((column) =>
      !optionKeys.includes(column) && !ignored.includes(column)
    )
    : artifact.columns.common.filter((column) => compare.includes(column));
  if (compare !== null && !sameList(compare, expectedCompared)) {
    fail("options_not_normalized");
  }
  if (!sameList(expectedCompared, artifact.columns.compared)) {
    fail("options_mismatch");
  }
  return {
    compareColumns: compare,
    dialect: "rfc4180",
    header: true,
    ignoredColumns: ignored,
    keys: optionKeys,
    mode,
  };
}

function summaryOf(validated) {
  const { artifact, mode } = validated;
  return {
    mode,
    columns: {
      keyCount: artifact.columns.keys.length,
      common: artifact.columns.common.length,
      added: artifact.columns.added.length,
      removed: artifact.columns.removed.length,
      ignored: artifact.columns.ignored.length,
      compared: artifact.columns.compared.length,
    },
    counts: { ...artifact.counts },
    complete: true,
  };
}

async function operationIdentityFrom(
  producerInput,
  contextInput,
  inputsInput,
  validated,
) {
  const producer = validateProducer(producerInput);
  if (validated.artifact.identity.engineDigest !== producer.executableSha256) {
    fail("engine_receipt_mismatch");
  }
  const context = validateContext(contextInput);
  const inputs = validateInputs(inputsInput, validated.artifact);
  const tuple = {
    schemaVersion: 1,
    media: TABULAR_DIFF_MEDIA,
    producer,
    context,
    inputs,
    contentSha256: validated.contentSha256,
    contentSize: validated.contentSize,
    semanticDigest: validated.semanticDigest,
    optionsDigest: validated.optionsDigest,
  };
  return {
    operationIdentity: await tabularSha256Hex(canonicalTabularJson(tuple)),
    tuple,
  };
}

export async function rebuildTabularDiffOperationIdentity(input) {
  const value = ownData(input, "operationInput").values;
  exactKeys(value, ["producer", "context", "inputs", "artifact"], [
    "producer",
    "context",
    "inputs",
    "artifact",
  ], "operationInput");
  const validated = await validateTabularDiffBytes(value.artifact);
  const operation = await operationIdentityFrom(
    value.producer,
    value.context,
    value.inputs,
    validated,
  );
  return deepFreeze({ ...operation, validated });
}

export async function buildTabularDiffIdentity(input) {
  const value = ownData(input, "identityInput").values;
  exactKeys(value, ["producer", "context", "inputs", "options", "artifact"], [
    "producer",
    "context",
    "inputs",
    "options",
    "artifact",
  ], "identityInput");
  const validated = await validateTabularDiffBytes(value.artifact);
  const options = validateOptions(
    value.options,
    validated.artifact,
    validated.mode,
  );
  const optionsDigest = await tabularSha256Hex(canonicalTabularJson(options));
  if (optionsDigest !== validated.optionsDigest) {
    fail("artifact_options_digest_mismatch");
  }
  const operation = await operationIdentityFrom(
    value.producer,
    value.context,
    value.inputs,
    validated,
  );
  return deepFreeze({ ...operation, options, validated });
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function validateLabel(value) {
  if (value == null) return null;
  return boundedIdentity(value, "label", 120);
}

export async function planTabularDiffRetention(input) {
  const value = ownData(input, "retentionInput").values;
  exactKeys(
    value,
    ["producer", "context", "inputs", "options", "artifact", "label"],
    ["producer", "context", "inputs", "options", "artifact"],
    "retentionInput",
  );
  const identity = await buildTabularDiffIdentity({
    producer: value.producer,
    context: value.context,
    inputs: value.inputs,
    options: value.options,
    artifact: value.artifact,
  });
  const bytes = encoder.encode(identity.validated.canonical);
  const chunks = [];
  for (
    let offset = 0, index = 0;
    offset < bytes.length;
    offset += TABULAR_DIFF_LIMITS.maxChunkRawBytes, index++
  ) {
    const chunk = bytes.slice(
      offset,
      Math.min(bytes.length, offset + TABULAR_DIFF_LIMITS.maxChunkRawBytes),
    );
    const sha256 = await tabularSha256Hex(chunk);
    const content = canonicalTabularJson({
      schemaVersion: 1,
      media: TABULAR_CHUNK_MEDIA,
      encoding: "base64",
      sha256,
      size: chunk.byteLength,
      bytes: base64(chunk),
    });
    if (utf8Length(content) > TABULAR_DIFF_LIMITS.maxChunkEnvelopeBytes) {
      fail("chunk_envelope_over_budget", String(index));
    }
    chunks.push({
      index,
      size: chunk.byteLength,
      sha256,
      key: `opfs:tabular-diff:cas:${sha256}`,
      content,
    });
  }
  if (
    chunks.length < 1 || chunks.length > TABULAR_DIFF_LIMITS.maxChunks ||
    chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== bytes.byteLength ||
    bytes.byteLength > TABULAR_DIFF_LIMITS.maxChunkRawTotal
  ) fail("chunk_plan_over_budget");
  const reassembled = new Uint8Array(bytes.byteLength);
  let cursor = 0;
  for (const chunk of chunks) {
    const raw = Uint8Array.from(
      atob(JSON.parse(chunk.content).bytes),
      (character) => character.charCodeAt(0),
    );
    reassembled.set(raw, cursor);
    cursor += raw.byteLength;
  }
  if (
    await tabularSha256Hex(reassembled) !== identity.validated.contentSha256
  ) fail("chunk_plan_digest_mismatch");
  const manifestUpperBound = canonicalTabularJson({
    schema: "cap-tabular-diff-retention-v1",
    media: TABULAR_MANIFEST_MEDIA,
    operationIdentity: identity.operationIdentity,
    content: {
      sha256: identity.validated.contentSha256,
      size: identity.validated.contentSize,
      semanticDigest: identity.validated.semanticDigest,
      optionsDigest: identity.validated.optionsDigest,
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        size: chunk.size,
        sha256: chunk.sha256,
        assetId: "x".repeat(TABULAR_DIFF_LIMITS.maxAssetIdBytes),
      })),
    },
    identity: {
      producer: identity.tuple.producer,
      context: identity.tuple.context,
      inputs: identity.tuple.inputs,
    },
    summary: summaryOf(identity.validated),
  });
  if (utf8Length(manifestUpperBound) > TABULAR_DIFF_LIMITS.maxManifestBytes) {
    fail("manifest_over_budget");
  }
  return deepFreeze({
    schema: "cap-tabular-diff-retention-plan-v1",
    canonicalArtifact: identity.validated.canonical,
    operationIdentity: identity.operationIdentity,
    tuple: identity.tuple,
    options: identity.options,
    summary: summaryOf(identity.validated),
    chunks,
    label: validateLabel(value.label),
    quota: {
      atomicGroup: false,
      capacityReservationAvailable: false,
      orphanCollectionAvailable: false,
      maxAssetsPerResult: TABULAR_DIFF_LIMITS.maxAssetsPerResult,
    },
  });
}

function neutralizeViewText(value) {
  const sourceBytes = utf8Length(value);
  let clean = value.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    "�",
  ).replaceAll("\n", "↵\n").replaceAll("\r", "␍");
  let sourceTruncated = false;
  if (utf8Length(clean) > TABULAR_DIFF_LIMITS.maxViewSourceCellBytes) {
    clean = truncateUtf8(clean, TABULAR_DIFF_LIMITS.maxViewSourceCellBytes);
    sourceTruncated = true;
  }
  const displayTruncated =
    utf8Length(clean) > TABULAR_DIFF_LIMITS.maxViewCellBytes;
  if (displayTruncated) {
    clean = truncateUtf8(clean, TABULAR_DIFF_LIMITS.maxViewCellBytes);
  }
  return {
    text: clean,
    truncated: sourceTruncated || displayTruncated,
    sourceBytes,
    formulaLike: /^[=+\-@]/u.test(value),
  };
}

function truncateUtf8(value, maximum) {
  if (utf8Length(value) <= maximum) return value;
  const ellipsisBytes = utf8Length("…");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(value.slice(0, middle)) <= maximum - ellipsisBytes) {
      low = middle;
    } else high = middle - 1;
  }
  let end = low;
  while (end > 0 && /[\ud800-\udbff]/u.test(value[end - 1])) end--;
  return `${value.slice(0, end)}…`;
}

function viewLocator(locator) {
  return Object.hasOwn(locator, "index")
    ? { index: locator.index }
    : { key: locator.key.map(neutralizeViewText) };
}

function boundedView(base) {
  let bytes = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = utf8Length(canonicalTabularJson({ ...base, bytes }));
    if (next === bytes) break;
    bytes = next;
  }
  const view = { ...base, bytes };
  if (
    utf8Length(canonicalTabularJson(view)) > TABULAR_DIFF_LIMITS.maxViewBytes
  ) fail("view_over_budget");
  return deepFreeze(view);
}

export function deriveTabularDiffPreview(
  validatedInput,
  requestInput,
  operationIdentity,
) {
  const validated = validatedInput?.artifact && validatedInput?.contentSha256
    ? validatedInput
    : null;
  if (
    !validated || typeof operationIdentity !== "string" ||
    !HEX64.test(operationIdentity)
  ) fail("view_invalid_input");
  const request = snapshot(requestInput, "previewRequest");
  if (typeof request.kind !== "string") fail("view_request_invalid");
  const common = {
    kind: request.kind,
    authoritative: false,
    media: TABULAR_VIEW_MEDIA,
    operationIdentity,
    contentSha256: validated.contentSha256,
  };
  if (request.kind === "summary") {
    exactKeys(request, ["kind"], ["kind"], "previewRequest");
    return boundedView({
      ...common,
      items: [summaryOf(validated)],
      page: 0,
      hasMore: false,
    });
  }
  if (request.kind === "schema") {
    exactKeys(request, ["kind", "page", "pageSize"], [
      "kind",
      "page",
      "pageSize",
    ], "previewRequest");
    const page = uint(request.page, "previewRequest.page");
    const pageSize = uint(request.pageSize, "previewRequest.pageSize");
    if (pageSize < 1 || pageSize > TABULAR_DIFF_LIMITS.maxViewRows) {
      fail("view_request_invalid");
    }
    const items = [];
    for (
      const role of [
        "keys",
        "common",
        "added",
        "removed",
        "ignored",
        "compared",
      ]
    ) {
      for (const name of validated.artifact.columns[role]) {
        items.push({ role, name: neutralizeViewText(name) });
      }
    }
    const offset = page * pageSize;
    if (
      !Number.isSafeInteger(offset) || offset > items.length ||
      items.length > TABULAR_DIFF_LIMITS.maxColumns * 6
    ) fail("view_request_invalid");
    const selected = items.slice(
      offset,
      offset + Math.min(pageSize, TABULAR_DIFF_LIMITS.maxViewColumns),
    );
    return boundedView({
      ...common,
      items: selected,
      page,
      hasMore: offset + selected.length < items.length,
    });
  }
  if (request.kind === "rows") {
    exactKeys(request, ["kind", "section", "page", "pageSize"], [
      "kind",
      "section",
      "page",
      "pageSize",
    ], "previewRequest");
    if (!["added", "removed", "changed"].includes(request.section)) {
      fail("view_request_invalid");
    }
    const page = uint(request.page, "previewRequest.page");
    const pageSize = uint(request.pageSize, "previewRequest.pageSize");
    if (pageSize < 1 || pageSize > TABULAR_DIFF_LIMITS.maxViewRows) {
      fail("view_request_invalid");
    }
    const source = validated.artifact.rows[request.section];
    const offset = page * pageSize;
    if (!Number.isSafeInteger(offset) || offset > source.length) {
      fail("view_request_invalid");
    }
    const selected = source.slice(offset, offset + pageSize);
    let cellCount = 0;
    const items = selected.map((row) => {
      const at = viewLocator(row.at);
      if (request.section === "changed") {
        cellCount += row.cells.length;
        return {
          at,
          cells: row.cells.map((cell) => ({
            column: neutralizeViewText(cell.column),
            before: neutralizeViewText(cell.before),
            after: neutralizeViewText(cell.after),
          })),
        };
      }
      const cells = Object.keys(row.row).sort(codePointCompare).map((
        column,
      ) => ({
        column: neutralizeViewText(column),
        value: neutralizeViewText(row.row[column]),
      }));
      cellCount += cells.length;
      return { at, cells };
    });
    if (cellCount > TABULAR_DIFF_LIMITS.maxViewCells) fail("view_over_budget");
    return boundedView({
      ...common,
      section: request.section,
      items,
      page,
      hasMore: offset + selected.length < source.length,
    });
  }
  if (request.kind === "cell") {
    exactKeys(
      request,
      ["kind", "row", "cell"],
      ["kind", "row", "cell"],
      "previewRequest",
    );
    const rowIndex = uint(request.row, "previewRequest.row");
    const cellIndex = uint(request.cell, "previewRequest.cell");
    const row = validated.artifact.rows.changed[rowIndex];
    const cell = row?.cells[cellIndex];
    if (!row || !cell) fail("view_request_invalid");
    return boundedView({
      ...common,
      items: [{
        at: viewLocator(row.at),
        column: neutralizeViewText(cell.column),
        before: neutralizeViewText(cell.before),
        after: neutralizeViewText(cell.after),
      }],
      page: 0,
      hasMore: false,
    });
  }
  fail("view_request_invalid");
}
