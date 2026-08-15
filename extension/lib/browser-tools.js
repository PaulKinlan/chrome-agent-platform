// lib/browser-tools.js — browser-control + event-listening tools the agent
// can call. Destructive operations (open/navigate/close) are gated behind an
// explicit user grant (a chrome.storage flag the hub sets when the user opts
// in), so a page's untrusted text can never drive arbitrary tab control.

import { tool } from "ai";
import { z } from "zod";

const GRANT_KEY = "cap:browserControlGrant";
const DEFAULT_GRANT_MS = 15 * 60 * 1000; // 15-minute scope — re-confirm after expiry

// A grant is scoped: it expires, and destructive tab actions are limited to the
// approved origins. NOT an indefinite global Boolean.
export async function isBrowserControlGranted(origin) {
  const s = await chrome.storage.local.get(GRANT_KEY);
  const grant = s[GRANT_KEY];
  if (!grant || typeof grant !== "object") return false;
  if (typeof grant.expiresAt !== "number" || grant.expiresAt <= Date.now()) return false;
  if (origin && Array.isArray(grant.origins) && grant.origins.length > 0) {
    return grant.origins.includes(origin);
  }
  return true;
}

export async function setBrowserControlGrant({ origins = [], expiryMs = DEFAULT_GRANT_MS } = {}) {
  const grant = {
    expiresAt: Date.now() + expiryMs,
    origins: origins.slice(0, 50),
    grantedAt: Date.now(),
  };
  await chrome.storage.local.set({ [GRANT_KEY]: grant });
  return grant;
}

/** Resolve the active tab in the current window. */
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

/** Read the visible text of a tab (or the active tab) via scripting. */
export async function readPage(tabId) {
  try {
    const target = tabId ? { tabId } : await activeTab().then((t) => (t?.id ? { tabId: t.id } : null));
    if (!target) return { error: "no tab" };
    const results = await chrome.scripting.executeScript({
      target,
      func: () => ({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText ?? "").slice(0, 20000),
      }),
    });
    return results?.[0]?.result ?? { error: "no result" };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** The browser-control toolset, passed into the agent. */
export function browserToolset() {
  const guard = async () => {
    if (!(await isBrowserControlGranted())) {
      return { error: "browser control not granted — ask the user to enable it in Settings" };
    }
    return null;
  };
  return {
    open_tab: tool({
      description: "Open a URL in a new browser tab. Requires browser-control permission.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const g = await guard();
        if (g) return g;
        const tab = await chrome.tabs.create({ url });
        return { ok: true, tabId: tab.id, url };
      },
    }),
    navigate_tab: tool({
      description: "Navigate an existing tab to a URL. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number().optional(), url: z.string().url() }),
      execute: async ({ tabId, url }) => {
        const id = tabId ?? (await activeTab())?.id;
        if (!id) return { error: "no tab" };
        const tab = await chrome.tabs.get(id).catch(() => null);
        const origin = tab?.url ? new URL(tab.url).origin : undefined;
        if (origin && !(await isBrowserControlGranted(origin))) {
          return { error: "browser control not granted for this origin — ask the user to approve it in Settings" };
        }
        const g = await guard();
        if (g) return g;
        await chrome.tabs.update(id, { url });
        return { ok: true, tabId: id, url };
      },
    }),
    read_page: tool({
      description: "Read the title, URL and visible text of a tab (or the active tab).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => readPage(tabId),
    }),
    capture_screenshot: tool({
      description: "Capture a PNG screenshot of the requested tab (or the active tab).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => {
        try {
          const tab = tabId
            ? await chrome.tabs.get(tabId).catch(() => null)
            : await activeTab();
          if (!tab?.windowId) return { error: "no tab" };
          // Activate the REQUESTED tab, then VERIFY it became active before
          // capture (captureVisibleTab captures the active tab — never another).
          if (tab.id) await chrome.tabs.update(tab.id, { active: true });
          const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
          if (active?.[0]?.id !== tab.id) return { error: "could not activate the requested tab" };
          const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          return { screenshot: url };
        } catch (e) {
          return { error: String(e?.message ?? e) };
        }
      },
    }),
    list_tabs: tool({
      description: "List the open tabs.",
      inputSchema: z.object({}),
      execute: async () => {
        const tabs = await chrome.tabs.query({});
        return { tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) };
      },
    }),
    close_tab: tool({
      description: "Close a tab by id. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number() }),
      execute: async ({ tabId }) => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const origin = tab?.url ? new URL(tab.url).origin : undefined;
        if (origin && !(await isBrowserControlGranted(origin))) {
          return { error: "browser control not granted for this origin — ask the user to approve it in Settings" };
        }
        const g = await guard();
        if (g) return g;
        await chrome.tabs.remove(tabId);
        return { ok: true, tabId };
      },
    }),
    recent_browser_events: tool({
      description: "Read the recent browser events (tab opened/updated/navigated).",
      inputSchema: z.object({ limit: z.number().optional() }),
      execute: async ({ limit }) => {
        const events = await chrome.storage.local.get("cap:events");
        const list = events["cap:events"] ?? [];
        return { events: list.slice(0, limit ?? 20) };
      },
    }),
    schedule_task: tool({
      description: "Schedule a future task to run the agent at an absolute time (epoch ms) or after a delay (ms). The task runs even if the browser is idle.",
      inputSchema: z.object({
        task: z.string().min(1).max(4000),
        at: z.number().optional(),
        delayMs: z.number().optional(),
        periodInMinutes: z.number().optional(),
      }),
      execute: async ({ task, at, delayMs, periodInMinutes }) => {
        // Same scheduling path as the register-task route: persist the full payload
        // (so it survives worker restart) + create the chrome alarm.
        const name = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let when;
        if (typeof at === "number" && at > Date.now()) when = at;
        else if (typeof delayMs === "number" && delayMs > 0) when = Date.now() + delayMs;
        else return { error: "provide a future `at` (absolute ms) or a positive `delayMs`" };
        const KEY = "cap:scheduledTasks";
        const store = await chrome.storage.local.get(KEY);
        const tasks = store[KEY] ?? {};
        tasks[name] = { name, task, periodInMinutes, at: when };
        await chrome.storage.local.set({ [KEY]: tasks });
        const info = { when };
        if (periodInMinutes) info.periodInMinutes = periodInMinutes;
        await chrome.alarms.create(name, info);
        return { ok: true, name, when };
      },
    }),
  };
}

/** Record a browser event into the rolling event log (kept in chrome.storage). */
export async function recordBrowserEvent(kind, payload) {
  const key = "cap:events";
  const stored = await chrome.storage.local.get(key);
  const list = stored[key] ?? [];
  list.unshift({ kind, at: new Date().toISOString(), ...payload });
  await chrome.storage.local.set({ [key]: list.slice(0, 200) });
}
