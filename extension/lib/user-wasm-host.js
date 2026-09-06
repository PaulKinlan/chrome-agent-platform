// extension/lib/user-wasm-host.js — Offscreen execution host listener for user-uploaded WASI modules.
import { executeUserWasmRun } from "./wasm-offscreen-host.js";
import { isTrustedWasmStreamSender } from "./wasm-stream-host.js";

export const USER_WASM_RUN_TYPE = "cap:user-wasm-run";

/**
 * Register the user-wasm execution host listener in the offscreen document.
 */
export function registerUserWasmHost() {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== USER_WASM_RUN_TYPE) return undefined;
    if (!isTrustedWasmStreamSender(sender)) {
      sendResponse({ ok: false, error: "user_wasm_sender_rejected" });
      return false;
    }
    (async () => {
      const wasmBytes = new Uint8Array(message.wasmBytes ?? []);
      const workerUrl = chrome.runtime.getURL("lib/wasm-execution-worker.js");
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
