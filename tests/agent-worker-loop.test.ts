// tests/agent-worker-loop.test.ts — CAP-FB-20260826-AGENT-WORKERS-01 (Phase 2).
// @ts-nocheck — the agent core + worker shell are deliberately dynamic.
//
// Pins the Phase-2 run-loop seam + the SW tool-bridge authority:
//   (a) lib/agent-loop.js runs the agent-do loop with INJECTED tools (the RPC
//       proxy seam) — a deterministic stub model issues a real tool call that
//       the proxy routes, and REDACTED progress (names/durations/ok only) streams;
//   (b) abort reaches the loop between steps.
// (The SW route authority is pinned in tests/agent-worker-host.test.ts.)
import { assert, assertEquals } from "jsr:@std/assert@1";

import { runAgentLoop, proxyTool, passthroughSchema } from "../extension/lib/agent-loop.js";

/** A minimal LanguageModelV2 stub that deterministically issues ONE tool call
 * (memory_set) on its first step, then finishes with text — exercising the
 * injected-tool seam without depending on the demo model's task-formatting. */
function toolCallingModel({ onAbort = null } = {}) {
  let steps = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-tool-caller",
    async doStream(options) {
      if (options?.abortSignal?.aborted) throw new Error("aborted");
      if (onAbort) await onAbort(options);
      steps += 1;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          if (steps === 1) {
            c.enqueue({ type: "tool-call", toolCallId: "call_1", toolName: "memory_set", input: JSON.stringify({ key: "sentinel", value: "x" }) });
            c.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
          } else {
            c.enqueue({ type: "text-start", id: "t1" });
            c.enqueue({ type: "text-delta", id: "t1", delta: "done" });
            c.enqueue({ type: "text-end", id: "t1" });
            c.enqueue({ type: "finish", usage, finishReason: "stop" });
          }
          c.close();
        },
      });
      // The v2 doStream contract returns { stream, ... } (not a bare stream).
      return Promise.resolve({ stream });
    },
  };
}

Deno.test("P2 runAgentLoop: agent-do issues a tool call through the injected proxy seam", async () => {
  const calls = [];
  const progress = [];
  const tools = {
    memory_set: proxyTool({
      name: "memory_set",
      description: "set a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async (toolName, args) => {
        calls.push({ toolName, args });
        return { ok: true, stored: true };
      },
    }),
  };

  const result = await runAgentLoop({
    model: toolCallingModel(),
    system: "You are a test agent.",
    task: "store a note",
    tools,
    onProgress: (r) => progress.push(r),
    maxIterations: 4,
  });

  assertEquals(typeof result, "string", "loop returns final text");
  assertEquals(calls.length, 1, "the model must issue exactly one tool call via the proxy");
  assertEquals(calls[0].toolName, "memory_set");

  const kinds = progress.map((p) => p.type);
  assert(kinds.includes("tool-call"), "tool-call progress fired");
  assert(kinds.includes("tool-result"), "tool-result progress fired");
  assert(kinds.includes("done"), "done progress fired");

  // REDACTION: tool-call progress carries the tool NAME only — never the args.
  const toolCall = progress.find((p) => p.type === "tool-call");
  assert(!("toolArgs" in (toolCall ?? {})), "tool-call progress must not leak args");
  assert(!JSON.stringify(toolCall).includes("sentinel"), "the tool-call ARGS (sentinel) must never leak into progress");
});

Deno.test("P2 runAgentLoop: a model-level abort rejection propagates to the caller", async () => {
  // The worker's abort path (agent-worker:abort → controller.abort) surfaces
  // as the model's stream rejecting; the seam must propagate that rejection
  // to the caller (never swallow it into a false success). Full signal
  // threading through agent-do is the REAL agent.js path, already pinned in
  // tests/agent-abort.test.ts.
  const abortedModel = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-aborting",
    async doStream() { throw new Error("aborted"); },
  };
  let threw = null;
  try {
    await runAgentLoop({ model: abortedModel, system: "x", task: "y", tools: {}, maxIterations: 2 });
  } catch (e) {
    threw = e;
  }
  assert(threw, "a model-level abort must reject the loop (never a false success)");
});
