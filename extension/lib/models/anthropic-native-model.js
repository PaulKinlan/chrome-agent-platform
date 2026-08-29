// lib/models/anthropic-native-model.js — the NATIVE Anthropic lane.
//
// Anthropic's OpenAI-compatible endpoint (api.anthropic.com/v1 chat-completions
// shim) does not carry provider-defined server tools (web_search_20250305 et
// al.) — only standard function tools survive. Provider server tools
// (extension/lib/provider-server-tools.js) therefore require the native
// Messages API via @ai-sdk/anthropic. This factory mirrors the Gemini native
// lane: same credential, same secret-safe logging fetch, same middleware stack.

import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel } from "ai";
import { thoughtSignatureMiddleware } from "./thought-signature-middleware.js";
import { toolCallFinishMiddleware } from "./tool-call-finish-middleware.js";
import { makeLoggingFetch } from "./openai-model.js";

/** The well-known Anthropic OpenAI-compatible endpoint preset. A stored config
 * with THIS base URL (or none) means "the real Anthropic API" and routes
 * native; any OTHER base URL is a BYO/proxy endpoint and stays on the
 * compatible adapter (provider server tools then report unavailable,
 * honestly). */
export const ANTHROPIC_COMPAT_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

export function isDefaultAnthropicEndpoint(baseURL) {
  const url = String(baseURL ?? "").trim().replace(/\/+$/u, "");
  return url === "" || url === ANTHROPIC_COMPAT_DEFAULT_BASE_URL;
}

export function createAnthropicNativeModel(config) {
  const { apiKey, model } = config ?? {};
  if (!apiKey || !model) {
    throw new Error("Anthropic native provider requires apiKey and model");
  }
  const anthropic = createAnthropic({
    apiKey,
    fetch: makeLoggingFetch([apiKey]),
  });
  return wrapLanguageModel({
    model: anthropic(String(model).trim()),
    middleware: [
      thoughtSignatureMiddleware(),
      toolCallFinishMiddleware(),
    ],
  });
}
