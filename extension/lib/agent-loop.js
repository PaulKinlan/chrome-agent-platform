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
// Pure loop-control rule (no authority, no chrome.*): the same continuation
// decision the SW-side loop makes (CAP-FB-20260830-MODEL-CALL-ECONOMY-01).
import { continuationStopDecision, isSilentIteration } from "./run-budget.js";
import { steerTextsToInject } from "./run-control.js";

/** Normalize an agent-do hook event into a redacted progress record. */
function redactProgress(record) {
  return record ?? null;
}

/**
 * Wrap a LanguageModel so every outgoing model call carries the run's pending
 * STEER guidance (chrome-agent-platform-afiu). `readSteers` is the sync reader
 * the realm feeds (the worker's steer buffer / the SW's run-control store); it
 * returns the steer records pending for THIS run. Their text is appended as
 * trailing user messages on the outgoing call COPY (agent-do's own history is
 * never touched), so guidance is honored BETWEEN steps: a steer that arrives
 * mid-tool-call changes the agent's NEXT action. Records keep riding later
 * calls until the run settles — a redirect stays live, and the fixture agents
 * in tests/agent-worker-loop.test.ts + run-control.test.ts assert exactly that.
 * No readSteers → the model passes through untouched. `onCarried(pending)`
 * fires after an injection with the records just carried (the stop-step
 * hook uses it to end the loop after the first carrying call).
 */
export function withSteerInjection(model, readSteers = null, onCarried = null) {
  if (!model || typeof readSteers !== "function") return model;
  // AI SDK 7 delivers the model call as options.prompt (message list) — the
  // agent.js attestation seam reads the SAME field. Only that list is
  // touched; every other option passes through untouched.
  const inject = (options) => {
    let pending = [];
    try { pending = readSteers() || []; } catch { return options; }
    const texts = steerTextsToInject(pending);
    if (!texts.length) return options;
    if (!Array.isArray(options?.prompt)) return options;
    const prompt = [...options.prompt];
    for (const text of texts) prompt.push({ role: "user", content: text });
    try { onCarried?.(pending); } catch { /* a control callback never breaks a call */ }
    return { ...options, prompt };
  };
  return new Proxy(model, {
    get(target, prop, receiver) {
      if ((prop === "doStream" || prop === "doGenerate") && typeof target[prop] === "function") {
        const fn = target[prop].bind(target);
        return (options, ...rest) => fn(inject(options), ...rest);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
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
 * @param {function=} opts.readSteers sync () => steer records — when present,
 *   every model call carries the pending steer text (between-step delivery)
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
  readSteers = null,
}) {
  // chrome-agent-platform-afiu: a steer with mode "stop-step" ends the loop at
  // the step boundary AFTER the first model call that carried it (the owner
  // said "take this direction, then wrap up" — the in-flight step finishes,
  // one more call answers with the steer, no continuation tool loop).
  let stopStepCarried = false;
  const injectedModel = withSteerInjection(model, readSteers, (carried) => {
    if (Array.isArray(carried) && carried.some((s) => s?.mode === "stop-step")) stopStepCarried = true;
  });
  let lastIteration = null; // { hasToolCalls, text, finishedWithToolCalls }
  let silentContinuations = 0;
  let modelSteps = 0; // one onUsage record per model step
  const agent = agentDoCreateAgent({
    id: "worker-agent",
    name: "worker-agent",
    model: injectedModel,
    systemPrompt: system,
    tools: tools ?? {},
    maxIterations,
    signal: signal ?? undefined,
    hooks: {
      onStepStart: async (e) => {
        // An owner stop-step steer outranks the continuation economy: the loop
        // stops at the boundary AFTER the carrying call ran (no continuation
        // nudge, no further tool loop).
        if (e.step > 0 && stopStepCarried) {
          stopStepCarried = false;
          try { onProgress?.({ type: "stopped", reason: "steer-stop-step", iterations: 0, steps: modelSteps }); } catch { /* ignore */ }
          return { decision: "stop" };
        }
        // The continuation economy, mirrored for the worker path so both
        // loops agree (CAP-FB-20260830-MODEL-CALL-ECONOMY-01): no continuation
        // call after an iteration that already answered; a silent tool loop
        // stops at the cap. The worker has no provider boundary, so the
        // inner-step-limit finish reason is unknown here (treated as "finished
        // on its own", the entry's stated predicate).
        if (e.step > 0) {
          const decision = continuationStopDecision({ lastIteration, silentContinuations });
          if (decision === "silent-cap") {
            try { onProgress?.({ type: "stopped", reason: "iteration-cap", iterations: silentContinuations, steps: modelSteps }); } catch { /* ignore */ }
            return { decision: "stop" };
          }
          if (decision === "answered") return { decision: "stop" };
        }
        try {
          onProgress?.({ type: "thinking", step: e.step, totalSteps: e.totalSteps ?? null, tokensSoFar: e.tokensSoFar ?? 0 });
        } catch { /* progress is best-effort */ }
      },
      onStepComplete: async (e) => {
        lastIteration = { hasToolCalls: e.hasToolCalls === true, text: String(e.text ?? "").trim(), finishedWithToolCalls: false };
        silentContinuations = isSilentIteration(lastIteration) ? silentContinuations + 1 : 0;
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
        modelSteps += 1;
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
