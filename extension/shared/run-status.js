// Pure lifecycle normalization for the single conversation run-status surface.
// Keep legacy aliases while every caller migrates to the canonical vocabulary.
const STATE_ALIASES = Object.freeze({
  working: "running",
  done: "completed",
  error: "failed",
});

const CANONICAL_STATES = new Set([
  "queued",
  "running",
  "retrying",
  "waiting-for-permission",
  "completed",
  "failed",
  "cancelled",
]);

export function normalizeConversationRunStatus(input) {
  if (!input || typeof input !== "object") return null;
  const rawState = typeof input.state === "string" ? input.state.trim().toLowerCase() : "";
  const state = STATE_ALIASES[rawState] ?? rawState;
  if (!CANONICAL_STATES.has(state)) return null;

  const activity = typeof input.activity === "string" ? input.activity.trim() : "";
  const reason = typeof input.errorReason === "string" && input.errorReason.trim()
    ? input.errorReason.trim()
    : typeof input.message === "string" && input.message.trim()
      ? input.message.trim()
      : "";

  switch (state) {
    case "queued":
      return { state, label: activity || "Queued", active: true, stoppable: true, tone: "muted" };
    case "running":
      return { state, label: activity || "Working…", active: true, stoppable: true, tone: "accent" };
    case "retrying":
      return { state, label: activity || "Retrying…", active: true, stoppable: true, tone: "accent" };
    case "waiting-for-permission":
      return { state, label: `Waiting for permission${reason ? ` — ${reason}` : ""}`, active: false, stoppable: true, tone: "muted" };
    case "completed":
      return { state, label: "Completed", active: false, stoppable: false, tone: "success" };
    case "failed":
      return { state, label: `Failed${reason ? ` — ${reason}` : ""}`, active: false, stoppable: false, tone: "danger" };
    case "cancelled":
      return { state, label: "Stopped", active: false, stoppable: false, tone: "muted" };
    default:
      return null;
  }
}

// The recovery action for a terminal/waiting status whose cause the owner can
// fix in Settings (provider auth, model config, host permission, network).
// ONE authority shared by the NTP thread surface and the sidepanel — the
// sidepanel dropping this logic was review P1-b (2026-08-28).
const RECOVERABLE_CATEGORY = /host-permission|provider-auth|model-config|network/i;

export function runStatusActionLabel(input) {
  const raw = typeof input?.state === "string" ? input.state.trim().toLowerCase() : "";
  const state = STATE_ALIASES[raw] ?? raw;
  if (state !== "failed" && state !== "waiting-for-permission") return null;
  const category = typeof input?.errorCategory === "string" ? input.errorCategory : "";
  return RECOVERABLE_CATEGORY.test(category) ? "Fix in Settings" : null;
}

/** Project one canonical run status into an <agent-conversation>.
 * Shared by the NTP and sidepanel so terminal recovery actions cannot diverge. */
export function projectConversationRunStatus(conversation, input) {
  if (!conversation) return;
  const state = typeof input?.state === "string" ? input.state : "";
  if (!state || state === "idle") {
    conversation.clearLiveStatus?.();
    return;
  }
  conversation.setLiveStatus?.({
    state,
    activity: input?.activity,
    message: input?.message,
    errorReason: input?.errorReason,
    actionLabel: runStatusActionLabel(input),
  });
}
