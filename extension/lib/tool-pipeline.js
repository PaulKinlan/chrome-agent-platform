// extension/lib/tool-pipeline.js — declarative, no-eval tool pipelines.
// CAP-FB-20260831-TOOL-PIPELINES-01.
//
// A pipeline chains a few EXISTING tools into one legible, reusable run where a
// step's output feeds the next by an EXPLICIT binding — the co-do "pipe" model,
// expressed declaratively so it needs no eval/new Function (MV3 CSP forbids
// them). It is NOT a scripting language: there are no expressions, only ordered
// steps whose args may reference an earlier step's result.
//
//   Pipeline = { name?, steps: Step[] }
//   Step     = { id, tool, args }        // id unique; tool = an existing tool
//   Binding  = { $ref: "<stepId>", path?: "a.b.0.c" }   // appears inside args
//
// Execution: validate → for each step, resolve its bindings against the results
// so far (pure path lookup, no eval), dispatch the tool through the run's NORMAL
// executor (so every step keeps its own owner-approval + untrusted-fencing +
// ledger), store the result, emit a step event for the plan strip. A failing
// step HALTS the pipeline with a structured error (fail closed). The tool NAME
// is fixed in the definition and is never bindable, so untrusted content from an
// earlier step can only ever land in a DATA position of a later step's args —
// never choose the tool — and a destructive step still raises its own approval
// card showing the resolved args.

export const MAX_PIPELINE_STEPS = 8;
export const MAX_STEP_ID_LEN = 40;
export const MAX_ARGS_BYTES = 32 * 1024;
export const MAX_BINDING_DEPTH = 8;
const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** A binding token is EXACTLY an object carrying a string `$ref` (optionally a
 * `path`). Any object shaped like one is treated as a binding — a real tool arg
 * that needs a literal `$ref` key is out of scope for this first slice. */
export function isBinding(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v) && typeof v.$ref === "string";
}

/** A structured error a step raises when a binding cannot be resolved. */
export class PipelineBindingError extends Error {
  constructor(message) { super(message); this.name = "PipelineBindingError"; }
}

/** Property / array-index access only along a dot path — no wildcards, no eval.
 * Returns `undefined` for a missing path (the caller decides fail-closed). */
export function getPath(root, path) {
  if (path == null || path === "") return root;
  let cur = root;
  for (const seg of String(path).split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Validate a pipeline definition WITHOUT running it. Every $ref must point at an
 * EARLIER step (so the pipeline is a linear pipe with no cycles by construction),
 * ids are unique and well-formed, the step count and args size are bounded, and
 * every step names a tool. `knownTools` (optional) rejects a step whose tool is
 * not in the run's catalog before anything executes.
 *
 * @returns {{ok:true, pipeline:{name:string, steps:Array}}|{ok:false, error:string}}
 */
export function validatePipeline(pipeline, { knownTools } = {}) {
  if (!pipeline || typeof pipeline !== "object") return { ok: false, error: "a pipeline is an object with a steps array" };
  const steps = pipeline.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: "a pipeline needs at least one step" };
  if (steps.length > MAX_PIPELINE_STEPS) return { ok: false, error: `too many steps (max ${MAX_PIPELINE_STEPS})` };

  const seen = new Set();
  const toolSet = knownTools ? new Set(knownTools) : null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") return { ok: false, error: `step ${i} is not an object` };
    const id = String(step.id ?? "");
    if (!STEP_ID_RE.test(id)) return { ok: false, error: `step ${i} has an invalid id "${id}" (use letters/digits/-/_, ≤${MAX_STEP_ID_LEN})` };
    if (seen.has(id)) return { ok: false, error: `duplicate step id "${id}"` };
    const tool = String(step.tool ?? "");
    if (!tool) return { ok: false, error: `step "${id}" has no tool` };
    if (toolSet && !toolSet.has(tool)) return { ok: false, error: `step "${id}" names an unknown tool "${tool}"` };
    const args = step.args ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return { ok: false, error: `step "${id}" args must be an object` };
    let bytes;
    try { bytes = new TextEncoder().encode(JSON.stringify(args)).length; }
    catch { return { ok: false, error: `step "${id}" args are not serializable` }; }
    if (bytes > MAX_ARGS_BYTES) return { ok: false, error: `step "${id}" args too large (${bytes} > ${MAX_ARGS_BYTES})` };
    // Every binding in this step must reference an ALREADY-seen (earlier) step.
    const refErr = validateBindingRefs(args, seen, id);
    if (refErr) return { ok: false, error: refErr };
    seen.add(id);
  }
  const name = typeof pipeline.name === "string" ? pipeline.name.trim().slice(0, 80) : "";
  return { ok: true, pipeline: { name, steps } };
}

function validateBindingRefs(value, earlierIds, stepId, depth = 0) {
  if (depth > MAX_BINDING_DEPTH) return `step "${stepId}" args nest too deeply`;
  if (isBinding(value)) {
    if (!earlierIds.has(value.$ref)) {
      return `step "${stepId}" binds $ref "${value.$ref}" which is not an earlier step`;
    }
    if (value.path != null && typeof value.path !== "string") {
      return `step "${stepId}" binding path must be a string`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const e = validateBindingRefs(v, earlierIds, stepId, depth + 1); if (e) return e; }
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) { const e = validateBindingRefs(v, earlierIds, stepId, depth + 1); if (e) return e; }
  }
  return null;
}

/**
 * Resolve one step's args against the accumulated `results` map (stepId →
 * value). Replaces every binding token with the referenced value (or a sub-path
 * of it). Throws PipelineBindingError when a path does not exist — fail closed:
 * a step never runs against a silently-missing input.
 */
export function resolveStepArgs(args, results, depth = 0) {
  if (depth > MAX_BINDING_DEPTH) throw new PipelineBindingError("args nest too deeply");
  if (isBinding(args)) {
    if (!Object.prototype.hasOwnProperty.call(results, args.$ref)) {
      throw new PipelineBindingError(`$ref "${args.$ref}" has no result yet`);
    }
    const base = results[args.$ref];
    const val = getPath(base, args.path);
    if (val === undefined) {
      throw new PipelineBindingError(`binding ${args.$ref}${args.path ? "." + args.path : ""} did not resolve`);
    }
    return val;
  }
  if (Array.isArray(args)) return args.map((v) => resolveStepArgs(v, results, depth + 1));
  if (args && typeof args === "object") {
    const out = {};
    for (const [k, v] of Object.entries(args)) out[k] = resolveStepArgs(v, results, depth + 1);
    return out;
  }
  return args;
}

/**
 * Run a validated pipeline. `dispatchTool(name, args)` runs ONE existing tool
 * through the run's normal executor and returns a normalized envelope
 * `{ ok:boolean, value?, error? }` — the caller's adapter maps the real
 * executor (owner-approval + fencing + ledger) onto this shape, so each step
 * keeps its own gates. `onStep(evt)` receives `{ index, id, tool, status,
 * error? }` for the plan strip (status: "running" | "ok" | "failed").
 *
 * Returns `{ ok:true, steps:[{id, tool, result}], final }` or, on the first
 * failing step, `{ ok:false, failedStep, stepIndex, error, completed }`.
 */
export async function runPipeline(pipeline, { dispatchTool, onStep } = {}) {
  const v = validatePipeline(pipeline);
  if (!v.ok) return { ok: false, error: v.error };
  if (typeof dispatchTool !== "function") return { ok: false, error: "no tool dispatcher" };
  const emit = typeof onStep === "function" ? onStep : () => {};

  const results = Object.create(null);
  const completed = [];
  const stepsOut = [];

  for (let i = 0; i < v.pipeline.steps.length; i++) {
    const step = v.pipeline.steps[i];
    emit({ index: i, id: step.id, tool: step.tool, status: "running" });

    let resolvedArgs;
    try {
      resolvedArgs = resolveStepArgs(step.args ?? {}, results);
    } catch (e) {
      const error = e instanceof PipelineBindingError ? e.message : String(e?.message ?? e);
      emit({ index: i, id: step.id, tool: step.tool, status: "failed", error });
      return { ok: false, failedStep: step.id, stepIndex: i, error: `binding error: ${error}`, completed };
    }

    let env;
    try {
      env = await dispatchTool(step.tool, resolvedArgs);
    } catch (e) {
      env = { ok: false, error: String(e?.message ?? e) };
    }
    if (!env || env.ok !== true) {
      const error = env?.error ?? "the step's tool failed";
      emit({ index: i, id: step.id, tool: step.tool, status: "failed", error });
      return { ok: false, failedStep: step.id, stepIndex: i, error, completed };
    }

    results[step.id] = env.value;
    completed.push({ id: step.id, tool: step.tool });
    stepsOut.push({ id: step.id, tool: step.tool, result: env.value });
    emit({ index: i, id: step.id, tool: step.tool, status: "ok" });
  }

  return { ok: true, steps: stepsOut, final: stepsOut[stepsOut.length - 1]?.result };
}
