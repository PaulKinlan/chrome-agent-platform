// tests/split-view.test.ts — chrome-agent-platform-gin2.
//
// The Tabs Split View API (Chrome 155+) lets an agent open a page SIDE-BY-SIDE
// with the owner's active tab instead of a background tab. The contract under
// test (extension/lib/split-view.js + the open_tab wiring):
//   1. Feature detection is by API SURFACE, never a version string.
//   2. A supported pairing creates with `splitWithTabId`.
//   3. EVERY refusal or absence falls back to a plain create — the page opens
//      either way — and the reason travels to the caller.
//   4. The fallback path never carries `splitWithTabId` (a constraint failure
//      retried with the same options would just fail again).
//   5. The open_tab tool wires the helper to the ACTIVE tab only when the
//      model asks (split: true), and reports splitView true/false honestly.
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { clearRunFence } from "../extension/lib/run-fence.js";
import {
  createSplitAware,
  splitViewSupported,
} from "../extension/lib/split-view.js";

function mockTabs({ supportsSplit = true, refuseSplit = false } = {}) {
  const calls = [];
  const created = [];
  const tabsApi = {
    create: async (opts) => {
      calls.push({ ...opts });
      if (opts.splitWithTabId && refuseSplit) {
        throw new Error("Tabs cannot be split: tabs must be adjacent.");
      }
      const tab = { id: 100 + created.length + 1, url: opts.url, splitViewId: opts.splitWithTabId ? 7 : -1 };
      created.push(tab);
      return tab;
    },
  };
  if (supportsSplit) tabsApi.createSplit = async () => 7;
  return { tabsApi, calls, created };
}

Deno.test("gin2: feature detection is by API surface, never a version string", () => {
  assertEquals(splitViewSupported({ createSplit: () => 1, create: async () => ({}) }), true);
  assertEquals(splitViewSupported({ create: async () => ({}) }), false, "Chrome <155: no createSplit");
  assertEquals(splitViewSupported(undefined), false, "no tabs namespace at all (non-Chrome context)");
});

Deno.test("gin2: a supported pairing creates WITH splitWithTabId and reports split", async () => {
  const { tabsApi, calls } = mockTabs();
  const r = await createSplitAware({ url: "https://example.com/page", alongsideTabId: 42, tabs: tabsApi });
  assertEquals(r.split, true);
  assertEquals(r.tab.url, "https://example.com/page");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].splitWithTabId, 42, "the create carries the pairing");
  assertEquals(calls[0].url, "https://example.com/page");
});

Deno.test("gin2: a refused pairing falls back to a PLAIN create without splitWithTabId, and names the reason", async () => {
  const { tabsApi, calls } = mockTabs({ refuseSplit: true });
  const r = await createSplitAware({ url: "https://example.com/page", alongsideTabId: 42, tabs: tabsApi });
  assertEquals(r.split, false);
  assertEquals(r.tab.id, 101, "the page still opened");
  assertStringIncludes(r.reason, "split refused");
  assertStringIncludes(r.reason, "adjacent");
  assertEquals(calls.length, 2, "the pairing attempt then the fallback");
  assertEquals(calls[0].splitWithTabId, 42);
  assertEquals(calls[1].splitWithTabId, undefined, "the fallback must NOT retry the refused options");
});

Deno.test("gin2: an unsupported Chrome falls back to a plain create naming unsupported", async () => {
  const { tabsApi, calls } = mockTabs({ supportsSplit: false });
  const r = await createSplitAware({ url: "https://example.com/page", alongsideTabId: 42, tabs: tabsApi });
  assertEquals(r.split, false);
  assertEquals(r.reason, "unsupported");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].splitWithTabId, undefined);
});

Deno.test("gin2: no alongside tab means a plain create, even on a supported Chrome", async () => {
  const { tabsApi, calls } = mockTabs();
  const r = await createSplitAware({ url: "https://example.com/page", tabs: tabsApi });
  assertEquals(r.split, false);
  assertEquals(r.reason, "no alongside tab");
  assertEquals(calls.length, 1);
});

// ---- the open_tab wiring: the model asks with split:true --------------------

const EXAMPLE = "https://example.com/";
const store = new Map();
const grantedPermissions = new Set(["tabs"]);
const grantedOrigins = new Set();
let nextTabId = 1;
let activeTab = null;
let splitRefused = false;
const createCalls = [];

function resetChrome() {
  store.clear();
  grantedPermissions.clear();
  grantedPermissions.add("tabs");
  grantedOrigins.clear();
  nextTabId = 1;
  activeTab = { id: 9, url: "https://owner.example/start", windowId: 1, active: true };
  splitRefused = false;
  createCalls.length = 0;
  clearRunFence();
}

async function grantOrigin() {
  const { setOriginBrowserControlGrant } = await import("../extension/lib/browser-tools.js");
  await setOriginBrowserControlGrant([EXAMPLE]);
}

function installChrome() {
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
      query: async (_q) => (activeTab ? [activeTab] : []),
      createSplit: async () => 7,
      create: async (opts) => {
        createCalls.push({ ...opts });
        if (opts.splitWithTabId && splitRefused) {
          throw new Error("Tabs cannot be split: tabs must be adjacent.");
        }
        const tab = { id: nextTabId++, url: opts.url, windowId: 1, active: opts.splitWithTabId ? true : false };
        return tab;
      },
      remove: async () => {},
    },
  };
}

Deno.test("gin2 open_tab: split:true pairs the new tab with the ACTIVE tab and reports splitView", async () => {
  resetChrome();
  installChrome();
  await grantOrigin();
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const tools = browserToolset(false);
  const r = await tools.open_tab.execute({ url: EXAMPLE, split: true });
  assertEquals(r.ok, true, JSON.stringify(r));
  assertEquals(r.splitView, true, `the split must be reported: ${JSON.stringify(r)}`);
  assertEquals(r.tabId, 1);
  assertEquals(createCalls.length, 1);
  assertEquals(createCalls[0].splitWithTabId, 9, "paired with the user's active tab");
  assertEquals(createCalls[0].url, EXAMPLE);
});

Deno.test("gin2 open_tab: a refused pairing falls back and reports splitView:false with the reason", async () => {
  resetChrome();
  installChrome();
  splitRefused = true;
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const tools = browserToolset(false);
  const r = await tools.open_tab.execute({ url: EXAMPLE, split: true });
  assertEquals(r.ok, true, JSON.stringify(r));
  assertEquals(r.splitView, false);
  assertStringIncludes(r.splitFallbackReason, "split refused");
  assertEquals(createCalls.length, 2, "pairing attempt then plain fallback");
  assertEquals(createCalls[1].splitWithTabId, undefined);
});

Deno.test("gin2 open_tab: no active tab (headless/none) falls back to a plain create", async () => {
  resetChrome();
  installChrome();
  activeTab = null;
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const tools = browserToolset(false);
  const r = await tools.open_tab.execute({ url: EXAMPLE, split: true });
  assertEquals(r.ok, true, JSON.stringify(r));
  assertEquals(r.splitView, false);
  assertEquals(r.splitFallbackReason, "no alongside tab");
  assertEquals(createCalls.length, 1);
  assertEquals(createCalls[0].splitWithTabId, undefined);
});

Deno.test("gin2 open_tab: without split:true the create is unchanged (no pairing attempted)", async () => {
  resetChrome();
  installChrome();
  await grantOrigin();
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const tools = browserToolset(false);
  const r = await tools.open_tab.execute({ url: EXAMPLE });
  assertEquals(r.ok, true, JSON.stringify(r));
  assertEquals(r.splitView, undefined, "no split key when the model did not ask");
  assertEquals(createCalls.length, 1);
  assertEquals(createCalls[0].splitWithTabId, undefined);
});
