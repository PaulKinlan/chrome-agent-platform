// scan-shipped.mjs — structural shipped-code audit using a REAL JavaScript
// parser (acorn). Replaces the earlier regex scan: exports are discovered by
// walking the AST, so every export form is covered (export declarations, export
// lists, `export { x as __y }` aliases, and default exports — including named
// default function/class declarations), and `window.__*` / `self.__*` /
// `globalThis.__*` oracle access is found via MemberExpression nodes (dot,
// bracket, template-literal, and statically foldable string concatenation) —
// not by pattern-matching source text.

// @ts-nocheck — this scanner is run by node (build.mjs) AND imported by Deno
// tests; the node:fs/promises read shim + acorn types are intentionally dynamic.

import { parse } from "acorn";
import { auditWasmBinary } from "../extension/lib/wasm-package-authority.js";

// Test controls/oracles that must never appear in shipped code (scanned
// case-insensitively over the RAW text so a renamed identifier is still caught
// by name). Keep in sync with the unit-test/harness layer.
const FORBIDDEN_NAMES = [
  "__setkvfaultfortest", "kv.fault", "cap-kv-fault-test", "injected test fault",
  "__sidebarpersistence", "__lastviewtransition",
  "__resetsessionfortest", "__resetmigrationfortest", "__resetbootfortest",
  "buildscriptsrcdoc", "test-only",
];

// __-prefixed globals that are legitimate library internals (NOT oracles).
// Scoped: these are ONLY exempted inside the generated dependency bundle(s),
// where esbuild inlines the zod/vite source. In shipped SOURCE files a
// `window.__zod*`/`window.__vite*` access is still a violation.
const EXCLUDED_GLOBAL_ORACLE = /^__(zod|vite)[A-Za-z0-9_$]*$/;

// Global objects whose __-prefixed properties are treated as test oracles.
const ORACLE_GLOBALS = new Set(["window", "self", "globalThis"]);

/** Recursively visit every node in the acorn AST. */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit);
    } else if (child && typeof child.type === "string") {
      walk(child, visit);
    }
  }
}

/** Collect every identifier DECLARED by a declaration node (Variable/Function/Class). */
function declaredNames(node) {
  const names = [];
  if (!node) return names;
  switch (node.type) {
    case "VariableDeclaration":
      for (const d of node.declarations) names.push(...declaredNames(d.id));
      break;
    case "FunctionDeclaration":
    case "ClassDeclaration":
      if (node.id) names.push(node.id.name);
      break;
    case "Identifier":
      names.push(node.name);
      break;
    case "ObjectPattern":
      for (const p of node.properties) names.push(...declaredNames(p.value ?? p.argument));
      break;
    case "ArrayPattern":
      for (const el of node.elements) names.push(...declaredNames(el));
      break;
    case "AssignmentPattern":
      names.push(...declaredNames(node.left));
      break;
    case "RestElement":
      names.push(...declaredNames(node.argument));
      break;
    default:
      break;
  }
  return names;
}

/** The __-prefixed name exported by a default export, if any. Covers the
 * identifier form (`export default __x`) AND named default function/class
 * declarations (`export default function __x(){}` / `export default class __x{}`). */
function defaultExportName(node) {
  if (!node) return null;
  if (node.type === "Identifier" && node.name.startsWith("__")) return node.name;
  if (
    (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
    node.id?.name?.startsWith("__")
  ) {
    return node.id.name;
  }
  return null;
}

/** Statically fold a property expression to a string, or null when it cannot be
 * resolved. Handles string literals, no-expression template literals, and
 * `+`-concatenations of the above (e.g. `self["__" + "reset"]`). */
function foldString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    const q = node.quasis[0].value;
    return q.cooked ?? q.raw;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = foldString(node.left);
    const r = foldString(node.right);
    if (l !== null && r !== null) return l + r;
  }
  return null;
}

function isRemoteScriptUrl(value) {
  return typeof value === "string" && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value);
}

function memberPropertyName(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return node.computed ? foldString(node.property) : null;
}

const CODE_LOADING_SINKS = new Set([
  "Worker",
  "SharedWorker",
  "WorkerCtor",
  "importScripts",
  "fetch",
]);

function directSinkName(node) {
  if (node?.type === "Identifier" && CODE_LOADING_SINKS.has(node.name)) {
    return node.name;
  }
  if (
    node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    ORACLE_GLOBALS.has(node.object.name)
  ) {
    const name = memberPropertyName(node);
    return CODE_LOADING_SINKS.has(name) ? name : null;
  }
  return null;
}

function sinkName(node, aliases) {
  const direct = directSinkName(node);
  if (direct) return direct;
  return node?.type === "Identifier" ? aliases.get(node.name) ?? null : null;
}

function isRemoteCodeUrl(value) {
  return isRemoteScriptUrl(value) && /\.(?:m?js)(?:$|[?#])/iu.test(value);
}

function createsScriptElement(node) {
  return node?.type === "CallExpression" &&
    memberPropertyName(node.callee) === "createElement" &&
    foldString(node.arguments?.[0])?.toLowerCase() === "script";
}

function scriptTarget(node, knownScripts) {
  if (createsScriptElement(node)) return true;
  return node?.type === "Identifier" &&
    (knownScripts.has(node.name) || /script/iu.test(node.name));
}

/**
 * Scan the given shipped JS files. `generatedBundles` is the set of file paths
 * that are GENERATED dependency bundles (esbuild output inlining zod/vite); only
 * there are the `__zod_*` / `__vite_*` oracle exemptions allowed. `readText` is
 * the injected file reader (the caller owns file I/O so this module stays
 * importable from BOTH node and Deno without a node:fs type dependency).
 * Returns a list of human-readable violation strings (empty when clean).
 */
// THE EXECUTION-HOST exemption — a FIXED canonical constant owned by the
// scanner (NOT caller-supplied): the exact source-only, unreachable worker
// that compiles a bounded wasm job inside a fresh dedicated Worker (Gate 2 of
// CAP-FB-20260822-WASM-EXECUTION-HOST-01). It is not route/provider-bound and
// nothing imports it in production; a separately reviewed successor owns the
// service-worker route that would reach it. The exemption is NOT a generic
// bypass: it applies to this ONE canonical path AND only to the EXACT allowed
// call shape below (a bounded count of `WebAssembly.instantiate(` calls whose
// FIRST argument is the identifier `wasmBytes` and whose SECOND argument is
// the member `runtime.imports`). The check covers DIRECT `WebAssembly.*`
// calls and constructors ONLY; ALIAS-based forms (e.g. `const inst =
// WebAssembly.instantiate` used later) are a DOCUMENTED RESIDUAL/HEURISTIC —
// they are outside this predicate and are not claimed as detected. Any other
// file with ANY direct dynamic WebAssembly call/constructor — and any deviating
// call shape in the canonical file — is a violation.
const EXECUTION_HOST_CANONICAL_PATH = "extension/lib/wasm-execution-worker.js";
const EXECUTION_HOST_CANONICAL_LOCATION = { line: 202, column: 25 };
const EXECUTION_HOST_ALLOWED_CALL_RE = /WebAssembly\.instantiate\(/g;
// The EXACT allowed arguments of the single canonical call: the first argument
// is the identifier `wasmBytes`, the second is the member `runtime.imports`.
const EXECUTION_HOST_ALLOWED_ARG0 = "wasmBytes";
const EXECUTION_HOST_ALLOWED_ARG1_OBJECT = "runtime";
const EXECUTION_HOST_ALLOWED_ARG1_PROP = "imports";

// THE WORKER-HOST exemption — a second FIXED canonical constant owned by the
// scanner (NOT caller-supplied): the exact source-only, unreachable executor
// (Gate 2 of CAP-FB-20260822-WASM-EXECUTION-HOST-01) constructs its fresh
// dedicated Worker from a runtime-resolved URL. This is the ONLY non-literal
// Worker construction in shipped source; everything else must be an
// allowlisted literal. The exemption applies to exactly this ONE node (file +
// exact line/column) and a bounded count of 1; any other Worker/SharedWorker
// node — literal or not — in any file stays flagged.
const WORKER_HOST_CANONICAL_PATH = "extension/lib/wasm-executor.js";
const WORKER_HOST_CANONICAL_LOCATION = { line: 200, column: 9 };
const WORKER_HOST_ALLOWED_RE = /new\s+Worker\s*\(/g;
// The bounded JS-minifier host constructs its fresh Worker through an injected
// `WorkerCtor` (the `{ WorkerCtor = globalThis.Worker }` dependency). It is a
// SEPARATE canonical entry bound to the exact line/column + the exact
// `new WorkerCtor(` shape, never a broad exemption for the minifier files.
const MINIFIER_WORKER_HOST_CANONICAL_PATH = "extension/lib/js-minifier-lifecycle.js";
const MINIFIER_WORKER_HOST_CANONICAL_LOCATION = { line: 13, column: 13 };
const MINIFIER_WORKER_HOST_ALLOWED_RE = /new\s+WorkerCtor\s*\(/g;
// The bounded JWT-decode host constructs its fresh browser Worker directly
// (`new Worker(workerUrl, { type: "module" })`). A SEPARATE canonical entry
// bound to the exact line/column + the exact `new Worker(` shape.
const JWT_WORKER_HOST_CANONICAL_PATH = "extension/lib/jwt-decode.js";
const JWT_WORKER_HOST_CANONICAL_LOCATION = { line: 60, column: 19 };
const JWT_WORKER_HOST_ALLOWED_RE = /new\s+Worker\s*\(/g;

// Scanner-owned canonical path matcher: BOTH exemptions bind to the exact
// normalized repo tail (`extension/lib/…`). The Store pipeline passes ABSOLUTE
// source paths (`path.join(root, entry.name)`), so a bare relative equality
// never matches there. This matcher accepts the exact normalized repo-tail —
// the relative form OR any path whose lexically normalized form ends in exactly
// that tail — and REJECTS lookalikes and suffix tricks: the tail must be the
// exact final segments (no `.evil`/`.bak` suffix, no `xxextension/…` prefix
// segment, no different filename, no NUL/control-character injection). The
// normalization is purely LEXICAL (collapse separators/`.` and resolve `..`
// without touching the filesystem), so `..` games that resolve to the canonical
// file still match, while anything that resolves away does not.
function isCanonicalScannedPath(file, canonicalRelative) {
  if (typeof file !== "string" || !file || typeof canonicalRelative !== "string") {
    return false;
  }
  // Control characters: refuse before any comparison (NUL/separator tricks).
  if (/[\u0000-\u001f\u007f]/u.test(file)) return false;
  const segments = file.replace(/\\/gu, "/").split("/");
  const out = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(segment);
  }
  const normalized = out.join("/");
  if (normalized === canonicalRelative) return true;
  return normalized.endsWith("/" + canonicalRelative);
}

export async function scanShippedJs(files, {
  generatedBundles = new Set(),
  allowedWorkerLiterals = new Set(),
  allowedDynamicEvaluatorFiles = new Set(),
  readText,
} = {}) {
  if (typeof readText !== "function") {
    throw new Error("scanShippedJs requires an injected readText(file) function");
  }
  if (
    !(generatedBundles instanceof Set) ||
    !(allowedWorkerLiterals instanceof Set) ||
    !(allowedDynamicEvaluatorFiles instanceof Set)
  ) {
    throw new Error("scanShippedJs policy sets must be Set instances");
  }
  const violations = [];

  for (const file of files) {
    const text = await readText(file);
    const inGeneratedBundle = generatedBundles.has(file);

    // 1. Forbidden test-control names (case-insensitive raw-text scan).
    const lower = text.toLowerCase();
    for (const needle of FORBIDDEN_NAMES) {
      if (lower.includes(needle)) {
        violations.push(
          `${file}: contains forbidden test control \`${needle}\` (test controls/oracles must live only in the test/harness layer)`,
        );
      }
    }

    // 2. Structural AST walk.
    let ast;
    try {
      ast = parse(text, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowHashBang: true,
        locations: true, // the execution-host exact-location pin needs node.loc
      });
    } catch (err) {
      violations.push(
        `${file}: not parseable as a JS module (${err.message})`,
      );
      continue;
    }

    const sinkAliases = new Map();
    // Resolve direct/computed global sinks and simple alias chains. This is a
    // bounded heuristic, not a substitute for CSP or exact package hashes.
    walk(ast, (node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.id?.type === "Identifier"
      ) {
        const sink = sinkName(node.init, sinkAliases);
        if (sink) sinkAliases.set(node.id.name, sink);
      }
      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" && node.left?.type === "Identifier"
      ) {
        const sink = sinkName(node.right, sinkAliases);
        if (sink) sinkAliases.set(node.left.name, sink);
      }
    });

    const scriptObjects = new Set();
    walk(ast, (node) => {
      if (
        node.type === "VariableDeclarator" && node.id?.type === "Identifier" &&
        createsScriptElement(node.init)
      ) scriptObjects.add(node.id.name);
      if (
        node.type === "AssignmentExpression" && node.left?.type === "Identifier" &&
        createsScriptElement(node.right)
      ) scriptObjects.add(node.left.name);
    });

    walk(ast, (node) => {
      // (a) exported __-prefixed test seams.
      if (node.type === "ExportNamedDeclaration") {
        if (node.specifiers) {
          for (const spec of node.specifiers) {
            const exported = spec.exported?.name ?? spec.exported?.value;
            if (typeof exported === "string" && exported.startsWith("__")) {
              violations.push(
                `${file}: exports \`${exported}\` (__-prefixed test seam)`,
              );
            }
          }
        }
        if (node.declaration) {
          for (const name of declaredNames(node.declaration)) {
            if (name.startsWith("__")) {
              violations.push(
                `${file}: exports \`${name}\` (__-prefixed test seam)`,
              );
            }
          }
        }
      }
      if (node.type === "ExportDefaultDeclaration") {
        const name = defaultExportName(node.declaration);
        if (name) {
          violations.push(
            `${file}: default-exports \`${name}\` (__-prefixed test seam)`,
          );
        }
      }
      // (b) Remote script-loading URLs are forbidden for Store packages.
      // AST checks are heuristic defense in depth; exact CSP and package SHA
      // verification remain primary authority.
      if (
        (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        isRemoteScriptUrl(node.source?.value)
      ) violations.push(`${file}: imports a remote script URL`);
      if (
        node.type === "ImportExpression" && isRemoteScriptUrl(foldString(node.source))
      ) violations.push(`${file}: dynamically imports a remote script URL`);
      if (
        node.type === "CallExpression" &&
        sinkName(node.callee, sinkAliases) === "importScripts"
      ) {
        for (const argument of node.arguments ?? []) {
          const value = foldString(argument);
          if (value === null || isRemoteScriptUrl(value)) {
            violations.push(`${file}: importScripts requires package-local literal URLs`);
            break;
          }
        }
      }
      if (
        node.type === "AssignmentExpression" &&
        memberPropertyName(node.left) === "src" &&
        scriptTarget(node.left.object, scriptObjects) &&
        isRemoteScriptUrl(foldString(node.right))
      ) violations.push(`${file}: assigns a remote script URL`);
      if (
        node.type === "CallExpression" &&
        memberPropertyName(node.callee) === "setAttribute" &&
        scriptTarget(node.callee.object, scriptObjects) &&
        foldString(node.arguments?.[0])?.toLowerCase() === "src" &&
        isRemoteScriptUrl(foldString(node.arguments?.[1]))
      ) violations.push(`${file}: assigns a remote script URL`);

      // Worker construction is exact-literal and allowlist-only. Store mode in
      // this slice supplies an empty allowlist, so an alternate Worker cannot
      // become a hidden Wasm/package execution host.
      if (node.type === "NewExpression") {
        const workerSink = sinkName(node.callee, sinkAliases);
        if (workerSink === "Worker" || workerSink === "SharedWorker" || workerSink === "WorkerCtor") {
          const value = foldString(node.arguments?.[0]);
          const isCanonicalWorkerHost = (
            isCanonicalScannedPath(file, WORKER_HOST_CANONICAL_PATH) &&
            workerSink === "Worker" &&
            node.loc?.start?.line === WORKER_HOST_CANONICAL_LOCATION.line &&
            node.loc?.start?.column === WORKER_HOST_CANONICAL_LOCATION.column &&
            value === null &&
            (text.match(WORKER_HOST_ALLOWED_RE) ?? []).length === 1
          ) || (
            isCanonicalScannedPath(file, MINIFIER_WORKER_HOST_CANONICAL_PATH) &&
            workerSink === "WorkerCtor" &&
            node.loc?.start?.line === MINIFIER_WORKER_HOST_CANONICAL_LOCATION.line &&
            node.loc?.start?.column === MINIFIER_WORKER_HOST_CANONICAL_LOCATION.column &&
            value === null &&
            (text.match(MINIFIER_WORKER_HOST_ALLOWED_RE) ?? []).length === 1
          ) || (
            isCanonicalScannedPath(file, JWT_WORKER_HOST_CANONICAL_PATH) &&
            workerSink === "Worker" &&
            node.loc?.start?.line === JWT_WORKER_HOST_CANONICAL_LOCATION.line &&
            node.loc?.start?.column === JWT_WORKER_HOST_CANONICAL_LOCATION.column &&
            value === null &&
            (text.match(JWT_WORKER_HOST_ALLOWED_RE) ?? []).length === 1
          );
          if (value === null && !isCanonicalWorkerHost) {
            violations.push(`${file}: ${workerSink} URL is not a literal`);
          } else if (
            value !== null &&
            (isRemoteScriptUrl(value) || !allowedWorkerLiterals.has(value))
          ) {
            violations.push(
              `${file}: ${workerSink} literal is not allowlisted: ${value}`,
            );
          }
        }
      }

      // (c) Dynamic source evaluation is forbidden except for the exact
      // manifest-sandbox evaluator path supplied by Store policy. Generated
      // service-worker/options bundles never inherit this exemption.
      if (
        !allowedDynamicEvaluatorFiles.has(file) &&
        ((node.type === "CallExpression" &&
          node.callee?.type === "Identifier" && node.callee.name === "eval") ||
          (node.type === "NewExpression" &&
            node.callee?.type === "Identifier" &&
            node.callee.name === "Function"))
      ) {
        violations.push(`${file}: dynamic source evaluator is forbidden`);
      }

      // (d) Dynamic Wasm construction/compilation and literal .wasm fetches
      // are forbidden in shipped source. The bundled authority is record-only;
      // a future host requires a separately reviewed static CAS route.
      if (
        (node.type === "CallExpression" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.object?.type === "Identifier" &&
          node.callee.object.name === "WebAssembly") ||
        // ALSO reject constructor APIs: new WebAssembly.Module(...) etc.
        (node.type === "NewExpression" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.object?.type === "Identifier" &&
          node.callee.object.name === "WebAssembly")
      ) {
        const isCanonicalHost = isCanonicalScannedPath(file, EXECUTION_HOST_CANONICAL_PATH);
        const isCall = node.type === "CallExpression";
        const memberName = node.callee?.property?.type === "Identifier"
          ? node.callee.property.name
          : null;
        const arg0 = node.arguments?.[0] ?? null;
        const arg0Ok = isCall && arg0?.type === "Identifier" &&
          arg0.name === EXECUTION_HOST_ALLOWED_ARG0;
        const arg1 = node.arguments?.[1] ?? null;
        const arg1Ok = isCall && arg1?.type === "MemberExpression" &&
          arg1.object?.type === "Identifier" &&
          arg1.object.name === EXECUTION_HOST_ALLOWED_ARG1_OBJECT &&
          arg1.property?.type === "Identifier" &&
          arg1.property.name === EXECUTION_HOST_ALLOWED_ARG1_PROP;
        const argCount = isCall ? (node.arguments?.length ?? 0) : 0;
        const sameLocation = node.loc?.start?.line ===
            EXECUTION_HOST_CANONICAL_LOCATION.line &&
          node.loc?.start?.column === EXECUTION_HOST_CANONICAL_LOCATION.column;
        const count = (text.match(EXECUTION_HOST_ALLOWED_CALL_RE) ?? []).length;
        const allowed =
          isCanonicalHost && isCall && memberName === "instantiate" &&
          argCount === 2 && arg0Ok && arg1Ok && sameLocation && count === 1;
        if (!allowed) {
          violations.push(`${file}: calls dynamic WebAssembly API (execution host is absent or the allowed call shape deviates)`);
        }
      }
      if (
        node.type === "CallExpression" &&
        sinkName(node.callee, sinkAliases) === "fetch"
      ) {
        const value = foldString(node.arguments?.[0]);
        if (typeof value === "string" && /\.wasm(?:$|[?#])/iu.test(value)) {
          violations.push(
            `${file}: fetches a .wasm resource (network Wasm is forbidden)`,
          );
        } else if (isRemoteCodeUrl(value)) {
          violations.push(`${file}: fetches a remote JavaScript resource`);
        }
      }
      // (e) window/self/globalThis.__* oracle access (dot, bracket,
      //     template-literal, and statically foldable string concatenation).
      if (node.type === "MemberExpression") {
        const obj = node.object;
        let propName = null;
        if (!node.computed && node.property?.type === "Identifier") {
          propName = node.property.name;
        } else if (node.computed) {
          propName = foldString(node.property);
        }
        if (
          typeof propName === "string" &&
          propName.startsWith("__") &&
          obj?.type === "Identifier" &&
          ORACLE_GLOBALS.has(obj.name)
        ) {
          // The __zod_*/__vite_* exemption applies ONLY inside the generated
          // dependency bundle(s), never in shipped source.
          if (inGeneratedBundle && EXCLUDED_GLOBAL_ORACLE.test(propName)) {
            return;
          }
          violations.push(
            `${file}: accesses \`${obj.name}[${JSON.stringify(propName)}]\` (test oracle)`,
          );
        }
      }
    });
  }

  return violations;
}

/** Audit a set of immutable bundled Wasm fixtures. Production build discovery
 * passes every physical `.wasm`; a missing manifest mapping fails closed. */
export async function scanBundledWasmFiles(files, {
  readBytes,
  manifestByFile = new Map(),
} = {}) {
  if (typeof readBytes !== "function") {
    throw new Error("scanBundledWasmFiles requires readBytes(file)");
  }
  const violations = [];
  for (const file of [...files].sort()) {
    const executable = manifestByFile.get(file);
    if (!executable) {
      violations.push(`${file}: unmanifested_binary`);
      continue;
    }
    try {
      auditWasmBinary(new Uint8Array(await readBytes(file)), executable);
    } catch (error) {
      violations.push(`${file}: ${error?.code ?? "wasm_scan_failed"}`);
    }
  }
  return violations;
}
