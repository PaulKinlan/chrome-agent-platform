// extension/lib/acp-client.js — Agent Client Protocol (ACP) client for Chrome Agent Platform.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Implements the ACP 1 client specification over WebSocket or stream transport:
//   - JSON-RPC 2.0 framing, integer protocolVersion: 1
//   - Handshake: initialize with capability declarations
//   - Session lifecycle: session/new and session/load with durable resume
//   - Prompt turn dispatch: session/prompt with streaming updates (chunks, thoughts, tool calls)
//   - Permission negotiation: session/request_permission handler
//
// Pure JavaScript, browser-safe, runs in MV3 Service Worker and Extension pages.

/**
 * @typedef {Object} AcpTurnEvent
 * @property {'chunk'|'thought'|'tool'|'permission'|'commands'|'info'|'other'} kind
 * @property {string} [text]
 * @property {string} [detail]
 * @property {Record<string, unknown>} [raw]
 */

/**
 * Is this ACP endpoint on the LOOPBACK interface?
 *
 * jsjy (2026-10-06): an `acp.endpoint` pointing anywhere else is refused before
 * a socket is opened. The bridge speaks plain ws:// and hands the harness our
 * approval surface, so a non-loopback endpoint means the token and the agent's
 * traffic cross the network in the clear, and the peer is not provably this
 * machine's bridge. Loopback means 127.0.0.0/8, ::1 or localhost — the
 * interface the bridge binds by default (`--host 127.0.0.1`).
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLoopbackAcpEndpoint(url) {
  let host;
  try {
    host = new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Refuse a non-loopback ACP endpoint rather than connecting to it (jsjy).
 * @param {string} url
 */
function assertLoopbackEndpoint(url) {
  if (isLoopbackAcpEndpoint(url)) return;
  throw new Error(
    `ACP endpoint ${url} is not on loopback — refusing to connect. ` +
      `The bridge speaks plain ws:// and drives the local approval surface, so only a loopback ` +
      `endpoint (127.0.0.1, ::1 or localhost) is accepted. Run the bridge with its default ` +
      `--host and put TLS in front of it if it must be reached remotely.`,
  );
}

/**
 * @typedef {Object} AcpClientOptions
 * @property {string} [url] - WebSocket URL to ACP bridge (default: 'ws://127.0.0.1:3210/acp')
 * @property {string} [defaultCwd] - Default working directory for sessions
 * @property {number} [requestTimeoutMs] - Request timeout in milliseconds (default: 120,000)
 * @property {(permission: AcpPermissionRequest) => Promise<string|null>} [permissionHandler]
 * @property {(commands: any[]) => void} [onCommands]
 * @property {any} [transport] - Optional explicit transport (for testing)
 */

/** Derive the bridge's /acp/preflight HTTP URL from an ACP WebSocket endpoint,
 * carrying the SAME token + harness query so the diagnostic reports THIS
 * connection's refusal reason (chrome-agent-platform-e25gk). */
export function acpPreflightUrl(endpoint) {
  const url = String(endpoint ?? "").trim();
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return "";
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/acp/preflight";
    return u.toString();
  } catch {
    return "";
  }
}

/** Ask the bridge WHY an ACP connection would be refused. The browser's
 * WebSocket API hides the HTTP status/body of a refused upgrade (it fires only
 * an opaque "error" then close 1006), so this plain-HTTP probe is the one way to
 * learn the real cause. Returns `{ reason, detail }` on a structured refusal,
 * or null when the bridge admits the connection or cannot be reached. */
export async function acpProbeConnectionFailure(endpoint) {
  const url = acpPreflightUrl(endpoint);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return null;
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON refusal body */ }
    if (body && typeof body.reason === "string") {
      return { reason: body.reason, detail: String(body.detail ?? body.reason) };
    }
    return { reason: "refused", detail: `the ACP bridge refused the connection (HTTP ${res.status})` };
  } catch {
    return null; // unreachable — the generic "failed to connect" message applies
  }
}

/** The user-facing, actionable message for an ACP connection refusal
 * (chrome-agent-platform-e25gk). Maps the preflight's structured reason to words
 * that tell the operator WHAT to fix, instead of a generic "failed to connect".
 * Returns "" when there is nothing more specific to say. */
export function acpConnectionErrorMessage(refusal) {
  const reason = refusal?.reason ?? "";
  // The token field lives at Settings → Agents → External agent harnesses (ACP) →
  // Token (options.html, wired by renderAcpSettings). The bridge accepts the
  // secret either pasted there (acp.token) or passed at start-up with --token / a
  // custom --token-file, so both are named (the token became mandatory on EVERY
  // connection, loopback included, in 0.3.578; there is no unauthenticated WS mode).
  const TOKEN_HINT = "Settings → Agents → External agent harnesses (ACP) → Token (the acp.token setting)";
  if (reason === "token-missing") {
    return "Authentication required: the ACP bridge needs its shared token, but none was provided. " +
      `Paste the token from $XDG_CONFIG_HOME/cap-acp/bridge-token into ${TOKEN_HINT}, or run the bridge ` +
      "with --token (or --token-file to name your own file), then retry.";
  }
  if (reason === "token-invalid") {
    return "Authentication failed: the token in acp.token does not match the ACP bridge's token. " +
      `Re-copy it from $XDG_CONFIG_HOME/cap-acp/bridge-token into ${TOKEN_HINT}, or run the bridge ` +
      "with --token (or --token-file) to pin the secret it expects.";
  }
  if (reason === "origin-rejected") {
    return "Origin rejected: the ACP bridge refused a connection from this page's origin. " +
      "Only extension pages and local scripts may drive the harness.";
  }
  if (refusal?.detail) {
    return `Failed to connect to ACP harness: ${refusal.detail}`;
  }
  return "";
}

/**
 * @typedef {Object} AcpPermissionRequest
 * @property {string} [title]
 * @property {Array<{optionId: string, name?: string, kind?: string}>} options
 * @property {Record<string, unknown>} [toolCall]
 */

/** The option an APPROVAL should answer with: the NARROWEST allow the harness
 * offers ("allow once" over "allow always"), else any allow, else nothing. */
export function acpAllowOptionId(options = []) {
  const list = Array.isArray(options) ? options : [];
  const text = (o) => `${o?.kind ?? ""} ${o?.optionId ?? ""} ${o?.name ?? ""}`.toLowerCase();
  const once = list.find((o) => /allow[_\s-]?once|allow_once|once/.test(text(o)) && /allow/.test(text(o)));
  const anyAllow = list.find((o) => /allow/.test(text(o)));
  return (once ?? anyAllow)?.optionId ?? null;
}

/** The option a DENIAL should answer with (fail closed): an explicit deny
 * option when the harness offers one, else null — which ACP reads as "no
 * selection", never as approval. */
export function acpDenyOptionId(options = []) {
  const list = Array.isArray(options) ? options : [];
  const deny = list.find((o) => /deny|reject|cancel|no\b/i.test(`${o?.kind ?? ""} ${o?.optionId ?? ""} ${o?.name ?? ""}`));
  return deny?.optionId ?? null;
}

export class AcpClient {
  /**
   * @param {AcpClientOptions} [options]
   */
  constructor(options = {}) {
    this.url = options.url || "ws://127.0.0.1:3210/acp";
    assertLoopbackEndpoint(this.url);
    this.defaultCwd = options.defaultCwd || "";
    this.requestTimeoutMs = options.requestTimeoutMs || 120_000;
    this.permissionHandler = options.permissionHandler || null;
    this.customTransport = options.transport || null;
    this.executionId = typeof options.executionId === "string" ? options.executionId : null;
    this.toolHandler = options.toolHandler || null;

    /** @type {WebSocket|null} */
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (res: any) => void, reject: (err: Error) => void, deadline: any}>} */
    this.pending = new Map();
    /** @type {((event: AcpTurnEvent) => void)|null} */
    this.activeTurnListener = null;

    this.agentInfo = null;
    this.agentCapabilities = null;
    this.authMethods = [];
    this.availableCommands = [];
    this.commandsReceived = false;
    this.onCommands = options.onCommands || null;
    this.pendingCommands = null;
    this.connected = false;
    this.activeSessionId = null;
  }

  setExecutionId(id) {
    this.executionId = typeof id === "string" ? id : null;
  }

  /**
   * Connect to the ACP server/bridge.
   * @param {string} [urlOverride]
   * @returns {Promise<void>}
   */
  async connect(urlOverride) {
    if (urlOverride) {
      assertLoopbackEndpoint(urlOverride);
      this.url = urlOverride;
    }

    if (this.customTransport) {
      this.connected = true;
      return;
    }

    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) {
      throw new Error("WebSocket is not supported in this runtime environment.");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let connectDeadline = null;
      const settleFail = (err) => {
        if (settled) return;
        settled = true;
        if (connectDeadline) clearTimeout(connectDeadline);
        reject(err);
      };
      // The browser hides WHY a WebSocket upgrade was refused (it fires an opaque
      // "error" then close 1006, never the 403 status or body). Probe the bridge's
      // /acp/preflight so the caller can tell "auth required" from "origin
      // rejected" (chrome-agent-platform-e25gk). Idempotent via settleFail.
      const failWithReason = (fallbackMsg) => {
        acpProbeConnectionFailure(this.url).then((refusal) => {
          const detail = acpConnectionErrorMessage(refusal);
          settleFail(new Error(detail || fallbackMsg));
        });
      };

      try {
        const ws = new WebSocketImpl(this.url);
        this.ws = ws;

        connectDeadline = setTimeout(() => {
          if (!this.connected) {
            try { ws.close(); } catch { /* already closing */ }
            settleFail(new Error(`Connection to ACP harness at ${this.url} timed out.`));
          }
        }, 10_000);

        ws.onopen = () => {
          if (connectDeadline) clearTimeout(connectDeadline);
          this.connected = true;
          if (!settled) { settled = true; resolve(); }
        };

        ws.onerror = () => {
          if (connectDeadline) clearTimeout(connectDeadline);
          if (!this.connected) {
            failWithReason(`Failed to connect to ACP harness at ${this.url}`);
          }
        };

        ws.onclose = (event) => {
          this._resetCommands();
          this.activeSessionId = null;
          this.connected = false;
          const err = new Error(`ACP harness connection closed (code: ${event.code}, reason: ${event.reason || "none"})`);
          this._abortPending(err);
          if (!settled) {
            failWithReason(err.message);
          }
        };

        ws.onmessage = (event) => {
          this._receiveRaw(String(event.data));
        };
      } catch (err) {
        settleFail(err);
      }
    });
  }

  /**
   * Send JSON-RPC initialize handshake.
   * @param {Record<string, unknown>} [capabilities]
   * @returns {Promise<any>}
   */
  async initialize(capabilities = {}) {
    const params = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...capabilities,
      },
    };

    const result = await this.request("initialize", params);
    this.agentInfo = result?.agentInfo || null;
    this.agentCapabilities = result?.agentCapabilities || null;
    this.authMethods = Array.isArray(result?.authMethods) ? result.authMethods : [];
    return result;
  }

  /**
   * Create a new agent session.
   * @param {{cwd?: string, mcpServers?: any[]}} [params]
   * @returns {Promise<{sessionId: string, models?: any, availableCommands?: any[]}>}
   */
  async newSession(params = {}) {
    // No invented "/" fallback: an empty cwd is passed through so a host-side
    // bridge can supply its own default (session/new is its own protocol call).
    const cwd = params.cwd ?? this.defaultCwd ?? "";
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];

    // The reset below is deliberate: clearing the id de-targets in-flight
    // session/update frames from the OLD session while the new one is being
    // negotiated, and the command list is the old session's. But a session/new
    // that FAILS must not cost the caller the session it already had, so the
    // prior values are captured first and restored on rejection or on a
    // malformed response (chrome-agent-platform-1gf1). A session/new that
    // SUCCEEDS keeps the new state — failures after that point (command
    // callbacks) must not roll a live session back.
    const priorSessionId = this.activeSessionId;
    const priorAvailableCommands = this.availableCommands;
    const priorCommandsReceived = this.commandsReceived;
    const priorPendingCommands = this.pendingCommands;
    const restorePriorSession = () => {
      this.activeSessionId = priorSessionId;
      this.availableCommands = priorAvailableCommands;
      this.commandsReceived = priorCommandsReceived;
      this.pendingCommands = priorPendingCommands;
    };

    this._resetCommands();
    this.activeSessionId = null;
    let result;
    try {
      result = await this.request("session/new", { cwd, mcpServers });
    } catch (error) {
      restorePriorSession();
      throw error;
    }
    const sessionId = String(result?.sessionId ?? "");
    if (!sessionId) {
      restorePriorSession();
      throw new Error("ACP server returned session/new without a valid sessionId");
    }
    this.activeSessionId = sessionId;
    if (this.pendingCommands?.sessionId === sessionId) this._acceptCommands(this.pendingCommands.commands);
    this.pendingCommands = null;
    return {
      sessionId,
      models: result?.models ?? null,
      availableCommands: this.availableCommands,
    };
  }

  /**
   * Resume an existing agent session.
   * @param {{sessionId: string, cwd?: string, mcpServers?: any[]}} params
   * @returns {Promise<{sessionId: string, resumed: boolean}>}
   */
  async loadSession(params) {
    if (!params?.sessionId) throw new Error("loadSession requires a sessionId");
    const cwd = params.cwd ?? this.defaultCwd ?? "";
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];

    // Capture BEFORE the reset: the reset destroys the command list too, and a
    // REFUSED load must put it back — the same contract 1gf1 gives a refused
    // newSession (chrome-agent-platform-djz9). The reset itself stays: the
    // session being loaded advertises its OWN commands (available_commands_update
    // arrives against the optimistic id below), so the success path must start
    // empty.
    const priorSessionId = this.activeSessionId;
    const priorAvailableCommands = this.availableCommands;
    const priorCommandsReceived = this.commandsReceived;
    const priorPendingCommands = this.pendingCommands;
    const restorePriorSession = () => {
      this.activeSessionId = priorSessionId;
      this.availableCommands = priorAvailableCommands;
      this.commandsReceived = priorCommandsReceived;
      this.pendingCommands = priorPendingCommands;
    };

    this._resetCommands();
    // The id is optimistic ON PURPOSE: session/update frames that arrive while
    // the load is in flight are filtered against activeSessionId
    // (_handleSessionUpdate), so the session being loaded is the one they
    // attribute to. What must NOT survive is that optimistic id when the load is
    // REFUSED — the client would report a live session it never activated and
    // keep filtering that session's notifications (chrome-agent-platform-tliw:
    // the Pi tool-server refusal leaked ses_fake_1 into the client). Restore the
    // previous value on rejection and let the error propagate unchanged.
    this.activeSessionId = params.sessionId;
    try {
      await this.request("session/load", { sessionId: params.sessionId, cwd, mcpServers });
    } catch (error) {
      restorePriorSession();
      throw error;
    }
    return { sessionId: params.sessionId, resumed: true };
  }

  /**
   * Dispatch a prompt turn.
   * @param {string} sessionId
   * @param {string} text
   * @param {((event: AcpTurnEvent) => void)} [onEvent]
   * @param {Array<{type: string, data?: string, mimeType?: string}>} [attachments]
   * @returns {Promise<{stopReason: string, text: string}>}
   */
  async prompt(sessionId, text, onEvent = null, attachments = []) {
    const promptParts = [{ type: "text", text: String(text ?? "") }];
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att && typeof att === "object") {
          promptParts.push(att);
        }
      }
    }

    const collectedText = [];
    this.activeTurnListener = (event) => {
      if (event.kind === "chunk" && event.text) {
        collectedText.push(event.text);
      }
      onEvent?.(event);
    };

    try {
      const result = await this.request(
        "session/prompt",
        { sessionId, prompt: promptParts },
        600_000,
      );
      return {
        stopReason: String(result?.stopReason ?? "end_turn"),
        text: collectedText.join(""),
      };
    } finally {
      this.activeTurnListener = null;
    }
  }

  /**
   * Cancel an active turn.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async cancel(sessionId) {
    if (!sessionId) return;
    try {
      await this.request("session/cancel", { sessionId });
    } catch {
      // Ignore cancellation failures
    }
  }

  /**
   * Close the connection.
   */
  close() {
    this._resetCommands();
    this.activeSessionId = null;
    this.connected = false;
    this._abortPending(new Error("ACP client closed"));
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closing/closed; teardown continues */ }
      this.ws = null;
    }
  }

  /**
   * Low-level JSON-RPC request.
   * @param {string} method
   * @param {any} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const ms = timeoutMs || this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP request "${method}" (id ${id}) timed out after ${Math.round(ms / 1000)}s`));
        }
      }, ms);

      this.pending.set(id, { resolve, reject, deadline });

      const msg = { jsonrpc: "2.0", id, method, params };
      try { this._send(msg); }
      catch (error) { clearTimeout(deadline); this.pending.delete(id); reject(error); }
    });
  }

  /**
   * @private
   */
  _send(msg) {
    const raw = JSON.stringify(msg);
    if (this.customTransport?.send) {
      this.customTransport.send(raw);
    } else if (this.ws && this.connected) {
      this.ws.send(raw);
    } else {
      throw new Error("ACP client is not connected.");
    }
  }

  /**
   * Handle incoming raw text chunk.
   * @param {string} text
   */
  _receiveRaw(text) {
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch {
        // Skip unparseable framing
      }
    }
  }

  /**
   * Handle an inbound parsed JSON-RPC message.
   * @param {any} msg
   */
  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    // Response to a request we sent
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.deadline);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `ACP error ${msg.error.code}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Inbound request from Agent (e.g. session/request_permission)
    if (msg.method !== undefined && msg.id !== undefined) {
      this._handleAgentRequest(msg);
      return;
    }

    // Inbound notification (e.g. session/update)
    if (msg.method === "session/update") {
      this._handleSessionUpdate(msg.params?.update, msg.params?.sessionId);
    }
  }

  /**
   * Handle agent-initiated requests (e.g. permission requests).
   * @private
   */
  async _handleAgentRequest(msg) {
    // CAP's browser tools, called BY THE HARNESS over this same connection (2amt). The harness is
    // told the catalogue in its opening prompt by scripts/acp-bridge.ts, and calls back with
    // {"method":"browser/call_tool","params":{"name":…,"args":…}}. Everything the tool decides —
    // permissions, the browser-control grant, the consent card — is decided inside the tool, so this
    // is a transport, not a new source of authority.
    if (msg.method === "_cap/tools/list" || msg.method === "_cap/tools/call") {
      if (!this.toolHandler) {
        this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      try {
        const result = await this.toolHandler(msg.method, msg.params);
        this._send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (error) {
        this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(error?.message ?? error) } });
      }
      return;
    }
    if (msg.method === "browser/call_tool") {
      if (this.toolHandler) {
        this._send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "browser/call_tool is disabled when toolHandler is configured" },
        });
        return;
      }
      let result;
      try {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        const args = (msg.params?.args && typeof msg.params.args === "object") ? { ...msg.params.args } : {};
        // Strip any harness-injected executionId or approved flags (security boundary: ACP-SQF5).
        // DO NOT strip args.id: browser tools (e.g. close_window, remove_bookmark) take an id argument.
        delete args.executionId;
        delete args.approved;
        this.activeTurnListener?.({ kind: "tool", detail: `browser:${name || "(unnamed)"}`, raw: msg.params });
        // THE SERVICE WORKER RUNS THE TOOL under principal 'model' with this.executionId.
        const reply = await chrome.runtime.sendMessage({
          type: "browser.callTool",
          name,
          args,
          executionId: this.executionId || "",
        });
        result = reply && reply.ok === false && reply.error !== undefined ? { error: reply.error } : reply;
      } catch (error) {
        result = { error: `browser tool dispatch failed: ${String((error && error.message) || error)}` };
      }
      this._send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.method === "session/request_permission") {
      const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
      let selectedOptionId = null;
      const asked = typeof this.permissionHandler === "function";

      if (asked) {
        try {
          selectedOptionId = await this.permissionHandler({
            title: msg.params?.toolCall?.title ?? "a tool",
            options,
            toolCall: msg.params?.toolCall,
          });
        } catch {
          selectedOptionId = null;
        }
      }

      // A gate that answers with anything but a non-empty STRING option id has
      // not approved anything: treat it as no answer (and therefore a denial)
      // rather than forwarding a malformed value to the harness.
      if (asked && (typeof selectedOptionId !== "string" || !selectedOptionId)) selectedOptionId = null;

      // WHEN A HANDLER IS CONFIGURED, an unanswered request is a DENIAL: the
      // owner's gate either chose an option or it did not, and a request the
      // owner never approved must never be answered with an allow just because
      // one exists in the list. The old behaviour (pick any allow) is now the
      // explicit AUTO mode only — a client with NO handler at all.
      if (!selectedOptionId) {
        selectedOptionId = asked
          ? acpDenyOptionId(options)
          : acpAllowOptionId(options);
      }

      this.activeTurnListener?.({
        kind: "permission",
        detail: `${msg.params?.toolCall?.title ?? "a tool"} → ${selectedOptionId ?? "denied"}`,
        raw: msg.params,
      });

      this._send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: selectedOptionId } },
      });
      return;
    }

    if (this.toolHandler && ["_cap/tools/list", "_cap/tools/call"].includes(msg.method)) {
      try {
        const result = await this.toolHandler(msg.method, msg.params);
        this._send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (error) {
        if (this.connected) this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(error?.message ?? error) } });
      }
      return;
    }

    // Unsupported agent request
    this._send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `${msg.method} is not supported by this client` },
    });
  }

  /**
   * Handle streaming session updates.
   * @private
   */
  _resetCommands() {
    this.availableCommands = [];
    this.commandsReceived = false;
    this.pendingCommands = null;
  }

  _acceptCommands(commands) {
    this.availableCommands = commands;
    this.commandsReceived = true;
    this.onCommands?.(commands);
  }

  _handleSessionUpdate(update, sessionId) {
    if (!update || typeof update !== "object") return;
    const kind = update.sessionUpdate;

    if (kind === "agent_message_chunk") {
      const text = String(update.content?.text ?? "");
      this.activeTurnListener?.({ kind: "chunk", text, raw: update });
    } else if (kind === "agent_thought_chunk") {
      const text = String(update.content?.text ?? "");
      this.activeTurnListener?.({ kind: "thought", text, raw: update });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      // toolCallId + status travel with the event so a consumer can SETTLE the
      // card a call already created instead of appending a new one per update.
      const detail = String(update.title ?? update.toolCallId ?? update.name ?? "");
      this.activeTurnListener?.({
        kind: "tool",
        detail,
        toolCallId: String(update.toolCallId ?? ""),
        status: String(update.status ?? (kind === "tool_call" ? "running" : "")),
        raw: update,
      });
    } else if (kind === "available_commands_update") {
      if (Array.isArray(update.availableCommands)) {
        if (!sessionId) return;
        if (!this.activeSessionId) {
          this.pendingCommands = { sessionId, commands: update.availableCommands };
          return;
        }
        if (sessionId !== this.activeSessionId) return;
        this._acceptCommands(update.availableCommands);
        this.activeTurnListener?.({ kind: "commands", detail: `${update.availableCommands.length} commands`, raw: update });
      }
    } else if (kind === "session_info_update") {
      this.activeTurnListener?.({ kind: "info", raw: update });
    } else {
      this.activeTurnListener?.({ kind: "other", detail: kind || "", raw: update });
    }
  }

  /**
   * @private
   */
  _abortPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.deadline);
      p.reject(err);
    }
    this.pending.clear();
  }
}
