// @ts-nocheck
// chrome-agent-platform-pvha — the task-level "tab tools" bundle
// (docs/OPEN-QUESTIONS.md #22): a real model's "group my tabs" step calls
// list_tabs first (needs `tabs`), then group_tabs (needs `tabGroups` + the
// browser-control grant) — two per-tool cards on a fresh profile. The bundle
// keeps per-tool asks as the SAFETY FLOOR and adds ONE task-level requirement
// the service worker offers on the denial path: one card covering see/list
// tabs, group tabs, and browser control on the owner's open-tab sites.
//
// Driven against the REAL extension/lib/tab-tools-bundle.js builder, the REAL
// extension/shared/conversation.js (stubbed chrome + minimal fake DOM), and
// the REAL extension/lib/browser-tools.js toolset. Plus a source pin: the
// bundle is owner-gesture-only — the model's tool registries never name it.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  offerTabToolsBundle,
  stampTabToolsBundle,
  TAB_TOOLS_BUNDLE_FAMILY,
  TAB_TOOLS_BUNDLE_ID,
  TAB_TOOLS_BUNDLE_PERMISSIONS,
} from "../extension/lib/tab-tools-bundle.js";
import { normalizePermissionRequirement } from "../extension/shared/conversation.js";

const DOCS = "https://docs.example";
const SHOP = "https://shop.example";

/** The denial shape browser-tools.js produces (permissionDenial). */
function denial(requirement, error = "missing capability — allow it in the approval card here") {
  return { error, waitingForPermission: true, permissionRequirement: requirement };
}

// ── 1. the pure bundle builder ──────────────────────────────────────────────

Deno.test("bundle builder: a fresh-profile list_tabs denial mints the union ask (tabs + tabGroups)", async () => {
  const granted = new Set();
  const bundle = await offerTabToolsBundle("exec-1", { reason: "list your open tabs", permissions: ["tabs"] }, {
    toolName: "list_tabs",
    openTabOrigins: [], // a fresh profile: the addresses are hidden, no site can be named
    hasPermission: async (p) => granted.has(p),
    isControlGranted: async () => false,
  });
  assert(bundle, "the tab-family denial gets the bundle");
  assertEquals([...bundle.permissions].sort(), ["tabGroups", "tabs"], "the union of the family's permissions");
  assertEquals(bundle.grantOrigins, [], "no site can be named yet — never widened to all sites");
  assertEquals(bundle.grantGlobal, false);
  assertEquals(bundle.bundle, TAB_TOOLS_BUNDLE_ID);
  assert(typeof bundle.reason === "string" && bundle.reason.length > 0 && bundle.reason.length <= 240);
});

Deno.test("bundle builder: the sites are the union of the denial's own + the open tabs', deduped, minus what is already granted", async () => {
  const granted = new Set(["tabs"]); // list_tabs already ran
  const controlGranted = new Set([`${DOCS}/*`]);
  const bundle = await offerTabToolsBundle("exec-2", {
    reason: "group these tabs",
    permissions: ["tabGroups"],
    grantOrigins: [DOCS, SHOP],
  }, {
    toolName: "group_tabs",
    openTabOrigins: [DOCS, SHOP, SHOP],
    hasPermission: async (p) => granted.has(p),
    isControlGranted: async (origin) => controlGranted.has(`${origin}/*`),
  });
  assert(bundle);
  assertEquals(bundle.permissions, ["tabGroups"], "already-held permissions are not re-asked");
  assertEquals(bundle.grantOrigins, [SHOP], `${DOCS} is already browser-control-granted — only the uncovered site is asked`);
  assertEquals(bundle.grantGlobal, false);
});

Deno.test("bundle builder: a genuinely origin-less denial keeps the all-sites ask honest", async () => {
  const bundle = await offerTabToolsBundle("exec-3", {
    reason: "group these tabs",
    permissions: ["tabGroups"],
    grantOrigins: [],
    grantGlobal: true,
  }, {
    toolName: "group_tabs",
    openTabOrigins: [DOCS],
    hasPermission: async (p) => p === "tabs",
    isControlGranted: async () => false,
  });
  assert(bundle);
  assertEquals(bundle.grantGlobal, true, "the global ask passes through — the bundle never hides it");
  assertEquals(bundle.grantOrigins, [], "an all-sites ask names no single site");
});

Deno.test("bundle builder: the per-tool FLOOR holds — non-family tools, approval/host-ask denials, and a nothing-missing ask get NO bundle", async () => {
  const opts = { openTabOrigins: [DOCS], hasPermission: async () => false, isControlGranted: async () => false };
  // A tool outside the tab family keeps its own per-tool card.
  assertEquals(await offerTabToolsBundle("exec-f1", { reason: "open a page", permissions: ["tabs"], grantOrigins: [SHOP] }, { ...opts, toolName: "open_tab" }), null);
  assertEquals(await offerTabToolsBundle("exec-f2", { reason: "read the page", permissions: ["scripting"], hostOrigins: [DOCS] }, { ...opts, toolName: "read_page" }), null);
  // An owner-approval requirement is a different decision — never bundled.
  assertEquals(await offerTabToolsBundle("exec-f3", { reason: "task.pause: x", approvals: [{ approvalId: "ap_1", action: "task.pause" }] }, { ...opts, toolName: "group_tabs" }), null);
  // Nothing missing → nothing to offer.
  assertEquals(await offerTabToolsBundle("exec-f4", { reason: "group these tabs", permissions: [] }, {
    ...opts,
    toolName: "group_tabs",
    openTabOrigins: [],
    hasPermission: async () => true,
    isControlGranted: async () => true,
  }), null);
  // A malformed requirement fails closed to the floor.
  assertEquals(await offerTabToolsBundle("exec-f5", null, { ...opts, toolName: "group_tabs" }), null);
});

Deno.test("bundle builder: ONE mint per task — a second tab-tool denial in the same run reuses the exact bundle", async () => {
  const first = await offerTabToolsBundle("exec-memo", { reason: "list your open tabs", permissions: ["tabs"] }, {
    toolName: "list_tabs",
    openTabOrigins: [],
    hasPermission: async () => false,
    isControlGranted: async () => false,
  });
  assert(first);
  // The second denial arrives after the owner granted SOME of it (or tabs
  // changed) — the offer must stay byte-identical so both denials share one
  // card key.
  const second = await offerTabToolsBundle("exec-memo", { reason: "group these tabs", permissions: ["tabGroups"], grantOrigins: [DOCS] }, {
    toolName: "group_tabs",
    openTabOrigins: [DOCS, SHOP],
    hasPermission: async (p) => p === "tabs",
    isControlGranted: async () => true,
  });
  assertEquals(second, first, "the memoized task-level bundle is reused verbatim");
  // A DIFFERENT run mints its own bundle from its own live state.
  const other = await offerTabToolsBundle("exec-other", { reason: "group these tabs", permissions: ["tabGroups"], grantOrigins: [SHOP] }, {
    toolName: "group_tabs",
    openTabOrigins: [SHOP],
    hasPermission: async (p) => p === "tabs",
    isControlGranted: async () => false,
  });
  assert(other);
  assertEquals(other.grantOrigins, [SHOP]);
  // Once the first run is gone its memo is not reused.
  const fresh = await offerTabToolsBundle("exec-memo", { reason: "list your open tabs", permissions: ["tabs"] }, {
    toolName: "list_tabs",
    openTabOrigins: [],
    hasPermission: async () => true,
    isControlGranted: async () => true,
    isExecutionActive: (id) => id !== "exec-memo",
  });
  assertEquals(fresh, null, "a settled run's stale memo never leaks into a new offer");
});

Deno.test("bundle builder: origins are bounded and non-web origins are dropped", async () => {
  const many = Array.from({ length: 60 }, (_, i) => `https://s${i}.example`);
  const bundle = await offerTabToolsBundle("exec-bound", { reason: "group these tabs", permissions: ["tabGroups"] }, {
    toolName: "group_tabs",
    openTabOrigins: [...many, "chrome://newtab", "file:///x", null, 42],
    hasPermission: async (p) => p === "tabs",
    isControlGranted: async () => false,
  });
  assert(bundle);
  assertEquals(bundle.grantOrigins.length, 50, "bounded like every requirement");
  assert(bundle.grantOrigins.every((o) => /^https:\/\//.test(o)), "only web origins survive");
});

Deno.test("stamp: the bundle replaces the denial's requirement IN PLACE (the live card, the tool-result event and the journal row share one object)", () => {
  const req = { reason: "list your open tabs", permissions: ["tabs"] };
  const d = denial(req);
  const bundle = { reason: "organize your open tabs", permissions: ["tabGroups", "tabs"], grantOrigins: [DOCS], grantGlobal: false, bundle: TAB_TOOLS_BUNDLE_ID };
  assertEquals(stampTabToolsBundle(req, bundle), true);
  assertEquals(d.permissionRequirement.reason, "organize your open tabs", "the SAME object the agent loop holds is updated");
  assertEquals(d.permissionRequirement.permissions, ["tabGroups", "tabs"]);
  assertEquals(d.permissionRequirement.grantOrigins, [DOCS]);
  assertEquals(d.permissionRequirement.bundle, TAB_TOOLS_BUNDLE_ID);
  // A frozen requirement fails closed to the floor — never throws.
  const frozen = Object.freeze({ reason: "x", permissions: ["tabs"] });
  assertEquals(stampTabToolsBundle(frozen, bundle), false);
});

Deno.test("two stamped tab-tool denials normalize to ONE conversation card key", async () => {
  const bundle = { reason: "organize your open tabs", permissions: ["tabGroups", "tabs"], grantOrigins: [DOCS, SHOP], grantGlobal: false, bundle: TAB_TOOLS_BUNDLE_ID };
  const a = denial({ reason: "list your open tabs", permissions: ["tabs"] });
  const b = denial({ reason: "group these tabs", permissions: ["tabGroups"], grantOrigins: [DOCS] });
  stampTabToolsBundle(a.permissionRequirement, bundle);
  stampTabToolsBundle(b.permissionRequirement, bundle);
  const na = normalizePermissionRequirement(a);
  const nb = normalizePermissionRequirement(b);
  assert(na && nb, "both stamped denials normalize");
  assertEquals(na.key, nb.key, "same bundle content → same card key → one card");
  assertEquals([...na.permissions].sort(), ["tabGroups", "tabs"]);
  assertEquals(na.grantOrigins, [DOCS, SHOP]);
});

// ── 2. the conversation: one card, one gesture, honest decline ──────────────

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  appendChild(child) { this.children.push(child); return child; }
  querySelector() { return null; }
  dispatch(type, detail) {
    for (const fn of (this.listeners.get(type) ?? [])) fn({ type, detail });
  }
}

function makeConversationContainer(appended) {
  return {
    appendUser() {}, appendAgent() {}, appendSystem() {}, appendError() {},
    appendTool() { return { setAttribute() {} }; },
    append(el) { appended.push(el); },
    scrollTop: 0, scrollHeight: 0,
    setMessages() {}, clear() {},
  };
}

const portState = { listener: null };

function installConversationChromeStub(sw) {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, local: true }));
          return;
        }
        if (msg.type === "agent.run") {
          sw.runCount += 1;
          sw.lastRunId = msg.runId ?? null;
          setTimeout(() => cb({ ok: true, threadId: "t_bundle", executionId: `exec:${msg.runId}`, result: "[demo] narrated" }), 250);
          return;
        }
        if (msg.type === "browser-control.set") {
          sw.grantCalls.push(msg);
          queueMicrotask(() => cb({ grant: { id: `g${sw.grantCalls.length}`, scope: msg.origins ? "origins" : "global", origins: msg.origins ?? [] } }));
          return;
        }
        if (msg.type === "run.resolve-inline-approval") {
          sw.resolved.push({ requestId: msg.requestId, approve: msg.approve });
          queueMicrotask(() => cb({ ok: true }));
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn) { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: {
      contains: () => Promise.resolve(true),
      request: (req) => {
        sw.permissionRequests.push({ permissions: [...(req.permissions ?? [])], origins: [...(req.origins ?? [])] });
        return Promise.resolve(true);
      },
    },
  };
}

async function waitForCondition(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The requirement exactly as the SW stamps it for the tab-tools bundle. */
const BUNDLE_REQUIREMENT = {
  reason: "organize your open tabs — see them, group them, and control the browser on the sites you have open",
  permissions: ["tabGroups", "tabs"],
  grantOrigins: [DOCS, SHOP],
  grantGlobal: false,
  bundle: TAB_TOOLS_BUNDLE_ID,
};

Deno.test("conversation: two consecutive tab-tool denials carrying the bundle render EXACTLY ONE card", async () => {
  const sw = { runCount: 0, lastRunId: null, grantCalls: [], permissionRequests: [], resolved: [] };
  installConversationChromeStub(sw);
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), { text: "group my tabs", onStatus: () => {} });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");
  // Denial 1: list_tabs paused, the SW stamped the bundle.
  portState.listener({ type: "progress", event: {
    type: "approval-request", runId: sw.lastRunId, requestId: "rp_list",
    result: denial({ ...BUNDLE_REQUIREMENT, permissions: [...BUNDLE_REQUIREMENT.permissions], grantOrigins: [...BUNDLE_REQUIREMENT.grantOrigins] }),
  } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "the bundle card");
  // Denial 2: group_tabs paused in the same task — the memoized bundle, a
  // byte-equal requirement (content, not identity — a fresh copy).
  portState.listener({ type: "progress", event: {
    type: "approval-request", runId: sw.lastRunId, requestId: "rp_group",
    result: denial({ ...BUNDLE_REQUIREMENT, permissions: [...BUNDLE_REQUIREMENT.permissions], grantOrigins: [...BUNDLE_REQUIREMENT.grantOrigins] }),
  } });
  await new Promise((r) => setTimeout(r, 60));
  const cards = appended.filter((el) => el.tagName === "permission-approval-card");
  assertEquals(cards.length, 1, "ONE card for the whole tab task");
  const card = cards[0];
  assertEquals(JSON.parse(card.getAttribute("permissions")).sort(), ["tabGroups", "tabs"]);
  assertEquals(JSON.parse(card.getAttribute("origins")), [DOCS, SHOP]);
  assertEquals(card.getAttribute("global"), null, "never widened to all sites");
  // The owner's ONE Allow resolves EVERY paused call behind the card and
  // requests the union scope in ONE chrome.permissions gesture.
  await card.dispatch("approve", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => sw.grantCalls.length === 1, 500, "the scoped grant is written");
  assertEquals(sw.permissionRequests.length, 1, "ONE chrome.permissions.request for the whole bundle");
  assertEquals(sw.permissionRequests[0].permissions.sort(), ["tabGroups", "tabs"], "the union permissions");
  assertEquals(sw.permissionRequests[0].origins, [], "no host patterns in a browser-control bundle");
  assertEquals(sw.grantCalls[0].origins, [DOCS, SHOP], "the browser-control grant covers exactly the bundle's sites");
  assertEquals(sw.resolved, [
    { requestId: "rp_list", approve: true },
    { requestId: "rp_group", approve: true },
  ], "both paused tab-tool calls resume from the one decision");
  await waitForCondition(() => card.getAttribute("state") === "granted", 500, "the card reports the grant");
  await turn;
});

Deno.test("conversation: Not-now ends honestly — nothing granted, nothing requested, one terminal card", async () => {
  const sw = { runCount: 0, lastRunId: null, grantCalls: [], permissionRequests: [], resolved: [] };
  installConversationChromeStub(sw);
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), { text: "group my tabs", onStatus: () => {} });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");
  portState.listener({ type: "progress", event: {
    type: "approval-request", runId: sw.lastRunId, requestId: "rp_list",
    result: denial({ ...BUNDLE_REQUIREMENT }),
  } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "the bundle card");
  const card = appended.find((el) => el.tagName === "permission-approval-card");
  await card.dispatch("deny", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => sw.resolved.length === 1, 500, "the paused call is declined");
  assertEquals(sw.resolved, [{ requestId: "rp_list", approve: false }]);
  assertEquals(sw.permissionRequests.length, 0, "Not now requests nothing");
  assertEquals(sw.grantCalls.length, 0, "Not now grants nothing");
  await waitForCondition(() => card.getAttribute("state") === "denied", 500, "the card says declined");
  // A second tab-tool denial with the same bundle does NOT nag again — the
  // declined decision is sticky and terminal.
  portState.listener({ type: "progress", event: {
    type: "approval-request", runId: sw.lastRunId, requestId: "rp_group",
    result: denial({ ...BUNDLE_REQUIREMENT }),
  } });
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(appended.filter((el) => el.tagName === "permission-approval-card").length, 1, "still exactly one card");
  assertEquals(sw.runCount, 1, "no whole-turn retry from a permission decision");
  await turn;
});

Deno.test("conversation: the per-tool FLOOR is unchanged when the bundle is not offered", async () => {
  const sw = { runCount: 0, lastRunId: null, grantCalls: [], permissionRequests: [], resolved: [] };
  installConversationChromeStub(sw);
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), { text: "bookmark this", onStatus: () => {} });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");
  // A plain per-tool denial (no bundle marker) — exactly today's card.
  portState.listener({ type: "progress", event: {
    type: "approval-request", runId: sw.lastRunId, requestId: "rp_bm",
    result: denial({ reason: "add a bookmark", permissions: ["bookmarks"] }),
  } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "the per-tool card");
  const card = appended.find((el) => el.tagName === "permission-approval-card");
  assertEquals(card.getAttribute("reason"), "add a bookmark");
  assertEquals(JSON.parse(card.getAttribute("permissions")), ["bookmarks"], "the per-tool scope, un-bundled");
  await turn;
});

// ── 3. the tool layer: after the ONE allow the second tool just runs ─────────

Deno.test("tools: once the bundle's grants are in, list_tabs AND group_tabs run with NO denial (the second tool needs no card)", async () => {
  // Reuse the real toolset against a grant-capable chrome shim.
  const store = new Map();
  const granted = new Set();
  const controlOrigins = new Set();
  const tabs = [];
  let nextTabId = 1;
  let nextGroupId = 1;
  const addTab = (url) => {
    const tab = { id: nextTabId++, windowId: 1, active: true, url, title: url, groupId: -1 };
    tabs.push(tab);
    return tab;
  };
  globalThis.chrome = {
    permissions: {
      contains: async (q) => {
        if (q?.permissions && !q.permissions.every((p) => granted.has(p))) return false;
        if (q?.origins && !q.origins.every((o) => controlOrigins.has(o))) return false;
        return true;
      },
      request: async () => true,
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
      group: async ({ tabIds }) => {
        const groupId = nextGroupId++;
        for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = groupId;
        return groupId;
      },
      ungroup: async () => {},
    },
    tabGroups: {
      query: async () => [],
      get: async () => null,
      update: async (id, props) => ({ id, ...props }),
    },
  };
  const { browserToolset, setOriginBrowserControlGrant, revokeBrowserControlGrant } = await import("../extension/lib/browser-tools.js");
  const { clearRunFence } = await import("../extension/lib/run-fence.js");
  clearRunFence();
  await revokeBrowserControlGrant();
  const a = addTab(`${DOCS}/fetch`);
  const b = addTab(`${SHOP}/cart`);
  // Premise: on a fresh profile list_tabs denies (the per-tool floor).
  const before = await browserToolset(false).list_tabs.execute({});
  assertEquals(before.waitingForPermission, true, "a fresh profile denies list_tabs");
  // The owner's ONE Allow lands exactly what approvePermissionRequirement
  // lands for the bundle: both permissions + the sites' browser control.
  granted.add("tabs");
  granted.add("tabGroups");
  await setOriginBrowserControlGrant([DOCS, SHOP]);
  const list = await browserToolset(false).list_tabs.execute({});
  assert(list.waitingForPermission !== true && Array.isArray(list.tabs), `list_tabs runs: ${JSON.stringify(list)}`);
  const group = await browserToolset(false).group_tabs.execute({ tabIds: [a.id, b.id], title: "Reading" });
  assertEquals(group.ok, true, `group_tabs runs with NO denial after the one bundle allow: ${JSON.stringify(group)}`);
  assert(group.waitingForPermission !== true, "the second tab tool raises no card");
  clearRunFence();
});

// ── 4. source pin: the bundle is owner-gesture-only ─────────────────────────

Deno.test("source pin: the model's tool registries never name the bundle id, builder, or a bundle route", async () => {
  const root = new URL("../", import.meta.url);
  const registries = [
    "extension/lib/browser-tools.js",
    "extension/lib/management-tools.js",
    "extension/lib/tool-catalog.js",
    "extension/lib/lazy-tool-protocol.js",
    "extension/lib/chrome-tool-capabilities.js",
    "extension/lib/tool-selection.js",
    "extension/lib/capabilities.js",
    "extension/lib/bundled-tool-packages.js",
  ];
  for (const path of registries) {
    const src = await Deno.readTextFile(new URL(path, root));
    assert(!/tab-tools\b/.test(src), `${path} names the bundle id — the bundle must never be reachable from the model's registries`);
    assert(!src.includes("TabToolsBundle"), `${path} names the bundle builder`);
    assert(!src.includes("TAB_TOOLS_BUNDLE"), `${path} names the bundle constants`);
  }
  // Positive control: the bundle lives in its own module, and the service
  // worker offers it on the denial path (never a model-facing route).
  const module = await Deno.readTextFile(new URL("extension/lib/tab-tools-bundle.js", root));
  assert(module.includes(`"${TAB_TOOLS_BUNDLE_ID}"`), "the bundle module exists and names the id");
  const sw = await Deno.readTextFile(new URL("extension/background/service-worker.js", root));
  assert(sw.includes("offerTabToolsBundle"), "the service worker offers the bundle");
  assert(sw.includes("waitForInlinePermissionDecision"), "the offer sits on the inline-permission denial path");
  // The family is exactly the tab listing/grouping tools.
  assertEquals([...TAB_TOOLS_BUNDLE_FAMILY].sort(), [
    "group_tabs", "list_tab_groups", "list_tabs", "move_tab_to_group", "ungroup_tabs", "update_tab_group",
  ]);
  assertEquals([...TAB_TOOLS_BUNDLE_PERMISSIONS].sort(), ["tabGroups", "tabs"]);
});
