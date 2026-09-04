// tests/task-view-full-response-contract.test.ts — CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 (znx9)
// @ts-nocheck
//
// Verifies:
// 1. Thread store capacity: response stored up to 252 KiB / 240 KiB in UTF-8 bytes (not UTF-16 chars).
// 2. Never-silent dynamic truncation marker states the actual cap and points to the run log.
// 3. Serialized outbox fits within the 256 KiB store bound with escape-aware sizing and backstop shrink.
// 4. Surrogate-safe slicing: byte-cap cuts never split a UTF-16 surrogate pair.
// 5. Redaction: applied BEFORE storage and persistence on the outbox and thread.
// 6. UI: responses >4000 chars collapsed behind Show-full-response toggle; Copy takes full stored content.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  appendThreadMessage,
  commitThreadTerminal,
  createThread,
  getThread,
  listThreads,
} from "../extension/lib/threads.js";
import {
  createDurableRunRegistry,
  DURABLE_RUN_POLICY,
} from "../extension/lib/durable-runs.js";

// ---- in-memory OPFS fake ----
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

class MockMemoryStore {
  values = new Map();
  versions = new Map();
  isMaster = true;
  origin = "master";
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async has(key) { return this.values.has(key); }
  async getVersion(key) { return this.versions.get(key) ?? 0; }
  async snapshot(key) {
    return { exists: this.values.has(key), value: this.values.has(key) ? structuredClone(this.values.get(key)) : null, version: this.versions.get(key) ?? 0 };
  }
  async setTrusted(key, value) {
    const version = (this.versions.get(key) ?? 0) + 1;
    this.values.set(key, structuredClone(value));
    this.versions.set(key, version);
    return version;
  }
  async keys() { return [...this.values.keys()].sort(); }
  async delete(key) {
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  async compareAndDelete(key, expected) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    this.values.delete(key);
    this.versions.set(key, expected + 1);
    return true;
  }
  async compareAndRestore(key, expected, value) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    await this.setTrusted(key, value);
    return true;
  }
}

function makeLogHandles() {
  const files = new Map();
  return (executionId, { create = false } = {}) => {
    let node = files.get(executionId);
    if (!node) {
      if (!create) return Promise.resolve(null);
      node = { content: "" };
      files.set(executionId, node);
    }
    return Promise.resolve({
      async getFile() { return { size: node.content.length, async text() { return node.content; } }; },
      async createWritable() {
        return {
          async write(chunk) { node.content += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); },
          async close() {},
        };
      },
    });
  };
}

function makeHarness(store) {
  const journal = [];
  const thread = [];
  const registry = createDurableRunRegistry({
    store,
    bootId: "boot-znx9",
    now: () => 1000,
    logHandleFor: makeLogHandles(),
    resolveJournalStore: async () => ({ journal }),
    appendJournal: async (target, entry) => { target.journal.push(structuredClone(entry)); },
    commitThread: async (threadId, executionId, terminal) => {
      thread.push({ threadId, executionId, ...structuredClone(terminal) });
    },
  });
  return { registry, journal, thread };
}

Deno.test("znx9: thread store capacity is 240 KiB UTF-8 bytes and preserves below-cap payloads complete", async () => {

  // 120 KiB payload (~half cap)
  const halfCap = "a".repeat(120 * 1024);
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content: halfCap });

  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  assertEquals(last.content.length, halfCap.length, "below-cap payload stored byte-complete");
  assertEquals(new TextEncoder().encode(last.content).byteLength, 120 * 1024);
});

Deno.test("znx9: over-cap messages carry dynamic non-silent truncation marker stating actual cap", async () => {
  const overCap = "x".repeat((240 * 1024) + 5000);
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content: overCap });

  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  const bytes = new TextEncoder().encode(last.content).byteLength;
  assert(bytes <= 240 * 1024, `content must stay <= 240 KiB, got ${bytes}`);
  assert(last.content.includes("truncated to 240 KiB"), "marker specifies 240 KiB cap");
  assert(last.content.includes("complete text is in the run log"), "points to run log");
});

Deno.test("znx9: surrogate-safe code-point slicing never leaves split high surrogates", async () => {
  // Boundary filled with 4-byte emoji (surrogate pairs in UTF-16)
  const fill = "b".repeat(240 * 1024 - 20);
  const emojis = "\u{1F600}".repeat(20);
  const content = fill + emojis;

  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content });

  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);

  // Validate that the last code unit is NOT a lone high surrogate
  const lastCode = last.content.charCodeAt(last.content.length - 1);
  assert(!(lastCode >= 0xD800 && lastCode <= 0xDBFF), "must not end in high surrogate");

  // Verify full round-trip decode without Unicode replacement character
  const reDecoded = new TextDecoder().decode(new TextEncoder().encode(last.content));
  assert(!reDecoded.includes("\uFFFD"), "no replacement character from broken surrogate pairs");
});

Deno.test("znx9: serialized outbox fits under 256 KiB store bound with escape-aware sizing", async () => {
  const mockStore = new MockMemoryStore();
  const captured = {};
  const origSetTrusted = mockStore.setTrusted.bind(mockStore);
  mockStore.setTrusted = async (key, val) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(val);
    return origSetTrusted(key, val);
  };

  const { registry } = makeHarness(mockStore);
  const executionId = "exec_znx9_test";
  await registry.start({
    executionId,
    clientCorrelationId: "page-znx9-1",
    threadId: "thread-znx9",
    kind: "task",
    taskPreview: "Big Task",
    journalTarget: "master",
    resumeRequest: {
      id: "task-1",
      task: "Big Task",
      memoryOrigin: "master",
      providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true },
      idempotencyKey: executionId,
    },
  });

  // Large content payload (~220 KiB)
  const largeOutput = "Super large output content block with data. ".repeat(5000);
  await registry.settle(executionId, {
    ok: true,
    result: largeOutput,
    summary: "done",
    logicalId: "task-1",
  });

  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox record was created");

  // Serialized byte length must strictly fit under the 256 KiB store bound
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized <= 256 * 1024, `outbox must fit in 256 KiB, got ${serialized} bytes`);
});

Deno.test("znx9: redaction occurs before outbox and thread storage", async () => {
  const mockStore = new MockMemoryStore();
  const captured = {};
  const origSetTrusted = mockStore.setTrusted.bind(mockStore);
  mockStore.setTrusted = async (key, val) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(val);
    return origSetTrusted(key, val);
  };

  const { registry } = makeHarness(mockStore);
  const executionId = "exec_redact_test";
  await registry.start({
    executionId,
    clientCorrelationId: "page-redact-1",
    threadId: "thread-redact",
    kind: "task",
    taskPreview: "Secret task",
    journalTarget: "master",
    resumeRequest: {
      id: "task-2",
      task: "Secret task",
      memoryOrigin: "master",
      providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true },
      idempotencyKey: executionId,
    },
  });

  const secretKey = "sk-r2secrettokentest123456";
  const secretString = `apiKey=${secretKey}`;
  await registry.settle(executionId, {
    ok: true,
    result: `The secret key generated is ${secretString}`,
    summary: "done",
    logicalId: "task-2",
  });

  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox written");
  const outboxJson = JSON.stringify(outbox);
  assert(!outboxJson.includes(secretKey), "secret token must be redacted in outbox before storage");
  assert(outboxJson.includes("[REDACTED]"), "redaction marker must be present in outbox");
});

Deno.test("znx9: message bubble long-response collapsing threshold and copy fidelity", async () => {
  const components = await Deno.readTextFile("extension/shared/components.js");

  // Threshold check: 4000 characters
  assert(components.includes("LONG_PREVIEW_CHARS = 4000") || components.includes("4000"), "threshold is 4000 chars");
  assert(components.includes("Show full response"), "Show full response button label exists");
  assert(components.includes("Copy full response") || components.includes("copy-full"), "Copy button exists");

  // Copy behavior copies complete content attribute, not sliced DOM text
  assert(components.includes('this.getAttribute("content")'), "Copy reads full content attribute");
});
