// @ts-nocheck
// CAP-FB-20260826-PERMISSIONS-SIMPLIFY-01 (owner P0) — in-context permission
// approvals. KATs for the sorting-hat demo's exact failure path and the
// security invariants of the new approval flow:
//  (a) the demo's group_tabs denial is STRUCTURED (waitingForPermission +
//      permissionRequirement) and the conversation surfaces an approval card;
//      Allow grants the EXACT scope and retries the turn; Deny grants nothing.
//  (b) grant semantics are preserved: an origins requirement sets ONLY the
//      origin-scoped grant (never the global form), the global form is sent
//      only for a genuinely-global requirement, a declined permission or a
//      failed grant set is honest (ok:false, nothing granted silently).
//  (e) the denial still carries the error text (the model sees an error) —
//      denial-when-not-approved is unchanged for every tool.
// Driven against the REAL extension/lib/browser-tools.js and the REAL
// extension/shared/conversation.js with stubbed chrome + a minimal fake DOM.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import {
  normalizePermissionRequirement,
  approvePermissionRequirement,
} from "../extension/shared/conversation.js";

// ── chrome shim (tabGroups + grant-capable, mirroring the REAL API shapes) ──
const store = new Map();
const granted = new Set();
const tabs = [];
const tabGroups = new Map();
let nextTabId = 1;
let nextGroupId = 1;
const permissionRequests = []; // recorded chrome.permissions.request calls

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  tabs.length = 0;
  tabGroups.clear();
  nextTabId = 1;
  nextGroupId = 1;
  permissionRequests.length = 0;
  clearRunFence();
}

function addTab(url, windowId = 1) {
  const tab = { id: nextTabId++, url, title: url, windowId, groupId: -1 };
  tabs.push(tab);
  return tab;
}

globalThis.chrome = {
  permissions: {
    contains: async ({ permissions }) => (permissions ?? []).every((p) => granted.has(p)),
    request: async ({ permissions }) => {
      permissionRequests.push([...(permissions ?? [])]);
      for (const p of (permissions ?? [])) granted.add(p);
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
      remove: async (key) => { for (const k of (Array.isArray(key) ? key : [key])) store.delete(k); },
    },
  },
  tabs: {
    get: async (id) => tabs.find((t) => t.id === id) ?? null,
    query: async () => [...tabs],
    group: async ({ tabIds }) => {
      const groupId = nextGroupId++;
      tabGroups.set(groupId, { id: groupId, title: "", color: "grey", collapsed: false, windowId: 1, tabIds: [...tabIds] });
      for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = groupId;
      return groupId;
    },
    ungroup: async (tabIds) => { for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = -1; },
  },
  tabGroups: {
    query: async () => [...tabGroups.values()],
    get: async (id) => tabGroups.get(id) ?? null,
    update: async (id, props) => {
      const g = tabGroups.get(id);
      if (!g) throw new Error("no such group");
      Object.assign(g, props);
      return { ...g };
    },
  },
};

function tools() {
  return browserToolset(false);
}

// ── (a) the demo's exact failure path is STRUCTURED ─────────────────────────

Deno.test("P0 demo path: group_tabs without the tabGroups permission denies with a STRUCTURED permission requirement", async () => {
  reset();
  addTab("https://a.example/1");
  const out = await tools().group_tabs.execute({ tabIds: [1] });
  assert(out?.error, "denial still carries the error text for the model");
  assertEquals(out.waitingForPermission, true, "the denial is a permission wait, not a plain error");
  const req = normalizePermissionRequirement(out);
  assert(req, "the structured requirement normalizes");
  assertEquals(req.permissions.sort(), ["tabGroups", "tabs"], "one approval covers BOTH Chrome permissions the tool needs");
  assertEquals(req.grantOrigins, []);
  assertEquals(req.grantGlobal, false);
});

Deno.test("P0 demo path: group_tabs with permissions but no browser-control grant denies with the EXACT origin scope", async () => {
  reset();
  granted.add("tabGroups");
  granted.add("tabs");
  addTab("https://a.example/1");
  addTab("https://b.example/2");
  const out = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assert(out?.error, "denial still carries the error text for the model");
  assertEquals(out.waitingForPermission, true);
  const req = normalizePermissionRequirement(out);
  assert(req, "the structured requirement normalizes");
  assertEquals(req.permissions, [], "the Chrome permissions are already granted — only the grant is missing");
  assertEquals(req.grantOrigins.sort(), ["https://a.example", "https://b.example"],
    "the grant scope is EXACTLY the tab origins the tool computed — never widened");
  assertEquals(req.grantGlobal, false, "an origin-scoped requirement must never ask for the global grant");
});

Deno.test("P0 demo path: an origin-less tab honestly requires the GLOBAL grant (and says so)", async () => {
  reset();
  granted.add("tabGroups");
  granted.add("tabs");
  addTab("https://a.example/1");
  addTab("chrome://extensions");
  await setOriginBrowserControlGrant(["https://a.example"]);
  const out = await tools().group_tabs.execute({ tabIds: [1, 2] });
  const req = normalizePermissionRequirement(out);
  assert(req, "the structured requirement normalizes");
  assertEquals(req.grantGlobal, true, "an origin-less tab forces the global grant (the tool's own semantics)");
  assertEquals(req.grantOrigins, [], "a global requirement never smuggles a fake origin list");
  assert(/all-sites|no single site/i.test(req.reason), "the card's reason must plainly say why global is needed");
});

Deno.test("P0 demo path: normalizePermissionRequirement fails closed on malformed/forged shapes", () => {
  assertEquals(normalizePermissionRequirement(null), null);
  assertEquals(normalizePermissionRequirement({ error: "plain error" }), null);
  assertEquals(normalizePermissionRequirement({ waitingForPermission: false, permissionRequirement: { permissions: ["tabs"] } }), null);
  assertEquals(normalizePermissionRequirement({ waitingForPermission: true }), null);
  assertEquals(normalizePermissionRequirement({ waitingForPermission: true, permissionRequirement: "tabs" }), null);
  assertEquals(normalizePermissionRequirement({ waitingForPermission: true, permissionRequirement: {} }), null, "an empty requirement is not approvable");
  const cleaned = normalizePermissionRequirement({
    waitingForPermission: true,
    permissionRequirement: {
      reason: "x".repeat(500),
      permissions: ["tabs", 7, null, "tabs"],
      grantOrigins: ["https://a.example", "not-a-url", "chrome://evil"],
      grantGlobal: false,
    },
  });
  assertEquals(cleaned.permissions, ["tabs"], "non-string/duplicate permissions are dropped");
  assertEquals(cleaned.grantOrigins, ["https://a.example"], "non-http(s) origins are dropped (a forged chrome:// can never be granted)");
  assert(cleaned.reason.length <= 240, "the reason is bounded");
});

// ── (b) the approval preserves the grant semantics ──────────────────────────

Deno.test("P0 approval: an origins requirement sets ONLY the origin-scoped grant (no silent global)", async () => {
  reset();
  const sent = [];
  const requestedPerms = [];
  const outcome = await approvePermissionRequirement(
    { reason: "group tabs", permissions: [], grantOrigins: ["https://a.example", "https://b.example"], grantGlobal: false },
    {
      sendFn: async (type, body) => { sent.push([type, body]); return { grant: { id: "g1", scope: "origins", origins: body.origins ?? [] } }; },
      requestPermissions: async (perms) => { requestedPerms.push([...perms]); return true; },
    },
  );
  assertEquals(outcome.ok, true);
  assertEquals(outcome.grantSet, true);
  const grantCalls = sent.filter(([type]) => type === "browser-control.set");
  assertEquals(grantCalls.length, 1, "exactly one grant write");
  assertEquals(grantCalls[0][1], { granted: true, origins: ["https://a.example", "https://b.example"] },
    "the grant is EXACTLY the requirement's origins — never widened, never the global form");
  assertEquals(requestedPerms, [["storage"]], "storage is requested so the grant persists (the Settings toggle's behaviour)");
});

Deno.test("P0 approval: a global requirement sends the global form ONLY because the tool required it", async () => {
  const sent = [];
  const outcome = await approvePermissionRequirement(
    { reason: "group tabs (origin-less)", permissions: [], grantOrigins: [], grantGlobal: true },
    {
      sendFn: async (type, body) => { sent.push([type, body]); return { grant: { id: "g2", scope: "global" } }; },
      requestPermissions: async () => true,
    },
  );
  assertEquals(outcome.ok, true);
  const grantCalls = sent.filter(([type]) => type === "browser-control.set");
  assertEquals(grantCalls, [["browser-control.set", { granted: true }]],
    "the global form is sent ONLY for a genuinely-global requirement");
});

Deno.test("P0 approval: Chrome permissions are requested exactly, first (they need the live gesture)", async () => {
  const sent = [];
  const requestedPerms = [];
  const outcome = await approvePermissionRequirement(
    { reason: "group tabs", permissions: ["tabGroups", "tabs"], grantOrigins: [], grantGlobal: false },
    {
      sendFn: async (type, body) => { sent.push([type, body]); return { grant: { id: "g3" } }; },
      requestPermissions: async (perms) => { requestedPerms.push([...perms]); return true; },
    },
  );
  assertEquals(outcome.ok, true);
  assertEquals(requestedPerms, [["tabGroups", "tabs"]], "the exact permissions are requested, nothing added");
  assertEquals(sent, [], "a permissions-only requirement never touches the grant");
});

Deno.test("P0 approval: a declined permission grants NOTHING (honest failure, no grant write)", async () => {
  const sent = [];
  const outcome = await approvePermissionRequirement(
    { reason: "group tabs", permissions: ["tabGroups"], grantOrigins: ["https://a.example"], grantGlobal: false },
    {
      sendFn: async (type, body) => { sent.push([type, body]); return { grant: { id: "g4" } }; },
      requestPermissions: async () => false, // the owner dismissed Chrome's prompt
    },
  );
  assertEquals(outcome.ok, false);
  assertEquals(outcome.permissionsGranted, false);
  assertEquals(sent, [], "the grant is never written when the permission was declined");
  assert(outcome.errors.length > 0, "the failure is surfaced, never swallowed");
});

Deno.test("P0 approval: a failed grant write is honest (ok:false, never claims success)", async () => {
  const outcome = await approvePermissionRequirement(
    { reason: "group tabs", permissions: [], grantOrigins: ["https://a.example"], grantGlobal: false },
    {
      sendFn: async () => ({ error: "backend exploded" }),
      requestPermissions: async () => true,
    },
  );
  assertEquals(outcome.ok, false);
  assertEquals(outcome.grantSet, false);
  assert(outcome.errors.join(" ").includes("backend exploded"), "the real error is surfaced");
});

// ── (e) denial-when-not-approved is unchanged for the demo's tools ──────────

Deno.test("P0 regression: after an approval grant the tool's real gates still hold (wrong-origin grant still denies)", async () => {
  reset();
  granted.add("tabGroups");
  granted.add("tabs");
  addTab("https://a.example/1");
  addTab("https://evil.example/2");
  // The owner approved a.example ONLY — grouping a tab on evil.example must
  // still deny, with a fresh structured requirement for the uncovered origin.
  await setOriginBrowserControlGrant(["https://a.example"]);
  const out = await tools().group_tabs.execute({ tabIds: [1, 2] });
  assert(out?.error && !out.ok, "an uncovered origin still denies");
  const req = normalizePermissionRequirement(out);
  assertEquals(req.grantOrigins.sort(), ["https://a.example", "https://evil.example"]);
  assertEquals(req.grantGlobal, false);
  // And with NO approval at all the mutation never happens.
  await revokeBrowserControlGrant();
  const denied = await tools().group_tabs.execute({ tabIds: [1] });
  assert(denied?.error && !denied.ok, "no grant → still denied (the gate is unchanged)");
  assertEquals(tabGroups.size, 0, "no group was created by a denied call");
});

// ── (a) the conversation surfaces the card in-context and Allow completes ──

// Minimal fake DOM for the approval card (attributes + listeners + append).
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
          sw.tasks.push(msg.task);
          // Hold long enough for the test to stream the denial MID-RUN (the
          // card only renders while this attempt owns the live subscription).
          setTimeout(() => cb({ ok: true, threadId: "t_perm", executionId: `exec:${msg.runId}`, result: "[demo] narrated" }), 200);
          return;
        }
        if (msg.type === "browser-control.set") {
          sw.grantCalls.push(msg);
          queueMicrotask(() => cb({ grant: { id: `g${sw.grantCalls.length}`, scope: msg.origins ? "origins" : "global", origins: msg.origins ?? [] } }));
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
      request: (req) => { sw.permissionRequests.push([...(req.permissions ?? [])]); return Promise.resolve(true); },
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

Deno.test("P0 conversation: a structured tool denial renders an in-context approval card; Allow grants the exact scope + retries", async () => {
  const sw = { runCount: 0, lastRunId: null, tasks: [], grantCalls: [], permissionRequests: [] };
  installConversationChromeStub(sw);
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const appended = [];
  const statuses = [];
  const turn = runConversationTurn(makeConversationContainer(appended), {
    text: "group my tabs by domain",
    onStatus: (s) => statuses.push(s),
  });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");
  // The SW streams the demo's exact denial: group_tabs → grant missing for the
  // tab origins (the structured requirement the tool now emits).
  const denial = {
    error: "browser control not granted for every tab origin here — ask the user to approve it in Settings",
    waitingForPermission: true,
    permissionRequirement: {
      reason: "group tabs on https://a.example",
      permissions: [],
      grantOrigins: ["https://a.example"],
      grantGlobal: false,
    },
  };
  portState.listener({ type: "progress", event: { type: "tool-call", runId: sw.lastRunId, toolName: "group_tabs", toolArgs: { tabIds: [1] } } });
  portState.listener({ type: "progress", event: { type: "tool-result", runId: sw.lastRunId, toolName: "group_tabs", result: denial, ok: true } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "the approval card renders");
  const card = appended.find((el) => el.tagName === "permission-approval-card");
  assertEquals(card.getAttribute("reason"), "group tabs on https://a.example");
  assertEquals(JSON.parse(card.getAttribute("origins")), ["https://a.example"], "the card shows the EXACT scope");
  assertEquals(card.getAttribute("global"), null, "no global claim for an origin-scoped requirement");
  assert(statuses.some((s) => s.state === "waiting-for-permission"), "the lifecycle surface reports the wait");
  await turn; // the first attempt settles (the model narrated the denial)
  assertEquals(sw.runCount, 1);
  // The owner clicks Allow (a browser-trusted click with live activation).
  await card.dispatch("approve", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => sw.grantCalls.length === 1, 500, "the scoped grant is written");
  assertEquals(sw.grantCalls[0].origins, ["https://a.example"], "Allow granted EXACTLY the card's scope — never widened");
  assert(sw.permissionRequests.some((p) => p.join() === "storage"), "storage requested so the grant persists");
  await waitForCondition(() => sw.runCount === 2, 1000, "the turn retries after the grant");
  assertEquals(sw.tasks[1], "group my tabs by domain", "the retry re-runs the owner's same task");
  await waitForCondition(() => card.getAttribute("state") === "granted", 500, "the card reports the grant");
});

Deno.test("P0 conversation: Deny grants nothing and never retries; a forged (untrusted) click is rejected", async () => {
  const sw = { runCount: 0, lastRunId: null, tasks: [], grantCalls: [], permissionRequests: [] };
  installConversationChromeStub(sw);
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), {
    text: "group my tabs by domain",
    onStatus: () => {},
  });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");
  const denial = {
    error: "browser control not granted for every tab origin here — ask the user to approve it in Settings",
    waitingForPermission: true,
    permissionRequirement: { reason: "group tabs", permissions: [], grantOrigins: ["https://a.example"], grantGlobal: false },
  };
  portState.listener({ type: "progress", event: { type: "tool-result", runId: sw.lastRunId, toolName: "group_tabs", result: denial, ok: true } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "the approval card renders");
  const card = appended.find((el) => el.tagName === "permission-approval-card");
  // A forged click (a script dispatching an untrusted event) grants NOTHING.
  await card.dispatch("approve", { sourceEvent: { isTrusted: false } });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(sw.grantCalls.length, 0, "an untrusted event can never grant");
  assertEquals(sw.permissionRequests.length, 0, "an untrusted event can never request permissions");
  // The owner declines for real.
  await card.dispatch("deny", { sourceEvent: { isTrusted: true } });
  await turn;
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(sw.grantCalls.length, 0, "Deny grants nothing");
  assertEquals(sw.runCount, 1, "Deny never retries the turn");
  assertEquals(card.getAttribute("state"), "denied");
});

// ── per-agent alarms P1-3: approval-card requirements (schedule mutations) ──

Deno.test("P1-3: a schedule-approval requirement (approvals[], no permissions) normalizes and APPROVES via the resolve authority", async () => {
  const { normalizePermissionRequirement, approvePermissionRequirement } = await import(
    `../extension/shared/conversation.js?conv-p13=${Date.now()}`
  );
  const raw = {
    ok: false,
    error: "This operation requires owner approval in Settings.",
    waitingForPermission: true,
    permissionRequirement: {
      reason: "task.pause: scheduled:10:task_1_abc",
      approvals: [{ approvalId: "ap_123", action: "task.pause" }],
    },
  };
  const req = normalizePermissionRequirement(raw);
  assert(req, "the approval-card requirement normalizes");
  assertEquals(req.approvals, [{ approvalId: "ap_123", action: "task.pause" }]);
  assertEquals(req.permissions, [], "no Chrome permissions are involved in a schedule approval");
  assert(req.key.startsWith("approvals|"), "the card key is approval-id derived (one card per approval)");

  const resolved = [];
  const sendFn = async (type, body) => {
    resolved.push([type, body]);
    return { ok: true };
  };
  const out = await approvePermissionRequirement(req, { sendFn, requestPermissions: async () => {
    throw new Error("a schedule approval must NEVER touch chrome.permissions");
  } });
  assertEquals(out.ok, true);
  assertEquals(resolved, [["management.resolve-approval", { approvalId: "ap_123", approve: true }]],
    "Allow resolves the EXACT pending approval through the SW authority");
});

Deno.test("P1-3: a malformed or failed approval requirement fails closed (no card, honest errors)", async () => {
  const { normalizePermissionRequirement, approvePermissionRequirement } = await import(
    `../extension/shared/conversation.js?conv-p13b=${Date.now()}`
  );
  // Forged/hostile shapes never become cards.
  assertEquals(normalizePermissionRequirement({
    waitingForPermission: true,
    permissionRequirement: { reason: "x", approvals: [{ approvalId: 42, action: "task.pause" }] },
  }), null, "a non-string approvalId is refused");
  assertEquals(normalizePermissionRequirement({
    waitingForPermission: true,
    permissionRequirement: { reason: "x", approvals: "ap_123" },
  }), null, "a non-array approvals field is refused");
  assertEquals(normalizePermissionRequirement({
    waitingForPermission: true,
    permissionRequirement: { reason: "x", approvals: [{ approvalId: "a".repeat(200), action: "task.pause" }] },
  }), null, "an over-long approvalId is refused");

  // A resolver failure surfaces honestly (never swallowed as success).
  const req = normalizePermissionRequirement({
    waitingForPermission: true,
    permissionRequirement: { reason: "task.pause: x", approvals: [{ approvalId: "ap_x", action: "task.pause" }] },
  });
  const out = await approvePermissionRequirement(req, {
    sendFn: async () => ({ ok: false, error: "approval expired" }),
  });
  assertEquals(out.ok, false);
  assert(out.errors[0].includes("approval expired"), "the resolver error is surfaced to the card");
});
