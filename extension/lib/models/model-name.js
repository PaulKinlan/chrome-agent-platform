// lib/models/model-name.js — pure model-id normalisation (no AI SDK/chrome).
//
// The Gemini OpenAI-compatible endpoint rejects a model name with the wrong
// format (spaces/casing) with HTTP 400 "unexpected model name format". Normalise
// a user-entered model id ("Gemini 3.7 Flash" → "gemini-3.7-flash") so both the
// dropdown AND a hand-typed model work. Non-Gemini providers are left untouched
// (their model ids are not all lowercase/hyphenated — e.g. "gpt-4o", "claude-3.5").

export function normaliseModelId(model, baseURL) {
  if (!model || typeof model !== "string") return model;
  const isGemini = /generativelanguage\.googleapis\.com/.test(
    String(baseURL ?? ""),
  );
  if (!isGemini) return model;
  return model.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");
}
