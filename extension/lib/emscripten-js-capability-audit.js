// lib/emscripten-js-capability-audit.js — executable admission invariant over
// the exact hash-verified glue+adapter byte set (chrome-agent-platform-197jd).
//
// The job worker (lib/emscripten-worker.js) imports package-provided glue and
// adapter modules by URL, and navigator.storage.getDirectory() is reachable
// from that same-origin context, so a hostile or buggy package JS could open
// or list OPFS writers on state that belongs to other runs. The binary audit
// (lib/emscripten-module-audit.js) inspects the WASM image only and never
// reads the glue/adapter JS. This module scans those bytes for the denied
// capabilities at admission time, with a typed refusal and a receipt verdict.
//
// Honesty boundary: a textual deny-list can never PROVE the absence of a
// capability. Dynamically computed member access (globalThis["navigator"]
// ["storage"]), string-built identifiers and similar stay invisible to any
// pattern. The residual is recorded in docs/RISK-REGISTER.md (R25); the C2
// claim (an admitted package cannot obtain its own OPFS write capability)
// remains an assumption — now a scanned one, not a proof.
//
// No package JavaScript is executed here. The scan is synchronous, bounded by
// the verified asset byte set, and runs on bytes already digest-checked by
// the graph audit.

import { WasmPackageAuthorityError } from "./wasm-package-authority.js";

const fail = (code, detail = null) => { throw new WasmPackageAuthorityError(code, "wasm", detail); };

// Reviewed glue identities whose fetch/XHR occurrences are the Emscripten
// runtime's own dead preamble (the worker profile hands the factory a
// hash-verified wasmBinary directly, so the URL-loading paths are unreachable).
// The exemption is BYTE-EXACT: it binds the digest, never the file. Any other
// byte set containing the pattern is refused. Adapters are never exempt.
const REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE = Object.freeze(new Set([
  // build-a/numeric.mjs — reviewed under chrome-agent-platform-ltkj.1.
  "921175ec0ad89d8af17dbdffc49e58033c8717a246fe80b458f32e4a5a8584a9",
  // build-a/image-resize.mjs — reviewed glue for the A0 image contract.
  "3c1c0e4381fe914b33dd554905d28e8dc777f1bda4bd42dcf05edd1380d7bea0",
  // build-a/link-main.mjs — reviewed glue for the A0 link contract.
  "bcddb43afe69fc2fb90102bf3ab0fcf83395177098ce647659bf1ee707292d76",
  // glue/blake3.mjs — reviewed under chrome-agent-platform-fh9k.
  "7d03777d994e39a8a619a8c9fe20c1bcb11710b114fc2f280022a2a103052878",
]));

const entry = (id, code, pattern, { exemptGlue = null } = {}) => Object.freeze({
  id,
  code,
  pattern,
  exemptGlue: exemptGlue ?? Object.freeze(new Set()),
});

/**
 * THE deny-list. Single exported constant (chrome-agent-platform-197jd): a
 * new capability must be added HERE, with a fixture in
 * tests/emscripten-js-capability-admission.test.ts — a test fails when an
 * entry has no fixture. `code` is the typed refusal suffix carried in the
 * admission error detail (`<assetId>:<code>`) and on the receipt.
 */
export const EMSCRIPTEN_JS_CAPABILITY_DENY_LIST = Object.freeze([
  // OPFS / storage capability acquisition (C2 surface).
  entry("navigator.storage", "navigator_storage", /\bnavigator\s*\.\s*storage\b/),
  entry("getDirectoryHandle", "opfs_directory_handle", /\bgetDirectoryHandle\b/),
  entry("getFileHandle", "file_handle", /\bgetFileHandle\b/),
  entry("createSyncAccessHandle", "sync_access_handle", /\bcreateSyncAccessHandle\b/),
  entry("createWritable", "writable_stream", /\bcreateWritable\b/),
  entry("caches", "cache_storage", /(?<![\w.$])caches\s*\.\s*(?:open|match|has|delete|keys)\b/),
  entry("indexedDB", "indexed_db", /\bindexedDB\b/),
  // Worker spawning from package JS.
  entry("worker-construction", "worker_construction", /(?<![\w.$])(?:new\s+)?(?:Shared)?Worker\s*\(/),
  // Network egress: dynamic import of network URLs.
  entry("network-dynamic-import", "network_dynamic_import", /\bimport\s*\(\s*(?:["'`](?:\s*(?:https?:|\/\/|data:|blob:))|new\s+URL\b)/),
  // Network egress: fetch/XHR. The two entries below carry the ONLY
  // exemptions in the list: the reviewed Emscripten runtime preamble digests
  // above (dead URL-loading paths under the direct-binary worker profile).
  entry("fetch", "fetch_call", /(?<![\w.$])fetch\s*\(/, { exemptGlue: REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE }),
  entry("xhr", "xhr", /\bXMLHttpRequest\b/, { exemptGlue: REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE }),
]);

const DENY_LIST_IDS = Object.freeze(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
// ES modules are valid UTF-8 by construction; anything else is a refusal.
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Roles whose package-provided JS the worker actually imports and runs. */
export function isJsCapabilityAssetRole(role) {
  return role === "glue" || role === "adapter";
}

/**
 * Scan the verified glue+adapter bytes for denied capabilities.
 * Refusal: WasmPackageAuthorityError("js_capability_denied", "wasm",
 * "<assetId>:<capability-code>"). Verdict (all clean):
 * { verdict:"pass", denyList:[ids], scanned:[{asset, role, sha256, exemptions:[ids]}] }
 * — recorded on the admission receipt as `current.jsCapabilityAudit`.
 * Undecodable bytes are refused (js_capability_unreadable), never skipped.
 */
export function auditEmscriptenJsCapabilities(capabilityAssets, files) {
  if (!Array.isArray(capabilityAssets) || !(files instanceof Map)) fail("js_capability_scan_invalid");
  const scanned = [];
  for (const asset of capabilityAssets) {
    if (!asset || typeof asset.id !== "string" || typeof asset.path !== "string" ||
        typeof asset.sha256 !== "string" || !isJsCapabilityAssetRole(asset.role)) {
      fail("js_capability_scan_invalid");
    }
    const bytes = files.get(asset.path);
    if (!(bytes instanceof Uint8Array)) fail("js_capability_scan_invalid", asset.id);
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      fail("js_capability_unreadable", asset.id);
    }
    const exemptions = [];
    for (const listItem of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
      if (!listItem.pattern.test(text)) continue;
      if (asset.role === "glue" && listItem.exemptGlue.has(asset.sha256)) {
        exemptions.push(listItem.id);
        continue;
      }
      fail("js_capability_denied", `${asset.id}:${listItem.code}`);
    }
    scanned.push(Object.freeze({
      asset: asset.id,
      role: asset.role,
      sha256: asset.sha256,
      exemptions: Object.freeze(exemptions.sort()),
    }));
  }
  return Object.freeze({
    verdict: "pass",
    denyList: DENY_LIST_IDS,
    scanned: Object.freeze(scanned),
  });
}
