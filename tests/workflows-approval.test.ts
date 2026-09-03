// tests/workflows-approval.test.ts — slice-2 (chrome-agent-platform-3cb6):
// the per-step owner-approval executor for pipeline workflows. Before slice-2
// a step that needed a capability grant or destructive approval FAILED CLOSED
// ("needs owner approval — run this workflow interactively"). Now the pause
// surfaces the run's REAL approval card through the run's onPermissionRequest
// seam and, on Allow, re-executes the paused call through the runtime-only
// resumeApprovedCall path (same tool, original args, same fence). Deny/expiry
// still fails closed — naming the tool and the requirement.
//
// FALSIFICATION: on the pre-slice-2 dispatcher every approval-path test here
// is RED (no requestApproval/resume params existed; a pause always failed
// closed), and the old REVISE-3 pre-gate tests go RED on the new dispatcher
// (management/destructive tools now dispatch). The deny/no-surface/expired
// paths pin the fail-closed contract that must SURVIVE slice-2.
// @ts-nocheck — shims + toolset composition are intentionally dynamic.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
// Namespace import (not named): on the pre-slice-2 tree the module loads and
// every approval-path test below fails BEHAVIOURALLY (the old dispatcher had
// no requestApproval/resume and fail-closed every pause) — the RED proof is
// the behavior, not an import error. PIPELINE_STEP_NEVER_DISPATCH_TOOLS is
// absent pre-slice-2 (the old export was the 30-tool pre-gate set).
import * as workflowLib from "../extension/lib/workflows.js";
const { runPipelineWorkflow, createWorkflowPipelineDispatcher } = workflowLib;
const NEVER_DISPATCH = workflowLib.PIPELINE_STEP_NEVER_DISPATCH_TOOLS;

const DENIAL = (reason) => ({
  waitingForPermission: true,
  permissionRequirement: { reason },
});

// A catalog/executor shim: every named tool resolves exactly, and the per-tool
// behavior map decides what each execute returns.
function makeDispatcher({ behaviors = {}, requestApproval, resume, settleCalls = [], resumeCalls = [], approvalRequests = [], calls = [] } = {}) {
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async (request) => ({ ok: true, results: [{ name: request.query, selectionRef: `sel_${request.query}` }] }),
    execute: async (request) => {
      calls.push(request.selectionRef);
      const tool = request.selectionRef.slice(4);
      const b = behaviors[tool];
      const out = typeof b === "function" ? b(request) : b;
      return out ?? { ok: true, selectedTool: tool, result: { ok: true } };
    },
    settle: async (ref) => { settleCalls.push(ref); },
    context: async () => ({ signal: null, runId: "r1" }),
    requestApproval: requestApproval === undefined
      ? async (denial) => { approvalRequests.push(denial); return "approved"; }
      : requestApproval,
    resume: resume === undefined
      ? async (ref) => { resumeCalls.push(ref); return { ok: true, selectedTool: ref.slice(4), result: { value: "resumed-value" } }; }
      : resume,
  });
  return { dispatcher, settleCalls, resumeCalls, approvalRequests, calls };
}

// ── 1. the approval path: pause → real card → Allow → resume executes ───────

Deno.test("slice-2: a paused step shows the card and Allow re-executes the SAME call", async () => {
  const rig = makeDispatcher({
    behaviors: { capture_visible_tab: () => ({ ok: true, selectedTool: "capture_visible_tab", result: DENIAL("capture this tab") }) },
  });
  const r = await rig.dispatcher("capture_visible_tab", {}, 2);
  assert(r.ok, "an approved step succeeds, got " + JSON.stringify(r));
  assertEquals(r.value, { value: "resumed-value" }, "the step value is the RESUMED call's real result");
  assertEquals(rig.approvalRequests.length, 1, "exactly one card was shown");
  assertEquals(rig.approvalRequests[0].permissionRequirement.reason, "capture this tab", "the card carries the exact requirement");
  assertEquals(rig.resumeCalls, ["sel_capture_visible_tab"], "resume re-ran the paused selectionRef — no fresh search");
  assertEquals(rig.settleCalls.length, 0, "an approved pause is never settled");
});

Deno.test("slice-2: the resumed result flows FORWARD through a $ref binding (end-to-end pipeline)", async () => {
  const rig = makeDispatcher({
    behaviors: {
      read_page: () => ({ ok: true, selectedTool: "read_page", result: DENIAL("read the page") }),
      memory_set: { ok: true, selectedTool: "memory_set", result: "written" },
    },
  });
  const pipe = JSON.stringify({
    steps: [
      { id: "s1", tool: "read_page", args: {} },
      { id: "s2", tool: "memory_set", args: { key: "page", value: { $ref: "s1", path: "value" } } },
    ],
  });
  let boundValue;
  const res = await runPipelineWorkflow({
    name: "p", kind: "pipeline", content: pipe,
    dispatchStep: async (tool, args) => {
      if (tool === "memory_set") boundValue = args.value;
      return rig.dispatcher(tool, args, 0);
    },
  });
  assert(res.ok, "the pipeline completes after approval, got " + JSON.stringify(res));
  assertEquals(boundValue, "resumed-value", "step 2 bound the RESUMED result, not the denial");
});

// ── 2. deny / expiry / no-surface: fail closed with the requirement named ───

Deno.test("slice-2: DENY fails the step closed naming tool + requirement; resume never fires; the pipeline halts", async () => {
  const rig = makeDispatcher({
    behaviors: {
      read_page: () => ({ ok: true, selectedTool: "read_page", result: DENIAL("read the page") }),
    },
    requestApproval: async () => "denied",
  });
  const later = [];
  const pipe = JSON.stringify({
    steps: [
      { id: "s1", tool: "read_page", args: {} },
      { id: "s2", tool: "memory_set", args: { key: "y", value: "never" } },
    ],
  });
  const res = await runPipelineWorkflow({
    name: "p", kind: "pipeline", content: pipe,
    dispatchStep: async (tool, args) => {
      if (tool === "memory_set") later.push(tool);
      return rig.dispatcher(tool, args, 0);
    },
  });
  assert(!res.ok, "a denied step fails the pipeline, got " + JSON.stringify(res));
  assertStringIncludes(String(res.error), "read_page", "the tool is named");
  assertStringIncludes(String(res.error), "read the page", "the requirement is named");
  assertStringIncludes(String(res.error), "denied", "the denial is named");
  assertEquals(rig.resumeCalls.length, 0, "a denied call is NEVER re-executed");
  assertEquals(rig.settleCalls, ["sel_read_page"], "the paused call is settled so it cannot dangle");
  assertEquals(later.length, 0, "no later step runs after a denial");
});

Deno.test("slice-2: EXPIRED approval fails closed naming the expiry", async () => {
  const rig = makeDispatcher({
    behaviors: { read_page: () => ({ ok: true, selectedTool: "read_page", result: DENIAL("read the page") }) },
    requestApproval: async () => "expired",
  });
  const r = await rig.dispatcher("read_page", {}, 1);
  assert(!r.ok);
  assertStringIncludes(String(r.error), "expired");
  assertStringIncludes(String(r.error), "read the page");
  assertEquals(rig.resumeCalls.length, 0);
  assertEquals(rig.settleCalls, ["sel_read_page"]);
});

Deno.test("slice-2: a throwing approval surface is treated as a denial (fail closed, settled)", async () => {
  const rig = makeDispatcher({
    behaviors: { read_page: () => ({ ok: true, selectedTool: "read_page", result: DENIAL("read the page") }) },
    requestApproval: async () => { throw new Error("surface gone"); },
  });
  const r = await rig.dispatcher("read_page", {}, 1);
  assert(!r.ok, "a broken card surface must never look like approval");
  assertStringIncludes(String(r.error), "denied");
  assertEquals(rig.resumeCalls.length, 0);
});

Deno.test("slice-2: WITHOUT the approval wiring a pause fails closed exactly as before (worker/SCOPED contexts)", async () => {
  const rig = makeDispatcher({
    behaviors: { read_page: () => ({ ok: true, selectedTool: "read_page", result: DENIAL("read the page") }) },
    requestApproval: null,
    resume: null,
  });
  const r = await rig.dispatcher("read_page", {}, 1);
  assert(!r.ok);
  assertStringIncludes(String(r.error), "needs owner approval");
  assertStringIncludes(String(r.error), "read the page");
  assertStringIncludes(String(r.error), "run this workflow interactively");
  assertEquals(rig.settleCalls, ["sel_read_page"], "the paused call is still settled");
});

Deno.test("slice-2: an approved pause whose RESUME cannot run fails honestly (no silent success)", async () => {
  const rig = makeDispatcher({
    behaviors: { read_page: () => ({ ok: true, selectedTool: "read_page", result: DENIAL("read the page") }) },
    resume: async () => ({ ok: false, error: "lazy-resume-tool-unavailable" }),
  });
  const r = await rig.dispatcher("read_page", {}, 3);
  assert(!r.ok);
  assertStringIncludes(String(r.error), "approved");
  assertStringIncludes(String(r.error), "could not be re-run");
  assertStringIncludes(String(r.error), "lazy-resume-tool-unavailable");
});

// ── 3. bounded re-pause loop ────────────────────────────────────────────────

Deno.test("slice-2: a re-run that pauses on a FURTHER requirement shows a second card, then succeeds", async () => {
  const rig = makeDispatcher({
    behaviors: { group_tabs: () => ({ ok: true, selectedTool: "group_tabs", result: DENIAL("see your tabs") }) },
    resume: async (ref) => {
      rig.resumeCalls.push(ref);
      if (rig.resumeCalls.length === 1) {
        // The first resume pauses again on the second requirement.
        return { ok: true, selectedTool: "group_tabs", selectionRef: "sel_group_tabs#2", result: DENIAL("group tabs") };
      }
      return { ok: true, selectedTool: "group_tabs", result: { grouped: 3 } };
    },
  });
  const r = await rig.dispatcher("group_tabs", {}, 1);
  assert(r.ok, "two sequential approvals complete the step, got " + JSON.stringify(r));
  assertEquals(r.value, { grouped: 3 });
  assertEquals(rig.approvalRequests.length, 2, "each requirement got its own card");
  assertEquals(rig.approvalRequests[0].permissionRequirement.reason, "see your tabs");
  assertEquals(rig.approvalRequests[1].permissionRequirement.reason, "group tabs");
  assertEquals(rig.resumeCalls, ["sel_group_tabs", "sel_group_tabs#2"], "the second resume uses the re-issued ref");
});

Deno.test("slice-2: the re-pause loop is BOUNDED — a 5th pause fails closed", async () => {
  let n = 0;
  const rig = makeDispatcher({
    behaviors: { needy_tool: () => ({ ok: true, selectedTool: "needy_tool", result: DENIAL(`need ${++n}`) }) },
    resume: async (ref) => { rig.resumeCalls.push(ref); return { ok: true, selectedTool: "needy_tool", result: DENIAL(`need ${++n}`) }; },
  });
  const r = await rig.dispatcher("needy_tool", {}, 1);
  assert(!r.ok, "an endlessly-pausing tool must not loop forever");
  assertStringIncludes(String(r.error), "4 approval rounds");
  assertEquals(rig.approvalRequests.length, 4, "exactly four cards were shown");
});

// ── 4. the never-dispatch set: recursion + remote only ──────────────────────

Deno.test("slice-2: the pre-dispatch guard covers ONLY workflow_run (recursion) and mcp__* (remote)", async () => {
  assert(Array.isArray(NEVER_DISPATCH) && NEVER_DISPATCH.includes("workflow_run"), "the recursion guard is exported (pre-slice-2: the export does not exist)");
  assertEquals(NEVER_DISPATCH.length, 1, "the set is the recursion guard alone — everything else gets its card");
  for (const tool of ["workflow_run", "mcp__server__list_things"]) {
    let searches = 0, executes = 0, settles = 0, cards = 0;
    const dispatcher = createWorkflowPipelineDispatcher({
      search: async () => { searches += 1; return { ok: true, results: [] }; },
      execute: async () => { executes += 1; return { ok: true, result: { ok: true } }; },
      settle: async () => { settles += 1; },
      context: async () => ({}),
      requestApproval: async () => { cards += 1; return "approved"; },
      resume: async () => ({ ok: true, result: 1 }),
    });
    const r = await dispatcher(tool, {}, 1);
    assert(!r.ok, `${tool} never dispatches from a pipeline`);
    assertStringIncludes(String(r.error), "cannot run inside a pipeline");
    assertEquals([searches, executes, settles, cards], [0, 0, 0, 0], `${tool}: zero catalog/executor/settle/approval events`);
  }
});

Deno.test("slice-2: management/destructive steps DISPATCH — their in-route owner card gates them (no pre-gate)", async () => {
  // The pre-slice-2 dispatcher fail-closed these BEFORE dispatch (zero events).
  // Now the step dispatches and the ROUTE's own requireOwnerApproval denial
  // arrives as a nested tool failure — the step fails with the route's honest
  // denial, later steps never run. (The approve case is the route proceeding
  // in-route and returning its real result — indistinguishable from any other
  // successful call at this seam.)
  for (const gated of ["delete_named_agent", "run_script", "close_tab", "patch_asset", "disenroll_origin"]) {
    const rig = makeDispatcher({
      behaviors: {
        [gated]: () => ({
          ok: true,
          selectedTool: gated,
          result: { ok: false, error: `The owner denied ${gated}; the action was not performed.` },
        }),
      },
    });
    const r = await rig.dispatcher(gated, {}, 1);
    assert(!r.ok, `${gated}: an in-route denial fails the step`);
    assertStringIncludes(String(r.error), gated, `${gated}: the denial is surfaced, not swallowed`);
    assertEquals(rig.calls, [`sel_${gated}`], `${gated}: the step DISPATCHED (the pre-gate is gone)`);
    assertEquals(rig.approvalRequests.length, 0, `${gated}: capability-card seam untouched by in-route approvals`);
  }
});

Deno.test("slice-2: an approved management step's REAL result is the step value (in-route approve)", async () => {
  const rig = makeDispatcher({
    behaviors: { delete_named_agent: { ok: true, selectedTool: "delete_named_agent", result: { ok: true, deleted: "agent-1" } } },
  });
  const r = await rig.dispatcher("delete_named_agent", { id: "agent-1" }, 1);
  assert(r.ok, "the route approved in-route and returned its real result, got " + JSON.stringify(r));
  assertEquals(r.value, { ok: true, deleted: "agent-1" });
  assertEquals(rig.calls, ["sel_delete_named_agent"]);
});
