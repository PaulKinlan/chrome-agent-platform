// x9r8k: independent SW-issued staging intent outlives run-log compaction.
// @ts-nocheck
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createEmscriptenSwIntent, EMSCRIPTEN_SW_INTENT_ROOT } from "../extension/lib/emscripten-sw-intent.js";
import { encodeModelStreamOwner } from "../extension/lib/wasm-stream-owner-codec.js";

function missing() { return new DOMException("not found", "NotFoundError"); }
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
  };
}
const storageFor = () => { const root = dir(); return { root, storage: { getDirectory: async () => root } }; };
const runId = "exec_ems_sw_intent_123456";
const identity = {
  runId, agentId: "hub",
  outputRef: { version: 1, id: "a".repeat(32), kind: "stdout" },
  generation: "b".repeat(32), packageId: "image.tool",
  graphDigest: "c".repeat(64), operationId: "resize",
};
const inputRef = { version: 1, id: "d".repeat(32), kind: "input" };
async function code(operation, expected) {
  const error = await assertRejects(operation);
  assertEquals(error.code ?? error.message, expected);
}

Deno.test("x9r8k: independent SW intent persists before any output creation and refuses replay", async () => {
  const { storage, root } = storageFor();
  const sw = createEmscriptenSwIntent({ storage });
  const record = await sw.begin({ identity, inputRef });
  assertEquals(record.state, "pending");
  assertEquals(record.stagingOnly, true);
  assertEquals(record.nonpromotable, true);
  assertEquals(Number.isSafeInteger(record.issuedAt), true);
  assertEquals(record.reconcileBy - record.issuedAt, 86_400_000,
    "every reservation has a bounded reconciliation deadline");
  assertEquals(record.identity.owner, encodeModelStreamOwner(runId, "hub"));
  assertEquals(root.nodes.has(EMSCRIPTEN_SW_INTENT_ROOT), true);
  assertEquals(root.nodes.has("wasm-streams-v1"), false, "intent precedes the output root");
  const restarted = createEmscriptenSwIntent({ storage });
  assertEquals(await restarted.read({ identity, inputRef }), record,
    "independent root persists despite run-log compaction or SW restart");
  await code(() => restarted.begin({ identity, inputRef }), "emscripten_sw_intent_replay");
  assertEquals(await restarted.read({ identity, inputRef }), record);
});

Deno.test("x9r8k: wrong run/owner/ref/generation cannot inherit SW-issued intent", async () => {
  const { storage } = storageFor();
  const sw = createEmscriptenSwIntent({ storage });
  await sw.begin({ identity, inputRef });
  for (const forged of [
    { ...identity, runId: "exec_ems_sw_intent_654321" },
    { ...identity, agentId: "named:alice" },
    { ...identity, packageId: "foreign.tool" },
    { ...identity, generation: "e".repeat(32) },
    { ...identity, outputRef: { ...identity.outputRef, id: "f".repeat(32) } },
  ]) await code(() => sw.read({ identity: forged, inputRef }),
    forged.outputRef.id === identity.outputRef.id
      ? "emscripten_sw_intent_collision" : "emscripten_sw_intent_unavailable");
  await code(() => sw.read({ identity, inputRef: { ...inputRef, id: "f".repeat(32) } }),
    "emscripten_sw_intent_collision");
  await code(() => sw.begin({ identity, inputRef: { ...inputRef, id: "f".repeat(32) } }),
    "emscripten_sw_intent_collision");
  await code(() => sw.begin({ identity: { ...identity, generation: "e".repeat(32) }, inputRef }),
    "emscripten_sw_intent_collision"); // same output ref cannot replay under a new generation
});

Deno.test("x9r8k: two overlapping grants for one output ref cannot both begin", async () => {
  const { storage } = storageFor();
  const sw = createEmscriptenSwIntent({ storage });
  const results = await Promise.allSettled([
    sw.begin({ identity, inputRef }), sw.begin({ identity, inputRef }),
  ]);
  assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
  assertEquals(results.filter((result) => result.status === "rejected").length, 1);
  assertEquals((await sw.read({ identity, inputRef })).state, "pending");
});

Deno.test("x9r8k: stale intent reaches a typed bounded reconciliation deadline", async () => {
  const { storage } = storageFor();
  let instant = 1_800_000_000_000;
  const sw = createEmscriptenSwIntent({ storage, now: () => instant });
  const record = await sw.begin({ identity, inputRef });
  assertEquals(record.reconcileBy, instant + 86_400_000);
  instant = record.reconcileBy;
  await code(() => sw.read({ identity, inputRef }), "emscripten_sw_intent_expired");
  await code(() => sw.begin({ identity, inputRef }), "emscripten_sw_intent_replay");
});

Deno.test("x9r8k: interrupted reservation without a record never authorizes retry", async () => {
  const { storage, root } = storageFor();
  const ledger = await root.getDirectoryHandle(EMSCRIPTEN_SW_INTENT_ROOT, { create: true });
  await ledger.getDirectoryHandle(identity.outputRef.id, { create: true });
  const sw = createEmscriptenSwIntent({ storage });
  await code(() => sw.begin({ identity, inputRef }), "emscripten_sw_intent_unavailable");
  const entry = await ledger.getDirectoryHandle(identity.outputRef.id);
  assertEquals(entry.nodes.has("intent.json"), false, "do not overwrite an ambiguous reservation");
});

Deno.test("x9r8k: malformed or partial intent never authorizes a retry", async () => {
  const { storage, root } = storageFor();
  const sw = createEmscriptenSwIntent({ storage });
  await sw.begin({ identity, inputRef });
  const ledger = await root.getDirectoryHandle(EMSCRIPTEN_SW_INTENT_ROOT);
  const entry = await ledger.getDirectoryHandle(identity.outputRef.id);
  entry.nodes.get("intent.json").bytes = "{partial";
  await code(() => sw.read({ identity, inputRef }), "emscripten_sw_intent_unavailable");
  await code(() => sw.begin({ identity, inputRef }), "emscripten_sw_intent_unavailable");
  assertEquals(entry.nodes.get("intent.json").bytes, "{partial", "never overwrite corrupt authority");
});
