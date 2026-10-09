#!/usr/bin/env node
// scripts/run-tests.mjs — the FULL suite in ordered phases (vj4s: serial `deno
// test -A tests/` cost ~6m48s because deno runs files serially by default).
//
//   Phase 1 (serial): rebuild writers and process-global hazards.
//   Phase 2 (guarded post-build parallel): reviewed read-only dist consumers;
//     no writer can rebuild during their run without failing the gate.
//   Phase 3 (parallel): everything else, `deno test --parallel` (one worker
//     per CPU). No file in these two phases writes shared build artifacts.
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
import { BUILD_GATE, READ_ONLY_DIST, SERIAL, SERIAL_TIMING_LANE, partition } from "./test-partition.mjs";
import { announce, runReadOnlyDistBatch, runSerialFiles } from "./lib/serial-phase.mjs";
import { ALWAYS_ON } from "./select-tests.mjs";
import { parallelPlan } from "./lib/parallel-plan.mjs";
import { loadWeights, parallelJobs, scheduleOrder } from "./lib/parallel-schedule.mjs";
import { startTypeCheck } from "./lib/type-check.mjs";

export const DEFAULT_PARALLEL_TIMEOUT_MS = 1800_000;
const PARALLEL_PHASE_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_TEST_TIMEOUT_MS ?? DEFAULT_PARALLEL_TIMEOUT_MS);
const PARALLEL_READY_FILE = process.env.CAP_PARALLEL_READY_FILE;
const PARALLEL_READY_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_READY_TIMEOUT_MS ?? 60_000);

export function areAllFailuresEnvironmental(cleanOutput) {
  const errorsIndex = cleanOutput.indexOf(" ERRORS ");
  if (errorsIndex === -1) return false;

  const failuresIndex = cleanOutput.indexOf(" FAILURES ", errorsIndex);
  const errorsText = failuresIndex !== -1
    ? cleanOutput.slice(errorsIndex, failuresIndex)
    : cleanOutput.slice(errorsIndex);

  // Each failure in Deno test error output starts with "\n\n<test_name> =>" or "\n<test_name> =>"
  const errorBlocks = errorsText.split(/\n+(?=[^\s\n].*?=>\s*)/).slice(1);
  if (errorBlocks.length === 0) return false;

  for (const block of errorBlocks) {
    const isRefusal =
      block.includes("CAP_ENVIRONMENTAL_REFUSAL") ||
      block.includes("BootStagingEnvironmentalRefusalError") ||
      block.includes("ENVIRONMENT: ntp-boot-staging refusal");
    if (!isRefusal) {
      return false;
    }
  }

  return true;
}

function runParallel(files, phase = "parallel phase", { noCheck = false } = {}) {
  if (!files || files.length === 0) return Promise.resolve(0);
  // Concurrent scheduling cannot identify the stalled file. Announce every
  // candidate BEFORE spawn so even a mid-phase kill leaves names on both streams.
  announce(`run-tests: ${phase} candidates (${files.length} file(s)):\n${files.map((file) => `  - ${file}`).join("\n")}`);
  // gate-speed: an explicit worker count and longest-first order (scripts/lib/parallel-schedule.mjs).
  // The ordered list is a permutation of `files` — the candidates announced above are what runs.
  const jobs = parallelJobs();
  const ordered = scheduleOrder(files, loadWeights());
  console.log(`run-tests: ${phase} runs ${files.length} file(s) on ${jobs} deno worker(s), longest-first (CAP_TEST_JOBS overrides)`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let capturedOutput = "";
    const child = spawn("deno", ["test", "-A", ...(noCheck ? ["--no-check"] : []), "--config", "deno.runner.jsonc", "--parallel", ...ordered], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, CAP_TEST_RUNNER: "1", DENO_JOBS: String(jobs) },
      detached: true,
    });
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        capturedOutput += chunk.toString();
        process.stdout.write(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        capturedOutput += chunk.toString();
        process.stderr.write(chunk);
      });
    }

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
          announce(`\nrun-tests: ${phase} ready marker ${PARALLEL_READY_FILE} never appeared within ${PARALLEL_READY_TIMEOUT_MS / 1000}s`);
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
        announce(`\nrun-tests: ${phase} child exited before creating ready marker ${PARALLEL_READY_FILE}`);
        resolve(124);
        return;
      }
      if (timedOut) {
        announce(`\nrun-tests: ${phase} TIMED OUT after ${PARALLEL_PHASE_TIMEOUT_MS / 1000}s`);
        announce(`run-tests: TIMED-OUT ${phase.toUpperCase()} CANDIDATE FILE(S) (culprit unconfirmed):`);
        for (const file of files) announce(`  - ${file} (${phase} timed out; individual culprit unknown)`);
        resolve(124);
        return;
      }
      let effectiveCode = code ?? (signal ? 128 + 15 : 1);
      if (effectiveCode !== 0 && capturedOutput.includes("CAP_ENVIRONMENTAL_REFUSAL")) {
        // Finding P1 (Round 4 review): A passing test emitting a marker must NOT allow a
        // failing product test to exit 75. Every failed test under ERRORS must carry
        // verified environmental refusal evidence.
        const clean = capturedOutput.replace(/\x1b\[[0-9;]*[mGKH]/gu, "");
        const summaryMatch = /FAILED\b[\s\S]*?\|\s*(\d+)\s*failed/i.exec(clean);

        if (summaryMatch) {
          const failCount = Number(summaryMatch[1]);
          const allEnvironmental = areAllFailuresEnvironmental(clean);
          if (failCount > 0 && allEnvironmental) {
            effectiveCode = 75;
          } else {
            announce(`\nrun-tests: ${phase} contains non-environmental failure(s) — preserving PRODUCT RED (exit 1)`);
          }
        } else {
          announce(`\nrun-tests: ${phase} exited non-zero with refusal marker but missing test summary — preserving exit ${effectiveCode}`);
        }
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const isRefusal = effectiveCode === 75;
      const statusText = effectiveCode === 0 ? "GREEN" : isRefusal ? "REFUSED (environmental verdict, exit 75)" : "FAILED";
      console.log(`\nrun-tests: ${phase} (${files.length} files) ${statusText} in ${secs}s`);
      resolve(effectiveCode);
    });

    child.on("error", (err) => {
      cleanup();
      console.error(`run-tests: ${phase} spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

/** Start the timing lane as a child (scripts/lib/serial-lane.mjs). Its output goes straight to this
 *  process's stdout/stderr (inherited fds, not a pipe: the artifact lane blocks the event loop in
 *  spawnSync), so each of its lines — headers, failures, its own phase summary — appears live. */
function startSerialLane(files) {
  if (!files.length) return { done: Promise.resolve(0) };
  console.log(`run-tests: serial TIMING lane (${files.length} file(s)) runs beside the artifact lane: ${files.join(", ")}`);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./lib/serial-lane.mjs", import.meta.url)), "--no-check", ...files], {
    stdio: "inherit",
    env: process.env,
  });
  const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  process.on("exit", kill);
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      announce(`run-tests: serial TIMING lane failed to start: ${error?.message ?? error}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      process.removeListener("exit", kill);
      resolve(code ?? (signal ? 128 + 15 : 1));
    });
  });
  return { done };
}

// Keep the audit's executable-test policy tied to the runner's actual recursive
// discovery. The optional names make the policy falsifiable in memory without
// writing transient *.test.ts files during the parallel suite.
export function enumerateRunnerTests(dir = "tests", names = readdirSync(dir, { recursive: true })) {
  return names.filter((f) => String(f).endsWith(".test.ts"))
    .map((f) => `tests/${f}`).sort();
}

export async function main(args = process.argv.slice(2)) {
  const cliFiles = args.filter((f) => !f.startsWith("-"));
  let all;
  let serialFiles;
  let parallel;
  if (cliFiles.length > 0) {
    all = cliFiles.sort();
    const part = partition(all);
    serialFiles = part.serial;
    parallel = part.parallel;
  } else {
    // Recursive: `deno test tests/` walks subdirectories, so this walk must too
    // (a non-recursive readdir would silently drop future tests/**/ nested files).
    all = enumerateRunnerTests();
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
  // gate-speed: ONE type check of every file this run executes, beside the serial phase (see
  // scripts/lib/type-check.mjs). Files run with --no-check only under a GREEN check; a red check
  // fails the run and the parallel phases fall back to checking themselves, exactly as before.
  const checked = [...serialFiles, ...parallel];
  const typeCheck = startTypeCheck(checked);
  const killCheck = () => { try { typeCheck.child?.kill("SIGKILL"); } catch { /* gone */ } };
  process.on("exit", killCheck);
  console.log(`run-tests: type-checking ${checked.length} file(s) up front, beside the serial phase (log: ${typeCheck.log})`);
  // gate-speed: the timing lane (SERIAL_TIMING_LANE — wall-clock/lock files with no build-artifact
  // hazard) runs in a child beside the artifact lane; both finish before any parallel phase.
  const timingLane = serialFiles.filter((f) => SERIAL_TIMING_LANE.has(f));
  const artifactLane = serialFiles.filter((f) => !SERIAL_TIMING_LANE.has(f));
  const lane = startSerialLane(timingLane);
  const artifactRc = artifactLane.length ? runSerialFiles(artifactLane, { noCheck: true }) : 0;
  const timingRc = await lane.done;
  const serialRc = artifactRc !== 0 ? artifactRc : timingRc;
  const check = await typeCheck.done;
  process.removeListener("exit", killCheck);
  const checkRc = check.code === 0 ? 0 : (check.code || 1);
  if (checkRc === 0) {
    console.log(`run-tests: type check GREEN (${checked.length} file(s)) in ${check.secs.toFixed(0)}s`);
  } else {
    announce(`\nrun-tests: TYPE CHECK FAILED (exit ${check.code}) for this run's ${checked.length} file(s) — log: ${typeCheck.log}`);
    if (check.output.trim()) console.error(check.output.replace(/\n$/, ""));
    announce("run-tests: the serial phase ran unchecked; the parallel phases run WITH their own check, and the run FAILS.");
  }
  const noCheck = checkRc === 0;
  const plan = parallelPlan({ serialRc, parallel, alwaysOn: ALWAYS_ON });
  if (plan.announce) console.error(`\n${plan.announce}`);
  // Extract reviewed readers from the parallel plan; SERIAL has fully ended.
  // In the unchanged per-change runner both subsets still share its one
  // parallel process AFTER serial (partition(...).parallel is intentionally total).
  const readOnly = plan.files.filter((file) => READ_ONLY_DIST.has(file));
  const other = plan.files.filter((file) => !READ_ONLY_DIST.has(file));
  const readOnlyRc = await runReadOnlyDistBatch(readOnly,
    (files) => runParallel(files, "post-build read-only phase", { noCheck }));
  // Preserve kz27: a failed builder OR read-only guard must not hide the
  // independent parallel guards; both phases run and the first failure wins.
  const parallelRc = await runParallel(other, "parallel phase", { noCheck });
  const rc = serialRc || checkRc || readOnlyRc || parallelRc;
  const deferredCount = cliFiles.length === 0 ? all.length - (serialFiles.length + parallel.length) : 0;
  console.log(
    `run-tests: ${serialFiles.length + parallel.length} files total, ${plan.skipped} skipped` +
      ` (${serialFiles.length} serial, ${readOnly.length} post-build read-only, ${parallel.length - readOnly.length} other parallel` +
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
