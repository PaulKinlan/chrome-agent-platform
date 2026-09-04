// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 7 (sessions +
// history): grant gating, permission-on-demand honesty, confirm-required
// enforcement, http/https URL-scheme validation, bounded outputs, and the
// read-only classification. In-memory chrome shim extended from
// chrome-tools-t1.test.ts with sessions + history surfaces.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import { createLifecycleTracker, runEndCleanupNote } from "../extension/lib/lifecycle-cleanup.js";

// ---- in-memory chrome shim ----
const store = new Map();
const granted = new Set(["storage", "tabs"]);
let recentlyClosed = []; // [{tab:{sessionId,url,title}} | {window:{sessionId,tabs:[{url,title}]}}]
let devices = []; // [{deviceName, sessions:[...]}]
const historyDb = new Map(); // url -> {url,title,visitCount,lastVisitTime,visits:[{visitTime,transition,referringId}]}
const calls = { restore: [], addUrl: [], deleteUrl: [], deleteRange: [], deleteAll: 0 };
let nextRestoredId = 1000; // fresh ids the shim assigns on each restore (Chrome never reuses ids)

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  granted.add("tabs");
  recentlyClosed = [];
  devices = [];
  historyDb.clear();
  calls.restore.length = 0;
  calls.addUrl.length = 0;
  calls.deleteUrl.length = 0;
  calls.deleteRange.length = 0;
  calls.deleteAll = 0;
  nextRestoredId = 1000;
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
  tabs: { query: async () => [], get: async () => { throw new Error("no tab"); }, remove: async () => {} },
  sessions: {
    getRecentlyClosed: async () => recentlyClosed,
    getDevices: async () => devices,
    // Realistic restore: Chrome's sessions.restore resolves with ONE Session
    // object carrying the FRESH ids it assigned — {tab:{id,…}} for a tab
    // restore, {window:{id,tabs:[{id,…}]}} for a window restore (r6 finding
    // 2: the old shim returned [{tab:{sessionId}}], so the tool's id
    // extraction saw nulls and the seam was never exercised).
    restore: async (sessionId) => {
      calls.restore.push(sessionId);
      const entry = recentlyClosed.find((s) => (s?.tab?.sessionId ?? s?.window?.sessionId) === sessionId);
      if (!entry) return { tab: { sessionId } }; // nothing fabricated for an unknown session
      if (entry.tab) {
        const tab = { id: nextRestoredId++, sessionId, ...(entry.tab.url ? { url: entry.tab.url } : {}) };
        if (entry.tab.title) tab.title = entry.tab.title;
        return { tab };
      }
      const window = { id: nextRestoredId++, sessionId, tabs: [] };
      for (const t of Array.isArray(entry.window?.tabs) ? entry.window.tabs : []) {
        const tab = { id: nextRestoredId++, ...(t?.url ? { url: t.url } : {}) };
        if (t?.title) tab.title = t.title;
        window.tabs.push(tab);
      }
      return { window };
    },
  },
  history: {
    search: async (q) => [...historyDb.values()]
      .filter((h) => !q.text || h.url.includes(q.text) || h.title.includes(q.text)),
    getVisits: async ({ url }) => historyDb.get(url)?.visits ?? [],
    addUrl: async ({ url }) => { calls.addUrl.push(url); if (!historyDb.has(url)) historyDb.set(url, { url, title: url, visitCount: 1, lastVisitTime: Date.now(), visits: [] }); },
    deleteUrl: async ({ url }) => { calls.deleteUrl.push(url); historyDb.delete(url); },
    deleteRange: async (r) => { calls.deleteRange.push(r); },
    deleteAll: async () => { calls.deleteAll++; historyDb.clear(); },
  },
};

const tools = () => browserToolset(false);

function seedHistory(urls) {
  for (const url of urls) {
    historyDb.set(url, {
      url, title: `Title for ${url}`, visitCount: 3, lastVisitTime: 1700000000000,
      visits: [{ visitTime: 1700000000000, transition: "link", referringId: 0 }, { visitTime: 1700000001000, transition: "typed", referringId: 1 }],
    });
  }
}

Deno.test("T7 inventory: the 9 tranche-7 tools ship; reads join the readOnly subset, mutations never", () => {
  const all = Object.keys(tools());
  for (const name of ["list_recently_closed", "restore_closed", "list_synced_devices", "search_history", "get_history_visits", "add_history_url", "delete_history_url", "delete_history_range", "clear_all_history"]) {
    assert(all.includes(name), `${name} shipped`);
  }
  const scoped = Object.keys(browserToolset(true));
  for (const name of ["list_recently_closed", "list_synced_devices", "search_history", "get_history_visits"]) {
    assert(scoped.includes(name), `${name} is read-only — exposed to scoped runs`);
  }
  for (const name of ["restore_closed", "add_history_url", "delete_history_url", "delete_history_range", "clear_all_history"]) {
    assert(!scoped.includes(name), `${name} mutates — NEVER exposed to scoped runs`);
  }
});

Deno.test("T7 schema bounds: hostile/oversized args are rejected before any chrome call", () => {
  const t = tools();
  assertEquals(t.restore_closed.inputSchema.safeParse({ sessionId: "" }).success, false, "empty sessionId rejected");
  assertEquals(t.restore_closed.inputSchema.safeParse({ sessionId: "x".repeat(200) }).success, false, "oversized sessionId rejected");
  assertEquals(t.search_history.inputSchema.safeParse({ text: "y".repeat(600) }).success, false, "oversized search text rejected");
  assertEquals(t.search_history.inputSchema.safeParse({ maxResults: 9999 }).success, false, "maxResults above cap rejected");
  assertEquals(t.get_history_visits.inputSchema.safeParse({ url: "not-a-url" }).success, false, "invalid url rejected");
  assertEquals(t.add_history_url.inputSchema.safeParse({ url: "https://a.example/" + "x".repeat(3000) }).success, false, "oversized url rejected");
  assertEquals(t.delete_history_range.inputSchema.safeParse({ startTime: 10, endTime: 5 }).success, false, "endTime<=startTime rejected");
  assertEquals(t.delete_history_range.inputSchema.safeParse({ startTime: 1.5, endTime: 10 }).success, false, "non-integer bound rejected");
  assertEquals(t.delete_history_range.inputSchema.safeParse({ startTime: 5 }).success, false, "both bounds required");
});

Deno.test("T7 sessions reads need NO permission: recently-closed + synced devices render bounded metadata", async () => {
  reset();
  granted.clear(); // NO permissions at all — sessions reads must still work
  recentlyClosed = [
    { tab: { sessionId: "s-tab-1", url: "https://a.example/x", title: "A" }, lastModified: 1700000001 },
    { window: { sessionId: "s-win-1", tabs: [{ url: "https://b.example/y", title: "B" }, { url: "https://c.example/z", title: "C" }] }, lastModified: 1700000002 },
  ];
  const rc = await tools().list_recently_closed.execute({});
  assertEquals(rc.total, 2);
  assertEquals(rc.closed[0], { kind: "tab", sessionId: "s-tab-1", url: "https://a.example/x", title: "A", lastModified: 1700000001 });
  assertEquals(rc.closed[1].kind, "window");
  assertEquals(rc.closed[1].tabCount, 2);

  // empty device list → honest note, not a throw
  const dv = await tools().list_synced_devices.execute({});
  assertEquals(dv.devices, []);
  assert(dv.note && dv.note.includes("no synced devices"));

  devices = [{ deviceName: "Pixel", sessions: [{ tab: { sessionId: "s-d", url: "https://d.example/" }, lastModified: 1700000003 }] }];
  const dv2 = await tools().list_synced_devices.execute({});
  assertEquals(dv2.devices.length, 1);
  assertEquals(dv2.devices[0].deviceName, "Pixel");
  assertEquals(dv2.devices[0].sessions[0].url, "https://d.example/");
});

Deno.test("T7 restore_closed: denied without a grant; scoped to the restored origin; window restore needs every origin; honest when nothing to restore", async () => {
  reset();
  recentlyClosed = [{ tab: { sessionId: "s-1", url: "https://a.example/x", title: "A" } }];
  let r = await tools().restore_closed.execute({ sessionId: "s-1" });
  assert(r.error && !r.ok, "no grant → denied");
  assertEquals(calls.restore.length, 0, "nothing restored");

  await setOriginBrowserControlGrant(["https://other.example"]);
  r = await tools().restore_closed.execute({ sessionId: "s-1" });
  assert(r.error, "ungranted restored origin denied under an origins grant");
  assertEquals(calls.restore.length, 0);

  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().restore_closed.execute({ sessionId: "s-1" });
  assertEquals(r.ok, true, "granted origin restores");
  assertEquals(calls.restore, ["s-1"]);
  // The shim Session carries the FRESH id Chrome assigns — the tool's id
  // extraction must read it (r6 finding 2: the old shim returned
  // [{tab:{sessionId}}], so these were nulls and the seam went untested).
  assertEquals(r.kind, "tab");
  assert(Number.isInteger(r.restoredTabId) && r.restoredTabId > 0, "restored tab id comes from the shim Session");
  assertEquals(r.restoredWindowId, null, "a tab restore has no window id");
  assertEquals(r.restoredWindowTabIds, [], "a tab restore has no window tab ids");

  // window restore: EVERY tab origin must be covered
  recentlyClosed = [{ window: { sessionId: "s-w", tabs: [{ url: "https://a.example/x" }, { url: "https://b.example/y" }] } }];
  r = await tools().restore_closed.execute({ sessionId: "s-w" });
  assert(r.error, "partial origin coverage denies the window restore");
  await setOriginBrowserControlGrant(["https://a.example", "https://b.example"]);
  r = await tools().restore_closed.execute({ sessionId: "s-w" });
  assertEquals(r.ok, true, "full origin coverage restores the window");
  assertEquals(r.kind, "window");
  assert(Number.isInteger(r.restoredWindowId) && r.restoredWindowId > 0, "restored window id comes from the shim Session");
  assertEquals(r.restoredWindowTabIds.length, 2, "the restored window's tab ids come from the shim Session");
  assert(r.restoredWindowTabIds.every((id) => Number.isInteger(id) && id > 0), "every restored window tab id is real");

  // nothing to restore
  recentlyClosed = [];
  await setGlobalBrowserControlGrant();
  r = await tools().restore_closed.execute({ sessionId: "s-missing" });
  assert(r.error && r.error.includes("nothing to restore"), "honest error when the session is gone");

  await revokeBrowserControlGrant();
  recentlyClosed = [{ tab: { sessionId: "s-2", url: "https://a.example/y" } }];
  r = await tools().restore_closed.execute({ sessionId: "s-2" });
  assert(r.error, "revoked grant denies a subsequent restore");
});

Deno.test("T7 restore_closed mixed-set gap (B1): ANY origin-less entry (chrome://, data:) forces a GLOBAL grant — a scoped grant is REFUSED", async () => {
  reset();
  // WINDOW shape: mixed set [covered https entry, chrome:// privileged entry].
  recentlyClosed = [{ window: { sessionId: "s-mixed-win", tabs: [{ url: "https://a.example/x" }, { url: "chrome://extensions" }] } }];
  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().restore_closed.execute({ sessionId: "s-mixed-win" });
  assert(r.error && !r.ok, "mixed window (https + chrome://) REFUSED under a scoped grant covering only the https origin");
  assertEquals(calls.restore.length, 0, "the chrome:// privileged page did NOT smuggle past the scoped grant");
  await setGlobalBrowserControlGrant();
  r = await tools().restore_closed.execute({ sessionId: "s-mixed-win" });
  assertEquals(r.ok, true, "the same mixed window is ALLOWED under a global grant");
  assertEquals(calls.restore, ["s-mixed-win"]);

  // TAB shape: a single origin-less tab (data: attacker markup).
  calls.restore.length = 0;
  recentlyClosed = [{ tab: { sessionId: "s-mixed-tab", url: "data:text/html,<script>alert(1)</script>" } }];
  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().restore_closed.execute({ sessionId: "s-mixed-tab" });
  assert(r.error && !r.ok, "origin-less tab (data:) REFUSED under a scoped grant");
  assertEquals(calls.restore.length, 0);
  await setGlobalBrowserControlGrant();
  r = await tools().restore_closed.execute({ sessionId: "s-mixed-tab" });
  assertEquals(r.ok, true, "origin-less tab ALLOWED under a global grant");
  assertEquals(calls.restore, ["s-mixed-tab"]);

  // TAB shape: a single chrome:// tab under an origins grant must be refused.
  calls.restore.length = 0;
  recentlyClosed = [{ tab: { sessionId: "s-chrome-tab", url: "chrome://settings" } }];
  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().restore_closed.execute({ sessionId: "s-chrome-tab" });
  assert(r.error && !r.ok, "single chrome:// tab REFUSED under a scoped grant");
  assertEquals(calls.restore.length, 0);
});

Deno.test("T7 restore_closed output seam (r6 finding 2): the tool's REAL result payload — ids decoded from the shim Session — is what feeds the lifecycle tracker", async () => {
  reset();
  await setGlobalBrowserControlGrant();
  recentlyClosed = [
    { tab: { sessionId: "s-seam-tab", url: "https://a.example/x", title: "A" }, lastModified: 1700000001 },
    { window: { sessionId: "s-seam-win", tabs: [{ url: "https://a.example/x", title: "A" }, { url: "https://b.example/y", title: "B" }] }, lastModified: 1700000002 },
  ];
  const rt = await tools().restore_closed.execute({ sessionId: "s-seam-tab" });
  const rw = await tools().restore_closed.execute({ sessionId: "s-seam-win" });
  assertEquals(rt.kind, "tab");
  assert(Number.isInteger(rt.restoredTabId) && rt.restoredTabId > 0, "execute() decoded the tab id the shim Session carries");
  assertEquals(rw.kind, "window");
  assert(Number.isInteger(rw.restoredWindowId) && rw.restoredWindowId > 0, "execute() decoded the window id the shim Session carries");
  assertEquals(rw.restoredWindowTabIds.length, 2, "execute() decoded the window's tab ids");

  // The tracker consumes THESE payloads (no hand-fabricated restore object):
  // ids must arrive under the real names restore_closed returns.
  const t = createLifecycleTracker();
  t.onToolResult("restore_closed", true, JSON.stringify(rt));
  t.onToolResult("restore_closed", true, JSON.stringify(rw));
  let s = t.snapshot();
  assertEquals(s.restoredTabIds.slice().sort((a, b) => a - b),
    [rt.restoredTabId, ...rw.restoredWindowTabIds].sort((a, b) => a - b),
    "the tracker saw every id the tool reported (single tab + the window's tabs)");
  assertEquals(s.restoredWindowIds, [rw.restoredWindowId], "the tracker saw the restored window id");

  // Closing the restored window through the SAME payload shapes drops its
  // child tab ids — the run-end note must never claim them open after
  // close_window (r6 finding 1, end to end over real result shapes).
  t.onToolResult("close_window", true, JSON.stringify({ ok: true, windowId: rw.restoredWindowId, closed: true }));
  s = t.snapshot();
  assertEquals(s.restoredWindowIds, [], "close_window released the restored window");
  assertEquals(s.restoredTabIds, [rt.restoredTabId], "closing the restored window dropped its tabs; the separately restored tab stays");
  t.onToolResult("close_tab", true, JSON.stringify({ ok: true, tabId: rt.restoredTabId, closed: true }));
  assertEquals(runEndCleanupNote(t.snapshot()), null, "nothing restored and left open → no note");
});

Deno.test("T7 history reads require the history permission and fail closed without it", async () => {
  reset();
  seedHistory(["https://a.example/x", "https://b.example/y"]);
  let r = await tools().search_history.execute({ text: "example" });
  assert(r.error && r.error.includes("history permission"), "no history permission → honest denial");
  r = await tools().get_history_visits.execute({ url: "https://a.example/x" });
  assert(r.error && r.error.includes("history permission"));

  granted.add("history");
  const s = await tools().search_history.execute({ text: "example", maxResults: 10 });
  assertEquals(s.total, 2);
  assertEquals(Object.keys(s.history[0]).sort(), ["lastVisitTime", "title", "url", "visitCount"], "bounded metadata only");
  const v = await tools().get_history_visits.execute({ url: "https://a.example/x" });
  assertEquals(v.total, 2);
  assertEquals(v.visits[0].transition, "link");
});

Deno.test("T7 history reads are bounded: oversized result sets are truncated with an honest total", async () => {
  reset();
  granted.add("history");
  seedHistory(Array.from({ length: 60 }, (_, i) => `https://big.example/${i}`));
  const s = await tools().search_history.execute({ text: "big.example", maxResults: 5 });
  assertEquals(s.history.length, 5, "sliced to the requested cap");
  assertEquals(s.total, 60, "honest unbounded total");
  const s2 = await tools().search_history.execute({ text: "big.example" }); // default maxResults 50
  assertEquals(s2.history.length, 50);
});

Deno.test("T7 add_history_url: http/https only + destination-origin grant gated", async () => {
  reset();
  granted.add("history");
  let r = await tools().add_history_url.execute({ url: "file:///etc/passwd" });
  assert(r.error && r.error.includes("http/https"), "file:// rejected");
  r = await tools().add_history_url.execute({ url: "chrome://settings" });
  assert(r.error && r.error.includes("http/https"), "chrome:// rejected");
  assertEquals(calls.addUrl.length, 0);

  r = await tools().add_history_url.execute({ url: "https://a.example/x" });
  assert(r.error, "no grant → denied");
  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().add_history_url.execute({ url: "https://other.example/x" });
  assert(r.error, "ungranted origin denied");
  r = await tools().add_history_url.execute({ url: "https://a.example/x" });
  assertEquals(r.ok, true, "granted origin adds");
  assertEquals(calls.addUrl, ["https://a.example/x"]);
});

Deno.test("T7 delete_history_url: http/https only + destination-origin grant gated", async () => {
  reset();
  granted.add("history");
  seedHistory(["https://a.example/x"]);
  let r = await tools().delete_history_url.execute({ url: "data:text/html,hi" });
  assert(r.error && r.error.includes("http/https"), "data: rejected");
  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().delete_history_url.execute({ url: "https://a.example/x" });
  assertEquals(r.ok, true);
  assertEquals(calls.deleteUrl, ["https://a.example/x"]);
});

Deno.test("T7 delete_history_range: bounded + GLOBAL grant required", async () => {
  reset();
  granted.add("history");
  await setOriginBrowserControlGrant(["https://a.example"]);
  let r = await tools().delete_history_range.execute({ startTime: 1, endTime: 100 });
  assert(r.error && r.error.includes("GLOBAL"), "an origins grant is not enough for a range wipe");
  assertEquals(calls.deleteRange.length, 0);
  await setGlobalBrowserControlGrant();
  r = await tools().delete_history_range.execute({ startTime: 1, endTime: 100 });
  assertEquals(r.ok, true);
  assertEquals(calls.deleteRange, [{ startTime: 1, endTime: 100 }]);
});

Deno.test("T7 clear_all_history: refuses without confirm:true, needs GLOBAL grant, then clears", async () => {
  reset();
  granted.add("history");
  seedHistory(["https://a.example/x"]);
  await setGlobalBrowserControlGrant();
  let r = await tools().clear_all_history.execute({});
  assert(r.error && r.error.includes("confirm"), "refuses without confirm:true");
  assertEquals(calls.deleteAll, 0);
  r = await tools().clear_all_history.execute({ confirm: false });
  assert(r.error && r.error.includes("confirm"), "confirm:false is not confirmation");
  assertEquals(calls.deleteAll, 0);
  r = await tools().clear_all_history.execute({ confirm: true });
  assertEquals(r.ok, true);
  assertEquals(calls.deleteAll, 1);
  assertEquals(historyDb.size, 0);

  // an origins grant is not enough even with confirm
  calls.deleteAll = 0;
  await setOriginBrowserControlGrant(["https://a.example"]);
  r = await tools().clear_all_history.execute({ confirm: true });
  assert(r.error && r.error.includes("GLOBAL"), "clear-all still requires a GLOBAL grant");
  assertEquals(calls.deleteAll, 0);
});
