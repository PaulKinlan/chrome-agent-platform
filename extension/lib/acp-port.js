// extension/lib/acp-port.js — the MessageChannel transport for an IN-BROWSER
// ACP harness (chrome-agent-platform-qnd4 / 11rm-adjacent, Stage: harness
// transport). The harness runs in a sandboxed frame (opaque origin, no
// chrome.*, connect-src 'none'); this transport carries the ACP JSON-RPC
// frames between the extension page (the runner) and that frame over a
// MessageChannel port.
//
// Contract mirror of AcpNativeTransport (the runner injects either):
//   connect(): Promise — resolves after a NONCE HANDSHAKE (a bare port has no
//     connect/disconnect signals, so the handshake stands in for them; it
//     fails closed: wrong nonce, no ack inside the window, or a non-ack first
//     message all close the transport with a named error).
//   send(raw string): parsed and posted on the port (Chrome frames port
//     messages as objects; the stringify/parse boundary sits here, exactly as
//     in the native transport).
//   onMessage(raw string) / onClose(reason) / close() / closed / lastError.
//
// Fail-closed rules (this transport bridges a privileged extension page to a
// sandboxed harness — a wrong peer must never be promoted to "connected"):
//   * the constructor refuses a missing/empty nonce;
//   * a hello ack carrying a different nonce closes the transport;
//   * any non-ack first message during the handshake closes the transport.

/** @typedef {{ port?: any, nonce?: string, handshakeTimeoutMs?: number }} AcpPortOptions */

export const PORT_HELLO = "acp-port-hello";
export const PORT_HELLO_ACK = "acp-port-hello-ack";
export const PORT_BYE = "acp-port-bye";

export class AcpPortTransport {
  /** @param {AcpPortOptions} options */
  constructor(options = {}) {
    // Fail closed at CONSTRUCTION: a transport without a shared nonce must not
    // exist at all (a rejected connect() could still be fired-and-forgotten by
    // a careless caller, leaving an unauthenticated channel object alive).
    if (typeof options.nonce !== "string" || options.nonce.length === 0) {
      throw new TypeError("acp port transport requires a shared nonce — refusing an unauthenticated channel");
    }
    this.port = options.port ?? null;
    this.nonce = options.nonce;
    this.handshakeTimeoutMs = Number(options.handshakeTimeoutMs ?? 2000);
    /** @type {((raw: string) => void)|null} */
    this.onMessage = null;
    /** @type {((reason: string) => void)|null} */
    this.onClose = null;
    this.closed = false;
    this.lastError = "";
    this._onPortMessage = (ev) => this._receive(ev?.data);
  }

  /**
   * Run the nonce handshake over the port. Resolves once the peer proves it
   * holds the same nonce; every other outcome closes the transport.
   */
  connect() {
    if (!this.nonce) {
      this.closed = true;
      return Promise.reject(new Error("acp port transport requires a shared nonce — refusing an unauthenticated channel"));
    }
    if (!this.port || typeof this.port.postMessage !== "function") {
      this.closed = true;
      return Promise.reject(new Error("acp port transport requires a MessagePort-like port"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      this.port.onmessage = (ev) => {
        const msg = ev?.data;
        if (settled) {
          this._frame(msg);
          return;
        }
        if (!msg || msg.type !== PORT_HELLO_ACK) {
          settled = true;
          this._fail(`acp port handshake: the first message was not a hello ack (${String(msg?.type ?? msg)})`);
          reject(new Error(this.lastError));
          return;
        }
        if (msg.nonce !== this.nonce) {
          settled = true;
          this._fail("acp port handshake: nonce mismatch — refusing the channel");
          reject(new Error(this.lastError));
          return;
        }
        settled = true;
        resolve();
      };
      try {
        this.port.postMessage({ type: PORT_HELLO, nonce: this.nonce });
      } catch (err) {
        settled = true;
        this._fail(`acp port handshake could not post the hello: ${String(err?.message ?? err)}`);
        reject(new Error(this.lastError));
        return;
      }
      setTimeout(() => {
        if (settled) return;
        settled = true;
        this._fail(`acp port handshake timed out after ${this.handshakeTimeoutMs}ms — the harness frame never acknowledged the nonce`);
        reject(new Error(this.lastError));
      }, this.handshakeTimeoutMs);
    });
  }

  /** @param {string} raw */
  send(raw) {
    if (!this.port || this.closed) throw new Error("ACP port transport is not connected.");
    this.port.postMessage(JSON.parse(raw));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port?.postMessage?.({ type: PORT_BYE });
    } catch {
      // a dead port cannot receive the bye; the close still stands
    }
    try {
      this.port?.close?.();
    } catch {
      // already gone
    }
    this.port = null;
  }

  /** @private */
  _fail(reason) {
    this.lastError = reason;
    this.closed = true;
    try {
      this.port?.close?.();
    } catch {
      // already gone
    }
    this.onClose?.(reason);
  }

  /** @private */
  _frame(msg) {
    if (msg && msg.type === PORT_BYE) {
      this.closed = true;
      this.lastError = "the harness frame closed the channel";
      this.onClose?.(this.lastError);
      return;
    }
    try {
      this.onMessage?.(JSON.stringify(msg ?? null));
    } catch {
      // a consumer error must not kill the port
    }
  }

  /** @private */
  _receive(msg) {
    if (this.closed) return;
    this._frame(msg);
  }
}
