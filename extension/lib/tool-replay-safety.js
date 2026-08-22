// lib/tool-replay-safety.js — the fail-closed per-tool replay-safety authority
// for durable-run interruption recovery (CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01).
//
// The durable recovery sweep decides whether an interrupted run may auto-resume
// or must pause for an owner decision. That decision is made from THIS
// declaration — never from the progress count alone:
//
//   - "read-only"  tools observe without mutating state — safe to re-run.
//   - "idempotent" tools may re-run safely with the stable execution
//     idempotency key (replaying applies the same effect once).
//   - "mutating"   tools have external side effects whose outcome is uncertain
//     after an interruption — NEVER auto-resumed.
//
// FAIL-CLOSED: any tool with NO declaration, an unknown name, or an explicit
// "mutating" declaration pauses the run as `paused-side-effect-uncertain` and
// requires the owner Retry/Cancel. Only a run whose EVERY progressed tool is
// explicitly "read-only" or "idempotent" may auto-resume with the stable
// execution idempotency key. No UI or documentation claims universal exactly-once
// external effects.

export const REPLAY_READ_ONLY = "read-only";
export const REPLAY_IDEMPOTENT = "idempotent";
export const REPLAY_MUTATING = "mutating";

// The extension's OWN memory toolset (extension/lib/agent.js memoryToolset):
// reads are read-only; memory_set is key-bound and idempotent (replaying writes
// the same value under the same key — the last-write-wins effect is identical).
export const READ_ONLY_TOOLS = new Set([
  "memory_get",
  "memory_grep",
  "memory_list",
]);

export const IDEMPOTENT_TOOLS = new Set([
  "memory_set",
]);

const SAFETY_ORDER = [REPLAY_READ_ONLY, REPLAY_IDEMPOTENT, REPLAY_MUTATING];

/** The declared replay safety for one tool name. Unknown/missing names fail
 * closed to "mutating" — an interruption after such a tool's progress must
 * pause for an owner decision. */
export function replaySafetyForTool(toolName) {
  const name = String(toolName ?? "");
  if (!name) return REPLAY_MUTATING;
  if (READ_ONLY_TOOLS.has(name)) return REPLAY_READ_ONLY;
  if (IDEMPOTENT_TOOLS.has(name)) return REPLAY_IDEMPOTENT;
  return REPLAY_MUTATING;
}

/** The WORST (least replayable) of two classifications. */
export function worstSafety(a, b) {
  return SAFETY_ORDER[Math.max(
    SAFETY_ORDER.indexOf(a ?? REPLAY_MUTATING),
    SAFETY_ORDER.indexOf(b ?? REPLAY_MUTATING),
  )];
}

/** Whether an interrupted run may AUTO-RESUME given the worst progressed-tool
 * safety: only explicit read-only/idempotent work (the fail-closed default is
 * mutating → no auto-resume). */
export function mayAutoResume(worstClassification) {
  return worstClassification === REPLAY_READ_ONLY ||
    worstClassification === REPLAY_IDEMPOTENT;
}
