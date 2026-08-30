// @ts-nocheck
// CAP-FB-20260830-MODEL-CATALOG-CURRENT-01 — OpenAI's /chat/completions refuses
// function tools on gpt-5.x unless reasoning_effort is "none" (every gpt-5.6
// hub call was HTTP 400 on 2026-08-30). The adapter must send it for OpenAI
// gpt-5.x and must NOT send it to endpoints that do not know the field.
import { assert, assertEquals } from "jsr:@std/assert@1";

async function captureBody(config) {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const { createOpenAICompatibleModel } = await import("../extension/lib/models/openai-model.js");
    const model = createOpenAICompatibleModel(config);
    const { streamText } = await import("ai");
    const res = streamText({ model, prompt: "hello" });
    try { for await (const _ of res.textStream) { /* drain */ } } catch { /* request body is what matters */ }
    try { await res.usage; } catch { /* ignore */ }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(bodies.length > 0, "the model must make a provider request");
  return JSON.parse(bodies[0]);
}

Deno.test("gpt-5.x requests to api.openai.com carry reasoning_effort none; non-OpenAI base URLs do not", async () => {
  const luna = await captureBody({ baseURL: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-5.6-luna" });
  assertEquals(luna.reasoning_effort, "none");
  assertEquals(luna.model, "gpt-5.6-luna");
  const mini = await captureBody({ baseURL: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-5.4-mini" });
  assertEquals(mini.reasoning_effort, "none");
  // Grok / Z.ai / Ollama do not know the field — it must be absent.
  const grok = await captureBody({ baseURL: "https://api.x.ai/v1", apiKey: "xk", model: "grok-4.6" });
  assertEquals("reasoning_effort" in grok, false);
  const ollama = await captureBody({ baseURL: "http://localhost:11434/v1", apiKey: "", model: "gpt-5.6-luna" });
  assertEquals("reasoning_effort" in ollama, false);
});
