// @ts-nocheck
// tests/onmessage-sender-guard.test.ts — pins the non-dispatcher onMessage sender authority guard (7z3m).
//
// Invariants guarded:
//   1. Every `chrome.runtime.onMessage.addListener` call in extension/ must accept a `sender` parameter
//      and reference/validate it in its body, or be explicitly allowlisted with a documented reason.
//   2. Falsification tests verify that un-checked, ignored (_sender), or single-param listeners fail RED.
//   3. Behavioral tests verify that execution hosts reject untrusted senders (tabs, content scripts, foreign IDs).
//   4. docs/SW-DISPATCH-AUTHORITY-CENSUS.md documents all non-dispatcher listeners and their sender predicates.

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

function walkAst(node: any, visitor: (n: any) => void) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item, visitor);
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walkAst(child, visitor);
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
  const KNOWN_PROPERTIES = new Set([
    "id",
    "tab",
    "url",
    "documentId",
    "origin",
    "frameId",
  ]);
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
    // 2. Rejecting conditional check: IfStatement whose test checks sender / sender.prop
    // and whose consequent returns or throws.
    if (sub.type === "IfStatement") {
      let testHasSenderCheck = false;
      walkAst(sub.test, (tNode: any) => {
        if (tNode.type === "BinaryExpression") {
          const isComp = ["===", "!==", "==", "!="].includes(tNode.operator);
          if (isComp) {
            walkAst(tNode, (operand: any) => {
              if (operand.type === "MemberExpression" && operand.object?.name === senderName) {
                const prop = operand.property?.name || operand.property?.value;
                if (KNOWN_PROPERTIES.has(prop)) testHasSenderCheck = true;
              }
            });
          }
        }
        if (tNode.type === "UnaryExpression" && tNode.operator === "!") {
          if (tNode.argument?.type === "Identifier" && tNode.argument?.name === senderName) {
            testHasSenderCheck = true;
          }
          if (tNode.argument?.type === "MemberExpression" && tNode.argument.object?.name === senderName) {
            const prop = tNode.argument.property?.name || tNode.argument.property?.value;
            if (KNOWN_PROPERTIES.has(prop)) testHasSenderCheck = true;
          }
        }
      });

      if (testHasSenderCheck) {
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

  const sites: ListenerSite[] = [];

  walkAst(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (
        callee.type === "MemberExpression" &&
        callee.property?.name === "addListener" &&
        callee.object?.type === "MemberExpression" &&
        callee.object?.property?.name === "onMessage"
      ) {
        const objObj = callee.object.object;
        const isRuntime =
          (objObj?.type === "Identifier" && objObj.name === "runtime") ||
          (objObj?.type === "MemberExpression" && objObj.property?.name === "runtime") ||
          objObj?.type === "LogicalExpression";
        if (!isRuntime) return;

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

  return sites;
}

// Allowlist for any listener that is intentionally un-gated (currently EMPTY because all 17 sites validate sender)
const ALLOWLISTED_SITES = new Map<string, string>();

Deno.test("guard: all extension/ runtime.onMessage listeners accept and check sender", () => {
  const jsFiles = walkJsFiles(EXTENSION_DIR);
  assert(jsFiles.length > 50, `must scan extension JS files, found ${jsFiles.length}`);

  const allSites: ListenerSite[] = [];
  for (const file of jsFiles) {
    const code = fs.readFileSync(file, "utf8");
    const sites = analyzeOnMessageListeners(code, file);
    allSites.push(...sites);
  }

  assert(allSites.length >= 17, `expected at least 17 onMessage listeners, found ${allSites.length}`);

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
