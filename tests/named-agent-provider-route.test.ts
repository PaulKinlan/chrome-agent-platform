// tests/named-agent-provider-route.test.ts — ROUTE-LEVEL (message-dispatcher)
// regression for the k3 HIGH-1 blank-save-preserves bug. The SW route
// `named-agent.set-provider` used to PRE-NORMALIZE the config (normalizeAgentProvider
// coerces an absent apiKey to "") before `setNamedAgentProvider`'s key-preservation
// guard ran, so the blank same-provider Save silently cleared the key. This drives
// the REAL dispatcher + the owner-approval dance (with an in-memory OPFS fake) so
// the pre-normalization path is exercised — not the lib function directly.

// @ts-nocheck — dynamic chrome/OPFS stubs (no types in Deno).
import { assert, assertEquals } from "jsr:@std/assert@1";

// ---- minimal in-memory OPFS fake (throws NotFoundError so readInstallKey
// creates + persists the owner-approval HMAC key across the dance) ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const n = this.node;
    return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw notFound(name);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw notFound(name);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const notFound = (name) => Object.assign(new Error(`not found: ${name}`), { name: "NotFoundError" });
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
});

Deno.test("named-agent.set-provider ROUTE: blank same-provider Save preserves the key through pre-normalization; explicit '' clears; swap isolates", async () => {
  const listeners = [];
  const noopListener = { addListener: () => {} };
  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onConnect: noopListener,
      onInstalled: noopListener,
      sendMessage: async () => {},
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
    permissions: { contains: async () => false, onAdded: noopListener, onRemoved: noopListener },
    alarms: { onAlarm: noopListener, create: () => {}, clear: () => {} },
    tabs: { onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener, onAttached: noopListener, onZoomChange: noopListener, query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {} },
    windows: { onCreated: noopListener, onRemoved: noopListener, onFocusChanged: noopListener },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noopListener },
    webNavigation: {},
    notifications: {},
  };
  await import("../extension/background/service-worker.js");

  const ownerSender = {
    id: "test-extension-id",
    url: "chrome-extension://test-extension-id/options/options.html",
    documentId: "doc-options-1",
    documentLifecycle: "active",
  };
  const dispatch = (msg, sender = ownerSender) => new Promise((resolve) => {
    for (const fn of [...listeners]) { try { fn(msg, sender, resolve); } catch { /* another listener's throw */ } }
  });

  // Seed the named agent with a deepseek override carrying a key.
  await dispatch({ type: "kv.set", values: {
    "cap:namedAgents": { probe: { id: "probe", name: "Probe", role: "", createdAt: 1, updatedAt: 1, provider: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1", apiKey: "sk-keep", model: "deepseek-chat" } } },
  } });

  // Helper: run the full owner-approval dance (first call → resolve → exact retry).
  const approvedSet = async (config) => {
    const first = await dispatch({ type: "named-agent.set-provider", id: "probe", config });
    if (first?.ok === true) return first;
    const pending = await dispatch({ type: "management.pending-approvals" });
    const approvalId = pending?.approvals?.[0]?.approvalId;
    assert(typeof approvalId === "string" && approvalId, "the mutation created a pending approval");
    const resolved = await dispatch({ type: "management.resolve-approval", approvalId, approve: true });
    assertEquals(resolved?.decision, "approved", "the owner approval resolves");
    return await dispatch({ type: "named-agent.set-provider", id: "probe", config });
  };

  // 1. Blank same-provider re-save: apiKey undefined (dropped by serialization)
  //    MUST carry the existing key forward (the k3 HIGH-1 contract).
  const blank = await approvedSet({ provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro" });
  assertEquals(blank?.ok, true, "blank save succeeds");
  assertEquals(blank?.agent?.provider?.hasApiKey, true, "blank same-provider Save PRESERVES the key");

  // 2. Provider SWAP with an absent key must NOT inherit the old key.
  const swapped = await approvedSet({ provider: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-4o" });
  assertEquals(swapped?.ok, true, "swap save succeeds");
  assertEquals(swapped?.agent?.provider?.hasApiKey, false, "swap does NOT inherit the old key");

  // 3. Explicit '' still clears (the Clear route contract).
  const cleared = await approvedSet({ provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "" });
  assertEquals(cleared?.ok, true, "explicit clear succeeds");
  assertEquals(cleared?.agent?.provider?.hasApiKey, false, "explicit '' clears the key");

  // 4. ROUTE VALIDATION: named-agent.create and named-agent.update with malformed profileGrants
  const getPendingCount = async () => {
    const pending = await dispatch({ type: "management.pending-approvals" });
    assertEquals(pending?.ok, true, "management.pending-approvals query must succeed");
    assert(Array.isArray(pending?.approvals), "pending.approvals must be an array");
    return pending.approvals.length;
  };

  const initialPending = await getPendingCount();

  // (a) CREATE with non-string entry [{}] -> fails closed, NO pending approval
  const rCreateObj = await dispatch({
    type: "named-agent.create",
    name: "Invalid Grants Obj",
    profileGrants: [{}],
  });
  assertEquals(rCreateObj?.ok, false);
  assert(rCreateObj?.error?.includes("must be a string"));
  assertEquals(await getPendingCount(), initialPending, "malformed create creates NO pending approval");

  // (b) CREATE with 33 grant entries (> 32 bound) -> fails closed, NO pending approval
  const rCreateHuge = await dispatch({
    type: "named-agent.create",
    name: "Invalid Grants Huge",
    profileGrants: Array.from({ length: 33 }, () => "profile:basic"),
  });
  assertEquals(rCreateHuge?.ok, false);
  assert(rCreateHuge?.error?.includes("exceeds maximum allowed length"));
  assertEquals(await getPendingCount(), initialPending, "oversized create creates NO pending approval");

  // (c) CREATE with null profileGrants -> fails closed, NO pending approval
  const rCreateNull = await dispatch({
    type: "named-agent.create",
    name: "Invalid Grants Null",
    profileGrants: null,
  });
  assertEquals(rCreateNull?.ok, false);
  assert(rCreateNull?.error?.includes("must be an array"));
  assertEquals(await getPendingCount(), initialPending, "null create creates NO pending approval");

  // (d) CREATE with VALID profileGrants succeeds
  const rCreateValid = await dispatch({
    type: "named-agent.create",
    id: "route-test-agent",
    name: "Route Test Agent",
    profileGrants: ["profile:basic"],
  });
  assertEquals(rCreateValid?.ok, true);
  assertEquals(rCreateValid?.agent?.profileGrants, ["profile:basic"]);

  // (e) UPDATE with non-string entry [{}] -> fails closed, NO pending approval
  const rUpdateObj = await dispatch({
    type: "named-agent.update",
    id: "route-test-agent",
    profileGrants: [{}],
  });
  assertEquals(rUpdateObj?.ok, false);
  assert(rUpdateObj?.error?.includes("must be a string"));
  assertEquals(await getPendingCount(), initialPending, "malformed update creates NO pending approval");

  // (f) UPDATE with 33 grant entries -> fails closed, NO pending approval
  const rUpdateHuge = await dispatch({
    type: "named-agent.update",
    id: "route-test-agent",
    profileGrants: Array.from({ length: 33 }, () => "profile:basic"),
  });
  assertEquals(rUpdateHuge?.ok, false);
  assert(rUpdateHuge?.error?.includes("exceeds maximum allowed length"));
  assertEquals(await getPendingCount(), initialPending, "oversized update creates NO pending approval");

  // (g) UPDATE with null profileGrants -> fails closed, NO pending approval
  const rUpdateNull = await dispatch({
    type: "named-agent.update",
    id: "route-test-agent",
    profileGrants: null,
  });
  assertEquals(rUpdateNull?.ok, false);
  assert(rUpdateNull?.error?.includes("must be an array"));
  assertEquals(await getPendingCount(), initialPending, "null update creates NO pending approval");
});
