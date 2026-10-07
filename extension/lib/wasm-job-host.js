// lib/wasm-job-host.js — the WASI-JOB lane of the offscreen execution host
// (chrome-agent-platform-ten9: no bundled tool may be preview-gated).
//
// The service worker's dispatchBundledWasmStream routes every non-stream
// bundled tool here: the offscreen document is Worker-capable, so it runs the
// shared executeBundledWasiJob (the same executor the Settings preview uses) —
// it self-fetches the pinned manifest + CAS bytes and re-validates both
// through the REAL package authority on every run; no package bytes, digests
// or capabilities ever ride the request (toolId/args/stdin only).

import { executeBundledWasiJob } from "./tool-exec-preview.js";
import { isTrustedServiceWorkerSender } from "./pure.js";

export const WASI_JOB_RUN_TYPE = "cap:wasm-wasi-job-run";

export function registerWasmJobHost({ runtime = globalThis.chrome?.runtime } = {}) {
  if (!runtime?.onMessage) return;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== WASI_JOB_RUN_TYPE) return;
    if (!isTrustedServiceWorkerSender(sender, runtime)) {
      sendResponse({
        ok: false,
        phase: "failed",
        error: "wasm_job_host_untrusted_sender",
      });
      return false;
    }
    executeBundledWasiJob({
      toolId: String(message.toolId ?? ""),
      args: Array.isArray(message.args) ? message.args : [],
      stdin: typeof message.stdin === "string" ? message.stdin : "",
      runContext: {
        origin: typeof message.origin === "string" && message.origin ? message.origin : "https://agent.cap",
        // The authority record rejects empty strings (validateAuthorityRecord):
        // hub runs seed documentId as "" (6s2c convention) — default it here.
        documentId: typeof message.documentId === "string" && message.documentId ? message.documentId : "task-run",
      },
    })
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          phase: "failed",
          error: String(error?.message ?? error).slice(0, 1024),
        })
      );
    return true; // async sendResponse
  });
}
