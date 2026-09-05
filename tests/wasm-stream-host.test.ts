// @ts-nocheck
import { buildPreviewAuthority } from "../extension/lib/tool-exec-preview.js";
import {
  executeWasmStreamRequest,
  isTrustedWasmStreamSender,
  WASM_STREAM_RUN_TYPE,
} from "../extension/lib/wasm-stream-host.js";

function assert(condition, message = "assertion failed") { if (!condition) throw new Error(message); }
function equal(actual, expected, message = "values differ") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

const runtime = {
  id: "cap-kat",
  getURL(path) { return `chrome-extension://cap-kat/${path}`; },
};
const realChrome = globalThis.chrome;
const realFetch = globalThis.fetch;

async function fileFetch(url) {
  const path = String(url).replace("chrome-extension://cap-kat/", "");
  const bytes = await Deno.readFile(`extension/${path}`);
  return {
    ok: true,
    async text() { return new TextDecoder().decode(bytes); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}
function request(toolId, args = []) {
  return {
    type: WASM_STREAM_RUN_TYPE,
    toolId,
    args,
    inputRef: { version: 1, id: "11111111111111111111111111111111", kind: "input" },
    outputRef: { version: 1, id: "22222222222222222222222222222222", kind: "stdout" },
    authority: buildPreviewAuthority({ origin: "https://agent.cap", documentId: "host-kat", now: () => 1 }),
    owner: "agent:host-kat:hub",
  };
}
function validResult(posted) {
  const workerInstanceId = "33333333-3333-4333-8333-333333333333";
  return {
    type: "wasm.stream.result",
    sessionId: posted.sessionId,
    toolId: posted.toolId,
    workerInstanceId,
    ok: true,
    phase: "completed",
    outputRef: posted.outputRef,
    exitCode: 0,
    error: null,
    elapsedMs: 2,
    receipt: {
      stdinBytes: 0,
      stdinSha256: "0".repeat(64),
      stdoutBytes: 3,
      stdoutSha256: "1".repeat(64),
      stderrBytes: 0,
      stderrSha256: "2".repeat(64),
      elapsedMs: 2,
      workerInstanceId,
    },
  };
}

Deno.test("stream host revalidates shipped assets and posts canonical jq argv to one fresh worker", async () => {
  globalThis.chrome = { runtime };
  globalThis.fetch = fileFetch;
  let posted = null, transferred = null, terminated = 0;
  class FakeWorker {
    postMessage(message, transfer) {
      posted = message; transferred = transfer;
      queueMicrotask(() => this.onmessage({ data: validResult(message) }));
    }
    terminate() { terminated++; }
  }
  try {
    const result = await executeWasmStreamRequest(request("jq", ["-c", "."]), {
      createWorker: () => new FakeWorker(), wallMs: 1000,
    });
    assert(result.ok, result.error);
    equal(posted.job.args, ["jq", "-M", "-c", "."], "file-backed stdout defaults jq to monochrome");
    equal(posted.inputRef.kind, "input");
    equal(posted.outputRef.kind, "stdout");
    assert(posted.wasmBytes instanceof Uint8Array && posted.wasmBytes.byteLength > 500_000,
      "exact admitted jq CAS bytes reach the worker");
    equal(transferred.length, 1);
    assert(terminated >= 1, "fresh worker is terminated after settlement");
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
  }
});

Deno.test("stream host rejects a malformed success receipt instead of sealing it", async () => {
  globalThis.chrome = { runtime };
  globalThis.fetch = fileFetch;
  class FakeWorker {
    postMessage(message) {
      const result = validResult(message);
      result.receipt.stdoutSha256 = "not-a-digest";
      queueMicrotask(() => this.onmessage({ data: result }));
    }
    terminate() {}
  }
  try {
    const result = await executeWasmStreamRequest(request("wc"), {
      createWorker: () => new FakeWorker(), wallMs: 1000,
    });
    equal(result.ok, false);
    assert(result.error.includes("wasm_stream_worker_result"), result.error);
    equal(result.outputRef, null);
    equal(result.receipt, null);
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
  }
});

Deno.test("stream host has a finite cancellation deadline", async () => {
  globalThis.chrome = { runtime };
  globalThis.fetch = fileFetch;
  let terminated = 0;
  class SilentWorker { postMessage() {} terminate() { terminated++; } }
  try {
    const result = await executeWasmStreamRequest(request("wc"), {
      createWorker: () => new SilentWorker(), wallMs: 1,
    });
    equal(result.ok, false);
    equal(result.phase, "timeout");
    assert(terminated >= 1);
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
  }
});

Deno.test("offscreen stream listener trusts only the extension service worker sender", () => {
  assert(isTrustedWasmStreamSender({ id: runtime.id }, runtime));
  assert(isTrustedWasmStreamSender({ id: runtime.id, url: runtime.getURL("background/service-worker.js") }, runtime));
  assert(!isTrustedWasmStreamSender({ id: "other" }, runtime));
  assert(!isTrustedWasmStreamSender({ id: runtime.id, documentId: "options-document", url: runtime.getURL("options/options.html") }, runtime));
  assert(!isTrustedWasmStreamSender({ id: runtime.id, tab: { id: 7 }, url: "https://example.test/" }, runtime));
  assert(!isTrustedWasmStreamSender({ id: runtime.id, url: runtime.getURL("offscreen/offscreen.html") }, runtime));
});
