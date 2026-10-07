// Executable, no-Chrome custody proof for the canonical security-suite
// supervisor. Every process mutant runs the real supervisor and the one exact
// hash-pinned repository fixture; cleanup mutants call the same exported live
// helper used by production supervision.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { lstat as nodeLstat } from "node:fs/promises";
import { runLockAware } from "../scripts/lib/lock-aware-command.ts";
import {
  cleanupExactProfile,
  pidAlive,
  PROFILE_ROOT,
  readProcIdentity,
  resolveSupervisorConfig,
  SELF_TEST_TOKEN,
  waitUntil,
} from "../scripts/security-suite-custody.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const SUPERVISOR = `${ROOT}/scripts/security-suite-supervisor.sh`;
const SUPERVISOR_NODE = `${ROOT}/scripts/security-suite-supervisor.mjs`;
const RUNNER = `${ROOT}/scripts/security-suite.ts`;
const FIXTURE = `${ROOT}/tests/fixtures/security-suite-fake-runner.mjs`;
const LOCK = "/tmp/cap-serialized-chrome-acceptance.lock";
const decoder = new TextDecoder();

// The slot poison marker is RETIRED (chrome-agent-platform-uzik, which also
// closes chrome-agent-platform-yr6e). This file used to clear a stale marker at
// suite load because the supervisor refused to run while one existed — and an
// unrelated lane's transient marker turned a whole `npm test` red. There is
// nothing to clear now: the supervisor never reads or writes it, and the guard
// test below fails if the mechanism comes back.
const RETIRED_POISON = "/tmp/cap-chrome-slot-POISON";
// chrome-agent-platform-2zqd: the DECLARED numbers for the escape cases, asserted as a CONTRACT rather
// than raced as clocks. The supervisor's own budget is the arbiter of a supervisor that never samples,
// so the fixture's loud refusal is a BACKSTOP LOAD CANNOT REACH: FREEZE_MS < BUDGET_MS < ACK_DEADLINE_MS,
// with the budget ~3.6x above the worst first-sample/ACK latency measured on this box (2_800 ms at
// loadavg ~10). Before this the fixture's private 1_500 ms deadline decided the outcome, so the BOX
// decided the red: the fixture gave up and exited 97 before the supervisor could observe the escape,
// and the red looked like a custody failure.
const ESCAPE_SELF_TEST_BUDGET_MS = 10_000;
const ESCAPE_ACK_DEADLINE_MS = 12_000;
const STUBBORN_ACK_DEADLINE_MS = 12_000;
const ESCAPE_SAMPLE_FREEZE_MS = 400;
// chrome-agent-platform-2zqd: how long the reap/cleanup assertions wait for a recorded pid to STOP being a
// live process before calling it a survivor. The PROPERTY is unchanged (a survivor still REDs) - only the
// BOUND is declared, because under parallel always-on load the box delayed cleanup past the old hard-coded
// 2 s: the third case in this file redded at loadavg ~9.5 while passing 12/0 alone. Measured reap on an idle
// box is 5-45 ms, so a healthy run still returns immediately - this bound only decides how long a FAILURE waits.
const REAP_SETTLE_TIMEOUT_MS = 10_000;

type RunResult = {
  code: number;
  text: string;
  receipt?: Record<string, unknown>;
  state: Array<Record<string, unknown>>;
};

// The child's 20 s budget counts ITS OWN time. The supervisor's first act is
// an exclusive flock on the canonical serialized-Chrome lock; when another lane
// holds it, the wait used to eat the whole budget and the test reported
// "supervisor emitted no result marker" for a supervisor that never ran
// (CAP-FB-20260830-SUITE-HONESTY-01). The supervisor now prints
// CAP_SECURITY_LOCK_ACQUIRED when it holds the lock and the budget starts
// there; the queue wait is bounded separately and reported as its own finding.
async function command(
  executable: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutSeconds = 20,
  lockMarker: string | undefined = undefined,
): Promise<{ code: number; text: string }> {
  const r = await runLockAware({
    executable,
    args,
    env,
    budgetMs: timeoutSeconds * 1000,
    lockWaitMs: 10 * 60_000,
    lockMarker,
  });
  return { code: r.code, text: r.text };
}

async function runSupervisor(
  scenario: string,
  timeoutMs: number,
  extra: Record<string, string> = {},
): Promise<RunResult> {
  const result = await command("bash", [SUPERVISOR], {
    CAP_SECURITY_SELF_TEST: SELF_TEST_TOKEN,
    CAP_SECURITY_RUNNER: FIXTURE,
    CAP_SECURITY_TEST_SCENARIO: scenario,
    CAP_SECURITY_SELF_TEST_TIMEOUT_MS: String(timeoutMs),
    ...extra,
  }, 20, "CAP_SECURITY_LOCK_ACQUIRED");
  const marker = result.text.split("\n").find((line) =>
    line.startsWith("CAP_SECURITY_RESULT ")
  );
  assert(marker, `supervisor emitted no result marker: ${result.text}`);
  const receipt = JSON.parse(marker.slice("CAP_SECURITY_RESULT ".length));
  let state: Array<Record<string, unknown>> = [];
  try {
    const body = await Deno.readTextFile(
      `${receipt.evidence}/self-test-state.jsonl`,
    );
    state = body.trim().split("\n").filter(Boolean).map((line) =>
      JSON.parse(line)
    );
  } catch {
    // Some early refusal paths intentionally create no fixture state.
  }
  return { ...result, receipt, state };
}

async function removeEvidence(result: RunResult) {
  const runId = result.receipt?.runId;
  if (typeof runId === "string") {
    const profile = await Deno.lstat(`${PROFILE_ROOT}/${runId}`).catch(() =>
      null
    );
    assertEquals(profile, null, `supervisor left its exact profile ${runId}`);
  }
  const evidence = result.receipt?.evidence;
  if (typeof evidence === "string") {
    await Deno.remove(evidence, { recursive: true }).catch(() => {});
  }
}

async function escapeChildPidFrom(stateFile: string): Promise<number> {
  const rows = (await Deno.readTextFile(stateFile).catch(() => "")).trim().split("\n")
    .filter(Boolean);
  for (const line of rows) {
    try {
      const row = JSON.parse(line);
      if (typeof row.childPid === "number" && row.childPid > 0) return row.childPid;
    } catch {
      // a partial trailing line is not a pid
    }
  }
  return 0;
}

async function assertRecordedPidsGone(result: RunResult) {
  const pids = new Set<number>();
  for (const row of result.state) {
    if (typeof row.pid === "number") pids.add(row.pid);
    if (typeof row.childPid === "number") pids.add(row.childPid);
  }
  for (const pid of pids) {
    const gone = await waitUntil(async () => {
      try {
        const identity = await readProcIdentity(pid);
        return identity.state !== "Z";
      } catch {
        return false;
      }
    }, REAP_SETTLE_TIMEOUT_MS);
    assert(gone, `fixture pid ${pid} survived owned-group cleanup`);
  }
}

// chrome-agent-platform-wtjz: boundedly verify live process ownership by identity rather than unguarded
// /proc reads that throw raw ENOENT under churn when inspecting transient descendants.
function matchEscapeResidueByIdentity(
  residue: Array<Record<string, unknown>>,
  expectedChildPid: number,
): Record<string, unknown> {
  const match = residue.find((r) => Number(r.pid) === expectedChildPid);
  assert(
    match,
    `expected escape child pid ${expectedChildPid} must be in residue: ${
      JSON.stringify(residue.map((r) => ({ pid: r.pid, starttime: r.starttime })))
    }`,
  );
  return match;
}

async function verifyLiveProcOwnership(
  pid: number,
  expectedStart: string,
  timeoutMs = 2_000,
): Promise<{ starttime: string; uid: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const id = await readProcIdentity(pid);
      if (id.state !== "Z") {
        if (id.starttime !== expectedStart) {
          throw new Error(
            `proc ${pid} starttime mismatch: expected ${expectedStart}, got ${id.starttime}`,
          );
        }
        return id;
      }
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `custody verification failed for pid ${pid} (expected start ${expectedStart}): ${
      lastError?.message ?? "process not live"
    }`,
  );
}

Deno.test("security-suite custody: production mode is immutable and fake runners are hash-pinned", async () => {
  const production = await resolveSupervisorConfig({
    env: {
      HOME: Deno.env.get("HOME") ?? "",
      CAP_SECURITY_TIMEOUT_MS: "1",
    },
    repoRoot: ROOT,
    expectedFixtureHash: "unused-in-production",
  });
  assertEquals(production.selfTest, false);
  assertEquals(production.timeoutMs, 120_000);
  assertEquals(production.attestDeadlineMs, 2_000, "production keeps the old attestation clock");
  assertEquals(production.sampleFreezeMs, 0, "production keeps zero sample freeze");
  assertEquals(production.runner, RUNNER);

  await assertRejects(
    () =>
      resolveSupervisorConfig({
        env: {
          HOME: Deno.env.get("HOME") ?? "",
          CAP_SECURITY_RUNNER: "/tmp/hostile-runner.mjs",
        },
        repoRoot: ROOT,
        expectedFixtureHash: "unused-in-production",
      }),
    Error,
    "self-test-only override refused",
  );

  await assertRejects(
    () => resolveSupervisorConfig({
      env: { HOME: Deno.env.get("HOME") ?? "", CAP_SECURITY_TEST_ATTEST_DEADLINE_MS: "5000" },
      repoRoot: ROOT,
      expectedFixtureHash: "unused-in-production",
    }),
    Error,
    "self-test-only override refused in production mode",
  );

  // chrome-agent-platform-a6x5: CAP_SECURITY_TEST_SAMPLE_FREEZE_MS is a test-only determinism
  // knob and must refuse loudly if present in production mode.
  await assertRejects(
    () => resolveSupervisorConfig({
      env: { HOME: Deno.env.get("HOME") ?? "", CAP_SECURITY_TEST_SAMPLE_FREEZE_MS: "500" },
      repoRoot: ROOT,
      expectedFixtureHash: "unused-in-production",
    }),
    Error,
    "self-test-only override refused in production mode",
  );

  await assertRejects(
    () => resolveSupervisorConfig({
      env: { HOME: Deno.env.get("HOME") ?? "", CAP_SECURITY_TEST_ACK_DEADLINE_MS: "5000" },
      repoRoot: ROOT,
      expectedFixtureHash: "unused-in-production",
    }),
    Error,
    "self-test-only override refused in production mode",
  );

  await assertRejects(
    () => resolveSupervisorConfig({
      env: { HOME: Deno.env.get("HOME") ?? "", CAP_SECURITY_TEST_STUBBORN_BOOT_DELAY_MS: "500" },
      repoRoot: ROOT,
      expectedFixtureHash: "unused-in-production",
    }),
    Error,
    "self-test-only override refused in production mode",
  );

  const fake = await Deno.makeTempFile({ prefix: "cap-hostile-runner-" });
  await Deno.writeTextFile(fake, "process.exit(0);\n");
  const refused = await command("bash", [SUPERVISOR], {
    CAP_SECURITY_SELF_TEST: SELF_TEST_TOKEN,
    CAP_SECURITY_RUNNER: fake,
    CAP_SECURITY_TEST_SCENARIO: "exit37",
    CAP_SECURITY_SELF_TEST_TIMEOUT_MS: "1000",
  }, 20, "CAP_SECURITY_LOCK_ACQUIRED");
  assertEquals(refused.code, 2);
  assert(refused.text.includes("path/hash refused"));
  await Deno.remove(fake);
});

Deno.test("security-suite custody: direct/no-lock/stale-parent/stale-nonce/wrong-lock all refuse before Chrome", async () => {
  const direct = await command("deno", ["run", "-A", RUNNER]);
  assertEquals(direct.code, 2);
  assert(direct.text.includes("REFUSED"));
  assert(!direct.text.includes("DevTools"));

  const directSupervisor = await command("node", [SUPERVISOR_NODE]);
  assertEquals(directSupervisor.code, 2);
  assert(
    directSupervisor.text.includes("lock fd is missing") ||
      directSupervisor.text.includes("lock fd has the wrong target"),
  );

  const guardDir = await Deno.makeTempDir({ prefix: "cap-sec-guard-mutants-" });
  const parent = await readProcIdentity(Deno.pid);
  const nonce = "a".repeat(32);
  const baseGuard = {
    schemaVersion: 1,
    nonce,
    parentPid: Deno.pid,
    parentStart: parent.starttime,
    lockPath: LOCK,
    issuedAt: Date.now(),
  };
  const runGuard = async (
    name: string,
    guard: Record<string, unknown>,
    envNonce = nonce,
  ) => {
    const guardPath = `${guardDir}/${name}.json`;
    await Deno.writeTextFile(guardPath, JSON.stringify(guard), { mode: 0o600 });
    return await command("deno", ["run", "-A", RUNNER], {
      CAP_SECURITY_NONCE: envNonce,
      CAP_SECURITY_GUARD: guardPath,
      CAP_SECURITY_PARENT: String(Deno.pid),
    });
  };

  const noLock = await runGuard("no-lock", baseGuard);
  assertEquals(noLock.code, 2);
  assert(
    noLock.text.includes("lock fd is missing") ||
      noLock.text.includes("lock fd has the wrong target"),
  );

  const staleParent = await runGuard("stale-parent", {
    ...baseGuard,
    parentStart: "0",
  });
  assertEquals(staleParent.code, 2);
  assert(staleParent.text.includes("stale parent identity"));

  const staleNonce = await runGuard("stale-nonce", baseGuard, "b".repeat(32));
  assertEquals(staleNonce.code, 2);
  assert(staleNonce.text.includes("nonce mismatch"));

  const wrongLock = await runGuard("wrong-lock", {
    ...baseGuard,
    lockPath: "/tmp/not-the-canonical-lock",
  });
  assertEquals(wrongLock.code, 2);
  assert(wrongLock.text.includes("wrong lock path"));
  await Deno.remove(guardDir, { recursive: true });
});

Deno.test("security-suite custody: the valid supervisor chain declares its attestation window", async () => {
  const declaredAttestDeadlineMs = 5_000;
  const result = await runSupervisor("guard", 2_000, {
    CAP_SECURITY_TEST_ATTEST_DEADLINE_MS: String(declaredAttestDeadlineMs),
  });
  try {
    assertEquals(result.code, 0);
    assertEquals(result.receipt?.result, "PASS");
    assertEquals(result.receipt?.attestDeadlineMs, declaredAttestDeadlineMs,
      "the receipt records the NUMBER the supervisor was given, not a private clock");
    const guardResult = result.state.find((row) =>
      row.event === "guard-result"
    );
    assertEquals(guardResult?.error, null);
  } finally {
    await removeEvidence(result);
  }
});

Deno.test("zfsl: invalid attestation declaration refuses by name before a runner is spawned", async () => {
  for (const bad of ["not-a-number", "0", "20001"]) {
    const result = await command("bash", [SUPERVISOR], {
      CAP_SECURITY_SELF_TEST: SELF_TEST_TOKEN,
      CAP_SECURITY_RUNNER: FIXTURE,
      CAP_SECURITY_TEST_SCENARIO: "guard",
      CAP_SECURITY_SELF_TEST_TIMEOUT_MS: "1000",
      CAP_SECURITY_TEST_ATTEST_DEADLINE_MS: bad,
    }, 20, "CAP_SECURITY_LOCK_ACQUIRED");
    assertEquals(result.code, 2);
    assert(result.text.includes("SECURITY-SUITE SUPERVISOR REFUSED: CAP_SECURITY_TEST_ATTEST_DEADLINE_MS out of bounds"));
    assert(!result.text.includes("CAP_SECURITY_RESULT"), "config refusal must precede spawning and receipt");
  }
});

Deno.test("a6x5: invalid sample freeze declaration refuses by name before a runner is spawned", async () => {
  for (const bad of ["not-a-number", "-1", "20001"]) {
    const result = await command("bash", [SUPERVISOR], {
      CAP_SECURITY_SELF_TEST: SELF_TEST_TOKEN,
      CAP_SECURITY_RUNNER: FIXTURE,
      CAP_SECURITY_TEST_SCENARIO: "guard",
      CAP_SECURITY_SELF_TEST_TIMEOUT_MS: "1000",
      CAP_SECURITY_TEST_SAMPLE_FREEZE_MS: bad,
    }, 20, "CAP_SECURITY_LOCK_ACQUIRED");
    assertEquals(result.code, 2);
    assert(result.text.includes("SECURITY-SUITE SUPERVISOR REFUSED: CAP_SECURITY_TEST_SAMPLE_FREEZE_MS out of bounds"));
    assert(!result.text.includes("CAP_SECURITY_RESULT"), "config refusal must precede spawning and receipt");
  }
});

Deno.test("zfsl: exhausted declared attestation window refuses by name and reaps the child", async () => {
  const declaredAttestDeadlineMs = 100;
  const result = await runSupervisor("timeout", 1_000, {
    CAP_SECURITY_TEST_ATTEST_DEADLINE_MS: String(declaredAttestDeadlineMs),
    CAP_SECURITY_TEST_FORCE_ATTEST_UNSETTLED: "1",
  });
  try {
    assertEquals(result.code, 2);
    assertEquals(result.receipt?.result, "REFUSED");
    assertEquals(result.receipt?.attestDeadlineMs, declaredAttestDeadlineMs);
    assertEquals(result.receipt?.reason,
      `PGID/SID attestation deadline exceeded after ${declaredAttestDeadlineMs} ms`);
    assertEquals(result.receipt?.cleaned, true);
    await assertRecordedPidsGone(result);
  } finally {
    await removeEvidence(result);
  }
});

Deno.test("security-suite custody: PGID/SID mismatch fails closed with no fixture survivor", async () => {
  const result = await runSupervisor("pgid-mismatch", 1_000, {
    CAP_SECURITY_TEST_FORCE_ATTEST_MISMATCH: "1",
  });
  try {
    assertEquals(result.code, 2);
    assertEquals(result.receipt?.result, "REFUSED");
    assert(
      String(result.receipt?.reason).includes("PGID/SID attestation failed"),
    );
    await assertRecordedPidsGone(result);
  } finally {
    await removeEvidence(result);
  }
});

Deno.test("security-suite custody: hard timeout sends TERM and returns 124", async () => {
  const result = await runSupervisor("timeout", 300);
  try {
    assertEquals(result.code, 124);
    assertEquals(result.receipt?.timedOut, true);
    assertEquals(result.receipt?.termSent, true);
    assertEquals(result.receipt?.killSent, false);
    assert(result.state.some((row) => row.event === "runner-term"));
    assertEquals(result.receipt?.cleaned, true);
    await assertRecordedPidsGone(result);
  } finally {
    await removeEvidence(result);
  }
});

Deno.test("security-suite custody: stubborn owned group receives TERM then KILL and leaves no survivor", async () => {
  const result = await runSupervisor("stubborn", 350, {
    CAP_SECURITY_TEST_ACK_DEADLINE_MS: String(STUBBORN_ACK_DEADLINE_MS),
  });
  try {
    assertEquals(result.code, 124);
    assertEquals(result.receipt?.termSent, true);
    assertEquals(result.receipt?.killSent, true);
    assertEquals(result.receipt?.groupSurvived, false);
    assert(result.state.some((row) => row.event === "runner-term-ignored"));
    assert(result.state.some((row) => row.event === "stubborn-child-term"));
    assert(result.state.some((row) => row.event === "stubborn-observed-by-supervisor"));
    assertEquals(
      result.state.find((row) => row.event === "stubborn-ack-deadline-declared")
        ?.ackDeadlineMs,
      STUBBORN_ACK_DEADLINE_MS,
      "the fixture must record the DECLARED window it was given",
    );
    assertEquals((result.receipt?.residue as unknown[])?.length, 0);
    await assertRecordedPidsGone(result);
  } finally {
    await removeEvidence(result);
  }
});

// chrome-agent-platform-r222: under CPU load, spawning and booting the stubborn child Node process
// can take longer than the 350 ms scenario timeout. The supervisor must await child readiness
// before starting the scenario timeout clock.
Deno.test("security-suite custody: stubborn child with boot delay awaits readiness before starting timeout clock", async () => {
  // 500 ms boot delay > 350 ms scenario timeout: without readiness handshake,
  // supervisor would timeout at 350 ms and send TERM before the child installs its handler.
  const result = await runSupervisor("stubborn", 350, {
    CAP_SECURITY_TEST_STUBBORN_BOOT_DELAY_MS: "500",
    CAP_SECURITY_TEST_ACK_DEADLINE_MS: String(STUBBORN_ACK_DEADLINE_MS),
  });
  try {
    assertEquals(result.code, 124);
    assertEquals(result.receipt?.termSent, true);
    assertEquals(result.receipt?.killSent, true);
    assertEquals(result.receipt?.groupSurvived, false);
    assert(result.state.some((row) => row.event === "runner-term-ignored"));
    assert(result.state.some((row) => row.event === "stubborn-child-term"));
    assert(result.state.some((row) => row.event === "stubborn-observed-by-supervisor"));
    assertEquals((result.receipt?.residue as unknown[])?.length, 0);
    await assertRecordedPidsGone(result);
  } finally {
    await removeEvidence(result);
  }
});

// chrome-agent-platform-r222: stubborn descendant failing to persist must fail loudly (exit 97)
Deno.test("security-suite custody: stubborn descendant that fails to persist fails scenario loudly", async () => {
  const result = await runSupervisor("stubborn", 2_000, {
    CAP_SECURITY_TEST_STUBBORN_CHILD_FAIL: "1",
  });
  try {
    assertEquals(result.receipt?.exit, 97);
    assertEquals(result.receipt?.result, "FAIL");
    assert(
      result.state.some((r) =>
        r.event === "stubborn-child-not-persistent" ||
        r.event === "stubborn-child-spawn-error" ||
        r.event === "stubborn-unconfirmed"
      ),
      `fixture must record WHY the stubborn scenario could not run: ${
        JSON.stringify(result.state)
      }`,
    );
  } finally {
    await removeEvidence(result);
  }
});

// chrome-agent-platform-r222: stubborn declared window that cannot be met records loud refusal by name
Deno.test("security-suite custody: stubborn declared window the ACK cannot meet records loud refusal by name", async () => {
  const dir = durableDir(`r222-stubborn-ack-refusal-${Deno.pid}`);
  const stateFile = `${dir}/self-test-state.jsonl`;
  const ackPath = `${dir}/sample-ack.json`;
  await Deno.writeTextFile(ackPath, `${JSON.stringify({ pids: [] })}\n`);
  let childPid = 0;
  try {
    const r = await command("node", [FIXTURE], {
      CAP_SECURITY_TEST_SCENARIO: "stubborn",
      CAP_SECURITY_TEST_STATE: stateFile,
      CAP_SECURITY_SAMPLE_ACK: ackPath,
      CAP_SECURITY_TEST_ACK_DEADLINE_MS: "1",
    }, 20);
    assertEquals(r.code, 97, "a window the ACK can never meet must produce the fixture's loud refusal");
    const events = (await Deno.readTextFile(stateFile)).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line));
    const named = events.map((row) => row.event);
    assert(named.includes("stubborn-ack-deadline-declared"), `the declared window must be recorded: ${named.join(",")}`);
    assert(named.includes("stubborn-unconfirmed"), `the refusal must be recorded BY NAME: ${named.join(",")}`);
  } finally {
    childPid = await escapeChildPidFrom(stateFile);
    if (childPid > 0) {
      try {
        Deno.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// chrome-agent-platform-r222: invalid declared window for stubborn scenario is refused loudly
Deno.test("security-suite custody: stubborn invalid declared window is refused loudly and by name", async () => {
  const dir = durableDir(`r222-stubborn-ack-invalid-${Deno.pid}`);
  const stateFile = `${dir}/self-test-state.jsonl`;
  const ackPath = `${dir}/sample-ack.json`;
  await Deno.writeTextFile(ackPath, `${JSON.stringify({ pids: [] })}\n`);
  let childPid = 0;
  try {
    const r = await command("node", [FIXTURE], {
      CAP_SECURITY_TEST_SCENARIO: "stubborn",
      CAP_SECURITY_TEST_STATE: stateFile,
      CAP_SECURITY_SAMPLE_ACK: ackPath,
      CAP_SECURITY_TEST_ACK_DEADLINE_MS: "not-a-number",
    }, 20);
    assertEquals(r.code, 97, "an invalid declared window must be refused loudly, never silently defaulted");
    const events = (await Deno.readTextFile(stateFile)).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line));
    const named = events.map((row) => row.event);
    assert(
      named.includes("stubborn-ack-deadline-invalid"),
      `the refusal must be recorded BY NAME: ${named.join(",")}`,
    );
    assert(
      !named.includes("stubborn-ack-deadline-declared"),
      `an invalid window must not be recorded as honoured: ${named.join(",")}`,
    );
  } finally {
    childPid = await escapeChildPidFrom(stateFile);
    if (childPid > 0) {
      try {
        Deno.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// chrome-agent-platform-r222: stubborn readiness deadline expiry produces loud refusal exit 97 (not 124)
Deno.test("security-suite custody: stubborn readiness deadline expiry produces loud refusal exit 97 (not 124)", async () => {
  const result = await runSupervisor("stubborn", 350, {
    CAP_SECURITY_TEST_SAMPLE_FREEZE_MS: "400",
    CAP_SECURITY_TEST_ACK_DEADLINE_MS: "100",
  });
  try {
    assertEquals(result.code, 97, "readiness expiry must be a loud refusal (exit 97), never a false scenario timeout (124)");
    assertEquals(result.receipt?.result, "FAIL");
    assert(
      result.state.some((r) => r.event === "stubborn-unconfirmed") ||
      result.receipt?.custodyReason === "stubborn-readiness-timeout",
      "must record stubborn-unconfirmed or stubborn-readiness-timeout",
    );
    await assertRecordedPidsGone(result);
  } finally {
    await removeEvidence(result);
  }
});

Deno.test("security-suite custody: exit 37 and runner signal propagate exactly", async () => {
  const nonzero = await runSupervisor("exit37", 2_000);
  try {
    assertEquals(nonzero.code, 37);
    assertEquals(nonzero.receipt?.exit, 37);
  } finally {
    await removeEvidence(nonzero);
  }

  const signaled = await runSupervisor("signal", 2_000);
  try {
    assertEquals(signaled.code, 143);
    assertEquals(signaled.receipt?.exit, 143);
    assertEquals(signaled.receipt?.runnerSignal, "SIGTERM");
  } finally {
    await removeEvidence(signaled);
  }
});

Deno.test("security-suite custody: live cleanup helper refuses real symlink/wrong-prefix and injected wrong owner", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-sec-clean-root-" });
  const target = await Deno.makeTempDir({ prefix: "cap-sec-clean-target-" });
  const link = `${root}/${"a".repeat(16)}`;
  await Deno.symlink(target, link);
  const symlink = await cleanupExactProfile({ profile: link, root });
  assertEquals(symlink.ok, false);
  assertEquals(symlink.removed, false);
  assert((await Deno.lstat(link)).isSymlink);
  assert((await Deno.lstat(target)).isDirectory);

  const outsideRoot = await Deno.makeTempDir({
    prefix: "cap-sec-clean-outside-",
  });
  const outside = `${outsideRoot}/${"b".repeat(16)}`;
  await Deno.mkdir(outside);
  const wrongPrefix = await cleanupExactProfile({ profile: outside, root });
  assertEquals(wrongPrefix.ok, false);
  assert((await Deno.lstat(outside)).isDirectory);

  const owned = `${root}/${"c".repeat(16)}`;
  await Deno.mkdir(owned);
  const wrongOwner = await cleanupExactProfile({
    profile: owned,
    root,
    lstatAdapter: async (file: string) => {
      const info = await nodeLstat(file);
      if (file !== owned) return info;
      return {
        uid: (Deno.uid() ?? 0) + 1,
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(),
      };
    },
  });
  assertEquals(wrongOwner.ok, false);
  assertEquals(wrongOwner.removed, false);
  assert((await Deno.lstat(owned)).isDirectory);

  await Deno.remove(root, { recursive: true });
  await Deno.remove(target, { recursive: true });
  await Deno.remove(outsideRoot, { recursive: true });
});

Deno.test("security-suite custody: escaped descendant fails THIS run (exit 70) and leaves no shared marker behind", async () => {
  assertEquals(pidAlive(Deno.pid), true);
  // DECLARED-ORDER PRECONDITION, stated honestly: these three values are declared in THIS file, and this
  // check only fails a future edit that inverts them - nothing at runtime enforces the ordering, so it is
  // NOT a system-contract assertion (independent review finding 1 asked for that to be said rather than
  // implied). The SYSTEM contract is the two checks that follow: the fixture must have RECORDED the window
  // it was handed, and the backstop case must still refuse loudly for a window the ACK cannot meet.
  assert(
    ESCAPE_SAMPLE_FREEZE_MS < ESCAPE_SELF_TEST_BUDGET_MS &&
      ESCAPE_SELF_TEST_BUDGET_MS < ESCAPE_ACK_DEADLINE_MS,
    `declared-order precondition broken (freeze < budget < ack deadline): ${ESCAPE_SAMPLE_FREEZE_MS}/${ESCAPE_SELF_TEST_BUDGET_MS}/${ESCAPE_ACK_DEADLINE_MS}`,
  );
  const result = await runSupervisor("escape", ESCAPE_SELF_TEST_BUDGET_MS, {
    CAP_SECURITY_TEST_ACK_DEADLINE_MS: String(ESCAPE_ACK_DEADLINE_MS),
  });
  let escapedPid = 0;
  let escapedStart = "";
  try {
    assertEquals(result.code, 70);
    // The fixture must have honoured the DECLARED window rather than a private literal: this is what
    // makes the outcome above a property of the contract instead of of the machine's load.
    assertEquals(
      result.state.find((row) => row.event === "escape-ack-deadline-declared")
        ?.ackDeadlineMs,
      ESCAPE_ACK_DEADLINE_MS,
      "the fixture must record the DECLARED window it was given",
    );
    assertEquals(result.receipt?.custodyReason, "descendant-residue");
    const residue = (result.receipt?.residue as Array<Record<string, unknown>>) ?? [];
    assert(residue.length >= 1, "receipt residue must contain at least one process");
    // chrome-agent-platform-wtjz: select escape-child-spawned pid from fixture state and match receipt residue
    // by identity rather than assuming residue[0], avoiding race with transient descendants under parallel load.
    const expectedChildPid = Number(
      result.state.find((row) => row.event === "escape-child-spawned")?.childPid ??
        await escapeChildPidFrom(`${result.receipt?.evidence}/self-test-state.jsonl`),
    );
    assert(
      Number.isSafeInteger(expectedChildPid) && expectedChildPid > 0,
      "fixture state must record escape-child-spawned with valid childPid",
    );
    const matchingResidue = matchEscapeResidueByIdentity(
      residue,
      expectedChildPid,
    );
    escapedPid = Number(matchingResidue.pid);
    escapedStart = String(matchingResidue.starttime);
    const live = await verifyLiveProcOwnership(escapedPid, escapedStart);
    assertEquals(live.starttime, escapedStart);
    assertEquals(live.uid, Deno.uid());
    // uzik: the finding is this run's own (receipt + exit code). It must NOT be
    // smeared onto every later run on the box via a shared marker — that was
    // yr6e, a full-suite red caused by another lane's transient file.
    assertEquals(
      await Deno.lstat(RETIRED_POISON).catch(() => null),
      null,
      "the retired poison marker must not be recreated",
    );
  } finally {
    if (escapedPid === 0 && Array.isArray(result?.state)) {
      const row = result.state.find((r) => r.event === "escape-child-spawned");
      if (typeof row?.childPid === "number") escapedPid = row.childPid;
    }
    if (escapedPid > 0) {
      try {
        const live = await readProcIdentity(escapedPid);
        if (escapedStart === "" || (live.starttime === escapedStart && live.uid === Deno.uid())) {
          Deno.kill(escapedPid, "SIGKILL");
        }
      } catch {
        // Already gone.
      }
      await waitUntil(() => pidAlive(escapedPid), REAP_SETTLE_TIMEOUT_MS);
    }
    await removeEvidence(result);
  }
  assertEquals(pidAlive(escapedPid), false);
});

Deno.test(
  "security-suite custody: an escape descendant that fails to persist fails the scenario loudly, never as a silent pass (7poq)",
  async () => {
    // The nightly full-suite red (chrome-agent-platform-7poq): the escape
    // scenario's descendant did not persist (spawn failure / death under
    // 32-worker suite pressure), the fixture still exited 0, and the run
    // looked exactly like a clean custody pass. The fixture must refuse the
    // scenario (exit 97) when it cannot establish the escape it promises;
    // the mutant below kills the descendant to reproduce that shape.
    const result = await runSupervisor("escape", 2_000, {
      CAP_SECURITY_TEST_ESCAPE_CHILD_FAIL: "1",
    });
    try {
      assertEquals(result.receipt?.exit, 97);
      assertEquals(result.receipt?.result, "FAIL");
      assertEquals(result.receipt?.custodyReason, "");
      assert(
        result.state.some((r) =>
          r.event === "escape-child-not-persistent" ||
          r.event === "escape-child-spawn-error" ||
          r.event === "escape-unconfirmed"
        ),
        `fixture must record WHY the scenario could not run: ${
          JSON.stringify(result.state)
        }`,
      );
    } finally {
      await removeEvidence(result);
    }
  },
);


Deno.test("uzik guard: the shared Chrome-slot poison mechanism is gone from production source", async () => {
  // Deleting coverage requires a guard: the poison marker only existed because
  // the whole machine shared ONE Chrome slot. Per-instance isolation (own
  // profile + kernel-assigned port) plus a bounded slot semaphore removes the
  // shared state it protected, and the marker itself became the defect (yr6e).
  // If it ever comes back, this fails — re-justify it in a bead, do not
  // silently reintroduce a machine-wide refusal path.
  const files = [
    "scripts/security-suite-custody.mjs",
    "scripts/security-suite-supervisor.mjs",
    "scripts/security-suite-supervisor.sh",
    "scripts/lib/chrome-launch.ts",
    "scripts/lib/chrome-slots.ts",
  ];
  for (const rel of files) {
    const text = await Deno.readTextFile(`${ROOT}/${rel}`);
    const code = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    assertEquals(code.includes("SLOT_POISON"), false, `${rel} still references SLOT_POISON in code`);
    assertEquals(code.includes("cap-chrome-slot-POISON"), false, `${rel} still names the poison marker in code`);
    assertEquals(code.includes("poisonReason"), false, `${rel} still reports poisonReason (use custodyReason)`);
  }
  // And the retired marker is not sitting on this box making gates refuse.
  assertEquals(await Deno.lstat(RETIRED_POISON).catch(() => null), null);
});

Deno.test(
  "d5st: the escape is still detected when the supervisor's sampling misses the runner's whole lifetime (forced window)",
  async () => {
    // The blind window (chrome-agent-platform-d5st): the escape child is
    // setsid'd, so its only link to the attested group is ppid -> runner
    // while the runner lives. The supervisor samples on its own event loop;
    // with sampling frozen past the runner's exit, nothing was ever
    // observed, residue came back empty, and the run exited 0 — a silent
    // pass. The handshake makes the runner wait for the supervisor's own
    // observation, so the forced window now ends in a DETECTED escape.
    // CAP_SECURITY_TEST_SAMPLE_FREEZE_MS delays the supervisor's first
    // sample past the point where an un-handshaked runner has already exited.
    const result = await runSupervisor("escape", ESCAPE_SELF_TEST_BUDGET_MS, {
      CAP_SECURITY_TEST_SAMPLE_FREEZE_MS: String(ESCAPE_SAMPLE_FREEZE_MS),
      CAP_SECURITY_TEST_ACK_DEADLINE_MS: String(ESCAPE_ACK_DEADLINE_MS),
    });
    let escapedPid = 0;
    let escapedStart = "";
    try {
      assertEquals(result.code, 70);
      // Same declaration check as the sibling case: the forced blind window must still sit inside the
      // window the fixture was GIVEN, not inside a literal only the fixture knew.
      assertEquals(
        result.state.find((row) => row.event === "escape-ack-deadline-declared")
          ?.ackDeadlineMs,
        ESCAPE_ACK_DEADLINE_MS,
        "the fixture must record the DECLARED window it was given",
      );
      assertEquals(result.receipt?.sampleFreezeMs, ESCAPE_SAMPLE_FREEZE_MS, "the supervisor receipt must record the declared sample freeze window");
      assertEquals(result.receipt?.custodyReason, "descendant-residue");
      const residue = (result.receipt?.residue as Array<Record<string, unknown>>) ?? [];
      assert(residue.length >= 1, "receipt residue must contain at least one process");
      // chrome-agent-platform-wtjz: select escape-child-spawned pid from fixture state and match receipt residue
      // by identity rather than assuming residue[0], avoiding race with transient descendants under parallel load.
      const expectedChildPid = Number(
        result.state.find((row) => row.event === "escape-child-spawned")?.childPid ??
          await escapeChildPidFrom(`${result.receipt?.evidence}/self-test-state.jsonl`),
      );
      assert(
        Number.isSafeInteger(expectedChildPid) && expectedChildPid > 0,
        "fixture state must record escape-child-spawned with valid childPid",
      );
      const matchingResidue = matchEscapeResidueByIdentity(
        residue,
        expectedChildPid,
      );
      escapedPid = Number(matchingResidue.pid);
      escapedStart = String(matchingResidue.starttime);
      const live = await verifyLiveProcOwnership(escapedPid, escapedStart);
      assertEquals(live.starttime, escapedStart);
      assertEquals(live.uid, Deno.uid());
      /**
       * d2vz: 70/residue is only HALF the guard. The handshake's other half is
       * that the runner CONSUMED the supervisor's ACK for its real child — the
       * fixture records that as `escape-observed-by-supervisor`, and records
       * `escape-unconfirmed` when the handshake did not complete (which is what
       * an unimported reader made it record silently). Requiring the first and
       * rejecting the second is what makes this case about the handshake rather
       * than about the outer exit code.
       */
      const events = (Array.isArray(result.state) ? result.state : []).map((r) => r?.event);
      assert(
        events.includes("escape-observed-by-supervisor"),
        `the supervisor's ACK must be consumed for this run's child (state events: ${JSON.stringify(events)})`,
      );
      assert(
        !events.includes("escape-unconfirmed"),
        "the fixture must not report escape-unconfirmed when its ACK named the child",
      );
    } finally {
      // Reap the child THIS case created, bound to its recorded identity
      // (pid + starttime + uid). Never a prefix scan, never a foreign process.
      if (escapedPid === 0 && Array.isArray(result?.state)) {
        const row = result.state.find((r) => r.event === "escape-child-spawned");
        if (typeof row?.childPid === "number") escapedPid = row.childPid;
      }
      if (escapedPid > 0) {
        try {
          const live = await readProcIdentity(escapedPid);
          if (escapedStart === "" || (live.starttime === escapedStart && live.uid === Deno.uid())) {
            Deno.kill(escapedPid, "SIGKILL");
          }
        } catch {
          // Already gone.
        }
        const gone = await waitUntil(() => pidAlive(escapedPid), REAP_SETTLE_TIMEOUT_MS);
        assert(gone, `the fixture's escaped child ${escapedPid} must be gone after teardown`);
      }
      await removeEvidence(result);
    }
  },
);

// ── chrome-agent-platform-2zqd: the BACKSTOP stays pinned ────────────────────────────────────────────
// The two escape cases above now hand the fixture a window that the supervisor's own budget settles
// first, so the fixture's refusal no longer fires in the POSITIVE case. This is the case that stops the
// refusal path becoming vacuous: run the fixture DIRECTLY (no supervisor, so the ACK can never list the
// child) with a DECLARED window of 1 ms. The refusal must be loud and BY NAME, and the window it was
// given must be the window it records - so deleting the deadline branch, or ignoring the declaration,
// reds here instead of silently passing.
Deno.test("2zqd: a declared window the ACK cannot meet still records the loud refusal by name (the backstop is pinned)", async () => {
  const dir = durableDir(`2zqd-ack-refusal-${Deno.pid}`);
  const stateFile = `${dir}/self-test-state.jsonl`;
  const ackPath = `${dir}/sample-ack.json`;
  // A well-formed ACK that NEVER lists the child: the handshake can never confirm.
  await Deno.writeTextFile(ackPath, `${JSON.stringify({ pids: [] })}\n`);
  let childPid = 0;
  try {
    const r = await command("node", [FIXTURE], {
      CAP_SECURITY_TEST_SCENARIO: "escape",
      CAP_SECURITY_TEST_STATE: stateFile,
      CAP_SECURITY_SAMPLE_ACK: ackPath,
      CAP_SECURITY_TEST_ACK_DEADLINE_MS: "1",
    }, 20);
    assertEquals(r.code, 97, "a window the ACK can never meet must produce the fixture's loud refusal");
    const events = (await Deno.readTextFile(stateFile)).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line));
    const named = events.map((row) => row.event);
    const declared = events.find((row) => row.event === "escape-ack-deadline-declared");
    assert(named.includes("escape-ack-deadline-declared"), `the declared window must be recorded: ${named.join(",")}`);
    assertEquals(declared?.ackDeadlineMs, 1, "the recorded window must be the value the fixture was GIVEN");
    assert(named.includes("escape-unconfirmed"), `the refusal must be recorded BY NAME: ${named.join(",")}`);
    childPid = Number(declared?.childPid ?? 0);
  } finally {
    // Recover the pid from ANY state row that recorded one, not only the row this test happened to read
    // before asserting: independent review finding 2 showed that when the code-97 assertion throws, the
    // local was still 0 and the escape child was left running until its 30 s unref timer (which is exactly
    // what the drill that produced code 143 did). The fixture records escape-child-spawned in every escape
    // run, so this always finds it.
    if (childPid === 0) childPid = await escapeChildPidFrom(stateFile);
    if (childPid > 0) {
      try {
        Deno.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// chrome-agent-platform-2zqd: the BOUNDS CHECK is a branch of its own and needs its own pin - independent
// review finding 3 measured that DELETING it left the whole suite green. An invalid declaration must be
// refused LOUDLY and BY NAME rather than silently defaulted, and it must not be recorded as honoured.
Deno.test("2zqd: an INVALID declared window is refused loudly and by name (the bounds check is pinned)", async () => {
  const dir = durableDir(`2zqd-ack-invalid-${Deno.pid}`);
  const stateFile = `${dir}/self-test-state.jsonl`;
  const ackPath = `${dir}/sample-ack.json`;
  await Deno.writeTextFile(ackPath, `${JSON.stringify({ pids: [] })}\n`);
  let childPid = 0;
  try {
    const r = await command("node", [FIXTURE], {
      CAP_SECURITY_TEST_SCENARIO: "escape",
      CAP_SECURITY_TEST_STATE: stateFile,
      CAP_SECURITY_SAMPLE_ACK: ackPath,
      CAP_SECURITY_TEST_ACK_DEADLINE_MS: "not-a-number",
    }, 20);
    assertEquals(r.code, 97, "an invalid declared window must be refused loudly, never silently defaulted");
    const events = (await Deno.readTextFile(stateFile)).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line));
    const named = events.map((row) => row.event);
    assert(
      named.includes("escape-ack-deadline-invalid"),
      `the refusal must be recorded BY NAME: ${named.join(",")}`,
    );
    assert(
      !named.includes("escape-ack-deadline-declared"),
      `an invalid window must not be recorded as honoured: ${named.join(",")}`,
    );
  } finally {
    childPid = await escapeChildPidFrom(stateFile);
    if (childPid > 0) {
      try {
        Deno.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// chrome-agent-platform-wtjz: residue matching selects escape child by identity even when foreign residue precedes it
Deno.test("security-suite custody: residue matching selects escape child by identity even when foreign residue precedes it", () => {
  const residue = [
    { pid: 99999, starttime: "12345", pgid: 99999, sid: 99999 },
    { pid: 54321, starttime: "67890", pgid: 54321, sid: 54321 },
  ];
  const expectedChildPid = 54321;
  const match = matchEscapeResidueByIdentity(residue, expectedChildPid);
  assertEquals(match.pid, 54321);
  assertEquals(match.starttime, "67890");
});

// chrome-agent-platform-wtjz: verifyLiveProcOwnership fails with named reason rather than raw ENOENT for non-existent pid
Deno.test("security-suite custody: verifyLiveProcOwnership fails with named reason rather than raw ENOENT for non-existent pid", async () => {
  const deadPid = 999999999;
  await assertRejects(
    () => verifyLiveProcOwnership(deadPid, "12345", 50),
    Error,
    `custody verification failed for pid ${deadPid}`,
  );
});
