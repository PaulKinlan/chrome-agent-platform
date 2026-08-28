// Unit test for the task-thread model (lib/threads.js): a task is a DISTINCT
// thread with its own persisted message history + an auto-generated name. This
// drives createThread / listThreads / getThread / appendThreadMessage /
// historyFromThread against the minimal in-memory OPFS fake.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  appendThreadMessage,
  commitThreadCancellation,
  commitThreadTerminal,
  createThread,
  deleteThread,
  generateThreadName,
  getThread,
  historyFromThread,
  listThreads,
  recordThreadError,
  setThreadStatus,
} from "../extension/lib/threads.js";

// ---- minimal in-memory OPFS fake ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
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
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
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

Deno.test("createThread creates a named thread + lists it most-recent-first", async () => {
  const a = await createThread("Summarise the key points of this page");
  const b = await createThread("Group my tabs by domain");
  assert(a.id && b.id, "threads must have ids");
  assert(a.name.length > 0, "a thread must have a fallback name");

  const threads = await listThreads();
  assertEquals(threads[0].id, b.id, "most-recent thread first");
  assertEquals(threads[1].id, a.id, "older thread after");
  assertEquals(threads[0].count, 1, "a new thread has one user message");
});

Deno.test("appendThreadMessage appends to the thread + updates the index preview", async () => {
  const t = await createThread("Write a summary");
  const id = t.id;
  await appendThreadMessage(id, { role: "assistant", content: "Here is the summary." });

  const thread = await getThread(id);
  assertEquals(thread.messages.length, 2, "user + assistant");
  assertEquals(thread.messages[1].role, "assistant");
  assertEquals(thread.status, "done");

  const index = await listThreads();
  assertEquals(index[0].preview, "Here is the summary.", "the preview is the last message");
  assertEquals(index[0].count, 2);
});

Deno.test("historyFromThread maps messages to agent-do turn shape", async () => {
  const t = await createThread("first question");
  await appendThreadMessage(t.id, { role: "assistant", content: "first answer" });
  await appendThreadMessage(t.id, { role: "user", content: "follow-up" });

  const history = historyFromThread(await getThread(t.id));
  assertEquals(history, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up" },
  ]);
});

Deno.test("generateThreadName falls back to the first line without the Prompt API", async () => {
  // No LanguageModel / ai in Deno → isPromptApiAvailable() returns false → fallback.
  const name = await generateThreadName("Group my tabs by domain\nand colour-code them");
  assertEquals(name, "Group my tabs by domain", "first line is the fallback title");
});

Deno.test("concurrent createThread calls never lose an index row (wider-goal thread race)", async () => {
  // The unlocked read-index→unshift→write-index sequence let two concurrent
  // creates last-write-wins (one thread silently dropped). Fire 25 concurrent
  // creates; EVERY one must appear in the index (the per-thread mutex
  // serializes the read-modify-write).
  const ids = await Promise.all(
    Array.from({ length: 25 }, (_, i) => createThread(`task ${i}`)),
  );
  const index = await listThreads();
  const indexed = new Set(index.map((r) => r.id));
  for (const t of ids) {
    assert(indexed.has(t.id), `thread ${t.id} must be in the index`);
  }
});

Deno.test("recordThreadError stores the failure detail + surfaces the error preview", async () => {
  const t = await createThread("summarise a page");
  await recordThreadError(t.id, { message: "No output generated", tool: "open_tab" });

  const thread = await getThread(t.id);
  assertEquals(thread.status, "error");
  assertEquals(thread.lastError.message, "No output generated");
  assertEquals(thread.lastError.tool, "open_tab");
  // The error is an `error`-role message in the thread (rendered as a danger bubble).
  const last = thread.messages[thread.messages.length - 1];
  assertEquals(last.role, "error");
  assertEquals(last.content, "No output generated");

  const index = await listThreads();
  const row = index.find((r) => r.id === t.id);
  assertEquals(row.status, "error");
  assertEquals(row.preview, "No output generated", "the error is the list preview");
});

Deno.test("a successful retry clears the prior error detail", async () => {
  const t = await createThread("summarise a page");
  await recordThreadError(t.id, { message: "failed" });
  await appendThreadMessage(t.id, { role: "assistant", content: "done now" });
  await setThreadStatus(t.id, "done");

  const thread = await getThread(t.id);
  assertEquals(thread.status, "done");
  assertEquals(thread.lastError, undefined, "a success clears the stale error");
  const index = await listThreads();
  const row = index.find((r) => r.id === t.id);
  assertEquals(row.status, "done");
});

Deno.test("commitThreadTerminal is idempotent by executionId and later tool replay preserves terminal status", async () => {
  const thread = await createThread("durable task");
  await commitThreadTerminal(thread.id, "exec-thread-001", {
    role: "assistant",
    content: "one answer",
    status: "done",
  });
  await commitThreadTerminal(thread.id, "exec-thread-001", {
    role: "assistant",
    content: "duplicate answer",
    status: "done",
  });
  await appendThreadMessage(thread.id, {
    role: "tool",
    toolName: "memory_get",
    toolStatus: "done",
  });
  const saved = await getThread(thread.id);
  assertEquals(saved.messages.filter((message) => message.executionId === "exec-thread-001").length, 1);
  assertEquals(saved.messages.find((message) => message.executionId === "exec-thread-001").content, "one answer");
  assertEquals(saved.status, "done");
});

Deno.test("commitThreadCancellation replaces a partial terminal and remains singular", async () => {
  const thread = await createThread("cancel me");
  await commitThreadTerminal(thread.id, "exec_cancel", { role: "assistant", content: "partial", status: "done" });
  await commitThreadCancellation(thread.id, "exec_cancel", { content: "Run cancelled by owner", reason: "explicit owner cancellation" });
  await commitThreadCancellation(thread.id, "exec_cancel", { content: "Run cancelled by owner", reason: "explicit owner cancellation" });
  const saved = await getThread(thread.id);
  assertEquals(saved.status, "cancelled");
  assertEquals(saved.messages.filter((message) => message.executionId === "exec_cancel").length, 1);
  assertEquals(saved.messages.find((message) => message.executionId === "exec_cancel").cancelled, true);
});

Deno.test("deleteThread removes the index row AND the body atomically (item 17)", async () => {
  const a = await createThread("keep me");
  const b = await createThread("delete me");
  // Sanity: both present before the delete.
  let index = await listThreads();
  assert(index.some((r) => r.id === a.id) && index.some((r) => r.id === b.id));
  // Delete b: the body is gone AND the index row is gone.
  const removed = await deleteThread(b.id);
  assertEquals(removed, true);
  assertEquals(await getThread(b.id), null);
  index = await listThreads();
  assert(!index.some((r) => r.id === b.id), "deleted thread must leave the index");
  assert(index.some((r) => r.id === a.id), "the other thread must survive");
  // Deleting an absent id is a clean false (never a throw).
  assertEquals(await deleteThread("nope"), false);
});
