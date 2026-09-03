// tests/workflows-revise.test.ts — the R2 falsification gates for the
// workflows-to-memory review (chrome-agent-platform-9ve7, REVISE round), with
// the dptw de-cap inversions (9ve7-land): one finding per test family:
//   1. workflow.run is approvable + source-disclosing, and the REAL approval
//      path (pending card → owner approves → sandbox executes) works.
//   2. a NESTED tool-result failure ({ok:false}/{error} inside the lazy
//      outer-ok envelope) fails the step and BLOCKS later pipeline steps.
//   3. pipeline steps that need owner approval get the REAL card (slice-2,
//      chrome-agent-platform-3cb6): management/destructive steps DISPATCH and
//      their route's requireOwnerApproval gates them in-route (a denial fails
//      the step with the route's message; later steps never run). Only
//      workflow_run (recursion) and mcp__* (remote) never dispatch.
//   4. the workflows: namespace is reserved from memory_set; stored records
//      are revalidated for SHAPE before approval/sandbox — never for SIZE
//      (dptw: a large shape-valid record plans and runs whole).
//   5. save_workflow mirrors memory_set's POST-write ownership fence with
//      version-scoped restore/delete compensation.
//   6. NO per-origin workflow count (dptw): the 129th+ workflow saves,
//      concurrent new-key saves both commit, and a store that cannot
//      enumerate its keys still saves (enumeration is not a precondition).
//
// FALSIFICATION: every test below is RED on the tree it gates against — the
// module import fails pre-feature, workflow.run is refused by
// createPendingApproval ("operation is not approvable"), nested step failures
// return ok:true, gated steps dispatch, memory_set writes workflows: keys, an
// aborted save keeps its write — and on the CAPPED 9ve7 tree every dptw
// past-bound test is RED ("exceeds" / "limit reached" refusals).
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
  PIPELINE_STEP_NEVER_DISPATCH_TOOLS,
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

// ── 3. approval-needing steps get the REAL card (slice-2) — only recursion +
// ── remote never dispatch ───────────────────────────────────────────────────

Deno.test("REVISE-3 (slice-2): the never-dispatch set is the recursion guard alone", () => {
  const set = new Set(PIPELINE_STEP_NEVER_DISPATCH_TOOLS);
  assert(set.has("workflow_run"), "workflow_run stays pre-gated (a pipeline must not recurse into the workflow runner)");
  assertEquals(set.size, 1, "management/destructive tools LEFT the set — their owner cards now work mid-pipeline");
  // The tools the old pre-gate covered are dispatchable now (their routes'
  // requireOwnerApproval / capability pauses gate them exactly as for a
  // model-initiated call).
  for (const formerly of ["delete_named_agent", "update_named_agent", "run_script", "create_script", "delete_agent", "update_agent", "update_asset", "delete_asset", "patch_asset", "disenroll_origin", "schedules_pause", "close_tab", "wipe_browsing_data", "remove_cookie", "write_file", "schedule_task"]) {
    assert(!set.has(formerly), `${formerly} must NOT be pre-gated — its owner card is the slice-2 feature`);
  }
  assert(!set.has("memory_get"), "memory_get is not gated");
  assert(!set.has("create_asset"), "create_asset is not gated");
});

Deno.test("REVISE-3 (slice-2): patch_asset and disenroll_origin DISPATCH — an in-route denial fails the step, later steps never run", async () => {
  // Pre-slice-2 these failed closed PRE-dispatch (zero search/execute). Now
  // the step dispatches; the route's owner card decides. A denied card comes
  // back as the route's nested failure and halts the pipeline; an approved
  // one returns the route's real result (the in-route approve case is covered
  // in tests/workflows-approval.test.ts).
  for (const gated of ["patch_asset", "disenroll_origin"]) {
    let searches = 0;
    let executes = 0;
    const dispatcher = createWorkflowPipelineDispatcher({
      search: async () => { searches += 1; return { ok: true, results: [{ name: gated, selectionRef: "sel_gated" }] }; },
      execute: async () => {
        executes += 1; // the real route would publish/await its owner card here
        return { ok: true, selectedTool: gated, result: { ok: false, error: `The owner denied ${gated}; the action was not performed.` } };
      },
      settle: async () => {},
      context: async () => ({ signal: null, runId: "r1" }),
    });
    const pipe = JSON.stringify({
      steps: [
        { id: "s1", tool: gated, args: { origin: "https://example.com" } },
        { id: "s2", tool: "memory_set", args: { key: "y", value: "should-not-run" } },
      ],
    });
    const res = await runPipelineWorkflow({ name: "p", kind: "pipeline", content: pipe, dispatchStep: dispatcher });
    assert(!res.ok, `${gated}: an in-route denial fails the workflow, got ${JSON.stringify(res)}`);
    assertStringIncludes(String(res.error), gated, `${gated}: the tool is named`);
    assertStringIncludes(String(res.error), "denied", `${gated}: the denial is surfaced`);
    assertEquals(searches, 1, `${gated}: the catalog WAS searched (no pre-gate)`);
    assertEquals(executes, 1, `${gated}: the step dispatched exactly once — the owner card gates it in-route`);
  }
});

Deno.test("REVISE-3 (slice-2): mcp__* and workflow_run steps still never dispatch; non-gated steps still run", async () => {
  const executed = [];
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async (request) => ({ ok: true, results: [{ name: request.query, selectionRef: `sel_${request.query}` }] }),
    execute: async (request) => { executed.push(request.selectionRef); return { ok: true, selectedTool: request.selectionRef, result: { ok: true } }; },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const mcp = await dispatcher("mcp__server__list_things", {}, 1);
  assert(!mcp.ok, "remote MCP tools never dispatch from a pipeline");
  assertStringIncludes(String(mcp.error), "cannot run inside a pipeline");
  const wf = await dispatcher("workflow_run", { name: "other" }, 2);
  assert(!wf.ok, "a recursion into workflow_run never dispatches");
  assertStringIncludes(String(wf.error), "cannot run inside a pipeline");
  const ok = await dispatcher("memory_get", { key: "x" }, 3);
  assert(ok.ok, "a non-gated tool still runs, got " + JSON.stringify(ok));
  assertEquals(executed.length, 1);
});

// ── 4. workflows: namespace reserved from memory_set; shape revalidated ─────

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

Deno.test("REVISE-4 (dptw): a large shape-valid record PLANS and RUNS whole — size is never a refusal reason", async () => {
  // workflowRunPlan is the choke point both run paths consume first. Pre-decap
  // a >64 KiB record failed here as "corrupt or forged"; post-dptw only SHAPE
  // (unknown kind, broken pipeline JSON) fails closed.
  const bigJs = "// " + "x".repeat(200 * 1024) + "\nreturn 1;";
  const plan = workflowRunPlan({ name: "big", kind: "script-js", content: bigJs });
  assert(plan.ok && plan.mode === "script-js", "a 200 KiB script body must plan, got " + JSON.stringify(plan).slice(0, 200));
  const bigPipe = JSON.stringify({ steps: [{ id: "s1", tool: "memory_get", args: { key: "x" } }], comment: "z".repeat(200 * 1024) });
  const planPipe = workflowRunPlan({ name: "big-p", kind: "pipeline", content: bigPipe });
  assert(planPipe.ok && planPipe.mode === "pipeline", "a 200 KiB pipeline body must plan, got " + JSON.stringify(planPipe).slice(0, 200));
  // The SW route path: gate (approval) and sandbox receive the WHOLE body.
  let gateCalled = 0;
  let sandboxSource = null;
  const route = await runWorkflowRoute({
    name: "big",
    kind: "script-js",
    source: bigJs,
    gate: async () => { gateCalled += 1; return { ok: true }; },
    runSandboxed: async (src) => { sandboxSource = src; return { ok: true, result: 1 }; },
  });
  assert(route.ok, "the route must run a large shape-valid body, got " + JSON.stringify(route).slice(0, 200));
  assertEquals(gateCalled, 1, "the owner card still gates the run (approval is untouched by de-capping)");
  assertEquals(sandboxSource, bigJs, "the sandbox received the WHOLE source — no clip");
  // Shape still fails closed: unknown kinds and broken pipeline JSON refuse.
  assert(!workflowRunPlan({ name: "b", kind: "nope", content: bigJs }).ok, "unknown kind still fails closed");
  assert(!workflowRunPlan({ name: "b", kind: "pipeline", content: "not json" + " ".repeat(100 * 1024) }).ok, "broken pipeline JSON still fails closed");
});

Deno.test("REVISE-4 (dptw): workflow_run dispatches a large shape-valid stored record (route reached with full content)", async () => {
  const bigContent = "// " + "x".repeat(200 * 1024) + "\nreturn 7;";
  const mem = makeMemory();
  // Seed the record directly in the store (the shape save_workflow writes).
  mem._map.set(workflowKey("big"), { name: "big", kind: "script-js", content: bigContent });
  let dispatched = null;
  const t = workflowsToolset({ memory: mem, runRoute: async (args) => { dispatched = args; return { ok: true, result: 7 }; } });
  const r = await t.workflow_run.execute({ name: "big" });
  assert(r.ok, "a large shape-valid record must dispatch, got " + JSON.stringify(r).slice(0, 200));
  assertEquals(dispatched.source, bigContent, "the SW workflow.run route receives the WHOLE stored body");
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

// ── 6. NO per-origin workflow count (dptw) — past-bound saves succeed ───────

Deno.test("REVISE-6 (dptw): the 129th and 200th workflows save — no per-origin count", async () => {
  // FALSIFICATION: on the capped tree the 129th NEW-key save was refused
  // ("workflow limit reached (128 per origin)"). Post-dptw the store is the
  // only ceiling.
  const mem = makeMemory();
  const seed = (i) => mem._map.set(workflowKey(`seed-${String(i).padStart(3, "0")}`), { name: `seed-${String(i).padStart(3, "0")}`, kind: "script-js", description: "", content: SAMPLE_JS });
  for (let i = 0; i < 128; i++) seed(i);
  const t = workflowsToolset({ memory: mem });
  const over129 = await t.save_workflow.execute({ name: "wf-129", kind: "script-js", content: SAMPLE_JS });
  assert(over129.ok, "the 129th workflow must save, got " + JSON.stringify(over129));
  for (let i = 130; i <= 200; i++) {
    const r = await t.save_workflow.execute({ name: `wf-${i}`, kind: "script-js", content: SAMPLE_JS });
    assert(r.ok, `wf-${i} must save, got ` + JSON.stringify(r));
  }
  const wfKeys = [...mem._map.keys()].filter((k) => workflowNameFromKey(String(k)) !== null);
  assertEquals(wfKeys.length, 200, "every save past the old bound landed whole");
  // And every one lists (no list truncation).
  const list = await t.workflow_list.execute({});
  assert(list.ok);
  assertEquals(list.workflows.length, 200, "workflow_list returns every saved workflow");
});

Deno.test("REVISE-6 (dptw): concurrent new-key saves BOTH commit (no count gate to violate)", async () => {
  // The per-store save lock existed ONLY to make count-then-create atomic at
  // the 128 bound; with the count gone, concurrent saves are ordinary per-key
  // writes (each key's own write is atomic in the store contract).
  const mem = makeMemory();
  const origSet = mem.set.bind(mem);
  mem.set = async (k, v) => { await new Promise((r) => setTimeout(r, 5)); return origSet(k, v); };
  const t = workflowsToolset({ memory: mem });
  const results = await Promise.all([
    t.save_workflow.execute({ name: "conc-a", kind: "script-js", content: SAMPLE_JS }),
    t.save_workflow.execute({ name: "conc-b", kind: "script-js", content: SAMPLE_JS }),
  ]);
  assert(results.every((r) => r?.ok === true), "BOTH concurrent saves commit, got " + JSON.stringify(results));
  assert(mem._map.has(workflowKey("conc-a")) && mem._map.has(workflowKey("conc-b")), "both records landed");
});

Deno.test("REVISE-6 (dptw): a store that cannot enumerate still saves (enumeration is not a save precondition)", async () => {
  // The capped code fail-closed a NEW-key save when keys() was unavailable
  // (capacity unprovable). With no count to prove, enumeration is never on
  // the save path.
  const mem = makeMemory();
  mem.keys = async () => { throw new Error("store enumeration unavailable"); };
  const t = workflowsToolset({ memory: mem });
  const r = await t.save_workflow.execute({ name: "unprovable", kind: "script-js", content: SAMPLE_JS });
  assert(r.ok, "a new-key save must not need enumeration, got " + JSON.stringify(r));
  const mem2 = makeMemory();
  delete mem2.keys;
  const t2 = workflowsToolset({ memory: mem2 });
  const r2 = await t2.save_workflow.execute({ name: "no-keys-fn", kind: "script-js", content: SAMPLE_JS });
  assert(r2.ok, "a store without keys() still saves, got " + JSON.stringify(r2));
});
