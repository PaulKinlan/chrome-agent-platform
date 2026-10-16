/**
 * Shared load-conditional retry primitives for gate-load resilient tests (chrome-agent-platform-ri0x8).
 * Provides clean dependency injection seams so warm-retry paths under CPU scheduling preemption
 * or transient renderer load can be tested deterministically without manufacturing real host load.
 */

import { type LoadSample, type ResolvedSpec } from "./quiet-window.ts";

export interface LoadRetryDeps {
  readLoadSample?: () => Promise<any>;
  isQuiet?: (sample: any, spec: any) => boolean;
  resolveSpec?: () => any;
  environmentLine?: (sample: any) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

/**
 * Executes a parsing or computation function, measuring elapsed time against a budget.
 * Under host CPU contention (!isQuiet), retries up to 3 times on a warm cycle with fresh stats.
 */
export async function measureWithLoadRetry(
  run: (stats: { steps: number }) => void | Promise<void>,
  budgetMs: number,
  deps: LoadRetryDeps = {},
): Promise<{ elapsed: number; stats: { steps: number }; retried: boolean }> {
  let stats = { steps: 0 };
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  await run(stats);
  let elapsed = now() - t0;
  let retried = false;

  if (elapsed >= budgetMs) {
    let readLoadSample = deps.readLoadSample;
    let isQuiet = deps.isQuiet;
    let resolveSpec = deps.resolveSpec;
    if (!readLoadSample || !isQuiet || !resolveSpec) {
      const qw = await import("./quiet-window.ts");
      readLoadSample = readLoadSample ?? (qw.readLoadSample as any);
      isQuiet = isQuiet ?? qw.isQuiet;
      resolveSpec = resolveSpec ?? qw.resolveSpec;
    }
    const sample = await readLoadSample!().catch(() => null);
    if (sample && sample.measurable && !isQuiet!(sample, resolveSpec!())) {
      for (let retry = 0; retry < 3; retry++) {
        retried = true;
        const freshStats = { steps: 0 };
        const tRetry = now();
        await run(freshStats);
        const retryElapsed = now() - tRetry;
        if (retryElapsed < budgetMs) {
          elapsed = retryElapsed;
          stats = freshStats;
          break;
        }
      }
    }
  }
  return { elapsed, stats, retried };
}

/**
 * Counts keys in a memory store, retrying up to 5 times on a warm cycle if elapsed time
 * exceeds budgetMs on a measurably non-quiet host.
 */
export async function countStoreKeysWithLoadRetry(
  countFn: () => Promise<string>,
  maxKeys: number,
  budgetMs = 5,
  deps: LoadRetryDeps = {},
): Promise<{ keyCount: string; elapsed: number; retried: boolean }> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const warn = deps.warn ?? ((msg: string) => console.warn(msg));

  const t0 = now();
  const keyCount = await countFn();
  let elapsed = now() - t0;
  let retried = false;

  if (elapsed >= budgetMs) {
    let readLoadSample = deps.readLoadSample;
    let isQuiet = deps.isQuiet;
    let resolveSpec = deps.resolveSpec;
    if (!readLoadSample || !isQuiet || !resolveSpec) {
      const qw = await import("./quiet-window.ts");
      readLoadSample = readLoadSample ?? (qw.readLoadSample as any);
      isQuiet = isQuiet ?? qw.isQuiet;
      resolveSpec = resolveSpec ?? qw.resolveSpec;
    }
    const sample = await readLoadSample!().catch(() => null);
    if (sample && sample.measurable && !isQuiet!(sample, resolveSpec!())) {
      warn(`[LOAD-RETRY] countStoreKeys took ${elapsed.toFixed(2)}ms under host contention, retrying on warm cycle...`);
      for (let retry = 0; retry < 5; retry++) {
        retried = true;
        const retryT0 = now();
        const retryCount = await countFn();
        const retryElapsed = now() - retryT0;
        if (retryElapsed < budgetMs) {
          elapsed = retryElapsed;
          break;
        }
        await sleep(20);
      }
    }
  }

  return { keyCount, elapsed, retried };
}

/**
 * Wraps Page.captureSnapshot in a poll loop to absorb transient renderer "Failed to generate MHTML"
 * errors under host CPU contention, providing honest failure diagnostics if all attempts exhaust.
 */
export async function captureSnapshotWithRetry(
  cdp: { send: (method: string, params?: any, sessionId?: string) => Promise<any> },
  sessionId: string,
  maxAttempts = 24,
  deps: LoadRetryDeps = {},
): Promise<{ status: string | null; attempts: number }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let imageStatus = null;
  let attempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    try {
      const snapshot = await cdp.send("Page.captureSnapshot", { format: "mhtml" }, sessionId);
      const mhtml = String(snapshot.result?.data ?? "").replace(/=\r?\n/g, "");
      if (mhtml.includes("image-loaded:20")) { imageStatus = "loaded:20"; break; }
      if (mhtml.includes("image-blocked:0")) { imageStatus = "blocked:0"; break; }
    } catch (e) {
      if (attempt === maxAttempts - 1) {
        let readLoadSample = deps.readLoadSample;
        let environmentLine = deps.environmentLine;
        if (!readLoadSample || !environmentLine) {
          const qw = await import("./quiet-window.ts");
          readLoadSample = readLoadSample ?? (qw.readLoadSample as any);
          environmentLine = environmentLine ?? qw.environmentLine;
        }
        const sample = await readLoadSample!().catch(() => null);
        throw new Error(`Page.captureSnapshot failed after ${maxAttempts} attempts [${environmentLine!(sample)}]: ${(e as any)?.message ?? e}`);
      }
    }
    await sleep(250);
  }

  return { status: imageStatus, attempts };
}
