// lib/notification-action-routing.js — Bounded Chrome notification click routing
// and action dispatch (CAP-FB-20260823-NOTIFICATION-CLICK-ACTION-01).
//
// Invariants:
//   - Every agent-created Chrome notification has a well-defined click behavior.
//   - Default behavior: opens/focuses the extension to the exact agent task view
//     and retained run log for that execution.
//   - When no explicit target is clear, the click resumes the agent's continued loop
//     and the agent works out the next action itself (bounded by run/origin/agent fences).
//   - Explicit agent-defined click actions are policy-checked, bounded, and must not
//     broaden permissions or navigate outside the extension without owner consent.
//   - Dismissed notifications remain discoverable in the task view history.
//   - Stale/unknown execution IDs fail closed safely without crashing or leaking state.

export const NOTIFICATION_STATES = Object.freeze({
  CREATED: "created",
  CLICKED: "clicked",
  DISMISSED: "dismissed",
});

export const NOTIFICATION_ACTION_TYPES = Object.freeze({
  DEFAULT: "default",
  RESUME: "resume",
  OPEN_THREAD: "open-thread",
  NAVIGATE: "navigate",
});

export const NOTIFICATION_LIMITS = Object.freeze({
  maxTitleBytes: 256,
  maxMessageBytes: 1024,
  maxHistoryEntries: 100,
  maxPromptBytes: 2048,
});

const STORAGE_PREFIX = "cap:notification:";
const INDEX_KEY = "cap:notifications:index";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function failClosed(code, detail = "") {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  return err;
}

function plainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype);
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(String(str ?? "")).byteLength;
}

export const ALLOWED_NAVIGATE_PREFIXES = Object.freeze([
  "ntp/ntp.html",
  "options/options.html",
  "sidepanel/sidepanel.html",
]);

export function isAllowedNavigatePath(targetPath) {
  if (typeof targetPath !== "string" || !targetPath) return false;
  const trimmed = targetPath.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("://") ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    return false;
  }
  return ALLOWED_NAVIGATE_PREFIXES.some((prefix) =>
    trimmed === prefix || trimmed.startsWith(`${prefix}#` ) || trimmed.startsWith(`${prefix}?`)
  );
}

/**
 * Validate and sanitize a notification action envelope.
 * Fails closed on any unsafe, external, or unbounded payload.
 */
export function validateNotificationAction(action) {
  if (!action) {
    return Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT });
  }
  if (!plainObject(action)) {
    return Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT });
  }

  const type = String(action.type ?? NOTIFICATION_ACTION_TYPES.DEFAULT);

  switch (type) {
    case NOTIFICATION_ACTION_TYPES.OPEN_THREAD: {
      const threadId = typeof action.threadId === "string" && ID_RE.test(action.threadId)
        ? action.threadId
        : null;
      if (!threadId) return Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT });
      return Object.freeze({
        type: NOTIFICATION_ACTION_TYPES.OPEN_THREAD,
        threadId,
      });
    }

    case NOTIFICATION_ACTION_TYPES.NAVIGATE: {
      const targetPath = typeof action.path === "string" ? action.path.trim() : "";
      // Positive internal-path allowlist enforcement (N-3): only allow valid extension page entry points
      if (!isAllowedNavigatePath(targetPath)) {
        return Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT });
      }
      return Object.freeze({
        type: NOTIFICATION_ACTION_TYPES.NAVIGATE,
        path: targetPath,
      });
    }

    case NOTIFICATION_ACTION_TYPES.RESUME: {
      const executionId = typeof action.executionId === "string" && ID_RE.test(action.executionId)
        ? action.executionId
        : null;
      const prompt = typeof action.prompt === "string"
        ? action.prompt.slice(0, NOTIFICATION_LIMITS.maxPromptBytes)
        : "";
      return Object.freeze({
        type: NOTIFICATION_ACTION_TYPES.RESUME,
        executionId,
        prompt,
      });
    }

    case NOTIFICATION_ACTION_TYPES.DEFAULT:
    default:
      return Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT });
  }
}

/**
 * Storage adapter abstraction for Notification Registry.
 */
export class NotificationRegistry {
  constructor({ storage = null, now = () => Date.now() } = {}) {
    this._storage = storage;
    this._now = now;
    this._inMemory = new Map();
  }

  async _getStore() {
    if (this._storage?.local) return this._storage.local;
    if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
    return null;
  }

  async registerNotification({
    notificationId,
    taskId = null,
    executionId = null,
    agentId = null,
    threadId = null,
    action = null,
    title = "",
    message = "",
  }) {
    if (!notificationId || typeof notificationId !== "string") {
      throw failClosed("invalid_notification_id");
    }

    const now = this._now();
    const validatedAction = validateNotificationAction(action);
    const record = Object.freeze({
      notificationId,
      taskId: typeof taskId === "string" ? taskId : null,
      executionId: typeof executionId === "string" ? executionId : null,
      agentId: typeof agentId === "string" ? agentId : null,
      threadId: typeof threadId === "string" ? threadId : null,
      action: validatedAction,
      title: String(title ?? "").slice(0, NOTIFICATION_LIMITS.maxTitleBytes),
      message: String(message ?? "").slice(0, NOTIFICATION_LIMITS.maxMessageBytes),
      state: NOTIFICATION_STATES.CREATED,
      createdAt: now,
      updatedAt: now,
    });

    this._inMemory.set(notificationId, record);

    const store = await this._getStore();
    if (store?.set) {
      try {
        await store.set({ [`${STORAGE_PREFIX}${notificationId}`]: record });
        // Update index list (bounded to maxHistoryEntries)
        const idxData = await store.get(INDEX_KEY);
        const list = Array.isArray(idxData?.[INDEX_KEY]) ? idxData[INDEX_KEY] : [];
        const nextList = [notificationId, ...list.filter((id) => id !== notificationId)]
          .slice(0, NOTIFICATION_LIMITS.maxHistoryEntries);
        await store.set({ [INDEX_KEY]: nextList });
      } catch (e) {
        console.warn("NotificationRegistry: storage write failed", e?.message ?? e);
      }
    }

    return record;
  }

  async getNotification(notificationId) {
    if (!notificationId || typeof notificationId !== "string") return null;

    if (this._inMemory.has(notificationId)) {
      return this._inMemory.get(notificationId);
    }

    const store = await this._getStore();
    if (store?.get) {
      try {
        const data = await store.get(`${STORAGE_PREFIX}${notificationId}`);
        const record = data?.[`${STORAGE_PREFIX}${notificationId}`];
        if (record && plainObject(record)) {
          this._inMemory.set(notificationId, Object.freeze(record));
          return Object.freeze(record);
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  async updateState(notificationId, state, detail = {}) {
    const existing = await this.getNotification(notificationId);
    const now = this._now();
    const updated = Object.freeze({
      ...(existing ?? {
        notificationId,
        taskId: null,
        executionId: null,
        agentId: null,
        threadId: null,
        action: Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT }),
        title: "",
        message: "",
        createdAt: now,
      }),
      state,
      updatedAt: now,
      ...detail,
    });

    this._inMemory.set(notificationId, updated);

    const store = await this._getStore();
    if (store?.set) {
      try {
        await store.set({ [`${STORAGE_PREFIX}${notificationId}`]: updated });
      } catch {}
    }

    return updated;
  }

  async listNotifications({ state = null, agentId = null, taskId = null, executionId = null, limit = 50 } = {}) {
    const store = await this._getStore();
    let ids = [...this._inMemory.keys()];

    if (store?.get) {
      try {
        const idxData = await store.get(INDEX_KEY);
        if (Array.isArray(idxData?.[INDEX_KEY])) {
          ids = [...new Set([...idxData[INDEX_KEY], ...ids])];
        }
      } catch {}
    }

    const records = [];
    for (const id of ids) {
      const rec = await this.getNotification(id);
      if (!rec) continue;
      if (state && rec.state !== state) continue;
      if (agentId && rec.agentId !== agentId) continue;
      if (taskId && rec.taskId !== taskId) continue;
      if (executionId && rec.executionId !== executionId) continue;
      records.push(rec);
      if (records.length >= limit) break;
    }

    records.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    return Object.freeze(records);
  }
}

/**
 * Determine the canonical extension page URL for a notification target.
 */
export function buildNotificationTargetUrl({ threadId, executionId, taskId, path = null }) {
  if (path && typeof path === "string" && !path.includes("://")) {
    const normalized = path.startsWith("/") ? path.slice(1) : path;
    return typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(normalized)
      : `chrome-extension://local/${normalized}`;
  }

  const targetId = threadId || taskId || executionId;
  if (targetId && typeof targetId === "string") {
    const hash = `#omnibox=thread:${encodeURIComponent(targetId)}`;
    return typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(`ntp/ntp.html${hash}`)
      : `chrome-extension://local/ntp/ntp.html${hash}`;
  }

  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("ntp/ntp.html")
    : "chrome-extension://local/ntp/ntp.html";
}

/**
 * Focus an existing extension tab or open a new one.
 */
export async function openOrFocusExtensionUrl(targetUrl, { tabsApi = null, windowsApi = null } = {}) {
  const tabs = tabsApi || (typeof chrome !== "undefined" ? chrome.tabs : null);
  const windows = windowsApi || (typeof chrome !== "undefined" ? chrome.windows : null);

  if (!tabs?.query) return null;

  try {
    const extBase = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("")
      : "chrome-extension://";

    const existingTabs = await tabs.query({});
    const matchingTab = existingTabs?.find((t) => typeof t.url === "string" && t.url.startsWith(extBase));

    if (matchingTab && matchingTab.id !== undefined) {
      if (tabs.update) {
        await tabs.update(matchingTab.id, { active: true, url: targetUrl });
      }
      if (matchingTab.windowId !== undefined && windows?.update) {
        await windows.update(matchingTab.windowId, { focused: true }).catch(() => {});
      }
      return { action: "focused", tabId: matchingTab.id, url: targetUrl };
    }

    if (tabs.create) {
      const created = await tabs.create({ url: targetUrl });
      return { action: "created", tabId: created?.id, url: targetUrl };
    }
  } catch (err) {
    console.warn("openOrFocusExtensionUrl failed", err?.message ?? err);
  }

  return null;
}

/**
 * Main entry point for notification click handling.
 */
export async function handleNotificationClick(
  notificationId,
  {
    registry,
    resumeAgentExecution = null,
    tabsApi = null,
    windowsApi = null,
    notificationsApi = null,
  } = {},
) {
  if (!notificationId || typeof notificationId !== "string") {
    return { ok: false, error: "invalid_notification_id" };
  }

  // Clear system notification
  const notifications = notificationsApi || (typeof chrome !== "undefined" ? chrome.notifications : null);
  if (notifications?.clear) {
    notifications.clear(notificationId).catch(() => {});
  }

  // Mark clicked in registry
  let record = null;
  if (registry) {
    record = await registry.updateState(notificationId, NOTIFICATION_STATES.CLICKED);
  }

  // If no registry record, try to parse task/execution ID from notificationId format
  if (!record) {
    let taskId = null;
    let executionId = null;
    if (notificationId.startsWith("cap:")) {
      const rest = notificationId.slice(4);
      if (rest.startsWith("task:")) taskId = rest.slice(5);
      else if (rest.startsWith("exec:")) executionId = rest.slice(5);
      else taskId = rest;
    }
    record = {
      notificationId,
      taskId,
      executionId,
      threadId: taskId || executionId,
      action: Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT }),
      state: NOTIFICATION_STATES.CLICKED,
    };
  }

  const action = record.action || Object.freeze({ type: NOTIFICATION_ACTION_TYPES.DEFAULT });
  let resumeResult = null;

  // If action is RESUME or when no explicit target is clear and an execution exists
  if (action.type === NOTIFICATION_ACTION_TYPES.RESUME && record.executionId && typeof resumeAgentExecution === "function") {
    try {
      resumeResult = await resumeAgentExecution({
        executionId: record.executionId,
        agentId: record.agentId,
        prompt: action.prompt || "Notification clicked: continue task loop.",
      });
    } catch (e) {
      resumeResult = { ok: false, error: String(e?.message ?? e) };
    }
  }

  // Default / Navigation / Thread view target URL
  const targetUrl = buildNotificationTargetUrl({
    threadId: action.type === NOTIFICATION_ACTION_TYPES.OPEN_THREAD ? action.threadId : record.threadId,
    executionId: record.executionId,
    taskId: record.taskId,
    path: action.type === NOTIFICATION_ACTION_TYPES.NAVIGATE ? action.path : null,
  });

  const navResult = await openOrFocusExtensionUrl(targetUrl, { tabsApi, windowsApi });

  return {
    ok: true,
    notificationId,
    state: NOTIFICATION_STATES.CLICKED,
    action: action.type,
    targetUrl,
    navigation: navResult,
    resume: resumeResult,
  };
}

/**
 * Handle notification closed/dismissed event.
 */
export async function handleNotificationClosed(
  notificationId,
  byUser = true,
  { registry = null } = {},
) {
  if (!notificationId || typeof notificationId !== "string") return null;

  if (registry) {
    return registry.updateState(notificationId, NOTIFICATION_STATES.DISMISSED, {
      dismissedByUser: Boolean(byUser),
    });
  }

  return null;
}
