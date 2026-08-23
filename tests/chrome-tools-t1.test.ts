// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 1 (windows + action
// + commands): schema bounds, permission/grant gates, read-only classification.
// In-memory chrome shim extended from tools-browser.test.ts with
// windows/action/commands surfaces.
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
const granted = new Set(["storage", "tabs"]);
const windows = new Map(); // id -> { id, focused, type, state, left, top, width, height, tabs: [{url}] }
const tabs = []; // { id, url, title, windowId }
let nextWindowId = 1;
const actionState = { badgeText: "", badgeColor: [0, 0, 0, 0], title: "" };
const declaredCommands = [
  { name: "toggle-panel", shortcut: "Ctrl+Shift+Y", description: "Toggle the side panel" },
];

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  granted.add("tabs");
  windows.clear();
  tabs.length = 0;
  nextWindowId = 1;
  actionState.badgeText = "";
  actionState.badgeColor = [0, 0, 0, 0];
  actionState.title = "";
  clearRunFence();
}

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
  tabs: {
    query: async (q) => tabs.filter((t) => q?.windowId === undefined || t.windowId === q.windowId),
    create: async ({ url, windowId }) => {
      const tab = { id: tabs.length + 1, url, title: url, windowId };
      tabs.push(tab);
      return tab;
    },
    remove: async (id) => { const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); },
  },
  windows: {
    getAll: async () => [...windows.values()].map((w) => ({ ...w, tabs: undefined })),
    get: async (id, { populate } = {}) => {
      const w = windows.get(id);
      if (!w) throw new Error("no such window");
      return { ...w, tabs: populate ? tabs.filter((t) => t.windowId === id) : undefined };
    },
    create: async (opts) => {
      const w = { id: nextWindowId++, focused: opts?.focused !== false, type: "normal", state: "normal", left: opts?.left ?? 0, top: opts?.top ?? 0, width: opts?.width ?? 800, height: opts?.height ?? 600 };
      windows.set(w.id, w);
      if (opts?.url) tabs.push({ id: tabs.length + 1, url: opts.url, title: opts.url, windowId: w.id });
      return w;
    },
    update: async (id, opts) => {
      const w = windows.get(id);
      if (!w) throw new Error("no such window");
      Object.assign(w, opts);
      return w;
    },
    remove: async (id) => {
      if (!windows.delete(id)) throw new Error("no such window");
      for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].windowId === id) tabs.splice(i, 1);
    },
  },
  action: {
    setBadgeText: async ({ text }) => { actionState.badgeText = text; },
    setBadgeBackgroundColor: async ({ color }) => { actionState.badgeColor = color; },
    setTitle: async ({ title }) => { actionState.title = title; },
    setIcon: async ({ path }) => { if (path.includes("missing")) throw new Error("Could not load icon"); },
    getBadgeText: async () => actionState.badgeText,
    getBadgeBackgroundColor: async () => actionState.badgeColor,
    getTitle: async () => actionState.title,
  },
  commands: {
    getAll: async () => declaredCommands,
  },
};

const tools = () => browserToolset(false);

Deno.test("T1 inventory: the 8 tranche-1 tools ship in the browser toolset; reads join the readOnly subset", () => {
  const all = Object.keys(tools());
  for (const name of ["list_windows", "create_window", "focus_window", "close_window", "move_window", "set_action_state", "get_action_state", "list_commands"]) {
    assert(all.includes(name), `${name} shipped`);
  }
  const scoped = Object.keys(browserToolset(true));
  for (const name of ["list_windows", "get_action_state", "list_commands"]) {
    assert(scoped.includes(name), `${name} is read-only — exposed to scoped runs`);
  }
  for (const name of ["create_window", "focus_window", "close_window", "move_window", "set_action_state"]) {
    assert(!scoped.includes(name), `${name} mutates — NEVER exposed to scoped runs`);
  }
});

Deno.test("T1 schema bounds: hostile/oversized args are rejected before any chrome call", () => {
  const t = tools();
  assertEquals(t.create_window.inputSchema.safeParse({ url: "not-a-url" }).success, false);
  assertEquals(t.create_window.inputSchema.safeParse({ width: 99 }).success, false, "width below the floor rejected");
  assertEquals(t.create_window.inputSchema.safeParse({ url: "https://example.com", width: 800 }).success, true);
  assertEquals(t.move_window.inputSchema.safeParse({ windowId: 1, state: "docked" }).success, false, "state enum bounded");
  assertEquals(t.move_window.inputSchema.safeParse({ windowId: 1.5 }).success, false, "non-integer windowId rejected");
  assertEquals(t.set_action_state.inputSchema.safeParse({ badgeText: "123456789" }).success, false, "badge text bounded");
  assertEquals(t.set_action_state.inputSchema.safeParse({ badgeColor: "red" }).success, false, "colour must be bounded hex");
  assertEquals(t.set_action_state.inputSchema.safeParse({ iconPath: "../secret.png" }).success, false, "traversal rejected");
  assertEquals(t.set_action_state.inputSchema.safeParse({ iconPath: "/abs.png" }).success, false, "absolute path rejected");
  assertEquals(t.set_action_state.inputSchema.safeParse({ iconPath: "https://evil.com/x.png" }).success, false, "remote icon rejected");
  assertEquals(t.set_action_state.inputSchema.safeParse({}).success, false, "at least one field required");
  assertEquals(t.set_action_state.inputSchema.safeParse({ badgeText: "3", iconPath: "icons/a.png" }).success, true);
});

Deno.test("T1 reads need NO permission: windows inventory carries no tab data; action/commands read back", async () => {
  reset();
  granted.clear(); // NO permissions at all — reads must still work
  windows.set(1, { id: 1, focused: true, type: "normal", state: "normal", left: 0, top: 0, width: 800, height: 600 });
  const lw = await tools().list_windows.execute({});
  assertEquals(lw.windows.length, 1);
  assertEquals(Object.keys(lw.windows[0]).sort(), ["focused", "height", "id", "left", "state", "top", "type", "width"], "bounded metadata only — no url/title");
  const ga = await tools().get_action_state.execute({});
  assertEquals(ga, { badgeText: "", title: "", badgeColor: "#00000000" });
  const lc = await tools().list_commands.execute({});
  assertEquals(lc.commands, declaredCommands);
});

Deno.test("T1 create_window: denied without a grant; destination-origin scoped; global required for no-url", async () => {
  reset();
  let r = await tools().create_window.execute({ url: "https://example.com/x" });
  assert(r.error && !r.ok, "no grant → denied");
  assertEquals(windows.size, 0, "no window created");

  await setOriginBrowserControlGrant(["https://example.com"]);
  r = await tools().create_window.execute({ url: "https://other.example/x" });
  assert(r.error, "ungranted destination origin denied under an origins grant");
  r = await tools().create_window.execute({ url: "https://example.com/x", width: 900 });
  assertEquals(r.ok, true, "granted destination origin opens");
  assertEquals(windows.get(r.windowId).width, 900);

  r = await tools().create_window.execute({}); // no url — origin-less scope
  assert(r.error, "no-url window requires a GLOBAL grant, not an origins grant");
  await setGlobalBrowserControlGrant();
  r = await tools().create_window.execute({});
  assertEquals(r.ok, true, "global grant opens a blank window");

  await revokeBrowserControlGrant();
  r = await tools().create_window.execute({ url: "https://example.com/y" });
  assert(r.error, "revoked grant denies a subsequent create");
});

Deno.test("T1 window manage: EVERY tab origin in the window must be granted; empty window needs global", async () => {
  reset();
  windows.set(1, { id: 1, focused: false, type: "normal", state: "normal", left: 0, top: 0, width: 800, height: 600 });
  tabs.push({ id: 1, url: "https://a.example/x", title: "a", windowId: 1 });
  tabs.push({ id: 2, url: "https://b.example/y", title: "b", windowId: 1 });

  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().close_window.execute({ windowId: 1 });
  assert(r.error, "partial origin coverage denies the window mutation");
  assert(windows.has(1), "window NOT closed");

  await setOriginBrowserControlGrant(["https://a.example", "https://b.example"]);
  r = await tools().focus_window.execute({ windowId: 1 });
  assertEquals(r.ok, true, "full origin coverage focuses");
  assertEquals(windows.get(1).focused, true);
  r = await tools().move_window.execute({ windowId: 1, state: "maximized" });
  assertEquals(windows.get(1).state, "maximized");
  r = await tools().close_window.execute({ windowId: 1 });
  assertEquals(r.ok, true);
  assertEquals(windows.size, 0, "closed under full coverage");

  // empty window: origin-less scope → global grant required
  windows.set(2, { id: 2, focused: false, type: "normal", state: "normal", left: 0, top: 0, width: 800, height: 600 });
  r = await tools().focus_window.execute({ windowId: 2 });
  assert(r.error, "empty window denied under an origins grant (no origin to scope to)");
  await setGlobalBrowserControlGrant();
  r = await tools().focus_window.execute({ windowId: 2 });
  assertEquals(r.ok, true, "global grant covers the origin-less window");

  r = await tools().close_window.execute({ windowId: 999 });
  assertEquals(r.error, "no such window");
});

Deno.test("T1 set_action_state: owner-scoped surface applies bounded fields and reports them", async () => {
  reset();
  const r = await tools().set_action_state.execute({ badgeText: "3", badgeColor: "#ff0080", title: "CAP" });
  assertEquals(r, { ok: true, applied: ["badgeText", "badgeColor", "title"] });
  assertEquals(actionState.badgeText, "3");
  assertEquals(actionState.badgeColor, "#ff0080");
  assertEquals(actionState.title, "CAP");
  const back = await tools().get_action_state.execute({});
  assertEquals(back.badgeText, "3");
  const bad = await tools().set_action_state.execute({ iconPath: "icons/missing.png" });
  assert(bad.error, "a failing chrome call surfaces the error, not a silent ok");
});
