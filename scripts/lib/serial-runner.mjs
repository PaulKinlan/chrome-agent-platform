// scripts/lib/serial-runner.mjs — bounded child execution with readiness handshake
// for serial phase test fixtures (chrome-agent-platform-5nhz).
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { classifyReadyMarkerTimeout, measuredReadyLoadPerCpu } from "./serial-phase.mjs";

const [file, readyFile, timeoutMsStr, readyTimeoutMsStr, injectedReadyLoadStr] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsStr || "10000");
const readyTimeoutMs = Number(readyTimeoutMsStr || "60000");

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
        loadPerCpu: injectedReadyLoad === undefined ? measuredReadyLoadPerCpu() : injectedReadyLoad,
      });
      if (readyVerdict.cause === "loaded" && !readyVerdict.reported) {
        process.stderr.write(`\nrunSerialFile: READY_MARKER_LOADED_GRACE ${readyFile} soft=${readyTimeoutMs}ms hard=${readyVerdict.hardTimeoutMs}ms load=${readyVerdict.loadPerCpu.toFixed(2)}/cpu\n`);
        readyVerdict.reported = true;
      }
      if (Date.now() - t0 <= readyVerdict.hardTimeoutMs) return;
      clearInterval(poll);
      poll = null;
      timedOut = true;
      process.stderr.write(`\nrunSerialFile: READY_MARKER_TIMEOUT_${readyVerdict.cause.toUpperCase().replaceAll("-", "_")} ${readyFile} soft=${readyTimeoutMs}ms hard=${readyVerdict.hardTimeoutMs}ms load=${readyVerdict.loadPerCpu ?? "unmeasurable"}/cpu\n`);
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
  process.exit(code ?? (signal ? 128 + 15 : 1));
});
