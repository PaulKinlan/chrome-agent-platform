// lib/provider.js — the real model layer.
//
// Model resolution order:
//   1. OpenAI-compatible endpoint (the user's OWN baseURL + apiKey + model,
//      stored in chrome.storage settings) — a real, user-configured provider.
//   2. Chrome's built-in Prompt API (Gemini nano) — on-device, no key, when
//      available in the browser.
//   3. Demo local model — a deterministic, clearly-labelled fallback so the
//      agent loop always runs end-to-end with zero configuration.
//
// There is NO hardcoded provider key and NO fake "deepseek-v4-pro" default —
// a Chrome extension cannot call a paid provider without the user's key, and
// this file never ships one.

import { createOpenAICompatibleModel } from "./models/openai-model.js";
import { createPromptApiModel, isPromptApiAvailable } from "./models/prompt-api-model.js";
import { createDemoModel } from "./models/demo-model.js";

const DEFAULTS = {
  // "demo" | "openai" | "prompt-api"
  provider: "demo",
  baseURL: "",
  apiKey: "",
  model: "",
};

export async function getProviderConfig() {
  const stored = await chrome.storage.local.get("providerConfig");
  return { ...DEFAULTS, ...(stored.providerConfig ?? {}) };
}

export async function setProviderConfig(partial) {
  const cur = await getProviderConfig();
  const next = { ...cur, ...partial };
  await chrome.storage.local.set({ providerConfig: next });
  return next;
}

export const PROVIDER_CHOICES = [
  { id: "demo", label: "Demo (no key — deterministic local)" },
  { id: "openai", label: "OpenAI-compatible endpoint (your key)" },
  { id: "prompt-api", label: "Chrome Prompt API (Gemini nano, on-device)" },
];

/** Resolve the actual LanguageModel. Returns { model, modelId, providerName }. */
export async function getModel() {
  const cfg = await getProviderConfig();

  if (cfg.provider === "openai") {
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      // Missing config — fall back to demo rather than throw, so the loop runs.
      return { model: createDemoModel(), modelId: "demo-local", providerName: "demo (missing openai config)" };
    }
    const model = createOpenAICompatibleModel(cfg);
    return { model, modelId: cfg.model, providerName: "openai-compatible" };
  }

  if (cfg.provider === "prompt-api") {
    if (await isPromptApiAvailable()) {
      try {
        const model = createPromptApiModel();
        return { model, modelId: "gemini-nano", providerName: "chrome-prompt-api" };
      } catch {
        // fall through to demo
      }
    }
    return { model: createDemoModel(), modelId: "demo-local", providerName: "demo (prompt api unavailable)" };
  }

  // default: demo
  return { model: createDemoModel(), modelId: "demo-local", providerName: "demo" };
}
