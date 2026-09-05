// lib/table-worker-host.js — fresh-worker host for bounded table jobs.
// The service worker owns deadlines and cancellation; operation bytes stay in
// this local extension worker and only a validated canonical result returns.

import { TABLE_LIMITS } from "./table-core.js";
import { runManagedStreamJob, STREAM_PLATFORM_LIMITS } from "./tool-stream-platform.js";

const activeJobs = new Map(); // runId -> Set<controller>
const TABLE_WORKER_PATH = "lib/table-operation-worker.js";
const WORKER_CODES = new Set([
  "table_invalid_input",
  "table_input_bound",
  "table_output_bound",
  "table_work_bound",
  "table_worker_failed",
]);

function addActive(runId, controller) {
  let set = activeJobs.get(runId);
  if (!set) {
    set = new Set();
    activeJobs.set(runId, set);
  }
  set.add(controller);
}

function removeActive(runId, controller) {
  const set = activeJobs.get(runId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) activeJobs.delete(runId);
}

function safeWorkerCode(value, fallback = "table_worker_failed") {
  return typeof value === "string" && WORKER_CODES.has(value) ? value : fallback;
}

/** Cancel every table worker owned by one settling run. Idempotent. */
export function cancelTableRun(runId) {
  const id = typeof runId === "string" ? runId : "";
  const jobs = activeJobs.get(id);
  if (!jobs) return 0;
  for (const job of [...jobs]) job.cancel();
  return jobs.size;
}

function defaultWorkerUrl() {
  // This host is bundled into dist/background/service-worker.js, while the
  // dependency-free operation worker ships from the extension's source lib/.
  // Resolve from the extension root; an import.meta-relative URL would point
  // beside the bundle after esbuild and silently 404.
  try {
    if (globalThis.chrome?.runtime?.getURL) return globalThis.chrome.runtime.getURL(TABLE_WORKER_PATH);
  } catch { /* test/non-extension realm */ }
  return new URL("./table-operation-worker.js", import.meta.url);
}

/** Execute one table operation in a fresh module Worker under the shared wall deadline. */
export async function runTableWorkerJob(job, {
  runId,
  timeoutMs = STREAM_PLATFORM_LIMITS.defaultTimeoutMs,
  WorkerCtor = globalThis.Worker,
  workerUrl = defaultWorkerUrl(),
} = {}) {
  if (typeof runId !== "string" || !runId || runId.length > 200) {
    return { ok: false, code: "table_run_required" };
  }
  if (typeof WorkerCtor !== "function") {
    return { ok: false, code: "table_worker_unavailable" };
  }

  let worker;
  let settled = false;
  let settle;
  const resultPromise = new Promise((resolve) => { settle = resolve; });
  const finish = (result) => {
    if (settled) return;
    settled = true;
    settle(result);
  };
  const controller = {
    cancel() {
      try { worker?.terminate(); } catch { /* best effort */ }
      finish({ ok: false, code: "table_cancelled" });
    },
  };

  try {
    worker = new WorkerCtor(workerUrl, { type: "module" });
  } catch {
    return { ok: false, code: "table_worker_unavailable" };
  }
  addActive(runId, controller);

  worker.onmessage = (event) => {
    const data = event?.data;
    if (data?.ok === true) {
      if (!data.table || typeof data.table !== "object" || Array.isArray(data.table) ||
          !Number.isSafeInteger(data.workUnits) || data.workUnits < 0 || data.workUnits > TABLE_LIMITS.maxWorkUnits) {
        finish({ ok: false, code: "table_worker_failed" });
        return;
      }
      finish({ ok: true, table: data.table, workUnits: data.workUnits });
    } else {
      finish({ ok: false, code: safeWorkerCode(data?.code) });
    }
  };
  worker.onerror = () => finish({ ok: false, code: "table_worker_failed" });
  worker.onmessageerror = () => finish({ ok: false, code: "table_worker_failed" });

  try {
    const result = await runManagedStreamJob(
      () => {
        try { worker.postMessage(job); }
        catch { finish({ ok: false, code: "table_worker_failed" }); }
        return resultPromise;
      },
      {
        timeoutMs,
        onTimeout: () => {
          try { worker.terminate(); } catch { /* best effort */ }
          finish({ ok: false, code: "table_timeout" });
        },
      },
    );
    if (result?.phase === "timeout") return { ok: false, code: "table_timeout" };
    return result;
  } finally {
    removeActive(runId, controller);
    try { worker.terminate(); } catch { /* best effort */ }
  }
}

export const TABLE_WORKER_RUN_TYPE = "cap:table-worker-run";
export const TABLE_WORKER_CANCEL_TYPE = "cap:table-worker-cancel";
export const TABLE_WORKER_SERVICE_WORKER_PATH = "dist/background/service-worker.js";

/** Only the extension service worker may ask the offscreen document to run or
 * cancel a table worker. Same-extension pages share sender.id, so they are not
 * sufficient authority. */
export function isTrustedTableWorkerSender(sender, runtime = chrome.runtime) {
  if (sender?.id !== runtime.id || sender?.tab != null || sender?.documentId != null) return false;
  const declared = runtime.getManifest?.()?.background?.service_worker;
  if (typeof declared === "string" && declared.length > 0 && declared !== TABLE_WORKER_SERVICE_WORKER_PATH) return false;
  return sender?.url === runtime.getURL(TABLE_WORKER_SERVICE_WORKER_PATH);
}

/** Register the offscreen table-worker host. MV3 service workers cannot
 * construct dedicated Workers, so only this owner-local document owns the
 * fresh module Worker while the service worker retains run/custody authority. */
export function registerTableWorkerHost() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== TABLE_WORKER_RUN_TYPE && message?.type !== TABLE_WORKER_CANCEL_TYPE) return undefined;
    if (!isTrustedTableWorkerSender(sender)) {
      sendResponse({ ok: false, code: "table_worker_unavailable" });
      return false;
    }
    if (message.type === TABLE_WORKER_CANCEL_TYPE) {
      const cancelled = cancelTableRun(message.runId);
      sendResponse({ ok: true, cancelled });
      return false;
    }
    runTableWorkerJob(message.job, {
      runId: message.runId,
      timeoutMs: message.timeoutMs,
    }).then(sendResponse).catch(() => sendResponse({ ok: false, code: "table_worker_failed" }));
    return true;
  });
}
