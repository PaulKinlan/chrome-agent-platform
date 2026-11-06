// lib/pure-tabs.js — the tab/URL seam (web-tab and internal-URL predicates, the tab
// change notifier, sidebar role labels, keyboard commands, omnibox URLs, and the
// discovered-only offering filter). Extracted from lib/pure.js by
// chrome-agent-platform-ux4ud; pure.js re-exports it.
import { escapeHtml } from "./pure-text.js";
/** Discovered-but-not-enrolled tool-offering pages for the Directory surface
 * (chrome-agent-platform-cthe): the passive detection list minus origins the
 * directory already shows as enrolled, deduped by origin, most-recently-used
 * first (the route sorts by lastAccessed). Pure so the hub surface and its
 * test share one rule. */
export function discoveredOnly(tabs, enrolledOrigins) {
  const enrolled = new Set(enrolledOrigins);
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (typeof t?.origin !== "string" || !t.origin) continue;
    if (enrolled.has(t.origin) || seen.has(t.origin)) continue;
    seen.add(t.origin);
    out.push(t);
  }
  return out;
}

/** The manifest `commands` ids, in the order Settings lists them. Kept beside
 * the parser so the UI, the service worker and the tests share ONE list — a
 * hand-copied second list is exactly how the composer/+menu duplicates drifted. */
export const KEYBOARD_COMMANDS = ["open-hub", "new-task", "open-side-panel", "ask-about-page"];

/** The hub URL a keyboard command should open. "new-task" lands on "#compose",
 * which parseNtpHash routes to the hub with the task composer focused. No
 * command ever carries page text — a shortcut must not inject task text.
 * "ask-about-page" is handled by the service worker (it opens the side panel
 * with the ACTIVE TAB attached, via a storage.session hand-off keyed by tab
 * id — see lib/ask-agent-entry.js); its hub URL is the plain hub, used only
 * when the side panel cannot open. */
export function hubUrlForCommand(command, getURL) {
  const base = getURL("ntp/ntp.html");
  return command === "new-task" ? `${base}#compose` : base;
}

/* ── Single-sourced shared helpers (CAP-FB-20260830-ESCAPEHTML-SINGLE-SOURCE-01)
 * Every page, worker and the service worker imports THESE. A second copy of any
 * of them anywhere under extension/ fails tests/single-source-helpers.test.ts
 * — the hub and Settings each carried an escapeHtml that skipped the single
 * quote, which is exactly the drift a grep guard exists to stop. This module
 * is dependency-free so the agent worker (where components.js cannot load)
 * can import it too. ─────────────────────────────────────────────────────── */

/** Formats an agent's persona / prompt snippet for display in compact sidebar rows:
 * strips leading markdown headers, extracts "- **Role**: <role>", and strips markdown syntax. */
export function formatSidebarAgentRole(raw) {
  if (!raw || typeof raw !== "string") return "";
  const str = raw.trim();
  if (!str) return "";

  // 1. If raw contains - **Role**: <text> or **Role**: <text>, extract <text> (up to newline or " - **")
  const roleMatch = str.match(/(?:^|\n|\s)(?:[-*]\s+)?\*{0,2}Role\*{0,2}:\s*([^\n]+)/i);
  if (roleMatch && roleMatch[1]) {
    let roleText = roleMatch[1].trim();
    const splitIndex = roleText.search(/\s+-\s+\*\*/);
    if (splitIndex !== -1) {
      roleText = roleText.slice(0, splitIndex).trim();
    }
    roleText = roleText.replace(/[*_`]/g, "").trim();
    if (roleText) return roleText;
  }

  // 2. Otherwise strip markdown heading lines (^#+\s*.*$/gm)
  let cleaned = str.replace(/^#+\s*.*$/gm, "");

  // Strip leading list markers
  cleaned = cleaned.replace(/^\s*[-*]\s+/gm, "");

  // Strip bold/italic/code markers
  cleaned = cleaned.replace(/[*_`]/g, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

/**
 * Determines whether a URL represents an internal extension surface or blank tab
 * created during cold boot. These surfaces never host site tools and must not
 * broadcast open-tabs-changed during boot.
 *
 * @param {string | undefined | null} url
 * @returns {boolean}
 */
export function isInternalExtensionUrl(url) {
  if (!url || typeof url !== "string") return true;
  if (url === "about:blank") return true;
  if (url.startsWith("chrome-extension://")) return true;
  return false;
}

export function isWebTabUrl(url) {
  return typeof url === "string" && /^https?:/.test(url);
}

export function createTabChangeNotifier({ notify, chromeTabs, debounceMs = 300 }) {
  let timer = null;
  const knownWebTabs = new Set();
  const createdInternalTabs = new Set();
  let baselinePending = false;
  const pendingUpdatesDuringBaseline = new Map(); // tabId -> url

  function noteChange() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      notify();
    }, debounceMs);
  }

  function handleCreated(tab) {
    const url = tab?.url || tab?.pendingUrl;
    const tabId = tab?.id;
    if (tabId != null) {
      if (isWebTabUrl(url)) {
        knownWebTabs.add(tabId);
        createdInternalTabs.delete(tabId);
        noteChange();
      } else {
        // Tab was created as an internal/blank surface during this worker session
        createdInternalTabs.add(tabId);
      }
    }
  }

  function handleUpdated(tabId, info, tab) {
    const url = info?.url || tab?.url || tab?.pendingUrl;
    const id = tabId ?? tab?.id;

    if (id != null && knownWebTabs.has(id) && !isWebTabUrl(url)) {
      // Known web tab transitioned to non-web (about:blank, chrome://, or extension page):
      // immediately purge from known web tabs and notify so stale tool offers are cleared.
      knownWebTabs.delete(id);
      if (baselinePending) pendingUpdatesDuringBaseline.delete(id);
      noteChange();
      return;
    }

    if (isWebTabUrl(url)) {
      if (id != null) {
        knownWebTabs.add(id);
        createdInternalTabs.delete(id);
        if (baselinePending) pendingUpdatesDuringBaseline.delete(id);
      }
      if (info?.status === "complete" || typeof info?.url === "string") {
        noteChange();
      }
    } else if (id != null) {
      if (baselinePending) {
        // While baseline query is pending, buffer non-web update
        pendingUpdatesDuringBaseline.set(id, url);
      }
    }
  }

  function handleActivated(activeInfo) {
    const id = activeInfo?.tabId;
    if (id != null && chromeTabs?.get) {
      try {
        chromeTabs.get(id, (tab) => {
          const url = tab?.url || tab?.pendingUrl;
          if (!isInternalExtensionUrl(url) && isWebTabUrl(url)) {
            knownWebTabs.add(id);
            createdInternalTabs.delete(id);
            noteChange();
          }
        });
      } catch {
        // Safe fail-closed
      }
    }
  }

  function handleRemoved(tabId) {
    if (tabId != null) {
      knownWebTabs.delete(tabId);
      createdInternalTabs.delete(tabId);
      if (baselinePending) pendingUpdatesDuringBaseline.delete(tabId);
    }
    noteChange();
  }

  function initBaseline(initialTabs) {
    if (Array.isArray(initialTabs)) {
      for (const t of initialTabs) {
        const url = t?.url || t?.pendingUrl;
        if (t?.id != null && isWebTabUrl(url)) {
          knownWebTabs.add(t.id);
        }
      }
      return;
    }
    if (chromeTabs?.query) {
      baselinePending = true;
      try {
        chromeTabs.query({}, (tabs) => {
          baselinePending = false;
          let transitionedDuringBaseline = false;
          for (const t of tabs ?? []) {
            const id = t?.id;
            if (id == null) continue;
            const url = t?.url || t?.pendingUrl;
            if (isWebTabUrl(url)) {
              if (pendingUpdatesDuringBaseline.has(id)) {
                // Tab was web in snapshot but updated to non-web while query was pending
                knownWebTabs.delete(id);
                transitionedDuringBaseline = true;
              } else {
                knownWebTabs.add(id);
              }
            } else {
              // Tab in query result is non-web.
              // If a live web update already confirmed this tab is web (newer than snapshot),
              // do NOT overwrite it!
              if (!knownWebTabs.has(id)) {
                if (pendingUpdatesDuringBaseline.has(id)) {
                  // If this was an uncertain pre-existing tab (not created as internal during boot),
                  // its navigation away to non-web transitions!
                  if (!createdInternalTabs.has(id)) {
                    transitionedDuringBaseline = true;
                  }
                }
              }
            }
          }
          pendingUpdatesDuringBaseline.clear();
          if (transitionedDuringBaseline) {
            noteChange();
          }
        });
      } catch {
        baselinePending = false;
        pendingUpdatesDuringBaseline.clear();
      }
    }
  }

  initBaseline();

  return {
    noteChange,
    handleCreated,
    handleUpdated,
    handleActivated,
    handleRemoved,
    initBaseline,
    knownWebTabs,
    createdInternalTabs,
    isBaselinePending: () => baselinePending,
  };
}

// probe
