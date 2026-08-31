// shared/plan-strip.js — the PURE plan-strip model.
//
// A running multi-step task has a durable-run registry underneath but, until
// now, no visible plan (CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01). This module
// is the small, testable reducer that turns the run's own step events (the
// tool calls streaming through the progress port) into a compact checklist:
// the current step active, completed ones checked. It is DOM-free so the live
// strip (conversation.js runConversationTurn) and a reopened running thread
// (renderRunTranscript) compute the SAME model from the SAME events, and it is
// unit-testable without a browser.
//
// The model is a list of steps, each `{ label, status }` where status is one of
// "active" | "done" | "error", plus a run-level `state` of
// "idle" | "running" | "settled". Steps are appended as tool calls START and
// resolved (FIFO — the oldest active step first, mirroring the tool-card queue)
// as their results arrive; a terminal event settles the strip.

/** A fresh, empty plan. */
export function emptyPlan() {
  return { steps: [], state: "idle" };
}

const STEP_STATUSES = new Set(["active", "done", "error"]);

function normalizeLabel(value, fallback) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || fallback;
}

/** Fold ONE normalized plan event into the plan, returning a NEW plan (the
 * input is never mutated). Event shapes:
 *   { type: "step-start", label }          — a tool call began (a new step)
 *   { type: "step-end", status, label? }   — the oldest active step resolved
 *   { type: "settle" }                     — the run finished; active → done
 *   { type: "fail" }                       — the run errored; active → error
 * Unknown events are ignored (the plan is returned unchanged). */
export function reducePlan(plan, ev) {
  const base = plan && Array.isArray(plan.steps) ? plan : emptyPlan();
  const steps = base.steps.map((s) => ({ label: s.label, status: s.status }));
  let state = base.state === "settled" || base.state === "running" ? base.state : "idle";
  switch (ev?.type) {
    case "step-start": {
      steps.push({ label: normalizeLabel(ev.label, "Working…"), status: "active" });
      state = "running";
      break;
    }
    case "step-end": {
      const i = steps.findIndex((s) => s.status === "active");
      if (i >= 0) {
        if (typeof ev.label === "string" && ev.label.trim()) steps[i].label = ev.label.trim();
        steps[i].status = ev.status === "error" ? "error" : "done";
      }
      break;
    }
    case "settle": {
      for (const s of steps) if (s.status === "active") s.status = "done";
      state = "settled";
      break;
    }
    case "fail": {
      for (const s of steps) if (s.status === "active") s.status = "error";
      state = "settled";
      break;
    }
    default:
      return base;
  }
  return { steps, state };
}

/** Fold a whole sequence of events into one plan (a REPLAY of the run so far).
 * The reopened-thread path and the tests both use this. */
export function planFromEvents(events) {
  let plan = emptyPlan();
  for (const ev of Array.isArray(events) ? events : []) plan = reducePlan(plan, ev);
  return plan;
}

/** A compact, render-ready summary of a plan: the total steps, how many have
 * resolved, the label of the step currently in flight (or null), and whether
 * any step errored. Drives the strip's summary line and its aria-live text. */
export function planSummary(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const total = steps.length;
  const resolved = steps.filter((s) => s.status === "done" || s.status === "error").length;
  const active = steps.find((s) => s.status === "active") ?? null;
  const errored = steps.some((s) => s.status === "error");
  return {
    total,
    resolved,
    // The 1-based ordinal of the step in flight (or, when none is active, the
    // count resolved) — "step 2 of 3" reads honestly as the run discovers steps.
    current: active ? Math.min(resolved + 1, total) : resolved,
    activeLabel: active ? active.label : null,
    errored,
  };
}

/** True when a step status is one this module recognizes (guards the renderer
 * against a hostile/garbled attribute). */
export function isPlanStepStatus(value) {
  return STEP_STATUSES.has(value);
}
