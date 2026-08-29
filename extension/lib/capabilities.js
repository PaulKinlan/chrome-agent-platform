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
  try {
    // HOST-PERMISSION SIMPLIFICATION (owner directive 2026-08-28: this
    // extension is load-unpacked only and will never ship to the store): every
    // capability permission is GRANTED AT INSTALL (manifest `permissions`).
    // There is no runtime request left to make — confirm absence honestly and
    // report the grant. The in-context owner approval for MUTATIONS is a
    // separate policy layer and is unaffected.
    const granted = await chrome.permissions.contains({
      permissions: cap.permissions,
    });
    // NOTE: no .catch(() => true) — a contains() failure must surface as an
    // honest error (the outer catch), NEVER as granted (fail closed).
    if (!granted) {
      // Install-granted permissions can never be absent; this is a lie-guard,
      // not a request path.
      return { ok: false, granted: false, capability: id, error: "capability not granted at install" };
    }
    return { ok: true, granted: true, capability: id };
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
 * That ordering is right when revocation can actually happen, but under the
 * install-granted model it meant an operation that could never succeed still
 * destroyed enrollment state on its way to failing.
 */
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
