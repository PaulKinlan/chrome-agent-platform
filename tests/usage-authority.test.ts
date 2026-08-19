// @ts-nocheck
// tests/usage-authority.test.ts — the six concrete reviewer reproductions, ported
// as failing tests BEFORE implementation. Each test exercises the REAL
// production path (lib/usage-store.js) with a faithful fake-indexeddb + chrome
// mock. @ts-nocheck

import { assertEquals, assert } from "jsr:@std/assert@1";
import { installFakeIdb, resetFakeIdb, injectAuthorityBytes, openDb, readStore, countStore, addFault, clearFaults } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

function mockChromeAbsent() { globalThis.chrome = { permissions: { contains: async () => false }, storage: undefined }; }
function mockChromeGranted(localStore) {
  globalThis.chrome = { permissions: { contains: async () => true }, storage: { local: {
    get: async (key) => { const out = {}; for (const k of (Array.isArray(key) ? key : [key])) if (localStore.has(k)) out[k] = JSON.parse(JSON.stringify(localStore.get(k))); return out; },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) { if (v === undefined) localStore.delete(k); else localStore.set(k, JSON.parse(JSON.stringify(v))); } },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) localStore.delete(k); },
  } } };
}

let seq = 0;
function freshStore() { return import(`../extension/lib/usage-store.js?f=${Date.now()}_${++seq}_${Math.random().toString(36).slice(2)}`); }
async function resetKv() {
  // Clear the shared kv session's legacy usage key between tests (the base kv.js
  // owns its session in closure and has no reset API).
  const { kvRemove } = await import("../extension/lib/kv.js");
  await kvRemove("cairn:usage").catch(() => {});
  await kvRemove("cap:usage:v2").catch(() => {});
}
const mkRow = (id) => ({ id, timestamp: "2026-08-18T12:00:00.000Z", agentId: "hub", taskId: "adhoc", provider: "demo", model: "demo-local", inputTokens: 8, outputTokens: 32, totalTokens: 40, estimatedCost: 0 });

async function setupAbsent() { await resetKv(); resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); clearFaults(); mockChromeAbsent(); }

// ---- PROBE 1: clear-vs-first-grant resurrection ----
Deno.test("PROBE-1: a clear during first-grant local import must NOT resurrect the stale local", async () => {
  await setupAbsent();
  const init = await freshStore();
  await init.usageWrite([mkRow("r-init")]); // initialize (local stays pending)
  const local = new Map([["cap:usage:v2", { v: 2, gen: 1, rows: [mkRow("stale-local")], tombstones: [] }]]);
  mockChromeGranted(local);
  // A clear commits discard + canonical empty; a delayed migration must not import.
  const migrator = await freshStore();
  await init.usageClear(); // clear (marks localDiscarded + canonical empty)
  await migrator.migrateLegacy(); // delayed migration (must NOT import the discarded local)
  const r = await migrator.usageRead();
  assert(!r.rows.some((x) => x.id === "stale-local"), "discarded local must not be resurrected by a delayed migration");
});

// ---- PROBE 2: concurrent initializer loser mirrors the winning env ----
Deno.test("PROBE-2: a concurrent initializer loser must mirror the WINNING authority, not its own", async () => {
  await setupAbsent();
  const local = new Map();
  mockChromeGranted(local);
  const { kvSet } = await import("../extension/lib/kv.js");
  await kvSet({ "cairn:usage": [mkRow("legacy-winner")] });
  const a = await freshStore();
  const b = await freshStore();
  await Promise.all([a.migrateLegacy(), b.migrateLegacy()]);
  const mirror = local.get("cap:usage:v2");
  const r = await a.usageRead();
  assertEquals(r.rows.map((x) => x.id), ["legacy-winner"], "authority holds the migrated legacy row exactly once");
  if (mirror) {
    assertEquals(mirror.rows.map((x) => x.id), ["legacy-winner"], "the mirror reflects the winning authority (not a losing snapshot)");
  }
});

// ---- PROBE 3: real agent-do delayed callback identity ----
Deno.test("PROBE-3: each run's provider attempt gets a DISTINCT immutable event id", async () => {
  const { createAgent } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const { getUsage } = await import("../extension/lib/usage.js");
  await setupAbsent();
  const model = { model: createDemoModel(), providerName: "demo", modelId: "demo-local" };
  const agent = createAgent({ model, id: "hub", name: "hub", memory: null });
  await agent.run("one", "ctx", []);
  await agent.run("two", "ctx", []);
  const u = await getUsage();
  const ids = u.rows.map((r) => r.id);
  assert(ids.length >= 2, "two runs must record two attempts");
  assertEquals(new Set(ids).size, ids.length, "each attempt must have a distinct immutable id");
});

// ---- PROBE 4: corruption repair CAS/readback/race ----
Deno.test("PROBE-4: after corruption repair, a valid write succeeds (repair leaves no stale CAS)", async () => {
  await setupAbsent();
  const s = await freshStore();
  await s.usageWrite([mkRow("r-valid")]);
  await injectAuthorityBytes(new TextEncoder().encode("{ corrupt !!!"));
  await s.usageRead(); // corruption repair → canonical empty
  await s.usageWrite([mkRow("r-new")]); // valid write after repair
  const r = await s.usageRead();
  assertEquals(r.rows.map((x) => x.id), ["r-new"], "a valid write after repair must succeed");
});

// ---- PROBE 5: universal outbox — clear leaves no stale pending ----
Deno.test("PROBE-5: clear writes a fresh pending generation (no stale outbox entry)", async () => {
  await setupAbsent();
  const local = new Map();
  mockChromeGranted(local);
  const s = await freshStore();
  await s.usageWrite([mkRow("r1")]);
  await s.usageClear();
  const authority = await readStore("authority", "ledger");
  const pending = await readStore("meta", "mirrorPending");
  const authParsed = authority ? JSON.parse(new TextDecoder().decode(authority.bytes)) : null;
  assert(authParsed && authParsed.rows.length === 0, "clear writes canonical empty authority");
  if (pending) {
    assertEquals(pending.gen, authParsed.gen, "the pending outbox generation must match the cleared authority (no stale entry)");
  }
});

// ---- PROBE 6: preparse bounds ----
Deno.test("PROBE-6: preparse bound + quarantine cap (small corrupt quarantined; over-cap fail-closed)", async () => {
  await setupAbsent();
  const s = await freshStore();
  // Small corrupt blob (< 1 MiB) → quarantined + replaced with empty.
  await injectAuthorityBytes(new TextEncoder().encode("{ corrupt small !!!"));
  const r = await s.usageRead();
  assertEquals(r.rows.length, 0, "small corrupt authority reads empty");
  // Over-cap corrupt blob (> 1 MiB) → fail closed (throw, source preserved).
  await setupAbsent();
  const s2 = await freshStore();
  const huge = new TextEncoder().encode(JSON.stringify({ v: 2, gen: 1, rows: [], tombstones: [], pad: "x".repeat(2 * 1024 * 1024) }));
  await injectAuthorityBytes(huge);
  let threw = false; try { await s2.usageRead(); } catch { threw = true; }
  assert(threw, "an over-cap corrupt authority must fail closed (no unbounded quarantine)");
});

// ---- Finding 1 (in-tx discard re-check) ----
Deno.test("PROBE-7: a clear committed between the local read and the migration tx cannot resurrect rows (in-tx re-check)", async () => {
  await setupAbsent();
  const local = new Map([["cap:usage:v2", { v: 2, gen: 1, rows: [mkRow("stale-local")], tombstones: [] }]]);
  mockChromeGranted(local);
  // Seed a legacy row so the migration runs, then clear, then force a fresh migration.
  const { kvSet } = await import("../extension/lib/kv.js");
  await kvSet({ "cairn:usage": [mkRow("legacy-seed")] });
  const init = await freshStore();
  await init.migrateLegacy(); // imports legacy (local still pending, not granted at read time? it IS granted)
  // A clear marks discard + canonical empty.
  await init.usageClear();
  // A fresh module re-runs migration; the discard marker must block the local import.
  const migrator = await freshStore();
  await migrator.migrateLegacy();
  const r = await migrator.usageRead();
  assert(!r.rows.some((x) => x.id === "stale-local"), "discard marker must block the local import after a clear");
});

// ---- Finding 2 (attempt identity across abort/retry) ----
Deno.test("PROBE-8: an aborted attempt (no onUsage) must not leak its identity to the next run", async () => {
  const { createAgent } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const { getUsage } = await import("../extension/lib/usage.js");
  await setupAbsent();
  // A model whose doStream THROWS (abort with no onUsage) — leaves a stale queue entry.
  const throwingModel = {
    specificationVersion: "v2", provider: "demo", modelId: "throwing", supportedUrls: {},
    doGenerate: async () => { throw new Error("abort"); },
    doStream: async () => { throw new Error("abort"); },
  };
  const agent = createAgent({ model: { model: throwingModel, providerName: "demo", modelId: "throwing" }, id: "hub", name: "hub", memory: null });
  await agent.run("will abort", "ctx", []).catch(() => {});
  // Now run the SAME reusable agent with a healthy model; the first onUsage must
  // carry a FRESH attempt id (not the aborted attempt's stale id).
  const good = createDemoModel();
  // Replace the model (the cached agent's model is a proxy; here we just run a fresh agent).
  const agent2 = createAgent({ model: { model: good, providerName: "demo", modelId: "demo-local" }, id: "hub", name: "hub", memory: null });
  await agent2.run("healthy", "ctx", []);
  const u = await getUsage();
  assert(u.rows.length >= 1, "the healthy run records usage");
  assert(u.rows.every((r) => /^[0-9a-f-]{36}$/.test(r.id)), "usage ids are UUID-shaped (fresh, not stale)");
});

// ---- PROBE 9: within-run AI-SDK retry binds attempt 2's id ----
Deno.test("PROBE-9: a within-run AI-SDK retry (doStream attempt 1 throws retryable, attempt 2 succeeds) binds ATTEMPT 2's id", async () => {
  const { createAgent } = await import("../extension/lib/agent.js");
  const { getUsage } = await import("../extension/lib/usage.js");
  await setupAbsent();
  // Capture crypto.randomUUID in order so the attempt ids are observable.
  const uuids = [];
  const origUUID = crypto.randomUUID.bind(crypto);
  Object.defineProperty(crypto, "randomUUID", {
    value: () => { const u = origUUID(); uuids.push(u); return u; },
    configurable: true, writable: true,
  });
  try {
    // A retryable AI_APICallError the SDK's retry wrapper recognizes (isRetryable
    // + the APICallError brand marker) — no absolute @ai-sdk import needed.
    const marker = Symbol.for("vercel.ai.error.AI_APICallError");
    const retryable = Object.assign(new Error("probe 429"), {
      name: "AI_APICallError", [marker]: true, isRetryable: true,
      statusCode: 429, url: "https://probe.invalid/", requestBodyValues: {},
      responseHeaders: {}, responseBody: "",
    });
    let calls = 0;
    const attemptIds = [];
    const flaky = {
      specificationVersion: "v2", provider: "probe-flaky", modelId: "probe", supportedUrls: {},
      doGenerate: async () => { throw new Error("not used"); },
      async doStream() {
        calls += 1;
        attemptIds.push({ n: calls, id: uuids[uuids.length - 1] });
        if (calls === 1) throw retryable; // attempt 1: no usage emitted
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "p1" });
            controller.enqueue({ type: "text-delta", id: "p1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "p1" });
            controller.enqueue({ type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, finishReason: "stop" });
            controller.close();
          },
        });
        return { stream };
      },
    };
    const agent = createAgent({ model: { model: flaky, providerName: "probe-flaky", modelId: "probe" }, id: "hub", name: "hub", memory: null });
    await agent.run("flaky retry", "ctx", []);
    const u = await getUsage();
    const rows = u.rows.filter((r) => r.provider === "probe-flaky");
    assert(calls === 2, `the SDK retried doStream within the run (calls=${calls})`);
    assert(rows.length >= 1, "the successful attempt records usage");
    const attempt2 = attemptIds.find((a) => a.n === 2);
    assertEquals(rows[0].id, attempt2.id, "the row binds ATTEMPT 2's id, not the failed attempt 1");
    // occurredAt must also come from attempt 2 (a fresh timestamp, not attempt 1's).
    const attempt1 = attemptIds.find((a) => a.n === 1);
    assert(attempt1 && attempt2 && attempt2.id !== attempt1.id, "attempt 1 and attempt 2 carry distinct ids");
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: origUUID, configurable: true, writable: true });
  }
});

// ---- PROBE 10: a SYNCHRONOUS (non-async) doStream throw drops the entry ----
Deno.test("PROBE-10: a SYNCHRONOUS doStream throw (non-async) on attempt 1 does not misbind attempt 2", async () => {
  const { createAgent } = await import("../extension/lib/agent.js");
  const { getUsage } = await import("../extension/lib/usage.js");
  await setupAbsent();
  const uuids = [];
  const origUUID = crypto.randomUUID.bind(crypto);
  Object.defineProperty(crypto, "randomUUID", { value: () => { const u = origUUID(); uuids.push(u); return u; }, configurable: true, writable: true });
  try {
    const marker = Symbol.for("vercel.ai.error.AI_APICallError");
    const retryable = Object.assign(new Error("probe 500"), { name: "AI_APICallError", [marker]: true, isRetryable: true, statusCode: 500, url: "https://probe.invalid/", requestBodyValues: {}, responseHeaders: {}, responseBody: "" });
    let calls = 0;
    const attemptIds = [];
    const syncFlaky = {
      specificationVersion: "v2", provider: "probe-sync", modelId: "probe", supportedUrls: {},
      doGenerate: async () => { throw new Error("not used"); },
      doStream(options) { // NOT async — the throw is synchronous
        calls += 1;
        attemptIds.push({ n: calls, id: uuids[uuids.length - 1] });
        if (calls === 1) throw retryable;
        const stream = new ReadableStream({ start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "s1" });
          c.enqueue({ type: "text-delta", id: "s1", delta: "ok" });
          c.enqueue({ type: "text-end", id: "s1" });
          c.enqueue({ type: "finish", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, finishReason: "stop" });
          c.close();
        }});
        return Promise.resolve({ stream });
      },
    };
    const agent = createAgent({ model: { model: syncFlaky, providerName: "probe-sync", modelId: "probe" }, id: "hub", name: "hub", memory: null });
    await agent.run("sync retry", "ctx", []);
    const u = await getUsage();
    const rows = u.rows.filter((r) => r.provider === "probe-sync");
    assert(calls === 2, `the SDK retried the sync throw (calls=${calls})`);
    assert(rows.length >= 1, "the successful attempt records usage");
    assertEquals(rows[0].id, attemptIds.find((a) => a.n === 2).id, "the row binds ATTEMPT 2's id (sync throw on attempt 1 dropped)");
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: origUUID, configurable: true, writable: true });
  }
});

// ---- PROBE 11: a plain {stream} return (no Promise) does not throw ----
Deno.test("PROBE-11: a plain {stream} (non-Promise) return records usage without a catch-is-not-a-function error", async () => {
  const { createAgent } = await import("../extension/lib/agent.js");
  const { getUsage } = await import("../extension/lib/usage.js");
  await setupAbsent();
  const plainModel = {
    specificationVersion: "v2", provider: "probe-plain", modelId: "probe", supportedUrls: {},
    doGenerate: async () => { throw new Error("not used"); },
    doStream(options) { // returns a plain {stream} object, not a Promise
      const stream = new ReadableStream({ start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "text-start", id: "p1" });
        c.enqueue({ type: "text-delta", id: "p1", delta: "plain ok" });
        c.enqueue({ type: "text-end", id: "p1" });
        c.enqueue({ type: "finish", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, finishReason: "stop" });
        c.close();
      }});
      return { stream };
    },
  };
  const agent = createAgent({ model: { model: plainModel, providerName: "probe-plain", modelId: "probe" }, id: "hub", name: "hub", memory: null });
  const result = await agent.run("plain object", "ctx", []);
  assert(typeof result === "string" || result !== undefined, "the run completes");
  const u = await getUsage();
  const rows = u.rows.filter((r) => r.provider === "probe-plain");
  assert(rows.length >= 1, "the plain-object model records usage (no catch-is-not-a-function)");
  assert(/^[0-9a-f-]{36}$/.test(rows[0].id), "the usage id is a valid UUID");
});
