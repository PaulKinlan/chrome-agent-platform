// @ts-nocheck
// bbz3s: check the package AJV REALLY resolves before either build target bundles it.
// Fixture stores are isolated under durable scratch; NEVER mutate shared node_modules.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { assertLiveFastUriResolution } from "../scripts/bundle-budget.mjs";

// Keep the pin independent of build execution: importing build.mjs starts a real build.
// Parse its original source (not esbuild output, whose offsets refer to transformed code).
const BUILD_SOURCE = new URL("../build.mjs", import.meta.url);
const GUARD = "assertLiveFastUriResolution";
const isName = (node, name) => node?.type === "Identifier" && node.name === name;
const isCall = (node, name) => node?.type === "CallExpression" && isName(node.callee, name);

function astNodes(program) {
  const nodes = [];
  const parents = new Map();
  function walk(node, parent = null) {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent);
      return;
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    nodes.push(node);
    parents.set(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "type", "loc"].includes(key)) continue;
      walk(value, node);
    }
  }
  walk(program);
  return { nodes, parents };
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((prop) => bindingNames(prop.value ?? prop.argument));
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  return [];
}

function shadowsName(node, name) {
  if (node.type === "VariableDeclarator" || node.type === "CatchClause") {
    return bindingNames(node.id ?? node.param).includes(name);
  }
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
    return isName(node.id, name) || node.params.some((param) => bindingNames(param).includes(name));
  }
  return node.type === "ClassDeclaration" && isName(node.id, name);
}

/** Require one live, unconditional import-bound check ahead of the ACTUAL esbuild fan-out. */
function isPropertyKey(node, parent) {
  if (!parent) return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
  return false;
}

function findScopedDeclarator(identNode, parents) {
  if (!identNode || identNode.type !== "Identifier" || !parents) return null;
  const name = identNode.name;
  for (let p = parents.get(identNode); p; p = parents.get(p)) {
    const stmts = Array.isArray(p.body) ? p.body : (Array.isArray(p.consequent) ? p.consequent : null);
    if (stmts) {
      for (const stmt of stmts) {
        if (stmt.type === "VariableDeclaration") {
          for (const decl of stmt.declarations) {
            if (decl.id.type === "Identifier" && decl.id.name === name) {
              return decl.init;
            }
          }
        }
      }
    }
    if ((p.type === "ForOfStatement" || p.type === "ForInStatement" || p.type === "ForStatement") && p.left?.type === "VariableDeclaration") {
      for (const decl of p.left.declarations) {
        if (bindingNames(decl.id).includes(name)) {
          return decl.init ?? null;
        }
      }
    }
    if (p.type === "ForStatement" && p.init?.type === "VariableDeclaration") {
      for (const decl of p.init.declarations) {
        if (bindingNames(decl.id).includes(name)) {
          return decl.init ?? null;
        }
      }
    }
    if (p.type === "CatchClause" && p.param && bindingNames(p.param).includes(name)) {
      return null;
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(p.type)) {
      if (p.params.some((param) => bindingNames(param).includes(name))) {
        return null;
      }
      if (p.id?.name === name) {
        return null;
      }
    }
    if ((p.type === "ClassDeclaration" || p.type === "ClassExpression") && p.id?.name === name) {
      return null;
    }
  }
  return null;
}

function evalStaticString(node, parents, seen = new Set()) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = evalStaticString(node.left, parents, seen);
    const right = evalStaticString(node.right, parents, seen);
    if (left !== null && right !== null) return left + right;
  }
  if (node.type === "Identifier" && parents && !seen.has(node)) {
    seen.add(node);
    const init = findScopedDeclarator(node, parents);
    if (init) return evalStaticString(init, parents, seen);
  }
  if (node.type === "MemberExpression" && node.computed) {
    let obj = node.object;
    if (obj.type === "Identifier" && parents && !seen.has(obj)) {
      seen.add(obj);
      obj = findScopedDeclarator(obj, parents) ?? obj;
    }
    let idxNode = node.property;
    if (idxNode.type === "Identifier" && parents && !seen.has(idxNode)) {
      seen.add(idxNode);
      idxNode = findScopedDeclarator(idxNode, parents) ?? idxNode;
    }
    if (obj?.type === "ArrayExpression" && idxNode?.type === "Literal" && typeof idxNode.value === "number") {
      return evalStaticString(obj.elements[idxNode.value], parents, seen);
    }
  }
  return null;
}

function containsLiteral(node, value) {
  if (!node) return false;
  if (node.type === "Literal" && node.value === value) return true;
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      if (child.some((c) => containsLiteral(c, value))) return true;
    } else if (child && typeof child === "object") {
      if (containsLiteral(child, value)) return true;
    }
  }
  return false;
}

function preBundleGuardProblems(source) {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const { nodes, parents } = astNodes(program);
  const problems = [];
  const guardImports = program.body.flatMap((node) => node.type === "ImportDeclaration" &&
      node.source.value === "./scripts/bundle-budget.mjs"
    ? node.specifiers.filter((spec) => spec.imported?.name === GUARD && spec.local?.name === GUARD)
    : []);
  if (guardImports.length !== 1) problems.push("the guard must be imported once, unaliased, from bundle-budget.mjs");
  if (nodes.some((node) => shadowsName(node, GUARD))) problems.push("the imported guard name is shadowed");
  const esbuildImports = program.body.flatMap((node) => node.type === "ImportDeclaration" && node.source.value === "esbuild"
    ? node.specifiers.filter((spec) => spec.imported?.name === "build" && spec.local?.name === "build") : []);
  if (esbuildImports.length !== 1 || nodes.some((node) => shadowsName(node, "build"))) {
    problems.push("build() must name the unshadowed esbuild import");
  }
  // The bundle scan below recognizes direct build() calls only. Keep the
  // esbuild binding surface closed, so buildSync/context/namespace imports or
  // a future bundling API cannot start work before the live guard unseen.
  const esbuildDeclarations = program.body.filter((node) =>
    node.type === "ImportDeclaration" && node.source.value === "esbuild");
  const esbuildSpecifiers = esbuildDeclarations.length === 1 ? esbuildDeclarations[0].specifiers : [];
  const esbuildNames = esbuildSpecifiers.map((spec) => spec.type === "ImportSpecifier"
    ? `${spec.imported.name}:${spec.local.name}` : "<default-or-namespace>").sort();
  if (esbuildDeclarations.length !== 1 || esbuildNames.join(",") !== "build:build,transform:transform") {
    problems.push("the esbuild import surface must be exactly { build, transform }");
  }
  // createRequire is used for unrelated dependency checks in this file; only
  // esbuild's specifier outside its one static import is prohibited (aat1m, i1gox, hz68x).
  const isEsbuildLoad = (node) => {
    if (isName(node, "esbuild") && !isPropertyKey(node, parents.get(node))) return true;
    if (node.type === "ImportExpression") {
      const argStr = evalStaticString(node.source, parents);
      if (argStr === "esbuild" || (node.source.type === "Identifier" && node.source.name === "esbuild") || containsLiteral(node.source, "esbuild")) return true;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const isReq = (callee.type === "Identifier" && callee.name === "require") ||
        (callee.type === "CallExpression" && isName(callee.callee, "createRequire"));
      if (isReq) {
        const argStr = evalStaticString(node.arguments[0], parents);
        if (argStr === "esbuild" || node.arguments[0]?.name === "esbuild" || containsLiteral(node.arguments[0], "esbuild")) return true;
      }
    }
    if (node.type === "Literal" && node.value === "esbuild" && !esbuildDeclarations.some((d) => d.source === node)) {
      const parent = parents.get(node);
      if (parent?.type === "ImportExpression" || (parent?.type === "CallExpression" && parent.arguments?.includes(node))) {
        return true;
      }
    }
    return false;
  };
  if (nodes.some(isEsbuildLoad)) {
    problems.push("esbuild cannot be loaded outside its static import");
  }
  if (nodes.some((node) => isName(node, "build") &&
    !isPropertyKey(node, parents.get(node)) &&
    !esbuildSpecifiers.some((spec) => spec.imported === node || spec.local === node) &&
    !(parents.get(node)?.type === "CallExpression" && parents.get(node).callee === node))) {
    problems.push("build must be called directly, never aliased or passed elsewhere");
  }

  const calls = nodes.filter((node) => isCall(node, GUARD));
  if (calls.length !== 1) problems.push(`expected exactly one live guard call, found ${calls.length}`);
  const bundles = nodes.filter((node) => isCall(node, "build"));
  if (!bundles.length) problems.push("no esbuild build() calls: the bundle scan is vacuous");
  const fanouts = nodes.filter((node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "ArrayPattern") return false;
    if (!bindingNames(node.id).includes("swResult") || !bindingNames(node.id).includes("workerResult")) return false;
    const settle = node.init?.type === "AwaitExpression" ? node.init.argument : null;
    return isCall(settle, "settleAll") && settle.arguments[0]?.type === "ArrayExpression" &&
      settle.arguments[0].elements.length > 0 && settle.arguments[0].elements.every((element) => isCall(element, "build"));
  });
  if (fanouts.length !== 1) problems.push(`expected one real bundled-results settleAll fan-out, found ${fanouts.length}`);
  // Preserve the old --frozen-lockfile pin, but on an executable call rather
  // than text that a comment or a misleading label could satisfy.
  const frozenInstalls = nodes.filter((node) => isCall(node, "runBoundedChild") &&
    node.arguments[0]?.value === "deno" && node.arguments[1]?.type === "ArrayExpression" &&
    node.arguments[1].elements.length === 2 && node.arguments[1].elements[0]?.value === "install" &&
    node.arguments[1].elements[1]?.value === "--frozen-lockfile");
  if (frozenInstalls.length !== 2) problems.push("both deno install repairs must invoke runBoundedChild with --frozen-lockfile");

  if (calls.length === 1) {
    const call = calls[0];
    const statement = parents.get(call);
    const block = parents.get(statement);
    if (statement?.type !== "ExpressionStatement" || statement.expression !== call || block?.type !== "BlockStatement") {
      problems.push("the guard must be its own direct statement");
    }
    const props = call.arguments[0]?.type === "ObjectExpression" ? call.arguments[0].properties : [];
    if (call.arguments.length !== 1 || props.length !== 2 ||
      !props.some((p) => !p.computed && isName(p.key, "root") && isName(p.value, "ROOT")) ||
      !props.some((p) => !p.computed && isName(p.key, "sdkDir") && isName(p.value, "CANON_MCP_SDK_DIR"))) {
      problems.push("the guard must resolve the live root and canonical SDK instance");
    }
    // A check inside a branch, function, catch, or a swallowing try/catch can
    // leave the other build target unguarded even when its text comes first.
    for (let child = statement; child; child = parents.get(child)) {
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "IfStatement", "SwitchCase",
        "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "CatchClause",
        "ConditionalExpression"].includes(child.type)) {
        problems.push(`the guard is conditional or deferred under ${child.type}`);
      }
      if (child.type === "TryStatement" && (child.handler || child.block !== parents.get(statement) &&
        !isAncestor(child.block, statement, parents))) {
        problems.push("the guard can be caught or bypassed by a try clause");
      }
    }
    if (fanouts.length === 1) {
      const fanoutStatement = parents.get(fanouts[0]);
      if (block !== parents.get(fanoutStatement) || statement.start >= fanoutStatement.start) {
        problems.push("the guard must precede the real bundle fan-out in the same straight-line block");
      }
    }
    if (bundles.some((bundle) => bundle.start < statement.end)) {
      problems.push("an esbuild build() starts before the guard");
    }
  }
  return problems;
}

function isAncestor(ancestor, child, parents) {
  for (let node = child; node; node = parents.get(node)) if (node === ancestor) return true;
  return false;
}

const replaceOnce = (source, needle, replacement) => {
  assertEquals(source.split(needle).length, 2, `the real build must contain one ${needle.slice(0, 70)}`);
  return source.replace(needle, replacement);
};

Deno.test("bbz3s: an unconditional live AJV check precedes the real developer/store bundle fan-out", () => {
  const source = Deno.readTextFileSync(BUILD_SOURCE);
  assertEquals(preBundleGuardProblems(source), [], "both targets must verify AJV before calling esbuild");
});

Deno.test("bbz3s: comment, conditional, late and swallowed-check mutants cannot satisfy the pre-bundle pin", () => {
  const source = Deno.readTextFileSync(BUILD_SOURCE);
  const line = "    assertLiveFastUriResolution({ root: ROOT, sdkDir: CANON_MCP_SDK_DIR });";
  const late = replaceOnce(replaceOnce(source, line, ""), "    const chunksDir =", `${line}\n    const chunksDir =`);
  const mutants = [
    ["removed guard, comment decoy", replaceOnce(source, line, `    // ${line.trim()} await settleAll([; const capAiSdkDedup =`), "exactly one live guard call"],
    ["guarded only in store builds", replaceOnce(source, line, `    if (BUILD_TARGET === "store") ${line.trim()}`), "conditional or deferred"],
    ["guard moved after actual esbuild fan-out", late, "esbuild build() starts before the guard"],
    ["guard exception swallowed", replaceOnce(source, line, `    try { ${line.trim()} } catch {}`), "caught or bypassed"],
    ["guard call only in void expression", replaceOnce(source, line, `    void ${line.trim()}`), "own direct statement"],
    ["one install missing frozen lockfile", replaceOnce(source,
      'rmSync(denoStoreDir, { recursive: true, force: true });\n        const res = await runBoundedChild("deno", ["install", "--frozen-lockfile"]',
      'rmSync(denoStoreDir, { recursive: true, force: true });\n        const res = await runBoundedChild("deno", ["install"]'), "both deno install repairs"],
    ["esbuild import replaced by local fake", replaceOnce(source,
      'import { build, transform } from "esbuild";',
      'import { transform } from "esbuild"; const build = () => ({})'), "unshadowed esbuild import"],
    ["buildSync imported and called before guard", replaceOnce(replaceOnce(source,
      'import { build, transform } from "esbuild";',
      'import { build, buildSync, transform } from "esbuild";'), line,
      `    buildSync({ entryPoints: ["decoy.js"], outfile: "decoy.js" });\n${line}`), "esbuild import surface"],
    ["context imported and called before guard", replaceOnce(replaceOnce(source,
      'import { build, transform } from "esbuild";',
      'import { build, context, transform } from "esbuild";'), line,
      `    await context({ entryPoints: ["decoy.js"], outfile: "decoy.js" });\n${line}`), "esbuild import surface"],
    ["namespace import hides a bundle call", replaceOnce(source,
      'import { build, transform } from "esbuild";',
      'import { build, transform } from "esbuild"; import * as esbuild from "esbuild";'), "esbuild import surface"],
    ["require reaches another esbuild binding", replaceOnce(source, line,
      `    const decoy = createRequire(import.meta.url)("esbuild");\n${line}`), "esbuild cannot be loaded outside"],
    ["dynamic import reaches another esbuild binding", replaceOnce(source, line,
      `    const decoy = await import("esbuild");\n${line}`), "esbuild cannot be loaded outside"],
    ["dynamic import assembled specifier (i1gox)", replaceOnce(source, line,
      `    const decoy = await import("esb" + "uild");\n${line}`), "esbuild cannot be loaded outside"],
    ["dynamic import identifier (i1gox)", replaceOnce(source, line,
      `    const decoy = await import(esbuild);\n${line}`), "esbuild cannot be loaded outside"],
    ["require computed member access (hz68x)", replaceOnce(source, line,
      `    const decoy = require(["esbuild"][0]);\n${line}`), "esbuild cannot be loaded outside"],
    ["require hoisted identifier specifier (pap3g)", replaceOnce(source, line,
      `    const __probe = "esbuild"; const decoy = require(__probe);\n${line}`), "esbuild cannot be loaded outside"],
    ["require hoisted array element specifier (pap3g)", replaceOnce(source, line,
      `    const __probeArr = ["esbuild"]; const decoy = require(__probeArr[0]);\n${line}`), "esbuild cannot be loaded outside"],
    ["require scoped identifier shadowing (ynkzd)", replaceOnce(source, line,
      `    function __f(){ const __n = "esbuild"; require(__n); } const __n = "lodash";\n${line}`), "esbuild cannot be loaded outside"],
    ["dynamic import computed member access (hz68x)", replaceOnce(source, line,
      `    const decoy = await import(["esbuild"][0]);\n${line}`), "esbuild cannot be loaded outside"],
    ["build alias evades the bundle scan", replaceOnce(source, line,
      `    const bundledEarly = build; bundledEarly({ entryPoints: ["decoy.js"] });\n${line}`), "build must be called directly"],
  ];
  for (const [name, mutant, expected] of mutants) {
    assert(mutant !== source, `${name} must change the real source`);
    assert(preBundleGuardProblems(mutant).some((s) => s.includes(expected)), `${name} must RED on ${expected}`);
  }
  // Unlike the old capAiSdkDedup string anchor, moving the check past the
  // plugin but still before the real bundle fan-out remains a valid order.
  const reordered = replaceOnce(replaceOnce(source, line, ""), "    const shared = {", `${line}\n    const shared = {`);
  assertEquals(preBundleGuardProblems(reordered), [], "an unconditional check need not precede plugin definition");
  const nonBundling = replaceOnce(source, line, `    await transform("1", { loader: "js" });\n${line}`);
  assertEquals(preBundleGuardProblems(nonBundling), [], "a non-bundling transform before the guard is allowed");
  // aat1m: unrelated non-call uses of "build" as a property key or literal "esbuild" in arrays must not falsely RED
  const legalProp = replaceOnce(source, line, `    const cfg = { build: 1 }; const ext = ["esbuild"];\n${line}`);
  assertEquals(preBundleGuardProblems(legalProp), [], "aat1m: property key build and literal esbuild in array must not red");
  // ynkzd: unrelated local require shadowed by an outer "esbuild" const must not falsely RED
  const legalShadow = replaceOnce(source, line, `    function __g(){ const __n = "lodash"; require(__n); } const __n = "esbuild";\n${line}`);
  assertEquals(preBundleGuardProblems(legalShadow), [], "ynkzd: local non-esbuild require shadowed by outer esbuild const must not red");
  // ja7kv: unrelated require of a function/catch parameter shadowing an outer "esbuild" const must not falsely RED
  const legalParam = replaceOnce(source, line, `    function __h(__n){ require(__n); } const __n = "esbuild";\n${line}`);
  assertEquals(preBundleGuardProblems(legalParam), [], "ja7kv: function param shadowing outer esbuild const must not red");
  const legalCatch = replaceOnce(source, line, `    try {} catch (__n){ require(__n); } const __n = "esbuild";\n${line}`);
  assertEquals(preBundleGuardProblems(legalCatch), [], "ja7kv: catch param shadowing outer esbuild const must not red");
  // tp912: named function/class expression id and for-of head declarator shadowing outer esbuild const must not falsely RED
  const legalFne = replaceOnce(source, line, `    const __fne = function __n(){ require(__n); }; const __n = "esbuild";\n${line}`);
  assertEquals(preBundleGuardProblems(legalFne), [], "tp912: function expression id shadowing outer esbuild const must not red");
  const legalCe = replaceOnce(source, line, `    const __ce = class __n { static m(){ require(__n); } }; const __n = "esbuild";\n${line}`);
  assertEquals(preBundleGuardProblems(legalCe), [], "tp912: class expression id shadowing outer esbuild const must not red");
  const legalForOf = replaceOnce(source, line, `    for (const __n of ["x"]) { require(__n); } const __n = "esbuild";\n${line}`);
  assertEquals(preBundleGuardProblems(legalForOf), [], "tp912: for-of head declarator shadowing outer esbuild const must not red");
  assertEquals(Deno.readTextFileSync(BUILD_SOURCE), source, "mutations stay in memory: build.mjs is byte-identical");
});

Deno.test("bbz3s: stale, mixed, flat and dangling AJV links fail closed against BOTH locks", () => {
  const roots: string[] = [];
  const fixture = (versions: string[], target: string, options: { sdk?: string; deno?: string; shadow?: string } = {}) => {
    // Node caches require.resolve results: each case needs a FRESH root, just
    // as each build is a fresh Node process. Repointing one link mid-test can
    // read Node's old resolver cache rather than the disk state under test.
    const root = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "layout-" });
    roots.push(root);
    const sdkDir = join(root, "node_modules", ".deno", "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol", "sdk");
    const ajvDir = join(sdkDir, "node_modules", "ajv");
    const store = (version: string) => join(root, "node_modules", ".deno", `fast-uri@${version}`, "node_modules", "fast-uri");
    Deno.mkdirSync(join(ajvDir, "node_modules"), { recursive: true });
    Deno.mkdirSync(join(ajvDir, "dist", "runtime"), { recursive: true });
    Deno.writeTextFileSync(join(ajvDir, "dist", "runtime", "uri.js"), 'module.exports = require("fast-uri");\n');
    Deno.writeTextFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", version: options.sdk ?? "1.31.0" }));
    Deno.writeTextFileSync(join(ajvDir, "package.json"), JSON.stringify({ name: "ajv", version: "8.20.0" }));
    for (const version of versions) {
      Deno.mkdirSync(store(version), { recursive: true });
      Deno.writeTextFileSync(join(store(version), "package.json"), JSON.stringify({ name: "fast-uri", version }));
    }
    const flat = join(root, "node_modules", "fast-uri");
    if (target === "flat") {
      Deno.mkdirSync(flat, { recursive: true });
      Deno.writeTextFileSync(join(flat, "package.json"), JSON.stringify({ name: "fast-uri", version: "3.1.8" }));
    }
    Deno.symlinkSync(target === "flat" ? flat : store(target), join(ajvDir, "node_modules", "fast-uri"));
    if (options.shadow) {
      const nested = join(ajvDir, "dist", "runtime", "node_modules");
      Deno.mkdirSync(nested, { recursive: true });
      Deno.symlinkSync(store(options.shadow), join(nested, "fast-uri"));
    }
    Deno.writeTextFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "node_modules/fast-uri": { version: "3.1.8", integrity: "sha512-test" },
      "node_modules/@modelcontextprotocol/sdk": { version: "1.31.0" },
    } }));
    Deno.writeTextFileSync(join(root, "deno.lock"), JSON.stringify({ npm: {
      [`fast-uri@${options.deno ?? "3.1.8"}`]: { integrity: options.deno ? "sha512-old" : "sha512-test" },
      "@modelcontextprotocol/sdk@1.31.0_zod@3.25.76": { integrity: "sha512-sdk" },
      "@modelcontextprotocol/sdk@1.31.0_zod@4.4.3": { integrity: "sha512-sdk" },
    } }));
    return { root, sdkDir, expected: join(store("3.1.8"), "package.json") };
  };
  try {
    // Old store ONLY: both locks are patched but AJV resolves vulnerable bytes.
    const stale = assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.5"], "3.1.5")),
      Error, "cap-security-dependency-resolve:");
    assertStringIncludes(stale.message, "fast-uri 3.1.5");
    assertStringIncludes(stale.message, "fast-uri 3.1.8");
    // Both directories present: checking for patched-dir PRESENCE would pass.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.5", "3.1.8"], "3.1.5"))).message,
      "fast-uri 3.1.5");
    // The actual importer is Ajv dist/runtime/uri.js, not Ajv package.json:
    // even a correct package-root link can be shadowed by a nested old copy.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.5", "3.1.8"], "3.1.8", { shadow: "3.1.5" }))).message, "fast-uri 3.1.5");
    const good = fixture(["3.1.8"], "3.1.8");
    const current = assertLiveFastUriResolution(good);
    assertEquals(current.version, "3.1.8");
    assertEquals(current.path, good.expected);
    // Same version in FLAT npm copy is not the Deno-store copy esbuild expects.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.8"], "flat"))).message,
      "npm and Deno locks require");
    const dangling = assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.8"], "3.1.6")),
      Error, "cap-security-dependency-resolve:");
    assertStringIncludes(dangling.message, "SDK -> AJV -> fast-uri cannot resolve");
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.8"], "3.1.8", { deno: "3.1.5" }))).message, "fast-uri locks disagree");
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.8"], "3.1.8", { sdk: "1.30.0" }))).message, "MCP SDK lock vs selected Deno-store instance");
  } finally {
    for (const root of roots) Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("c1e3s: symlinked node_modules or .deno store fails with actionable recovery message", () => {
  const root = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "symlink-root-" });
  const realStore = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "real-store-" });
  try {
    // Case 1: root/node_modules is a symlink to realStore
    Deno.symlinkSync(realStore, join(root, "node_modules"));
    const err = assertThrows(
      () => assertLiveFastUriResolution({ root, sdkDir: join(realStore, "sdk") }),
      Error,
      "cap-security-dependency-resolve:",
    );
    assertStringIncludes(err.message, "is a SYMLINK →");
    assertStringIncludes(err.message, "rm -rf node_modules && npm ci && deno install");
    assertStringIncludes(err.message, "never run deno install alone against a symlinked store");

    // Case 2: root/node_modules is real dir, but root/node_modules/.deno is a symlink
    Deno.removeSync(join(root, "node_modules"));
    Deno.mkdirSync(join(root, "node_modules"), { recursive: true });
    Deno.symlinkSync(realStore, join(root, "node_modules", ".deno"));
    const err2 = assertThrows(
      () => assertLiveFastUriResolution({ root, sdkDir: join(realStore, "sdk") }),
      Error,
      "cap-security-dependency-resolve:",
    );
    assertStringIncludes(err2.message, "is a SYMLINK →");
    assertStringIncludes(err2.message, "rm -rf node_modules && npm ci && deno install");
    assertStringIncludes(err2.message, "never run deno install alone against a symlinked store");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(realStore, { recursive: true });
  }
});

Deno.test("c1e3s: build.mjs refuses symlinked node_modules and .deno store BEFORE automatic deno install repair", async () => {
  const buildScript = await Deno.readTextFile(new URL("../build.mjs", import.meta.url));
  const preRepairBlock = buildScript.match(/const nmDir = path\.join\(ROOT, "node_modules"\);[\s\S]*?(?=let denoEntries = \[\];)/);
  assert(preRepairBlock, "build.mjs must contain pre-repair symlink guard before let denoEntries");
  assertStringIncludes(preRepairBlock[0], 'lstatSync(nmDir).isSymbolicLink()', "pre-repair guard must check nmDir");
  assertStringIncludes(preRepairBlock[0], 'lstatSync(denoStoreDir).isSymbolicLink()', "pre-repair guard must check denoStoreDir");
  const repairCallIndex = buildScript.indexOf('runBoundedChild("deno", ["install", "--frozen-lockfile"]');
  assert(repairCallIndex > 0, "build.mjs must contain repair call");
  assert(buildScript.indexOf('const nmDir = path.join(ROOT, "node_modules");') < repairCallIndex,
    "pre-repair symlink check must execute before any repair runBoundedChild call");

  // Dynamic execution test: run the pre-repair logic against mock layouts
  const tmp = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "build-guard-" });
  const realStore = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "real-store-" });
  try {
    const testRunner = `
import fs, { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
const ROOT = process.argv[2];
${preRepairBlock[0]}
console.log("GUARD_PASSED");
`;
    const runnerScript = join(tmp, "runner.mjs");
    Deno.writeTextFileSync(runnerScript, testRunner);

    // Test 1: symlinked node_modules
    const worktree1 = join(tmp, "wt1");
    Deno.mkdirSync(worktree1, { recursive: true });
    Deno.symlinkSync(realStore, join(worktree1, "node_modules"));
    const p1 = await new Deno.Command("node", { args: [runnerScript, worktree1] }).output();
    assertEquals(p1.code, 1);
    const err1 = new TextDecoder().decode(p1.stderr);
    assertStringIncludes(err1, "cap-security-dependency-resolve:");
    assertStringIncludes(err1, "is a SYMLINK →");
    assertStringIncludes(err1, "rm -rf node_modules && npm ci && deno install");

    // Test 2: real node_modules, symlinked .deno
    const worktree2 = join(tmp, "wt2");
    Deno.mkdirSync(join(worktree2, "node_modules"), { recursive: true });
    Deno.symlinkSync(realStore, join(worktree2, "node_modules", ".deno"));
    const p2 = await new Deno.Command("node", { args: [runnerScript, worktree2] }).output();
    assertEquals(p2.code, 1);
    const err2 = new TextDecoder().decode(p2.stderr);
    assertStringIncludes(err2, "cap-security-dependency-resolve:");
    assertStringIncludes(err2, "is a SYMLINK →");
    assertStringIncludes(err2, "rm -rf node_modules && npm ci && deno install");

    // Test 3: verify remediation command applicability on both layout shapes
    const pRm1 = await new Deno.Command("sh", { args: ["-c", "rm -rf node_modules"], cwd: worktree1 }).output();
    assertEquals(pRm1.code, 0);
    assertThrows(() => Deno.lstatSync(join(worktree1, "node_modules")), Deno.errors.NotFound);
    assertEquals(Deno.statSync(realStore).isDirectory, true, "realStore must not be deleted by symlink removal");

    const pRm2 = await new Deno.Command("sh", { args: ["-c", "rm -rf node_modules"], cwd: worktree2 }).output();
    assertEquals(pRm2.code, 0);
    assertThrows(() => Deno.lstatSync(join(worktree2, "node_modules")), Deno.errors.NotFound);
    assertEquals(Deno.statSync(realStore).isDirectory, true, "realStore must not be deleted by directory removal");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
    Deno.removeSync(realStore, { recursive: true });
  }
});
