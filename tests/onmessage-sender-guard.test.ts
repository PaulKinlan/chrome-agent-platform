// @ts-nocheck
// tests/onmessage-sender-guard.test.ts — pins the non-dispatcher onMessage sender authority guard (7z3m).
//
// Invariants guarded:
//   1. Every `chrome.runtime.onMessage.addListener` call in extension/ must accept a `sender` parameter
//      and validate it by CALLING the vetted production predicate (isTrustedServiceWorkerSender or
//      its exported aliases), resolved through the file's import bindings — or be listed in
//      ALLOWLISTED_SITES with a one-line justification naming what checks the sender instead.
//      Inline sender checks, however correct, never count (69bvp round-3 re-scope: sound by
//      construction, not by dataflow proof).
//   2. Falsification tests verify that un-checked, ignored (_sender), single-param,
//      id-only-checking, and inline-checked listeners fail RED, and that predicate credit
//      requires an actual import binding to the vetted module (name alone does not count).
//   3. Behavioral tests verify that execution hosts reject untrusted senders (tabs, content scripts, foreign IDs).
//   4. docs/SW-DISPATCH-AUTHORITY-CENSUS.md documents all non-dispatcher listeners and their sender predicates.
//   5. The inventory resolves simple aliases of chrome.runtime / its onMessage event object
//      (const ev = chrome.runtime.onMessage; ev.addListener(...), destructuring, runtime-object
//      aliases) and FAILS CLOSED on any runtime onMessage reference it cannot enumerate
//      (event object passed away, aliased addListener method) instead of silently skipping it
//      (chrome-agent-platform-2i86h). onConnect hosts are out of scope by design (T18).

import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";

import { isTrustedServiceWorkerSender, SERVICE_WORKER_BUNDLE_PATH } from "../extension/lib/pure.js";
import { registerPythonHost } from "../extension/lib/python-host.js";
import { registerWasmJobHost, WASI_JOB_RUN_TYPE } from "../extension/lib/wasm-job-host.js";
import { registerAgentWorkerHost } from "../extension/lib/agent-worker-host.js";
import { registerOnDeviceTextHost } from "../extension/lib/on-device-text-host.js";
import { handleScriptRunMessage } from "../extension/lib/script-host.js";
import { onPermissionSettled } from "../extension/lib/provider-gate.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_DIR = path.join(ROOT, "extension");

function walkJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "dist-versions" && entry.name !== "node_modules") {
        files.push(...walkJsFiles(full));
      }
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

function walkAst(node: any, visitor: (n: any, parent?: any) => void, parent: any = null) {
  if (!node || typeof node !== "object") return;
  visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item, visitor, node);
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walkAst(child, visitor, node);
    }
  }
}

interface ListenerSite {
  file: string;
  relPath: string;
  line: number;
  checksSender: boolean;
  senderParamName: string | null;
  reason?: string;
}

// VETTED BINDINGS (69bvp re-scope after the round-3 FAIL): the guard no longer
// infers rejection semantics from arbitrary code shape - four rounds of
// counterexamples (dead && clauses, uncalled nested functions, identity
// self-comparisons) proved that approach unsound. The rule is now sound BY
// CONSTRUCTION: a listener's sender check must be a CALL to the vetted
// production predicate, resolved through the file's import bindings, or the
// site must carry an explicit ALLOWLISTED_SITES entry with a justification.
// ACCEPTED RESIDUAL (deliberate, reviewer-acknowledged in round 4): credit is
// binding-level, not execution-path - an imported vetted call inside an
// uncalled nested function still counts. Do not re-litigate; pinned by probe18.
const VETTED_PREDICATE_SOURCES: Record<string, Set<string>> = {
  "extension/lib/pure.js": new Set(["isTrustedServiceWorkerSender", "isTrustedWasmStreamSender"]),
  "extension/lib/wasm-stream-host.js": new Set(["isTrustedWasmStreamSender"]),
};

// True iff a binding pattern (const/let/var id, param, catch param,
// destructuring) declares `name`.
function patternBinds(pattern: any, name: string): boolean {
  if (!pattern) return false;
  switch (pattern.type) {
    case "Identifier": return pattern.name === name;
    case "ObjectPattern":
      return (pattern.properties ?? []).some((p: any) =>
        patternBinds(p.type === "RestElement" ? p.argument : p.value, name));
    case "ArrayPattern":
      return (pattern.elements ?? []).some((el: any) => patternBinds(el, name));
    case "AssignmentPattern": return patternBinds(pattern.left, name);
    case "RestElement": return patternBinds(pattern.argument, name);
    default: return false;
  }
}

const SHADOW_FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

// A declarator that re-binds `name` to a VETTED import binding is an alias of
// the same predicate, not a shadow (e.g. wasm-stream-host.js:223).
function isVettedAliasDeclarator(d: any, name: string, imports: Map<string, { path: string; imported: string }>): boolean {
  if (!patternBinds(d.id, name)) return false;
  if (d.init?.type !== "Identifier") return false;
  const b = imports.get(d.init.name);
  return !!b && !!VETTED_PREDICATE_SOURCES[b.path]?.has(b.imported);
}

// Descend statements (never into nested function bodies) looking for a hoisted
// `var` or function declaration of `name` that is not a vetted alias.
function nestedVarDeclares(node: any, name: string, imports: Map<string, { path: string; imported: string }>): boolean {
  let found = false;
  const visit = (n: any) => {
    if (!n || found || typeof n !== "object") return;
    if (n !== node && SHADOW_FN_TYPES.has(n.type)) return; // prune nested functions
    if (n.type === "VariableDeclaration" && n.kind === "var") {
      for (const d of n.declarations ?? []) {
        if (patternBinds(d.id, name) && !isVettedAliasDeclarator(d, name, imports)) found = true;
      }
    }
    if (n.type === "FunctionDeclaration" && n.id?.name === name) found = true;
    for (const key of Object.keys(n)) {
      if (key === "parent") continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(node);
  return found;
}

// 69bvp round-4: a call only invokes the vetted import if NO enclosing scope
// re-declares the name. Walk the call's ancestor chain: function params,
// function-expression names, catch bindings, and block/program-level
// declarations (let/const direct children; var/function hoisted) all shadow -
// except declarators that alias the vetted import itself.
function isShadowedAtCall(callNode: any, name: string, imports: Map<string, { path: string; imported: string }>): boolean {
  let node = callNode.parent;
  while (node) {
    if (SHADOW_FN_TYPES.has(node.type)) {
      for (const param of node.params ?? []) {
        if (patternBinds(param, name)) return true;
      }
      if (node.type === "FunctionExpression" && node.id?.name === name) return true;
    }
    if (node.type === "CatchClause" && patternBinds(node.param, name)) return true;
    if (node.type === "BlockStatement" || node.type === "Program") {
      for (const stmt of node.body ?? []) {
        if (stmt.type === "VariableDeclaration") {
          for (const d of stmt.declarations ?? []) {
            if (patternBinds(d.id, name) && !isVettedAliasDeclarator(d, name, imports)) return true;
          }
        }
        if (stmt.type === "FunctionDeclaration" && stmt.id?.name === name) return true;
        // `var` / function declarations hoist past nested blocks (not nested functions)
        if (!SHADOW_FN_TYPES.has(stmt.type) && stmt.type !== "VariableDeclaration" && nestedVarDeclares(stmt, name, imports)) {
          return true;
        }
      }
    }
    node = node.parent;
  }
  return false;
}

function isAuthenticatingSender(
  body: any,
  senderName: string,
  imports: Map<string, { path: string; imported: string }>,
): boolean {
  let validated = false;
  walkAst(body, (sub) => {
    if (sub.type !== "CallExpression") return;
    const callee = sub.callee;
    if (callee?.type !== "Identifier") return;
    const binding = imports.get(callee.name);
    if (!binding || !VETTED_PREDICATE_SOURCES[binding.path]?.has(binding.imported)) return;
    // The call's ACTUAL lexical binding must be the import, not a local shadow.
    if (isShadowedAtCall(sub, callee.name, imports)) return;
    if (sub.arguments.some((arg: any) => arg.type === "Identifier" && arg.name === senderName)) {
      validated = true;
    }
  });
  return validated;
}

function analyzeOnMessageListeners(code: string, filePath: string): ListenerSite[] {
  let ast: any;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (err: any) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }

  // Parent pointers for use-context classification (walkAst never recurses into "parent").
  walkAst(ast, (node, parent) => {
    if (parent) node.parent = parent;
  });

  const functions = new Map<string, any>();
  walkAst(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      functions.set(node.id.name, node);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id?.name &&
      (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
    ) {
      functions.set(node.id.name, node.init);
    }
  });

  // Import bindings: local name -> resolved repo-relative source + imported
  // name. The vetted-predicate rule resolves calls through this map.
  const imports = new Map<string, { path: string; imported: string }>();
  walkAst(ast, (node) => {
    if (node.type !== "ImportDeclaration" || typeof node.source?.value !== "string") return;
    const resolved = path
      .relative(ROOT, path.resolve(path.dirname(filePath), node.source.value))
      .split(path.sep)
      .join("/");
    for (const spec of node.specifiers ?? []) {
      if (spec.type === "ImportSpecifier") {
        imports.set(spec.local.name, { path: resolved, imported: spec.imported?.name ?? spec.local.name });
      }
    }
  });
  // Single-level const aliases of a vetted import are the same binding
  // (e.g. wasm-stream-host.js: export const isTrustedWasmStreamSender =
  // isTrustedServiceWorkerSender).
  walkAst(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init?.type === "Identifier" &&
      !imports.has(node.id.name)
    ) {
      const binding = imports.get(node.init.name);
      if (binding && VETTED_PREDICATE_SOURCES[binding.path]?.has(binding.imported)) {
        imports.set(node.id.name, binding);
      }
    }
  });

  // 2i86h: the inventory must not be escapeable by aliasing. Resolve simple
  // aliases of chrome.runtime and of its onMessage event object, and FAIL
  // CLOSED on any runtime onMessage reference the scan cannot enumerate.
  const runtimeAliases = new Set<string>();
  const eventAliases = new Set<string>();

  const propName = (memberExpr: any): string | undefined =>
    memberExpr?.property?.name ?? (memberExpr?.computed ? memberExpr?.property?.value : undefined);

  const isRuntimeRootExpr = (node: any): boolean => {
    if (!node) return false;
    if (node.type === "Identifier") return node.name === "runtime" || runtimeAliases.has(node.name);
    if (node.type === "MemberExpression") return propName(node) === "runtime";
    // Historical leniency: (a || b).onMessage.addListener chains.
    if (node.type === "LogicalExpression") return true;
    return false;
  };

  const isOnMessageEventExpr = (node: any): boolean => {
    if (!node) return false;
    if (node.type === "Identifier") return eventAliases.has(node.name);
    if (node.type === "MemberExpression" && propName(node) === "onMessage") return isRuntimeRootExpr(node.object);
    return false;
  };

  // Fixpoint alias collection: const rt = chrome.runtime; const ev = rt.onMessage;
  // const ev2 = ev; const { onMessage } = chrome.runtime.
  let changed = true;
  while (changed) {
    changed = false;
    walkAst(ast, (node) => {
      if (node.type !== "VariableDeclarator" || !node.init) return;
      if (node.id?.type === "Identifier") {
        if (!runtimeAliases.has(node.id.name) && isRuntimeRootExpr(node.init)) {
          runtimeAliases.add(node.id.name);
          changed = true;
        }
        if (!eventAliases.has(node.id.name) && isOnMessageEventExpr(node.init)) {
          eventAliases.add(node.id.name);
          changed = true;
        }
      }
      if (node.id?.type === "ObjectPattern" && isRuntimeRootExpr(node.init)) {
        for (const prop of node.id.properties ?? []) {
          const key = prop.key?.name ?? prop.key?.value;
          const local = prop.value?.name;
          if (key === "onMessage" && typeof local === "string" && !eventAliases.has(local)) {
            eventAliases.add(local);
            changed = true;
          }
        }
      }
    });
  }

  // Fail-closed classification: EVERY reference to the runtime onMessage event
  // object must be enumerable — a direct addListener/removeListener/hasListener
  // call, a tracked alias declaration, or a benign existence guard in a test
  // position. Anything else (passed to a function, stored on an object, an
  // aliased addListener METHOD) is reported instead of silently skipped.
  const LISTENER_METHODS = new Set(["addListener", "removeListener", "hasListener", "hasListeners"]);
  const unenumerable: string[] = [];

  const classifyEventUse = (node: any): "ok" | "unenumerable" => {
    let child = node;
    let p = node.parent;
    while (p?.type === "ChainExpression") { child = p; p = p.parent; }
    if (!p) return "unenumerable";
    // const ev = <event> (alias declaration), or the declaration name itself.
    if (p.type === "VariableDeclarator" && (p.init === child || p.id === child)) return "ok";
    // <event>.addListener(...) — the method must be CALLED immediately; an
    // aliased method (const add = ev.addListener) escapes enumeration.
    if (p.type === "MemberExpression" && p.object === child) {
      if (LISTENER_METHODS.has(propName(p))) {
        let mChild = p;
        let mp = p.parent;
        while (mp?.type === "ChainExpression") { mChild = mp; mp = mp.parent; }
        if (mp?.type === "CallExpression" && mp.callee === mChild) return "ok";
      }
      return "unenumerable";
    }
    // Benign existence guard: if (!runtime?.onMessage) / if (runtime?.onMessage).
    let tChild = child;
    let tp = p;
    while (tp && (tp.type === "UnaryExpression" || tp.type === "LogicalExpression" || tp.type === "ChainExpression")) {
      tChild = tp;
      tp = tp.parent;
    }
    if (
      tp &&
      (tp.type === "IfStatement" || tp.type === "WhileStatement" || tp.type === "DoWhileStatement" || tp.type === "ConditionalExpression") &&
      tp.test === tChild
    ) {
      return "ok";
    }
    return "unenumerable";
  };

  walkAst(ast, (node) => {
    const isEventRef =
      (node.type === "MemberExpression" && propName(node) === "onMessage" && isRuntimeRootExpr(node.object)) ||
      (node.type === "Identifier" && eventAliases.has(node.name));
    if (!isEventRef) return;
    if (classifyEventUse(node) !== "ok") {
      unenumerable.push(`${path.relative(ROOT, filePath)}:${node.loc?.start?.line ?? 0}`);
    }
  });

  const sites: ListenerSite[] = [];

  walkAst(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (
        callee.type === "MemberExpression" &&
        propName(callee) === "addListener" &&
        isOnMessageEventExpr(callee.object)
      ) {
        const arg = node.arguments[0];
        let fn: any = null;
        if (arg?.type === "ArrowFunctionExpression" || arg?.type === "FunctionExpression") {
          fn = arg;
        } else if (arg?.type === "Identifier" && functions.has(arg.name)) {
          fn = functions.get(arg.name);
        }

        let checksSender = false;
        let senderParamName: string | null = null;
        if (fn && fn.params.length >= 2) {
          const p2 = fn.params[1];
          if (p2.type === "Identifier" && !p2.name.startsWith("_")) {
            senderParamName = p2.name;
            checksSender = isAuthenticatingSender(fn.body, senderParamName, imports);
          }
        }

        const relPath = path.relative(ROOT, filePath);
        sites.push({
          file: filePath,
          relPath,
          line: node.loc?.start?.line ?? 0,
          checksSender,
          senderParamName,
        });
      }
    }
  });

  // Attached out-of-band so existing array usages keep working: references to
  // the runtime onMessage event object that the inventory cannot enumerate.
  (sites as any).unenumerable = unenumerable;
  return sites;
}

// Allowlist for listeners that are intentionally gated by something OTHER than
// a direct vetted-predicate call (69bvp re-scope: the ONLY alternative the
// inventory accepts). Every entry must name what checks the sender instead.
const ALLOWLISTED_SITES = new Map<string, string>([
  [
    "extension/background/service-worker.js:13361",
    "central dispatcher: accepts page/content-script senders BY DESIGN; sender classified by authorizeToolReport (lib/pure.js:912) and route authority enforced per-route (Layers 1-3)",
  ],
  [
    "extension/content/content-script.js:376",
    "content script receiving SW pushes: inline !sender || sender.id !== runtime.id || sender.tab != null rejects foreign and tab senders; pinned by the behavioral content-script test below",
  ],
  [
    "extension/content/webmcp-detect-relay.js:97",
    "same SW-push guard shape as content-script.js:376: inline id-match + tab-absence; relay only, no execution authority",
  ],
  [
    "extension/ntp/ntp.js:6409",
    "delegates sender validation to handleScriptRunMessage (lib/script-host.js:184), which enforces isTrustedServiceWorkerSender before any script run",
  ],
  [
    "extension/offscreen/offscreen.js:24",
    "delegates sender validation to handleScriptRunMessage (lib/script-host.js:184), which enforces isTrustedServiceWorkerSender before any script run",
  ],
]);

Deno.test("guard: all extension/ runtime.onMessage listeners accept and check sender", () => {
  const jsFiles = walkJsFiles(EXTENSION_DIR);
  assert(jsFiles.length > 50, `must scan extension JS files, found ${jsFiles.length}`);

  const allSites: ListenerSite[] = [];
  const allUnenumerable: string[] = [];
  for (const file of jsFiles) {
    const code = fs.readFileSync(file, "utf8");
    const sites = analyzeOnMessageListeners(code, file);
    allSites.push(...sites);
    allUnenumerable.push(...((sites as any).unenumerable ?? []));
  }

  assert(allSites.length >= 17, `expected at least 17 onMessage listeners, found ${allSites.length}`);

  // 2i86h: fail closed — a runtime onMessage reference the scan cannot enumerate
  // (aliased-away event object or method) is a violation, not a skipped site.
  assertEquals(
    allUnenumerable,
    [],
    `Found runtime onMessage references the inventory cannot enumerate (fail closed):\n${allUnenumerable.join("\n")}`,
  );

  const violations: string[] = [];
  for (const site of allSites) {
    const key = `${site.relPath}:${site.line}`;
    if (!site.checksSender && !ALLOWLISTED_SITES.has(key)) {
      violations.push(`${site.relPath}:${site.line} (sender param: ${site.senderParamName ?? "none"})`);
    }
  }

  assertEquals(
    violations,
    [],
    `Found un-gated onMessage.addListener calls missing sender validation:\n${violations.join("\n")}`,
  );

  // Allowlist hygiene: every entry must correspond to a real scanned site —
  // a stale entry silently suppresses nothing and hides a moved listener.
  const siteKeys = new Set(allSites.map((s) => `${s.relPath}:${s.line}`));
  const staleEntries = [...ALLOWLISTED_SITES.keys()].filter((k) => !siteKeys.has(k));
  assertEquals(
    staleEntries,
    [],
    `stale ALLOWLISTED_SITES entries (no listener found at that site):\n${staleEntries.join("\n")}`,
  );
});

Deno.test("guard falsification: detects un-gated, ignored, or missing sender listeners", () => {
  const probeMissingSender = `
    chrome.runtime.onMessage.addListener((message) => {
      console.log(message);
    });
  `;
  const sites1 = analyzeOnMessageListeners(probeMissingSender, "extension/test-probe1.js");
  assertEquals(sites1.length, 1);
  assertEquals(sites1[0].checksSender, false);

  const probeIgnoredSender = `
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      sendResponse({ ok: true });
    });
  `;
  const sites2 = analyzeOnMessageListeners(probeIgnoredSender, "extension/test-probe2.js");
  assertEquals(sites2.length, 1);
  assertEquals(sites2[0].checksSender, false);

  const probeUnusedSender = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      sendResponse({ ok: true });
    });
  `;
  const sites3 = analyzeOnMessageListeners(probeUnusedSender, "extension/test-probe3.js");
  assertEquals(sites3.length, 1);
  assertEquals(sites3[0].checksSender, false);

  const probeCheckedSender = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isTrustedServiceWorkerSender(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites4 = analyzeOnMessageListeners(probeCheckedSender, "extension/test-probe4.js");
  assertEquals(sites4.length, 1);
  assertEquals(sites4[0].checksSender, true);

  const probeIneffectualVoidSender = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void sender;
      sendResponse({ ok: true });
    });
  `;
  const sites5 = analyzeOnMessageListeners(probeIneffectualVoidSender, "extension/test-probe5.js");
  assertEquals(sites5.length, 1);
  assertEquals(sites5[0].checksSender, false, "void sender must not count as validation");

  const probeIneffectualLogSender = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log(sender);
      sendResponse({ ok: true });
    });
  `;
  const sites6 = analyzeOnMessageListeners(probeIneffectualLogSender, "extension/test-probe6.js");
  assertEquals(sites6.length, 1);
  assertEquals(sites6[0].checksSender, false, "console.log(sender) must not count as validation");

  const probeIneffectualVoidSenderProperty = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void sender.id;
      sendResponse({ ok: true });
    });
  `;
  const sites7 = analyzeOnMessageListeners(probeIneffectualVoidSenderProperty, "extension/test-probe7.js");
  assertEquals(sites7.length, 1);
  assertEquals(sites7[0].checksSender, false, "void sender.id must not count as validation");

  const probeIneffectualAssignment = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const id = sender.id;
      sendResponse({ ok: true, id });
    });
  `;
  const sites8 = analyzeOnMessageListeners(probeIneffectualAssignment, "extension/test-probe8.js");
  assertEquals(sites8.length, 1);
  assertEquals(sites8[0].checksSender, false, "const id = sender.id must not count as validation without rejecting branch");

  // INV-15 (THREAT_MODEL.md): an extension ID alone does not establish the SW
  // principal — same-extension documents and content scripts share sender.id.
  // A rejecting conditional that compares ONLY sender.id must NOT count as
  // authenticating (chrome-agent-platform-69bvp).
  const probeIdOnlyRejectingCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites9 = analyzeOnMessageListeners(probeIdOnlyRejectingCheck, "extension/test-probe9.js");
  assertEquals(sites9.length, 1);
  assertEquals(sites9[0].checksSender, false, "id-only rejecting check must not count as SW authentication (INV-15)");

  const probeNegatedIdOnlyCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!sender || sender.id !== chrome.runtime.id) return;
      sendResponse({ ok: true });
    });
  `;
  const sites10 = analyzeOnMessageListeners(probeNegatedIdOnlyCheck, "extension/test-probe10.js");
  assertEquals(sites10.length, 1);
  assertEquals(sites10[0].checksSender, false, "!sender || id-mismatch rejecting check is still id-only and must not count");

  // origin/frameId do not discriminate same-extension non-SW callers either.
  const probeOriginOnlyCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.origin !== chrome.runtime.getURL("/").slice(0, -1)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites11 = analyzeOnMessageListeners(probeOriginOnlyCheck, "extension/test-probe11.js");
  assertEquals(sites11.length, 1);
  assertEquals(sites11[0].checksSender, false, "origin-only rejecting check must not count as SW authentication");

  // Positive pins: a rejecting conditional that ALSO excludes same-extension
  // tabs/documents (tab/documentId) or pins the SW bundle URL DOES count.
  // 69bvp round-3 re-scope: inline checks NEVER count, however correct - the
  // only credits are a vetted-predicate call or an allowlist entry.
  const probeIdAndTabCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!sender || sender.id !== chrome.runtime.id || sender.tab != null) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites12 = analyzeOnMessageListeners(probeIdAndTabCheck, "extension/test-probe12.js");
  assertEquals(sites12.length, 1);
  assertEquals(sites12[0].checksSender, false, "even a correct inline id+tab check no longer counts - vetted predicate or allowlist only");

  const probeSwBundleUrlCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.url !== chrome.runtime.getURL("dist/background/service-worker.js")) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites13 = analyzeOnMessageListeners(probeSwBundleUrlCheck, "extension/test-probe13.js");
  assertEquals(sites13.length, 1);
  assertEquals(sites13[0].checksSender, false, "even a correct inline SW-bundle-URL check no longer counts - vetted predicate or allowlist only");

  // 69bvp history pin: this shape defeated the RETIRED dataflow rule (a property
  // MENTION in a dead clause was credited). Under the re-scoped rule it fails
  // simply because there is no vetted-predicate call.
  const probeDeadAndFalseClause = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || (sender.tab != null && false)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites14 = analyzeOnMessageListeners(probeDeadAndFalseClause, "extension/test-probe14.js");
  assertEquals(sites14.length, 1);
  assertEquals(sites14[0].checksSender, false, "sender.tab in a dead (&& false) clause must not count — the guard is ID-only");

  const probeShortCircuitedOrTrueClause = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if ((sender.url !== chrome.runtime.getURL("dist/background/service-worker.js") || true) && sender.id !== chrome.runtime.id) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites15 = analyzeOnMessageListeners(probeShortCircuitedOrTrueClause, "extension/test-probe15.js");
  assertEquals(sites15.length, 1);
  assertEquals(sites15[0].checksSender, false, "sender.url in a short-circuited (|| true) clause must not count — the guard is ID-only");

  const probeConstantTest = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || true) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites16 = analyzeOnMessageListeners(probeConstantTest, "extension/test-probe16.js");
  assertEquals(sites16.length, 1);
  assertEquals(sites16[0].checksSender, false, "a constant-true test rejects everyone and discriminates nothing");

  // 69bvp history pin: this shape defeated the RETIRED execution-path rule (an
  // uncalled nested function's check was credited). Under the re-scoped rule an
  // inline-only listener fails because there is no vetted-predicate call.
  const probeUncalledNestedFunction = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      function unusedHelper() { if (sender.tab != null) return false; }
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites17 = analyzeOnMessageListeners(probeUncalledNestedFunction, "extension/test-probe17.js");
  assertEquals(sites17.length, 1);
  assertEquals(sites17[0].checksSender, false, "a discriminating check inside an uncalled nested function is not on the execution path");

  // Same boundary for the recognized-predicate branch: a predicate call inside
  // an uncalled nested function does not gate the listener.
  // ACCEPTED LIMITATION (viiaq retired by the round-3 re-scope): credit is
  // binding-level, not execution-path - an IMPORTED vetted-predicate call is
  // credited even inside an uncalled nested function. Pinned so the acceptance
  // is explicit, not silent.
  const probeNestedPredicateCall = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      function unusedHelper() { return isTrustedServiceWorkerSender(sender); }
      sendResponse({ ok: true });
    });
  `;
  const sites18 = analyzeOnMessageListeners(probeNestedPredicateCall, "extension/test-probe18.js");
  assertEquals(sites18.length, 1);
  assertEquals(sites18[0].checksSender, true, "binding-level credit: imported vetted call counts even off the execution path (accepted, viiaq retired)");

  // 69bvp history pin: this identity contradiction defeated the RETIRED
  // truth-table rule (a freely flippable atom faked dependence). Under the
  // re-scoped rule it fails because there is no vetted-predicate call.
  const probeSelfComparison = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || sender.tab != sender.tab) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites19 = analyzeOnMessageListeners(probeSelfComparison, "extension/test-probe19.js");
  assertEquals(sites19.length, 1);
  assertEquals(sites19[0].checksSender, false, "sender.tab != sender.tab is an identity contradiction, not a discriminating check");

  // Positive pin REMOVED by the re-scope: even a correct top-level inline
  // id+tab check fails - only the vetted predicate or an allowlist entry counts.
  const probeTopLevelTabCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || sender.tab != null) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites20 = analyzeOnMessageListeners(probeTopLevelTabCheck, "extension/test-probe20.js");
  assertEquals(sites20.length, 1);
  assertEquals(sites20[0].checksSender, false, "inline checks never count under the re-scoped rule, even at the top level");

  // The vetted predicate credited by NAME alone (no import binding) does not
  // count: an ID-only local helper shadowing the name must not pass.
  const probeUnboundPredicateName = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isTrustedServiceWorkerSender(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites21 = analyzeOnMessageListeners(probeUnboundPredicateName, "extension/test-probe21.js");
  assertEquals(sites21.length, 1);
  assertEquals(sites21[0].checksSender, false, "an unbound predicate NAME (no import) must not be credited");

  // A NON-vetted export imported from the same module does not count.
  const probeNonVettedImport = `
    import { redactSecrets } from "./lib/pure.js";
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!redactSecrets(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites22 = analyzeOnMessageListeners(probeNonVettedImport, "extension/test-probe22.js");
  assertEquals(sites22.length, 1);
  assertEquals(sites22[0].checksSender, false, "a non-vetted import from pure.js must not be credited");

  // 69bvp round-4: the call's ACTUAL lexical binding must be the import. A local
  // shadow (const/let/var, param, catch, destructuring) of the predicate name
  // inside an enclosing scope defeats name-keyed credit.
  const probeShadowedPredicate = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const isTrustedServiceWorkerSender = (s) => s.id === chrome.runtime.id;
      if (!isTrustedServiceWorkerSender(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites23 = analyzeOnMessageListeners(probeShadowedPredicate, "extension/test-probe23.js");
  assertEquals(sites23.length, 1);
  assertEquals(sites23[0].checksSender, false, "a shadowed predicate name is not the vetted import (ID-only arrow must fail)");

  // Positive: a shadow in a DISJOINT sibling scope does not affect the listener's
  // own binding.
  const probeSiblingScopeShadow = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    function unrelated() {
      const isTrustedServiceWorkerSender = () => false;
      return isTrustedServiceWorkerSender(null);
    }
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isTrustedServiceWorkerSender(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites24 = analyzeOnMessageListeners(probeSiblingScopeShadow, "extension/test-probe24.js");
  assertEquals(sites24.length, 1);
  assertEquals(sites24[0].checksSender, true, "a shadow in a disjoint sibling scope must not defeat the listener's own import binding");
});

Deno.test("behavioral: isTrustedServiceWorkerSender enforces SW bundle path and rejects documents/tabs", () => {
  const runtime = {
    id: "test-extension-id",
    getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
  };

  const validSender = {
    id: "test-extension-id",
    url: runtime.getURL(SERVICE_WORKER_BUNDLE_PATH),
  };
  assert(isTrustedServiceWorkerSender(validSender, runtime), "SW sender must be trusted");

  // Foreign extension id
  assert(!isTrustedServiceWorkerSender({ ...validSender, id: "foreign-id" }, runtime));
  // Content script with tab
  assert(!isTrustedServiceWorkerSender({ ...validSender, tab: { id: 1 } }, runtime));
  // Document frame with documentId
  assert(!isTrustedServiceWorkerSender({ ...validSender, documentId: "frame-doc-id" }, runtime));
  // Extension page URL (options, ntp, offscreen)
  assert(!isTrustedServiceWorkerSender({ ...validSender, url: runtime.getURL("options/options.html") }, runtime));
  assert(!isTrustedServiceWorkerSender({ ...validSender, url: runtime.getURL("offscreen/offscreen.html") }, runtime));
  assert(!isTrustedServiceWorkerSender({ ...validSender, url: runtime.getURL("ntp/ntp.html") }, runtime));
});

// 69bvp / INV-15: the PRODUCTION predicate must reject same-extension callers that
// share our sender.id — a content script (tab set, page URL) and an extension
// document (documentId set, extension-page URL) — and accept only the SW bundle.
Deno.test("inventory falsification: aliased onMessage registrations are caught, unenumerable references fail closed", () => {
  // 2i86h: the scan must not be escapeable by aliasing the event object.
  // An UNCHECKED listener registered through an alias is a violation the old
  // direct-syntax-only scan could not see (0 sites found -> escape).
  const probeAliasedUnchecked = `
    const event = chrome.runtime.onMessage;
    event.addListener((message, sender, sendResponse) => {
      sendResponse({ ok: true });
    });
  `;
  const sitesA = analyzeOnMessageListeners(probeAliasedUnchecked, "extension/test-alias1.js");
  assertEquals(sitesA.length, 1, "aliased registration must be enumerated as a site");
  assertEquals(sitesA[0].checksSender, false, "aliased unchecked listener must be flagged un-gated");

  // Aliased registration WITH the vetted predicate is enumerated and counts as gated.
  const probeAliasedChecked = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    const event = chrome.runtime.onMessage;
    event.addListener((message, sender, sendResponse) => {
      if (!isTrustedServiceWorkerSender(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sitesB = analyzeOnMessageListeners(probeAliasedChecked, "extension/test-alias2.js");
  assertEquals(sitesB.length, 1, "aliased checked registration must be enumerated");
  assertEquals(sitesB[0].checksSender, true);

  // Destructured alias of the event object.
  const probeDestructured = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    const { onMessage } = chrome.runtime;
    onMessage.addListener((message, sender, sendResponse) => {
      if (!isTrustedServiceWorkerSender(sender)) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sitesC = analyzeOnMessageListeners(probeDestructured, "extension/test-alias3.js");
  assertEquals(sitesC.length, 1, "destructured onMessage alias must be enumerated");
  assertEquals(sitesC[0].checksSender, true);

  // Runtime-object alias one level up.
  const probeRuntimeAlias = `
    const rt = chrome.runtime;
    rt.onMessage.addListener((message, sender, sendResponse) => {
      sendResponse({ ok: true });
    });
  `;
  const sitesD = analyzeOnMessageListeners(probeRuntimeAlias, "extension/test-alias4.js");
  assertEquals(sitesD.length, 1, "runtime-alias registration must be enumerated");
  assertEquals(sitesD[0].checksSender, false);

  // Fail closed when the event object ESCAPES enumeration: passing
  // chrome.runtime.onMessage to a function means the scanner cannot see what
  // registers on it — this must be reported, not silently skipped.
  const probeEscape = `
    export function registerLater(event) {
      event.addListener((message, sender, sendResponse) => sendResponse({ ok: true }));
    }
    registerLater(chrome.runtime.onMessage);
  `;
  const sitesE = analyzeOnMessageListeners(probeEscape, "extension/test-alias5.js");
  assert(Array.isArray(sitesE.unenumerable), "scanner must expose an unenumerable-references list");
  assertEquals(sitesE.unenumerable.length, 1, "passing chrome.runtime.onMessage away must fail closed");

  // Fail closed when the addListener METHOD itself is aliased.
  const probeMethodAlias = `
    const add = chrome.runtime.onMessage.addListener;
    add((message, sender, sendResponse) => sendResponse({ ok: true }));
  `;
  const sitesF = analyzeOnMessageListeners(probeMethodAlias, "extension/test-alias6.js");
  assert(Array.isArray(sitesF.unenumerable), "scanner must expose an unenumerable-references list");
  assertEquals(sitesF.unenumerable.length, 1, "aliasing onMessage.addListener must fail closed");

  // Non-runtime onMessage (ports, DOM shims) must NOT be enumerated or flagged.
  const probePort = `
    port.onMessage.addListener((message) => console.log(message));
    this.onMessage = null;
  `;
  const sitesG = analyzeOnMessageListeners(probePort, "extension/test-alias7.js");
  assertEquals(sitesG.length, 0, "port.onMessage is not the runtime broadcast bus");
  assertEquals(sitesG.unenumerable.length, 0, "port.onMessage must not fail closed");

  // Existence guards on the runtime event object are benign and must not fail closed.
  const probeExistenceGuard = `
    import { isTrustedServiceWorkerSender } from "./lib/pure.js";
    function register(runtime) {
      if (!runtime?.onMessage) return;
      runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!isTrustedServiceWorkerSender(sender)) return false;
        sendResponse({ ok: true });
        return true;
      });
    }
  `;
  const sitesH = analyzeOnMessageListeners(probeExistenceGuard, "extension/test-alias8.js");
  assertEquals(sitesH.length, 1);
  assertEquals(sitesH[0].checksSender, true);
  assertEquals(sitesH.unenumerable.length, 0, "if (!runtime?.onMessage) existence guards are benign");
});

Deno.test("behavioral: production predicate rejects same-extension id-sharing callers (INV-15)", () => {
  const runtime = {
    id: "test-extension-id",
    getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
  };

  // Same-extension content script: shares sender.id, carries tab + page URL.
  const contentScriptSender = { id: "test-extension-id", tab: { id: 7 }, url: "https://example.com/page" };
  assert(!isTrustedServiceWorkerSender(contentScriptSender, runtime), "content script sharing our id must be rejected");

  // Same-extension document (options/ntp/offscreen frame): shares sender.id, carries documentId + extension URL.
  const documentSender = { id: "test-extension-id", documentId: "doc-9", url: runtime.getURL("options/options.html") };
  assert(!isTrustedServiceWorkerSender(documentSender, runtime), "extension document sharing our id must be rejected");

  // The real service worker: id match, no tab/documentId, exact SW bundle URL.
  const swSender = { id: "test-extension-id", url: runtime.getURL(SERVICE_WORKER_BUNDLE_PATH) };
  assert(isTrustedServiceWorkerSender(swSender, runtime), "service worker sender must be accepted");
});

Deno.test("behavioral: python host listener refuses untrusted senders", async () => {
  let registeredListener: any = null;
  const fakeRuntime = {
    id: "cap-id",
    getURL: (p: string) => `chrome-extension://cap-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
    onMessage: {
      addListener(fn: any) { registeredListener = fn; },
      removeListener() {},
    },
  };

  registerPythonHost({ runtime: fakeRuntime });
  assert(registeredListener !== null, "listener must be registered");

  let response: any = null;
  const untrustedSender = { id: "cap-id", tab: { id: 99 }, url: "https://evil.test" };
  const handled = registeredListener(
    { type: "python.run", code: "print(1)" },
    untrustedSender,
    (res: any) => { response = res; },
  );

  assertEquals(handled, false);
  assertEquals(response, { ok: false, error: "python_host_untrusted_sender" });
});

Deno.test("behavioral: wasm-job host listener refuses untrusted senders", async () => {
  let registeredListener: any = null;
  const fakeRuntime = {
    id: "cap-id",
    getURL: (p: string) => `chrome-extension://cap-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
    onMessage: {
      addListener(fn: any) { registeredListener = fn; },
    },
  };

  registerWasmJobHost({ runtime: fakeRuntime });
  assert(registeredListener !== null, "listener must be registered");

  let response: any = null;
  const untrustedSender = { id: "cap-id", documentId: "doc-1", url: fakeRuntime.getURL("options/options.html") };
  registeredListener(
    { type: WASI_JOB_RUN_TYPE, toolId: "jq", args: [], stdin: "{}" },
    untrustedSender,
    (res: any) => { response = res; },
  );

  assertEquals(response, { ok: false, phase: "failed", error: "wasm_job_host_untrusted_sender" });
});

Deno.test("behavioral: agent-worker host listener refuses untrusted senders", async () => {
  let registeredListener: any = null;
  const fakeRuntime = {
    id: "cap-id",
    getURL: (p: string) => `chrome-extension://cap-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
    onMessage: {
      addListener(fn: any) { registeredListener = fn; },
      removeListener() {},
    },
  };

  registerAgentWorkerHost({ runtime: fakeRuntime });
  assert(registeredListener !== null, "listener must be registered");

  let response: any = null;
  const untrustedSender = { id: "cap-id", tab: { id: 10 } };
  const handled = registeredListener(
    { type: "agent-worker-host:ensure", agentId: "test-agent" },
    untrustedSender,
    (res: any) => { response = res; },
  );

  assertEquals(handled, false);
  assertEquals(response, { ok: false, error: "agent_worker_host_untrusted_sender" });
});

Deno.test("behavioral: on-device text host listener refuses untrusted senders", async () => {
  let registeredListener: any = null;
  const fakeRuntime = {
    id: "cap-id",
    getURL: (p: string) => `chrome-extension://cap-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
    onMessage: {
      addListener(fn: any) { registeredListener = fn; },
    },
  };

  registerOnDeviceTextHost({ runtime: fakeRuntime });
  assert(registeredListener !== null, "listener must be registered");

  let response: any = null;
  const untrustedSender = { id: "foreign-id", url: fakeRuntime.getURL(SERVICE_WORKER_BUNDLE_PATH) };
  const handled = registeredListener(
    { type: "onDeviceText.summarize", text: "hello" },
    untrustedSender,
    (res: any) => { response = res; },
  );

  assertEquals(handled, false);
  assertEquals(response, { ok: false, error: "on_device_text_host_untrusted_sender" });
});

Deno.test("behavioral: script host handleScriptRunMessage ignores unrelated message types without responding", () => {
  let responded = false;
  const ret = handleScriptRunMessage(
    { type: "tools.upsert", tool: {} },
    null,
    () => { responded = true; },
    {} as any,
    "offscreen",
  );
  assertEquals(ret, false, "must return false immediately for unrelated types");
  assertEquals(responded, false, "must not send any response for unrelated types");
});

Deno.test("behavioral: script host handleScriptRunMessage refuses untrusted senders", async () => {
  const fakeRuntime = {
    id: "cap-id",
    getURL: (p: string) => `chrome-extension://cap-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
  };

  let response: any = null;
  const untrustedSender = { id: "cap-id", tab: { id: 42 } };
  const handled = handleScriptRunMessage(
    { type: "cap:script-run-announce", runId: "run_12345678" },
    untrustedSender,
    (res: any) => { response = res; },
    {} as any,
    "offscreen",
    { runtime: fakeRuntime },
  );

  assertEquals(handled, false);
  assertEquals(response, { ok: false, error: "script_host_untrusted_sender" });
});

Deno.test("behavioral: provider-gate onPermissionSettled ignores untrusted broadcast senders", () => {
  let registeredListener: any = null;
  const fakeRuntime = {
    id: "cap-id",
    getURL: (p: string) => `chrome-extension://cap-id/${p}`,
    getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
    onMessage: {
      addListener(fn: any) { registeredListener = fn; },
      removeListener() {},
    },
  };

  let called = false;
  onPermissionSettled(() => { called = true; }, { runtime: fakeRuntime });
  assert(registeredListener !== null, "listener must be registered");

  // Untrusted sender: must NOT call handler
  const untrustedSender = { id: "cap-id", tab: { id: 1 } };
  registeredListener({ type: "provider-host-perm:settled" }, untrustedSender);
  assertEquals(called, false, "untrusted sender broadcast must be ignored");

  // Trusted SW sender: must call handler
  const trustedSender = { id: "cap-id", url: fakeRuntime.getURL(SERVICE_WORKER_BUNDLE_PATH) };
  registeredListener({ type: "provider-host-perm:settled" }, trustedSender);
  assertEquals(called, true, "trusted SW sender broadcast must trigger handler");
});

Deno.test("behavioral: content-script onRuntimeMessage filters foreign sender and tab senders", async () => {
  const csSource = await Deno.readTextFile(path.join(ROOT, "extension/content/content-script.js"));
  // Extract onRuntimeMessage implementation
  const fnMatch = csSource.match(/function onRuntimeMessage\([\s\S]*?\n\}/);
  assert(fnMatch, "must find onRuntimeMessage in content-script.js");
  const onRuntimeMessage = new Function(
    "chrome",
    `let syncCalled = false;
     function syncEnrollmentAtStartup() { syncCalled = true; return Promise.resolve(); }
     ${fnMatch[0]};
     return { onRuntimeMessage, getSyncCalled: () => syncCalled };`,
  )({ runtime: { id: "cap-extension-id" } });

  // Foreign sender: must return false and not invoke sync
  const foreignSender = { id: "foreign-id" };
  const ret1 = onRuntimeMessage.onRuntimeMessage({ type: "enrollment.poke" }, foreignSender, () => {});
  assertEquals(ret1, false, "foreign sender must be rejected");
  assertEquals(onRuntimeMessage.getSyncCalled(), false, "sync must not be called on foreign sender");

  // Tab sender: must return false
  const tabSender = { id: "cap-extension-id", tab: { id: 10 } };
  const ret2 = onRuntimeMessage.onRuntimeMessage({ type: "enrollment.poke" }, tabSender, () => {});
  assertEquals(ret2, false, "sender from tab must be rejected");

  // Extension SW sender: must be accepted
  const swSender = { id: "cap-extension-id" };
  const ret3 = onRuntimeMessage.onRuntimeMessage({ type: "enrollment.poke" }, swSender, () => {});
  assertEquals(ret3, true, "valid extension SW sender must be accepted");
  assertEquals(onRuntimeMessage.getSyncCalled(), true, "sync must be called on valid sender");

  // Missing sender: must be rejected fail-closed per docs/SW-DISPATCH-AUTHORITY-CENSUS.md
  const ret4 = onRuntimeMessage.onRuntimeMessage({ type: "enrollment.poke" }, undefined, () => {});
  assertEquals(ret4, false, "missing sender must be rejected fail-closed");
});

Deno.test("census: docs/SW-DISPATCH-AUTHORITY-CENSUS.md documents non-dispatcher listeners", async () => {
  const census = await Deno.readTextFile(path.join(ROOT, "docs/SW-DISPATCH-AUTHORITY-CENSUS.md"));
  assert(census.includes("## 6. Non-Dispatcher Extension Message Listeners"), "census must have Section 6");
  assert(census.includes("isTrustedServiceWorkerSender"), "census must document isTrustedServiceWorkerSender");
  assert(census.includes("extension/lib/python-host.js"), "census must list python-host.js");
  assert(census.includes("extension/lib/wasm-job-host.js"), "census must list wasm-job-host.js");
  assert(census.includes("extension/lib/agent-worker-host.js"), "census must list agent-worker-host.js");
  assert(census.includes("extension/lib/on-device-text-host.js"), "census must list on-device-text-host.js");
  assert(census.includes("extension/lib/script-host.js"), "census must list script-host.js");
  assert(census.includes("extension/offscreen/offscreen.js"), "census must list offscreen.js");
  assert(census.includes("extension/lib/provider-gate.js"), "census must list provider-gate.js");
});
