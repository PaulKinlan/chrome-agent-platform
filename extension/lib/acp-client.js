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
 * @typedef {Object} AcpClientOptions
 * @property {string} [url] - WebSocket URL to ACP bridge (default: 'ws://127.0.0.1:3210/acp')
 * @property {string} [defaultCwd] - Default working directory for sessions
 * @property {number} [requestTimeoutMs] - Request timeout in milliseconds (default: 120,000)
 * @property {(permission: AcpPermissionRequest) => Promise<string|null>} [permissionHandler]
 * @property {any} [transport] - Optional explicit transport (for testing)
 */

/**
 * @typedef {Object} AcpPermissionRequest
 * @property {string} [title]
 * @property {Array<{optionId: string, name?: string, kind?: string}>} options
 * @property {Record<string, unknown>} [toolCall]
 */

export class AcpClient {
  /**
   * @param {AcpClientOptions} [options]
   */
  constructor(options = {}) {
    this.url = options.url || "ws://127.0.0.1:3210/acp";
    this.defaultCwd = options.defaultCwd || "";
    this.requestTimeoutMs = options.requestTimeoutMs || 120_000;
    this.permissionHandler = options.permissionHandler || null;
    this.customTransport = options.transport || null;

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
    this.connected = false;
    this.activeSessionId = null;
  }

  /**
   * Connect to the ACP server/bridge.
   * @param {string} [urlOverride]
   * @returns {Promise<void>}
   */
  async connect(urlOverride) {
    if (urlOverride) this.url = urlOverride;

    if (this.customTransport) {
      this.connected = true;
      return;
    }

    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) {
      throw new Error("WebSocket is not supported in this runtime environment.");
    }

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocketImpl(this.url);
        this.ws = ws;

        const connectDeadline = setTimeout(() => {
          if (!this.connected) {
            ws.close();
            reject(new Error(`Connection to ACP harness at ${this.url} timed out.`));
          }
        }, 10_000);

        ws.onopen = () => {
          clearTimeout(connectDeadline);
          this.connected = true;
          resolve();
        };

        ws.onerror = (err) => {
          clearTimeout(connectDeadline);
          const msg = `Failed to connect to ACP harness at ${this.url}`;
          if (!this.connected) reject(new Error(msg));
        };

        ws.onclose = (event) => {
          this.connected = false;
          const err = new Error(`ACP harness connection closed (code: ${event.code}, reason: ${event.reason || "none"})`);
          this._abortPending(err);
        };

        ws.onmessage = (event) => {
          this._receiveRaw(String(event.data));
        };
      } catch (err) {
        reject(err);
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
    const cwd = params.cwd || this.defaultCwd || "/";
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];

    const result = await this.request("session/new", { cwd, mcpServers });
    const sessionId = String(result?.sessionId ?? "");
    if (!sessionId) {
      throw new Error("ACP server returned session/new without a valid sessionId");
    }
    this.activeSessionId = sessionId;
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
    const cwd = params.cwd || this.defaultCwd || "/";
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];

    await this.request("session/load", { sessionId: params.sessionId, cwd, mcpServers });
    this.activeSessionId = params.sessionId;
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
    this.connected = false;
    this._abortPending(new Error("ACP client closed"));
    if (this.ws) {
      try { this.ws.close(); } catch {}
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
      this._send(msg);
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
      this._handleSessionUpdate(msg.params?.update);
    }
  }

  /**
   * Handle agent-initiated requests (e.g. permission requests).
   * @private
   */
  async _handleAgentRequest(msg) {
    if (msg.method === "session/request_permission") {
      const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
      let selectedOptionId = null;

      if (typeof this.permissionHandler === "function") {
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

      // Default fallback: select option matching 'allow', else first option
      if (!selectedOptionId) {
        const allow =
          options.find((o) => /allow/i.test(`${o.kind ?? ""} ${o.optionId ?? ""} ${o.name ?? ""}`)) ??
          options[0];
        selectedOptionId = allow?.optionId ?? null;
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
  _handleSessionUpdate(update) {
    if (!update || typeof update !== "object") return;
    const kind = update.sessionUpdate;

    if (kind === "agent_message_chunk") {
      const text = String(update.content?.text ?? "");
      this.activeTurnListener?.({ kind: "chunk", text, raw: update });
    } else if (kind === "agent_thought_chunk") {
      const text = String(update.content?.text ?? "");
      this.activeTurnListener?.({ kind: "thought", text, raw: update });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const detail = String(update.title ?? update.toolCallId ?? update.name ?? "");
      this.activeTurnListener?.({ kind: "tool", detail, raw: update });
    } else if (kind === "available_commands_update") {
      if (Array.isArray(update.availableCommands)) {
        this.availableCommands = update.availableCommands;
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
