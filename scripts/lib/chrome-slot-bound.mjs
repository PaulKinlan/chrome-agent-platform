// chrome-slot-bound.mjs — the browser concurrency bound, readable from BOTH runtimes.
// chrome-agent-platform-i7p87
//
// Why this file exists at all, rather than the number just living in chrome-slots.ts:
// the bound is consumed in two places that run under different runtimes. The semaphore
// itself is `chrome-slots.ts` (Deno, used by suites), but the number a lane needs to see
// WHEN A PHASE GOES RED is printed by `scripts/run-tests.mjs`, which is plain node. A .ts
// module cannot be imported from node, so the choice was: duplicate the default (two
// numbers that drift, and a stale copy is exactly the class of bug this repo keeps
// paying for), or put the one value in a module both can load. This is that module.
//
// i7p87's question was "how many browsers can this phase have live at once". Answering it
// from the code was easy (4 by default, min'd against Deno's worker count); answering it
// in the log of a failed run was not, and a lane reading a red phase should not have to
// go and find out.

/** Default bound — a MEMORY bound, not a correctness bound (see chrome-slots.ts). */
export const DEFAULT_MAX_CONCURRENT_CHROMES = 4;

/** Read one environment variable portably: Deno when present, node otherwise. */
function readEnv(name) {
  const deno = globalThis.Deno?.env?.get;
  if (typeof deno === "function") return globalThis.Deno.env.get(name);
  const proc = globalThis.process?.env;
  return proc ? proc[name] : undefined;
}

/**
 * The concurrency bound, read per call. Unparsable → the default; anything
 * below 1 → 1 (0 would deadlock every launch on the machine); fractional
 * bounds floor.
 * @param {(name: string) => string | undefined} [env] injectable for tests
 * @returns {number}
 */
export function maxConcurrentChromes(env = readEnv) {
  const raw = env("CAP_CHROME_MAX_CONCURRENT");
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_CONCURRENT_CHROMES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT_CHROMES;
  return Math.max(1, Math.floor(parsed));
}

/**
 * How many test modules the parallel phase runs at once, for the same
 * announcement: Deno's `--parallel` defaults to the CPU count, and DENO_JOBS
 * overrides it. Kept beside the browser bound because the phase's real browser
 * concurrency is min(these two) — and nothing in this repo sets DENO_JOBS, so
 * the worker count is currently whatever the hardware reports.
 * @param {{ cpus?: number, env?: (name: string) => string | undefined }} [opts]
 * @returns {number}
 */
export function parallelWorkerCount({ cpus = 0, env = readEnv } = {}) {
  const raw = env("DENO_JOBS");
  const parsed = raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  return Math.max(1, Math.floor(Number(cpus) || 0));
}

/**
 * The one line a reader needs when a phase goes red: what ran, and how much of it
 * could touch a browser at once.
 * @param {{ cpus?: number, env?: (name: string) => string | undefined }} [opts]
 * @returns {string}
 */
export function concurrencyNotice({ cpus = 0, env = readEnv } = {}) {
  const workers = parallelWorkerCount({ cpus, env });
  const browsers = maxConcurrentChromes(env);
  const live = Math.min(workers, browsers);
  return `deno workers=${workers}, chrome slots=${browsers} → at most ${live} browser(s) live`;
}
