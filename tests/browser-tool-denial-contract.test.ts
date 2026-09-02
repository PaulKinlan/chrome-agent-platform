// @ts-nocheck
// CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01 — every browser-tool denial is a
// structured permission requirement the conversation can turn into ONE
// in-context Allow card.
//
// The contract: a denial from `browserToolset(false)` MUST be accepted by
// `normalizePermissionRequirement` (the ONLY gate before a card renders) and
// must name the exact Chrome permission(s), the exact origin(s), or the global
// scope. Two error vocabularies used to coexist — the legacy bare
// `{ error, permissionRequired:{ capability } }` and the structured
// `waitingForPermission + permissionRequirement` — and the tab tools the demo
// path needs used the legacy one, so "open example.com in a new tab" said
// "enable it from the chat when prompted" while nothing in the chat prompted.
//
// In-memory chrome shim (copied from chrome-tools-t12.test.ts) with NOTHING
// granted by default.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  revokeBrowserControlGrant,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { normalizePermissionRequirement } from "../extension/shared/conversation.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim (grant NOTHING) ----
const store = new Map();
const grantedPermissions = new Set();
const grantedOrigins = new Set();
const tabs = [];
let nextTabId = 1;

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedOrigins.clear();
  tabs.length = 0;
  nextTabId = 1;
  clearRunFence();
}

function addTab(url) {
  const tab = { id: nextTabId++, url, title: url, windowId: 1, active: true };
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
    create: async ({ url }) => addTab(url),
    update: async (id, props) => { const t = tabs.find((x) => x.id === id); if (t && props?.url) t.url = props.url; return t; },
    remove: async (id) => { const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); },
    captureVisibleTab: async () => "data:image/png;base64,iVBORw0KGgo=",
  },
  windows: {
    get: async (id) => ({ id, tabs: [...tabs] }),
    create: async ({ url }) => ({ id: 7, tabs: url ? [addTab(url)] : [] }),
  },
  scripting: {
    executeScript: async () => [{ result: { title: "Example", url: "https://example.com/", text: "hi" } }],
  },
  pageCapture: {
    saveAsMHTML: async () => new Blob(["x"]),
  },
};

function tools() {
  return browserToolset(false);
}

const EXAMPLE = "https://example.com";

/** The exact per-tool minimal args, keyed by the tool name the Gates list. */
function callFor(name, tabId) {
  switch (name) {
    case "open_tab": return { url: `${EXAMPLE}/` };
    case "navigate_tab": return { tabId, url: `${EXAMPLE}/` };
    case "list_tabs": return {};
    case "close_tab": return { tabId };
    case "create_window": return { url: `${EXAMPLE}/` };
    case "read_page": return { tabId };
    case "capture_screenshot": return { tabId };
    case "save_page_as_mhtml": return { tabId };
    default: throw new Error(`no minimal args for ${name}`);
  }
}

const DENIAL_TOOLS = [
  "open_tab", "navigate_tab", "list_tabs", "close_tab", "create_window",
  "read_page", "capture_screenshot", "save_page_as_mhtml",
];

/** A denial satisfies the contract when the conversation's normaliser accepts
 * it AND it names something concrete to grant. */
function assertContract(name, result) {
  assertEquals(result?.waitingForPermission, true, `denial contract: ${name} carries waitingForPermission`);
  const req = normalizePermissionRequirement(result);
  assert(req !== null, `denial contract: ${name} is accepted by normalizePermissionRequirement`);
  assert(
    req.permissions.length > 0 || req.grantOrigins.length > 0 || req.grantGlobal === true,
    `denial contract: ${name} names a permission, an origin, or the global scope`,
  );
  return req;
}

for (const name of DENIAL_TOOLS) {
  Deno.test(`denial contract: ${name} without ${name === "read_page" ? "scripting" : name === "capture_screenshot" || name === "save_page_as_mhtml" ? "site access" : "tabs"}`, async () => {
    reset();
    const tab = addTab(`${EXAMPLE}/`);
    const result = await tools()[name].execute(callFor(name, tab.id));
    const req = assertContract(name, result);
    if (["open_tab", "navigate_tab", "list_tabs", "close_tab", "create_window"].includes(name)) {
      assert(req.permissions.includes("tabs"), `${name}: the exact Chrome permission is named`);
    }
    if (name === "read_page") assert(req.permissions.includes("scripting"), "read_page: scripting is named");
    if (name === "capture_screenshot") assert(req.grantOrigins.includes(EXAMPLE), `${name}: the exact origin is named`);
    if (name === "save_page_as_mhtml") assert(req.permissions.includes("pageCapture"), "save_page_as_mhtml: pageCapture is named");
    // The error text is still there for the transcript (never a silent card).
    assert(typeof result.error === "string" && result.error.length > 0, `${name}: error text present`);
  });
}

Deno.test("denial contract: with tabs granted but no browser-control grant, the mutating tab tools name https://example.com (or the global scope)", async () => {
  for (const name of ["open_tab", "navigate_tab", "close_tab", "create_window"]) {
    reset();
    grantedPermissions.add("tabs");
    await revokeBrowserControlGrant();
    const tab = addTab(`${EXAMPLE}/`);
    const result = await tools()[name].execute(callFor(name, tab.id));
    const req = assertContract(name, result);
    assertEquals(req.permissions, [], `${name}: no Chrome permission is re-requested once tabs is granted`);
    assert(
      req.grantOrigins.includes(EXAMPLE) || req.grantGlobal === true,
      `${name}: the browser-control requirement names ${EXAMPLE} (got ${JSON.stringify(req)})`,
    );
  }
});

Deno.test("denial contract: capture_screenshot with site access but no browser-control grant names the tab's origin", async () => {
  reset();
  grantedOrigins.add(`${EXAMPLE}/*`);
  await revokeBrowserControlGrant();
  const tab = addTab(`${EXAMPLE}/`);
  const result = await tools().capture_screenshot.execute({ tabId: tab.id });
  const req = assertContract("capture_screenshot", result);
  assertEquals(req.permissions, []);
  assert(req.grantOrigins.includes(EXAMPLE));
});

Deno.test("denial contract: save_page_as_mhtml with pageCapture but no site access names the tab's origin", async () => {
  reset();
  grantedPermissions.add("pageCapture");
  const tab = addTab(`${EXAMPLE}/`);
  const result = await tools().save_page_as_mhtml.execute({ tabId: tab.id });
  const req = assertContract("save_page_as_mhtml", result);
  assertEquals(req.permissions, []);
  assert(req.grantOrigins.includes(EXAMPLE));
});

Deno.test("denial contract: list_tabs with tabs granted needs no browser-control grant (a read)", async () => {
  reset();
  grantedPermissions.add("tabs");
  addTab(`${EXAMPLE}/`);
  const result = await tools().list_tabs.execute({});
  assertEquals(result.error, undefined);
  assertEquals(result.tabs.length, 1);
});

// CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01 — "list_tabs, I'm not sure it gets
// all the tabs": the listing carries a count plus window/group/active/index
// per tab so the model AND the owner can verify completeness across windows.
Deno.test("list_tabs: completeness fields — count, windowId, groupId, active, index for every window", async () => {
  reset();
  grantedPermissions.add("tabs");
  const a = addTab(`${EXAMPLE}/a`);
  const b = addTab(`${EXAMPLE}/b`);
  Object.assign(a, { windowId: 1, index: 0, active: true, groupId: -1 });
  Object.assign(b, { windowId: 2, index: 0, active: false, groupId: 7 });
  const result = await tools().list_tabs.execute({});
  assertEquals(result.count, 2, "the total is stated, not inferred");
  assertEquals(result.windows, 2, "tabs from every window are included");
  assertEquals(result.tabs.map((t) => t.windowId), [1, 2]);
  assertEquals(result.tabs.map((t) => t.index), [0, 0]);
  assertEquals(result.tabs.map((t) => t.active), [true, false]);
  assertEquals(result.tabs.map((t) => t.groupId), [-1, 7]);
  assertEquals(result.tabs[0].id, a.id);
});

Deno.test("denial contract: granting exactly what the card asked for makes the retried open_tab succeed", async () => {
  reset();
  addTab(`${EXAMPLE}/`);
  const first = await tools().open_tab.execute({ url: `${EXAMPLE}/` });
  const req1 = assertContract("open_tab", first);
  // The owner's Allow: chrome.permissions.request for the named permissions…
  for (const p of req1.permissions) grantedPermissions.add(p);
  const second = await tools().open_tab.execute({ url: `${EXAMPLE}/` });
  const req2 = assertContract("open_tab", second);
  // …then browser-control.set for the named origins (the second card).
  assert(req2.grantOrigins.includes(EXAMPLE));
  await setOriginBrowserControlGrant(req2.grantOrigins);
  const third = await tools().open_tab.execute({ url: `${EXAMPLE}/` });
  assertEquals(third.error, undefined, `retried open_tab succeeds: ${JSON.stringify(third)}`);
  assertEquals(third.ok, true);
});

Deno.test("denial contract: a global-only mutation asks for the global grant, never an origin", async () => {
  reset();
  grantedPermissions.add("browsingData");
  await revokeBrowserControlGrant();
  const result = await tools().wipe_browsing_data.execute({ dataTypes: ["cache"], sinceMs: 1000 });
  const req = assertContract("wipe_browsing_data", result);
  assertEquals(req.grantGlobal, true);
  assertEquals(req.grantOrigins, []);
  await setGlobalBrowserControlGrant();
});

Deno.test("denial contract: the legacy permissionRequired marker stays as an alias on Chrome-permission denials", async () => {
  // Consumers that remain: scripts/chrome-journeys.ts (lease check) and
  // tests/bug7-history-permission.test.ts read `permissionRequired.capability`.
  reset();
  const result = await tools().list_tabs.execute({});
  assertEquals(result.permissionRequired?.capability, "tabs");
});

Deno.test("denial contract: a forged shape never produces a card (normaliser bounds unchanged)", () => {
  assertEquals(normalizePermissionRequirement({ error: "x", permissionRequired: { capability: "tabs" } }), null);
  assertEquals(normalizePermissionRequirement({ error: "x", waitingForPermission: true, permissionRequirement: { origins: ["https://a.com/*"] } }), null);
  assertEquals(normalizePermissionRequirement({ error: "x", waitingForPermission: true, permissionRequirement: { grantOrigins: ["javascript:alert(1)"] } }), null);
});
