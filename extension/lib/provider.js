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
  createGeminiNativeModel,
  isDefaultGeminiEndpoint,
  normaliseGeminiNativeModelId,
} from "./models/gemini-native-model.js";
import {
  createAnthropicNativeModel,
  isDefaultAnthropicEndpoint,
} from "./models/anthropic-native-model.js";
import {
  createPromptApiModel,
  isPromptApiAvailable,
} from "./models/prompt-api-model.js";
import { createDemoModel } from "./models/demo-model.js";
import { createLocalAssistant, LOCAL_ASSISTANT_MODEL_ID } from "./models/local-assistant.js";
import { defaultModelFor } from "./model-catalog.js";
import { kvGet, kvSet } from "./kv.js";
import { DEVELOPER_FEATURES_KEY } from "./pure.js";
import {
  DEFAULTS,
  PROVIDER_CHOICES,
  IMAGE_TOOL_RESULT_LANES,
  PROVIDER_PUBLIC_NAMES,
  OUTBOUND_HOSTS,
  acceptsImageToolResults,
  OPENAI_COMPATIBLE_IDS,
  effectiveBaseURL,
  withEffectiveBaseURL,
} from "./provider-catalog.js";

// Re-exported so the Settings page (which must NOT import the heavy model layer)
// and developerFeaturesOn() share ONE key. The definition lives in pure.js.
export { DEVELOPER_FEATURES_KEY };
export {
  PROVIDER_CHOICES,
  OUTBOUND_HOSTS,
  acceptsImageToolResults,
  effectiveBaseURL,
  withEffectiveBaseURL,
};


export async function getProviderConfig() {
  const stored = await kvGet("providerConfig");
  return { ...DEFAULTS, ...(stored.providerConfig ?? {}) };
}

export async function setProviderConfig(partial) {
  const cur = await getProviderConfig();
  const next = { ...cur, ...partial };
  // A provider SWITCH that omits the base URL must not inherit the previous
  // provider's endpoint (an OpenAI save after a BYO save would otherwise run
  // OpenAI's key against the BYO URL).
  if (partial?.provider && partial.provider !== cur.provider && partial.baseURL === undefined) {
    next.baseURL = "";
  }
  // Store the EFFECTIVE base URL: a preset provider saved without one gets the
  // preset endpoint, so the stored config can always derive a real origin; the
  // BYO endpoint has no preset and stays "" (the gate then says so)
  // (CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01).
  next.baseURL = effectiveBaseURL(next);
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
    const baseURL = effectiveBaseURL(cfg);
    const apiKey = cfg.apiKey ?? "";
    // An EMPTY model id resolves to the provider's catalogue default (the
    // recommended, verified-callable id) instead of silently running the demo
    // model — providers without a catalogue (BYO endpoint, Ollama, LM Studio)
    // still need an explicit id (CAP-FB-20260830-MODEL-CATALOG-CURRENT-01).
    const explicitModel = String(cfg.model ?? "").trim();
    const model = explicitModel || defaultModelFor(id);
    const usingDefaultModel = !explicitModel && Boolean(model);
    const needsKey = PROVIDER_CHOICES.find((p) => p.id === id)?.needsKey ??
      true;
    // Ollama needs no key; the others do. A model id is always required — and
    // a REAL provider id must NEVER silently resolve to the demo model (the
    // pre-gate check covers the run; this is the same refusal for every other
    // resolution path, e.g. a per-agent override, so the demo fallback exists
    // ONLY for the provider id "demo" itself — CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
    if (!baseURL || !model || (needsKey && !apiKey)) {
      throw new Error(
        `${id} is misconfigured: missing ${!baseURL ? "base URL" : !model ? "model id" : "API key"}`,
      );
    }
    // NATIVE GEMINI LANE: the Gemini OpenAI-compatible endpoint silently drops
    // provider-defined server tools (google_search, url_context, code_exec), so
    // the DEFAULT Gemini config routes through @ai-sdk/google's native API
    // (same credential + middleware). A CUSTOM base URL is a BYO/proxy
    // endpoint and stays on the compatible adapter — provider server tools
    // then honestly report owner-action-required.
    if (id === "gemini" && isDefaultGeminiEndpoint(cfg.baseURL)) {
      const canonicalModel = normaliseGeminiNativeModelId(model);
      const m = createGeminiNativeModel({ apiKey, model: canonicalModel });
      return {
        model: m,
        modelId: canonicalModel,
        providerName: id,
        providerLane: "gemini-native",
        usingDefaultModel,
      };
    }
    // NATIVE ANTHROPIC LANE: Anthropic's OpenAI-compatible endpoint does not
    // carry provider-defined server tools (web_search_20250305), so the
    // DEFAULT Anthropic config routes through @ai-sdk/anthropic's native
    // Messages API (same credential + middleware). A CUSTOM base URL is a
    // BYO/proxy endpoint and stays on the compatible adapter — provider
    // server tools then honestly report owner-action-required.
    if (id === "anthropic" && isDefaultAnthropicEndpoint(cfg.baseURL)) {
      const m = createAnthropicNativeModel({ apiKey, model });
      return {
        model: m,
        modelId: model,
        providerName: id,
        providerLane: "anthropic-native",
        usingDefaultModel,
      };
    }
    const m = createOpenAICompatibleModel({ baseURL, apiKey, model });
    return { model: m, modelId: model, providerName: id, providerLane: "openai-compatible", usingDefaultModel };
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

  // default: no provider configured. A fresh profile runs the LOCAL ASSISTANT
  // (deterministic tab skills through the real tool protocol — a real first
  // result with no key, CAP-FB-20260830-KEYLESS-FIRST-RESULT-01). The marker
  // demo model — the journey suite's test seam — is reachable ONLY under the
  // developer flag, so its "[demo model] Task received (N chars)" plumbing
  // proof can never be the first thing a new user reads.
  if (await developerFeaturesOn()) {
    return {
      model: createDemoModel(),
      modelId: "demo-local",
      providerName: "demo",
    };
  }
  return {
    model: createLocalAssistant(),
    modelId: LOCAL_ASSISTANT_MODEL_ID,
    providerName: "local",
  };
}

/** The developer flag (CAP-FB-20260830-EXEC-BUILD-FLAG-01 owns the surface;
 * until it lands the flag is the kv key `cap:developerFeatures === true`).
 * Read once per resolution — never cached, so a toggle takes effect on the
 * next run. */
export async function developerFeaturesOn() {
  try {
    const stored = await kvGet(DEVELOPER_FEATURES_KEY);
    return stored?.[DEVELOPER_FEATURES_KEY] === true;
  } catch {
    return false;
  }
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
