// lib/run-text-steps.js — which of a run's per-step texts is the ANSWER
// (CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01).
//
// agent-do's loop sends a synthetic user turn ("Continue working on the task…
// respond with your final summary") after ANY step that made a tool call — even
// when that step already ended in the model's real answer. Every model replies
// to the nudge with a "Task complete / here is a summary" paragraph, and because
// only the LAST step's text used to become the run result (and the thread's
// terminal message), the user's real answer was replaced by boilerplate.
//
// This tracker is pure and shared by the agent loop (which decides the run's
// result + marks the nudge reply hidden) and the tests. Rules:
//   - a step that made tool calls AND ended in text is a substantive answer:
//     it is emitted, persisted as an intermediate thread message, and
//     remembered as the candidate result;
//   - a text-only step immediately after such a step is the NUDGE REPLY: it is
//     hidden (never rendered, never persisted) and never the result;
//   - a text-only step after a tool step that ended WITHOUT text is the real
//     answer (the model needed the tool results before answering);
//   - a text-only first step (no tools at all) is simply the answer.
// Only whitespace-trimmed non-empty text counts.

export function createRunTextTracker() {
  let lastStep = null; // { step, hasToolCalls, text }
  let substantive = null; // the latest substantive (tool-step) answer text
  let hiddenLast = false; // the most recent text was a hidden nudge reply

  const trimmed = (value) => String(value ?? "").trim();

  return {
    /** Classify one completed step. Returns { text, hidden, persist }. */
    step(e) {
      const step = Number.isFinite(e?.step) ? e.step : (lastStep ? lastStep.step + 1 : 0);
      const hasToolCalls = e?.hasToolCalls === true;
      const text = trimmed(e?.text);
      const prev = lastStep;
      lastStep = { step, hasToolCalls, text };
      if (!text) {
        hiddenLast = false;
        return { text: "", hidden: false, persist: false };
      }
      const nudgeReply = !hasToolCalls && prev != null && prev.hasToolCalls && prev.text.length > 0 && step === prev.step + 1;
      if (nudgeReply) {
        hiddenLast = true;
        return { text, hidden: true, persist: false };
      }
      hiddenLast = false;
      if (hasToolCalls) {
        substantive = text;
        return { text, hidden: false, persist: true };
      }
      return { text, hidden: false, persist: false };
    },
    /** The run's result: the substantive answer when the loop ended on a
     *  hidden nudge reply; otherwise the loop's own final text. */
    finalText(loopText) {
      const text = typeof loopText === "string" ? loopText : "";
      if (hiddenLast && substantive) return substantive;
      return text;
    },
    /** Whether the loop's final text was a hidden nudge reply. */
    endedOnNudge() {
      return hiddenLast && Boolean(substantive);
    },
    /** Whether the NEXT step, if it turns out text-only, would be the hidden
     *  nudge reply — decided at step START so the streaming tee can hold its
     *  deltas back (a hidden step must never stream; a step that then makes a
     *  tool call is not the nudge and its text still lands at step end). */
    nextStepMayBeNudge() {
      return lastStep != null && lastStep.hasToolCalls && lastStep.text.length > 0;
    },
  };
}
