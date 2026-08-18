// Unit tests for the Chrome Prompt API (Gemini nano) adapter — the session
// create contract (topK + temperature must be passed together, or neither)
// and the clear-error handling for a not-ready model.
//
// These mock globalThis.LanguageModel so they run without Chrome + without a
// downloaded model, and prove the adapter never fakes success.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  createPromptApiModel,
  isPromptApiAvailable,
} from "../extension/lib/models/prompt-api-model.js";

type SessionOptions = { topK?: number; temperature?: number; systemPrompt?: string };
type FakeSession = {
  prompt: (t: string) => Promise<string>;
  promptStreaming?: (t: string) => ReadableStream<string>;
  destroy?: () => void;
};

type FakeApi = {
  (): void;
  create: (opts: SessionOptions) => Promise<FakeSession>;
  capabilities: () => Promise<{ available: string }>;
};

function installPromptApi(
  create?: (opts: SessionOptions) => Promise<FakeSession>,
): FakeApi {
  // The adapter reads `globalThis.LanguageModel` as a FUNCTION with .create + .capabilities.
  const api = function LanguageModel() {} as FakeApi;
  api.create = create ?? (async () => ({ prompt: async () => "ok" }));
  api.capabilities = async () => ({ available: "readily" });
  (globalThis as unknown as Record<string, unknown>).LanguageModel = api;
  return api;
}

Deno.test("createPromptApiModel passes topK and temperature together", async () => {
  let captured: SessionOptions = {};
  installPromptApi(async (opts) => {
    captured = opts;
    return { prompt: async () => "ok" };
  });
  const model = createPromptApiModel();
  await model.doGenerate({ prompt: [{ role: "user", content: "hi" }] });
  // The Prompt API rejects a session that specifies one of topK/temperature
  // without the other. The adapter must pass BOTH (never just temperature).
  assertEquals(typeof captured.topK, "number");
  assertEquals(typeof captured.temperature, "number");
});

Deno.test("createPromptApiModel surfaces a clear error when the model is not ready", async () => {
  installPromptApi(async () => {
    throw new Error("Model is not available, download required");
  });
  const model = createPromptApiModel();
  await assertRejects(
    () => model.doGenerate({ prompt: [{ role: "user", content: "hi" }] }),
    Error,
    "not ready",
  );
});

Deno.test("isPromptApiAvailable reports true for a readily-available model", async () => {
  installPromptApi();
  assert(await isPromptApiAvailable());
});

Deno.test("isPromptApiAvailable reports false when the API is absent", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.LanguageModel;
  delete g.LanguageModel;
  try {
    assert(!(await isPromptApiAvailable()));
  } finally {
    g.LanguageModel = saved;
  }
});

Deno.test("the session binds the EXACT AI-SDK system message — a fresh session per call (the attestation boundary)", async () => {
  // The review's provider-bound capture blocker: what the run-bound
  // attestation captures at the AI-SDK boundary must be byte-for-byte what
  // the provider session receives. The session's systemPrompt IS the AI-SDK
  // system message, and a changed composition gets a FRESH session (a
  // session's systemPrompt is immutable — reuse would silently bind the
  // wrong system prompt).
  const seen: SessionOptions[] = [];
  installPromptApi(async (opts) => {
    seen.push(opts);
    return { prompt: async () => "ok" };
  });
  const model = createPromptApiModel();
  await model.doGenerate({
    prompt: [
      { role: "system", content: "SYSTEM-COMPOSITION-EXACT" },
      { role: "user", content: "hello" },
    ],
  });
  await model.doGenerate({
    prompt: [
      { role: "system", content: "SYSTEM-COMPOSITION-CHANGED" },
      { role: "user", content: "hi" },
    ],
  });
  assertEquals(seen.length, 2, "a fresh session per call — never a stale cached system prompt");
  assertEquals(seen[0].systemPrompt, "SYSTEM-COMPOSITION-EXACT");
  assertEquals(seen[1].systemPrompt, "SYSTEM-COMPOSITION-CHANGED");
  // topK + temperature still ride together on every session.
  assertEquals(typeof seen[0].topK, "number");
  assertEquals(typeof seen[0].temperature, "number");
});

Deno.test("non-system messages keep their ROLES — no undifferentiated flattening into one user turn", async () => {
  let prompted = "";
  installPromptApi(async () => ({
    prompt: async (t: string) => {
      prompted = t;
      return "ok";
    },
  }));
  const model = createPromptApiModel();
  await model.doGenerate({
    prompt: [
      { role: "system", content: "SYS-TEXT" },
      { role: "user", content: "USER-TURN" },
      { role: "assistant", content: "ASSISTANT-TURN" },
      { role: "user", content: [{ type: "text", text: "MULTI-PART" }] },
    ],
  });
  assert(prompted.includes("user:\nUSER-TURN"), `the user role is labelled: ${JSON.stringify(prompted)}`);
  assert(prompted.includes("assistant:\nASSISTANT-TURN"), "the assistant role is labelled");
  assert(prompted.includes("MULTI-PART"), "content parts are extracted");
  assert(!prompted.includes("SYS-TEXT"), "the system message rides the session, never the user text");
});

Deno.test("doStream binds the EXACT system message + role transcript at the final Prompt API boundary", async () => {
  const created: SessionOptions[] = [];
  let streamed = "";
  let destroyed = false;
  installPromptApi(async (opts) => {
    created.push(opts);
    return {
      prompt: async () => "unused",
      promptStreaming: (text: string) => {
        streamed = text;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue("streamed reply");
            controller.close();
          },
        });
      },
      destroy: () => { destroyed = true; },
    };
  });
  const model = createPromptApiModel();
  const result = await model.doStream({
    prompt: [
      { role: "system", content: "STREAM-SYSTEM-EXACT" },
      { role: "user", content: "STREAM-USER" },
      { role: "assistant", content: "STREAM-ASSISTANT" },
    ],
  });
  const reader = result.stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  assertEquals(created[0]?.systemPrompt, "STREAM-SYSTEM-EXACT");
  assert(streamed.includes("user:\nSTREAM-USER"), "streaming keeps the user role");
  assert(streamed.includes("assistant:\nSTREAM-ASSISTANT"), "streaming keeps the assistant role");
  assert(!streamed.includes("STREAM-SYSTEM-EXACT"), "the system text rides session creation, not promptStreaming");
  assert(destroyed, "the per-call streaming session is released after the stream closes");
});
