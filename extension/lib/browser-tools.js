// lib/browser-tools.js — browser-control + event-listening tools the agent
// can call. The agent can completely control the browser: open/navigate/close
// tabs, read the page, capture a screenshot, and read browser events that
// happened (the event log from the service-worker's chrome.tabs listeners).

import { tool } from "ai";
import { z } from "zod";

/** Read the visible text of a tab (or the active tab) via scripting. */
export async function readPage(tabId) {
  try {
    const target = tabId ? { tabId } : {};
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
  return {
    open_tab: tool({
      description: "Open a URL in a new browser tab.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        const tab = await chrome.tabs.create({ url });
        return { ok: true, tabId: tab.id, url };
      },
    }),
    navigate_tab: tool({
      description: "Navigate an existing tab to a URL.",
      inputSchema: z.object({ tabId: z.number().optional(), url: z.string() }),
      execute: async ({ tabId, url }) => {
        if (tabId) {
          await chrome.tabs.update(tabId, { url });
          return { ok: true, tabId, url };
        }
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.id) return { error: "no active tab" };
        await chrome.tabs.update(tabs[0].id, { url });
        return { ok: true, tabId: tabs[0].id, url };
      },
    }),
    read_page: tool({
      description: "Read the title, URL and visible text of a tab (or the active tab).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => readPage(tabId),
    }),
    capture_screenshot: tool({
      description: "Capture a PNG screenshot of the visible tab.",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => {
        try {
          const url = await chrome.tabs.captureVisibleTab(tabId ? { tabId } : undefined, { format: "png" });
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
      description: "Close a tab by id.",
      inputSchema: z.object({ tabId: z.number() }),
      execute: async ({ tabId }) => {
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
