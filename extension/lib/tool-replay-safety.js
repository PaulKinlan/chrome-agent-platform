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
  // Tranche-8 Chrome API coverage: cookie/content-setting reads observe only.
  "list_cookies",
  "list_cookie_stores",
  "get_cookie",
  "get_content_setting",
  // Tranche-3/4 Chrome API coverage: tab-group inventory + download history reads
  "list_tab_groups",
  "list_downloads",
  // Tranche-13 Chrome API coverage: tab zoom + sidePanel options reads.
  "get_tab_zoom",
  "get_side_panel_options",
  // Tranche-5/6 Chrome API coverage (CAP-FB-20260825): system/topSites/
  // permissions inventory + reading-list query + MHTML save are observe-only
  // (no browser state changes — the capture_screenshot precedent).
  "get_system_memory",
  "get_system_cpu",
  "get_system_storage",
  "get_system_display",
  "list_top_sites",
  "list_granted_permissions",
  "query_reading_list",
  "save_page_as_mhtml",
  // Tranche-7 Chrome API coverage: sessions + history reads
  "list_recently_closed",
  "list_synced_devices",
  "search_history",
  "get_history_visits",
  // Tranche-11 Chrome API coverage: extension/runtime/side-panel reads observe only.
  "list_extensions",
  "get_extension",
  "get_extension_permission_warnings",
  "get_platform_info",
  "get_extension_manifest",
  // Tranche-9 Chrome API coverage: browser-settings inventory reads observe only.
  "get_privacy_setting",
  "get_proxy_settings",
  "get_font_settings",
  "list_tts_voices",
  "tts_is_speaking",
  // Tranche-10 Chrome API coverage: rule inventory/match-testing, frame reads
  // and request-activity observation are observe-only.
  "list_network_rules",
  "get_network_rule_matches",
  "get_navigation_frames",
  "get_navigation_frame",
  "get_request_activity",
  // Tranche-12 Chrome API coverage: script registries
  "list_user_scripts",
  "list_content_scripts",
  // CAP-FB-20260830-PAGE-ACTION-TOOLS-01: the page-action reads observe only —
  // a snapshot, a scroll and a bounded wait leave no durable state to reverse,
  // so they are safe to re-run after an interruption.
  "find_elements",
  "scroll_page",
  "wait_for",
]);
// Memory reads: observe only.
const MEMORY_READ_TOOLS = new Set(["memory_get", "memory_grep", "memory_list"]);
// Management/registry reads: observe only.
const REGISTRY_READ_TOOLS = new Set([
  "get_agent", "list_agents", "get_asset", "list_assets", "get_usage", "get_memory_overview",
  "get_named_agent", "list_named_agents", "list_hooks", "list_scripts", "get_script", "list_skills", "list_tools",
  "schedules_list",
  // The shared jobs board (2026-08-29): reads.
  "board_list", "board_read", "board_read_messages",
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
  "close_tab", "navigate_tab", "open_tab", "schedule_task",
  // Tranche-1 Chrome API coverage (reads are classified above; ALL are built-ins):
  "list_windows", "get_action_state", "list_commands",
  "create_window", "focus_window", "close_window", "move_window", "set_action_state",
  // Tranche-2 Chrome API coverage:
  "create_alarm", "list_alarms", "clear_alarm",
  "create_bookmark", "list_bookmarks", "remove_bookmark",
  "notify", "clear_notification",
  "query_idle_state",
  "create_context_menu", "list_context_menus", "remove_context_menu",
  // Tranche-8 Chrome API coverage (reads are classified above; ALL are built-ins):
  "list_cookies", "list_cookie_stores", "get_cookie",
  "set_cookie", "remove_cookie",
  "wipe_browsing_data",
  "get_content_setting", "set_content_setting", "clear_content_settings",
  // Tranche-3 Chrome API coverage: tabGroups (mutations; the reads are above)
  "group_tabs", "update_tab_group", "ungroup_tabs", "move_tab_to_group",
  // Tranche-4 Chrome API coverage: downloads (mutations; list_downloads above)
  "download_file", "pause_download", "resume_download", "cancel_download",
  "erase_download", "show_download", "open_download", "remove_download_file",
  // Tranche-13 Chrome API coverage (reads are classified above; ALL are built-ins):
  "get_tab_zoom", "get_side_panel_options",
  "move_tab", "duplicate_tab", "set_tab_pinned", "reload_tab",
  "tab_go_back", "tab_go_forward", "set_tab_zoom", "discard_tab", "highlight_tabs",
  "enable_action", "disable_action", "set_side_panel_options", "set_panel_behavior",
  // Tranche-5/6 (reads classified above; ALL are built-ins):
  "get_system_memory", "get_system_cpu", "get_system_storage", "get_system_display",
  "list_top_sites", "list_granted_permissions",
  "add_reading_list_entry", "query_reading_list", "update_reading_list_entry",
  "remove_reading_list_entry", "save_page_as_mhtml",
  // Tranche-7 Chrome API coverage (reads classified above; ALL are built-ins):
  "list_recently_closed", "restore_closed", "list_synced_devices",
  "search_history", "get_history_visits", "add_history_url",
  "delete_history_url", "delete_history_range", "clear_all_history",
  // Tranche-11 Chrome API coverage: extension/browser management (reads above;
  // ALL 12 are built-ins; the 6 mutations are classified mutating by exclusion).
  "list_extensions", "get_extension", "get_extension_permission_warnings",
  "set_extension_enabled", "uninstall_extension",
  "get_platform_info", "get_extension_manifest",
  // Tranche-9 Chrome API coverage: browser settings (reads are classified above;
  // ALL are built-ins; mutations are browser-wide + global-grant-gated).
  "set_privacy_setting",
  "set_proxy_settings", "clear_proxy_settings",
  "set_font_size", "set_default_font", "clear_font_settings",
  "request_keep_awake", "release_keep_awake",
  "search_query",
  "tts_speak", "tts_stop",
  // Tranche-10 Chrome API coverage: network rules + navigation + request
  // observation (reads classified above; ALL are built-ins).
  "list_network_rules", "add_network_rule", "update_network_rule",
  "remove_network_rule", "get_network_rule_matches",
  "get_navigation_frames", "get_navigation_frame", "get_request_activity",
  // Tranche-12 Chrome API coverage: user/content scripts
  // (reads are classified above; ALL are built-ins).
  "register_user_script", "update_user_script", "unregister_user_script", "list_user_scripts",
  "register_content_script", "update_content_script", "unregister_content_script", "list_content_scripts",
  // CAP-FB-20260830-PAGE-ACTION-TOOLS-01: the page-action family (reads
  // classified above; click/type/select are mutating by exclusion).
  "find_elements", "click_element", "type_text", "select_option", "scroll_page", "wait_for",
  "memory_get", "memory_grep", "memory_list", "memory_set",
  "create_agent", "update_agent", "delete_agent", "get_agent", "list_agents",
  "disenroll_origin", "create_asset", "update_asset", "patch_asset", "delete_asset", "list_assets",
  "get_asset", "get_usage", "get_memory_overview",
  "create_named_agent", "update_named_agent", "delete_named_agent", "get_named_agent",
  "list_named_agents", "set_agent_provider", "list_hooks", "subscribe_hook",
  "unsubscribe_hook", "generate_ui", "create_script", "update_script",
  "delete_script", "list_scripts", "get_script", "run_script",
  // Per-agent schedule controls: mutating built-ins (route-gated by owner
  // approval; a replay re-runs the gated route, so the gate re-arms).
  "schedules_pause", "schedules_resume", "schedules_update",
  // Agent→agent delegation (G5): spawns a child run — mutating built-in.
  "delegate_to_agent",
  // The shared jobs board (2026-08-29): posting/claiming/settling/messaging
  // mutate the hub-level board store — mutating built-ins (reads above).
  "board_post_job", "board_claim_job", "board_complete_job", "board_send_message",
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
