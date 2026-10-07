// scripts/lib/serial-runner.mjs — bounded child execution with readiness handshake
// for serial phase test fixtures (chrome-agent-platform-5nhz).
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const [file, readyFile, timeoutMsStr, readyTimeoutMsStr] = process.argv.slice(2);
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
      clearInterval(poll);
      poll = null;
      timedOut = true;
      process.stderr.write(`\nrunSerialFile: ready marker ${readyFile} was not created within ${readyTimeoutMs / 1000}s\n`);
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
  if (readyFile && !readyOk) {
    process.stderr.write(`\nrunSerialFile: child exited before creating ready marker ${readyFile}\n`);
    process.exit(124);
  }
  if (timedOut) {
    process.exit(124);
  }
  process.exit(code ?? (signal ? 128 + 15 : 1));
});
