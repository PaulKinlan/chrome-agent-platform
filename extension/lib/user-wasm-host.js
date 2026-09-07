// extension/lib/user-wasm-host.js — Offscreen execution host listener for user-uploaded WASI modules.
import { executeUserWasmRun } from "./wasm-offscreen-host.js";
import { isTrustedWasmStreamSender } from "./wasm-stream-host.js";
import { verifyAndReadOwnerBlobBytes } from "./user-wasm-store.js";

export const USER_WASM_RUN_TYPE = "cap:user-wasm-run";

function randomHex(bytes = 4) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the host-bound authority record for a live user-wasm execution.
 * Attribution reflects the executing agent and task run, not settings-preview.
 */
export function buildUserWasmAuthority({
  origin = "https://agent.cap",
  documentId = "task-run",
  runId = null,
  agentId = "hub",
  now = null,
} = {}) {
  const at = (now ?? (() => Date.now()))();
  const execId = runId ? `run-${runId}` : `exec-${at.toString(36)}-${randomHex(4)}`;
  const callId = `user-wasm-${randomHex(4)}`;
  return Object.freeze({
    sessionId: `user-wasm-${runId ?? randomHex(6)}`,
    executionId: execId,
    callId,
    agentId: String(agentId || "hub"),
    origin: typeof origin === "string" && /^https?:\/\//u.test(origin)
      ? new URL(origin).origin
      : "https://agent.cap",
    documentId: String(documentId || "task-run"),
  });
}

/**
 * Register the user-wasm execution host listener in the offscreen document.
 */
export function registerUserWasmHost({ runtime = globalThis.chrome?.runtime } = {}) {
  if (!runtime?.onMessage) return;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== USER_WASM_RUN_TYPE) return undefined;
    if (!isTrustedWasmStreamSender(sender, runtime)) {
      sendResponse({ ok: false, error: "user_wasm_sender_rejected" });
      return false;
    }
    (async () => {
      let wasmBytes;
      if (message.wasmBytes && (message.wasmBytes instanceof Uint8Array || Array.isArray(message.wasmBytes))) {
        wasmBytes = new Uint8Array(message.wasmBytes);
      } else {
        // Zero-copy transport: fetch bytes directly from local OPFS by digest
        wasmBytes = await verifyAndReadOwnerBlobBytes({ digest: message.digest });
      }

      const workerUrl = typeof runtime.getURL === "function"
        ? runtime.getURL("lib/wasm-execution-worker.js")
        : null;

      return await executeUserWasmRun({
        toolId: message.toolId,
        digest: message.digest,
        args: message.args,
        stdin: message.stdin,
        wasmBytes,
        authority: message.authority,
        wallMs: message.wallMs,
        workerUrl,
      });
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({
        ok: false,
        phase: "failed",
        error: String(err?.message ?? err).slice(0, 1024),
      }));
    return true;
  });
}
