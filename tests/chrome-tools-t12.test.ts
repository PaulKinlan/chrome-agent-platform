// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 12 (power tools:
// chrome.debugger CDP with a bounded method allowlist, chrome.userScripts and
// chrome.scripting dynamic content scripts with single-origin matches).
// KATs: CDP allowlist enforcement (Runtime.evaluate + unknown methods refused
// BEFORE any Chrome call), args bounds, GLOBAL-grant-only for every debugger
// mutation, single-origin matches enforcement (<all_urls>/wildcards refused
// before any Chrome call), host-permission scoping, origin-coverage of every
// matches pattern, bounded outputs + honest truncation. In-memory chrome shim
// extended from chrome-tools-t8.test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import {
  BROWSER_TOOL_NAMES,
  CHROME_TOOL_CAPABILITY_BOUNDS,
} from "../extension/lib/chrome-tool-capabilities.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim ----
const store = new Map();
const grantedPermissions = new Set(["storage", "tabs"]);
const grantedOrigins = new Set();
const tabs = [];
let nextTabId = 1;
const attachedTabs = new Set();
const debuggerCalls = []; // records debugger API calls ("never reached" proofs)
const userScripts = new Map(); // id -> script
const contentScripts = new Map(); // id -> script
const scriptCalls = []; // records userScripts/scripting API calls
let sendCommandResult = {};

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedPermissions.add("storage");
  grantedPermissions.add("tabs");
  grantedOrigins.clear();
  tabs.length = 0;
  nextTabId = 1;
  attachedTabs.clear();
  debuggerCalls.length = 0;
  userScripts.clear();
  contentScripts.clear();
  scriptCalls.length = 0;
  sendCommandResult = {};
  clearRunFence();
}

function addTab(url) {
  const tab = { id: nextTabId++, url, title: url, windowId: 1 };
  tabs.push(tab);
  return tab;
}

globalThis.chrome = {
  permissions: {
    contains: async (q) => {
      if (q?.permissions && !q.permissions.every((p) => grantedPermissions.has(p))) return false;
      if (q?.origins && !q.origins.every((o) => grantedOrigins.has(o))) return false;
      return true;
    },
  },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
  tabs: {
    query: async () => [...tabs],
    get: async (id) => tabs.find((t) => t.id === id) ?? null,
  },
  debugger: {
    attach: async (target, version) => {
      debuggerCalls.push(["attach", target, version]);
      if (attachedTabs.has(target.tabId)) {
        throw new Error(`Another debugger is already attached to the tab with id ${target.tabId}.`);
      }
      attachedTabs.add(target.tabId);
    },
    detach: async (target) => {
      debuggerCalls.push(["detach", target]);
      if (!attachedTabs.has(target.tabId)) {
        throw new Error(`No debugger is attached to the tab with id ${target.tabId}.`);
      }
      attachedTabs.delete(target.tabId);
    },
    sendCommand: async (target, method, args) => {
      debuggerCalls.push(["sendCommand", target, method, args]);
      if (!attachedTabs.has(target.tabId)) {
        throw new Error(`No debugger is attached to the tab with id ${target.tabId}.`);
      }
      return sendCommandResult;
    },
  },
  userScripts: {
    register: async (scripts) => {
      scriptCalls.push(["userScripts.register", scripts]);
      for (const s of scripts) {
        if (userScripts.has(s.id)) throw new Error(`Duplicate user script id ${s.id}.`);
        userScripts.set(s.id, { ...s });
      }
    },
    update: async (scripts) => {
      scriptCalls.push(["userScripts.update", scripts]);
      for (const s of scripts) {
        if (!userScripts.has(s.id)) throw new Error(`No user script with id ${s.id}.`);
        userScripts.set(s.id, { ...s });
      }
    },
    unregister: async ({ ids }) => {
      scriptCalls.push(["userScripts.unregister", ids]);
      for (const id of ids) userScripts.delete(id);
    },
    getScripts: async (filter) => {
      scriptCalls.push(["userScripts.getScripts", filter]);
      const all = [...userScripts.values()];
      if (filter?.ids) return all.filter((s) => filter.ids.includes(s.id));
      return all;
    },
  },
  scripting: {
    registerContentScripts: async (scripts) => {
      scriptCalls.push(["scripting.register", scripts]);
      for (const s of scripts) {
        if (contentScripts.has(s.id)) throw new Error(`Duplicate content script id ${s.id}.`);
        contentScripts.set(s.id, { ...s });
      }
    },
    updateContentScripts: async (scripts) => {
      scriptCalls.push(["scripting.update", scripts]);
      for (const s of scripts) {
        if (!contentScripts.has(s.id)) throw new Error(`No content script with id ${s.id}.`);
        contentScripts.set(s.id, { ...s });
      }
    },
    unregisterContentScripts: async ({ ids }) => {
      scriptCalls.push(["scripting.unregister", ids]);
      for (const id of ids) contentScripts.delete(id);
    },
    getRegisteredContentScripts: async (filter) => {
      scriptCalls.push(["scripting.getRegistered", filter]);
      const all = [...contentScripts.values()];
      if (filter?.ids) return all.filter((s) => filter.ids.includes(s.id));
      return all;
    },
  },
};

function tools() {
  return browserToolset(false);
}

// ──────────────────────────────────────────────────────────────────────────
// Registry parity: the 12 T12 tools are appended AND the counts are honest.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12: browserToolset has exactly 64 tools matching BROWSER_TOOL_NAMES (52 + 12)", () => {
  reset();
  const browser = tools();
  assertEquals(Object.keys(browser), BROWSER_TOOL_NAMES);
  assertEquals(BROWSER_TOOL_NAMES.length, 64);
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS.browserTools, 64);
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS.totalTools, 93);
  for (const name of [
    "list_debugger_targets", "debugger_attach", "debugger_detach", "debugger_send_command",
    "register_user_script", "update_user_script", "unregister_user_script", "list_user_scripts",
    "register_content_script", "update_content_script", "unregister_content_script", "list_content_scripts",
  ]) {
    assert(name in browser, `${name} present`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// chrome.debugger: permission + GLOBAL grant discipline
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12 debugger tools: denied honestly without the debugger permission (no Chrome call)", async () => {
  reset();
  addTab("https://a.example/1");
  await setGlobalBrowserControlGrant();
  for (const [name, args] of [
    ["list_debugger_targets", {}],
    ["debugger_attach", { tabId: 1 }],
    ["debugger_detach", { tabId: 1 }],
    ["debugger_send_command", { tabId: 1, method: "Network.enable" }],
  ]) {
    const r = await tools()[name].execute(args);
    assertEquals(r.error, "debugger permission not granted — enable Debugger in Settings", name);
  }
  assertEquals(debuggerCalls.length, 0);
});

Deno.test("T12 debugger_attach: an ORIGIN grant is never enough — only the GLOBAL grant authorizes CDP", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  await setOriginBrowserControlGrant(["https://a.example"]);
  const denied = await tools().debugger_attach.execute({ tabId: tab.id });
  assert(denied.error.includes("global grant"), denied.error);
  assertEquals(debuggerCalls.length, 0);
  await revokeBrowserControlGrant();
  const deniedNone = await tools().debugger_attach.execute({ tabId: tab.id });
  assert(deniedNone.error.includes("global grant"), deniedNone.error);
  await setGlobalBrowserControlGrant();
  const ok = await tools().debugger_attach.execute({ tabId: tab.id });
  assertEquals(ok, { ok: true, tabId: tab.id, protocolVersion: "1.3" });
  assertEquals(debuggerCalls, [["attach", { tabId: tab.id }, "1.3"]]);
});

Deno.test("T12 debugger_attach: already attached → honest bounded error, never a raw throw", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  await setGlobalBrowserControlGrant();
  assertEquals((await tools().debugger_attach.execute({ tabId: tab.id })).ok, true);
  const again = await tools().debugger_attach.execute({ tabId: tab.id });
  assert(typeof again.error === "string" && again.error.includes("Another debugger is already attached"), JSON.stringify(again));
});

Deno.test("T12 debugger_detach: grant-gated + honest when nothing is attached", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  const denied = await tools().debugger_detach.execute({ tabId: tab.id });
  assert(denied.error.includes("global grant"), denied.error);
  await setGlobalBrowserControlGrant();
  const notAttached = await tools().debugger_detach.execute({ tabId: tab.id });
  assert(notAttached.error.includes("No debugger is attached"), JSON.stringify(notAttached));
  attachedTabs.add(tab.id);
  const ok = await tools().debugger_detach.execute({ tabId: tab.id });
  assertEquals(ok, { ok: true, tabId: tab.id });
});

// ──────────────────────────────────────────────────────────────────────────
// CDP allowlist: Runtime.evaluate + unknown methods refused BEFORE Chrome
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12 debugger_send_command: Runtime.evaluate refused BY DESIGN with rationale (no Chrome call)", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  attachedTabs.add(tab.id);
  await setGlobalBrowserControlGrant();
  const r = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Runtime.evaluate" });
  assert(r.error.includes("arbitrary JavaScript"), JSON.stringify(r));
  const r2 = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Runtime.callFunctionOn" });
  assert(r2.error.includes("Runtime.* methods") || r2.error.includes("refused"), JSON.stringify(r2));
  assertEquals(debuggerCalls.length, 0);
});

Deno.test("T12 debugger_send_command: unknown methods refused BEFORE chrome.debugger.sendCommand", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  attachedTabs.add(tab.id);
  await setGlobalBrowserControlGrant();
  for (const method of ["DOM.getDocument", "Storage.clearDataForOrigin", "Network.setBypassServiceWorker"]) {
    const r = await tools().debugger_send_command.execute({ tabId: tab.id, method });
    assert(r.error.includes("not on the allowlist"), `${method}: ${JSON.stringify(r)}`);
  }
  assertEquals(debuggerCalls.length, 0);
});

Deno.test("T12 debugger_send_command: allowlisted method runs under the global grant; args bounded", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  attachedTabs.add(tab.id);
  await setGlobalBrowserControlGrant();
  const ok = await tools().debugger_send_command.execute({
    tabId: tab.id,
    method: "Emulation.setCPUThrottlingRate",
    argsJson: JSON.stringify({ rate: 4 }),
  });
  assertEquals(ok.ok, true);
  assertEquals(ok.truncated, false);
  assertEquals(debuggerCalls[0][0], "sendCommand");
  assertEquals(debuggerCalls[0][2], "Emulation.setCPUThrottlingRate");
  assertEquals(debuggerCalls[0][3], { rate: 4 });
  // args bounds (defense in depth — execute is called directly here):
  const tooBig = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Network.enable", argsJson: "x".repeat(4097) });
  assert(tooBig.error.includes("4 KiB"), JSON.stringify(tooBig).slice(0, 120));
  const badJson = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Network.enable", argsJson: "{oops" });
  assert(badJson.error.includes("valid JSON"), JSON.stringify(badJson));
  const notObject = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Network.enable", argsJson: "[1,2]" });
  assert(notObject.error.includes("JSON object"), JSON.stringify(notObject));
  assertEquals(debuggerCalls.length, 1); // only the first command reached Chrome
});

Deno.test("T12 debugger_send_command: an ORIGIN grant is refused for CDP commands", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  attachedTabs.add(tab.id);
  await setOriginBrowserControlGrant(["https://a.example"]);
  const r = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Network.enable" });
  assert(r.error.includes("global grant"), JSON.stringify(r));
  assertEquals(debuggerCalls.length, 0);
});

Deno.test("T12 debugger_send_command: results > 8 KiB truncated with an honest flag", async () => {
  reset();
  grantedPermissions.add("debugger");
  const tab = addTab("https://a.example/1");
  attachedTabs.add(tab.id);
  await setGlobalBrowserControlGrant();
  sendCommandResult = { data: "y".repeat(9000) };
  const r = await tools().debugger_send_command.execute({ tabId: tab.id, method: "Performance.getMetrics" });
  assertEquals(r.ok, true);
  assertEquals(r.truncated, true);
  assertEquals(r.result.length, 8192);
  assert(r.resultBytes > 8192);
});

Deno.test("T12 list_debugger_targets: read-only, bounded, permission-gated", async () => {
  reset();
  grantedPermissions.add("debugger");
  for (let i = 0; i < 5; i++) addTab(`https://a.example/${i}`);
  const r = await tools().list_debugger_targets.execute({ maxResults: 3 });
  assertEquals(r.targets.length, 3);
  assertEquals(r.total, 5);
  assertEquals(r.truncated, true);
  assertEquals(r.targets[0].tabId, 1);
  assertEquals(debuggerCalls.length, 0);
  // no grant needed for the read:
  const noGrant = await tools().list_debugger_targets.execute({});
  assertEquals(noGrant.total, 5);
});

// ──────────────────────────────────────────────────────────────────────────
// chrome.userScripts: single-origin matches + host scoping + grant coverage
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12 register_user_script: broad matches refused BEFORE any Chrome call", async () => {
  reset();
  grantedPermissions.add("userScripts");
  grantedOrigins.add("https://a.example/*");
  await setGlobalBrowserControlGrant();
  for (const matches of [
    ["<all_urls>"],
    ["https://*.example.com/*"],
    ["https://a.example/path/*"],
    ["file:///etc/passwd"],
  ]) {
    const r = await tools().register_user_script.execute({ id: "s1", js: "console.log(1)", matches });
    assert(typeof r.error === "string" && r.error.startsWith("matches rejected:"), `${matches}: ${JSON.stringify(r)}`);
  }
  assertEquals(scriptCalls.length, 0);
});

Deno.test("T12 register_user_script: host permission for the exact origin is required (never requested by the SW)", async () => {
  reset();
  grantedPermissions.add("userScripts");
  await setOriginBrowserControlGrant(["https://a.example"]);
  const r = await tools().register_user_script.execute({
    id: "s1", js: "console.log(1)", matches: ["https://a.example/*"],
  });
  assert(r.error.includes("host permission not granted"), JSON.stringify(r));
  assertEquals(scriptCalls.length, 0);
});

Deno.test("T12 register_user_script: grant must cover every matches origin (per-origin + multi-origin)", async () => {
  reset();
  grantedPermissions.add("userScripts");
  grantedOrigins.add("https://a.example/*");
  grantedOrigins.add("https://b.example/*");
  // No product grant at all:
  const denied = await tools().register_user_script.execute({
    id: "s1", js: "console.log(1)", matches: ["https://a.example/*"],
  });
  assert(denied.error.includes("browser control not granted"), JSON.stringify(denied));
  // Origin grant covering ONLY a.example, matches ask for a + b:
  await setOriginBrowserControlGrant(["https://a.example"]);
  const partial = await tools().register_user_script.execute({
    id: "s2", js: "console.log(1)", matches: ["https://a.example/*", "https://b.example/*"],
  });
  assert(partial.error.includes("browser control not granted"), JSON.stringify(partial));
  assertEquals(scriptCalls.length, 0);
  // Origin grant covering BOTH:
  await setOriginBrowserControlGrant(["https://a.example", "https://b.example"]);
  const ok = await tools().register_user_script.execute({
    id: "s3", js: "console.log(1)", matches: ["https://a.example/*", "https://b.example/*"], runAt: "document_idle",
  });
  assertEquals(ok.ok, true);
  assertEquals(ok.matches, ["https://a.example/*", "https://b.example/*"]);
  assertEquals(userScripts.get("s3").runAt, "document_idle");
});

Deno.test("T12 update_user_script: same discipline as register", async () => {
  reset();
  grantedPermissions.add("userScripts");
  grantedOrigins.add("https://a.example/*");
  await setOriginBrowserControlGrant(["https://a.example"]);
  userScripts.set("s1", { id: "s1", js: "old", matches: ["https://a.example/*"] });
  const ok = await tools().update_user_script.execute({ id: "s1", js: "new", matches: ["https://a.example/*"] });
  assertEquals(ok.ok, true);
  assertEquals(userScripts.get("s1").js, "new");
  await revokeBrowserControlGrant();
  const denied = await tools().update_user_script.execute({ id: "s1", js: "x", matches: ["https://a.example/*"] });
  assert(denied.error.includes("browser control not granted"), JSON.stringify(denied));
});

Deno.test("T12 unregister_user_script: coverage is checked against the REGISTERED script's matches", async () => {
  reset();
  grantedPermissions.add("userScripts");
  grantedOrigins.add("https://a.example/*");
  userScripts.set("s1", { id: "s1", js: "x", matches: ["https://a.example/*"] });
  const denied = await tools().unregister_user_script.execute({ id: "s1" });
  assert(denied.error.includes("browser control not granted"), JSON.stringify(denied));
  assertEquals(userScripts.has("s1"), true);
  await setOriginBrowserControlGrant(["https://a.example"]);
  const ok = await tools().unregister_user_script.execute({ id: "s1" });
  assertEquals(ok, { ok: true, id: "s1" });
  assertEquals(userScripts.has("s1"), false);
  const missing = await tools().unregister_user_script.execute({ id: "nope" });
  assert(missing.error.includes("no user script"), JSON.stringify(missing));
});

Deno.test("T12 unregister_user_script: a script whose matches fail validation is an ORIGIN-LESS scope — global grant only", async () => {
  reset();
  grantedPermissions.add("userScripts");
  grantedOrigins.add("https://a.example/*");
  // Registered out-of-band with a broad pattern that today's validator refuses:
  userScripts.set("legacy", { id: "legacy", js: "x", matches: ["<all_urls>"] });
  await setOriginBrowserControlGrant(["https://a.example"]);
  const denied = await tools().unregister_user_script.execute({ id: "legacy" });
  assert(denied.error.includes("browser control not granted"), JSON.stringify(denied));
  assertEquals(userScripts.has("legacy"), true);
  await setGlobalBrowserControlGrant();
  const ok = await tools().unregister_user_script.execute({ id: "legacy" });
  assertEquals(ok, { ok: true, id: "legacy" });
  assertEquals(userScripts.has("legacy"), false);
});

Deno.test("T12 list_user_scripts: read-only, bounded, permission-gated", async () => {
  reset();
  const denied = await tools().list_user_scripts.execute({});
  assertEquals(denied.error, "userScripts permission not granted — enable User scripts in Settings");
  grantedPermissions.add("userScripts");
  for (let i = 0; i < 5; i++) userScripts.set(`s${i}`, { id: `s${i}`, js: "y".repeat(400), matches: ["https://a.example/*"], runAt: "document_idle" });
  const r = await tools().list_user_scripts.execute({ maxResults: 3 });
  assertEquals(r.userScripts.length, 3);
  assertEquals(r.total, 5);
  assertEquals(r.truncated, true);
  assertEquals(r.userScripts[0].jsBytes, 400);
  assertEquals(r.userScripts[0].jsPreview.length, 256);
});

// ──────────────────────────────────────────────────────────────────────────
// chrome.scripting dynamic content scripts: same discipline
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12 register_content_script: broad matches refused before Chrome; scripting permission gated", async () => {
  reset();
  const noPerm = await tools().register_content_script.execute({ id: "c1", js: "x", matches: ["https://a.example/*"] });
  assertEquals(noPerm.error, "scripting permission not granted — enable Site Agents in Settings");
  grantedPermissions.add("scripting");
  grantedOrigins.add("https://a.example/*");
  await setGlobalBrowserControlGrant();
  const broad = await tools().register_content_script.execute({ id: "c1", js: "x", matches: ["<all_urls>"] });
  assert(broad.error.startsWith("matches rejected:"), JSON.stringify(broad));
  assertEquals(scriptCalls.length, 0);
});

Deno.test("T12 register_content_script: host + origin-coverage + world enum", async () => {
  reset();
  grantedPermissions.add("scripting");
  grantedOrigins.add("https://a.example/*");
  await setOriginBrowserControlGrant(["https://a.example"]);
  const ok = await tools().register_content_script.execute({
    id: "c1", js: "document.title='x'", matches: ["https://a.example/*"], runAt: "document_start", world: "MAIN",
  });
  assertEquals(ok.ok, true);
  assertEquals(contentScripts.get("c1").world, "MAIN");
  assertEquals(contentScripts.get("c1").runAt, "document_start");
  await revokeBrowserControlGrant();
  const denied = await tools().register_content_script.execute({ id: "c2", js: "x", matches: ["https://a.example/*"] });
  assert(denied.error.includes("browser control not granted"), JSON.stringify(denied));
  assertEquals(scriptCalls.filter(([k]) => k === "scripting.register").length, 1);
});

Deno.test("T12 unregister_content_script: registered-matches coverage; invalid matches ⇒ global grant only", async () => {
  reset();
  grantedPermissions.add("scripting");
  grantedOrigins.add("https://a.example/*");
  contentScripts.set("c1", { id: "c1", js: ["x"], matches: ["https://a.example/*"] });
  contentScripts.set("legacy", { id: "legacy", js: ["x"], matches: ["*://*/"] });
  await setOriginBrowserControlGrant(["https://a.example"]);
  assertEquals((await tools().unregister_content_script.execute({ id: "c1" })).ok, true);
  assertEquals(contentScripts.has("c1"), false);
  const deniedLegacy = await tools().unregister_content_script.execute({ id: "legacy" });
  assert(deniedLegacy.error.includes("browser control not granted"), JSON.stringify(deniedLegacy));
  await setGlobalBrowserControlGrant();
  assertEquals((await tools().unregister_content_script.execute({ id: "legacy" })).ok, true);
});

Deno.test("T12 list_content_scripts: read-only, bounded, permission-gated", async () => {
  reset();
  grantedPermissions.add("scripting");
  for (let i = 0; i < 4; i++) contentScripts.set(`c${i}`, { id: `c${i}`, js: ["z".repeat(300)], matches: ["https://a.example/*"], runAt: "document_idle", world: "ISOLATED" });
  const r = await tools().list_content_scripts.execute({ maxResults: 2 });
  assertEquals(r.contentScripts.length, 2);
  assertEquals(r.total, 4);
  assertEquals(r.truncated, true);
  assertEquals(r.contentScripts[0].jsBytes, 300);
  assertEquals(r.contentScripts[0].world, "ISOLATED");
});
