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
      return { state, label: activity || "Queued", active: true, tone: "muted" };
    case "running":
      return { state, label: activity || "Working…", active: true, tone: "accent" };
    case "retrying":
      return { state, label: activity || "Retrying…", active: true, tone: "accent" };
    case "waiting-for-permission":
      return { state, label: `Waiting for permission${reason ? ` — ${reason}` : ""}`, active: false, tone: "muted" };
    case "completed":
      return { state, label: "Completed", active: false, tone: "success" };
    case "failed":
      return { state, label: `Failed${reason ? ` — ${reason}` : ""}`, active: false, tone: "danger" };
    case "cancelled":
      return { state, label: "Cancelled", active: false, tone: "muted" };
    default:
      return null;
  }
}
