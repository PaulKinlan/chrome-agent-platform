// lib/pending-approval-replay.js — the service worker's memory of the approval
// cards that are still waiting on the owner (chrome-agent-platform-716s.1).
//
// An `approval-request` progress event is broadcast ONCE, to the ports that are
// connected at that moment. A hub opened afterwards (a second tab, a reload of
// the first) never saw it, so it rendered the paused run as "Working — run in
// progress…" with nothing to click, while the first tab still showed the card.
// This tracker remembers every published approval-request by its DECISION KEY
// (the inline permission `requestId`, or the owner-approval `approvalId`) until
// the matching `approval-settled` arrives, so a port that connects later can be
// handed the SAME event — same key, so the owner's Allow in the second tab wakes
// the exact waiter the first tab's card was bound to. Pure and bounded; the
// worker wires `observe()` at its single broadcast chokepoint and `replayable()`
// at port connect.

export const MAX_TRACKED_PENDING_APPROVALS = 64;

/** The decision key an approval event is tracked under: the inline permission
 * request id wins, else the owner-approval id. Null for anything else. */
export function approvalEventKey(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.requestId === "string" && event.requestId) return event.requestId;
  if (typeof event.approvalId === "string" && event.approvalId) return event.approvalId;
  return null;
}

function stampsOf(event) {
  const out = {};
  for (const field of ["runId", "threadId", "executionId", "requestId", "approvalId"]) {
    if (event[field] !== undefined && event[field] !== null) out[field] = event[field];
  }
  return out;
}

export function createPendingApprovalTracker({ max = MAX_TRACKED_PENDING_APPROVALS } = {}) {
  const pending = new Map(); // key -> the stamped approval-request event, insertion-ordered

  function prune(now) {
    for (const [key, event] of pending) {
      const expiresAt = Number(event?.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) pending.delete(key);
    }
  }

  return {
    /** Observe one event at the broadcast chokepoint. A request is remembered;
     * its settlement forgets it; a run's `done` forgets every card of that
     * execution (a settled run can have no live waiter). Anything else is
     * ignored. Never throws. */
    observe(event) {
      if (!event || typeof event !== "object") return;
      if (event.type === "done") {
        const executionId = typeof event.executionId === "string" ? event.executionId : null;
        if (!executionId) return;
        for (const [key, tracked] of pending) {
          if (tracked.executionId === executionId) pending.delete(key);
        }
        return;
      }
      const key = approvalEventKey(event);
      if (!key) return;
      if (event.type === "approval-request") {
        if (!pending.has(key) && pending.size >= max) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
        pending.set(key, event);
      } else if (event.type === "approval-settled") {
        pending.delete(key);
      }
    },
    /** The tracked request event for a key, or null. */
    get(key) {
      return pending.get(String(key ?? "")) ?? null;
    },
    forget(key) {
      return pending.delete(String(key ?? ""));
    },
    /** The requests still worth replaying to a freshly connected port: not
     * expired, and — when the caller can tell — still backed by a live waiter.
     * Dead entries are pruned as a side effect so the map never grows past
     * what is actually pending. */
    replayable({ now = Date.now(), isLive = null } = {}) {
      prune(now);
      const out = [];
      for (const [key, event] of pending) {
        if (typeof isLive === "function") {
          let live = false;
          try { live = isLive(event, key) === true; } catch { live = false; }
          if (!live) { pending.delete(key); continue; }
        }
        out.push(event);
      }
      return out;
    },
    /** The `approval-settled` event that closes a tracked request — carrying
     * the request's own run/thread/execution stamps so every page's run filter
     * accepts it. Null when the key is unknown. */
    settledEvent(key, state) {
      const event = pending.get(String(key ?? ""));
      if (!event) return null;
      return { ...stampsOf(event), type: "approval-settled", state: String(state ?? "") };
    },
    get size() {
      return pending.size;
    },
  };
}
