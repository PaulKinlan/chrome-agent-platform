// lib/browser-tools.js — browser-control + event-listening tools the agent
// can call. Destructive operations (open/navigate/close) are gated behind an
// explicit user grant (a chrome.storage flag the hub sets when the user opts
// in), so a page's untrusted text can never drive arbitrary tab control.

import { tool } from "ai";
import { z } from "zod";

const GRANT_KEY = "cap:browserControlGrant";

export async function isBrowserControlGranted() {
  const s = await chrome.storage.local.get(GRANT_KEY);
  return Boolean(s[GRANT_KEY]);
}

export async function setBrowserControlGrant(granted) {
  await chrome.storage.local.set({ [GRANT_KEY]: Boolean(granted) });
  return Boolean(granted);
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
      description: "Navigate an existing tab to a URL. Requires browser-control permission.",
      inputSchema: z.object({ tabId: z.number().optional(), url: z.string().url() }),
      execute: async ({ tabId, url }) => {
        const g = await guard();
        if (g) return g;
        const id = tabId ?? (await activeTab())?.id;
        if (!id) return { error: "no tab" };
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
          // Activate the REQUESTED tab so captureVisibleTab targets it (it captures
          // the active tab of the window, not an arbitrary tabId).
          if (tab.id) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
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
      description: "Close a tab by id. Requires browser-control permission.",
      inputSchema: z.object({ tabId: z.number() }),
      execute: async ({ tabId }) => {
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
