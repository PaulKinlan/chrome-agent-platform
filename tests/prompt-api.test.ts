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
type FakeSession = { prompt: (t: string) => Promise<string> };

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
