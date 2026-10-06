#!/usr/bin/env node
// scripts/run-tests.mjs — the FULL suite in two phases (vj4s: serial `deno
// test -A tests/` cost ~6m48s because deno runs files serially by default).
//
//   Phase 1 (serial): tests that BUILD the extension or assert on shared
//     build artifacts in THIS worktree (extension/dist, dist-versions,
//     bundled-tool CAS). They rewrite/verify the same paths; racing them
//     against each other or against dist readers failed 9 tests (par1 run).
//   Phase 2 (parallel): everything else, `deno test --parallel` (one worker
//     per CPU). No file in this phase writes shared build artifacts.
//     NOTE: Phase 2 includes REAL-BROWSER execution (tests/chrome-profile-location.test.ts
//     unconditionally launches Chromium under a unit-scope lockPath; see docs/CHROME-TEST-CONTRACT.md).
//
// Coverage is complete by construction: every tests/*.test.ts runs exactly
// once; the serial set is validated to exist, and NEW test files default to
// the parallel set (the safe default — a new build-artifact test that races
// fails loudly and belongs in SERIAL with its reason).
//
// A bare `deno test -A tests/` sweep is REFUSED (deno.jsonc excludes
// tests/*.test.ts; tests/00-use-npm-test_test.ts prints the commands): agents
// kept running the serial sweep per edit (Paul, 2026-09-04). The runner passes
// --config deno.runner.jsonc to see every file.
// This script is the merge gate via `npm test`; explicit files still run directly.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SERIAL, partition } from "./test-partition.mjs";
import { runSerialFiles } from "./lib/serial-phase.mjs";
import { ALWAYS_ON } from "./select-tests.mjs";
import { parallelPlan } from "./lib/parallel-plan.mjs";

export const DEFAULT_PARALLEL_TIMEOUT_MS = 1800_000;
const PARALLEL_PHASE_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_TEST_TIMEOUT_MS ?? DEFAULT_PARALLEL_TIMEOUT_MS);

function announce(line) {
  console.log(line);
  console.error(line);
}

export function runParallel(files) {
  if (!files || files.length === 0) return 0;
  const t0 = Date.now();
  const r = spawnSync("deno", ["test", "-A", "--config", "deno.runner.jsonc", "--parallel", ...files], {
    stdio: "inherit",
    env: { ...process.env, CAP_TEST_RUNNER: "1" },
    timeout: PARALLEL_PHASE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    detached: true,
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (r.pid) {
      try { process.kill(-r.pid, "SIGKILL"); } catch { /* gone */ }
    }
    announce(`\nrun-tests: parallel phase TIMED OUT after ${PARALLEL_PHASE_TIMEOUT_MS / 1000}s`);
    return 124;
  }
  // Safety: kill any remaining process group descendants so orphaned background processes
  // (e.g. leftover browser children or background test workers) cannot linger past process.exit.
  if (r.pid) {
    try { process.kill(-r.pid, "SIGKILL"); } catch { /* clean */ }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nrun-tests: parallel phase (${files.length} files) ${r.status === 0 ? "GREEN" : "FAILED"} in ${secs}s`);
  return r.status ?? 1;
}

export function main(args = process.argv.slice(2)) {
  const cliFiles = args.filter((f) => !f.startsWith("-"));
  let all;
  let serialFiles;
  if (cliFiles.length > 0) {
    all = cliFiles.sort();
    serialFiles = all.filter((f) => SERIAL.has(f));
  } else {
    // Recursive: `deno test tests/` walks subdirectories, so this walk must too
    // (a non-recursive readdir would silently drop future tests/**/ nested files).
    all = readdirSync("tests", { recursive: true })
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `tests/${f}`)
      .sort();
    const missing = [...SERIAL].filter((f) => !all.includes(f));
    if (missing.length > 0) {
      console.error(`run-tests: SERIAL names files that do not exist: ${missing.join(", ")}`);
      process.exit(2);
    }
    serialFiles = [...SERIAL];
  }
  const { parallel } = partition(all);

  // chrome-agent-platform-kz27: the parallel phase used to be conditional on the serial phase
  // (`if (rc === 0) …`), which meant ONE serial failure SKIPPED the ~500-file parallel phase — and the
  // always-on guards live there. So a guard violation could sit on main while the gate reported the
  // guards green, because they never ran. The plan is pure and lives in scripts/lib/parallel-plan.mjs;
  // here we only print what it decides and let the serial failure still decide the exit code.
  const t0 = Date.now();
  const serialRc = serialFiles.length ? runSerialFiles(serialFiles) : 0;
  const plan = parallelPlan({ serialRc, parallel, alwaysOn: ALWAYS_ON });
  if (plan.announce) console.error(`\n${plan.announce}`);
  const parallelRc = runParallel(plan.files);
  const rc = serialRc === 0 ? parallelRc : serialRc;
  console.log(`run-tests: ${all.length} files total, ${plan.skipped} skipped, wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(rc);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
