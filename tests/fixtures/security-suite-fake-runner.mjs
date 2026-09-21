// Exact hash-pinned, no-Chrome fixture for security-suite supervisor mutants.
// The production supervisor accepts this file only in explicit self-test mode.

import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { verifyRunnerGuard } from "../../scripts/security-suite-custody.mjs";

const state = process.env.CAP_SECURITY_TEST_STATE;
const record = (event, extra = {}) => {
  if (!state) return;
  appendFileSync(
    state,
    `${
      JSON.stringify({ event, pid: process.pid, ppid: process.ppid, ...extra })
    }\n`,
  );
};
// Bound fixture lifetime (chrome-agent-platform-pozs): unref'd safety exit
// ensures a leaked descendant (e.g. --escape-child or --stubborn-child) can
// never survive as an orphan past 30 seconds if a test crashes or times out.
const stayAlive = (maxMs = 30_000) => {
  const timer = setTimeout(() => process.exit(0), maxMs);
  timer.unref();
  return setInterval(() => {}, 60_000);
};

if (process.argv[2] === "--stubborn-child") {
  process.on("SIGTERM", () => record("stubborn-child-term"));
  record("stubborn-child-ready");
  stayAlive();
} else if (process.argv[2] === "--escape-child") {
  process.on("SIGTERM", () => record("escape-child-term"));
  record("escape-child-ready");
  stayAlive();
} else {
  const scenario = process.env.CAP_SECURITY_TEST_SCENARIO;
  record("runner-ready", { scenario });

  if (scenario === "guard") {
    const error = await verifyRunnerGuard({ env: process.env });
    record("guard-result", { error });
    setTimeout(() => process.exit(error ? 97 : 0), 100);
  } else if (scenario === "exit37") {
    setTimeout(() => process.exit(37), 100);
  } else if (scenario === "signal") {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
  } else if (scenario === "timeout") {
    process.on("SIGTERM", () => {
      record("runner-term");
      process.exit(0);
    });
    stayAlive();
  } else if (scenario === "stubborn") {
    process.on("SIGTERM", () => record("runner-term-ignored"));
    const child = spawn(process.execPath, [
      fileURLToPath(new URL(import.meta.url)),
      "--stubborn-child",
    ], {
      env: process.env,
      stdio: "ignore",
    });
    record("stubborn-child-spawned", { childPid: child.pid });
    stayAlive();
  } else if (scenario === "pgid-mismatch") {
    process.on("SIGTERM", () => process.exit(0));
    stayAlive();
  } else if (scenario === "escape") {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL(import.meta.url)),
      "--escape-child",
    ], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.unref();
    record("escape-child-spawned", { childPid: child.pid });
    // chrome-agent-platform-7poq: a failed spawn reports asynchronously, and a
    // descendant killed under suite pressure leaves no residue. Either way,
    // exiting 0 would make a no-op scenario indistinguishable from a passing
    // custody run (the nightly full-suite red: "exit 70 expected, got 0").
    // Fail the scenario loudly instead; the supervisor reports the refusal.
    child.once("error", () => {
      record("escape-child-spawn-error", {});
      process.exit(97);
    });
    if (process.env.CAP_SECURITY_TEST_ESCAPE_CHILD_FAIL === "1") {
      // Test-only mutant (CAP_SECURITY_TEST_* envs are stripped from the
      // child environment in production): the descendant must NOT persist,
      // simulating the observed full-suite failure shape.
      //
      // d2vz: this used to kill the child after 50ms, which was only loud
      // because the handshake could never confirm anything (the reader was
      // unimported). With the reader working, the sampler can win that race and
      // the run ends 70/residue instead of the loud 97 this case exists for. A
      // descendant that does not persist must be killed BEFORE it can be
      // observed, so the refusal is the outcome and not a race.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    // chrome-agent-platform-d5st: the scenario is not ESTABLISHED until the
    // supervisor has actually SEEN this descendant — exiting earlier raced
    // the supervisor's sampler, and a run where no sample landed in the
    // window exited 0, indistinguishable from a clean pass. The supervisor
    // writes its observed subtree to CAP_SECURITY_SAMPLE_ACK after each scan;
    // wait (bounded, inside this scenario's own budget) for our child to be
    // in it, then exit. A descendant that never shows up is the loud refusal,
    // not a silent pass.
    const ackPath = process.env.CAP_SECURITY_SAMPLE_ACK;
    if (!ackPath) {
      record("escape-no-ack-path", {});
      process.exit(97);
    }
    const deadline = Date.now() + 1_500;
    const confirmed = () => {
      try {
        const ack = JSON.parse(readFileSync(ackPath, "utf8"));
        return Array.isArray(ack.pids) && ack.pids.includes(child.pid);
      } catch {
        return false;
      }
    };
    const poll = () => {
      let alive = false;
      if (typeof child.pid === "number" && child.pid > 0) {
        try {
          process.kill(child.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (!alive) {
        record("escape-child-not-persistent", {});
        process.exit(97);
      }
      if (confirmed()) {
        record("escape-observed-by-supervisor", { childPid: child.pid });
        process.exit(0);
      }
      if (Date.now() > deadline) {
        record("escape-unconfirmed", {});
        process.exit(97);
      }
      setTimeout(poll, 10);
    };
    poll();
  } else if (scenario === "serialize") {
    setTimeout(() => process.exit(0), 700);
  } else {
    record("unknown-scenario");
    process.exit(98);
  }
}
