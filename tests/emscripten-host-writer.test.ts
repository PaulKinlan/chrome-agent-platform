// 3mcu1: host-owned output writer; no binary operation is exposed to the model.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { openAuditedHostOwnedEmscriptenWriter, openHostOwnedEmscriptenWriter } from "../extension/lib/emscripten-host-writer.js";
import { createEmscriptenHostEvidence } from "../extension/lib/emscripten-host-evidence.js";
import { createWasmStreamOutput, listWasmStreamEntries, WASM_STREAM_ROOT_NAME } from "../extension/lib/wasm-stream-files.js";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";

const RUN = "exec_host_writer_123456";
const AGENT = "named:alice";
const identityFor = (outputRef) => ({
  runId: RUN, agentId: AGENT, outputRef, generation: "b".repeat(32),
  packageId: "image.tool", graphDigest: "c".repeat(64), operationId: "resize",
});
function missing() { return new DOMException("not found", "NotFoundError"); }
function memoryStorage({ exclusive = true, exclusivePerHandle = false, terminalExclusiveFails = false, closeFails = false, writeFails = false, beforeStdoutWrite } = {}) {
  const dir = () => {
    const children = new Map();
    return {
      children,
      async getDirectoryHandle(name, { create = false } = {}) {
        if (!children.has(name) && create) children.set(name, dir());
        const node = children.get(name);
        if (!node?.getDirectoryHandle) throw missing();
        return node;
      },
      async getFileHandle(name, { create = false } = {}) {
        if (!children.has(name) && create) children.set(name, { bytes: new Uint8Array(), open: 0, exclusiveOpens: 0 });
        const node = children.get(name);
        if (!node || node.getDirectoryHandle) throw missing();
        let handleOpen = 0;
        return {
          getFile: async () => new Blob([node.bytes]),
          createWritable: async (options = {}) => {
            if (terminalExclusiveFails && name === "stdout.bin" && options.mode === "exclusive" && node.exclusiveOpens > 0 && node.open === 0) {
              throw new DOMException("terminal lock unavailable", "NoModificationAllowedError");
            }
            if (exclusive && options.mode === "exclusive" &&
                (exclusivePerHandle ? handleOpen : node.open)) {
              throw new DOMException("exclusive", "NoModificationAllowedError");
            }
            node.open++; handleOpen++;
            if (options.mode === "exclusive") node.exclusiveOpens++;
            let next = new Uint8Array();
            let position = 0;
            let ended = false;
            const release = () => { if (!ended) { ended = true; node.open--; handleOpen--; } };
            return {
              async write(value) {
                if (name === "stdout.bin") await beforeStdoutWrite?.();
                if (ended) throw new Error("write after close");
                if (writeFails && name === "stdout.bin") throw new Error("injected write failure");
                const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
                const merged = new Uint8Array(Math.max(next.length, position + bytes.length));
                merged.set(next); merged.set(bytes, position); next = merged; position += bytes.length;
              },
              async close() { if (closeFails && name === "stdout.bin") throw new Error("injected close failure"); node.bytes = next; release(); },
              async abort() { release(); },
            };
          },
        };
      },
      async removeEntry(name) { if (!children.delete(name)) throw missing(); },
      async *entries() { for (const [name, node] of children) yield [name, { kind: node.getDirectoryHandle ? "directory" : "file" }]; },
    };
  };
  const root = dir();
  return { storage: { getDirectory: async () => root }, root };
}
async function setup(options) {
  const { storage, root } = memoryStorage(options);
  const owner = emscriptenJobOwner({ runId: RUN, agentId: AGENT });
  const outputRef = await createWasmStreamOutput({ owner, storage });
  const reasons = [];
  const open = () => openHostOwnedEmscriptenWriter({ runId: RUN, agentId: AGENT, outputRef, storage,
    recordUnknown: async (reason) => { reasons.push(reason); } });
  return { storage, root, outputRef, reasons, open };
}
async function code(operation, expected) {
  const error = await assertRejects(operation);
  assertEquals(error.code ?? error.message, expected);
}

Deno.test("3mcu1: host drains ordered frames, closes exclusive writer and independently hashes bytes", async () => {
  const { storage, root, outputRef, open } = await setup();
  const channel = await open();
  const a = new TextEncoder().encode("hello");
  const b = new TextEncoder().encode(" world");
  await channel.push({ seq: 0, chunk: a });
  await channel.push({ seq: 1, chunk: b });
  const proof = await channel.close();
  assertEquals(proof.state, "closed");
  assertEquals(proof.writerFence, "exclusive");
  assertEquals(proof.frames, 2);
  assertEquals(proof.bytes, 11);
  const streamRoot = await root.getDirectoryHandle(WASM_STREAM_ROOT_NAME);
  const outputDir = await streamRoot.getDirectoryHandle(outputRef.id);
  const file = await (await outputDir.getFileHandle("stdout.bin")).getFile();
  assertEquals(await file.text(), "hello world");
  assertEquals(proof.sha256, [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello world")))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  await code(() => channel.push({ seq: 2, chunk: a }), "emscripten_writer_not_open");
  assertEquals((await listWasmStreamEntries({ storage })).length, 1, "no seal, publish or delete");
});

Deno.test("3mcu1: a frame arriving after drain begins poisons positive proof", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { storage, outputRef, open } = await setup({ beforeStdoutWrite: () => gate });
  const channel = await open();
  const first = channel.push({ seq: 0, chunk: new Uint8Array([1, 2, 3]) });
  const closing = channel.close();
  await code(() => channel.push({ seq: 1, chunk: new Uint8Array([4, 5]) }), "emscripten_writer_not_open");
  release();
  await first.catch(() => {});
  await code(() => closing, "emscripten_writer_not_open");
  assertEquals(channel.state, "unknown");
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [outputRef.id]);
});

Deno.test("3mcu1: close cannot advertise bytes while a host write is still pending", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { open } = await setup({ beforeStdoutWrite: () => gate });
  const channel = await open();
  const frame = channel.push({ seq: 0, chunk: new Uint8Array([4, 5, 6]) });
  const closing = channel.close();
  let settled = false;
  closing.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assertEquals(settled, false, "pending write fences close");
  release();
  await frame;
  const proof = await closing;
  assertEquals(proof.bytes, 3);
  assertEquals(proof.frames, 1);
});

Deno.test("3mcu1: a lock scoped only to one FileSystemFileHandle fails closed", async () => {
  const { open } = await setup({ exclusivePerHandle: true });
  await code(open, "emscripten_writer_exclusivity_unavailable");
});

Deno.test("3mcu1: silently ignored exclusive mode refuses instead of using siloed writer", async () => {
  const { storage, root, outputRef, open } = await setup({ exclusive: false });
  await code(open, "emscripten_writer_exclusivity_unavailable");
  const dir = await (await root.getDirectoryHandle(WASM_STREAM_ROOT_NAME)).getDirectoryHandle(outputRef.id);
  assertEquals(dir.children.get("stdout.bin").open, 0, "both probe handles aborted");
  assertEquals((await listWasmStreamEntries({ storage })).length, 1);
});

Deno.test("3mcu1: terminal lock re-acquisition failure yields UNKNOWN after close", async () => {
  const { storage, outputRef, open } = await setup({ terminalExclusiveFails: true });
  const channel = await open();
  await channel.push({ seq: 0, chunk: new Uint8Array([1]) });
  await code(() => channel.close(), "emscripten_writer_exclusivity_unavailable");
  assertEquals(channel.state, "unknown");
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [outputRef.id]);
});

Deno.test("3mcu1: close and write failures become UNKNOWN; no seal/artifact/cleanup", async () => {
  for (const options of [{ closeFails: true }, { writeFails: true }]) {
    const { storage, outputRef, reasons, open } = await setup(options);
    const channel = await open();
    if (options.closeFails) {
      await channel.push({ seq: 0, chunk: new Uint8Array([1]) });
      await code(() => channel.close(), "emscripten_writer_close_failed");
    } else {
      await code(() => channel.push({ seq: 0, chunk: new Uint8Array([1]) }), "emscripten_writer_write_failed");
    }
    assertEquals(channel.state, "unknown");
    assertEquals(reasons, ["writer_fence_unavailable"]);
    assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [outputRef.id]);
  }
});

Deno.test("3mcu1: forced abort and invalid/gapped frames never seal or delete output", async () => {
  const { storage, outputRef, reasons, open } = await setup();
  const channel = await open();
  await code(() => channel.push({ seq: 1, chunk: new Uint8Array([1]) }), "emscripten_writer_frame_invalid");
  assertEquals(channel.state, "unknown");
  assertEquals(reasons, ["writer_fence_unavailable"]);
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [outputRef.id]);
  const another = await setup();
  const active = await another.open();
  await active.abort("deadline");
  await code(() => active.close(), "emscripten_writer_not_open");
  assertEquals(another.reasons, ["deadline"]);
  assertEquals((await listWasmStreamEntries({ storage: another.storage })).length, 1);
});

Deno.test("3mcu1: host-owned close proof persists across offscreen restart; no artifact is sealed", async () => {
  const { storage, outputRef } = await setup();
  const identity = identityFor(outputRef);
  const host = createEmscriptenHostEvidence({ storage });
  const channel = await openAuditedHostOwnedEmscriptenWriter({ identity, storage, evidence: host });
  assertEquals((await host.read(identity)).state, "unknown", "pending is never positive evidence");
  await channel.push({ seq: 0, chunk: new Uint8Array([3, 4, 5]) });
  const result = await channel.close();
  assertEquals(result.evidenceState, "closed");
  const restarted = createEmscriptenHostEvidence({ storage });
  const saved = await restarted.read(identity);
  assertEquals(saved.state, "closed");
  assertEquals(saved.proof.bytes, 3);
  assertEquals(saved.proof.sha256, result.sha256);
  await code(() => restarted.begin(identity), "emscripten_host_evidence_closed");
  await code(() => host.recordUnknown(identity, "deadline"), "emscripten_host_evidence_collision");
  assertEquals((await listWasmStreamEntries({ storage })).length, 1);
});

Deno.test("3mcu1: failed host-owned close leaves only durable UNKNOWN, never closed", async () => {
  const { storage, outputRef } = await setup({ closeFails: true });
  const identity = identityFor(outputRef);
  const host = createEmscriptenHostEvidence({ storage });
  const channel = await openAuditedHostOwnedEmscriptenWriter({ identity, storage, evidence: host });
  await channel.push({ seq: 0, chunk: new Uint8Array([1]) });
  await code(() => channel.close(), "emscripten_writer_close_failed");
  assertEquals((await createEmscriptenHostEvidence({ storage }).read(identity)).state, "unknown");
  assertEquals((await host.read(identity)).reason, "writer_fence_unavailable");
});

Deno.test("3mcu1: final audit append failure never returns a CLOSED receipt", async () => {
  const { storage, outputRef } = await setup();
  const identity = identityFor(outputRef);
  const host = createEmscriptenHostEvidence({ storage });
  const evidence = {
    begin: (raw) => host.begin(raw),
    recordUnknown: (raw, reason) => host.recordUnknown(raw, reason),
    recordClosed: async () => { throw new Error("injected audit failure"); },
  };
  const channel = await openAuditedHostOwnedEmscriptenWriter({ identity, storage, evidence });
  await channel.push({ seq: 0, chunk: new Uint8Array([1]) });
  await assertRejects(() => channel.close(), Error, "injected audit failure");
  assertEquals((await host.read(identity)).state, "unknown", "pending remains nonpublishable");
});

Deno.test("3mcu1: existing native worker envelope has exact keys and no OPFS capability", async () => {
  const host = await Deno.readTextFile(new URL("../extension/lib/emscripten-host.js", import.meta.url));
  const worker = await Deno.readTextFile(new URL("../extension/lib/emscripten-worker.js", import.meta.url));
  assert(host.includes('fail("emscripten_output_custody_unavailable")'), "binary host guard remains");
  assert(worker.includes('if (!exactKeys(job, JOB_KEYS)'), "worker rejects extra keys");
  const keys = worker.match(/const JOB_KEYS = Object\.freeze\(\[([\s\S]*?)\]\);/u)?.[1] ?? "";
  assert(keys.includes('"wasmBytes"'));
  assert(!/"(?:inputRef|outputRef|handles|storage|owner|root|directory)"/u.test(keys));
  assert(!/setTimeout|setInterval/u.test(await Deno.readTextFile(new URL("../extension/lib/emscripten-host-writer.js", import.meta.url))));
});
