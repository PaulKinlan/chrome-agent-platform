// lib/capabilities.js — the OPTIONAL-permission capability gate.
//
// Every API permission is optional (Paul's hard requirement). This module is the
// single authority for (a) which permission backs which capability and (b)
// requesting/checking permissions. The Settings page renders a capability panel
// from CAPABILITIES and each Enable button calls `requestCapability` from a REAL
// user gesture. The service worker NEVER requests a permission itself (no user
// gesture — Chrome rejects it with "must be called during a user gesture").
//
// The extension degrades gracefully when a capability is absent: the SW guards
// chrome.* access, and each feature reports "permission not granted" rather than
// throwing.

import { exactOriginPattern } from "./permission-orchestration.js";

// The `gates` field states the ACTIONS each permission gates (Settings
// renders it on every row) — a permission row must never leave the owner
// wondering what an entry silently controls (the ARTIFACT-DELETE finding:
// artifact deletion itself needs NO permission; it lives in the extension's
// own OPFS space).
export const CAPABILITIES = [
  {
    id: "bookmarks",
    permissions: ["bookmarks"],
    label: "Bookmarks",
    hint: "Read, create and organize bookmarks. Without the grant, bookmark tools are refused with an Enable affordance.",
    gates: "Gates: bookmark list/create/remove tools.",
    chromeOsOnly: false,
  },
  {
    id: "history",
    permissions: ["history"],
    label: "History",
    hint: "Search browsing history. Without the grant, history tools are refused with an Enable affordance.",
    gates: "Gates: search_history and related history tools.",
    chromeOsOnly: false,
  },
  {
    id: "contextMenus",
    permissions: ["contextMenus"],
    label: "Context menus",
    hint: "Create the agent's right-click menu entries. Without the grant, menu tools are refused.",
    gates: "Gates: context menu create/remove tools.",
    chromeOsOnly: false,
  },
  {
    id: "idle",
    permissions: ["idle"],
    label: "Idle detection",
    hint: "Detect when the browser is idle (used by scheduled runs). Without the grant, idle tools are refused.",
    gates: "Gates: idle query tool.",
    chromeOsOnly: false,
  },
  {
    id: "topSites",
    permissions: ["topSites"],
    label: "Top sites",
    hint: "Read the most-visited sites. Without the grant, top-sites tools are refused.",
    gates: "Gates: top sites tools.",
    chromeOsOnly: false,
  },
  {
    id: "readingList",
    permissions: ["readingList"],
    label: "Reading list",
    hint: "Read and manage the Chrome reading list. Without the grant, reading-list tools are refused.",
    gates: "Gates: reading list tools.",
    chromeOsOnly: false,
  },
  {
    id: "pageCapture",
    permissions: ["pageCapture"],
    label: "Page capture (MHTML)",
    hint: "Capture a page as MHTML. Without the grant, page-capture tools are refused.",
    gates: "Gates: MHTML page capture.",
    chromeOsOnly: false,
  },
  {
    id: "privacy",
    permissions: ["privacy"],
    label: "Privacy controls",
    hint: "Read and set Chrome privacy features (e.g. safe browsing). Without the grant, privacy tools are refused.",
    gates: "Gates: privacy set/get tools.",
    chromeOsOnly: false,
  },
  {
    id: "proxy",
    permissions: ["proxy"],
    label: "Proxy settings",
    hint: "Configure Chrome proxy settings. Without the grant, proxy tools are refused.",
    gates: "Gates: proxy set/clear tools.",
    chromeOsOnly: false,
  },
  {
    id: "fontSettings",
    permissions: ["fontSettings"],
    label: "Font settings",
    hint: "Read and set Chrome font settings. Without the grant, font tools are refused.",
    gates: "Gates: font get/set tools.",
    chromeOsOnly: false,
  },
  {
    id: "power",
    permissions: ["power"],
    label: "Power management",
    hint: "Keep the system awake during long runs. Without the grant, power tools are refused.",
    gates: "Gates: power keep-awake tool.",
    chromeOsOnly: false,
  },
  {
    id: "search",
    permissions: ["search"],
    label: "Web search",
    hint: "Query the default search engine. Without the grant, search tools are refused.",
    gates: "Gates: search query tool.",
    chromeOsOnly: false,
  },
  {
    id: "tts",
    permissions: ["tts"],
    label: "Text to speech",
    hint: "Speak text aloud and list voices. Without the grant, TTS tools are refused.",
    gates: "Gates: speak/stop/voice tools.",
    chromeOsOnly: false,
  },
  {
    id: "system.cpu",
    permissions: ["system.cpu"],
    label: "System CPU info",
    hint: "Read CPU diagnostics. Without the grant, CPU tools are refused.",
    gates: "Gates: CPU info tool.",
    chromeOsOnly: false,
  },
  {
    id: "system.memory",
    permissions: ["system.memory"],
    label: "System memory info",
    hint: "Read memory diagnostics. Without the grant, memory tools are refused.",
    gates: "Gates: memory info tool.",
    chromeOsOnly: false,
  },
  {
    id: "system.storage",
    permissions: ["system.storage"],
    label: "System storage info",
    hint: "Read storage device diagnostics. Without the grant, storage tools are refused.",
    gates: "Gates: storage info tool.",
    chromeOsOnly: false,
  },
  {
    id: "system.display",
    permissions: ["system.display"],
    label: "System display info",
    hint: "Read display diagnostics. Without the grant, display tools are refused.",
    gates: "Gates: display info tool.",
    chromeOsOnly: false,
  },
  {
    id: "storage",
    permissions: ["storage"],
    label: "Memory & settings",
    hint: "Persist settings, tasks, usage and enrollment across restarts. Without it the hub still runs, but nothing survives a restart.",
    gates: "Gates: saving settings, tasks, usage history and site enrollments to chrome.storage. Artifacts and scripts (OPFS) never need it.",
  },
  {
    id: "alarms",
    permissions: ["alarms"],
    label: "Scheduled tasks",
    hint: "Run the agent on a schedule (or after a delay). Without it, scheduled tasks are unavailable.",
    gates: "Gates: creating schedules and delayed tasks; scheduled agent runs.",
  },
  {
    id: "tabs",
    permissions: ["tabs"],
    label: "Browser control",
    hint: "Open/navigate/close/list tabs. This permission reads the browsing history (Chrome warns) and is granted from a headed browser; screenshots use the separate Screenshots capability instead.",
    gates: "Gates: opening, navigating, closing and listing tabs; reading tab URLs and titles.",
  },
  {
    id: "tabGroups",
    permissions: ["tabGroups"],
    label: "Tab groups",
    hint: "Create, rename, recolor, collapse and manage tab groups, and move tabs between them. Without it the tabGroups API isn't injected, so the group tools return 'not available'.",
    gates: "Gates: list_tab_groups, group_tabs, update_tab_group, ungroup_tabs, move_tab_to_group.",
  },
  {
    id: "activeTab",
    permissions: ["activeTab"],
    label: "Screenshots",
    hint: "Enables Chrome's TRANSIENT owner-invoked capture: click the extension icon while viewing a page to capture that page. It never authorizes a background or model-selected capture (those need exact site access). Silent (no Chrome warning).",
    gates: "Gates: capturing the page you are viewing, only when you click the extension icon.",
  },
  {
    id: "scripting",
    permissions: ["scripting"],
    label: "Site Agents",
    hint: "Find and use tools made available by sites you add. Chrome asks for access only to those sites.",
    gates: "Gates: injecting the site-agent bridge into origins you enroll.",
  },
  {
    id: "notifications",
    permissions: ["notifications"],
    label: "Notifications",
    hint: "Surface scheduled-task completions as system notifications.",
    gates: "Gates: showing system notifications (scheduled-task completions).",
  },
  {
    id: "sidePanel",
    permissions: ["sidePanel"],
    label: "Side panel",
    hint: "Open the hub in Chrome's side panel alongside a page.",
    gates: "Gates: opening the hub in Chrome's side panel.",
  },
  {
    id: "cookies",
    permissions: ["cookies"],
    label: "Cookies",
    hint: "List/read/set/remove site cookies. Cookie tools ALSO need the exact-origin host permission for the target site (granted per site, never for all sites).",
    gates: "Gates: listing, reading, setting and removing cookies for sites you grant exact site access to.",
  },
  {
    id: "browsingData",
    permissions: ["browsingData"],
    label: "Browsing data",
    hint: "Wipe explicitly chosen browsing data types (cache, cookies, history, downloads, passwords, …). Browser-wide: every wipe also needs the global browser-control grant.",
    gates: "Gates: wiping only the data types you enumerate (cache, cookies, history, downloads, passwords and more).",
  },
  {
    id: "contentSettings",
    permissions: ["contentSettings"],
    label: "Content settings",
    hint: "Read/set/clear per-site content rules (JavaScript, images, cookies, location, notifications, popups) for one exact origin at a time — broad patterns are refused.",
    gates: "Gates: reading and changing per-site content rules (JS, images, cookies, location, notifications, popups) for single origins.",
  },
  {
    id: "userScripts",
    permissions: ["userScripts"],
    label: "User scripts",
    hint: "Register user scripts (USER_SCRIPT world) on specific sites. Only single exact-origin matches are accepted (broad patterns are refused) and each site's host access is granted separately in Settings; mutations ALSO need the browser-control grant for every matched origin.",
    gates: "Gates: register/update/unregister/list_user_scripts. (Dynamic content scripts use the Site Agents capability instead.)",
  },
  {
    id: "downloads",
    permissions: ["downloads"],
    label: "Downloads",
    hint: "Download files (http/https only) and manage the browser's download history. Mutations stay behind the Browser control grant.",
    gates: "Gates: download_file, list_downloads, pause/resume/cancel/erase/show/open/remove downloads.",
  },
  // Tranche-11 Chrome API coverage: extension/browser management. The service
  // worker NEVER requests this itself — the Settings Enable button calls
  // requestCapability from a real owner gesture. Mutations (enable/disable/
  // uninstall an extension) ALSO stay behind the GLOBAL browser-control grant,
  // and this extension can never toggle or uninstall ITSELF.
  {
    id: "management",
    permissions: ["management"],
    label: "Extension management",
    hint: "List the installed extensions and enable/disable or uninstall them. Enabling/disabling/uninstalling is browser-wide and ALSO needs the global Browser control grant; this extension can never change or remove itself.",
    gates: "Gates: list_extensions, get_extension, permission warnings, set_extension_enabled, uninstall_extension.",
  },
  {
    id: "declarativeNetRequest",
    permissions: ["declarativeNetRequest"],
    label: "Network rules",
    hint: "Manage the extension's dynamic network rules (block/allow/redirect/upgradeScheme). Rules apply browser-wide: every rule change ALSO needs the global Browser control grant.",
    gates: "Gates: listing and match-testing rules (read), adding/updating/removing rules (global grant).",
  },
  {
    id: "webNavigation",
    permissions: ["webNavigation"],
    label: "Navigation frames",
    hint: "Read a tab's frame tree and see top-frame navigation start/complete in the recent browser events log.",
    gates: "Gates: reading frame trees and navigation events.",
  },
  {
    id: "webRequest",
    permissions: ["webRequest"],
    label: "Request observation",
    hint: "Observe (never block or modify) web requests for sites you already granted host access to. Blocking webRequest is not available without enterprise policy.",
    gates: "Gates: reading observed request activity.",
  },
];

/** Whether a permission (or the equivalent) is currently granted. */
export async function hasPermission(permission) {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: [permission] });
  } catch {
    return false;
  }
}

export async function hasCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return false;
  for (const p of cap.permissions) {
    if (!(await hasPermission(p))) return false;
  }
  return true;
}

/** The granted status of every capability (for the Settings panel). */
export async function capabilityStatus() {
  const out = {};
  for (const c of CAPABILITIES) {
    out[c.id] = await hasCapability(c.id);
  }
  return out;
}

/**
 * Request a capability's permissions. MUST be called from a user gesture (the
 * Settings Enable button). Returns { granted, permission } — the request is
 * never silently swallowed: a rejection or a false result is surfaced so the
 * UI can report it honestly.
 */
export async function requestCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return { ok: false, error: `unknown capability ${id}` };
  // OPTIONAL + JIT model (owner directive 2026-08-29, superseding the
  // 2026-08-28 install-grant model for capabilities): the capability
  // permissions live in manifest optional_permissions and are REQUESTED here
  // from the owner's gesture (Settings toggle / chat affordance). ChromeOS-
  // only permissions (audioCapture/videoCapture) are refused honestly when
  // the platform lacks the API.
  try {
    const granted = await chrome.permissions.request({
      permissions: cap.permissions,
    });
    return { ok: true, granted: Boolean(granted), capability: id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), capability: id };
  }
}

/**
 * Revoke a capability's permissions. MUST be called from a user gesture (the
 * Settings Disable button). Returns { revoked, error } and CONFIRMS absence via
 * chrome.permissions.contains (a `remove` resolving false means "already absent",
 * which is the goal — not a failure). The UI must surface a failed revoke, never
 * claim success against a still-granted permission (the round-16 finding).
 */
/**
 * Whether a capability is backed ENTIRELY by permissions the manifest declares
 * as required. `chrome.permissions.remove` only operates on OPTIONAL
 * permissions, so such a capability can never be revoked at runtime — Chrome
 * answers "You cannot remove required permissions."
 *
 * This matters beyond a nicer message: revoke paths do their DEPENDENT
 * teardown first (scripting tombstones every enrolled origin so a running
 * bridge is rejected from that instant, before the permission is removed).
 * That ordering is load-bearing on every revoke again: under the OPTIONAL +
 * JIT model (owner directive 2026-08-29, superseding the 2026-08-28
 * install-granted model for capabilities) capability permissions are
 * runtime-revocable. Only the minimal mandatory boot set
 * (storage/alarms/sidePanel/offscreen) is non-revocable.
 */
/**
 * The THREE-STATE capability status (review: permissions UI must never
 * collapse "not granted" and "not available on this platform"):
 *   granted              — contains() says yes
 *   requestable          — not granted, but grantable on this platform (JIT)
 *   platform-unavailable — never grantable here (ChromeOS-only API absent)
 */
export async function capabilityState(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return { id, state: "unknown" };
  const states = await Promise.all((cap.permissions ?? []).map(async (p) => {
    if (!isPermissionPlatformAvailable(p)) return "platform-unavailable";
    try {
      return (await chrome.permissions.contains({ permissions: [p] })) ? "granted" : "requestable";
    } catch {
      return "platform-unavailable";
    }
  }));
  if (states.every((st) => st === "granted")) return { id, state: "granted" };
  if (states.includes("platform-unavailable")) {
    const grantable = states.filter((st) => st !== "platform-unavailable");
    return {
      id,
      state: grantable.length > 0 ? "partial-platform-unavailable" : "platform-unavailable",
      unavailablePermissions: (cap.permissions ?? []).filter((_, i) => states[i] === "platform-unavailable"),
    };
  }
  return { id, state: "requestable" };
}

export function isRequiredCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap || !Array.isArray(cap.permissions) || cap.permissions.length === 0) return false;
  let required = [];
  try { required = chrome.runtime?.getManifest?.()?.permissions ?? []; } catch { return false; }
  if (!Array.isArray(required) || required.length === 0) return false;
  return cap.permissions.every((p) => required.includes(p));
}

export async function revokeCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return { ok: false, error: `unknown capability ${id}` };
  if (isRequiredCapability(id)) {
    return {
      ok: false,
      revoked: false,
      capability: id,
      required: true,
      error: `${cap.label ?? id} is granted at install and cannot be turned off at runtime`,
    };
  }
  try {
    const removed = await chrome.permissions.remove({
      permissions: cap.permissions,
    });
    const stillGranted = await hasCapability(id);
    return { ok: true, revoked: !stillGranted, capability: id, removed };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), capability: id };
  }
}

/**
 * Request an exact origin's host permission (for enrollment). MUST be called
 * from a user gesture. Returns the honest grant result.
 */
export async function requestOriginHost(origin) {
  // HOST-PERMISSION SIMPLIFICATION: <all_urls> is granted at install
  // (manifest host_permissions), so every http(s) origin is already covered —
  // confirm and report honestly. A runtime escalation request no longer
  // exists for host access. FAIL CLOSED: a contains() error means the grant
  // state is unreadable — that is NOT granted, never silently true.
  const matches = [exactOriginPattern(origin)];
  try {
    return (await chrome.permissions.contains({ origins: matches })) === true;
  } catch {
    return false;
  }
}
