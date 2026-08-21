import { assertEquals, assertStrictEquals } from "jsr:@std/assert";
import { normalizeToolCallFinish, toolCallFinishMiddleware } from "../extension/lib/models/tool-call-finish-middleware.js";

Deno.test("tool-call finish middleware corrects a non-conforming generated stop", () => {
  const input = {
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "capture_screenshot", input: "{}" }],
    finishReason: "stop",
  };
  assertEquals(normalizeToolCallFinish(input).finishReason, "tool-calls");
});

Deno.test("tool-call finish middleware leaves ordinary text stops unchanged", () => {
  const input = { content: [{ type: "text", text: "done" }], finishReason: "stop" };
  assertStrictEquals(normalizeToolCallFinish(input), input);
});

Deno.test("tool-call finish middleware remembers tool chunks until the streamed finish", async () => {
  const chunks = [
    { type: "tool-call", toolCallId: "call_1", toolName: "capture_screenshot", input: "{}" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  const middleware = toolCallFinishMiddleware();
  const wrapped = await middleware.wrapStream({
    doStream: async () => ({ stream: ReadableStream.from(chunks) }),
  });
  const output = await Array.fromAsync(wrapped.stream) as Array<Record<string, unknown>>;
  assertEquals(output[0], chunks[0]);
  assertEquals(output[1].finishReason, "tool-calls");
});

Deno.test("streamed text-only stops remain stops", async () => {
  const middleware = toolCallFinishMiddleware();
  const wrapped = await middleware.wrapStream({
    doStream: async () => ({ stream: ReadableStream.from([
      { type: "text-delta", id: "text", delta: "done" },
      { type: "finish", finishReason: "stop" },
    ]) }),
  });
  const output = await Array.fromAsync(wrapped.stream) as Array<Record<string, unknown>>;
  assertEquals(output.at(-1)?.finishReason, "stop");
});
