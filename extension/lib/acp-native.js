// extension/lib/acp-native.js — the Chrome NATIVE MESSAGING transport for the
// ACP client: the extension talks to a locally-installed host process that
// Chrome launches on demand. No WebSocket, no port, no daemon to run — the
// "bridge" disappears; Chrome is the only thing that starts anything.
//
// The host (scripts/acp-native-host.ts) speaks the same JSON-RPC frames the
// bridge relays, so AcpClient needs no protocol change: it takes an injected
// transport and this module is one.
//
// Frames: chrome.runtime.Port messages are already objects (Chrome does the
// 4-byte length framing), which is why this transport stringifies/parses at the
// boundary and hands AcpClient exactly what its WebSocket path would.

/** @typedef {{ hostName?: string, nativeConnect?: (name: string) => any }} AcpNativeOptions */

/** The default installed host name (see scripts/acp-native-install.mjs). */
export const DEFAULT_NATIVE_HOST = "com.chrome_agent_platform.acp";

/**
 * A transport over chrome.runtime.connectNative. `connect()` resolves once the
 * port is up; a host that is not installed rejects with an actionable message
 * (Chrome reports it on disconnect, not on connect).
 */
export class AcpNativeTransport {
  /** @param {AcpNativeOptions} [options] */
  constructor(options = {}) {
    this.hostName = options.hostName || DEFAULT_NATIVE_HOST;
    this.nativeConnect = options.nativeConnect
      || (typeof chrome !== "undefined" && chrome?.runtime?.connectNative
        ? (name) => chrome.runtime.connectNative(name)
        : null);
    /** @type {any} */
    this.port = null;
    /** @type {((raw: string) => void)|null} */
    this.onMessage = null;
    /** @type {((reason: string) => void)|null} */
    this.onClose = null;
    this.closed = false;
    this.lastError = "";
  }

  /** Open the native port. Rejects (with the install hint) when unavailable. */
  connect() {
    if (!this.nativeConnect) {
      return Promise.reject(new Error("native messaging is not available in this context"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let port;
      try {
        port = this.nativeConnect(this.hostName);
      } catch (err) {
        reject(new Error(`native host "${this.hostName}" could not be started: ${String(err?.message ?? err)}`));
        return;
      }
      this.port = port;
      // Chrome reports a missing host asynchronously, as a disconnect.
      port.onMessage?.addListener?.((msg) => {
        try { this.onMessage?.(JSON.stringify(msg)); } catch { /* consumer error */ }
      });
      port.onDisconnect?.addListener?.(() => {
        const err = (typeof chrome !== "undefined" && chrome.runtime?.lastError?.message) || "";
        this.lastError = err || "the native host disconnected";
        this.closed = true;
        if (!settled) {
          settled = true;
          reject(new Error(
            `native host "${this.hostName}" is not installed or exited (${this.lastError}). ` +
              `Install it with: npm run acp:native:install`,
          ));
          return;
        }
        this.onClose?.(this.lastError);
      });
      // There is no connect event. A missing host is reported as a DISCONNECT,
      // and it can arrive a tick or two later, so a port is only treated as live
      // after a short grace window — resolving immediately would hand the runner
      // a dead port and turn "host not installed" into a failed turn instead of
      // a fallback to the WebSocket bridge.
      const GRACE_MS = 250;
      setTimeout(() => {
        if (settled) return;
        if (this.closed) {
          settled = true;
          reject(new Error(
            `native host "${this.hostName}" is not installed (${this.lastError}). ` +
              `Install it with: npm run acp:native:install`,
          ));
          return;
        }
        settled = true;
        resolve();
      }, GRACE_MS);
    });
  }

  /** @param {string} raw */
  send(raw) {
    if (!this.port || this.closed) throw new Error("ACP native host is not connected.");
    this.port.postMessage(JSON.parse(raw));
  }

  close() {
    this.closed = true;
    try { this.port?.disconnect?.(); } catch { /* already gone */ }
    this.port = null;
  }
}

/**
 * Ensure the optional `nativeMessaging` permission is granted (chrome-agent-platform-o65r).
 *
 * The shipped manifest lists `nativeMessaging` in `optional_permissions` — install never
 * demands it (the CAP-FB-20260831 boot-perms model), so the owner grants it at the moment
 * of need: selecting the Native host transport (or pressing Test connection) IS the user
 * gesture. A refusal or a failed request is a CLEAR error, never a silent failure — the
 * transport can only fall back to the WebSocket bridge honestly when the owner knows the
 * native leg is unavailable.
 *
 * Idempotent: an already-granted permission is detected with contains() and never
 * re-prompts.
 *
 * @param {{ contains?: (bundle: { permissions: string[] }) => Promise<boolean>,
 *          request?: (bundle: { permissions: string[] }) => Promise<boolean> }} [perms]
 *   Injectable chrome.permissions surface (defaults to the real one); tests pass fakes.
 * @returns {Promise<{ granted: boolean, error: string }>} granted=true when the permission
 *   is (or just became) available; error is "" when granted, else a user-facing message.
 */
export async function ensureAcpNativePermission(perms = {}) {
  const contains = perms.contains
    || (typeof chrome !== "undefined" && chrome?.permissions?.contains
      ? (bundle) => chrome.permissions.contains(bundle)
      : null);
  const request = perms.request
    || (typeof chrome !== "undefined" && chrome?.permissions?.request
      ? (bundle) => chrome.permissions.request(bundle)
      : null);
  const bundle = { permissions: ["nativeMessaging"] };
  if (!contains || !request) {
    return { granted: false, error: "chrome.permissions is unavailable in this context — native messaging cannot be granted here." };
  }
  try {
    if (await contains(bundle) === true) return { granted: true, error: "" };
  } catch { /* a failed contains is not a denial — fall through to request */ }
  try {
    if (await request(bundle) === true) return { granted: true, error: "" };
    return {
      granted: false,
      error: "Native messaging permission was not granted — the native host transport stays unavailable and the WebSocket bridge is used instead. You can retry any time.",
    };
  } catch (err) {
    return {
      granted: false,
      error: `Native messaging permission could not be requested (${String(err?.message ?? err)}). Click “Test connection” to grant it from a real click.`,
    };
  }
}
