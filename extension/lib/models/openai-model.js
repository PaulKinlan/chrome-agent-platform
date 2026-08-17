// lib/models/openai-model.js — the real, configurable provider.
//
// Uses the Vercel AI SDK's @ai-sdk/openai createOpenAI with the user's OWN
// base URL + API key + model id (stored in chrome.storage settings). This is
// a genuine model — it calls the user's endpoint. It is never a fake label and
// the extension never ships the owner's keys.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { normaliseModelId } from "./model-name.js";

// A single, deduped per-(url,status) log so a failing provider logs its HTTP
// status + body ONCE (not once per retry attempt). The extension's describeError
// already surfaces the actionable message; this makes the RAW console show the
// real reason instead of a generic AI_APICallError.
const _loggedFetchFailures = new Set();

async function _loggingFetch(input, init) {
  const res = await fetch(input, init);
  if (!res.ok) {
    const url = typeof input === "string" ? input : input?.url ?? "(provider)";
    const key = `${url}::${res.status}`;
    if (!_loggedFetchFailures.has(key)) {
      _loggedFetchFailures.add(key);
      let body = "";
      try {
        body = await res.clone().text();
      } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.error(
        `[provider] HTTP ${res.status} from ${url}${body ? ` — ${body}` : ""}`,
      );
    }
  }
  return res;
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
  const openai = createOpenAICompatible({
    baseURL,
    apiKey: apiKey ?? "",
    name: "configured",
    // Intercept the provider fetch to log the real HTTP status/body ONCE (the
    // SDK's AI_APICallError message is generic). The SDK still throws the
    // AI_APICallError with statusCode/responseBody for describeError to map.
    fetch: _loggingFetch,
  });
  return openai(resolvedModel);
}
