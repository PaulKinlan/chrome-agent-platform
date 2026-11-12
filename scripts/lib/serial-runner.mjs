// scripts/lib/serial-runner.mjs — bounded child execution with readiness handshake
// for serial phase test fixtures (chrome-agent-platform-5nhz).
import { spawn } from "node:child_process";
import { bestEffortWrite, createWriteCounters } from "./best-effort-write.mjs";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import {
  classifyReadyMarkerTimeout,
  currentStealFractionSync,
  measuredReadyLoad,
  readinessStealSignal,
  stealSampleSync,
} from "./serial-phase.mjs";

const [file, readyFile, timeoutMsStr, readyTimeoutMsStr, injectedReadyLoadStr, injectedReadyStealStr] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsStr || "10000");
const readyTimeoutMs = Number(readyTimeoutMsStr || "60000");

// yqhb2: the sentinel writes we attempted and the ones that landed, so a silent zero is impossible.
const SENTINEL_WRITES = createWriteCounters();
if (process.env.CAP_SERIAL_SENTINEL_REPORT === "1") {
  process.on("exit", () => { console.error(`runSerialFile: sentinel writes attempted=${SENTINEL_WRITES.attempted} written=${SENTINEL_WRITES.written} failed=${SENTINEL_WRITES.failed}`); });
}

// chrome-agent-platform-tf96x: leave a SENTINEL naming us, so the detached fixture we are about to
// spawn can tell when we are gone. The fixture runs in its own process group ON PURPOSE, which also
// means nothing above us can kill it — measured 2026-10-23, a fixture orphaned by a bound-killed
// gate ran 120 minutes until the reaper swept it. The fixture polls /proc/<this pid> and exits when
// we disappear; the write is best-effort and cleans up with the scratch dir like everything else.
// yqhb2: best-effort, but NOT silent. A discarded failure here means the fixture we are about to
// spawn cannot tell when we die — it will orphan on a bound kill (that is why this exists). The
// attempt/success/failure is counted and announced, so "we could not leave a sentinel" is
// distinguishable from "there was nothing to leave".
bestEffortWrite(
  { write: writeFileSync, counters: SENTINEL_WRITES, label: `runner sentinel ${file}.runner` },
  `${file}.runner`,
  String(process.pid),
);

const child = spawn("deno", ["test", "-A", "--config", "deno.runner.jsonc", file], {
  stdio: "inherit",
  env: { ...process.env, CAP_TEST_RUNNER: "1" },
  detached: true,
});

let readyOk = !readyFile;
let timedOut = false;
let timer = null;
let poll = null;
let readyVerdict = null;
const parseSeam = (s) => (s === undefined || s === "undefined" ? undefined : Number(s));
const injectedReadyLoad = parseSeam(injectedReadyLoadStr);
// cqxo3: steal is the contention signal loadavg cannot see (a stolen box
// deschedules the child's cold boot with a SHORT runnable queue), so the
// readiness classification samples it at the soft deadline beside the load.
const injectedReadySteal = parseSeam(injectedReadyStealStr);

const startTimeout = () => {
  timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, timeoutMs);
};

if (readyFile) {
  const t0 = Date.now();
  // lzccc: cumulative counters bracketing the wait. Their difference is the share of the
  // WHOLE wait lost to hypervisor steal — so a bursty host that is quiet at the deadline is
  // still seen, and a quiet host that catches one burst no longer earns grace it did not earn.
  // CAP_SERIAL_STEAL_STAT lets a fixture serve its own /proc/stat: the child runs during the
  // wait, so a test can show the window a stolen wait and prove the runner READ it, not just
  // that the seam works.
  const statPath = process.env.CAP_SERIAL_STEAL_STAT || "/proc/stat";
  const readStat = () => readFileSync(statPath, "utf8");
  const stealAtStart = injectedReadySteal === undefined ? stealSampleSync({ readFile: readStat }) : null;
  poll = setInterval(() => {
    let ready = false;
    try {
      if (existsSync(readyFile) && statSync(readyFile).size > 0) {
        ready = true;
      }
    } catch {
      // not yet written or mid-write
    }

    if (ready) {
      clearInterval(poll);
      poll = null;
      readyOk = true;
      startTimeout();
    } else if (Date.now() - t0 > readyTimeoutMs) {
      // The execution timer begins ONLY after the marker. At the first ready
      // deadline, classify current load rather than killing a healthy child
      // whose Deno cold boot has not yet received CPU time. Grace is x4 max.
      readyVerdict ??= classifyReadyMarkerTimeout({
        baseMs: readyTimeoutMs,
        // kzy5x: ABSOLUTE load, so an 8-core box at load 5.5 is not read as idle and the cold boot gets grace.
        loadPerCpu: injectedReadyLoad === undefined ? measuredReadyLoad() : injectedReadyLoad,
        // cqxo3: and steal, so a 65%-stolen box with a quiet loadavg is not read as idle either.
        steal: readinessStealSignal({
          startJiffies: stealAtStart,
          endJiffies: stealAtStart ? stealSampleSync({ readFile: readStat }) : null,
          // The seam is the WINDOW's value: a test that injects 0.8 asserts what the wait
          // experienced, exactly like a real bursty host.
          instantFraction: injectedReadySteal === undefined ? currentStealFractionSync() : injectedReadySteal,
        }).fraction,
      });
      if (readyVerdict.cause === "loaded" && !readyVerdict.reported) {
        process.stderr.write(`\nrunSerialFile: READY_MARKER_LOADED_GRACE ${readyFile} soft=${readyTimeoutMs}ms hard=${readyVerdict.hardTimeoutMs}ms load=${readyVerdict.loadPerCpu?.toFixed(2) ?? "unmeasurable"} steal=${readyVerdict.steal ?? "unmeasurable"}\n`);
        readyVerdict.reported = true;
      }
      if (Date.now() - t0 <= readyVerdict.hardTimeoutMs) return;
      clearInterval(poll);
      poll = null;
      timedOut = true;
      process.stderr.write(`\nrunSerialFile: READY_MARKER_TIMEOUT_${readyVerdict.cause.toUpperCase().replaceAll("-", "_")} ${readyFile} soft=${readyTimeoutMs}ms hard=${readyVerdict.hardTimeoutMs}ms load=${readyVerdict.loadPerCpu ?? "unmeasurable"} steal=${readyVerdict.steal ?? "unmeasurable"}\n`);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  }, 50);
} else {
  startTimeout();
}

child.on("close", (code, signal) => {
  if (poll) clearInterval(poll);
  if (timer) clearTimeout(timer);
  if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }
  // Recheck ready marker on close to avoid race where child writes marker and exits between polls
  if (readyFile && !readyOk) {
    try {
      if (existsSync(readyFile) && statSync(readyFile).size > 0) {
        readyOk = true;
      }
    } catch {
      // unwritten or inaccessible
    }
  }
  if (timedOut) process.exit(124);
  if (readyFile && !readyOk) {
    process.stderr.write(`\nrunSerialFile: child exited before creating ready marker ${readyFile}\n`);
    process.exit(124);
  }
  const signalNumber = signal ? (osConstants.signals[signal] ?? 15) : 0;
  process.exit(code ?? (signal ? 128 + signalNumber : 1));
});
