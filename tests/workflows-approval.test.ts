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

// ── 5. REAL-path integration: a genuine agent run whose pipeline workflow ───
// ── pauses on a capability, shows the card, and RESUMES through the real ────
// ── lazy protocol (resumeApprovedCall) — no dispatcher shims ────────────────

import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { tool } from "ai";
import { z } from "zod";
import { createAgent } from "../extension/lib/agent.js";
import { executableBrowserToolRecords } from "../extension/lib/lazy-tool-protocol.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import { workflowKey } from "../extension/lib/workflows.js";
import { managementToolset } from "../extension/lib/management-tools.js";
import {
  createNamedAgent,
  getNamedAgent,
  deleteNamedAgent,
} from "../extension/lib/named-agents.js";
import { createNamedAgentDeleteGate } from "../extension/background/routes/agent-schedule.js";
import {
  createApprovalStore,
  createPendingApproval,
  resolvePendingApproval,
  waitForApprovalDecision,
  consumeApproved,
  approvalCardDenial,
  canonicalOperationTarget,
  canonicalRecord,
  canonicalField,
  canonicalScalar,
  payloadDigest,
  opaqueTargetRef,
} from "../extension/lib/owner-approval.js";

function streamOf(parts, finishReason) {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return new ReadableStream({
    start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      for (const p of parts) {
        if (p.text != null) {
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: p.text });
          c.enqueue({ type: "text-end", id: "t" });
        }
        if (p.tool) {
          c.enqueue({ type: "tool-call", toolCallId: p.id, toolName: p.tool, input: JSON.stringify(p.args ?? {}) });
        }
      }
      c.enqueue({ type: "finish", usage, finishReason });
      c.close();
    },
  });
}

/** A scripted model: search workflow_run, execute it on the found selectionRef,
 * then answer with whatever the run returned. */
function workflowRunModel(workflowName, modelOutputs) {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "workflow-runner",
    supportedUrls: {},
    async doStream(options) {
      calls += 1;
      for (const m of options.prompt ?? []) {
        if (m?.role !== "tool") continue;
        for (const part of m.content ?? []) modelOutputs.push(JSON.stringify(part.output ?? part));
      }
      if (calls === 1) {
        return { stream: streamOf([{ tool: "search_tools", id: "call_1", args: { query: "workflow_run", limit: 3 } }], "tool-calls") };
      }
      if (calls === 2) {
        const blob = modelOutputs.join("\n");
        // The search result rides as a JSON-encoded string (modelContent), so
        // the quotes are escaped in the serialized prompt part.
        const match = blob.match(/selectionRef\\+":\\+"(sel_[0-9a-f]+)/);
        if (!match) return { stream: streamOf([{ text: "NO-SELECTION-REF" }], "stop") };
        return { stream: streamOf([{ tool: "execute_tool", id: "call_2", args: { selectionRef: match[1], arguments: { name: workflowName } } }], "tool-calls") };
      }
      return { stream: streamOf([{ text: "Workflow finished." }], "stop") };
    },
  };
}

/** Run a real agent whose saved pipeline workflow has ONE gated step
 * (`site_report` pauses until the owner's decision flips the grant). */
async function runPipelineWithCard(decision) {
  resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); clearRunFence();
  const store = new Map();
  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) { if (v === undefined) store.delete(k); else store.set(k, v); } },
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
      },
    },
  };
  let granted = false;
  const calls = { site_report: 0 };
  const memoryMap = new Map();
  // The saved pipeline workflow (the shape save_workflow writes): one step
  // naming the gated tool.
  memoryMap.set(workflowKey("wf-card"), {
    name: "wf-card",
    kind: "pipeline",
    description: "",
    content: JSON.stringify({ steps: [{ id: "s1", tool: "site_report", args: {} }] }),
    createdAt: 1,
  });
  const memory = {
    origin: "hub",
    async get(key) { return memoryMap.has(key) ? memoryMap.get(key) : undefined; },
    async has(key) { return memoryMap.has(key); },
    async set(key, value) { memoryMap.set(key, value); return 1; },
    async keys() { return [...memoryMap.keys()]; },
    async delete(key) { memoryMap.delete(key); },
  };
  const grantDigest = () => (granted ? "b".repeat(64) : "a".repeat(64));
  const tools = {
    site_report: tool({
      description: "Report on the current site",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        calls.site_report++;
        if (!granted) {
          return {
            error: "browser control not granted",
            waitingForPermission: true,
            permissionRequirement: { reason: "read the current site", permissions: [], grantOrigins: ["https://example.com"], grantGlobal: false },
          };
        }
        return { ok: true, report: "the site report" };
      },
    }),
  };
  const readLazySources = async () => executableBrowserToolRecords(tools, {
    version: "1.0.0",
    sourceGeneration: "extension:test:orchestrator:1",
    closureGeneration: "extension:test:orchestrator:1:browser:full",
    packageDigest: "c".repeat(64),
    permissionDigest: "none",
    grantDigest: grantDigest(),
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    capabilities: ["browser.tabs"],
    authorizationGuard: async () => ({ ok: true, permissionDigest: "none", grantDigest: grantDigest() }),
  });
  const modelOutputs = [];
  const denials = [];
  const agent = createAgent({
    model: { model: workflowRunModel("wf-card", modelOutputs), modelId: "workflow-runner", providerName: "test" },
    id: "hub",
    name: "hub",
    memory,
    taskId: `wf-card-${Math.random().toString(36).slice(2, 8)}`,
    readLazySources,
    onProgress: () => {},
    onPermissionRequest: async (denial) => {
      denials.push(denial);
      if (decision === "approved") granted = true;
      return decision;
    },
  });
  const text = await agent.run("run my saved workflow");
  return { calls, denials, modelOutputs, text: String(text) };
}

Deno.test("slice-2 REAL path: a pipeline step's pause surfaces the run's card and Allow re-executes through the real lazy resume", async () => {
  const { calls, denials, modelOutputs, text } = await runPipelineWithCard("approved");
  assertEquals(denials.length, 1, "exactly one card, got " + JSON.stringify(denials));
  assertEquals(denials[0].permissionRequirement.reason, "read the current site", "the card carries the step's requirement");
  assertEquals(calls.site_report, 2, "the gated step ran once (paused), then re-executed on Allow through the REAL resumeApprovedCall");
  const joined = modelOutputs.join("\n");
  assert(joined.includes("the site report"), "the workflow's real result reached the model: " + joined.slice(0, 400));
  assert(!joined.includes("run this workflow interactively"), "the old fail-closed sentence is gone");
  assert(!joined.includes("needs owner approval"), "no fail-closed refusal reaches the model");
  assert(!/NO-SELECTION-REF/.test(text), "the scripted model found workflow_run in the catalog");
});

Deno.test("slice-2 REAL path: a DENIED pipeline step fails the workflow closed — tool + requirement named, never re-executed", async () => {
  const { calls, denials, modelOutputs } = await runPipelineWithCard("denied");
  assertEquals(denials.length, 1, "the card was shown");
  assertEquals(calls.site_report, 1, "a denied step is NEVER re-executed");
  const joined = modelOutputs.join("\n");
  assert(joined.includes("denied"), "the denial reaches the model honestly: " + joined.slice(0, 400));
  assert(joined.includes("read the current site"), "the requirement is named");
  assert(joined.includes("site_report"), "the tool is named");
});

// ── 6. REAL-path destructive management in-route approval (kdjk) ─────────────
// ── A real delete_named_agent step inside a pipeline workflow invokes the ────
// ── real route gate, surfaces its owner approval card in-route, and awaits ───
// ── decision: Allow deletes the agent and proceeds; Deny halts the pipeline. ─

async function runRealDestructivePipeline(decision) {
  const approvalStore = createApprovalStore();
  const approvalEvents = [];
  const executed = [];
  const agentsMap = {
    "doomed-agent": { id: "doomed-agent", name: "Doomed Agent", revision: 1 },
  };

  const payloadFields = (entries) =>
    canonicalRecord(...entries.map(([name, value]) => canonicalField(name, canonicalScalar(value))));
  const namedExistingPayload = (existing) => payloadFields([
    ["id", existing?.id ?? ""],
    ["instanceId", existing?.instanceId ?? `legacy:${existing?.id ?? ""}:0`],
    ["revision", Number.isSafeInteger(existing?.revision) ? existing.revision : 0],
  ]);
  const namedBoundMutationPayload = (request, existing) =>
    canonicalRecord(
      canonicalField("request", request),
      canonicalField("existing", namedExistingPayload(existing)),
    );

  const callRoute = async (type, args) => {
    if (type === "named-agent.delete") {
      const slug = args.id;
      const existing = agentsMap[slug];
      if (!existing) return { ok: false, error: `no agent ${slug}` };

      const gateBeforeDelete = createNamedAgentDeleteGate(
        { principal: "model", executionId: "exec-destructive-1" },
        {
          requireOwnerApproval: async (context, action, target, payload) => {
            const executionId = context?.executionId ?? "exec-destructive-1";
            const digest = await payloadDigest(payload);
            const targetRef = `ref_${slug}`;
            const pending = createPendingApproval(approvalStore, executionId, action, target, digest);
            if (!pending.ok) return { ok: false, error: pending.error ?? "pending approval failed" };

            const request = approvalCardDenial({ approvalId: pending.approvalId, action, targetRef });
            approvalEvents.push({
              type: "approval-request",
              approvalId: pending.approvalId,
              action,
              targetRef,
              target,
              result: request,
            });

            // Asynchronously resolve or deny as the user would on the in-context approval card
            queueMicrotask(() => {
              resolvePendingApproval(approvalStore, pending.approvalId, decision === "approved");
            });

            const dec = await waitForApprovalDecision(approvalStore, pending.approvalId);
            if (dec.decision === "approved") {
              const exact = consumeApproved(approvalStore, executionId, action, target, digest);
              if (exact.ok) {
                approvalEvents.push({ type: "approval-settled", approvalId: pending.approvalId, state: "granted" });
                return { ok: true };
              }
              return { ok: false, error: "approval mismatch" };
            }
            approvalEvents.push({ type: "approval-settled", approvalId: pending.approvalId, state: "denied" });
            return { ok: false, approvalDenied: true, error: `The owner denied ${action}; the action was not performed.` };
          },
          canonicalOperationTarget,
          namedBoundMutationPayload,
          payloadFields,
          cancelScheduledTaskBackground: () => ({ marked: Promise.resolve() }),
        },
      );

      const gate = await gateBeforeDelete({ slug, existing });
      if (!gate.ok) return gate;
      delete agentsMap[slug];
      return { ok: true, deleted: slug };
    }
    throw new Error(`unknown route ${type}`);
  };

  const mgmt = managementToolset({ callRoute });
  const tools = {
    delete_named_agent: mgmt.delete_named_agent,
    site_report: {
      description: "Report on the site",
      execute: async () => {
        return { ok: true, report: "step 2 executed" };
      },
    },
  };

  const dispatcher = createWorkflowPipelineDispatcher({
    search: async (req) => ({ ok: true, results: [{ name: req.query, selectionRef: `sel_${req.query}` }] }),
    execute: async (req) => {
      const toolName = req.selectionRef.slice(4);
      executed.push(toolName);
      const t = tools[toolName];
      if (!t) return { ok: false, error: `no tool ${toolName}` };
      const res = await t.execute(req.arguments);
      return { ok: true, selectedTool: toolName, result: res };
    },
    settle: async () => {},
    context: async () => ({ signal: null, runId: "r1" }),
  });

  const pipe = JSON.stringify({
    steps: [
      { id: "s1", tool: "delete_named_agent", args: { id: "doomed-agent" } },
      { id: "s2", tool: "site_report", args: {} },
    ],
  });

  const outcome = await runPipelineWorkflow({
    name: "destructive-test",
    kind: "pipeline",
    content: pipe,
    dispatchStep: (tool, args, index) => dispatcher(tool, args, index),
  });

  return { outcome, approvalEvents, executed, agentsMap };
}

Deno.test("slice-2 REAL path: destructive delete_named_agent pipeline step surfaces owner card in-route and Allow completes deletion + step 2", async () => {
  const { outcome, approvalEvents, executed, agentsMap } = await runRealDestructivePipeline("approved");
  assert(outcome.ok, "pipeline completes after owner approves destructive step: " + JSON.stringify(outcome));
  assertEquals(approvalEvents.length, 2, "surfaces approval-request then approval-settled");
  assertEquals(approvalEvents[0].type, "approval-request");
  assertEquals(approvalEvents[0].action, "named-agent.delete", "surfaces the exact destructive action");
  assertEquals(approvalEvents[0].target, "named:12:doomed-agent", "canonical target names the exact agent slug");
  assertEquals(approvalEvents[1].type, "approval-settled");
  assertEquals(approvalEvents[1].state, "granted");
  assertEquals(agentsMap["doomed-agent"], undefined, "agent is genuinely deleted after Allow");
  assertEquals(executed, ["delete_named_agent", "site_report"], "subsequent pipeline step 2 executed after approval");
});

Deno.test("slice-2 REAL path: destructive delete_named_agent pipeline step denied by owner halts pipeline and leaves agent intact", async () => {
  const { outcome, approvalEvents, executed, agentsMap } = await runRealDestructivePipeline("denied");
  assert(!outcome.ok, "pipeline fails closed when owner denies destructive step: " + JSON.stringify(outcome));
  assertStringIncludes(String(outcome.error), "The owner denied named-agent.delete; the action was not performed.");
  assertEquals(approvalEvents.length, 2, "surfaces approval-request then approval-settled");
  assertEquals(approvalEvents[0].type, "approval-request");
  assertEquals(approvalEvents[0].action, "named-agent.delete");
  assertEquals(approvalEvents[1].type, "approval-settled");
  assertEquals(approvalEvents[1].state, "denied");
  assert(agentsMap["doomed-agent"] !== undefined, "agent survives in storage when owner denies deletion");
  assertEquals(executed, ["delete_named_agent"], "subsequent pipeline step 2 was NEVER executed because step 1 was denied");
});
