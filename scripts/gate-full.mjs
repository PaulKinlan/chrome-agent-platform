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
  const buildTier = await run("npm", ["run", "test:build"], env, root);
  return buildTier || 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFullGate();
}
