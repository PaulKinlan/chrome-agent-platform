// lib/models/thought-signature-middleware.js — preserve Gemini thought signatures
// across the tool-call round-trip.
//
// Gemini's OpenAI-compatible endpoint emits a `thought_signature` in the response's
// `extra_content.google.thought_signature` and REQUIRES it back in the next
// request's functionCall parts (the tool-call round-trip), or it 400s with:
//   "Function call is missing a thought_signature in functionCall parts".
//
// The AI SDK (@ai-sdk/openai-compatible v3) RESPONSE-side stores the signature
// under `part.providerMetadata.<providerName>.thoughtSignature`, and the SDK's
// message conversion (`convertToModelMessages`) copies it to
// `part.providerOptions.<providerName>.thoughtSignature`. But the provider's
// REQUEST-side reads `part.providerOptions.google.thoughtSignature` (hardcoded
// "google") — the key never matches (our provider name is "configured"), so the
// signature is dropped and every tool-call round-trip 400s.
//
// This middleware (wrapLanguageModel) fixes the request side: on transformParams
// it copies any thought signature found under `providerMetadata.*` or
// `providerOptions.<any key>` into `providerOptions.google.thoughtSignature`,
// which the provider reads.

const GOOGLE_KEY = "google";

function firstThoughtSignature(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of Object.keys(obj)) {
    if (key === GOOGLE_KEY) {
      // If it's already under google, return it (and it's already correct).
      const v = obj[key]?.thoughtSignature ?? obj[key]?.thought_signature;
      if (v != null) return String(v);
      continue;
    }
    const v = obj[key]?.thoughtSignature ?? obj[key]?.thought_signature;
    if (v != null) return String(v);
  }
  return undefined;
}

function moveThoughtSignature(part) {
  if (!part || part.type !== "tool-call") return part;
  const fromMetadata = firstThoughtSignature(part.providerMetadata);
  const fromOptions = firstThoughtSignature(part.providerOptions);
  const ts = fromMetadata ?? fromOptions;
  if (ts == null) return part;
  const existing = part.providerOptions?.[GOOGLE_KEY] ?? {};
  // Only rewrite if the value isn't already there and correct.
  if (existing.thoughtSignature === ts) return part;
  return {
    ...part,
    providerOptions: {
      ...(part.providerOptions ?? {}),
      [GOOGLE_KEY]: { ...existing, thoughtSignature: ts },
    },
  };
}

export function thoughtSignatureMiddleware() {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const prompt = params?.prompt;
      if (!Array.isArray(prompt)) return params;
      let changed = false;
      const nextPrompt = prompt.map((message) => {
        if (message?.role !== "assistant") return message;
        const content = message.content;
        if (!Array.isArray(content)) return message;
        const nextContent = content.map((part) => {
          if (part?.type !== "tool-call") return part;
          const next = moveThoughtSignature(part);
          if (next !== part) changed = true;
          return next;
        });
        return changed ? { ...message, content: nextContent } : message;
      });
      if (!changed) return params;
      return { ...params, prompt: nextPrompt };
    },
  };
}
