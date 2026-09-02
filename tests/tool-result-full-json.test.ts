// @ts-nocheck — the agent factory, the durable registry and the projections are untyped JS.
// tests/tool-result-full-json.test.ts — CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01.
//
// The owner's P0: "I can't see the results of the tool call. It is critical we
// have a nice JSON formatted result." Every tool result was cut to 300 chars
// ONCE at the source (lib/agent.js summarizeToolResult) before the progress
// event existed, so the card, the run log and the reopened thread were all
// faithful to a stub. These tests pin the retained full payload end to end:
//   (1) the progress event carries `resultFull` (redacted, byte-bounded to
//       64 KiB with a never-silent truncation flag) beside the unchanged
//       300-char `result` summary;
//   (2) the durable run log persists it and reads it back intact after the
//       registry forgets its caches and after a worker restart (a 64 KiB row
//       spills into the retained payload store and is lifted back on read);
//   (3) the thread projection carries it to the card as `detail`;
//   (4) toolResultErrorText names the error for every failure shape.
// Falsification (recorded in TASKS.md): revert the `resultFull` emission in
// lib/agent.js → "the tool-result event carries the full bounded result" is RED.

import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import {
  toolResultErrorText,
  toolResultFullJson,
  TOOL_RESULT_FULL_MAX_BYTES,
} from "../extension/lib/tool-summary.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { createMemoryRunLogHandles } from "../extension/lib/run-log-wal-memory.js";
import { pairToolJournal, projectThreadMessages, toolRowsFromRunLog } from "../extension/shared/conversation.js";

const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;

// ── (4) the error text for every failure shape ─────────────────────────────
Deno.test("toolResultErrorText: a nested lazy-protocol error, a bare protocol error and a plain failure all name the error", () => {
  const nested = JSON.stringify({ ok: true, selectedTool: "read_page", result: { error: "Cannot access contents of the page. Extension manifest must request permission to access this host." } });
  assertEquals(toolResultErrorText(nested), "Cannot access contents of the page. Extension manifest must request permission to access this host.");
  // The live event double-wraps the envelope in {modelContent}.
  const wrapped = JSON.stringify({ modelContent: nested, authorizes: false, requiresLiveAuthorization: true });
  assertEquals(toolResultErrorText(wrapped), "Cannot access contents of the page. Extension manifest must request permission to access this host.");
  // A bare protocol error is EXPLAINED, never shown as an opaque code.
  const protocol = toolResultErrorText(JSON.stringify({ ok: false, error: "selection-replayed" }));
  assert(protocol.startsWith("selection-replayed"), `the code stays first, got: ${protocol}`);
  assert(/already been used|search_tools/.test(protocol), `the code is explained, got: ${protocol}`);
  assertEquals(toolResultErrorText({ ok: false, error: "no agent for demo-site" }), "no agent for demo-site");
  assertEquals(toolResultErrorText("Error: the tab closed"), "Error: the tab closed");
  // A success has no error text.
  assertEquals(toolResultErrorText(JSON.stringify({ ok: true, selectedTool: "memory_get", result: { key: "a", value: "b" } })), "");
  assertEquals(toolResultErrorText({ key: "a", value: "b" }), "");
});

// ── (1a) the retained full JSON: bounded, redacted, never silent ───────────
Deno.test("toolResultFullJson: a 200 KiB result is bounded to 64 KiB of VALID JSON with the truncation flag, and a credential leaf is redacted", () => {
  const big = {
    ok: true,
    apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
    items: Array.from({ length: 4000 }, (_, i) => ({ id: i, title: `Article ${i}`, body: "lorem ipsum ".repeat(4) })),
  };
  const out = toolResultFullJson(big);
  assertEquals(out.truncated, true, "a 200 KiB result must be flagged truncated");
  assert(out.bytes > TOOL_RESULT_FULL_MAX_BYTES, `the original size is reported (${out.bytes})`);
  assert(utf8(out.json) <= TOOL_RESULT_FULL_MAX_BYTES, `bounded to 64 KiB, got ${utf8(out.json)}`);
  const parsed = JSON.parse(out.json); // valid JSON — the tree can always render it
  assert(parsed && typeof parsed === "object", "the bounded copy is a JSON object");
  assert(!out.json.includes("sk-live-"), "the credential leaf must be redacted before it leaves the runtime");
  // Below the cap: byte-complete and NOT flagged.
  const small = { ok: true, selectedTool: "read_page", result: { title: "Hello", text: "x".repeat(5000) } };
  const kept = toolResultFullJson(small);
  assertEquals(kept.truncated, false);
  assertEquals(JSON.parse(kept.json).result.text.length, 5000, "a 5 KiB result is byte-complete (the old cut was 300 chars)");
});

// ── (1b) the progress event carries the full result ────────────────────────
const store = new Map();
const clone = (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
(globalThis as any).chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = clone(store.get(k));
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) { if (v === undefined) store.delete(k); else store.set(k, clone(v)); }
      },
      remove: async (keys: string | string[]) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
};
function __reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); clearRunFence(); }
function fakeMemory() {
  const m = new Map();
  return {
    async get(key: string) { return m.has(key) ? m.get(key) : undefined; },
    async has(key: string) { return m.has(key); },
    async set(key: string, value: unknown) { m.set(key, value); return value; },
    async list() { return [...m.keys()].map((key) => ({ key, value: m.get(key) })); },
    async keys() { return [...m.keys()]; },
  };
}
async function runDemo(task: string) {
  __reset();
  store.clear();
  const events: any[] = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "hub",
    name: "hub",
    memory: fakeMemory(),
    taskId: `full-${Math.random().toString(36).slice(2, 8)}`,
    onProgress: (e: any) => events.push(e),
  });
  const result = await agent.run(task);
  return { events, result };
}

Deno.test("agent progress: the tool-result event carries the full bounded result (resultFull) beside the 300-char summary", async () => {
  const { events } = await runDemo("@demo-tools list my open tabs");
  const results = events.filter((e) => e.type === "tool-result" && e.toolName === "execute_tool");
  assert(results.length >= 2, `the demo run executes memory_set + memory_get through the lazy protocol (got ${results.length})`);
  for (const ev of results) {
    assert(typeof ev.result === "string" && ev.result.length <= 301, "the list-surface summary stays bounded at 300 chars");
    assert(typeof ev.resultFull === "string" && ev.resultFull.length > 0, "the event carries resultFull");
    const parsed = JSON.parse(ev.resultFull); // the full copy is VALID JSON, never a mid-string slice
    assertEquals(parsed.ok, true);
    assert(typeof parsed.selectedTool === "string", "the lazy envelope is intact in the full copy");
    assertEquals(ev.resultFullTruncated, false, "a small result is never flagged truncated");
  }
  // The lazy envelope is longer than the 300-char summary — the full copy is
  // what the card needs; the summary is the stub the owner saw.
  const get = results[results.length - 1];
  assert(get.resultFull.length > get.result.length, `resultFull (${get.resultFull.length}) exceeds the summary (${get.result.length})`);
  assert(get.resultFull.includes("Espresso machine"), "the memory_get value the model saw is in the full copy");
});

// ── (2) the durable run log retains the full copy ──────────────────────────
class FakeStore {
  values = new Map();
  versions = new Map();
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
  async compareAndRestore(key, expected, value) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    await this.setTrusted(key, value);
    return true;
  }
  async compareAndDelete(key, expected) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    this.values.delete(key);
    this.versions.set(key, expected + 1);
    return true;
  }
  async delete(key) {
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}
function harness(store, { bootId = "boot-a" } = {}) {
  const journal = [];
  const thread = [];
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId,
    now: (() => { let n = 1_000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal }),
    appendJournal: async (target, entry) => { target.journal.push(structuredClone(entry)); },
    replaceCancellationJournal: async () => {},
    commitThread: async (threadId, executionId, terminal) => { thread.push({ threadId, executionId, ...structuredClone(terminal) }); },
    replaceCancellationThread: async () => {},
    injectFailure: async () => {},
  });
  return { registry, journal, thread };
}
const executionId = "exec_full_result_0001";
async function begin(registry) {
  await registry.start({
    executionId,
    clientCorrelationId: "page-run-1",
    threadId: "thread-1",
    kind: "task",
    taskPreview: "read every tab",
    journalTarget: "master",
    resumeRequest: { id: "task-1", task: "read every tab", memoryOrigin: "master", providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true }, idempotencyKey: executionId },
  });
}

Deno.test("durable runs: a 64 KiB tool-result row reads back intact (resultFull + identity) after forgetCachedState and after a worker restart", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  const full = JSON.stringify({ ok: true, selectedTool: "read_page", result: { text: "t".repeat(TOOL_RESULT_FULL_MAX_BYTES - 200) } });
  assert(utf8(full) > 60 * 1024 && utf8(full) <= TOOL_RESULT_FULL_MAX_BYTES, "the fixture is a near-cap 64 KiB row");
  const row = { type: "tool-result", id: "task-1", executionId, run: "r1", callId: "c1", tool: "execute_tool", selectedTool: "read_page", result: "{\"ok\":true,\"selectedTool\":\"read_page\",\"result\":{\"text\":\"ttt…\"}}", resultFull: full, resultFullTruncated: false, ok: true };
  await first.registry.appendLog(executionId, row, "tool-result:c1");
  const readBack = (rows) => rows.find((r) => r.idempotencyKey === "tool-result:c1");
  const live = readBack(await first.registry.listLogs(executionId));
  assertEquals(live.resultFull, full, "the full copy is on the row as read");
  assertEquals(live.callId, "c1", "the row identity survives the payload spill");
  assertEquals(live.tool, "execute_tool");
  assertEquals(live.ok, true);
  first.registry.forgetCachedState();
  const cold = readBack(await first.registry.listLogs(executionId));
  assertEquals(cold.resultFull, full, "readable after the registry forgets its caches");
  const restarted = harness(store, { bootId: "boot-b" });
  await restarted.registry.recover();
  const afterRestart = readBack(await restarted.registry.listLogs(executionId));
  assertEquals(afterRestart.resultFull, full, "readable after a worker restart");
  assertEquals(afterRestart.callId, "c1");
});

// ── (3) the thread projection carries the full copy to the card ────────────
Deno.test("thread projection: the derived tool row carries resultFull as the card's detail, and a truncated row carries the never-silent note", () => {
  const full = JSON.stringify({ ok: true, selectedTool: "read_page", result: { title: "Hello", text: "y".repeat(2000), tail: "TAIL-MARKER-END" } });
  const logs = [
    { type: "tool-call", callId: "c1", run: "r1", tool: "execute_tool", args: JSON.stringify({ selectionRef: "sel_1", arguments: { url: "https://example.com" } }), at: 1 },
    { type: "tool-result", callId: "c1", run: "r1", tool: "execute_tool", selectedTool: "read_page", result: full.slice(0, 300) + "…", resultFull: full, resultFullTruncated: false, ok: true, at: 2 },
    { type: "tool-call", callId: "c2", run: "r1", tool: "execute_tool", args: JSON.stringify({ selectionRef: "sel_2", arguments: { url: "https://example.org" } }), at: 3 },
    { type: "tool-result", callId: "c2", run: "r1", tool: "execute_tool", selectedTool: "read_page", result: "{\"ok\":true}", resultFull: "{\"ok\":true,\"bounded\":true}", resultFullTruncated: true, resultFullBytes: 300 * 1024, ok: true, at: 4 },
  ];
  const paired = pairToolJournal(logs);
  assertEquals(paired[0].resultFull, full, "pairToolJournal keeps the full copy");
  const rows = toolRowsFromRunLog("exec-1", logs).filter((r) => r.role === "tool");
  assertEquals(rows.length, 2);
  assertEquals(rows[0].toolDetail, full, "the derived thread row carries the full copy as toolDetail");
  assert(rows[0].toolDetail.includes("TAIL-MARKER-END"));
  assert(typeof rows[1].toolDetailNote === "string" && /truncated/i.test(rows[1].toolDetailNote) && /64 KiB/.test(rows[1].toolDetailNote) && /300 KiB/.test(rows[1].toolDetailNote),
    `a truncated row says so, with both sizes: ${rows[1].toolDetailNote}`);
  const cards = projectThreadMessages({ messages: [{ role: "user", content: "read", ts: 0, executionId: "exec-1" }, ...rows, { role: "assistant", content: "done", ts: 5, executionId: "exec-1" }] })
    .filter((m) => m.role === "tool");
  assertEquals(cards.length, 2);
  assertEquals(cards[0].detail, full, "the projected card gets the full copy as detail");
  assertEquals(cards[0].name, "read_page");
  assert(/truncated/i.test(cards[1].detailNote ?? ""), "the projected card carries the truncation note");
});
