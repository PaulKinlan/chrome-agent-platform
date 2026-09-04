// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranches 5+6 (system/topSites/
// permissions-read + readingList/pageCapture), implemented 2026-08-25: honest
// permission-denied paths, http/https-only reading-list urls, the MHTML consent
// chain (run-owned → origin → exact-host → grant) + the hard byte cap.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence, setRunFence } from "../extension/lib/run-fence.js";

const store = new Map();
const granted = new Set(["storage", "tabs"]);
const grantedOrigins = new Set();
const readingList = new Map(); // url -> entry
const tabs = [{ id: 7, url: "https://example.com/page", title: "Example", windowId: 1 }];
let mhtmlSize = 128;

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  granted.add("tabs");
  grantedOrigins.clear();
  readingList.clear();
  mhtmlSize = 128;
  clearRunFence();
}

globalThis.chrome = {
  permissions: {
    contains: async ({ permissions, origins }) => {
      if (permissions) return permissions.every((p) => granted.has(p));
      if (origins) return origins.every((o) => grantedOrigins.has(o));
      return false;
    },
    getAll: async () => ({ permissions: [...granted], origins: [...grantedOrigins] }),
  },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) { if (v === undefined) store.delete(k); else store.set(k, v); } },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
  system: {
    memory: { getInfo: async () => ({ capacity: 16 * 1024 ** 3, availableCapacity: 8 * 1024 ** 3 }) },
    cpu: { getInfo: async () => ({ modelName: "TestCPU", archName: "x86_64", numOfProcessors: 2, processors: [{ usage: { user: 1, kernel: 2, idle: 3, total: 6 } }, { usage: { user: 4, kernel: 5, idle: 6, total: 15 } }] }) },
    storage: { getInfo: async () => ([{ id: "sda1", name: "Main", type: "fixed", capacity: 512 * 1024 ** 3 }]) },
    display: { getInfo: async () => ([{ id: "d1", name: "Built-in", isPrimary: true, isEnabled: true, modes: [{ width: 1920, height: 1080, isNative: true }], bounds: { left: 0, top: 0, width: 1920, height: 1080 } }]) },
  },
  topSites: { get: async () => ([{ url: "https://a.example/", title: "A" }, { url: "https://b.example/", title: "B" }]) },
  readingList: {
    addEntry: async ({ url, title, hasBeenRead }) => { readingList.set(url, { url, title, hasBeenRead, creationTime: 1, lastUpdateTime: 1 }); },
    query: async (q) => [...readingList.values()].filter((e) =>
      (q.url === undefined || e.url === q.url) &&
      (q.title === undefined || e.title === q.title) &&
      (q.hasBeenRead === undefined || e.hasBeenRead === q.hasBeenRead)),
    updateEntry: async ({ url, title, hasBeenRead }) => { const e = readingList.get(url); if (e) { if (title !== undefined) e.title = title; if (hasBeenRead !== undefined) e.hasBeenRead = hasBeenRead; } },
    removeEntry: async ({ url }) => { readingList.delete(url); },
  },
  pageCapture: {
    // Mirrors the REAL pageCapture API (authoritative page_capture.json):
    // saveAsMHTML(details) REQUIRES details.tabId (integer >= 0). Wrong shapes
    // THROW so a test can never mirror a wrong API again.
    saveAsMHTML: async (details) => {
      if (!details || !Number.isInteger(details.tabId) || details.tabId < 0) {
        throw new Error("pageCapture.saveAsMHTML requires details.tabId (integer >= 0)");
      }
      return { size: mhtmlSize, text: async () => "M".repeat(mhtmlSize) };
    },
  },
  tabs: {
    get: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error("no tab")),
    query: async () => tabs.filter((t) => t.id === 7),
  },
};

const tools = () => browserToolset();

Deno.test("T5: system/topSites tools return bounded data when permitted, honest errors when denied", async () => {
  reset();
  // Denied first: every T5 surface fails HONEST (no grant, no silent request).
  assert((await tools().get_system_memory.execute({})).error.includes("system.memory permission not granted"));
  assert((await tools().get_system_cpu.execute({})).error.includes("system.cpu permission not granted"));
  assert((await tools().get_system_storage.execute({})).error.includes("system.storage permission not granted"));
  assert((await tools().get_system_display.execute({})).error.includes("system.display permission not granted"));
  assert((await tools().list_top_sites.execute({})).error.includes("topSites permission not granted"));
  // Granted: bounded data flows.
  for (const p of ["system.memory", "system.cpu", "system.storage", "system.display", "topSites"]) granted.add(p);
  const mem = await tools().get_system_memory.execute({});
  assertEquals(mem.capacityBytes, 16 * 1024 ** 3);
  const cpu = await tools().get_system_cpu.execute({});
  assertEquals(cpu.numOfProcessors, 2);
  assertEquals(cpu.processors.length, 2);
  const stor = await tools().get_system_storage.execute({});
  assertEquals(stor.storageUnits[0].name, "Main");
  const disp = await tools().get_system_display.execute({});
  assertEquals(disp.displays[0].isPrimary, true);
  assertEquals(disp.displays[0].bounds.width, 1920);
  const top = await tools().list_top_sites.execute({ maxResults: 1 });
  assertEquals(top.topSites.length, 1, "maxResults bounds the list");
});

Deno.test("T5: list_granted_permissions is a read-only inventory needing NO optional permission", async () => {
  reset();
  const inv = await tools().list_granted_permissions.execute({});
  assertEquals(inv.permissions.sort(), ["storage", "tabs"]);
  assertEquals(inv.origins, []);
  granted.add("readingList");
  grantedOrigins.add("https://example.com/*");
  const inv2 = await tools().list_granted_permissions.execute({});
  assert(inv2.permissions.includes("readingList"));
  assertEquals(inv2.origins, ["https://example.com/*"]);
});

Deno.test("T6: readingList CRUD flows with http/https-only validation + honest permission errors", async () => {
  reset();
  // Denied: honest error before anything else.
  assert((await tools().add_reading_list_entry.execute({ url: "https://a.example/x", title: "A" })).error.includes("readingList permission not granted"));
  assert((await tools().query_reading_list.execute({})).error.includes("readingList permission not granted"));
  granted.add("readingList");
  // URL validation: chrome://, file://, javascript:, and garbage are refused BEFORE the API.
  // N1 (review): case / whitespace / embedded tab+newline / nested-scheme probes.
  // The WHATWG parser lowercases schemes and strips tabs/newlines — so padded
  // or upper-cased http(s) urls are GENUINELY https after parsing (not
  // bypasses) and must be ACCEPTED; anything parsing to a non-http(s) protocol
  // (or unparseable) must be REFUSED.
  for (const bad of ["chrome://extensions", "file:///etc/passwd", "javascript:alert(1)", "not a url",
    "http:javascript:alert(1)", "view-source:https://a.example/", "data:text/html,x"]) {
    const r = await tools().add_reading_list_entry.execute({ url: bad, title: "x" });
    assert(r.error.includes("http/https"), `refused ${bad}`);
    const u = await tools().update_reading_list_entry.execute({ url: bad, hasBeenRead: true });
    assert(u.error.includes("http/https"), `update refused ${bad}`);
    const d = await tools().remove_reading_list_entry.execute({ url: bad });
    assert(d.error.includes("http/https"), `remove refused ${bad}`);
  }
  assertEquals(readingList.size, 0, "no refused url reached the API");
  // Normalized-but-genuine https urls are accepted (no false rejection).
  for (const ok of ["HTTPS://upper.example/x", "\thttps://tabbed.example/x\n", "https://a.example/\nstill-https-path"]) {
    const r = await tools().add_reading_list_entry.execute({ url: ok, title: "x" });
    assertEquals(r.ok, true, `normalized https accepted: ${JSON.stringify(ok)}`);
    readingList.clear();
  }
  // CRUD happy path.
  const add = await tools().add_reading_list_entry.execute({ url: "https://a.example/x", title: "A", hasBeenRead: false });
  assertEquals(add.ok, true);
  const q = await tools().query_reading_list.execute({ hasBeenRead: false });
  assertEquals(q.entries.length, 1);
  assertEquals(q.entries[0].title, "A");
  const upd = await tools().update_reading_list_entry.execute({ url: "https://a.example/x", hasBeenRead: true });
  assertEquals(upd.ok, true);
  const q2 = await tools().query_reading_list.execute({ hasBeenRead: true });
  assertEquals(q2.entries.length, 1);
  const rm = await tools().remove_reading_list_entry.execute({ url: "https://a.example/x" });
  assertEquals(rm.ok, true);
  assertEquals(readingList.size, 0);
});

Deno.test("T6: save_page_as_mhtml rides the screenshot consent chain; NO byte cap (dptw)", async () => {
  reset();
  // pageCapture permission denied → honest error.
  assert((await tools().save_page_as_mhtml.execute({ tabId: 7 })).error.includes("pageCapture permission not granted"));
  granted.add("pageCapture");
  // No exact host permission → waitingForPermission with the permissionRequirement payload.
  const wait = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  assert(wait.waitingForPermission === true);
  // The requirement is the card-shaped one (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01):
  // exact canonical origin under grantOrigins, no Chrome permission needed.
  assertEquals(wait.permissionRequirement.grantOrigins, ["https://example.com"]);
  assertEquals(wait.permissionRequirement.permissions, []);
  // Host permission but NO product grant → honest grant error, no capture.
  grantedOrigins.add("https://example.com/*");
  const noGrant = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  assert(noGrant.error.includes("browser control not granted"));
  // Grant → capture flows, inline content + honest size metadata.
  await setOriginBrowserControlGrant(["https://example.com"], Date.now() + 5 * 60_000);
  const ok = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  assertEquals(ok.ok, true);
  assertEquals(ok.sizeBytes, 128);
  assertEquals(ok.mhtml.length, 128);
  assertEquals(ok.truncated, false);
  // dptw: past the removed 8 MiB cap the capture is delivered whole.
  mhtmlSize = 9 * 1024 * 1024;
  const big = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  assertEquals(big.ok, true, `past the removed cap the capture lands: ${JSON.stringify(big).slice(0, 160)}`);
  assertEquals(big.sizeBytes, 9 * 1024 * 1024);
  assertEquals(big.mhtml.length, 9 * 1024 * 1024, "every byte arrives");
  await revokeBrowserControlGrant();
});

Deno.test("T5/T6: registry parity — the 11 new tools are registered with capability records", async () => {
  const { chromeToolCapability, CHROME_TOOL_CAPABILITY_BOUNDS, BROWSER_TOOL_NAMES } = await import("../extension/lib/chrome-tool-capabilities.js");
  const names = ["get_system_memory", "get_system_cpu", "get_system_storage", "get_system_display", "list_top_sites", "list_granted_permissions", "add_reading_list_entry", "query_reading_list", "update_reading_list_entry", "remove_reading_list_entry", "save_page_as_mhtml"];
  for (const n of names) {
    assert(BROWSER_TOOL_NAMES.includes(n), `${n} in BROWSER_TOOL_NAMES`);
    const rec = chromeToolCapability(n, "chrome-api");
    assert(rec, `${n} has a capability record`);
    assert(rec.capabilityTokens.length > 0, `${n} has capability tokens`);
  }
  assertEquals(BROWSER_TOOL_NAMES.length, CHROME_TOOL_CAPABILITY_BOUNDS.browserTools);
  // every browserToolset tool is registered (no drift between the toolset and the table)
  const all = tools();
  for (const n of Object.keys(all)) assert(BROWSER_TOOL_NAMES.includes(n), `toolset tool ${n} registered`);
  // HOST-PERMISSION SIMPLIFICATION: these are GRANTED AT INSTALL now
  const manifest = JSON.parse(await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)));
  for (const p of ["system.cpu", "system.memory", "system.storage", "system.display", "topSites", "readingList", "pageCapture"]) {
    // Capability permissions are OPTIONAL (JIT) under the 2026-08-29 model.
    assert(manifest.optional_permissions.includes(p), `manifest made ${p} optional`);
  }
  assert((manifest.host_permissions ?? []).includes("<all_urls>"), "host access is permanent (<all_urls>)");
});

Deno.test("T6 r2 (review): update_reading_list_entry refuses a no-op update honestly (M3)", async () => {
  reset();
  granted.add("readingList");
  const r = await tools().update_reading_list_entry.execute({ url: "https://a.example/x" });
  assert(r.error.includes("nothing to update"), "url-only update refused before Chrome raw-throws");
});

Deno.test("T6 r2 (review): save_page_as_mhtml re-checks tab identity inside the lock (B1) and run ownership post-capture (B2)", async () => {
  reset();
  granted.add("pageCapture");
  grantedOrigins.add("https://example.com/*");
  await setOriginBrowserControlGrant(["https://example.com"], Date.now() + 5 * 60_000);
  // B1 pre-capture navigation: tabs.get returns a DIFFERENT url inside the lock.
  const origGet = chrome.tabs.get;
  let preCalls = 0;
  chrome.tabs.get = async () => (++preCalls > 1 // entry resolution = original; in-lock re-read = navigated
    ? { id: 7, url: "https://evil.example/takeover", title: "Evil", windowId: 1 }
    : { id: 7, url: "https://example.com/page", title: "Example", windowId: 1 });
  const raced = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  chrome.tabs.get = origGet;
  assert(raced.error.includes("tab navigated before capture"), `pre-capture race refused: ${raced.error}`);
  assert(!raced.mhtml, "no bytes on refusal");
  // B1 post-capture navigation: identity changes DURING capture (second get call).
  let calls = 0;
  chrome.tabs.get = async () => (++calls > 2 // entry + in-lock pre-capture = original; post-capture = navigated
    ? { id: 7, url: "https://evil.example/mid", title: "Evil", windowId: 1 }
    : { id: 7, url: "https://example.com/page", title: "Example", windowId: 1 });
  const midRace = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  chrome.tabs.get = origGet;
  assert(midRace.error.includes("navigated during capture"), `post-capture race refused: ${midRace.error}`);
  assert(!midRace.mhtml, "bytes discarded on post-capture race");
  // B2: abort lands during capture — bytes must NOT be returned.
  const fence = { signal: { aborted: false } };
  setRunFence(fence);
  const origText = chrome.pageCapture.saveAsMHTML;
  chrome.pageCapture.saveAsMHTML = async () => {
    fence.signal.aborted = true; // abort lands DURING the capture await
    return { size: 64, text: async () => "M".repeat(64) };
  };
  const aborted = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  chrome.pageCapture.saveAsMHTML = origText;
  clearRunFence();
  assert(aborted.error.includes("run aborted"), `post-capture abort refuses: ${aborted.error}`);
  assert(!aborted.mhtml, "bytes discarded on abort");
  await revokeBrowserControlGrant();
});

Deno.test("T6 r2 (review): save_page_as_mhtml capture failures are structured, never raw throws (M1/M2)", async () => {
  reset();
  granted.add("pageCapture");
  grantedOrigins.add("https://example.com/*");
  await setOriginBrowserControlGrant(["https://example.com"], Date.now() + 5 * 60_000);
  const orig = chrome.pageCapture.saveAsMHTML;
  chrome.pageCapture.saveAsMHTML = async () => { throw new Error("chrome exploded"); };
  const threw = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  assert(threw.error.startsWith("capture failed:"), `throw → structured: ${threw.error}`);
  chrome.pageCapture.saveAsMHTML = async () => null;
  const nul = await tools().save_page_as_mhtml.execute({ tabId: 7 });
  assert(nul.error.includes("no data"), `null blob guarded: ${nul.error}`);
  chrome.pageCapture.saveAsMHTML = orig;
  await revokeBrowserControlGrant();
});
