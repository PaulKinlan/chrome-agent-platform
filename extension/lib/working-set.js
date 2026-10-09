// extension/lib/working-set.js — Pure working-set model for task threads (chrome-agent-platform-3p3e.9).
//
// A task working set groups the tabs that a thread opened or that the user
// attached to the thread into a Chrome tab group.
//
// Working set structure:
//   {
//     groupId: number | null,            // Chrome tab group id if currently grouped
//     tabs: Array<{ tabId?: number, url: string, title?: string }>,
//     tabIds: number[],                  // Active/open tab IDs currently in browser
//     urls: string[],                    // All retained URLs in the working set
//   }
//
// Invariants:
// - Bounded: at most MAX_WORKING_SET_TABS (32) tabs per thread.
// - Reconcilable: stale tabIds (closed in browser) are detached while retaining
//   saved URLs and duplicate-URL tab instances for future restoration.
// - Robust: failed tab closes leave tabIds tracked rather than misreporting success.
// - Pure: reducer functions return new immutable structures.

export const MAX_WORKING_SET_TABS = 32;

/**
 * @typedef {Object} WorkingSetTab
 * @property {number} [tabId]
 * @property {string} url
 * @property {string} [title]
 */

/**
 * @typedef {Object} WorkingSet
 * @property {number | null} groupId
 * @property {readonly WorkingSetTab[]} tabs
 * @property {readonly number[]} tabIds
 * @property {readonly string[]} urls
 */

/**
 * Creates or sanitizes a working set object.
 * @param {object} [initial]
 * @returns {WorkingSet}
 */
export function createWorkingSet(initial = {}) {
  let tabs = [];

  if (Array.isArray(initial?.tabs)) {
    for (const item of initial.tabs) {
      if (!item) continue;
      const tabId = Number.isInteger(item.tabId) && item.tabId > 0 ? item.tabId : undefined;
      const url = typeof item.url === "string" ? item.url : "";
      const title = typeof item.title === "string" && item.title ? item.title.slice(0, 120) : undefined;
      if (tabId != null || url) {
        tabs.push(Object.freeze({
          ...(tabId != null ? { tabId } : {}),
          url,
          ...(title ? { title } : {}),
        }));
      }
    }
  } else {
    // Legacy / flat array support (tabIds and urls)
    const initialTabIds = Array.isArray(initial?.tabIds)
      ? initial.tabIds.filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const initialUrls = Array.isArray(initial?.urls)
      ? initial.urls.filter((u) => typeof u === "string" && u.length > 0)
      : [];

    const maxLen = Math.max(initialTabIds.length, initialUrls.length);
    for (let i = 0; i < maxLen; i++) {
      const tabId = initialTabIds[i];
      const url = initialUrls[i] || "";
      tabs.push(Object.freeze({
        ...(tabId != null ? { tabId } : {}),
        url,
      }));
    }
  }

  // Bound inactive history to MAX_WORKING_SET_TABS while preserving tab ordering.
  // All live open tabs (tabId != null) are retained so closeWorkingSetTabs never abandons a tab.
  let inactiveCount = 0;
  for (const t of tabs) {
    if (t.tabId == null) inactiveCount++;
  }
  const maxInactive = Math.max(MAX_WORKING_SET_TABS, initial?.preserveInactiveCount || 0);
  if (inactiveCount > maxInactive) {
    const excess = inactiveCount - maxInactive;
    let dropped = 0;
    const next = [];
    for (const t of tabs) {
      if (t.tabId == null && dropped < excess) {
        dropped++;
        continue;
      }
      next.push(t);
    }
    tabs = next;
  }

  const groupId = typeof initial?.groupId === "number" && initial.groupId >= 0
    ? initial.groupId
    : null;

  const tabIds = tabs
    .map((t) => t.tabId)
    .filter((id) => typeof id === "number" && id > 0);

  const urls = tabs
    .map((t) => t.url)
    .filter((u) => typeof u === "string" && u.length > 0);

  const groupNamed = initial?.groupNamed === true;
  const preserveInactiveCount = typeof initial?.preserveInactiveCount === "number" && initial.preserveInactiveCount > 0
    ? initial.preserveInactiveCount
    : (tabs.length > MAX_WORKING_SET_TABS ? tabs.length : undefined);

  return Object.freeze({
    groupId,
    groupNamed,
    tabs: Object.freeze(tabs),
    tabIds: Object.freeze(tabIds),
    urls: Object.freeze(urls),
    ...(preserveInactiveCount ? { preserveInactiveCount } : {}),
  });
}

/**
 * Adds a tab (tabId, url, and optional title) to the working set, preserving separate
 * tab instances (even with duplicate URLs) and capping at MAX_WORKING_SET_TABS (32).
 */
export function addTabToWorkingSet(workingSet, { tabId, url, title } = {}) {
  const current = workingSet || createWorkingSet();
  const nextTabs = [...current.tabs];
  const validTabId = typeof tabId === "number" && tabId > 0 ? tabId : undefined;
  const validUrl = typeof url === "string" ? url : "";
  const validTitle = typeof title === "string" && title ? title.slice(0, 120) : undefined;

  let existingIndex = -1;
  if (validTabId != null) {
    existingIndex = nextTabs.findIndex((t) => t.tabId === validTabId);
  }

  if (existingIndex !== -1) {
    // Update existing tab entry
    const existing = nextTabs[existingIndex];
    nextTabs[existingIndex] = Object.freeze({
      tabId: validTabId,
      url: validUrl || existing.url,
      title: validTitle || existing.title,
    });
  } else if (validTabId != null || validUrl) {
    // New tab instance (never steals or mutates pre-existing inactive entries)
    nextTabs.push(Object.freeze({
      ...(validTabId != null ? { tabId: validTabId } : {}),
      url: validUrl,
      ...(validTitle ? { title: validTitle } : {}),
    }));
  }

  return createWorkingSet({
    groupId: current.groupId,
    groupNamed: current.groupNamed,
    tabs: nextTabs,
    preserveInactiveCount: current.preserveInactiveCount,
  });
}

/**
 * Detaches an active tabId when closed, preserving its URL and tab entry for restoration.
 */
export function removeTabFromWorkingSet(workingSet, tabId, { liveUrl, liveTitle } = {}) {
  const current = workingSet || createWorkingSet();
  if (typeof tabId !== "number") return current;

  const nextTabs = current.tabs.map((t) => {
    if (t.tabId === tabId) {
      return Object.freeze({
        url: liveUrl || t.url,
        ...(liveTitle || t.title ? { title: liveTitle || t.title } : {}),
      });
    }
    return t;
  });

  return createWorkingSet({
    groupId: current.groupId,
    groupNamed: current.groupNamed,
    tabs: nextTabs,
    preserveInactiveCount: current.preserveInactiveCount,
  });
}

/**
 * Completely purges a tab entry from the working set (used for abort rollback compensation).
 */
export function purgeTabFromWorkingSet(workingSet, tabId) {
  const current = workingSet || createWorkingSet();
  if (typeof tabId !== "number") return current;

  const nextTabs = current.tabs.filter((t) => t.tabId !== tabId);
  const remainingOpenIds = nextTabs
    .map((t) => t.tabId)
    .filter((id) => typeof id === "number" && id > 0);

  return createWorkingSet({
    groupId: remainingOpenIds.length === 0 ? null : current.groupId,
    groupNamed: remainingOpenIds.length === 0 ? false : current.groupNamed,
    tabs: nextTabs,
    preserveInactiveCount: current.preserveInactiveCount,
  });
}

/**
 * Updates the associated tab group ID.
 */
export function setWorkingSetGroup(workingSet, groupId, groupNamed = false) {
  const current = workingSet || createWorkingSet();
  const validGroupId = typeof groupId === "number" && groupId >= 0 ? groupId : null;
  return createWorkingSet({
    groupId: validGroupId,
    groupNamed: validGroupId !== null ? (groupNamed === true) : false,
    tabs: current.tabs,
    preserveInactiveCount: current.preserveInactiveCount,
  });
}

/**
 * Reconciles the working set against active browser tabs.
 * Tabs closed in Chrome have their tabId detached while retaining saved URLs
 * for future restoration.
 * @param {object} workingSet
 * @param {Array<number | { id?: number }>} [activeBrowserTabs]
 * @param {Array<number>} [activeGroupIds]
 */
export function reconcileWorkingSet(workingSet, activeBrowserTabs = [], activeGroupIds = undefined) {
  const current = workingSet || createWorkingSet();
  const activeTabMap = new Map();
  for (const t of (activeBrowserTabs || [])) {
    const id = typeof t === "number" ? t : t?.id;
    if (typeof id === "number" && id > 0) {
      activeTabMap.set(id, t);
    }
  }

  const staleTabIds = [];
  const updatedTabs = [];
  let urlsChanged = false;
  const nextTabs = current.tabs.map((t) => {
    if (t.tabId != null) {
      if (!activeTabMap.has(t.tabId)) {
        staleTabIds.push(t.tabId);
        return Object.freeze({
          url: t.url,
          ...(t.title ? { title: t.title } : {}),
        });
      }
      // Tab is still open — update its live URL/title if changed by navigation
      const live = activeTabMap.get(t.tabId);
      if (live && typeof live.url === "string" && live.url && live.url !== t.url) {
        urlsChanged = true;
        const entry = Object.freeze({
          tabId: t.tabId,
          url: live.url,
          ...(live.title ? { title: live.title } : (t.title ? { title: t.title } : {})),
        });
        updatedTabs.push(entry);
        return entry;
      }
    }
    return t;
  });

  let nextGroupId = current.groupId;
  let staleGroup = false;
  if (Array.isArray(activeGroupIds) && current.groupId != null) {
    const groupSet = new Set(activeGroupIds);
    if (!groupSet.has(current.groupId)) {
      nextGroupId = null;
      staleGroup = true;
    }
  }

  const reconciled = createWorkingSet({
    groupId: nextGroupId,
    groupNamed: nextGroupId == null ? false : current.groupNamed,
    tabs: nextTabs,
    preserveInactiveCount: current.preserveInactiveCount,
  });

  return Object.freeze({
    reconciled,
    staleTabIds: Object.freeze(staleTabIds),
    updatedTabs: Object.freeze(updatedTabs),
    closedCount: staleTabIds.length,
    staleGroup,
    urlsChanged,
  });
}

/**
 * Computes the state when closing the task's working set tabs.
 * Returns the tab IDs to close in the browser and the updated working set.
 */
export function closeWorkingSet(workingSet) {
  const current = workingSet || createWorkingSet();
  const tabsToClose = current.tabs
    .map((t) => t.tabId)
    .filter((id) => typeof id === "number" && id > 0);

  const nextTabs = current.tabs.map((t) => Object.freeze({
    url: t.url,
    ...(t.title ? { title: t.title } : {}),
  }));

  return Object.freeze({
    nextWorkingSet: createWorkingSet({
      groupId: null,
      tabs: nextTabs,
      preserveInactiveCount: nextTabs.length,
    }),
    tabsToClose: Object.freeze(tabsToClose),
  });
}

/**
 * Computes the plan to restore a task's working set.
 * By default, returns URLs for tabs that are currently NOT open.
 */
export function restoreWorkingSetPlan(workingSet, { onlyMissing = true } = {}) {
  const current = workingSet || createWorkingSet();
  const targetTabs = onlyMissing
    ? current.tabs.filter((t) => t.tabId == null && typeof t.url === "string" && t.url.length > 0)
    : current.tabs.filter((t) => typeof t.url === "string" && t.url.length > 0);

  return Object.freeze({
    urlsToOpen: Object.freeze(targetTabs.map((t) => t.url)),
    tabsToRestore: Object.freeze(targetTabs),
  });
}

/**
 * Generates a clean, bounded tab group title from a thread name.
 */
export function groupTitleForThread(threadName) {
  const raw = String(threadName || "Task").trim();
  const title = raw.length > 32 ? raw.slice(0, 31) + "…" : raw;
  return title || "Task";
}

/**
 * Groups working set tabs into a Chrome tab group, creating or updating as necessary.
 * @param {WorkingSet} workingSet
 * @param {{ title?: string, color?: string, chromeApi?: object }} [options]
 * @returns {Promise<{ nextWorkingSet: WorkingSet, groupId: number | null }>}
 */
export async function syncWorkingSetTabGroup(workingSet, { title = "Task", color = undefined, chromeApi = globalThis.chrome } = {}) {
  const current = workingSet || createWorkingSet();
  const activeIds = current.tabIds;
  if (!chromeApi?.tabs?.group || activeIds.length === 0) {
    return { nextWorkingSet: current, groupId: current.groupId };
  }

  let groupId = current.groupId;
  try {
    if (typeof groupId === "number") {
      try {
        await chromeApi.tabs.group({ tabIds: [...activeIds], groupId });
      } catch {
        groupId = null;
      }
    }
    if (groupId == null) {
      groupId = await chromeApi.tabs.group({ tabIds: [...activeIds] });
    }
    let groupNamed = false;
    if (typeof groupId === "number" && chromeApi.tabGroups?.update) {
      const updateProps = { title: groupTitleForThread(title) };
      if (color) updateProps.color = color;
      try {
        await chromeApi.tabGroups.update(groupId, updateProps);
        groupNamed = true;
      } catch {
        // failed or missing permission
      }
    }
    const nextWs = setWorkingSetGroup(current, groupId, groupNamed);
    return { nextWorkingSet: nextWs, groupId, groupNamed };
  } catch {
    return { nextWorkingSet: current, groupId: current.groupId };
  }
}

/**
 * Closes open tabs for a working set in Chrome, returning the successfully closed tab count
 * and updated working set. Only tabs that were successfully closed are detached.
 * @param {WorkingSet} workingSet
 * @param {{ chromeApi?: object }} [options]
 * @returns {Promise<{ nextWorkingSet: WorkingSet, closedTabIds: readonly number[] }>}
 */
export async function closeWorkingSetTabs(workingSet, { chromeApi = globalThis.chrome } = {}) {
  const current = workingSet || createWorkingSet();
  const candidateIds = current.tabIds;
  if (!chromeApi?.tabs?.remove || candidateIds.length === 0) {
    return { nextWorkingSet: current, closedTabIds: Object.freeze([]), closedTabs: Object.freeze([]) };
  }

  // Capture live URLs for each tab before removal so navigated tabs preserve current URL
  const liveTabMap = new Map();
  if (chromeApi.tabs?.get) {
    await Promise.all(
      candidateIds.map(async (id) => {
        try {
          const t = await chromeApi.tabs.get(id);
          if (t?.url) liveTabMap.set(id, { url: t.url, title: t.title });
        } catch { /* best effort */ }
      })
    );
  }

  const successfullyClosed = [];
  const closedEntries = [];
  for (const tabId of candidateIds) {
    try {
      await chromeApi.tabs.remove(tabId);
      successfullyClosed.push(tabId);
      const live = liveTabMap.get(tabId);
      const original = current.tabs.find((t) => t.tabId === tabId);
      closedEntries.push(Object.freeze({
        tabId,
        url: live?.url || original?.url || "",
        title: live?.title || original?.title,
      }));
    } catch {
      // Tab removal failed; keep tabId tracked so state is honest
    }
  }

  const nextTabs = current.tabs.map((t) => {
    if (t.tabId != null && successfullyClosed.includes(t.tabId)) {
      const live = liveTabMap.get(t.tabId);
      return Object.freeze({
        url: live?.url || t.url,
        ...(live?.title || t.title ? { title: live?.title || t.title } : {}),
      });
    }
    return t;
  });

  const remainingOpenIds = nextTabs
    .map((t) => t.tabId)
    .filter((id) => typeof id === "number" && id > 0);

  const nextWorkingSet = createWorkingSet({
    groupId: remainingOpenIds.length === 0 ? null : current.groupId,
    groupNamed: remainingOpenIds.length === 0 ? false : current.groupNamed,
    tabs: nextTabs,
    preserveInactiveCount: nextTabs.length,
  });

  return {
    nextWorkingSet,
    closedTabIds: Object.freeze(successfullyClosed),
    closedTabs: Object.freeze(closedEntries),
  };
}

/**
 * Restores tabs for a working set in Chrome by opening saved URLs and grouping them.
 * Opens missing tabs and joins them into the thread's tab group.
 * @param {WorkingSet} workingSet
 * @param {{ title?: string, onlyMissing?: boolean, chromeApi?: object }} [options]
 * @returns {Promise<{ nextWorkingSet: WorkingSet, openedTabIds: readonly number[] }>}
 */
export async function restoreWorkingSetTabs(workingSet, { title = "Task", onlyMissing = true, targetUrls = null, chromeApi = globalThis.chrome } = {}) {
  const current = workingSet || createWorkingSet();
  const plan = restoreWorkingSetPlan(current, { onlyMissing });
  if (!chromeApi?.tabs?.create || plan.urlsToOpen.length === 0) {
    return { nextWorkingSet: current, openedTabIds: Object.freeze([]) };
  }

  const remainingTargetCounts = new Map();
  if (Array.isArray(targetUrls)) {
    for (const url of targetUrls) {
      if (url) remainingTargetCounts.set(url, (remainingTargetCounts.get(url) || 0) + 1);
    }
  }

  const openedTabIds = [];
  const nextTabs = [...current.tabs];

  let missingIndex = 0;
  for (let i = 0; i < nextTabs.length; i++) {
    const tab = nextTabs[i];
    if (onlyMissing && tab.tabId != null) continue;
    if (!tab.url) continue;
    if (Array.isArray(targetUrls)) {
      const count = remainingTargetCounts.get(tab.url) || 0;
      if (count <= 0) continue;
      remainingTargetCounts.set(tab.url, count - 1);
    }

    try {
      const created = await chromeApi.tabs.create({ url: tab.url });
      if (typeof created?.id === "number") {
        openedTabIds.push(created.id);
        nextTabs[i] = Object.freeze({
          tabId: created.id,
          url: tab.url,
          ...(tab.title ? { title: tab.title } : {}),
        });
        missingIndex++;
      }
    } catch {
      // Best-effort URL restore
    }
  }

  const wsWithTabs = createWorkingSet({
    groupId: current.groupId,
    groupNamed: current.groupNamed,
    tabs: nextTabs,
    preserveInactiveCount: nextTabs.length,
  });

  const synced = await syncWorkingSetTabGroup(wsWithTabs, { title, chromeApi });
  return { nextWorkingSet: synced.nextWorkingSet, openedTabIds: Object.freeze(openedTabIds) };
}
