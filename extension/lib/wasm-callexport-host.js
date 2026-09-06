// lib/wasm-callexport-host.js — the call-export lane (chrome-agent-platform-uslb):
// ZERO-IMPORT compute modules (no _start, no stdin/stdout) executed as managed
// tools. A CAP-authored harness — NO package JS ever runs: instantiate the CAS
// bytes, write the (base64-decoded) input at the module's declared input-buffer
// pointer, call the declared entry export, read digestBytes from the state.
//
// Invariants (same fence model as the stream lane):
//   - the module is RE-AUDITED against the admitted manifest before every run
//     (the CAS bytes are re-read and re-hashed per execution);
//   - inputs are bounded (a base64 string budget) and the module is a fresh
//     instance per call (never pooled — no cross-call state);
//   - no eval/new Function; WebAssembly.Instance is the only execution;
//   - exact-key envelopes, typed errors, fail closed.

import { auditWasmBinary } from "./wasm-package-authority.js";
import { BUNDLED_INVENTORY } from "./bundled-inventory-data.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "./bundled-tool-packages.data.js";
import { WasmPackageAuthority } from "./wasm-package-authority.js";
import { isTrustedWasmStreamSender } from "./wasm-stream-host.js";

export const CALLEXPORT_RUN_TYPE = "cap:wasm-callexport-run";
export const CALLEXPORT_LIMITS = Object.freeze({
  maxInputBytes: 4 * 1024 * 1024, // decoded input budget (hashes of big files come via OPFS later)
});

function fail(code) { throw new Error(`callexport fail-closed: ${code}`); }

function decodeBase64(text) {
  if (typeof text !== "string") fail("input_not_base64");
  const clean = text.replace(/\s+/g, "");
  if (clean.length > (CALLEXPORT_LIMITS.maxInputBytes * 4) / 3 + 4) fail("input_over_budget");
  let bytes;
  try { bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)); }
  catch { fail("input_not_base64"); }
  if (bytes.byteLength > CALLEXPORT_LIMITS.maxInputBytes) fail("input_over_budget");
  return bytes;
}

/** The per-call harness: audit the CAS bytes against the admitted executable,
 * instantiate fresh, run the declared ABI, return the hex digest. */
export async function executeCallexportRun({ wasmBytes, executable, data }) {
  const spec = executable?.callExport;
  if (!spec) fail("no_callexport_spec");
  // Ground-truth the bytes against the admitted declaration every run.
  auditWasmBinary(wasmBytes, executable, {});
  const input = decodeBase64(data);
  let instance;
  try {
    const module = new WebAssembly.Module(wasmBytes);
    instance = new WebAssembly.Instance(module, {});
  } catch { fail("instantiate_failed"); }
  const ex = instance.exports;
  const memory = ex.memory;
  if (!(memory instanceof WebAssembly.Memory)) fail("memory_export_missing");
  const bufferPtr = ex[spec.inputBuffer]();
  if (!Number.isSafeInteger(bufferPtr) || bufferPtr < 0) fail("buffer_ptr_invalid");
  const heap = new Uint8Array(memory.buffer);
  if (bufferPtr + input.byteLength > heap.byteLength) fail("input_exceeds_memory");
  heap.set(input, bufferPtr);
  let digest;
  try {
    // The lane's ABI v1 (the hash-wasm convention): input written at the
    // inputBuffer pointer; entry(inputLength, initParam, digestBytes)
    // computes IN PLACE (the digest replaces the input at the buffer);
    // initParam 0 = the algorithm default.
    ex[spec.entry](input.byteLength, 0, spec.digestBytes);
    digest = new Uint8Array(memory.buffer, bufferPtr, spec.digestBytes).slice();
  } catch { fail("entry_call_failed"); }
  if (digest.byteLength !== spec.digestBytes) fail("digest_read_failed");
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── The offscreen host listener ─────────────────────────────────────────────
// The SW sends a bounded message; the host resolves the manifest + CAS bytes
// from the GENERATED registry (never request-borne paths), revalidates the
// manifest digest against the immutable inventory, audits the bytes against
// the declared executable (zero imports, ABI exports exist, memory bounded),
// and runs the harness.

const MESSAGE_KEYS = Object.freeze(["authority", "data", "owner", "toolId", "type"]);

async function executeCallexportRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify([...MESSAGE_KEYS].sort()) ||
      raw.type !== CALLEXPORT_RUN_TYPE || typeof raw.toolId !== "string") {
    fail("request_shape");
  }
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === raw.toolId);
  if (!row || row.callexport !== true || row.admitted !== true || row.disabled === true) {
    fail("tool_not_callexport");
  }
  const authority = new WasmPackageAuthority({});
  const manifestRes = await fetch(chrome.runtime.getURL(row.manifestRef.replace(/^extension\//, "")));
  const casRes = await fetch(chrome.runtime.getURL(`wasm/cas/${row.binary.sha256}.wasm`));
  if (!manifestRes.ok || !casRes.ok) fail("asset_fetch");
  const manifestText = await manifestRes.text();
  const validated = authority.validateManifest(manifestText);
  if (!validated?.ok) fail("manifest_invalid");
  const manifest = validated.manifest;
  // The manifest digest must equal the IMMUTABLE inventory row.
  const invRow = (BUNDLED_INVENTORY.manifests ?? []).find((c) => c?.pkg === row.packageId);
  if (!invRow || invRow.digest !== validated.manifestDigest) fail("manifest_drift");
  if (manifest.package.id !== row.packageId) fail("package_identity");
  const executable = (manifest.executables ?? []).find((e) => e?.id === raw.toolId && e?.callExport != null);
  if (!executable) fail("executable_missing");
  const wasmBytes = new Uint8Array(await casRes.arrayBuffer());
  const hash = await executeCallexportRun({ wasmBytes, executable, data: String(raw.data ?? "") });
  return Object.freeze({
    ok: true,
    phase: "completed",
    toolId: raw.toolId,
    stdout: JSON.stringify({ hash, algorithm: raw.toolId.replace(/^hash_/, "") }),
  });
}

export function registerCallexportHost() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== CALLEXPORT_RUN_TYPE) return undefined;
    // Only the extension service worker may submit (same sender gate as the
    // stream host — document/tab senders are rejected explicitly).
    if (!isTrustedWasmStreamSender(sender)) {
      sendResponse({ ok: false, error: "callexport_sender" });
      return false;
    }
    executeCallexportRequest(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, phase: "failed", error: String(error?.message ?? error).slice(0, 1024) }));
    return true;
  });
}
