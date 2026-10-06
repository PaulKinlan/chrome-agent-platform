// tests/named-agent-create-approval.test.ts — chrome-agent-platform-4h47,
// the acceptance for the `named-agent.create` half of the 51cd defect class.
//
// THE DEFECT. Three authorities declare `named-agent.create` approval-gated:
// extension/lib/owner-approval.js (DESTRUCTIVE_ACTIONS, and since this bead
// OWNER_DIRECT_ACTIONS for the owner's own gesture), docs/SW-DISPATCH-AUTHORITY-
// CENSUS.md §4.4, and the route's own `requireOwnerApproval` call. But
// `createNamedAgent` ran its seam only under
// `if (existing && typeof gateOnReplace === "function")` — so the FIRST-TIME
// create, which is exactly the case a model calling the `create_agent` tool
// produces, wrote a new agent record with NO owner-facing decision. The route
// CONTAINED the seam, so any "the route mentions the gate" assertion passed while
// the defect was live: completeness of a call site is not enforcement of it.
//
// WHAT THIS DRIVES. The REAL route through the MODEL path. The `named-agent.create`
// member is AST-selected out of service-worker.js's `handlers` object literal and
// run in node:vm together with the REAL extension/lib/owner-approval.js (approval
// store, digest, card) and the REAL extension/lib/named-agents.js (createNamedAgent,
// the registry, the OPFS sandbox write). Only run liveness, the UI port set,
// telemetry and the avatar generator are faked — the same harness shape as
// tests/hook-subscribe-approval.test.ts and tests/named-agent-provider-route.test.ts.
//
// THE MUTANT THIS FILE IS CALIBRATED AGAINST: restoring the old short-circuit in
// extension/lib/named-agents.js (`if (existing && typeof gateOnReplace ===
// "function")`) must turn test 1 and test 2 RED — no approval card at all, no
// pending row, and the ungated create landing in the registry.
// @ts-nocheck — dynamic chrome/OPFS stubs (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { runInNewContext } from "node:vm";
import * as approvals from "../extension/lib/owner-approval.js";
import * as namedAgents from "../extension/lib/named-agents.js";

// ---- in-memory chrome mock (copied from tests/hook-subscribe-approval.test.ts) ----
const store = new Map();
const granted = new Set(["storage"]); // the optional "storage" backend is on
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  permissions: {
    contains: async ({ permissions }) => permissions.every((p) => granted.has(p)),
  },
};

// ---- in-memory OPFS fake (the create path provisions the agent's own sandbox) ----
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
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const notFound = (name) => Object.assign(new Error(`not found: ${name}`), { name: "NotFoundError" });
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(dirNode()); } } },
  configurable: true,
});

const EXECUTION_ID = "exec-create";
const RESOLVER_DOCUMENT_ID = "doc-create-1";

/** Reset the fake chrome.storage.local (and re-grant "storage") between tests. */
function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
}

/**
 * Load the production route: AST-select the SW function declarations the model
 * path needs, plus the `named-agent.create` member out of the `handlers` map, and
 * run them in a fresh vm context populated with the REAL owner-approval and
 * named-agents modules. Returns the dispatcher the run would bind for a model
 * tool call, plus a direct call for the OWNER-context control.
 */
async function loadModelRoute(approvalStore) {
  const source = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const functionNames = [
    "dispatchRoute",
    "approvalExecutionId",
    "isOwnerPrincipal",
    "requireOwnerApproval",
    "namedCandidatePayload",
    "namedExistingPayload",
    "namedBoundMutationPayload",
    "payloadFields",
    "payloadStringArray",
  ];
  const functions = functionNames.map((name) => {
    const node = ast.body.find((n) => n.type === "FunctionDeclaration" && n.id.name === name);
    assert(node, `production function ${name} must exist`);
    return source.slice(node.start, node.end);
  });
  const handlers = ast.body
    .flatMap((n) => n.declarations ?? [])
    .find((n) => n.id.name === "handlers");
  assert(handlers, "the SW `handlers` route map must exist");
  const route = handlers.init.arguments
    .flatMap((n) => n.properties ?? [])
    .find((n) => n.key?.value === "named-agent.create");
  assert(route, "the actual named-agent.create dispatch member must exist");
  const dispatch = runInNewContext(
    `${functions.join("\n")}\nconst handlers = ({${source.slice(route.start, route.end)}}); dispatchRoute;`,
    {
      ...approvals,
      ...namedAgents,
      ownerApprovalStore: approvalStore,
      activeExecutions: new Set([EXECUTION_ID]),
      cancellingApprovalExecutions: new Set(),
      endedExecutions: new Set(),
      progressPorts: new Set(["conversation"]),
      opaqueTargetRef: async () => "opaque-test-ref",
      securityApprovalEvent: () => {},
      broadcastProgress: () => {},
      broadcastRegistryChanged: () => {},
      // The avatar follow-up is out of scope here; the create response is what
      // this file asserts. Stubbed so the success path completes.
      generateAvatarForCreatedAgent: async () => ({ attached: false }),
      attention: { cardOpened: () => {}, cardClosed: () => {} },
      setTimeout,
      clearTimeout,
    },
  );
  return {
    /** A MODEL tool call for `named-agent.create` (the run's own envelope). */
    bindCall: (onApprovalEvent) =>
      approvals.bindModelApprovalDispatcher(EXECUTION_ID, dispatch, onApprovalEvent, {
        agentId: "hub",
        resolverDocumentId: RESOLVER_DOCUMENT_ID,
      }),
    /** An OWNER call from an extension UI document with a browser-attested id. */
    callAsOwner: (body) => dispatch("named-agent.create", body, {
      principal: "extension",
      documentId: RESOLVER_DOCUMENT_ID,
      senderUrl: "chrome-extension://test-extension-id/ntp/ntp.html",
    }),
    dispatch,
  };
}

Deno.test("named-agent.create FIRST-TIME from the MODEL path publishes one owner approval card, writes NO agent, then LANDS on the approval", async () => {
  reset();
  // `listNamedAgents()` overlays the derived BUILT-IN background seeds, so the
  // persisted-registry question is asked of the specific slug (and of the
  // storage key) rather than of the list length.
  assertEquals(await namedAgents.getNamedAgent("create-pilot"), null, "precondition: create-pilot does not exist");
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);
  const body = { name: "Create Pilot", role: "round-trip tester" };

  // ---- 1. DENY: one card, one pending row, nothing persisted ----
  const deniedEvents = [];
  const denied = await bindCall(async (event) => {
    deniedEvents.push(event);
    if (event.type !== "approval-request") return;
    assertEquals(event.action, "named-agent.create", "the card names the route as the action");
    assertEquals(event.result.ok, false);
    assertEquals(event.result.waitingForPermission, true, "the model create must publish the approval card");
    // The gate sits INSIDE the registry-lock critical section, ahead of the
    // write — nothing may be persisted before the owner decides.
    assertEquals(await namedAgents.getNamedAgent("create-pilot"), null, "no agent may exist before the decision");
    assertEquals(store.has("cap:namedAgents"), false, "no registry key may exist before the decision");
    assertEquals(approvalStore.approvals.size, 1, "exactly one pending approval row");
    const pending = approvals.listPendingApprovals(approvalStore);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].action, "named-agent.create");
    // The target is the SLUG the registry itself will address the agent by.
    assertEquals(pending[0].target, approvals.canonicalOperationTarget("named", { id: "create-pilot" }));
    approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
  })("named-agent.create", body);

  assertEquals(
    deniedEvents.filter((e) => e.type === "approval-request").length,
    1,
    "a FIRST-TIME model create must publish exactly one owner approval card",
  );
  assertEquals(denied.ok, false, `the denied create must refuse: ${JSON.stringify(denied)}`);
  assertEquals(denied.approvalDenied, true);
  assertEquals(denied.action, "named-agent.create");
  assertEquals(approvalStore.approvals.size, 0, "the denied row is removed, not left claimable");
  assertEquals(await namedAgents.getNamedAgent("create-pilot"), null, "a denied create writes no agent");
  assertEquals(store.has("cap:namedAgents"), false, "a denied create writes no registry key");

  // ---- 2. APPROVE: the SAME call lands (a payload builder that refuses every
  //         create would fail HERE — the trap 51cd recorded) ----
  const grantedEvents = [];
  const granted = await bindCall(async (event) => {
    grantedEvents.push(event);
    if (event.type !== "approval-request") return;
    assertEquals(approvalStore.approvals.size, 1);
    approvals.resolvePendingApproval(approvalStore, event.approvalId, true);
  })("named-agent.create", body);

  assertEquals(
    grantedEvents.filter((e) => e.type === "approval-request").length,
    1,
    "the approved create asked exactly once",
  );
  assertEquals(granted.ok, true, `the approved create must land: ${JSON.stringify(granted)}`);
  assertEquals(granted.agent?.id, "create-pilot");
  assertEquals(granted.agent?.name, "Create Pilot");
  assertEquals(approvalStore.approvals.size, 0, "the decision is consumed, not reusable");
  assertEquals((await namedAgents.getNamedAgent("create-pilot"))?.name, "Create Pilot", "the approved create persists the agent");
});

Deno.test("named-agent.create's create-path payload is DETERMINISTIC, so an approved retry can match it (and a different request cannot)", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);

  /** Run a denied create and return the digest of the row it raised. */
  const digestOf = async (body) => {
    let digest = null;
    const call = bindCall(async (event) => {
      if (event.type !== "approval-request") return;
      const entry = approvalStore.approvals.get(event.approvalId);
      assert(entry, "the card names a live pending row");
      digest = entry.digest;
      approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
    });
    const result = await call("named-agent.create", body);
    assertEquals(result.ok, false, "a denied create refuses");
    assert(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest), `a digest was raised: ${digest}`);
    return digest;
  };

  const first = await digestOf({ name: "Retry Target", role: "same request" });
  const retry = await digestOf({ name: "Retry Target", role: "same request" });
  assertEquals(
    retry,
    first,
    "the SAME request must produce the SAME digest: the exact-retry consumption matches on it, so a " +
      "create path whose absent-row form varied per call (a timestamp, a fresh uuid, the candidate's own " +
      "instanceId/revision) could never be approved on a retry",
  );
  const different = await digestOf({ name: "Retry Target", role: "different request" });
  assert(
    different !== first,
    "a different request must NOT share the digest — the approval binds the exact candidate",
  );
  assertEquals(await namedAgents.getNamedAgent("retry-target"), null, "no digest probe persisted an agent");
});

Deno.test("named-agent.create from an OWNER document is direct (no card), and the create still lands", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { callAsOwner } = await loadModelRoute(approvalStore);

  // The owner's own Create click in an extension UI document IS the approval
  // (added to OWNER_DIRECT_ACTIONS by this bead, the reviewable precedent of its
  // sibling named-agent.update). No card, no pending row, and the create lands —
  // the hub's primary create flow must not regress into "approve it in Settings".
  const result = await callAsOwner({ id: "owner-created", name: "Owner Created", role: "owner gesture" });
  assertEquals(result.ok, true, `the owner's direct create must land: ${JSON.stringify(result)}`);
  assertEquals(result.agent?.id, "owner-created");
  assertEquals(approvalStore.approvals.size, 0, "an owner-direct create raises no pending row");
  assert(await namedAgents.getNamedAgent("owner-created"), "the owner's direct create persisted the agent");
});

Deno.test("a MODEL create is NOT owner-direct, even when the model is hosted in an extension document", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { dispatch } = await loadModelRoute(approvalStore);

  // `principal` and `documentId` are authority fields: dispatchRoute strips them
  // from the message body, and the model principal comes only from the run's own
  // context. A model that forges them in the body must still pay the card.
  let sawCard = false;
  const forged = await dispatch("named-agent.create", {
    id: "forged-owner",
    name: "Forged Owner",
    role: "impersonation attempt",
    principal: "extension",
    documentId: RESOLVER_DOCUMENT_ID,
    __context: { principal: "extension", documentId: RESOLVER_DOCUMENT_ID },
    userActivation: true,
  }, { principal: "model", executionId: EXECUTION_ID, onApprovalEvent: async (event) => {
    if (event.type !== "approval-request") return;
    sawCard = true;
    approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
  } });

  assert(sawCard, "a body-supplied owner identity must not bypass the model's approval card");
  assertEquals(forged.ok, false);
  assertEquals(await namedAgents.getNamedAgent("forged-owner"), null, "the forged create wrote nothing");
  assertEquals(approvalStore.approvals.size, 0);
});
