// lib/workflows.js — the agent's own reusable-workflow store
// (CAP-FB-20260831-WORKFLOWS-TO-MEMORY-01).
//
// A workflow is a named, reusable procedure the agent saved so it can do the
// same job again: a JS script body, a Python script, a saved tool pipeline
// (declarative steps — the runner lands with TOOL-PIPELINES-01), or plain
// step-by-step instructions the agent should follow.
//
// Storage is the run's ORIGIN-KEYED memory under `workflows:<name>` — the same
// trust class as memory_set (the agent's own store, never another origin's).
// save/list/get are pure memory operations with no owner approval; `run`
// dispatches to the service worker's `workflow.run` route, which reuses the
// sandboxed script host + owner approval exactly like `script.run` (same gates:
// source digest, fetch hosts, no DOM/extension/network of its own).
//
// BROWSER-SAFE: this module must stay free of bare specifiers ("ai"/"zod") —
// it is reachable from the NTP's raw ES-module graph via lib/named-agents.js →
// lib/system-prompts.js. The workflow TOOLS live in lib/agent.js (the SW
// bundle); this module only exports pure helpers + validation.

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

/** Validate + normalize a workflow record before save. Returns { ok } or { error }. */
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

/** Pure run decision for a saved workflow record (review blocker 3: the
 * production route must be driven by this exact decision, not a parallel
 * re-implementation). Returns { runScript } with the source for script-js, or
 * { ok:false, error } for kinds whose runtime is not present. */
export function workflowRunPlan(wf) {
  const kind = String(wf?.kind ?? "");
  if (kind === "pipeline") {
    return { ok: false, error: "pipeline workflows need the pipe runner (TOOL-PIPELINES-01) — save it as script-js or instructions for now" };
  }
  if (kind === "script-python") {
    return { ok: false, error: "script-python workflows need the Python runtime, which is not admitted yet — save it as script-js or instructions" };
  }
  if (kind !== "script-js") {
    return { ok: false, error: `workflow "${String(wf?.name ?? "").slice(0, 64)}" is kind ${kind} — read it with workflow_get and follow the instructions; only script-js workflows can run now` };
  }
  return { ok: true, runScript: true, source: String(wf?.content ?? "") };
}

/** The production workflow.run path: decision → approval gate → sandbox.
 * Extracted from the SW route so tests exercise the SAME code (review blocker
 * 3). `gate` is the scriptApprovalGate-shaped function (context, action, scope,
 * id, source, extra) → { ok } | { ok:false, error }; `runSandboxed` is the
 * sandbox host. Bounds the returned result like the original route. */
export async function runWorkflowRoute({ name, kind, source, description, scope, gate, runSandboxed, resultBound = 256 * 1024 }) {
  const src = typeof source === "string" ? source : "";
  const wfName = String(name ?? "").slice(0, 64);
  const plan = workflowRunPlan({ name: wfName, kind, content: src });
  if (!plan.ok) return plan;
  const gateResult = await gate({ name: wfName, description });
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

/** Build the bounded "## Saved workflows" prompt layer (name + kind only).
 * Name/description are interpolated into the SYSTEM PROMPT, so line breaks and
 * control characters must be neutralized first — a newline-bearing workflow
 * name could otherwise inject extra durable prompt lines (review blocker 4). */
export function sanitizePromptText(s) {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
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
