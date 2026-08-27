// lib/agent-loop.js — the agent-do RUN-LOOP SEAM for the per-agent shared
// workers (CAP-FB-20260826-AGENT-WORKERS-01, Phase 2).
//
// The service worker owns routing/auth/grant-lock/redaction/storage. Phase 2
// moves the agent-do LOOP out of the SW and into each agent's shared worker —
// but the worker holds NO authority. It runs the loop with INJECTED tools whose
// `execute` is an RPC proxy back to the SW (the SW validates + executes the real
// tool + returns the result). This module is the loop-control seam both realms
// use: the worker imports it and passes proxy tools; a hypothetical future
// direct-realm caller passes the real tools.
//
// IMPORTANT: this module imports ONLY agent-do + the ai SDK `tool` — it must
// NOT import browser-tools.js / memory / usage-store (those are SW authority).
// Progress events are REDACTED: tool names, durations, ok/error, token counts —
// never tool args, tool results, prompts, or page content.

import { createAgent as agentDoCreateAgent } from "agent-do";
import { tool } from "ai";
import { z } from "zod";

/** Normalize an agent-do hook event into a redacted progress record. */
function redactProgress(record) {
  return record ?? null;
}

/**
 * Run the agent-do loop once. The `tools` map is `{ name: aiTool }` where each
 * aiTool is an ai-SDK `tool()` whose `execute` does the actual work — in the
 * worker, that `execute` is an RPC proxy to the SW. Returns the loop's final
 * text; onProgress receives the REDACTED lifecycle stream.
 *
 * @param {object} opts
 * @param {*}      opts.model         an ai-SDK LanguageModel (doStream/doGenerate)
 * @param {string} opts.system        the system prompt
 * @param {object} opts.tools         { name: aiTool } (ai-SDK tool map)
 * @param {function=} opts.onProgress (record) => void — redacted lifecycle events
 * @param {AbortSignal=} opts.signal  abort the loop between steps
 * @param {number=} opts.maxIterations
 * @returns {Promise<string>} the final text
 */
export async function runAgentLoop({
  model,
  system,
  tools,
  task = "",
  onProgress = null,
  signal = null,
  maxIterations = 12,
}) {
  const agent = agentDoCreateAgent({
    id: "worker-agent",
    name: "worker-agent",
    model,
    systemPrompt: system,
    tools: tools ?? {},
    maxIterations,
    signal: signal ?? undefined,
    hooks: {
      onStepStart: async (e) => {
        try {
          onProgress?.({ type: "thinking", step: e.step, totalSteps: e.totalSteps ?? null, tokensSoFar: e.tokensSoFar ?? 0 });
        } catch { /* progress is best-effort */ }
      },
      onStepComplete: async (e) => {
        try {
          // text is the model's step output — redact: only hasToolCalls + step.
          onProgress?.({ type: "step-complete", step: e.step, hasToolCalls: e.hasToolCalls === true });
        } catch { /* ignore */ }
      },
      onPreToolUse: async (e) => {
        try {
          // tool NAME only — never args (args may carry page content/prompts).
          onProgress?.({ type: "tool-call", toolName: String(e.toolName ?? "unknown").slice(0, 64), step: e.step });
        } catch { /* ignore */ }
      },
      onPostToolUse: async (e) => {
        try {
          // name + duration + ok only — never the result content.
          onProgress?.({ type: "tool-result", toolName: String(e.toolName ?? "unknown").slice(0, 64), step: e.step, durationMs: e.durationMs ?? null, ok: e.ok !== false });
        } catch { /* ignore */ }
      },
      onComplete: async (e) => {
        try {
          onProgress?.({ type: "done", totalSteps: e.totalSteps ?? null, aborted: e.aborted === true });
        } catch { /* ignore */ }
      },
      onUsage: async (record) => {
        try {
          onProgress?.({
            type: "usage",
            inputTokens: record.inputTokens ?? 0,
            outputTokens: record.outputTokens ?? 0,
            estimatedCost: record.estimatedCost ?? 0,
          });
        } catch { /* ignore */ }
      },
    },
  });

  // Run the loop once (no history/context for the worker's first-class run).
  return await agent.run(String(task ?? ""), {}, []);
}

/**
 * Build an ai-SDK `tool()` whose `execute` is an RPC proxy: it posts a
 * tool-execute request to the service worker and resolves with the SW's result.
 * The worker holds NO authority — every tool executes in the SW under its
 * grant-lock / run-fence / redaction.
 *
 * @param {object} opts
 * @param {string} opts.name        tool name (matches the SW's registry)
 * @param {string} opts.description one-line (the model sees this)
 * @param {object} opts.inputSchema zod schema (bounded)
 * @param {(args: any) => Promise<any>} opts.send RPC: posts {type, toolName, args} and resolves the SW result
 * @returns an ai-SDK tool
 */
export function proxyTool({ name, description, inputSchema, send }) {
  return tool({
    description,
    inputSchema,
    execute: async (args) => {
      const result = await send(name, args);
      // The SW returns the tool's structured result verbatim (or an error).
      return result;
    },
  });
}

/** A permissive pass-through schema for a proxy tool (the worker holds no
 * authority, so it must NOT re-implement the real input contract — the SW
 * validates the real args). */
export function passthroughSchema() {
  return z.object({}).passthrough();
}

export { redactProgress };
