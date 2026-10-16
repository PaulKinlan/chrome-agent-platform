// The merger's FULL gate uses the same exact-commit/source/output validation as
// the FAST gate. This does NOT transfer dist between worktrees or re-stamp a
// marker: a new merge commit still builds once. Only an already-certified dist
// for this exact tip can avoid paying for the initial production build again.
// The separate build-behaviour tier still invokes real builds by design.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoreBuild } from "./build-if-needed.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const BUILD_INFRA_PATTERNS = Object.freeze([
  /^build\.mjs$/,
  /^scripts\/build-.*\.mjs$/,
  /^scripts\/lib\/.*build.*\.mjs$/,
  /^scripts\/lib\/wasm-.*\.mjs$/,
  /^scripts\/gate-full\.mjs$/,
  /^scripts\/select-tests\.mjs$/,
  /^packages\/bundled\//,
  /^deno\.runner\.jsonc$/,
  /^package\.json$/,
  /^package-lock\.json$/,
]);

export function hasBuildInfraChanges(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    // If null/undefined/non-array, or if changedFiles is empty (e.g. unknown delta / single commit / git failure),
    // fail closed: trigger test:build.
    return true;
  }
  return changedFiles.some((file) => BUILD_INFRA_PATTERNS.some((pat) => pat.test(file)));
}

export function defaultGetChangedFiles(root = ROOT, options = {}) {
  try {
    let base = options?.baseRef;
    if (!base) {
      const explicitBaseIdx = process.argv.indexOf("--base");
      if (explicitBaseIdx !== -1 && process.argv[explicitBaseIdx + 1]) {
        base = process.argv[explicitBaseIdx + 1];
      }
    }
    if (!base) {
      // Try merge-base of origin/main and HEAD
      const mb = spawnSync("git", ["merge-base", "origin/main", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      });
      if (mb.status === 0 && mb.stdout?.trim()) {
        base = mb.stdout.trim();
      }
    }
    if (!base) {
      // Fallback: check if HEAD~1 exists
      const rev = spawnSync("git", ["rev-parse", "--verify", "HEAD~1"], {
        cwd: root,
        encoding: "utf8",
      });
      if (rev.status === 0) {
        base = "HEAD~1";
      }
    }

    if (base) {
      const diff = spawnSync("git", ["diff", "--name-only", `${base}..HEAD`], {
        cwd: root,
        encoding: "utf8",
      });
      if (diff.status === 0 && diff.stdout !== undefined) {
        return diff.stdout.trim().split("\n").filter(Boolean);
      }
    } else {
      // Root commit with no base: inspect commit tree
      const show = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      });
      if (show.status === 0 && show.stdout !== undefined) {
        return show.stdout.trim().split("\n").filter(Boolean);
      }
    }
  } catch {}
  return [];
}

function runCommand(command, args, env, root) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) console.error(`gate-full: ${args.join(" ")} could not start: ${result.error.message}`);
  return result.status ?? 1;
}

export async function runFullGate({
  root = ROOT,
  ensure = ensureStoreBuild,
  run = runCommand,
  log = console.error,
  selectiveBuildTier = process.argv.includes("--selective-build-tier"),
  getChanged = defaultGetChangedFiles,
} = {}) {
  let build;
  try {
    build = await ensure({
      required: true,
      reason: "FULL gate runs dist-consuming tests and requires a certified store build",
      root,
    });
  } catch (error) {
    log(`gate-full: build validation failed: ${error?.message ?? String(error)}`);
    return 1;
  }
  log(`gate-full: build-if-needed: ${build.disposition} in ${build.secs.toFixed(1)}s — ${build.reason}`);
  if (build.disposition !== "ran" && build.disposition !== "reused") return 1;

  const env = { ...process.env, CAP_GATE_BUILD_JSON: JSON.stringify(build) };
  const tested = await run("npm", ["test"], env, root);
  if (tested !== 0) return tested || 1;

  let shouldRunBuildTier = true;
  if (selectiveBuildTier) {
    const changed = typeof getChanged === "function" ? getChanged(root) : defaultGetChangedFiles(root);
    shouldRunBuildTier = hasBuildInfraChanges(changed);
    if (!shouldRunBuildTier) {
      log(
        "gate-full: selective build tier: skipping test:build (no build infrastructure changed in this delta; build-smoke verified in npm test)",
      );
    }
  }

  if (shouldRunBuildTier) {
    const buildTier = await run("npm", ["run", "test:build"], env, root);
    return buildTier || 0;
  }
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFullGate();
}
