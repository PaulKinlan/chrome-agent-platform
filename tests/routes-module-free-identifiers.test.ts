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
// route module, every identifier used as a CALL TARGET must resolve to a declaration, a parameter, an
// import, or a known global. It is deliberately narrow (callees only) so it cannot drown in property names,
// object keys and labels — the false-positive class that gets a guard deleted.
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

function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case "Identifier": out.add(node.name); break;
    case "ObjectPattern":
      for (const p of node.properties) patternNames(p.type === "RestElement" ? p.argument : p.value, out);
      break;
    case "ArrayPattern": for (const el of node.elements) patternNames(el, out); break;
    case "AssignmentPattern": patternNames(node.left, out); break;
    case "RestElement": patternNames(node.argument, out); break;
    default: break;
  }
}

function collect(ast) {
  const declared = new Set();
  const callees = new Map(); // name -> first node (for the failure message)
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "VariableDeclarator": patternNames(node.id, declared); break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id?.name) declared.add(node.id.name);
        for (const p of node.params ?? []) patternNames(p, declared);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id?.name) declared.add(node.id.name);
        break;
      case "CatchClause": patternNames(node.param, declared); break;
      case "ImportDeclaration":
        for (const s of node.specifiers) if (s.local?.name) declared.add(s.local.name);
        break;
      case "CallExpression":
      case "NewExpression":
        if (node.callee?.type === "Identifier" && !callees.has(node.callee.name)) {
          callees.set(node.callee.name, node.callee);
        }
        break;
      default: break;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value.type === "string") visit(value);
    }
  };
  visit(ast);
  return { declared, callees };
}

const ROUTES_DIR = new URL("../extension/background/routes/", import.meta.url);

Deno.test("route modules: every call target resolves to a declaration, a parameter, an import, or a global", async () => {
  const problems = [];
  let modules = 0;
  for await (const entry of Deno.readDir(ROUTES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".js")) continue;
    modules += 1;
    const code = await Deno.readTextFile(new URL(entry.name, ROUTES_DIR));
    const { declared, callees } = collect(acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }));
    for (const [name] of callees) {
      if (declared.has(name) || GLOBALS.has(name)) continue;
      problems.push(`extension/background/routes/${entry.name} calls ${name}(...) but never declares or imports it`);
    }
  }
  assert(modules >= 15, `expected to scan the route modules, saw ${modules}`);
  assertEquals(problems, [], `a route module calls something it does not have — the handler would throw ReferenceError at call time:\n${problems.join("\n")}`);
});

Deno.test("route modules: the scanner actually detects a missing import (self-check)", () => {
  // A guard nobody mutation-checked is a guard nobody knows works. This asserts the exact defect shape the
  // test above exists for: a callee that is never imported.
  const source = `
import { present } from "./dep.js";
export function factory() {
  return Object.freeze({ async "x.run"() { return await present(); } });
}
function broken() { return absent(); }
`;
  const { declared, callees } = collect(acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  const free = [...callees.keys()].filter((n) => !declared.has(n) && !GLOBALS.has(n));
  assertEquals(free, ["absent"]);
});
