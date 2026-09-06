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

/** The AI SDK packages whose duplicated Deno-store instances the
 * chrome-agent-platform-63et guard refuses to bundle. */
const AI_SDK_DUPLICATE_RE = /\.deno\/(ai|zod|@ai-sdk\+provider-utils)@([^/]+)\//;

/**
 * chrome-agent-platform-63et: group the AI SDK Deno-store instances in a
 * metafile per package and return only SAME-VERSION peer-context duplicates
 * — the `_N`-suffixed second instantiations of one exact version (the same
 * code bundled twice, ~500KB minified of pure duplication on 2026-09-06).
 * DISTINCT versions of a package are legitimate (the providers pin
 * incompatible provider-utils lines; zod majors are an owner-scope decision)
 * and are not flagged. Pure and fixture-testable: takes the metafile object,
 * returns { ["name@version"]: [".deno/name@version", ".deno/name@version_N"]
 * } for duplicated packages only (empty object when clean).
 */
export function duplicateAiSdkInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return {};
  const groups = {};
  for (const input of Object.keys(inputs)) {
    const m = input.match(AI_SDK_DUPLICATE_RE);
    if (!m) continue;
    const pkg = m[1].replaceAll("+", "/");
    const base = m[2].replace(/_\d+$/, "");
    (groups[`${pkg}@${base}`] ??= new Set()).add(`.deno/${m[1]}@${m[2]}`);
  }
  const duplicates = {};
  for (const [key, instances] of Object.entries(groups)) {
    if (instances.size > 1) duplicates[key] = [...instances].sort();
  }
  return duplicates;
}

/**
 * chrome-agent-platform-63et lockfile-drift guard: every dependency input in
 * the bundle must come from the Deno store layout (node_modules/.deno/…)
 * that `deno install` + deno.lock produce. A bare node_modules/… input path
 * means the install state drifted (npm-era leftovers, manual copies) — the
 * exact mis-install that silently produced a 272KB-bloated bundle on
 * 2026-09-06 while the primary checkout measured 2,999,957. Returns the
 * offending input paths, sorted. Pure.
 */
export function nonDenoStoreInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.keys(inputs)
    .filter((p) => p.includes("node_modules/") && !p.includes("node_modules/.deno/"))
    .sort();
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
  if (metafile) {
    // chrome-agent-platform-63et fail-closed guards: a duplicated AI SDK
    // instance or a drifted (non-Deno-store) dependency input must fail the
    // build even when the byte total still fits the budget — a mis-install
    // silently changed the shipped bundle once already.
    const duplicates = duplicateAiSdkInputs(metafile);
    if (Object.keys(duplicates).length) {
      throw new Error(
        `bundle budget: duplicated same-version AI SDK instances in ${label} — ` +
        Object.entries(duplicates)
          .map(([pkg, instances]) => `${pkg}: ${instances.join(", ")}`)
          .join("; ") +
        `\nOne instance per exact version is the build invariant (distinct versions are fine); the cap-ai-sdk-dedup plugin in build.mjs owns the fix.`,
      );
    }
    const drifted = nonDenoStoreInputs(metafile);
    if (drifted.length) {
      throw new Error(
        `bundle budget: non-Deno-store dependency inputs in ${label} (lockfile drift — run deno install; an npm-era install silently changes the shipped bundle):\n` +
        drifted.map((p) => `  ${p}`).join("\n"),
      );
    }
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
