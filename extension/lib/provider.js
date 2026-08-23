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
import { createLocalOpfsModel } from "./models/local-opfs-model.js";
import { kvGet, kvSet } from "./kv.js";

const DEFAULTS = {
  // "demo" | "openai" | "anthropic" | "gemini" | "deepseek" | "ollama" | "prompt-api"
  provider: "demo",
  baseURL: "",
  apiKey: "",
  model: "",
};

/** Complete runtime/test provider authority. User-facing lists derive a
 * public-only view via provider-visibility.js; do not delete internal choices
 * here or stored Demo/Prompt API selections would stop resolving. */
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
    // The BYO-endpoint provider (Bedrock, Kimi, Groq, Together…). Resolves
    // through the same adapter but has NO preset base URL — the user must set
    // one (k3 review HIGH-2: previously offered in Settings yet unresolvable —
    // absent from this set AND PROVIDER_CHOICES, so a global selection fell
    // through to demo and a per-agent override was silently dropped).
    id: "openai-compatible",
    label: "OpenAI-compatible (your endpoint + key)",
    needsKey: true,
    baseURL: "",
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
  {
    id: "local-opfs",
    label: "Local OPFS Model (on-device GGUF)",
    needsKey: false,
    needsModel: true,
  },
];

/** Every provider id that resolves through the OpenAI-compatible adapter. */
const OPENAI_COMPATIBLE_IDS = new Set([
  "openai",
  "openai-compatible",
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

/** Resolve a LanguageModel from a COMPLETE provider config (provider id +
 * baseURL + apiKey + model). A complete config is self-contained — it never
 * mixes one provider's endpoint with another's credential. Returns
 * { model, modelId, providerName }. */
export async function resolveModelFromConfig(cfg) {
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

  if (id === "local-opfs") {
    const modelId = cfg.model || "gemma-4-e4b-it-qat-q4_0";
    const model = createLocalOpfsModel({ modelId });
    return {
      model,
      modelId,
      providerName: "local-opfs",
    };
  }

  // default: demo
  return {
    model: createDemoModel(),
    modelId: "demo-local",
    providerName: "demo",
  };
}

/** Resolve the LanguageModel for the stored global provider. */
export async function getModel() {
  return resolveModelFromConfig(await getProviderConfig());
}

/** Resolve the LanguageModel for a NAMED agent's provider OVERRIDE. When the
 * override is absent (or not a complete valid config) the global provider is
 * used instead. The override is a COMPLETE provider-specific config, so a
 * per-agent model can never mix one provider's endpoint with another's
 * credential (the wider-goal review's credential-disclosure finding). */
export async function getModelForAgent(override) {
  if (override && typeof override === "object" && override.provider) {
    return resolveModelFromConfig({
      provider: override.provider,
      baseURL: override.baseURL ?? "",
      apiKey: override.apiKey ?? "",
      model: override.model ?? "",
    });
  }
  return getModel();
}
