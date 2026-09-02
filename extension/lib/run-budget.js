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

/** "Step 34 of 80" — the live counter text; empty when nothing is known.
 * With the running result counts the runtime digests (CAP-FB-20260902-LOOP-
 * CONTEXT-WINDOW-01) it reads "Step 34 of 80 · 12 results, 1 failed". */
export function formatBudgetProgress(budget) {
  const step = Number(budget?.step);
  const total = Number(budget?.total);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return "";
  let text = `Step ${Math.max(0, Math.trunc(step))} of ${Math.trunc(total)}`;
  const count = Number(budget?.results?.count);
  if (Number.isFinite(count) && count > 0) {
    const failed = Number(budget?.results?.failed);
    text += ` · ${Math.trunc(count)} result${count === 1 ? "" : "s"}`;
    if (Number.isFinite(failed) && failed > 0) text += `, ${Math.trunc(failed)} failed`;
  }
  return text;
}

/** THE BUDGET VERDICT (CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01). A run is
 * "Budget reached" only when BOTH hold:
 *   - the loop stopped because the budget ran out — the LAST allowed outer
 *     iteration still ended in tool calls (agent-do breaks the loop only on a
 *     no-tool-call step), and the run was not aborted; AND
 *   - NO substantive final text landed (`run-text-steps.js` `finalText`,
 *     whitespace-trimmed).
 * A run that wrote its answer on its last allowed step — even while still
 * calling tools — answered: it settles as finished, never as a budget stop.
 * A run with no substantive text is never claimed ok. */
export function budgetExhaustedVerdict({ aborted, lastStepHadTools, lastStepIndex, maxIterations, hasFinalText } = {}) {
  if (aborted === true) return false;
  if (lastStepHadTools !== true) return false;
  const last = Number(lastStepIndex);
  const max = Math.trunc(Number(maxIterations));
  if (!Number.isFinite(last) || !Number.isFinite(max) || last < max - 1) return false;
  return hasFinalText !== true;
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

/* ── THE CONTINUATION BUDGET (CAP-FB-20260830-MODEL-CALL-ECONOMY-01) ────────
 * agent-do sends "Continue working on the task…" after ANY outer iteration
 * that called tools. Two of those continuations are waste, and the loop's own
 * `onStepStart → {decision:"stop"}` hook is where the product declines them:
 *   - ANSWERED: the iteration called tools, wrote its answer, and its last
 *     model call finished on its own (finish reason "stop", not the inner
 *     step limit's "tool-calls") — a continuation could only repeat it.
 *   - SILENT ×N: the iteration called tools and then said nothing; one nudge
 *     is fair (the model may need the prompt), CONTINUATION_SILENT_CAP in a
 *     row is a loop, and the run stops visibly ("Stopped after N steps").
 * An inner-step-limit boundary is neither: it always continues, carrying the
 * runtime digest (lib/run-digest.js). Pure; shared by the agent loop, the
 * worker loop seam, the service worker's terminal and the surfaces. */
export const CONTINUATION_SILENT_CAP = 3;

/** An iteration that called tools, wrote nothing, and finished on its own. */
export function isSilentIteration(iteration) {
  return !!iteration && iteration.hasToolCalls === true &&
    !String(iteration.text ?? "").trim() && iteration.finishedWithToolCalls !== true;
}

/** What onStepStart decides before a continuation call:
 *  "answered" — stop, the previous iteration already answered;
 *  "silent-cap" — stop visibly, the model keeps calling tools and saying nothing;
 *  "continue" — send the continuation (a first silence, or an inner-step-limit boundary). */
export function continuationStopDecision({ lastIteration, silentContinuations } = {}) {
  const it = lastIteration;
  if (it && it.hasToolCalls === true && String(it.text ?? "").trim() && it.finishedWithToolCalls !== true) return "answered";
  if (Number(silentContinuations) >= CONTINUATION_SILENT_CAP) return "silent-cap";
  return "continue";
}

/** "Stopped after 6 steps" — steps are model steps, the unit "Step N of M"
 * already shows the owner. */
export function formatContinuationStop(stopped) {
  const steps = Math.max(0, Math.trunc(Number(stopped?.steps) || 0));
  return `Stopped after ${steps} step${steps === 1 ? "" : "s"}`;
}

/** The terminal a run settles with when the continuation cap stopped it.
 * Budget-family (category "budget", `budget.stopped` set) so the status row's
 * Continue action and the run.continue route apply unchanged; the words say
 * what happened instead of "Budget reached". */
export function continuationStopTerminal({ used, total, stopped } = {}) {
  const u = Number.isFinite(Number(used)) ? Math.trunc(Number(used)) : 0;
  const t = Number.isFinite(Number(total)) ? Math.trunc(Number(total)) : 0;
  const steps = Number.isFinite(Number(stopped?.steps)) ? Math.trunc(Number(stopped.steps)) : u;
  const iterations = Number.isFinite(Number(stopped?.iterations)) ? Math.trunc(Number(stopped.iterations)) : CONTINUATION_SILENT_CAP;
  const marker = formatContinuationStop({ steps });
  return {
    ok: false,
    error: `${marker} — the model kept calling tools without answering`,
    errorCategory: "budget",
    errorReason: `${marker} — the model answered ${iterations} continuation${iterations === 1 ? "" : "s"} with tool calls and no text`,
    errorAction: "Continue",
    budget: { used: u, total: t, exhausted: false, stopped: { reason: "iteration-cap", steps, iterations } },
  };
}

export function isContinuationStopTerminal(terminal) {
  return isBudgetTerminal(terminal) && !!terminal.budget?.stopped;
}
