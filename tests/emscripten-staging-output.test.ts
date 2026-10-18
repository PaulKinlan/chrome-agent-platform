// x9r8k: a post-intent creation failure is durably retained, not deleted.
// @ts-nocheck
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createWasmStreamOutput, WASM_STREAM_ROOT_NAME } from "../extension/lib/wasm-stream-files.js";
import { createEmscriptenSwIntent } from "../extension/lib/emscripten-sw-intent.js";

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
        if (name === "stderr.bin") throw new Error("injected stderr create failure");
        if (!nodes.has(name) && create) nodes.set(name, { bytes: "" });
        const node = nodes.get(name);
        if (!node || node.getDirectoryHandle) throw missing();
        return {
          getFile: async () => new Blob([node.bytes]),
          createWritable: async () => {
            let next = "";
            return {
              async write(value) { next = value; },
              async close() { node.bytes = next; },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name) { deletions.push(name); nodes.delete(name); },
    };
  }
  const root = dir();
  return { root, deletions, storage: { getDirectory: async () => root } };
}

Deno.test("x9r8k: retention mode refuses absent lifecycle writer before any output creation", async () => {
  const { storage, root, deletions } = storageFixture();
  let intentStarted = false;
  const error = await assertRejects(() => createWasmStreamOutput({
    owner: "agent:exec_staging_123456:|hub", storage,
    beforeCreate: () => { intentStarted = true; }, preserveOnFailure: true,
  }));
  assertEquals(error.code, "wasm_stream_before_create");
  assertEquals(intentStarted, false);
  assertEquals(deletions, []);
  assertEquals(root.nodes.size, 0);
});

Deno.test("x9r8k: post-intent failure retains output and writes bounded retained-not-deleted lifecycle", async () => {
  const { storage, root, deletions } = storageFixture();
  const instant = 1_800_000_000_000;
  const intent = createEmscriptenSwIntent({ storage, now: () => instant });
  const inputRef = { version: 1, id: "d".repeat(32), kind: "input" };
  let identity;
  const error = await assertRejects(() => createWasmStreamOutput({
    owner: "agent:exec_staging_123456:|hub", storage,
    beforeCreate: async (ref) => {
      identity = { runId: "exec_staging_123456", agentId: "hub", outputRef: ref,
        generation: "f".repeat(32), packageId: "image.tool",
        graphDigest: "a".repeat(64), operationId: "resize" };
      await intent.begin({ identity, inputRef });
    },
    preserveOnFailure: true,
    onRetainedFailure: (ref, reason) => {
      assertEquals(ref.id, identity.outputRef.id);
      return intent.recordRetained({ identity, inputRef }, reason);
    },
  }));
  assertEquals(error.message, "injected stderr create failure");
  assertEquals(deletions, [], "a failed staging creation must never delete its directory");
  const streams = await root.getDirectoryHandle(WASM_STREAM_ROOT_NAME);
  await streams.getDirectoryHandle(identity.outputRef.id); // partial output still exists
  const marker = await intent.readRetained({ identity, inputRef });
  assertEquals(marker.type, "emscripten-staging-retained");
  assertEquals(marker.state, "retained-not-deleted");
  assertEquals(marker.reason, "output_create_failed");
  assertEquals(marker.retainedAt, instant);
  assertEquals(marker.reconcileBy - marker.retainedAt, 86_400_000);
  const refused = await assertRejects(() => intent.read({ identity, inputRef }));
  assertEquals(refused.code, "emscripten_sw_intent_retained");
});
