// lib/run-budget.js — a run's step budget, in plain English.
//
// CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01: a run used to stop after four to
// six tool actions with nothing on screen saying why. The budget is FINITE
// (every bound below is named), VISIBLE ("Step N of M" while working) and
// RECOVERABLE: when the budget runs out with work still to do, the terminal is
// a budget stop with ONE action — Continue — which runs a new turn on the
// same thread (same context), never a silent finish.
//
// Pure: no chrome.*, no DOM. Shared by the agent loop (agent.js), the service
// worker (the terminal + the run.continue route) and the conversation surfaces.

export const RUN_BUDGET_BOUNDS = Object.freeze({
  // The most outer iterations any run may be given (named agents cap here).
  maxIterations: 64,
  // The most model steps one inner turn may hold.
  maxInnerSteps: 24,
  // The smallest inner turn that still fits one search + one execute.
  minInnerSteps: 2,
});

/** The run's default step budget. A run is `maxIterations` outer loop
 * iterations of at most `innerStepLimit` model steps each; the visible budget
 * is their product in MODEL STEPS. The hub default was 12 × 8: with the lazy
 * protocol charging a search + an execute per action that fitted ~4 tool
 * actions per inner turn, and the run gave up long before "every tab".
 * 48 × 24 fits a 30-tab loop in one inner turn with a reusable selection ref
 * (one execute per tab). */
export const RUN_BUDGET_DEFAULTS = Object.freeze({
  maxIterations: 48,
  innerStepLimit: (maxIterations) =>
    Math.max(RUN_BUDGET_BOUNDS.minInnerSteps, Math.min(Number(maxIterations) || 0, RUN_BUDGET_BOUNDS.maxInnerSteps)),
});

/** Clamp a caller-supplied outer-iteration budget into the finite bound;
 * undefined when the caller gave none (the default applies). */
export function boundedIterations(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(Math.trunc(n), RUN_BUDGET_BOUNDS.maxIterations);
}

/** The words the owner sees when the Continue button is pressed. The SW runs
 * this as the next user turn of the SAME thread, so the model sees every prior
 * turn (its own partial answer included) as context. */
export const BUDGET_CONTINUE_TASK =
  "Continue the previous task from where it stopped. Do not repeat items you already handled; finish the remaining items, then give the final answer.";

/** "Step 34 of 80" — the live counter text; empty when nothing is known. */
export function formatBudgetProgress(budget) {
  const step = Number(budget?.step);
  const total = Number(budget?.total);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return "";
  return `Step ${Math.max(0, Math.trunc(step))} of ${Math.trunc(total)}`;
}

/** The terminal a run settles with when its step budget ran out with work
 * still to do. `ok:false` because the task is NOT finished; the category and
 * action drive the status row's Continue button and the thread's error row. */
export function budgetExhaustedTerminal({ used, total } = {}) {
  const u = Number.isFinite(Number(used)) ? Math.trunc(Number(used)) : 0;
  const t = Number.isFinite(Number(total)) ? Math.trunc(Number(total)) : 0;
  return {
    ok: false,
    error: `Step budget reached (${u} of ${t}) before the task finished`,
    errorCategory: "budget",
    errorReason: `the run used all ${u} of its ${t} steps and still had work to do`,
    errorAction: "Continue",
    budget: { used: u, total: t, exhausted: true },
  };
}

export function isBudgetTerminal(terminal) {
  return !!terminal && typeof terminal === "object" && terminal.errorCategory === "budget";
}
