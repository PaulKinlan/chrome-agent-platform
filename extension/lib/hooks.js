// lib/hooks.js — the system-hooks layer.
//
// Agents (the master hub agent, or a background recipe like the "sorting hat")
// can listen to a Chrome system event and be invoked when it fires. This module
// is the single authority for:
//
//   1. The HOOKS CATALOG — the full surface of chrome.* `on*` events an agent
//      could respond to, each with its required (OPTIONAL) permission and a
//      candidate use. See docs/HOOKS.md for the prose catalog.
//   2. THE SUBSCRIPTION REGISTRY — data (a hook + a recipe/agent + a prompt
//      template), persisted under `cap:hooks`. A subscription is NEVER eval'd;
//      it is looked up + its prompt built when the event fires.
//   3. THE PERMISSIONS LAYER (Paul's hard requirement) — a DENY-LIST of hooks
//      the agent can NEVER use. The deny-list is authoritative and checked
//      FIRST (fail-closed): a task that makes an agent subscribe to bookmarks
//      can be constrained by the owner denying the bookmarks hook, and a hook
//      the owner decides is too powerful is refused no matter what the agent
//      asks. The deny-list can only be changed by the owner from the Settings
//      UI (a user gesture), never by the agent itself.

import { kvGet, kvSet } from "./kv.js";
import { hasPermission } from "./capabilities.js";
import { getRecipe } from "./recipes.js";

const SUBSCRIPTIONS_KEY = "cap:hooks";
const DENY_KEY = "cap:hooksDeny";

// Fan-out bounds (the wider-goal review's unbounded-fan-out finding): a model
// must not be able to register an unbounded number of subscriptions, an
// unbounded template, or arbitrary recipeIds — each would let a single event
// enqueue unbounded paid runs. These are the registry ceilings.
const MAX_SUBSCRIPTIONS = 200;
const MAX_TEMPLATE_BYTES = 64 * 1024; // 64 KiB per prompt template

/** One chrome.* event an agent can listen to + respond to. */
export const HOOKS = [
  // ---- tabs (permission: tabs) ----
  {
    id: "tabs.onCreated",
    api: "tabs",
    event: "onCreated",
    label: "Tab created",
    permission: "tabs",
    payload: "tab (id, windowId, url, title)",
    use: "Sorting Hat groups the new tab; Auto-pin pins repeat domains; focus-mode closes tabs opened in a distraction session.",
  },
  {
    id: "tabs.onUpdated",
    api: "tabs",
    event: "onUpdated",
    label: "Tab updated",
    permission: "tabs",
    payload: "tabId, changeInfo (url/status/title), tab",
    use: "Summarise-on-navigate fires when a page finishes loading; page-sentiment-log records the visited URL.",
  },
  {
    id: "tabs.onRemoved",
    api: "tabs",
    event: "onRemoved",
    label: "Tab removed",
    permission: "tabs",
    payload: "tabId, removeInfo (windowId, isWindowClosing)",
    use: "Stale-tab-closer confirms a closed tab; reading-time records an unfinished article tab.",
  },
  {
    id: "tabs.onActivated",
    api: "tabs",
    event: "onActivated",
    label: "Tab activated",
    permission: "tabs",
    payload: "activeInfo (tabId, windowId)",
    use: "Focus-mode tracks which tab is foreground; a context agent prepares actions for the focused page.",
  },
  {
    id: "tabs.onAttached",
    api: "tabs",
    event: "onAttached",
    label: "Tab attached",
    permission: "tabs",
    payload: "tabId, attachInfo (newWindowId, newPosition)",
    use: "Sorting Hat re-groups tabs moved into a window.",
  },
  {
    id: "tabs.onZoomChange",
    api: "tabs",
    event: "onZoomChange",
    label: "Tab zoom changed",
    permission: "tabs",
    payload: "ZoomChangeInfo (tabId, oldZoomFactor, newZoomFactor, zoomSettings)",
    use: "A vision-deficiency agent logs zoom usage to recommend an accessibility baseline.",
  },
  // ---- windows (permission: none/tabs) ----
  {
    id: "windows.onCreated",
    api: "windows",
    event: "onCreated",
    label: "Window created",
    permission: "tabs",
    payload: "window",
    use: "Focus-mode opens a dedicated distraction-free window.",
  },
  {
    id: "windows.onRemoved",
    api: "windows",
    event: "onRemoved",
    label: "Window removed",
    permission: "tabs",
    payload: "windowId",
    use: "A workspace agent tears down the session's scratch state.",
  },
  {
    id: "windows.onFocusChanged",
    api: "windows",
    event: "onFocusChanged",
    label: "Window focus changed",
    permission: "tabs",
    payload: "windowId (WINDOW_ID_NONE when unfocused)",
    use: "A presence/status agent pauses when the user switches away.",
  },
  // ---- bookmarks (permission: bookmarks) ----
  {
    id: "bookmarks.onCreated",
    api: "bookmarks",
    event: "onCreated",
    label: "Bookmark created",
    permission: "bookmarks",
    payload: "id, bookmark",
    use: "Auto-categorize files the new bookmark; bookmark-dedupe flags a duplicate.",
  },
  {
    id: "bookmarks.onRemoved",
    api: "bookmarks",
    event: "onRemoved",
    label: "Bookmark removed",
    permission: "bookmarks",
    payload: "id, removeInfo (parentId, index, node)",
    use: "Dead-bookmark-cleaner updates its index when a bookmark is deleted.",
  },
  {
    id: "bookmarks.onChanged",
    api: "bookmarks",
    event: "onChanged",
    label: "Bookmark changed",
    permission: "bookmarks",
    payload: "id, changeInfo (title, url)",
    use: "A link-rot agent re-checks a bookmark whose URL changed.",
  },
  {
    id: "bookmarks.onMoved",
    api: "bookmarks",
    event: "onMoved",
    label: "Bookmark moved",
    permission: "bookmarks",
    payload: "id, moveInfo (parentId, index, oldParentId, oldIndex)",
    use: "Bookmark-auto-categorize re-derives the folder when the user moves a bookmark.",
  },
  {
    id: "bookmarks.onChildrenReordered",
    api: "bookmarks",
    event: "onChildrenReordered",
    label: "Bookmark folder reordered",
    permission: "bookmarks",
    payload: "id, reorderInfo (childIds)",
    use: "A sort agent respects a manual reorder (don't undo the user's hand-edit).",
  },
  // ---- history (permission: history) ----
  {
    id: "history.onVisited",
    api: "history",
    event: "onVisited",
    label: "Page visited",
    permission: "history",
    payload: "HistoryItem (id, url, title, visitTime)",
    use: "Page-sentiment-log records the visit; a research agent accumulates a visit trail.",
  },
  {
    id: "history.onVisitRemoved",
    api: "history",
    event: "onVisitRemoved",
    label: "History visit removed",
    permission: "history",
    payload: "removed (allHistory, urls)",
    use: "A privacy agent confirms a history clear actually removed the items.",
  },
  // ---- downloads (permission: downloads) ----
  {
    id: "downloads.onCreated",
    api: "downloads",
    event: "onCreated",
    label: "Download started",
    permission: "downloads",
    payload: "DownloadItem (id, filename, url, state)",
    use: "Download-organizer files the new download by type; download-nightly-summary collects the day's downloads.",
  },
  {
    id: "downloads.onChanged",
    api: "downloads",
    event: "onChanged",
    label: "Download changed",
    permission: "downloads",
    payload: "delta (id, state, filename, error)",
    use: "A completion agent fires when a download completes (state=complete) or errors.",
  },
  {
    id: "downloads.onErased",
    api: "downloads",
    event: "onErased",
    label: "Download erased",
    permission: "downloads",
    payload: "downloadId",
    use: "Download-organizer removes the index entry for an erased download.",
  },
  // ---- webNavigation (permission: webNavigation) ----
  {
    id: "webNavigation.onCompleted",
    api: "webNavigation",
    event: "onCompleted",
    label: "Navigation completed",
    permission: "webNavigation",
    payload: "details (tabId, url, frameId, timeStamp)",
    use: "Summarise-on-navigate runs on the main frame finishing a load.",
  },
  {
    id: "webNavigation.onBeforeNavigate",
    api: "webNavigation",
    event: "onBeforeNavigate",
    label: "Navigation starting",
    permission: "webNavigation",
    payload: "details (tabId, url, frameId, parentFrameId)",
    use: "A focus-mode agent blocks navigation to a distraction domain.",
  },
  {
    id: "webNavigation.onCommitted",
    api: "webNavigation",
    event: "onCommitted",
    label: "Navigation committed",
    permission: "webNavigation",
    payload: "details (tabId, url, transitionType, frameId)",
    use: "A per-origin sub-agent prepares its WebMCP tools when the origin commits.",
  },
  // ---- context menus (permission: contextMenus) ----
  {
    id: "contextMenus.onClicked",
    api: "contextMenus",
    event: "onClicked",
    label: "Context menu clicked",
    permission: "contextMenus",
    payload: "info (menuItemId, selectionText, pageUrl), tab",
    use: "Save-quote / right-click-summarize / right-click-translate-selection invoke on the selected text.",
  },
  // ---- commands (permission: none; declared in manifest commands) ----
  {
    id: "commands.onCommand",
    api: "commands",
    event: "onCommand",
    label: "Keyboard command",
    permission: null,
    payload: "command (the command name)",
    use: "A global hotkey (e.g. Ctrl+Shift+K) invokes the clipboard-phrase / omnibox-ask agent.",
  },
  // ---- idle (permission: idle) ----
  {
    id: "idle.onStateChanged",
    api: "idle",
    event: "onStateChanged",
    label: "Idle state changed",
    permission: "idle",
    payload: "newState (active/idle/locked)",
    use: "Idle-close-tabs closes stale tabs when the user is away; a cleanup agent runs on idle.",
  },
  // ---- alarms (permission: alarms) ----
  {
    id: "alarms.onAlarm",
    api: "alarms",
    event: "onAlarm",
    label: "Alarm fired",
    permission: "alarms",
    payload: "Alarm (name, scheduledTime, periodInMinutes)",
    use: "The scheduled background agents (sorting hat, daily-summary) run on their alarm.",
  },
  // ---- storage (permission: storage) ----
  {
    id: "storage.onChanged",
    api: "storage",
    event: "onChanged",
    label: "Storage changed",
    permission: "storage",
    payload: "changes (key -> {oldValue, newValue}), areaName",
    use: "A sync agent reacts to an external change to a preference.",
  },
  // ---- notifications (permission: notifications) ----
  {
    id: "notifications.onClicked",
    api: "notifications",
    event: "onClicked",
    label: "Notification clicked",
    permission: "notifications",
    payload: "notificationId",
    use: "Clicking a digest notification opens the full digest; a reminder opens its target.",
  },
  // ---- action (permission: none) ----
  {
    id: "action.onClicked",
    api: "action",
    event: "onClicked",
    label: "Extension action clicked",
    permission: null,
    payload: "tab",
    use: "The OWNER-invoked screenshot path (the headed activeTab capture).",
  },
  // ---- runtime (permission: none) ----
  {
    id: "runtime.onStartup",
    api: "runtime",
    event: "onStartup",
    label: "Extension startup",
    permission: null,
    payload: "none",
    use: "recoverOnBoot reconciles the scheduler on a fresh worker boot.",
  },
  {
    id: "runtime.onInstalled",
    api: "runtime",
    event: "onInstalled",
    label: "Extension installed/updated",
    permission: null,
    payload: "details (reason)",
    use: "First-run onboarding: seed master memory + open the welcome page.",
  },
  {
    id: "runtime.onSuspend",
    api: "runtime",
    event: "onSuspend",
    label: "Service worker suspending",
    permission: null,
    payload: "none",
    use: "A persistence agent flushes in-memory state before the SW is torn down.",
  },
];

export function getHook(id) {
  return HOOKS.find((h) => h.id === id);
}

// ---- deny-list (the permissions layer) ----

/** The owner's deny-list: hook ids the agent can NEVER use. */
export async function getHookDenyList() {
  const stored = await kvGet(DENY_KEY);
  const list = stored[DENY_KEY];
  return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

async function writeDenyList(list) {
  await kvSet({ [DENY_KEY]: list });
}

/** Deny (or un-deny) a hook. OWNER-ONLY (called from the Settings UI route,
 * never exposed to the agent toolset). */
export async function setHookDeny(hookId, deny) {
  if (!getHook(hookId)) return { ok: false, error: `unknown hook ${hookId}` };
  const list = await getHookDenyList();
  const has = list.includes(hookId);
  if (deny && !has) list.push(hookId);
  if (!deny && has) {
    const i = list.indexOf(hookId);
    list.splice(i, 1);
  }
  await writeDenyList(list);
  return { ok: true, hookId, denied: Boolean(deny) };
}

/**
 * Whether a hook is currently usable. FAIL-CLOSED: the deny-list is checked
 * FIRST, so a denied hook is refused regardless of permission. When the hook
 * needs a (optional) permission, it must be granted too. Returns { ok, error }.
 */
export async function checkHookAllowed(hookId) {
  const hook = getHook(hookId);
  if (!hook) return { ok: false, error: `unknown hook ${hookId}` };
  const deny = await getHookDenyList();
  if (deny.includes(hookId)) {
    return { ok: false, error: `hook ${hookId} is denied by the owner` };
  }
  if (hook.permission && !(await hasPermission(hook.permission))) {
    return {
      ok: false,
      error: `hook ${hookId} requires the optional "${hook.permission}" permission`,
    };
  }
  return { ok: true };
}

// ---- subscriptions (the registry) ----

/** All subscriptions: [{ hookId, recipeId|null, promptTemplate, enabled, at }]. */
export async function getHookSubscriptions() {
  const stored = await kvGet(SUBSCRIPTIONS_KEY);
  const list = stored[SUBSCRIPTIONS_KEY];
  return Array.isArray(list) ? list : [];
}

async function writeSubscriptions(list) {
  await kvSet({ [SUBSCRIPTIONS_KEY]: list });
}

/**
 * Subscribe an agent/recipe to a hook. Data only (never eval). The deny-list is
 * checked FIRST (fail-closed): a denied hook, or a hook whose optional
 * permission is absent, is refused.
 *
 * @param {string} hookId  the HOOKS catalog id
 * @param {string|null} recipeId  a recipe id, or null for the master hub agent
 * @param {string} promptTemplate  a prompt template; the event payload is
 *   serialized into `{{payload}}` when the hook fires (default: the recipe's
 *   own prompt + the payload appended)
 */
export async function subscribeHook({ hookId, recipeId = null, promptTemplate = "" }) {
  const allowed = await checkHookAllowed(hookId);
  if (!allowed.ok) return allowed;
  // VALIDATE the recipeId: null (the master hub agent) or a KNOWN recipe id.
  // An arbitrary/unknown recipeId must not create a distinct fan-out row that a
  // single event can enqueue.
  if (recipeId != null) {
    if (typeof recipeId !== "string" || !recipeId || recipeId.length > 128) {
      return { ok: false, error: "invalid recipeId" };
    }
    if (!getRecipe(recipeId)) {
      return { ok: false, error: `unknown recipe: ${recipeId}` };
    }
  }
  const template = typeof promptTemplate === "string" ? promptTemplate : "";
  if (new TextEncoder().encode(template).length > MAX_TEMPLATE_BYTES) {
    return { ok: false, error: "prompt template too large" };
  }
  const list = await getHookSubscriptions();
  // Idempotent: re-subscribing the same (hook, recipe) replaces the entry.
  const existing = list.find(
    (s) => s.hookId === hookId && (s.recipeId ?? null) === (recipeId ?? null),
  );
  if (!existing && list.length >= MAX_SUBSCRIPTIONS) {
    return { ok: false, error: "subscription limit reached" };
  }
  const entry = {
    hookId,
    recipeId: recipeId ?? null,
    promptTemplate: template,
    enabled: true,
    at: new Date().toISOString(),
  };
  if (existing) {
    Object.assign(existing, entry);
  } else {
    list.push(entry);
  }
  await writeSubscriptions(list);
  return { ok: true, hookId, recipeId: recipeId ?? null };
}

export async function unsubscribeHook({ hookId, recipeId = null }) {
  const list = await getHookSubscriptions();
  const next = list.filter(
    (s) => !(s.hookId === hookId && (s.recipeId ?? null) === (recipeId ?? null)),
  );
  await writeSubscriptions(next);
  return { ok: true, hookId, recipeId: recipeId ?? null };
}

/** The granted/denied status of every hook, for the Settings Hooks panel. */
export async function hookStatus() {
  const deny = await getHookDenyList();
  const subs = await getHookSubscriptions();
  const byHook = new Map();
  for (const s of subs) {
    if (!byHook.has(s.hookId)) byHook.set(s.hookId, []);
    byHook.get(s.hookId).push(s.recipeId ?? "master");
  }
  return HOOKS.map((h) => ({
    id: h.id,
    label: h.label,
    permission: h.permission,
    denied: deny.includes(h.id),
    subscribers: byHook.get(h.id) ?? [],
  }));
}
