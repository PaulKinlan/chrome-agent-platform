// lib/models/prompt-api-model.js — best-effort adapter for Chrome's built-in
// Prompt API (Gemini nano), wrapped as a LanguageModelV2 so it plugs into the
// agent-do loop with NO key and NO network. The Prompt API is available in
// Chrome when enabled (chrome://flags → Prompt API for Gemini Nano) with the
// model downloaded. When it is NOT available, the caller must fall back to the
// demo model — this adapter never fakes success.

function extractText(prompt) {
  let out = "";
  for (const msg of prompt ?? []) {
    const c = msg?.content;
    if (typeof c === "string") out += c;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "text") out += part.text;
      }
    }
  }
  return out;
}

function getPromptApi() {
  const g = globalThis;
  // Chrome exposes the Prompt API as `LanguageModel` (older) or via `window.ai.languageModel` (newer).
  if (typeof g.LanguageModel === "function") return g.LanguageModel;
  if (g.ai && typeof g.ai.languageModel?.create === "function") return g.ai.languageModel;
  return null;
}

export async function isPromptApiAvailable() {
  try {
    const api = getPromptApi();
    if (!api) return false;
    if (typeof api.capabilities === "function") {
      const caps = await api.capabilities();
      return caps?.available === "readily" || caps?.available === "after-download";
    }
    if (typeof api.availability === "function") {
      return (await api.availability()) === "available";
    }
    return true; // a create function exists; assume usable and let the call fail honestly
  } catch {
    return false;
  }
}

export function createPromptApiModel() {
  const api = getPromptApi();
  if (!api) throw new Error("Chrome Prompt API not available");

  let session = null;
  const ensureSession = async () => {
    if (session) return session;
    // The Prompt API rejects a session that specifies topK without temperature
    // (or vice versa) with NotSupportedError. Pass BOTH together, or neither.
    // topK: 40 + temperature: 0.4 is a deterministic, agent-appropriate default.
    try {
      session = await api.create({
        systemPrompt:
          "You are the Chrome Agent Platform hub agent. Be concise and helpful.",
        topK: 40,
        temperature: 0.4,
      });
    } catch (err) {
      const msg = err?.message ?? String(err);
      // Distinguish the common failure modes so the agent sees a clear,
      // actionable error instead of a generic "no output" crash.
      if (/topK|temperature/i.test(msg)) {
        throw new Error(`Chrome Prompt API session failed: ${msg}`);
      }
      if (/download|not available|not supported/i.test(msg)) {
        throw new Error(
          "Chrome Prompt API (Gemini nano) model is not ready — download it via chrome://flags or wait for it to finish downloading.",
        );
      }
      throw new Error(`Chrome Prompt API session failed: ${msg}`);
    }
    return session;
  };

  return {
    // v2 is the known-good LanguageModel spec this adapter implements; the AI
    // SDK logs a benign "v2 compatibility mode" warning and runs it via its
    // v2→current compat layer (the Prompt API exposes none of the v3/v4
    // features that would justify the larger migration).
    specificationVersion: "v2",
    provider: "chrome-prompt-api",
    modelId: "gemini-nano",
    supportedUrls: {},

    async doGenerate(options) {
      const s = await ensureSession();
      const text = extractText(options.prompt);
      const out = await s.prompt(text);
      return {
        content: [{ type: "text", text: out }],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, // Prompt API doesn't report tokens
        warnings: [],
      };
    },

    async doStream(options) {
      const s = await ensureSession();
      const text = extractText(options.prompt);
      const stream = s.promptStreaming(text);
      const id = `prompt-${crypto.randomUUID?.() ?? Math.random()}`;
      const readable = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id });
          const reader = stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue({ type: "text-delta", id, delta: value });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: "stop",
          });
          controller.close();
        },
      });
      return { stream: readable };
    },
  };
}
