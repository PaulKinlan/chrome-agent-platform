// @ts-nocheck — the OPFS fake is intentionally dynamic.
// tests/thread-persist-regression.test.ts — CAP-FB-20260824-THREAD-PERSIST-01:
// (A) tool replay inserts BEFORE the terminal row (the thread ends on the
// terminal, not a tool); (B) a thread over the byte budget never evicts the
// terminal assistant/error row + its triggering user row.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { appendThreadMessage, commitThreadTerminal, createThread, getThread } from "../extension/lib/threads.js";

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
  async getFile() {
    const node = this.node;
    return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } };
  }
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

Deno.test("thread persist (A): tool replay inserts BEFORE the terminal row — the thread ends on the terminal", async () => {
  const t = await createThread("First question");
  const id = t.id;
  // The durable outbox commits the terminal FIRST (as it does in production).
  await commitThreadTerminal(id, "exec_1", { role: "assistant", content: "Final answer" });
  // The post-run tool replay lands AFTER, keyed by the same executionId.
  await appendThreadMessage(id, { role: "tool", toolName: "fetch", toolStatus: "success", toolResult: "data", toolOk: true, toolCallId: "c1", executionId: "exec_1" });
  await appendThreadMessage(id, { role: "tool", toolName: "compute", toolStatus: "success", toolResult: "42", toolOk: true, toolCallId: "c2", executionId: "exec_1" });

  const thread = await getThread(id);
  const roles = thread.messages.map((m) => m.role);
  assertEquals(roles[roles.length - 1], "assistant", "the terminal assistant row is LAST, not mid-thread");
  assertEquals(thread.messages[thread.messages.length - 1].content, "Final answer");
  assert(roles.slice(0, -1).includes("tool"), "the tool rows land BEFORE the terminal");
  // The tool rows are between the user and the terminal (insert-before-terminal).
  assertEquals(roles[0], "user");
  assertEquals(thread.messages.filter((m) => m.role === "tool").length, 2);
});

Deno.test("thread persist (B): a thread over the byte budget keeps the terminal + its triggering user row", async () => {
  const t = await createThread("Triggering question");
  const id = t.id;
  await commitThreadTerminal(id, "exec_1", { role: "assistant", content: "The answer" });
  // The self-embedding loop: a bounded-but-large tool result (16 KiB) is
  // re-appended many times, blowing the 200 KiB budget. The terminal + the
  // user must survive the trim; the OLDEST tool rows are evicted instead.
  for (let i = 0; i < 20; i++) {
    await appendThreadMessage(id, { role: "tool", toolName: "memory_get", toolStatus: "success", toolResult: `t${i}:` + "x".repeat(16 * 1024), toolOk: true, toolCallId: `c${i}`, executionId: "exec_1" });
  }
  const thread = await getThread(id);
  const roles = thread.messages.map((m) => m.role);
  // The terminal + the user survive.
  assert(thread.messages.some((m) => m.role === "assistant" && m.content === "The answer"), "the terminal survives the trim");
  assert(thread.messages.some((m) => m.role === "user" && m.content === "Triggering question"), "the triggering user survives the trim");
  // The terminal is still LAST (the DEFECT A invariant holds under eviction).
  assertEquals(roles[roles.length - 1], "assistant");
});
