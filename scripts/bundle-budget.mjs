// scripts/bundle-budget.mjs — the store-target bundle size gate
// (CAP-FB-20260830-BUNDLE-BUDGET-01).
//
import { lstatSync, readlinkSync } from "node:fs";
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

/**
 * Store-target ceilings for EVERY generated bundle (minified bytes), keyed by
 * dist-relative path (chrome-agent-platform-9epn.4, perf audit #5). Before
 * this table only the SW and the agent worker had a number; ntp / sidepanel /
 * options / diff-core grew unobserved (832 867 / 635 119 / 841 261 B in the
 * 2026-10-01 audit). The UI ceilings were measured on the store build of the
 * tree that introduced them (ntp 830 013, sidepanel 633 728, options 839 829,
 * diff-core 16 611 B) and set at that size + 5 % headroom, rounded DOWN to the
 * nearest 10 kB (1 kB for diff-core). Lowering a ceiling is a ratchet (the
 * splitting bead 9epn.6 owns the next one); RAISING one is an owner decision
 * named in the change's report — never a silent edit.
 *
 * The build fails the STORE target when a bundle exceeds its ceiling
 * (build.mjs → assertBundleBudget); tests/bundle-budget.test.ts asserts the
 * same ceilings against the sizes recorded in dist/dist.complete.
 */
export const STORE_BUNDLE_BUDGETS = Object.freeze({
  "background/service-worker.js": STORE_SW_BUDGET_BYTES,
  "workers/agent-worker.js": 2_000_000,
  "options.bundle.js": 880_000,
  "ntp.bundle.js": 870_000,
  "sidepanel.bundle.js": 660_000,
  "shared/diff-core.bundle.js": 17_000,
});

/** The bundle outputs the budget report covers (relative to dist/). */
export const BUDGET_REPORTED_BUNDLES = Object.freeze(Object.keys(STORE_BUNDLE_BUDGETS));

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
 * Every Deno-store package instance in a metafile input path:
 * `node_modules/.deno/<name>@<version>[_N]/…`. Scoped packages are stored as
 * `@scope+name`; `_N` is Deno's suffix for a second peer-context instantiation
 * of the SAME exact version. Captures: [1] the store name, [2] the version
 * (suffix included).
 *
 * chrome-agent-platform-9epn.3: this used to match only
 * `ai|zod|@ai-sdk+provider-utils` (the 63et packages), so the build's "one
 * instance per exact version" invariant (docs/CONSTITUTION.md §performance)
 * was silently violated by @modelcontextprotocol/sdk@1.30.0 + _1 and
 * zod-to-json-schema@3.25.2 + _1 both shipping in the service worker. The
 * detector now covers EVERY package.
 */
const DENO_STORE_INSTANCE_RE = /\.deno\/(@?[^/@]+)@([^/]+)\//;

/**
 * chrome-agent-platform-63et (widened by 9epn.3 to every package): group the
 * Deno-store instances in a metafile per package and return only SAME-VERSION
 * peer-context duplicates — the `_N`-suffixed second instantiations of one
 * exact version (the same code bundled twice, ~500KB minified of pure
 * duplication on 2026-09-06; ~175KB pre-minify of SDK on 2026-10-01).
 * DISTINCT versions of a package are legitimate (the providers pin
 * incompatible provider-utils lines; zod majors are an owner-scope decision)
 * and are not flagged. Pure and fixture-testable: takes the metafile object,
 * returns { ["name@version"]: [".deno/name@version", ".deno/name@version_N"]
 * } for duplicated packages only (empty object when clean).
 */
export function duplicateStoreInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return {};
  const groups = {};
  for (const input of Object.keys(inputs)) {
    const m = input.match(DENO_STORE_INSTANCE_RE);
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

/** The 63et name, kept so existing callers and tests read unchanged — it is
 * the same (now package-wide) detector. */
export const duplicateAiSdkInputs = duplicateStoreInputs;

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
 * Return any .cjs input paths from zod in the metafile.
 * A CJS entrypoint pulls in CommonJS zod + dozens of locale files that
 * cannot be tree-shaken and duplicates ESM zod (d885.1). Pure.
 */
export function zodCjsInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.keys(inputs)
    .filter((p) => p.includes("zod") && p.endsWith(".cjs"))
    .sort();
}

/** If <root>/node_modules resolves through a symlink, say so in the error —
 * dependency-root layout changes measured bytes (a symlinked root measured
 * 688 bytes over budget with source unchanged, chrome-agent-platform-2eb5),
 * and the environmental-vs-product distinction should cost zero gate runs. */
function dependencyRootNote(root) {
  try {
    const nm = `${root}/node_modules`;
    if (lstatSync(nm).isSymbolicLink()) {
      return `\nNOTE: ${nm} is a SYMLINK → ${readlinkSync(nm)}. Dependency-root layout changes the measured bundle (688 bytes observed with source unchanged) — verify with a real node_modules before treating this as product growth.`;
    }
  } catch { /* no node_modules here — nothing to say */ }
  return "";
}

/**
 * The gate: `bytes` over `budgetBytes` throws an error that names the bundle,
 * the actual size, the budget, and the top contributors (when a metafile is
 * available). Returns the measured size on pass.
 */
export function assertBundleBudget({ label, bytes, budgetBytes = STORE_SW_BUDGET_BYTES, metafile = null, root = process.cwd() }) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`bundle budget: ${label} size is not measurable (${bytes})`);
  }
  if (metafile) {
    // chrome-agent-platform-63et fail-closed guards (9epn.3: the duplicate
    // guard covers EVERY package): a duplicated same-version Deno-store
    // instance or a drifted (non-Deno-store) dependency input must fail the
    // build even when the byte total still fits the budget — a mis-install
    // silently changed the shipped bundle once already, and a second
    // @modelcontextprotocol/sdk@1.30.0 shipped for weeks under a guard that
    // only watched three packages.
    const duplicates = duplicateStoreInputs(metafile);
    if (Object.keys(duplicates).length) {
      throw new Error(
        `bundle budget: duplicated same-version package instances in ${label} — ` +
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
    const cjsZod = zodCjsInputs(metafile);
    if (cjsZod.length) {
      throw new Error(
        `bundle budget: .cjs inputs from zod in ${label} (CJS+ESM double-bundling — CANON_ZOD_V4 in build.mjs must resolve to ESM .js):\n` +
        cjsZod.map((p) => `  ${p}`).join("\n"),
      );
    }
  }
  if (size > budgetBytes) {
    throw new Error(
      `bundle budget exceeded: ${label} is ${size} bytes; the store budget is ${budgetBytes}.\n` +
      `Top contributors:\n${formatContributors(metafile)}\n` +
      `Cut the largest contributors (lazy-load a feature, drop a dependency) or raise the budget with an owner decision in docs/CONSTITUTION.md.` +
      dependencyRootNote(root),
    );
  }
  return size;
}
