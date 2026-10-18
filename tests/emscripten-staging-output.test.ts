// x9r8k: once durable intent exists, failed output creation must quarantine, not delete.
// @ts-nocheck
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createWasmStreamOutput, WASM_STREAM_ROOT_NAME } from "../extension/lib/wasm-stream-files.js";

Deno.test("x9r8k: staging output preserves partial directory on post-intent creation failure", async () => {
  const events = [];
  const directories = new Map();
  const output = {
    async getFileHandle(name) {
      if (name === "stderr.bin") throw new Error("injected stderr create failure");
      return {};
    },
  };
  const streams = {
    async getDirectoryHandle(id, { create } = {}) {
      if (create) directories.set(id, output);
      if (!directories.has(id)) throw new DOMException("missing", "NotFoundError");
      return output;
    },
    async removeEntry(id) { events.push("DELETE"); directories.delete(id); },
  };
  const storage = { getDirectory: async () => ({
    getDirectoryHandle: async (name) => {
      assertEquals(name, WASM_STREAM_ROOT_NAME);
      return streams;
    },
  }) };
  let outputRef;
  const error = await assertRejects(() => createWasmStreamOutput({
    owner: "agent:exec_staging_123456:|hub", storage,
    beforeCreate: (ref) => { outputRef = ref; events.push(`INTENT:${ref.id}`); },
    preserveOnFailure: true,
  }));
  assertEquals(error.message, "injected stderr create failure");
  assertEquals(events, [`INTENT:${outputRef.id}`], "never delete after SW intent persisted");
  assertEquals(directories.has(outputRef.id), true, "quarantine partial staging output");
});
