// tests/acp-stop.test.ts — chrome-agent-platform-c6gq:
// Verify ACP in-flight turn cancellation from the UI (Stop affordance).
//
// Asserts:
//   1. An in-flight ACP turn registers an executionId and emits running status.
//   2. cancelAcpTurn() sends session/cancel to the harness, stops the turn,
//      and settles status to 'cancelled' with stopReason 'cancelled'.
//   3. Cancelling something already finished or never started returns an honest
//      error ('no_active_turn') without corrupting state or leaving spinners.
//   4. A second cancel on an already-cancelling turn returns 'run_already_terminal'.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { runAcpTaskTurn, cancelAcpTurn, acpSessionKey } from "../extension/lib/acp-runner.js";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

class MockContainer {
  thoughts: any[] = [];
  tools: any[] = [];
  agentMessages: string[] = [];
  errors: any[] = [];
  systemMessages: string[] = [];

  thinkingDelta(d: any) { this.thoughts.push(d); }
  appendTool(t: any) { this.tools.push(t); return { setAttribute() {} }; }
  appendAgent(t: string) { this.agentMessages.push(t); return { setAttribute() {} }; }
  appendError(e: string, meta: any) { this.errors.push({ e, meta }); }
  appendSystem(s: string) { this.systemMessages.push(s); }
}

Deno.test("c6gq: an in-flight ACP turn exposes Stop and settles to cancelled on cancelAcpTurn()", async () => {
  // Hold prompt containing "hold-this-turn" until session/cancel arrives
  const HOLD_TEXT = "hold-this-turn";
  const bridge = createAcpServer(0, FAKE_ADAPTER, {
    CAP_ACP_FIXTURE_HOLD_TEXT: HOLD_TEXT,
    CAP_ACP_FIXTURE_DIE_ON_SPAWN: "0",
  });
  const endpoint = `ws://127.0.0.1:${(bridge as any).addr.port}/acp`;

  const container = new MockContainer();
  const statuses: any[] = [];
  let registeredExecutionId: string | null = null;
  const threadId = "thread_stop_1";
  const harnessId = "pi";

  try {
    // Start turn asynchronously so it holds in-flight
    const turnPromise = runAcpTaskTurn({
      container,
      task: `Please ${HOLD_TEXT} for testing`,
      threadId,
      harnessId,
      endpoint,
      onRunRegistered: (id: string) => { registeredExecutionId = id; },
      onStatus: (s: any) => { statuses.push(s); },
    });

    // Wait until turn is running and held
    for (let i = 0; i < 40; i++) {
      if (statuses.some((s) => s.state === "running")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(statuses.some((s) => s.state === "running"), "turn must transition to running");
    assert(registeredExecutionId !== null, "onRunRegistered must be called with executionId");
    assert(String(registeredExecutionId).startsWith("acp:"), "executionId must carry acp: prefix");

    // Give adapter time to enter held state
    await new Promise((r) => setTimeout(r, 200));

    // Cancel the in-flight turn via cancelAcpTurn
    const cancelRes = await cancelAcpTurn({ threadId, harnessId });
    assertEquals(cancelRes.ok, true, `cancelAcpTurn must succeed: ${JSON.stringify(cancelRes)}`);
    assertEquals(cancelRes.cancelledOnWire, true, "cancel must be dispatched over wire");

    // Await turn completion
    const result = await turnPromise;

    // Assert turn settled to cancelled
    assertEquals(result.ok, false, "cancelled turn must report ok: false");
    assertEquals(result.error, "Task was cancelled");
    assertEquals(result.stopReason, "cancelled");

    // Assert status settled to cancelled
    const finalStatus = statuses.at(-1);
    assertEquals(finalStatus?.state, "cancelled", "final status must be cancelled");
    assertEquals(finalStatus?.executionId, registeredExecutionId, "status must bind executionId");
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("c6gq: cancelling something already finished or never started returns honest error and preserves state", async () => {
  // 1. Never started
  const neverStarted = await cancelAcpTurn({ threadId: "nonexistent", harnessId: "pi" });
  assertEquals(neverStarted.ok, false);
  assertEquals(neverStarted.error, "no_active_turn");

  // 2. Normal turn finishes first, then cancel attempted
  const bridge = createAcpServer(0, FAKE_ADAPTER, {
    CAP_ACP_FIXTURE_HOLD_TEXT: "",
    CAP_ACP_FIXTURE_DIE_ON_SPAWN: "0",
  });
  const endpoint = `ws://127.0.0.1:${(bridge as any).addr.port}/acp`;
  const container = new MockContainer();
  const threadId = "thread_finish_first";
  const harnessId = "pi";

  try {
    const res = await runAcpTaskTurn({
      container,
      task: "quick prompt",
      threadId,
      harnessId,
      endpoint,
    });
    assertEquals(res.ok, true);

    // Now try to cancel the finished turn
    const cancelFinished = await cancelAcpTurn({ threadId, harnessId });
    assertEquals(cancelFinished.ok, false);
    assertEquals(cancelFinished.error, "no_active_turn");
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("c6gq: calling cancelAcpTurn twice on in-flight turn reports run_already_terminal on second call", async () => {
  const HOLD_TEXT = "hold-second-turn";
  const bridge = createAcpServer(0, FAKE_ADAPTER, {
    CAP_ACP_FIXTURE_HOLD_TEXT: HOLD_TEXT,
    CAP_ACP_FIXTURE_DIE_ON_SPAWN: "0",
  });
  const endpoint = `ws://127.0.0.1:${(bridge as any).addr.port}/acp`;

  const container = new MockContainer();
  const threadId = "thread_double_cancel";
  const harnessId = "pi";

  try {
    const turnPromise = runAcpTaskTurn({
      container,
      task: `Please ${HOLD_TEXT} for double cancel test`,
      threadId,
      harnessId,
      endpoint,
    });

    // Wait until turn starts
    await new Promise((r) => setTimeout(r, 300));

    // First cancel: ok
    const firstCancel = await cancelAcpTurn({ threadId, harnessId });
    assertEquals(firstCancel.ok, true);

    // Second cancel: rejected honestly as already terminal/cancelling or settled
    const secondCancel = await cancelAcpTurn({ threadId, harnessId });
    assertEquals(secondCancel.ok, false);
    assert(
      ["run_already_terminal", "no_active_turn"].includes(secondCancel.error ?? ""),
      `second cancel must report terminal/finished error, got: ${secondCancel.error}`,
    );

    await turnPromise;
  } finally {
    await bridge.shutdown();
  }
});
