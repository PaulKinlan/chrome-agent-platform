// lib/model-catalog.js — the ONE place a model id is written down for the user.
//
// Why this exists (CAP-FB-20260830-MODEL-CATALOG-CURRENT-01): the Settings
// picker used to be derived from the bundled PRICE table, which is a copy of
// llm-prices.com and therefore lists every id ever priced (retired families)
// plus pricing pseudo-ids like `gpt-5.6-terra-272k` (a context tier OpenAI
// answers 404 to) — and the tier rows sorted FIRST. There was also no
// per-provider default, so an empty model field silently ran the demo model.
//
// Every id below was verified callable against the provider's own /models list
// on the day it was committed (2026-08-30). `scripts/check-models.mjs` fails the
// build if a retired family reappears anywhere under extension/, scripts/,
// docs/, README.md or PLAN.md (the price table is the one allowed exception —
// old usage rows still need a price).
//
// PURE: no chrome.*, no kv, no DOM. `fetchLiveModels` is the only network
// function and it never throws into the UI (any failure → []).

import { safeProviderError } from "./pure.js";

export const MODEL_CATALOG = Object.freeze({
  openai: {
    default: "gpt-5.6-luna",
    suggested: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini"],
  },
  gemini: {
    default: "gemini-3.7-flash",
    suggested: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-flash-latest"],
  },
  anthropic: {
    default: "claude-sonnet-5",
    suggested: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5"],
  },
  deepseek: {
    default: "deepseek-v4-flash",
    suggested: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  "openai-compatible": {
    default: "",
    suggested: [],
    // Shown as placeholder examples only — a BYO endpoint has no catalogue.
    examples: ["grok-4.6", "glm-5.3"],
  },
  ollama: { default: "", suggested: [] },
  "lm-studio": { default: "", suggested: [] },
});

/** The current Gemini image-generation model (the agent-avatar endpoint). */
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

/** Retired model families. A hit anywhere in the user-facing source is a
 * defect (see scripts/check-models.mjs). Anchored so a current id can never
 * false-positive: `gpt-5.4-mini` does not match `gpt-4`, `gemini-3.7-flash`
 * does not match `gemini-[12]`, `claude-sonnet-5` does not match `-4`. */
export const RETIRED_MODEL_PATTERNS = Object.freeze([
  /\bgpt-4(?:[.o-]|\b)/i, // gpt-4, gpt-4o, gpt-4.1, gpt-4-turbo, gpt-4.5
  /\bchatgpt-4o\b/i,
  /\bo[134](?:-(?:mini|pro|preview|deep-research)\b|\b)/, // o1, o3-mini, o4-mini
  /\bgemini-[12](?:[.-]\d+)?(?:-|\b)/i, // gemini-1.5-pro, gemini-2.0-flash, gemini-2.5-*
  /\bclaude-3(?:[.-]|\b)/i, // claude-3-*, claude-3.5-*
  /\bclaude-(?:sonnet|opus|haiku)-4(?:[.-]\d|\b)/i, // claude-sonnet-4-5, claude-opus-4.1
  /\bgrok-3(?:[.-]|\b)/i,
  /\bglm-4(?:[.-]|\b)/i,
]);

export function isRetiredModelId(id) {
  const s = String(id ?? "");
  return RETIRED_MODEL_PATTERNS.some((re) => re.test(s));
}

/** llm-prices.com context-tier pseudo-ids (`…-272k`, `…-200k`, `…-128k`). They
 * are pricing rows, not models — every provider 404s them. */
export function isPricingTierId(id) {
  return /-(\d+)k$/i.test(String(id ?? ""));
}

export function defaultModelFor(providerId) {
  return MODEL_CATALOG[providerId]?.default ?? "";
}

export function suggestedModelsFor(providerId) {
  return [...(MODEL_CATALOG[providerId]?.suggested ?? [])];
}

export function exampleModelsFor(providerId) {
  return [...(MODEL_CATALOG[providerId]?.examples ?? [])];
}

const GEMINI_NATIVE_HOST = "generativelanguage.googleapis.com";
const ANTHROPIC_HOST = "api.anthropic.com";

// Modalities a chat picker must not offer (the provider's /models list is the
// provider's own, but embeddings / speech / image / moderation ids can never
// answer a chat completion).
const NON_CHAT = /embed|tts|whisper|transcri|audio|realtime|moderation|dall-e|image|imagen|veo|video|live|sora|lyria|banana|search-|computer-use|batch|-tuning|aqa|bison|gecko/i;

// Newest generation first (the number after the family name), then the
// family name itself, so a provider's long tail reads gpt-5.x before gpt-4.x.
function versionOf(id) {
  const m = String(id).match(/(\d+)(?:\.(\d+))?/);
  return m ? [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] : [0, 0];
}
function newestFirst(a, b) {
  const [am, an] = versionOf(a);
  const [bm, bn] = versionOf(b);
  if (bm !== am) return bm - am;
  if (bn !== an) return bn - an;
  return a.localeCompare(b);
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

/**
 * The provider's LIVE model list, for the Settings picker to merge below the
 * catalogue suggestions once a key is entered.
 *   - OpenAI-compatible endpoints (OpenAI, Grok/x.ai, Z.ai, Ollama, LM Studio,
 *     DeepSeek, any BYO base URL): GET `${baseURL}/models` with the Bearer key.
 *   - Gemini on its default endpoint: the native `/v1beta/models?key=` list
 *     (the OpenAI-compatible `/models` route is not the canonical list);
 *     the `models/` prefix is normalised away.
 *   - Anthropic on its default endpoint: `/v1/models` with the x-api-key header.
 * 10 s timeout. Returns a de-duplicated, sorted, chat-only id list with the
 * pricing-tier pseudo-ids dropped. NEVER throws: every failure is [] and the
 * logged reason passes safeProviderError (the URL with `key=` is never logged).
 */
export async function fetchLiveModels(providerId, { baseURL, apiKey, signal } = {}) {
  const base = String(baseURL ?? "").replace(/\/+$/, "");
  const key = String(apiKey ?? "").trim();
  if (!base) return [];
  const host = hostOf(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  if (signal) signal.addEventListener?.("abort", () => controller.abort(), { once: true });
  // dptw (2026-09-03): complete listings — every page is followed and no id
  // is dropped for its length. pageSize/limit query params ask for the
  // provider's largest page; pagination cursors walk the rest.
  let url = `${base}/models`;
  const headers = { Accept: "application/json" };
  let extract = (json) => (Array.isArray(json?.data) ? json.data : []).map((m) => m?.id);
  let nextUrl = null; // (json) => next page URL or null
  if (providerId === "gemini" && host === GEMINI_NATIVE_HOST) {
    url = `https://${GEMINI_NATIVE_HOST}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`;
    extract = (json) => (Array.isArray(json?.models) ? json.models : []).map((m) => String(m?.name ?? "").replace(/^models\//, ""));
    nextUrl = (json) => {
      const token = typeof json?.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : null;
      return token
        ? `https://${GEMINI_NATIVE_HOST}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000&pageToken=${encodeURIComponent(token)}`
        : null;
    };
  } else if (providerId === "anthropic" && host === ANTHROPIC_HOST) {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    url = `${base}/models?limit=1000`;
    // Anthropic models list paginates with after_id (the last id seen) while
    // has_more is true.
    nextUrl = (json) => {
      if (json?.has_more !== true) return null;
      const last = typeof json?.last_id === "string" && json.last_id
        ? json.last_id
        : (Array.isArray(json?.data) && json.data.length ? json.data[json.data.length - 1]?.id : null);
      return typeof last === "string" && last
        ? `${base}/models?limit=1000&after_id=${encodeURIComponent(last)}`
        : null;
    };
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  try {
    const allIds = [];
    for (let page = 0; page < 100 && url; page++) {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) return page === 0 ? [] : [...new Set(allIds)].sort(newestFirst);
      const json = await res.json();
      allIds.push(...extract(json));
      url = nextUrl ? nextUrl(json) : null;
    }
    const ids = allIds
      .filter((id) => typeof id === "string" && id.length > 0)
      .filter((id) => !isPricingTierId(id))
      .filter((id) => !NON_CHAT.test(id));
    return [...new Set(ids)].sort(newestFirst);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[model-catalog] live model list unavailable: ${safeProviderError(String(e?.message ?? e), key ? [key] : [])}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
