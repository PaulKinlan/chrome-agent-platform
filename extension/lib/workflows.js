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

/** Build the bounded "## Saved workflows" prompt layer (name + kind only). */
export function buildWorkflowsPrompt(workflows) {
  if (!Array.isArray(workflows) || workflows.length === 0) return "";
  const lines = workflows
    .slice(0, WORKFLOW_BOUNDS.maxWorkflows)
    .map((w) => `- ${w.name} (${w.kind}${w.description ? `: ${w.description}` : ""})`)
    .join("\n");
  return `\n## Saved workflows\nYou have saved reusable workflows. List them with workflow_list, read one with workflow_get, run one with workflow_run, or save a new one with save_workflow.\n${lines}\n`;
}
