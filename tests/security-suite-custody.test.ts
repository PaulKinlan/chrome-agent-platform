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
  isVanishedGroupError,
  isVanishedProcError,
  pidAlive,
  PROFILE_ROOT,
  readProcIdentity,
  resolveSupervisorConfig,
  SELF_TEST_TOKEN,
  terminateAttestedGroup,
  waitUntil,
} from "../scripts/security-suite-custody.mjs";

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
    }, 2_000);
    assert(gone, `fixture pid ${pid} survived owned-group cleanup`);
  }
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

Deno.test("security-suite custody: the valid supervisor chain passes the live inherited-lock guard", async () => {
  const result = await runSupervisor("guard", 2_000);
  try {
    assertEquals(result.code, 0);
    assertEquals(result.receipt?.result, "PASS");
    const guardResult = result.state.find((row) =>
      row.event === "guard-result"
    );
    assertEquals(guardResult?.error, null);
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
  const result = await runSupervisor("stubborn", 350);
  try {
    assertEquals(result.code, 124);
    assertEquals(result.receipt?.termSent, true);
    assertEquals(result.receipt?.killSent, true);
    assertEquals(result.receipt?.groupSurvived, false);
    assert(result.state.some((row) => row.event === "runner-term-ignored"));
    assert(result.state.some((row) => row.event === "stubborn-child-term"));
    assertEquals((result.receipt?.residue as unknown[])?.length, 0);
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
  const result = await runSupervisor("escape", 2_000);
  let escapedPid = 0;
  let escapedStart = "";
  try {
    assertEquals(result.code, 70);
    assertEquals(result.receipt?.custodyReason, "descendant-residue");
    const residue = result.receipt?.residue as Array<Record<string, unknown>>;
    assert(residue.length >= 1);
    escapedPid = Number(residue[0].pid);
    escapedStart = String(residue[0].starttime);
    const live = await readProcIdentity(escapedPid);
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
      await waitUntil(() => pidAlive(escapedPid), 2_000);
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
    const result = await runSupervisor("escape", 2_000, {
      CAP_SECURITY_TEST_SAMPLE_FREEZE_MS: "400",
    });
    let escapedPid = 0;
    let escapedStart = "";
    try {
      assertEquals(result.code, 70);
      assertEquals(result.receipt?.custodyReason, "descendant-residue");
      const residue = result.receipt?.residue as Array<Record<string, unknown>>;
      assert(residue.length >= 1);
      escapedPid = Number(residue[0].pid);
      escapedStart = String(residue[0].starttime);
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
        const gone = await waitUntil(() => pidAlive(escapedPid), 2_000);
        assert(gone, `the fixture's escaped child ${escapedPid} must be gone after teardown`);
      }
      await removeEvidence(result);
    }
  },
);

// ── chrome-agent-platform-8ixk ─────────────────────────────────────────────
// The runner child can exit between terminateAttestedGroup's group-alive check
// and its readProcIdentity call. That ENOENT used to be rethrown out of the
// supervisor as an uncaught rejection, so the run wrote NO receipt at all — no
// CAP_SECURITY_RESULT, no verdict — and a death this way read as environmental
// because there was nothing left to read. Observed for real: killing the runner
// mid-run produced `ENOENT: no such file or directory, open '/proc/<pid>/stat'`
// at readProcIdentity <- terminateAttestedGroup, and an evidence directory with
// no receipt in it.
//
// The race is INJECTED, not timed: readIdentity and isAlive are options on
// terminateAttestedGroup, the same pattern attestOwnedGroup already uses for
// readIdentity. A test that waits for a real process to die at the right instant
// would be flaky, and a flaky test of a teardown race is worse than none.
// The pgid/pid are deliberately impossible so no path can reach process.kill.
const DEAD_PGID = 999999;
const DEAD_PID = 999998;
const fakeAttestation = {
  identity: {
    pid: DEAD_PID,
    pgid: DEAD_PGID,
    sid: DEAD_PID,
    starttime: "12345",
    uid: 0,
  },
};
const coded = (code: string) => Object.assign(new Error(code), { code });

Deno.test("8ixk: isVanishedProcError accepts ONLY a disappeared /proc entry", () => {
  assertEquals(isVanishedProcError(coded("ENOENT")), true);
  // An unreadable /proc for a process that still exists is a DIFFERENT fact and
  // must not be laundered into "it exited".
  assertEquals(isVanishedProcError(coded("EACCES")), false);
  assertEquals(isVanishedProcError(coded("ENOTDIR")), false);
  assertEquals(isVanishedProcError(new Error("owned process-group identity changed")), false);
  assertEquals(isVanishedProcError(null), false);
  assertEquals(isVanishedProcError(undefined), false);
});

Deno.test("8ixk: a leader that vanished while its group also died is benign, returned and RECORDED — not rethrown", async () => {
  let aliveCalls = 0;
  const result = await terminateAttestedGroup({
    attestation: fakeAttestation,
    observed: new Map(),
    termWaitMs: 50,
    killWaitMs: 50,
    readIdentity: () => Promise.reject(coded("ENOENT")),
    // true at the entry check, false when the catch re-checks: the race, made
    // deterministic instead of timed.
    isAlive: () => aliveCalls++ === 0,
  });
  // leaderExited is what the supervisor turns into a custodyReason, so the
  // receipt says the child exited before the identity read instead of saying
  // nothing at all.
  assertEquals(result, {
    termSent: false,
    killSent: false,
    survived: false,
    leaderExited: true,
  });
});

Deno.test("8ixk: a vanished leader with the group STILL ALIVE keeps failing closed", async () => {
  // The benign path requires BOTH facts. A dead leader inside a live group still
  // has to pass the observed-descendant ownership check, and an unobserved group
  // must throw rather than be signalled.
  await assertRejects(
    () =>
      terminateAttestedGroup({
        attestation: fakeAttestation,
        observed: new Map(),
        termWaitMs: 50,
        killWaitMs: 50,
        readIdentity: () => Promise.reject(coded("ENOENT")),
        isAlive: () => true,
      }),
    Error,
    "ENOENT",
  );
});

Deno.test("8ixk: a non-ENOENT read failure stays fail-closed even with a dead group", async () => {
  // Proves the benign path is gated on the ERROR KIND and not merely on the group
  // being gone: same alive sequence as the benign case, different error.
  let aliveCalls = 0;
  await assertRejects(
    () =>
      terminateAttestedGroup({
        attestation: fakeAttestation,
        observed: new Map(),
        termWaitMs: 50,
        killWaitMs: 50,
        readIdentity: () => Promise.reject(coded("EACCES")),
        isAlive: () => aliveCalls++ === 0,
      }),
    Error,
    "EACCES",
  );
});

Deno.test("8ixk: an identity CHANGE is still an identity change, not a vanished leader", async () => {
  // The pre-existing ownership check must survive the new early return: a leader
  // that exists but no longer matches the attestation is the dangerous case.
  await assertRejects(
    () =>
      terminateAttestedGroup({
        attestation: fakeAttestation,
        observed: new Map(),
        termWaitMs: 50,
        killWaitMs: 50,
        readIdentity: () =>
          Promise.resolve({
            pid: DEAD_PID,
            state: "S",
            ppid: 1,
            pgid: DEAD_PGID,
            sid: DEAD_PID,
            starttime: "99999", // differs from the attested 12345
            uid: 0,
          }),
        isAlive: () => true,
      }),
    Error,
    "owned process-group identity changed",
  );
});

// ── chrome-agent-platform-8ixk, second race ────────────────────────────────
// Found by cap-astra's independent review with a LIVE owned fixture, at the
// unchanged candidate: both kernel identity reads complete, the own child then
// dies before completion is delivered, and process.kill(-pgid, SIGTERM) throws
// killESRCH — which escaped uncaught, Node exited 1, and NO receipt was written.
// A pre-existing sibling of the ENOENT race, not newly introduced, but the
// acceptance is "an early exit leaves a receipt", which one guarded read does not
// deliver on its own. `kill` is injected so no test ever signals a real group:
// an impossible pgid is inside the pid range on some kernels, and guessing is not
// acceptable in a file that owns signalling.
const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
const eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });
const liveIdentity = {
  pid: DEAD_PID,
  state: "S",
  ppid: 1,
  pgid: DEAD_PGID,
  sid: DEAD_PID,
  starttime: "12345", // matches the attestation, so the identity check passes
  uid: 0,
};

Deno.test("8ixk: isVanishedGroupError accepts ONLY ESRCH", () => {
  assertEquals(isVanishedGroupError(esrch()), true);
  assertEquals(isVanishedGroupError(eperm()), false);
  assertEquals(isVanishedGroupError(coded("ENOENT")), false);
  assertEquals(isVanishedGroupError(new Error("kill EINVAL")), false);
  assertEquals(isVanishedGroupError(null), false);
});

Deno.test("8ixk: a group that dies before SIGTERM reaches it is benign and recorded, not an uncaught ESRCH", async () => {
  const result = await terminateAttestedGroup({
    attestation: fakeAttestation,
    observed: new Map(),
    termWaitMs: 20,
    killWaitMs: 20,
    readIdentity: () => Promise.resolve(liveIdentity),
    isAlive: () => true, // alive at the entry check, so the kill is reached
    kill: () => {
      throw esrch();
    },
  });
  assertEquals(result, {
    termSent: false,
    killSent: false,
    survived: false,
    groupGoneBeforeSignal: true,
  });
});

Deno.test("8ixk: a group that dies during the SIGTERM wait is benign at the SIGKILL escalation too", async () => {
  let calls = 0;
  const result = await terminateAttestedGroup({
    attestation: fakeAttestation,
    observed: new Map(),
    termWaitMs: 20,
    killWaitMs: 20,
    readIdentity: () => Promise.resolve(liveIdentity),
    isAlive: () => true, // never reports gone, so the escalation is reached
    // @types/node declares process.kill as returning the literal `true` (it either
    // returns true or throws), so an injected stand-in has to match that signature.
    kill: (): true => {
      calls += 1;
      if (calls === 1) return true; // SIGTERM "succeeds"
      throw esrch(); // SIGKILL finds nothing
    },
  });
  assertEquals(result, {
    termSent: true,
    killSent: false,
    survived: false,
    groupGoneBeforeSignal: true,
  });
  assertEquals(calls, 2);
});

Deno.test("8ixk: a REFUSAL to signal (EPERM) still propagates — only ESRCH is benign", async () => {
  // The fail-closed boundary for this race: not being allowed to touch a group is
  // a real custody finding and must not be laundered into "it already exited".
  await assertRejects(
    () =>
      terminateAttestedGroup({
        attestation: fakeAttestation,
        observed: new Map(),
        termWaitMs: 20,
        killWaitMs: 20,
        readIdentity: () => Promise.resolve(liveIdentity),
        isAlive: () => true,
        kill: () => {
          throw eperm();
        },
      }),
    Error,
    "EPERM",
  );
});
