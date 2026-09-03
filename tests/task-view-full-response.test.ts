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

Deno.test("full response (dptw): a message past the removed 240 KiB cap is stored WHOLE", async () => {
  const huge = "x".repeat((240 * 1024) + 2000);
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content: huge });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  assertEquals(last.content, huge, "dptw: no truncation, no marker — the whole response persists");
});

Deno.test("full response (dptw): multi-byte content of ANY byte size stores whole", async () => {
  // 90,000 emoji = 360,000 UTF-8 bytes — past the removed 240 KiB cap.
  const emoji = "\u{1F600}".repeat(90_000);
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content: emoji });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  assertEquals(last.content, emoji, "dptw: 360 KiB of emoji persists whole — no byte cap, no surrogate-split clip");
  // A smaller multi-byte response stores byte-complete too.
  const okEmoji = "\u{1F600}".repeat(45_000);
  const t2 = await createThread("seed");
  await appendThreadMessage(t2.id, { role: "assistant", content: okEmoji });
  const stored2 = await getThread(t2.id);
  assertEquals(stored2.messages.at(-1).content, okEmoji, "byte-complete");
});

Deno.test("full response: the SIDEBAR error preview stays a small bounded preview (r1 B3)", async () => {
  const { recordThreadError, listThreads } = await import("../extension/lib/threads.js");
  const longError = "provider exploded with an extremely long diagnostic message ".repeat(2000); // ~130 KiB
  const thread = await createThread("seed");
  await recordThreadError(thread.id, { message: longError, detail: longError });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  // The task-view error bubble may carry the full message...
  assert(last.content.length > 1000, "the thread error row keeps the full message for the task view");
  // ...but the SIDEBAR index preview must be a small bounded preview.
  const rows = await listThreads();
  const row = rows.find((r) => r.id === thread.id);
  assert(row, "thread row exists in the index");
  assert(row.preview.length <= 1024, `sidebar preview must stay bounded (got ${row.preview.length} chars)`);
  assert(row.error.length <= 1024, `sidebar error must stay bounded (got ${row.error.length} chars)`);
});

Deno.test("full response: the durable/terminal-commit path also bounds the SIDEBAR error preview (r2 B3)", async () => {
  const { commitThreadTerminal, listThreads } = await import("../extension/lib/threads.js");
  const longError = "durable terminal error with an extremely long diagnostic message ".repeat(3000); // ~195 KiB
  const thread = await createThread("seed");
  await commitThreadTerminal(thread.id, "exec-err", { role: "error", content: longError });
  const rows = await listThreads();
  const row = rows.find((r) => r.id === thread.id);
  assert(row, "thread row exists in the index");
  assert(row.error.length <= 1024, `the durable-error sidebar row.error must stay bounded (got ${row.error.length} chars)`);
  assert(row.preview.length <= 165, "the durable-error sidebar preview stays a preview");
});

Deno.test("full response: the byte-cap cut never splits a UTF-16 surrogate pair (r2 B5)", async () => {
  // Content whose UTF-8 bytes slightly exceed the 240 KiB cap, with emoji
  // (surrogate pairs) deliberately placed where the byte boundary lands. The
  // stored slice must not end with a lone high surrogate.
  const base = "The quick brown fox jumps over the lazy dog. ";
  const filler = "a".repeat(240 * 1024 - 30); // just under the cap in bytes
  const emojiTail = "\u{1F600}".repeat(40) + "z"; // 4-byte emoji straddling the boundary
  const content = filler + emojiTail;
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content });
  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  // The slice must be a valid code-point boundary: no lone high surrogate at
  // the end (the cut can fall inside a surrogate pair).
  const lastChar = last.content.charCodeAt(last.content.length - 1);
  assert(!(lastChar >= 0xD800 && lastChar <= 0xDBFF),
    `the cut left a lone high surrogate (last code unit 0x${lastChar.toString(16)})`);
  // Every code point decodes cleanly (no replacement chars from split pairs).
  const decoded = new TextDecoder().decode(new TextEncoder().encode(last.content));
  assert(!decoded.includes("\uFFFD"), "no replacement character — no split surrogate pair survived");
  // A below-cap response with the same emoji stores byte-complete and whole.
  const small = "\u{1F600}".repeat(100);
  const t2 = await createThread("seed");
  await appendThreadMessage(t2.id, { role: "assistant", content: small });
  const stored2 = await getThread(t2.id);
  const last2 = stored2.messages.at(-1);
  assertEquals(last2.content.length, 200, "below-cap emoji stores whole (200 UTF-16 units)");
  assertEquals(last2.content.charCodeAt(199), 0xDE00, "the pair's low surrogate is intact at the end");
});
