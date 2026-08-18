// scan-shipped.mjs — structural shipped-code audit using a REAL JavaScript
// parser (acorn). Replaces the earlier regex scan: exports are discovered by
// walking the AST, so every export form is covered (export declarations, export
// lists, `export { x as __y }` aliases, and `export default <__identifier>`), and
// `window.__*` / `self.__*` / `globalThis.__*` oracle access is found via
// MemberExpression nodes — not by pattern-matching source text.

import { parse } from "acorn";

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

/**
 * Scan the given shipped JS files. Returns a list of human-readable violation
 * strings (empty when clean). Each file is parsed with acorn; a file that does
 * not parse as ESM is reported as a violation (shipped code must be parseable),
 * except files the caller opts out of (none by default).
 */
export async function scanShippedJs(files) {
  const violations = [];

  for (const file of files) {
    const text = await readText(file);

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
        const d = node.declaration;
        if (d?.type === "Identifier" && d.name.startsWith("__")) {
          violations.push(
            `${file}: default-exports \`${d.name}\` (__-prefixed test seam)`,
          );
        }
      }
      // (b) window/self/globalThis.__* oracle access (dot AND bracket access).
      if (node.type === "MemberExpression") {
        const obj = node.object;
        let propName = null;
        if (!node.computed && node.property?.type === "Identifier") {
          propName = node.property.name;
        } else if (
          node.computed &&
          node.property?.type === "Literal" &&
          typeof node.property.value === "string"
        ) {
          propName = node.property.value;
        }
        if (
          propName &&
          propName.startsWith("__") &&
          !EXCLUDED_GLOBAL_ORACLE.test(propName) &&
          obj?.type === "Identifier" &&
          ORACLE_GLOBALS.has(obj.name)
        ) {
          violations.push(
            `${file}: accesses \`${obj.name}[${JSON.stringify(propName)}]\` (test oracle)`,
          );
        }
      }
    });
  }

  return violations;
}

async function readText(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
