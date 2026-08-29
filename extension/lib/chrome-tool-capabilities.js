// lib/chrome-tool-capabilities.js — canonical bounded metadata for the exact
// shipped browser + management tool inventory.
//
// The table contains DATA ONLY. It is not a grant, permission request,
// dispatcher, validator, provider binding, or execution allowlist.

export const CHROME_TOOL_CAPABILITY_BOUNDS = Object.freeze({
  browserTools: 126,
  managementTools: 34,
  totalTools: 160,
  maxCapabilityTokens: 4,
  maxCapabilityTokenBytes: 96,
  maxPermissions: 8,
  maxPermissionBytes: 32,
  maxRouteFamilyBytes: 64,
});

export const BROWSER_TOOL_NAMES = Object.freeze([
  "open_side_panel",
  "open_tab",
  "navigate_tab",
  "read_page",
  "capture_screenshot",
  "list_tabs",
  "close_tab",
  "recent_browser_events",
  "schedule_task",
  "list_windows",
  "create_window",
  "focus_window",
  "close_window",
  "move_window",
  "set_action_state",
  "get_action_state",
  "list_commands",
  "create_alarm",
  "list_alarms",
  "clear_alarm",
  "create_bookmark",
  "list_bookmarks",
  "remove_bookmark",
  "notify",
  "clear_notification",
  "query_idle_state",
  "create_context_menu",
  "list_context_menus",
  "remove_context_menu",
  "list_cookies",
  "list_cookie_stores",
  "get_cookie",
  "set_cookie",
  "remove_cookie",
  "wipe_browsing_data",
  "get_content_setting",
  "set_content_setting",
  "clear_content_settings",
  "list_tab_groups",
  "group_tabs",
  "update_tab_group",
  "ungroup_tabs",
  "move_tab_to_group",
  "download_file",
  "list_downloads",
  "pause_download",
  "resume_download",
  "cancel_download",
  "erase_download",
  "show_download",
  "open_download",
  "remove_download_file",
  "move_tab",
  "duplicate_tab",
  "set_tab_pinned",
  "reload_tab",
  "tab_go_back",
  "tab_go_forward",
  "get_tab_zoom",
  "set_tab_zoom",
  "discard_tab",
  "highlight_tabs",
  "enable_action",
  "disable_action",
  "get_side_panel_options",
  "set_side_panel_options",
  "set_panel_behavior",
  "get_system_memory",
  "get_system_cpu",
  "get_system_storage",
  "get_system_display",
  "list_top_sites",
  "list_granted_permissions",
  "add_reading_list_entry",
  "query_reading_list",
  "update_reading_list_entry",
  "remove_reading_list_entry",
  "save_page_as_mhtml",
  "list_recently_closed",
  "restore_closed",
  "list_synced_devices",
  "search_history",
  "get_history_visits",
  "add_history_url",
  "delete_history_url",
  "delete_history_range",
  "clear_all_history",
  "list_extensions",
  "get_extension",
  "get_extension_permission_warnings",
  "set_extension_enabled",
  "uninstall_extension",
  "get_platform_info",
  "get_extension_manifest",
  "get_privacy_setting",
  "set_privacy_setting",
  "get_proxy_settings",
  "set_proxy_settings",
  "clear_proxy_settings",
  "get_font_settings",
  "set_font_size",
  "set_default_font",
  "clear_font_settings",
  "request_keep_awake",
  "release_keep_awake",
  "search_query",
  "tts_speak",
  "tts_stop",
  "list_tts_voices",
  "tts_is_speaking",
  "list_network_rules",
  "add_network_rule",
  "update_network_rule",
  "remove_network_rule",
  "get_network_rule_matches",
  "get_navigation_frames",
  "get_navigation_frame",
  "get_request_activity",
  "register_user_script",
  "update_user_script",
  "unregister_user_script",
  "list_user_scripts",
  "register_content_script",
  "update_content_script",
  "unregister_content_script",
  "list_content_scripts",
]);

export const MANAGEMENT_CAPABILITY_TOOL_NAMES = Object.freeze([
  "create_agent",
  "update_agent",
  "delete_agent",
  "get_agent",
  "list_agents",
  "disenroll_origin",
  "create_asset",
  "update_asset",
  "delete_asset",
  "list_assets",
  "get_asset",
  "get_usage",
  "get_memory_overview",
  "create_named_agent",
  "update_named_agent",
  "delete_named_agent",
  "get_named_agent",
  "list_named_agents",
  "set_agent_provider",
  "list_hooks",
  "subscribe_hook",
  "unsubscribe_hook",
  "generate_ui",
  "create_script",
  "update_script",
  "delete_script",
  "list_scripts",
  "get_script",
  "run_script",
  "schedules_list",
  "schedules_pause",
  "schedules_resume",
  "schedules_update",
  "delegate_to_agent",
]);

export const FLAGGED_FOR_LATER_PROVIDER_CUTOVER = Object.freeze([
  "open_side_panel",
  "capture_screenshot",
  "schedule_task",
  "run_script",
  "set_agent_provider",
  "delete_agent",
  "delete_asset",
  "disenroll_origin",
  "delete_named_agent",
  "update_asset",
]);

const REPLAY = new Set(["read-only", "idempotent", "mutating", "unknown"]);
const MUTATION = new Set(["read", "idempotent", "mutating"]);
const GRANT_SCOPES = new Set([
  "none",
  "destination-origin",
  "tab-scoped",
  "global",
  "owner-gesture-activeTab",
]);
const TOKEN = /^(?:chrome|management)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const GENERIC_TOKEN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const PERMISSION = /^[A-Za-z][A-Za-z0-9.]*$/u;
const ROUTE = /^(?:browser|management)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const bytes = (value) => new TextEncoder().encode(value).byteLength;

function record(toolName, sourceKind, capabilityTokens, optionalPermissions,
  productGrantScopeKind, replayClass, requiresOwnerGesture, mutationClass,
  routeFamily) {
  return {
    toolName,
    sourceKind,
    capabilityTokens,
    optionalPermissions,
    productGrantScopeKind,
    replayClass,
    trustedReplaySafety: replayClass,
    requiresOwnerGesture,
    mutationClass,
    routeFamily,
  };
}

const rows = [
  record("open_side_panel", "chrome-api", ["chrome.side-panel.open"], ["sidePanel"], "owner-gesture-activeTab", "mutating", true, "mutating", "browser.side-panel"),
  record("open_tab", "chrome-api", ["chrome.tabs.open.destination-origin"], ["tabs"], "destination-origin", "mutating", false, "mutating", "browser.tabs"),
  record("navigate_tab", "chrome-api", ["chrome.tabs.navigate.destination-origin"], ["tabs"], "destination-origin", "mutating", false, "mutating", "browser.tabs"),
  record("read_page", "chrome-api", ["chrome.host.exact-origin", "chrome.page.read"], ["activeTab", "scripting", "tabs"], "none", "read-only", false, "read", "browser.page"),
  record("capture_screenshot", "chrome-api", ["chrome.host.exact-origin", "chrome.screenshot.capture.tab-origin", "chrome.screenshot.capture.owner-gesture-alternative"], ["activeTab", "tabs"], "tab-scoped", "read-only", false, "read", "browser.capture"),
  record("list_tabs", "chrome-api", ["chrome.tabs.list"], ["tabs"], "none", "read-only", false, "read", "browser.tabs"),
  record("close_tab", "chrome-api", ["chrome.tabs.close.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("recent_browser_events", "chrome-api", ["chrome.events.recent.read"], [], "none", "read-only", false, "read", "browser.events"),
  record("schedule_task", "chrome-api", ["chrome.alarms.schedule", "chrome.scripts.schedule"], ["alarms"], "none", "mutating", false, "mutating", "browser.scheduler"),

  // Tranche-1 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // windows + action + commands. No NEW manifest permission anywhere in this
  // tranche; window mutations ride the SAME product browser-control grant as
  // their tabs siblings (the grant is not a manifest permission).
  record("list_windows", "chrome-api", ["chrome.windows.list"], [], "none", "read-only", false, "read", "browser.windows"),
  record("create_window", "chrome-api", ["chrome.windows.create.destination-origin"], ["tabs"], "destination-origin", "mutating", false, "mutating", "browser.windows"),
  record("focus_window", "chrome-api", ["chrome.windows.focus.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.windows"),
  record("close_window", "chrome-api", ["chrome.windows.close.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.windows"),
  record("move_window", "chrome-api", ["chrome.windows.move.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.windows"),
  record("set_action_state", "chrome-api", ["chrome.action.set"], [], "none", "mutating", false, "mutating", "browser.action"),
  record("get_action_state", "chrome-api", ["chrome.action.get"], [], "none", "read-only", false, "read", "browser.action"),
  record("list_commands", "chrome-api", ["chrome.commands.list"], [], "none", "read-only", false, "read", "browser.commands"),

  // Tranche-2 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // alarms, bookmarks, notifications, idle, contextMenus (declared optional permissions).
  record("create_alarm", "chrome-api", ["chrome.alarms.create"], ["alarms"], "none", "mutating", false, "mutating", "browser.alarms"),
  record("list_alarms", "chrome-api", ["chrome.alarms.list"], ["alarms"], "none", "read-only", false, "read", "browser.alarms"),
  record("clear_alarm", "chrome-api", ["chrome.alarms.clear"], ["alarms"], "none", "mutating", false, "mutating", "browser.alarms"),
  record("create_bookmark", "chrome-api", ["chrome.bookmarks.create"], ["bookmarks"], "none", "mutating", false, "mutating", "browser.bookmarks"),
  record("list_bookmarks", "chrome-api", ["chrome.bookmarks.list"], ["bookmarks"], "none", "read-only", false, "read", "browser.bookmarks"),
  record("remove_bookmark", "chrome-api", ["chrome.bookmarks.remove"], ["bookmarks"], "none", "mutating", false, "mutating", "browser.bookmarks"),
  record("notify", "chrome-api", ["chrome.notifications.create"], ["notifications"], "none", "mutating", false, "mutating", "browser.notifications"),
  record("clear_notification", "chrome-api", ["chrome.notifications.clear"], ["notifications"], "none", "mutating", false, "mutating", "browser.notifications"),
  record("query_idle_state", "chrome-api", ["chrome.idle.query"], ["idle"], "none", "read-only", false, "read", "browser.idle"),
  record("create_context_menu", "chrome-api", ["chrome.context-menus.create"], ["contextMenus"], "none", "mutating", false, "mutating", "browser.context-menus"),
  record("list_context_menus", "chrome-api", ["chrome.context-menus.list"], ["contextMenus"], "none", "read-only", false, "read", "browser.context-menus"),
  record("remove_context_menu", "chrome-api", ["chrome.context-menus.remove"], ["contextMenus"], "none", "mutating", false, "mutating", "browser.context-menus"),

  // Tranche-8 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // site-data control — cookies (API permission + exact-origin HOST permission),
  // browsingData (global-grant wipe of explicitly enumerated types), and
  // contentSettings (single-origin patterns only; broad/wildcard rejected).
  record("list_cookies", "chrome-api", ["chrome.cookies.list"], ["cookies"], "none", "read-only", false, "read", "browser.cookies"),
  record("list_cookie_stores", "chrome-api", ["chrome.cookies.stores.list"], ["cookies"], "none", "read-only", false, "read", "browser.cookies"),
  record("get_cookie", "chrome-api", ["chrome.cookies.get.exact-origin"], ["cookies"], "none", "read-only", false, "read", "browser.cookies"),
  record("set_cookie", "chrome-api", ["chrome.cookies.set.exact-origin"], ["cookies"], "destination-origin", "mutating", false, "mutating", "browser.cookies"),
  record("remove_cookie", "chrome-api", ["chrome.cookies.remove.exact-origin"], ["cookies"], "destination-origin", "mutating", false, "mutating", "browser.cookies"),
  record("wipe_browsing_data", "chrome-api", ["chrome.browsing-data.wipe.global"], ["browsingData"], "global", "mutating", false, "mutating", "browser.browsing-data"),
  record("get_content_setting", "chrome-api", ["chrome.content-settings.get"], ["contentSettings"], "none", "read-only", false, "read", "browser.content-settings"),
  record("set_content_setting", "chrome-api", ["chrome.content-settings.set.exact-origin"], ["contentSettings"], "destination-origin", "mutating", false, "mutating", "browser.content-settings"),
  record("clear_content_settings", "chrome-api", ["chrome.content-settings.clear.exact-origin"], ["contentSettings"], "destination-origin", "mutating", false, "mutating", "browser.content-settings"),
  // Tranche-3 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // tabGroups — the owner's "sorting hat" unlock. tabGroups itself needs NO
  // manifest permission; the tab url/title reads for the grant scoping ride the
  // declared "tabs" permission. Mutations are tab-origin grant-scoped (the same
  // browser-control grant as the tabs/windows siblings); reads are un-scoped.
  record("list_tab_groups", "chrome-api", ["chrome.tab-groups.list"], [], "none", "read-only", false, "read", "browser.tab-groups"),
  record("group_tabs", "chrome-api", ["chrome.tab-groups.group.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tab-groups"),
  record("update_tab_group", "chrome-api", ["chrome.tab-groups.update.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tab-groups"),
  record("ungroup_tabs", "chrome-api", ["chrome.tab-groups.ungroup.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tab-groups"),
  record("move_tab_to_group", "chrome-api", ["chrome.tab-groups.move.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tab-groups"),

  // Tranche-4 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // downloads — the "downloads" optional permission is already declared;
  // mutations are GLOBAL-grant-scoped (downloads are browser-wide; an
  // origin-scoped grant must never authorize them). open_download is the
  // owner-OVERRIDDEN Phase-1 exclusion — kept hard grant-gated.
  record("download_file", "chrome-api", ["chrome.downloads.create.destination-scheme"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("list_downloads", "chrome-api", ["chrome.downloads.list"], ["downloads"], "none", "read-only", false, "read", "browser.downloads"),
  record("pause_download", "chrome-api", ["chrome.downloads.pause"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("resume_download", "chrome-api", ["chrome.downloads.resume"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("cancel_download", "chrome-api", ["chrome.downloads.cancel"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("erase_download", "chrome-api", ["chrome.downloads.erase"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("show_download", "chrome-api", ["chrome.downloads.show"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("open_download", "chrome-api", ["chrome.downloads.open"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  record("remove_download_file", "chrome-api", ["chrome.downloads.remove-file"], ["downloads"], "global", "mutating", false, "mutating", "browser.downloads"),
  // Tranche-13 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // deep tab control + action enable/disable + sidePanel options/behavior.
  // NO new manifest permissions (already-declared "tabs"/"sidePanel" only).
  // Tab mutations ride the SAME product browser-control grant as close_tab
  // (tab-scoped origin re-checked inside the grant lock); the two sidePanel
  // mutations are browser-level surfaces requiring a GLOBAL grant.
  record("move_tab", "chrome-api", ["chrome.tabs.move.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("duplicate_tab", "chrome-api", ["chrome.tabs.duplicate.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("set_tab_pinned", "chrome-api", ["chrome.tabs.set-pinned.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("reload_tab", "chrome-api", ["chrome.tabs.reload.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("tab_go_back", "chrome-api", ["chrome.tabs.go-back.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("tab_go_forward", "chrome-api", ["chrome.tabs.go-forward.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("get_tab_zoom", "chrome-api", ["chrome.tabs.get-zoom"], ["tabs"], "none", "read-only", false, "read", "browser.tabs"),
  record("set_tab_zoom", "chrome-api", ["chrome.tabs.set-zoom.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("discard_tab", "chrome-api", ["chrome.tabs.discard.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("highlight_tabs", "chrome-api", ["chrome.tabs.highlight.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("enable_action", "chrome-api", ["chrome.action.enable"], [], "none", "mutating", false, "mutating", "browser.action"),
  record("disable_action", "chrome-api", ["chrome.action.disable"], [], "none", "mutating", false, "mutating", "browser.action"),
  record("get_side_panel_options", "chrome-api", ["chrome.side-panel.get-options"], ["sidePanel"], "none", "read-only", false, "read", "browser.side-panel"),
  record("set_side_panel_options", "chrome-api", ["chrome.side-panel.set-options"], ["sidePanel"], "global", "mutating", false, "mutating", "browser.side-panel"),
  record("set_panel_behavior", "chrome-api", ["chrome.side-panel.set-behavior"], ["sidePanel"], "global", "mutating", false, "mutating", "browser.side-panel"),
  // Tranche-5 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01
  // T5, CAP-FB-20260825 implementation): system.* + topSites + permissions
  // inventory — ALL read-only; the optional permission is requested by the
  // owner in Settings and each tool fails HONEST when denied (no grant gate:
  // nothing here mutates or touches page data).
  record("get_system_memory", "chrome-api", ["chrome.system.memory.read"], ["system.memory"], "none", "read-only", false, "read", "browser.system"),
  record("get_system_cpu", "chrome-api", ["chrome.system.cpu.read"], ["system.cpu"], "none", "read-only", false, "read", "browser.system"),
  record("get_system_storage", "chrome-api", ["chrome.system.storage.read"], ["system.storage"], "none", "read-only", false, "read", "browser.system"),
  record("get_system_display", "chrome-api", ["chrome.system.display.read"], ["system.display"], "none", "read-only", false, "read", "browser.system"),
  record("list_top_sites", "chrome-api", ["chrome.top-sites.read"], ["topSites"], "none", "read-only", false, "read", "browser.top-sites"),
  record("list_granted_permissions", "chrome-api", ["chrome.permissions.inventory.read"], [], "none", "read-only", false, "read", "browser.permissions"),
  // Tranche-6: readingList (http/https-only entries; mutations assert durable
  // run ownership) + pageCapture (EXACTLY capture_screenshot consent: origin
  // host permission + product grant under the grant lock + hard byte cap).
  record("add_reading_list_entry", "chrome-api", ["chrome.reading-list.add"], ["readingList"], "none", "mutating", false, "mutating", "browser.reading-list"),
  record("query_reading_list", "chrome-api", ["chrome.reading-list.query"], ["readingList"], "none", "read-only", false, "read", "browser.reading-list"),
  record("update_reading_list_entry", "chrome-api", ["chrome.reading-list.update"], ["readingList"], "none", "mutating", false, "mutating", "browser.reading-list"),
  record("remove_reading_list_entry", "chrome-api", ["chrome.reading-list.remove"], ["readingList"], "none", "mutating", false, "mutating", "browser.reading-list"),
  record("save_page_as_mhtml", "chrome-api", ["chrome.host.exact-origin", "chrome.page-capture.save.tab-origin"], ["pageCapture", "tabs"], "tab-scoped", "read-only", false, "read", "browser.capture"),
  // Tranche-7 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // sessions (no manifest permission) + history (already-declared optional
  // permission). Restore rides the product browser-control grant covering every
  // restored origin; per-URL history writes/deletes are destination-origin
  // scoped; range/all wipes require a GLOBAL grant (clear_all also needs an
  // explicit confirm:true).
  record("list_recently_closed", "chrome-api", ["chrome.sessions.list-recently-closed"], [], "none", "read-only", false, "read", "browser.sessions"),
  record("restore_closed", "chrome-api", ["chrome.sessions.restore.tab-origin"], [], "tab-scoped", "mutating", false, "mutating", "browser.sessions"),
  record("list_synced_devices", "chrome-api", ["chrome.sessions.list-devices"], [], "none", "read-only", false, "read", "browser.sessions"),
  record("search_history", "chrome-api", ["chrome.history.search"], ["history"], "none", "read-only", false, "read", "browser.history"),
  record("get_history_visits", "chrome-api", ["chrome.history.visits.list"], ["history"], "none", "read-only", false, "read", "browser.history"),
  record("add_history_url", "chrome-api", ["chrome.history.add.destination-origin"], ["history"], "destination-origin", "mutating", false, "mutating", "browser.history"),
  record("delete_history_url", "chrome-api", ["chrome.history.delete.destination-origin"], ["history"], "destination-origin", "mutating", false, "mutating", "browser.history"),
  record("delete_history_range", "chrome-api", ["chrome.history.delete-range"], ["history"], "global", "mutating", false, "mutating", "browser.history"),
  record("clear_all_history", "chrome-api", ["chrome.history.clear-all"], ["history"], "global", "mutating", false, "mutating", "browser.history"),

  // Tranche-11 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // extension/browser management. chrome.management is a NEW optional
  // permission (Settings capability row grants it from a genuine owner
  // gesture); runtime/sidePanel/action need no new permission. ALL mutations
  // are browser-wide / this-extension-own-surface = GLOBAL browser-control
  // grant (an origin-scoped grant must never authorize them); reads un-scoped.
  record("list_extensions", "chrome-api", ["chrome.management.list"], ["management"], "none", "read-only", false, "read", "browser.management"),
  record("get_extension", "chrome-api", ["chrome.management.get"], ["management"], "none", "read-only", false, "read", "browser.management"),
  record("get_extension_permission_warnings", "chrome-api", ["chrome.management.permission-warnings"], ["management"], "none", "read-only", false, "read", "browser.management"),
  record("set_extension_enabled", "chrome-api", ["chrome.management.set-enabled.global"], ["management"], "global", "mutating", false, "mutating", "browser.management"),
  record("uninstall_extension", "chrome-api", ["chrome.management.uninstall.global"], ["management"], "global", "mutating", false, "mutating", "browser.management"),
  record("get_platform_info", "chrome-api", ["chrome.runtime.platform-info"], [], "none", "read-only", false, "read", "browser.runtime"),
  record("get_extension_manifest", "chrome-api", ["chrome.runtime.manifest"], [], "none", "read-only", false, "read", "browser.runtime"),

  // Tranche-9 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // browser settings — chrome.privacy / proxy / fontSettings / power / search /
  // tts. Reads are un-scoped observe-only. Every mutation is BROWSER-WIDE (no
  // destination origin) and is therefore GLOBAL-grant-scoped: an origin-scoped
  // grant must never authorize a browser-wide settings change.
  record("get_privacy_setting", "chrome-api", ["chrome.privacy.get"], ["privacy"], "none", "read-only", false, "read", "browser.privacy"),
  record("set_privacy_setting", "chrome-api", ["chrome.privacy.set.global"], ["privacy"], "global", "mutating", false, "mutating", "browser.privacy"),
  record("get_proxy_settings", "chrome-api", ["chrome.proxy.get"], ["proxy"], "none", "read-only", false, "read", "browser.proxy"),
  record("set_proxy_settings", "chrome-api", ["chrome.proxy.set.global"], ["proxy"], "global", "mutating", false, "mutating", "browser.proxy"),
  record("clear_proxy_settings", "chrome-api", ["chrome.proxy.clear.global"], ["proxy"], "global", "mutating", false, "mutating", "browser.proxy"),
  record("get_font_settings", "chrome-api", ["chrome.font-settings.get"], ["fontSettings"], "none", "read-only", false, "read", "browser.font-settings"),
  record("set_font_size", "chrome-api", ["chrome.font-settings.set-size.global"], ["fontSettings"], "global", "mutating", false, "mutating", "browser.font-settings"),
  record("set_default_font", "chrome-api", ["chrome.font-settings.set-default.global"], ["fontSettings"], "global", "mutating", false, "mutating", "browser.font-settings"),
  record("clear_font_settings", "chrome-api", ["chrome.font-settings.clear.global"], ["fontSettings"], "global", "mutating", false, "mutating", "browser.font-settings"),
  record("request_keep_awake", "chrome-api", ["chrome.power.keep-awake.global"], ["power"], "global", "mutating", false, "mutating", "browser.power"),
  record("release_keep_awake", "chrome-api", ["chrome.power.release.global"], ["power"], "global", "mutating", false, "mutating", "browser.power"),
  record("search_query", "chrome-api", ["chrome.search.query.global"], ["search"], "global", "mutating", false, "mutating", "browser.search"),
  record("tts_speak", "chrome-api", ["chrome.tts.speak.global"], ["tts"], "global", "mutating", false, "mutating", "browser.tts"),
  record("tts_stop", "chrome-api", ["chrome.tts.stop.global"], ["tts"], "global", "mutating", false, "mutating", "browser.tts"),
  record("list_tts_voices", "chrome-api", ["chrome.tts.voices.list"], ["tts"], "none", "read-only", false, "read", "browser.tts"),
  record("tts_is_speaking", "chrome-api", ["chrome.tts.speaking.get"], ["tts"], "none", "read-only", false, "read", "browser.tts"),
  // Tranche-10 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
  // declarativeNetRequest dynamic rules are BROWSER-WIDE -> global grant;
  // webNavigation frame reads + webRequest observation are reads.
  record("list_network_rules", "chrome-api", ["chrome.network-rules.list"], ["declarativeNetRequest"], "none", "read-only", false, "read", "browser.network-rules"),
  record("add_network_rule", "chrome-api", ["chrome.network-rules.add.global"], ["declarativeNetRequest"], "global", "mutating", false, "mutating", "browser.network-rules"),
  record("update_network_rule", "chrome-api", ["chrome.network-rules.update.global"], ["declarativeNetRequest"], "global", "mutating", false, "mutating", "browser.network-rules"),
  record("remove_network_rule", "chrome-api", ["chrome.network-rules.remove.global"], ["declarativeNetRequest"], "global", "mutating", false, "mutating", "browser.network-rules"),
  record("get_network_rule_matches", "chrome-api", ["chrome.network-rules.match-test"], ["declarativeNetRequest"], "none", "read-only", false, "read", "browser.network-rules"),
  record("get_navigation_frames", "chrome-api", ["chrome.navigation.frames.list"], ["webNavigation"], "none", "read-only", false, "read", "browser.navigation"),
  record("get_navigation_frame", "chrome-api", ["chrome.navigation.frame.get"], ["webNavigation"], "none", "read-only", false, "read", "browser.navigation"),
  record("get_request_activity", "chrome-api", ["chrome.requests.activity.read"], ["webRequest"], "none", "read-only", false, "read", "browser.requests"),

  record("create_agent", "management", ["management.agent.create"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("update_agent", "management", ["management.agent.update"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("delete_agent", "management", ["management.agent.delete"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("get_agent", "management", ["management.agent.get"], [], "none", "read-only", false, "read", "management.agents"),
  record("list_agents", "management", ["management.agent.list"], [], "none", "read-only", false, "read", "management.agents"),
  record("disenroll_origin", "management", ["management.origin.disenroll"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("create_asset", "management", ["management.asset.create"], [], "none", "mutating", false, "mutating", "management.assets"),
  record("update_asset", "management", ["management.asset.update"], [], "none", "mutating", false, "mutating", "management.assets"),
  record("delete_asset", "management", ["management.asset.delete"], [], "none", "mutating", false, "mutating", "management.assets"),
  record("list_assets", "management", ["management.asset.list"], [], "none", "read-only", false, "read", "management.assets"),
  record("get_asset", "management", ["management.asset.get"], [], "none", "read-only", false, "read", "management.assets"),
  record("get_usage", "management", ["management.usage.get"], [], "none", "read-only", false, "read", "management.usage"),
  record("get_memory_overview", "management", ["management.memory.overview.get"], [], "none", "read-only", false, "read", "management.memory"),
  record("create_named_agent", "management", ["management.named-agent.create"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("update_named_agent", "management", ["management.named-agent.update"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("delete_named_agent", "management", ["management.named-agent.delete"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("get_named_agent", "management", ["management.named-agent.get"], [], "none", "read-only", false, "read", "management.named-agents"),
  record("list_named_agents", "management", ["management.named-agent.list"], [], "none", "read-only", false, "read", "management.named-agents"),
  record("set_agent_provider", "management", ["management.provider.set"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("list_hooks", "management", ["management.hooks.list"], [], "none", "read-only", false, "read", "management.hooks"),
  record("subscribe_hook", "management", ["management.hooks.subscribe"], [], "none", "idempotent", false, "idempotent", "management.hooks"),
  record("unsubscribe_hook", "management", ["management.hooks.unsubscribe"], [], "none", "idempotent", false, "idempotent", "management.hooks"),
  record("generate_ui", "management", ["management.ui.generate"], [], "none", "mutating", false, "mutating", "management.ui"),
  record("create_script", "management", ["management.script.create"], [], "none", "mutating", false, "mutating", "management.scripts"),
  record("update_script", "management", ["management.script.update"], [], "none", "mutating", false, "mutating", "management.scripts"),
  record("delete_script", "management", ["management.script.delete"], [], "none", "mutating", false, "mutating", "management.scripts"),
  record("list_scripts", "management", ["management.script.list"], [], "none", "read-only", false, "read", "management.scripts"),
  record("get_script", "management", ["management.script.get"], [], "none", "read-only", false, "read", "management.scripts"),
  record("run_script", "management", ["management.script.run"], [], "none", "mutating", false, "mutating", "management.scripts"),
  // Per-agent schedule visibility + control (pause/resume/update are gated
  // owner-approved mutations; list is a read, scoped to the calling agent).
  record("schedules_list", "management", ["management.schedules.list"], [], "none", "read-only", false, "read", "management.schedules"),
  record("schedules_pause", "management", ["management.task.pause"], [], "none", "mutating", false, "mutating", "management.schedules"),
  record("schedules_resume", "management", ["management.task.resume"], [], "none", "mutating", false, "mutating", "management.schedules"),
  record("schedules_update", "management", ["management.task.update"], [], "none", "mutating", false, "mutating", "management.schedules"),
  // Agent→agent delegation (G5): spawns a child run — mutating, and the
  // route's own fail-closed guard (per-edge allow-list + depth/cycle/cap/budget)
  // is the authority; no Chrome permission is involved.
  record("delegate_to_agent", "management", ["management.agent.delegate"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  // Tranche-12 Chrome API coverage:
  // browser-wide global grant), user scripts + dynamic content scripts
  // (single-origin matches; destination-origin grant coverage; host
  // permissions granted via the Settings flow). desktopCapture intentionally
  // absent (documented exclusion).
  record("register_user_script", "chrome-api", ["chrome.user-scripts.register"], ["userScripts"], "destination-origin", "mutating", false, "mutating", "browser.user-scripts"),
  record("update_user_script", "chrome-api", ["chrome.user-scripts.update"], ["userScripts"], "destination-origin", "mutating", false, "mutating", "browser.user-scripts"),
  record("unregister_user_script", "chrome-api", ["chrome.user-scripts.unregister"], ["userScripts"], "destination-origin", "mutating", false, "mutating", "browser.user-scripts"),
  record("list_user_scripts", "chrome-api", ["chrome.user-scripts.list"], ["userScripts"], "none", "read-only", false, "read", "browser.user-scripts"),
  record("register_content_script", "chrome-api", ["chrome.content-scripts.register"], ["scripting"], "destination-origin", "mutating", false, "mutating", "browser.content-scripts"),
  record("update_content_script", "chrome-api", ["chrome.content-scripts.update"], ["scripting"], "destination-origin", "mutating", false, "mutating", "browser.content-scripts"),
  record("unregister_content_script", "chrome-api", ["chrome.content-scripts.unregister"], ["scripting"], "destination-origin", "mutating", false, "mutating", "browser.content-scripts"),
  record("list_content_scripts", "chrome-api", ["chrome.content-scripts.list"], ["scripting"], "none", "read-only", false, "read", "browser.content-scripts"),
];

function validateRow(row, seen) {
  if (!row || typeof row !== "object" || seen.has(`${row.sourceKind}:${row.toolName}`)) throw new Error("duplicate_capability_entry");
  seen.add(`${row.sourceKind}:${row.toolName}`);
  if (!["chrome-api", "management"].includes(row.sourceKind)) throw new Error("invalid_capability_source");
  const expectedNames = row.sourceKind === "chrome-api" ? BROWSER_TOOL_NAMES : MANAGEMENT_CAPABILITY_TOOL_NAMES;
  if (!expectedNames.includes(row.toolName)) throw new Error("unknown_capability_entry");
  if (!Array.isArray(row.capabilityTokens) || row.capabilityTokens.length < 1 || row.capabilityTokens.length > CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokens) throw new Error("invalid_capability_tokens");
  if (new Set(row.capabilityTokens).size !== row.capabilityTokens.length || row.capabilityTokens.some((token) => typeof token !== "string" || !TOKEN.test(token) || bytes(token) > CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokenBytes)) throw new Error("invalid_capability_tokens");
  if (!Array.isArray(row.optionalPermissions) || row.optionalPermissions.length > CHROME_TOOL_CAPABILITY_BOUNDS.maxPermissions || new Set(row.optionalPermissions).size !== row.optionalPermissions.length || row.optionalPermissions.some((permission) => typeof permission !== "string" || !PERMISSION.test(permission) || bytes(permission) > CHROME_TOOL_CAPABILITY_BOUNDS.maxPermissionBytes)) throw new Error("invalid_capability_permissions");
  if (!GRANT_SCOPES.has(row.productGrantScopeKind)) throw new Error("invalid_grant_scope");
  if (!REPLAY.has(row.replayClass) || row.trustedReplaySafety !== row.replayClass) throw new Error("invalid_replay_class");
  if (typeof row.requiresOwnerGesture !== "boolean" || !MUTATION.has(row.mutationClass)) throw new Error("invalid_mutation_metadata");
  if (typeof row.routeFamily !== "string" || !ROUTE.test(row.routeFamily) || bytes(row.routeFamily) > CHROME_TOOL_CAPABILITY_BOUNDS.maxRouteFamilyBytes) throw new Error("invalid_route_family");
}

if (rows.length !== CHROME_TOOL_CAPABILITY_BOUNDS.totalTools) throw new Error("capability_table_count_mismatch");
const seen = new Set();
for (const row of rows) validateRow(row, seen);
for (const name of BROWSER_TOOL_NAMES) if (!seen.has(`chrome-api:${name}`)) throw new Error("capability_table_browser_incomplete");
for (const name of MANAGEMENT_CAPABILITY_TOOL_NAMES) if (!seen.has(`management:${name}`)) throw new Error("capability_table_management_incomplete");

export const CHROME_TOOL_CAPABILITY_TABLE = Object.freeze(rows.map((row) => Object.freeze({
  ...row,
  capabilityTokens: Object.freeze([...row.capabilityTokens].sort()),
  optionalPermissions: Object.freeze([...row.optionalPermissions].sort()),
})));

const byIdentity = new Map(CHROME_TOOL_CAPABILITY_TABLE.map((row) => [`${row.sourceKind}:${row.toolName}`, row]));

export function chromeToolCapability(toolName, sourceKind) {
  const row = typeof toolName === "string" && typeof sourceKind === "string"
    ? byIdentity.get(`${sourceKind}:${toolName}`)
    : null;
  if (!row) {
    const error = new Error("unknown_capability_entry");
    error.code = "unknown_capability_entry";
    throw error;
  }
  return row;
}

export function capabilitiesByTool(toolMap, sourceKind) {
  if (!["chrome-api", "management"].includes(sourceKind)) throw new Error("unknown_capability_source");
  const names = Object.keys(toolMap ?? {}).sort();
  const expected = [...(sourceKind === "chrome-api" ? BROWSER_TOOL_NAMES : MANAGEMENT_CAPABILITY_TOOL_NAMES)].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    const error = new Error("capability_table_inventory_mismatch");
    error.code = "capability_table_inventory_mismatch";
    throw error;
  }
  return Object.freeze(Object.fromEntries(names.map((name) => [name, chromeToolCapability(name, sourceKind).capabilityTokens])));
}

export function selectedCapabilitySummary(name, sourceKind, fallbackCapabilities = [], fallbackReplay = "unknown") {
  if (sourceKind === "chrome-api" || sourceKind === "management") {
    const row = chromeToolCapability(name, sourceKind);
    return Object.freeze({
      capabilityTokens: row.capabilityTokens,
      optionalPermissions: row.optionalPermissions,
      productGrantScopeKind: row.productGrantScopeKind,
      replayClass: row.replayClass,
      requiresOwnerGesture: row.requiresOwnerGesture,
      mutationClass: row.mutationClass,
      routeFamily: row.routeFamily,
    });
  }
  const tokens = Array.isArray(fallbackCapabilities)
    ? fallbackCapabilities.filter((token) =>
      typeof token === "string" && GENERIC_TOKEN.test(token) &&
      bytes(token) <= CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokenBytes
    ).slice(0, CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokens)
    : [];
  return Object.freeze({
    capabilityTokens: Object.freeze(tokens),
    optionalPermissions: Object.freeze([]),
    productGrantScopeKind: "none",
    replayClass: REPLAY.has(fallbackReplay) ? fallbackReplay : "unknown",
    requiresOwnerGesture: false,
    mutationClass: fallbackReplay === "read-only" ? "read" : fallbackReplay === "idempotent" ? "idempotent" : "mutating",
    routeFamily: sourceKind === "extension-builtin" ? "catalog.builtin" : "catalog.webmcp",
  });
}
