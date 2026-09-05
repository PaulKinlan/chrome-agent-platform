// @ts-nocheck
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  cancelTableRun,
  isTrustedTableWorkerSender,
  registerTableWorkerHost,
  runTableWorkerJob,
  TABLE_WORKER_CANCEL_TYPE,
  TABLE_WORKER_RUN_TYPE,
} from "../extension/lib/table-worker-host.js";

class ReplyWorker {
  static instances = [];
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.terminated = 0;
    ReplyWorker.instances.push(this);
  }
  postMessage(job) {
    queueMicrotask(() => this.onmessage?.({ data: { ok: true, table: job.table, workUnits: 9 } }));
  }
  terminate() { this.terminated++; }
}

class WaitingWorker {
  static instances = [];
  constructor() { this.terminated = 0; WaitingWorker.instances.push(this); }
  postMessage() {}
  terminate() { this.terminated++; }
}

Deno.test("table worker host uses one fresh module worker per bounded job", async () => {
  ReplyWorker.instances.length = 0;
  const a = await runTableWorkerJob({ table: { id: "a" } }, { runId: "exec:a", WorkerCtor: ReplyWorker });
  const b = await runTableWorkerJob({ table: { id: "b" } }, { runId: "exec:b", WorkerCtor: ReplyWorker });
  assertEquals(a, { ok: true, table: { id: "a" }, workUnits: 9 });
  assertEquals(b, { ok: true, table: { id: "b" }, workUnits: 9 });
  assertEquals(ReplyWorker.instances.length, 2);
  assertNotEquals(ReplyWorker.instances[0], ReplyWorker.instances[1]);
  assertEquals(ReplyWorker.instances.map((worker) => worker.options), [{ type: "module" }, { type: "module" }]);
  assert(ReplyWorker.instances.every((worker) => worker.terminated >= 1));
});

Deno.test("table worker host resolves the operation worker from the extension root after SW bundling", async () => {
  ReplyWorker.instances.length = 0;
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://unit-test/${path}` } };
  try {
    const result = await runTableWorkerJob({ table: {} }, { runId: "exec:path", WorkerCtor: ReplyWorker });
    assertEquals(result.ok, true);
    assertEquals(ReplyWorker.instances[0].url, "chrome-extension://unit-test/lib/table-operation-worker.js");
  } finally {
    globalThis.chrome = previous;
  }
});

Deno.test("offscreen table host accepts only the exact service-worker sender and runs the real host path", async () => {
  ReplyWorker.instances.length = 0;
  const previousChrome = globalThis.chrome;
  const previousWorker = globalThis.Worker;
  let listener = null;
  globalThis.chrome = {
    runtime: {
      id: "extension-id",
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      getManifest: () => ({ background: { service_worker: "dist/background/service-worker.js" } }),
      onMessage: { addListener(fn) { listener = fn; } },
    },
  };
  globalThis.Worker = ReplyWorker;
  try {
    registerTableWorkerHost();
    assert(typeof listener === "function");
    const trusted = { id: "extension-id", url: "chrome-extension://extension-id/dist/background/service-worker.js" };
    assertEquals(isTrustedTableWorkerSender(trusted), true);
    for (const sender of [
      { ...trusted, url: "chrome-extension://extension-id/ntp/ntp.html", documentId: "page" },
      { ...trusted, tab: { id: 1 } },
      { ...trusted, id: "other-extension" },
      { ...trusted, url: "" },
    ]) assertEquals(isTrustedTableWorkerSender(sender), false);

    let denied;
    const deniedAsync = listener({ type: TABLE_WORKER_RUN_TYPE, runId: "exec:denied", job: {} },
      { id: "extension-id", url: "chrome-extension://extension-id/ntp/ntp.html", documentId: "page" },
      (value) => { denied = value; });
    assertEquals(deniedAsync, false);
    assertEquals(denied, { ok: false, code: "table_worker_unavailable" });

    const response = new Promise((resolve) => {
      const keepOpen = listener({ type: TABLE_WORKER_RUN_TYPE, runId: "exec:offscreen", job: { table: { local: true } } }, trusted, resolve);
      assertEquals(keepOpen, true);
    });
    assertEquals(await response, { ok: true, table: { local: true }, workUnits: 9 });
    assertEquals(ReplyWorker.instances.length, 1);

    let cancelled;
    const cancelAsync = listener({ type: TABLE_WORKER_CANCEL_TYPE, runId: "exec:none" }, trusted,
      (value) => { cancelled = value; });
    assertEquals(cancelAsync, false);
    assertEquals(cancelled, { ok: true, cancelled: 0 });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.Worker = previousWorker;
  }
});

Deno.test("table worker host cancellation terminates the exact run's active worker", async () => {
  WaitingWorker.instances.length = 0;
  const pending = runTableWorkerJob({}, { runId: "exec:cancel", WorkerCtor: WaitingWorker, timeoutMs: 1000 });
  await Promise.resolve();
  assertEquals(cancelTableRun("exec:other"), 0);
  assertEquals(cancelTableRun("exec:cancel"), 1);
  assertEquals(await pending, { ok: false, code: "table_cancelled" });
  assert(WaitingWorker.instances[0].terminated >= 1);
});

Deno.test("table worker host cancels every concurrent fresh worker for one exact run", async () => {
  WaitingWorker.instances.length = 0;
  const first = runTableWorkerJob({ id: 1 }, { runId: "exec:parallel", WorkerCtor: WaitingWorker, timeoutMs: 1000 });
  const second = runTableWorkerJob({ id: 2 }, { runId: "exec:parallel", WorkerCtor: WaitingWorker, timeoutMs: 1000 });
  await Promise.resolve();
  assertEquals(cancelTableRun("exec:parallel"), 2);
  assertEquals(await Promise.all([first, second]), [
    { ok: false, code: "table_cancelled" },
    { ok: false, code: "table_cancelled" },
  ]);
  assertEquals(WaitingWorker.instances.length, 2);
  assert(WaitingWorker.instances.every((worker) => worker.terminated >= 1));
  assertEquals(cancelTableRun("exec:parallel"), 0, "every completion unregisters only its own controller");
});

Deno.test("table worker host enforces the shared absolute wall deadline", async () => {
  WaitingWorker.instances.length = 0;
  const started = Date.now();
  const result = await runTableWorkerJob({}, { runId: "exec:timeout", WorkerCtor: WaitingWorker, timeoutMs: 100 });
  assertEquals(result, { ok: false, code: "table_timeout" });
  assert(Date.now() - started < 1000, "deadline is bounded rather than hanging");
  assert(WaitingWorker.instances[0].terminated >= 1);
});

Deno.test("table worker host maps data-bearing worker errors to a fixed safe code", async () => {
  class FailingWorker extends ReplyWorker {
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: { ok: false, code: "table_customer_ssn_123" } }));
    }
  }
  const result = await runTableWorkerJob({}, { runId: "exec:error", WorkerCtor: FailingWorker });
  assertEquals(result, { ok: false, code: "table_worker_failed" });
});

Deno.test("table worker host terminates and unregisters workers when postMessage fails", async () => {
  class ThrowingWorker extends WaitingWorker {
    postMessage() { throw new Error("structured clone exposed private cell"); }
  }
  WaitingWorker.instances.length = 0;
  const result = await runTableWorkerJob({}, { runId: "exec:post-failure", WorkerCtor: ThrowingWorker });
  assertEquals(result, { ok: false, code: "table_worker_failed" });
  assertEquals(WaitingWorker.instances[0].terminated, 1);
  assertEquals(cancelTableRun("exec:post-failure"), 0, "a failed dispatch leaves no stale run cancellation hook");
});

Deno.test("table worker host rejects malformed success envelopes without returning worker data", async () => {
  class MalformedWorker extends ReplyWorker {
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: { ok: true, table: { private: "cell" }, workUnits: -1 } }));
    }
  }
  const result = await runTableWorkerJob({}, { runId: "exec:malformed", WorkerCtor: MalformedWorker });
  assertEquals(result, { ok: false, code: "table_worker_failed" });
});
