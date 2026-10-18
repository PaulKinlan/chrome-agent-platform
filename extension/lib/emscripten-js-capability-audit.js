// lib/emscripten-js-capability-audit.js — executable admission invariant over
// the exact hash-verified package JS, closed by a real ECMAScript parser
// (chrome-agent-platform-197jd; ADR chrome-agent-platform-errqz).
//
// The job worker (lib/emscripten-worker.js) imports package-provided glue and
// adapter modules by URL, and navigator.storage.getDirectory() is reachable
// from that same-origin context, so a hostile or buggy package JS could open
// or list OPFS writers on state that belongs to other runs. The binary audit
// (lib/emscripten-module-audit.js) inspects the WASM image only. This module
// parses every hash-verified package JS asset with acorn (vendored at
// lib/vendor/acorn.mjs) and judges the AST.
//
// ADR errqz decisions implemented here:
//   - ONE maintained parser at the admission boundary; never a regex or
//     hand-written tokenizer. Parse failure and unsupported new syntax are
//     REFUSALS (js_capability_parse_failed), never a pass.
//   - Asset role never implies non-execution: every JS asset (declared JS
//     roles, plus any .mjs/.js asset in any role) is parsed and statically
//     screened even when no root reaches it, so changing a role cannot hide
//     executable JS.
//   - The import graph is seeded from the ACTUAL worker roots (glue and
//     adapter; bootstrap is screened but is not a worker root until worker
//     bootstrap execution is supported) and traverses AST ImportDeclaration,
//     ExportNamedDeclaration/ExportAllDeclaration sources and
//     ImportExpression anywhere in the AST — including inside exported
//     declarations and template expressions (finding 0065v).
//   - Every dynamic import source must be a plain literal string; nonliteral
//     imports are REFUSED (js_capability_import_nonliteral), not skipped.
//     Every edge must resolve canonically to a hash-verified admitted asset;
//     bare, absolute, network, malformed and missing targets are refused
//     (js_capability_import_unresolved).
//   - Denied capabilities are matched as finite AST shapes: member chains
//     (receiver-qualified and optional-chaining included — comments between
//     tokens do not exist in an AST, finding o0t1n), call/new callees, and
//     identifier references. The only exemptions remain the four reviewed
//     Emscripten glue preamble digests for their dead fetch/XHR URL-loading
//     paths; byte-exact and glue-only.
//   - Node/edge budgets are REFUSALS (js_capability_limit), never a pass.
//
// Honesty boundary (the receipt says this in so many words): a PASS proves
// only that the supported module grammar has a complete, closed set of import
// edges over the verified bytes and that the named static denied AST forms
// were not found. It does NOT prove C2 (an admitted package cannot obtain its
// own OPFS write capability): computed, aliased and global capability
// acquisition remains unproven, and nothing here proves writer-freedom. The
// residual is docs/RISK-REGISTER.md R25; the proof shape stays ADR nv5g0's
// host-managed writer leases (g2dje).
//
// No package JavaScript is executed here. Parsing and walking are synchronous
// and bounded, and run on bytes already digest-checked by the graph audit.

import { parse, version as acornVersion } from "./vendor/acorn.mjs";
import { WasmPackageAuthorityError } from "./wasm-package-authority.js";

const fail = (code, detail = null) => { throw new WasmPackageAuthorityError(code, "wasm", detail); };

// Reviewed glue identities whose fetch/XHR occurrences are the Emscripten
// runtime's own dead preamble (the worker profile hands the factory a
// hash-verified wasmBinary directly, so the URL-loading paths are unreachable).
// The exemption is BYTE-EXACT: it binds the digest, never the file. Any other
// byte set containing the shape is refused. Adapters are never exempt.
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

/**
 * THE deny-list (chrome-agent-platform-197jd), as finite AST shapes. A new
 * capability must be added HERE, with a fixture in
 * tests/emscripten-js-capability-admission.test.ts — a test fails when an
 * entry has no fixture. `code` is the typed refusal suffix carried in the
 * admission error detail (`<assetId>:<code>`) and on the receipt.
 *
 * kind "member-pair": denied when a member chain contains the CONSECUTIVE
 *   property pair ["navigator", "storage"] / ["caches", <method>].
 * kind "name": denied when an identifier or property (literal) carries the
 *   exact name — receiver-qualified spellings included (e840g), comment-
 *   splitting invisible in an AST (o0t1n).
 * kind "new": denied when a NewExpression callee's terminal name matches.
 * kind "call": denied when a CallExpression callee's terminal name matches.
 */
const method = (name) => Object.freeze({ name });
export const EMSCRIPTEN_JS_CAPABILITY_DENY_LIST = Object.freeze([
  entry("navigator.storage", "navigator_storage", { kind: "member-pair", pair: ["navigator", "storage"] }),
  entry("getDirectoryHandle", "opfs_directory_handle", { kind: "name", names: [method("getDirectoryHandle")] }),
  entry("getFileHandle", "file_handle", { kind: "name", names: [method("getFileHandle")] }),
  entry("createSyncAccessHandle", "sync_access_handle", { kind: "name", names: [method("createSyncAccessHandle")] }),
  entry("createWritable", "writable_stream", { kind: "name", names: [method("createWritable")] }),
  entry("caches", "cache_storage", { kind: "member-pair", pair: ["caches", ["open", "match", "has", "delete", "keys"]] }),
  entry("indexedDB", "indexed_db", { kind: "name", names: [method("indexedDB")] }),
  entry("worker-construction", "worker_construction", { kind: "new", names: [method("Worker"), method("SharedWorker")] }),
  entry("network-dynamic-import", "network_dynamic_import", { kind: "network-import-literal" }),
  entry("fetch", "fetch_call", { kind: "call", names: [method("fetch")], exemptGlue: REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE }),
  entry("xhr", "xhr", { kind: "name", names: [method("XMLHttpRequest")], exemptGlue: REVIEWED_EMSCRIPTEN_GLUE_PREAMBLE }),
]);

function entry(id, code, shape) {
  return Object.freeze({ id, code, ...shape, exemptGlue: shape.exemptGlue ?? Object.freeze(new Set()) });
}

const DENY_LIST_IDS = Object.freeze(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
const DENY_SINGLE_NAMES = new Map(); // name -> entry (for kind "name")
for (const listItem of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
  if (listItem.kind === "name") for (const m of listItem.names) DENY_SINGLE_NAMES.set(m.name, listItem);
}
const CACHES_METHODS = ["open", "match", "has", "delete", "keys"];
// ES modules are valid UTF-8 by construction; anything else is a refusal.
const decoder = new TextDecoder("utf-8", { fatal: true });

const PARSER_POLICY = "cap-js-capability-admission-ast-v1";
const NODE_BUDGET = 100_000; // per asset; exceeded -> js_capability_limit
const EDGE_BUDGET = 256; // per package; exceeded -> js_capability_limit

/** Roles whose package-provided JS the worker executes or may bootstrap. */
export function isJsCapabilityAssetRole(role) {
  return role === "glue" || role === "adapter" || role === "pthread-bootstrap";
}

/** A .mjs/.js asset is executable JS whatever role the manifest gave it. */
function isJsAsset(asset) {
  return isJsCapabilityAssetRole(asset.role) || /\.(?:mjs|js)$/u.test(asset.path ?? "");
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

// ── AST judgment ─────────────────────────────────────────────────────────────

/** Flatten a member/optional-member chain into property names.
 * Returns { names, opaque }: `opaque` is true when any computed access was
 * not a literal string — the chain BEFORE it is still knowable. */
function memberChain(node) {
  const names = [];
  let opaque = false;
  let cursor = node;
  while (cursor?.type === "MemberExpression") {
    const prop = cursor.property;
    if (prop.type === "Identifier") names.unshift(prop.name);
    else if (prop.type === "Literal" && typeof prop.value === "string") names.unshift(prop.value);
    else opaque = true;
    cursor = cursor.object;
  }
  if (cursor?.type === "Identifier") names.unshift(cursor.name);
  else opaque = true;
  return { names, opaque };
}

const calleeName = (callee) => {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression") {
    const prop = callee.property;
    if (prop.type === "Identifier") return prop.name;
    if (prop.type === "Literal" && typeof prop.value === "string") return prop.value;
  }
  return null;
};

const containsConsecutive = (names, head, tail) => {
  for (let i = 0; i + 1 < names.length; i++) {
    if (names[i] !== head) continue;
    if (typeof tail === "string" ? names[i + 1] === tail : tail.includes(names[i + 1])) return true;
  }
  return false;
};

/** Judge one AST against the deny-list. Returns the list of entry ids that matched. */
function judgeAst(ast) {
  const matched = [];
  const seenEntry = new Set();
  const deny = (listItem) => {
    if (!seenEntry.has(listItem.id)) {
      seenEntry.add(listItem.id);
      matched.push(listItem);
    }
  };
  let nodes = 0;
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++nodes > NODE_BUDGET) fail("js_capability_limit", "nodes");
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (node.type === "MemberExpression") {
      const { names } = memberChain(node);
      for (const listItem of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
        if (listItem.kind !== "member-pair") continue;
        if (containsConsecutive(names, listItem.pair[0], listItem.pair[1])) deny(listItem);
      }
      // Property spellings of single-name capabilities (obj.fetch, self.XMLHttpRequest).
      const last = names[names.length - 1];
      if (last && DENY_SINGLE_NAMES.has(last)) deny(DENY_SINGLE_NAMES.get(last));
    } else if (node.type === "Identifier") {
      const hit = DENY_SINGLE_NAMES.get(node.name);
      if (hit) deny(hit);
    } else if (node.type === "NewExpression" || node.type === "CallExpression") {
      const name = calleeName(node.callee);
      if (name) {
        for (const listItem of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
          if (listItem.kind !== "new" && listItem.kind !== "call") continue;
          if (listItem.kind === "new" && node.type !== "NewExpression") continue;
          if (listItem.kind === "call" && node.type !== "CallExpression") continue;
          for (const m of listItem.names) {
            if (m.name === name) deny(listItem);
          }
        }
        // caches.<method>() via callee chain (the member walk above also
        // covers the bare chain; the callee check catches call-position
        // chains whose object side is opaque).
        if (node.type === "CallExpression" && CACHES_METHODS.includes(name) && node.callee.type === "MemberExpression") {
          const { names } = memberChain(node.callee);
          if (containsConsecutive(names, "caches", CACHES_METHODS)) {
            deny(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.find((e) => e.id === "caches"));
          }
        }
      }
    } else if (node.type === "ImportExpression") {
      // Dynamic import: judged for network denial here; edge extraction
      // happens in collectEdges (which enforces the literal rule).
      if (node.source?.type === "Literal" && typeof node.source.value === "string") {
        if (/^(?:https?:|\/\/|data:|blob:)/u.test(node.source.value)) {
          deny(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.find((e) => e.id === "network-dynamic-import"));
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return matched;
}

/** Collect literal import edges from the AST. Nonliteral dynamic imports REFUSE. */
function collectEdges(ast, assetId) {
  const edges = [];
  const stack = [ast];
  let nodes = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (++nodes > NODE_BUDGET) fail("js_capability_limit", "nodes");
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" ||
        (node.type === "ExportNamedDeclaration" && node.source)) {
      const value = node.source?.value;
      if (typeof value !== "string") fail("js_capability_import_nonliteral", `${assetId}:${node.type}`);
      edges.push({ specifier: value, dynamic: false });
    } else if (node.type === "ImportExpression") {
      if (node.source?.type !== "Literal" || typeof node.source.value !== "string") {
        fail("js_capability_import_nonliteral", `${assetId}:dynamic-import`);
      }
      edges.push({ specifier: node.source.value, dynamic: true });
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return edges;
}

/**
 * Parse, screen and close the import graph over the verified package JS.
 *
 * @param rootAssets the worker roots (glue and adapter assets).
 * @param allAssets every asset in the admitted graph — the resolution
 *   universe and the all-role screening set.
 * @param files path -> verified bytes.
 *
 * Refusals: WasmPackageAuthorityError
 *   - "js_capability_denied", detail "<assetId>:<capability-code>";
 *   - "js_capability_import_nonliteral", detail "<assetId>:dynamic-import";
 *   - "js_capability_import_unresolved", detail "<assetId>:<specifier>";
 *   - "js_capability_parse_failed", detail "<assetId>:<first error>";
 *   - "js_capability_limit", detail "<assetId>:nodes" / "edges";
 *   - "js_capability_scan_invalid" for structural misuse.
 * Verdict (all clean): see RECEIPT below — recorded on the admission receipt
 * as `current.jsCapabilityAudit`. The verdict PROVES ONLY a complete, closed
 * import-edge set over the verified bytes plus absence of the named static
 * denied AST forms; it does NOT prove C2 (no own OPFS writers).
 */
export function auditEmscriptenJsCapabilities(rootAssets, allAssets, files) {
  if (!Array.isArray(rootAssets) || !Array.isArray(allAssets) || !(files instanceof Map)) fail("js_capability_scan_invalid");
  const byPath = new Map(allAssets.map((a) => [a?.path, a]));
  const jsAssets = [...allAssets].filter((a) => a && isJsAsset(a)).sort((a, b) => (a.id < b.id ? -1 : 1));

  // Parse + screen + collect edges for EVERY JS asset, reachable or not.
  const parsed = new Map(); // path -> { asset, edges, matched }
  for (const asset of jsAssets) {
    const bytes = files.get(asset.path);
    if (!(bytes instanceof Uint8Array)) fail("js_capability_scan_invalid", asset.id);
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      fail("js_capability_unreadable", asset.id);
    }
    let ast;
    try {
      ast = parse(text, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, locations: false });
    } catch (error) {
      fail("js_capability_parse_failed", `${asset.id}:${String(error?.message ?? "parse error").slice(0, 160)}`);
    }
    const matched = judgeAst(ast);
    const edges = collectEdges(ast, asset.id);
    parsed.set(asset.path, { asset, edges, matched });
  }
  if (parsed.size > EDGE_BUDGET * 4) fail("js_capability_limit", "assets");

  // Capability refusals take precedence over edge resolution (a capability
  // match is the stronger statement about the bytes).
  for (const [, info] of parsed) {
    for (const listItem of info.matched) {
      if (info.asset.role === "glue" && listItem.exemptGlue.has(info.asset.sha256)) continue;
      fail("js_capability_denied", `${info.asset.id}:${listItem.code}`);
    }
  }

  // Every edge of every JS asset must resolve to admitted package bytes.
  // (Fail-closed for ALL assets: changing a role must not turn a refused
  // import into a live one.)
  const edgeRows = [];
  let edgeCount = 0;
  const resolvedTargets = new Map(); // path -> [targetPath]
  for (const [path, info] of parsed) {
    const targets = [];
    for (const edge of info.edges) {
      if (++edgeCount > EDGE_BUDGET) fail("js_capability_limit", `${info.asset.id}:edges`);
      const resolved = resolveRelativeImport(path, edge.specifier);
      const target = resolved === null ? undefined : byPath.get(resolved);
      if (resolved === null || resolved === "" || !target || !files.has(target.path)) {
        fail("js_capability_import_unresolved", `${info.asset.id}:${edge.specifier}`);
      }
      targets.push(target.path);
      edgeRows.push({ from: info.asset.id, to: target.id, specifier: edge.specifier, dynamic: edge.dynamic });
    }
    resolvedTargets.set(path, targets);
  }
  edgeRows.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : a.specifier < b.specifier ? -1 : 1) : a.from < b.from ? -1 : 1));

  // Reachability from the worker roots (glue and adapter).
  const rootPaths = rootAssets
    .filter((a) => a && (a.role === "glue" || a.role === "adapter"))
    .map((a) => a.path)
    .sort();
  const reached = new Set();
  const queue = [...rootPaths];
  while (queue.length) {
    const path = queue.shift();
    if (reached.has(path) || !parsed.has(path)) continue;
    reached.add(path);
    for (const target of resolvedTargets.get(path) ?? []) if (!reached.has(target)) queue.push(target);
  }

  const scanned = [];
  const screened = [];
  for (const asset of jsAssets) {
    const info = parsed.get(asset.path);
    const exemptions = info.matched
      .filter((listItem) => asset.role === "glue" && listItem.exemptGlue.has(asset.sha256))
      .map((listItem) => listItem.id)
      .sort();
    screened.push({ asset: asset.id, role: asset.role });
    if (reached.has(asset.path)) {
      scanned.push({ asset: asset.id, role: asset.role, sha256: asset.sha256, exemptions: Object.freeze(exemptions) });
    }
  }

  return Object.freeze({
    verdict: "pass",
    parser: Object.freeze({ name: "acorn", version: acornVersion }),
    policy: PARSER_POLICY,
    denyList: DENY_LIST_IDS,
    roots: Object.freeze(rootPaths.map((p) => byPath.get(p)?.id ?? p)),
    edges: Object.freeze(edgeRows.map((e) => Object.freeze(e))),
    scanned: Object.freeze(scanned),
    screened: Object.freeze(screened),
    unproven: Object.freeze(
      "This verdict does NOT prove C2 / no-writers: capability acquisition via computed, aliased or global references, and any OPFS write the package may perform, remain unproven. It states only that the parsed module grammar has a complete closed import-edge set over the verified bytes and that the named static denied AST forms were not found.",
    ),
  });
}
