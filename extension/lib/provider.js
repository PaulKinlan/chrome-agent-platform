// lib/provider.js — the real model layer.
//
// Model resolution order:
//   1. An OpenAI-compatible provider (the user's OWN baseURL + apiKey + model,
//      stored in chrome.storage settings) — a real, user-configured provider.
//      Every advertised OpenAI-compatible provider (OpenAI, Anthropic, Gemini,
//      DeepSeek, Ollama) goes through the SAME compatible adapter with ITS OWN
//      endpoint — none silently falls back to a different model.
//   2. Chrome's built-in Prompt API (Gemini nano) — on-device, no key.
//   3. Demo local model — a deterministic, clearly-labelled fallback so the
//      agent loop always runs end-to-end with zero configuration.
//
// There is NO hardcoded provider key and NO fake default — a Chrome extension
// cannot call a paid provider without the user's key, and this file never ships
// one.

import { createOpenAICompatibleModel } from "./models/openai-model.js";
import {
  createPromptApiModel,
  isPromptApiAvailable,
} from "./models/prompt-api-model.js";
import { createDemoModel } from "./models/demo-model.js";
import { kvGet, kvSet } from "./kv.js";

const DEFAULTS = {
  // "demo" | "openai" | "anthropic" | "gemini" | "deepseek" | "ollama" | "prompt-api"
  provider: "demo",
  baseURL: "",
  apiKey: "",
  model: "",
};

/** The providers the options page may advertise — every one is real. */
export const PROVIDER_CHOICES = [
  { id: "demo", label: "Demo (no key — deterministic local)" },
  {
    id: "openai",
    label: "OpenAI-compatible endpoint (your key)",
    needsKey: true,
    baseURL: "https://api.openai.com/v1",
    needsModel: true,
  },
  {
    id: "anthropic",
    label: "Anthropic (OpenAI-compatible endpoint, your key)",
    needsKey: true,
    baseURL: "https://api.anthropic.com/v1",
    needsModel: true,
  },
  {
    id: "gemini",
    label: "Google Gemini (OpenAI-compatible endpoint, your key)",
    needsKey: true,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsModel: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek (OpenAI-compatible endpoint, your key)",
    needsKey: true,
    baseURL: "https://api.deepseek.com/v1",
    needsModel: true,
  },
  {
    id: "ollama",
    label: "Ollama (local, OpenAI-compatible)",
    needsKey: false,
    baseURL: "http://localhost:11434/v1",
    needsModel: true,
  },
  {
    id: "prompt-api",
    label: "Chrome Prompt API (Gemini nano, on-device)",
    needsKey: false,
    needsModel: false,
  },
];

/** Every provider id that resolves through the OpenAI-compatible adapter. */
const OPENAI_COMPATIBLE_IDS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "ollama",
]);

export async function getProviderConfig() {
  const stored = await kvGet("providerConfig");
  return { ...DEFAULTS, ...(stored.providerConfig ?? {}) };
}

export async function setProviderConfig(partial) {
  const cur = await getProviderConfig();
  const next = { ...cur, ...partial };
  await kvSet({ providerConfig: next });
  return next;
}

/** Resolve the LanguageModel for the stored global provider. There is NO
 * per-agent provider resolution — every agent uses the one global provider
 * config, so a per-agent override can never mix one provider's endpoint with
 * another's credential. Returns { model, modelId, providerName }. */
export async function getModel() {
  const cfg = await getProviderConfig();
  const id = cfg.provider;

  if (OPENAI_COMPATIBLE_IDS.has(id)) {
    const baseURL = cfg.baseURL ||
      (PROVIDER_CHOICES.find((p) => p.id === id)?.baseURL ?? "");
    const apiKey = cfg.apiKey ?? "";
    const model = cfg.model ?? "";
    const needsKey = PROVIDER_CHOICES.find((p) => p.id === id)?.needsKey ??
      true;
    // Ollama needs no key; the others do. A model id is always required.
    if (!baseURL || !model || (needsKey && !apiKey)) {
      return {
        model: createDemoModel(),
        modelId: "demo-local",
        providerName: `${id} (missing ${
          !baseURL ? "base URL" : !model ? "model id" : "API key"
        } — fell back to demo)`,
      };
    }
    const m = createOpenAICompatibleModel({ baseURL, apiKey, model });
    return { model: m, modelId: model, providerName: id };
  }

  if (id === "prompt-api") {
    if (await isPromptApiAvailable()) {
      try {
        const model = createPromptApiModel();
        return {
          model,
          modelId: "gemini-nano",
          providerName: "chrome-prompt-api",
        };
      } catch {
        // fall through to demo
      }
    }
    return {
      model: createDemoModel(),
      modelId: "demo-local",
      providerName: "demo (prompt api unavailable)",
    };
  }

  // default: demo
  return {
    model: createDemoModel(),
    modelId: "demo-local",
    providerName: "demo",
  };
}
