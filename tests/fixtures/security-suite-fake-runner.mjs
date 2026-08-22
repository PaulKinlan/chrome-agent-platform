// Exact hash-pinned, no-Chrome fixture for security-suite supervisor mutants.
// The production supervisor accepts this file only in explicit self-test mode.

import { appendFileSync } from "node:fs";
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
const stayAlive = () => setInterval(() => {}, 60_000);

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
      new URL(import.meta.url).pathname,
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
      new URL(import.meta.url).pathname,
      "--escape-child",
    ], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.unref();
    record("escape-child-spawned", { childPid: child.pid });
    setTimeout(() => process.exit(0), 300);
  } else if (scenario === "serialize") {
    setTimeout(() => process.exit(0), 700);
  } else {
    record("unknown-scenario");
    process.exit(98);
  }
}
