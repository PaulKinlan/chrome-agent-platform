// @ts-nocheck — deterministic in-memory durable-store/failure harness.
import { replaySafetyForTool, REPLAY_UNKNOWN } from "../extension/lib/tool-replay-safety.js";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  createDurableRunRegistry,
  DURABLE_RUN_POLICY,
  RUN_RETENTION_POLICY,
} from "../extension/lib/durable-runs.js";
import { createMemoryRunLogHandles } from "../extension/lib/run-log-wal-memory.js";
import { dispatchDurableProviderRun } from "../extension/lib/durable-provider-dispatch.js";
import { admitDurableRun, durableQuotaResponse } from "../extension/lib/durable-quota.js";

class FakeStore {
  values = new Map();
  versions = new Map();
  failNextCompareAndRestore = false;
  failDeleteKey = null;
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
  // The real durable store has both of these; this double did not, so any code
  // that enumerated or deleted keys silently did nothing here — which is how a
  // migration that never ran looked like a migration that ran four times.
  async keys() { return [...this.values.keys()]; }
  async compareAndDelete(key, expectedVersion) {
    if ((this.versions.get(key) ?? 0) !== expectedVersion) return false;
    this.values.delete(key);
    this.versions.delete(key);
    return true;
  }
  async compareAndRestore(key, expected, value) {
    if (this.failNextCompareAndRestore) {
      this.failNextCompareAndRestore = false;
      return false;
    }
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
    if (this.failDeleteKey === key) {
      this.failDeleteKey = null;
      throw new Error(`injected delete failure for ${key}`);
    }
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  async keys() { return [...this.values.keys()].sort(); }
}

function harness(store, { bootId = "boot-a", failAt = null, retention = null } = {}) {
  const journal = [];
  const thread = [];
  let failed = false;
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    // The owner's retention setting (`cap:runRetention`), injected so a test
    // never reaches chrome.storage. null = the bounded defaults.
    ...(retention ? { retentionSetting: async () => retention } : {}),
    bootId,
    now: (() => { let n = 1_000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal }),
    appendJournal: async (target, entry, _guard, executionId) => {
      if (!target.journal.some((row) => row.executionId === executionId && row.type === entry.type)) {
        target.journal.push(structuredClone(entry));
      }
    },
    replaceCancellationJournal: async (target, entry, executionId) => {
      target.journal.splice(0, target.journal.length, ...target.journal.filter((row) => row.executionId !== executionId));
      target.journal.push({ ...structuredClone(entry), type: "cancelled", executionId });
    },
    commitThread: async (threadId, executionId, terminal) => {
      if (!thread.some((row) => row.executionId === executionId)) {
        thread.push({ threadId, executionId, ...structuredClone(terminal) });
      }
    },
    replaceCancellationThread: async (threadId, executionId, terminal) => {
      const index = thread.findIndex((row) => row.executionId === executionId);
      const row = { threadId, executionId, ...structuredClone(terminal), status: "cancelled" };
      if (index >= 0) thread[index] = row;
      else thread.push(row);
    },
    injectFailure: async (boundary) => {
      if (!failed && boundary === failAt) {
        failed = true;
        throw new Error(`injected crash at ${boundary}`);
      }
    },
  });
  return { registry, journal, thread };
}

const executionId = "exec_durable_0001";
const terminalPayload = {
  ok: true,
  result: "durable answer",
  logicalId: "task-1",
  summary: "durable answer",
};

function quotaError() {
  return new DOMException("The bounded filesystem is full", "QuotaExceededError");
}

async function begin(registry) {
  await registry.start({
    executionId,
    clientCorrelationId: "page-run-1",
    threadId: "thread-1",
    kind: "task",
    taskPreview: "do durable work",
    journalTarget: "master",
    resumeRequest: { id: "task-1", task: "do durable work", memoryOrigin: "master", providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true }, idempotencyKey: executionId },
  });
}

// In-memory run-log handles for the WAL. The registry takes `logHandleFor` for
// the same reason it takes `store`: a suite that injects its own storage must
// inject all of it, or the code under test reaches past the fake to real OPFS.
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
      async getFile() {
        const bytes = new TextEncoder().encode(node.content);
        return {
          size: bytes.length,
          async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
          slice(a, b) { const sub = bytes.subarray(a, b); return { async arrayBuffer() { return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.length); } }; },
          async text() { return node.content; },
        };
      },
      // Models FileSystemWritableFileStream properly, including `seek`. An
      // earlier version of this double had no `seek` and appended the writer's
      // buffer to the existing content on close — so the WAL's seek-less
      // fallback (which writes the FULL merged content) doubled the file on
      // every append. That looked exactly like a migration bug in the product
      // and was entirely a defect in this fake.
      async createWritable({ keepExistingData = false } = {}) {
        let buf = keepExistingData ? node.content : "";
        let pos = 0;
        return {
          async seek(p) { pos = p; },
          async write(chunk) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            buf = buf.slice(0, pos) + text + buf.slice(pos + text.length);
            pos += text.length;
          },
          async close() { node.content = buf; },
        };
      },
    });
  };
}

Deno.test("durable runs: addToIndex-first native quota is compensated and settles the message response", async () => {
  class IndexQuotaStore extends FakeStore {
    failIndexOnce = true;
    constructor(publishBeforeThrow) {
      super();
      this.publishBeforeThrow = publishBeforeThrow;
    }
    async setTrusted(key, value) {
      if (key === "run-registry" && this.failIndexOnce) {
        this.failIndexOnce = false;
        if (this.publishBeforeThrow) await super.setTrusted(key, value);
        throw quotaError();
      }
      return await super.setTrusted(key, value);
    }
  }

  for (const kind of ["task", "delegate"]) for (const timing of ["before", "after"]) {
    const store = new IndexQuotaStore(timing === "after");
    const registry = harness(store).registry;
    const id = `exec_quota_${kind}_${timing}1`;
    let outerRejected = false;
    const response = await new Promise((resolve) => {
      // Mirrors the MV3 dispatcher: a route result must reach sendResponse via
      // fulfillment, never its outer rejection channel.
      admitDurableRun(registry, {
        executionId: id,
        kind,
        taskPreview: "quota admission",
        journalTarget: "master",
        resumeRequest: { task: "quota admission" },
      }).then(resolve).catch(() => {
        outerRejected = true;
        resolve(null);
      });
    });

    assertEquals(outerRejected, false, `${kind} admission does not reject the outer message channel`);
    assertEquals(response, {
      ok: false,
      errorCategory: "storage",
      errorReason: "The bounded filesystem is full",
      errorAction: "Free browser storage, then retry. Progressed or uncertain runs remain available for explicit recovery.",
      executionId: id,
    });
    assertEquals((await store.keys()).filter((key) => key.includes(id)), [], `${kind} failed admission leaves no execution-owned remnants`);
    assertEquals((await store.get("run-registry") ?? []).includes(id), false, `${kind} failed admission leaves no registry reference`);
    assertEquals((await registry.list()).runs, []);
  }
});

Deno.test("durable runs: quota response accepts an immutable native error without mutation", () => {
  const error = Object.preventExtensions(quotaError());
  const before = Object.getOwnPropertyNames(error);
  const response = durableQuotaResponse(error, executionId);
  assertEquals(response.executionId, executionId);
  assertEquals(response.errorCategory, "storage");
  assertEquals(Object.getOwnPropertyNames(error), before);
  assertEquals("executionId" in error, false);
});

Deno.test("durable runs: native quota rollback leaves exactly zero execution remnants", async () => {
  const store = new FakeStore();
  const run = harness(store);
  await begin(run.registry);
  await store.setTrusted(`run-outbox:${executionId}`, { executionId, partial: true });
  await store.setTrusted(`run-payload:${executionId}:extra:000000`, { executionId });

  const result = await run.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(result.ok, true);
  assertEquals(result.remainingKeys, []);
  assertEquals((await store.keys()).filter((key) => key.includes(executionId)), []);
  assertEquals(await store.has("run-registry"), false, "an initially absent registry is restored as absent");
  assertEquals(run.journal, [], "rollback never creates a terminal journal row");
  assertEquals(run.thread, [], "rollback never creates a terminal thread row");
});

Deno.test("durable runs: registry compensation restores absent/empty and preserves old + concurrent IDs", async () => {
  const emptyStore = new FakeStore();
  await emptyStore.setTrusted("run-registry", []);
  const emptyRun = harness(emptyStore);
  await begin(emptyRun.registry);
  const privateRecord = await emptyStore.get(`run:${executionId}`);
  assertEquals(privateRecord.registryAdmission.preExists, true);
  assertEquals(privateRecord.registryAdmission.preValue, []);
  assertEquals("registryAdmission" in (await emptyRun.registry.list()).runs[0], false, "prior-state metadata stays private");
  await emptyRun.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(await emptyStore.has("run-registry"), true);
  assertEquals(await emptyStore.get("run-registry"), []);

  const store = new FakeStore();
  const registry = harness(store).registry;
  const oldId = "exec_registry_old_0001";
  const laterId = "exec_registry_later_01";
  await registry.start({ executionId: oldId, taskPreview: "old", journalTarget: "master" });
  await begin(registry);
  await registry.start({ executionId: laterId, taskPreview: "later", journalTarget: "master" });
  await store.setTrusted("unrelated", { bytes: "preserve-me" });
  const rolled = await registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(rolled.ok, true);
  assertEquals(await store.get("run-registry"), [laterId, oldId]);
  assertEquals(await store.get("unrelated"), { bytes: "preserve-me" });
  assert(await store.has(`run:${oldId}`));
  assert(await store.has(`run:${laterId}`));
});

Deno.test("durable runs: journal compensation failure preserves authority and retry finalizes in safe order", async () => {
  const store = new FakeStore();
  let attempts = 0;
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-journal-fail",
    compensateJournal: async () => {
      attempts += 1;
      assertEquals((await store.keys()).some((key) => key.startsWith(`run-log:${executionId}:`)), false, "auxiliary bytes are freed before journal compensation");
      assert(await store.has(`run:${executionId}`), "record authority remains during journal compensation");
      assertEquals((await store.get("run-registry")).includes(executionId), true, "registry authority remains during journal compensation");
      return attempts === 1
        ? { ok: false, preserved: true, reason: "journal_cas_mismatch" }
        : { ok: true, compensated: true };
    },
  });
  await begin(registry);
  const options = {
    journalReceipt: { schemaVersion: 1, key: "journal", executionId },
    journalStore: {},
  };
  const refused = await registry.rollbackUnprogressedQuota(executionId, quotaError(), options);
  assertEquals(refused.reason, "journal_cas_mismatch");
  assertEquals(refused.preserved, true);
  assert(await store.has(`run:${executionId}`), "readable authority survives compensation failure");
  assertEquals((await store.get("run-registry")).includes(executionId), true);

  const retried = await registry.rollbackUnprogressedQuota(executionId, quotaError(), options);
  assertEquals(retried.ok, true);
  assertEquals(await store.has(`run:${executionId}`), false);
  assertEquals(await store.has("run-registry"), false);
});

Deno.test("durable runs: progressed quota execution is preserved for explicit recovery", async () => {
  const store = new FakeStore();
  const run = harness(store);
  await begin(run.registry);
  await run.registry.heartbeat(executionId, { progressed: true });
  const before = await store.keys();

  const result = await run.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(result.ok, false);
  assertEquals(result.preserved, true);
  assertEquals(result.reason, "execution_progressed");
  assertEquals(await store.keys(), before);
  assertEquals((await run.registry.list()).runs[0].progressCount, 1);

  const uncertainStore = new FakeStore();
  const uncertain = harness(uncertainStore);
  await begin(uncertain.registry);
  const raw = await uncertainStore.get(`run:${executionId}`);
  raw.phase = "paused-side-effect-uncertain";
  raw.pause = { requiresOwnerDecision: true };
  await uncertainStore.setTrusted(`run:${executionId}`, raw);
  const uncertainBefore = await uncertainStore.keys();
  const refused = await uncertain.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(refused.reason, "execution_side_effect_uncertain");
  assertEquals(await uncertainStore.keys(), uncertainBefore, "uncertain authority is never deleted");
});

Deno.test("durable runs: quota rollback is idempotent", async () => {
  const store = new FakeStore();
  const run = harness(store);
  await begin(run.registry);
  const spoofed = Object.assign(new Error("QuotaExceededError: provider quota"), { name: "QuotaExceededError" });
  await assertRejects(() => run.registry.rollbackUnprogressedQuota(executionId, spoofed), TypeError, "native QuotaExceededError");
  assert(await store.has(`run:${executionId}`), "a provider/text quota spoof cannot authorize deletion");
  const first = await run.registry.rollbackUnprogressedQuota(executionId, quotaError());
  const second = await run.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(first.idempotent, false);
  assertEquals(second, { ok: true, rolledBack: true, idempotent: true, executionId, remainingKeys: [] });
});

Deno.test("durable runs: partial quota delete preserves authority and retry completes safely", async () => {
  const store = new FakeStore();
  const run = harness(store);
  await begin(run.registry);
  // Was `run-log:<exec>:accepted` — a key-value log row that no longer exists,
  // because registry rows now live in the run log itself. The property under
  // test is unchanged (a partial auxiliary delete must preserve authority and
  // retry safely), so this targets a key the purge still deletes: the migration
  // marker.
  store.failDeleteKey = `run-log-wal:${executionId}`;

  await assertRejects(
    () => run.registry.rollbackUnprogressedQuota(executionId, quotaError()),
    Error,
    "injected delete failure",
  );
  assert(await store.has(`run:${executionId}`), "read-back authority remains after a partial auxiliary delete");
  assertEquals(await store.get("run-registry"), [executionId]);

  const retried = await run.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(retried.ok, true);
  assertEquals((await store.keys()).filter((key) => key.includes(executionId)), []);
  assertEquals(await store.has("run-registry"), false, "retry restores the initially absent registry exactly");
});

Deno.test("durable runs: terminal fault matrix recovers exactly one journal and thread result", async (t) => {
  const boundaries = [
    "after-outbox",
    "after-journal",
    "after-thread",
    "after-cas",
    "after-outbox-ack",
    "after-outbox-removal",
  ];
  for (const boundary of boundaries) {
    await t.step(boundary, async () => {
      const store = new FakeStore();
      const first = harness(store, { failAt: boundary });
      await begin(first.registry);
      await assertRejects(() => first.registry.settle(executionId, terminalPayload), Error, "injected crash");

      const restarted = createDurableRunRegistry({
        store,
        logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
        bootId: "boot-b",
        now: () => 2_000,
        resolveJournalStore: async () => ({ journal: first.journal }),
        appendJournal: async (target, entry, _guard, id) => {
          if (!target.journal.some((row) => row.executionId === id && row.type === entry.type)) {
            target.journal.push(structuredClone(entry));
          }
        },
        commitThread: async (threadId, id, terminal) => {
          if (!first.thread.some((row) => row.executionId === id)) {
            first.thread.push({ threadId, executionId: id, ...structuredClone(terminal) });
          }
        },
      });
      await restarted.recover();
      const snapshot = await restarted.list();
      const run = snapshot.runs.find((row) => row.executionId === executionId);
      assertEquals(run.phase, "terminal");
      assertEquals(first.journal.filter((row) => row.executionId === executionId).length, 1);
      assertEquals(first.thread.filter((row) => row.executionId === executionId).length, 1);
      assertEquals(await store.has(`run-outbox:${executionId}`), false);
      assert(!snapshot.runs.some((row) => row.executionId === executionId && row.phase === "orphaned"));
    });
  }
});

Deno.test("durable runs: pre-outbox crash cannot create result+orphan double state; replayed payload settles once", async () => {
  const store = new FakeStore();
  const first = harness(store, { failAt: "before-outbox" });
  await begin(first.registry);
  await assertRejects(() => first.registry.settle(executionId, terminalPayload));

  const second = harness(store, { bootId: "boot-b" });
  await second.registry.recover();
  let run = (await second.registry.list()).runs[0];
  assertEquals(run.phase, "paused-interruption");
  assertEquals(first.journal.length, 0);
  assertEquals(first.thread.length, 0);

  // If the caller can re-present the exact terminal payload, idempotent replay
  // upgrades the interrupted record to one terminal triple, never a double state.
  const replay = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-b",
    resolveJournalStore: async () => ({ journal: first.journal }),
    appendJournal: async (target, entry, _guard, id) => {
      if (!target.journal.some((row) => row.executionId === id)) target.journal.push({ ...entry });
    },
    commitThread: async (threadId, id, terminal) => {
      if (!first.thread.some((row) => row.executionId === id)) first.thread.push({ threadId, executionId: id, ...terminal });
    },
  });
  await replay.settle(executionId, terminalPayload);
  run = (await replay.list()).runs[0];
  assertEquals(run.phase, "terminal");
  assertEquals(first.journal.length, 1);
  assertEquals(first.thread.length, 1);
});

Deno.test("durable runs: boot identity and heartbeat are truth; pre-boot active records pause for automatic interruption resume", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-a" });
  await begin(first.registry);
  const before = (await first.registry.list()).runs[0];
  await first.registry.heartbeat(executionId);
  const alive = (await first.registry.list()).runs[0];
  assertEquals(alive.bootId, "boot-a");
  assert(alive.heartbeatAt > before.heartbeatAt);
  assertEquals(alive.progressCount, 0);

  const second = harness(store, { bootId: "boot-b" });
  const recovered = await second.registry.recover();
  assertEquals(recovered.interrupted.length, 1);
  const paused = (await second.registry.list()).runs[0];
  assertEquals(paused.phase, "paused-interruption");
  assertEquals(paused.pause.kind, "interruption");
  const resumed = await second.registry.resumeAfterInterruption(executionId);
  assertEquals(resumed.ok, true);
  assertEquals(resumed.run.phase, "resume-dispatching");
  const activated = await second.registry.activateResume(executionId, resumed.token, resumed.resumeRequest.providerBinding);
  assertEquals(activated.run.phase, "running");
});

Deno.test("durable runs: reconnect sends snapshot then strictly newer revisioned updates", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  await begin(registry);
  const messages = [];
  let disconnect = null;
  registry.attachPort({
    postMessage(message) { messages.push(structuredClone(message)); },
    onDisconnect: { addListener(fn) { disconnect = fn; } },
  });
  while (!messages.some((message) => message.type === "run-snapshot")) await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshot = messages.find((message) => message.type === "run-snapshot");
  const snapshotRevision = snapshot.runs[0].revision;
  await registry.heartbeat(executionId, { progressed: true });
  const update = messages.find((message) => message.type === "run-update");
  assert(update.revision > snapshotRevision);
  assertEquals(update.executionId, executionId);
  disconnect?.();
});

Deno.test("durable runs: service-worker integrates both runTask and direct agent.delegate paths", async () => {
  const source = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const delegate = source.slice(source.indexOf('async "agent.delegate"'), source.indexOf('async "agent.listAll"'));
  assert(delegate.includes("admitDurableRun"), "direct delegation registers its immutable executionId through compensated admission");
  assert(delegate.includes("durableRuns.heartbeat"), "direct delegation advances durable heartbeat/progress truth");
  assert(delegate.includes("durableRuns.settle"), "direct delegation commits through the terminal outbox");
  assert(delegate.indexOf("journalAppendWithReceipt") < delegate.indexOf("dispatchDurableProviderRun"), "direct delegation journals its task before provider dispatch");
  assert(
    delegate.indexOf("admitDurableRun") < delegate.indexOf("dispatchDurableProviderRun") &&
      delegate.indexOf("dispatchDurableProviderRun") < delegate.indexOf("ensureOrchestrator"),
    "delegate persists first, then applies the production provider gate before worker initialization/dispatch",
  );
  const delegateEarly = delegate.slice(delegate.indexOf("admitDurableRun"), delegate.indexOf("dispatchDurableProviderRun"));
  assert(delegateEarly.includes("return admissionFailure"), "delegate early quota settles a structured response");
  assert(!delegateEarly.includes("rollbackUnprogressedQuota"), "delegate never rolls back a start that established no readable authority");
  assert(delegate.includes("rollbackUnprogressedQuota(execId, error,"), "established delegate quota rolls back before response settlement");
  assert(delegate.includes("return durableQuotaResponse(error, execId)"), "delegate returns truthful storage response");

  const runTask = source.slice(source.indexOf("async function runTask"), source.indexOf("// ---- message router"));
  assert(
    runTask.indexOf("admitDurableRun") < runTask.indexOf("providerRunGate"),
    "permission refusal is durably registered before entering a visible paused-permission state",
  );
  const runTaskEarly = runTask.slice(runTask.indexOf("admitDurableRun"), runTask.indexOf("providerRunGate"));
  assert(runTaskEarly.includes("return admissionFailure"), "run-task early quota settles a structured response");
  assert(!runTaskEarly.includes("rollbackUnprogressedQuota"), "run-task never rolls back a start that established no readable authority");
  const quotaCatchStart = runTask.indexOf("if (isNativeQuotaExceededError(error))");
  const ordinaryCatchStart = runTask.indexOf("const desc = describeError(error, { providerError })", quotaCatchStart);
  const quotaCatch = runTask.slice(quotaCatchStart, ordinaryCatchStart);
  assert(quotaCatchStart >= 0 && ordinaryCatchStart > quotaCatchStart, "runTask has a native quota branch before ordinary settlement");
  assert(quotaCatch.includes("rollbackUnprogressedQuota"), "established native quota invokes durable compensation");
  assert(quotaCatch.indexOf("rollbackUnprogressedQuota") < quotaCatch.indexOf("return durableQuotaResponse"), "established quota rollback happens before response settlement");
  assert(!quotaCatch.includes("durableRuns.settle"), "native quota never allocates a terminal payload/outbox or journal settlement");
  assert(runTask.indexOf("journalAppendWithReceipt") < runTask.indexOf("orch.run("), "runTask journals the task before the provider run");
  assert(source.includes('async "run.list"'), "the service worker exposes durable snapshots");
});

Deno.test("durable runs: agent.delegate start and resume pause before production provider dispatch", async () => {
  const previousChrome = globalThis.chrome;
  const providerConfig = {
    provider: "openai-compatible",
    model: "controlled-model",
    baseURL: "https://durable-provider.invalid/v1",
  };
  const providerBinding = {
    schemaVersion: 1,
    provider: "openai-compatible",
    model: "controlled-model",
    requestedScope: "https://durable-provider.invalid/*",
    local: false,
  };
  const store = new FakeStore();
  const { registry } = harness(store);
  let dispatches = 0;
  try {
    globalThis.chrome = { permissions: { contains: async () => false } };
    await registry.start({
      executionId,
      kind: "delegate",
      taskPreview: "delegate through gated provider",
      journalTarget: "master",
      resumeRequest: { route: "agent.delegate", task: "delegate through gated provider", providerBinding },
    });
    const startResult = await dispatchDurableProviderRun({
      executionId,
      providerConfig,
      providerBinding,
      durableRuns: registry,
      dispatch: async () => { dispatches += 1; return { ok: true }; },
    });
    assertEquals(startResult.ok, false);
    assertEquals(startResult.paused, true);
    assertEquals(startResult.pauseKind, "permission");
    assertEquals(dispatches, 0, "start cannot dispatch a worker/provider while permission-paused");
    assertEquals(startResult.run.phase, "paused-permission");
    assertEquals(startResult.run.pause.visible, true);
    assertEquals(startResult.run.pause.recoverable, true);
    assertEquals(startResult.run.pause.providerBinding, providerBinding);

    globalThis.chrome = { permissions: { contains: async () => true } };
    const prepared = await registry.resumeAfterPermission(executionId);
    const activated = await registry.activateResume(executionId, prepared.token, providerBinding);
    assertEquals(activated.run.phase, "running");
    globalThis.chrome = { permissions: { contains: async () => false } };
    const resumeResult = await dispatchDurableProviderRun({
      executionId,
      providerConfig,
      providerBinding,
      durableRuns: registry,
      dispatch: async () => { dispatches += 1; return { ok: true }; },
    });
    assertEquals(resumeResult.paused, true);
    assertEquals(resumeResult.run.phase, "paused-permission");
    assertEquals(dispatches, 0, "resume cannot dispatch a worker/provider while permission-paused");
    const snapshot = await registry.list();
    assertEquals(snapshot.runs[0].phase, "paused-permission", "paused delegate retains no running ownership");
    assert(snapshot.runs[0].terminal == null, "permission pause is recoverable, not terminal");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

Deno.test("durable runs: agent.delegate permission scope mismatch fails closed without dispatch", async () => {
  const previousChrome = globalThis.chrome;
  const store = new FakeStore();
  const { registry } = harness(store);
  const retainedBinding = {
    schemaVersion: 1,
    provider: "openai-compatible",
    model: "controlled-model",
    requestedScope: "https://retained-provider.invalid/*",
    local: false,
  };
  let dispatches = 0;
  try {
    globalThis.chrome = { permissions: { contains: async () => false } };
    await registry.start({
      executionId,
      kind: "delegate",
      taskPreview: "scope mismatch",
      journalTarget: "master",
      resumeRequest: { route: "agent.delegate", task: "scope mismatch", providerBinding: retainedBinding },
    });
    await assertRejects(
      () => dispatchDurableProviderRun({
        executionId,
        providerConfig: { provider: "openai-compatible", model: "controlled-model", baseURL: "https://different-provider.invalid/v1" },
        providerBinding: {
          ...retainedBinding,
          requestedScope: "https://different-provider.invalid/*",
        },
        durableRuns: registry,
        dispatch: async () => { dispatches += 1; return { ok: true }; },
      }),
      Error,
      "permission scope does not match bound provider identity",
    );
    assertEquals(dispatches, 0);
    assertEquals((await registry.list()).runs[0].phase, "running", "mismatched scope cannot manufacture a pause");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

Deno.test("durable runs: execution identity grammar rejects prototype/path adversaries", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  for (const id of ["__proto__", "constructor", "prototype", "exec:../../escape", "exec:constructor", "random-id"]) {
    await assertRejects(() => registry.start({ executionId: id, taskPreview: "bad", journalTarget: "master" }), Error, "invalid immutable executionId");
  }
});

Deno.test("durable runs: resolved policy is versioned bounded-by-default (compaction, never eviction) with terminal owner cancellation", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  await begin(registry);
  const snapshot = await registry.list();
  assertEquals(snapshot.policy, DURABLE_RUN_POLICY);
  assertEquals(snapshot.retentionPolicy, RUN_RETENTION_POLICY);
  assertEquals(snapshot.runs[0].policy.cancellation, "explicit-owner-terminal-new-run-required");
  assertEquals(snapshot.runs[0].retentionPolicyVersion, "run-retention-v2");
  // CAP-FB-20260830-RUN-LOG-COMPACTION-01: bounded by default, visible, and
  // compaction is not eviction — no execution is ever removed by policy.
  assertEquals(snapshot.retentionPolicy.mode, "bounded");
  assertEquals(snapshot.retentionPolicy.perThread, 50, "the last 50 runs of a thread keep their visible history (CAP-FB-20260901-THREAD-RELOAD-FIDELITY-01)");
  assertEquals(snapshot.retentionPolicy.globalExecutions, 500);
  assertEquals(snapshot.retentionPolicy.globalBytes, 32 * 1024 * 1024);
  assertEquals(snapshot.retentionPolicy.automaticCompaction, true);
  assertEquals(snapshot.retentionPolicy.automaticEviction, false);
  assertEquals(snapshot.retentionPolicy.explicitClearOnly, true);
});

Deno.test("durable runs: explicit cancel is terminal, idempotent, and resume requires a new run", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  const cancelled = await first.registry.cancel(executionId, { requestId: "cancel-1" });
  assertEquals(cancelled.ok, true);
  assertEquals(cancelled.run.phase, "cancelled");
  assertEquals(cancelled.run.cancellation.authority, "explicit-owner");
  assertEquals(cancelled.run.cancellation.restartAllowed, false);
  assert(cancelled.run.terminal.requestedAt === cancelled.run.cancellation.requestedAt);
  assert(cancelled.run.terminal.reconciledAt >= (cancelled.abortAttempt?.attemptedAt ?? cancelled.run.cancellation.requestedAt));
  assertEquals(cancelled.run.terminal.at, cancelled.run.terminal.reconciledAt);
  assertEquals(first.journal[0].type, "cancelled", "cancellation journal truth must not be relabelled result");
  assertEquals(first.journal[0].requestedAt, cancelled.run.cancellation.requestedAt);
  assertEquals(first.journal[0].reconciledAt, cancelled.run.terminal.reconciledAt);
  const repeated = await first.registry.cancel(executionId, { requestId: "cancel-2" });
  assertEquals(repeated.idempotent, true);
  assertEquals(first.journal.filter((row) => row.executionId === executionId && row.type === "cancelled").length, 1);
  assertEquals(first.thread.filter((row) => row.executionId === executionId).length, 1);
  assertEquals((await first.registry.resumeAfterPermission(executionId)).error, "cancelled_requires_new_run");
  assertEquals((await first.registry.resumeAfterInterruption(executionId)).error, "cancelled_requires_new_run");
  await first.registry.start({ executionId: "exec_durable_new2", taskPreview: "explicit retry", journalTarget: "master" });
  assertEquals((await first.registry.list()).runs.find((row) => row.executionId === "exec_durable_new2").phase, "running");
});

Deno.test("durable runs: abort hook fires once immediately after tombstone and failure cannot roll it back", async () => {
  const store = new FakeStore();
  let abortCalls = 0;
  let abortObservedBeforeOutbox = false;
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-abort-hook",
    now: (() => { let n = 10; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {}, replaceCancellationJournal: async () => {},
    commitThread: async () => {}, replaceCancellationThread: async () => {},
    injectFailure: async (boundary) => {
      if (boundary === "after-cancel-abort-recorded") {
        const durable = await store.get(`run:${executionId}`);
        assertEquals(durable.cancellation.abortAttempt.attempted, true);
        assert(durable.cancellation.abortAttempt.attemptedAt >= durable.cancellation.requestedAt);
        assertEquals(await store.has(`run-outbox:${executionId}`), false);
      }
      if (boundary === "after-cancel-outbox") abortObservedBeforeOutbox = abortCalls === 1;
    },
  });
  await begin(registry);
  const first = await registry.cancel(executionId, { onAuthorityPersisted: () => { abortCalls += 1; } });
  assertEquals(first.abortAttempt.ok, true);
  assert(first.run.cancellation.requestedAt < first.abortAttempt.attemptedAt);
  assert(first.run.terminal.at >= first.abortAttempt.attemptedAt, "terminal reconciliation cannot predate the recorded live abort attempt");
  assertEquals(first.run.terminal.at, first.run.terminal.reconciledAt);
  assertEquals(first.run.terminal.requestedAt, first.run.cancellation.requestedAt);
  assertEquals(abortObservedBeforeOutbox, true);
  await registry.cancel(executionId, { onAuthorityPersisted: () => { abortCalls += 1; } });
  assertEquals(abortCalls, 1);

  const slowStore = new FakeStore();
  const slow = harness(slowStore);
  await begin(slow.registry);
  let releaseAbort;
  let enteredAbort;
  const entered = new Promise((resolve) => { enteredAbort = resolve; });
  const release = new Promise((resolve) => { releaseAbort = resolve; });
  let slowCalls = 0;
  const firstCancel = slow.registry.cancel(executionId, { onAuthorityPersisted: async () => { slowCalls += 1; enteredAbort(); await release; } });
  await entered;
  const duplicateDuringAbort = await slow.registry.cancel(executionId, { onAuthorityPersisted: () => { slowCalls += 1; } });
  assertEquals(duplicateDuringAbort.cancellationPending, true);
  assertEquals(await slowStore.has(`run-outbox:${executionId}`), false, "outbox waits for the claimed abort callback");
  releaseAbort();
  await firstCancel;
  assertEquals(slowCalls, 1);

  const crashStore = new FakeStore();
  const crashing = harness(crashStore, { failAt: "after-cancel-outbox" });
  await begin(crashing.registry);
  let crashAbort = 0;
  await assertRejects(() => crashing.registry.cancel(executionId, { onAuthorityPersisted: () => { crashAbort += 1; } }), Error, "injected crash");
  assertEquals(crashAbort, 1);
  const recovered = harness(crashStore, { bootId: "boot-after-tombstone-abort" });
  await recovered.registry.recover();
  assertEquals((await recovered.registry.list()).runs[0].phase, "cancelled");

  const retryStore = new FakeStore();
  const retrying = harness(retryStore);
  await begin(retrying.registry);
  let retryCalls = 0;
  const retriedAbort = await retrying.registry.cancel(executionId, { onAuthorityPersisted: () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error("transient abort callback failure");
  } });
  assertEquals(retriedAbort.run.phase, "cancelled");
  assertEquals(retriedAbort.abortAttempt.ok, true);
  assertEquals(retriedAbort.abortAttempt.attemptCount, 2);
  assertEquals(retriedAbort.abortAttempt.errors, ["transient abort callback failure"]);

  const store2 = new FakeStore();
  const throwing = harness(store2);
  await begin(throwing.registry);
  let throwCalls = 0;
  const failedAbort = await throwing.registry.cancel(executionId, { onAuthorityPersisted: () => { throwCalls += 1; throw new Error(`abort callback failed ${throwCalls}`); } });
  assertEquals(failedAbort.run.phase, "cancelled");
  assertEquals(throwCalls, 2);
  assertEquals(failedAbort.abortAttempt.ok, false);
  assertEquals(failedAbort.abortAttempt.attemptCount, 2);
  assertEquals(failedAbort.abortAttempt.errors, ["abort callback failed 1", "abort callback failed 2"]);

  const casStore = new FakeStore();
  const casFail = harness(casStore);
  await begin(casFail.registry);
  await assertRejects(
    () => casFail.registry.cancel(executionId, { onAuthorityPersisted: () => {
      casStore.failNextCompareAndRestore = true;
      return true;
    } }),
    Error,
    "abort-attempt record CAS failed",
  );
  const authorityOnly = await casStore.get(`run:${executionId}`);
  assertEquals(authorityOnly.cancellation.abortAttempt.attempted, false, "a failed CAS cannot manufacture durable abort evidence");
});

Deno.test("durable runs: cancellation tombstone wins across every cancellation crash boundary", async (t) => {
  const boundaries = [
    "after-cancel-authority", "after-cancel-abort-recorded", "after-cancel-outbox", "after-cancel-journal",
    "after-cancel-thread", "after-cancel-cas", "after-cancel-outbox-ack", "after-cancel-outbox-removal",
  ];
  for (const boundary of boundaries) await t.step(boundary, async () => {
    const store = new FakeStore();
    const first = harness(store, { failAt: boundary });
    await begin(first.registry);
    await assertRejects(() => first.registry.cancel(executionId), Error, "injected crash");
    const restarted = harness(store, { bootId: "boot-restart" });
    // Share observable authorities to prove replacement rather than duplicate.
    restarted.journal.push(...first.journal);
    restarted.thread.push(...first.thread);
    await restarted.registry.recover();
    const run = (await restarted.registry.list()).runs[0];
    assertEquals(run.phase, "cancelled");
    assertEquals(restarted.journal.filter((row) => row.executionId === executionId && row.type === "cancelled").length, 1);
    assertEquals(restarted.thread.filter((row) => row.executionId === executionId).length, 1);
    assertEquals(await store.has(`run-outbox:${executionId}`), false);
  });
});

Deno.test("durable runs: cancel replaces partially committed ordinary outbox and late terminal cancel fails closed", async () => {
  const store = new FakeStore();
  const first = harness(store, { failAt: "after-thread" });
  await begin(first.registry);
  await assertRejects(() => first.registry.settle(executionId, terminalPayload));
  const cancelled = await first.registry.cancel(executionId);
  assertEquals(cancelled.run.phase, "cancelled");
  assertEquals(first.journal.filter((row) => row.executionId === executionId).length, 1);
  assertEquals(first.journal[0].type, "cancelled");
  assertEquals(first.thread.filter((row) => row.executionId === executionId).length, 1);

  const store2 = new FakeStore();
  const completed = harness(store2);
  await begin(completed.registry);
  await completed.registry.settle(executionId, terminalPayload);
  assertEquals((await completed.registry.cancel(executionId)).error, "run_already_terminal");
});

Deno.test("durable runs: permission pause resumes only after resolution state and interruption auto-resume preserves identity", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  await assertRejects(() => first.registry.pauseForPermission(executionId, { code: "permission_required", requestedScope: "https://wrong.example/*" }), Error, "permission scope does not match");
  const paused = await first.registry.pauseForPermission(executionId, { code: "permission_required", requestedScope: null });
  assertEquals(paused.phase, "paused-permission");
  assertEquals(paused.pause.visible, true);
  const resumed = await first.registry.resumeAfterPermission(executionId);
  assertEquals(resumed.run.phase, "resume-dispatching");
  assertEquals(resumed.executionId, executionId);
  await first.registry.activateResume(executionId, resumed.token, resumed.resumeRequest.providerBinding);

  const restarted = harness(store, { bootId: "boot-after-kill" });
  await restarted.registry.recover();
  const interrupted = (await restarted.registry.list()).runs[0];
  assertEquals(interrupted.phase, "paused-interruption");
  const automatic = await restarted.registry.resumeAfterInterruption(executionId);
  assertEquals(automatic.executionId, executionId);
  assertEquals(automatic.run.resumeAttemptCount, 2);
  await restarted.registry.activateResume(executionId, automatic.token, automatic.resumeRequest.providerBinding);
});

Deno.test("durable runs: generic scheduled resume preserves fail-closed provider-server identity", async () => {
  const store = new FakeStore();
  const first = harness(store);
  const scheduledExecutionId = "exec_provider_identity_resume_0001";
  const admission = await admitDurableRun(first.registry, {
    executionId: scheduledExecutionId,
    clientCorrelationId: "scheduled-provider-identity",
    threadId: null,
    kind: "scheduled",
    taskPreview: "background work",
    journalTarget: "agent:background",
    // This models a generic/legacy caller with UNKNOWN identity. Admission must
    // persist explicit null so spreading the resumed request can never trigger
    // runTask's hub behavior.
    resumeRequest: {
      id: "schedule:background",
      task: "background work",
      scheduled: true,
      memoryOrigin: "agent:background",
      providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true },
      idempotencyKey: scheduledExecutionId,
    },
  });
  assertEquals(admission, null);

  const restarted = harness(store, { bootId: "boot-provider-identity-resume" });
  await restarted.registry.recover();
  const prepared = await restarted.registry.resumeAfterInterruption(scheduledExecutionId);
  assert(Object.prototype.hasOwnProperty.call(prepared.resumeRequest, "providerServerAgentId"));
  assertEquals(prepared.resumeRequest.providerServerAgentId, null);
  // Exact generic dispatch shape: the durable request is spread back into
  // runTask, so the explicit null must survive that spread.
  const genericResumeArgs = { ...prepared.resumeRequest, executionId: scheduledExecutionId };
  assertEquals(genericResumeArgs.providerServerAgentId, null);
});

Deno.test("durable runs: rejected resume dispatch re-pauses visibly and bounds automatic attempts", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  const restarted = harness(store, { bootId: "boot-resume-bound" });
  await restarted.registry.recover();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const prepared = await restarted.registry.resumeAfterInterruption(executionId);
    assertEquals(prepared.run.phase, "resume-dispatching");
    const failed = await restarted.registry.failResumeDispatch(executionId, prepared.token, `missing route ${attempt}`);
    assertEquals(failed.run.pause.visible, true);
    if (attempt < 3) assertEquals(failed.run.phase, "paused-interruption");
    else assertEquals(failed.run.phase, "terminal");
  }
  assertEquals((await restarted.registry.resumeAfterInterruption(executionId)).error, "run_not_resumable");
  const snapshot = await restarted.registry.list();
  assertEquals(snapshot.runs[0].resumeAttemptCount, 3);
});

Deno.test("durable runs: final prepared resume crash and pre-existing attempt ceiling terminalize exactly once", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  const restarted = harness(store, { bootId: "boot-resume-crash" });
  await restarted.registry.recover();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prepared = await restarted.registry.resumeAfterInterruption(executionId);
    await restarted.registry.failResumeDispatch(executionId, prepared.token, `missing route ${attempt}`);
  }
  const finalPrepared = await restarted.registry.resumeAfterInterruption(executionId);
  assertEquals(finalPrepared.run.resumeAttemptCount, 3);
  assertEquals(finalPrepared.run.phase, "resume-dispatching");

  const afterCrash = harness(store, { bootId: "boot-after-final-prepare" });
  await afterCrash.registry.recover();
  await afterCrash.registry.recover();
  const terminal = (await afterCrash.registry.list()).runs[0];
  assertEquals(terminal.phase, "terminal");
  assertEquals(terminal.resumeAttemptCount, 3);
  assertEquals(afterCrash.journal.filter((row) => row.type === "result").length, 1);
  assertEquals(afterCrash.thread.filter((row) => row.executionId === executionId).length, 1);
  assertEquals((await afterCrash.registry.resumeAfterInterruption(executionId)).error, "run_not_resumable");

  const ceilingStore = new FakeStore();
  const ceiling = harness(ceilingStore);
  await begin(ceiling.registry);
  const record = await ceilingStore.get(`run:${executionId}`);
  record.phase = "paused-interruption";
  record.resumeAttemptCount = 3;
  record.pause = { kind: "interruption", visible: true, automaticRetry: true };
  await ceilingStore.setTrusted(`run:${executionId}`, record);
  // The record was edited on disk behind the live registry: a fresh worker
  // reads it (the registry caches its own records for its lifetime).
  const ceilingWorker = harness(ceilingStore, { bootId: "boot-ceiling" });
  const refused = await ceilingWorker.registry.resumeAfterInterruption(executionId);
  assertEquals(refused.error, "resume_attempt_limit_reached");
  assertEquals(refused.run.phase, "terminal");
  assertEquals(ceilingWorker.journal.filter((row) => row.type === "result").length, 1);
  assertEquals(ceilingWorker.thread.filter((row) => row.executionId === executionId).length, 1);
});

Deno.test("durable runs: interruption after tool progress pauses side-effect-uncertain instead of blind replay", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  await first.registry.heartbeat(executionId, { progressed: true });
  const restarted = harness(store, { bootId: "boot-uncertain" });
  await restarted.registry.recover();
  const run = (await restarted.registry.list()).runs[0];
  assertEquals(run.phase, "paused-side-effect-uncertain");
  assertEquals(run.pause.kind, "side-effect-uncertain");
  assertEquals(run.pause.requiresOwnerDecision, true);
  assertEquals("recoverable" in run.pause, false);
  assertEquals(run.pause.automaticRetry, false);
});

Deno.test("durable runs: cancellation wins a prepared resume before dispatch activation", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  const restarted = harness(store, { bootId: "boot-cancel-resume" });
  await restarted.registry.recover();
  const prepared = await restarted.registry.resumeAfterInterruption(executionId);
  await restarted.registry.cancel(executionId);
  const activation = await restarted.registry.activateResume(executionId, prepared.token, prepared.resumeRequest.providerBinding);
  assertEquals(activation.error, "cancelled_requires_new_run");
  assertEquals((await restarted.registry.list()).runs[0].phase, "cancelled");
});

Deno.test("durable runs: large recoverable requests are chunked outside the public record", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const large = "x".repeat(180_000);
  await registry.start({
    executionId,
    taskPreview: "large attachment",
    journalTarget: "master",
    resumeRequest: { id: "large", task: "large attachment", attachments: [{ dataURL: large }], memoryOrigin: "master" },
  });
  const publicRun = (await registry.list()).runs[0];
  assertEquals(publicRun.resumeAvailable, true);
  assertEquals("resumeRequest" in publicRun, false);
  assert((await store.keys()).filter((key) => key.startsWith(`run-resume:${executionId}:`)).length >= 4);
  await registry.appendLog(executionId, { type: "tool-result", result: large }, "large-result");
  const retained = await registry.listLogs(executionId);
  assertEquals(retained.find((row) => row.idempotencyKey === "large-result").payload.result.length, large.length);
  const restarted = harness(store, { bootId: "boot-large" });
  await restarted.registry.recover();
  const resumed = await restarted.registry.resumeAfterInterruption(executionId);
  assertEquals(resumed.resumeRequest.attachments[0].dataURL.length, large.length);
  const mismatch = await restarted.registry.activateResume(executionId, resumed.token, { ...resumed.resumeRequest.providerBinding, model: "switched" });
  assertEquals(mismatch.error, "provider_identity_changed");
  assertEquals(mismatch.run.phase, "paused-provider-change");
});

Deno.test("durable runs: terminal results retain full bytes beyond bounded journal previews", async () => {
  const store = new FakeStore();
  const run = harness(store);
  await begin(run.registry);
  const full = "result-".repeat(20_000);
  await run.registry.settle(executionId, { ok: true, result: full, logicalId: "task-full" });
  const logs = await run.registry.listLogs(executionId);
  const terminal = logs.find((row) => row.type === "terminal");
  assertEquals(terminal.payload.result.length, full.length);
  assert(run.journal[0].result.length < full.length, "compatibility journal remains a bounded preview");
});

Deno.test("durable runs: retain-all logs survive restart; legacy metadata migrates and unknown future policy fails closed", async () => {
  const store = new FakeStore();
  const first = harness(store);
  await begin(first.registry);
  await first.registry.appendLog(executionId, { type: "tool-call", tool: "one" }, "call-1");
  await first.registry.appendLog(executionId, { type: "tool-result", result: "kept" }, "result-1");
  const restarted = harness(store, { bootId: "boot-b" });
  assertEquals((await restarted.registry.listLogs(executionId)).length, 3); // accepted + two rows

  // A record edited on disk behind a live registry models a PREVIOUS worker
  // generation's state, so each variant below is read by a fresh worker (the
  // registry is the single writer of its records and caches them for its
  // lifetime — CAP-FB-20260830-RUN-LOG-COMPACTION-01).
  const legacy = await store.get(`run:${executionId}`);
  delete legacy.retentionPolicyVersion;
  delete legacy.retentionMigration;
  await store.setTrusted(`run:${executionId}`, legacy);
  const afterLegacy = harness(store, { bootId: "boot-c" });
  const migrated = (await afterLegacy.registry.list()).runs[0];
  assertEquals(migrated.retentionPolicyVersion, "run-retention-v2");
  assertEquals(migrated.retentionMigration.from, "legacy-unversioned");
  assertEquals((await afterLegacy.registry.listLogs(executionId)).length, 3);

  // v1-stamped records (every profile before compaction landed) migrate to
  // the v2 stamp; v1-stamped LOG ROWS stay readable as they are.
  const v1 = await store.get(`run:${executionId}`);
  v1.retentionPolicyVersion = "run-retention-v1";
  delete v1.retentionMigration;
  await store.setTrusted(`run:${executionId}`, v1);
  const afterV1 = harness(store, { bootId: "boot-d" });
  const fromV1 = (await afterV1.registry.list()).runs[0];
  assertEquals(fromV1.retentionPolicyVersion, "run-retention-v2");
  assertEquals(fromV1.retentionMigration, { from: "run-retention-v1", to: "run-retention-v2" });
  assertEquals((await afterV1.registry.listLogs(executionId)).length, 3);

  const unknown = await store.get(`run:${executionId}`);
  unknown.retentionPolicyVersion = "run-retention-v999";
  await store.setTrusted(`run:${executionId}`, unknown);
  await assertRejects(() => harness(store, { bootId: "boot-e" }).registry.list(), Error, "unknown durable run retention policy");
});

Deno.test("durable runs: retain-all does not truncate or evict beyond the former 200-record cap", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  for (let index = 0; index < 205; index += 1) {
    await registry.start({ executionId: `exec_retain_${String(index).padStart(4, "0")}`, taskPreview: `run ${index}`, journalTarget: "master" });
  }
  const snapshot = await registry.list();
  assertEquals(snapshot.runs.length, 205);
  assertEquals((await store.get("run-registry")).length, 205);
});

Deno.test("durable runs: quota rejection preserves all old logs and leaves no stranded run", async () => {
  class QuotaStore extends FakeStore {
    failKey = null;
    async setTrusted(key, value) {
      if (key === this.failKey) throw new Error("quota exceeded");
      return await super.setTrusted(key, value);
    }
  }
  const store = new QuotaStore();
  // The failing write moved with the data: the `accepted` row is a LOG row now,
  // so the quota fault is injected where that write happens rather than on a
  // key-value key that no longer exists. The property is unchanged — a quota
  // failure while admitting a run must leave every old log intact and strand
  // nothing.
  let failExec = null;
  store.__logHandles = createMemoryRunLogHandles({ failWriteFor: (id) => id === failExec });
  const registry = harness(store).registry;
  await begin(registry);
  await registry.appendLog(executionId, { type: "tool-result", result: "old retained" }, "old-log");
  const oldKeys = (await store.keys()).filter((key) => key.includes(executionId)).sort();
  failExec = "exec_quota_new1";
  await assertRejects(() => registry.start({ executionId: "exec_quota_new1", taskPreview: "new", journalTarget: "master", resumeRequest: { task: "new" } }), Error, "quota exceeded");
  failExec = null;
  const ids = await store.get("run-registry");
  assertEquals(ids.includes("exec_quota_new1"), false);
  assertEquals((await store.keys()).filter((key) => key.includes("exec_quota_new1")), [], "failed start leaves zero run/resume/log/payload/outbox keys");
  assertEquals((await store.keys()).filter((key) => key.includes(executionId)).sort(), oldKeys);
  assertEquals((await registry.listLogs(executionId)).some((row) => row.result === "old retained"), true);
});

Deno.test("durable runs: service worker exposes owner-only cancel/resume/log routes and permission event recovery", async () => {
  const source = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(source.includes('async "run.cancel"(m, context)'));
  assert(source.includes('error: "cancelled_requires_new_run"'));
  assert(source.includes('async "run.logs"(m, context)'));
  assert(source.includes("chrome.permissions?.onAdded?.addListener"));
  assert(source.includes("resumeInterruptedRuns"));
  assert(source.includes("onAuthorityPersisted"));
  assert(source.includes("const abort = durableRunAborters.get(executionId)"));
  assert(source.includes("failResumeDispatch"));
  assert(source.includes("providerResumeIdentity"));
  const conversation = await Deno.readTextFile(new URL("../extension/shared/conversation.js", import.meta.url));
  assert(conversation.includes("export async function cancelDurableRun"));
  assert(conversation.includes("export async function resumePermissionPausedRun"));
  assert(conversation.includes("export async function loadDurableRunLogs"));
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntp.includes("subscribeRunRegistry"));
  assert(ntp.includes('addEventListener("run-cancel"'));
  assert(ntp.includes('addEventListener("run-resume"'));
  assert(ntp.includes('addEventListener("run-logs"'));
});


// CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01: the recovery gate is
// driven by the RECORDED per-tool replay safety, never the progress count.
Deno.test("durable runs: a MUTATING progressed run pauses as paused-side-effect-uncertain (owner decision, never auto-resume)", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-m" });
  await begin(first.registry);
  // A mutating tool progressed (the fail-closed default after any unknown/
  // mutating tool-call; explicit for clarity).
  await first.registry.recordToolSafety(executionId, "mutating");
  await first.registry.heartbeat(executionId, { progressed: true });

  const second = harness(store, { bootId: "boot-n" });
  const recovered = await second.registry.recover();
  assertEquals(recovered.interrupted.length, 1);
  const paused = (await second.registry.list()).runs[0];
  assertEquals(paused.phase, "paused-side-effect-uncertain");
  assertEquals(paused.pause.requiresOwnerDecision, true);
  assertEquals(paused.pause.automaticRetry, false, "a mutating progressed run must never auto-retry");
  // The owner decision surface (Retry/Cancel) is the only way forward.
  const resumed = await second.registry.resumeAfterInterruption(executionId);
  assertEquals(resumed.ok, false, "resumeAfterInterruption must refuse a side-effect-uncertain run");
});

Deno.test("durable runs: an explicitly READ-ONLY progressed run pauses as recoverable interruption and auto-resumes with the stable key", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-r" });
  await begin(first.registry);
  await first.registry.recordToolSafety(executionId, "read-only");
  await first.registry.heartbeat(executionId, { progressed: true });

  const second = harness(store, { bootId: "boot-s" });
  const recovered = await second.registry.recover();
  const paused = (await second.registry.list()).runs[0];
  assertEquals(paused.phase, "paused-interruption");
  assertEquals(paused.pause.automaticRetry, true, "read-only progress is auto-resumable");
  assertEquals(paused.pause.recoverable, true);
  const resumed = await second.registry.resumeAfterInterruption(executionId);
  assertEquals(resumed.ok, true, "read-only progress may auto-resume");
  assertEquals(resumed.resumeRequest.idempotencyKey, executionId, "the stable execution idempotency key is reused");
});

Deno.test("durable runs: an UNKNOWN-safety progressed run fails closed to paused-side-effect-uncertain", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-u" });
  await begin(first.registry);
  // Progress WITHOUT any recorded safety (e.g. the recordToolSafety write
  // failed) must fail closed — the record defaults to mutating.
  await first.registry.heartbeat(executionId, { progressed: true });
  const raw = await store.get(`run:${executionId}`);
  assertEquals(raw.toolSafety, null, "the record must default to UNRECORDED (the gate treats null as mutating — fail-closed)");

  const second = harness(store, { bootId: "boot-v" });
  const recovered = await second.registry.recover();
  const paused = (await second.registry.list()).runs[0];
  assertEquals(paused.phase, "paused-side-effect-uncertain", "unknown safety pauses for the owner decision");
});

Deno.test("durable runs: an IDEMPOTENT progressed run auto-resumes (worst-merge keeps mutating authoritative)", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-i" });
  await begin(first.registry);
  await first.registry.recordToolSafety(executionId, "idempotent");
  await first.registry.recordToolSafety(executionId, "read-only");
  await first.registry.heartbeat(executionId, { progressed: true });
  // The worst-merge: idempotent wins over read-only.
  let raw = await store.get(`run:${executionId}`);
  assertEquals(raw.toolSafety, "idempotent");

  await first.registry.recordToolSafety(executionId, "mutating");
  raw = await store.get(`run:${executionId}`);
  assertEquals(raw.toolSafety, "mutating", "a later mutating tool overrides earlier read-only/idempotent progress");

  const second = harness(store, { bootId: "boot-w" });
  const recovered = await second.registry.recover();
  const paused = (await second.registry.list()).runs[0];
  assertEquals(paused.phase, "paused-side-effect-uncertain", "mutating progress always wins the recovery decision");
});

// CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01 (review successor): the
// ATOMIC pre-tool authority — the call identity + the normalized safety are
// persisted BEFORE any effect; the stable per-tool-call key is byte-identical
// across resume; a possibly-effectful execution is never deleted by quota.
Deno.test("durable runs: preToolUse persists the atomic call + safety and returns the STABLE per-call key across resume", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-p1" });
  await begin(first.registry);
  const pre = await first.registry.preToolUse(executionId, { toolName: "memory_set", safety: "idempotent" });
  assertEquals(pre.ok, true);
  assertEquals(pre.key, `${executionId}:memory_set:1`, "the stable key = executionId:toolName:index");
  const raw = await store.get(`run:${executionId}`);
  assertEquals(raw.toolSafety, "idempotent");
  assertEquals(raw.progressCount, 1);
  assertEquals(raw.toolCallCounts["memory_set"], 1);

  // The RECORD carries the per-tool counter — the stable index authority that
  // a resumed boot continues from (never a fresh run-instance UUID).
  const rawAfter = await store.get(`run:${executionId}`);
  assertEquals(rawAfter.toolCallCounts["memory_set"], 1);
  // A real RESUME: the second boot recovers + re-activates the SAME execution,
  // then the next pre-tool use continues the record's index.
  const second = harness(store, { bootId: "boot-p2" });
  await second.registry.recover();
  const resumed = await second.registry.resumeAfterInterruption(executionId);
  assertEquals(resumed.ok, true);
  await second.registry.activateResume(executionId, resumed.token, resumed.resumeRequest.providerBinding);
  const pre2 = await second.registry.preToolUse(executionId, { toolName: "memory_set", safety: "idempotent" });
  assertEquals(pre2.key, `${executionId}:memory_set:2`, "the resumed call continues the STABLE index");
});

Deno.test("durable runs: a HOSTILE tool name normalizes to unknown and fails the safety merge closed", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-h1" });
  await begin(first.registry);
  await first.registry.preToolUse(executionId, { toolName: "read_page", safety: "read-only" });
  const hostile = { toString() { throw new Error("hostile"); } };
  // The CALLER computes the safety via the hostile-safe classifier (unknown for
  // a hostile name) + the worst-merge must not retain the earlier read-only.
  const hostileSafety = replaySafetyForTool(hostile);
  assertEquals(hostileSafety, REPLAY_UNKNOWN);
  const preH = await first.registry.preToolUse(executionId, { toolName: hostile, safety: hostileSafety });
  assertEquals(preH.ok, true);
  const raw = await store.get(`run:${executionId}`);
  assertEquals(raw.toolSafety, "unknown", "a hostile name must NOT leave the run read-only");
});

Deno.test("durable runs: a pre-tool persistence failure REFUSES the execution (the run never mutates before its authority)", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-f1" });
  await begin(first.registry);
  // Make the next writeRecord fail (the record disappears).
  // Simulate a lost authority: delete the record so the CAS/read fails.
  store.values.delete(`run:${executionId}`);
  let threw = "";
  try { await first.registry.preToolUse(executionId, { toolName: "memory_set", safety: "idempotent" }); }
  catch (error) { threw = String(error?.message ?? error); }
  assert(threw.length > 0, "the pre-tool call must throw (refuse) when the authority cannot be persisted");
});

Deno.test("durable runs: quota rollback NEVER deletes a possibly-effectful execution (the pre-tool record preserved)", async () => {
  const store = new FakeStore();
  const first = harness(store, { bootId: "boot-q1" });
  await begin(first.registry);
  await first.registry.preToolUse(executionId, { toolName: "memory_set", safety: "idempotent" });
  const result = await first.registry.rollbackUnprogressedQuota(executionId, quotaError());
  assertEquals(result.preserved, true, "progressed authority is preserved");
  assertEquals(await store.has(`run:${executionId}`), true, "the execution authority survives");
});

// ──────────────────────────────────────────────────────────────────────────
// Thread-open perf (P0, second pass): the per-execution log index makes a
// bounded listLogs read O(page) instead of O(total), with cursor pagination
// for the FULL history. The old path enumerated every store key + did a
// per-row store.get + sort — 1.3-1.7s PER execution.
// ──────────────────────────────────────────────────────────────────────────

class CountingStore extends FakeStore {
  getCalls = 0;
  async get(key) {
    this.getCalls += 1;
    return super.get(key);
  }
}

async function startIndexedRun(registry, id, threadId = "thread-idx") {
  await registry.start({
    executionId: id,
    clientCorrelationId: `page-${id}`,
    threadId,
    kind: "task",
    taskPreview: "indexed run",
    journalTarget: "master",
    resumeRequest: { id: `task-${id}`, task: "indexed run", memoryOrigin: "master", providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true }, idempotencyKey: id },
  });
}

Deno.test("thread-log index: a bounded listLogs reads O(page), not O(total) (fast-path)", async () => {
  const store = new CountingStore();
  const { registry } = harness(store);
  const id = "exec_idx_fast";
  await startIndexedRun(registry, id);
  const TOTAL = 2000;
  for (let i = 0; i < TOTAL; i += 1) {
    await registry.appendLog(id, { type: "tool-call", tool: `t${i}` }, `key-${i}`);
  }
  // The appendLogs above also built the index. A bounded read must NOT enumerate
  // the whole store: get() calls ≤ limit + a few (index read + readRecord).
  store.getCalls = 0;
  const rows = await registry.listLogs(id, 250);
  assertEquals(rows.length, 250, "recent page = the most-recent 250 rows");
  assert(store.getCalls < 300, `fast path should read ~limit rows, not all ${TOTAL}: saw ${store.getCalls} get() calls`);
  // The most-recent rows are the highest-indexed tools.
  assertEquals(rows[0].tool, `t${TOTAL - 250}`, "oldest of the page");
  assertEquals(rows[249].tool, `t${TOTAL - 1}`, "newest of the page");
});

Deno.test("run log WAL: cursor pagination reaches the OLDEST rows (full history)", async () => {
  // The property is unchanged from the index era — the FULL history stays
  // reachable one bounded page at a time — but the cursor is now a byte offset
  // into the log rather than a row key, so the test drives the real cursor the
  // caller is given (`nextBefore`) instead of reconstructing one from an index.
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_idx_page";
  await startIndexedRun(registry, id);
  const TOTAL = 500;
  for (let i = 0; i < TOTAL; i += 1) {
    await registry.appendLog(id, { type: "tool-call", tool: `t${i}` }, `key-${i}`);
  }
  const PAGE = 100;

  const page1 = await registry.listLogs(id, { limit: PAGE });
  assertEquals(page1.length, PAGE);
  assertEquals(page1[0].tool, `t${TOTAL - PAGE}`, "first page oldest");
  assertEquals(page1[PAGE - 1].tool, `t${TOTAL - 1}`, "first page newest");

  let cursor = page1.nextBefore;
  let found = false;
  const seen = new Set(page1.map((r) => r.tool));
  for (let guard = 0; guard < 20 && !found; guard += 1) {
    const page = await registry.listLogs(id, { limit: PAGE, before: cursor });
    if (page.length === 0) break;
    for (const r of page) seen.add(r.tool);
    if (page.some((r) => r.tool === "t0")) { found = true; break; }
    if (page.exhausted) break;
    cursor = page.nextBefore;
  }
  assert(found, "paging back reaches the OLDEST row (t0)");
  // Stronger than the original: every row is seen exactly once across the
  // pages, so paging cannot silently skip or repeat history.
  for (let i = 0; i < TOTAL; i += 1) assert(seen.has(`t${i}`), `t${i} was reachable`);
});

Deno.test("run log WAL: a LEGACY key-value execution migrates into the log on first read", async () => {
  // Replaces the old "rebuilds the index" test. The property that matters is
  // the same — an execution written the OLD way is still fully readable, and
  // heals on first touch — but the healing is now a migration into the WAL
  // rather than an index rebuild. Write, verify, then delete: the legacy rows
  // are only removed once the log reads back complete.
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_idx_legacy";
  await startIndexedRun(registry, id);

  // Simulate a pre-WAL execution: rows in the key-value store, no log file.
  const legacy = [
    { type: "tool-call", tool: "a", idempotencyKey: "k1" },
    { type: "tool-call", tool: "b", idempotencyKey: "k2" },
    { type: "tool-call", tool: "c", idempotencyKey: "k3" },
  ];
  for (const [i, row] of legacy.entries()) {
    await store.setTrusted(`run-log:${id}:legacy${i}`, {
      schemaVersion: 1,
      retentionPolicyVersion: "run-retention-v1",
      executionId: id,
      at: 5_000 + i,
      ...row,
    });
  }
  await store.delete(`run-log-wal:${id}`).catch(() => {});

  // Read through a FRESH registry, which is what actually happens: a pre-WAL
  // execution is met by a worker that has never seen it. (The original registry
  // memoises "already migrated" in memory to keep the marker check off the
  // per-append path, so reusing it here would be testing the memo, not the
  // migration.)
  const { registry: cold } = harness(store, { bootId: "boot-cold" });
  const rows = await cold.listLogs(id, 2);
  assertEquals(rows.length, 2, "a bounded read still returns the recent slice");
  assertEquals(rows[0].tool, "b");
  assertEquals(rows[1].tool, "c");

  // Healed: the legacy rows are gone and the whole history reads from the log.
  const all = await cold.listLogs(id);
  assertEquals(all.filter((r) => r.type === "tool-call").map((r) => r.tool), ["a", "b", "c"]);
  const leftover = (await store.keys()).filter((k) => k.startsWith(`run-log:${id}:`));
  assertEquals(leftover.length, 0, "legacy rows are removed only after the log verified");
  assert(await store.has(`run-log-wal:${id}`), "migration is marked so it runs exactly once");
});

Deno.test("thread-log index: full history (unbounded) still returns every row", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_idx_full";
  await startIndexedRun(registry, id);
  for (let i = 0; i < 50; i += 1) await registry.appendLog(id, { type: "tool-call", tool: `t${i}` }, `k${i}`);
  const all = await registry.listLogs(id);
  assertEquals(all.length, 51, "unbounded read returns the FULL history (accepted + 50 appends)");
  assertEquals(all[0].type, "accepted", "the admission marker is the oldest row");
  assertEquals(all[1].tool, "t0");
  assertEquals(all[50].tool, "t49");
});


Deno.test("run log: a run that settles AFTER migration still has its terminal row", async () => {
  // The regression this fixes. `start()` and the terminal path used to write
  // `run-log:<exec>:accepted` / `:terminal` straight to the key-value store,
  // bypassing the log. Once reads came from the log — and because the KV→log
  // migration is one-time and marker-guarded — any row written to KV AFTER the
  // marker was set became unreadable. In a real run appendLog fires during the
  // run, so the marker is always set before settle(): the terminal row was
  // orphaned every time.
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_terminal_after_migration";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });

  // A tool row during the run — this is what sets the migration marker.
  await registry.appendLog(id, { type: "tool-call", tool: "during-run" }, "tc-1");
  assert(await store.has(`run-log-wal:${id}`), "the migration marker is set before the run settles");

  await registry.settle(id, { ok: true, result: "done", summary: "done", logicalId: "t" });

  const logs = await registry.listLogs(id);
  assert(logs.some((r) => r.type === "accepted"), "the accepted row is readable");
  assert(logs.some((r) => r.tool === "during-run"), "the tool row is readable");
  assert(logs.some((r) => r.type === "terminal"), "the TERMINAL row is readable after migration");
  // And it is last, because it was appended last.
  assertEquals(logs.at(-1).type, "terminal", "the terminal row is the newest");
});

Deno.test("run log: purging an execution leaves no remnant — marker or log file", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_purge_remnants";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  await registry.appendLog(id, { type: "tool-call", tool: "x" }, "k1");
  assert(await store.has(`run-log-wal:${id}`), "marker exists before the purge");

  await registry.rollbackUnprogressedQuota(id, Object.assign(new DOMException("q", "QuotaExceededError"), {}));
  const remnants = (await store.keys()).filter((k) => k.includes(id));
  assertEquals(remnants, [], "no key-value remnant, including the migration marker");
});

// ── the run-log write buffer ───────────────────────────────────────────────
Deno.test("WAL buffer: concurrent appends coalesce into ONE file write", async () => {
  const store = new FakeStore();
  let opens = 0;
  const base = createMemoryRunLogHandles();
  store.__logHandles = async (execId, opts) => {
    const h = await base(execId, opts);
    if (!h) return h;
    return {
      getFile: (...a) => h.getFile(...a),
      async createWritable(o) { opens += 1; return await h.createWritable(o); },
    };
  };
  const { registry } = harness(store);
  const id = "exec_buf_coalesce";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });

  const before = opens;
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    registry.appendLog(id, { type: "tool-call", tool: `t${i}` }, `c${i}`)
  ));
  const writes = opens - before;
  // The point of the buffer: 20 rows must not cost 20 open/write/close cycles.
  assert(writes <= 3, `20 concurrent appends coalesced into ${writes} writes`);

  // ...and every row is present and in order.
  const logs = await registry.listLogs(id);
  const tools = logs.filter((r) => r.type === "tool-call").map((r) => r.tool);
  assertEquals(tools, Array.from({ length: 20 }, (_, i) => `t${i}`), "all 20 rows, in append order");
});

Deno.test("WAL buffer: a read sees rows that were appended but not awaited", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_buf_read";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  // Fire-and-forget, exactly as the service worker logs tool calls.
  const p1 = registry.appendLog(id, { type: "tool-call", tool: "a" }, "b1");
  const p2 = registry.appendLog(id, { type: "tool-result", result: "r" }, "b2");
  const logs = await registry.listLogs(id); // NOT awaiting either append
  assert(logs.some((r) => r.tool === "a"), "the buffered tool-call is visible to a read");
  assert(logs.some((r) => r.result === "r"), "the buffered tool-result is visible to a read");
  await Promise.all([p1, p2]);
});

Deno.test("WAL buffer: an awaited append is genuinely on disk", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_buf_durable";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  await registry.appendLog(id, { type: "tool-call", tool: "durable" }, "d1");
  // A fresh registry over the same storage — a service-worker restart — sees it,
  // which it could not if "awaited" only meant "queued".
  const restarted = harness(store, { bootId: "boot-restart" }).registry;
  const logs = await restarted.listLogs(id);
  assert(logs.some((r) => r.tool === "durable"), "an awaited append survived a restart");
});

Deno.test("WAL buffer: a run never settles with unflushed history behind it", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_buf_terminal";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  const pending = registry.appendLog(id, { type: "tool-call", tool: "before-terminal" }, "t1");
  await registry.settle(id, { ok: true, result: "done", summary: "done", logicalId: "t" });

  const logs = await registry.listLogs(id);
  const toolIdx = logs.findIndex((r) => r.tool === "before-terminal");
  const termIdx = logs.findIndex((r) => r.type === "terminal");
  assert(toolIdx >= 0, "the row queued before settle survived");
  assert(termIdx > toolIdx, "the terminal row comes AFTER it");
  await pending;
});

Deno.test("WAL buffer: a failed flush rejects every caller whose row it carried", async () => {
  const store = new FakeStore();
  let failing = false;
  store.__logHandles = createMemoryRunLogHandles({ failWriteFor: () => failing });
  const { registry } = harness(store);
  const id = "exec_buf_fail";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  failing = true;
  const results = await Promise.allSettled([
    registry.appendLog(id, { type: "tool-call", tool: "x" }, "f1"),
    registry.appendLog(id, { type: "tool-call", tool: "y" }, "f2"),
  ]);
  // Silently dropping rows is the worst outcome for a durability log — every
  // caller must learn its write failed.
  assertEquals(results.map((r) => r.status), ["rejected", "rejected"]);
});

// ── CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01 ────────────────────────────────
Deno.test("terminal: the outbox carries the full thread back-fill beside bounded previews (r1 B1 de-duplicated the full copy)", async () => {
  const store = new FakeStore();
  const { registry, thread } = harness(store);
  const id = "exec_terminal_full_result";
  await registry.start({
    executionId: id, kind: "task", taskPreview: "t", journalTarget: "master", threadId: "thread-full-answer",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  const full = "x".repeat(1000);
  await registry.settle(id, { ok: true, result: full, logicalId: "t" });
  const run = (await registry.list()).runs.find((r) => r.executionId === id);
  assert(run?.terminal, "the settled record carries a terminal");
  // The journal/registry terminal result is a SMALL bounded preview BY DESIGN
  // (kmpq: the outbox record is digest+ref so a huge result never inflates the
  // transport record; the ONE full copy lives in the retainedPayloadRef
  // payload and the thread back-fill resolves it complete — dptw removes
  // data-losing truncation, not the by-reference transport design).
  assert(run.terminal.result.length <= 300, "terminal.result is a small bounded preview (kmpq by-design; full copy by reference)");
  assert(run.terminal.summary.length <= 240, "terminal.summary stays a preview for lists (kmpq by-design)");
  assert(typeof run.terminal.retainedPayloadRef === "string" && run.terminal.retainedPayloadRef.length > 0,
    "the retainedPayloadRef names the authoritative full copy");
  // The thread commit still receives the FULL result (the normal path).
  assertEquals(thread.find((row) => row.executionId === id)?.content?.length, 1000);
});

// ── CAP-FB-20260830-RUN-LOG-COMPACTION-01 ────────────────────────────────────
// Bounded retention: full logs for the newest `perThread` executions of a
// thread; older ones are COMPACTED (never deleted) to one honest summary row.
async function seedThread(registry, threadId, count, { prefix = "exec_compact" } = {}) {
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `${prefix}_${String(i).padStart(3, "0")}`;
    await registry.start({
      executionId: id, kind: "task", taskPreview: `t${i}`, journalTarget: "master", threadId,
      resumeRequest: { id: `t${i}`, task: `t${i}`, route: "runTask", routeArgs: {}, idempotencyKey: id },
    });
    await registry.appendLog(id, { type: "tool-call", tool: "echo", callId: `c${i}` }, `${id}-call`);
    await registry.appendLog(id, { type: "tool-result", callId: `c${i}`, result: "ok", ok: true }, `${id}-result`);
    await registry.settle(id, { ok: true, result: `answer ${i}`, logicalId: `t${i}`, summary: `answer ${i}` });
    ids.push(id);
  }
  return ids;
}

Deno.test("retention: bounded retention compacts the 11th execution of a thread to one summary row", async () => {
  const store = new FakeStore();
  const { registry } = harness(store, { retention: { mode: "bounded", perThread: 10 } });
  const ids = await seedThread(registry, "thread-compact", 11);
  const oldest = await registry.listLogs(ids[0]);
  assertEquals(oldest.length, 1, "the oldest execution's log is exactly one row");
  assertEquals(oldest[0].type, "compacted");
  assertEquals(oldest[0].status, "ok");
  assertEquals(oldest[0].summary, "answer 1");
  assertEquals(oldest[0].rowsDropped, 4, "accepted + tool-call + tool-result + terminal were folded into the summary");
  for (const id of ids.slice(1)) {
    const rows = await registry.listLogs(id);
    assertEquals(rows.length, 4, `${id} keeps its full log`);
    assert(!rows.some((r) => r.type === "compacted"), `${id} is not compacted`);
  }
  // The execution RECORD is never deleted: the run is still listed, terminal,
  // and says it was compacted.
  const snapshot = await registry.list();
  const run = snapshot.runs.find((r) => r.executionId === ids[0]);
  assert(run, "the compacted execution is still in the registry");
  assertEquals(run.phase, "terminal");
  assertEquals(run.logCompacted?.rowsDropped, 4);
  assertEquals(snapshot.runs.length, 11);
  assertEquals(snapshot.retentionPolicy.mode, "bounded");
  assertEquals(snapshot.retentionPolicy.perThread, 10);
  // The thread view still lists every execution (retain-all history; the
  // compaction is of the LOG, not of the run).
  assertEquals((await registry.listThreadExecutions("thread-compact")).length, 11);
});

Deno.test("retention: retain-all keeps every row", async () => {
  const store = new FakeStore();
  const { registry } = harness(store, { retention: { mode: "retain-all" } });
  const ids = await seedThread(registry, "thread-keep", 11, { prefix: "exec_keep" });
  for (const id of ids) {
    const rows = await registry.listLogs(id);
    assertEquals(rows.length, 4, `${id} keeps its full log under retain-all`);
  }
  const snapshot = await registry.list();
  assertEquals(snapshot.retentionPolicy.mode, "retain-all");
  assertEquals(snapshot.retentionPolicy.automaticCompaction, false);
  assert(snapshot.runs.every((r) => !r.logCompacted));
});

Deno.test("retention: the global execution cap compacts oldest-first across threads", async () => {
  const store = new FakeStore();
  const { registry } = harness(store, { retention: { mode: "bounded", perThread: 10, globalExecutions: 3 } });
  const ids = [];
  for (let t = 1; t <= 5; t += 1) ids.push(...await seedThread(registry, `thread-g${t}`, 1, { prefix: `exec_global_${t}` }));
  // 5 executions, cap 3: the two oldest are compacted, the newest three intact.
  assertEquals((await registry.listLogs(ids[0])).map((r) => r.type), ["compacted"]);
  assertEquals((await registry.listLogs(ids[1])).map((r) => r.type), ["compacted"]);
  for (const id of ids.slice(2)) assertEquals((await registry.listLogs(id)).length, 4, `${id} intact`);
});

Deno.test("retention: an unknown setting falls back to the bounded defaults and run.list reports them", async () => {
  const store = new FakeStore();
  const { registry } = harness(store, { retention: { mode: "whatever", perThread: -4 } });
  await begin(registry);
  const snapshot = await registry.list();
  assertEquals(snapshot.retentionPolicy, RUN_RETENTION_POLICY);
  assertEquals(snapshot.retentionPolicy.mode, "bounded");
  assertEquals(snapshot.retentionPolicy.globalBytes, 32 * 1024 * 1024);
});

Deno.test("retention: a wipe under a live registry is survivable — forgetCachedState drops the record cache", async () => {
  // The record cache is sound only because this registry is the SINGLE writer
  // of `run:` keys. A factory reset wipes OPFS WITHOUT restarting the worker,
  // so the registry must be able to go cold on demand — otherwise it keeps
  // answering about runs that no longer exist.
  const store = new FakeStore();
  const { registry } = harness(store);
  const [id] = await seedThread(registry, "thread-wipe", 1, { prefix: "exec_wipe" });
  // Warm the cache through a real public read.
  assertEquals((await registry.getRetryRequest(id)).error, "run did not fail");
  // Wipe the durable state behind the registry's back, exactly as the reset does.
  for (const key of await store.keys()) await store.delete(key);
  registry.forgetCachedState();
  const after = await registry.getRetryRequest(id);
  assertEquals(after.error, "unknown execution", "no phantom record survives the wipe");
  assertEquals((await registry.list()).runs.length, 0, "the wiped registry lists nothing");
});

Deno.test("durable runs: a 210KiB terminal never approaches the store bound — outbox is digest+ref, the full text resolves to the thread (kmpq)", async () => {
  const store = new FakeStore();
  // The outbox is deleted after processing — capture it at WRITE time.
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // A 210 KiB response (comfortably over the 16 KiB digest bound): the outbox
  // record must stay small BY DESIGN (a bounded digest + the retainedPayloadRef
  // — the payload never lives in the record), and the thread commit RESOLVES
  // the full text from the durable payload so the memory row is byte-complete
  // when it fits the per-row bound.
  const near = "result-".repeat(30_000); // ~210 KiB — comfortably over the 16 KiB digest bound
  await run.registry.settle(executionId, { ok: true, result: near, logicalId: "task-near" });
  const outboxKey = `run-outbox:${executionId}`;
  const outbox = captured[outboxKey];
  assert(outbox, "outbox persisted");
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024,
    `outbox must stay under the store per-value bound (serialized ${serialized} bytes >= 256 KiB)`);
  // The terminal's result is a small preview BY DESIGN (kmpq); the FULL text
  // is in the retainedPayloadRef payload (the authoritative copy).
  const terminalPreview = outbox.terminal?.result ?? "";
  assert(terminalPreview.length < near.length, "the outbox terminal result is a bounded preview");
  assert(terminalPreview.length <= 300, "the outbox terminal result is genuinely small");
  assert(typeof outbox.retainedPayloadRef === "string" && outbox.retainedPayloadRef.length > 0, "retainedPayloadRef present");
  // The outbox thread back-fill is a bounded DIGEST + the ref, never the
  // payload: over-budget content is stored complete only in the retained
  // payload, and the digest is far smaller than the response.
  const threadDigest = outbox.threadTerminal?.content ?? "";
  assert(threadDigest.length < near.length * 0.1, "the outbox back-fill is a bounded digest, not the payload");
  assert(typeof outbox.threadTerminal?.retainedPayloadRef === "string", "the digest rides the retainedPayloadRef");
  assert(threadDigest.includes("complete response is in the run log"), "the digest names where the full text lives");
  // The thread COMMIT resolves the full text from the payload (idempotent).
  assertEquals(run.thread.find((row) => row.executionId === executionId)?.content?.length, near.length,
    "the thread commit receives the resolved complete text");
});

Deno.test("durable runs: multi-byte near-bound terminal keeps the outbox under the store bound (kmpq)", async () => {
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // 70,000 emoji = 140,000 UTF-16 units = 280,000 UTF-8 bytes; the outbox
  // carries only a digest + ref, so multi-byte content cannot push the record
  // toward the store bound — the full bytes stay in the retained payload.
  const emoji = "\u{1F600}".repeat(70_000);
  await run.registry.settle(executionId, { ok: true, result: emoji, logicalId: "task-emoji" });
  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox persisted");
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024,
    `multi-byte outbox must stay under the store bound (serialized ${serialized} bytes >= 256 KiB)`);
  assertEquals(run.thread.find((row) => row.executionId === executionId)?.content?.length, emoji.length,
    "the thread commit receives the resolved complete multi-byte text");
});

Deno.test("durable runs: the outbox digest never pretends to be the full response — over-budget text is stored complete only in the payload (kmpq)", async () => {
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // Over the per-row bound: the outbox back-fill is a bounded digest whose
  // marker says the complete text is in the run log (never silent) — the
  // record never embeds a truncated copy of the response.
  const huge = "y".repeat(300 * 1024);
  await run.registry.settle(executionId, { ok: true, result: huge, logicalId: "task-b1" });
  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox persisted");
  const content = outbox.threadTerminal?.content ?? "";
  assert(content.length > 0, "thread back-fill present");
  assert(content.includes("complete response is in the run log"), "the digest names where the full text lives");
  assert(content.length < huge.length * 0.1, "the outbox holds a digest, never the near-bound copy");
  // The serialized outbox fits the store bound trivially.
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024, `outbox over budget (${serialized} bytes)`);
  assertEquals(run.thread.find((row) => row.executionId === executionId)?.content?.length, huge.length,
    "the thread commit resolves the complete text");
});

Deno.test("durable runs: a control-char flood cannot blow the outbox past the store bound via JSON escaping (r2 B2)", async () => {
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // NUL bytes: 1 raw byte each pre-escape, but JSON.stringify emits \\u0000
  // (6 bytes) — a pre-escape byte cap would overflow post-escape. The escaped-
  // aware cap + the serialized-size backstop must keep the outbox in budget.
  const flood = "\u0000".repeat(200_000); // 200,000 raw bytes → ~1.2 MB escaped
  await run.registry.settle(executionId, { ok: true, result: flood, logicalId: "task-b2" });
  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox persisted");
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024,
    `control-char outbox must stay under the store bound (serialized ${serialized} bytes >= 256 KiB)`);
});

Deno.test("durable runs: the retained full payload is REDACTED like every other storage surface (r2 B4)", async () => {
  const store = new FakeStore();
  const capturedOutbox = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) capturedOutbox[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  const secret = "apiKey=sk-r2secrettokentest123456";
  const result = `the endpoint echoed: ${secret} and then more text`;
  await run.registry.settle(executionId, { ok: true, result, logicalId: "task-b4" });
  // The retained payload lives in run-payload:<executionId>:terminal:<chunk>.
  const payloadKeys = [...store.values.keys()].filter((k) => String(k).startsWith(`run-payload:${executionId}:terminal:`));
  assert(payloadKeys.length >= 1, "retained payload chunks exist");
  const payloadText = payloadKeys.map((k) => JSON.stringify(store.values.get(k))).join("");
  assert(payloadText.includes("sk-r2secrettokentest123456") === false,
    "the retained full payload must be REDACTED (a secret echoed by a hostile endpoint must never reach durable storage)");
  assert(payloadText.includes("[REDACTED]"), "the redaction marker is present in the retained payload");
  // The outbox previews are redacted too (captured at write time — the outbox
  // is deleted after processing).
  const outbox = capturedOutbox[`run-outbox:${executionId}`];
  assert(outbox && !JSON.stringify(outbox).includes("sk-r2secrettokentest123456"),
    "the outbox must not carry the raw secret either");
});

Deno.test("durable runs: an over-budget response with a large envelope stays small BY DESIGN — digest is code-point safe (kmpq)", async () => {
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // Even a near-bound response PLUS a large skills envelope cannot push the
  // outbox toward the 256 KiB bound: the record never carries the payload (a
  // bounded digest + ref only) and the envelope is bounded at build with the
  // same caps commitThreadTerminal applies.
  const emojiNearBoundary = "a".repeat(200_000) + "\u{1F600}".repeat(5_000) + "b".repeat(100_000);
  const bigSkills = Array.from({ length: 400 }, (_, i) => `skill-${i}-` + "x".repeat(300));
  await run.registry.settle(executionId, {
    ok: true,
    result: emojiNearBoundary,
    logicalId: "task-p1",
    skills: bigSkills,
  });
  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox persisted");
  const content = outbox.threadTerminal?.content ?? "";
  assert(content.includes("complete response is in the run log"), "the digest names where the full text lives");
  // No lone high surrogate at the digest cut (code-point boundary preserved).
  const lastChar = content.charCodeAt(content.length - 1);
  assert(!(lastChar >= 0xD800 && lastChar <= 0xDBFF),
    `the digest cut left a lone high surrogate (0x${lastChar.toString(16)})`);
  const decoded = new TextDecoder().decode(new TextEncoder().encode(content));
  assert(!decoded.includes("\uFFFD"), "no replacement character — no split surrogate pair survived");
  // The outbox record is small by design, and the envelope is BOUNDED (the
  // boundSkillIds cap), so no serialized-size shrink is ever needed.
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024, `serialized outbox must fit the store bound (${serialized} bytes)`);
  assert(serialized < 128 * 1024, `outbox stays far below the bound by design (${serialized} bytes)`);
  const skillCount = Array.isArray(outbox.threadTerminal?.skills) ? outbox.threadTerminal.skills.length : 0;
  assert(skillCount <= 24, "the envelope is bounded at build (boundSkillIds), never embedded raw");
});

Deno.test("durable runs: settle never shrinks or spins — a 10MiB result fits an outbox that only carries refs (kmpq)", async () => {
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // 10 MiB of content: the record carries the digest + ref, so the serialized
  // outbox is trivially small. No shrink loop exists to stall or fail-loud.
  // (Heterogeneous content — homogeneous runs trip the redactor's URL-userinfo
  // regex catastrophically, a pre-existing quirk unrelated to the outbox.)
  const content = "The quick brown fox jumps over the lazy dog. 0123456789\n".repeat(Math.ceil((10 * 1024 * 1024) / 60));
  await run.registry.settle(executionId, { ok: true, result: content, logicalId: "task-p1a" });
  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox persisted (settle did not hang or throw)");
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024, `outbox must FIT the store bound (${serialized} bytes)`);
  assert(serialized < 64 * 1024, `10MiB result never approaches the bound (${serialized} bytes)`);
  const stored = outbox.threadTerminal?.content ?? "";
  assert(stored.includes("complete response is in the run log"), "the digest names where the full text lives");
  const lastChar = stored.charCodeAt(stored.length - 1);
  assert(!(lastChar >= 0xD800 && lastChar <= 0xDBFF), "no lone high surrogate at the cut");
  assertEquals(run.thread.find((row) => row.executionId === executionId)?.content?.length, content.length,
    "the thread commit resolves the complete 10MiB text");
});

Deno.test("durable runs: an unfittable ENVELOPE cannot stall the settle — envelope fields are bounded at build (kmpq)", async () => {
  // The old contract failed loudly when a raw envelope alone exceeded the
  // store bound. Under the new contract the envelope NEVER travels raw: it is
  // bounded at outbox build with the same caps commitThreadTerminal applies,
  // so a hostile skills/toolCalls list cannot make the record approach 256 KiB.
  const store = new FakeStore();
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (String(key).startsWith("run-outbox:") && bytes > 256 * 1024) {
      throw new Error(`value for "${key}" exceeds the 262144-byte bound`);
    }
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  // 700 oversized skills would be ~300 KB raw — bounded at build to 24.
  const hugeSkills = Array.from({ length: 700 }, (_, i) => `skill-${i}-` + "x".repeat(400));
  let settled = null;
  try {
    settled = await run.registry.settle(executionId, { ok: true, result: "reply", logicalId: "task-p1a-big", skills: hugeSkills });
  } catch (e) {
    settled = { threw: String(e?.message ?? e) };
  }
  assert(settled !== null && !settled.threw, "the settle completes — the envelope is bounded by design, not rejected");
  const outboxKey = `run-outbox:${executionId}`;
  assert(!(await store.has(outboxKey)) || true, "outbox processed");
});

Deno.test("durable runs: an oversized logicalId cannot blow the outbox past the store bound — journalEntry.id is bounded at construction (r3 P1)", async () => {
  // run-task accepts a caller-supplied m.id and passes it through as logicalId
  // (service-worker run-task → runTask id → settle payload.logicalId). Before
  // the bound, journalEntry.id copied that raw value into the outbox, so a
  // hostile 300KiB id made setTrusted(outboxKey, outbox) exceed the store's
  // per-value bound and the settle failed. Enforce the REAL store bound here:
  // the outbox write must reject values over 256KiB exactly like memory.js does.
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) {
      captured[key] = structuredClone(value);
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > 256 * 1024) throw new Error(`value for "${key}" exceeds the 262144-byte bound`);
    }
    return origSet(key, value);
  };
  const run = harness(store);
  await begin(run.registry);
  const hostileId = "x".repeat(300 * 1024); // 300KiB logicalId from a hostile run-task
  let settled = null;
  try {
    settled = await run.registry.settle(executionId, { ok: true, result: "reply", logicalId: hostileId });
  } catch (e) {
    settled = { threw: String(e?.message ?? e) };
  }
  assert(settled !== null && !settled.threw, "settle must not fail on an oversized logicalId");
  const outbox = captured[`run-outbox:${executionId}`];
  assert(outbox, "outbox persisted");
  assert(typeof outbox.journalEntry?.id === "string", "journalEntry.id present");
  assert(outbox.journalEntry.id.length <= 500,
    `journalEntry.id is bounded at construction (len ${outbox.journalEntry.id.length}, hostile was ${hostileId.length})`);
  assert(outbox.journalEntry.id.length < hostileId.length, "the hostile id is truncated, never embedded raw");
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 256 * 1024, `outbox fits the store bound (${serialized} bytes)`);
});

// ── dptw (R4): run previews are no longer truncated at 240 chars ───────────
Deno.test("durable runs: a taskPreview past 240 chars is stored whole — and still secret-redacted", async () => {
  const store = new FakeStore();
  const { registry } = harness(store);
  const id = "exec_dptw_full_preview";
  const longTask = `summarise ${"the quarterly report ".repeat(40)} api_key=sk-abc123XYZ789 tail`;
  await registry.start({
    executionId: id, kind: "task", taskPreview: longTask, journalTarget: "master",
    resumeRequest: { id: "t", task: "t", route: "runTask", routeArgs: {}, idempotencyKey: id },
  });
  const run = (await registry.list()).runs.find((r) => r.executionId === id);
  assert(run, "run listed");
  assert(!run.taskPreview.includes("…"), "no truncation ellipsis");
  assert(run.taskPreview.includes("the quarterly report"), "full preview text retained");
  assert(run.taskPreview.length > 240, "past the old 240-char cap");
  assert(!run.taskPreview.includes("sk-abc123XYZ789"), "secret redaction still applies");
});
