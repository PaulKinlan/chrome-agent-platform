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

/**
 * Scan the given shipped JS files. `generatedBundles` is the set of file paths
 * that are GENERATED dependency bundles (esbuild output inlining zod/vite); only
 * there are the `__zod_*` / `__vite_*` oracle exemptions allowed. `readText` is
 * the injected file reader (the caller owns file I/O so this module stays
 * importable from BOTH node and Deno without a node:fs type dependency).
 * Returns a list of human-readable violation strings (empty when clean).
 */
export async function scanShippedJs(files, { generatedBundles = new Set(), readText } = {}) {
  if (typeof readText !== "function") {
    throw new Error("scanShippedJs requires an injected readText(file) function");
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
      });
    } catch (err) {
      violations.push(
        `${file}: not parseable as a JS module (${err.message})`,
      );
      continue;
    }

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
      // (b) Dynamic Wasm construction/compilation and literal .wasm fetches
      // are forbidden in shipped source. The bundled authority is record-only;
      // a future host requires a separately reviewed static CAS route.
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === "WebAssembly"
      ) {
        violations.push(`${file}: calls dynamic WebAssembly API (execution host is absent)`);
      }
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" && node.callee.name === "fetch" &&
        typeof node.arguments?.[0]?.value === "string" && /\.wasm(?:$|[?#])/iu.test(node.arguments[0].value)
      ) {
        violations.push(`${file}: fetches a .wasm resource (network Wasm is forbidden)`);
      }
      // (c) window/self/globalThis.__* oracle access (dot, bracket,
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
