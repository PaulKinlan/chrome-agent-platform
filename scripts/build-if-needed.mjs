// scripts/build-if-needed.mjs — decide whether the FAST gate must pay for a store build, and never
// re-stamp a marker without building (chrome-agent-platform-0eq00, architect design arch-0eq00).
//
// WHY: every FAST gate ran `npm run build:production` unconditionally (~95 s, measured; FULL-gate
// medians a19b9/arch-0eq00), even when the dist artifacts the selected tests read were already
// valid for the exact tree. The store build is LOAD-BEARING for the subset gate — tests/owner-
// approval-security.test.ts is always-on AND imports extension/dist/shared/diff-core.bundle.js — so
// the honest saving is VALIDATE-OR-BUILD: reuse `extension/dist/dist.complete` only when the marker
// validates for THIS commit and THESE source bytes; otherwise build; if the build still leaves an
// invalid marker, FAIL CLOSED (never run against a dist the gate cannot certify).
//
// The marker's commit binding is NOT weakened here: reuse goes through dist-complete.mjs's own
// validateDistCompleteMarker, which requires the exact commit, the indexed-source digest and every
// output hash. There is deliberately no tree-only or digest-only shortcut (architect, 2026-10-14).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { READ_ONLY_DIST } from "./test-partition.mjs";
import { validateDistCompleteMarker } from "./dist-complete.mjs";

/** The build target the FAST gate's tests are written against. */
export const GATE_BUILD_TARGET = "store";

/**
 * Suite files known (by review, in scripts/test-partition.mjs) to read built artifacts. The dynamic
 * scan below catches new readers; this list is the belt for the ones the scan can miss (a file that
 * reads shipped CAS/inventory rather than the extension/dist tree).
 */
export const STATIC_DIST_CONSUMERS = Object.freeze([
  ...READ_ONLY_DIST,
  "tests/build-smoke.test.ts",
]);

// Deliberately broad: `dist`, `dist-versions`, `dist.complete`, `extension/dist/...`. A false
// positive costs one build (the status quo); a false negative would run a dist-reading test against
// a dist the gate cannot certify, which is the failure this module exists to prevent.
const DIST_REFERENCE_RE = /\bdist(?:-versions)?\b|\bdist\.complete\b/;

/** True when a test file's source references the built dist tree (over-approximating on purpose). */
export function referencesDistTree(text) {
  return DIST_REFERENCE_RE.test(String(text ?? ""));
}

/**
 * The subset of `files` that reads the built dist tree. Reads only files under tests/ (a repo-rooted
 * path from elsewhere is not a test) and tolerates unreadable files by treating them as consumers
 * (fail closed).
 * @param {string[]} files repo-relative paths
 * @param {(rel: string) => string | null} [readText] defaults to the worktree file
 * @returns {string[]} sorted
 */
export function findDistConsumers(files = [], readText = null) {
  const read = readText ?? ((rel) => {
    try {
      return readFileSync(join(process.cwd(), rel), "utf8");
    } catch {
      return null;
    }
  });
  const consumers = new Set(STATIC_DIST_CONSUMERS);
  for (const rel of files) {
    if (!String(rel).startsWith("tests/")) continue;
    if (consumers.has(rel)) continue;
    const text = read(rel);
    if (text === null || referencesDistTree(text)) consumers.add(rel);
  }
  return [...consumers].sort();
}

/**
 * Files whose bytes (or whose build behaviour) feed the generated dist. Broad on purpose: naming one
 * of these forces the build, which is only ever the conservative choice.
 */
export function isBuildInput(rel) {
  const file = String(rel ?? "").replace(/^\.\//, "");
  if (!file) return false;
  if (file === "build.mjs") return true;
  if (file === "package.json" || file === "package-lock.json") return true;
  if (/^deno\.[^/]*$/.test(file)) return true; // deno.jsonc / deno.runner.jsonc / deno.lock
  if (/^scripts\/dist-complete\.mjs$/.test(file)) return true;
  if (/^scripts\/lib\/build-[^/]*\.mjs$/.test(file)) return true;
  if (/^scripts\/build-[^/]*\.(?:mjs|js|ts)$/.test(file)) return true;
  if (/^scripts\/bundled-[^/]*\.mjs$/.test(file)) return true;
  // Every shipped extension source the store build reads (generated dist is not tracked, so this
  // never matches the artifacts themselves).
  if (file.startsWith("extension/") && !file.startsWith("extension/dist")) return true;
  return false;
}

/**
 * The build decision for one gate run (pure).
 * @param {{ kind: "subset" | "full", selected?: string[], changed?: string[], distConsumers?: string[] }} args
 * @returns {{ required: boolean, reason: string }}
 */
export function decideBuild({ kind, selected = [], changed = [], distConsumers = [] } = {}) {
  if (kind === "full") {
    return { required: true, reason: "the selector failed closed to the full suite" };
  }
  const consumers = distConsumers.filter((f) => selected.includes(f));
  if (consumers.length) {
    const named = consumers.slice(0, 3).join(", ");
    const more = consumers.length > 3 ? ` (+${consumers.length - 3} more)` : "";
    return {
      required: true,
      reason: `${named}${more} read the built extension/dist tree, so the shipped bundles must come from this tree`,
    };
  }
  const input = changed.find(isBuildInput);
  if (input) {
    return { required: true, reason: `${input} feeds the store build` };
  }
  return {
    required: false,
    reason:
      `no selected test reads extension/dist (${selected.length} selected) and no build input changed ` +
      `(${changed.length} changed)`,
  };
}

/**
 * VALIDATE-OR-BUILD. Reuses the existing marker only when it validates for this exact commit; never
 * re-stamps without building. A build that leaves an invalid marker returns disposition "failed" so
 * the caller can refuse the run instead of testing against an uncertified dist.
 * @param {{
 *   required: boolean,
 *   reason: string,
 *   root: string,
 *   distRoot?: string,
 *   validate?: () => Promise<{ ok: boolean, commit?: string | null, error?: string }>,
 *   runBuild?: () => Promise<number>,
 * }} args
 */
export async function ensureStoreBuild({
  required,
  reason,
  root,
  distRoot,
  validate,
  runBuild,
}) {
  const dist = distRoot ?? join(root, "extension", "dist");
  const validateMarker = validate ?? (async () => {
    try {
      const marker = await validateDistCompleteMarker({
        root,
        distRoot: dist,
        expectedTarget: GATE_BUILD_TARGET,
      });
      return { ok: true, commit: marker.commit };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  const build = runBuild ?? defaultRunBuild(root);

  if (!required) {
    return { disposition: "omitted", reason, secs: 0, markerCommit: null };
  }

  const t0 = Date.now();
  const existing = await validateMarker();
  if (existing.ok) {
    return {
      disposition: "reused",
      reason: "dist.complete already validates for this commit and these source bytes (no build needed)",
      secs: (Date.now() - t0) / 1000,
      markerCommit: existing.commit ?? null,
    };
  }

  const rc = await build();
  const secs = (Date.now() - t0) / 1000;
  if (rc !== 0) {
    return {
      disposition: "failed",
      reason: `store build exited ${rc} (${existing.error ?? "no valid dist.complete"})`,
      secs,
      markerCommit: null,
    };
  }
  const after = await validateMarker();
  if (!after.ok) {
    return {
      disposition: "failed",
      reason: `store build exited 0 but dist.complete still does not validate: ${after.error}`,
      secs,
      markerCommit: null,
    };
  }
  return {
    disposition: "ran",
    reason: `rebuilt: no valid dist.complete for this commit (${existing.error ?? "marker absent"})`,
    secs,
    markerCommit: after.commit ?? null,
  };
}

function defaultRunBuild(root) {
  return async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("npm", ["run", "build:production"], { cwd: root, stdio: "inherit" });
    return r.status ?? 1;
  };
}
