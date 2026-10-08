// lib/site-tool-audit.js — fail-closed, durable WebMCP consent/invocation WAL.
//
// The service worker is the sole writer. Records are strict, bounded JSONL in
// small OPFS segments. Pagination uses immutable sequence cursors rather than
// shifting array offsets, and retention deletes whole oldest segments only.
// An append resolves only after the file closes; callers must refuse dispatch
// or publication when it rejects.

import { createIncrementalSha256 } from "./incremental-sha256.js";
import { canonicalOrigin } from "./memory.js";
import { appendRecords } from "./run-log-wal.js";

export const SITE_TOOL_AUDIT_VERSION = 1;
export const SITE_TOOL_AUDIT_RETENTION = Object.freeze({
  recordsPerSegment: 128,
  maxSegments: 32,
  maxRetainedRecords: 4096,
  maxRecordBytes: 2048,
  maxPageSize: 100,
});

const SEGMENT_RE = /^events-(\d{16})\.jsonl$/;
const EVENTS = new Set([
  "consent-requested",
  "consent-decided",
  "consent-invalidated",
  "invocation-started",
  "invocation-finished",
  "invocation-blocked",
  "consent-reset",
]);
const DIRECTIONS = new Set([
  "agent-to-owner",
  "owner-to-agent",
  "agent-to-site",
  "site-to-agent",
  "settings-to-agent",
]);
const ACTORS = new Set(["agent", "owner", "settings", "system"]);
const OUTCOMES = new Set([
  "pending",
  "allowed",
  "denied",
  "blocked",
  "succeeded",
  "failed",
  "revoked",
  "expired",
  "unavailable",
  "reset",
  "disabled",
]);
const REASONS = new Set([
  "first-use",
  "owner-allowed",
  "owner-denied",
  "owner-expired",
  "no-owner-channel",
  "cached-allow",
  "owner-direct",
  "sticky-deny",
  "site-policy-deny",
  "authority-changed",
  "page-result",
  "page-error",
  "docs-fallback",
  "settings-tool",
  "settings-site",
  "site-deleted",
  "scripting-disabled",
  "not-enrolled",
  "descriptor-changed",
  "run-not-live",
  "audit-unavailable",
]);
const INPUT_KEYS = new Set([
  "event", "direction", "actor", "origin", "tool", "source",
  "identityDigest", "enrollmentGen", "consentRevision", "executionId",
  "runId", "agentId", "argDigest", "outcome", "reason",
]);
const encoder = new TextEncoder();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function ownData(value, key) {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hashCanonicalArguments(root) {
  const hash = createIncrementalSha256();
  const seen = new Set();
  const stack = [{ kind: "value", value: root }];
  const write = (text) => hash.update(encoder.encode(text));
  while (stack.length) {
    const task = stack.pop();
    if (task.kind === "text") {
      write(task.value);
      continue;
    }
    if (task.kind === "exit") {
      seen.delete(task.value);
      continue;
    }
    const value = task.value;
    if (value === null) { write("null"); continue; }
    if (typeof value === "string" || typeof value === "boolean") {
      write(JSON.stringify(value));
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
      write(JSON.stringify(value));
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) fail("site_tool_audit_arguments");
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) fail("site_tool_audit_arguments");
    seen.add(value);
    stack.push({ kind: "exit", value });
    stack.push({ kind: "text", value: Array.isArray(value) ? "]" : "}" });
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || ownKeys.length !== value.length + 1) fail("site_tool_audit_arguments");
      for (let index = value.length - 1; index >= 0; index--) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("site_tool_audit_arguments");
        stack.push({ kind: "value", value: descriptor.value });
        if (index > 0) stack.push({ kind: "text", value: "," });
      }
      stack.push({ kind: "text", value: "[" });
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) fail("site_tool_audit_arguments");
    const keys = Object.keys(descriptors).sort();
    if (keys.length !== ownKeys.length) fail("site_tool_audit_arguments");
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value === "undefined") {
        fail("site_tool_audit_arguments");
      }
      stack.push({ kind: "value", value: descriptor.value });
      stack.push({ kind: "text", value: ":" });
      stack.push({ kind: "text", value: JSON.stringify(key) });
      if (index > 0) stack.push({ kind: "text", value: "," });
    }
    stack.push({ kind: "text", value: "{" });
  }
  return hash.hex();
}

/** Stable incremental SHA-256 only; raw argument values never enter the audit row. */
export function digestSiteToolArguments(args) {
  try {
    return hashCanonicalArguments(args);
  } catch (error) {
    if (error?.code === "site_tool_audit_arguments") throw error;
    fail("site_tool_audit_arguments");
  }
}

function boundedId(value) {
  return value == null ? null : (typeof value === "string" && value.length <= 200 ? value : fail("site_tool_audit_record"));
}

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("site_tool_audit_record");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail("site_tool_audit_record");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))) {
    fail("site_tool_audit_record");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) fail("site_tool_audit_record");
  }
  const event = ownData(input, "event");
  const direction = ownData(input, "direction");
  const actor = ownData(input, "actor");
  const rawOrigin = ownData(input, "origin");
  const origin = typeof rawOrigin === "string" ? canonicalOrigin(rawOrigin) : null;
  const tool = ownData(input, "tool");
  const source = ownData(input, "source");
  const identityDigest = ownData(input, "identityDigest");
  const enrollmentGen = ownData(input, "enrollmentGen");
  const consentRevision = ownData(input, "consentRevision");
  const argDigest = ownData(input, "argDigest");
  const outcome = ownData(input, "outcome");
  const reason = ownData(input, "reason");
  if (
    !EVENTS.has(event) || !DIRECTIONS.has(direction) || !ACTORS.has(actor) || !origin ||
    typeof tool !== "string" || !tool || tool.length > 128 ||
    (source !== "declared" && source !== "inferred") ||
    typeof identityDigest !== "string" || !/^[0-9a-f]{64}$/.test(identityDigest) ||
    !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1 ||
    !Number.isSafeInteger(consentRevision) || consentRevision < 0 ||
    !(argDigest === null || (typeof argDigest === "string" && /^[0-9a-f]{64}$/.test(argDigest))) ||
    !OUTCOMES.has(outcome) || !REASONS.has(reason)
  ) fail("site_tool_audit_record");
  return {
    event,
    direction,
    actor,
    origin,
    tool,
    source,
    identityDigest,
    enrollmentGen,
    consentRevision,
    executionId: boundedId(ownData(input, "executionId")),
    runId: boundedId(ownData(input, "runId")),
    agentId: boundedId(ownData(input, "agentId")),
    argDigest,
    outcome,
    reason,
  };
}

function validateStoredRow(row, maxRecordBytes) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("site_tool_audit_corrupt");
  const prototype = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) fail("site_tool_audit_corrupt");
  const v = ownData(row, "v");
  const seq = ownData(row, "seq");
  const at = ownData(row, "at");
  if (
    v !== SITE_TOOL_AUDIT_VERSION || !Number.isSafeInteger(seq) || seq < 1 ||
    !Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())
  ) fail("site_tool_audit_corrupt");
  const input = {};
  for (const key of INPUT_KEYS) input[key] = ownData(row, key);
  const normalized = normalizeInput(input);
  const clean = { v, seq, at, ...normalized };
  if (JSON.stringify(clean) !== JSON.stringify(row)) fail("site_tool_audit_corrupt");
  if (encoder.encode(`${JSON.stringify(clean)}\n`).byteLength > maxRecordBytes) fail("site_tool_audit_corrupt");
  return clean;
}

async function readSegment(handle, maxRecordBytes) {
  const file = await handle.getFile();
  if (file.size === 0) return [];
  const text = await file.text();
  // A torn tail is not silently accepted as an empty/shorter audit. Refuse all
  // reads/appends until the owner exports diagnostics or resets the profile.
  if (!text.endsWith("\n")) fail("site_tool_audit_corrupt");
  const rows = [];
  for (const line of text.slice(0, -1).split("\n")) {
    if (!line) fail("site_tool_audit_corrupt");
    let parsed;
    try { parsed = JSON.parse(line); } catch { fail("site_tool_audit_corrupt"); }
    rows.push(validateStoredRow(parsed, maxRecordBytes));
  }
  return rows;
}

async function defaultOpenDirectory() {
  if (!globalThis.navigator?.storage?.getDirectory) fail("site_tool_audit_unavailable");
  const root = await navigator.storage.getDirectory();
  const privateDir = await root.getDirectoryHandle("chrome-agent-platform-private", { create: true });
  return await privateDir.getDirectoryHandle("site-tool-audit-v1", { create: true });
}

function segmentName(firstSequence) {
  return `events-${String(firstSequence).padStart(16, "0")}.jsonl`;
}

async function segmentHandles(directory) {
  if (typeof directory?.entries !== "function") fail("site_tool_audit_unavailable");
  const out = [];
  for await (const [name, handle] of directory.entries()) {
    const match = SEGMENT_RE.exec(name);
    if (!match) continue;
    if (handle?.kind && handle.kind !== "file") fail("site_tool_audit_corrupt");
    const first = Number(match[1]);
    if (!Number.isSafeInteger(first) || first < 1) fail("site_tool_audit_corrupt");
    out.push({ name, first, handle });
  }
  out.sort((a, b) => a.first - b.first);
  for (let index = 1; index < out.length; index++) {
    if (!Number.isSafeInteger(out[index].first) || out[index].first <= out[index - 1].first) {
      fail("site_tool_audit_corrupt");
    }
  }
  return out;
}

function parseCursor(cursor) {
  if (cursor == null || cursor === "") return null;
  if (typeof cursor !== "string") fail("site_tool_audit_cursor");
  const match = /^(older|newer):(\d+)$/.exec(cursor);
  const sequence = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(sequence) || sequence < 1) fail("site_tool_audit_cursor");
  return { direction: match[1], sequence };
}

export function createSiteToolAuditStore({
  openDirectory = defaultOpenDirectory,
  now = () => Date.now(),
  recordsPerSegment = SITE_TOOL_AUDIT_RETENTION.recordsPerSegment,
  maxSegments = SITE_TOOL_AUDIT_RETENTION.maxSegments,
  maxRecordBytes = SITE_TOOL_AUDIT_RETENTION.maxRecordBytes,
  maxPageSize = SITE_TOOL_AUDIT_RETENTION.maxPageSize,
} = {}) {
  if (
    typeof openDirectory !== "function" || typeof now !== "function" ||
    !Number.isSafeInteger(recordsPerSegment) || recordsPerSegment < 1 ||
    !Number.isSafeInteger(maxSegments) || maxSegments < 1 ||
    !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 256 ||
    !Number.isSafeInteger(maxPageSize) || maxPageSize < 1
  ) fail("site_tool_audit_config");
  let mutex = Promise.resolve();
  const locked = (fn) => {
    const run = mutex.then(fn, fn);
    mutex = run.then(() => {}, () => {});
    return run;
  };

  async function readRows(directory, segments = null) {
    const listed = segments ?? await segmentHandles(directory);
    const all = [];
    let previous = null;
    for (let segmentIndex = 0; segmentIndex < listed.length; segmentIndex++) {
      const segment = listed[segmentIndex];
      const rows = await readSegment(segment.handle, maxRecordBytes);
      // Only the newest segment may be empty (a file may have been created
      // immediately before an append failed). Every older segment is complete;
      // retention removes only a contiguous prefix, never an interior segment.
      if (rows.length === 0) {
        if (segmentIndex !== listed.length - 1) fail("site_tool_audit_corrupt");
        continue;
      }
      if (
        rows[0].seq !== segment.first || rows.length > recordsPerSegment ||
        (segmentIndex < listed.length - 1 && rows.length !== recordsPerSegment)
      ) fail("site_tool_audit_corrupt");
      for (const row of rows) {
        if (previous != null && row.seq !== previous + 1) fail("site_tool_audit_corrupt");
        previous = row.seq;
        all.push(row);
      }
    }
    return all;
  }

  return Object.freeze({
    async append(input) {
      const normalized = normalizeInput(input);
      return await locked(async () => {
        const directory = await openDirectory();
        let segments = await segmentHandles(directory);
        const rows = await readRows(directory, segments);
        const sequence = rows.length ? rows[rows.length - 1].seq + 1 : 1;
        if (!Number.isSafeInteger(sequence)) fail("site_tool_audit_sequence");
        const at = now();
        if (!Number.isSafeInteger(at) || at < 0) fail("site_tool_audit_clock");
        const row = { v: SITE_TOOL_AUDIT_VERSION, seq: sequence, at, ...normalized };
        if (encoder.encode(`${JSON.stringify(row)}\n`).byteLength > maxRecordBytes) {
          fail("site_tool_audit_record_size");
        }
        let active = segments[segments.length - 1] ?? null;
        const activeCount = active ? rows.filter((candidate) => candidate.seq >= active.first).length : 0;
        const needsSegment = !active || activeCount >= recordsPerSegment;
        // Enforce retention BEFORE adding bytes. If deletion is unavailable,
        // this append fails without allowing a persistent cleanup failure to
        // grow an unbounded 33rd/34th segment.
        const targetSegmentCount = needsSegment ? maxSegments - 1 : maxSegments;
        while (segments.length > targetSegmentCount) {
          const oldest = segments[0];
          await directory.removeEntry(oldest.name);
          segments.shift();
        }
        if (needsSegment) {
          const name = segmentName(sequence);
          active = { name, first: sequence, handle: await directory.getFileHandle(name, { create: true }) };
          segments.push(active);
        }
        await appendRecords(active.handle, [row]);
        return Object.freeze({ ...row });
      });
    },

    async list({ cursor = null, limit = 25 } = {}) {
      const parsedCursor = parseCursor(cursor);
      const pageLimit = Number.isSafeInteger(limit)
        ? Math.max(1, Math.min(limit, maxPageSize))
        : Math.min(25, maxPageSize);
      return await locked(async () => {
        const directory = await openDirectory();
        const rows = await readRows(directory);
        let pageAscending;
        if (!parsedCursor) {
          pageAscending = rows.slice(-pageLimit);
        } else if (parsedCursor.direction === "older") {
          pageAscending = rows.filter((row) => row.seq < parsedCursor.sequence).slice(-pageLimit);
        } else {
          pageAscending = rows.filter((row) => row.seq > parsedCursor.sequence).slice(0, pageLimit);
        }
        const records = pageAscending.slice().reverse().map((row) => Object.freeze({ ...row }));
        const firstRetained = rows[0]?.seq ?? null;
        const lastRetained = rows[rows.length - 1]?.seq ?? null;
        const pageMin = pageAscending[0]?.seq ?? null;
        const pageMax = pageAscending[pageAscending.length - 1]?.seq ?? null;
        return Object.freeze({
          ok: true,
          records: Object.freeze(records),
          olderCursor: pageMin != null && firstRetained < pageMin ? `older:${pageMin}` : null,
          newerCursor: pageMax != null && lastRetained > pageMax ? `newer:${pageMax}` : null,
          historyTruncated: firstRetained != null && firstRetained > 1,
          firstRetainedSequence: firstRetained,
          lastRetainedSequence: lastRetained,
          retention: Object.freeze({
            recordsPerSegment,
            maxSegments,
            maxRetainedRecords: recordsPerSegment * maxSegments,
            maxRecordBytes,
          }),
        });
      });
    },

    /** Run a profile-wide mutation after every queued append/list and prevent
     * later audit work from interleaving until it settles. Factory reset uses
     * this to remove OPFS without a stale append recreating the audit tree. */
    async runExclusive(operation) {
      if (typeof operation !== "function") fail("site_tool_audit_config");
      return await locked(operation);
    },
  });
}

const siteToolAuditStore = createSiteToolAuditStore();

export async function appendSiteToolAudit(record) {
  return await siteToolAuditStore.append(record);
}

export async function listSiteToolAudit(options) {
  return await siteToolAuditStore.list(options);
}

export async function withSiteToolAuditBarrier(operation) {
  return await siteToolAuditStore.runExclusive(operation);
}
