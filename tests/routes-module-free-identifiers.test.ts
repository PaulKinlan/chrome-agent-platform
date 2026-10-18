// tests/routes-module-free-identifiers.test.ts — chrome-agent-platform-atxc6.
//
// Every route module under extension/background/routes/ is now a SEPARATE ES module, which means moving a
// handler out of the worker also means moving (or importing) everything it calls. Miss one and the handler
// does not fail to load — it fails at CALL time, with ReferenceError, in whichever surface first exercises
// it. That is exactly what shipped in the first cut of routes/tool-stream.js: the file imported the read /
// remove helpers and forgot the input trio it calls (createWasmStreamInput, appendWasmStreamInputBase64,
// sealWasmStreamInput), so bundled-tool input creation was dead on arrival while the fast gate stayed green
// — nothing in the suite INVOKED those three routes (review finding chrome-agent-platform-fwx5n).
//
// A gate that only fires when someone happens to call the route is not a gate. This one is static: in every
// route module, every identifier used as a CALL TARGET must resolve in its OWN lexical scope — to a
// parameter, a declaration in an enclosing scope, an import, or a known global.
//
// SCOPE-AWARE, not name-unioned (chrome-agent-platform-e0177): the first version of this file collected
// every declaration in the file into one set and every callee into another, so an unrelated nested
// parameter `function unrelated(missing) {}` silently excused a genuinely free `missing()` call — a mutant
// that changed nothing at runtime but made the guard blind. Declarations are now attached to the scope that
// owns them (params + `var` hoisted to the function, `let`/`const`/`class`/`function` to their block, block
// children of every scope node) and a callee is resolved by walking the chain from the call site.
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";

const GLOBALS = new Set([
  "Object", "Array", "JSON", "Math", "String", "Number", "Boolean", "Promise", "Map", "Set", "WeakMap",
  "WeakSet", "Error", "TypeError", "RangeError", "SyntaxError", "Date", "RegExp", "Symbol", "BigInt",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "structuredClone", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "fetch", "crypto", "console", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController",
  "atob", "btoa", "Intl", "AggregateError", "Reflect", "Proxy", "globalThis", "performance",
  "Uint8Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView",
]);

const KEYS = (node) => Object.keys(node).filter((k) => !["type", "start", "end", "loc", "range"].includes(k));
const newScope = (parent = null) => ({ parent, names: new Set() });
function resolves(scope, name) {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return false;
}
function declarePattern(node, scope) {
  if (!node) return;
  switch (node.type) {
    case "Identifier": scope.names.add(node.name); break;
    case "ObjectPattern":
      for (const p of node.properties) declarePattern(p.type === "RestElement" ? p.argument : p.value, scope);
      break;
    case "ArrayPattern": for (const el of node.elements) declarePattern(el, scope); break;
    case "AssignmentPattern": declarePattern(node.left, scope); break;
    case "RestElement": declarePattern(node.argument, scope); break;
    default: break;
  }
}

// `var` and function declarations belong to the nearest FUNCTION (or program) scope, so they are collected
// by descending through blocks but never through a nested function.
function hoistVars(node, scope) {
  if (!node || typeof node.type !== "string") return;
  if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
    if (node.type === "FunctionDeclaration" && node.id?.name) scope.names.add(node.id.name);
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const d of node.declarations) declarePattern(d.id, scope);
  }
  for (const key of KEYS(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) hoistVars(child, scope);
    else if (value && typeof value.type === "string") hoistVars(value, scope);
  }
}

function collect(ast) {
  const freeCallees = new Map(); // name -> node

  // Block-level declarations of the statements DIRECTLY in this scope.
  function declareBlock(statements, scope) {
    for (const statement of statements ?? []) {
      if (!statement) continue;
      if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
        for (const d of statement.declarations) declarePattern(d.id, scope);
      } else if (statement.type === "FunctionDeclaration" && statement.id?.name) scope.names.add(statement.id.name);
      else if (statement.type === "ClassDeclaration" && statement.id?.name) scope.names.add(statement.id.name);
    }
  }

  function walk(node, scope) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "ImportDeclaration":
        for (const s of node.specifiers) if (s.local?.name) scope.names.add(s.local.name);
        return;
      case "Program": {
        const programScope = newScope(null);
        hoistVars(node, programScope);
        declareBlock(node.body, programScope);
        for (const statement of node.body) walk(statement, programScope);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const functionScope = newScope(scope);
        if (node.type === "FunctionExpression" && node.id?.name) functionScope.names.add(node.id.name);
        for (const p of node.params ?? []) declarePattern(p, functionScope);
        hoistVars(node.body, functionScope);
        if (node.body?.type === "BlockStatement") {
          const bodyScope = newScope(functionScope);
          declareBlock(node.body.body, bodyScope);
          for (const statement of node.body.body) walk(statement, bodyScope);
        } else {
          walk(node.body, functionScope);
        }
        return;
      }
      case "BlockStatement": {
        const blockScope = newScope(scope);
        declareBlock(node.body, blockScope);
        for (const statement of node.body) walk(statement, blockScope);
        return;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement": {
        const loopScope = newScope(scope);
        if (node.init?.type === "VariableDeclaration" && node.init.kind !== "var") {
          for (const d of node.init.declarations) declarePattern(d.id, loopScope);
        }
        if (node.left?.type === "VariableDeclaration" && node.left.kind !== "var") {
          for (const d of node.left.declarations) declarePattern(d.id, loopScope);
        }
        for (const key of KEYS(node)) {
          const value = node[key];
          if (Array.isArray(value)) for (const child of value) walk(child, loopScope);
          else if (value && typeof value.type === "string") walk(value, loopScope);
        }
        return;
      }
      case "CatchClause": {
        const catchScope = newScope(scope);
        declarePattern(node.param, catchScope);
        walk(node.body, catchScope);
        return;
      }
      case "CallExpression":
      case "NewExpression":
        if (node.callee?.type === "Identifier" && !resolves(scope, node.callee.name) &&
            !GLOBALS.has(node.callee.name) && !freeCallees.has(node.callee.name)) {
          freeCallees.set(node.callee.name, node.callee);
        }
        break;
      default: break;
    }
    for (const key of KEYS(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) walk(child, scope);
      else if (value && typeof value.type === "string") walk(value, scope);
    }
  }

  walk(ast, null);
  return { freeCallees };
}

const ROUTES_DIR = new URL("../extension/background/routes/", import.meta.url);

Deno.test("route modules: every call target resolves in its own lexical scope", async () => {
  const problems = [];
  let modules = 0;
  for await (const entry of Deno.readDir(ROUTES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".js")) continue;
    modules += 1;
    const code = await Deno.readTextFile(new URL(entry.name, ROUTES_DIR));
    const { freeCallees } = collect(acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }));
    for (const [name] of freeCallees) {
      problems.push(`extension/background/routes/${entry.name} calls ${name}(...) but never declares or imports it`);
    }
  }
  assert(modules >= 15, `expected to scan the route modules, saw ${modules}`);
  assertEquals(problems, [], `a route module calls something it does not have — the handler would throw ReferenceError at call time:\n${problems.join("\n")}`);
});

Deno.test("route modules: the scanner detects a missing import (self-check)", () => {
  const source = `
import { present } from "./dep.js";
export function factory() {
  return Object.freeze({ async "x.run"() { return await present(); } });
}
function broken() { return absent(); }
`;
  const { freeCallees } = collect(acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  assertEquals([...freeCallees.keys()], ["absent"]);
});

Deno.test("route modules: an unrelated nested parameter cannot excuse a free callee (e0177)", () => {
  // The exact mutant from the finding: it changes nothing at runtime, but the first (name-union) scanner
  // saw `missing` declared as a parameter elsewhere in the file and stayed silent.
  const source = `export function route() { return missing(); } export function unrelated(missing) {}`;
  const { freeCallees } = collect(acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  assertEquals([...freeCallees.keys()], ["missing"], "a parameter in ANOTHER function must not resolve this call");

  // ...and the honest neighbouring cases must still resolve: a parameter, a hoisted var, a block declaration
  // and an import are all real bindings at the call site.
  const ok = `
import { imported } from "./dep.js";
export async function factory(config) {
  const local = () => 1;
  let block = 2;
  if (config) { var hoisted = 3; function nested() { return hoisted; } nested(); }
  return await imported(local(), block, config);
}
`;
  const resolved = collect(acorn.parse(ok, { ecmaVersion: "latest", sourceType: "module" }));
  assertEquals([...resolved.freeCallees.keys()], []);
});
