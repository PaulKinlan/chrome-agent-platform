// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranches 3+4 (tabGroups +
// downloads): schema bounds, grant/permission gates, URL-scheme denial,
// bounded outputs, permission-request flow.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { CAPABILITIES } from "../extension/lib/capabilities.js";
import {
  BROWSER_TOOL_NAMES,
  CHROME_TOOL_CAPABILITY_BOUNDS,
} from "../extension/lib/chrome-tool-capabilities.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim ----
const store = new Map();
const granted = new Set(["storage", "tabs", "downloads"]);
const tabs = []; // { id, url, title, windowId, groupId? }
const tabGroups = new Map(); // id -> { id, title, color, collapsed, windowId, tabIds: [] }
const downloads = new Map(); // id -> { id, url, filename, state, mime, bytesReceived, totalBytes, startTime }
let nextTabId = 1;
let nextGroupId = 1;
let nextDownloadId = 1;

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  granted.add("tabs");
  granted.add("downloads");
  tabs.length = 0;
  tabGroups.clear();
  downloads.clear();
  nextTabId = 1;
  nextGroupId = 1;
  nextDownloadId = 1;
  clearRunFence();
}

function addTab(url, windowId = 1) {
  const tab = { id: nextTabId++, url, title: url, windowId };
  tabs.push(tab);
  return tab;
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
    get: async (id) => tabs.find((t) => t.id === id) ?? null,
  },
  tabGroups: {
    query: async (q) => [...tabGroups.values()].filter((g) => !q?.windowId || g.windowId === q.windowId),
    get: async (id) => tabGroups.get(id) ?? null,
    group: async ({ tabIds, title, color }) => {
      const group = { id: nextGroupId++, title: title ?? "", color: color ?? "grey", collapsed: false, windowId: 1, tabIds };
      for (const t of tabIds) {
        const tab = tabs.find((x) => x.id === t);
        if (tab) tab.groupId = group.id;
      }
      tabGroups.set(group.id, group);
      return group;
    },
    update: async (id, props) => {
      const group = tabGroups.get(id);
      if (!group) throw new Error("no group");
      Object.assign(group, props);
      return group;
    },
    ungroup: async (tabIds) => {
      for (const id of tabIds) {
        const tab = tabs.find((t) => t.id === id);
        if (tab) {
          const g = tabGroups.get(tab.groupId);
          if (g) g.tabIds = g.tabIds.filter((x) => x !== id);
          delete tab.groupId;
        }
      }
      return [];
    },
    move: async (tabIds, groupId) => {
      const group = tabGroups.get(groupId);
      if (!group) throw new Error("no group");
      for (const id of tabIds) {
        const tab = tabs.find((t) => t.id === id);
        if (tab) tab.groupId = groupId;
        if (!group.tabIds.includes(id)) group.tabIds.push(id);
      }
      return group;
    },
  },
  downloads: {
    download: async ({ url, filename, saveAs }) => {
      const id = nextDownloadId++;
      downloads.set(id, { id, url, filename: filename ?? url.split("/").pop(), state: "in_progress", mime: "application/octet-stream", bytesReceived: 0, totalBytes: 0, startTime: Date.now(), saveAs });
      return id;
    },
    search: async (q) => {
      let items = [...downloads.values()];
      if (q?.query) items = items.filter((d) => (d.filename ?? "").includes(q.query));
      if (q?.state) items = items.filter((d) => d.state === q.state);
      return items;
    },
    pause: async (id) => { const d = downloads.get(id); if (d) d.state = "interrupted"; },
    resume: async (id) => { const d = downloads.get(id); if (d) d.state = "in_progress"; },
    cancel: async (id) => { const d = downloads.get(id); if (d) d.state = "interrupted"; },
    erase: async ({ id }) => { for (const i of id ?? []) downloads.delete(i); },
    show: async () => {},
    open: async () => {},
    removeFile: async (id) => { const d = downloads.get(id); if (d) d.fileRemoved = true; },
  },
};

function tools() {
  return browserToolset(false);
}

// ──────────────────────────────────────────────────────────────────────────
// Registry parity: the T3/T4 tools are appended to the toolset AND recorded.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T3/T4: browserToolset has exactly 94 tools matching BROWSER_TOOL_NAMES (T1/T2 + T8 + T13 + T5/T6 + T7 + T11 + 14)", () => {
  reset();
  const browser = tools();
  assertEquals(Object.keys(browser), BROWSER_TOOL_NAMES);
  assertEquals(BROWSER_TOOL_NAMES.length, 94);
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS.browserTools, 94);
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS.totalTools, 123);
  for (const name of ["list_tab_groups", "group_tabs", "update_tab_group", "ungroup_tabs", "move_tab_to_group", "download_file", "list_downloads", "pause_download", "resume_download", "cancel_download", "erase_download", "show_download", "open_download", "remove_download_file"]) {
    assert(name in browser, `${name} present`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// T3 tabGroups: reads light, mutations grant-gated (tab-origin discipline).
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T3 list_tab_groups: read-only, no permission/grant needed, bounded", async () => {
  reset();
  granted.delete("tabs"); // tabGroups itself needs NO permission
  addTab("https://a.example/1");
  const group = { id: 7, title: "Sorting hat", color: "blue", collapsed: false, windowId: 1, tabIds: [1] };
  tabGroups.set(7, group);
  const r = await tools().list_tab_groups.execute({});
  assertEquals(r.tabGroups, [{ id: 7, title: "Sorting hat", color: "blue", collapsed: false, windowId: 1 }]);
});

Deno.test("T3 group_tabs: denied without a grant; tab-origin scoped; global for origin-less tabs", async () => {
  reset();
  addTab("https://a.example/x");
  addTab("https://b.example/y");
  let r = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assert(r.error && !r.ok, "no grant → denied");
  assertEquals(tabGroups.size, 0, "no group created");

  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assert(r.error, "partial origin coverage denies the group");
  assertEquals(tabGroups.size, 0);

  await setOriginBrowserControlGrant(["https://a.example", "https://b.example"]);
  r = await tools().group_tabs.execute({ tabIds: [1, 2], title: "Sorting hat", color: "blue" });
  assertEquals(r.ok, true, "full coverage groups");
  assertEquals(tabGroups.get(r.groupId).title, "Sorting hat");
  assertEquals(tabGroups.get(r.groupId).color, "blue");
  assertEquals(tabs.find((t) => t.id === 1).groupId, r.groupId);

  // a missing tab id fails closed
  r = await tools().group_tabs.execute({ tabIds: [1, 999] });
  assert(r.error, "no such tab");
});

Deno.test("T3 group_tabs: a tab with NO origin (chrome:///newtab) needs the GLOBAL grant", async () => {
  reset();
  addTab("chrome://newtab/");
  let r = await tools().group_tabs.execute({ tabIds: [1] });
  assert(r.error, "origin-less tab denied without ANY grant");
  await setOriginBrowserControlGrant(["https://example.com"]);
  r = await tools().group_tabs.execute({ tabIds: [1] });
  assert(r.error, "origin-less tab still denied under an ORIGINS grant");
  await setGlobalBrowserControlGrant();
  r = await tools().group_tabs.execute({ tabIds: [1] });
  assertEquals(r.ok, true, "global grant groups the origin-less tab");
});

Deno.test("T3 update_tab_group: grant must cover the group's tab origins; revoke denies", async () => {
  reset();
  addTab("https://a.example/x");
  addTab("https://b.example/y");
  await setOriginBrowserControlGrant(["https://a.example", "https://b.example"]);
  const g = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assertEquals(g.ok, true);

  let r = await tools().update_tab_group.execute({ groupId: g.groupId, collapsed: true });
  assertEquals(r.ok, true, "covered group updates");
  assertEquals(tabGroups.get(g.groupId).collapsed, true);

  await revokeBrowserControlGrant();
  r = await tools().update_tab_group.execute({ groupId: g.groupId, color: "red" });
  assert(r.error, "revoked grant denies the update");
});

Deno.test("T3 ungroup_tabs + move_tab_to_group: grant-gated + bounded tabIds array", async () => {
  reset();
  addTab("https://a.example/x");
  addTab("https://b.example/y");
  await setGlobalBrowserControlGrant();
  const g = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assertEquals(g.ok, true);
  assertEquals(tabGroups.size, 1);

  let r = await tools().ungroup_tabs.execute({ tabIds: [1] });
  assertEquals(r.ok, true, "ungroup granted");
  assertEquals(tabs.find((t) => t.id === 1).groupId, undefined);

  // a 17-element tabIds array is rejected by the schema
  const tooMany = Array.from({ length: 17 }, (_, i) => i + 1);
  r = await tools().move_tab_to_group.execute({ tabIds: tooMany, groupId: g.groupId });
  assert(!r.ok && r.error, "17 tabIds rejected");

  r = await tools().move_tab_to_group.execute({ tabIds: [1, 2], groupId: g.groupId });
  assertEquals(r.ok, true, "move granted");
  assertEquals(tabGroups.get(g.groupId).tabIds.sort(), [1, 2]);
});

// ──────────────────────────────────────────────────────────────────────────
// T4 downloads: URL-scheme denial, global-grant gating, bounded output.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T4 download_file: ONLY http/https — file/chrome/extension/data/ftp refused", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const t = tools();
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "chrome-extension://abcdefgh/ijklmnop",
    "data:text/plain,hello",
    "ftp://example.com/x",
    "blob:https://example.com/uuid",
    "not a url",
  ]) {
    const r = await t.download_file.execute({ url });
    assert(r.error && String(r.error).includes("http/https"), `${url} refused`);
    assertEquals(downloads.size, 0, "no download for the refused scheme");
  }
  const r = await t.download_file.execute({ url: "https://example.com/file.pdf" });
  assertEquals(r.ok, true, "https accepted");
  assertEquals(downloads.get(r.downloadId).saveAs, false, "saveAs never auto-true");
});

Deno.test("T4 download_file: filename sanitized (no traversal/backslash/control) + bounded", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  const t = tools();
  const r = await t.download_file.execute({
    url: "https://example.com/a.pdf",
    filename: "../../etc/passwd\\..\\..\\evil.txt\u0000x",
  });
  assertEquals(r.ok, true);
  const stored = downloads.get(r.downloadId);
  assert(!stored.filename.includes(".."), "traversal stripped");
  assert(!stored.filename.includes("\\"), "backslashes folded");
  assert(!stored.filename.includes("\u0000"), "NUL removed");
  // the sanitized result is a bounded relative path
  assert(stored.filename.length > 0 && stored.filename.length <= 256);
  // an all-traversal filename is rejected
  const r2 = await t.download_file.execute({ url: "https://example.com/b.pdf", filename: "../../../" });
  assertEquals(r2.error, "invalid filename");
});

Deno.test("T4 download mutations: denied without the GLOBAL grant (an origins grant is never enough)", async () => {
  reset();
  const id = await chrome.downloads.download({ url: "https://example.com/f" });
  const t = tools();
  const ops = [
    () => t.pause_download.execute({ downloadId: id }),
    () => t.resume_download.execute({ downloadId: id }),
    () => t.cancel_download.execute({ downloadId: id }),
    () => t.erase_download.execute({ ids: [id] }),
    () => t.show_download.execute({ downloadId: id }),
    () => t.open_download.execute({ downloadId: id }),
    () => t.remove_download_file.execute({ downloadId: id }),
  ];
  for (const op of ops) {
    const r = await op();
    assert(r.error && !r.ok, "no grant → denied");
  }
  assertEquals(downloads.size, 1, "nothing mutated");

  await setOriginBrowserControlGrant(["https://example.com"]);
  const r = await t.pause_download.execute({ downloadId: id });
  assert(r.error, "an ORIGINS grant must NOT authorize a browser-wide downloads mutation");

  await setGlobalBrowserControlGrant();
  assertEquals((await t.pause_download.execute({ downloadId: id })).ok, true);
  assertEquals(downloads.get(id).state, "interrupted");
  assertEquals((await t.resume_download.execute({ downloadId: id })).ok, true);
  assertEquals((await t.cancel_download.execute({ downloadId: id })).ok, true);
  assertEquals((await t.erase_download.execute({ ids: [id] })).ok, true);
  assertEquals(downloads.has(id), false, "erased");
});

Deno.test("T4 open_download (owner-overridden Phase-1 exclusion): hard grant-gated", async () => {
  reset();
  const id = await chrome.downloads.download({ url: "https://example.com/f" });
  const t = tools();
  let r = await t.open_download.execute({ downloadId: id });
  assert(r.error, "open_download denied without the grant");
  await setOriginBrowserControlGrant(["https://example.com"]);
  r = await t.open_download.execute({ downloadId: id });
  assert(r.error, "open_download denied under an origins grant");
  await setGlobalBrowserControlGrant();
  r = await t.open_download.execute({ downloadId: id });
  assertEquals(r.ok, true, "open_download granted under the GLOBAL grant");
});

Deno.test("T4 list_downloads: bounded + permission-gated; read-only exposure", async () => {
  reset();
  await chrome.downloads.download({ url: "https://example.com/a" });
  await chrome.downloads.download({ url: "https://example.com/b" });
  const r = await tools().list_downloads.execute({ limit: 10 });
  assertEquals(r.downloads.length, 2);
  assertEquals(Object.keys(r.downloads[0]).sort(), ["bytesReceived", "filename", "id", "mime", "state", "totalBytes", "url"].sort());

  granted.delete("downloads");
  const denied = await tools().list_downloads.execute({});
  assertEquals(denied.error, "downloads permission not granted — enable Downloads in Settings");
});

// ──────────────────────────────────────────────────────────────────────────
// Permission-request flow: the Settings capability row requests the exact
// named permission (never silently broadened).
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T4: the Downloads capability row requests exactly [\"downloads\"]", () => {
  const cap = CAPABILITIES.find((c) => c.id === "downloads");
  assert(cap, "downloads capability row exists");
  assertEquals(cap.permissions, ["downloads"]);
  assert(!cap.permissions.includes("tabs"), "no extra permission");
});

// ──────────────────────────────────────────────────────────────────────────
// REVISE round (review finding 1): a MIXED set (covered https tab + an
// origin-less chrome:// tab) must NOT be authorized by a per-origin grant —
// ANY origin-less tab forces the GLOBAL grant.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("REVISE: mixed tab set [https://a.example, chrome://settings] — origin grant REFUSED, global ALLOWED (group/ungroup/move)", async () => {
  reset();
  addTab("https://a.example/x");
  addTab("chrome://settings/");
  const t = tools();

  // per-origin grant covering ONLY the https tab
  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await t.group_tabs.execute({ tabIds: [1, 2] });
  assert(r.error, "mixed set denied under an origins grant (the chrome:// tab must force global)");
  assertEquals(tabGroups.size, 0, "no group created");
  r = await t.ungroup_tabs.execute({ tabIds: [1, 2] });
  assert(r.error, "mixed ungroup denied under an origins grant");
  r = await t.move_tab_to_group.execute({ tabIds: [1, 2], groupId: 99 });
  assert(r.error, "mixed move denied under an origins grant");

  // global grant authorizes the SAME mixed set
  await setGlobalBrowserControlGrant();
  r = await t.group_tabs.execute({ tabIds: [1, 2] });
  assertEquals(r.ok, true, "mixed set grouped under the GLOBAL grant");
  assertEquals(tabGroups.get(r.groupId).tabIds.sort(), [1, 2]);
});

Deno.test("REVISE: update_tab_group with an origin-less tab in the group — origin grant REFUSED, global ALLOWED", async () => {
  reset();
  addTab("https://a.example/x");
  addTab("chrome://settings/");
  await setGlobalBrowserControlGrant();
  const g = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assertEquals(g.ok, true, "mixed group created under global");
  assertEquals(tabGroups.get(g.groupId).tabIds.sort(), [1, 2]);

  // an origins grant that covers ONLY the https tab must NOT authorize the update
  await revokeBrowserControlGrant();
  await setOriginBrowserControlGrant(["https://a.example"]);
  const r = await tools().update_tab_group.execute({ groupId: g.groupId, color: "red" });
  assert(r.error, "the group contains an origin-less tab — an origins grant is REFUSED");

  await setGlobalBrowserControlGrant();
  const ok = await tools().update_tab_group.execute({ groupId: g.groupId, color: "red" });
  assertEquals(ok.ok, true, "global grant authorizes the group update");
  assertEquals(tabGroups.get(g.groupId).color, "red");
});
