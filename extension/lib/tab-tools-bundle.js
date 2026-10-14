// lib/tab-tools-bundle.js — the task-level "tab tools" bundle (OPEN-QUESTIONS
// #22). Per-tool asks remain the SAFETY FLOOR; when a task is about the
// owner's tabs, the service worker's denial path offers ONE task-level
// requirement instead — one card covering see/list tabs, group tabs, and
// browser control on the owner's open-tab sites. The model can never select
// or grant this: it exists only as a requirement shape rendered on the
// owner's approval card, and only the owner's real click (the conversation's
// approvePermissionRequirement) grants it.
//
// Pure and bounded. Every effect (permission checks, grant checks, tab
// enumeration) is injected; nothing here touches chrome.* directly, requests
// anything, or grants anything.

export const TAB_TOOLS_BUNDLE_ID = "tab-tools";

/** The tools whose denials a task is "about the owner's tabs" for. Deliberately
 * the listing/grouping family — open/navigate/close keep their own
 * destination-scoped per-tool asks (the safety floor). */
export const TAB_TOOLS_BUNDLE_FAMILY = Object.freeze([
  "list_tabs",
  "list_tab_groups",
  "group_tabs",
  "update_tab_group",
  "ungroup_tabs",
  "move_tab_to_group",
]);

/** The Chrome permissions the family can need — the bundle's union ask. */
export const TAB_TOOLS_BUNDLE_PERMISSIONS = Object.freeze(["tabs", "tabGroups"]);

const MAX_ORIGINS = 50;
const WEB_ORIGIN = /^https?:\/\/[^/]+$/;

// One minted bundle per task (executionId) — every tab-tool denial in the same
// run offers the EXACT same requirement, so the conversation renders ONE card
// and the owner decides once. Bounded; stale entries drop when their run is
// gone (isExecutionActive) or the map overflows (oldest first).
const offersByExecution = new Map();
const MAX_OFFERS = 64;

function pruneOffers(isExecutionActive) {
  for (const id of offersByExecution.keys()) {
    try {
      if (!isExecutionActive(id)) offersByExecution.delete(id);
    } catch {
      offersByExecution.delete(id);
    }
  }
  while (offersByExecution.size > MAX_OFFERS) {
    const oldest = offersByExecution.keys().next().value;
    offersByExecution.delete(oldest);
  }
}

/** The task-level bundle requirement for a tab-family denial — or null, which
 * leaves the denial on the per-tool floor. `requirement` is the tool's own
 * structured denial requirement; `openTabOrigins` are the canonical origins of
 * the owner's currently open web tabs (whatever the address-visibility rules
 * allow the worker to see — never invented). The ask is exactly:
 *   permissions   whichever of tabs/tabGroups are still missing;
 *   grantOrigins  the denial's own sites union the open tabs' sites, deduped,
 *                 minus sites already browser-control-granted (bounded 50);
 *   grantGlobal   only when the denial is genuinely origin-less (a chrome://
 *                 tab) — the bundle never hides or invents the all-sites ask.
 * Memoized per executionId: the first mint wins for the whole task. */
export async function offerTabToolsBundle(executionId, requirement, {
  toolName = "",
  openTabOrigins = [],
  hasPermission = async () => false,
  isControlGranted = async () => false,
  isExecutionActive = () => true,
} = {}) {
  if (!TAB_TOOLS_BUNDLE_FAMILY.includes(toolName)) return null;
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return null;
  const executionKey = typeof executionId === "string" && executionId ? executionId : null;
  if (executionKey) {
    const memo = offersByExecution.get(executionKey);
    if (memo && isExecutionActive(executionKey)) return memo;
  }
  // Owner-approval cards and site-access asks are different decisions — never
  // folded into the bundle (fail closed to the floor).
  if ((Array.isArray(requirement.approvals) && requirement.approvals.length) ||
      (Array.isArray(requirement.hostOrigins) && requirement.hostOrigins.length)) return null;
  const grantGlobal = requirement.grantGlobal === true;
  const permissions = [];
  for (const permission of TAB_TOOLS_BUNDLE_PERMISSIONS) {
    let held = false;
    try { held = (await hasPermission(permission)) === true; } catch { held = false; }
    if (!held) permissions.push(permission);
  }
  let grantOrigins = [];
  if (!grantGlobal) {
    const sites = new Set();
    for (const origin of [...(Array.isArray(requirement.grantOrigins) ? requirement.grantOrigins : []), ...(Array.isArray(openTabOrigins) ? openTabOrigins : [])]) {
      if (typeof origin === "string" && WEB_ORIGIN.test(origin)) sites.add(origin);
    }
    for (const origin of [...sites].sort()) {
      if (grantOrigins.length >= MAX_ORIGINS) break;
      let covered = false;
      try { covered = (await isControlGranted(origin)) === true; } catch { covered = false; }
      if (!covered) grantOrigins.push(origin);
    }
  }
  if (!permissions.length && !grantOrigins.length && !grantGlobal) return null;
  const reason = grantGlobal
    ? "organize your open tabs — see them, group them, and control the browser on all sites (one of the tabs has no single site)"
    : grantOrigins.length
      ? "organize your open tabs — see them, group them, and control the browser on the sites you have open"
      : "organize your open tabs — see them and group them";
  const bundle = Object.freeze({
    reason,
    permissions: Object.freeze([...permissions].sort()),
    grantOrigins: Object.freeze(grantOrigins),
    grantGlobal,
    bundle: TAB_TOOLS_BUNDLE_ID,
  });
  if (executionKey) {
    pruneOffers(isExecutionActive);
    offersByExecution.set(executionKey, bundle);
  }
  return bundle;
}

/** Stamp the bundle onto the denial's requirement IN PLACE. The agent loop,
 * the live approval event, the journaled tool-result row and the reopened
 * thread all hold this exact object, so one stamp keeps every surface
 * byte-identical (one card everywhere). Returns false for a frozen/malformed
 * requirement — the caller stays on the per-tool floor, never throws. */
export function stampTabToolsBundle(requirement, bundle) {
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return false;
  if (!bundle || typeof bundle !== "object" || bundle.bundle !== TAB_TOOLS_BUNDLE_ID) return false;
  try {
    requirement.reason = String(bundle.reason).slice(0, 240);
    requirement.permissions = [...bundle.permissions];
    requirement.grantOrigins = [...bundle.grantOrigins];
    requirement.grantGlobal = bundle.grantGlobal === true;
    requirement.bundle = TAB_TOOLS_BUNDLE_ID;
    return true;
  } catch {
    return false;
  }
}
