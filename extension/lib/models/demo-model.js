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
// @demo-delegate <agentId>: the demo model issues a REAL delegate_task tool
// call (the production model-facing delegate) — the delegated worker runs
// "@demo-tools" and the final text reflects the delegation result.
const DELEGATE_MARKER = "@demo-delegate";
// @demo-slow: the FIRST model step is delayed (a deterministic mid-run window
// for abort tests).
const SLOW_MARKER = "@demo-slow";

function wantsDelegate(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  return msgs.some((m) => m?.role === "user" && extractText([m]).toLowerCase().includes(DELEGATE_MARKER));
}

function delegateAgentId(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  const text = extractText([last]);
  const m = text.match(new RegExp(DELEGATE_MARKER + "\\s+([\\w.-]+)"));
  return m ? m[1] : "demo-site";
}

function wantsSlow(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  return extractText([last]).toLowerCase().includes(SLOW_MARKER);
}

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
  // the marker is on the ORIGINAL task — scan ALL user turns (the agent-do
  // continuation prompts drop it, but the task stays in the history)
  const msgs = Array.isArray(prompt) ? prompt : [];
  return msgs.some((m) => m?.role === "user" && extractText([m]).toLowerCase().includes(TOOLS_MARKER));
}

/** Whether the model has already answered: the FIRST model step of a run has
 * NO assistant message yet — that step issues the demo calls; EVERY later step
 * (the assistant message exists, regardless of whether its tool-call parts were
 * stripped by the provider loop) emits the final text. Deterministic + robust
 * against the loop's message normalization. */
function hasAssistantMessage(prompt) {
  return (Array.isArray(prompt) ? prompt : []).some((m) => m?.role === "assistant");
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
      const hasTools = hasAssistantMessage(options.prompt);
      if (wantsDemoTools(options.prompt) && !hasTools) {
        return Promise.resolve({
          content: [
            { type: "tool-call", toolCallId: "call_demo_set", toolName: "memory_set", input: JSON.stringify(DEMO_ARGS) },
            { type: "tool-call", toolCallId: "call_demo_get_1", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) },
            { type: "tool-call", toolCallId: "call_demo_get_2", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
          warnings: [],
        });
      }
      if (wantsDelegate(options.prompt) && !hasTools) {
        return Promise.resolve({
          content: [{ type: "tool-call", toolCallId: "call_demo_delegate", toolName: "delegate_task", input: JSON.stringify({ agentId: delegateAgentId(options.prompt), task: "run @demo-tools @demo-slow please" }) }],
          finishReason: "tool-calls",
          usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
          warnings: [],
        });
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

    async doStream(options) {
      if (wantsSlow(options.prompt) && !options._slowUsed) {
        options._slowUsed = true;
        await new Promise((r) => setTimeout(r, 500));
      }
      const text = extractText(options.prompt);
      const wantsTools = wantsDemoTools(options.prompt);
      const wantsDel = wantsDelegate(options.prompt);
      const hasTools = hasAssistantMessage(options.prompt);
      const id = `demo-${crypto.randomUUID?.() ?? Math.random()}`;
      const usage = { inputTokens: 8, outputTokens: 32, totalTokens: 40 };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          let response = "";
          if (wantsDel && !hasTools) {
            // STEP 1: a REAL delegate_task call (the production model-facing path)
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_delegate", toolName: "delegate_task", input: JSON.stringify({ agentId: delegateAgentId(options.prompt), task: "run @demo-tools @demo-slow please" }) });
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          if (wantsDel) {
            // STEP 2: reflect the delegation result (an aborted delegation
            // returns an error — never a success object)
            const lastTool = [...(options.prompt ?? [])].reverse().find((m) => m?.role === "tool");
            const toolText = typeof lastTool?.content === "string" ? lastTool.content : JSON.stringify(lastTool?.content ?? "");
            // scan the ENTIRE tool message (content + the result parts' output
            // values) for the abort/error marker — the shape varies by SDK path
            const allText = toolText + " " + JSON.stringify(lastTool ?? {});
            const failed = /abort|delegation aborted|error/i.test(allText);
            response = failed
              ? "[demo model] Delegation FAILED — the delegated worker was aborted mid-run."
              : `[demo model] Delegation succeeded. Worker response: ${toolText.slice(0, 160)}`;
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsTools && !hasTools) {
            // STEP 1: the REAL demo calls IN ONE STEP — the SDK executes them
            // IN ORDER (set completes before the gets read back — deterministic,
            // independent of any per-step message accumulation)
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_set", toolName: "memory_set", input: JSON.stringify(DEMO_ARGS) });
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_get_1", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) });
            controller.enqueue({ type: "tool-call", toolCallId: "call_demo_get_2", toolName: "memory_get", input: JSON.stringify({ key: "demo" }) });
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          if (wantsTools) {
            // STEP 2: the tools all ran — the deterministic final summary
            response = "[demo model] Tool calls executed deterministically: memory_set wrote the shopping list (2 items), memory_get read it back (twice). This ran through the REAL production tool loop.";
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
