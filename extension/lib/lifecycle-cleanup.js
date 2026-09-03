// lib/lifecycle-cleanup.js — tab/window lifecycle cleanup (chrome-agent-platform-4ffg).
//
// Agents open tabs/windows (open_tab, duplicate_tab, create_window,
// restore_closed) and used to leave them behind. This module is the PURE core
// of the fix: which tools create persistent browser surface, the cleanup
// guidance their descriptions carry for the model, the per-run tracker that
// records what a run opened and released, and the run-end summary/auto-close
// decisions derived from it.
//
// Pure: no chrome.*, no DOM, no IO — Deno-testable. The service worker wires
// the tracker to a run's tool-result stream and applies the run-end note +
// the (default-off) auto-close at terminal settle. The AUDIT of what each
// lifecycle tool leaves behind lives in docs/LIFECYCLE-CLEANUP.md; this file's
// tables are the machine-readable half the falsification tests walk.
//
// Design notes:
//   - A "release" (close_tab of a tab THIS run opened, close_window of a
//     window THIS run opened) removes the id from the still-open set, so the
//     summary only lists what is genuinely still around and auto-close never
//     re-closes what the run already closed itself.
//   - Which ids a tool result reports is read ONLY through that tool's
//     declared refKeys (LIFECYCLE_OPEN_TOOLS / LIFECYCLE_RELEASE_TOOLS):
//     duplicate_tab therefore consumes newTabId alone and never the source
//     tabId it echoes — a user's pre-existing tab can never be attributed to
//     the run as "opened" (r5 finding 1).
//   - restore_closed reports the ids Chrome actually re-opened
//     (restoredTabId / restoredWindowId / restoredWindowTabIds in its result)
//     so the run summary names them instead of a generic count (r5 finding
//     3). Restored surface is never auto-closeable: re-opening is the
//     deliberate act and the setting must not undo it.
//   - Keepers: open_tab / duplicate_tab accept keep:true (echoed in their
//     result), the tracker marks that id kept, and autoCloseTabPlan leaves
//     kept tabs open — "open this article for me" survives a run that also
//     opened scratch tabs (r5 finding 2).
//   - Auto-close targets TABS only, never windows: closing a window closes
//     every tab in it, which stays owner-approved (Destructive class) — the
//     setting must never silently wipe a window the run opened around other
//     work.

/** The tools whose description must carry cleanup guidance + what each
 *  leaves open. Every name here exists in browserToolset() and the
 *  falsification test walks this exact list. `refKeys` are the ONLY result
 *  keys that count as ids for that tool — duplicate_tab echoes its source
 *  tabId but only newTabId is this run's surface. */
export const LIFECYCLE_OPEN_TOOLS = Object.freeze({
  open_tab: { opens: "tab", refKeys: ["tabId"] },
  duplicate_tab: { opens: "tab", refKeys: ["newTabId"] },
  create_window: { opens: "window", refKeys: ["windowId"] },
  restore_closed: { opens: "session", refKeys: ["restoredTabId", "restoredWindowId", "restoredWindowTabIds"] },
});

/** Tools that RELEASE surface a lifecycle tool opened (used by the tracker to
 *  forget ids the run already cleaned up). */
export const LIFECYCLE_RELEASE_TOOLS = Object.freeze({
  close_tab: { releases: "tab", refKeys: ["tabId"] },
  close_window: { releases: "window", refKeys: ["windowId"] },
});

/** The model-facing cleanup guidance appended to each lifecycle tool's
 *  description. Markers the falsification test asserts on every lifecycle
 *  description: "Cleanup:", "close", "deliberate choice". */
export const CLEANUP_GUIDANCE = Object.freeze({
  open_tab:
    "Cleanup: this opens a NEW TAB and leaves it open after this task. " +
    "When the task that needed it is done, close it with close_tab. " +
    "Leaving a tab open is a deliberate choice — tell the user which tab you kept and why.",
  duplicate_tab:
    "Cleanup: the copy is a NEW TAB this run leaves open after this task. " +
    "When the task that needed the copy is done, close it with close_tab. " +
    "Leaving a tab open is a deliberate choice — tell the user which tab you kept and why.",
  create_window:
    "Cleanup: this opens a NEW WINDOW and leaves it open after this task. " +
    "When the task that needed it is done, close it with close_window (closing a window asks the owner). " +
    "Leaving a window open is a deliberate choice — tell the user which window you kept and why.",
  restore_closed:
    "Cleanup: this RE-OPENS a recently closed tab or window and leaves it open after this task. " +
    "If you restored it only as scratch, close it again (close_tab / close_window) when the task is done. " +
    "Leaving it open is a deliberate choice — tell the user what you kept and why.",
});

/** The guidance a lifecycle tool's description must carry (for tests/docs). */
export function cleanupGuidanceFor(toolName) {
  return CLEANUP_GUIDANCE[String(toolName ?? "")] ?? null;
}

/** Is `name` a lifecycle tool that opens persistent browser surface? */
export function isLifecycleOpenTool(name) {
  return Object.hasOwn(LIFECYCLE_OPEN_TOOLS, String(name ?? ""));
}

/**
 * Decode a tool result payload (the retained full result: a JSON string of
 * the decoded result, or an object) and pull the TOP-LEVEL ids it reports
 * through the tool's OWN declared refKeys. Only top-level keys count — a
 * nested copy of the same result (an args echo, an error excerpt) must never
 * double-count or invent a surface. When `toolName` names a lifecycle tool,
 * only that tool's refKeys are read (duplicate_tab's echoed source tabId is
 * NOT its opened surface); an unknown/empty name keeps the legacy read-every
 * tab/window key behaviour for direct callers. Pure; never throws.
 * @returns {{ tabIds: number[], windowIds: number[], restoredTabIds: number[], restoredWindowIds: number[] }}
 */
export function lifecycleIdsInResult(payload, toolName) {
  const tabIds = [];
  const windowIds = [];
  const restoredTabIds = [];
  const restoredWindowIds = [];
  let d = payload;
  if (typeof d === "string") {
    const s = d.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try { d = JSON.parse(s); } catch { d = payload; }
    } else {
      d = null; // plain text carries no ids
    }
  }
  if (d && typeof d === "object") {
    // A lazy envelope nests the real result under `result` ({ok:true,
    // selectedTool, result:{…}}) — descend exactly one level for ids.
    const candidates = [d];
    const nested = d && typeof d === "object" ? d.result : null;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) candidates.push(nested);
    const entry = Object.hasOwn(LIFECYCLE_OPEN_TOOLS, toolName ?? "")
      ? LIFECYCLE_OPEN_TOOLS[toolName]
      : Object.hasOwn(LIFECYCLE_RELEASE_TOOLS, toolName ?? "")
        ? LIFECYCLE_RELEASE_TOOLS[toolName]
        : null;
    const refKeys = entry ? entry.refKeys : null; // null → legacy all-keys read
    const want = (key) => (refKeys ? refKeys.includes(key) : true);
    const isTabKey = (key) => key === "tabId" || key === "newTabId";
    const isWindowKey = (key) => key === "windowId";
    for (const c of candidates) {
      for (const key of Object.keys(c)) {
        if (!want(key)) continue;
        const v = c[key];
        if (isTabKey(key)) {
          if (Number.isInteger(v) && v > 0 && !tabIds.includes(v)) tabIds.push(v);
        } else if (isWindowKey(key)) {
          if (Number.isInteger(v) && v > 0 && !windowIds.includes(v)) windowIds.push(v);
        }
      }
      // restore_closed: restoredTabId / restoredWindowId are single ids;
      // restoredWindowTabIds is an array of the window's tab ids.
      const rt = c.restoredTabId;
      if (want("restoredTabId") && Number.isInteger(rt) && rt > 0 && !restoredTabIds.includes(rt)) restoredTabIds.push(rt);
      const rw = c.restoredWindowId;
      if (want("restoredWindowId") && Number.isInteger(rw) && rw > 0 && !restoredWindowIds.includes(rw)) restoredWindowIds.push(rw);
      if (want("restoredWindowTabIds") && Array.isArray(c.restoredWindowTabIds)) {
        for (const id of c.restoredWindowTabIds) {
          if (Number.isInteger(id) && id > 0 && !restoredTabIds.includes(id)) restoredTabIds.push(id);
        }
      }
    }
  }
  return { tabIds, windowIds, restoredTabIds, restoredWindowIds };
}

/**
 * The per-run tracker. Feed it every tool-result of a run
 * (onToolResult(toolName, ok, payload)); it records what the run opened and
 * what it already released, so the run-end summary and auto-close plan are
 * exact to THIS run.
 */
export function createLifecycleTracker() {
  const openedTabs = new Map(); // tabId -> { url, kept }
  const openedWindows = new Map(); // windowId -> { url }
  const closedTabIds = new Set(); // ids the RUN already closed itself
  const closedWindowIds = new Set();
  const restoredTabIds = new Set(); // ids restore_closed actually re-opened
  const restoredWindowIds = new Set();
  let restoredSessions = 0; // restores whose ids Chrome did not report

  /** Is `payload` (JSON string or object, lazy envelope allowed) marked keep? */
  const keptOf = (payload) => {
    let d = payload;
    if (typeof d === "string") {
      const s = d.trim();
      if (s.startsWith("{")) { try { d = JSON.parse(s); } catch { d = null; } } else d = null;
    }
    if (d && typeof d === "object") {
      if (d.keep === true) return true;
      const nested = d.result && typeof d.result === "object" ? d.result : null;
      return nested?.keep === true;
    }
    return false;
  };
  const urlOf = (payload) => {
    let d = payload;
    if (typeof d === "string") {
      const s = d.trim();
      if (s.startsWith("{")) { try { d = JSON.parse(s); } catch { d = null; } } else d = null;
    }
    const o = d && typeof d === "object" ? (d.result && typeof d.result === "object" ? d.result : d) : null;
    return o && typeof o.url === "string" ? String(o.url).slice(0, 2048) : null;
  };

  return {
    /**
     * Record one tool result. `payload` is the retained full result (JSON
     * string or object) or null when unavailable. Pure state update.
     */
    onToolResult(tool, ok, payload) {
      const name = String(tool ?? "");
      if (ok !== true) return;
      if (Object.hasOwn(LIFECYCLE_OPEN_TOOLS, name)) {
        if (name === "restore_closed") {
          const { restoredTabIds: rts, restoredWindowIds: rws } = lifecycleIdsInResult(payload ?? {}, name);
          for (const id of rts) restoredTabIds.add(id);
          for (const id of rws) restoredWindowIds.add(id);
          if (rts.length === 0 && rws.length === 0) {
            const d = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
            if (d?.ok === true || payload == null) restoredSessions += 1;
          }
          return;
        }
        const { tabIds, windowIds } = lifecycleIdsInResult(payload ?? {}, name);
        const url = urlOf(payload);
        const kept = keptOf(payload);
        for (const id of tabIds) {
          openedTabs.set(id, { id, url, ...(kept ? { kept: true } : {}) });
          closedTabIds.delete(id);
        }
        for (const id of windowIds) {
          openedWindows.set(id, { id, url });
          closedWindowIds.delete(id);
        }
        return;
      }
      if (Object.hasOwn(LIFECYCLE_RELEASE_TOOLS, name)) {
        const { tabIds, windowIds } = lifecycleIdsInResult(payload ?? {}, name);
        for (const id of tabIds) {
          if (openedTabs.has(id)) {
            openedTabs.delete(id);
            closedTabIds.add(id);
          }
          restoredTabIds.delete(id);
        }
        for (const id of windowIds) {
          if (openedWindows.has(id)) {
            openedWindows.delete(id);
            closedWindowIds.add(id);
          }
          restoredWindowIds.delete(id);
        }
      }
    },

    /** Snapshot of what this run opened and already released. */
    snapshot() {
      return {
        openedTabs: [...openedTabs.values()],
        openedWindows: [...openedWindows.values()],
        closedTabIds: [...closedTabIds],
        closedWindowIds: [...closedWindowIds],
        restoredTabIds: [...restoredTabIds],
        restoredWindowIds: [...restoredWindowIds],
        restoredSessions,
      };
    },
  };
}

/**
 * Which of the run's still-open opened tabs auto-close should remove: exactly
 * `openedTabs` minus the tabs the run already closed itself minus the tabs
 * the run deliberately KEPT (keep:true — "open this article for me" must
 * survive). Nothing else can ever enter the plan — it is a pure filter over
 * the run's own ids.
 */
export function autoCloseTabPlan(snapshot) {
  const closed = new Set(snapshot?.closedTabIds ?? []);
  return (snapshot?.openedTabs ?? [])
    .filter((t) => Number.isInteger(t?.id) && !closed.has(t.id) && t.kept !== true)
    .map((t) => t.id);
}

const TAB_IDS = (list) => list.map((t) => `#${t.id}${t.kept === true ? " (kept)" : ""}`).join(", ");
const WINDOW_IDS = (list) => list.map((w) => `#${w.id}`).join(", ");
const ID_LIST = (list) => list.map((id) => `#${id}`).join(", ");

/**
 * The run-end cleanup summary: a short, deterministic, runtime-written note
 * naming the tabs/windows the run opened and left open (the model's final
 * text gets it appended verbatim at settle). Returns null when there is
 * nothing left to tidy (nothing opened, or the run already closed it all).
 * `autoClosedTabIds` lists the ids auto-close just removed (default-off
 * setting) — the note then says so instead of telling the user to close them.
 */
export function runEndCleanupNote(snapshot, autoClosedTabIds = []) {
  const s = snapshot ?? {};
  const openedTabs = Array.isArray(s.openedTabs) ? s.openedTabs : [];
  const openedWindows = Array.isArray(s.openedWindows) ? s.openedWindows : [];
  const restoredTabIds = Array.isArray(s.restoredTabIds) ? s.restoredTabIds : [];
  const restoredWindowIds = Array.isArray(s.restoredWindowIds) ? s.restoredWindowIds : [];
  const restored = Number(s.restoredSessions) || 0;
  if (openedTabs.length === 0 && openedWindows.length === 0 && restoredTabIds.length === 0 && restoredWindowIds.length === 0 && restored === 0) return null;
  const autoClosed = new Set((Array.isArray(autoClosedTabIds) ? autoClosedTabIds : []).filter(Number.isInteger));
  const lines = [];
  if (openedTabs.length > 0) {
    const stillOpen = openedTabs.filter((t) => !autoClosed.has(t.id));
    const keptOpen = stillOpen.filter((t) => t.kept === true);
    const state = stillOpen.length === 0
      ? "closed (auto-close was on)"
      : autoClosed.size > 0
        ? `${stillOpen.length} still open (${autoClosed.size} auto-closed)`
        : `${stillOpen.length} still open`;
    lines.push(`Tabs this run opened: ${TAB_IDS(openedTabs)} — ${state}.`);
    if (keptOpen.length > 0) {
      lines.push(`Kept ${ID_LIST(keptOpen.map((t) => t.id))} open for the user as the task's result.`);
    }
    const closeable = stillOpen.filter((t) => t.kept !== true);
    if (closeable.length > 0 && autoClosed.size === 0) {
      lines.push("Close any you no longer need with close_tab; say which tab you are keeping for the user and why.");
    }
  }
  if (openedWindows.length > 0) {
    lines.push(`Windows this run opened: ${WINDOW_IDS(openedWindows)} — still open (windows are never auto-closed). Close with close_window if the task is done.`);
  }
  if (restoredTabIds.length > 0) {
    lines.push(`Restored recently closed tab${restoredTabIds.length === 1 ? "" : "s"}: ${ID_LIST(restoredTabIds)} — close it again if it was scratch.`);
  }
  if (restoredWindowIds.length > 0) {
    lines.push(`Restored recently closed window${restoredWindowIds.length === 1 ? "" : "s"}: ${ID_LIST(restoredWindowIds)} — close it again if it was scratch.`);
  }
  if (restored > 0 && restoredTabIds.length === 0 && restoredWindowIds.length === 0) {
    lines.push(`Restored ${restored} recently closed ${restored === 1 ? "session" : "sessions"} — close it again if it was scratch.`);
  }
  return lines.join(" ");
}

/**
 * Append the run-end cleanup note to a run's final result text (the thread's
 * terminal row). Bounded: the note itself is short and the result is bounded
 * downstream anyway. Returns the original text unchanged when note is null.
 */
export function appendRunEndCleanupNote(result, snapshot, autoClosedTabIds = []) {
  const note = runEndCleanupNote(snapshot, autoClosedTabIds);
  if (!note) return result;
  const base = String(result ?? "").trimEnd();
  const sep = base ? "\n\n" : "";
  return `${base}${sep}— Browser-tidy (runtime note) — ${note}`;
}
