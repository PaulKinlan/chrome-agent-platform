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
// pattern; computed import specifiers (import(variable)) stay invisible to
// the resolver below. The residual is recorded in docs/RISK-REGISTER.md
// (R25); the C2 claim (an admitted package cannot obtain its own OPFS write
// capability) remains an assumption — now a scanned one, not a proof.
//
// No package JavaScript is executed here. The scan is synchronous, bounded by
// the verified asset byte set, and runs on bytes already digest-checked by
// the graph audit.
//
// Import-graph closure (review finding 1o3uv): capabilities do not care about
// manifest roles. A glue module may relative-import another package asset — a
// data-role .mjs — and that module executes in the same worker with the same
// reachability. The scan therefore starts from the declared JS roles
// (glue/adapter/pthread-bootstrap) and TRANSITIVELY scans every asset they
// import, whatever role the manifest gave it. Every import specifier must
// resolve to admitted package bytes: relative paths resolve inside the
// verified set or the package is refused (js_capability_import_unresolved);
// bare and URL specifiers cannot resolve in an MV3 worker and are refused the
// same way.
//
// Import edges are found by a structural mini-tokenizer (review findings
// e840g/u3vfd/3awbd: a regex extractor had a length gap that skipped long
// import lists, read commented-out imports inside comments and template raw
// text, and the deny-list lookbehind rejected receiver-qualified spellings).
// The tokenizer skips comments, string literals, template raw text and regex
// literals, treats template ${...} as live code, and reads import/export-from
// edges structurally (no keyword-to-string gap limit). Capability names in
// the deny-list match as identifier OR property (self./window./globalThis.
// forms are the idiomatic worker spellings and are refused like the bare
// forms); only a LONGER IDENTIFIER swallows the match (spawnWorker does not
// match Worker), which is the anti-substring guard, never a receiver guard.

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
 *
 * The (?<![\w$]) anchor is an ANTI-SUBSTRING guard (a longer identifier like
 * spawnWorker must not match Worker), never a receiver guard: the idiomatic
 * receiver-qualified worker spellings (self.caches.open, window.fetch,
 * new self.Worker) are matched and refused like the bare forms (e840g).
 */
export const EMSCRIPTEN_JS_CAPABILITY_DENY_LIST = Object.freeze([
  // OPFS / storage capability acquisition (C2 surface).
  entry("navigator.storage", "navigator_storage", /\bnavigator\s*\.\s*storage\b/),
  entry("getDirectoryHandle", "opfs_directory_handle", /\bgetDirectoryHandle\b/),
  entry("getFileHandle", "file_handle", /\bgetFileHandle\b/),
  entry("createSyncAccessHandle", "sync_access_handle", /\bcreateSyncAccessHandle\b/),
  entry("createWritable", "writable_stream", /\bcreateWritable\b/),
  entry("caches", "cache_storage", /(?<![\w$])caches\s*\.\s*(?:open|match|has|delete|keys)\b/),
  entry("indexedDB", "indexed_db", /\bindexedDB\b/),
  // Worker spawning from package JS.
  entry("worker-construction", "worker_construction", /(?<![\w$])(?:new\s+)?(?:Shared)?Worker\s*\(/),
  // Network egress: dynamic import of network URLs.
  entry("network-dynamic-import", "network_dynamic_import", /\bimport\s*\(\s*(?:["'`](?:\s*(?:https?:|\/\/|data:|blob:))|new\s+URL\b)/),
  // Network egress: fetch/XHR. The two entries below carry the ONLY
  // exemptions in the list: the reviewed Emscripten runtime preamble digests
  // above (dead URL-loading paths under the direct-binary worker profile).
  entry("fetch", "fetch_call", /(?<![\w$])fetch\s*\(/, { exemptGlue: REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE }),
  entry("xhr", "xhr", /\bXMLHttpRequest\b/, { exemptGlue: REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE }),
]);

const DENY_LIST_IDS = Object.freeze(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
// ES modules are valid UTF-8 by construction; anything else is a refusal.
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Roles whose package-provided JS the worker executes or may bootstrap. */
export function isJsCapabilityAssetRole(role) {
  return role === "glue" || role === "adapter" || role === "pthread-bootstrap";
}

// ── Structural import-edge extraction ────────────────────────────────────────
// A single-pass tokenizer over module text. It is LEXICAL, not a parser: it
// exists to (a) never read an import edge inside a comment, string literal,
// template raw text or regex literal, and (b) never miss a live edge because
// of its shape. Computed specifiers (import(variable)) are not literal text
// and stay on the documented residual (R25).

const IDENT_START = /[\w$]/u;
const identPart = (c) => IDENT_START.test(c);
// After these the following `/` starts a regex literal; after an identifier,
// number, string, `)`, `]`, `}` or same-class punctuation it is division.
const REGEX_ALLOWED_AFTER = new Set(["", "(", "[", "{", ",", ";", "=", ":", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">", "=>", "&&", "||", "??", "return", "typeof", "case", "in", "of", "instanceof", "new", "delete", "void", "do", "else", "yield", "await", "throw"]);
const regexAllowedAfter = (prev) => REGEX_ALLOWED_AFTER.has(prev);

function skipWs(text, i) {
  while (i < text.length && /\s/u.test(text[i])) i++;
  return i;
}

function skipStringLiteral(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === quote) return j + 1;
    if (c === "\n") return j; // unterminated — let code mode resume; never loops
    j++;
  }
  return j;
}

function readStringRaw(text, i) {
  const quote = text[i];
  let j = i + 1;
  let value = "";
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      // Only pass-through escapes matter for path text; keep the raw char.
      const next = text[j + 1];
      if (next !== undefined) value += next === "\n" ? "" : next;
      j += 2;
      continue;
    }
    if (c === quote) return { value, end: j + 1 };
    if (c === "\n") return { value, end: j };
    value += c;
    j++;
  }
  return { value, end: j };
}

function skipRegexLiteral(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
    else if (c === "\n") return j; // not a regex after all; resume code
    j++;
  }
  return j;
}

function skipTemplateLiteral(text, i, edges) {
  // text[i] === "`". Raw text is skipped; ${ ... } is LIVE code and is
  // scanned for edges recursively.
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") return j + 1;
    if (c === "$" && text[j + 1] === "{") {
      j = scanCode(text, j + 2, edges, "}");
      if (text[j] === "}") j++;
      continue;
    }
    j++;
  }
  return j;
}

// Reads one depth-0 `from "specifier"` clause body. Returns the index to
// resume scanning from; pushes the edge when a literal specifier is found.
function readFromClause(text, j, edges) {
  const start = j;
  let depth = 0;
  let sawBinding = false;
  while (j < text.length && j - start < 65536) {
    const c = text[j];
    if (c === "`") { j = skipTemplateLiteral(text, j, edges); continue; }
    if (c === "/" && text[j + 1] === "/") { const e = text.indexOf("\n", j); j = e < 0 ? text.length : e + 1; continue; }
    if (c === "/" && text[j + 1] === "*") { const e = text.indexOf("*/", j + 2); j = e < 0 ? text.length : e + 2; continue; }
    if (c === "\"" || c === "'") {
      if (depth === 0 && !sawBinding) {
        const spec = readStringRaw(text, j);
        edges.push({ specifier: spec.value });
        return spec.end;
      }
      j = skipStringLiteral(text, j);
      continue;
    }
    if (c === "{" || c === "[" || c === "(") { depth++; j++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; j++; continue; }
    if (c === ";") return j;
    if (IDENT_START.test(c)) {
      let e = j + 1;
      while (e < text.length && identPart(text[e])) e++;
      const word = text.slice(j, e);
      if (depth === 0 && word === "from") {
        const m = skipWs(text, e);
        if (text[m] === "\"" || text[m] === "'") {
          const spec = readStringRaw(text, m);
          edges.push({ specifier: spec.value });
          return spec.end;
        }
        if (m < text.length && IDENT_START.test(text[m])) {
          // `from` was a binding name (import from from "x"); keep looking.
          sawBinding = true;
          j = e;
          continue;
        }
        return m;
      }
      if (depth === 0) sawBinding = true;
      j = e;
      continue;
    }
    j++;
  }
  return j;
}

function scanCode(text, i, edges, stopAt) {
  let prev = "";
  while (i < text.length) {
    const c = text[i];
    if (stopAt !== undefined && c === stopAt) return i;
    if (/\s/u.test(c)) { i++; continue; } // whitespace never becomes the significant token
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (c === "\"" || c === "'") { i = skipStringLiteral(text, i); prev = "string"; continue; }
    if (c === "`") { i = skipTemplateLiteral(text, i, edges); prev = "template"; continue; }
    if (c === "/" && regexAllowedAfter(prev)) { i = skipRegexLiteral(text, i); prev = "regex"; continue; }
    if (IDENT_START.test(c)) {
      let e = i + 1;
      while (e < text.length && identPart(text[e])) e++;
      const word = text.slice(i, e);
      if (word === "import") {
        let k = skipWs(text, e);
        if (text[k] === ".") { i = k + 1; prev = word; continue; } // import.meta
        if (text[k] === "(") {
          const m = skipWs(text, k + 1);
          if (text[m] === "\"" || text[m] === "'") {
            const spec = readStringRaw(text, m);
            edges.push({ specifier: spec.value });
            i = spec.end;
          } else {
            i = m; // computed specifier — documented residual (R25)
          }
          prev = word;
          continue;
        }
        i = readFromClause(text, k, edges);
        prev = word;
        continue;
      }
      if (word === "export") {
        i = readFromClause(text, skipWs(text, e), edges);
        prev = word;
        continue;
      }
      i = e;
      prev = word;
      continue;
    }
    prev = c;
    i++;
  }
  return i;
}

/**
 * Literal import specifiers of live import edges, in source order:
 * static `import ... from "x"` / side-effect `import "x"` /
 * `export ... from "x"` / dynamic `import("x")`. Comments, string literals,
 * template raw text and regex literals are never read for edges; template
 * ${...} expressions are live code and are scanned.
 */
export function extractImportSpecifiers(text) {
  const edges = [];
  scanCode(text, 0, edges, undefined);
  const specifiers = edges.map((edge) => edge.specifier);
  if (specifiers.length > 256) fail("js_capability_scan_invalid", "import_specifier_bound");
  return specifiers;
}

/** Resolve a relative import specifier against an asset path; null when it is not relative. */
export function resolveRelativeImport(fromPath, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return null;
  let url;
  try {
    url = new URL(specifier, `file:///${fromPath}`);
  } catch {
    return ""; // malformed relative specifier — never silently accepted
  }
  return url.pathname.replace(/^\//u, "");
}

/**
 * Scan the verified package JS for denied capabilities, transitively through
 * the ES module import graph.
 *
 * @param entryAssets declared JS-role assets (glue/adapter/pthread-bootstrap)
 *   — the scan seeds from these.
 * @param allAssets every asset in the admitted graph — the resolution universe
 *   an import specifier may target, whatever role the manifest gave it.
 * @param files path -> verified bytes.
 *
 * Refusals: WasmPackageAuthorityError
 *   - "js_capability_denied", detail "<assetId>:<capability-code>" — a
 *     deny-list pattern matched any scanned asset, including transitively
 *     imported data-role modules;
 *   - "js_capability_import_unresolved", detail "<assetId>:<specifier>" — an
 *     import that does not resolve to admitted package bytes;
 *   - "js_capability_unreadable" — non-UTF-8 JS bytes.
 * Verdict (all clean):
 * { verdict:"pass", denyList:[ids], scanned:[{asset, role, sha256, exemptions:[ids]}] }
 * — recorded on the admission receipt as `current.jsCapabilityAudit`.
 */
export function auditEmscriptenJsCapabilities(entryAssets, allAssets, files) {
  if (!Array.isArray(entryAssets) || !Array.isArray(allAssets) || !(files instanceof Map)) fail("js_capability_scan_invalid");
  const byPath = new Map(allAssets.map((a) => [a?.path, a]));
  const scanned = [];
  const seen = new Set();
  const queue = entryAssets.map((a) => a?.path).filter(Boolean).sort();
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const asset = byPath.get(path);
    if (!asset) fail("js_capability_scan_invalid", path);
    const bytes = files.get(path);
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
    // Import-graph closure: every specifier must land on admitted bytes.
    for (const specifier of extractImportSpecifiers(text)) {
      const resolved = resolveRelativeImport(path, specifier);
      const target = resolved === null ? undefined : byPath.get(resolved);
      if (resolved === null || resolved === "" || !target || !files.has(target.path)) {
        fail("js_capability_import_unresolved", `${asset.id}:${specifier}`);
      }
      if (!seen.has(target.path)) queue.push(target.path);
    }
  }
  return Object.freeze({
    verdict: "pass",
    denyList: DENY_LIST_IDS,
    scanned: Object.freeze(scanned),
  });
}
