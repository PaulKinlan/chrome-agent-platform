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
//                   ownership, capability gates). A step that would need an
//                   owner approval card FAILS CLOSED naming the tool and the
//                   requirement — nested execution never shows a silent card
//                   and never corrupts the run's approval-resume state.
//   - instructions → never executed; read with workflow_get and follow them.
//   - script-python → fails closed (runtime not admitted).
//
// BROWSER-SAFE: this module must stay free of bare specifiers ("ai"/"zod") —
// it only imports other pure modules.

import { validatePipeline, runPipeline } from "./tool-pipeline.js";
import { isToolResultFailure } from "./tool-summary.js";

export const WORKFLOW_NAMESPACE = "workflows:";
export const WORKFLOW_KINDS = ["script-js", "script-python", "pipeline", "instructions"];

export const WORKFLOW_BOUNDS = Object.freeze({
  maxNameLength: 64,
  maxDescriptionLength: 256,
  maxContentBytes: 64 * 1024, // 64 KiB
  maxWorkflows: 128, // per origin
});

/** A saved workflow record: { name, kind, description, content, createdAt }. */
export function workflowKey(name) {
  return `${WORKFLOW_NAMESPACE}${String(name ?? "").slice(0, WORKFLOW_BOUNDS.maxNameLength)}`;
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
  if (n.length > WORKFLOW_BOUNDS.maxNameLength) {
    return { error: `workflow name exceeds ${WORKFLOW_BOUNDS.maxNameLength} chars` };
  }
  if (!WORKFLOW_KINDS.includes(kind)) {
    return { error: `workflow kind must be one of ${WORKFLOW_KINDS.join(", ")}` };
  }
  const d = String(description ?? "").trim();
  if (d.length > WORKFLOW_BOUNDS.maxDescriptionLength) {
    return { error: `workflow description exceeds ${WORKFLOW_BOUNDS.maxDescriptionLength} chars` };
  }
  const c = String(content ?? "");
  const bytes = new TextEncoder().encode(c).length;
  if (bytes > WORKFLOW_BOUNDS.maxContentBytes) {
    return { error: `workflow content exceeds ${WORKFLOW_BOUNDS.maxContentBytes} UTF-8 bytes` };
  }
  return { ok: true, record: { name: n, description: d, kind, content: c, createdAt: Date.now() } };
}

/** Pure run decision for a saved workflow record — the SAME decision the run
 * paths consume, so a test exercises exactly what production runs. Returns
 * { ok:true, mode:"script-js", source } for a JS body, or
 * { ok:true, mode:"pipeline", pipeline } for a parsed+validated pipeline
 * definition, or { ok:false, error } for a kind whose runtime is not present. */
export function workflowRunPlan(wf) {
  const kind = String(wf?.kind ?? "");
  const name = String(wf?.name ?? "").slice(0, WORKFLOW_BOUNDS.maxNameLength);
  // The plan is the choke point BOTH run paths (the agent-side workflow_run
  // and the SW `workflow.run` route) consume BEFORE any approval card or
  // sandbox: revalidate the STORED record against the save-time bounds, so a
  // forged/oversized record (a memory_set write to the workflows: namespace
  // used to be able to land up to the store's 256 KiB limit) fails closed
  // here — never reaching the owner-approval card or the sandbox host.
  const content = String(wf?.content ?? "");
  if (new TextEncoder().encode(content).length > WORKFLOW_BOUNDS.maxContentBytes) {
    return { ok: false, error: `workflow "${name}" content exceeds the ${WORKFLOW_BOUNDS.maxContentBytes} UTF-8 byte bound — the stored record is corrupt or forged; re-save the workflow` };
  }
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
 * bounded result. Extracted from the SW route so tests exercise the SAME code.
 * `gate` is the scriptApprovalGate-shaped function (context, action, scope,
 * id, source, extra) → { ok } | { ok:false, error }; `runSandboxed` is the
 * sandbox host. */
export async function runWorkflowRoute({ name, kind, source, description, gate, runSandboxed, resultBound = 256 * 1024 }) {
  const src = typeof source === "string" ? source : "";
  const wfName = String(name ?? "").slice(0, WORKFLOW_BOUNDS.maxNameLength);
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
  let result = run?.result ?? null;
  if (result != null) {
    try {
      const s = JSON.stringify(result);
      if (s && s.length > resultBound) result = String(result).slice(0, resultBound);
    } catch { result = String(result).slice(0, resultBound); }
  }
  return { ok: run?.ok ?? false, result, error: run?.error, logs: run?.logs ?? [] };
}

/** The exact step-tool names whose model dispatch can RAISE an owner card and
 * await the decision (REVISE P1): their SW routes call requireOwnerApproval
 * with the model principal (management deletes/updates/script routes, the
 * Destructive browser class, the cookie-value reader, the file-write diff
 * card, per-agent schedule controls) or the run's own workflow_run route.
 * A pipeline step naming one of these must fail closed BEFORE dispatch — the
 * executor would otherwise show a card mid-pipeline and EXECUTE once approved
 * (the fail-closed premise). Keep in lock-step with owner-approval.js's
 * DESTRUCTIVE_ACTIONS / SOURCE_DISCLOSING_ACTIONS and the browser toolset's
 * gates: a tool whose route joins the approvable set belongs HERE. Remote MCP
 * tools (mcp__*) are matched by prefix in the dispatcher (per-server
 * first-use approval is never reachable from a pipeline step either). */
export const PIPELINE_STEP_OWNER_APPROVAL_TOOLS = Object.freeze([
  // management tools routed to owner-approvable actions (agent/asset/named-agent/script/hooks/task)
  "update_agent",
  "delete_agent",
  // delete_agent's sibling route alias: disenroll_origin posts the SAME
  // agent.delete action, which awaits an owner card — a pipeline step naming
  // it must fail closed pre-dispatch like delete_agent itself.
  "disenroll_origin",
  "update_asset",
  // update_asset's cheap sibling: patch_asset posts asset.patch, whose route
  // awaits the SAME asset.update owner approval card (the edits resolve to a
  // body behind the gate) — a pipeline step naming it must fail closed.
  "patch_asset",
  "delete_asset",
  "create_named_agent",
  "update_named_agent",
  "delete_named_agent",
  "set_agent_provider",
  "subscribe_hook",
  "unsubscribe_hook",
  "create_script",
  "update_script",
  "delete_script",
  "run_script",
  "schedules_pause",
  "schedules_resume",
  "schedules_update",
  // the run's own script-js workflow runner (a workflow step that recurses
  // into workflow_run would raise the workflow.run owner card)
  "workflow_run",
  // browser Destructive class + cookie-value reader + file-write diff card
  "close_tab",
  "close_window",
  "wipe_browsing_data",
  "remove_bookmark",
  "set_cookie",
  "remove_cookie",
  "get_cookie",
  "write_file",
  "schedule_task",
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
 * call. A step whose result is a structured owner-approval pause FAILS CLOSED
 * naming the tool + requirement (nested execution never shows a silent card,
 * and the paused call is settled so it cannot dangle or be resumed later). */
export function createWorkflowPipelineDispatcher({ search, execute, settle, context, ownerApprovalTools = PIPELINE_STEP_OWNER_APPROVAL_TOOLS } = {}) {
  const gated = new Set(ownerApprovalTools && typeof ownerApprovalTools[Symbol.iterator] === "function"
    ? [...ownerApprovalTools]
    : []);
  return async (toolName, args, stepIndex) => {
    const want = String(toolName ?? "").slice(0, 200);
    // PRE-DISPATCH guard (REVISE P1): an owner-approval-gated step must fail
    // closed BEFORE the executor runs. Model-routed tools (delete_named_agent,
    // run_script, the Destructive browser class, …) AWAIT the owner decision
    // inside requireOwnerApproval and would otherwise publish an owner card
    // mid-pipeline and EXECUTE once approved — the exact behaviour the
    // fail-closed premise forbids. The guard names the step and the tool;
    // nothing is searched, executed or settled, so no approval event can fire.
    if (gated.has(want) || want.startsWith("mcp__")) {
      return {
        ok: false,
        error: `step ${stepIndex} (${want}) needs owner approval — pipeline steps never raise an owner card; run this workflow interactively or run the step directly`,
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
    const result = envelope.result;
    if (result && typeof result === "object" && result.waitingForPermission === true) {
      const req = result.permissionRequirement;
      const reason = req && typeof req.reason === "string" ? req.reason : "owner approval";
      try { if (typeof settle === "function") await settle(found.selectionRef); } catch { /* best effort */ }
      return {
        ok: false,
        error: `step ${stepIndex} (${want}) needs owner approval (${reason}) — run this workflow interactively or run the step directly`,
      };
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
    .slice(0, WORKFLOW_BOUNDS.maxWorkflows)
    .map((w) => `- ${sanitizePromptText(w.name)} (${sanitizePromptText(w.kind)}${w.description ? `: ${sanitizePromptText(w.description)}` : ""})`)
    .join("\n");
  return `\n## Saved workflows\nYou have saved reusable workflows. List them with workflow_list, read one with workflow_get, run one with workflow_run, or save a new one with save_workflow.\n${lines}\n`;
}
