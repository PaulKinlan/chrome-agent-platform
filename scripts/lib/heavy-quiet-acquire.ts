// scripts/lib/heavy-quiet-acquire.ts — the ONE way a wall-clock heavy-tier suite should start
// (chrome-agent-platform-rvht7, coord's option (a): acquire exclusivity instead of hoping for it).
//
// WHY: the heavy tier runs `deno test --parallel` over ~20 RAM/CPU-saturating WASM and Pyodide suites, and
// tests/ntp-boot-staging-timing.test.ts measures wall-clock budgets (median long tasks, composer-ready,
// thread-list-hydrated) on that same box. So the suite asserted "the box is quiet" from INSIDE the least quiet
// job on the machine — measured refusal at load1 5.25-5.8 on 8 cores against CAP_QUIET_MAX_LOAD_PER_CORE=0.35,
// with sibling rustc/esbuild/cargo builders on the box. That is not a product red and not a quiet box: it is a
// suite that never had the right to measure, coin-flipping every run.
//
// WHAT THIS DOES: before a single millisecond of budget is measured, WAIT for a real quiet window
// (lib/quiet-window.ts — load/core, active heavy builder JOBS, sustained across consecutive samples) up to a
// BOUNDED deadline, and report how long it waited. If the window never arrives: print the environmental
// refusal marker with attribution and throw QuietWindowRefusedError, which the serial/parallel runners already
// classify as environmental (exit 75) rather than a FAIL. Never unbounded, never a product red.
//
// The bound is CAP_QUIET_ACQUIRE_MS (default 180 s). It is deliberately SEPARATE from CAP_QUIET_WAIT_MS: the
// journey gate's 10-minute wait is sized for a UI gate that runs once, while a heavy-tier suite that waits ten
// minutes to start has already cost more than the tier it belongs to.
import {
  ENVIRONMENTAL_REFUSAL_MARKER,
  QuietWindowRefusedError,
  requireQuietWindow,
  type LoadSample,
  type ProcCpuMap,
  type QuietSpec,
} from "./quiet-window.ts";

export const DEFAULT_ACQUIRE_MS = 180_000;

/** Parse the bound, refusing anything that is not a finite positive number of milliseconds.
 *  A NaN/Infinity/negative env var must not become an unbounded wait: the gate would hang instead of refusing,
 *  and a hang is indistinguishable from a slow suite. */
export function resolveAcquireMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ACQUIRE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ACQUIRE_MS;
  return Math.floor(n);
}

export interface AcquireHooks {
  sample?: (prev?: ProcCpuMap | null) => Promise<LoadSample>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  notice?: (line: string) => void;
  error?: (line: string) => void;
}

export interface AcquireResult {
  waitedMs: number;
  boundMs: number;
}

/**
 * Wait for a quiet window, or refuse environmentally.
 *
 * @throws QuietWindowRefusedError — after printing the environmental marker with the bound and the reason.
 */
export async function acquireQuietWindowForHeavyRun(
  options: { spec?: QuietSpec; boundMs?: number; hooks?: AcquireHooks; label?: string } = {},
): Promise<AcquireResult> {
  const hooks = options.hooks ?? {};
  const boundMs = options.boundMs ?? resolveAcquireMs(Deno.env.get("CAP_QUIET_ACQUIRE_MS"));
  const label = options.label ?? "heavy-tier wall-clock suite";
  const notice = hooks.notice ?? ((line: string) => console.error(line));
  const error = hooks.error ?? ((line: string) => console.error(line));

  const spec: QuietSpec = { ...(options.spec ?? {}), maxWaitMs: boundMs };
  try {
    const { waitedMs } = await requireQuietWindow(spec, {
      sample: hooks.sample,
      sleep: hooks.sleep,
      now: hooks.now,
      notice,
    });
    // A wait nobody can see is indistinguishable from a suite that is simply slower than it used to be.
    if (waitedMs > 0) console.log(`[quiet-acquire] ${label}: quiet window acquired after ${waitedMs} ms (bound ${boundMs} ms)`);
    return { waitedMs, boundMs };
  } catch (e) {
    if (e instanceof QuietWindowRefusedError) {
      error(
        `${ENVIRONMENTAL_REFUSAL_MARKER} ${JSON.stringify({
          reason: "no-quiet-window",
          suite: label,
          waitedMs: e.waitedMs,
          boundMs,
        })}`,
      );
      error(e.message);
    }
    throw e;
  }
}
