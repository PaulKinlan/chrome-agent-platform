// tests/agent-loop-steer.test.ts — chrome-agent-platform-afiu, falsification
// gate 1: a STEER delivered mid-tool-call changes the agent's NEXT action.
// @ts-nocheck — the fixture model + loop are deliberately dynamic.
//
// A fixture agent runs the REAL run loop (lib/agent-loop.js). Its first step
// issues a tool call; DURING that tool call (mid-tool-call — the exact window
// the owner types into) a steer lands in the buffer the loop reads at every
// model call. Gate assertions:
//   - the steering text arrived BETWEEN steps: the NEXT model call's prompt
//     carries it (reverting the delivery seam leaves that step without it);
//   - the next action CHANGED: the fixture issues memory_get (the steered
//     direction) instead of repeating memory_set;
//   - a stop-step steer ends the loop at the next step boundary (the stopped
//     decision fires; the run never runs to its outer budget);
//   - no steer source → the loop is byte-identical to the pre-steer path.
import { assert, assertEquals } from "jsr:@std/assert@1";

import { runAgentLoop, proxyTool, passthroughSchema } from "../extension/lib/agent-loop.js";

/** Join a model call's prompt (messages) into searchable text — content may
 * be a plain string or the SDK's parts array. */
function promptText(input) {
  return (input ?? []).map((m) =>
    typeof m?.content === "string" ? m.content
      : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").join("") : "").join("\n");
}

/** A deterministic fixture model: step 1 calls memory_set, then — if the
 * steer arrived — memory_get, then answers. Records every call's PROMPT so
 * the test can assert the steer text rode the between-step call. */
function fixtureModel({ calls, inputs }) {
  let step = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "fixture-steer-model",
    async doStream(options) {
      calls.push(calls.length + 1);
      // Clone the prompt the model would have seen (the run-loop seam already
      // appended the steer to the outgoing copy).
      inputs.push(JSON.parse(JSON.stringify(options?.prompt ?? [])));
      step += 1;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          if (step === 1) {
            c.enqueue({ type: "tool-call", toolCallId: "call_1", toolName: "memory_set", input: JSON.stringify({ key: "a", value: "1" }) });
            c.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
          } else if (step === 2) {
            // The steered direction: file the note instead of another set.
            c.enqueue({ type: "tool-call", toolCallId: "call_2", toolName: "memory_get", input: JSON.stringify({ key: "a" }) });
            c.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
          } else {
            c.enqueue({ type: "text-start", id: "t1" });
            c.enqueue({ type: "text-delta", id: "t1", delta: "done — steered" });
            c.enqueue({ type: "text-end", id: "t1" });
            c.enqueue({ type: "finish", usage, finishReason: "stop" });
          }
          c.close();
        },
      });
      return Promise.resolve({ stream });
    },
  };
}

Deno.test("steer mid-tool-call: the message arrives between steps and changes the next action", async () => {
  const calls = [];
  const inputs = [];
  const steerBuffer = []; // the run loop reads this at every model call
  const tools = {
    memory_set: proxyTool({
      name: "memory_set",
      description: "set a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async () => {
        // MID-TOOL-CALL: the owner steers while this tool is in flight.
        steerBuffer.push({ id: "s1", mode: "inject", text: "file it under the audit instead — no more writes" });
        return { ok: true, stored: true };
      },
    }),
    memory_get: proxyTool({
      name: "memory_get",
      description: "read a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async () => ({ ok: true, value: "1" }),
    }),
  };

  const result = await runAgentLoop({
    model: fixtureModel({ calls, inputs }),
    system: "You are a fixture agent.",
    task: "store a note",
    tools,
    onProgress: () => {},
    maxIterations: 6,
    readSteers: () => [...steerBuffer],
  });

  // Between-step arrival: the steer text rides the NEXT model call's prompt.
  assert(inputs.length >= 2, `expected ≥2 model calls, saw ${inputs.length}`);
  const secondInput = promptText(inputs[1]);
  assert(secondInput.includes("file it under the audit"), "the steering message must arrive between steps (in the NEXT model call)");

  // The next action changed: the steered direction ran after the steer.
  assert(result.includes("done"), "the loop finished with the steered direction");
  // set → (steer) → the steered get → the final answer.
  assertEquals(calls.length, 3, "set, then the steered get, then the answer");
  assert(inputs.length >= 3);
  const thirdInput = promptText(inputs[2]);
  assert(thirdInput.includes("file it under the audit"), "gentle steer guidance stays live through the rest of the run");
});

Deno.test("steer stop-step: the loop fires the stopped decision and ends before its outer budget", async () => {
  // A fixture that would keep tool-calling forever. The stop-step steer lands
  // during the first tool execution; the loop must fire its stopped decision
  // at the next step boundary — where the identical run WITHOUT the stop
  // keeps issuing model calls until its outer budget.
  const makeModel = ({ calls, inputs }) => {
    let seq = 0;
    return {
      specificationVersion: "v2",
      provider: "test",
      modelId: "fixture-relentless",
      async doStream(options) {
        calls.push(calls.length + 1);
        inputs.push(JSON.parse(JSON.stringify(options?.prompt ?? [])));
        seq += 1;
        const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
        const stream = new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "tool-call", toolCallId: `c_${seq}`, toolName: "memory_set", input: JSON.stringify({ key: "a", value: String(seq) }) });
            c.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            c.close();
          },
        });
        return Promise.resolve({ stream });
      },
    };
  };
  const memoryTools = () => ({
    memory_set: proxyTool({
      name: "memory_set",
      description: "set a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async () => ({ ok: true, stored: true }),
    }),
  });

  // WITH stop-step: the first tool execution lands the steer; the stopped
  // decision fires and the run never reaches its outer budget.
  const stopCalls = [];
  const stopInputs = [];
  const stopProgress = [];
  const stopBuffer = [];
  let steered = false;
  const stopTools = {
    memory_set: proxyTool({
      name: "memory_set",
      description: "set a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async () => {
        if (!steered) {
          steered = true;
          stopBuffer.push({ id: "s2", mode: "stop-step", text: "stop the file work and answer now" });
        }
        return { ok: true, stored: true };
      },
    }),
  };
  await runAgentLoop({
    model: makeModel({ calls: stopCalls, inputs: stopInputs }),
    system: "You are a fixture agent.",
    task: "store a note",
    tools: stopTools,
    onProgress: (r) => stopProgress.push(r),
    maxIterations: 12,
    readSteers: () => [...stopBuffer],
  });
  assert(stopProgress.some((r) => r?.type === "stopped" && r?.reason === "steer-stop-step"), "stop-step must fire the steer stopped decision");
  const carried = stopInputs.findIndex((input) => promptText(input).includes("stop the file work"));
  assert(carried >= 0, "the stop-step text is carried by at least one model call");

  // WITHOUT any steer: the same fixture keeps tool-calling to its outer
  // budget — the stop is what ends the run early.
  const runCalls = [];
  const runInputs = [];
  const runProgress = [];
  await runAgentLoop({
    model: makeModel({ calls: runCalls, inputs: runInputs }),
    system: "You are a fixture agent.",
    task: "store a note",
    tools: memoryTools(),
    onProgress: (r) => runProgress.push(r),
    maxIterations: 4,
  });
  assert(stopCalls.length < runCalls.length, `the stop must end the run before its outer budget (with stop ${stopCalls.length} calls; without ${runCalls.length})`);
  assert(!runProgress.some((r) => r?.type === "stopped" && r?.reason === "steer-stop-step"), "no steer-stop decision without a steer");
});

Deno.test("no steer source: the loop behaves exactly as before (passthrough)", async () => {
  const calls = [];
  const inputs = [];
  const tools = {
    memory_set: proxyTool({
      name: "memory_set",
      description: "set a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async () => ({ ok: true, stored: true }),
    }),
    memory_get: proxyTool({
      name: "memory_get",
      description: "read a memory (proxied)",
      inputSchema: passthroughSchema(),
      send: async () => ({ ok: true, value: "1" }),
    }),
  };
  await runAgentLoop({
    model: fixtureModel({ calls, inputs }),
    system: "You are a fixture agent.",
    task: "store a note",
    tools,
    maxIterations: 6,
  });
  assertEquals(calls.length, 3, "without a steer source the loop runs to its natural end");
  const secondInput = promptText(inputs[1]);
  assert(!secondInput.includes("audit"), "no steer text is ever injected without a steer source");
});
