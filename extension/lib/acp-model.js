// ACP is a model backend, not a second CAP tool dispatcher. agent-do owns
// validation, approval, execution and run bookkeeping exactly as for other models.
import { AcpClient } from "./acp-client.js";

const usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };

/** The envelope every harness prompt is wrapped in (chrome-agent-platform-6yfm,
 *  coord ruling seq944 — option C: insertion-only, no bare-command bypass).
 *
 *  ACP has no system-prompt setter, so the CAP prompt travels as explicitly
 *  labelled CONVERSATION data: this prefix is the label, and the prompt itself
 *  is JSON — structured, never a raw concatenation. Removing or bypassing the
 *  envelope is the "silent raw-prompt bypass" this bead forbids, so the tests
 *  pin the envelope as a PREFIX (not a substring anywhere) and parse what
 *  follows it; `tests/acp-model.test.ts` drives both mutants (envelope dropped,
 *  prompt raw-concatenated) to prove those pins can fail. */
export const ACP_PROMPT_ENVELOPE =
  "Follow the CAP instructions and conversation below. Use the CAP tools to act through CAP.\n";

/** In-memory map of retained active ACP sessions for the offscreen model backend (chrome-agent-platform-v05y).
 * Unifies pre-prompt command discovery and prompt turns onto a single retained session lifecycle.
 * Map<sessionKey, {
 *   client: AcpClient,
 *   sessionId: string,
 *   threadId: string|null,
 *   harnessId: string,
 *   url: string,
 *   cwd: string,
 *   availableCommands: any[],
 *   inFlightTurn: boolean,
 *   currentTurnOwnerToken: string|null,
 *   activeExecutionId: string|null,
 *   lastActiveAt: number,
 * }>
 */
const retainedAcpModelSessions = new Map();

/** Map<sessionKey, Promise<any>> to serialize cold-start connections and avoid duplicate/race connects. */
const connectingAcpModelSessions = new Map();

export const ACP_MODEL_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/** Prune idle or disconnected retained model sessions. */
export function pruneIdleAcpModelSessions(maxIdleMs = ACP_MODEL_IDLE_TIMEOUT_MS) {
  const now = Date.now();
  for (const [key, rec] of retainedAcpModelSessions) {
    if (!rec?.client?.connected || (!rec.inFlightTurn && (now - (rec.lastActiveAt || 0) > maxIdleMs))) {
      closeRetainedAcpModelSession(key);
    }
  }
}

/** Get active retained model session record if connected and valid. Pure. */
export function getRetainedAcpModelSession(sessionKey) {
  pruneIdleAcpModelSessions();
  const rec = retainedAcpModelSessions.get(sessionKey);
  if (!rec) return null;
  if (!rec.client?.connected) {
    retainedAcpModelSessions.delete(sessionKey);
    try { rec.client?.close(); } catch { /* client already terminated or dropped */ }
    return null;
  }
  return rec;
}

/** Close and prune a retained model session, ensuring client transport is cleanly terminated. */
export function closeRetainedAcpModelSession(sessionKey) {
  const rec = retainedAcpModelSessions.get(sessionKey);
  if (rec) {
    retainedAcpModelSessions.delete(sessionKey);
    try { rec.client?.close(); } catch { /* client already terminated or dropped */ }
  }
}

/** Close all retained model sessions. */
export function clearAllRetainedAcpModelSessions() {
  for (const [key] of retainedAcpModelSessions) {
    closeRetainedAcpModelSession(key);
  }
  retainedAcpModelSessions.clear();
}

/** Total active retained model sessions count. */
export function retainedAcpModelSessionsCount() {
  pruneIdleAcpModelSessions();
  for (const [key, rec] of retainedAcpModelSessions) {
    if (!rec?.client?.connected) retainedAcpModelSessions.delete(key);
  }
  return retainedAcpModelSessions.size;
}

export function createAcpModel({
  threadId = null,
  url,
  cwd = "",
  harnessId,
  permissionHandler,
  executionId = null,
  clientFactory = (options) => new AcpClient(options),
  retainSession = false,
}) {
  const instanceOwnerToken = crypto.randomUUID();
  const sessionKey = `${threadId || "global"}:${harnessId}:${url || ""}:${cwd || ""}`;
  const children = new Set();
  let client = null;
  let controller = null;
  let tools = [];
  let pending = null;
  let started = false;
  let finished = false;
  let closed = false;
  let fromRetained = false;
  let activeSessionId = null;
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
    const rec = retainedAcpModelSessions.get(sessionKey);
    if (rec && rec.currentTurnOwnerToken === instanceOwnerToken) {
      rec.inFlightTurn = false;
      rec.currentTurnOwnerToken = null;
      rec.activeExecutionId = null;
      rec.lastActiveAt = Date.now();
    }
    pending?.reject(error); pending = null;
    controller?.error(error); controller = null;
    detachAbort();
    if (!retainSession && !fromRetained) {
      client?.close();
    }
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
  async function connectSession(capTools = true, onCommands = null) {
    if (retainSession) {
      // N1(b) Cold-start fence: if another backend is currently connecting for this key,
      // wait for it so we reuse the single connected client rather than racing or overwriting.
      if (connectingAcpModelSessions.has(sessionKey)) {
        try {
          await connectingAcpModelSessions.get(sessionKey);
        } catch { /* connection errors are handled on the caller's subsequent connect attempt */ }
      }

      const existing = getRetainedAcpModelSession(sessionKey);
      if (existing && existing.client?.connected) {
        // N1 concurrency fence: if a turn is currently streaming on this session,
        // a catalogue discovery must NEVER overwrite the streaming turn's toolHandler or executionId!
        if (existing.inFlightTurn) {
          if (onCommands) {
            client = existing.client;
            activeSessionId = existing.sessionId;
            fromRetained = true;
            // Discovery request while turn is live: return existing commands without state mutation
            onCommands(existing.availableCommands || []);
            return { sessionId: existing.sessionId, resumed: true };
          }
          throw new Error("ACP session currently owns an active turn; cannot start concurrent turn");
        }
        client = existing.client;
        activeSessionId = existing.sessionId;
        fromRetained = true;
        existing.lastActiveAt = Date.now();
        if (typeof client.setExecutionId === "function") client.setExecutionId(executionId);
        if (permissionHandler) client.permissionHandler = permissionHandler;
        if (capTools) client.toolHandler = handleTool;
        if (onCommands && existing.availableCommands) onCommands(existing.availableCommands);
        return { sessionId: existing.sessionId, resumed: true };
      }
    }

    const connectPromise = (async () => {
      client = clientFactory({
        url,
        defaultCwd: cwd,
        onCommands,
        requestTimeoutMs: 15000,
        toolHandler: capTools ? handleTool : null,
        permissionHandler: permissionHandler ?? (async () => null),
        executionId: executionId || null,
      });
      if (typeof client.setExecutionId === "function") {
        client.setExecutionId(executionId);
      }
      await client.connect();
      if (closed) { client.close(); return { sessionId: null, resumed: false }; }
      await client.initialize((retainSession || capTools) ? { _meta: { capTools: true } } : {});
      if (closed) throw new Error("CAP harness connection closed");
      const sess = await client.newSession({ cwd });
      activeSessionId = sess.sessionId;

      if (retainSession) {
        // N2 overwrite leak fix: close any superseded client for this sessionKey
        const old = retainedAcpModelSessions.get(sessionKey);
        if (old && old.client && old.client !== client) {
          try { old.client.close(); } catch { /* best-effort cleanup of superseded client */ }
        }
        retainedAcpModelSessions.set(sessionKey, {
          client,
          sessionId: sess.sessionId,
          threadId,
          harnessId,
          url,
          cwd,
          availableCommands: client.availableCommands || [],
          inFlightTurn: false,
          currentTurnOwnerToken: null,
          activeExecutionId: null,
          lastActiveAt: Date.now(),
        });
      }

      return { sessionId: sess.sessionId, resumed: false };
    })();

    if (retainSession) {
      connectingAcpModelSessions.set(sessionKey, connectPromise);
    }
    try {
      return await connectPromise;
    } finally {
      if (retainSession) {
        connectingAcpModelSessions.delete(sessionKey);
      }
    }
  }
  async function start(prompt) {
    const session = await connectSession(true);
    const rec = retainedAcpModelSessions.get(sessionKey);
    if (rec) {
      rec.inFlightTurn = true;
      rec.currentTurnOwnerToken = instanceOwnerToken;
      rec.activeExecutionId = executionId;
      rec.lastActiveAt = Date.now();
    }
    try {
      // ACP has no system-prompt setter. Pass the complete CAP prompt, including
      // protected untrusted-content rules, as explicitly labelled conversation data.
      const text = ACP_PROMPT_ENVELOPE + JSON.stringify(prompt);
      await client.prompt(session.sessionId, text, (event) => {
        if (event.kind !== "chunk" || !controller || closed) return;
        const id = `acp-text-${++textId}`;
        controller.enqueue({ type: "text-start", id });
        controller.enqueue({ type: "text-delta", id, delta: event.text });
        controller.enqueue({ type: "text-end", id });
      });
      finished = true;
      finish("stop");
    } finally {
      if (rec && rec.currentTurnOwnerToken === instanceOwnerToken) {
        rec.inFlightTurn = false;
        rec.currentTurnOwnerToken = null;
        rec.activeExecutionId = null;
        rec.lastActiveAt = Date.now();
      }
    }
  }
  const backend = {
    specificationVersion: "v2",
    provider: "acp",
    providerName: "acp",
    modelId: harnessId,
    supportedUrls: {},
    async doStream(options) {
      if (closed) throw new Error("CAP harness turn has ended");
      if (finished) {
        if (!retainSession && !fromRetained) client?.close();
        finished = false;
        started = false;
      }
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
      const child = createAcpModel({ threadId, url, cwd, harnessId, permissionHandler, executionId, clientFactory, retainSession });
      children.add(child);
      return child;
    },
    close() {
      for (const child of children) child.close();
      children.clear();
      const rec = retainedAcpModelSessions.get(sessionKey);
      // Strictly verify that THIS instance owns the in-flight turn via per-instance token.
      // Another instance (such as discoveryBackend.close() upon catalogue arrival) must NEVER
      // clear the in-flight turn fence or issue session/cancel on a live turn!
      if (rec && rec.currentTurnOwnerToken === instanceOwnerToken) {
        try { client?.cancel?.(activeSessionId); } catch { /* cancel is best-effort when closing */ }
        rec.inFlightTurn = false;
        rec.currentTurnOwnerToken = null;
        rec.activeExecutionId = null;
        rec.lastActiveAt = Date.now();
      }
      if (!retainSession && !fromRetained) {
        fail(new Error("CAP run ended"));
      } else {
        closed = true;
        controller?.close();
        controller = null;
        detachAbort();
      }
    },
  };
  return {
    async discoverCommands(waitMs = 3000) {
      // Note (N4 / B1 capability declaration): During discovery, pass capTools: false so no toolHandler
      // is mounted on the client. The bridge initialize declares _meta.capTools: true upfront so the
      // capability channel is established, but the actual toolHandler is only mounted when doStream runs.
      let announce;
      const arrived = new Promise((resolve) => { announce = resolve; });
      const session = await connectSession(false, announce);
      let timer;
      try {
        if (!client.commandsReceived) await Promise.race([arrived, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
        return { sessionId: session.sessionId, received: client.commandsReceived === true, commands: client.availableCommands || [] };
      } finally { clearTimeout(timer); }
    },
    model: backend,
    modelId: harnessId,
    providerName: "acp",
    providerLane: "acp",
    fork: backend.fork,
    close: backend.close,
  };
}
