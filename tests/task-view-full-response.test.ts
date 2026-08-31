// tests/task-view-full-response.test.ts — CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01
//
// The owner reported the agent's response is TRUNCATED in the task view. Root
// cause (verified in the investigation): COMMIT-TIME truncation — boundText()
// capped every message at 16 KiB (MAX_MESSAGE_CHARS) in lib/threads.js and the
// durable outbox terminal result at 16 KiB in lib/durable-runs.js, so the
// thread STORE itself never held the full response. The fix raises both bounds
// to 512 KiB (the full text is always preserved in the durable journal's
// retainedPayloadRef), makes an over-budget slice explicit (never silent), and
// adds a Show-full-response expander + copy button to long agent bubbles.
// @ts-nocheck — the OPFS fake is intentionally dynamic.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  appendThreadMessage,
  commitThreadTerminal,
  createThread,
  getThread,
} from "../extension/lib/threads.js";

// ---- minimal in-memory OPFS fake (mirrors tests/threads.test.ts) ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() { const node = this.node; return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } }; }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
  writable: true,
});

Deno.test("full response: a long agent response persists BYTE-COMPLETE in the thread store (RED on the old 16 KiB cap)", async () => {
  const longResponse = "The quick brown fox jumps over the lazy dog. ".repeat(2000); // ~84 KiB > the old 16 KiB cap
  const thread = await createThread("seed");
  const t = await getThread(thread.id);
  assert(t, "thread exists");
  await appendThreadMessage(thread.id, { role: "assistant", content: longResponse });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  assertEquals(last.role, "assistant", "last row is the assistant response");
  assert(last.content.length === longResponse.length,
    `response must be stored byte-complete (stored ${last.content.length}, expected ${longResponse.length}) — the old 16 KiB cap truncated at commit`);
  assert(last.content.endsWith("lazy dog. "), "tail of the response survived");
});

Deno.test("full response: the terminal commit path also stores the complete text", async () => {
  const longResponse = "Alpha bravo charlie delta echo foxtrot. ".repeat(1500); // ~66 KiB
  const thread = await createThread("seed");
  await commitThreadTerminal(thread.id, "exec-1", { role: "assistant", content: longResponse });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  assert(last.content.length === longResponse.length,
    `terminal commit must store the full response (stored ${last.content.length}, expected ${longResponse.length})`);
  assert(last.content.endsWith("foxtrot. "), "the final characters of the response are present");
});

Deno.test("full response: an OVER-budget message (beyond the cap) is never silently truncated", async () => {
  const huge = "x".repeat((252 * 1024) + 2000);
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content: huge });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  assert(last.content.includes("truncated to 252 KiB"), "the truncation marker is present (never silent)");
  assert(last.content.includes("complete text is in the run log"), "the reader is told where the full text lives");
});
