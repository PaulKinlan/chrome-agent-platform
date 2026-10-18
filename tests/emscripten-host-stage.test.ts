// x9r8k.2: offscreen staging host remains SW-only and never returns an artifact.
// @ts-nocheck
import { assertEquals } from "jsr:@std/assert@1";
import { EMSCRIPTEN_HOST_STAGE_TYPE } from "../extension/lib/emscripten-stage-protocol.js";
import { executeStagedEmscriptenBinaryRequest } from "../extension/lib/emscripten-host-stage.js";
import { registerEmscriptenBinaryStagingHost } from "../extension/lib/emscripten-host-stage-route.js";
import { SERVICE_WORKER_BUNDLE_PATH } from "../extension/lib/pure.js";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";

const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const RUN = "exec_host_stage_123456";
const INPUT = { version: 1, id: "d".repeat(32), kind: "input" };
const IDENTITY = { runId: RUN, agentId: "hub", outputRef: { version: 1, id: "e".repeat(32), kind: "stdout" },
  generation: "f".repeat(32), packageId: "image.tool", graphDigest: "a".repeat(64), operationId: "resize" };
const PROOF = { ok: true, state: "closed", writerFence: "exclusive", frames: 1, bytes: 2, sha256: "c".repeat(64),
  evidenceState: "closed", ledgerRef: { version: 1, root: "emscripten-host-evidence-v1",
    id: `${IDENTITY.outputRef.id}-${IDENTITY.generation}`, hostIncarnation: crypto.randomUUID() } };
function request() {
  return { type: EMSCRIPTEN_HOST_STAGE_TYPE, identity: IDENTITY, inputRef: INPUT,
    packageId: IDENTITY.packageId, version: "1.0.0", graphDigest: IDENTITY.graphDigest,
    operationId: IDENTITY.operationId, sessionId: crypto.randomUUID(),
    operation: { id: IDENTITY.operationId, adapterId: "stage-adapter", exportName: "resize", result: "buffer",
      params: [{ name: "width", type: "i32", minimum: 1, maximum: 200 }] },
    args: [2], lifecycle: { startupMs: 200, callMs: 200 },
    assets: [
      { role: "glue", path: "wasm/runtime/image.tool/1.0.0/glue.mjs", sha256: SHA, size: 5 },
      { role: "adapter", path: "wasm/runtime/image.tool/1.0.0/adapter.mjs", sha256: SHA, size: 5 },
      { role: "main-wasm", path: `wasm/cas/${SHA}.wasm`, sha256: SHA, size: 5 },
    ],
  };
}
function sealedStorage() {
  const meta = { version: 1, id: INPUT.id, type: "input", owner: emscriptenJobOwner({ runId: RUN, agentId: "hub" }),
    sealed: true, bytes: 0, createdAt: Date.now() };
  const directory = { getFileHandle: async (name) => ({
    getFile: async () => new Blob([name === "authority.json" ? JSON.stringify(meta) : new Uint8Array()]),
  }) };
  return { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getDirectoryHandle: async (id) => {
      if (id !== INPUT.id) throw new DOMException("missing", "NotFoundError");
      return directory;
    },
  }) }) };
}
function runtimeFixture() {
  const listeners = [];
  const runtime = { id: "extension-id", getManifest: () => ({ background: { service_worker: SERVICE_WORKER_BUNDLE_PATH } }),
    getURL: () => `data:application/octet-stream;base64,aGVsbG8=`,
    onMessage: { addListener: (fn) => listeners.push(fn) } };
  // Sender identity must use the real service worker URL, not the asset data URL.
  const sender = { id: runtime.id, url: `data:application/octet-stream;base64,aGVsbG8=` };
  return { runtime, sender, listeners };
}

Deno.test("x9r8k.2: only SW sender may reach staging host executor", async () => {
  const { runtime, listeners } = runtimeFixture();
  let calls = 0;
  let loads = 0;
  registerEmscriptenBinaryStagingHost(runtime, async () => {
    loads++;
    return { executeStagedEmscriptenBinaryRequest: async () => {
      calls++; return { ok: false, phase: "unknown", error: "emscripten_worker_termination_unproved", hostProof: PROOF };
    } };
  });
  assertEquals(listeners.length, 1);
  for (const sender of [
    { id: runtime.id, url: "chrome-extension://extension-id/options.html", documentId: "tab" },
    { id: runtime.id, url: runtime.getURL(SERVICE_WORKER_BUNDLE_PATH), tab: { id: 3 } },
    { id: "foreign", url: runtime.getURL(SERVICE_WORKER_BUNDLE_PATH) },
  ]) {
    let result;
    assertEquals(listeners[0](request(), sender, (value) => { result = value; }), false);
    assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_stage_sender" });
  }
  assertEquals(calls, 0);
  assertEquals(loads, 0, "foreign message must not even load executable staging code");
  let response;
  assertEquals(listeners[0](request(), { id: runtime.id, url: runtime.getURL(SERVICE_WORKER_BUNDLE_PATH) },
    (value) => { response = value; }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(calls, 1);
  assertEquals(loads, 1);
  assertEquals(response.hostProof, PROOF);
});

Deno.test("x9r8k.2: host verifies sealed run-owned input and three declared assets before binary runner", async () => {
  const { runtime } = runtimeFixture();
  const storage = sealedStorage();
  let calls = 0;
  const runBinary = async ({ job, identity, wallMs }) => {
    calls++;
    assertEquals(identity, IDENTITY);
    assertEquals(wallMs, 5_400);
    assertEquals(job.wasmBytes, new TextEncoder().encode("hello"));
    assertEquals(job.type, "cap:emscripten-worker-job");
    return PROOF;
  };
  const result = await executeStagedEmscriptenBinaryRequest(request(), { runtime, storage, runBinary });
  assertEquals(result.ok, false);
  assertEquals(result.error, "emscripten_worker_termination_unproved");
  assertEquals(result.hostProof, PROOF);
  assertEquals(calls, 1);
  for (const bad of [
    { ...request(), assets: request().assets.map((asset) => ({ ...asset, sha256: "0".repeat(64) })) },
    { ...request(), inputRef: { ...INPUT, id: "0".repeat(32) } },
    { ...request(), operation: { ...request().operation, result: "i32" } },
    { ...request(), extra: "arbitrary option" },
  ]) {
    const rejected = await executeStagedEmscriptenBinaryRequest(bad, { runtime, storage, runBinary });
    assertEquals(rejected.ok, false);
    assertEquals("hostProof" in rejected, false);
  }
  assertEquals(calls, 1, "bad input cannot reach native Worker");
});
