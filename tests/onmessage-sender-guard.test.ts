// @ts-nocheck
// tests/onmessage-sender-guard.test.ts — pins the non-dispatcher onMessage sender authority guard (7z3m).
//
// Invariants guarded:
//   1. Every `chrome.runtime.onMessage.addListener` call in extension/ must accept a `sender` parameter
//      and reference/validate it in its body, or be explicitly allowlisted with a documented reason.
//      A rejecting conditional counts as validation ONLY when its test PROVABLY depends
//      on an SW-discriminating property (tab / documentId / url) via exhaustive truth-table
//      evaluation: per THREAT_MODEL.md INV-15, an extension-ID-only (or origin/frameId-only)
//      check establishes nothing because same-extension documents and content scripts share
//      sender.id, and a discriminating property MENTIONED in a dead or short-circuited
//      clause (&& false / || true) establishes nothing either (chrome-agent-platform-69bvp).
//   2. Falsification tests verify that un-checked, ignored (_sender), single-param, and
//      id-only-checking listeners fail RED.
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

function isAuthenticatingSender(body: any, senderName: string): boolean {
  const KNOWN_PREDICATES = new Set([
    "isTrustedServiceWorkerSender",
    "isTrustedWasmStreamSender",
    "isTrustedTableWorkerSender",
    "authorizeToolReport",
    "handleScriptRunMessage",
  ]);
  // INV-15 (THREAT_MODEL.md): an extension ID alone does not establish the SW
  // principal — same-extension documents and content scripts share sender.id.
  // A rejecting conditional only counts as authenticating the service worker
  // when its test PROVABLY DEPENDS on a property that discriminates the SW from
  // same-extension callers: tab/documentId absence or the SW bundle URL.
  // id/origin/frameId-only checks establish nothing (chrome-agent-platform-69bvp),
  // and neither does a discriminating property MENTIONED in a dead or
  // short-circuited clause (&& false / || true) — proven by exhaustive
  // truth-table evaluation of the test over its atoms (69bvp re-review).
  const SW_DISCRIMINATING_PROPERTIES = new Set(["tab", "documentId", "url"]);

  const stableKey = (node: any): string =>
    JSON.stringify(node, (k, v) => (k === "parent" || k === "loc" || k === "start" || k === "end" ? undefined : v));

  const referencesSender = (node: any): boolean => {
    let found = false;
    walkAst(node, (sub) => {
      if (found) return;
      if (sub.type !== "Identifier" || sub.name !== senderName) return;
      const p = sub.parent;
      if (p && p.type === "MemberExpression" && p.property === sub && !p.computed) return;
      if (p && p.type === "Property" && p.key === sub && !p.computed) return;
      found = true;
    });
    return found;
  };

  const senderPropsOf = (node: any): string[] => {
    const props = new Set<string>();
    walkAst(node, (sub) => {
      if (sub.type === "MemberExpression" && sub.object?.type === "Identifier" && sub.object.name === senderName) {
        const p = sub.property?.name || sub.property?.value;
        if (typeof p === "string") props.add(p);
      }
    });
    return [...props];
  };

  // Constant-fold sub-expressions that do not reference the sender.
  const tryConstEval = (node: any): { ok: boolean; value?: any } => {
    try {
      switch (node?.type) {
        case "Literal":
          return { ok: true, value: node.value };
        case "ChainExpression":
          return tryConstEval(node.expression);
        case "UnaryExpression": {
          const a = tryConstEval(node.argument);
          if (!a.ok) return { ok: false };
          switch (node.operator) {
            case "!": return { ok: true, value: !a.value };
            case "-": return { ok: true, value: -a.value };
            case "+": return { ok: true, value: +a.value };
            case "~": return { ok: true, value: ~a.value };
            case "void": return { ok: true, value: undefined };
            case "typeof": return { ok: true, value: typeof a.value };
            default: return { ok: false };
          }
        }
        case "BinaryExpression": {
          const l = tryConstEval(node.left);
          const r = tryConstEval(node.right);
          if (!l.ok || !r.ok) return { ok: false };
          switch (node.operator) {
            case "===": return { ok: true, value: l.value === r.value };
            case "!==": return { ok: true, value: l.value !== r.value };
            case "==": return { ok: true, value: l.value == r.value };
            case "!=": return { ok: true, value: l.value != r.value };
            case "<": return { ok: true, value: l.value < r.value };
            case "<=": return { ok: true, value: l.value <= r.value };
            case ">": return { ok: true, value: l.value > r.value };
            case ">=": return { ok: true, value: l.value >= r.value };
            case "+": return { ok: true, value: l.value + r.value };
            case "-": return { ok: true, value: l.value - r.value };
            case "*": return { ok: true, value: l.value * r.value };
            case "/": return { ok: true, value: l.value / r.value };
            case "%": return { ok: true, value: l.value % r.value };
            default: return { ok: false };
          }
        }
        case "LogicalExpression": {
          const l = tryConstEval(node.left);
          if (!l.ok) return { ok: false };
          if (node.operator === "||") return l.value ? l : tryConstEval(node.right);
          if (node.operator === "&&") return l.value ? tryConstEval(node.right) : l;
          if (node.operator === "??") return l.value ?? tryConstEval(node.right);
          return { ok: false };
        }
        case "ConditionalExpression": {
          const t = tryConstEval(node.test);
          if (!t.ok) return { ok: false };
          return tryConstEval(t.value ? node.consequent : node.alternate);
        }
        default:
          return { ok: false };
      }
    } catch {
      return { ok: false };
    }
  };

  // Prove that the test's outcome DEPENDS on an SW-discriminating sender
  // property: split the test into atoms at the transparent boolean structure
  // (||, &&, ??, !, ternary, chain), constant-fold what does not reference the
  // sender, then exhaustively evaluate the truth table. A discriminating atom
  // whose value never changes the result is dead — exactly the
  // `sender.id !== id || (sender.tab != null && false)` counterexample from the
  // 69bvp re-review. Fail closed (false) when unprovable.
  const proveDiscriminatingDependence = (test: any): boolean => {
    try {
      const atomNodes: any[] = [];
      const atomIndex = new Map<string, number>();
      const register = (node: any): number => {
        const key = stableKey(node);
        let idx = atomIndex.get(key);
        if (idx === undefined) {
          idx = atomNodes.length;
          atomIndex.set(key, idx);
          atomNodes.push(node);
        }
        return idx;
      };
      const collect = (node: any): void => {
        switch (node.type) {
          case "LogicalExpression":
            collect(node.left);
            collect(node.right);
            return;
          case "ChainExpression":
            collect(node.expression);
            return;
          case "UnaryExpression":
            if (node.operator === "!") { collect(node.argument); return; }
            break;
          case "ConditionalExpression":
            collect(node.test);
            collect(node.consequent);
            collect(node.alternate);
            return;
        }
        if (referencesSender(node) || !tryConstEval(node).ok) register(node);
      };
      collect(test);

      const n = atomNodes.length;
      if (n === 0 || n > 10) return false; // constant test, or too complex to prove: fail closed

      const evalWith = (node: any, values: boolean[]): any => {
        switch (node.type) {
          case "LogicalExpression": {
            const l = evalWith(node.left, values);
            if (node.operator === "||") return l ? l : evalWith(node.right, values);
            if (node.operator === "&&") return l ? evalWith(node.right, values) : l;
            return l ?? evalWith(node.right, values);
          }
          case "ChainExpression":
            return evalWith(node.expression, values);
          case "UnaryExpression":
            if (node.operator === "!") return !evalWith(node.argument, values);
            break;
          case "ConditionalExpression":
            return evalWith(node.test, values) ? evalWith(node.consequent, values) : evalWith(node.alternate, values);
        }
        if (referencesSender(node)) return values[register(node)];
        const c = tryConstEval(node);
        if (c.ok) return c.value;
        return values[register(node)];
      };

      const rows = 1 << n;
      const results: boolean[] = new Array(rows);
      for (let mask = 0; mask < rows; mask++) {
        const values = atomNodes.map((_, i) => Boolean((mask >> i) & 1));
        results[mask] = Boolean(evalWith(test, values));
      }
      for (let i = 0; i < n; i++) {
        if (!senderPropsOf(atomNodes[i]).some((p) => SW_DISCRIMINATING_PROPERTIES.has(p))) continue;
        for (let mask = 0; mask < rows; mask++) {
          if (results[mask] !== results[mask ^ (1 << i)]) return true; // live dependence on a discriminating property
        }
      }
      return false;
    } catch {
      return false; // fail closed
    }
  };

  let validated = false;
  walkAst(body, (sub) => {
    // 1. Passed to a recognized sender authentication helper/predicate
    if (sub.type === "CallExpression") {
      const callee = sub.callee;
      const name = callee.name || (callee.property && callee.property.name);
      if (KNOWN_PREDICATES.has(name)) {
        if (sub.arguments.some((arg: any) => arg.type === "Identifier" && arg.name === senderName)) {
          validated = true;
        }
      }
    }
    // 2. Rejecting conditional check: IfStatement whose test PROVABLY depends on
    // an SW-discriminating sender property (tab/documentId/url), and whose
    // consequent returns or throws. Dead or short-circuited clauses do not count.
    if (sub.type === "IfStatement") {
      if (proveDiscriminatingDependence(sub.test)) {
        let consequentRejects = false;
        walkAst(sub.consequent, (cNode: any) => {
          if (cNode.type === "ReturnStatement" || cNode.type === "ThrowStatement") {
            consequentRejects = true;
          }
        });
        if (consequentRejects) {
          validated = true;
        }
      }
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
            checksSender = isAuthenticatingSender(fn.body, senderParamName);
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

// Allowlist for any listener that is intentionally un-gated (currently EMPTY because all 17 sites validate sender)
const ALLOWLISTED_SITES = new Map<string, string>();

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
  const probeIdAndTabCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!sender || sender.id !== chrome.runtime.id || sender.tab != null) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites12 = analyzeOnMessageListeners(probeIdAndTabCheck, "extension/test-probe12.js");
  assertEquals(sites12.length, 1);
  assertEquals(sites12[0].checksSender, true, "id + tab-absence rejecting check must count as SW authentication");

  const probeSwBundleUrlCheck = `
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.url !== chrome.runtime.getURL("dist/background/service-worker.js")) return false;
      sendResponse({ ok: true });
      return true;
    });
  `;
  const sites13 = analyzeOnMessageListeners(probeSwBundleUrlCheck, "extension/test-probe13.js");
  assertEquals(sites13.length, 1);
  assertEquals(sites13[0].checksSender, true, "SW bundle URL rejecting check must count as SW authentication");

  // 69bvp re-review (gpt-6-sol): a property MENTION in a dead or short-circuited
  // clause does not establish rejection — the discriminating property must be in a
  // live branch whose value can change the outcome of the test.
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
