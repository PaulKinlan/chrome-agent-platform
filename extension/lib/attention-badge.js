// lib/attention-badge.js — "Waiting on you": the toolbar action badge and the
// completion/pause notifications for runs the owner is NOT looking at
// (chrome-agent-platform-3p3e.6).
//
// The job: the owner starts a task, switches tabs, and the agent stops on an
// Allow card (or finishes). Without this the stalled run is discovered an hour
// later. With it the toolbar icon carries a count, and — when the
// `notifications` permission is granted — a notification whose click opens the
// exact thread.
//
// Shape:
//   - `pendingAttention(runs, connectedPorts, extras)` is a PURE projection
//     over public durable-run records (no chrome.*), unit-tested directly.
//   - `createAttentionTracker()` is the service worker's in-memory state: it
//     consumes the durable registry's `run-update` events, the live Allow-card
//     opens/closes, and the port registry's "which surface is open" reports,
//     and coalesces the storm into ONE badge write per ATTENTION_COALESCE_MS.
//     Every input is injectable, so the whole thing runs off-browser; the
//     service worker binds the real chrome.action / notifications.
//
// Hot-path rule: no storage reads. The tracker is seeded ONCE from the
// registry's list() after recovery, then fed incrementally by the change hook.

import { runSurfaceIdentity } from "./run-scope.js";
import { scheduledNotificationClickAction, SCHEDULED_NOTIFICATION_ICON } from "./scheduled-run-report.js";

/** Registry storms (a run's many heartbeats, a snapshot replay) coalesce into
 * one badge write per window. */
export const ATTENTION_COALESCE_MS = 250;

/** The badge background: the design accent (petrol teal) — never red unless
 * an item is an error (docs/DESIGN.md palette). */
export const ATTENTION_BADGE_ACCENT = "#0e6e63";
export const ATTENTION_BADGE_DANGER = "#b3261e";
export const ATTENTION_BADGE_TEXT_COLOR = "#ffffff";

/** The durable phases where the run is stopped and ONLY the owner can move it
 * (`run.resume` accepts exactly these; `paused-interruption` resumes itself). */
export const ATTENTION_PAUSED_PHASES = Object.freeze([
  "paused-permission",
  "paused-provider-change",
  "paused-side-effect-uncertain",
]);

const TERMINAL = new Set(["terminal", "cancelled"]);
const PAUSED = new Set(ATTENTION_PAUSED_PHASES);

/** Interactive run kinds: an owner-started task or an agent conversation. A
 * scheduled run already raises its own notification on the scheduled settle
 * path, and a delegate child reports through its parent. */
const INTERACTIVE_KINDS = new Set(["task", "agent"]);

/** Bounded notification body (a runaway result must never blow it). */
export const ATTENTION_NOTIFICATION_MAX_MESSAGE = 160;

/** Bound on remembered unseen-settled runs: the badge never grows without
 * bound across a long-lived worker; the oldest fall off. */
export const ATTENTION_UNSEEN_CAP = 50;

/** The surface key a run belongs to — `thread:<id>` for a task thread,
 * `agent:<ref>` for an agent conversation, or null when it has neither. The
 * same identity the hub/side panel use to project runs onto a surface
 * (lib/run-scope.js), so "open on a connected port" compares like with like. */
export function runSurfaceKey(run) {
  const identity = runSurfaceIdentity({ threadId: run?.threadId ?? null, agentId: null });
  if (identity) return `${identity.type}:${identity.id}`;
  const agentId = typeof run?.agentId === "string" && run.agentId ? run.agentId : null;
  return agentId ? `agent:${agentId}` : null;
}

/** Normalize a port's reported surface (`{ type: "thread"|"agent", id }`) to
 * the same key. Anything else reads as "no surface open". */
export function surfaceKeyOf(surface) {
  if (!surface || typeof surface !== "object") return null;
  const type = String(surface.type ?? "");
  const id = typeof surface.id === "string" ? surface.id : "";
  if (!id || (type !== "thread" && type !== "agent")) return null;
  return `${type}:${id}`;
}

export function isInteractiveRun(run) {
  return INTERACTIVE_KINDS.has(String(run?.kind ?? "task"));
}

/**
 * The pure projection.
 *
 * @param {Array<object>} runs            public durable-run records
 * @param {Array<{surface?: object|null}>} connectedPorts  one entry per live
 *        hub/side-panel port, each carrying the surface it is showing (or null)
 * @param {{ pendingCards?: Iterable<string>, unseenSettled?: Iterable<string> }} extras
 *        pendingCards: executionIds with a live Allow card awaiting a decision;
 *        unseenSettled: executionIds that settled while nobody was looking
 * @returns {{ count: number, items: Array<{executionId,kind,surfaceKey,error,updatedAt,run}> }}
 */
export function pendingAttention(runs, connectedPorts = [], { pendingCards = [], unseenSettled = [] } = {}) {
  const openSurfaces = new Set();
  for (const port of Array.isArray(connectedPorts) ? connectedPorts : []) {
    const key = surfaceKeyOf(port?.surface);
    if (key) openSurfaces.add(key);
  }
  const cards = new Set(pendingCards);
  const unseen = new Set(unseenSettled);
  const items = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    const executionId = typeof run?.executionId === "string" ? run.executionId : "";
    if (!executionId) continue;
    const phase = String(run.phase ?? "");
    let kind = null;
    let error = false;
    if (PAUSED.has(phase)) kind = "paused";
    else if (!TERMINAL.has(phase) && cards.has(executionId)) kind = "card";
    else if (TERMINAL.has(phase) && unseen.has(executionId) && isInteractiveRun(run)) {
      kind = "settled";
      error = run.terminal?.ok === false || phase === "cancelled";
    }
    if (!kind) continue;
    const surfaceKey = runSurfaceKey(run);
    if (surfaceKey && openSurfaces.has(surfaceKey)) continue; // the owner is looking at it
    items.push({ executionId, kind, surfaceKey, error, updatedAt: Number(run.updatedAt ?? 0) || 0, run });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return { count: items.length, items };
}

/** The badge text for a count: "" clears the badge; large counts stay legible
 * in the four-character badge. */
export function badgeTextFor(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

/** The badge colour: red ONLY when something in the set is an error. */
export function badgeColorFor(items) {
  return (Array.isArray(items) ? items : []).some((item) => item?.error === true)
    ? ATTENTION_BADGE_DANGER
    : ATTENTION_BADGE_ACCENT;
}

/** Where an attention notification's click lands: the task thread when the run
 * has one (open-thread → `#omnibox=thread:<id>`), else the agent surface. */
export function attentionClickAction(run) {
  const threadId = typeof run?.threadId === "string" && run.threadId ? run.threadId : null;
  if (threadId) return { type: "open-thread", threadId };
  return scheduledNotificationClickAction(run?.agentId ?? null);
}

/** The notification spec for a run that needs the owner. Pure: the service
 * worker registers it with the notification registry and calls
 * chrome.notifications.create with `chrome.runtime.getURL(iconPath)`. */
export function buildAttentionNotification(run, reason) {
  const executionId = String(run?.executionId ?? "");
  const preview = String(run?.taskPreview ?? "").replace(/\s+/g, " ").trim();
  let title;
  let body;
  if (reason === "paused") {
    title = "Waiting on you";
    body = String(run?.pause?.reason ?? "").trim() || "A run is paused until you allow it.";
  } else {
    const ok = run?.terminal?.ok !== false && String(run?.phase ?? "") !== "cancelled";
    title = ok ? "Task finished" : "Task stopped";
    body = String(run?.terminal?.result ?? "").replace(/\s+/g, " ").trim() || preview || (ok ? "The result is ready." : "The run did not finish.");
  }
  const message = (preview && reason === "paused" ? `${preview} — ${body}` : body).slice(0, ATTENTION_NOTIFICATION_MAX_MESSAGE);
  return {
    notificationId: `cap:attention:${executionId}`,
    executionId,
    threadId: typeof run?.threadId === "string" ? run.threadId : null,
    agentId: typeof run?.agentId === "string" ? run.agentId : null,
    title,
    message,
    action: attentionClickAction(run),
    iconPath: SCHEDULED_NOTIFICATION_ICON,
  };
}

/**
 * The service worker's in-memory attention state + the coalesced badge writer.
 *
 * Inputs (all injectable; defaults are globals so the worker can call it bare):
 *   setBadge({ text, color })  — applies the badge; called ONLY when the text or
 *                                colour changes (never on every registry write)
 *   notify(spec, reason)       — raises a notification (the worker decides
 *                                whether `notifications` is granted)
 *   setTimeout/clearTimeout/now — timers for the coalescing window
 */
export function createAttentionTracker({
  setBadge = () => {},
  notify = () => {},
  coalesceMs = ATTENTION_COALESCE_MS,
  setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
  clearTimeout: cancel = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  /** executionId → public record — only runs that can matter: non-terminal
   *  ones, plus terminal ones still unseen. Everything else is dropped. */
  const runs = new Map();
  const ports = new Map(); // port → { surface: object|null }
  const pendingCards = new Map(); // executionId → Set<cardId>
  const unseenSettled = new Set(); // insertion-ordered; bounded by ATTENTION_UNSEEN_CAP
  const notified = new Set(); // executionId:reason — exactly one notification per transition
  let seeded = false;
  const preSeed = [];
  let timer = null;
  let applied = { text: null, color: null };

  function portEntries() {
    return [...ports.values()];
  }

  function project() {
    return pendingAttention([...runs.values()], portEntries(), {
      pendingCards: pendingCards.keys(),
      unseenSettled,
    });
  }

  function flush() {
    timer = null;
    const { items } = project();
    const text = badgeTextFor(items.length);
    const color = badgeColorFor(items);
    if (text === applied.text && color === applied.color) return;
    applied = { text, color };
    try { setBadge({ text, color, count: items.length }); } catch { /* the badge is advisory */ }
  }

  function scheduleFlush() {
    if (timer != null) return;
    timer = schedule(flush, coalesceMs);
  }

  function surfaceOpen(run) {
    const key = runSurfaceKey(run);
    if (!key) return false;
    for (const entry of ports.values()) if (surfaceKeyOf(entry.surface) === key) return true;
    return false;
  }

  function raise(run, reason) {
    const stamp = `${run.executionId}:${reason}`;
    if (notified.has(stamp)) return;
    notified.add(stamp);
    if (notified.size > 512) notified.delete(notified.values().next().value);
    try { notify(buildAttentionNotification(run, reason), reason); } catch { /* best-effort */ }
  }

  function absorb(run, { transition = true } = {}) {
    const executionId = typeof run?.executionId === "string" ? run.executionId : "";
    if (!executionId) return;
    const prev = runs.get(executionId) ?? null;
    const phase = String(run.phase ?? "");
    const prevPhase = String(prev?.phase ?? "");
    if (TERMINAL.has(phase)) {
      // A settle TRANSITION needs a known non-terminal prior: a terminal
      // re-write (compaction, retention migration) for a run already dropped
      // from this map must never read as "just finished".
      const settledNow = transition && prev !== null && !TERMINAL.has(prevPhase);
      if (settledNow && isInteractiveRun(run) && !surfaceOpen(run)) {
        unseenSettled.add(executionId);
        while (unseenSettled.size > ATTENTION_UNSEEN_CAP) unseenSettled.delete(unseenSettled.values().next().value);
        // Nobody has a hub or side panel open at all → the notification is the
        // only way the owner learns the run finished.
        if (ports.size === 0) raise(run, "settled");
      }
      pendingCards.delete(executionId);
      if (unseenSettled.has(executionId)) runs.set(executionId, run);
      else runs.delete(executionId);
      scheduleFlush();
      return;
    }
    runs.set(executionId, run);
    if (PAUSED.has(phase) && prevPhase !== phase && transition) {
      // A paused run cannot continue without the owner: notify regardless of
      // open surfaces (the fix is in Settings, not in the thread).
      if (phase === "paused-permission") raise(run, "paused");
    }
    scheduleFlush();
  }

  return Object.freeze({
    /** Seed from ONE registry list() at boot; events that arrived before the
     * seed are replayed after it, fenced by revision. */
    seed(records) {
      for (const run of Array.isArray(records) ? records : []) absorb(run, { transition: false });
      seeded = true;
      const buffered = preSeed.splice(0, preSeed.length);
      for (const run of buffered) {
        const known = runs.get(run.executionId);
        if (known && Number(known.revision ?? 0) >= Number(run.revision ?? 0)) continue;
        absorb(run);
      }
      scheduleFlush();
    },
    /** The durable registry change hook: a `run-update` event's public record. */
    onRunUpdate(event) {
      const run = event?.run ?? event;
      if (!run || typeof run !== "object") return;
      if (!seeded) { preSeed.push(run); if (preSeed.length > 256) preSeed.shift(); return; }
      absorb(run);
    },
    /** A hub/side-panel port connected (surface unknown until it reports). */
    portConnected(port) {
      ports.set(port, { surface: null });
      scheduleFlush();
    },
    portDisconnected(port) {
      ports.delete(port);
      scheduleFlush();
    },
    /** The port now shows this surface (`{type:"thread"|"agent", id}` or null):
     * every unseen-settled run on it is seen. */
    portViewing(port, surface) {
      if (!ports.has(port)) ports.set(port, { surface: null });
      const key = surfaceKeyOf(surface);
      ports.get(port).surface = key ? { type: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) } : null;
      if (key) {
        for (const executionId of [...unseenSettled]) {
          const run = runs.get(executionId);
          if (!run || runSurfaceKey(run) === key) {
            unseenSettled.delete(executionId);
            if (run) runs.delete(executionId);
          }
        }
      }
      scheduleFlush();
    },
    /** A live Allow card (inline permission or owner approval) opened/closed
     * for a running execution. */
    cardOpened(executionId, cardId) {
      const id = String(executionId ?? "");
      if (!id) return;
      if (!pendingCards.has(id)) pendingCards.set(id, new Set());
      pendingCards.get(id).add(String(cardId ?? ""));
      scheduleFlush();
    },
    cardClosed(executionId, cardId) {
      const id = String(executionId ?? "");
      const set = pendingCards.get(id);
      if (!set) return;
      set.delete(String(cardId ?? ""));
      if (set.size === 0) pendingCards.delete(id);
      scheduleFlush();
    },
    /** The owner explicitly acknowledged these runs (dismissed from the hub). */
    acknowledge(executionIds) {
      for (const raw of Array.isArray(executionIds) ? executionIds : [executionIds]) {
        const id = String(raw ?? "");
        if (unseenSettled.delete(id)) runs.delete(id);
      }
      scheduleFlush();
    },
    /** Force the pending window to apply now (tests + worker shutdown). */
    flushNow() {
      if (timer != null) { cancel(timer); timer = null; }
      flush();
    },
    /** Read-only projection for diagnostics/tests. */
    snapshot() {
      const { count, items } = project();
      return {
        count,
        items: items.map(({ executionId, kind, surfaceKey, error }) => ({ executionId, kind, surfaceKey, error })),
        ports: ports.size,
        badge: { ...applied },
      };
    },
  });
}
