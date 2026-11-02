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
import { constants as osConstants } from "node:os";
import { resolve as resolvePath } from "node:path";
import { BUILD_GATE, BUILD_GATE_FILES, BUILD_GATE_REASONS, HEAVY_GATE, HEAVY_GATE_FILES, HEAVY_GATE_REASONS, READ_ONLY_DIST, SERIAL, partition } from "./test-partition.mjs";
import { announce, runReadOnlyDistBatch, runSerialFiles, runSerialLanes } from "./lib/serial-phase.mjs";
import { ALWAYS_ON } from "./select-tests.mjs";
import {
  certificationGaps,
  computeParallelPhaseTimeout,
  DEFAULT_PARALLEL_TIMEOUT_MS,
  parallelPlan,
} from "./lib/parallel-plan.mjs";
import { loadWeights, scheduleOrder } from "./lib/parallel-schedule.mjs";
import { emitGateLedger, deferredTierEntries, fullTierManifestFields, parseGateBuild } from "./lib/gate-manifest.mjs";
import { parseSuiteDurations, slowestSuites } from "./lib/parallel-durations.mjs";
import { candidateBlockLines, incompleteNote, INCOMPLETE_EXIT, incompleteRunExit, killProgress, killProgressLine } from "./lib/phase-outcome.mjs";
import { checkBrowserPrerequisite } from "./lib/browser-prerequisite.mjs";
import {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  areAllFailuresEnvironmental,
  combinePhaseExitCodes,
} from "./lib/environmental-verdict.mjs";

export { DEFAULT_PARALLEL_TIMEOUT_MS, computeParallelPhaseTimeout, areAllFailuresEnvironmental, combinePhaseExitCodes };
const PARALLEL_READY_FILE = process.env.CAP_PARALLEL_READY_FILE;
const PARALLEL_READY_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_READY_TIMEOUT_MS ?? 60_000);


function runParallel(files, phase = "parallel phase", durationsOut = null, killedOut = null, neverRanOut = null) {
  if (!files || files.length === 0) return Promise.resolve(0);
  // Concurrent scheduling cannot identify the stalled file. Announce every
  // candidate BEFORE spawn so even a mid-phase kill leaves names on both streams.
  announce(`run-tests: ${phase} candidates (${files.length} file(s)):\n${files.map((file) => `  - ${file}`).join("\n")}`);
  // Scheduling changes only order, never worker count or selected files. The off switch
  // preserves the pre-slice invocation for an A/B on the exact same committed tree.
  const scheduled = phase === "parallel phase" && process.env.CAP_PARALLEL_SCHEDULE !== "0";
  const ordered = scheduled ? scheduleOrder(files, loadWeights()) : files;
  if (scheduled) announce(`run-tests: parallel scheduler longest-first (${ordered.length} selected file(s)); Deno default workers`);
  const t0 = Date.now();
  const phaseTimeoutMs = computeParallelPhaseTimeout(files.length);
  return new Promise((resolve) => {
    let capturedOutput = "";
    // Test seam (5xg1w review): point the phase spawn at a nonexistent binary to drive the real
    // spawn-error path in a DEFAULT run (an empty-PATH child cannot: the browser prerequisite
    // refuses first). Used by tests/gate-outcome-child-run.test.ts, never by the gate.
    const child = spawn(process.env.CAP_PARALLEL_SPAWN_COMMAND || "deno", ["test", "-A", "--config", "deno.runner.jsonc", "--parallel", ...ordered], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, CAP_TEST_RUNNER: "1" },
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

    // Watchdog (qvv7k): monitor runner PID. If this runner process dies unexpectedly
    // (e.g. uncatchable SIGKILL from a gate timeout or reaper), terminate the detached
    // child's process group so no test descendants survive reparented to init (PID 1).
    let watchdog = null;
    if (child.pid) {
      try {
        watchdog = spawn(
          "sh",
          [
            "-c",
            'parent=$1; child_pgid=$2; while kill -0 "$parent" 2>/dev/null; do sleep 0.5; done; kill -9 -"$child_pgid" 2>/dev/null',
            "_",
            String(process.pid),
            String(child.pid),
          ],
          { stdio: "ignore", detached: true },
        );
        watchdog.unref();
      } catch {
        /* best-effort */
      }
    }

    const startPhaseTimer = () => {
      if (phaseTimeoutMs > 0 && Number.isFinite(phaseTimeoutMs)) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
          }
        }, phaseTimeoutMs);
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
          // Re-check marker one last time before declaring timeout to avoid polling race
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
            return;
          }
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
      if (watchdog && watchdog.pid) {
        try { process.kill(-watchdog.pid, "SIGKILL"); } catch { /* gone */ }
        try { process.kill(watchdog.pid, "SIGKILL"); } catch { /* gone */ }
      }
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGHUP", onSigHup);
      process.removeListener("SIGQUIT", onSigQuit);
      process.kill(process.pid, sig);
    };
    const onSigTerm = () => onSig("SIGTERM");
    const onSigInt = () => onSig("SIGINT");
    const onSigHup = () => onSig("SIGHUP");
    const onSigQuit = () => onSig("SIGQUIT");
    process.on("SIGTERM", onSigTerm);
    process.on("SIGINT", onSigInt);
    process.on("SIGHUP", onSigHup);
    process.on("SIGQUIT", onSigQuit);

    const onExit = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* clean */ }
      }
    };
    process.on("exit", onExit);

    const cleanup = () => {
      if (readyPoll) clearInterval(readyPoll);
      if (timer) clearTimeout(timer);
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGHUP", onSigHup);
      process.removeListener("SIGQUIT", onSigQuit);
      process.removeListener("exit", onExit);
      if (watchdog && watchdog.pid) {
        try { process.kill(-watchdog.pid, "SIGKILL"); } catch { /* gone */ }
        try { process.kill(watchdog.pid, "SIGKILL"); } catch { /* gone */ }
      }
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
        if (killedOut) killedOut.push(`${phase} child exited before its ready marker`);
        resolve(124);
        return;
      }
      if (timedOut) {
        // jtrny: a killed phase must say HOW FAR IT GOT, and must never be reported in a shape that reads
        // as completion. The old block named every candidate "culprit unconfirmed" and printed no phase
        // status line at all, so the only completion-shaped line left in the log was the planner summary
        // ("N files total … wall Xs") — which is how a 15%-done starved phase was read as a finished
        // suite plus a mysterious 568s tail. See scripts/lib/phase-outcome.mjs.
        const secsAtKill = ((Date.now() - t0) / 1000).toFixed(0);
        const progress = killProgress(files, capturedOutput);
        announce(`\nrun-tests: ${phase} TIMED OUT after ${phaseTimeoutMs / 1000}s`);
        announce(killProgressLine({ phase, files, output: capturedOutput, elapsedSecs: Number(secsAtKill) }));
        announce(`run-tests: ${phase} (${files.length} files) TIMED-OUT in ${secsAtKill}s (bound ${phaseTimeoutMs / 1000}s)`);
        for (const line of candidateBlockLines({ phase, candidates: progress.noResult, total: files.length })) {
          announce(line);
        }
        if (killedOut) {
          killedOut.push(
            `${phase} killed at its ${phaseTimeoutMs / 1000}s bound ` +
              `(${progress.completed.length}/${files.length} files had completed a test)`,
          );
        }
        resolve(124);
        return;
      }
      const signalNumber = signal ? (osConstants.signals[signal] ?? 15) : 0;
      let effectiveCode = code ?? (signal ? 128 + signalNumber : 1);
      const hasEnvironmentalMarker =
        capturedOutput.includes(ENVIRONMENTAL_REFUSAL_MARKER) ||
        capturedOutput.includes("QuietWindowRefusedError") ||
        capturedOutput.includes("ENVIRONMENT: machine is not quiet enough for this gate") ||
        capturedOutput.includes("ENVIRONMENT: ntp-boot-staging refusal") ||
        capturedOutput.includes("ENVIRONMENT: the fleet-wide heavy-gate slot is busy");
      if (effectiveCode !== 0 && hasEnvironmentalMarker) {
        // Finding P1 (Round 4 review): A passing test emitting a marker must NOT allow a
        // failing product test to exit 75. Every failed test under ERRORS must carry
        // verified environmental refusal evidence.
        const clean = capturedOutput.replace(/\x1b\[[0-9;]*[mGKH]/gu, "");
        const summaryMatch = /FAILED\b[\s\S]*?\|\s*(\d+)\s*failed/i.exec(clean);

        if (summaryMatch) {
          const failCount = Number(summaryMatch[1]);
          const allEnvironmental = areAllFailuresEnvironmental(clean);
          if (failCount > 0 && allEnvironmental) {
            effectiveCode = ENVIRONMENTAL_REFUSAL_EXIT;
          } else {
            announce(`\nrun-tests: ${phase} contains non-environmental failure(s) — preserving PRODUCT RED (exit 1)`);
          }
        } else {
          announce(`\nrun-tests: ${phase} exited non-zero with refusal marker but missing test summary — preserving exit ${effectiveCode}`);
        }
      }
      // Publish per-file test-seconds measured from this phase's own reporter
      // lines (chrome-agent-platform-6gk81): the manifest carries the full
      // map, this log line names the tail a human should re-tier or split.
      if (durationsOut) {
        const measured = parseSuiteDurations(capturedOutput);
        for (const [file, secs] of measured) {
          durationsOut.set(file, (durationsOut.get(file) ?? 0) + secs);
        }
        const slowest = slowestSuites(measured, 10);
        if (slowest.length) {
          announce(`run-tests: ${phase} slowest suites (test-seconds): ${slowest.map((s) => `${s.file} ${s.secs}s`).join(", ")}`);
        }
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const isRefusal = effectiveCode === ENVIRONMENTAL_REFUSAL_EXIT;
      const statusText = effectiveCode === 0 ? "GREEN" : isRefusal ? `REFUSED (environmental verdict, exit ${ENVIRONMENTAL_REFUSAL_EXIT})` : "FAILED";
      console.log(`\nrun-tests: ${phase} (${files.length} files) ${statusText} in ${secs}s`);
      resolve(effectiveCode);
    });

    child.on("error", (err) => {
      cleanup();
      console.error(`run-tests: ${phase} spawn error: ${err.message}`);
      // chrome-agent-platform-5xg1w review, blocker 1: a phase whose child never spawned ran NONE of
      // its files. Recording it in killedPhases puts it in the incomplete accounting (manifest
      // `incomplete` + exit 76 via incompleteRunExit), and neverRanOut carries the FILES themselves
      // so the manifest counts them in skipped/omitted — a never-spawned phase reporting skipped:0
      // is the same "zero skipped reads as complete coverage" lie (coord review, round 2).
      if (killedOut) {
        killedOut.push(`${phase} spawn error: ${err.message} — the phase never ran (${files.length} file(s) unrun)`);
      }
      if (neverRanOut) neverRanOut.push(...files);
      resolve(1);
    });
  });
}

// Keep the audit's executable-test policy tied to the runner's actual recursive
// discovery. The optional names make the policy falsifiable in memory without
// writing transient *.test.ts files during the parallel suite.
export function enumerateRunnerTests(dir = "tests", names = readdirSync(dir, { recursive: true })) {
  return names.filter((f) => String(f).endsWith(".test.ts"))
    .map((f) => `tests/${f}`).sort();
}

/**
 * Derives the test execution plan for default `npm test` runs (all tests, no CLI filter).
 * Deferrals:
 * - BUILD_GATE files are deferred to `npm run test:build` (h65e).
 * - HEAVY_GATE files are deferred to `npm run test:heavy` (o29c0).
 */
export function defaultTestPlan(all = enumerateRunnerTests()) {
  const part = partition(all);
  const serialFiles = [...SERIAL].filter((f) => !BUILD_GATE.has(f));
  const parallel = part.parallel.filter((f) => !HEAVY_GATE.has(f));
  return { serialFiles, parallel };
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
    // chrome-agent-platform-o29c0: HEAVY_GATE files run in the dedicated npm run test:heavy
    // tier, so standard npm test skips WASM and heavy binary fixtures to relieve memory and CPU pressure.
    const plan = defaultTestPlan(all);
    serialFiles = plan.serialFiles;
    parallel = plan.parallel;
  }

  // Pre-flight prerequisite check (chrome-agent-platform-jy7aj):
  // When browser-dependent tests (or the full gate suite) are to run, verify that a usable
  // browser resolves BEFORE executing any tests. If missing, REFUSE loudly with a named
  // prerequisite fault instead of letting a serial failure skip 645 files and mask the run as '1 failed'.
  const prereq = checkBrowserPrerequisite(cliFiles.length === 0 ? all : cliFiles, {
    isFullSuite: cliFiles.length === 0,
    totalFiles: serialFiles.length + parallel.length,
  });
  if (prereq.refused) {
    console.error(`\n${prereq.refusal.line}\n`);
    console.log(prereq.refusal.marker, JSON.stringify(prereq.refusal.payload));
    if (cliFiles.length === 0) {
      emitGateLedger({
        unknown: `PREREQUISITE MISSING: chrome - ${prereq.refusal.payload.filesNotRun} files not run (${prereq.report.tried.join("; ")})`,
      });
    }
    process.exit(prereq.refusal.exit);
  }

  // chrome-agent-platform-kz27: the parallel phase used to be conditional on the serial phase
  // (`if (rc === 0) …`), which meant ONE serial failure SKIPPED the ~500-file parallel phase — and the
  // always-on guards live there. So a guard violation could sit on main while the gate reported the
  // guards green, because they never ran. The plan is pure and lives in scripts/lib/parallel-plan.mjs;
  // here we only print what it decides and let the serial failure still decide the exit code.
  const t0 = Date.now();
  const serialFailures = [];
  // chrome-agent-platform-5xg1w review, blocker 1: GLOBAL-lane files whose child exited without
  // reporting are UNRUN, not failed — they come back separately so the accounting below counts them
  // (a run over unreported files is INCOMPLETE, never a completed FAIL).
  const serialUnreported = [];
  // chrome-agent-platform-1oouo: SERIAL runs as lanes when two of its three hazard classes are
  // independent (build writers vs the process-global Chrome lock/slot cluster); the load- and
  // clock-sensitive files still run ALONE, first. scripts/test-partition.mjs SERIAL_LANES pins the split.
  // w6kc0 review P1-1: the synthetic phase-0 case. Declining the serial phase entirely is the ONLY cheap way
  // to reach the skip route with every phase exit code at 0, which is the state where the forced exit and the
  // manifest's certification are load-bearing (with a real serial failure rc is already non-zero, so a
  // reverted wiring would still look red). Used by tests/gate-outcome-child-run.test.ts, never by the gate.
  const skipSerial = process.env.CAP_RUN_TESTS_SKIP_SERIAL === "1";
  const serialRc = skipSerial || !serialFiles.length
    ? 0
    : await runSerialLanes(serialFiles, { failuresOut: serialFailures, unreportedOut: serialUnreported });
  const failingFiles = serialFailures.filter((f) => f.code !== 0 && !f.isRefusal).map((f) => f.file);
  const plan = parallelPlan({ serialRc, parallel, alwaysOn: ALWAYS_ON, failingFiles });
  if (plan.announce) console.error(`\n${plan.announce}`);
  // chrome-agent-platform-w6kc0: a run that skipped files must never certify the tree, whatever the
  // guard subset did. The planner already drives rc non-zero on a serial failure; this makes the claim
  // structural rather than a consequence of which rc the phases happened to produce.
  // chrome-agent-platform-w6kc0 review P1-1: a "stop after the serial phase" seam, so the gate-outcome
  // WIRING (gap detection -> summary marker -> forced exit -> manifest certification) can be observed by a
  // CHILD RUN of this runner (tests/gate-outcome-child-run.test.ts) rather than only by unit-testing the
  // pure planner. Without a cheap seam the only way to exercise the wiring is a ~7-minute full gate, which
  // is exactly why the first cut shipped asserted-not-observed. It runs the serial phase for real, runs NO
  // parallel file, and reports every parallel file as unrun.
  const stopAfterSerial = process.env.CAP_RUN_TESTS_STOP_AFTER_SERIAL === "1";
  // What this execution did NOT run. FOUR independent sources, and every one of them has to be here: the
  // planner's skip, the parallel files a seam declined, the SERIAL files a seam declined (the w6kc0 review
  // P1 finding), and — the 5xg1w review blocker-1 finding — the GLOBAL-lane serial files whose child exited
  // WITHOUT reporting a result. Counting only parallel files meant a serial-only selection under
  // CAP_RUN_TESTS_SKIP_SERIAL had an EMPTY gap and exited 0 without running the file it was asked to run;
  // not counting unreported files meant a dead lane child exited 1 as a COMPLETED FAIL over files that
  // never ran — the same false verdict, reached through the lane machinery instead of a seam.
  const declinedSerial = skipSerial ? serialFiles.length : 0;
  const unrunSerial = declinedSerial + serialUnreported.length;
  const unrunParallelDeclined = stopAfterSerial ? parallel.length : plan.skipped;
  const plannedUnrunCount = unrunSerial + unrunParallelDeclined;
  const gaps = [];
  if (declinedSerial > 0) gaps.push(`serial phase skipped (${declinedSerial} file(s) unrun)`);
  if (serialUnreported.length > 0) {
    gaps.push(
      `serial lane child never reported a result (${serialUnreported.length} file(s) unrun): ` +
        serialUnreported.join(", "),
    );
  }
  gaps.push(...certificationGaps({ skipped: unrunParallelDeclined }));
  // A selection whose ENTIRE content was skipped is incomplete regardless of phase: nothing ran, so nothing
  // can be certified, even if the arithmetic above somehow produced no gap.
  const selectedTotal = serialFiles.length + parallel.length;
  if (selectedTotal > 0 && plannedUnrunCount >= selectedTotal && !gaps.length) {
    gaps.push(`the whole selection was skipped (${selectedTotal} file(s) unrun)`);
  }
  // Extract reviewed readers from the parallel plan; SERIAL has fully ended.
  // In the unchanged per-change runner both subsets still share its one
  // parallel process AFTER serial (partition(...).parallel is intentionally total).
  const readOnly = plan.files.filter((file) => READ_ONLY_DIST.has(file));
  const other = plan.files.filter((file) => !READ_ONLY_DIST.has(file));
  const suiteDurations = new Map();
  // jtrny: every phase the bound killed, so the planner summary can refuse to read as a completion and
  // the manifest can carry the reason instead of leaving a reader to infer it from an rc.
  const killedPhases = [];
  // 5xg1w review round 2: the selected files of a parallel child that NEVER SPAWNED. Known only after
  // the phases ran, so they join the accounting below the phase calls — counted in the summary, the
  // gaps, the manifest's skipped/omitted, and the marker, exactly like a lost serial lane.
  const neverSpawnedFiles = [];
  const readOnlyRc = stopAfterSerial ? 0 : await runReadOnlyDistBatch(readOnly,
    (files) => runParallel(files, "post-build read-only phase", suiteDurations, killedPhases, neverSpawnedFiles));
  // Preserve kz27: a failed builder OR read-only guard must not hide the
  // independent parallel guards; both phases run and the first failure wins.
  const parallelRc = stopAfterSerial ? 0 : await runParallel(other, "parallel phase", suiteDurations, killedPhases, neverSpawnedFiles);
  if (neverSpawnedFiles.length > 0) {
    gaps.push(`parallel phase child never spawned (${neverSpawnedFiles.length} file(s) unrun)`);
  }
  const unrunCount = plannedUnrunCount + neverSpawnedFiles.length;
  const rc = combinePhaseExitCodes(serialRc, readOnlyRc, parallelRc);
  // w6kc0: a skip is a certification gap regardless of the phase exit codes, so the outcome can never
  // be a plain rc. 5xg1w: and an incomplete run gets its OWN exit code (76), not the exit-1 shape of a
  // completed FAIL — a serial-phase abort that skipped 711 of 759 files used to be indistinguishable
  // from a genuine completed failure, and a content-addressed gate cache filed it as a permanent FAIL
  // for the tree. Bound-kill (124/137/143) and environmental-refusal (75) codes keep their meaning;
  // see scripts/lib/phase-outcome.mjs. A completed run's rc passes through byte-identically.
  const effectiveRc = incompleteRunExit(rc, { gaps, killedPhases });
  const gapsNote = gaps.length ? ` — INCOMPLETE: ${gaps.join("; ")}` : "";
  const buildDeferredCount = cliFiles.length === 0 ? all.filter((f) => BUILD_GATE.has(f)).length : 0;
  const heavyDeferredCount = cliFiles.length === 0 ? all.filter((f) => HEAVY_GATE.has(f)).length : 0;
  const deferredParts = [];
  if (buildDeferredCount) deferredParts.push(`${buildDeferredCount} deferred to npm run test:build`);
  if (heavyDeferredCount) deferredParts.push(`${heavyDeferredCount} deferred to npm run test:heavy`);
  const deferredSummary = deferredParts.length ? `, ${deferredParts.join(", ")}` : "";
  console.log(
    `run-tests: ${serialFiles.length + parallel.length} files total, ${unrunCount} skipped` +
      ` (${serialFiles.length} serial, ${readOnly.length} post-build read-only, ${parallel.length - readOnly.length} other parallel` +
      `${deferredSummary}), wall ${((Date.now() - t0) / 1000).toFixed(0)}s` +
      incompleteNote(killedPhases) +
      gapsNote,
  );
  if (gaps.length) {
    console.error(
      `run-tests: NOT CERTIFIABLE — ${gaps.join("; ")}. A green guard subset does not make ` +
        `this a verdict on the tree: re-run once the serial phase passes. ` +
        `INCOMPLETE verdict, exit ${effectiveRc} (${INCOMPLETE_EXIT} = files were skipped; a completed FAIL exits 1).`,
    );
  }
  // The coverage ledger for the FULL tier (chrome-agent-platform-0eq00). Only the default `npm test`
  // form is a gate; an explicit-file run (`run-tests.mjs tests/x.test.ts`) is an inner-loop tool and
  // deliberately emits nothing, so a probe run can never look like a gate record.
  if (cliFiles.length === 0) {
    const skippedFiles = [
      ...(skipSerial ? serialFiles : []),
      ...(stopAfterSerial ? parallel : parallel.filter((f) => !plan.files.includes(f))),
    ];
    // A FAST selector that failed closed passes its changed-file candidates to
    // this FULL runner. Report placement from suites that actually executed,
    // including a named reason when a heavy/build-tier suite was deferred.
    const fileMappingContext = process.env.CAP_GATE_FILE_MAPPING_JSON
      ? JSON.parse(process.env.CAP_GATE_FILE_MAPPING_JSON) : null;
    const manifest = fullTierManifestFields({
      serialFiles,
      parallelFiles: plan.files,
      skippedFiles,
      // 5xg1w review, blocker 1 + round 2: files LOST with a lane/phase that produced no result are
      // counted and named here, so the manifest's skipped/omitted disclosure covers work that was
      // LOST, not only work declined — each with the reason that is true for it.
      lostFiles: [
        ...serialUnreported.map((file) => ({
          file,
          reason: "serial lane child never reported a result — file never ran to a certified verdict in this run",
        })),
        ...neverSpawnedFiles.map((file) => ({
          file,
          reason: "parallel phase child never spawned — file never ran in this run",
        })),
      ],
      failingFiles,

      // One reason per file from the tier that owns it (review P1-B): build-behaviour files run in
      // the SAME FULL command (its npm run test:build stage), heavy files are NOT part of that
      // command at all. The per-file tables already carry the measured reason.
      deferred: deferredTierEntries({
        buildGateFiles: BUILD_GATE_FILES,
        buildGateReasons: BUILD_GATE_REASONS,
        heavyGateFiles: HEAVY_GATE_FILES,
        heavyGateReasons: HEAVY_GATE_REASONS,
      }),
      rc: effectiveRc,
      build: parseGateBuild(process.env.CAP_GATE_BUILD_JSON),
      fileMappingContext,
      suiteDurations,
      incomplete:
        [...killedPhases, ...gaps].length
          ? [...killedPhases, ...gaps].join("; ")
          : null,
    });
    emitGateLedger({
      manifest,
      fileMapping: manifest?.fileMapping ?? [],
      // The FAST tier certifies a lockfile delta by a closure; this tier must record the same trail
      // when a fail-closed FAST run hands its context across (chrome-agent-platform-lezl0).
      lockfileDelta: fileMappingContext?.lockfileDelta ?? [],
    });
  }
  // chrome-agent-platform-5xg1w: the LAST line of an incomplete run is the marker the fleet's per-tree
  // gate cache greps for (fleet-check reads tail -c 8000 of the log for "ABORTED: incomplete suite
  // run" / "phase not entered, skipped=" and classifies st=INCOMPLETE, which is re-gateable instead of
  // a cached FAIL). It must come AFTER the manifest JSON, which with hundreds of `omitted` entries can
  // be far larger than the 8000-byte tail window and would otherwise push every other signal out of it.
  if (effectiveRc === INCOMPLETE_EXIT) {
    // Files DECLINED before they could start (planner/seam) get the grep-able "phase not entered" wording;
    // files LOST to a lane child that never reported or a phase that died are named by their own gap/kill
    // entries — skipped alone must never read as the whole story (5xg1w review, blocker 2).
    const neverStarted = unrunCount - serialUnreported.length;
    const detail =
      (neverStarted > 0 ? `phase not entered, skipped=${neverStarted}; ` : "") +
      `total unrun ${unrunCount}: ${[...gaps, ...killedPhases].join("; ")}`;
    console.error(
      `run-tests: ABORTED: incomplete suite run — NOT a verdict on the tree (exit ${INCOMPLETE_EXIT}); ${detail}`,
    );
  }
  process.exit(effectiveRc);
}

// Node canonicalizes the module URL but not a symlinked argv path. Without
// realpath, a symlink invocation silently exits 0 having run no gate tests.
export function isRunTestsEntry(entry = process.argv[1]) {
  return Boolean(entry) && realpathSync(resolvePath(entry)) === fileURLToPath(import.meta.url);
}
if (isRunTestsEntry()) main();
