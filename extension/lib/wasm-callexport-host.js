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
export async function executeCallexportRun({ wasmBytes, executable, data, args }) {
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
  if (spec.abi === "chacha20_poly1305") {
    return executeChachaPoly1305Run({ ex, memory, args: args ?? (data ? { data } : {}) });
  }
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

const ARX_SIGMA32 = new Uint8Array([
  0x65, 0x78, 0x70, 0x61, 0x6e, 0x64, 0x20, 0x33,
  0x32, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x20, 0x6b,
]); // "expand 32-byte k"

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function encodeBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function executeChachaPoly1305Run({ ex, memory, args }) {
  const mode = args?.mode ?? "encrypt";
  if (mode !== "encrypt" && mode !== "decrypt") fail("invalid_mode");
  const key = decodeBase64(args?.key);
  if (key.byteLength !== 32) fail("key_length_invalid");
  const nonce = decodeBase64(args?.nonce);
  if (nonce.byteLength !== 12) fail("nonce_length_invalid");
  const data = decodeBase64(args?.data);
  const aad = args?.aad ? decodeBase64(args.aad) : new Uint8Array(0);

  const heap = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);

  if (mode === "encrypt") {
    if (data.byteLength > 2 * 1024 * 1024) fail("input_over_budget");
    heap.fill(0, 0, 8);
    heap.set(ARX_SIGMA32, 16);
    heap.set(key, 32);
    heap.set(nonce, 64);
    dv.setBigUint64(80, BigInt(aad.byteLength), true);
    dv.setBigUint64(88, BigInt(data.byteLength), true);

    const aadLo = aad.byteLength & 0xffffffff;
    const aadHi = Math.floor(aad.byteLength / 0x100000000);
    ex.encryptInit(aadLo, aadHi);

    if (aad.byteLength > 0) {
      const aadBlockLen = 16;
      let pos = 0;
      while (pos < aad.byteLength) {
        const remaining = aad.byteLength - pos;
        const take = Math.min(remaining, 65536);
        const blocks = Math.ceil(take / aadBlockLen);
        const left = blocks * aadBlockLen - take;
        heap.fill(0, 1008, 1008 + blocks * aadBlockLen);
        heap.set(aad.subarray(pos, pos + take), 1008);
        const isLast = (pos + take >= aad.byteLength) ? 1 : 0;
        ex.aadBlocks(blocks, isLast, left);
        pos += take;
      }
    }

    const blockLen = 64;
    const blocks = Math.ceil(data.byteLength / blockLen);
    const left = blocks * blockLen - data.byteLength;
    heap.fill(0, 1008, 1008 + blocks * blockLen);
    heap.set(data, 1008);
    ex.encryptBlocks(blocks, 1, left, -1);

    const ciphertext = heap.subarray(1008, 1008 + data.byteLength).slice();
    ex.tagFinish();
    const tag = heap.subarray(992, 992 + 16).slice();

    const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.byteLength);
    const resultBase64 = encodeBase64(combined);
    return { data: resultBase64, algorithm: "chacha20_poly1305", mode: "encrypt" };
  } else {
    if (data.byteLength < 16) fail("ciphertext_too_short");
    const cipherLen = data.byteLength - 16;
    const ciphertext = data.subarray(0, cipherLen);
    const passedTag = data.subarray(cipherLen);

    heap.fill(0, 0, 8);
    heap.set(ARX_SIGMA32, 16);
    heap.set(key, 32);
    heap.set(nonce, 64);
    dv.setBigUint64(80, BigInt(aad.byteLength), true);
    dv.setBigUint64(88, BigInt(ciphertext.byteLength), true);

    const aadLo = aad.byteLength & 0xffffffff;
    const aadHi = Math.floor(aad.byteLength / 0x100000000);
    ex.decryptInit(aadLo, aadHi);

    if (aad.byteLength > 0) {
      const aadBlockLen = 16;
      let pos = 0;
      while (pos < aad.byteLength) {
        const remaining = aad.byteLength - pos;
        const take = Math.min(remaining, 65536);
        const blocks = Math.ceil(take / aadBlockLen);
        const left = blocks * aadBlockLen - take;
        heap.fill(0, 1008, 1008 + blocks * aadBlockLen);
        heap.set(aad.subarray(pos, pos + take), 1008);
        const isLast = (pos + take >= aad.byteLength) ? 1 : 0;
        ex.aadBlocks(blocks, isLast, left);
        pos += take;
      }
    }

    const blockLen = 64;
    const blocks = Math.ceil(ciphertext.byteLength / blockLen);
    const left = blocks * blockLen - ciphertext.byteLength;
    heap.fill(0, 1008, 1008 + blocks * blockLen);
    heap.set(ciphertext, 1008);
    ex.decryptBlocks(blocks, 1, left, -1);

    const plaintext = heap.subarray(1008, 1008 + ciphertext.byteLength).slice();
    ex.tagFinish();
    const computedTag = heap.subarray(992, 992 + 16).slice();

    if (!timingSafeEqual(computedTag, passedTag)) {
      fail("invalid_tag");
    }

    const resultBase64 = encodeBase64(plaintext);
    return { data: resultBase64, algorithm: "chacha20_poly1305", mode: "decrypt" };
  }
}

// ── The offscreen host listener ─────────────────────────────────────────────
// The SW sends a bounded message; the host resolves the manifest + CAS bytes
// from the GENERATED registry (never request-borne paths), revalidates the
// manifest digest against the immutable inventory, audits the bytes against
// the declared executable (zero imports, ABI exports exist, memory bounded),
// and runs the harness.

const MESSAGE_KEYS = Object.freeze(["args", "authority", "data", "owner", "toolId", "type"]);

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
  const result = await executeCallexportRun({ wasmBytes, executable, data: String(raw.data ?? ""), args: raw.args });
  const stdout = typeof result === "string"
    ? JSON.stringify({ hash: result, algorithm: raw.toolId.replace(/^hash_/, "") })
    : JSON.stringify(result);
  return Object.freeze({
    ok: true,
    phase: "completed",
    toolId: raw.toolId,
    stdout,
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
