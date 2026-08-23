// lib/model-prices.js — bundled model pricing (per 1M tokens, USD).
//
// Source: https://www.llm-prices.com/current-v1.json (model id -> {input, output}
// per-1M-token USD). Plus zero-cost entries for the on-device models
// (gemini-nano / the Chrome Prompt API).
//
// REFRESH: node scripts/refresh-model-prices.mjs
// An unknown model falls back to agent-do 0-cost estimate (best-effort).
export const MODEL_PRICING = {
  "amazon-nova-lite": { input: 0.06, output: 0.24 },
  "amazon-nova-micro": { input: 0.035, output: 0.14 },
  "amazon-nova-premier": { input: 2.5, output: 12.5 },
  "amazon-nova-pro": { input: 0.8, output: 3.2 },
  "chatgpt-4o-latest": { input: 5, output: 15 },
  "chrome-prompt-api": { input: 0, output: 0 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-sonnet": { input: 3, output: 15 },
  "claude-3.5-haiku": { input: 0.8, output: 4 },
  "claude-3.5-sonnet": { input: 3, output: 15 },
  "claude-3.7-sonnet": { input: 3, output: 15 },
  "claude-4.5-haiku": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-4-0": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4.5": { input: 3, output: 15 },
  "claude-sonnet-4.5-200k": { input: 6, output: 22.5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "codellama": { input: 0, output: 0 },
  "codestral": { input: 0.3, output: 0.9 },
  "codestral-latest": { input: 0.3, output: 0.9 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-coder": { input: 0, output: 0 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48 },
  "demo": { input: 0, output: 0 },
  "demo-local": { input: 0, output: 0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-128k": { input: 0.15, output: 0.6 },
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
  "gemini-1.5-flash-8b-128k": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-pro-128k": { input: 2.5, output: 10 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash-preview-09-2025": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-pro-200k": { input: 2.5, output: 15 },
  "gemini-2.5-pro-preview-03-25": { input: 1.25, output: 10 },
  "gemini-2.5-pro-preview-03-25-200k": { input: 2.5, output: 15 },
  "gemini-3-1-pro-preview": { input: 2, output: 12 },
  "gemini-3-1-pro-preview-200k": { input: 4, output: 18 },
  "gemini-3-flash": { input: 0.5, output: 3 },
  "gemini-3-flash-preview": { input: 0.5, output: 3 },
  "gemini-3-pro-preview": { input: 2, output: 12 },
  "gemini-3-pro-preview-200k": { input: 4, output: 18 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro": { input: 2, output: 12 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-nano": { input: 0, output: 0 },
  "gemini-nano-prompt-api": { input: 0, output: 0 },
  "gemma-4-e4b-it-qat-q4_0": { input: 0, output: 0 },
  "gemma-4-26b-a4b-it-qat-q4_0": { input: 0, output: 0 },
  "gemma2": { input: 0, output: 0 },
  "glm-4.5": { input: 0.6, output: 2.2 },
  "glm-4.5-air": { input: 0.2, output: 1.1 },
  "glm-4.5-airx": { input: 1.1, output: 4.5 },
  "glm-4.5-flash": { input: 0, output: 0 },
  "glm-4.5-x": { input: 2.2, output: 8.9 },
  "glm-4.6": { input: 0.6, output: 2.2 },
  "glm-4.7": { input: 0.6, output: 2.2 },
  "glm-4.7-flash": { input: 0, output: 0 },
  "glm-4.7-flashx": { input: 0.07, output: 0.4 },
  "glm-5": { input: 1, output: 3.2 },
  "glm-5-turbo": { input: 1.2, output: 4 },
  "glm-5.1": { input: 1.4, output: 4.4 },
  "glm-5.2": { input: 1.4, output: 4.4 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.5": { input: 75, output: 150 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-pro": { input: 15, output: 120 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5.1-codex": { input: 1.25, output: 10 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.2-pro": { input: 21, output: 168 },
  "gpt-5.3": { input: 2.5, output: 15 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-272k": { input: 5, output: 22.5 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-pro": { input: 30, output: 180 },
  "gpt-5.4-pro-272k": { input: 60, output: 270 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-272k": { input: 10, output: 45 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.5-pro-272k": { input: 60, output: 270 },
  "gpt-5.6": { input: 5, output: 30 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-luna-272k": { input: 0.4, output: 1.8 },
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-sol-272k": { input: 10, output: 45 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-terra-272k": { input: 4, output: 18 },
  "gpt-image-1": { input: 10, output: 40 },
  "gpt-image-1-mini": { input: 2, output: 8 },
  "gpt-image-2-image": { input: 8, output: 30 },
  "gpt-image-2-text": { input: 5, output: 10 },
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-4": { input: 3, output: 15 },
  "grok-4-128k": { input: 6, output: 30 },
  "grok-4-fast": { input: 0.2, output: 0.5 },
  "grok-4-fast-128k": { input: 0.4, output: 1 },
  "grok-4-fast-reasoning": { input: 0.2, output: 0.5 },
  "grok-4-fast-reasoning-128k": { input: 0.4, output: 1 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, output: 2.5 },
  "grok-4.20-0309-non-reasoning-200k": { input: 2.5, output: 5 },
  "grok-4.20-0309-reasoning": { input: 1.25, output: 2.5 },
  "grok-4.20-0309-reasoning-200k": { input: 2.5, output: 5 },
  "grok-4.20-multi-agent-0309": { input: 1.25, output: 2.5 },
  "grok-4.20-multi-agent-0309-200k": { input: 2.5, output: 5 },
  "grok-4.3": { input: 1.25, output: 2.5 },
  "grok-4.3-200k": { input: 2.5, output: 5 },
  "grok-4.5": { input: 2, output: 6 },
  "grok-4.5-200k": { input: 4, output: 12 },
  "grok-4.6": { input: 2, output: 6 },
  "grok-4.6-200k": { input: 4, output: 12 },
  "grok-build-0.1": { input: 1, output: 2 },
  "grok-build-0.1-200k": { input: 2, output: 4 },
  "grok-code-fast-1": { input: 0.2, output: 1.5 },
  "kimi-k2-0711-preview": { input: 0.6, output: 2.5 },
  "kimi-k2-0905-preview": { input: 0.6, output: 2.5 },
  "kimi-k2-thinking": { input: 0.6, output: 2.5 },
  "kimi-k2-thinking-turbo": { input: 1.15, output: 8 },
  "kimi-k2-turbo-preview": { input: 1.15, output: 8 },
  "llama-3.1-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-4-scout": { input: 0.11, output: 0.34 },
  "llama3": { input: 0, output: 0 },
  "llama3.2": { input: 0, output: 0 },
  "magistral-medium-latest": { input: 2, output: 5 },
  "minimax-m2": { input: 0.3, output: 1.2 },
  "ministral-3b": { input: 0.1, output: 0.1 },
  "ministral-3b-latest": { input: 0.04, output: 0.04 },
  "ministral-8b": { input: 0.15, output: 0.15 },
  "ministral-8b-latest": { input: 0.1, output: 0.1 },
  "mistral-large": { input: 0.5, output: 1.5 },
  "mistral-large-3": { input: 0.5, output: 1.5 },
  "mistral-large-latest": { input: 2, output: 6 },
  "mistral-local": { input: 0, output: 0 },
  "mistral-medium": { input: 0.4, output: 2 },
  "mistral-medium-2505": { input: 0.4, output: 2 },
  "mistral-medium-3": { input: 0.4, output: 2 },
  "mistral-nemo": { input: 0.15, output: 0.15 },
  "mistral-saba-latest": { input: 0.2, output: 0.6 },
  "mistral-small": { input: 0.03, output: 0.11 },
  "mistral-small-3": { input: 0.075, output: 0.2 },
  "mistral-small-latest": { input: 0.1, output: 0.3 },
  "mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
  "muse-spark-1.1": { input: 1.25, output: 4.25 },
  "muse-spark-1.2": { input: 1.25, output: 4.25 },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o1-preview": { input: 15, output: 60 },
  "o1-pro": { input: 150, output: 600 },
  "o3": { input: 10, output: 40 },
  "o3-deep-research": { input: 10, output: 40 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3-pro": { input: 20, output: 80 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o4-mini-deep-research": { input: 2, output: 8 },
  "open-mistral-7b": { input: 0.25, output: 0.25 },
  "open-mixtral-8x22b": { input: 2, output: 6 },
  "open-mixtral-8x7b": { input: 0.7, output: 0.7 },
  "phi3": { input: 0, output: 0 },
  "pixtral-12b": { input: 0.15, output: 0.15 },
  "pixtral-large-latest": { input: 2, output: 6 },
  "prompt-api": { input: 0, output: 0 },
  "qwen2.5": { input: 0, output: 0 },
  "qwen3-32b": { input: 0.29, output: 0.59 },
  "qwen3.6-plus": { input: 0.5, output: 3 },
  "qwen3.6-plus-256k": { input: 2, output: 6 },
  "sonar": { input: 1, output: 1 },
  "sonar-deep-research": { input: 2, output: 8 },
  "sonar-pro": { input: 3, output: 15 },
  "sonar-reasoning": { input: 2, output: 8 },
  "text-davinci-003": { input: 20, output: 20 },
};

// ── Vendor model lists (driven by the pricing data above — single source of
// truth, so the settings dropdowns never drift from the bundled pricing). ──

// Which models belong to which chat provider, by id prefix. Filtered against
// MODEL_PRICING so only priced (real/current) models appear.
const VENDOR_PREFIXES = {
  openai: ["gpt-", "o1", "o3", "o4", "chatgpt-"],
  anthropic: ["claude-"],
  gemini: ["gemini-"],
  deepseek: ["deepseek-"],
};

// Family weight — breaks ties when two models share a version (e.g. gpt-5.6
// vs gpt-5.6-luna), so the more-capable family sorts first.
const FAMILY = [
  ["pro", "terra", "sol", "opus"],
  ["sonnet", "luna", "reasoner", "preview"],
  ["flash", "chat", "haiku"],
  ["coder", "fable", "mythos", "lite", "mini", "nano", "deep-research", "codex"],
];
function familyRank(id) {
  const lower = id.toLowerCase();
  let best = 999;
  FAMILY.forEach((tier, idx) => {
    if (tier.some((f) => lower.includes(f))) best = Math.min(best, idx);
  });
  return best;
}

// Extract a comparable [major, minor] version from a model id.
function versionOf(id) {
  const m = id.match(/[-\s]?(\d+)(?:[._-](\d+))?/);
  if (!m) return [0, 0];
  return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
}

// The newest/most-capable first: version desc, then family tier asc, then
// the fuller id (a variant like "…-272k" sorts after its base) desc.
function sortNewestFirst(a, b) {
  const [am, an] = versionOf(a);
  const [bm, bn] = versionOf(b);
  if (bm !== am) return bm - am;
  if (bn !== an) return bn - an;
  const fr = familyRank(a) - familyRank(b);
  if (fr !== 0) return fr;
  return b.length - a.length;
}

/**
 * The current chat models for a provider, derived from MODEL_PRICING and
 * sorted newest-first. Returns [] for providers without a vendor mapping.
 */
export function modelsForVendor(vendor) {
  const prefixes = VENDOR_PREFIXES[vendor];
  if (!prefixes) return [];
  return Object.keys(MODEL_PRICING)
    .filter((id) => prefixes.some((p) => id.startsWith(p)))
    // On-device ids (the Prompt API's gemini-nano family) are NOT cloud models
    // — they never resolve through the OpenAI-compatible endpoint, so the
    // pickers must not offer them (the k3 review's catalogue finding).
    .filter((id) => !id.includes("nano") && !id.includes("prompt-api"))
    .filter((id) => !id.includes("image"))
    .sort(sortNewestFirst);
}
