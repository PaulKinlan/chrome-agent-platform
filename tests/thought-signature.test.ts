// Unit tests for the Gemini thought-signature middleware — the tool-call
// round-trip fix ("Function call is missing a thought_signature").

import { assertEquals } from "jsr:@std/assert@1";

import { thoughtSignatureMiddleware } from "../extension/lib/models/thought-signature-middleware.js";

const THOUGHT = "TST-thought-sig-123";

async function transform(part: unknown): Promise<any> {
  const mw = thoughtSignatureMiddleware() as unknown as {
    transformParams: (o: { params: unknown; type: string; model: unknown }) => Promise<any>;
  };
  const out = await mw.transformParams({
    params: { prompt: [{ role: "assistant", content: [part] }] },
    type: "stream",
    model: {},
  });
  return out.prompt[0].content[0];
}

Deno.test("moves providerMetadata.<key>.thoughtSignature → providerOptions.google", async () => {
  const out = await transform({
    type: "tool-call", toolCallId: "c1", toolName: "list_tabs", input: {},
    providerMetadata: { configured: { thoughtSignature: THOUGHT } },
  });
  assertEquals(out.providerOptions?.google?.thoughtSignature, THOUGHT);
});

Deno.test("moves providerOptions.<wrong-key>.thoughtSignature → providerOptions.google", async () => {
  const out = await transform({
    type: "tool-call", toolCallId: "c2", toolName: "list_tabs", input: {},
    providerOptions: { configured: { thoughtSignature: THOUGHT } },
  });
  assertEquals(out.providerOptions?.google?.thoughtSignature, THOUGHT);
});

Deno.test("leaves an already-correct providerOptions.google signature unchanged", async () => {
  const out = await transform({
    type: "tool-call", toolCallId: "c3", toolName: "list_tabs", input: {},
    providerOptions: { google: { thoughtSignature: THOUGHT } },
  });
  assertEquals(out.providerOptions?.google?.thoughtSignature, THOUGHT);
});

Deno.test("leaves a tool call with no signature unchanged", async () => {
  const part = { type: "tool-call", toolCallId: "c4", toolName: "list_tabs", input: {} };
  const out = await transform(part);
  assertEquals(out.providerOptions, undefined);
});

Deno.test("leaves non-tool-call parts unchanged", async () => {
  const part = { type: "text", text: "hi" };
  const out = await transform(part);
  assertEquals(out, part);
});

Deno.test("does not mutate the input params when nothing changes", async () => {
  const mw = thoughtSignatureMiddleware() as unknown as {
    transformParams: (o: { params: unknown; type: string; model: unknown }) => Promise<{ prompt: unknown }>;
  };
  const params = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const out = await mw.transformParams({ params, type: "stream", model: {} });
  // When nothing changes the middleware returns the input params unchanged (no
  // mutation, no copy) — the prompt content is preserved exactly.
  assertEquals(out, params);
  assertEquals(out.prompt, params.prompt);
});
