// x9r8k.2: SW-only staging. No model-facing binary, seal, publish or delete path.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stageTrustedEmscriptenBinary, bindTrustedSwStaging,
  EMSCRIPTEN_SW_STAGE_TYPE } from "../extension/lib/emscripten-sw-stage.js";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";
import { createWasmStreamInput, sealWasmStreamInput } from "../extension/lib/wasm-stream-files.js";
import { createEmscriptenSwIntent } from "../extension/lib/emscripten-sw-intent.js";
import { createEmscriptenHostEvidence } from "../extension/lib/emscripten-host-evidence.js";
import { openAuditedHostOwnedEmscriptenWriter } from "../extension/lib/emscripten-host-writer.js";

function missing() { return new DOMException("missing", "NotFoundError"); }
function storageFixture() {
  const deletions = [];
  function dir() {
    const nodes = new Map();
    return {
      nodes,
      async getDirectoryHandle(name, { create = false } = {}) {
        if (!nodes.has(name) && create) nodes.set(name, dir());
        const node = nodes.get(name);
        if (!node?.getDirectoryHandle) throw missing();
        return node;
      },
      async getFileHandle(name, { create = false } = {}) {
        if (!nodes.has(name) && create) nodes.set(name, { bytes: new Uint8Array(), open: 0 });
        const file = nodes.get(name);
        if (!file || file.getDirectoryHandle) throw missing();
        return {
          getFile: async () => new Blob([file.bytes]),
          createWritable: async ({ mode } = {}) => {
            if (mode === "exclusive" && file.open) throw new DOMException("locked", "NoModificationAllowedError");
            file.open++;
            let bytes = new Uint8Array(); let done = false;
            const release = () => { if (!done) { done = true; file.open--; } };
            return {
              async write(value) {
                const part = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
                const next = new Uint8Array(bytes.length + part.length);
                next.set(bytes); next.set(part, bytes.length); bytes = next;
              },
              async close() { file.bytes = bytes; release(); },
              async abort() { release(); },
            };
          },
        };
      },
      async removeEntry(name) { deletions.push(name); nodes.delete(name); },
    };
  }
  const root = dir();
  return { storage: { getDirectory: async () => root }, root, deletions };
}
const RUN = "exec_stage_route_123456";
const PKG = "image.tool";
const GRAPH = "a".repeat(64);
const OP = "resize";
const MANIFEST = {
  package: { id: PKG, version: "1.0.0" },
  assets: [
    { role: "glue", path: "extension/wasm/runtime/image.tool/1.0.0/glue.mjs", sha256: "b".repeat(64), size: 5 },
    { role: "adapter", path: "extension/wasm/runtime/image.tool/1.0.0/adapter.mjs", sha256: "c".repeat(64), size: 5 },
    { role: "main-wasm", path: `extension/wasm/cas/${"d".repeat(64)}.wasm`, sha256: "d".repeat(64), size: 5 },
  ],
  entry: { adapterId: "stage-adapter", operations: [
    { kind: "native-buffer-v1", id: OP, exportName: "resize", result: "buffer",
      params: [{ name: "width", type: "i32", minimum: 1, maximum: 200 }] },
  ] },
  resources: { lifecycle: { startupMs: 200, callMs: 200, concurrentJobs: 1 } },
};
function request(inputRef) {
  return { type: EMSCRIPTEN_SW_STAGE_TYPE, runId: RUN, agentId: null, inputRef,
    packageId: PKG, version: "1.0.0", graphDigest: GRAPH, operationId: OP, args: [2] };
}
async function setup() {
  const fixture = storageFixture();
  const inputRef = await createWasmStreamInput({ owner: emscriptenJobOwner({ runId: RUN, agentId: "hub" }), storage: fixture.storage });
  await sealWasmStreamInput({ ref: inputRef, owner: emscriptenJobOwner({ runId: RUN, agentId: "hub" }), storage: fixture.storage });
  const intent = createEmscriptenSwIntent({ storage: fixture.storage });
  const evidence = createEmscriptenHostEvidence({ storage: fixture.storage });
  let live = true; let calls = 0;
  const deps = {
    storage: fixture.storage, intent, evidence,
    isLive: () => live,
    readPackages: async () => ({ ok: true, packages: new Map([[PKG,
      { version: "1.0.0", graphDigest: GRAPH, manifest: MANIFEST }]]) }),
    ensureHost: async () => ({ ok: true }),
    sendHost: async (message) => {
      calls++;
      const channel = await openAuditedHostOwnedEmscriptenWriter({
        identity: message.identity, storage: fixture.storage, evidence,
      });
      await channel.push({ seq: 0, chunk: new Uint8Array([10, 20]) });
      const proof = await channel.close();
      return { ok: false, phase: "unknown", error: "emscripten_worker_termination_unproved", hostProof: proof };
    },
  };
  return { ...fixture, inputRef, deps, get calls() { return calls; }, cancel() { live = false; } };
}

Deno.test("x9r8k.2: fresh run + sealed input + independently bound host proof remain terminal UNKNOWN", async () => {
  const f = await setup();
  const result = await stageTrustedEmscriptenBinary(request(f.inputRef), f.deps);
  assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_worker_termination_unproved" });
  assertEquals(f.calls, 1);
  assertEquals(f.deletions, []);
  const streams = await f.root.getDirectoryHandle("wasm-tool-streams-v1");
  const intentRoot = await f.root.getDirectoryHandle("emscripten-sw-intent-v1");
  const ids = [...streams.nodes.keys()].filter((id) => id !== f.inputRef.id);
  assertEquals(ids.length, 1);
  const marker = await intentRoot.getDirectoryHandle(ids[0]);
  const retained = JSON.parse(await (await (await marker.getFileHandle("retained.json")).getFile()).text());
  assertEquals(retained.state, "retained-not-deleted");
  assertEquals(retained.reason, "termination_unproved");
});

Deno.test("x9r8k.2: cancellation, stale registry, foreign or unsealed input cannot create output", async () => {
  for (const flaw of ["cancel", "stale", "foreign", "unsealed"]) {
    const f = await setup();
    let raw = request(f.inputRef);
    if (flaw === "cancel") f.cancel();
    if (flaw === "stale") raw = { ...raw, graphDigest: "f".repeat(64) };
    if (flaw === "foreign") raw = { ...raw, agentId: "other" };
    if (flaw === "unsealed") raw = { ...raw, inputRef: { ...f.inputRef, id: "e".repeat(32) } };
    const result = await stageTrustedEmscriptenBinary(raw, f.deps);
    assertEquals(result.ok, false, flaw);
    assertEquals(f.calls, 0, flaw);
    assertEquals(f.deletions, [], flaw);
    const streams = await f.root.getDirectoryHandle("wasm-tool-streams-v1");
    assertEquals([...streams.nodes.keys()], [f.inputRef.id], `${flaw}: no output directory`);
  }
});

Deno.test("x9r8k.2: cancellation after output creation retains the ref and refuses host work", async () => {
  const f = await setup();
  f.deps.ensureHost = async () => { f.cancel(); return { ok: true }; };
  const result = await stageTrustedEmscriptenBinary(request(f.inputRef), f.deps);
  assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_run_not_live" });
  assertEquals(f.calls, 0);
  assertEquals(f.deletions, []);
  const intents = await f.root.getDirectoryHandle("emscripten-sw-intent-v1");
  const dirs = [...intents.nodes.values()];
  assertEquals(dirs.length, 1);
  const marker = JSON.parse(await (await (await dirs[0].getFileHandle("retained.json")).getFile()).text());
  assertEquals(marker.reason, "run_not_live");
});

Deno.test("x9r8k.2: even a forged positive host result with CLOSED proof is refused", async () => {
  const f = await setup();
  const send = f.deps.sendHost;
  f.deps.sendHost = async (message) => ({ ...await send(message), ok: true, phase: "completed" });
  const result = await stageTrustedEmscriptenBinary(request(f.inputRef), f.deps);
  assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_stage_host_unavailable" });
  assertEquals(f.calls, 1);
  assertEquals(f.deletions, []);
});

Deno.test("jwosv: a contradictory host proof retains an evidence-mismatch marker", async () => {
  const f = await setup();
  const send = f.deps.sendHost;
  f.deps.sendHost = async (message) => {
    const response = await send(message);
    return { ...response, hostProof: { ...response.hostProof, evidenceState: "unknown" } };
  };
  const result = await stageTrustedEmscriptenBinary(request(f.inputRef), f.deps);
  assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_staging_evidence_mismatch" });
  const intents = await f.root.getDirectoryHandle("emscripten-sw-intent-v1");
  const [dir] = [...intents.nodes.values()];
  const marker = JSON.parse(await (await (await dir.getFileHandle("retained.json")).getFile()).text());
  assertEquals(marker.state, "retained-not-deleted");
  assertEquals(marker.reason, "evidence_mismatch");
  assertEquals(f.deletions, []);
});

Deno.test("jwosv: an unreadable host ledger retains an evidence-unavailable marker", async () => {
  const f = await setup();
  f.deps.evidence = { read: async () => { throw new Error("missing host ledger"); } };
  const result = await stageTrustedEmscriptenBinary(request(f.inputRef), f.deps);
  assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_staging_evidence_unavailable" });
  const intents = await f.root.getDirectoryHandle("emscripten-sw-intent-v1");
  const [dir] = [...intents.nodes.values()];
  const marker = JSON.parse(await (await (await dir.getFileHandle("retained.json")).getFile()).text());
  assertEquals(marker.state, "retained-not-deleted");
  assertEquals(marker.reason, "evidence_unavailable");
  assertEquals(f.deletions, []);
});

Deno.test("x9r8k.2: SW-owned capability has no extension-page message ingress", async () => {
  const f = await setup();
  const invoke = bindTrustedSwStaging(f.deps);
  const refused = await invoke({ ...request(f.inputRef), sender: "extension-page" });
  assertEquals(refused, { ok: false, phase: "unknown", error: "emscripten_stage_request" });
  assertEquals(f.calls, 0);
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes('Object.defineProperty(globalThis, Symbol.for("cap.emscripten.stage-only")'));
  assert(!sw.includes("registerEmscriptenSwStagingRoute"));
  const route = await Deno.readTextFile(new URL("../extension/lib/emscripten-sw-stage.js", import.meta.url));
  assert(!route.includes("runtime.onMessage.addListener("));
  assertEquals(f.deletions, []);
});
