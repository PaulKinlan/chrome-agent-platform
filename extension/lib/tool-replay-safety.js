// lib/tool-replay-safety.js — the fail-closed per-tool replay-safety authority
// for durable-run interruption recovery (CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01).
//
// The durable recovery sweep decides whether an interrupted run may auto-resume
// or must pause for an owner decision. That decision is made from THIS
// declaration — never from the progress count alone:
//
//   - "read-only"  tools observe without mutating state — safe to re-run.
//   - "idempotent" tools may re-run safely with the STABLE per-tool-call
//     idempotency key (executionId + attempt-stable tool-call index).
//   - "mutating"   tools have external side effects whose outcome is uncertain
//     after an interruption — NEVER auto-resumed.
//   - "unknown"    tools have no trusted declaration (page/WebMCP tools unless
//     a trusted declaration authority exists) — treated EXACTLY like mutating.
//
// The canonical bounded enum is { read-only, idempotent, mutating, unknown }.
// The DEFAULT for anything undeclared is "unknown" (fail closed). Every
// extension built-in is explicitly classified. HOSTILE inputs (a throwing
// String(), a getter/Proxy, oversized values, a non-enum string) normalize to
// "unknown" — and the worst-merge can never let an invalid value retain a
// read-only/idempotent classification.
//
// No UI or documentation claims universal exactly-once external effects.

export const REPLAY_READ_ONLY = "read-only";
export const REPLAY_IDEMPOTENT = "idempotent";
export const REPLAY_MUTATING = "mutating";
export const REPLAY_UNKNOWN = "unknown";

export const REPLAY_SAFETIES = Object.freeze([
  REPLAY_READ_ONLY,
  REPLAY_IDEMPOTENT,
  REPLAY_MUTATING,
  REPLAY_UNKNOWN,
]);

// The worst-first ordering for the merge: unknown/mutating always win over
// read-only/idempotent; an INVALID value cannot rank as safer than the current.
const WORST_ORDER = [REPLAY_UNKNOWN, REPLAY_MUTATING, REPLAY_IDEMPOTENT, REPLAY_READ_ONLY];

// ── the explicit built-in classifications (every shipped tool) ──────────────
// Browser reads (the browserToolset readOnly set): observe only.
const BROWSER_READ_TOOLS = new Set([
  "read_page",
  "capture_screenshot",
  "list_tabs",
  "recent_browser_events",
  // Tranche-1 Chrome API coverage: window inventory + own-action state +
  // declared commands are observe-only.
  "list_windows",
  "get_action_state",
  "list_commands",
  // Tranche-2 Chrome API coverage: alarms, bookmarks, idle, contextMenus reads
  "list_alarms",
  "list_bookmarks",
  "query_idle_state",
  "list_context_menus",
  // Tranche-7 Chrome API coverage: sessions + history reads
  "list_recently_closed",
  "list_synced_devices",
  "search_history",
  "get_history_visits",
]);
// Memory reads: observe only.
const MEMORY_READ_TOOLS = new Set(["memory_get", "memory_grep", "memory_list"]);
// Management/registry reads: observe only.
const REGISTRY_READ_TOOLS = new Set([
  "get_agent", "list_agents", "get_asset", "list_assets", "get_usage", "get_memory_overview",
  "get_named_agent", "list_named_agents", "list_hooks", "list_scripts", "get_script", "list_skills", "list_tools",
]);
// Key-bound writes (replaying writes the same value under the same key — the
// last-write-wins effect is identical) or idempotent-by-identity creations.
const IDEMPOTENT_TOOLS = new Set([
  "memory_set",
  "memory_append",
  "skill_add",
  "subscribe_hook",
  "unsubscribe_hook",
]);

export const READ_ONLY_TOOLS = new Set([
  ...BROWSER_READ_TOOLS,
  ...MEMORY_READ_TOOLS,
  ...REGISTRY_READ_TOOLS,
]);

function safeString(value) {
  // Hostile inputs (a throwing toString, a getter/Proxy, a Symbol) never throw
  // the classifier — they become the empty string, which normalizes to unknown.
  try {
    return String(value ?? "");
  } catch {
    return "";
  }
}

/** Normalize ANY input to the canonical enum — hostile/non-enum/empty values
 * become "unknown" (fail closed). */
export function normalizeSafety(value) {
  const s = safeString(value).trim();
  return REPLAY_SAFETIES.includes(s) ? s : REPLAY_UNKNOWN;
}

/** The declared replay safety for one tool name. Undeclared / hostile /
 * page-owned names fail closed to "unknown" — an interruption after such a
 * tool's progress must pause for an owner decision. */
export function replaySafetyForTool(toolName) {
  const name = safeString(toolName).trim();
  if (!name) return REPLAY_UNKNOWN;
  if (READ_ONLY_TOOLS.has(name)) return REPLAY_READ_ONLY;
  if (IDEMPOTENT_TOOLS.has(name)) return REPLAY_IDEMPOTENT;
  // Every built-in is either classified above or is a mutating built-in; any
  // OTHER name (page/WebMCP, undeclared) is unknown unless a trusted
  // declaration authority says otherwise.
  if (BUILT_IN_TOOLS.has(name)) return REPLAY_MUTATING;
  return REPLAY_UNKNOWN;
}

// The full shipped built-in name set (browser + management + memory + hooks +
// scripts) — used so the classifier can distinguish "known mutating built-in"
// from "page-owned unknown". Everything else is unknown.
const BUILT_IN_TOOLS = new Set([
  "read_page", "capture_screenshot", "list_tabs", "recent_browser_events",
  "close_tab", "navigate_tab", "open_tab", "open_side_panel", "schedule_task",
  // Tranche-1 Chrome API coverage (reads are classified above; ALL are built-ins):
  "list_windows", "get_action_state", "list_commands",
  "create_window", "focus_window", "close_window", "move_window", "set_action_state",
  // Tranche-2 Chrome API coverage:
  "create_alarm", "list_alarms", "clear_alarm",
  "create_bookmark", "list_bookmarks", "remove_bookmark",
  "notify", "clear_notification",
  "query_idle_state",
  "create_context_menu", "list_context_menus", "remove_context_menu",
  // Tranche-7 Chrome API coverage (reads classified above; ALL are built-ins):
  "list_recently_closed", "restore_closed", "list_synced_devices",
  "search_history", "get_history_visits", "add_history_url",
  "delete_history_url", "delete_history_range", "clear_all_history",
  "memory_get", "memory_grep", "memory_list", "memory_set",
  "create_agent", "update_agent", "delete_agent", "get_agent", "list_agents",
  "disenroll_origin", "create_asset", "update_asset", "delete_asset", "list_assets",
  "get_asset", "get_usage", "get_memory_overview",
  "create_named_agent", "update_named_agent", "delete_named_agent", "get_named_agent",
  "list_named_agents", "set_agent_provider", "list_hooks", "subscribe_hook",
  "unsubscribe_hook", "generate_ui", "create_script", "update_script",
  "delete_script", "list_scripts", "get_script", "run_script",
]);

/** The WORST (least replayable) of two classifications. Invalid inputs are
 * normalized to unknown, so a hostile value can never retain a read-only/
 * idempotent result. */
export function worstSafety(a, b) {
  const na = normalizeSafety(a);
  const nb = normalizeSafety(b);
  return WORST_ORDER[Math.min(WORST_ORDER.indexOf(na), WORST_ORDER.indexOf(nb))];
}

/** Whether an interrupted run may AUTO-RESUME given the worst progressed-tool
 * safety: only explicit read-only/idempotent (unknown/mutating fail closed). */
export function mayAutoResume(worstClassification) {
  const n = normalizeSafety(worstClassification);
  return n === REPLAY_READ_ONLY || n === REPLAY_IDEMPOTENT;
}

/** The STABLE per-tool-call idempotency key — executionId + the attempt-stable
 * tool-call index. Byte-identical across resume (the index persists in the
 * durable record, never a fresh run-instance UUID). */
export function perCallIdempotencyKey({ executionId, toolName, callIndex }) {
  return `${safeString(executionId)}:${safeString(toolName)}:${String(callIndex)}`;
}
