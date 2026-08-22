// offscreen/offscreen.js — the SINGLETON execution host for agent-generated
// scripts on SCHEDULED runs (Paul 2026-08-17). The service worker cannot create
// DOM, so it opens this offscreen document (the production host) which spins up
// an opaque sandboxed iframe per run via the shared lib/script-host.js. The
// on-demand path (the user on the NTP) uses the SAME shared host registered in
// the NTP page — whichever host is open answers the SW's runtime message.

import { handleScriptRunMessage } from "../lib/script-host.js";
import { createOffscreenWasmHost } from "../lib/wasm-offscreen-host.js";
import { WasmExecutor } from "../lib/wasm-executor.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  handleScriptRunMessage(message, sendResponse, document, "offscreen")
);

// The Settings-only bounded Wasm preview executor (CAP-FB-20260822-
// TOOL-PREVIEW-EXEC-01). The service worker validates the request + package
// (manifest/CAS/imports/memory/caps) and forwards the bounded job + bytes; THIS
// document is the only Worker-capable extension surface, so the canonical
// Gate-2 executor runs here (a fresh dedicated Worker per call). The
// authority fence record is supplied by the SW (never request-borne) and
// re-validated by the offscreen host before any worker spawns.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "wasm.preview") return undefined;
  (async () => {
    const executor = new WasmExecutor({
      workerUrl: chrome.runtime.getURL("lib/wasm-execution-worker.js"),
      callMs: Number.isSafeInteger(message.wallMs) ? message.wallMs : 5000,
    });
    const host = createOffscreenWasmHost({
      executor,
      authority: message.authority,
    });
    const result = await host.handleJob({
      type: "wasm.job",
      job: message.job,
      wasmBytes: message.wasmBytes,
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
});
