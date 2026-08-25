// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 13 (deep tab control
// + action enable/disable + sidePanel options/behavior): schema bounds,
// permission/grant gates per tool, tab-identity re-read defense, side-panel
// path confinement, read-only classification. In-memory chrome shim extended
// from chrome-tools-t1.test.ts with the deep tab/action/sidePanel surfaces.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim ----
const store = new Map();
const granted = new Set(["storage", "tabs", "sidePanel"]);
const tabs = new Map(); // id -> { id, url, windowId, pinned, active, index, discarded }
const zoom = new Map(); // id -> zoomFactor
const calls = { reload: [], goBack: [], goForward: [], highlight: [], enable: [], disable: [], setOptions: [], setPanelBehavior: [], move: [], duplicate: [] };
let nextTabId = 1;
let sidePanelOptions = { path: "sidepanel/sidepanel.html", enabled: true };
let getURLBehavior = "normal"; // normal | throw | escape

function seedTab(url, { windowId = 1, active = false, pinned = false } = {}) {
  const tab = { id: nextTabId++, url, windowId, pinned, active, index: tabs.size, discarded: false };
  tabs.set(tab.id, tab);
  return tab;
}

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  granted.add("tabs");
  granted.add("sidePanel");
  tabs.clear();
  zoom.clear();
  nextTabId = 1;
  for (const key of Object.keys(calls)) calls[key] = [];
  sidePanelOptions = { path: "sidepanel/sidepanel.html", enabled: true };
  getURLBehavior = "normal";
  clearRunFence();
}

const EXT_ROOT = "chrome-extension://test-extension-id/";

globalThis.chrome = {
  permissions: {
    contains: async ({ permissions }) => permissions.every((p) => granted.has(p)),
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
  runtime: {
    getURL: (path) => {
      if (getURLBehavior === "throw") throw new Error("boom");
      const p = String(path).replace(/^\/+/, "");
      // The root lookup always resolves to the extension root (as in Chrome);
      // the escape mode models a hostile resolution of a NON-root path.
      if (getURLBehavior === "escape" && p !== "") return "https://evil.example/not-bundled.html";
      return `${EXT_ROOT}${p}`;
    },
  },
  tabs: {
    query: async (q) => [...tabs.values()].filter((t) => q?.windowId === undefined || t.windowId === q.windowId),
    get: async (id) => {
      const t = tabs.get(id);
      if (!t) throw new Error("No tab with id " + id);
      return { ...t };
    },
    move: async (id, props) => {
      const t = tabs.get(id);
      if (!t) throw new Error("No tab with id " + id);
      if (props?.windowId !== undefined) t.windowId = props.windowId;
      if (props?.index !== undefined) t.index = props.index;
      calls.move.push([id, props]);
      return { ...t };
    },
    duplicate: async (id) => {
      const t = tabs.get(id);
      if (!t) throw new Error("No tab with id " + id);
      const copy = { id: nextTabId++, url: t.url, windowId: t.windowId, pinned: false, active: false, index: tabs.size, discarded: false };
      tabs.set(copy.id, copy);
      calls.duplicate.push(id);
      return { ...copy };
    },
    update: async (id, props) => {
      const t = tabs.get(id);
      if (!t) throw new Error("No tab with id " + id);
      if (props?.pinned !== undefined) t.pinned = props.pinned;
      return { ...t };
    },
    reload: async (id, opts) => {
      if (!tabs.has(id)) throw new Error("No tab with id " + id);
      calls.reload.push([id, opts]);
    },
    goBack: async (id) => {
      if (!tabs.has(id)) throw new Error("No tab with id " + id);
      calls.goBack.push(id);
    },
    goForward: async (id) => {
      if (!tabs.has(id)) throw new Error("No tab with id " + id);
      calls.goForward.push(id);
    },
    getZoom: async (id) => {
      if (!tabs.has(id)) throw new Error("No tab with id " + id);
      return zoom.get(id) ?? 1;
    },
    setZoom: async (id, factor) => {
      if (!tabs.has(id)) throw new Error("No tab with id " + id);
      zoom.set(id, factor);
    },
    discard: async (id) => {
      const t = tabs.get(id);
      if (!t) throw new Error("No tab with id " + id);
      if (t.active) throw new Error("Tabs cannot be discarded");
      t.discarded = true;
    },
    highlight: async (props) => {
      calls.highlight.push(props);
      return { id: props?.windowId ?? 1 };
    },
  },
  windows: {
    WINDOW_ID_CURRENT: -2,
    get: async (id, { populate } = {}) => {
      const resolved = id === -2 ? 1 : id;
      const winTabs = [...tabs.values()].filter((t) => t.windowId === resolved).sort((a, b) => a.index - b.index);
      if (resolved !== 1 && winTabs.length === 0 && !tabs.size) throw new Error("No window with id " + id);
      return { id: resolved, tabs: populate ? winTabs.map((t) => ({ ...t })) : undefined };
    },
  },
  action: {
    enable: async (tabId) => { calls.enable.push(tabId ?? null); },
    disable: async (tabId) => { calls.disable.push(tabId ?? null); },
  },
  sidePanel: {
    getOptions: async ({ tabId } = {}) => ({ ...sidePanelOptions, tabId: tabId ?? null }),
    setOptions: async (opts) => {
      calls.setOptions.push(opts);
      sidePanelOptions = { path: opts.path, enabled: opts.enabled ?? sidePanelOptions.enabled };
    },
    setPanelBehavior: async (behavior) => { calls.setPanelBehavior.push(behavior); },
  },
};

const tools = () => browserToolset(false);

// The deep tab mutations that must be tab-origin grant-gated.
const TAB_MUTATIONS = [
  ["move_tab", { tabId: 1, index: 0 }],
  ["duplicate_tab", { tabId: 1 }],
  ["set_tab_pinned", { tabId: 1, pinned: true }],
  ["reload_tab", { tabId: 1 }],
  ["tab_go_back", { tabId: 1 }],
  ["tab_go_forward", { tabId: 1 }],
  ["set_tab_zoom", { tabId: 1, zoomFactor: 1.5 }],
  ["discard_tab", { tabId: 1 }],
];

Deno.test("T13 inventory: the 15 tranche-13 tools ship; reads join the readOnly subset, mutations never", () => {
  const all = Object.keys(tools());
  for (const name of [
    "move_tab", "duplicate_tab", "set_tab_pinned", "reload_tab", "tab_go_back",
    "tab_go_forward", "get_tab_zoom", "set_tab_zoom", "discard_tab", "highlight_tabs",
    "enable_action", "disable_action", "get_side_panel_options", "set_side_panel_options",
    "set_panel_behavior",
  ]) {
    assert(all.includes(name), `${name} shipped`);
  }
  const scoped = Object.keys(browserToolset(true));
  for (const name of ["get_tab_zoom", "get_side_panel_options"]) {
    assert(scoped.includes(name), `${name} is read-only — exposed to scoped runs`);
  }
  for (const name of [
    "move_tab", "duplicate_tab", "set_tab_pinned", "reload_tab", "tab_go_back",
    "tab_go_forward", "set_tab_zoom", "discard_tab", "highlight_tabs",
    "enable_action", "disable_action", "set_side_panel_options", "set_panel_behavior",
  ]) {
    assert(!scoped.includes(name), `${name} mutates — NEVER exposed to scoped runs`);
  }
});

Deno.test("T13 schema bounds: zoom range, move/highlight arg shapes, side-panel path confinement — all rejected before any chrome call", () => {
  const t = tools();
  // zoom bounded 0.25–8
  assertEquals(t.set_tab_zoom.inputSchema.safeParse({ tabId: 1, zoomFactor: 0.1 }).success, false, "below 0.25 rejected");
  assertEquals(t.set_tab_zoom.inputSchema.safeParse({ tabId: 1, zoomFactor: 9 }).success, false, "above 8 rejected");
  assertEquals(t.set_tab_zoom.inputSchema.safeParse({ tabId: 1, zoomFactor: 0 }).success, false);
  assertEquals(t.set_tab_zoom.inputSchema.safeParse({ tabId: 1, zoomFactor: 0.25 }).success, true, "floor accepted");
  assertEquals(t.set_tab_zoom.inputSchema.safeParse({ tabId: 1, zoomFactor: 8 }).success, true, "ceiling accepted");
  // move_tab requires a destination
  assertEquals(t.move_tab.inputSchema.safeParse({ tabId: 1 }).success, false, "no windowId/index rejected");
  assertEquals(t.move_tab.inputSchema.safeParse({ tabId: 1, index: -1 }).success, false, "negative index rejected");
  assertEquals(t.move_tab.inputSchema.safeParse({ tabId: 1, index: 2 }).success, true);
  // highlight_tabs: exactly one selector, bounded
  assertEquals(t.highlight_tabs.inputSchema.safeParse({ windowId: 1 }).success, false, "no selector rejected");
  assertEquals(t.highlight_tabs.inputSchema.safeParse({ tabIds: [1], indices: [0] }).success, false, "both selectors rejected");
  assertEquals(t.highlight_tabs.inputSchema.safeParse({ indices: [1500] }).success, false, "index above bound rejected");
  assertEquals(t.highlight_tabs.inputSchema.safeParse({ tabIds: [] }).success, false, "empty tabIds rejected");
  assertEquals(t.highlight_tabs.inputSchema.safeParse({ indices: [0, 2] }).success, true);
  // side-panel path confinement (schema layer)
  assertEquals(t.set_side_panel_options.inputSchema.safeParse({ path: "../evil.html" }).success, false, "traversal rejected");
  assertEquals(t.set_side_panel_options.inputSchema.safeParse({ path: "/abs.html" }).success, false, "absolute path rejected");
  assertEquals(t.set_side_panel_options.inputSchema.safeParse({ path: "https://evil.example/x.html" }).success, false, "remote URL rejected");
  assertEquals(t.set_side_panel_options.inputSchema.safeParse({ path: "sidepanel/sidepanel.js" }).success, false, "non-html rejected");
  assertEquals(t.set_side_panel_options.inputSchema.safeParse({ path: "" }).success, false, "empty rejected");
  assertEquals(t.set_side_panel_options.inputSchema.safeParse({ path: "sidepanel/sidepanel.html" }).success, true);
});

Deno.test("T13 permission gates: no tabs permission → structured denial; no sidePanel permission → structured denial", async () => {
  reset();
  const t = seedTab("https://granted.example/a");
  granted.delete("tabs");
  for (const [name, args] of TAB_MUTATIONS) {
    const r = await tools()[name].execute(args);
    assertEquals(r.error, "tabs permission not granted — enable Browser control in Settings", name);
  }
  assertEquals((await tools().get_tab_zoom.execute({ tabId: t.id })).error, "tabs permission not granted — enable Browser control in Settings");
  assertEquals((await tools().highlight_tabs.execute({ tabIds: [t.id] })).error, "tabs permission not granted — enable Browser control in Settings");
  granted.add("tabs");
  granted.delete("sidePanel");
  for (const name of ["get_side_panel_options", "set_side_panel_options", "set_panel_behavior"]) {
    const args = name === "set_side_panel_options" ? { path: "sidepanel/sidepanel.html" } : name === "set_panel_behavior" ? { openPanelOnActionClick: true } : {};
    const r = await tools()[name].execute(args);
    assertEquals(r.error, "sidePanel permission not granted — enable it in Settings (Side panel)", name);
  }
});

Deno.test("T13 grant-denied paths: EVERY deep tab mutation denies without a grant and mutates nothing", async () => {
  reset();
  const t = seedTab("https://granted.example/a");
  for (const [name, args] of TAB_MUTATIONS.map(([n, a]) => [n, { ...a, tabId: t.id }])) {
    const r = await tools()[name].execute(args);
    assert(r.error && !r.ok, `${name} denied without a grant`);
    assert(r.error.includes("browser control not granted"), `${name} honest denial: ${r.error}`);
  }
  assertEquals(calls.move.length, 0, "no move reached Chrome");
  assertEquals(calls.duplicate.length, 0, "no duplicate reached Chrome");
  assertEquals(calls.reload.length, 0, "no reload reached Chrome");
  assertEquals(calls.goBack.length, 0, "no goBack reached Chrome");
  assertEquals(calls.goForward.length, 0, "no goForward reached Chrome");
  assert(!tabs.get(t.id).pinned, "no pin applied");
  assert(!tabs.get(t.id).discarded, "no discard applied");
  assertEquals(zoom.get(t.id), undefined, "no zoom applied");
  const h = await tools().highlight_tabs.execute({ tabIds: [t.id] });
  assert(h.error && h.error.includes("browser control not granted"), "highlight denied without a grant");
  assertEquals(calls.highlight.length, 0);
});

Deno.test("T13 origin scoping: granted origin allows; ungranted tab origin denies", async () => {
  reset();
  const ok = seedTab("https://granted.example/a");
  const other = seedTab("https://other.example/b");
  await setOriginBrowserControlGrant(["https://granted.example"]);

  assertEquals((await tools().reload_tab.execute({ tabId: ok.id })).ok, true, "granted origin reloads");
  assertEquals(calls.reload.length, 1);
  assertEquals((await tools().set_tab_pinned.execute({ tabId: ok.id, pinned: true })).ok, true);
  assertEquals(tabs.get(ok.id).pinned, true);
  assertEquals((await tools().set_tab_zoom.execute({ tabId: ok.id, zoomFactor: 2 })).ok, true);
  assertEquals(zoom.get(ok.id), 2);
  assertEquals((await tools().get_tab_zoom.execute({ tabId: ok.id })).zoomFactor, 2);
  const dup = await tools().duplicate_tab.execute({ tabId: ok.id });
  assertEquals(dup.ok, true);
  assert(dup.newTabId && dup.newTabId !== ok.id);
  assertEquals((await tools().move_tab.execute({ tabId: ok.id, index: 3 })).ok, true);
  assertEquals(tabs.get(ok.id).index, 3);
  assertEquals((await tools().tab_go_back.execute({ tabId: ok.id })).ok, true);
  assertEquals((await tools().tab_go_forward.execute({ tabId: ok.id })).ok, true);
  const discarded = seedTab("https://granted.example/d"); // inactive → discardable
  assertEquals((await tools().discard_tab.execute({ tabId: discarded.id })).ok, true);
  assertEquals(tabs.get(discarded.id).discarded, true);

  for (const [name, args] of TAB_MUTATIONS.map(([n, a]) => [n, { ...a, tabId: other.id }])) {
    const r = await tools()[name].execute(args);
    assert(r.error && r.error.includes("browser control not granted"), `${name} denies an ungranted origin`);
  }
});

Deno.test("T13 identity re-read: a tab that navigates between grant-check and mutation is never mutated", async () => {
  reset();
  const t = seedTab("https://granted.example/a");
  await setOriginBrowserControlGrant(["https://granted.example"]);
  // Simulate the round-20 race: the FIRST tabs.get inside the lock sees the
  // granted origin; the identity re-read immediately before the mutation sees
  // the tab has navigated to an ungranted origin. The tool must fail closed.
  const realGet = globalThis.chrome.tabs.get;
  let getServed = 0;
  globalThis.chrome.tabs.get = async (id) => {
    const copy = await realGet(id);
    getServed++;
    if (getServed >= 2) return { ...copy, url: "https://evil.example/smuggled" };
    return copy;
  };
  const r = await tools().reload_tab.execute({ tabId: t.id });
  assert(r.error && r.error.includes("source identity changed"), `identity race fails closed: ${r.error}`);
  assertEquals(calls.reload.length, 0, "the mutation never reached Chrome");
  globalThis.chrome.tabs.get = realGet;
});

Deno.test("T13 highlight_tabs: EVERY highlighted origin must be granted; indices resolve against the live window order", async () => {
  reset();
  const a = seedTab("https://a.example/x", { index: 0 });
  const b = seedTab("https://b.example/y", { index: 1 });
  const c = seedTab("https://a.example/z", { index: 2 });

  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().highlight_tabs.execute({ tabIds: [a.id, b.id] });
  assert(r.error && r.error.includes("every highlighted tab"), "partial coverage denies");
  assertEquals(calls.highlight.length, 0, "no highlight reached Chrome");

  r = await tools().highlight_tabs.execute({ tabIds: [a.id, c.id] });
  assertEquals(r.ok, true, "full coverage highlights");
  assertEquals(calls.highlight[0].tabs.sort(), [a.id, c.id].sort());

  // index selector resolves through the LIVE window tab order
  r = await tools().highlight_tabs.execute({ indices: [0, 2] });
  assertEquals(r.ok, true);
  assertEquals(calls.highlight[1].tabs.sort(), [a.id, c.id].sort(), "indices 0/2 resolve to the a.example tabs");

  r = await tools().highlight_tabs.execute({ indices: [7] });
  assert(r.error && r.error.includes("no tab at index 7"), "out-of-range index fails honestly");

  // tabs without readable origins are an origin-less scope → global grant only
  await revokeBrowserControlGrant();
  const chromeTab = seedTab(undefined, { index: 3 }); // no url → canonicalOrigin impossible
  r = await tools().highlight_tabs.execute({ tabIds: [chromeTab.id] });
  assert(r.error, "origin-less highlight denied under no grant");
  await setGlobalBrowserControlGrant();
  r = await tools().highlight_tabs.execute({ tabIds: [chromeTab.id] });
  assertEquals(r.ok, true, "global grant covers the origin-less highlight");
});

Deno.test("T13 MIXED-SET coverage (review blocker): an origin-less tab is NEVER filtered out of the grant check", async () => {
  reset();
  const a = seedTab("https://a.example/x", { index: 0 });
  const chromeTab = seedTab("chrome://newtab/", { index: 1 }); // canonicalOrigin → null (non-http scheme)

  // The reviewer's probe, direction 1: an origins grant covering ONLY the
  // https tab must REFUSE the mixed set (pre-fix this returned
  // {ok:true, highlighted:2} — the origin-less tab was filtered out of the
  // coverage set and failed open).
  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().highlight_tabs.execute({ tabIds: [a.id, chromeTab.id] });
  assert(r.error && r.error.includes("every highlighted tab"), `mixed set refused under an origins grant: ${r?.error}`);
  assertEquals(calls.highlight.length, 0, "no highlight reached Chrome");
  assertEquals(r.ok, undefined);

  // Direction 2: the SAME mixed set under a GLOBAL grant is ALLOWED (the
  // global grant covers the origin-less tab; named origins are covered too).
  await setGlobalBrowserControlGrant();
  r = await tools().highlight_tabs.execute({ tabIds: [a.id, chromeTab.id] });
  assertEquals(r.ok, true, "global grant covers the mixed set");
  assertEquals(r.highlighted, 2);
  assertEquals(calls.highlight.length, 1);

  // Origin-less-ONLY set under an origins grant is likewise refused (empty
  // named-origin set + hasOriginless → the global grant is required).
  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().highlight_tabs.execute({ tabIds: [chromeTab.id] });
  assert(r.error, "origin-less-only set refused under an origins grant");
  assertEquals(calls.highlight.length, 1, "still no new highlight reached Chrome");
});

Deno.test("T13 aligned single-tab coverage: origin-less tabs mutate ONLY under a global grant; cross-class navigation fails closed", async () => {
  reset();
  const chromeTab = seedTab("chrome://settings/");

  // origins grant → the origin-less single tab is denied (never in the list)
  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().reload_tab.execute({ tabId: chromeTab.id });
  assert(r.error && r.error.includes("browser control not granted"), `origin-less single tab denied under an origins grant: ${r?.error}`);
  assertEquals(calls.reload.length, 0);

  // global grant → allowed (the aligned coverage semantics chosen per review)
  await setGlobalBrowserControlGrant();
  r = await tools().reload_tab.execute({ tabId: chromeTab.id });
  assertEquals(r.ok, true, "origin-less single tab allowed under a global grant");
  assertEquals(calls.reload.length, 1);

  // identity: an origin-less tab that navigates to a WEB origin between the
  // grant check and the mutation fails closed (cross-class navigation)
  const realGet = globalThis.chrome.tabs.get;
  let served = 0;
  globalThis.chrome.tabs.get = async (id) => {
    const copy = await realGet(id);
    served++;
    if (served >= 2) return { ...copy, url: "https://evil.example/x" };
    return copy;
  };
  r = await tools().set_tab_zoom.execute({ tabId: chromeTab.id, zoomFactor: 1.5 });
  assert(r.error && r.error.includes("source identity changed"), `cross-class navigation fails closed: ${r?.error}`);

  // …while staying within the origin-less class (chrome://settings →
  // chrome://version) remains inside the globally-granted class
  served = 0;
  globalThis.chrome.tabs.get = async (id) => {
    const copy = await realGet(id);
    served++;
    if (served >= 2) return { ...copy, url: "chrome://version/" };
    return copy;
  };
  r = await tools().set_tab_zoom.execute({ tabId: chromeTab.id, zoomFactor: 1.5 });
  assertEquals(r.ok, true, "origin-less → origin-less stays within the granted class");
  globalThis.chrome.tabs.get = realGet;
});

Deno.test("T13 discard: Chrome's refusal (active tab) surfaces as a structured error, never a throw", async () => {
  reset();
  const active = seedTab("https://granted.example/a", { active: true });
  await setGlobalBrowserControlGrant();
  const r = await tools().discard_tab.execute({ tabId: active.id });
  assert(r.error && r.error.includes("not discarded"), `structured error: ${r.error}`);
  assertEquals(r.ok, undefined);
  assert(!tabs.get(active.id).discarded);
});

Deno.test("T13 enable/disable_action: owner-scoped surfaces need no grant but honor the run fence", async () => {
  reset();
  assertEquals(await tools().enable_action.execute({}), { ok: true, tabId: null, enabled: true });
  assertEquals(await tools().disable_action.execute({ tabId: 42 }), { ok: true, tabId: 42, enabled: false });
  assertEquals(calls.enable, [null]);
  assertEquals(calls.disable, [42]);
});

Deno.test("T13 sidePanel options: confinement to bundled pages + GLOBAL grant only", async () => {
  reset();
  const readBack = await tools().get_side_panel_options.execute({});
  assertEquals(readBack.ok, true);
  assertEquals(readBack.path, "sidepanel/sidepanel.html");

  // origins grant is NOT enough for a browser-level surface
  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().set_side_panel_options.execute({ path: "sidepanel/sidepanel.html", enabled: true });
  assert(r.error && r.error.includes("browser control not granted"), "origins grant denied for a global surface");
  assertEquals(calls.setOptions.length, 0);

  r = await tools().set_panel_behavior.execute({ openPanelOnActionClick: true });
  assert(r.error, "set_panel_behavior needs the global grant too");
  assertEquals(calls.setPanelBehavior.length, 0);

  await setGlobalBrowserControlGrant();
  r = await tools().set_side_panel_options.execute({ path: "panel/panel.html", enabled: true, tabId: 7 });
  assertEquals(r.ok, true, "global grant + confined path applies");
  assertEquals(calls.setOptions[0], { path: "panel/panel.html", enabled: true, tabId: 7 });
  r = await tools().set_panel_behavior.execute({ openPanelOnActionClick: false });
  assertEquals(r.ok, true);
  assertEquals(calls.setPanelBehavior[0], { openPanelOnActionClick: false });

  // runtime confinement proofs (beyond the schema): an escaping resolution or
  // a throwing getURL both fail closed and never reach setOptions.
  const before = calls.setOptions.length;
  getURLBehavior = "escape";
  r = await tools().set_side_panel_options.execute({ path: "panel/panel.html" });
  assert(r.error && r.error.includes("escapes the extension root"), `escape denied: ${r.error}`);
  getURLBehavior = "throw";
  r = await tools().set_side_panel_options.execute({ path: "panel/panel.html" });
  assert(r.error && r.error.includes("rejected"), `throwing getURL denied: ${r.error}`);
  getURLBehavior = "normal";
  assertEquals(calls.setOptions.length, before, "no setOptions reached Chrome for confined paths");
});

Deno.test("T13 missing tab / window honesty", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const r = await tools().reload_tab.execute({ tabId: 9999 });
  assertEquals(r.error, "no such tab: 9999");
  const h = await tools().highlight_tabs.execute({ indices: [0], windowId: 5 });
  // window 5 has no tabs in the shim → the index resolves honestly
  assert(h.error, "out-of-range window index fails honestly");
});
