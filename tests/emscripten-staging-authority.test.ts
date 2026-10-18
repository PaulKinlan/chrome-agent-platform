// x9r8k: SW may inspect staging evidence but cannot promote, seal or delete it.
// @ts-nocheck
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";
import { createEmscriptenSwIntent } from "../extension/lib/emscripten-sw-intent.js";
import { createEmscriptenHostEvidence } from "../extension/lib/emscripten-host-evidence.js";
import { openAuditedHostOwnedEmscriptenWriter } from "../extension/lib/emscripten-host-writer.js";
import { createWasmStreamInput, createWasmStreamOutput, sealWasmStreamInput } from "../extension/lib/wasm-stream-files.js";
import { verifyStagedEmscriptenRun } from "../extension/lib/emscripten-staging-authority.js";

function missing() { return new DOMException("missing", "NotFoundError"); }
function storageFixture() {
  let deletions = 0;
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
                const nextBytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
                const next = new Uint8Array(bytes.length + nextBytes.length);
                next.set(bytes); next.set(nextBytes, bytes.length); bytes = next;
              },
              async close() { file.bytes = bytes; release(); },
              async abort() { release(); },
            };
          },
        };
      },
      async removeEntry(name) { deletions++; nodes.delete(name); },
    };
  }
  const root = dir();
  return { storage: { getDirectory: async () => root }, root, get deletions() { return deletions; } };
}
async function setup() {
  const fixture = storageFixture();
  const { storage } = fixture;
  const runId = "exec_staging_auth_123456";
  const agentId = "hub";
  const owner = emscriptenJobOwner({ runId, agentId });
  const inputRef = await createWasmStreamInput({ owner, storage });
  await sealWasmStreamInput({ ref: inputRef, owner, storage });
  const intent = createEmscriptenSwIntent({ storage });
  let identity;
  const outputRef = await createWasmStreamOutput({ owner, storage, beforeCreate: async (ref) => {
    identity = { runId, agentId, outputRef: ref, generation: "f".repeat(32),
      packageId: "image.tool", graphDigest: "a".repeat(64), operationId: "resize" };
    await intent.begin({ identity, inputRef });
  } });
  const evidence = createEmscriptenHostEvidence({ storage });
  const channel = await openAuditedHostOwnedEmscriptenWriter({ identity, storage, evidence });
  await channel.push({ seq: 0, chunk: new Uint8Array([10, 20]) });
  const proof = await channel.close();
  assertEquals((await intent.read({ identity, inputRef })).state, "pending");
  return { ...fixture, identity, inputRef, outputRef, intent, evidence, proof };
}
async function code(operation, expected) {
  const error = await assertRejects(operation);
  assertEquals(error.code ?? error.message, expected);
}
function verify(fixture, changes = {}) {
  return verifyStagedEmscriptenRun({ identity: fixture.identity, inputRef: fixture.inputRef,
    hostProof: fixture.proof, intent: fixture.intent, evidence: fixture.evidence,
    storage: fixture.storage, isLive: () => true, ...changes });
}

Deno.test("x9r8k: fresh independent SW intent, host ledger and staging bytes still yield termination UNKNOWN", async () => {
  const fixture = await setup();
  const result = await verify(fixture);
  assertEquals(result, { ok: false, phase: "unknown", error: "emscripten_worker_termination_unproved" });
  assertEquals(fixture.deletions, 0, "staging must never delete a file");
  assertEquals((await fixture.evidence.read(fixture.identity)).state, "closed",
    "writer CLOSED is a narrow resource fact, not worker termination");
});

Deno.test("x9r8k: wrong ledger locator or returned proof never authenticates independently", async () => {
  const fixture = await setup();
  for (const hostProof of [
    { ...fixture.proof, ledgerRef: { ...fixture.proof.ledgerRef, id: "b".repeat(32) + "-" + "f".repeat(32) } },
    { ...fixture.proof, ledgerRef: { ...fixture.proof.ledgerRef, hostIncarnation: crypto.randomUUID() } },
    { ...fixture.proof, bytes: 99 },
  ]) await code(() => verify(fixture, { hostProof }), "emscripten_staging_evidence_mismatch");
  assertEquals(fixture.deletions, 0);
});

Deno.test("x9r8k: revoked ledger and mismatched staging bytes refuse, never clean up", async () => {
  const fixture = await setup();
  await fixture.evidence.recordProtocolViolation(fixture.identity, "writer_fence_unavailable");
  await code(() => verify(fixture), "emscripten_staging_evidence_unavailable");
  assertEquals(fixture.deletions, 0);
  const fresh = await setup();
  const streamRoot = await fresh.root.getDirectoryHandle("wasm-tool-streams-v1");
  const output = await streamRoot.getDirectoryHandle(fresh.outputRef.id);
  output.nodes.get("stdout.bin").bytes = new Uint8Array([90, 20]);
  await code(() => verify(fresh), "emscripten_staging_bytes_mismatch");
  assertEquals(fresh.deletions, 0);
});

Deno.test("x9r8k: independent SW verifier refuses forged non-staging intent even if its reader lies", async () => {
  const fixture = await setup();
  for (const badField of ["stagingOnly", "nonpromotable"]) {
    const intent = { read: async (arg) => ({ ...await fixture.intent.read(arg), [badField]: false }) };
    await code(() => verify(fixture, { intent }), "emscripten_staging_intent_unavailable");
  }
  assertEquals(fixture.deletions, 0);
});

Deno.test("x9r8k: independent SW verifier refuses sealed or nonzero-byte staging authority", async () => {
  const fixture = await setup();
  const streamRoot = await fixture.root.getDirectoryHandle("wasm-tool-streams-v1");
  const output = await streamRoot.getDirectoryHandle(fixture.outputRef.id);
  const authorityFile = output.nodes.get("authority.json");
  const original = authorityFile.bytes;
  const metadata = JSON.parse(new TextDecoder().decode(original));
  for (const patch of [{ sealed: true }, { bytes: 2 }]) {
    authorityFile.bytes = new TextEncoder().encode(JSON.stringify({ ...metadata, ...patch }));
    await code(() => verify(fixture), "emscripten_staging_bytes_unavailable");
    authorityFile.bytes = original;
  }
  assertEquals(fixture.deletions, 0);
});

Deno.test("x9r8k.2: verifier checks deadline even if the injected SW reader lies", async () => {
  const fixture = await setup();
  const intent = { read: async (arg) => {
    const real = await fixture.intent.read(arg);
    return { ...real, reconcileBy: real.reconcileBy + 1 };
  } };
  await code(() => verify(fixture, { intent }), "emscripten_staging_intent_unavailable");
});

Deno.test("x9r8k.2: verifier checks owner even when both independent readers and metadata lie", async () => {
  const fixture = await setup();
  const forged = { ...(await fixture.intent.read({ identity: fixture.identity, inputRef: fixture.inputRef })).identity,
    owner: "agent:foreign_run_123456:|hub" };
  const intent = { read: async (arg) => ({ ...await fixture.intent.read(arg), identity: forged }) };
  const evidence = { read: async (arg) => ({ ...await fixture.evidence.read(arg), identity: forged }) };
  const streams = await fixture.root.getDirectoryHandle("wasm-tool-streams-v1");
  const output = await streams.getDirectoryHandle(fixture.outputRef.id);
  const authority = output.nodes.get("authority.json");
  authority.bytes = new TextEncoder().encode(JSON.stringify({
    ...JSON.parse(new TextDecoder().decode(authority.bytes)), owner: forged.owner,
  }));
  await code(() => verify(fixture, { intent, evidence }), "emscripten_staging_intent_unavailable");
  assertEquals(fixture.deletions, 0);
});

Deno.test("x9r8k.2: verifier pins unsealed authority id and owner, not just file hash", async () => {
  const fixture = await setup();
  const streams = await fixture.root.getDirectoryHandle("wasm-tool-streams-v1");
  const output = await streams.getDirectoryHandle(fixture.outputRef.id);
  const file = output.nodes.get("authority.json");
  const original = file.bytes;
  const meta = JSON.parse(new TextDecoder().decode(original));
  for (const patch of [{ id: "e".repeat(32) }, { owner: "agent:foreign_run_123456:|hub" }]) {
    file.bytes = new TextEncoder().encode(JSON.stringify({ ...meta, ...patch }));
    await code(() => verify(fixture), "emscripten_staging_bytes_unavailable");
    file.bytes = original;
  }
  assertEquals(fixture.deletions, 0);
});

Deno.test("x9r8k.2: SW rejects forged host receipt and record facts despite CLOSED bytes", async () => {
  const fixture = await setup();
  for (const hostProof of [
    { ...fixture.proof, evidenceState: "unknown" },
    { ...fixture.proof, writerFence: "shared" },
  ]) await code(() => verify(fixture, { hostProof }), "emscripten_staging_evidence_mismatch");
  const evidence = { read: async (arg) => ({ ...await fixture.evidence.read(arg),
    identity: { ...(await fixture.evidence.read(arg)).identity, operationId: "foreign" } }) };
  await code(() => verify(fixture, { evidence }), "emscripten_staging_evidence_mismatch");
  assertEquals(fixture.deletions, 0);
});

Deno.test("x9r8k: missing intent, SW restart or cancellation refuse without publication", async () => {
  const fixture = await setup();
  const missingIntent = { read: async () => { throw new Error("compacted"); } };
  await code(() => verify(fixture, { intent: missingIntent }), "emscripten_staging_intent_unavailable");
  await code(() => verify(fixture, { isLive: () => false }), "emscripten_run_not_live");
  let calls = 0;
  await code(() => verify(fixture, { isLive: () => ++calls === 1 }), "emscripten_run_not_live");
  assertEquals(fixture.deletions, 0);
});
