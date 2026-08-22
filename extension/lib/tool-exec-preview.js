// lib/tool-exec-preview.js — Settings-only bounded Wasm tool execution
// (CAP-FB-20260822-TOOL-PREVIEW-EXEC-01). The FIRST real bundled execution:
// a single technically-admitted package (cap.bundled.csvtool) may be run ONLY
// from the exact Settings options document by an EXPLICIT owner click.
//
// Invariants:
//   - NO package catalog/provider selection authority: the catalog summary stays
//     metadata-only; there is no selection route, no provider binding, no
//     capability grant — the preview is a self-contained owner-requested run.
//   - IMMUTABLE revalidation at every execution: the bundled manifest is
//     re-parsed + re-validated through the REAL authority, its digest must
//     equal the immutable inventory row, and the CAS bytes must re-match the
//     manifest executable's sha256 + size; auditWasmBinary re-checks
//     imports/memory; capabilities are re-verified against the manifest.
//   - STRICT bounds: args/stdin/output/wall-time are bounded by PREVIEW_LIMITS;
//     the executor's own bounds still apply on the worker side.
//   - This module is scanner-clean: no `new Worker`, no `WebAssembly.` direct
//     calls — the fresh-Worker execution lives in the canonical executor/
//     offscreen host (scanner-owned exemptions), reached only through the
//     reviewed offscreen document.

import { createWasiJob } from "./wasm-host-types.js";
import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";

const EXECUTOR_REQUEST_MAX_BYTES = EXECUTOR_BOUNDS.maxRequestBytes;
import {
  WasmPackageAuthority,
  auditWasmBinary,
  WASM_PACKAGE_LIMITS,
} from "./wasm-package-authority.js";

export const PREVIEW_LIMITS = Object.freeze({
  maxArgs: 4,
  maxArgBytes: 512,
  maxArgTotalBytes: 1024,
  // The executor request envelope is JSON-bounded (EXECUTOR_BOUNDS.maxRequestBytes
  // 64 KiB) and carries the wasm bytes as a JSON number array (~40 KB for the
  // csvtool). The stdin therefore MUST stay small enough for the whole envelope
  // to fit — 2 KiB is the honest bound for a settings preview sample.
  maxStdinBytes: 2 * 1024,
  // Bounded by the WASI host hard caps (MAX_STDOUT_BYTES 1 MiB, MAX_STDERR 256 KiB).
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  wallMs: 5000,
  maxOutputTextBytes: 256 * 1024,
});

export const PREVIEW_PACKAGE_ID = "cap.bundled.csvtool";
export const PREVIEW_TOOL_ID = "csvtool";
// The reserved https origin representing the exact Settings surface in the WASI
// job context (boundedOrigin accepts http(s) only — chrome-extension:// cannot
// be a WASI job origin). Never routable, never a web origin.
export const PREVIEW_SETTINGS_ORIGIN = "https://settings.cap";

const HEX64_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const encoder = new TextEncoder();

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function plainData(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function utf8Bytes(value) {
  return encoder.encode(String(value)).byteLength;
}

function randomHex(bytes) {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The explicit wasm-bytes transport: Chrome runtime messaging JSON-serializes
// typed arrays, so a Uint8Array never arrives as `instanceof Uint8Array` on the
// receiving side. The SW sends an explicit Array.from(casBytes) array and the
// options host STRICTLY validates + rehydrates it before the host contract
// (which requires a genuine Uint8Array). Bound: 8 bytes .. maxRequestBytes.
export function rehydratePreviewWasmBytes(value) {
  if (!Array.isArray(value) || value.length < 8 ||
      value.length > EXECUTOR_REQUEST_MAX_BYTES) {
    fail("preview_wasm_transport");
  }
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      fail("preview_wasm_transport");
    }
    out[index] = byte;
  }
  return out;
}

// The stdin transport rehydration: createWasiJob on the SW side emits the
// stdin as a FROZEN PLAIN byte array, which the generic offscreen-host contract
// (createWasiJob) rejects (it requires a genuine Uint8Array). The options host
// STRICTLY validates + rehydrates a dense byte array (0..maxStdinBytes, every
// element an integer 0..255, no holes) and clones the job before handleJob.
export function rehydratePreviewStdin(value) {
  if (!Array.isArray(value)) fail("preview_stdin_transport");
  if (value.length > PREVIEW_LIMITS.maxStdinBytes) fail("preview_stdin_transport");
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      fail("preview_stdin_transport");
    }
    out[index] = byte;
  }
  return out;
}

/** The route's LOCAL extraction from the runtime message. The global
 * dispatcher passes the message body (which carries `type`) straight to the
 * handler, so the strict validator would reject it; this extracts ONLY
 * `args` + `stdin` so the standard `{type,args,stdin}` message works and ANY
 * extra key (hostile or accidental) can never reach the validator/executor.
 * The global dispatch is deliberately NOT modified. */
export function extractPreviewInput(message) {
  if (!plainData(message)) return message; // let the validator reject the shape
  return { args: message.args, stdin: message.stdin };
}

/** The STRICT exact-key bounded preview request: ONLY `args` + `stdin`.
 * Nothing else may reach the executor (no fences, no package bytes, no
 * capability claims — the SW supplies those). */
export function validatePreviewInput(raw) {
  if (!plainData(raw)) fail("preview_request_shape");
  if (
    JSON.stringify(Object.keys(raw).sort()) !==
    JSON.stringify(["args", "stdin"].sort())
  ) fail("preview_request_shape");
  if (!Array.isArray(raw.args) || raw.args.length > PREVIEW_LIMITS.maxArgs) {
    fail("preview_args");
  }
  let totalBytes = 0;
  const args = raw.args.map((arg) => {
    if (typeof arg !== "string" || arg.includes("\0")) fail("preview_args");
    const bytes = utf8Bytes(arg);
    if (bytes > PREVIEW_LIMITS.maxArgBytes) fail("preview_args");
    totalBytes += bytes;
    return arg;
  });
  if (totalBytes > PREVIEW_LIMITS.maxArgTotalBytes) fail("preview_args");
  if (typeof raw.stdin !== "string") fail("preview_stdin");
  const stdinBytes = utf8Bytes(raw.stdin);
  if (stdinBytes > PREVIEW_LIMITS.maxStdinBytes) fail("preview_stdin");
  return Object.freeze({ args: Object.freeze(args), stdin: raw.stdin });
}

/** Build the host-bound authority fence record for a settings preview run.
 * The fences are synthesized by the trusted Settings surface (the SW route) —
 * never request-borne. `origin` is the extension's own origin.
 * @param {{ origin: string, documentId?: string, now?: (() => number) | null }} [options] */
export function buildPreviewAuthority({ origin, documentId = "settings-options", now = null } = {}) {
  if (typeof origin !== "string" || !origin) fail("preview_authority_origin");
  const at = (now ?? (() => Date.now()))();
  const executionId = `settings-${at.toString(36)}-${randomHex(4)}`;
  const callId = `preview-${randomHex(4)}`;
  if (!ID_RE.test(executionId) || !ID_RE.test(callId)) fail("preview_authority_id");
  return Object.freeze({
    sessionId: `settings-preview-${randomHex(6)}`,
    executionId,
    callId,
    agentId: "settings-owner",
    origin,
    documentId,
  });
}

/** Build the bounded WasiJob from a validated preview input + the authority. */
export function buildPreviewJob({ input, authority, quota = null }) {
  if (!plainData(authority) ||
      JSON.stringify(Object.keys(authority).sort()) !==
        JSON.stringify(["agentId", "callId", "documentId", "executionId", "origin", "sessionId"].sort()) ||
      typeof authority.executionId !== "string" ||
      typeof authority.callId !== "string" || typeof authority.origin !== "string") {
    fail("preview_authority");
  }
  const stdinBytes = encoder.encode(input.stdin);
  // argv0 = the program name: the WASI `_start` command convention REQUIRES
  // argv[0] (the csvtool exits with code 2 when it is absent). The Settings
  // UI stays command-only — the program name is prepended here, never typed.
  const args = [PREVIEW_TOOL_ID, ...input.args];
  const job = createWasiJob({
    tier: "tiny",
    context: {
      executionId: authority.executionId,
      callId: authority.callId,
      origin: authority.origin,
      workspaceRoot: `tool-jobs/${authority.executionId}/${authority.callId}/`,
    },
    args,
    stdin: stdinBytes,
    quota: quota ?? {
      hostCalls: 50_000,
      pathCalls: 4096,
      stdinBytes: PREVIEW_LIMITS.maxStdinBytes,
      stdoutBytes: PREVIEW_LIMITS.maxStdoutBytes,
      stderrBytes: PREVIEW_LIMITS.maxStderrBytes,
      fileBytes: 10 * 1024 * 1024,
      fileSize: 10 * 1024 * 1024,
      dynamicFds: 256,
    },
  });
  return job;
}

/** The immutable execution-time revalidation. Every check uses the REAL
 * authority + the immutable bundled manifest + the pinned CAS bytes. */
export async function revalidateCsvtoolExecution({
  manifestText,
  casBytes,
  inventory = null,
  limits = WASM_PACKAGE_LIMITS,
  now = null,
}) {
  if (typeof manifestText !== "string" || !(casBytes instanceof Uint8Array)) {
    fail("preview_revalidate_input");
  }
  const authority = new WasmPackageAuthority({ now: now ?? (() => Date.now()) });
  const validated = authority.validateManifest(manifestText);
  if (!validated?.ok) fail("preview_manifest_invalid", validated?.error ?? "");
  const manifest = validated.manifest;

  // The package identity must be the pinned preview package.
  if (
    manifest?.package?.id !== PREVIEW_PACKAGE_ID ||
    manifest?.package?.type !== "tool-bundle"
  ) fail("preview_package_identity");

  // The manifest digest must equal the IMMUTABLE inventory row (when supplied).
  if (inventory && Array.isArray(inventory.manifests)) {
    const row = inventory.manifests.find(
      (candidate) => candidate?.pkg === PREVIEW_PACKAGE_ID,
    );
    if (!row || typeof row.digest !== "string" || !HEX64_RE.test(row.digest)) {
      fail("preview_inventory_row");
    }
    if (row.digest !== validated.manifestDigest) {
      fail("preview_manifest_drift");
    }
  }

  // The executables must contain exactly the csvtool executable + no others.
  const executables = Array.isArray(manifest?.executables)
    ? manifest.executables
    : [];
  if (executables.length !== 1) fail("preview_executable_count");
  const executable = executables[0];
  if (
    !executable || executable?.id !== PREVIEW_TOOL_ID ||
    typeof executable?.sha256 !== "string" || !HEX64_RE.test(executable.sha256) ||
    !Number.isSafeInteger(executable?.size) || executable.size < 0
  ) fail("preview_executable");

  // CAS bytes MUST re-match the manifest executable (sha256 + size) —
  // a substituted/truncated/grown binary fails closed.
  if (casBytes.byteLength !== executable.size) fail("preview_cas_size");
  const digest = await crypto.subtle.digest("SHA-256", casBytes).then(
    (d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  if (digest !== executable.sha256) fail("preview_cas_sha");

  // auditWasmBinary re-checks imports/memory/tier against the manifest.
  auditWasmBinary(casBytes, executable, { limits });

  // Capabilities must match the executable's declared set exactly.
  const caps = Array.isArray(executable?.capabilities)
    ? executable.capabilities
    : [];
  if (
    JSON.stringify([...caps].sort()) !==
    JSON.stringify(["compute", "text.transform"].sort())
  ) fail("preview_capabilities");

  return Object.freeze({
    ok: true,
    executable,
    manifestDigest: validated.manifestDigest,
    casSha256: digest,
    casSize: casBytes.byteLength,
    memory: executable.memory ?? null,
    capabilities: Object.freeze(caps),
  });
}

/** Bound a result envelope for the Settings UI (never echo unbounded bytes). */
export function boundPreviewResult(result, maxTextBytes = PREVIEW_LIMITS.maxOutputTextBytes) {
  if (!plainData(result)) fail("preview_result_shape");
  const boundedString = (value, label) => {
    if (typeof value !== "string") fail(`preview_result_${label}`);
    if (utf8Bytes(value) > maxTextBytes) {
      fail(`preview_result_${label}_over_budget`);
    }
    return value;
  };
  const ok = result.ok === true;
  return Object.freeze({
    ok,
    phase: typeof result.phase === "string" ? result.phase : "unknown",
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
    stdout: ok ? boundedString(result.stdout, "stdout") : "",
    stderr: ok ? boundedString(result.stderr, "stderr") : "",
    errno: Number.isSafeInteger(result.errno) ? result.errno : null,
    error: ok ? null : boundedString(String(result.error ?? "").slice(0, 512), "error"),
  });
}
