// lib/models/demo-model.js — a minimal, honest LanguageModelV2 (AI SDK v7)
// that always returns a deterministic response. This is the ZERO-CONFIG
// default so the agent loop genuinely runs end-to-end with no API key or
// downloaded model. It is CLEARLY labelled "demo mode" — never claimed to be a
// real model. The real providers (OpenAI-compatible, Prompt API) plug in over
// the same interface.
//
// DEMO TOOL-CALLING MODE: a task containing the marker "@demo-tools" makes the
// demo model deterministically issue REAL tool calls (memory_set + memory_get)
// on the first model step, then read the tool results and emit a final text.
// This is a deterministic LOCAL path for real-extension evidence: the PRODUCTION
// journal writer (journalingProgress) persists the resulting tool-call/
// tool-result rows exactly as it would for a real provider, so a reload +
// reopen can assert the restored terminal cards — no API key, no host grant.

const TOOLS_MARKER = "@demo-tools";

function extractText(prompt) {
  // prompt is a LanguageModelV2Prompt: array of { role, content } messages.
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

/** The demo tool-calling mode is requested when the LAST user turn contains the
 * marker (deterministic + explicit — never accidentally triggered). */
function wantsDemoTools(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  return extractText([last]).toLowerCase().includes(TOOLS_MARKER);
}

/** How many tool RESULTS the conversation already carries. The demo tools run
 * in SEQUENCED steps (the agent-do loop calls the model after each tool
 * execution): step 1 memory_set, step 2 memory_get, step 3 a SECOND memory_get
 * (two same-name calls — the persisted-replay evidence), step 4 the final
 * text. Counting results keeps the sequence deterministic + independent (each
 * step's tool result is a prerequisite for the next). */
function toolResultCount(prompt) {
  return (Array.isArray(prompt) ? prompt : []).filter((m) => m?.role === "tool").length;
}

// A deterministic, RICH tool-call payload (nested arrays/objects/unicode — the
// structured renderer's showcase + the journal's real persisted rows).
const DEMO_ARGS = {
  key: "demo",
  value: {
    items: [
      { name: "Espresso machine", qty: 1, tags: ["kitchen", "appliance"], note: "ünïçødé 日本語" },
      { name: "AeroPress", qty: 2, tags: ["kitchen"] },
    ],
    total: 3.5,
    active: true,
    meta: { nested: { deep: [1, [2, [3]]], ratio: 0.75 } },
  },
};

export function createDemoModel() {
  return {
    specificationVersion: "v2",
    provider: "demo",
    modelId: "demo-local",
    supportedUrls: {},

    doGenerate(options) {
      const text = extractText(options.prompt);
      const results = toolResultCount(options.prompt);
      if (wantsDemoTools(options.prompt)) {
        if (results === 0) {
          return Promise.resolve({
            content: [{ type: "tool-call", toolCallId: "call_demo_set", toolName: "memory_set", input: JSON.stringify(DEMO_ARGS) }],
            finishReason: "tool-calls",
            usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
            warnings: [],
          });
        }
        if (results === 1) {
          return Promise.resolve({
            content: [{ type: "tool-call", toolCallId: "call_demo_get_1", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) }],
            finishReason: "tool-calls",
            usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
            warnings: [],
          });
        }
        if (results === 2) {
          // a SECOND same-name call — the persisted replay must keep them distinct
          return Promise.resolve({
            content: [{ type: "tool-call", toolCallId: "call_demo_get_2", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) }],
            finishReason: "tool-calls",
            usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
            warnings: [],
          });
        }
      }
      const response = `[demo model] I received "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}". ` +
        `This is a deterministic demo response — configure a real provider (OpenAI-compatible endpoint) ` +
        `in Settings to get real completions.`;
      return Promise.resolve({
        content: [{ type: "text", text: response }],
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
        warnings: [],
      });
    },

    doStream(options) {
      const text = extractText(options.prompt);
      const wantsTools = wantsDemoTools(options.prompt);
      const results = toolResultCount(options.prompt);
      const id = `demo-${crypto.randomUUID?.() ?? Math.random()}`;
      const usage = { inputTokens: 8, outputTokens: 32, totalTokens: 40 };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (wantsTools && results === 0) {
            // STEP 1: deterministically request the REAL demo memory_set
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_set", toolName: "memory_set", input: JSON.stringify(DEMO_ARGS) });
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          if (wantsTools && results === 1) {
            // STEP 2: read it back (the set completed — deterministic order)
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_get_1", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) });
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          if (wantsTools && results === 2) {
            // STEP 3: a SECOND same-name call — the replay keeps them distinct
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_get_2", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) });
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          let response;
          if (wantsTools) {
            // STEP 4: the tools all ran — the deterministic final summary
            response = "[demo model] Tool calls executed deterministically in sequence: memory_set wrote the shopping list (2 items), memory_get read it back (twice). This ran through the REAL production tool loop.";
          } else {
            response = `[demo model] Task received (${text.length} chars). Configure a real provider in Settings ` +
              `to get real completions. This demo response proves the agent loop runs end-to-end.`;
          }
          controller.enqueue({ type: "text-start", id });
          const chunks = response.match(/.{1,24}/g) ?? [response];
          for (const chunk of chunks) {
            controller.enqueue({ type: "text-delta", id, delta: chunk });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({ type: "finish", usage, finishReason: "stop" });
          controller.close();
        },
      });
      return Promise.resolve({ stream });
    },
  };
}
