// lib/activity-kinds.js — the hub's Recent-activity kind allowlist, shared by
// the SERVER (routes/activity.js enforces it, default-deny) and the CLIENT
// (components.js filters seeded rows against it). One module so the two can
// never drift (CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01 r2 B1).
//
// Attestation rows are the durable prompt receipt and tool-call/tool-result/
// screenshot/error rows are protocol — they stay in the journal and in Run
// logs, never on the hub.
export const USER_VISIBLE_KINDS = Object.freeze([
  "task",
  "result",
  "artifact",
  "approval-requested",
  "approval-granted",
  "approval-denied",
  "schedule-ran",
]);

export const USER_VISIBLE_KINDS_SET = new Set(USER_VISIBLE_KINDS);
