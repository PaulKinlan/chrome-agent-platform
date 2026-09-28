// lib/provider-catalog.js — provider presets, choices, and endpoint helpers.
//
// Separated from lib/provider.js so UI surfaces (Options / Settings) and permission
// gates can inspect provider choices, default models, and derive effective base URLs
// without pulling in the heavy AI SDK model layer (ai, @ai-sdk/*, zod, demo-model).

export const DEFAULTS = {
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
    vision: true,
  },
  {
    id: "anthropic",
    label: "Anthropic (OpenAI-compatible endpoint, your key)",
    needsKey: true,
    baseURL: "https://api.anthropic.com/v1",
    needsModel: true,
    vision: true,
  },
  {
    id: "gemini",
    label: "Google Gemini (native API, your key — a custom base URL uses the OpenAI-compatible adapter)",
    needsKey: true,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsModel: true,
    vision: true,
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
    id: "lm-studio",
    label: "LM Studio (local, OpenAI-compatible)",
    needsKey: false,
    baseURL: "http://localhost:1234/v1",
    needsModel: true,
  },
  {
    id: "prompt-api",
    label: "Chrome Prompt API (Gemini nano, on-device)",
    needsKey: false,
    needsModel: false,
  },
];

/** The resolved provider LANES whose tool-result transport carries a real
 * image content part, so a screenshot can be SHOWN to the model instead of
 * described to it (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01).
 *
 * The OpenAI-compatible chat transport is deliberately absent: it collapses a
 * `content` tool output with `JSON.stringify`, which would put the whole base64
 * PNG straight back into the message text — the exact failure this change
 * exists to remove. A model on that lane gets the JSON envelope (the id, the
 * URL, the dimensions) and nothing else. */
export const IMAGE_TOOL_RESULT_LANES = new Set(["gemini-native", "anthropic-native"]);

/** The reader-facing name of each hosted preset, for the privacy statement. */
export const PROVIDER_PUBLIC_NAMES = Object.freeze({
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
});

/** Every host a hosted preset sends a request to, DERIVED from the presets
 * above so the "What this extension sends and stores" page can never drift
 * from the endpoints this file actually resolves
 * (CAP-FB-20260830-PRIVACY-STATEMENT-01). Local presets (http://localhost)
 * and the on-device models are deliberately absent: nothing leaves the
 * machine on those lanes. `tests/privacy-statement.test.ts` fails the moment a
 * new https:// literal appears here without being listed. */
export const OUTBOUND_HOSTS = Object.freeze(
  PROVIDER_CHOICES
    .filter((c) => /^https:\/\//.test(c.baseURL ?? ""))
    .map((c) => Object.freeze({
      id: c.id,
      name: PROVIDER_PUBLIC_NAMES[c.id] ?? c.id,
      host: new URL(c.baseURL).host,
    })),
);

/** Can this RESOLVED model be shown an image in a tool result? Both halves must
 * hold: the provider's models can see images at all (the `vision` flag above),
 * and the lane it resolved on transports an image part. */
export function acceptsImageToolResults(resolved) {
  if (!IMAGE_TOOL_RESULT_LANES.has(String(resolved?.providerLane ?? ""))) return false;
  return PROVIDER_CHOICES.find((p) => p.id === resolved?.providerName)?.vision === true;
}

/** Every provider id that resolves through the OpenAI-compatible adapter. */
export const OPENAI_COMPATIBLE_IDS = new Set([
  "openai",
  "openai-compatible",
  "anthropic",
  "gemini",
  "deepseek",
  "ollama",
  "lm-studio",
]);

/** The base URL a config will actually run against: the stored one, or the
 * preset's when the stored one is empty. A preset provider saved without a
 * base URL is a complete config (CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01);
 * only a BYO endpoint with no URL is genuinely unconfigured. */
export function effectiveBaseURL(cfg) {
  const stored = String(cfg?.baseURL ?? "").trim();
  if (stored) return stored;
  return PROVIDER_CHOICES.find((p) => p.id === cfg?.provider)?.baseURL ?? "";
}

/** The same config with its effective base URL filled in — for every origin
 * derivation (status, permission summary, resume identity). Storage applies
 * the same helper in setProviderConfig, so a stored config already carries it;
 * this covers configs that never pass through storage (per-agent overrides,
 * legacy stored values). */
export function withEffectiveBaseURL(cfg) {
  const baseURL = effectiveBaseURL(cfg);
  return baseURL === String(cfg?.baseURL ?? "") ? cfg : { ...cfg, baseURL };
}
