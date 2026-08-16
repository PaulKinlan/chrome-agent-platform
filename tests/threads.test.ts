// Unit test for the task-thread model (lib/threads.js): a task is a DISTINCT
// thread with its own persisted message history + an auto-generated name. This
// drives createThread / listThreads / getThread / appendThreadMessage /
// historyFromThread against the minimal in-memory OPFS fake.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  appendThreadMessage,
  createThread,
  generateThreadName,
  getThread,
  historyFromThread,
  listThreads,
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
    this.parts.push(String(s));
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
