// scripts/lib/parallel-schedule.mjs — HOW the parallel phase orders its files
// (gate-speed, 2026-10-08). Deno keeps its default worker count. WHICH files run is decided elsewhere
// (scripts/test-partition.mjs + scripts/lib/parallel-plan.mjs); this module only orders and sizes,
// so it cannot drop or add a file — scheduleOrder() returns a permutation of its input, and
// tests/parallel-schedule.test.ts pins that.
//
// WHY THE ORDER: deno starts files in the order given. On historical tree 1f79854,
// alphabetical order put the single heaviest file (tests/wasm-sync-workspace.test.ts,
// ~60 s of pure CPU) at +505 s, where it ran ALONE for the last ~60 s of the phase. Longest-first (LPT) scheduling starts the known-heavy files first so
// their tail overlaps the light ones. The weights are MEASURED seconds (scripts/lib/test-weights.json);
// a file without a weight is light by default and keeps its alphabetical place after the heavy ones.
// A stale weight can only make the schedule worse, never change what runs.
import { readFileSync } from "node:fs";

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
