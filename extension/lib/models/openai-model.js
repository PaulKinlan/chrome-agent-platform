// lib/models/openai-model.js — the real, configurable provider.
//
// Uses the Vercel AI SDK's @ai-sdk/openai createOpenAI with the user's OWN
// base URL + API key + model id (stored in chrome.storage settings). This is
// a genuine model — it calls the user's endpoint. It is never a fake label and
// the extension never ships the owner's keys.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { normaliseModelId } from "./model-name.js";
import { thoughtSignatureMiddleware } from "./thought-signature-middleware.js";
import { toolCallFinishMiddleware } from "./tool-call-finish-middleware.js";
import { safeProviderError } from "../pure.js";

// A single, deduped per-(url,status) log so a failing provider logs its HTTP
// status + body ONCE (not once per retry attempt). The extension's describeError
// already surfaces the actionable message; this makes the RAW console show the
// real reason instead of a generic AI_APICallError. The body is
// SECRET-SAFE: a custom endpoint can echo the Authorization credential back in
// its error body, so it passes safeProviderError (known-secret + pattern
// redaction + bounded length) BEFORE it ever reaches the console (the sol
// review's HIGH-2). The configured key is threaded in per-config via
// _makeLoggingFetch below.
const _loggedFetchFailures = new Set();

export function makeLoggingFetch(knownSecrets = []) {
  return async function _loggingFetch(input, init) {
    const res = await fetch(input, init);
    if (!res.ok) {
      const url = typeof input === "string" ? input : input?.url ?? "(provider)";
      // SECRET-SAFE URL: credentials masked + the query dropped, bounded as the
      // dedupe key too (the final review's HIGH — a raw unbounded URL was both
      // printed and used as the dedupe key).
      const safeUrl = (() => {
        try {
          const u = new URL(url);
          if (u.username) u.username = "[REDACTED]";
          if (u.password) u.password = "";
          u.search = "";
          return u.toString().slice(0, 300);
        } catch {
          return safeProviderError(url);
        }
      })();
      const key = `${safeUrl}::${res.status}`;
      if (!_loggedFetchFailures.has(key)) {
        _loggedFetchFailures.add(key);
        if (_loggedFetchFailures.size > 200) {
          _loggedFetchFailures.delete(_loggedFetchFailures.values().next().value);
        }
        let body = "";
        try {
          body = await res.clone().text();
        } catch { /* ignore */ }
        // eslint-disable-next-line no-console
        console.error(
          `[provider] HTTP ${res.status} from ${safeUrl}${body ? ` — ${safeProviderError(body, knownSecrets)}` : ""}`,
        );
      }
    }
    return res;
  };
}

/** True for OpenAI's own endpoint (api.openai.com), where the gpt-5.x request
 * rules below apply. A BYO/proxy/other-vendor base URL is never OpenAI. */
export function isOpenAIEndpoint(baseURL) {
  try {
    return new URL(String(baseURL ?? "")).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/** Whether a request to `baseURL` for `model` must carry
 * `reasoning_effort: "none"`: OpenAI's /chat/completions refuses function tools
 * on every gpt-5.x unless the effort is "none" (HTTP 400 "Function tools with
 * reasoning_effort are not supported … set reasoning_effort to 'none'" — every
 * gpt-5.6 hub call failed on the first step, 2026-08-30 models lane). "none" is
 * accepted by gpt-5.5 and gpt-5.4-mini too (probe: 200), so it is applied to
 * the whole gpt-5 family. Grok/Z.ai/Ollama/BYO do not know the field, so a
 * non-OpenAI base URL never gets it. */
export function needsReasoningEffortNone(baseURL, model) {
  return isOpenAIEndpoint(baseURL) && /^gpt-5/i.test(String(model ?? ""));
}

// The request-shape rule lives in the ADAPTER (not the logging fetch): the
// SDK forwards `providerOptions.<providerName>.reasoningEffort` into the wire
// body as `reasoning_effort`, so a transformParams middleware sets it unless a
// caller already chose an effort explicitly.
function openaiReasoningEffortMiddleware(providerName) {
  return {
    middlewareVersion: "v2",
    transformParams: async ({ params }) => {
      const prev = params.providerOptions?.[providerName] ?? {};
      if (prev.reasoningEffort != null) return params;
      return {
        ...params,
        providerOptions: {
          ...(params.providerOptions ?? {}),
          [providerName]: { ...prev, reasoningEffort: "none" },
        },
      };
    },
  };
}

// The Gemini OpenAI-compatible endpoint rejects a model name with the wrong
// format (spaces/casing) with HTTP 400 "unexpected model name format".
// normaliseModelId handles that ("Gemini 3.7 Flash" → "gemini-3.7-flash").
export function createOpenAICompatibleModel(config) {
  const { baseURL, apiKey, model } = config ?? {};
  // baseURL + model are always required; apiKey is OPTIONAL (local Ollama has
  // no key). The SDK accepts an empty-string key for keyless local endpoints.
  if (!baseURL || !model) {
    throw new Error("OpenAI-compatible provider requires baseURL and model");
  }
  const resolvedModel = normaliseModelId(model, baseURL);
  const providerName = "configured";
  const openai = createOpenAICompatible({
    baseURL,
    apiKey: apiKey ?? "",
    name: providerName,
    // Ask the provider to include token usage in the streaming response. The
    // AI SDK only forwards `stream_options: { include_usage: true }` when this
    // is set (dist: "only include stream_options when in strict compatibility
    // mode"). WITHOUT it most OpenAI-compatible endpoints omit usage from the
    // stream, so agent-do's onStepEnd sees step.usage === undefined and records
    // 0 — which recordUsage then drops (inputTokens===0 && outputTokens===0),
    // yielding ZERO usage rows. This is the root cause of "usage calls/tokens
    // aren't working" (every real provider — openai/anthropic/gemini/deepseek/
    // BYO-endpoint — routes through this adapter).
    includeUsage: true,
    // Intercept the provider fetch to log the real HTTP status/body ONCE (the
    // SDK's AI_APICallError message is generic). The SDK still throws the
    // AI_APICallError with statusCode/responseBody for describeError to map.
    fetch: makeLoggingFetch(apiKey ? [apiKey] : []),
  });
  const provider = openai(resolvedModel);
  // Gemini requires the thought_signature back in the next tool-call round-trip;
  // the OpenAI-compat provider stores it under providerMetadata but reads it from
  // providerOptions.google — patch that mismatch so tool calls don't 400.
  return wrapLanguageModel({
    model: provider,
    middleware: [
      ...(needsReasoningEffortNone(baseURL, resolvedModel)
        ? [openaiReasoningEffortMiddleware(providerName)]
        : []),
      thoughtSignatureMiddleware(),
      toolCallFinishMiddleware(),
    ],
  });
}
