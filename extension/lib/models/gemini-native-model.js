// lib/models/gemini-native-model.js — the NATIVE Gemini lane.
//
// Gemini's OpenAI-compatible endpoint (generativelanguage.googleapis.com/
// v1beta/openai) SILENTLY DROPS provider-defined server tools (google_search,
// url_context, code_execution) — only standard function tools survive. Provider
// server tools (extension/lib/provider-server-tools.js) therefore require the
// native API via @ai-sdk/google. This factory keeps the same credential, the
// same secret-safe logging fetch, and the same middleware stack as the
// compatible adapter; thoughtSignatureMiddleware is a no-op on the native path
// (the key is already "google") and stays for uniformity.

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { wrapLanguageModel } from "ai";
import { normaliseModelId } from "./model-name.js";
import { thoughtSignatureMiddleware } from "./thought-signature-middleware.js";
import { toolCallFinishMiddleware } from "./tool-call-finish-middleware.js";
import { makeLoggingFetch } from "./openai-model.js";

/** The well-known Gemini OpenAI-compatible endpoint preset. A stored config
 * with THIS base URL (or none) means "the real Gemini API" and routes native;
 * any OTHER base URL is a BYO/proxy endpoint and stays on the compatible
 * adapter (provider server tools then report unavailable, honestly). */
export const GEMINI_COMPAT_DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

export function isDefaultGeminiEndpoint(baseURL) {
  const url = String(baseURL ?? "").trim().replace(/\/+$/u, "");
  return url === "" || url === GEMINI_COMPAT_DEFAULT_BASE_URL;
}

export function normaliseGeminiNativeModelId(model) {
  return normaliseModelId(model, GEMINI_COMPAT_DEFAULT_BASE_URL);
}

export function createGeminiNativeModel(config) {
  const { apiKey, model } = config ?? {};
  if (!apiKey || !model) {
    throw new Error("Gemini native provider requires apiKey and model");
  }
  const resolvedModel = normaliseGeminiNativeModelId(model);
  const google = createGoogleGenerativeAI({
    apiKey,
    fetch: makeLoggingFetch([apiKey]),
  });
  return wrapLanguageModel({
    model: google(resolvedModel),
    middleware: [
      thoughtSignatureMiddleware(),
      toolCallFinishMiddleware(),
    ],
  });
}
