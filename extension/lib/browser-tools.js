// lib/browser-tools.js — browser-control + event-listening tools the agent
// can call. Destructive operations (open/navigate/close) are gated behind an
// explicit user grant (a chrome.storage flag the hub sets when the user opts
// in), so a page's untrusted text can never drive arbitrary tab control.

import { tool } from "ai";
import { z } from "zod";
import { scheduleTask } from "./scheduler.js";
import { canonicalOrigin } from "./memory.js";
import { kvGet, kvRemove, kvSet } from "./kv.js";

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
  const s = await kvGet(GRANT_KEY);
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
  const s = await kvGet(GRANT_KEY);
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
  await kvSet({ [GRANT_KEY]: grant });
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
  await kvSet({ [GRANT_KEY]: grant });
  return grant;
}

export async function revokeBrowserControlGrant() {
  await kvRemove(GRANT_KEY);
  return { revoked: true };
}

/** Resolve the active tab in the current window. */
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

/** Whether the OPTIONAL `tabs` permission is currently granted (the broader
 * open/navigate/close/list controls). Screenshot capture uses the SILENT
 * `activeTab` permission instead (see hasActiveTabPermission) — the same
 * permission the reference screenshot tool uses, grantable from a user gesture
 * with no warning. */
async function hasTabsPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["tabs"] });
  } catch {
    return false;
  }
}

/** Whether the OPTIONAL `activeTab` permission is granted (screenshot capture).
 * `activeTab` is SILENT (no warning) so it grants from the Settings gesture even
 * in headless; it authorizes captureVisibleTab of the active tab. */
async function hasActiveTabPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["activeTab"] });
  } catch {
    return false;
  }
}

/** Whether the OPTIONAL `scripting` permission is currently granted. */
async function hasScriptingPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["scripting"] });
  } catch {
    return false;
  }
}

/** A per-tab capture mutex: two concurrent captures of the SAME tab must not
 * interleave (activate + capture + post-check is not atomic across calls), and
 * a losing capture must never return another capture's bytes. */
const captureLocks = new Map();
function withTabCaptureLock(tabId, fn) {
  const prev = captureLocks.get(tabId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  captureLocks.set(tabId, run.then(() => {}, () => {}));
  return run;
}

/** Validate a SINGLE grant record (id + scope + expiry + origin) together.
 * Returns the grant id when the record authorizes `origin`, else null. Reading
 * ONE record and validating id/scope/expiry/origin atomically closes the
 * separate-storage-reads race (the round-13 medium: a revoke→regrant could
 * otherwise slip between a scope check and an identity check). */
function validateGrantFor(grant, origin) {
  if (!grant || typeof grant !== "object") return null;
  if (
    typeof grant.expiresAt !== "number" || !Number.isFinite(grant.expiresAt)
  ) return null;
  if (grant.expiresAt <= Date.now()) return null;
  let authorized = false;
  if (grant.scope === "global") {
    authorized = true;
  } else if (
    grant.scope === "origins" && Array.isArray(grant.origins) &&
    grant.origins.length > 0
  ) {
    authorized = typeof origin === "string" && grant.origins.includes(origin);
  }
  if (!authorized) return null;
  if (typeof grant.id !== "string" || grant.id.length === 0) return null;
  return grant.id;
}

/**
 * Capture a PNG screenshot of the active tab, gated by the browser-control
 * grant FOR THAT TAB'S ORIGIN. Uses chrome.tabs.captureVisibleTab (the standard
 * extension screenshot API — NOT the Chrome debugger, which cannot be optional
 * and carries Chrome's all-sites warning) with the SILENT `activeTab` permission
 * (the same permission the reference screenshot tool uses).
 *
 * `activeTab` authorizes the ACTIVE tab, so capture semantics are: if a tabId
 * is supplied, that tab is ACTIVATED first (chrome.tabs.update needs no
 * permission for {active:true}); the now-active tab's url is read via
 * chrome.tabs.query({active:true}) (url is visible under activeTab) and its
 * origin is grant-checked. The active-tab ABA window is closed by re-deriving +
 * re-checking the origin AND the grant identity before AND after the capture,
 * under a per-tab mutex.
 *
 * Requires the OPTIONAL `activeTab` permission (requested from the Settings
 * browser-control toggle / Screenshots capability). Fail closed when absent.
 */
export async function captureTabScreenshot(tabId) {
  if (!(await hasActiveTabPermission()) && !(await hasTabsPermission())) {
    return {
      error:
        "activeTab permission not granted — enable Screenshots in Settings to allow captures",
    };
  }

  return await withTabCaptureLock(tabId ?? "active", async () => {
    // Activate the requested tab (if any) so it is the active tab — capture
    // targets the ACTIVE tab under activeTab. Activating needs no permission.
    if (tabId) {
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch (e) {
        return { error: `could not activate tab: ${e?.message ?? e}` };
      }
    }
    // The active tab (its url is visible under activeTab / tabs).
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))
      .find((t) => !tabId || t.id === tabId) ?? null;
    if (!active?.id) return { error: "no active tab" };

    const origin = active.url
      ? (() => {
        try {
          return canonicalOrigin(active.url);
        } catch {
          return undefined;
        }
      })()
      : undefined;
    if (!origin) {
      return {
        error:
          "cannot read the active tab's URL — capture requires the tab to be authorized (in a headed browser, invoke the extension on the page you are viewing; activeTab is transient and headless cannot grant it for an arbitrary tab)",
      };
    }
    // Read the grant ONCE and validate id + scope + expiry + origin together (an
    // atomic snapshot, not separate reads). The returned id is the fence for the
    // whole capture.
    const grantIdBefore = validateGrantFor(
      (await kvGet(GRANT_KEY))[GRANT_KEY],
      origin,
    );
    if (!grantIdBefore) {
      return {
        error:
          "browser control not granted for this tab's origin — ask the user to approve it in Settings",
      };
    }

    // Post-activation the tab could have navigated — re-derive + re-check BEFORE
    // capturing (closes the active-tab ABA: activation itself can race a nav).
    const cur = (await chrome.tabs.query({ active: true, currentWindow: true }))
      .find((t) => t.id === active.id) ?? null;
    const curOrigin = cur?.url
      ? (() => {
        try {
          return canonicalOrigin(cur.url);
        } catch {
          return undefined;
        }
      })()
      : undefined;
    if (!curOrigin || curOrigin !== origin) {
      return { error: "tab navigated during capture — screenshot discarded" };
    }

    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(
        cur.windowId ?? undefined,
        { format: "png" },
      );
    } catch (e) {
      return { error: `capture failed: ${e?.message ?? e}` };
    }

    // Post-capture re-checks (fail closed — discard the bytes on ANY doubt):
    // 1. the tab is STILL on the same origin (no navigation during capture);
    // 2. the SAME grant record still authorizes the SAME origin with the SAME
    //    id (closes the revoke→regrant ABA race atomically).
    const nowTab = (await chrome.tabs.query({ active: true, currentWindow: true }))
      .find((t) => t.id === active.id) ?? null;
    const nowOrigin = nowTab?.url
      ? (() => {
        try {
          return canonicalOrigin(nowTab.url);
        } catch {
          return undefined;
        }
      })()
      : undefined;
    if (!nowOrigin || nowOrigin !== origin) {
      return { error: "tab navigated during capture — screenshot discarded" };
    }
    if (
      validateGrantFor(
        (await kvGet(GRANT_KEY))[GRANT_KEY],
        nowOrigin,
      ) !== grantIdBefore
    ) {
      return {
        error:
          "browser control grant changed during capture — screenshot discarded",
      };
    }
    if (!dataUrl || !String(dataUrl).startsWith("data:image/")) {
      return { error: "capture returned no image data" };
    }
    return {
      screenshot: dataUrl,
      url: nowTab.url, // the SOURCE page, so the UI re-opens the page (not the data URL)
    };
  });
}

/** Read the visible text of a tab (or the active tab) via scripting. */
export async function readPage(tabId) {
  try {
    if (!(await hasScriptingPermission())) {
      return {
        error:
          "scripting permission not granted — enable Site agents in Settings",
      };
    }
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
        }
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
        }
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
        }
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
        }
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
        const events = await kvGet("cap:events");
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
  const stored = await kvGet(key);
  const list = stored[key] ?? [];
  list.unshift({ kind, at: new Date().toISOString(), ...payload });
  await kvSet({ [key]: list.slice(0, 200) });
}
