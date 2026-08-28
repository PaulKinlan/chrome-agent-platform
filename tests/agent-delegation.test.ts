// @ts-nocheck
// Agent→agent delegation (AGENT-PRODUCT-GAPS G5; owner directive 2026-08-28:
// "agents invocable as skills"). Falsification-gated KATs for the REAL modules:
//
//  (1) GUARDS (lib/agent-delegation.js — the exact decision logic the
//      named-agent.delegate route calls): allowed edge → child budget; target
//      NOT in canDelegateTo → structured denial; A→B→A cycle → rejected;
//      depth 3 → rejected; descendant cap → rejected; budget exhaustion →
//      rejected; a forged/mismatched caller identity → rejected.
//  (2) REGISTRY: descendant counting, cap refusal, release-on-settle, eviction.
//  (3) RECORD: createNamedAgent/updateNamedAgent persist + normalize
//      canDelegateTo through the REAL registry (chrome + OPFS mocks, the
//      named-agents.test.ts pattern).
//  (4) TOOL WIRING: managementToolset's delegate_to_agent forwards the BOUND
//      delegation context AFTER the model args (a forged __delegation in the
//      model's args can never win); the tool is in the capability inventory.
//  (5) AUDIT: appendDelegationAudit bounds the log and records the exact
//      shape (parent run id → child run id, agents, bounded task, outcome).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  CHILD_ITERATION_CAP,
  DELEGATION_AUDIT_KEY,
  DELEGATION_AUDIT_MAX,
  MAX_DELEGATION_DEPTH,
  MAX_DELEGATION_DESCENDANTS,
  appendDelegationAudit,
  createDelegationRegistry,
  delegationAuditRecord,
  evaluateDelegation,
  normalizeCanDelegateTo,
  resolveTargetAgent,
} from "../extension/lib/agent-delegation.js";
import { managementToolset, MANAGEMENT_TOOL_NAMES } from "../extension/lib/management-tools.js";
import { MANAGEMENT_CAPABILITY_TOOL_NAMES } from "../extension/lib/chrome-tool-capabilities.js";

// ── (1) guard KATs ──────────────────────────────────────────────────────────

const chief = { id: "chief-of-staff", name: "Chief of Staff", canDelegateTo: ["research-analyst", "critic"] };
const researcher = { id: "research-analyst", name: "Research Analyst", canDelegateTo: ["chief-of-staff"] };
const critic = { id: "critic", name: "Critic", canDelegateTo: [] };
const ALL = [chief, researcher, critic];

function rootState(over = {}) {
  return {
    agentId: "chief-of-staff",
    rootRunId: "exec-root",
    depth: 0,
    path: ["chief-of-staff"],
    maxIterations: 12,
    step: 0,
    ...over,
  };
}

Deno.test("delegation guard: an allowed edge delegates with a bounded child budget", () => {
  const verdict = evaluateDelegation({
    callerAgent: chief,
    targetAgent: researcher,
    state: rootState(),
    descendantCount: 0,
  });
  assertEquals(verdict.ok, true);
  assertEquals(verdict.child.depth, 1);
  assertEquals(verdict.child.path, ["chief-of-staff", "research-analyst"]);
  assertEquals(verdict.child.maxIterations, CHILD_ITERATION_CAP, "child is capped well inside the parent's budget");
});

Deno.test("delegation guard: a target NOT in canDelegateTo is denied (empty list denies everything)", () => {
  const denied = evaluateDelegation({
    callerAgent: critic, // canDelegateTo: []
    targetAgent: researcher,
    state: rootState({ agentId: "critic", path: ["critic"] }),
    descendantCount: 0,
  });
  assertEquals(denied.ok, false);
  assertEquals(denied.code, "delegation-not-allowed");
  assertStringIncludes(denied.error, "Can delegate to");
});

Deno.test("delegation guard: A→B→A cycle is rejected even when every edge is allowed", () => {
  // chief → researcher (allowed); researcher tries to delegate BACK to chief
  // (allowed edge on researcher's record!) — the path already contains chief.
  const verdict = evaluateDelegation({
    callerAgent: researcher,
    targetAgent: chief,
    state: rootState({
      agentId: "research-analyst",
      depth: 1,
      path: ["chief-of-staff", "research-analyst"],
    }),
    descendantCount: 1,
  });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.code, "delegation-cycle");
  assertStringIncludes(verdict.error, "chief-of-staff");
});

Deno.test("delegation guard: self-delegation is a cycle denial", () => {
  const verdict = evaluateDelegation({
    callerAgent: chief,
    targetAgent: chief,
    state: rootState(),
    descendantCount: 0,
  });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.code, "delegation-cycle");
});

Deno.test("delegation guard: depth beyond the cap is rejected (depth 2 cannot delegate)", () => {
  // The caller has a VALID edge (chief → researcher) — only the depth is over.
  const verdict = evaluateDelegation({
    callerAgent: chief,
    targetAgent: researcher,
    state: rootState({
      agentId: "chief-of-staff",
      depth: MAX_DELEGATION_DEPTH,
      path: ["chief-of-staff", "critic", "chief-of-staff"], // target NOT in path — depth, not cycle, must fire
    }),
    descendantCount: 2,
  });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.code, "delegation-depth");
});

Deno.test("delegation guard: the descendant cap refuses the (cap+1)-th child of a root run", () => {
  const verdict = evaluateDelegation({
    callerAgent: chief,
    targetAgent: researcher,
    state: rootState(),
    descendantCount: MAX_DELEGATION_DESCENDANTS,
  });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.code, "delegation-cap");
});

Deno.test("delegation guard: the child never exceeds the parent's REMAINING budget; an exhausted budget denies", () => {
  const tight = evaluateDelegation({
    callerAgent: chief,
    targetAgent: researcher,
    state: rootState({ maxIterations: 12, step: 8 }), // 4 remaining
    descendantCount: 0,
  });
  assertEquals(tight.ok, true);
  assertEquals(tight.child.maxIterations, 4, "child capped at the parent's remaining iterations");
  const exhausted = evaluateDelegation({
    callerAgent: chief,
    targetAgent: researcher,
    state: rootState({ maxIterations: 12, step: 11 }), // 1 remaining
    descendantCount: 0,
  });
  assertEquals(exhausted.ok, false);
  assertEquals(exhausted.code, "delegation-budget");
});

Deno.test("delegation guard: a forged caller identity (record id ≠ run state) is denied", () => {
  const verdict = evaluateDelegation({
    callerAgent: researcher, // the RECORD
    targetAgent: critic,
    state: rootState(), // the RUN claims chief-of-staff
    descendantCount: 0,
  });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.code, "delegation-context");
});

Deno.test("delegation guard: unknown target and missing state fail closed", () => {
  const noTarget = evaluateDelegation({ callerAgent: chief, targetAgent: null, state: rootState(), descendantCount: 0 });
  assertEquals(noTarget.ok, false);
  assertEquals(noTarget.code, "delegation-target");
  const noState = evaluateDelegation({ callerAgent: chief, targetAgent: researcher, state: null, descendantCount: 0 });
  assertEquals(noState.ok, false);
  assertEquals(noState.code, "delegation-context");
});

Deno.test("delegation resolution: id match wins; exact name resolves; ambiguous name resolves nothing", () => {
  assertEquals(resolveTargetAgent("critic", ALL)?.id, "critic");
  assertEquals(resolveTargetAgent("Chief of Staff", ALL)?.id, "chief-of-staff");
  const dupes = [...ALL, { id: "critic-2", name: "Critic" }];
  assertEquals(resolveTargetAgent("critic", dupes)?.id, "critic", "an exact id match always wins");
  assertEquals(resolveTargetAgent("Critic", dupes), null, "an ambiguous NAME never resolves");
  assertEquals(resolveTargetAgent("", ALL), null);
  assertEquals(resolveTargetAgent(null, ALL), null);
});

// ── (2) registry KATs ───────────────────────────────────────────────────────

Deno.test("delegation registry: counts descendants, refuses past the cap, releases on settle", () => {
  const reg = createDelegationRegistry();
  for (let i = 0; i < MAX_DELEGATION_DESCENDANTS; i++) {
    assertEquals(reg.acquire("root-1"), true, `child ${i + 1} admitted`);
  }
  assertEquals(reg.acquire("root-1"), false, "the cap refuses the next child");
  assertEquals(reg.count("root-1"), MAX_DELEGATION_DESCENDANTS);
  reg.release("root-1"); // the root settles
  assertEquals(reg.count("root-1"), 0);
  assertEquals(reg.acquire("root-1"), true, "a fresh root run can delegate again");
});

Deno.test("delegation registry: eviction bounds the map when settle cleanup is lost", () => {
  const reg = createDelegationRegistry({ maxEntries: 4 });
  for (let i = 0; i < 6; i++) assertEquals(reg.acquire(`root-${i}`), true);
  assert(reg.size <= 4, "the map is hard-bounded");
});

// ── (3) record persistence (REAL registry, mocked chrome + OPFS) ────────────

const kv = new Map();
const fs = new Map();
function getDir(path) {
  let node = fs;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
}
function dirHandle(node, name) {
  return {
    name,
    getDirectoryHandle: async (seg, { create } = {}) => {
      const key = "d:" + seg;
      if (!node.has(key)) {
        if (!create) throw new Error("missing " + seg);
        node.set(key, new Map());
      }
      return dirHandle(node.get(key), seg);
    },
    getFileHandle: async (seg, { create } = {}) => {
      const key = "f:" + seg;
      if (!node.has(key)) {
        if (!create) throw new Error("missing " + seg);
        node.set(key, { text: "" });
      }
      const rec = node.get(key);
      return {
        getFile: async () => ({ text: async () => rec.text, size: new TextEncoder().encode(rec.text).length }),
        createWritable: async () => ({
          write: async (s) => { rec.text = s; },
          close: async () => {},
        }),
      };
    },
    removeEntry: async (seg) => { node.delete("d:" + seg); node.delete("f:" + seg); },
    entries: async function* () {
      for (const [k, v] of node) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file", getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }) }];
      }
    },
  };
}
function installMocks() {
  kv.clear();
  fs.clear();
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (kv.has(k)) out[k] = JSON.parse(JSON.stringify(kv.get(k)));
          }
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) kv.delete(k);
            else kv.set(k, JSON.parse(JSON.stringify(v)));
          }
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) kv.delete(k);
        },
      },
    },
  };
  globalThis.navigator = globalThis.navigator ?? {};
  Object.defineProperty(globalThis.navigator, "storage", {
    value: {
      getDirectory: async () => ({
        getDirectoryHandle: async (seg, { create } = {}) => {
          const node = create ? getDir([seg]) : (() => { const n = fs.get("d:" + seg); if (!n) throw new Error("missing"); return n; })();
          return dirHandle(node, seg);
        },
      }),
    },
    configurable: true,
  });
}

Deno.test("delegation record: create/update persist a normalized canDelegateTo through the real registry", async () => {
  installMocks();
  const na = await import(`../extension/lib/named-agents.js?deleg=${Date.now()}`);
  const created = await na.createNamedAgent({ name: "Chief", canDelegateTo: ["researcher", "researcher", 42, " critic "] });
  assertEquals(created.ok, true);
  assertEquals(created.agent.canDelegateTo, ["researcher", "critic"], "deduped, trimmed, non-strings dropped");
  const listed = await na.listNamedAgents();
  assertEquals(listed[0].canDelegateTo, ["researcher", "critic"], "the list survives a round-trip read");
  const updated = await na.updateNamedAgent(created.agent.id, { canDelegateTo: ["critic"] });
  assertEquals(updated.ok, true);
  assertEquals(updated.agent.canDelegateTo, ["critic"]);
  const other = await na.createNamedAgent({ name: "Other" });
  assertEquals(other.agent.canDelegateTo, [], "default is cannot-delegate");
});

// ── (4) tool wiring KATs ────────────────────────────────────────────────────

Deno.test("delegate_to_agent: present in the management toolset + capability inventory; caller identity rides the dispatcher context, never model args", async () => {
  assert(MANAGEMENT_TOOL_NAMES.includes("delegate_to_agent"), "the tool is catalogued");
  assert(MANAGEMENT_CAPABILITY_TOOL_NAMES.includes("delegate_to_agent"), "the capability inventory carries it");

  const calls = [];
  const spy = (type, args) => { calls.push({ type, args }); return Promise.resolve({ ok: true }); };
  const tools = managementToolset({ callRoute: spy });
  assert(tools.delegate_to_agent, "the tool exists");
  // The model controls ONLY the brief fields — there is NO identity arg to
  // forge (the route resolves the caller from the dispatcher-bound context).
  await tools.delegate_to_agent.execute({ agent: "researcher", task: "dig into X", __delegation: { executionId: "FORGED" } });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].type, "named-agent.delegate");
  assertEquals(calls[0].args.agent, "researcher");
  assertEquals(calls[0].args.__delegation, undefined, "no identity field is forwarded through the model-controlled body");
  // The schema itself must not carry an identity field.
  const schema = JSON.stringify(tools.delegate_to_agent.inputSchema ?? {});
  assert(!schema.includes("__delegation"), "the model-facing schema has no caller-identity field");
});

// ── (5) audit KATs ──────────────────────────────────────────────────────────

Deno.test("delegation audit: exact bounded record + the log is capped", async () => {
  const mem = new Map();
  const store = {
    get: async (k) => mem.get(k) ?? null,
    set: async (k, v) => void mem.set(k, v),
  };
  const rec = delegationAuditRecord({
    rootRunId: "exec-root",
    parentRunId: "exec-parent",
    childRunId: "delegate:critic:1",
    fromAgent: "Chief of Staff",
    toAgent: "Critic",
    task: "x".repeat(500),
    outcome: "ok",
  });
  assert(rec.task.length <= 140, "the task summary is bounded");
  await appendDelegationAudit(store, rec);
  for (let i = 0; i < DELEGATION_AUDIT_MAX + 10; i++) {
    await appendDelegationAudit(store, delegationAuditRecord({
      rootRunId: "r", parentRunId: "p", childRunId: `c${i}`, fromAgent: "a", toAgent: "b", task: "t", outcome: "error",
    }));
  }
  const log = mem.get(DELEGATION_AUDIT_KEY);
  assertEquals(log.length, DELEGATION_AUDIT_MAX, "the audit log is hard-capped");
  assertEquals(log.at(-1).childRunId, `c${DELEGATION_AUDIT_MAX + 9}`, "newest records survive");
});

// ── (6) SW wiring pins (the seams the route depends on) ─────────────────────

Deno.test("delegation SW pins: fail-closed context, no approval inheritance, lock bypass confined to the delegation path", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // The route resolves the caller from the dispatcher-bound CONTEXT (never a
  // model-controlled body field — dispatchRoute strips __-prefixed keys).
  assertStringIncludes(sw, "routeContext?.executionId");
  assertStringIncludes(sw, "activeDelegationRuns.get(callerExecutionId)");
  // The child inherits NO approvals.
  const delegateRoute = sw.slice(sw.indexOf('async "named-agent.delegate"'), sw.indexOf('async "named-agent.history"'));
  assertStringIncludes(delegateRoute, "approvalBinding: null");
  assertStringIncludes(delegateRoute, "skipRunLock: true");
  // The lock bypass exists ONLY behind the skipRunLock flag in runTask.
  assertStringIncludes(sw, "skipRunLock ? runBody() : withRunLock(runBody)");
  // The delegation run-state is registered for the run and dies with it.
  assertStringIncludes(sw, "activeDelegationRuns.set(executionId, delegationState)");
  assertStringIncludes(sw, "activeDelegationRuns.delete(executionId)");
  // The run-context save/restore confines the singleton swap to nested runs.
  assertStringIncludes(sw, "savedRunContext");
});
