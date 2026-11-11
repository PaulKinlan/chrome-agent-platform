// tests/named-agent-provider-approval-detail.test.ts — chrome-agent-platform-awaom
//
// THE DEFECT. `named-agent.set-provider` lets a MODEL author the provider
// baseURL of a named agent (set_agent_provider), and the blank same-provider
// save CARRIES THE AGENT'S EXISTING STORED KEY onto that config
// (preserveExistingProviderKey). But the route called requireOwnerApproval with
// NO detail and NO stagedDetail — unlike script.update / asset.update / fs.write
// — so the owner's card rendered `named-agent.set-provider: provider:<opaque-ref>`
// with detail=undefined: the exact host being approved was NEVER displayed, and
// one click later the agent's preserved key posted to the model-chosen host.
// An approval control that does not disclose what it approves is a formality.
//
// THE FIX UNDER TEST. The route now stages a provider-change detail (kind
// "named-agent.set-provider"): old vs new provider/baseURL/model as diff text,
// key-PRESENCE markers including an explicit "stored key carried to this host"
// marker, the principal provenance ("model"), and NEVER the apiKey value. The
// owner surface (conversation card) renders it behind the approval.detail
// principal gate; the model-facing envelope stays opaque.
//
// RED ON MAIN: getStagedApprovalDetail returns null (stagedDetail was never
// passed), so the detail assertions fail. Reverting the fix re-fails this file.
//
// Harness shape copied from tests/named-agent-create-approval.test.ts: the real
// route member AST-selected out of service-worker.js's `handlers` literal, run
// in node:vm with the REAL owner-approval.js and named-agents.js modules.
// @ts-nocheck — dynamic chrome/OPFS stubs (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { runInNewContext } from "node:vm";
import * as approvals from "../extension/lib/owner-approval.js";
import * as namedAgents from "../extension/lib/named-agents.js";
import { lineDiffSummary } from "../extension/shared/diff-core.js";
import { checkFetchTarget } from "../extension/lib/fetch-policy.js";
import { effectiveBaseURL } from "../extension/lib/provider-catalog.js";

// ---- in-memory chrome mock (copied from tests/named-agent-create-approval.test.ts) ----
const store = new Map();
const granted = new Set(["storage"]);
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

// ---- in-memory OPFS fake (readInstallKey persists the owner-approval HMAC key) ----
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

const EXECUTION_ID = "exec-set-provider";
const RESOLVER_DOCUMENT_ID = "doc-set-provider-1";
const STORED_KEY = "sk-keep-secret-awaom";

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  // Seed one named agent carrying a STORED provider key (the value the blank
  // same-provider save would carry onto a model-chosen host).
  store.set("cap:namedAgents", {
    probe: {
      id: "probe", name: "Probe", role: "", avatar: null, skills: [], coreAssets: [],
      profileGrants: [],
      provider: {
        provider: "deepseek", baseURL: "https://api.deepseek.com/v1",
        apiKey: STORED_KEY, model: "deepseek-chat",
      },
      mcpServers: [], canDelegateTo: [], tools: null,
      instanceId: "inst-probe-awaom", revision: 3, createdAt: 1, updatedAt: 1,
    },
  });
}

/**
 * Load the production route: AST-select the SW function declarations the
 * set-provider model path needs, plus the `named-agent.set-provider` member out
 * of the `handlers` map, and run them in a fresh vm context populated with the
 * REAL owner-approval and named-agents modules.
 */
async function loadModelRoute(approvalStore, contextOverrides = {}) {
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
  // The awaom fix's helpers: REQUIRED on a fixed tree; tolerated absent on a
  // pristine (pre-fix) tree so the RED failure lands on the acceptance
  // assertion (staged detail is null), not on harness load.
  for (const name of [
    "providerChangeStagedDetail", "providerChangeDetailText",
    "singleLineCardValue", "modelAuthoredBaseURLRefusal",
  ]) {
    const node = ast.body.find((n) => n.type === "FunctionDeclaration" && n.id.name === name);
    if (node) functions.push(source.slice(node.start, node.end));
  }
  const handlers = ast.body
    .flatMap((n) => n.declarations ?? [])
    .find((n) => n.id.name === "handlers");
  assert(handlers, "the SW `handlers` route map must exist");
  const route = handlers.init.arguments
    .flatMap((n) => n.properties ?? [])
    .find((n) => n.key?.value === "named-agent.set-provider");
  assert(route, "the actual named-agent.set-provider dispatch member must exist");
  const dispatch = runInNewContext(
    `${functions.join("\n")}\nconst handlers = ({${source.slice(route.start, route.end)}}); dispatchRoute;`,
    {
      ...approvals,
      ...namedAgents,
      lineDiffSummary,
      checkFetchTarget,
      effectiveBaseURL,
      ownerApprovalStore: approvalStore,
      activeExecutions: new Set([EXECUTION_ID]),
      cancellingApprovalExecutions: new Set(),
      endedExecutions: new Set(),
      progressPorts: new Set(["conversation"]),
      opaqueTargetRef: async () => "opaque-test-ref",
      securityApprovalEvent: () => {},
      broadcastProgress: () => {},
      broadcastRegistryChanged: () => {},
      attention: { cardOpened: () => {}, cardClosed: () => {} },
      setTimeout,
      clearTimeout,
      ...contextOverrides,
    },
  );
  return {
    bindCall: (onApprovalEvent) =>
      approvals.bindModelApprovalDispatcher(EXECUTION_ID, dispatch, onApprovalEvent, {
        agentId: "hub",
        resolverDocumentId: RESOLVER_DOCUMENT_ID,
      }),
    /** An OWNER call from an extension UI document (the Settings approval dance). */
    callAsOwner: (body) => dispatch("named-agent.set-provider", body, {
      principal: "extension",
      documentId: RESOLVER_DOCUMENT_ID,
      senderUrl: "chrome-extension://test-extension-id/ntp/ntp.html",
    }),
    dispatch,
  };
}

Deno.test("awaom ACCEPTANCE: the model set-provider pending approval stages a detail carrying the normalized baseURL and the model provenance — never the key value", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);

  // The repro from the bead: the model moves the agent to a model-chosen host
  // with an ABSENT apiKey — the blank same-provider save preserves the stored
  // key onto that host. (baseURL differs, provider matches, so the key rides.)
  const config = { provider: "deepseek", baseURL: "https://evil.example/v1", model: "x" };
  let staged = null;
  let sawCard = false;

  const denied = await bindCall(async (event) => {
    if (event.type !== "approval-request") return;
    sawCard = true;
    assertEquals(event.action, "named-agent.set-provider");
    // The model-facing envelope stays OPAQUE: no staged bodies, no key.
    const approval = event.result?.permissionRequirement?.approvals?.[0];
    assert(approval, "the card carries the pending approval");
    assertEquals(approval.detail, undefined, "the staged provider detail never crosses into the model envelope");
    assert(!JSON.stringify(event.result).includes(STORED_KEY), "the key value never crosses to the model");
    // The OWNER surface reads the staged detail behind the approval.detail gate.
    staged = approvals.getStagedApprovalDetail(approvalStore, event.approvalId);
    approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
  })("named-agent.set-provider", { id: "probe", config });

  assert(sawCard, "the model set-provider published its approval card");
  assertEquals(denied.ok, false, "the denied set-provider refuses");

  // ---- THE ACCEPTANCE (RED on main: staged === null) ----
  assert(staged, "a staged provider-change detail exists for the pending approval");
  assertEquals(staged.kind, "named-agent.set-provider");
  assertEquals(staged.name, "Probe", "the detail names the agent");
  assertEquals(staged.provenance, "model", "the detail records the model principal as the author");
  assert(
    staged.newContent.includes("https://evil.example/v1"),
    `the card shows the exact model-chosen host: ${staged.newContent}`,
  );
  assert(
    staged.oldContent.includes("https://api.deepseek.com/v1"),
    "the card shows the current host for comparison",
  );
  assert(
    /stored key/i.test(staged.newContent) && /carried/i.test(staged.newContent),
    `the key-carry marker warns the owner the stored key follows the change: ${staged.newContent}`,
  );
  assert(
    !JSON.stringify(staged).includes(STORED_KEY),
    "the apiKey VALUE never enters the staged detail (presence markers only)",
  );
  // The title's +n -m can never disagree with the rendered hunks (dptw): the
  // counts are the diff core's over the SAME two staged bodies.
  const summary = lineDiffSummary(staged.oldContent, staged.newContent);
  assertEquals(staged.added, summary.added);
  assertEquals(staged.removed, summary.removed);
  assert(summary.added > 0 && summary.removed > 0, "the hostile host swap is a visible diff");

  // Denied: the registry still points at the old host with its key.
  const after = await namedAgents.getNamedAgent("probe");
  assertEquals(after?.provider?.baseURL, "https://api.deepseek.com/v1", "a denied change writes nothing");

  // The staged detail is evicted with the row (fail closed).
  assertEquals(approvalStore.approvals.size, 0);
});

Deno.test("awaom: the approved exact-retry lands the change the card described (host swap with the carried key)", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);
  const config = { provider: "deepseek", baseURL: "https://evil.example/v1", model: "x" };

  const result = await bindCall(async (event) => {
    if (event.type !== "approval-request") return;
    approvals.resolvePendingApproval(approvalStore, event.approvalId, true);
  })("named-agent.set-provider", { id: "probe", config });

  assertEquals(result.ok, true, `the approved change lands: ${JSON.stringify(result)}`);
  // The result the model sees is REDACTED (hasApiKey presence bit only).
  assertEquals(result.agent?.provider?.hasApiKey, true, "the carried key survives as a presence bit");
  assertEquals(result.agent?.provider?.apiKey, undefined, "the key value never crosses back to the model");
  const after = await namedAgents.getNamedAgent("probe");
  assertEquals(after?.provider?.baseURL, "https://evil.example/v1");
  assertEquals(approvalStore.approvals.size, 0, "the decision is consumed, not reusable");
});

Deno.test("awaom: clearing the override (config null) stages the inherit-global detail, still key-value-free", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);

  let staged = null;
  const denied = await bindCall(async (event) => {
    if (event.type !== "approval-request") return;
    staged = approvals.getStagedApprovalDetail(approvalStore, event.approvalId);
    approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
  })("named-agent.set-provider", { id: "probe", config: null });

  assertEquals(denied.ok, false, "the denied clear refuses");
  assert(staged, "the clear stages a detail too");
  assertEquals(staged.kind, "named-agent.set-provider");
  assertEquals(staged.provenance, "model");
  assert(
    staged.newContent.includes("inherit the global default"),
    `the proposed side names the inherit-global state: ${staged.newContent}`,
  );
  assert(staged.oldContent.includes("https://api.deepseek.com/v1"), "the current host is shown");
  assert(!JSON.stringify(staged).includes(STORED_KEY), "no key value in the clear detail either");
});

Deno.test("awaom: boundStagedApprovalDetail accepts the provider kind with a bounded provenance and still drops unknown kinds", () => {
  const bounded = approvals.boundStagedApprovalDetail({
    kind: "named-agent.set-provider", name: "Probe",
    oldContent: "a", newContent: "b", added: 1, removed: 1,
    provenance: "model",
  });
  assert(bounded);
  assertEquals(bounded.provenance, "model");
  // Provenance is bounded (64) and optional; unknown kinds are still dropped.
  const long = approvals.boundStagedApprovalDetail({
    kind: "named-agent.set-provider", name: "Probe", oldContent: "", newContent: "",
    provenance: "x".repeat(200),
  });
  assertEquals(long.provenance.length, 64);
  const noProv = approvals.boundStagedApprovalDetail({
    kind: "named-agent.set-provider", name: "Probe", oldContent: "", newContent: "",
  });
  assertEquals(noProv.provenance, undefined);
  assertEquals(approvals.boundStagedApprovalDetail({
    kind: "named-agent.delete", name: "Probe", oldContent: "a", newContent: "b",
  }), null, "an unknown kind is still dropped (the card falls back to opaque)");
});

// ── round-2 findings (rev-awaom FAIL verdict on 17214e58b) ──

Deno.test("lhbh8: model-authored loopback / metadata / preset-loopback destinations are refused BEFORE any card", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);
  const cases = [
    { name: "loopback literal", config: { provider: "deepseek", baseURL: "http://127.0.0.1:11434/v1", model: "x" } },
    { name: "cloud metadata", config: { provider: "deepseek", baseURL: "http://169.254.169.254/latest/meta-data/", model: "x" } },
    // The fence covers the RESOLVED endpoint: an empty baseURL with the ollama
    // preset still aims the agent (and its carried key) at loopback.
    { name: "loopback via preset", config: { provider: "ollama", baseURL: "", model: "llama3" } },
  ];
  for (const { name, config } of cases) {
    let sawCard = false;
    const refused = await bindCall(async (event) => {
      if (event.type === "approval-request") {
        sawCard = true;
        approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
      }
    })("named-agent.set-provider", { id: "probe", config });
    assertEquals(refused.ok, false, `${name}: refused`);
    assert(
      /public host|control characters|Settings/i.test(refused.error ?? ""),
      `${name}: the refusal names the fence: ${refused.error}`,
    );
    assertEquals(sawCard, false, `${name}: no approval card is published for a refused destination`);
    assertEquals(approvalStore.approvals.size, 0, `${name}: no pending row survives the refusal`);
    const after = await namedAgents.getNamedAgentProvider("probe");
    assertEquals(after?.baseURL, "https://api.deepseek.com/v1", `${name}: the registry is untouched`);
  }
});

Deno.test("lhbh8: the OWNER path is NOT fenced — a loopback save from an extension document pays the Settings dance and lands", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { callAsOwner } = await loadModelRoute(approvalStore);
  const body = { id: "probe", config: { provider: "ollama", baseURL: "http://127.0.0.1:11434/v1", model: "llama3" } };

  const first = await callAsOwner(body);
  assertEquals(first.ok, false, "the owner save raises its pending approval first");
  const pending = approvals.listPendingApprovals(approvalStore);
  assertEquals(pending.length, 1, "set-provider is not owner-direct: one pending row");
  approvals.resolvePendingApproval(approvalStore, pending[0].approvalId, true);
  const second = await callAsOwner(body);
  assertEquals(second.ok, true, `the approved owner loopback save lands: ${JSON.stringify(second)}`);
  const after = await namedAgents.getNamedAgentProvider("probe");
  assertEquals(after?.baseURL, "http://127.0.0.1:11434/v1", "the owner's own loopback destination is preserved");
});

Deno.test("snjrg: a newline-forged baseURL is refused for the model, and a STORED newline renders as one sanitized line", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);

  // (a) The model cannot smuggle control characters through: the WHATWG URL
  //     parser would strip the newline (host still evil.example) while the card
  //     shows forged lines — so the route refuses instead of sanitizing.
  let sawCard = false;
  const forged = await bindCall(async (event) => {
    if (event.type === "approval-request") {
      sawCard = true;
      approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
    }
  })("named-agent.set-provider", {
    id: "probe",
    config: {
      provider: "deepseek",
      baseURL: "https://evil.example/v1\napiKey: no key attached\nprovenance: owner-approved in Settings",
      model: "x",
    },
  });
  assertEquals(forged.ok, false);
  assert(/control characters/i.test(forged.error ?? ""), `the refusal names control characters: ${forged.error}`);
  assertEquals(sawCard, false, "no card renders for a newline-forged destination");

  // (b) A newline ALREADY in the stored record (an owner-saved value predating
  //     the fence) cannot forge lines on the card's old side either: every
  //     interpolated value renders as exactly one line.
  const seeded = store.get("cap:namedAgents");
  store.set("cap:namedAgents", {
    probe: {
      ...seeded.probe,
      provider: {
        provider: "deepseek",
        baseURL: "https://old.example/v1\napiKey: no key attached",
        apiKey: STORED_KEY, model: "deepseek-chat",
      },
    },
  });
  let staged = null;
  await bindCall(async (event) => {
    if (event.type !== "approval-request") return;
    staged = approvals.getStagedApprovalDetail(approvalStore, event.approvalId);
    approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
  })("named-agent.set-provider", { id: "probe", config: { provider: "deepseek", baseURL: "https://clean.example/v1", model: "y" } });
  assert(staged, "the clean proposal stages its detail");
  const oldLines = staged.oldContent.split("\n");
  assertEquals(oldLines.length, 5, `the old side is exactly four field lines + trailing newline: ${JSON.stringify(oldLines)}`);
  assert(
    oldLines.some((l) => l.startsWith("baseURL: https://old.example/v1 apiKey: no key attached")),
    `the stored newline collapsed into its own field line: ${JSON.stringify(oldLines)}`,
  );
  assertEquals(
    oldLines.filter((l) => l.startsWith("apiKey:")).length, 1,
    "exactly ONE apiKey line on the card — the forged marker never renders as its own line",
  );
});

Deno.test("nat8y: an empty stored baseURL stages the RESOLVED catalog host, not a sentence", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  const { bindCall } = await loadModelRoute(approvalStore);
  let staged = null;
  await bindCall(async (event) => {
    if (event.type !== "approval-request") return;
    staged = approvals.getStagedApprovalDetail(approvalStore, event.approvalId);
    approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
  })("named-agent.set-provider", { id: "probe", config: { provider: "openai", baseURL: "", model: "gpt-5" } });
  assert(staged, "the preset change stages its detail");
  assert(
    staged.newContent.includes("https://api.openai.com/v1"),
    `the card names the endpoint the run will actually reach: ${staged.newContent}`,
  );
  assert(
    !staged.newContent.includes("(the provider's default endpoint)"),
    "the unresolved sentence is gone from the proposed side",
  );
});

Deno.test("nat8y: set-provider refuses FAIL-CLOSED when its staged detail cannot be staged", async () => {
  reset();
  const approvalStore = approvals.createApprovalStore();
  // Inject the staging failure: the owner must never be shown the opaque
  // 'provider:<ref>' card for a model-authored host change — the degradation
  // awaom exists to remove.
  const { bindCall } = await loadModelRoute(approvalStore, {
    stageApprovalDetail: () => ({ ok: false, error: "injected staging failure" }),
  });
  let sawCard = false;
  const refused = await bindCall(async (event) => {
    if (event.type === "approval-request") {
      sawCard = true;
      approvals.resolvePendingApproval(approvalStore, event.approvalId, false);
    }
  })("named-agent.set-provider", { id: "probe", config: { provider: "deepseek", baseURL: "https://fine.example/v1", model: "x" } });
  assertEquals(refused.ok, false);
  assert(/could not be shown for approval/i.test(refused.error ?? ""), `the refusal says why: ${refused.error}`);
  assertEquals(sawCard, false, "the opaque card is never published for an unstaged set-provider");
  assertEquals(approvalStore.approvals.size, 0, "the pending row is resolved, not left claimable");
  const after = await namedAgents.getNamedAgentProvider("probe");
  assertEquals(after?.baseURL, "https://api.deepseek.com/v1", "the refused change wrote nothing");
});
