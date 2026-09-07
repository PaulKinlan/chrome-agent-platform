// extension/lib/wasm-preview-host.js — the Settings-only Gate-2 wasm preview
// HOST (chrome-agent-platform-j6au). The bounded bundled-tool job requested by
// `tool.preview.run` runs HERE, in the OPTIONS document (Worker-capable + COI;
// no offscreen permission, no NTP/content fallback). Extracted verbatim from
// options.js so committed tests execute the REAL host, and so the registration
// happens at MODULE SCOPE — the root cause of the "no offscreen response" RED
// class was this listener being registered inside renderToolLibrary(), i.e.
// only when the developer tool-library section rendered. The preview host is a
// protocol surface: it must answer whenever Settings is open.
//
// The executor + offscreen host stay SEPARATE shipped files (runtime-URL
// dynamic import — esbuild cannot inline a non-static specifier), so the
// options bundle carries NO inlined `new Worker` and the Store scan keeps
// governing the canonical source files (whose worker-host exemption is
// scanner-owned). No blanket scanner/Worker exemption is added.

import {
  rehydratePreviewQuota,
  rehydratePreviewStdin,
  rehydratePreviewWasmBytes,
} from "./tool-exec-preview.js";

/** The production module loaders (runtime-URL dynamic imports). Tests inject
 * fakes; the shipped wiring uses chrome.runtime.getURL. */
function defaultLoaders(runtime) {
  return {
    loadExecutor: async () => import(runtime.getURL("lib/wasm-executor.js")),
    loadHost: async () => import(runtime.getURL("lib/wasm-offscreen-host.js")),
    loadRehydrate: async () => ({ rehydratePreviewQuota, rehydratePreviewStdin, rehydratePreviewWasmBytes }),
  };
}

/**
 * Register the preview host listener. Returns the registered listener (or
 * null when no runtime messaging exists). The ONLY accepted sender is the
 * same-extension SERVICE WORKER (sender.id exact, no tab); the authority +
 * job arrive from the trusted SW (never request-borne).
 */
export function registerWasmPreviewHost({ runtime = globalThis.chrome?.runtime, loaders = null } = {}) {
  if (!runtime?.onMessage) return null;
  const seams = loaders ? { ...defaultLoaders(runtime), ...loaders } : defaultLoaders(runtime);
  const listener = (message, sender, sendResponse) => {
    if (message?.type !== "wasm.preview.options") return undefined;
    if (sender?.id !== runtime.id || sender?.tab != null) {
      sendResponse({ ok: false, error: "wasm preview host denied: sender is not the service worker" });
      return undefined;
    }
    (async () => {
      const [{ WasmExecutor }, { createOffscreenWasmHost }, { rehydratePreviewQuota: rhQuota, rehydratePreviewStdin: rhIn, rehydratePreviewWasmBytes: rhBytes }] =
        await Promise.all([seams.loadExecutor(), seams.loadHost(), seams.loadRehydrate()]);
      const executor = new WasmExecutor({
        workerUrl: runtime.getURL("lib/wasm-execution-worker.js"),
        callMs: Number.isSafeInteger(message.wallMs) ? message.wallMs : 5000,
      });
      const host = createOffscreenWasmHost({
        executor,
        authority: message.authority,
      });
      const wasmBytes = rhBytes(message.wasmBytes);
      // createWasiJob on the SW side emitted a FROZEN PLAIN byte array for
      // stdin; the generic host contract requires a genuine Uint8Array — the
      // local rehydration clones the job with the dense validated bytes.
      const job = {
        ...message.job,
        stdin: rhIn(message.job?.stdin),
        // Infinity quotas arrive as null over the JSON transport — restore
        // the dptw-unbounded fields before the executor enforces them (j6au).
        quota: rhQuota(message.job?.quota),
      };
      const result = await host.handleJob({
        type: "wasm.job",
        job,
        wasmBytes,
      });
      sendResponse({ ok: true, result });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: String(error?.message ?? error),
        executorCode: error?.executorCode ?? null,
      });
    });
    return true; // async response
  };
  runtime.onMessage.addListener(listener);
  return listener;
}
