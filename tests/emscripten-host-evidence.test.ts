// xoeaa: deterministic host-owned OPFS ledger, never a positive writer fence.
// @ts-nocheck
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createEmscriptenHostEvidence, EMSCRIPTEN_HOST_EVIDENCE_ROOT } from "../extension/lib/emscripten-host-evidence.js";

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
const RUN = "exec_ems_host_evidence_123456";
const identity = {
  runId: RUN, agentId: "named:alice",
  outputRef: { version: 1, id: "a".repeat(32), kind: "stdout" },
  generation: "b".repeat(32), packageId: "image.tool",
  graphDigest: "c".repeat(64), operationId: "resize",
};
const storageFor = () => { const root = dir(); return { root, storage: { getDirectory: async () => root } }; };
async function code(operation, expected) {
  const error = await assertRejects(operation);
  assertEquals(error.code ?? error.message, expected);
}

Deno.test("xoeaa: pending and UNKNOWN survive offscreen restart; never claim worker quiescence", async () => {
  const { storage, root } = storageFor();
  const host = createEmscriptenHostEvidence({ storage });
  const pending = await host.begin(identity);
  assertEquals(pending.state, "pending");
  assertEquals(pending.identity.owner, `agent:${RUN}:|named:alice`);
  assertEquals(await host.begin(identity), pending, "same host may read its pending row");
  assertEquals((await host.read(identity)).state, "unknown", "pending is not success");
  const unknown = await host.recordUnknown(identity, "worker_termination_unproved");
  assertEquals(unknown.state, "unknown");
  assertEquals((await host.read(identity)).reason, "worker_termination_unproved");
  assertEquals(await host.recordUnknown(identity, "worker_termination_unproved"), unknown);
  await code(() => host.begin(identity), "emscripten_host_evidence_unknown");
  const restarted = createEmscriptenHostEvidence({ storage });
  assertEquals(await restarted.read(identity), unknown, "separate offscreen incarnation reads durable evidence");
  await code(() => restarted.begin(identity), "emscripten_host_evidence_unknown");
  await code(() => restarted.recordUnknown(identity, "deadline"), "emscripten_host_evidence_collision");
  await code(() => restarted.recordUnknown(identity, "offscreen_restart"), "emscripten_host_evidence_reason");
  assertEquals(root.nodes.has(EMSCRIPTEN_HOST_EVIDENCE_ROOT), true);
});

Deno.test("xoeaa: foreign owner, wrong generation and unrecorded jobs never inherit host evidence", async () => {
  const { storage } = storageFor();
  const host = createEmscriptenHostEvidence({ storage });
  await host.begin(identity);
  for (const forged of [
    { ...identity, agentId: "named:bob" },
    { ...identity, runId: "exec_ems_host_evidence_654321" },
    { ...identity, packageId: "foreign.tool" },
  ]) {
    await code(() => host.read(forged), "emscripten_host_evidence_unavailable");
    await code(() => host.recordUnknown(forged, "deadline"), "emscripten_host_evidence_collision");
  }
  await code(() => host.read({ ...identity, generation: "d".repeat(32) }), "emscripten_host_evidence_unavailable");
  await code(() => host.recordUnknown(identity, "quiescent"), "emscripten_host_evidence_reason");
  await code(() => host.begin({ ...identity, outputRef: { ...identity.outputRef, id: "../bad" } }), "wasm_stream_ref");
});

Deno.test("xoeaa: corrupt pending or unknown authority never overwrites or authenticates", async () => {
  const { storage, root } = storageFor();
  const host = createEmscriptenHostEvidence({ storage });
  await host.begin(identity);
  const ledgerRoot = await root.getDirectoryHandle(EMSCRIPTEN_HOST_EVIDENCE_ROOT);
  const job = await ledgerRoot.getDirectoryHandle(`${identity.outputRef.id}-${identity.generation}`);
  job.nodes.get("pending.json").bytes = "{broken";
  await code(() => host.begin(identity), "emscripten_host_evidence_unavailable");
  await code(() => host.read(identity), "emscripten_host_evidence_unavailable");
  assertEquals(job.nodes.get("pending.json").bytes, "{broken");
});
