// scripts/bundle-budget.mjs — the store-target bundle size gate
// (CAP-FB-20260830-BUNDLE-BUDGET-01).
//
// The constitution watches the service-worker bundle (docs/CONSTITUTION.md):
// unmeasured growth shipped 4.56 MB against a ~2.5 MB note in Aug 2026 because
// nothing in the build failed when it grew. This module is the teeth: the
// store build FAILS when the service-worker bundle exceeds the budget, and the
// error names the top contributor inputs so the fix direction is obvious.
//
// The budget measures the MINIFIED store bundle (the bytes the Store package
// actually ships). The developer build stays unminified with source maps
// (CAP-FB-20260826-OBSERVABILITY-01) and only warns.

/** Store-target service-worker budget: 3.0 MB minified. */
export const STORE_SW_BUDGET_BYTES = 3_000_000;

/** The bundle outputs the budget report covers (relative to dist/). */
export const BUDGET_REPORTED_BUNDLES = Object.freeze([
  "background/service-worker.js",
  "options.bundle.js",
  "workers/agent-worker.js",
  "shared/diff-core.bundle.js",
]);

/**
 * The top contributor inputs of an esbuild metafile, largest first.
 * Pure and fixture-testable: takes the metafile object, returns
 * [{ input, bytes }] with repo-relative-ish paths as esbuild reports them.
 */
export function topContributors(metafile, limit = 15) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.entries(inputs)
    .map(([input, info]) => ({ input, bytes: Number(info?.bytes) || 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, Math.max(1, limit));
}

/** Format the contributor list for the build log / gate failure. */
export function formatContributors(metafile, limit = 15) {
  const rows = topContributors(metafile, limit);
  if (rows.length === 0) return "(no metafile inputs)";
  return rows.map((r) => `  ${String(r.bytes).padStart(9)}  ${r.input}`).join("\n");
}

/**
 * The gate: `bytes` over `budgetBytes` throws an error that names the bundle,
 * the actual size, the budget, and the top contributors (when a metafile is
 * available). Returns the measured size on pass.
 */
export function assertBundleBudget({ label, bytes, budgetBytes = STORE_SW_BUDGET_BYTES, metafile = null }) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`bundle budget: ${label} size is not measurable (${bytes})`);
  }
  if (size > budgetBytes) {
    throw new Error(
      `bundle budget exceeded: ${label} is ${size} bytes; the store budget is ${budgetBytes}.\n` +
      `Top contributors:\n${formatContributors(metafile)}\n` +
      `Cut the largest contributors (lazy-load a feature, drop a dependency) or raise the budget with an owner decision in docs/CONSTITUTION.md.`,
    );
  }
  return size;
}
