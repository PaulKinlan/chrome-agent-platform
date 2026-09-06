// Executable, no-Chrome custody proof for the canonical security-suite
// supervisor. Every process mutant runs the real supervisor and the one exact
// hash-pinned repository fixture; cleanup mutants call the same exported live
// helper used by production supervision.

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

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
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
    if (escapedPid > 0) {
      try {
        const live = await readProcIdentity(escapedPid);
        if (live.starttime === escapedStart && live.uid === Deno.uid()) {
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
