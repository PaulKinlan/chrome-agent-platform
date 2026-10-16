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

import { readFileSync, statSync } from "node:fs";
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

/**
 * Static tree-walking and census guards in ALWAYS_ON that mention "dist" only to skip it
 * during directory enumeration, in comments, or in AST/partition rule declarations
 * (chrome-agent-platform-omsz9). They do NOT load or read built artifacts.
 * Scoped explicitly by name to preserve fail-closed behaviour for any unverified file.
 */
export const ALWAYS_ON_TREE_SKIPPING_GUARDS = Object.freeze(new Set([
  "tests/chrome-tools-t12-static.test.ts",
  "tests/code-health.test.ts",
  "tests/composer-selector-migration.test.ts",
  "tests/dialog-confirm-modernization.test.ts",
  "tests/durable-root.test.ts",
  "tests/enrollment-authority-reader-census.test.ts",
  "tests/kat-service-worker-match.test.ts",
  // luq4w: skips generated output while walking shipped source; no built-artifact read/import.
  "tests/no-uppercase-kickers-static.test.ts",
  "tests/postmessage-wildcard-guard.test.ts",
  "tests/settings-strings-audit.test.ts",
  "tests/single-source-helpers.test.ts",
  "tests/source-inspecting-tests-guard.test.ts",
  "tests/substring-pin-honesty.test.ts",
  "tests/test-partition-guard.test.ts",
  "tests/unbundled-page-census.test.ts",
]));

// Deliberately broad for unknown test files: `dist`, `dist-versions`, `dist.complete`, `extension/dist/...`.
// A false positive costs one build (the status quo); a false negative would run a dist-reading test
// against a dist the gate cannot certify, which is the failure this module exists to prevent.
const DIST_REFERENCE_RE = /\bdist(?:-versions)?\b|\bdist\.complete\b/;

// Tightened check scoped to the 15 verified ALWAYS_ON tree-skipping guards (chrome-agent-platform-omsz9).
// These guards walk source trees and filter out dist/ or cite dist in comments/AST rules.
// They are ONLY treated as dist consumers if they actually load or read from the built extension/dist tree.
const TIGHTENED_DIST_CONSUMER_RE =
  /\bimport\s+(?:type\s+)?(?:[\w*\s{},]*from\s+)?["'][^"']*?\b(?:extension\/)?dist\/|\bimport\s*\(\s*["'][^"']*?\b(?:extension\/)?dist\/|\b(?:readTextFile|readFile|readFileSync|readTextFileSync)\s*(?:Sync)?\s*\(\s*(?:ROOT\s*\+\s*)?["'][^"']*?\bextension\/dist\/|\bdist\.complete\b/;

// The IMPORT-only form of the check, used for modules reached through a test's import graph
// (chrome-agent-platform-1l1ph). A module that IMPORTS the dist tree is a compile-time dependency of the
// selected test: Deno type-checks that graph, so on a worktree with no extension/dist the tier dies with
// TS2307 before a single test runs. A module that merely READS a dist file at runtime is deliberately not
// flagged here: the gate's own machinery (scripts/lib/serial-phase.mjs, scripts/test-partition.mjs) reads
// dist.complete to validate a build, so a read-based rule would force a build on nearly every subset gate
// and hide the next real omission. Reads are still caught for the test file itself by referencesDistTree.
const MODULE_DIST_IMPORT_RE =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},]*from\s+)?["'][^"']*?\b(?:extension\/)?dist\/|\bimport\s*\(\s*["'][^"']*?\b(?:extension\/)?dist\/|\brequire\s*\(\s*["'][^"']*?\b(?:extension\/)?dist\//;

/**
 * True when a test file's source references the built dist tree.
 * For general files, uses the broad fail-closed DIST_REFERENCE_RE.
 * For the 15 verified ALWAYS_ON tree-skipping guards, strips backtick test fixtures and comments
 * before evaluating with TIGHTENED_DIST_CONSUMER_RE to distinguish tree skipping from real loads.
 * @param {string} text
 * @param {string | null} [rel] repo-relative path of the test file
 */
export function referencesDistTree(text, rel = null) {
  if (rel && ALWAYS_ON_TREE_SKIPPING_GUARDS.has(rel)) return referencesDistTreeTight(text);
  return DIST_REFERENCE_RE.test(String(text ?? ""));
}

/**
 * The precise check: strip comments and backtick fixtures, then require an actual dist import or a
 * read of extension/dist, rather than the word "dist" appearing in a comment. Used for the verified
 * tree-skipping guards, where a comment mentioning dist must not force a build.
 */
function referencesDistTreeTight(text) {
  const stripped = stripInertText(text);
  return TIGHTENED_DIST_CONSUMER_RE.test(stripped);
}

/** Strip backtick fixtures and comments so prose about the dist tree is not read as a dependency. */
function stripInertText(text) {
  return String(text ?? "")
    .replace(/`[\s\S]*?`/g, "\"\"")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

/** True when a repo-relative path names a real FILE (not a directory, not the empty specifier). */
function existsAsFile(rel) {
  if (typeof rel !== "string" || rel === "") return false;
  try {
    return statSync(join(process.cwd(), rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * True when a module IMPORTS the dist tree (the compile-time edge Deno type-checks).
 */
function moduleImportsDistTree(text) {
  return MODULE_DIST_IMPORT_RE.test(stripInertText(text));
}

/**
 * The subset of `files` that reads the built dist tree. Reads only files under tests/ (a repo-rooted
 * path from elsewhere is not a test) and tolerates unreadable files by treating them as consumers
 * (fail closed).
 *
 * `reachableModules(rel)` (optional) returns the modules that test transitively imports. A test whose
 * IMPORT GRAPH reaches a module that IMPORTS the dist tree DOES need the built tree even when its own
 * text never says "dist": `tests/security.test.ts` -> a shared module -> `../dist/shared/…bundle.js`,
 * which Deno type-checks before a single test runs (chrome-agent-platform-1l1ph). Without the resolver
 * only direct references are seen, which is what let a fresh worktree omit the build and then fail
 * type-checking on the missing bundle.
 *
 * A test file keeps the loose mention rule it always had (a changed test that only SHOUTS about the tree
 * stays a consumer, fail-closed). A module REACHED through the graph is matched on IMPORTS only. That is
 * the compile-time edge Deno type-checks, and it keeps the omission honest: the gate's own machinery
 * (scripts/lib/serial-phase.mjs, scripts/test-partition.mjs) READS dist.complete to certify a build, so a
 * read-based rule flags 12 of the 44 always-on guards and forces a build on every gate, while prose
 * mentions in tests/-prefixed helpers flag 6 more. An omission that can never fire is a decorative
 * decision (and a permanent 17s rebuild on a cold tree).
 * @param {string[]} files repo-relative paths
 * @param {(rel: string) => string | null} [readText] defaults to the worktree file
 * @param {((rel: string) => string[]) | null} [reachableModules]
 * @returns {string[]} sorted
 */
export function findDistConsumers(files = [], readText = null, reachableModules = null) {
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
    const probe = [rel, ...(typeof reachableModules === "function" ? reachableModules(rel) ?? [] : [])];
    let consumer = false;
    for (const candidate of probe) {
      const text = (() => {
        try {
          return read(candidate);
        } catch {
          return null; // a reader that throws is an unreadable file, not a licence to omit the build
        }
      })();
      if (text === null) {
        // Fail closed for the test file itself (an unreadable test may well need the tree) and for a
        // module that is really there but unreadable. A module that does not exist cannot import the dist
        // tree, and the import graph can reach a path no longer on disk (chrome-agent-platform-1l1ph: the
        // closure of a real test reaches tests/x.mjs, which does not exist) — treating a phantom edge as a
        // consumer would force a build on every gate forever.
        if (candidate === rel || existsAsFile(candidate)) {
          consumer = true;
          break;
        }
        continue;
      }
      const hit = candidate === rel
        ? referencesDistTree(text, candidate)
        : moduleImportsDistTree(text);
      if (hit) {
        consumer = true;
        break;
      }
    }
    if (consumer) consumers.add(rel);
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
export function decideBuild({ kind, selected = [], changed = [], distConsumers = [], consumptionProof = "proven" } = {}) {
  if (kind === "full") {
    return { required: true, reason: "the selector failed closed to the full suite" };
  }
  // FAIL SAFE (chrome-agent-platform-1l1ph): when the caller could not run the import-graph part of
  // the consumer analysis, the absence of a named consumer is not evidence. Build rather than run the
  // tier against bundles this worktree may not have (a fresh worktree has no extension/dist at all).
  if (consumptionProof !== "proven") {
    return {
      required: true,
      reason:
        `the dist-consumer analysis could not be completed for this selection (${consumptionProof}), ` +
        `so the build is required rather than assume no selected test reads extension/dist`,
    };
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
