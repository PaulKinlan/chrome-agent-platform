// lib/workflows.js — the agent's reusable-workflow store.
//
// A workflow is a named, repeatable procedure the agent saved so it can do the
// same job again without re-inventing it: a JS script body (runs sandboxed,
// owner-approved), a saved tool pipeline (declarative steps — the pipeline
// runner in lib/tool-pipeline.js), step-by-step instructions the agent should
// follow, or a Python script (Python is not admitted yet — saving works, the
// run fails closed naming the missing runtime).
//
// Storage is the run's OWN origin-keyed memory under `workflows:<name>` — the
// same trust class and store as memory_set (the agent's own store, never
// another origin's). The keys ride the runtime-context memory digest and the
// memory_grep/memory_list tools, so a fresh run's prompt already lists what
// the agent saved; save/list/get are pure memory operations with no owner
// approval. `workflow.run`:
//   - script-js   → the service worker's `workflow.run` route, which reuses the
//                   sandboxed script host + owner approval exactly like
//                   `script.run` (source digest + fetch hosts on the card).
//   - pipeline    → runPipeline (lib/tool-pipeline.js) with a dispatcher bound
//                   to the RUN'S live lazy tool catalog — every step goes
//                   through the run's normal executor (validation, run
//                   ownership, capability gates). A step that needs an owner
//                   approval card shows the run's REAL card and re-executes
//                   on Allow (slice-2, chrome-agent-platform-3cb6); a denial
//                   fails the step closed naming the tool and the
//                   requirement. Contexts without an approval surface
//                   (workers, SCOPED hook runs) still fail closed.
//   - instructions → never executed; read with workflow_get and follow them.
//   - script-python → fails closed (runtime not admitted).
//
// BROWSER-SAFE: this module must stay free of bare specifiers ("ai"/"zod") —
// it only imports other pure modules.

import { validatePipeline, runPipeline } from "./tool-pipeline.js";
import { isToolResultFailure } from "./tool-summary.js";

export const WORKFLOW_NAMESPACE = "workflows:";
export const WORKFLOW_KINDS = ["script-js", "script-python", "pipeline", "instructions"];

/** A saved workflow record: { name, kind, description, content, createdAt }.
 * Shape validation only (dptw): no name/description/content size ceilings and
 * no per-origin count — the OPFS store and its quota are the honest ceiling. */
export function workflowKey(name) {
  // The FULL name is the key — never truncated: two names sharing a long
  // common prefix are distinct workflows, not one silently overwriting the
  // other.
  return `${WORKFLOW_NAMESPACE}${String(name ?? "")}`;
}

export function workflowNameFromKey(key) {
  return String(key ?? "").startsWith(WORKFLOW_NAMESPACE)
    ? String(key).slice(WORKFLOW_NAMESPACE.length)
    : null;
}

/** Validate + normalize a workflow record before save. Returns
 * `{ ok:true, record }` or `{ ok:false, error }`. */
export function validateWorkflow({ name, description, kind, content }) {
  const n = String(name ?? "").trim();
  if (!n) return { error: "workflow name is required" };
  if (!WORKFLOW_KINDS.includes(kind)) {
    return { error: `workflow kind must be one of ${WORKFLOW_KINDS.join(", ")}` };
  }
  const d = String(description ?? "").trim();
  const c = String(content ?? "");
  return { ok: true, record: { name: n, description: d, kind, content: c, createdAt: Date.now() } };
}

/** Pure run decision for a saved workflow record — the SAME decision the run
 * paths consume, so a test exercises exactly what production runs. Returns
 * { ok:true, mode:"script-js", source } for a JS body, or
 * { ok:true, mode:"pipeline", pipeline } for a parsed+validated pipeline
 * definition, or { ok:false, error } for a kind whose runtime is not present. */
export function workflowRunPlan(wf) {
  const kind = String(wf?.kind ?? "");
  const name = String(wf?.name ?? "");
  // The plan is the choke point BOTH run paths (the agent-side workflow_run
  // and the SW `workflow.run` route) consume BEFORE any approval card or
  // sandbox: it validates the stored record's SHAPE (kind, pipeline JSON) —
  // never its size (dptw). A forged record with an unknown kind or a broken
  // pipeline body fails closed here, never reaching the owner-approval card
  // or the sandbox host.
  const content = String(wf?.content ?? "");
  if (kind === "pipeline") {
    let parsed;
    try {
      parsed = JSON.parse(String(wf?.content ?? ""));
    } catch {
      return { ok: false, error: `workflow "${name}" has a pipeline body that is not valid JSON` };
    }
    const v = validatePipeline(parsed);
    if (!v.ok) return { ok: false, error: `workflow "${name}" pipeline is invalid: ${v.error}` };
    return { ok: true, mode: "pipeline", pipeline: v.pipeline };
  }
  if (kind === "script-python") {
    return { ok: false, error: "script-python workflows need the Python runtime, which is not admitted yet — save it as script-js or instructions" };
  }
  if (kind === "script-js") {
    return { ok: true, mode: "script-js", source: content };
  }
  if (kind === "instructions") {
    return { ok: false, error: `workflow "${name}" is kind instructions — read it with workflow_get and follow the instructions; it is never executed` };
  }
  return { ok: false, error: `workflow "${name}" has unknown kind "${kind}"` };
}

/** The production script-js run path: plan → approval gate → sandbox →
 * whole result (dptw: no result clip — the run envelope downstream owns
 * retention, and a cut result is a wrong answer). Extracted from the SW route
 * so tests exercise the SAME code. `gate` is the scriptApprovalGate-shaped
 * function (context, action, scope, id, source, extra) → { ok } | { ok:false,
 * error }; `runSandboxed` is the sandbox host. */
export async function runWorkflowRoute({ name, kind, source, description, gate, runSandboxed }) {
  const src = typeof source === "string" ? source : "";
  const wfName = String(name ?? "");
  const plan = workflowRunPlan({ name: wfName, kind, content: src });
  if (!plan.ok) return plan;
  if (plan.mode !== "script-js") {
    return { ok: false, error: `workflow "${wfName}" is kind ${kind} — only script-js workflows run through the sandbox host` };
  }
  if (typeof gate !== "function" || typeof runSandboxed !== "function") {
    return { ok: false, error: "workflow run is not available in this context" };
  }
  const gateResult = await gate({ name: wfName, description: String(description ?? "") });
  if (!gateResult.ok) return gateResult;
  const run = await runSandboxed(plan.source);
  return { ok: run?.ok ?? false, result: run?.result ?? null, error: run?.error, logs: run?.logs ?? [] };
}

/** The step-tool names that must NEVER dispatch from a pipeline step:
 * `workflow_run` (a pipeline recursing into the workflow runner could loop a
 * workflow into itself — the owner card is no brake against a workflow that
 * re-enters itself between clicks) and `mcp__*` remote-server tools (matched
 * by PREFIX in the dispatcher; a nested per-server first-use approval is out
 * of the pipeline contract). Every OTHER gated tool keeps its gate THROUGH
 * the normal owner card (slice-2, chrome-agent-platform-3cb6): a capability
 * pause surfaces the run's real approval card and resumes on Allow (the
 * requestApproval/resume pair below), and a management/destructive route
 * (delete_named_agent, run_script, close_tab, …) raises its own card
 * in-route via requireOwnerApproval exactly as it does for a model-initiated
 * execute_tool call — approved executes, denied fails the step with the
 * requirement named. Keep the never-dispatch set minimal: a tool whose route
 * joins the approvable set does NOT belong here. */
export const PIPELINE_STEP_NEVER_DISPATCH_TOOLS = Object.freeze([
  // the run's own script-js workflow runner (recursion guard)
  "workflow_run",
]);

/** The production pipeline run path: parse + validate the record's body, then
 * run the steps through lib/tool-pipeline.js's runner with the caller's
 * dispatcher adapter (`dispatchStep(name, args, stepIndex)` → the runPipeline
 * envelope { ok:boolean, value?, error? } — in the agent this adapter binds
 * the RUN's live lazy catalog, the documented "normal tool seam"). Extracted
 * so tests exercise the SAME path production runs. */
export async function runPipelineWorkflow({ name, kind, content, dispatchStep }) {
  const plan = workflowRunPlan({ name, kind, content });
  if (!plan.ok) return plan;
  if (plan.mode !== "pipeline") {
    return { ok: false, error: "workflow is not a pipeline" };
  }
  if (typeof dispatchStep !== "function") {
    return { ok: false, error: "pipeline workflow run is not available in this context" };
  }
  const dispatchTool = (tool, args) => dispatchStep(String(tool ?? ""), args);
  const res = await runPipeline(plan.pipeline, { dispatchTool });
  if (!res.ok) return res;
  return { ok: true, steps: res.steps, final: res.final };
}

/** The agent-side pipeline step dispatcher adapter. Each step resolves its
 * tool by EXACT name against the run's live lazy catalog (search), then
 * executes through the protocol (execute) — validation, run-ownership and
 * capability gates all apply exactly as for a model-initiated execute_tool
 * call.
 *
 * OWNER APPROVAL (slice-2, chrome-agent-platform-3cb6): a step whose result
 * is a structured owner-approval pause surfaces the run's REAL approval card
 * through `requestApproval` (the run's onPermissionRequest seam — the same
 * one the agent loop's post-tool hook uses) and, on Allow, re-executes the
 * paused call through `resume` (the runtime-only resumeApprovedCall path:
 * same tool, original validated args, same run fence, every live authority
 * check — ledger entries and the untrusted-content projection apply exactly
 * as for a first-time call, because the resume ends in the ordinary
 * execute). On deny/expiry the paused call is settled and the step FAILS
 * CLOSED naming the tool and the requirement — the pipeline halts. Without
 * the requestApproval/resume pair (workers, SCOPED hook runs) a pause fails
 * closed exactly as before. A re-run that pauses on a FURTHER requirement
 * loops, bounded at 4 rounds (mirroring the agent loop). */
export function createWorkflowPipelineDispatcher({ search, execute, settle, context, requestApproval = null, resume = null, neverDispatchTools = PIPELINE_STEP_NEVER_DISPATCH_TOOLS } = {}) {
  const blocked = new Set(neverDispatchTools && typeof neverDispatchTools[Symbol.iterator] === "function"
    ? [...neverDispatchTools]
    : []);
  return async (toolName, args, stepIndex) => {
    // The FULL declared name is searched — never truncated: a truncated name
    // could silently match a different tool than the pipeline declared.
    const want = String(toolName ?? "");
    // PRE-DISPATCH guard: recursion (workflow_run) and remote MCP tools never
    // dispatch from a pipeline step. Zero search/execute/settle events.
    if (blocked.has(want) || want.startsWith("mcp__")) {
      return {
        ok: false,
        error: `step ${stepIndex} (${want}) cannot run inside a pipeline — run this workflow interactively or run the step directly`,
      };
    }
    const ctx = typeof context === "function" ? await context().catch(() => null) : null;
    if (!ctx || typeof search !== "function" || typeof execute !== "function") {
      return { ok: false, error: "pipeline step execution is not available in this context" };
    }
    let found = null;
    try {
      const res = await search({ query: want, limit: 12 }, ctx);
      if (res?.ok === true && Array.isArray(res.results)) {
        found = res.results.find((r) => r && typeof r.name === "string" && r.name === want) ?? null;
      }
    } catch { found = null; }
    if (!found || typeof found.selectionRef !== "string") {
      return { ok: false, error: `step ${stepIndex} names "${want}", which is not a runnable tool in this context` };
    }
    let envelope;
    try {
      envelope = await execute({ selectionRef: found.selectionRef, arguments: args ?? {} }, ctx);
    } catch (e) {
      return { ok: false, error: `step ${stepIndex} (${want}) failed: ${String(e?.message ?? e)}` };
    }
    if (!envelope || envelope.ok !== true) {
      const msg = envelope && typeof envelope.error === "string" ? envelope.error : "unknown failure";
      return { ok: false, error: `step ${stepIndex} (${want}) failed: ${msg}` };
    }
    let result = envelope.result;
    let pausedRef = typeof envelope.selectionRef === "string" ? envelope.selectionRef : found.selectionRef;
    // The owner-approval loop (slice-2): a capability pause shows the run's
    // real card and awaits the decision; Allow re-executes through the
    // runtime-only resume path. Bounded at 4 pauses per step.
    for (let round = 0; result && typeof result === "object" && result.waitingForPermission === true; round++) {
      const req = result.permissionRequirement;
      const reason = req && typeof req.reason === "string" ? req.reason : "owner approval";
      const canAsk = typeof requestApproval === "function" && typeof resume === "function";
      if (!canAsk) {
        try { if (typeof settle === "function") await settle(pausedRef); } catch { /* best effort */ }
        return {
          ok: false,
          error: `step ${stepIndex} (${want}) needs owner approval (${reason}) — run this workflow interactively or run the step directly`,
        };
      }
      if (round >= 4) {
        try { if (typeof settle === "function") await settle(pausedRef); } catch { /* best effort */ }
        return {
          ok: false,
          error: `step ${stepIndex} (${want}) still needs owner approval after 4 approval rounds (${reason}) — run the step directly`,
        };
      }
      let decision;
      try { decision = await requestApproval(result); } catch { decision = "denied"; }
      if (decision !== "approved") {
        try { if (typeof settle === "function") await settle(pausedRef); } catch { /* best effort */ }
        return {
          ok: false,
          error: decision === "expired"
            ? `step ${stepIndex} (${want}): approval expired (${reason}) — the pipeline stopped; the step was not performed`
            : `step ${stepIndex} (${want}): the owner denied the request (${reason}) — the pipeline stopped; the step was not performed`,
        };
      }
      let resumed = null;
      try { resumed = await resume(pausedRef); } catch { resumed = null; }
      const protocolFailure = !resumed || (resumed.ok !== true && typeof resumed.selectedTool !== "string");
      if (protocolFailure) {
        return {
          ok: false,
          error: `step ${stepIndex} (${want}): the owner approved (${reason}), but the step could not be re-run (${resumed && typeof resumed.error === "string" ? resumed.error : "the tool is no longer available"}) — run the step directly`,
        };
      }
      result = resumed.result;
      pausedRef = typeof resumed.selectionRef === "string" ? resumed.selectionRef : pausedRef;
    }
    // NESTED tool-result failure (REVISE P1): the lazy protocol reports the
    // OUTER envelope ok:true even when the tool that ran reported its own
    // failure ({ok:false}/{error}) — its "give the use back" contract. Only
    // checking the outer envelope turned a denied/failed step into a success
    // and let the LATER steps execute. Treat the nested failure as the failed
    // step it is so runPipeline halts here.
    if (result !== undefined && result !== null && isToolResultFailure(result)) {
      const msg = result && typeof result === "object" && typeof result.error === "string" && result.error.trim()
        ? result.error
        : String(result);
      return { ok: false, error: `step ${stepIndex} (${want}) failed: ${msg}` };
    }
    return { ok: true, value: result };
  };
}

/** Build the bounded "## Saved workflows" prompt layer (name + kind only). If
 * a prompt layer ever interpolates workflow names, use this — names and
 * descriptions are agent-written, so line breaks / Unicode line separators /
 * control characters must be neutralized first: a newline-bearing name could
 * otherwise inject extra durable prompt lines. */
export function sanitizePromptText(s) {
  return String(s ?? "")
    // Unicode line separators (U+2028/U+2029) terminate lines in JS strings
    // the same way \n does — collapse them alongside \n/\r FIRST.
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\r\n?|\n/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function buildWorkflowsPrompt(workflows) {
  if (!Array.isArray(workflows) || workflows.length === 0) return "";
  const lines = workflows
    .map((w) => `- ${sanitizePromptText(w.name)} (${sanitizePromptText(w.kind)}${w.description ? `: ${sanitizePromptText(w.description)}` : ""})`)
    .join("\n");
  return `\n## Saved workflows\nYou have saved reusable workflows. List them with workflow_list, read one with workflow_get, run one with workflow_run, or save a new one with save_workflow.\n${lines}\n`;
}
