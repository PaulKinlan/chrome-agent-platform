// lib/browser-tools.js — browser-control + event-listening tools the agent
// can call. Destructive operations (open/navigate/close) are gated behind an
// explicit user grant (a chrome.storage flag the hub sets when the user opts
// in), so a page's untrusted text can never drive arbitrary tab control.

import { tool } from "ai";
import { z } from "zod";
import { scheduleTask } from "./scheduler.js";
import { canonicalOrigin } from "./memory.js";

const GRANT_KEY = "cap:browserControlGrant";
const DEFAULT_GRANT_MS = 15 * 60 * 1000; // 15-minute scope — re-confirm after expiry

// A grant is EXPLICITLY scoped, expiring, and revocable. Two scopes:
//   - "global": the owner granted control over the whole browser (temporary).
//   - "origins": the owner granted control over a non-empty origin allowlist.
// A grant is NEVER an indefinite global Boolean, and an empty origin list is
// never silently treated as unrestricted.
export async function isBrowserControlGranted(origin) {
  const s = await chrome.storage.local.get(GRANT_KEY);
  const grant = s[GRANT_KEY];
  if (!grant || typeof grant !== "object") return false;
  if (
    typeof grant.expiresAt !== "number" || !Number.isFinite(grant.expiresAt)
  ) return false;
  if (grant.expiresAt <= Date.now()) return false;
  if (grant.scope === "global") return true;
  if (
    grant.scope === "origins" && Array.isArray(grant.origins) &&
    grant.origins.length > 0
  ) {
    return typeof origin === "string" && grant.origins.includes(origin);
  }
  return false; // an empty/unknown origin list is DENIED, never unrestricted
}

function clampExpiryMs(expiryMs) {
  const ms = Number(expiryMs);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_GRANT_MS;
  return Math.min(ms, 60 * 60 * 1000); // never longer than an hour without re-confirm
}

export async function setGlobalBrowserControlGrant(
  expiryMs = DEFAULT_GRANT_MS,
) {
  const grant = {
    scope: "global",
    expiresAt: Date.now() + clampExpiryMs(expiryMs),
    grantedAt: Date.now(),
  };
  await chrome.storage.local.set({ [GRANT_KEY]: grant });
  return grant;
}

export async function setOriginBrowserControlGrant(
  origins,
  expiryMs = DEFAULT_GRANT_MS,
) {
  const canonical = [
    ...new Set(
      (origins ?? []).map((o) => {
        try {
          return canonicalOrigin(String(o));
        } catch {
          return null;
        }
      }).filter(Boolean),
    ),
  ].slice(0, 50);
  if (canonical.length === 0) {
    throw new Error("origin grant needs at least one valid origin");
  }
  const grant = {
    scope: "origins",
    origins: canonical,
    expiresAt: Date.now() + clampExpiryMs(expiryMs),
    grantedAt: Date.now(),
  };
  await chrome.storage.local.set({ [GRANT_KEY]: grant });
  return grant;
}

export async function revokeBrowserControlGrant() {
  await chrome.storage.local.remove(GRANT_KEY);
  return { revoked: true };
}

/** Resolve the active tab in the current window. */
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

/**
 * An activation-generation counter. Every tab-activation or navigation event
 * increments it, so a switch-away-and-back (an ABA active-tab swap) DURING the
 * capture interval is observable even if the requested tab is restored before
 * the post-capture active-tab query. captureVisibleTab captures whichever tab
 * is visible when the API executes, so the counter closes the gap that a
 * before/after query pair cannot.
 */
let activationGen = 0;
let genListenerInstalled = false;
function ensureActivationGenListener() {
  if (genListenerInstalled) return;
  genListenerInstalled = true;
  chrome.tabs.onActivated?.addListener(() => {
    activationGen++;
  });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    // A navigation (or a load) during the capture interval invalidates the
    // captured bytes; it must be observed, not merely re-read after the fact.
    if (changeInfo.status === "loading" || changeInfo.url) activationGen++;
  });
}

/**
 * Capture a PNG screenshot of the requested tab (or the active tab), gated by
 * the browser-control grant FOR THAT TAB'S ORIGIN. This is the ONE gated
 * implementation shared by the agent tool AND the chat runtime route — a
 * post-revoke or wrong-origin capture must fail here.
 */
export async function captureTabScreenshot(tabId) {
  ensureActivationGenListener();
  // Resolve the tab first so we can derive its origin for the grant check.
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await activeTab();
  if (!tab?.id) return { error: "no tab" };

  const origin = tab.url
    ? (() => {
      try {
        return canonicalOrigin(tab.url);
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!origin) return { error: "no origin" };
  if (!(await isBrowserControlGranted(origin))) {
    return {
      error:
        "browser control not granted for this tab's origin — ask the user to approve it in Settings",
    };
  }

  try {
    // Activate the REQUESTED tab, then VERIFY it became active before capture
    // (captureVisibleTab captures the active tab — never another).
    await chrome.tabs.update(tab.id, { active: true });
    const active = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (active?.[0]?.id !== tab.id) {
      return { error: "could not activate the requested tab" };
    }
    // TOCTOU guard: re-read the tab's CURRENT url after activation. It must be
    // the SAME authorized origin — a tab that navigated from an allowed origin
    // to a denied one between authorization and capture must NOT be captured.
    const nowTab = await chrome.tabs.get(tab.id).catch(() => null);
    const currentOrigin = nowTab?.url ? canonicalOrigin(nowTab.url) : undefined;
    if (!currentOrigin || currentOrigin !== origin) {
      return { error: "tab navigated to a different origin — capture denied" };
    }
    if (!(await isBrowserControlGranted(currentOrigin))) {
      return {
        error:
          "browser control not granted for this tab's origin — ask the user to approve it in Settings",
      };
    }
    // Sample the activation generation IMMEDIATELY before capture.
    const genBefore = activationGen;
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    // Post-capture re-checks (fail closed — discard the bytes on ANY doubt):
    // 1. no activation/navigation happened during the capture interval (closes
    //    the switch-away-and-back ABA race);
    // 2. the requested tab is STILL the active one;
    // 3. its origin is unchanged;
    // 4. the grant is STILL valid (closes the mid-capture revoke/expiry race).
    if (activationGen !== genBefore) {
      return { error: "active tab changed during capture — screenshot discarded" };
    }
    const afterActive = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (afterActive?.[0]?.id !== tab.id) {
      return { error: "active tab changed during capture — screenshot discarded" };
    }
    const afterTab = await chrome.tabs.get(tab.id).catch(() => null);
    const afterOrigin = afterTab?.url ? canonicalOrigin(afterTab.url) : undefined;
    if (!afterOrigin || afterOrigin !== origin) {
      return { error: "tab navigated during capture — screenshot discarded" };
    }
    if (!(await isBrowserControlGranted(afterOrigin))) {
      return {
        error:
          "browser control grant changed during capture — screenshot discarded",
      };
    }
    return { screenshot: url };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** Read the visible text of a tab (or the active tab) via scripting. */
export async function readPage(tabId) {
  try {
    const target = tabId
      ? { tabId }
      : await activeTab().then((t) => (t?.id ? { tabId: t.id } : null));
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
  return {
    open_tab: tool({
      description:
        "Open a URL in a new browser tab. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        // Check the DESTINATION origin against the grant (a per-origin grant
        // only authorizes its own origins; a global grant authorizes all).
        let destOrigin;
        try {
          destOrigin = canonicalOrigin(url);
        } catch {
          return { error: "invalid url" };
        }
        if (!(await isBrowserControlGranted(destOrigin))) {
          return {
            error:
              "browser control not granted for this origin — ask the user to approve it in Settings",
          };
        }
        const tab = await chrome.tabs.create({ url });
        return { ok: true, tabId: tab.id, url };
      },
    }),
    navigate_tab: tool({
      description:
        "Navigate an existing tab to a URL. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({
        tabId: z.number().optional(),
        url: z.string().url(),
      }),
      execute: async ({ tabId, url }) => {
        // Check the DESTINATION origin (not just the current tab's origin): an
        // approved origin must not be navigated to an unapproved one.
        let destOrigin;
        try {
          destOrigin = canonicalOrigin(url);
        } catch {
          return { error: "invalid url" };
        }
        if (!(await isBrowserControlGranted(destOrigin))) {
          return {
            error:
              "browser control not granted for the destination origin — ask the user to approve it in Settings",
          };
        }
        const id = tabId ?? (await activeTab())?.id;
        if (!id) return { error: "no tab" };
        await chrome.tabs.update(id, { url });
        return { ok: true, tabId: id, url };
      },
    }),
    read_page: tool({
      description:
        "Read the title, URL and visible text of a tab (or the active tab).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => readPage(tabId),
    }),
    capture_screenshot: tool({
      description:
        "Capture a PNG screenshot of the requested tab (or the active tab). Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => captureTabScreenshot(tabId),
    }),
    list_tabs: tool({
      description: "List the open tabs.",
      inputSchema: z.object({}),
      execute: async () => {
        const tabs = await chrome.tabs.query({});
        return {
          tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        };
      },
    }),
    close_tab: tool({
      description:
        "Close a tab by id. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number() }),
      execute: async ({ tabId }) => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const origin = tab?.url
          ? (() => {
            try {
              return canonicalOrigin(tab.url);
            } catch {
              return undefined;
            }
          })()
          : undefined;
        if (!(await isBrowserControlGranted(origin))) {
          return {
            error:
              "browser control not granted for this origin — ask the user to approve it in Settings",
          };
        }
        await chrome.tabs.remove(tabId);
        return { ok: true, tabId };
      },
    }),
    recent_browser_events: tool({
      description:
        "Read the recent browser events (tab opened/updated/navigated).",
      inputSchema: z.object({ limit: z.number().optional() }),
      execute: async ({ limit }) => {
        const events = await chrome.storage.local.get("cap:events");
        const list = events["cap:events"] ?? [];
        return { events: list.slice(0, limit ?? 20) };
      },
    }),
    schedule_task: tool({
      description:
        "Schedule a future task to run the agent at an absolute time (epoch ms) or after a delay (ms). The task runs even if the browser is idle.",
      inputSchema: z.object({
        task: z.string().min(1).max(4000),
        at: z.number().optional(),
        delayMs: z.number().optional(),
        periodInMinutes: z.number().optional(),
      }),
      execute: async ({ task, at, delayMs, periodInMinutes }) => {
        // The ONE atomic scheduling path (shared with the register-task route).
        const { name, when } = await scheduleTask({
          task,
          at,
          delayMs,
          periodInMinutes,
        });
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
