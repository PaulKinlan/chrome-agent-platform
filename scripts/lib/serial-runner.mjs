// scripts/lib/serial-runner.mjs — bounded child execution with readiness handshake
// for serial phase test fixtures (chrome-agent-platform-5nhz).
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { classifyReadyMarkerTimeout, measuredReadyLoad } from "./serial-phase.mjs";

const [file, readyFile, timeoutMsStr, readyTimeoutMsStr, injectedReadyLoadStr] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsStr || "10000");
const readyTimeoutMs = Number(readyTimeoutMsStr || "60000");

// chrome-agent-platform-tf96x: leave a SENTINEL naming us, so the detached fixture we are about to
// spawn can tell when we are gone. The fixture runs in its own process group ON PURPOSE, which also
// means nothing above us can kill it — measured 2026-10-23, a fixture orphaned by a bound-killed
// gate ran 120 minutes until the reaper swept it. The fixture polls /proc/<this pid> and exits when
// we disappear; the write is best-effort and cleans up with the scratch dir like everything else.
try {
  writeFileSync(`${file}.runner`, String(process.pid));
} catch { /* best-effort: a fixture without a sentinel keeps today's behaviour */ }

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
const injectedReadyLoad = injectedReadyLoadStr === undefined ? undefined : Number(injectedReadyLoadStr);

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
      });
      if (readyVerdict.cause === "loaded" && !readyVerdict.reported) {
        process.stderr.write(`\nrunSerialFile: READY_MARKER_LOADED_GRACE ${readyFile} soft=${readyTimeoutMs}ms hard=${readyVerdict.hardTimeoutMs}ms load=${readyVerdict.loadPerCpu.toFixed(2)}\n`);
        readyVerdict.reported = true;
      }
      if (Date.now() - t0 <= readyVerdict.hardTimeoutMs) return;
      clearInterval(poll);
      poll = null;
      timedOut = true;
      process.stderr.write(`\nrunSerialFile: READY_MARKER_TIMEOUT_${readyVerdict.cause.toUpperCase().replaceAll("-", "_")} ${readyFile} soft=${readyTimeoutMs}ms hard=${readyVerdict.hardTimeoutMs}ms load=${readyVerdict.loadPerCpu ?? "unmeasurable"}\n`);
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
