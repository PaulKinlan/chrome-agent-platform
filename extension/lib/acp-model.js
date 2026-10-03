// ACP is a model backend, not a second CAP tool dispatcher. agent-do owns
// validation, approval, execution and run bookkeeping exactly as for other models.
import { AcpClient } from "./acp-client.js";

const usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };

export function createAcpModel({ url, cwd = "", harnessId, permissionHandler, clientFactory = (options) => new AcpClient(options) }) {
  const children = new Set();
  let client = null;
  let controller = null;
  let tools = [];
  let pending = null;
  let started = false;
  let finished = false;
  let closed = false;
  let textId = 0;
  let detachAbort = () => {};

  function finish(reason) {
    if (!controller) return;
    controller.enqueue({ type: "finish", finishReason: reason, usage });
    controller.close();
    controller = null;
  }
  function fail(error) {
    if (closed) return;
    closed = true;
    pending?.reject(error); pending = null;
    controller?.error(error); controller = null;
    detachAbort(); client?.close();
  }
  async function handleTool(method, params) {
    if (closed || finished) throw new Error("CAP run is no longer active");
    if (method === "_cap/tools/list") {
      return { tools: tools.map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema })) };
    }
    if (!controller || pending) throw new Error("CAP is already processing a tool call; retry after its result");
    if (!tools.some((t) => t.name === params?.name)) throw new Error("Tool is not available in this CAP run");
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      pending = { id, resolve, reject };
      controller.enqueue({ type: "tool-call", toolCallId: id, toolName: params.name, input: JSON.stringify(params.arguments ?? {}) });
      finish("tool-calls");
    });
  }
  async function start(prompt) {
    client = clientFactory({ url, defaultCwd: cwd, toolHandler: handleTool,
      // Never inherit AcpClient's legacy no-handler auto-allow mode.
      permissionHandler: permissionHandler ?? (async () => null) });
    await client.connect();
    if (closed) { client.close(); return; }
    await client.initialize({ _meta: { capTools: true } });
    const session = await client.newSession({ cwd });
    // ACP has no system-prompt setter. Pass the complete CAP prompt, including
    // protected untrusted-content rules, as explicitly labelled conversation data.
    const text = "Follow the CAP instructions and conversation below. Use the CAP tools to act through CAP.\n" + JSON.stringify(prompt);
    await client.prompt(session.sessionId, text, (event) => {
      if (event.kind !== "chunk" || !controller || closed) return;
      const id = `acp-text-${++textId}`;
      controller.enqueue({ type: "text-start", id });
      controller.enqueue({ type: "text-delta", id, delta: event.text });
      controller.enqueue({ type: "text-end", id });
    });
    finished = true;
    finish("stop");
  }
  const backend = {
    specificationVersion: "v2",
    provider: "acp",
    providerName: "acp",
    modelId: harnessId,
    supportedUrls: {},
    async doStream(options) {
      if (closed) throw new Error("CAP harness turn has ended");
      if (finished) { client?.close(); finished = false; started = false; }
      tools = (options.tools ?? []).filter((t) => t.type === "function");
      // Only the existing lazy surface crosses this channel, never eager tool closures.
      if (!tools.length) throw new Error("CAP run supplied no callable tools");
      detachAbort();
      const signal = options.abortSignal;
      const abort = () => fail(new DOMException("CAP run cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      detachAbort = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) abort();
      if (closed) throw new DOMException("CAP run cancelled", "AbortError");
      const stream = new ReadableStream({ start(c) { controller = c; c.enqueue({ type: "stream-start", warnings: [] }); } });
      if (pending) {
        const part = (options.prompt ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : [])
          .find((p) => p.type === "tool-result" && p.toolCallId === pending.id);
        if (!part) { fail(new Error("CAP tool result missing from the next model step")); return { stream }; }
        const output = part.output;
        const value = output?.value ?? output;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const reply = pending; pending = null;
        reply.resolve({ content: [{ type: "text", text }], ...(String(output?.type).startsWith("error") ? { isError: true } : {}) });
      }
      if (!started) {
        started = true;
        void start(options.prompt).catch(fail);
      }
      return { stream };
    },
    fork() {
      const child = createAcpModel({ url, cwd, harnessId, permissionHandler, clientFactory });
      children.add(child);
      return child;
    },
    close() {
      for (const child of children) child.close();
      children.clear();
      fail(new Error("CAP run ended"));
    },
  };
  return { model: backend, modelId: harnessId, providerName: "acp", providerLane: "acp", fork: backend.fork, close: backend.close };
}
