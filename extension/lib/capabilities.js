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
export async function revokeCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return { ok: false, error: `unknown capability ${id}` };
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
  // Validate before crossing the Chrome authority boundary. A vague network
  // need, wildcard host, path, or `<all_urls>` can never be escalated here.
  const matches = [exactOriginPattern(origin)];
  return await chrome.permissions.request({ origins: matches });
}
