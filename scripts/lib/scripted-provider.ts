// scripted-provider.ts — a keyless, loopback-only OpenAI-compatible provider
// that answers with a SCRIPT instead of a model.
// CAP-FB-20260830-SUITE-HONESTY-01
//
// Why: the demo model runs in-process and never touches the real provider
// path (the AI SDK's chat-completions adapter, streaming SSE, tool-call
// deltas, the `[provider]` logging fetch). A harness that wants to drive the
// REAL lazy protocol through the REAL HTTP path without a key points the
// extension's `openai-compatible` provider at this server and scripts the
// model's side of the conversation:
//
//   const provider = await startScriptedProvider({
//     steps: [
//       { tool: "search_tools", args: { query: "create_asset", limit: 1 } },
//       { tool: "execute_tool", args: (req) => ({ selectionRef: selectionRefOf(req), arguments: { … } }) },
//       { text: "Created crumb.html." },
//     ],
//   });
//   … provider.set({ provider: "openai-compatible", baseURL: provider.baseURL, model: "scripted" }) …
//   provider.requests   // every request the extension made, bounded
//   provider.leakHits   // every request that was NOT an API call (a sandboxed
//                       // frame reaching this origin is an exfiltration)
//   await provider.close();
//
// One request consumes one step, in order. A step may be a function of the
// request so it can read the previous tool result (the lazy protocol's
// selectionRef is minted per search and must be echoed back). When the script
// runs out the provider answers with a plain text that says so and counts it
// in `overflow` — a harness asserts `overflow === 0` rather than being handed
// a silently-invented turn.
//
// A turn that searches, executes and answers is THREE model calls: search,
// execute, answer. agent-do's synthetic continuation turn ("Continue working
// on the task…") is no longer sent after a step that already answered
// (CAP-FB-20260830-MODEL-CALL-ECONOMY-01 — the loop's own onStepStart stop
// hook declines it), so a fourth request shows up as an overflow. A model that
// answers a continuation with a tool call and then silence is nudged at most
// three times, after which the run stops with "Stopped after N steps".
//
// Binds to 127.0.0.1 only. Never reads an environment key. Never logs a body.

export interface ScriptedRequest {
  path: string;
  bytes: number;
  stream: boolean;
  model: string;
  messages: any[];
  toolNames: string[];
  /** The parsed JSON body (kept so a step can inspect it; never printed). */
  body: any;
}

export type ToolStep = {
  tool: string;
  args: Record<string, unknown> | ((req: ScriptedRequest) => Record<string, unknown>);
  /** Optional tool-call id; defaults to call_<n>. */
  id?: string;
};
export type TextStep = { text: string };
export type Step = ToolStep | TextStep | ((req: ScriptedRequest) => ToolStep | TextStep);

export interface ScriptedProvider {
  baseURL: string;
  port: number;
  requests: ScriptedRequest[];
  leakHits: { path: string; method: string; at: number }[];
  /** Requests that arrived after the script was exhausted. */
  overflow: number;
  /** The step index the next request will consume. */
  cursor(): number;
  close(): Promise<void>;
}

/** The provider gate refuses an empty key even for a local endpoint, so a
 *  harness configures this placeholder. It is not a credential: the server
 *  never checks it, and it matches no provider's key shape. */
export const SCRIPTED_DUMMY_KEY = "scripted-provider-no-key";

const API_PATH = /\/chat\/completions$/;
const MODELS_PATH = /\/models$/;

/** The last tool-result message in the request, parsed (agent-do wraps the
 *  envelope as `{modelContent}` on some paths; unwrap that too). */
export function lastToolResult(req: ScriptedRequest): any {
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "tool") continue;
    return parseLoose(m.content);
  }
  return null;
}

function parseLoose(v: unknown): any {
  if (typeof v === "string") {
    try { return unwrap(JSON.parse(v)); } catch { return v; }
  }
  if (Array.isArray(v)) {
    // content parts: take the first text part that parses
    for (const part of v) {
      if (part?.type === "text" && typeof part.text === "string") {
        try { return unwrap(JSON.parse(part.text)); } catch { /* next part */ }
      }
    }
    return v;
  }
  return unwrap(v);
}

function unwrap(v: any): any {
  if (v && typeof v === "object" && typeof v.modelContent === "string" && !("retryable" in v)) {
    try { return JSON.parse(v.modelContent); } catch { return v; }
  }
  return v;
}

/** First `sel_…` selectionRef anywhere in the last tool result, or "" . */
export function selectionRefOf(req: ScriptedRequest): string {
  const found = findSelectionRef(lastToolResult(req), 0);
  return found ?? "";
}

function findSelectionRef(v: any, depth: number): string | null {
  if (depth > 8 || v == null) return null;
  if (typeof v === "string") return /^sel_[a-f0-9]{36}$/.test(v) ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) { const r = findSelectionRef(x, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof v === "object") {
    if (typeof v.selectionRef === "string" && /^sel_[a-f0-9]{36}$/.test(v.selectionRef)) return v.selectionRef;
    for (const k of Object.keys(v)) { const r = findSelectionRef(v[k], depth + 1); if (r) return r; }
  }
  return null;
}

/** The unwrapped output of the most recent execute_tool result whose
 *  `selectedTool` matches — e.g. the created asset's id. */
export function lastExecuteResult(req: ScriptedRequest, selectedTool: string): any {
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "tool") continue;
    const v = parseLoose(m.content);
    if (v && typeof v === "object" && v.selectedTool === selectedTool) return v;
  }
  return null;
}

/** The `{ ok, selectedTool, result, … }` envelope of the most recent
 *  execute_tool call for `selectedTool`, tolerating the agent-loop adapter's
 *  double-JSON-encoded tool content (parseLoose stops at the first string
 *  that parses; the adapter sometimes stringifies the envelope a second
 *  time, so keep parsing while the value stays a JSON string). Harnesses
 *  asserting on the exact tool payload the MODEL saw should use this. */
export function executeEnvelope(req: ScriptedRequest, selectedTool: string): any {
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "tool") continue;
    let v: any = parseLoose(m.content);
    for (let d = 0; d < 4 && typeof v === "string"; d++) {
      try { v = JSON.parse(v); } catch { break; }
    }
    if (v && typeof v === "object" && v.selectedTool === selectedTool) return v;
  }
  return null;
}

/** The `results[].name` list of the most recent search_tools result the model
 *  has seen in this request's messages — the membership probe for "is this
 *  tool in the run's toolset" (a tool the catalog holds is the top hit for
 *  its own name; a removed tool never appears). */
export function searchResultNames(req: ScriptedRequest): string[] {
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "tool") continue;
    let v: any = parseLoose(m.content);
    for (let d = 0; d < 4 && typeof v === "string"; d++) {
      try { v = JSON.parse(v); } catch { break; }
    }
    if (v && typeof v === "object" && Array.isArray(v.results)) {
      return v.results.map((r: any) => String(r?.name ?? "")).filter(Boolean);
    }
  }
  return [];
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...(usage ? { usage } : {}),
  };
}

const USAGE = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

export async function startScriptedProvider(opts: {
  steps: Step[];
  /** Bound on retained requests (bodies are kept for step functions only). */
  maxRequests?: number;
}): Promise<ScriptedProvider> {
  const steps = opts.steps.slice();
  const requests: ScriptedRequest[] = [];
  const leakHits: ScriptedProvider["leakHits"] = [];
  let cursor = 0;
  let overflow = 0;
  let calls = 0;
  const ac = new AbortController();

  const resolveStep = (req: ScriptedRequest): ToolStep | TextStep => {
    if (cursor >= steps.length) {
      overflow++;
      return { text: `scripted provider: no step left (request ${requests.length}, ${steps.length} steps)` };
    }
    const s = steps[cursor++];
    return typeof s === "function" ? s(req) : s;
  };

  const answer = (req: ScriptedRequest): Response => {
    const step = resolveStep(req);
    const id = `chatcmpl-scripted-${++calls}`;
    const model = req.model || "scripted";
    if ("text" in step) {
      if (!req.stream) {
        return Response.json({
          id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: "assistant", content: step.text }, finish_reason: "stop", logprobs: null }],
          usage: USAGE,
        });
      }
      const body = sse(chunk(id, model, { role: "assistant", content: "" }, null)) +
        sse(chunk(id, model, { content: step.text }, null)) +
        sse(chunk(id, model, {}, "stop", USAGE)) +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    const args = typeof step.args === "function" ? step.args(req) : step.args;
    const callId = step.id ?? `call_${calls}`;
    const argText = JSON.stringify(args ?? {});
    if (!req.stream) {
      return Response.json({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: step.tool, arguments: argText } }] },
          finish_reason: "tool_calls", logprobs: null,
        }],
        usage: USAGE,
      });
    }
    const body = sse(chunk(id, model, { role: "assistant", content: null }, null)) +
      sse(chunk(id, model, { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: step.tool, arguments: "" } }] }, null)) +
      sse(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: argText } }] }, null)) +
      sse(chunk(id, model, {}, "tool_calls", USAGE)) +
      "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  };

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (r) => {
    const u = new URL(r.url);
    if (r.method === "POST" && API_PATH.test(u.pathname)) {
      const raw = await r.text();
      let body: any = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      const req: ScriptedRequest = {
        path: u.pathname,
        bytes: raw.length,
        stream: body?.stream === true,
        model: String(body?.model ?? ""),
        messages: Array.isArray(body?.messages) ? body.messages : [],
        toolNames: Array.isArray(body?.tools) ? body.tools.map((t: any) => t?.function?.name ?? t?.name ?? "?") : [],
        body,
      };
      if (requests.length < (opts.maxRequests ?? 64)) requests.push(req);
      return answer(req);
    }
    if (r.method === "GET" && MODELS_PATH.test(u.pathname)) {
      return Response.json({ object: "list", data: [{ id: "scripted", object: "model", owned_by: "harness" }] });
    }
    // Anything else on this origin is NOT the extension talking to its
    // provider: a sandboxed artifact frame that reaches here has escaped.
    leakHits.push({ path: u.pathname + u.search, method: r.method, at: Date.now() });
    return new Response("not an api path", { status: 404 });
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    leakHits,
    get overflow() { return overflow; },
    cursor: () => cursor,
    close: async () => {
      ac.abort();
      try { await server.shutdown(); } catch { /* already down */ }
    },
  };
}
