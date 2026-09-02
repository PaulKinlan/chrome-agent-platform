// @ts-nocheck
// CAP-FB-20260901-ONE-CARD-PER-STEP-01 — a tool whose first call needs several
// things (the `tabs` + `tabGroups` permissions AND the browser-control grant
// for the tabs' sites) raises ONE structured denial carrying the FULL
// requirement, so the conversation shows ONE Allow card and the owner's one
// click requests all of it in ONE chrome.permissions.request — never a cascade
// of three cards and two native prompts (the EXEC-DEMO-01 rehearsal).
//
// The requirement is derived BEFORE the first denial from the capability
// table (`requirementFor`) and filtered to what is actually missing; nothing
// is requested before the model selects a tool that needs it, and nothing is
// widened beyond that tool's own needs (a `list_tabs` still asks for `tabs`
// alone).
//
// In-memory chrome shim with Chrome's OWN visibility rule for `tab.url`: the
// address is hidden unless the `tabs` permission or the site's host access is
// granted — so the test proves what a fresh profile sees, not a shim that
// leaks addresses the real browser would scrub.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  browserToolset,
  revokeBrowserControlGrant,
  setOriginBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { requirementFor } from "../extension/lib/chrome-tool-capabilities.js";
import { normalizePermissionRequirement } from "../extension/shared/conversation.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

const DOCS = "https://docs.example";
const SHOP = "https://shop.example";

// ---- in-memory chrome shim ----
const store = new Map();
const grantedPermissions = new Set();
const grantedOrigins = new Set();
const tabs = [];
const tabGroups = new Map();
let nextTabId = 1;
let nextGroupId = 1;
let createdTabs = 0;

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedOrigins.clear();
  tabs.length = 0;
  tabGroups.clear();
  nextTabId = 1;
  nextGroupId = 1;
  createdTabs = 0;
  clearRunFence();
}

function addTab(url) {
  const tab = { id: nextTabId++, windowId: 1, active: true, _realUrl: url };
  tabs.push(tab);
  return tab;
}

/** Chrome's rule: `tab.url` is present only with `tabs` or host access. */
function visible(tab) {
  if (!tab) return null;
  let host = false;
  try { host = grantedOrigins.has(`${new URL(tab._realUrl).origin}/*`); } catch { host = false; }
  const shown = { ...tab };
  delete shown._realUrl;
  if (grantedPermissions.has("tabs") || host) {
    shown.url = tab._realUrl;
    shown.title = tab._realUrl;
  }
  return shown;
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
    query: async () => tabs.map(visible),
    get: async (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return visible(tab);
    },
    group: async ({ tabIds, groupId }) => {
      const id = groupId ?? nextGroupId++;
      const group = tabGroups.get(id) ?? { id, title: "", color: "grey", collapsed: false, windowId: 1, tabIds: [] };
      for (const tabId of tabIds) {
        const tab = tabs.find((t) => t.id === tabId);
        if (tab) { tab.groupId = id; if (!group.tabIds.includes(tabId)) group.tabIds.push(tabId); }
      }
      tabGroups.set(id, group);
      return id;
    },
    create: async ({ url }) => {
      createdTabs++;
      const tab = addTab(url);
      return visible(tab);
    },
    remove: async () => {},
  },
  tabGroups: {
    query: async () => [...tabGroups.values()],
    get: async (id) => tabGroups.get(id) ?? null,
    update: async (id, props) => { const g = tabGroups.get(id); Object.assign(g, props); return g; },
  },
};

const tools = () => browserToolset(false);

/** The conversation accepts the denial as ONE card; returns its requirement. */
function oneCard(result) {
  assertEquals(result?.waitingForPermission, true, `a structured denial: ${JSON.stringify(result)}`);
  const req = normalizePermissionRequirement(result);
  assert(req !== null, `accepted by normalizePermissionRequirement: ${JSON.stringify(result)}`);
  return req;
}

// ── the requirement, derived from the table before any denial ──────────────
Deno.test("requirementFor(group_tabs): the tabs + tabGroups permissions AND browser control, from the table", () => {
  const need = requirementFor("group_tabs");
  assertEquals([...need.permissions].sort(), ["tabGroups", "tabs"]);
  assertEquals(need.browserControl, true);
  assertEquals(need.grantGlobal, false);
  assertEquals(need.grantOrigins, []);
  assert(Object.isFrozen(need), "the requirement is data — frozen");
  const scoped = requirementFor("group_tabs", { origins: [DOCS, SHOP, DOCS] });
  assertEquals(scoped.grantOrigins, [DOCS, SHOP], "browser control names each tab site once");
});

Deno.test("requirementFor: list_tabs asks for tabs alone (never widened); a browser-wide tool asks for the global grant; unknown tools throw", () => {
  const list = requirementFor("list_tabs");
  assertEquals(list.permissions, ["tabs"]);
  assertEquals(list.browserControl, false);
  const wipe = requirementFor("wipe_browsing_data");
  assertEquals(wipe.permissions, ["browsingData"]);
  assertEquals(wipe.browserControl, true);
  assertEquals(wipe.grantGlobal, true);
  const page = requirementFor("read_page", { origin: DOCS });
  assert(!page.permissions.includes("activeTab"), "activeTab is Chrome's owner-gesture path — never a model-path ask");
  assertEquals(page.hostOrigins, [DOCS], "a page-reaching tool names the site's host access");
  assertThrows(() => requirementFor("no_such_tool"));
});

Deno.test("requirementFor: every reason is user language — no Chrome permission token reaches the card copy", () => {
  const need = requirementFor("group_tabs", { origins: [DOCS] });
  assert(need.reasons.length >= 3, `one reason per thing asked: ${JSON.stringify(need.reasons)}`);
  for (const line of need.reasons) {
    assert(!/\b(tabGroups|activeTab|scripting|browsingData)\b/.test(line), `no token in ${JSON.stringify(line)}`);
  }
  assert(need.reasons.some((l) => /see your open tabs/i.test(l)), JSON.stringify(need.reasons));
  assert(need.reasons.some((l) => /group tabs/i.test(l)), JSON.stringify(need.reasons));
  assert(need.reasons.some((l) => /control the browser on/i.test(l) && l.includes("docs.example")), JSON.stringify(need.reasons));
});

// ── the tool's FIRST denial carries the full set ───────────────────────────
Deno.test("group_tabs on a fresh profile with the tabs' site access already held: ONE denial carries tabs + tabGroups + browser control of the sites", async () => {
  reset();
  grantedOrigins.add(`${DOCS}/*`); // the owner allowed the site earlier (a read_page) — its address is visible
  const a = addTab(`${DOCS}/fetch`);
  const b = addTab(`${DOCS}/streams`);
  const result = await tools().group_tabs.execute({ tabIds: [a.id, b.id], title: "Docs" });
  const req = oneCard(result);
  assertEquals([...req.permissions].sort(), ["tabGroups", "tabs"], `both permissions on the one card: ${JSON.stringify(req)}`);
  assertEquals(req.grantOrigins, [DOCS], `the sites' browser control on the SAME card: ${JSON.stringify(req)}`);
  assertEquals(req.grantGlobal, false, "never widened to all sites");
  assertEquals(tabGroups.size, 0, "nothing grouped before the owner's decision");
});

Deno.test("group_tabs after list_tabs (tabs granted, the real-model order): ONE denial carries tabGroups + browser control — tabs is not re-asked", async () => {
  reset();
  grantedPermissions.add("tabs");
  const a = addTab(`${DOCS}/fetch`);
  const b = addTab(`${DOCS}/streams`);
  const result = await tools().group_tabs.execute({ tabIds: [a.id, b.id] });
  const req = oneCard(result);
  assertEquals(req.permissions, ["tabGroups"], JSON.stringify(req));
  assertEquals(req.grantOrigins, [DOCS], JSON.stringify(req));
  assertEquals(req.grantGlobal, false);
});

Deno.test("group_tabs with everything granted runs (no card)", async () => {
  reset();
  grantedPermissions.add("tabs");
  grantedPermissions.add("tabGroups");
  await setOriginBrowserControlGrant([DOCS]);
  const a = addTab(`${DOCS}/fetch`);
  const b = addTab(`${DOCS}/streams`);
  const result = await tools().group_tabs.execute({ tabIds: [a.id, b.id], title: "Docs", color: "blue" });
  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(tabGroups.get(result.groupId).title, "Docs");
});

Deno.test("group_tabs when the addresses are hidden (no tabs, no site access): the card asks for the permissions and is NOT widened to all sites", async () => {
  reset();
  const a = addTab(`${DOCS}/fetch`);
  const result = await tools().group_tabs.execute({ tabIds: [a.id] });
  const req = oneCard(result);
  assertEquals([...req.permissions].sort(), ["tabGroups", "tabs"]);
  assertEquals(req.grantGlobal, false, "an address hidden by a missing permission is unknown, not privileged — no all-sites ask");
  assertEquals(req.grantOrigins, [], "no site can be named yet");
});

Deno.test("group_tabs: a genuinely origin-less tab (chrome://) with tabs granted still needs the all-sites grant on the one card", async () => {
  reset();
  grantedPermissions.add("tabs");
  const a = addTab("chrome://newtab/");
  const result = await tools().group_tabs.execute({ tabIds: [a.id] });
  const req = oneCard(result);
  assertEquals(req.permissions, ["tabGroups"]);
  assertEquals(req.grantGlobal, true);
});

Deno.test("update_tab_group / ungroup_tabs / move_tab_to_group: the same single combined denial", async () => {
  reset();
  grantedPermissions.add("tabs");
  const a = addTab(`${SHOP}/cart`);
  const b = addTab(`${SHOP}/checkout`);
  tabGroups.set(9, { id: 9, title: "Shop", color: "red", collapsed: false, windowId: 1, tabIds: [a.id] });
  a.groupId = 9;
  for (const [name, args] of [
    ["ungroup_tabs", { tabIds: [a.id] }],
    ["move_tab_to_group", { tabIds: [b.id], groupId: 9 }],
  ]) {
    const req = oneCard(await tools()[name].execute(args));
    assertEquals(req.permissions, ["tabGroups"], `${name}: ${JSON.stringify(req)}`);
    assertEquals(req.grantOrigins, [SHOP], `${name}: ${JSON.stringify(req)}`);
  }
  // A group's tabs are only readable through chrome.tabGroups, which Chrome
  // does not expose without the permission: the first card asks for it, and
  // the sites follow on the re-run (never invented, never widened).
  const blind = oneCard(await tools().update_tab_group.execute({ groupId: 9, title: "Shopping" }));
  assertEquals(blind.permissions, ["tabGroups"], JSON.stringify(blind));
  assertEquals(blind.grantGlobal, false);
  grantedPermissions.add("tabGroups");
  const sighted = oneCard(await tools().update_tab_group.execute({ groupId: 9, title: "Shopping" }));
  assertEquals(sighted.permissions, [], JSON.stringify(sighted));
  assertEquals(sighted.grantOrigins, [SHOP], JSON.stringify(sighted));
});

Deno.test("open_tab on a fresh profile: ONE denial carries tabs + browser control of the destination", async () => {
  reset();
  const result = await tools().open_tab.execute({ url: `${SHOP}/cart` });
  const req = oneCard(result);
  assertEquals(req.permissions, ["tabs"]);
  assertEquals(req.grantOrigins, [SHOP]);
  assertEquals(createdTabs, 0);
  // With both in place the tab opens.
  grantedPermissions.add("tabs");
  await setOriginBrowserControlGrant([SHOP]);
  const ok = await tools().open_tab.execute({ url: `${SHOP}/cart` });
  assertEquals(ok.ok, true, JSON.stringify(ok));
  assertEquals(createdTabs, 1);
});

Deno.test("list_tabs asks for tabs alone — the combined card never widens a read", async () => {
  reset();
  addTab(`${DOCS}/fetch`);
  const req = oneCard(await tools().list_tabs.execute({}));
  assertEquals(req.permissions, ["tabs"]);
  assertEquals(req.grantOrigins, []);
  assertEquals(req.grantGlobal, false);
  await revokeBrowserControlGrant();
});

Deno.test("the combined denial is ONE card key — a denial of it is one terminal decision, not three", async () => {
  reset();
  grantedOrigins.add(`${DOCS}/*`);
  const a = addTab(`${DOCS}/fetch`);
  const first = oneCard(await tools().group_tabs.execute({ tabIds: [a.id] }));
  const again = oneCard(await tools().group_tabs.execute({ tabIds: [a.id] }));
  assertEquals(first.key, again.key, "the same ask reopens the same card");
  assert(first.key.includes("tabGroups") && first.key.includes("tabs") && first.key.includes(DOCS), first.key);
});
