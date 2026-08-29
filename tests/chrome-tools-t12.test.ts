// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 12 (power tools:
// chrome.userScripts and
// chrome.scripting dynamic content scripts with single-origin matches).
// KATs: CDP allowlist enforcement (Runtime.evaluate + unknown methods refused
// BEFORE any Chrome call), args bounds, GLOBAL-grant-only for every
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
  CHROME_TOOL_CAPABILITY_TABLE,
} from "../extension/lib/chrome-tool-capabilities.js";
import { CAPABILITIES } from "../extension/lib/capabilities.js";
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
// Registry parity: the 8 T12 tools are appended AND the counts are honest.
// (The 4 chrome.debugger CDP tools were removed 2026-08-27 — see the guard below.)
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12: browserToolset has exactly 126 tools matching BROWSER_TOOL_NAMES (118 + 8)", () => {
  reset();
  const browser = tools();
  assertEquals(Object.keys(browser), BROWSER_TOOL_NAMES);
  assertEquals(BROWSER_TOOL_NAMES.length, 126);
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS.browserTools, 126);
  // 159 + delegate_to_agent (agent→agent delegation, G5) = 160.
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS.totalTools, 160);
  for (const name of [
    "register_user_script", "update_user_script", "unregister_user_script", "list_user_scripts",
    "register_content_script", "update_content_script", "unregister_content_script", "list_content_scripts",
  ]) {
    assert(name in browser, `${name} present`);
  }
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
  assertEquals(denied.error, "userScripts permission not granted — all permissions are granted at install; if Settings → Permissions shows it missing, reload the extension");
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
  assertEquals(noPerm.error, "scripting permission not granted — all permissions are granted at install; if Settings → Permissions shows Site Agents missing, reload the extension");
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

// ──────────────────────────────────────────────────────────────────────────
// readOnly (scoped-hook) exposure: the 2 T12 reads are exposed; NO T12 mutation.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12 readOnly: the 2 reads are exposed; every T12 mutation is excluded", () => {
  reset();
  const scoped = browserToolset(true);
  for (const name of ["list_user_scripts", "list_content_scripts"]) {
    assert(name in scoped, `${name} exposed to scoped runs`);
  }
  for (const name of [
    "register_user_script", "update_user_script", "unregister_user_script",
    "register_content_script", "update_content_script", "unregister_content_script",
  ]) {
    assert(!(name in scoped), `${name} must NOT be exposed to scoped runs`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// REMOVAL GUARD (2026-08-27, owner decision Q17).
// chrome.debugger was removed: it carries Chrome's all-sites permission
// warning and a persistent "started debugging this browser" bar, which is not
// acceptable in the product's current posture. The tools may return later
// behind a separate developer-only surface — as a DELIBERATE act, not by a
// tranche quietly re-adding a name. This guard fails loudly if that happens,
// and the chrome.debugger shim above stays in place precisely so that a
// resurrected tool would have something to call and still be caught here.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T12 GUARD: chrome.debugger is absent from the manifest, the capability table and the toolset", async () => {
  reset();
  const manifest = JSON.parse(await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)));
  assert(!JSON.stringify(manifest).includes("debugger"), "no debugger anywhere in the manifest");
  assert(!(manifest.optional_permissions ?? []).includes("debugger"), "debugger is not an optional permission");

  const browser = tools();
  const scoped = browserToolset(true);
  for (const name of [
    "list_debugger_targets", "debugger_attach", "debugger_detach", "debugger_send_command",
  ]) {
    assert(!(name in browser), `${name} must NOT be in the toolset`);
    assert(!(name in scoped), `${name} must NOT be exposed to scoped runs`);
    assert(!BROWSER_TOOL_NAMES.includes(name), `${name} must NOT be in BROWSER_TOOL_NAMES`);
  }
  assert(!CHROME_TOOL_CAPABILITY_TABLE.some((row) => row.toolName.includes("debugger")), "no debugger row in the capability table");
  assert(!CAPABILITIES.some((c) => c.id === "debugger"), "no debugger capability offered in Settings");
  assertEquals(debuggerCalls.length, 0);
});
