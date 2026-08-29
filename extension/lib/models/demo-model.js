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
// @demo-delegate-agent <agentIdOrName>: the demo model issues a REAL
// delegate_to_agent management call (agent→agent delegation, G5) targeting a
// NAMED agent; the child runs "@demo-tools" in its OWN sandbox and the final
// text reflects the delegation result. Checked BEFORE the site-delegation
// marker (the strings share a prefix).
const AGENT_DELEGATE_MARKER = "@demo-delegate-agent";
// @demo-slow: the FIRST model step is delayed (a deterministic mid-run window
// for abort tests).
const SLOW_MARKER = "@demo-slow";
/** Public deterministic cancellation window used by the demo provider. This is
 * product behavior (the documented @demo-slow marker), not a hidden test seam. */
export const DEMO_SLOW_HOLD_MS = 10_000;

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const done = () => { signal?.removeEventListener?.("abort", aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", aborted);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", aborted, { once: true });
  });
}

function wantsDelegate(prompt) {
  return !!latestRunSlice(prompt)?.marker?.delegate;
}

function wantsAgentDelegate(prompt) {
  return !!latestRunSlice(prompt)?.marker?.delegateAgent;
}

function delegateAgentRef(prompt) {
  // Scope to the SAME run slice the marker check uses — the last user message
  // of the WHOLE prompt can be an agent-do continuation without the marker.
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  const m = sliceText.match(new RegExp(AGENT_DELEGATE_MARKER + "\\s+([\\w.-]+)"));
  return m ? m[1] : "demo-agent";
}

// The task forwarded to a delegation CHILD: everything from the next "@demo"
// marker AFTER the agent ref (enables chains like
// "@demo-delegate-agent mid @demo-delegate-agent leaf" → mid receives
// "@demo-delegate-agent leaf", and slow children via
// "@demo-delegate-agent helper @demo-tools @demo-slow"); plain delegations
// keep the historical "@demo-tools" child task. "@demo-delegate-slow" is a
// PARENT-SIDE alias: the child receives "@demo-tools @demo-slow" WITHOUT the
// parent's own model seeing the slow marker (the parent must stay fast so a
// cancellation probe can observe the live child).
function delegateChildTask(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  if (new RegExp(AGENT_DELEGATE_MARKER + "\\s+[\\w.-]+\\s+@demo-delegate-slow\\b").test(sliceText)) {
    return "@demo-tools @demo-slow";
  }
  const m = sliceText.match(new RegExp(AGENT_DELEGATE_MARKER + "\\s+[\\w.-]+\\s+(@demo[\\s\\S]{0,300})"));
  return m ? m[1].trim().slice(0, 300) : "@demo-tools";
}

// "@demo-delegate-parallel <agentA> <agentB>" — ONE model step returns TWO
// delegate tool calls, driving agent-do's concurrent same-step execution.
function delegateParallelRefs(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  const m = sliceText.match(/@demo-delegate-parallel(?:-slow)?\s+([\w.-]+)\s+([\w.-]+)/);
  return m ? [m[1], m[2]] : null;
}

function wantsSlowFirstParallelDelegate(prompt) {
  return /@demo-delegate-parallel-slow\b/.test(extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : [])));
}

// "@demo-delegate-x<N>" (after the agent marker) — N sequential delegations
// in one run, driving the combined-budget exhaustion path. N ≥ 4 gives the
// children the LONGER tools plan ("@demo-tools-x2") so a budget denial is
// reachable below the descendant cap.
export function delegateMultiCount(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  // Accept only the marker boundary or agent-do's exact concatenated
  // continuation — never arbitrary suffixes such as x3garbage.
  const m = sliceText.match(/@demo-delegate-x(\d)(?=$|\s|Continue working)/);
  return m ? Math.min(9, Number.parseInt(m[1], 10)) : 0;
}

// "@demo-tools-x2" — the doubled tools plan (12 actions ≈ 6 loop iterations),
// so a delegated child can consume its full iteration cap in budget tests.
export function wantsDemoToolsX2(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  // Accept the exact concatenated continuation, but not x20/x2garbage.
  return /@demo-tools-x2(?=$|\s|Continue working)/.test(sliceText);
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
  // the marker is on the ORIGINAL task of the CURRENT run — scope to the
  // LATEST user turn carrying any marker (a prior run's marker must never
  // trigger a later non-marker run; an intervening non-marker run resets)
  return !!latestRunSlice(prompt)?.marker?.tools;
}

/** STATELESS, run-scoped demo sequencing: the step is derived from the CURRENT
 * prompt's tool history — never from counters on a shared model (which would
 * leak across concurrent/multi-agent runs and consecutive marker runs). With
 * ONE dependent tool call per model step (@demo-tools: set → get → get →
 * final; @demo-delegate: delegate → final), the tool history accumulates
 * across the current run's steps. The agent-do continuation step strips the
 * tool history, so the demo's OWN emitted final summary (which persists in the
 * assistant history) marks "already final" — the continuation then re-emits
 * the summary and the loop breaks. This is the only deterministic ordering —
 * the AI SDK executes same-step tools concurrently with Promise.all, so
 * same-step set+get could read the pre-write value. */
/** The CURRENT run's scope: the boundary is the LATEST user message — the
 * CURRENT run's marker is ONLY that message's marker (a PRIOR run's marker in
 * the history can never trigger the current run). The slice is everything
 * from that boundary onward, so the step derives ONLY from the current run's
 * messages — a prior run's tool/summary transcript never interferes. */
/** The agent-do loop's SYNTHETIC continuation prompt (it repeats every
 * iteration after a tool step) is NOT a new run boundary — the run's real
 * task is the last NON-continuation user message. */
const AGENTDO_CONTINUATION = "continue working on the task";

function isAgentDoContinuation(msg) {
  return msg?.role === "user" && /^continue working on the task/i.test(extractText([msg]).trim());
}

function latestRunSlice(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  let lastIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === "user" && !isAgentDoContinuation(msgs[i])) lastIdx = i;
  }
  if (lastIdx === -1) return null;
  const lastUser = extractText([msgs[lastIdx]]).toLowerCase();
  return {
    slice: msgs.slice(lastIdx),
    marker: {
      tools: lastUser.includes(TOOLS_MARKER),
      delegate: lastUser.includes(DELEGATE_MARKER) && !lastUser.includes(AGENT_DELEGATE_MARKER),
      delegateAgent: lastUser.includes(AGENT_DELEGATE_MARKER),
    },
  };
}

function runSlice(prompt) {
  return latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []);
}

function toolResultCount(prompt) {
  return runSlice(prompt).reduce((count, message) => {
    if (message?.role !== "tool") return count;
    if (!Array.isArray(message.content)) return count + 1;
    return count + message.content.filter((part) =>
      part?.type === "tool-result" || part?.type === "tool-error"
    ).length;
  }, 0);
}

function latestSelectionRef(prompt) {
  const toolMessage = [...runSlice(prompt)].reverse().find((m) => m?.role === "tool");
  if (!toolMessage) return null;
  try {
    return JSON.stringify(toolMessage).match(/sel_[a-f0-9]{36}/u)?.[0] ?? null;
  } catch {
    return null;
  }
}

function lazyDemoCall(prompt, { delegate = false, delegateAgent = false } = {}) {
  const step = toolResultCount(prompt);
  if (delegateAgent) {
    const parallelRefs = delegateParallelRefs(prompt);
    if (parallelRefs) {
      // TWO searches (a selectionRef is single-use — one per sibling), then
      // TWO executes in ONE step, driving agent-do's concurrent same-step
      // execution (the parallel-sibling delegation path).
      const toolParts = runSlice(prompt)
        .filter((m) => m?.role === "tool")
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .filter((p) => p && typeof p === "object");
      const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
      const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
      if (executes >= 2) return null;
      if (searches < 2) {
        return [0, 1].map((i) => ({ id: `search_delegate_${i}`, name: "search_tools", input: { query: "delegate_to_agent", limit: 1 } }));
      }
      const refs = runSlice(prompt)
        .filter((m) => m?.role === "tool")
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .map((p) => JSON.stringify(p).match(/sel_[a-f0-9]{36}/u)?.[0])
        .filter(Boolean);
      const [refA, refB] = [refs.at(-2), refs.at(-1)];
      return refA && refB
        ? [
          { id: "execute_delegate_a", name: "execute_tool", input: { selectionRef: refA, arguments: { agent: parallelRefs[0], task: wantsSlowFirstParallelDelegate(prompt) ? "@demo-tools @demo-slow" : "@demo-tools" } } },
          { id: "execute_delegate_b", name: "execute_tool", input: { selectionRef: refB, arguments: { agent: parallelRefs[1], task: "@demo-tools" } } },
        ]
        : null;
    }
    const wantMulti = delegateMultiCount(prompt);
    if (wantMulti > 0) {
      // search → delegate → … → final: N SEQUENTIAL child runs against one
      // budget. Round detection reads the tool parts' toolName (result
      // messages can carry more than one part, so a naive result count
      // miscounts rounds).
      const toolParts = runSlice(prompt)
        .filter((m) => m?.role === "tool")
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .filter((p) => p && typeof p === "object");
      const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
      const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
      if (searches >= wantMulti && executes >= wantMulti) return null;
      if (searches <= executes) {
        return { id: `search_delegate_${searches}`, name: "search_tools", input: { query: "delegate_to_agent", limit: 1 } };
      }
      const selectionRef = latestSelectionRef(prompt);
      return selectionRef
        ? { id: `execute_delegate_${executes}`, name: "execute_tool", input: { selectionRef, arguments: { agent: delegateAgentRef(prompt), task: wantMulti >= 3 ? "@demo-tools-x2" : "@demo-tools" } } }
        : null;
    }
    if (step === 0) {
      return { id: "search_delegate_agent", name: "search_tools", input: { query: "delegate_to_agent", limit: 1 } };
    }
    if (step === 1) {
      const selectionRef = latestSelectionRef(prompt);
      return selectionRef
        ? { id: "execute_delegate_agent", name: "execute_tool", input: { selectionRef, arguments: { agent: delegateAgentRef(prompt), task: delegateChildTask(prompt) } } }
        : null;
    }
    return null;
  }
  if (delegate) {
    if (step === 0) {
      return { id: "search_delegate", name: "search_tools", input: { query: "delegate_task", limit: 1 } };
    }
    if (step === 1) {
      const selectionRef = latestSelectionRef(prompt);
      return selectionRef
        ? { id: "execute_delegate", name: "execute_tool", input: { selectionRef, arguments: { agentId: delegateAgentId(prompt), task: "run @demo-tools @demo-slow please" } } }
        : null;
    }
    return null;
  }
  const plan = [
    { type: "search", tool: "memory_set" },
    { type: "execute", args: DEMO_ARGS },
    { type: "search", tool: "memory_get" },
    { type: "execute", args: { key: "demo" } },
    { type: "search", tool: "memory_get" },
    { type: "execute", args: { key: "demo" } },
  ];
  const fullPlan = wantsDemoToolsX2(prompt) ? [...plan, ...plan] : plan;
  const action = fullPlan[step];
  if (!action) return null;
  if (action.type === "search") {
    return { id: `search_${step}`, name: "search_tools", input: { query: action.tool, limit: 1 } };
  }
  const selectionRef = latestSelectionRef(prompt);
  return selectionRef
    ? { id: `execute_${step}`, name: "execute_tool", input: { selectionRef, arguments: action.args } }
    : null;
}

function demoAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Tool calls executed in sequence/.test(p.text ?? "")));
}

function delegateAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Delegation/.test(p.text ?? "")));
}

function agentDelegateAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Agent delegation/.test(p.text ?? "")));
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
      const lazyCall = wantsAgentDelegate(options.prompt)
        ? lazyDemoCall(options.prompt, { delegateAgent: true })
        : wantsDelegate(options.prompt)
        ? lazyDemoCall(options.prompt, { delegate: true })
        : wantsDemoTools(options.prompt) && !demoAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt)
        : null;
      if (lazyCall) {
        const lazyCalls = Array.isArray(lazyCall) ? lazyCall : [lazyCall];
        return Promise.resolve({
          content: lazyCalls.map((call) => ({
            type: "tool-call",
            toolCallId: `call_demo_${call.id}`,
            toolName: call.name,
            input: JSON.stringify(call.input),
          })),
          finishReason: "tool-calls",
          usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
          warnings: [],
        });
      }
      if (!wantsDemoTools(options.prompt) && !wantsDelegate(options.prompt)) {
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
        await abortableDelay(DEMO_SLOW_HOLD_MS, options.abortSignal);
      }
      const text = extractText(options.prompt);
      const wantsTools = wantsDemoTools(options.prompt);
      const wantsDel = wantsDelegate(options.prompt);
      const wantsADel = wantsAgentDelegate(options.prompt);
      const id = `demo-${crypto.randomUUID?.() ?? Math.random()}`;
      const usage = { inputTokens: 8, outputTokens: 32, totalTokens: 40 };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          let response = "";
          const lazyCall = wantsADel && !agentDelegateAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { delegateAgent: true })
            : wantsDel
            ? lazyDemoCall(options.prompt, { delegate: true })
            : wantsTools && !demoAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt)
            : null;
          if (lazyCall) {
            const lazyCalls = Array.isArray(lazyCall) ? lazyCall : [lazyCall];
            for (const call of lazyCalls) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call_demo_${call.id}`,
                toolName: call.name,
                input: JSON.stringify(call.input),
              });
            }
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          if (wantsDel && delegateAlreadyFinal(options.prompt)) {
            // the continuation step (tool history stripped) re-emits the EXACT
            // summary the model already produced (the final text stays the
            // authoritative outcome — FAILED or succeeded, never a neutral
            // rewrite that could mask a failed delegation)
            // scope to the CURRENT run's slice ONLY — a prior run's success in
            // the broader history can never be replayed onto the current failure
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && /\[demo model\] Delegation/.test(p2.text ?? ""));
            response = prior?.text ?? "[demo model] Delegation finished.";
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsDel) {
            // STEP 2 (delegate): reflect the delegation outcome (an aborted /
            // failed delegation is a REAL tool-error — the run reports it).
            // The SDK's tool-error message may be EMPTY (the error rides the
            // run's rejection, not the tool message), so the absence of any
            // SUCCESSFUL delegate result is the signal.
            const lastTool = [...runSlice(options.prompt)].reverse().find((m) => m?.role === "tool");
            // STRUCTURAL parsing of the AI SDK tool PARTS: the tool message's
            // content is an array of { type:'tool-result'|'tool-error', output }
            // parts (NOT `result`). A result part whose output.type ===
            // "error-text" is FAILED; a result part with a REAL output value is
            // SUCCESS — the worker text's WORDS never matter (a successful text
            // mentioning 'error'/'abort' must not be rejected).
            const parts = Array.isArray(lastTool?.content) ? lastTool.content : [];
            let succeeded = false;
            for (const part of parts) {
              if (part?.type === "tool-result" && part?.output) {
                if (part.output.type === "error-text") {
                  succeeded = false;
                  break;
                }
                succeeded = true;
              } else if (part?.type === "tool-error") {
                succeeded = false;
                break;
              }
            }
            const failed = !succeeded;
            // the SUCCESS response uses the STRUCTURALLY parsed output value
            const outValue = parts.find((pt) => pt?.type === "tool-result" && pt?.output && pt.output.type !== "error-text")?.output?.value ?? "";
            response = failed
              ? "[demo model] Delegation FAILED — the delegated worker was aborted mid-run."
              : `[demo model] Delegation succeeded. Worker response: ${typeof outValue === "string" ? outValue.slice(0, 160) : JSON.stringify(outValue ?? "").slice(0, 160)}`;
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsADel && agentDelegateAlreadyFinal(options.prompt)) {
            // Continuation AFTER the final text (agent-do compacts the tool
            // exchange away, then asks to continue): re-emit the EXACT prior
            // final — never restart the search/execute sequence.
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && /\[demo model\] Agent delegation/.test(p2.text ?? ""));
            response = prior?.text ?? "[demo model] Agent delegation finished.";
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsADel) {
            // STEP 2 (delegate-to-agent): reflect the child run's outcome with
            // the SAME structural tool-part parsing as the site-delegation path.
            // The lazy execute_tool wrapper reports { ok:true, result: <route
            // result> } for a COMPLETED call — a structured DENIAL rides inside
            // as result.ok === false, so look one level in before deciding.
            const lastTool = [...runSlice(options.prompt)].reverse().find((m) => m?.role === "tool");
            const parts = Array.isArray(lastTool?.content) ? lastTool.content : [];
            let succeeded = false;
            for (const part of parts) {
              if (part?.type === "tool-result" && part?.output) {
                if (part.output.type === "error-text") { succeeded = false; break; }
                succeeded = true;
              } else if (part?.type === "tool-error") { succeeded = false; break; }
            }
            const outValue = parts.find((pt) => pt?.type === "tool-result" && pt?.output && pt.output.type !== "error-text")?.output?.value ?? "";
            const errValue = parts.find((pt) => pt?.output?.type === "error-text")?.output?.value ?? parts.find((pt) => pt?.type === "tool-error")?.error ?? "";
            let outText = typeof outValue === "string" ? outValue : JSON.stringify(outValue ?? "");
            // Unwrap the lazy protocol envelope (string OR object form).
            let inner = outValue;
            if (typeof outValue === "string") {
              try { inner = JSON.parse(outValue); } catch { inner = outValue; }
            }
            const routeResult = inner && typeof inner === "object" && "result" in inner ? inner.result : inner;
            if (succeeded && routeResult && typeof routeResult === "object" && routeResult.ok === false) {
              succeeded = false;
              outText = String(routeResult.error ?? "delegation denied");
            } else if (succeeded && routeResult && typeof routeResult === "object" && typeof routeResult.result === "string") {
              outText = routeResult.result;
            }
            response = succeeded
              ? `[demo model] Agent delegation succeeded. Child result: ${String(outText).slice(0, 200)}`
              : `[demo model] Agent delegation DENIED/FAILED: ${String(succeeded ? "" : (routeResult?.error ?? outText ?? errValue)).slice(0, 200)}`;
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsTools && (toolResultCount(options.prompt) >= (wantsDemoToolsX2(options.prompt) ? 12 : 6) || demoAlreadyFinal(options.prompt))) {
            // STEP 4 (tools): the final summary — the reads' VALUES speak for
            // themselves (the run's tool results are the assertion target). The
            // continuation step (tool history stripped) re-emits the same
            // summary, so the loop ends on the text-only step.
            response = "[demo model] Tool calls executed in sequence: memory_set wrote the shopping list, then memory_get read it back twice.";
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
