// tests/attention-badge.test.ts — "Waiting on you" (chrome-agent-platform-3p3e.6):
// the toolbar action badge + the pause/finish notifications for runs the owner
// is not looking at.
//
// Falsification: every test here is RED against origin/main before the change
// (the module does not exist; the registry has no `subscribe`; the port client
// has no `reportViewedSurface`) and GREEN with it. The tracker tests drive a
// FAKE chrome.action and read the exact setBadgeText sequence — never a source
// substring.
// @ts-nocheck — fake chrome + deterministic timers are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  ATTENTION_BADGE_ACCENT,
  ATTENTION_BADGE_DANGER,
  ATTENTION_COALESCE_MS,
  badgeTextFor,
  buildAttentionNotification,
  createAttentionTracker,
  pendingAttention,
  runSurfaceKey,
} from "../extension/lib/attention-badge.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { createMemoryRunLogHandles } from "./fixtures/run-log-wal-memory.js";
import { validateNotificationAction, NOTIFICATION_ACTION_TYPES } from "../extension/lib/notification-action-routing.js";

const run = (over = {}) => ({
  executionId: `exec_${Math.random().toString(36).slice(2, 12)}`,
  kind: "task",
  threadId: null,
  agentId: null,
  phase: "running",
  revision: 1,
  updatedAt: 1000,
  taskPreview: "summarise the quarterly report",
  ...over,
});

// ── the pure projection ─────────────────────────────────────────────────────

Deno.test("pendingAttention: a paused-permission run counts; a running one does not", () => {
  const paused = run({ executionId: "exec_paused", phase: "paused-permission", threadId: "t1", pause: { reason: "needs the provider host" } });
  const running = run({ executionId: "exec_running", phase: "running", threadId: "t2" });
  const out = pendingAttention([paused, running], []);
  assertEquals(out.count, 1);
  assertEquals(out.items[0].executionId, "exec_paused");
  assertEquals(out.items[0].kind, "paused");
});

Deno.test("pendingAttention: an unseen-settled interactive run counts; settled-but-seen and scheduled do not", () => {
  const unseen = run({ executionId: "exec_unseen", phase: "terminal", threadId: "t1", terminal: { ok: true } });
  const seen = run({ executionId: "exec_seen", phase: "terminal", threadId: "t2", terminal: { ok: true } });
  const scheduled = run({ executionId: "exec_sched", kind: "scheduled", phase: "terminal", terminal: { ok: true } });
  const out = pendingAttention([unseen, seen, scheduled], [], { unseenSettled: ["exec_unseen", "exec_sched"] });
  assertEquals(out.items.map((i) => i.executionId), ["exec_unseen"]);
  assertEquals(out.items[0].kind, "settled");
  assertEquals(out.items[0].error, false);
});

Deno.test("pendingAttention: a run whose thread is open on a connected port is excluded (paused, card and settled alike)", () => {
  const paused = run({ executionId: "exec_p", phase: "paused-permission", threadId: "open-thread" });
  const card = run({ executionId: "exec_c", phase: "running", threadId: "open-thread" });
  const settled = run({ executionId: "exec_s", phase: "terminal", threadId: "open-thread", terminal: { ok: true } });
  const other = run({ executionId: "exec_o", phase: "paused-permission", threadId: "other-thread" });
  const ports = [{ surface: { type: "thread", id: "open-thread" } }, { surface: null }];
  const out = pendingAttention([paused, card, settled, other], ports, { pendingCards: ["exec_c"], unseenSettled: ["exec_s"] });
  assertEquals(out.items.map((i) => i.executionId), ["exec_o"]);
  // The same four with NO port viewing that thread all count.
  const all = pendingAttention([paused, card, settled, other], [{ surface: null }], { pendingCards: ["exec_c"], unseenSettled: ["exec_s"] });
  assertEquals(all.count, 4);
});

Deno.test("pendingAttention: an agent run with no thread keys on the agent surface", () => {
  const agentRun = run({ executionId: "exec_a", kind: "agent", agentId: "named:researcher", phase: "paused-permission" });
  assertEquals(runSurfaceKey(agentRun), "agent:named:researcher");
  assertEquals(pendingAttention([agentRun], [{ surface: { type: "agent", id: "named:researcher" } }]).count, 0);
  assertEquals(pendingAttention([agentRun], [{ surface: { type: "agent", id: "named:other" } }]).count, 1);
});

Deno.test("pendingAttention: a live Allow card counts only while the execution is still running", () => {
  const running = run({ executionId: "exec_card", phase: "running" });
  const done = run({ executionId: "exec_card", phase: "terminal", terminal: { ok: false } });
  assertEquals(pendingAttention([running], [], { pendingCards: ["exec_card"] }).items[0]?.kind, "card");
  assertEquals(pendingAttention([done], [], { pendingCards: ["exec_card"] }).count, 0);
});

Deno.test("badgeTextFor: empty at zero, the count otherwise, bounded for the four-character badge", () => {
  assertEquals(badgeTextFor(0), "");
  assertEquals(badgeTextFor(1), "1");
  assertEquals(badgeTextFor(42), "42");
  assertEquals(badgeTextFor(120), "99+");
});

Deno.test("buildAttentionNotification: thread runs open the thread; agent runs navigate to the agent; the action validates", () => {
  const threadSpec = buildAttentionNotification(run({ executionId: "exec_t", threadId: "thread-9", phase: "terminal", terminal: { ok: true, result: "Done: 3 items" } }), "settled");
  assertEquals(threadSpec.notificationId, "cap:attention:exec_t");
  assertEquals(threadSpec.title, "Task finished");
  assertEquals(threadSpec.action, { type: "open-thread", threadId: "thread-9" });
  assertEquals(validateNotificationAction(threadSpec.action).type, NOTIFICATION_ACTION_TYPES.OPEN_THREAD);
  assertEquals(threadSpec.message, "Done: 3 items");
  const agentSpec = buildAttentionNotification(run({ executionId: "exec_a", kind: "agent", agentId: "named:researcher", phase: "paused-permission", pause: { reason: "needs api.example.com" } }), "paused");
  assertEquals(agentSpec.title, "Waiting on you");
  assertEquals(agentSpec.action.type, "navigate");
  assert(agentSpec.action.path.startsWith("ntp/ntp.html#agent=named:researcher"));
  assertEquals(validateNotificationAction(agentSpec.action).type, NOTIFICATION_ACTION_TYPES.NAVIGATE);
  // Bounded body: a runaway result never blows the notification.
  const long = buildAttentionNotification(run({ phase: "terminal", terminal: { ok: true, result: "x".repeat(5000) } }), "settled");
  assert(long.message.length <= 160);
  const failed = buildAttentionNotification(run({ phase: "terminal", terminal: { ok: false, result: "provider refused" } }), "settled");
  assertEquals(failed.title, "Task stopped");
});

// ── the tracker against a fake chrome.action ────────────────────────────────

function fakeTimers() {
  let now = 0;
  const queue = [];
  return {
    setTimeout: (fn, ms) => { const id = Symbol(); queue.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: (id) => { const i = queue.findIndex((q) => q.id === id); if (i >= 0) queue.splice(i, 1); },
    advance(ms) {
      now += ms;
      let fired = 0;
      for (const q of [...queue].sort((a, b) => a.at - b.at)) {
        if (q.at <= now) { queue.splice(queue.indexOf(q), 1); q.fn(); fired += 1; }
      }
      return fired;
    },
    pending: () => queue.length,
  };
}

function harness() {
  const timers = fakeTimers();
  const action = { calls: [], setBadgeText({ text }) { this.calls.push(text); }, colors: [] };
  const notifications = [];
  const tracker = createAttentionTracker({
    setBadge: ({ text, color }) => { action.setBadgeText({ text }); action.colors.push(color); },
    notify: (spec, reason) => notifications.push({ ...spec, reason }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { tracker, timers, action, notifications };
}

Deno.test("tracker: a registry change sequence produces the expected setBadgeText calls and clears to ''", () => {
  const { tracker, timers, action, notifications } = harness();
  tracker.seed([]);
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls, [""], "boot applies an empty badge once (clears a stale one from a previous worker life)");

  // A run starts (no badge), hits an Allow card (badge 1), the owner answers (clears).
  tracker.onRunUpdate({ type: "run-update", run: run({ executionId: "exec_1", threadId: "t1", revision: 1 }) });
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls, [""], "a running run with no card is not attention");
  tracker.cardOpened("exec_1", "rp_a");
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls, ["", "1"]);
  assertEquals(action.colors.at(-1), ATTENTION_BADGE_ACCENT);
  tracker.cardClosed("exec_1", "rp_a");
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls, ["", "1", ""]);

  // It pauses on a provider permission: badge 1 + exactly one notification.
  tracker.onRunUpdate({ run: run({ executionId: "exec_1", threadId: "t1", phase: "paused-permission", revision: 2, pause: { reason: "allow api.example.com" } }) });
  tracker.onRunUpdate({ run: run({ executionId: "exec_1", threadId: "t1", phase: "paused-permission", revision: 3, pause: { reason: "allow api.example.com" } }) });
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls, ["", "1", "", "1"]);
  assertEquals(notifications.map((n) => [n.notificationId, n.reason]), [["cap:attention:exec_1", "paused"]]);

  // Opening that thread on a connected port clears the badge; closing the port restores it.
  const port = {};
  tracker.portConnected(port);
  tracker.portViewing(port, { type: "thread", id: "t1" });
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls.at(-1), "");
  tracker.portDisconnected(port);
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls.at(-1), "1");

  // Resumed and settled OK while nobody is connected → badge stays 1 (now an
  // unseen result) and ONE finished notification; a later terminal re-write
  // (compaction) adds nothing.
  tracker.onRunUpdate({ run: run({ executionId: "exec_1", threadId: "t1", phase: "running", revision: 4 }) });
  tracker.onRunUpdate({ run: run({ executionId: "exec_1", threadId: "t1", phase: "terminal", revision: 5, terminal: { ok: true, result: "done" } }) });
  tracker.onRunUpdate({ run: run({ executionId: "exec_1", threadId: "t1", phase: "terminal", revision: 6, terminal: { ok: true, result: "done" } }) });
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(tracker.snapshot().items, [{ executionId: "exec_1", kind: "settled", surfaceKey: "thread:t1", error: false }]);
  assertEquals(notifications.map((n) => n.reason), ["paused", "settled"]);

  // The owner opens the thread → seen → the badge clears for good.
  const hub = {};
  tracker.portConnected(hub);
  tracker.portViewing(hub, { type: "thread", id: "t1" });
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls.at(-1), "");
  tracker.portDisconnected(hub);
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls.at(-1), "", "a seen result does not come back when the port closes");
});

Deno.test("tracker: a settle while a hub port is connected (but elsewhere) badges without notifying; with the thread open it is seen", () => {
  const { tracker, timers, action, notifications } = harness();
  tracker.seed([run({ executionId: "exec_a", threadId: "ta" }), run({ executionId: "exec_b", threadId: "tb" })]);
  const hub = {};
  tracker.portConnected(hub);
  tracker.portViewing(hub, { type: "thread", id: "tb" });
  tracker.onRunUpdate({ run: run({ executionId: "exec_a", threadId: "ta", phase: "terminal", revision: 2, terminal: { ok: false, result: "boom" } }) });
  tracker.onRunUpdate({ run: run({ executionId: "exec_b", threadId: "tb", phase: "terminal", revision: 2, terminal: { ok: true } }) });
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls.at(-1), "1", "only the run the owner is not looking at");
  assertEquals(action.colors.at(-1), ATTENTION_BADGE_DANGER, "red only because that run failed");
  assertEquals(notifications.length, 0, "a connected hub means no notification");
});

Deno.test("tracker: a registry storm coalesces into one badge write per window", () => {
  const { tracker, timers, action } = harness();
  tracker.seed([]);
  timers.advance(ATTENTION_COALESCE_MS);
  for (let i = 0; i < 40; i += 1) {
    tracker.onRunUpdate({ run: run({ executionId: `exec_${i}`, threadId: `t${i}`, phase: "paused-permission", revision: 1 }) });
  }
  assertEquals(timers.pending(), 1, "forty updates arm exactly one timer");
  timers.advance(ATTENTION_COALESCE_MS - 1);
  assertEquals(action.calls, [""], "nothing applies before the window closes");
  timers.advance(1);
  assertEquals(action.calls, ["", "40"]);
});

Deno.test("tracker: events before the seed are buffered and replayed after it, fenced by revision", () => {
  const { tracker, timers, action } = harness();
  tracker.onRunUpdate({ run: run({ executionId: "exec_x", threadId: "tx", phase: "paused-permission", revision: 3 }) });
  tracker.onRunUpdate({ run: run({ executionId: "exec_y", threadId: "ty", phase: "running", revision: 1 }) });
  // The seed already knows exec_x at revision 3 (paused) and exec_y running.
  tracker.seed([run({ executionId: "exec_x", threadId: "tx", phase: "paused-permission", revision: 3 }), run({ executionId: "exec_y", threadId: "ty", revision: 1 })]);
  timers.advance(ATTENTION_COALESCE_MS);
  assertEquals(action.calls, ["1"]);
  assertEquals(tracker.snapshot().items.map((i) => i.executionId), ["exec_x"]);
});

// ── the registry change hook ────────────────────────────────────────────────

class FakeStore {
  values = new Map();
  versions = new Map();
  isMaster = true;
  origin = "master";
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async has(key) { return this.values.has(key); }
  async getVersion(key) { return this.versions.get(key) ?? 0; }
  async snapshot(key) {
    return { exists: this.values.has(key), value: this.values.has(key) ? structuredClone(this.values.get(key)) : null, version: this.versions.get(key) ?? 0 };
  }
  async setTrusted(key, value) {
    const version = (this.versions.get(key) ?? 0) + 1;
    this.values.set(key, structuredClone(value));
    this.versions.set(key, version);
    return version;
  }
  async keys() { return [...this.values.keys()].sort(); }
  async compareAndDelete(key, expected) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    this.values.delete(key);
    this.versions.set(key, expected + 1);
    return true;
  }
  async compareAndRestore(key, expected, value) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    await this.setTrusted(key, value);
    return true;
  }
  async delete(key) {
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}

Deno.test("durable runs: subscribe() delivers every run-update to an in-worker listener until unsubscribed", async () => {
  const store = new FakeStore();
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: createMemoryRunLogHandles(),
    bootId: "boot-attention",
    now: (() => { let n = 1000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    commitThread: async () => {},
  });
  const seen = [];
  const off = registry.subscribe((event) => seen.push(event));
  const executionId = "exec_attention_0001";
  await registry.start({ executionId, threadId: "thread-1", kind: "task", taskPreview: "hello", journalTarget: "master" });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].type, "run-update");
  assertEquals(seen[0].run.executionId, executionId);
  assertEquals(seen[0].run.phase, "running");
  assertEquals(seen[0].run.threadId, "thread-1");
  assertEquals("journalTarget" in seen[0].run, false, "the hook carries the PUBLIC record only");
  off();
  await registry.heartbeat?.(executionId).catch(() => {});
  await registry.settle(executionId, { ok: true, result: "done", logicalId: "task-1", summary: "done" });
  assertEquals(seen.length, 1, "an unsubscribed listener hears nothing more");
});

// ── the surface report from the port client ────────────────────────────────

Deno.test("conversation.reportViewedSurface posts attention.viewing over the progress port and re-sends on reconnect", async () => {
  const posted = [];
  let disconnect = null;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: async () => ({ ok: true }),
      connect: () => ({
        onMessage: { addListener() {} },
        onDisconnect: { addListener(fn) { disconnect = fn; } },
        postMessage(msg) { posted.push(msg); },
      }),
    },
  };
  const { reportViewedSurface, subscribeProgress } = await import(`../extension/shared/conversation.js?t=${Math.random()}`);
  reportViewedSurface({ type: "thread", id: "thread-42" });
  assertEquals(posted, [{ type: "attention.viewing", surface: { type: "thread", id: "thread-42" } }]);
  reportViewedSurface(null);
  assertEquals(posted.at(-1), { type: "attention.viewing", surface: null });
  reportViewedSurface({ type: "agent", id: "named:researcher" });
  reportViewedSurface({ type: "bogus", id: "x" });
  assertEquals(posted.at(-1).surface, null, "an unknown surface type reads as nothing open");
  reportViewedSurface({ type: "agent", id: "named:researcher" });
  // The worker restarted: the port drops; the next subscriber re-creates it
  // and the remembered surface is re-reported without the page doing anything.
  posted.length = 0;
  disconnect();
  subscribeProgress(() => {});
  assertEquals(posted, [{ type: "attention.viewing", surface: { type: "agent", id: "named:researcher" } }]);
  delete globalThis.chrome;
});
