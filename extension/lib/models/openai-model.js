// lib/models/openai-model.js — the real, configurable provider.
//
// Uses the Vercel AI SDK's @ai-sdk/openai createOpenAI with the user's OWN
// base URL + API key + model id (stored in chrome.storage settings). This is
// a genuine model — it calls the user's endpoint. It is never a fake label and
// the extension never ships the owner's keys.

import { createOpenAI } from "@ai-sdk/openai";

export function createOpenAICompatibleModel(config) {
  const { baseURL, apiKey, model } = config ?? {};
  if (!baseURL || !apiKey || !model) {
    throw new Error("OpenAI-compatible provider requires baseURL, apiKey, and model");
  }
  const openai = createOpenAI({ baseURL, apiKey });
  return openai(model);
}
