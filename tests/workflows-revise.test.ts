// tests/workflows-revise.test.ts — the R2 falsification gates for the
// workflows-to-memory review (chrome-agent-platform-9ve7, REVISE round). One
// finding per test family:
//   1. workflow.run is approvable + source-disclosing, and the REAL approval
//      path (pending card → owner approves → sandbox executes) works.
//   2. a NESTED tool-result failure ({ok:false}/{error} inside the lazy
//      outer-ok envelope) fails the step and BLOCKS later pipeline steps.
//   3. an owner-approval-gated step fails closed PRE-dispatch (zero tool
//      execution, zero approval events), never raising a mid-pipeline card.
//   4. the workflows: namespace is reserved from memory_set and stored records
//      are revalidated against WORKFLOW_BOUNDS before approval/sandboxing.
//   5. save_workflow mirrors memory_set's POST-write ownership fence with
//      version-scoped restore/delete compensation.
//   6. the declared 128-workflow per-origin bound is enforced on save: NEW-key
//      saves are refused past the bound, count+create are atomic per store
//      under concurrency, and an unprovable count (store cannot enumerate)
//      FAILS CLOSED. Overwrites never count and still work at the bound.
//
// FALSIFICATION: every test below is RED on the pre-fix code — the module
// import fails (new exports), workflow.run is refused by createPendingApproval
// ("operation is not approvable"), nested step failures return ok:true, gated
// steps dispatch, memory_set writes workflows: keys, an aborted save keeps its
// write, and the 129th workflow saves.
// @ts-nocheck — shims + toolset composition are intentionally dynamic.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DESTRUCTIVE_ACTIONS,
  SOURCE_DISCLOSING_ACTIONS,
  approvalCardDenial,
  canonicalField,
  canonicalOperationTarget,
  canonicalRecord,
  canonicalScalar,
  consumeApproved,
  createApprovalStore,
  createPendingApproval,
  payloadDigest,
  resolvePendingApproval,
  waitForApprovalDecision,
} from "../extension/lib/owner-approval.js";
import { sha256Hex } from "../extension/lib/pure.js";
import { setRunFence, clearRunFence } from "../extension/lib/run-fence.js";
import {
  runPipelineWorkflow,
  runWorkflowRoute,
  workflowKey,
  workflowNameFromKey,
  workflowRunPlan,
  createWorkflowPipelineDispatcher,
  PIPELINE_STEP_OWNER_APPROVAL_TOOLS,
  WORKFLOW_BOUNDS,
} from "../extension/lib/workflows.js";
import { workflowsToolset, memoryToolset } from "../extension/lib/agent.js";

// A tiny in-memory memory store (mirrors the OPFS store's set→version +
// CAS-delete contract; abortMidSet lets a test abort the run DURING the
// awaited write, exactly like a real abort landing mid-OPFS-write).
function makeMemory({ abortMidSet = false, controller = null } = {}) {
  const map = new Map();
  let version = 0;
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async has(key) { return map.has(key); },
    async set(key, value) {
      if (abortMidSet && controller) controller.abort(); // abort lands DURING the write
      const s = JSON.stringify(value);
      if (s.length > 256 * 1024) throw new Error("value exceeds 256 KiB bound");
      map.set(key, value);
      version += 1;
      return version;
    },
    async keys() { return [...map.keys()]; },
    async delete(key) { map.delete(key); },
    async getVersion(key) { return map.has(key) ? 1 : 0; },
    async compareAndDelete(key, expectedVersion) {
      if (map.has(key) && (expectedVersion == null || expectedVersion >= 1)) map.delete(key);
    },
    _map: map,
  };
}

const SAMPLE_JS = "return { ok: true, from: 'workflow' };";

// ── 1. workflow.run approvable end-to-end (REAL approval machinery) ─────────

// The gate the SW's workflow.run route binds: scriptApprovalGate-shaped and
// composed from the SAME exported owner-approval functions requireOwnerApproval
// uses, in the SAME order (consume → pending → wait → consume). `onPending`
// fires while the card is pending (the point where the conversation renders
// it), so a test can assert what the owner sees before the Allow click.
function approveWorkflowRunGate({ store, executionId, source, name, onPending }) {
  const target = canonicalOperationTarget("script", { origin: "master", id: String(name ?? "") });
  const payload = canonicalRecord(
    canonicalField("origin", canonicalScalar("master")),
    canonicalField("id", canonicalScalar(String(name ?? ""))),
    canonicalField("name", canonicalScalar(String(name ?? ""))),
    canonicalField("sourceDigest", canonicalScalar(sha256Hex(String(source ?? "")))),
    canonicalField("fetchHosts", canonicalScalar("")),
    canonicalField("dynamic", canonicalScalar(false)),
  );
  return async () => {
    const digest = await payloadDigest(payload);
    const consumed = consumeApproved(store, executionId, "workflow.run", target, digest);
    if (consumed.ok) return { ok: true };
    const pending = createPendingApproval(store, executionId, "workflow.run", target, digest);
    if (!pending.ok) return pending; // ← PRE-FIX: {ok:false,error:"operation is not approvable"}
    if (pending.status === "pending") onPending?.(pending);
    const decisionWait = waitForApprovalDecision(store, pending.approvalId);
    const decided = resolvePendingApproval(store, pending.approvalId, true); // the owner's Allow click
    await decisionWait;
    if (decided.decision === "approved") {
      const exact = consumeApproved(store, executionId, "workflow.run", target, digest);
      if (exact.ok) return { ok: true };
      return { ok: false, error: "the approval no longer matched this workflow run" };
    }
    return { ok: false, error: "The owner denied workflow.run; the workflow was not run." };
  };
}

Deno.test("REVISE-1: workflow.run is an approvable, source-disclosing action", () => {
  assert(DESTRUCTIVE_ACTIONS.has("workflow.run"), "createPendingApproval refuses actions outside DESTRUCTIVE_ACTIONS — workflow.run could never obtain approval");
  assert(SOURCE_DISCLOSING_ACTIONS.has("workflow.run"), "the workflow.run card must disclose the exact script source like script.run");
  // script.run parity: both actions share the two sets.
  assert(DESTRUCTIVE_ACTIONS.has("script.run"));
  assert(SOURCE_DISCLOSING_ACTIONS.has("script.run"));
});

Deno.test("REVISE-1: REAL approval path end-to-end — pending card → owner approves → sandbox executes", async () => {
  const store = createApprovalStore();
  const executionId = "exec-wf-1";
  const source = "return 42;";
  const name = "summarise";
  let cardShown = null;
  let sandboxCalled = 0;
  const gate = approveWorkflowRunGate({
    store,
    executionId,
    source,
    name,
    onPending: (pending) => {
      // The card the owner sees while the approval is pending: an approvable,
      // source-disclosing workflow.run card carrying the exact source.
      const card = approvalCardDenial({
        approvalId: pending.approvalId,
        action: "workflow.run",
        targetRef: name,
        detail: { source, hosts: [] },
      });
      assert(card && card.ok === false && card.waitingForPermission === true, "an approvable action produces a card denial");
      const shown = card.permissionRequirement.approvals[0];
      assertEquals(shown.action, "workflow.run");
      assertEquals(shown.detail.source, source, "the card discloses the exact source (SOURCE_DISCLOSING)");
      cardShown = card;
    },
  });
  const res = await runWorkflowRoute({
    name,
    kind: "script-js",
    source,
    description: "d",
    gate,
    runSandboxed: async (src) => {
      sandboxCalled += 1;
      assertEquals(src, source, "the sandbox receives the workflow body");
      return { ok: true, result: 42, logs: [] };
    },
  });
  assert(cardShown, "the owner card was shown before the sandbox ran");
  assert(res.ok && res.result === 42, `run must succeed after approval, got ${JSON.stringify(res)}`);
  assertEquals(sandboxCalled, 1, "approval granted → the sandbox executes the workflow body");
});

Deno.test("REVISE-1: workflow.run with NO approval never reaches the sandbox", async () => {
  const store = createApprovalStore();
  const executionId = "exec-wf-deny";
  const source = "return 1;";
  let sandboxCalled = 0;
  const res = await runWorkflowRoute({
    name: "denied",
    kind: "script-js",
    source,
    gate: async () => ({ ok: false, error: "The owner denied workflow.run; the workflow was not run." }),
    runSandboxed: async () => { sandboxCalled += 1; return { ok: true }; },
  });
  assert(!res.ok);
  assertEquals(sandboxCalled, 0);
});

// ── 2. nested tool-result failures fail the step and BLOCK continuation ─────

Deno.test("REVISE-2: a nested {ok:false}/{error} tool result is a FAILED step (never outer-ok success)", async () => {
  let settled = 0;
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async () => ({ ok: true, results: [{ name: "memory_get", selectionRef: "sel_ref_1" }] }),
    // The lazy protocol's envelope for a tool that RAN and reported its own
    // failure: OUTER ok:true, nested {ok:false,error} in result.
    execute: async () => ({
      ok: true,
      selectedTool: "memory_get",
      result: { ok: false, error: "key is reserved" },
    }),
    settle: async () => { settled += 1; },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const r = await dispatcher("memory_get", { key: "x" }, 1);
  assert(!r.ok, "a nested tool-result failure must fail the step, got " + JSON.stringify(r));
  assertStringIncludes(String(r.error), "step 1");
  assertStringIncludes(String(r.error), "memory_get");
  assertStringIncludes(String(r.error), "key is reserved");
  assertEquals(settled, 0, "a plain tool failure has no paused call to settle");
});

Deno.test("REVISE-2: a nested-failure step HALTS the pipeline (later steps never dispatch)", async () => {
  const calls = [];
  // The production wiring: the step dispatcher (createWorkflowPipelineDispatcher)
  // feeds runPipelineWorkflow, so the nested lazy-envelope failure must surface
  // through the dispatcher and stop the runner.
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async (request) => ({ ok: true, results: [{ name: request.query, selectionRef: `sel_${request.query}` }] }),
    execute: async (request) => {
      calls.push(request.selectionRef);
      if (request.selectionRef === "sel_memory_get") {
        return { ok: true, selectedTool: "memory_get", result: { ok: false, error: "the step's tool was denied" } };
      }
      return { ok: true, selectedTool: "memory_set", result: "written" };
    },
    settle: async () => {},
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const pipe = JSON.stringify({
    steps: [
      { id: "s1", tool: "memory_get", args: { key: "x" } },
      { id: "s2", tool: "memory_set", args: { key: "y", value: "should-not-run" } },
    ],
  });
  const res = await runPipelineWorkflow({ name: "p", kind: "pipeline", content: pipe, dispatchStep: dispatcher });
  assert(!res.ok, "a nested-failure step must fail the workflow, got " + JSON.stringify(res));
  assertEquals(calls, ["sel_memory_get"], "the pipeline halts AT the failing step — later steps must not execute");
  assertStringIncludes(String(res.error), "denied");
});

// ── 3. approval-gated steps fail closed PRE-dispatch (no card, no execute) ──

Deno.test("REVISE-3: the pre-dispatch deny set covers model-approval-gated tools", () => {
  const set = new Set(PIPELINE_STEP_OWNER_APPROVAL_TOOLS);
  for (const gated of ["delete_named_agent", "update_named_agent", "run_script", "create_script", "delete_agent", "update_agent", "update_asset", "delete_asset", "patch_asset", "disenroll_origin", "schedules_pause", "close_tab", "wipe_browsing_data", "remove_cookie", "write_file", "workflow_run"]) {
    assert(set.has(gated), `${gated} must be pre-gated (its model route awaits an owner card)`);
  }
  // Non-gated workflow-usable tools stay runnable.
  assert(!set.has("memory_get"), "memory_get is not owner-gated");
  assert(!set.has("create_asset"), "create_asset is not owner-gated");
});

Deno.test("REVISE-3: patch_asset and disenroll_origin fail closed pre-dispatch — zero search/execute/approval events", async () => {
  for (const gated of ["patch_asset", "disenroll_origin"]) {
    let searches = 0;
    let executes = 0;
    let settles = 0;
    let approvalEvents = 0;
    const dispatcher = createWorkflowPipelineDispatcher({
      search: async () => { searches += 1; return { ok: true, results: [{ name: gated, selectionRef: "sel_gated" }] }; },
      execute: async () => {
        executes += 1;
        approvalEvents += 1; // the real executor would publish/await an owner card here
        return { ok: true, selectedTool: gated, result: { ok: true } };
      },
      settle: async () => { settles += 1; },
      context: async () => ({ signal: null, runId: "r1" }),
    });
    const r = await dispatcher(gated, { origin: "https://example.com" }, 1);
    assert(!r.ok, `${gated} must fail closed, got ${JSON.stringify(r)}`);
    assertStringIncludes(String(r.error), gated);
    assertStringIncludes(String(r.error), "needs owner approval");
    assertEquals(searches, 0, `${gated}: guard fires before the catalog is searched`);
    assertEquals(executes, 0, `${gated}: executor never runs — no owner card can be raised`);
    assertEquals(settles, 0, `${gated}: nothing dispatched, nothing to settle`);
    assertEquals(approvalEvents, 0, `${gated}: ZERO approval events`);
  }
});

Deno.test("REVISE-3: a gated step fails closed BEFORE the executor — zero search/execute/settle/approval events", async () => {
  let searches = 0;
  let executes = 0;
  let settles = 0;
  let approvalEvents = 0;
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async () => { searches += 1; return { ok: true, results: [{ name: "delete_named_agent", selectionRef: "sel_gated" }] }; },
    execute: async () => {
      executes += 1;
      approvalEvents += 1; // the real executor would publish/await an owner card here
      return { ok: true, selectedTool: "delete_named_agent", result: { ok: true, deleted: true } };
    },
    settle: async () => { settles += 1; },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const r = await dispatcher("delete_named_agent", { id: "agent-1" }, 1);
  assert(!r.ok, "a gated step must fail closed, got " + JSON.stringify(r));
  assertStringIncludes(String(r.error), "delete_named_agent");
  assertStringIncludes(String(r.error), "needs owner approval");
  assertEquals(searches, 0, "the guard fires before the catalog is even searched");
  assertEquals(executes, 0, "the executor never runs — no owner card can be raised");
  assertEquals(settles, 0, "nothing was dispatched, so nothing needs settling");
  assertEquals(approvalEvents, 0, "ZERO approval events for an approval-requiring step");
});

Deno.test("REVISE-3: mcp__* and workflow_run steps are pre-gated; non-gated steps still dispatch", async () => {
  const executed = [];
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async (request) => ({ ok: true, results: [{ name: request.query, selectionRef: `sel_${request.query}` }] }),
    execute: async (request) => { executed.push(request.selectionRef); return { ok: true, selectedTool: request.selectionRef, result: { ok: true } }; },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const mcp = await dispatcher("mcp__server__list_things", {}, 1);
  assert(!mcp.ok, "remote MCP first-use approvals must not fire inside a pipeline");
  const wf = await dispatcher("workflow_run", { name: "other" }, 2);
  assert(!wf.ok, "a recursion into workflow_run (an owner card) must fail closed");
  const ok = await dispatcher("memory_get", { key: "x" }, 3);
  assert(ok.ok, "a non-gated tool still runs, got " + JSON.stringify(ok));
  assertEquals(executed.length, 1);
});

Deno.test("REVISE-3: a gated step inside a REAL pipeline halts it with zero later dispatch", async () => {
  const calls = [];
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async () => ({ ok: true, results: [] }), // never reached for the gated step
    execute: async (request) => { calls.push(request.selectionRef); return { ok: true, result: { ok: true } }; },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const pipe = JSON.stringify({
    steps: [
      { id: "s1", tool: "delete_named_agent", args: { id: "agent-1" } },
      { id: "s2", tool: "memory_set", args: { key: "y", value: "should-not-run" } },
    ],
  });
  const res = await runPipelineWorkflow({ name: "p", kind: "pipeline", content: pipe, dispatchStep: dispatcher });
  assert(!res.ok, "the gated step must fail the workflow, got " + JSON.stringify(res));
  assertStringIncludes(String(res.error), "delete_named_agent");
  assertEquals(calls.length, 0, "no step after the gated one (or the gated one) may execute");
});

// ── 4. workflows: namespace reserved from memory_set; records revalidated ────

Deno.test("REVISE-4: memory_set REFUSES the workflows: namespace (honest error)", async () => {
  const mem = makeMemory();
  const t = memoryToolset(mem);
  const r = await t.memory_set.execute({ key: "workflows:evil", value: { name: "evil", kind: "script-js", content: "x".repeat(200 * 1024) } });
  assert(!r.ok, "a forged oversized workflows:* write must be refused, got " + JSON.stringify(r));
  assertStringIncludes(String(r.error), "reserved");
  assertStringIncludes(String(r.error), "save_workflow");
  assertEquals(mem._map.size, 0, "nothing was written");
  // Ordinary keys still write.
  const ok = await t.memory_set.execute({ key: "note", value: "fine" });
  assert(ok.ok);
});

Deno.test("REVISE-4: an oversized forged record fails the run plan BEFORE approval/sandbox", async () => {
  // workflowRunPlan is the choke point both run paths consume first.
  const forged = workflowRunPlan({ name: "evil", kind: "script-js", content: "x".repeat(200 * 1024) });
  assert(!forged.ok, "a >64 KiB forged script body must fail closed at plan time");
  assertStringIncludes(String(forged.error), "exceeds");
  const forgedPipe = workflowRunPlan({ name: "evil", kind: "pipeline", content: "{\"steps\":[]}" + " ".repeat(200 * 1024) });
  assert(!forgedPipe.ok, "a >64 KiB forged pipeline body must fail closed at plan time");
  // The SW route path: the gate (approval) and sandbox never see the oversized body.
  let gateCalled = 0;
  let sandboxCalled = 0;
  const route = await runWorkflowRoute({
    name: "evil",
    kind: "script-js",
    source: "x".repeat(200 * 1024),
    gate: async () => { gateCalled += 1; return { ok: true }; },
    runSandboxed: async () => { sandboxCalled += 1; return { ok: true, result: 1 }; },
  });
  assert(!route.ok, "the route must fail closed on an oversized body");
  assertEquals(gateCalled, 0, "no approval card for a forged oversized record");
  assertEquals(sandboxCalled, 0, "the sandbox never runs a forged oversized record");
});

Deno.test("REVISE-4: workflow_run refuses a forged oversized stored record (route never invoked)", async () => {
  const mem = makeMemory();
  // Forge the record directly in the store (what a pre-fix memory_set could do).
  mem._map.set(workflowKey("evil"), { name: "evil", kind: "script-js", content: "x".repeat(200 * 1024) });
  let dispatched = 0;
  const t = workflowsToolset({ memory: mem, runRoute: async () => { dispatched += 1; return { ok: true }; } });
  const r = await t.workflow_run.execute({ name: "evil" });
  assert(!r.ok, "a forged oversized record must never dispatch, got " + JSON.stringify(r));
  assertStringIncludes(String(r.error), "exceeds");
  assertEquals(dispatched, 0, "the SW workflow.run route (approval + sandbox) must never be reached");
});

// ── 5. save_workflow post-write ownership fence + compensation ──────────────

Deno.test("REVISE-5: an abort DURING the awaited write compensates (new key removed, honest error)", async () => {
  const controller = new AbortController();
  const mem = makeMemory({ abortMidSet: true, controller });
  setRunFence({ signal: controller.signal, assertOwned: async () => {} });
  try {
    const t = workflowsToolset({ memory: mem });
    const r = await t.save_workflow.execute({ name: "x", kind: "script-js", content: SAMPLE_JS });
    assert(!r.ok, "an abort during the write must not report success, got " + JSON.stringify(r));
    assertEquals(mem._map.has(workflowKey("x")), false, "the aborted write must be compensated (key removed)");
  } finally {
    clearRunFence();
  }
});

Deno.test("REVISE-5: an abort DURING an OVERWRITE restores the prior record (never deletes it wholesale)", async () => {
  const controller = new AbortController();
  const mem = makeMemory({ abortMidSet: true, controller });
  const prior = { name: "x", kind: "script-js", description: "original", content: "return 1;", createdAt: 1 };
  mem._map.set(workflowKey("x"), prior);
  setRunFence({ signal: controller.signal, assertOwned: async () => {} });
  try {
    const t = workflowsToolset({ memory: mem });
    const r = await t.save_workflow.execute({ name: "x", kind: "script-js", content: "return 2;" });
    assert(!r.ok, "an abort during the write must not report success, got " + JSON.stringify(r));
    const after = mem._map.get(workflowKey("x"));
    assert(after, "the prior record must survive");
    assertEquals(after.content, "return 1;", "the aborted overwrite restores the PRIOR record");
    assertEquals(after.createdAt, 1);
  } finally {
    clearRunFence();
  }
});

Deno.test("REVISE-5: save_workflow succeeds when no abort lands (fence parity regression)", async () => {
  const mem = makeMemory();
  const t = workflowsToolset({ memory: mem });
  const r = await t.save_workflow.execute({ name: "fine", kind: "script-js", content: SAMPLE_JS });
  assert(r.ok, "a clean save still succeeds, got " + JSON.stringify(r));
});

// ── 6. the 128-workflow per-origin bound is enforced on save ────────────────

Deno.test("REVISE-6: save_workflow enforces WORKFLOW_BOUNDS.maxWorkflows at the bound", async () => {
  const mem = makeMemory();
  const t = workflowsToolset({ memory: mem });
  for (let i = 0; i < 127; i++) {
    const r = await t.save_workflow.execute({ name: `wf-${String(i).padStart(3, "0")}`, kind: "script-js", content: SAMPLE_JS });
    assert(r.ok, `wf-${i} should save, got ${JSON.stringify(r)}`);
  }
  // The 128th fits exactly.
  const last = await t.save_workflow.execute({ name: "wf-128", kind: "script-js", content: SAMPLE_JS });
  assert(last.ok, "the 128th workflow saves, got " + JSON.stringify(last));
  // The 129th (a NEW key) is honestly refused at the bound.
  const over = await t.save_workflow.execute({ name: "wf-over", kind: "script-js", content: SAMPLE_JS });
  assert(!over.ok, "a new workflow past the bound must be refused, got " + JSON.stringify(over));
  assertStringIncludes(String(over.error), "128");
  assertEquals(mem._map.size, 128, "nothing past the bound was written");
  // Overwriting an EXISTING workflow at the bound stays allowed.
  const overwrite = await t.save_workflow.execute({ name: "wf-001", kind: "script-js", content: "return 2;" });
  assert(overwrite.ok, "updating an existing workflow at the bound is allowed, got " + JSON.stringify(overwrite));
});

Deno.test("REVISE-6: two CONCURRENT new-key saves at the bound cannot both commit (count+create atomic per store)", async () => {
  // Seed 127 workflows directly (the shape save_workflow writes).
  const mem = makeMemory();
  const seed = (i) => mem._map.set(workflowKey(`seed-${String(i).padStart(3, "0")}`), { name: `seed-${String(i).padStart(3, "0")}`, kind: "script-js", description: "", content: SAMPLE_JS });
  for (let i = 0; i < 127; i++) seed(i);
  // Delay each durable write by a tick so BOTH concurrent saves finish their
  // count before either commit lands — the exact interleaving the per-store
  // lock must prevent (pre-fix: both observe 127 and both write 129).
  const origSet = mem.set.bind(mem);
  mem.set = async (k, v) => { await new Promise((r) => setTimeout(r, 5)); return origSet(k, v); };
  const t = workflowsToolset({ memory: mem });
  const results = await Promise.all([
    t.save_workflow.execute({ name: "conc-a", kind: "script-js", content: SAMPLE_JS }),
    t.save_workflow.execute({ name: "conc-b", kind: "script-js", content: SAMPLE_JS }),
  ]);
  const okCount = results.filter((r) => r?.ok === true).length;
  assertEquals(okCount, 1, "exactly ONE of two concurrent new-key saves may commit at the bound, got " + JSON.stringify(results));
  const wfKeys = [...mem._map.keys()].filter((k) => workflowNameFromKey(String(k)) !== null);
  assertEquals(wfKeys.length, 128, "the store never exceeds 128 workflows under concurrent saves");
});

Deno.test("REVISE-6: a NEW-key save FAILS CLOSED when the store cannot enumerate (rejected-keys store)", async () => {
  const boom = new Error("store enumeration unavailable");
  const mem = makeMemory();
  mem.keys = async () => { throw boom; };
  const t = workflowsToolset({ memory: mem });
  const r = await t.save_workflow.execute({ name: "unprovable", kind: "script-js", content: SAMPLE_JS });
  assert(!r.ok, "a new-key save must fail closed when enumeration cannot prove capacity, got " + JSON.stringify(r));
  assertStringIncludes(String(r.error), "enumerat");
  assertEquals([...mem._map.keys()].length, 0, "nothing may be written when capacity is unprovable");
  // A store without keys() at all is equally unprovable → also fails closed.
  const mem2 = makeMemory();
  delete mem2.keys;
  const t2 = workflowsToolset({ memory: mem2 });
  const r2 = await t2.save_workflow.execute({ name: "no-keys-fn", kind: "script-js", content: SAMPLE_JS });
  assert(!r2.ok, "a new-key save must fail closed when the store has no keys(), got " + JSON.stringify(r2));
  assertStringIncludes(String(r2.error), "enumerat");
  // An OVERWRITE of an existing workflow still works without enumeration (it
  // never counts against the bound) — the fail-closed rule is for NEW keys.
  mem._map.set(workflowKey("existing"), { name: "existing", kind: "script-js", content: SAMPLE_JS });
  mem.keys = async () => { throw boom; };
  const overwrite = await t.save_workflow.execute({ name: "existing", kind: "script-js", content: "return 3;" });
  assert(overwrite.ok, "an overwrite never counts, so it does not need enumeration, got " + JSON.stringify(overwrite));
});
