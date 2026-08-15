// lib/models/openai-model.js — the real, configurable provider.
//
// Uses the Vercel AI SDK's @ai-sdk/openai createOpenAI with the user's OWN
// base URL + API key + model id (stored in chrome.storage settings). This is
// a genuine model — it calls the user's endpoint. It is never a fake label and
// the extension never ships the owner's keys.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function createOpenAICompatibleModel(config) {
  const { baseURL, apiKey, model } = config ?? {};
  // baseURL + model are always required; apiKey is OPTIONAL (local Ollama has
  // no key). The SDK accepts an empty-string key for keyless local endpoints.
  if (!baseURL || !model) {
    throw new Error("OpenAI-compatible provider requires baseURL and model");
  }
  const openai = createOpenAICompatible({
    baseURL,
    apiKey: apiKey ?? "",
    name: "configured",
  });
  return openai(model);
}
