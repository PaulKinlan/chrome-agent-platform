// Offscreen host for file-backed bundled WASI tools. It fetches and
// revalidates the shipped manifest/CAS, then gives one fresh Worker only opaque
// OPFS references plus the audited executable bytes.

import { previewSpecFor, revalidatePreviewExecution } from "./tool-exec-preview.js";
import { createWasiJob } from "./wasm-host-types.js";
import { BUNDLED_INVENTORY } from "./bundled-inventory-data.js";
import { validateAuthorityRecord } from "./wasm-executor.js";
import { validateWasmStreamRef, WASM_STREAM_ROOT_NAME } from "./wasm-stream-files.js";

export const WASM_STREAM_RUN_TYPE = "cap:wasm-stream-run";
export const WASM_STREAM_WALL_MS = 180_000;

function plain(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateRequest(raw) {
  if (!plain(raw) ||
      JSON.stringify(Object.keys(raw).sort()) !==
        JSON.stringify(["args", "authority", "inputRef", "outputRef", "owner", "toolId", "type"]) ||
      raw.type !== WASM_STREAM_RUN_TYPE || typeof raw.toolId !== "string" ||
      typeof raw.owner !== "string" || raw.owner.length === 0 || new TextEncoder().encode(raw.owner).byteLength > 1024 ||
      !Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    fail("wasm_stream_request");
  }
  const spec = previewSpecFor(raw.toolId);
  if (!spec) fail("wasm_stream_tool");
  const authority = validateAuthorityRecord(raw.authority);
  return Object.freeze({
    toolId: raw.toolId,
    args: Object.freeze([...raw.args]),
    authority,
    owner: raw.owner,
    inputRef: validateWasmStreamRef(raw.inputRef),
    outputRef: validateWasmStreamRef(raw.outputRef, { kinds: ["stdout"] }),
    spec,
  });
}

async function removePartialOutput(outputRef) {
  try {
    const root = await navigator.storage.getDirectory();
    const streams = await root.getDirectoryHandle(WASM_STREAM_ROOT_NAME);
    await streams.removeEntry(outputRef.id, { recursive: true });
  } catch { /* best effort after a failed/aborted run */ }
}

export async function executeWasmStreamRequest(raw, {
  createWorker = (url) => new Worker(url, { type: "module" }),
  wallMs = WASM_STREAM_WALL_MS,
} = {}) {
  const request = validateRequest(raw);
  const manifestUrl = chrome.runtime.getURL(request.spec.manifestRel);
  const casUrl = chrome.runtime.getURL(request.spec.casRel);
  const [manifestResponse, casResponse] = await Promise.all([fetch(manifestUrl), fetch(casUrl)]);
  if (!manifestResponse.ok || !casResponse.ok) fail("wasm_stream_asset_fetch");
  const manifestText = await manifestResponse.text();
  const wasmBytes = new Uint8Array(await casResponse.arrayBuffer());
  await revalidatePreviewExecution({
    toolId: request.toolId,
    manifestText,
    casBytes: wasmBytes,
    inventory: BUNDLED_INVENTORY,
  });

  const job = createWasiJob({
    tier: "tiny",
    context: {
      executionId: request.authority.executionId,
      callId: request.authority.callId,
      origin: request.authority.origin,
      workspaceRoot: `tool-jobs/${request.authority.executionId}/${request.authority.callId}/`,
    },
    args: [request.spec.argv0, ...request.args],
    stdin: new Uint8Array(0),
    acceptedExitCodes: request.spec.acceptedExitCodes,
    stdoutEncoding: request.spec.stdoutEncoding,
    workspaceSeed: request.spec.workspaceSeed,
    quota: {
      hostCalls: Number.POSITIVE_INFINITY,
      pathCalls: 4096,
      stdinBytes: Number.POSITIVE_INFINITY,
      stdoutBytes: Number.POSITIVE_INFINITY,
      stderrBytes: Number.POSITIVE_INFINITY,
      fileBytes: Number.POSITIVE_INFINITY,
      fileSize: Number.POSITIVE_INFINITY,
      dynamicFds: 256,
    },
  });

  let worker;
  try {
    worker = createWorker(chrome.runtime.getURL("lib/wasm-stream-worker.js"));
  } catch (error) {
    await removePartialOutput(request.outputRef);
    throw error;
  }

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { worker.terminate(); } catch { /* best effort */ }
        resolve(result);
      };
      const timer = setTimeout(() => finish(Object.freeze({
        type: "wasm.stream.result",
        sessionId: request.authority.sessionId,
        ok: false,
        phase: "timeout",
        toolId: request.toolId,
        outputRef: null,
        receipt: null,
        error: "wall deadline exceeded; worker terminated",
        exitCode: null,
      })), wallMs);
      worker.onerror = (event) => finish(Object.freeze({
        type: "wasm.stream.result",
        sessionId: request.authority.sessionId,
        ok: false,
        phase: "failed",
        toolId: request.toolId,
        outputRef: null,
        receipt: null,
        error: String(event?.message ?? "stream worker error").slice(0, 1024),
        exitCode: null,
      }));
      worker.onmessage = (event) => {
        const result = event.data;
        if (!plain(result) || result.type !== "wasm.stream.result" ||
            result.sessionId !== request.authority.sessionId || result.toolId !== request.toolId) {
          finish(Object.freeze({
            type: "wasm.stream.result",
            sessionId: request.authority.sessionId,
            ok: false,
            phase: "failed",
            toolId: request.toolId,
            outputRef: null,
            receipt: null,
            error: "stream worker result rejected",
            exitCode: null,
          }));
          return;
        }
        finish(result);
      };
      worker.postMessage({
        type: "wasm.stream.job",
        sessionId: request.authority.sessionId,
        toolId: request.toolId,
        inputRef: request.inputRef,
        outputRef: request.outputRef,
        owner: request.owner,
        job,
        wasmBytes,
      }, [wasmBytes.buffer]);
    });
  } finally {
    try { worker.terminate(); } catch { /* best effort */ }
  }
}

export function registerWasmStreamHost() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== WASM_STREAM_RUN_TYPE) return undefined;
    // Runtime messages from other extensions are never accepted. Extension
    // pages and this extension's service worker share sender.id.
    if (sender?.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "wasm_stream_sender" });
      return false;
    }
    executeWasmStreamRequest(message).then(async (result) => {
      if (!result.ok && message?.outputRef) await removePartialOutput(message.outputRef);
      sendResponse(result);
    }).catch(async (error) => {
      if (message?.outputRef) await removePartialOutput(message.outputRef);
      sendResponse({ ok: false, phase: "failed", error: String(error?.message ?? error).slice(0, 1024) });
    });
    return true;
  });
}
