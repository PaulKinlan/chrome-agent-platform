// tests/wasm-preview-host.test.ts — chrome-agent-platform-j6au: the Settings
// Gate-2 wasm preview host is pinned by EXECUTING the real
// registerWasmPreviewHost (extracted verbatim from options.js). The root cause
// of the owned "no offscreen response" RED class was the listener registering
// only inside renderToolLibrary() — i.e. only with developer features on and
// the tool-library section rendered. The registration is now module-scope and
// the unit is executed here with injectable seams.
// @ts-nocheck — the host is deliberately dynamic.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { registerWasmPreviewHost } from "../extension/lib/wasm-preview-host.js";

function fakeRuntime() {
  const listeners = [];
  return {
    id: "test-ext-id",
    getURL: (p) => `chrome-extension://test-ext-id/${p}`,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    _listeners: listeners,
  };
}

const SW_SENDER = { id: "test-ext-id", tab: null };
const TAB_SENDER = { id: "test-ext-id", tab: { id: 7 } };
const FOREIGN_SENDER = { id: "other-ext", tab: null };

function fakeSeams({ result = { stdout: "hi" }, fail = null } = {}) {
  const calls = [];
  return {
    seams: {
      loadExecutor: async () => ({
        WasmExecutor: class {
          constructor(opts) { calls.push(["executor", opts]); }
        },
      }),
      loadHost: async () => ({
        createOffscreenWasmHost: ({ executor, authority }) => {
          calls.push(["host", { executor, authority }]);
          return {
            handleJob: async (jobMsg) => {
              calls.push(["handleJob", jobMsg]);
              if (fail) throw fail;
              return result;
            },
          };
        },
      }),
      loadRehydrate: async () => import("../extension/lib/tool-exec-preview.js"),
    },
    calls,
  };
}

Deno.test("wasm-preview-host: registers ONE listener at call time (module-scope wiring is the fix)", () => {
  const runtime = fakeRuntime();
  assertEquals(runtime._listeners.length, 0, "nothing registered before the call");
  const listener = registerWasmPreviewHost({ runtime });
  assertEquals(runtime._listeners.length, 1, "the host registers exactly one listener");
  assertEquals(listener, runtime._listeners[0]);
});

Deno.test("wasm-preview-host: without messaging there is no listener (honest null)", () => {
  assertEquals(registerWasmPreviewHost({ runtime: {} }), null);
  assertEquals(registerWasmPreviewHost({ runtime: { onMessage: null } }), null);
});

Deno.test("wasm-preview-host: foreign senders are DENIED explicitly and the channel is not held (G2-style gate)", () => {
  const runtime = fakeRuntime();
  registerWasmPreviewHost({ runtime });
  const listener = runtime._listeners[0];
  const responses = [];
  const held = listener({ type: "wasm.preview.options" }, FOREIGN_SENDER, (res) => responses.push(res));
  assertEquals(held, undefined, "a denied sender must NOT hold the message channel");
  assertEquals(responses.length, 1);
  assertEquals(responses[0], { ok: false, error: "wasm preview host denied: sender is not the service worker" });

  const responses2 = [];
  const held2 = listener({ type: "wasm.preview.options" }, TAB_SENDER, (res) => responses2.push(res));
  assertEquals(held2, undefined, "a tab sender is also denied without holding the channel");
  assertEquals(responses2.length, 1);
});

Deno.test("wasm-preview-host: the SW request runs the REAL host sequence and answers via the held channel", async () => {
  const runtime = fakeRuntime();
  const { seams, calls } = fakeSeams({ result: { stdout: "hi" } });
  registerWasmPreviewHost({ runtime, loaders: seams });
  const listener = runtime._listeners[0];

  const responses = [];
  const held = listener(
    {
      type: "wasm.preview.options",
      authority: { sessionId: "s", executionId: "e", callId: "c", agentId: "hub", origin: "https://agent.cap", documentId: "task-run" },
      job: { args: [], stdin: [104, 105], quota: {
        hostCalls: 50_000, pathCalls: 4096,
        stdinBytes: null, stdoutBytes: null, stderrBytes: null,
        fileBytes: null, fileSize: null, dynamicFds: 256,
      } },
      wasmBytes: [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
      wallMs: 1234,
    },
    SW_SENDER,
    (res) => responses.push(res),
  );
  assertEquals(held, true, "the SW request HOLDS the channel for the async job (the null-response bug)");
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(responses.length, 1, "exactly one response");
  assertEquals(responses[0], { ok: true, result: { stdout: "hi" } });

  // The wiring reached the executor/host seams with the rehydrated bytes and
  // the SW-supplied authority (never request-borne beyond the documented pass).
  assertEquals(calls[0][0], "executor");
  assertEquals(calls[0][1].callMs, 1234, "the SW's wallMs drives the executor deadline");
  assertEquals(calls[1][0], "host");
  assertEquals(calls[1][1].authority?.executionId, "e");
  const jobMsg = calls[2][1];
  assertEquals(jobMsg.type, "wasm.job");
  assertEquals(jobMsg.wasmBytes, new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), "wasm bytes rehydrated to a real Uint8Array");
  assertEquals(jobMsg.job.stdin, new Uint8Array([104, 105]), "stdin rehydrated to a real Uint8Array");
  // The transport turned the dptw-unbounded quotas into null — the host must
  // restore Infinity BEFORE the executor enforces them (the quota_fileBytes bug).
  assertEquals(jobMsg.job.quota.fileBytes, Number.POSITIVE_INFINITY, "unbounded file quota restored after transport");
  assertEquals(jobMsg.job.quota.stdinBytes, Number.POSITIVE_INFINITY);
  assertEquals(jobMsg.job.quota.hostCalls, 50_000, "bounded count guards pass through untouched");
});

Deno.test("wasm-preview-host: a host failure answers honestly through the same channel (never silence)", async () => {
  const runtime = fakeRuntime();
  const { seams } = fakeSeams({ fail: new Error("execution exploded") });
  registerWasmPreviewHost({ runtime, loaders: seams });
  const listener = runtime._listeners[0];
  const responses = [];
  const held = listener({ type: "wasm.preview.options", job: { stdin: [], quota: { fileBytes: null } }, wasmBytes: [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0] }, SW_SENDER, (res) => responses.push(res));
  assertEquals(held, true);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(responses.length, 1);
  assertEquals(responses[0].ok, false);
  assertStringIncludes(responses[0].error, "execution exploded");
});
