// scripts/lib/type-check.mjs — ONE up-front type check for every file a full run executes, overlapped
// with the serial phase (gate-speed, 2026-10-08).
//
// WHY: every `deno test` process type-checks its own graph, and that costs ~1.2 CPU-s per process
// even on a warm check cache (measured on the 2-vCPU hub: tests/diff-core.test.ts 1.3 s with the
// check, 0.07 s user with --no-check). The serial phase starts 20 such processes one after another,
// on one CPU, and the parallel phase then spent its first ~20 s in a single-threaded check while
// the other CPU idled. One `deno check` of the union, started BEFORE the serial phase and running
// beside it, does the same type checking once, on the CPU the serial phase leaves idle.
//
// WHAT DOES NOT CHANGE: every file is still type-checked (the check covers exactly the files the run
// executes — serial and parallel), and a type error still fails the run. The fallback keeps today's
// behaviour where it matters: when the up-front check FAILS, the parallel phase runs WITH its own
// check exactly as before (so the per-file type error output is unchanged), and the run's exit code
// is non-zero even if every test body passed. Only files that ran under a GREEN up-front check run
// with --no-check.
//
// The child's output goes to a durable log FILE, not a pipe: the serial phase blocks node's event loop
// in spawnSync, and a pipe nobody drains would stall the check at 64 KiB of output.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableRoot } from "./durable-root.mjs";

/** The argv of the up-front check (pure, pinned by tests/type-check.test.ts). */
export function typeCheckArgs(files) {
  return ["check", "--config", "deno.runner.jsonc", ...files];
}

/**
 * Start the up-front check. Returns { log, done } where done resolves to
 * { code, output, secs }. A spawn failure resolves code 1 with the reason (never a silent pass).
 * @param {string[]} files
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, logDir?: string }} [options]
 */
export function startTypeCheck(files, { cwd = undefined, env = process.env, logDir = undefined } = {}) {
  const t0 = Date.now();
  const dir = logDir ?? join(durableRoot(), "type-check-logs");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-p${process.pid}.log`);
  const fd = openSync(log, "w");
  let child;
  try {
    child = spawn("deno", typeCheckArgs(files), {
      cwd,
      env: { ...env, NO_COLOR: env.NO_COLOR ?? "1" },
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    closeSync(fd);
    return { log, child: null, done: Promise.resolve({ code: 1, output: `spawn failed: ${error?.message ?? error}`, secs: 0 }) };
  }
  const done = new Promise((resolve) => {
    const finish = (code, extra = "") => {
      try { closeSync(fd); } catch { /* already closed */ }
      let output = "";
      try { output = readFileSync(log, "utf8"); } catch { /* unreadable log: the code still decides */ }
      resolve({ code, output: output + extra, secs: (Date.now() - t0) / 1000 });
    };
    child.on("error", (error) => finish(1, `\nspawn error: ${error?.message ?? error}\n`));
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 + 15 : 1)));
  });
  return { log, child, done };
}
