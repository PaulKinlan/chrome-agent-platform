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
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { BUILD_GATE, SERIAL, partition } from "./test-partition.mjs";
import { announce, runSerialFiles } from "./lib/serial-phase.mjs";
import { ALWAYS_ON } from "./select-tests.mjs";
import { parallelPlan } from "./lib/parallel-plan.mjs";

export const DEFAULT_PARALLEL_TIMEOUT_MS = 1800_000;
const PARALLEL_PHASE_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_TEST_TIMEOUT_MS ?? DEFAULT_PARALLEL_TIMEOUT_MS);
const PARALLEL_READY_FILE = process.env.CAP_PARALLEL_READY_FILE;
const PARALLEL_READY_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_READY_TIMEOUT_MS ?? 60_000);

function runParallel(files) {
  if (!files || files.length === 0) return Promise.resolve(0);
  // Concurrent scheduling cannot identify the stalled file. Announce every
  // candidate BEFORE spawn so even a mid-phase kill leaves names on both streams.
  announce(`run-tests: parallel phase candidates (${files.length} file(s)):\n${files.map((file) => `  - ${file}`).join("\n")}`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("deno", ["test", "-A", "--config", "deno.runner.jsonc", "--parallel", ...files], {
      stdio: "inherit",
      env: { ...process.env, CAP_TEST_RUNNER: "1" },
      detached: true,
    });

    let timedOut = false;
    let timer = null;
    let readyPoll = null;
    let readyOk = !PARALLEL_READY_FILE;

    const startPhaseTimer = () => {
      if (PARALLEL_PHASE_TIMEOUT_MS > 0 && Number.isFinite(PARALLEL_PHASE_TIMEOUT_MS)) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
          }
        }, PARALLEL_PHASE_TIMEOUT_MS);
      }
    };

    if (PARALLEL_READY_FILE) {
      const t0Ready = Date.now();
      readyPoll = setInterval(() => {
        let ready = false;
        try {
          if (existsSync(PARALLEL_READY_FILE) && statSync(PARALLEL_READY_FILE).size > 0) {
            ready = true;
          }
        } catch {}

        if (ready) {
          clearInterval(readyPoll);
          readyPoll = null;
          readyOk = true;
          startPhaseTimer();
        } else if (Date.now() - t0Ready > PARALLEL_READY_TIMEOUT_MS) {
          clearInterval(readyPoll);
          readyPoll = null;
          timedOut = true;
          announce(`\nrun-tests: parallel phase ready marker ${PARALLEL_READY_FILE} never appeared within ${PARALLEL_READY_TIMEOUT_MS / 1000}s`);
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch {}
          }
        }
      }, 50);
    } else {
      startPhaseTimer();
    }

    const onSig = (sig) => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGINT", onSigInt);
      process.kill(process.pid, sig);
    };
    const onSigTerm = () => onSig("SIGTERM");
    const onSigInt = () => onSig("SIGINT");
    process.on("SIGTERM", onSigTerm);
    process.on("SIGINT", onSigInt);

    const cleanup = () => {
      if (readyPoll) clearInterval(readyPoll);
      if (timer) clearTimeout(timer);
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGINT", onSigInt);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* clean */ }
      }
    };

    child.on("close", (code, signal) => {
      cleanup();
      // Recheck ready marker on close to avoid race where child writes marker and exits between polls
      if (PARALLEL_READY_FILE && !readyOk) {
        try {
          if (existsSync(PARALLEL_READY_FILE) && statSync(PARALLEL_READY_FILE).size > 0) {
            readyOk = true;
          }
        } catch {
          // unwritten or inaccessible
        }
      }
      if (PARALLEL_READY_FILE && !readyOk) {
        announce(`\nrun-tests: parallel phase child exited before creating ready marker ${PARALLEL_READY_FILE}`);
        resolve(124);
        return;
      }
      if (timedOut) {
        announce(`\nrun-tests: parallel phase TIMED OUT after ${PARALLEL_PHASE_TIMEOUT_MS / 1000}s`);
        announce("run-tests: TIMED-OUT PARALLEL PHASE CANDIDATE FILE(S) (culprit unconfirmed):");
        for (const file of files) announce(`  - ${file} (parallel phase timed out; individual culprit unknown)`);
        resolve(124);
        return;
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`\nrun-tests: parallel phase (${files.length} files) ${code === 0 ? "GREEN" : "FAILED"} in ${secs}s`);
      resolve(code ?? (signal ? 128 + 15 : 1));
    });

    child.on("error", (err) => {
      cleanup();
      console.error(`run-tests: parallel phase spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  const cliFiles = args.filter((f) => !f.startsWith("-"));
  let all;
  let serialFiles;
  let parallel;
  if (cliFiles.length > 0) {
    all = cliFiles.sort();
    serialFiles = all.filter((f) => SERIAL.has(f));
    parallel = all.filter((f) => !SERIAL.has(f));
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
    // Option D (chrome-agent-platform-h65e): BUILD_GATE files run in the dedicated
    // npm run test:build gate, so npm test runs only the remaining serial hazard files.
    // Preserve SERIAL declaration order so early fixtures (build-smoke) run before consumers.
    const part = partition(all);
    serialFiles = [...SERIAL].filter((f) => !BUILD_GATE.has(f));
    parallel = part.parallel;
  }

  // chrome-agent-platform-kz27: the parallel phase used to be conditional on the serial phase
  // (`if (rc === 0) …`), which meant ONE serial failure SKIPPED the ~500-file parallel phase — and the
  // always-on guards live there. So a guard violation could sit on main while the gate reported the
  // guards green, because they never ran. The plan is pure and lives in scripts/lib/parallel-plan.mjs;
  // here we only print what it decides and let the serial failure still decide the exit code.
  const t0 = Date.now();
  const serialRc = serialFiles.length ? runSerialFiles(serialFiles) : 0;
  const plan = parallelPlan({ serialRc, parallel, alwaysOn: ALWAYS_ON });
  if (plan.announce) console.error(`\n${plan.announce}`);
  const parallelRc = await runParallel(plan.files);
  const rc = serialRc === 0 ? parallelRc : serialRc;
  const deferredCount = cliFiles.length === 0 ? all.length - (serialFiles.length + parallel.length) : 0;
  console.log(
    `run-tests: ${serialFiles.length + parallel.length} files total, ${plan.skipped} skipped` +
      ` (${serialFiles.length} serial, ${parallel.length} parallel` +
      `${deferredCount ? `, ${deferredCount} deferred to npm run test:build` : ""}), wall ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  process.exit(rc);
}

// Node canonicalizes the module URL but not a symlinked argv path. Without
// realpath, a symlink invocation silently exits 0 having run no gate tests.
export function isRunTestsEntry(entry = process.argv[1]) {
  return Boolean(entry) && realpathSync(resolvePath(entry)) === fileURLToPath(import.meta.url);
}
if (isRunTestsEntry()) main();
