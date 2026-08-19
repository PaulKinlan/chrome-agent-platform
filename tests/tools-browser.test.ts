// tools-browser.test.ts — a test SUITE per browser-control tool (not one test
// per tool): the tool DOES the requested thing against a shimmed chrome.tabs/
// permissions/scripting backend, plus the error cases (missing permission, no
// grant, invalid arg, abort). The round-N comments reference the review findings
// each assertion guards against.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  setDenyAllBrowserControlGrant,
  revokeBrowserControlGrant,
  isBrowserControlGranted,
} from "../extension/lib/browser-tools.js";
import { setRunFence, clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim (tabs + permissions + scripting + storage) ----
const store = new Map();
const granted = new Set(["storage", "tabs", "activeTab", "scripting"]);
const grantedOrigins = new Set(); // exact host permissions ("https://x/*")
const tabs = []; // { id, url, title, active }

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
function reset() {
  store.clear();
  granted.clear();
  for (const p of ["storage", "tabs", "activeTab", "scripting"]) granted.add(p);
  grantedOrigins.clear();
  tabs.length = 0;
  clearRunFence();
}
function nextTabId() {
  return (tabs.reduce((m, t) => Math.max(m, t.id), 0) + 1) || 1;
}

globalThis.chrome = {
  permissions: {
    contains: async ({ permissions, origins }) => {
      if (origins) return origins.every((o) => grantedOrigins.has(o));
      return permissions.every((p) => granted.has(p));
    },
    request: async ({ permissions, origins }) => {
      permissions?.forEach((p) => granted.add(p));
      origins?.forEach((o) => grantedOrigins.add(o));
      return true;
    },
    remove: async ({ permissions }) => {
      permissions.forEach((p) => granted.delete(p));
      return true;
    },
  },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  tabs: {
    create: async ({ url }) => {
      const tab = { id: nextTabId(), url, title: url, active: true };
      tabs.push(tab);
      return tab;
    },
    get: async (id) => {
      const t = tabs.find((t) => t.id === id);
      if (!t) throw new Error("no such tab");
      return t;
    },
    update: async (id, { url }) => {
      const t = tabs.find((t) => t.id === id);
      if (!t) throw new Error("no such tab");
      if (url) t.url = url;
      return t;
    },
    remove: async (id) => {
      const i = tabs.findIndex((t) => t.id === id);
      if (i >= 0) tabs.splice(i, 1);
    },
    query: async (q) => tabs.filter((t) => (!q?.active || t.active) && (!q?.currentWindow || true)),
    captureVisibleTab: async () => "data:image/png;base64,AAAA",
  },
  scripting: {
    executeScript: async ({ target }) => {
      const t = tabs.find((t) => t.id === target.tabId) ?? tabs[0];
      return [{ result: { title: t?.title ?? "", url: t?.url ?? "", text: "visible text" } }];
    },
  },
  alarms: {
    create: async () => true,
    clear: async () => true,
    get: async () => undefined,
    getAll: async () => [],
  },
};

const toolset = () => browserToolset();

Deno.test("browser grant: PERSISTS — the owner grant does not auto-expire (tracker item 51)", async () => {
  reset();
  await setGlobalBrowserControlGrant(); // no expiry → PERSISTENT
  const s = await chrome.storage.local.get("cap:browserControlGrant");
  const grant = s["cap:browserControlGrant"];
  assertEquals(grant.scope, "global", "the empty-origins toggle grants GLOBAL (all origins)");
  assertEquals(grant.expiresAt, null, "a persistent grant has no expiry (revoked explicitly, never auto-expires)");
  // A persistent global grant authorizes ANY origin (not a deny-all record).
  assertEquals(await isBrowserControlGranted("https://anything.example"), true);
});

Deno.test("browser grant: a TIMED grant still expires (an explicit expiryMs is honored)", async () => {
  reset();
  await setGlobalBrowserControlGrant(1); // 1ms
  await new Promise((r) => setTimeout(r, 15));
  assertEquals(await isBrowserControlGranted("https://anything.example"), false);
});

Deno.test("browser open_tab: opens a tab when the grant + permission are present", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const r = await toolset().open_tab.execute({ url: "https://example.com/a" });
  assert(r.ok, `open_tab should succeed, got ${JSON.stringify(r)}`);
  assertEquals(tabs.length, 1, "a tab was actually created");
  assertEquals(tabs[0].url, "https://example.com/a");
});

Deno.test("browser open_tab: DENIES without the tabs permission", async () => {
  reset();
  granted.delete("tabs");
  await setGlobalBrowserControlGrant();
  const r = await toolset().open_tab.execute({ url: "https://example.com/a" });
  assert(!r.ok);
  assertStringIncludes(r.error, "tabs permission not granted");
  assertEquals(tabs.length, 0, "no tab without permission");
});

Deno.test("browser open_tab: DENIES when the destination origin is not granted", async () => {
  reset();
  await setOriginBrowserControlGrant(["https://allowed.example"], 60000);
  const r = await toolset().open_tab.execute({ url: "https://other.example/x" });
  assert(!r.ok);
  assertStringIncludes(r.error, "not granted");
  assertEquals(tabs.length, 0);
});

Deno.test("browser open_tab: the input schema rejects an invalid url", async () => {
  const t = toolset().open_tab;
  assertThrows(() => t.inputSchema.parse({ url: "not-a-url" }), "the zod schema must reject a non-URL");
});

Deno.test("browser open_tab: DENIES when the run is pre-aborted (the fence)", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  setRunFence({ signal: { aborted: true } });
  const r = await toolset().open_tab.execute({ url: "https://example.com/a" });
  assert(!r.ok, "an aborted run must not open a tab");
  assertEquals(tabs.length, 0, "no tab was created");
});

Deno.test("browser navigate_tab: navigates an existing tab when granted", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const tab = await chrome.tabs.create({ url: "https://example.com/from" });
  const r = await toolset().navigate_tab.execute({ tabId: tab.id, url: "https://example.com/to" });
  assert(r.ok, `navigate_tab should succeed, got ${JSON.stringify(r)}`);
  assertEquals(tabs.find((t) => t.id === tab.id).url, "https://example.com/to");
});

Deno.test("browser navigate_tab: DENIES a destination not granted", async () => {
  reset();
  await setOriginBrowserControlGrant(["https://allowed.example"], 60000);
  const tab = await chrome.tabs.create({ url: "https://allowed.example/from" });
  const r = await toolset().navigate_tab.execute({ tabId: tab.id, url: "https://other.example/to" });
  assert(!r.ok);
  assertStringIncludes(r.error, "not granted");
  assertEquals(tabs.find((t) => t.id === tab.id).url, "https://allowed.example/from", "unchanged");
});

Deno.test("browser navigate_tab: DENIES when the source identity changed mid-call", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const tab = await chrome.tabs.create({ url: "https://example.com/from" });
  // A second tab navigates the source tab to an unauthorized origin between the
  // grant check and the mutation (round-20 source-identity race). We emulate by
  // making tabs.get return a DIFFERENT url on the second call.
  let calls = 0;
  const origGet = chrome.tabs.get;
  chrome.tabs.get = async (id) => {
    calls++;
    if (calls >= 2) return { id, url: "https://evil.example/moved", title: "moved" };
    return origGet(id);
  };
  try {
    const r = await toolset().navigate_tab.execute({ tabId: tab.id, url: "https://example.com/to" });
    assert(!r.ok);
    assertStringIncludes(r.error, "source identity changed");
  } finally {
    chrome.tabs.get = origGet;
  }
});

Deno.test("browser close_tab: closes a granted tab", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const tab = await chrome.tabs.create({ url: "https://example.com/a" });
  const r = await toolset().close_tab.execute({ tabId: tab.id });
  assert(r.ok, `close_tab should succeed, got ${JSON.stringify(r)}`);
  assertEquals(tabs.length, 0, "the tab was actually closed");
});

Deno.test("browser close_tab: DENIES an ungranted origin", async () => {
  reset();
  await setOriginBrowserControlGrant(["https://allowed.example"], 60000);
  const tab = await chrome.tabs.create({ url: "https://other.example/x" });
  const r = await toolset().close_tab.execute({ tabId: tab.id });
  assert(!r.ok);
  assertEquals(tabs.length, 1, "the ungranted tab stayed open");
});

Deno.test("browser list_tabs: lists the open tabs", async () => {
  reset();
  await chrome.tabs.create({ url: "https://a.example/1" });
  await chrome.tabs.create({ url: "https://b.example/2" });
  const r = await toolset().list_tabs.execute({});
  assertEquals(r.tabs.length, 2);
  assertEquals(r.tabs[0].url, "https://a.example/1");
});

Deno.test("browser list_tabs: DENIES without the tabs permission", async () => {
  reset();
  granted.delete("tabs");
  const r = await toolset().list_tabs.execute({});
  assert(!r.ok);
  assertStringIncludes(r.error, "tabs permission not granted");
});

Deno.test("browser read_page: reads the page via scripting", async () => {
  reset();
  const tab = await chrome.tabs.create({ url: "https://example.com/doc" });
  const r = await toolset().read_page.execute({ tabId: tab.id });
  assert(r.title, `read_page should return a title, got ${JSON.stringify(r)}`);
  assertEquals(r.url, "https://example.com/doc");
});

Deno.test("browser read_page: DENIES without the scripting permission", async () => {
  reset();
  granted.delete("scripting");
  const r = await toolset().read_page.execute({});
  assert(!r.ok);
  assertStringIncludes(r.error, "scripting permission not granted");
});

Deno.test("browser capture_screenshot: activeTab/tabs are NOT a background fallback without exact host access", async () => {
  reset();
  tabs.push({ id: 7, url: "https://private.example/page", title: "Private", active: true });
  await setOriginBrowserControlGrant(["https://private.example"]);
  // activeTab + tabs are both present in the shim, but a model/background
  // capture still requires the selected tab's exact origin permission.
  const r = await toolset().capture_screenshot.execute({ tabId: 7 });
  assert(!r.ok);
  assertEquals(r.waitingForPermission, true);
  assertStringIncludes(r.error, "https://private.example/*");
});

Deno.test("browser capture_screenshot: the OWNER-INVOKED path uses Chrome's transient activeTab authority (no exact host needed)", async () => {
  reset();
  tabs.push({ id: 9, url: "https://anywhere.example/page", title: "Anywhere", active: true });
  // The product browser-control grant covers the origin, but the exact host
  // Chrome permission is NOT granted — the owner-invoked path must still
  // capture (Chrome's action click carries the transient authority).
  await setOriginBrowserControlGrant(["https://anywhere.example"]);
  // Call the function directly the way the action listener does (the tool
  // route never passes ownerInvoked).
  const { captureTabScreenshot } = await import("../extension/lib/browser-tools.js");
  const r = await captureTabScreenshot(9, { ownerInvoked: true });
  assert(!r.error, `owner-invoked capture must not fail closed: ${r.error ?? ""}`);
  assert(typeof r.screenshot === "string" && r.screenshot.startsWith("data:image/"), "captured a screenshot");
});

Deno.test("browser capture_screenshot: the MODEL path with exact host granted captures", async () => {
  reset();
  tabs.push({ id: 11, url: "https://allowed.example/page", title: "Allowed", active: true });
  await setOriginBrowserControlGrant(["https://allowed.example"]);
  grantedOrigins.add("https://allowed.example/*"); // the exact host grant
  const r = await toolset().capture_screenshot.execute({ tabId: 11 });
  assert(!r.error, `exact-host capture must succeed: ${r.error ?? ""}`);
  assert(typeof r.screenshot === "string" && r.screenshot.startsWith("data:image/"));
});

Deno.test("browser schedule_task: schedules when fenced ok", async () => {
  reset();
  const created = [];
  chrome.alarms.create = async (name, info) => { created.push({ name, info }); return true; };
  const r = await toolset().schedule_task.execute({ task: "summarise this", delayMs: 1000 });
  assert(r.ok, `schedule_task should succeed, got ${JSON.stringify(r)}`);
  assert(created.length === 1, "an alarm was actually created");
});

Deno.test("browser schedule_task: DENIES when the run is aborted", async () => {
  reset();
  setRunFence({ signal: { aborted: true } });
  const r = await toolset().schedule_task.execute({ task: "summarise this", delayMs: 1000 });
  assert(!r.ok);
  assertStringIncludes(r.error, "run aborted");
});

Deno.test("browser scoped (readOnly) toolset exposes ONLY read tools", () => {
  const scoped = browserToolset(true);
  const keys = Object.keys(scoped);
  assert(keys.includes("read_page") && keys.includes("capture_screenshot") && keys.includes("list_tabs"));
  assert(!keys.includes("open_tab"), "open_tab must not be in the readOnly set");
  assert(!keys.includes("navigate_tab"), "navigate_tab must not be in the readOnly set");
  assert(!keys.includes("close_tab"), "close_tab must not be in the readOnly set");
  assert(!keys.includes("schedule_task"), "schedule_task must not be in the readOnly set");
});

Deno.test("browser: a revoked grant DENIES a subsequent mutation", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  await revokeBrowserControlGrant();
  const r = await toolset().open_tab.execute({ url: "https://example.com/a" });
  assert(!r.ok, "revoking the grant must block the mutation");
  assertEquals(tabs.length, 0);
});
