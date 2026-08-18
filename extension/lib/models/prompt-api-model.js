// lib/models/prompt-api-model.js — best-effort adapter for Chrome's built-in
// Prompt API (Gemini nano), wrapped as a LanguageModelV2 so it plugs into the
// agent-do loop with NO key and NO network. The Prompt API is available in
// Chrome when enabled (chrome://flags → Prompt API for Gemini Nano) with the
// model downloaded. When it is NOT available, the caller must fall back to the
// demo model — this adapter never fakes success.
//
// THE TRUE FINAL REQUEST BOUNDARY (the review's provider-bound capture
// blocker): the run-bound prompt attestation observes the AI-SDK options at
// doGenerate/doStream. For this provider, what Gemini nano ACTUALLY receives
// is (a) the session's systemPrompt and (b) the session.prompt(text) input.
// An earlier version created the session ONCE with a hard-coded system prompt
// and flattened the whole AI-SDK prompt into the user text — so the captured
// attestation did NOT describe the real provider request (the real session
// system prompt differed, and message roles were lost). Now the adapter binds
// capture EXACTLY: the AI-SDK system message becomes the session's
// systemPrompt VERBATIM (a fresh session per call — a session's systemPrompt
// is immutable), and the remaining messages are serialized WITH their roles,
// so what the attestation captures is byte-for-byte what the provider gets.

/** Extract the exact system message an AI-SDK LanguageModel call carries
 * (options.system, or the role:"system" prompt messages) — the same shape the
 * attestation boundary in lib/agent.js captures, so the provider session is
 * bound to byte-for-byte what the attestation observed. */
function extractSystemMessage(options) {
  if (typeof options?.system === "string" && options.system) return options.system;
  const msgs = Array.isArray(options?.prompt) ? options.prompt : [];
  return msgs
    .filter((m) => m?.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => p?.text ?? "").join("")
          : ""
    )
    .join("\n");
}

/** Serialize the NON-system messages into a role-preserving transcript: every
 * message is labelled with its role, so user/assistant/tool content is never
 * misrepresented as one undifferentiated user turn. */
function serializeMessages(options) {
  const msgs = (Array.isArray(options?.prompt) ? options.prompt : [])
    .filter((m) => m?.role !== "system");
  const out = [];
  for (const msg of msgs) {
    const role = String(msg?.role ?? "user");
    const c = msg?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "text") text += part.text;
        else if (part?.type === "tool-result") {
          try {
            text += `\n[tool result]\n${JSON.stringify(part?.result ?? part?.output ?? "")}`;
          } catch { text += "\n[tool result]"; }
        } else if (part?.type === "tool-call") {
          try {
            text += `\n[tool call ${part?.toolName ?? "tool"}]\n${JSON.stringify(part?.args ?? part?.input ?? "")}`;
          } catch { text += `\n[tool call ${part?.toolName ?? "tool"}]`; }
        }
      }
    }
    out.push(`${role}:\n${text}`);
  }
  return out.join("\n\n");
}

// The Prompt API reports NO token counts (its usage comes back 0/0), which the
// usage ledger then DROPS (usage.js returns on 0/0) — so on-device runs were
// completely invisible in usage accounting (GLM-5.3 O3). Emit an ESTIMATE so the
// on-device provider still shows as a real (zero-cost) row: ~4 chars/token is the
// standard rough heuristic, and the estimatedCost stays 0 (on-device is free).
function estimateTokens(text) {
  const chars = String(text ?? "").length;
  return chars === 0 ? 0 : Math.max(1, Math.ceil(chars / 4));
}
export { estimateTokens };

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

  // A FRESH session per call, bound to the EXACT system message the AI-SDK
  // layer carried (the attestation boundary observes the same options, so the
  // captured digest describes the real provider request). A session's
  // systemPrompt is immutable, so reuse across differing compositions would
  // silently bind the wrong system prompt — never cached.
  const createSession = async (systemPrompt) => {
    // The Prompt API rejects a session that specifies topK without temperature
    // (or vice versa) with NotSupportedError. Pass BOTH together, or neither.
    // topK: 40 + temperature: 0.4 is a deterministic, agent-appropriate default.
    try {
      return await api.create({
        systemPrompt: systemPrompt || undefined,
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
      const system = extractSystemMessage(options);
      const text = serializeMessages(options);
      const s = await createSession(system);
      try {
        const out = await s.prompt(text);
        const inputTokens = estimateTokens(system + text);
        const outputTokens = estimateTokens(out);
        return {
          content: [{ type: "text", text: out }],
          finishReason: "stop",
          // Estimated (the Prompt API reports no counts); zero-cost on-device.
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          warnings: [],
        };
      } finally {
        // Release the per-call session (the on-device model's context window
        // is a real resource; a leaked session per run would exhaust it).
        try { s.destroy?.(); } catch { /* best-effort */ }
      }
    },

    async doStream(options) {
      const system = extractSystemMessage(options);
      const text = serializeMessages(options);
      const inputTokens = estimateTokens(system + text);
      const s = await createSession(system);
      const stream = s.promptStreaming(text);
      const id = `prompt-${crypto.randomUUID?.() ?? Math.random()}`;
      const readable = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id });
          let outText = "";
          const reader = stream.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              outText += value ?? "";
              controller.enqueue({ type: "text-delta", id, delta: value });
            }
            controller.enqueue({ type: "text-end", id });
            const outputTokens = estimateTokens(outText);
            controller.enqueue({
              type: "finish",
              // Estimated (the Prompt API reports no counts); zero-cost on-device.
              usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
              finishReason: "stop",
            });
            controller.close();
          } catch (e) {
            controller.error(e);
          } finally {
            try { s.destroy?.(); } catch { /* best-effort */ }
          }
        },
      });
      return { stream: readable };
    },
  };
}
