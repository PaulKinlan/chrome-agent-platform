// Normalize non-conforming OpenAI-compatible responses that emit tool calls but
// label the step's finish reason as "stop". The AI loop uses "tool-calls" to
// continue into tool execution; without this correction the conversation stays
// on "thinking…", no live tool event fires, and no tool row reaches history.

function hasToolCall(content) {
  return Array.isArray(content) && content.some((part) => part?.type === "tool-call");
}

export function normalizeToolCallFinish(result) {
  if (!result || result.finishReason !== "stop" || !hasToolCall(result.content)) return result;
  return { ...result, finishReason: "tool-calls" };
}

export function toolCallFinishMiddleware() {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => normalizeToolCallFinish(await doGenerate()),
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let sawToolCall = false;
      const stream = result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part?.type === "tool-call") sawToolCall = true;
          if (part?.type === "finish") {
            const normalized = sawToolCall && part.finishReason === "stop"
              ? { ...part, finishReason: "tool-calls" }
              : part;
            controller.enqueue(normalized);
            sawToolCall = false;
            return;
          }
          controller.enqueue(part);
        },
      }));
      return { ...result, stream };
    },
  };
}
