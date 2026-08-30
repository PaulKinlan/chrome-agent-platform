// lib/provider-test.js — "Test connection" for the provider cards.
//
// A minimal, real round-trip per provider so the user can confirm their key +
// model id actually work before relying on them:
//   - demo             → always succeeds (deterministic local model).
//   - prompt-api       → probes the on-device Chrome Prompt API session.
//   - openai-compatible→ a tiny `/chat/completions` call to the configured base URL.
//
// The function is PURE (no chrome.*, no kv, no DOM) so it is unit-testable;
// the options page owns the DOM (button + loading + result states). A fetch
// from an extension page is subject to the provider's CORS policy — a CORS
// rejection surfaces as a clear network error, never a false success.

import {
  createPromptApiModel,
  isPromptApiAvailable,
} from "./models/prompt-api-model.js";
import { safeProviderError } from "./pure.js";
import { isOpenAIEndpoint } from "./models/openai-model.js";

// OpenAI-compatible providers (every cloud provider advertised goes through the
// same adapter + endpoint).
const OPENAI_COMPATIBLE_IDS = new Set([
  "openai",
  "openai-compatible",
  "anthropic",
  "gemini",
  "deepseek",
  "ollama",
]);

/** Map an HTTP status to a stable error kind so the UI can show a specific,
 * actionable message (invalid key vs invalid model vs rate-limit). */
export function errorKindForStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "http";
}

/**
 * The probe body. ONE request shape with the hub (CAP-FB-20260830-MODEL-CATALOG-
 * CURRENT-01): every current OpenAI model rejects `max_tokens` (HTTP 400
 * unsupported_parameter — use `max_completion_tokens`), and OpenAI's gpt-5.x
 * refuses function tools unless `reasoning_effort` is "none", which the hub's
 * adapter now sends — so the probe sends it too, and a green Test predicts a
 * working run. Other endpoints (Gemini compat, Grok, Z.ai, Ollama) accept the
 * token cap and do not know the reasoning field, so it is OpenAI-only.
 * Exported PURE so the shape is unit-tested without a fetch.
 */
export function buildProbeBody({ baseURL, model } = {}) {
  const body = {
    model: String(model ?? ""),
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_completion_tokens: 8,
    stream: false,
  };
  if (isOpenAIEndpoint(baseURL) && /^gpt-5/i.test(body.model)) body.reasoning_effort = "none";
  return body;
}

/**
 * @param {object} p a provider preset { id, name, baseURL, needsKey, needsModel }
 * @param {object} fields { baseURL, apiKey, model }
 * @returns {Promise<{ok:boolean, latencyMs:number, detail?:string, error?:string, errorKind?:string, status?:number}>}
 */
export async function testProvider(p, fields = {}) {
  const t0 = performance.now();
  const latency = () => Math.max(0, Math.round(performance.now() - t0));

  if (p.id === "demo") {
    return {
      ok: true,
      latencyMs: latency(),
      detail: "Demo (local) — deterministic, no network, always works.",
    };
  }

  if (p.id === "prompt-api") {
    if (!(await isPromptApiAvailable())) {
      return {
        ok: false,
        latencyMs: latency(),
        errorKind: "unavailable",
        error:
          "Chrome Prompt API (Gemini nano) is not available — enable it in chrome://flags and download the model.",
      };
    }
    try {
      const model = createPromptApiModel();
      const out = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] },
        ],
      });
      const text = String(out?.content?.[0]?.text ?? "").trim();
      return {
        ok: true,
        latencyMs: latency(),
        detail: `Prompt API responded (${text ? JSON.stringify(text.slice(0, 30)) : "no text"}).`,
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: latency(),
        errorKind: "error",
        error: String(e?.message ?? e),
      };
    }
  }

  if (!OPENAI_COMPATIBLE_IDS.has(p.id)) {
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "config",
      error: `Unknown provider "${p.id}".`,
    };
  }

  const baseURL = String(fields.baseURL || p.baseURL || "").replace(/\/+$/, "");
  const apiKey = String(fields.apiKey ?? "").trim();
  const model = String(fields.model ?? "").trim();

  if (!baseURL || !model) {
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "config",
      error: `Missing ${!baseURL ? "base URL" : "model id"} — fill it in, then test.`,
    };
  }
  if (p.needsKey !== false && !apiKey) {
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "config",
      error: "Missing API key — enter it, then test.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(buildProbeBody({ baseURL, model })),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      return {
        ok: true,
        latencyMs: latency(),
        status: res.status,
        detail: `Model "${model}" responded (HTTP ${res.status}).`,
      };
    }

    // Non-2xx: surface the provider's specific error (invalid key, unknown
    // model) — SECRET-SAFE: a custom endpoint can echo the Authorization
    // credential in its error body, so the message is redacted (the configured
    // key + any pattern-embedded credential) and bounded before it reaches
    // the Settings UI (the sol review's HIGH-2).
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      // Providers differ in error shape: OpenAI `{error:{message}}`, Gemini's
      // OpenAI-compatible endpoint `[{error:{message}}]`, some `{message}`.
      const first = Array.isArray(err) ? err[0] : err;
      msg =
        first?.error?.message ||
        first?.error?.code ||
        first?.error?.status ||
        first?.error?.type ||
        first?.message ||
        msg;
    } catch {
      /* non-JSON error body — keep the status */
    }
    return {
      ok: false,
      latencyMs: latency(),
      status: res.status,
      errorKind: errorKindForStatus(res.status),
      error: safeProviderError(msg, apiKey ? [apiKey] : []),
    };
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") {
      return {
        ok: false,
        latencyMs: latency(),
        errorKind: "timeout",
        error: "Timed out after 20s — check the base URL / network.",
      };
    }
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "network",
      // The fetch failure text can embed the URL (with credentials) or a
      // header the endpoint echoed — redact + bound it (HIGH-2).
      error: safeProviderError(`Unreachable: ${String(e?.message ?? e)}`, apiKey ? [apiKey] : []),
    };
  }
}
