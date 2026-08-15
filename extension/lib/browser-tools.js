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

let grantSeq = 0;
/** A unique, non-predictable grant identity. Revoke→regrant always produces a
 * DIFFERENT id, so a capture can detect that authorization was absent during
 * the capture interval (not just that a grant exists before/after). */
function newGrantId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `grant_${Date.now()}_${Math.random().toString(36).slice(2)}_${grantSeq++}`;
}

/** The current grant's identity id, or null when no grant exists. */
export async function getBrowserControlGrantIdentity() {
  const s = await chrome.storage.local.get(GRANT_KEY);
  const grant = s[GRANT_KEY];
  return grant && typeof grant === "object" && typeof grant.id === "string"
    ? grant.id
    : null;
}

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
    id: newGrantId(),
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
    id: newGrantId(),
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
 * Capture a PNG screenshot of the requested tab, gated by the browser-control
 * grant FOR THAT TAB'S ORIGIN. Uses chrome.debugger + Page.captureScreenshot
 * targeting the SPECIFIC tab by id (NOT captureVisibleTab, which captures
 * whatever tab is visible and needs the permanent <all_urls> host permission).
 * Targeting a tab by id eliminates the active-tab ABA race entirely and works
 * with only the `debugger` permission — the tab is attached, captured, and
 * detached within a single call, so there is no lingering broad access.
 */
export async function captureTabScreenshot(tabId) {
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
  // Snapshot the grant IDENTITY (a unique id per grant). A revoke→regrant during
  // the capture produces a NEW id, so a before/after Boolean check alone cannot
  // catch it — the identity must remain IDENTICAL across the whole capture.
  const grantIdBefore = await getBrowserControlGrantIdentity();
  if (!grantIdBefore) return { error: "browser control grant missing" };

  const debuggee = { tabId: tab.id };
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    try {
      await chrome.debugger.sendCommand(debuggee, "Page.enable", {});
      const shot = await chrome.debugger.sendCommand(
        debuggee,
        "Page.captureScreenshot",
        { format: "png" },
      );
      // Post-capture re-checks (fail closed — discard the bytes on ANY doubt):
      // 1. the tab is STILL on the same origin (no navigation during capture);
      // 2. the grant is STILL valid AND the SAME grant identity (closes the
      //    revoke→regrant ABA race).
      const nowTab = await chrome.tabs.get(tab.id).catch(() => null);
      const currentOrigin = nowTab?.url ? canonicalOrigin(nowTab.url) : undefined;
      if (!currentOrigin || currentOrigin !== origin) {
        return { error: "tab navigated during capture — screenshot discarded" };
      }
      if ((await getBrowserControlGrantIdentity()) !== grantIdBefore) {
        return {
          error:
            "browser control grant changed during capture — screenshot discarded",
        };
      }
      if (!(await isBrowserControlGranted(currentOrigin))) {
        return {
          error:
            "browser control grant changed during capture — screenshot discarded",
        };
      }
      if (!shot?.data) return { error: "capture returned no data" };
      return { screenshot: `data:image/png;base64,${shot.data}` };
    } finally {
      await chrome.debugger.detach(debuggee).catch(() => {});
    }
  } catch (e) {
    // Detach on attach/command failure too (never leave a lingering debugger).
    await chrome.debugger.detach(debuggee).catch(() => {});
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
