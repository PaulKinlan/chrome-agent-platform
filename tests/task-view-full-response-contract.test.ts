// tests/task-view-full-response-contract.test.ts — CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 (znx9)
// @ts-nocheck
//
// Verifies:
// 1. Thread store capacity: response stored up to 240 KiB UTF-8 bytes (not UTF-16 chars) with surrogate-safe code-point slicing.
// 2. Dynamic truncation marker states the actual cap and points to the run log.
// 3. Serialized outbox fits within the 256 KiB store bound with escape-aware sizing and backstop shrink reporting reduced cap.
// 4. Redaction: applied BEFORE storage across outbox, retained payload chunks, journal, and thread terminal.
// 5. UI: real <message-bubble> execution at 4000/4001 boundary, toggle expands, and Copy copies complete stored content.

const registry = new Map();
class HTMLElementStub {
  constructor() { this._attrs = new Map(); }
  attachShadow(_init) { return new ShadowRootStub(); }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class ShadowRootStub {
  get innerHTML() { return ""; }
  set innerHTML(_v) {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
}

globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  appendThreadMessage,
  commitThreadTerminal,
  createThread,
  getThread,
  listThreads,
  MAX_MESSAGE_BYTES,
  MAX_THREAD_BYTES,
} from "../extension/lib/threads.js";
import {
  createDurableRunRegistry,
  DURABLE_RUN_POLICY,
} from "../extension/lib/durable-runs.js";
import { createMemoryRunLogHandles } from "../extension/lib/run-log-wal-memory.js";

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
  value: {
    storage: { async getDirectory() { return new FakeDirHandle(root); } },
    clipboard: { async writeText() {} },
  },
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

function makeHarness(store) {
  const journal = [];
  const thread = [];
  const registry = createDurableRunRegistry({
    store,
    bootId: "boot-znx9",
    now: () => 1000,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    resolveJournalStore: async () => ({ journal }),
    appendJournal: async (target, entry) => { target.journal.push(structuredClone(entry)); },
    commitThread: async (threadId, executionId, terminal) => {
      thread.push({ threadId, executionId, ...structuredClone(terminal) });
    },
  });
  return { registry, journal, thread };
}

// ── 1. Multibyte near-cap preservation & surrogate-safe code-point slicing ──

Deno.test("znx9: thread store capacity (240 KiB UTF-8 bytes) preserves near-cap multibyte payloads byte-complete", async () => {
  assertEquals(MAX_MESSAGE_BYTES, 240 * 1024, "MAX_MESSAGE_BYTES is 240 KiB");
  assertEquals(MAX_THREAD_BYTES, 248 * 1024, "MAX_THREAD_BYTES is 248 KiB");

  // Near-cap multibyte payload: 45,000 4-byte emoji (\u{1F600}) = 180,000 UTF-8 bytes (90,000 UTF-16 code units)
  // This is well above 120 KiB ASCII and tests that multi-byte content < 240 KiB stores 100% byte-complete.
  const okEmoji = "\u{1F600}".repeat(45_000);
  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content: okEmoji });

  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);
  const bytes = new TextEncoder().encode(last.content).byteLength;
  assertEquals(bytes, 180_000, "180,000 UTF-8 bytes stored byte-complete");
  assertEquals(last.content.length, 90_000, "90,000 UTF-16 units intact");
  assert(!last.content.includes("truncated"), "no truncation marker for below-cap multibyte payload");

  // Check that serialized thread fits under MAX_THREAD_BYTES
  const serialized = new TextEncoder().encode(JSON.stringify(stored.messages)).byteLength;
  assert(serialized <= MAX_THREAD_BYTES, `thread messages must stay under MAX_THREAD_BYTES (${serialized} <= ${MAX_THREAD_BYTES})`);
});

Deno.test("znx9: surrogate-safe code-point slicing never splits surrogate pair at the 240 KiB boundary", async () => {
  // r3 falsification (gpt-5.6-sol): the OLD prefix (240*1024-100) left ~24-26
  // bytes of budget after the ASCII fill — six whole 4-byte emoji fit and the
  // seventh needs 4 more bytes than remain, so the naive cut ALWAYS lands on a
  // code-point boundary and the surrogate backoff is never exercised: removing
  // it changed nothing and the test stayed green. To make the cut land BETWEEN
  // a high and low surrogate, the marker's encoded length must be reserved and
  // the ASCII fill must leave EXACTLY 3 spare bytes after k whole emoji: a
  // lone high surrogate then measures 3 bytes (encoded as U+FFFD) and fits,
  // while completing the pair needs a 4th byte and does not — the naive cut
  // lands inside the pair and only the backoff saves it.
  const marker = `\n\n…(response truncated to ${(MAX_MESSAGE_BYTES / 1024).toFixed(0)} KiB — the complete text is in the run log)`;
  const budget = MAX_MESSAGE_BYTES - new TextEncoder().encode(marker).byteLength;
  const wholeEmoji = 6; // k whole emoji before the straddling one
  const prefixLen = budget - 3 - wholeEmoji * 4; // EXACTLY 3 spare bytes after k emoji
  const fill = "a".repeat(prefixLen);
  const emoji = "\u{1F600}";
  // Enough emoji that total bytes EXCEED MAX_MESSAGE_BYTES (else boundText
  // returns content untouched, no cut, no marker): 40 * 4 = 160 bytes over the
  // fill puts the content past the cap while the (k+1)th emoji still straddles.
  const emojiStraddle = emoji.repeat(40);
  const content = fill + emojiStraddle;

  const thread = await createThread("seed");
  await appendThreadMessage(thread.id, { role: "assistant", content });

  const stored = await getThread(thread.id);
  const last = stored.messages.at(-1);

  // The cut boundary is the content IMMEDIATELY BEFORE the appended marker
  // (inspecting the final char of the complete marked string always sees the
  // marker's ')' and can never fail).
  const cutEnd = last.content.slice(0, last.content.length - marker.length);
  const boundary = cutEnd.charCodeAt(cutEnd.length - 1);
  // 1. With the backoff, the cut backs off to the pair boundary: the stored
  //    slice ends on the LOW surrogate of a WHOLE emoji (0xDE00), never on a
  //    lone high surrogate (0xD800..0xDBFF) — the backoff must have removed it.
  assertEquals(boundary, 0xDE00,
    `cut must end on a whole emoji's low surrogate (got 0x${boundary.toString(16)}) — the surrogate backoff must keep pairs whole`);
  assert(!(boundary >= 0xD800 && boundary <= 0xDBFF),
    `slice left lone high surrogate (0x${boundary.toString(16)})`);

  // 2. Decoding the re-encoded slice must produce zero Unicode replacement characters (\uFFFD)
  const reDecoded = new TextDecoder().decode(new TextEncoder().encode(last.content));
  assert(!reDecoded.includes("\uFFFD"), "no replacement character from split surrogate pairs");

  // 3. Dynamic truncation marker states the actual cap
  assert(last.content.includes("truncated to 240 KiB"), "truncation marker specifies 240 KiB cap");
  assert(last.content.includes("complete text is in the run log"), "points to run log");
});

// ── 2. Outbox escape-aware sizing and backstop shrink ──

Deno.test("znx9: control-character flood triggers escape-aware sizing to keep outbox under 256 KiB", async () => {
  const mockStore = new MockMemoryStore();
  const captured = {};
  const origSetTrusted = mockStore.setTrusted.bind(mockStore);
  mockStore.setTrusted = async (key, val) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(val);
    return origSetTrusted(key, val);
  };

  const { registry } = makeHarness(mockStore);
  const executionId = "exec_ctrl_escape";
  await registry.start({
    executionId,
    clientCorrelationId: "page-ctrl-1",
    threadId: "thread-ctrl",
    kind: "task",
    taskPreview: "Control Char Task",
    journalTarget: "master",
    resumeRequest: {
      id: "task-ctrl",
      task: "Control Char Task",
      memoryOrigin: "master",
      providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true },
      idempotencyKey: executionId,
    },
  });

  // 45,000 \u0001 control chars: 45 KB raw UTF-8, but expands 6x in JSON (\u0001 -> 6 bytes = 270 KB!).
  // Escape-aware budget calculation must scale down the budget to keep the serialized outbox under 256 KiB.
  const ctrlFlood = "\u0001".repeat(45_000);
  await registry.settle(executionId, {
    ok: true,
    result: ctrlFlood,
    summary: "done",
    logicalId: "task-ctrl",
  });

  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox record created");

  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized <= 256 * 1024, `control-char outbox must fit in 256 KiB, got ${serialized} bytes`);

  // r3 falsification (gpt-5.6-sol): the serialized-fit assertion alone cannot
  // fail when escape-aware primary sizing is removed — the backstop shrink
  // (durable-runs.js ~1928-1945) shrinks content until the serialized size
  // fits again, masking the regression. The PRIMARY escape-aware cut must be
  // what truncated this flood: the stored content must carry the PRIMARY
  // "truncated to 240 KiB" marker. Without {escaped:true} the raw 45 KB flood
  // fits the raw 240 KiB budget untouched, only the backstop shrinks it, and
  // the backstop's marker reports a SMALLER dynamic cap — so this assertion
  // goes RED when escape-aware primary sizing is removed.
  const storedContent = outbox.threadTerminal?.content ?? "";
  assert(storedContent.includes("truncated to 240 KiB"),
    "escape-aware primary sizing must produce the PRIMARY 240 KiB marker (the backstop must not be the shrinker)");
});

Deno.test("znx9: backstop shrink shrinks content and reports the reduced cap in dynamic marker when envelope is large", async () => {
  const mockStore = new MockMemoryStore();
  const captured = {};
  const origSetTrusted = mockStore.setTrusted.bind(mockStore);
  mockStore.setTrusted = async (key, val) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(val);
    return origSetTrusted(key, val);
  };

  const { registry } = makeHarness(mockStore);
  const executionId = "exec_backstop_shrink";
  await registry.start({
    executionId,
    clientCorrelationId: "page-shrink-1",
    threadId: "thread-shrink",
    kind: "task",
    taskPreview: "Backstop Shrink Task",
    journalTarget: "master",
    resumeRequest: {
      id: "task-shrink",
      task: "Backstop Shrink Task",
      memoryOrigin: "master",
      providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true },
      idempotencyKey: executionId,
    },
  });

  // Large envelope with 400 skill items (~25 KiB of envelope metadata) + 240 KiB result payload
  const largeSkills = Array.from({ length: 400 }, (_, i) => `skill_namespace_identifier_module_${i}`);
  const largePayload = "Data payload block for testing backstop shrink. ".repeat(6000); // ~280 KiB

  await registry.settle(executionId, {
    ok: true,
    result: largePayload,
    summary: "done",
    logicalId: "task-shrink",
    skills: largeSkills,
  });

  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox record created");

  // 1. Serialized outbox must strictly fit under the 256 KiB store bound
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024, `outbox must fit in 256 KiB after backstop shrink (${serialized} bytes)`);

  // 2. The dynamic marker in content must state the REDUCED cap (< 240 KiB)
  const storedContent = outbox.threadTerminal?.content ?? "";
  const markerMatch = storedContent.match(/truncated to (\d+)\s*KiB/);
  assert(markerMatch, `marker must be present in content: ${storedContent.slice(-120)}`);
  const reportedCap = Number(markerMatch[1]);
  assert(reportedCap < 240, `marker must report reduced cap (< 240 KiB), got ${reportedCap} KiB`);

  // 3. Envelope data (skills array) remains intact
  assertEquals(outbox.threadTerminal?.skills?.length, 400, "skills envelope preserved");
});

// ── 3. Comprehensive Redaction Coverage ──

Deno.test("znx9: secret token is redacted before outbox, retained payload, journal, and thread storage", async () => {
  const mockStore = new MockMemoryStore();
  const capturedOutbox = {};
  const origSetTrusted = mockStore.setTrusted.bind(mockStore);
  mockStore.setTrusted = async (key, val) => {
    if (String(key).startsWith("run-outbox:")) capturedOutbox[key] = structuredClone(val);
    return origSetTrusted(key, val);
  };

  const { registry, journal, thread } = makeHarness(mockStore);
  const executionId = "exec_redact_complete";
  await registry.start({
    executionId,
    clientCorrelationId: "page-redact-all",
    threadId: "thread-redact-all",
    kind: "task",
    taskPreview: "Secret Processing Task",
    journalTarget: "master",
    resumeRequest: {
      id: "task-redact",
      task: "Secret Processing Task",
      memoryOrigin: "master",
      providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true },
      idempotencyKey: executionId,
    },
  });

  const rawSecret = "sk-r2secrettokentest9876543210";
  const secretEcho = `apiKey=${rawSecret}`;
  const resultText = `The endpoint response returned: ${secretEcho} in the output.`;

  await registry.settle(executionId, {
    ok: true,
    result: resultText,
    summary: "done",
    logicalId: "task-redact",
  });

  // A. Outbox verification
  const outbox = capturedOutbox[`run-outbox:${executionId}`];
  assert(outbox, "outbox was written");
  const outboxJson = JSON.stringify(outbox);
  assert(!outboxJson.includes(rawSecret), "secret must be absent from outbox JSON");
  assert(outboxJson.includes("[REDACTED]"), "outbox JSON must carry [REDACTED]");

  // B. Retained payload chunks verification
  const payloadKeys = (await mockStore.keys()).filter((k) => String(k).startsWith(`run-payload:${executionId}:terminal:`));
  assert(payloadKeys.length >= 1, "retained payload chunk exists");
  const payloadJson = JSON.stringify(await Promise.all(payloadKeys.map((k) => mockStore.get(k))));
  assert(!payloadJson.includes(rawSecret), "secret must be absent from retained payload chunks");
  assert(payloadJson.includes("[REDACTED]"), "retained payload must carry [REDACTED]");

  // C. Journal verification
  const journalJson = JSON.stringify(journal);
  assert(!journalJson.includes(rawSecret), "secret must be absent from journal");
  assert(journalJson.includes("[REDACTED]"), "journal must carry [REDACTED]");

  // D. Thread terminal verification
  const threadJson = JSON.stringify(thread);
  assert(!threadJson.includes(rawSecret), "secret must be absent from thread terminal");
  assert(threadJson.includes("[REDACTED]"), "thread terminal must carry [REDACTED]");
});

// ── 4. Real <message-bubble> execution, 4000/4001 boundary, and Copy fidelity ──

Deno.test("znx9: real <message-bubble> executes collapsing at 4000/4001 boundary and Copy copies full content", async () => {
  // Load components module
  await import("../extension/shared/components.js");

  let clipboardCopied = null;
  globalThis.navigator = globalThis.navigator || {};
  globalThis.navigator.clipboard = {
    async writeText(text) {
      clipboardCopied = text;
    },
  };

  const MB = customElements.get("message-bubble");
  assert(MB, "message-bubble custom element is registered");

  // 1. Exact 4000 chars -> NOT collapsed (no full-response expander)
  const content4000 = "x".repeat(4000);
  const bubble4000 = new MB();
  bubble4000.setAttribute("role", "agent");
  bubble4000.setAttribute("content", content4000);
  assertEquals(bubble4000._longResponse(content4000), false, "4000 chars is within preview limit (not long)");

  // 2. 4001 chars -> COLLAPSED (flags long-response expander)
  const content4001 = "y".repeat(4001);
  const bubble4001 = new MB();
  bubble4001.setAttribute("role", "agent");
  bubble4001.setAttribute("content", content4001);
  assertEquals(bubble4001._longResponse(content4001), true, "4001 chars activates long-response expander");

  // 3. Test Toggle and Copy helpers on message bubble
  let toggleHandler = null;
  let copyHandler = null;
  const fakeToggle = {
    addEventListener(evt, handler) {
      if (evt === "click") toggleHandler = handler;
    },
    textContent: "Show full response",
  };
  const fakeBtn = {
    addEventListener(evt, handler) {
      if (evt === "click") copyHandler = handler;
    },
    textContent: "Copy full response",
  };
  const fakeContainer = {
    _attrs: { "data-open": "0" },
    getAttribute(name) { return this._attrs[name] ?? null; },
    setAttribute(name, val) { this._attrs[name] = String(val); },
    querySelector(sel) {
      if (sel === ".long-copy") return fakeBtn;
      if (sel === ".long-toggle") return fakeToggle;
      return null;
    },
  };

  // Wire long response container on bubble4001
  bubble4001._wireLongResponse(fakeContainer);
  assert(toggleHandler, "toggle click handler was registered");
  assert(copyHandler, "copy click handler was registered");

  // A. Test toggle expands and updates label
  assertEquals(fakeContainer.getAttribute("data-open"), "0", "initial state is collapsed");
  toggleHandler();
  assertEquals(fakeContainer.getAttribute("data-open"), "1", "data-open becomes 1 on toggle");
  assertEquals(fakeToggle.textContent, "Show less", "toggle label updates to Show less");

  toggleHandler();
  assertEquals(fakeContainer.getAttribute("data-open"), "0", "data-open returns to 0 on second toggle");
  assertEquals(fakeToggle.textContent, "Show full response", "toggle label updates to Show full response");

  // B. Test copy writes complete stored content attribute
  await copyHandler();
  assertEquals(clipboardCopied, content4001, "Copy must copy the exact complete stored content attribute");
  assertEquals(clipboardCopied.length, 4001);
});
