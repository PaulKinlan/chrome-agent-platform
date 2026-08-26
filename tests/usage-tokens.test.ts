// @ts-nocheck
// Usage-tokens root-cause KAT (owner P0, CAP-FB-20260826-USAGE-TOKENS-01):
// the OpenAI-compatible adapter must request `stream_options: {include_usage:true}`
// so the provider streams token usage; without it agent-do's onStepEnd sees
// step.usage === undefined → records 0 → recordUsage drops the row → zero usage.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("usage-tokens: createOpenAICompatibleModel requests stream usage (stream_options.include_usage)", async () => {
  // Stub fetch to capture the outgoing request body, and return a minimal
  // streaming SSE response with a usage chunk so the model can be exercised.
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const { createOpenAICompatibleModel } = await import("../extension/lib/models/openai-model.js");
    const model = createOpenAICompatibleModel({ baseURL: "https://provider.example/v1", apiKey: "sk-test", model: "test-model" });
    // Drive one STREAMING generation (the path agent-do uses) — we only need the
    // REQUEST body; consume the stream best-effort.
    const { streamText } = await import("ai");
    const res = streamText({ model, prompt: "hello" });
    try { for await (const _ of res.textStream) { /* drain */ } } catch { /* stream shape is irrelevant to the request assertion */ }
    try { await res.usage; } catch { /* ignore */ }
    assert(bodies.length > 0, "the model must make at least one provider request");
    const parsed = bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } }).filter(Boolean);
    const withStreamUsage = parsed.some((b) => b?.stream_options?.include_usage === true);
    assert(withStreamUsage, `the request must set stream_options.include_usage=true; got bodies: ${JSON.stringify(parsed).slice(0, 400)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
