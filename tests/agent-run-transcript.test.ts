// tests/agent-run-transcript.test.ts — the agent-view run transcript
// (CAP-FB-20260823-AGENT-RUN-VISIBILITY-01): a READ-ONLY projection of one
// run's retained rows + the live progress into a chat-like container, plus the
// latest-run surface scope. No provider/model/permission mutation.
// @ts-nocheck — the chrome mock + the fake container are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert";
import { latestRunForSurface } from "../extension/lib/run-scope.js";

// The renderRunTranscript projection uses the SHARED module-level progress
// port — load a cache-busted instance per test so a prior test's settled port
// can never leak into the next one (the fresh-module isolation pattern).
const freshConv = () => import(`../extension/shared/conversation.js?t=${Math.random()}`);

function installChromeMock() {
  let portListener = null;
  let disconnectListener = null;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: async (msg) => {
        if (msg?.type === "run.logs") return { ok: true, executionId: msg.executionId, logs: [] };
        return { ok: true };
      },
      connect: () => ({
        onMessage: { addListener(fn) { portListener = fn; } },
        onDisconnect: { addListener(fn) { disconnectListener = fn; } },
        postMessage() {},
      }),
    },
  };
  return {
    emit: (event) => { if (portListener) portListener({ type: "progress", event }); },
    disconnect() { if (disconnectListener) disconnectListener(); },
  };
}

function fakeContainer() {
  const calls = [];
  const c = {
    calls,
    appendUser(text, ts) { calls.push({ kind: "user", text, ts }); },
    appendAgent(text, ts) { calls.push({ kind: "agent", text, ts }); },
    appendSystem(text) { calls.push({ kind: "system", text }); },
    appendError(text) { calls.push({ kind: "error", text }); },
    appendTool(card) {
      const entry = { kind: "tool", ...card };
      entry.attrs = {};
      entry.setAttribute = (name, value) => { entry.attrs[name] = value; };
      calls.push(entry);
      return entry;
    },
    clear() { calls.push({ kind: "clear" }); },
    setAttribute() {},
  };
  return c;
}

Deno.test("renderRunTranscript streams ONLY the matching execution's live events + settles", async () => {
  const { renderRunTranscript } = await freshConv();
  const chromeMock = installChromeMock();
  const c = fakeContainer();
  let status = null;
  const unsub = renderRunTranscript(c, "exec-1", { onStatus: (s) => { status = s; } });

  // a DIFFERENT run's event is ignored
  chromeMock.emit({ type: "tool-call", runId: "exec-2", toolName: "other", toolArgs: null });
  assertEquals(c.calls.length, 0, "foreign-run event is never rendered");

  // this run's tool-call → running card
  chromeMock.emit({ type: "tool-call", runId: "exec-1", toolName: "fetch", toolArgs: { url: "https://x" } });
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].kind, "tool");
  assertEquals(c.calls[0].status, "running");
  assertEquals(status.state, "running");

  // tool-result → resolved card
  chromeMock.emit({ type: "tool-result", runId: "exec-1", toolName: "fetch", result: "ok", ok: true });
  assertEquals(c.calls.length, 1, "the result resolves the card, no new card");
  assertEquals(c.calls[0].attrs["tool-status"], "success");

  // done → terminal settles + unsubscribes (a later event is a no-op)
  chromeMock.emit({ type: "done", runId: "exec-1", aborted: false });
  chromeMock.emit({ type: "tool-call", runId: "exec-1", toolName: "late", toolArgs: null });
  assertEquals(c.calls.length, 1, "no events after the terminal settle");
  unsub();
});

Deno.test("renderRunTranscript appends the live conclusion on a non-aborted done (never on abort)", async () => {
  const { renderRunTranscript } = await freshConv();
  const chromeMock = installChromeMock();
  const c = fakeContainer();
  const unsub = renderRunTranscript(c, "exec-1", {});
  chromeMock.emit({ type: "done", runId: "exec-1", aborted: false, text: "the final answer" });
  assertEquals(c.calls.some((x) => x.kind === "agent" && x.text === "the final answer"), true, "the conclusion bubble is appended");
  const c2 = fakeContainer();
  const unsub2 = renderRunTranscript(c2, "exec-2", {});
  chromeMock.emit({ type: "done", runId: "exec-2", aborted: true, text: "should not show" });
  assertEquals(c2.calls.some((x) => x.kind === "agent" && x.text === "should not show"), false, "an aborted run appends no conclusion");
  unsub(); unsub2();
});

Deno.test("latestRunForSurface returns the most-recent retained run for the agent", () => {
  const runs = [
    { executionId: "e1", agentId: "named:a1", phase: "terminal", revision: 1, updatedAt: 100 },
    { executionId: "e2", agentId: "named:a1", phase: "running", revision: 2, updatedAt: 200 },
    { executionId: "e3", agentId: "named:a2", phase: "running", revision: 3, updatedAt: 300 },
  ];
  assertEquals(latestRunForSurface(runs, { agentId: "a1", agentKind: "named" })?.executionId, "e2", "the most-recently-updated run for the agent");
  assertEquals(latestRunForSurface(runs, { agentId: "a1", agentKind: "background" })?.executionId, undefined, "background:a1 is a distinct identity");
  assertEquals(latestRunForSurface(runs, { agentId: "a3", agentKind: "named" }), null, "no run → null");
  assertEquals(latestRunForSurface(runs, {}), null, "no surface identity → null");
});

Deno.test("latestRunForSurface orders by updatedAt, NOT the per-run revision counter", () => {
  // An older, heartbeat-heavy run (high revision) must NOT beat a newer run
  // with a lower revision — the CAS counter only orders ONE run's own writes.
  const runs = [
    { executionId: "old", agentId: "named:a1", phase: "terminal", revision: 500, updatedAt: 1000 },
    { executionId: "new", agentId: "named:a1", phase: "running", revision: 3, updatedAt: 2000 },
  ];
  assertEquals(latestRunForSurface(runs, { agentId: "a1", agentKind: "named" })?.executionId, "new", "the newer run wins despite the lower revision");
});
