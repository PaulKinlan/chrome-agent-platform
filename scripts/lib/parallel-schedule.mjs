// scripts/lib/parallel-schedule.mjs — HOW the parallel phase runs its files: how many deno workers,
// and in which order (gate-speed, 2026-10-08). WHICH files run is decided elsewhere
// (scripts/test-partition.mjs + scripts/lib/parallel-plan.mjs); this module only orders and sizes,
// so it cannot drop or add a file — scheduleOrder() returns a permutation of its input, and
// tests/parallel-schedule.test.ts pins that.
//
// WHY THE WORKER COUNT: `deno test --parallel` defaults to one worker per CPU (2 on the fleet's
// 2-vCPU VMs). Measured on the hub (2 vCPU, origin/main 1f79854): the 476 s parallel phase spent
// 15-50% of whole stretches IDLE, because both workers sat in tests that wait — real timeouts,
// spawned children, Chrome round trips — while ~600 CPU-light files queued behind them.
//
// WHY THE ORDER: deno starts files in the order given. Alphabetical order put the single heaviest
// file (tests/wasm-sync-workspace.test.ts, ~60 s of pure CPU) at +505 s, where it ran ALONE for the
// last ~60 s of the phase. Longest-first (LPT) scheduling starts the known-heavy files first so
// their tail overlaps the light ones. The weights are MEASURED seconds (scripts/lib/test-weights.json);
// a file without a weight is light by default and keeps its alphabetical place after the heavy ones.
// A stale weight can only make the schedule worse, never change what runs.
import { readFileSync } from "node:fs";
import os from "node:os";

/** Default deno worker count for the parallel phase: 3 per CPU, at least 4, at most 16.
 *  CAP_TEST_JOBS (a positive integer) wins outright. */
export function parallelJobs({ env = process.env, cpus = os.availableParallelism?.() ?? os.cpus().length } = {}) {
  const explicit = Number(env?.CAP_TEST_JOBS ?? NaN);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const n = Number.isFinite(cpus) && cpus > 0 ? cpus : 2;
  return Math.max(4, Math.min(16, n * 3));
}

/** The committed weights table: { "tests/x.test.ts": seconds }. Unreadable → {} (ordering only). */
export function loadWeights(url = new URL("./test-weights.json", import.meta.url)) {
  try {
    const parsed = JSON.parse(readFileSync(url, "utf8"));
    return parsed && typeof parsed.weights === "object" ? parsed.weights : {};
  } catch {
    return {};
  }
}

/** Longest-first permutation of `files`: weighted files by descending weight, then the rest in
 *  their given order. Pure; never adds, drops or duplicates a file. */
export function scheduleOrder(files, weights = {}) {
  const idx = new Map(files.map((f, i) => [f, i]));
  const w = (f) => (Object.hasOwn(weights, f) && Number.isFinite(weights[f]) ? weights[f] : 0);
  return [...files].sort((a, b) => (w(b) - w(a)) || (idx.get(a) - idx.get(b)));
}
