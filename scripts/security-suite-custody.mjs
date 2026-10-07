// Shared live custody helpers for the serialized real-Chromium security suite.
// Production supervision and no-Chrome mutants call these same functions.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fstatSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { durableDir } from "./lib/durable-root.mjs";

const execFileAsync = promisify(execFile);
const HAS_PROC = (() => {
  try { return statSync("/proc").isDirectory(); } catch { return false; }
})();

export const CANONICAL_LOCK = "/tmp/cap-serialized-chrome-acceptance.lock";
// SLOT_POISON ("/tmp/cap-chrome-slot-POISON") was retired by
// chrome-agent-platform-uzik. It existed because the whole machine shared ONE
// Chrome slot: a supervisor that saw residue after its run marked the slot
// poisoned so the NEXT lane would refuse to use a contaminated browser. With
// per-instance isolation (own profile, kernel-assigned port) and a bounded
// slot semaphore there is no shared slot to contaminate, and the marker itself
// became the defect (chrome-agent-platform-yr6e: a transient marker from an
// unrelated lane turned a full `npm test` red). Custody failures are still
// failures — they are reported per run (exit 70/71/72 + `custodyReason` in the
// receipt) instead of being smeared across every later run on the box.
export const PROFILE_ROOT = durableDir("cap-sec-profiles");
export const PRODUCTION_TIMEOUT_MS = 120_000;
export const SELF_TEST_TOKEN = "security-suite-custody-v1";

const RUN_ID_PATTERN = /^[a-f0-9]{16}$/u;
const NONCE_PATTERN = /^[a-f0-9]{32}$/u;

export function parseProcStat(raw) {
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error("malformed proc stat");
  const pid = Number(raw.slice(0, raw.indexOf(" ")));
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const identity = {
    pid,
    state: fields[0] ?? "",
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    starttime: fields[19] ?? "",
  };
  if (
    !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
    !Number.isSafeInteger(identity.ppid) || identity.ppid < 0 ||
    !Number.isSafeInteger(identity.pgid) || identity.pgid <= 0 ||
    !Number.isSafeInteger(identity.sid) || identity.sid <= 0 ||
    !/^\d+$/u.test(identity.starttime)
  ) throw new Error("invalid proc identity");
  return identity;
}

function parsePsIdentityLine(line) {
  const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
  if (!m) return null;
  const pid = Number(m[1]);
  const state = m[2][0] ?? "";
  const ppid = Number(m[3]);
  const pgid = Number(m[4]);
  const uid = Number(m[5]);
  const lstart = m[6].trim().replace(/\s+/gu, " ");
  const parsedMs = Date.parse(lstart);
  const starttime = Number.isFinite(parsedMs) && parsedMs > 0
    ? String(Math.floor(parsedMs / 1000))
    : Array.from(Buffer.from(lstart, "utf8"), (b) => String(b).padStart(3, "0")).join("");
  if (
    !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(ppid) || ppid < 0 ||
    !Number.isSafeInteger(pgid) || pgid <= 0 ||
    !/^\d+$/u.test(starttime)
  ) return null;
  return {
    pid,
    state,
    ppid,
    pgid,
    sid: pgid,
    starttime,
    uid,
  };
}

export async function readProcIdentity(pid) {
  if (!HAS_PROC) {
    const { stdout } = await execFileAsync("/bin/ps", [
      "-o",
      "pid=,state=,ppid=,pgid=,uid=,lstart=",
      "-p",
      String(pid),
    ]);
    const parsed = parsePsIdentityLine(stdout.trim());
    if (!parsed) throw new Error("process not found");
    return parsed;
  }
  const [raw, procInfo] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    stat(`/proc/${pid}`),
  ]);
  return { ...parseProcStat(raw), uid: procInfo.uid };
}

export async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyInheritedCanonicalLock(fd = 9) {
  if (!HAS_PROC) {
    let fdStat;
    try {
      fdStat = fstatSync(fd);
    } catch {
      return "canonical inherited lock fd is missing";
    }
    let lockStat;
    try {
      lockStat = statSync(CANONICAL_LOCK);
    } catch {
      return "inherited lock fd has the wrong target";
    }
    if (fdStat.dev !== lockStat.dev || fdStat.ino !== lockStat.ino) {
      return "inherited lock fd has the wrong target";
    }
    try {
      await execFileAsync("flock", ["-n", CANONICAL_LOCK, "true"]);
      return "canonical inherited lock has no live exclusive flock";
    } catch (error) {
      // Only a contention exit proves that another process holds the lock.
      // In particular, a missing flock binary must fail closed on Darwin.
      if (error?.code === 1) return null;
      return "canonical inherited lock could not be verified";
    }
  }
  let target;
  let fdinfo;
  try {
    [target, fdinfo] = await Promise.all([
      readlink(`/proc/self/fd/${fd}`),
      readFile(`/proc/self/fdinfo/${fd}`, "utf8"),
    ]);
  } catch {
    return "canonical inherited lock fd is missing";
  }
  if (target !== CANONICAL_LOCK) {
    return "inherited lock fd has the wrong target";
  }
  const lockLine = fdinfo.split("\n").find((line) => line.startsWith("lock:"));
  if (
    !lockLine ||
    !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+[1-9]\d*\s+/u.test(
      lockLine,
    )
  ) return "canonical inherited lock has no live exclusive flock";
  return null;
}

export async function verifyRunnerGuard({ env, now = Date.now(), fd = 9 }) {
  const nonce = env.CAP_SECURITY_NONCE ?? "";
  const guardPath = env.CAP_SECURITY_GUARD ?? "";
  const parentPid = Number(env.CAP_SECURITY_PARENT ?? "0");
  if (
    !NONCE_PATTERN.test(nonce) || !guardPath ||
    !Number.isSafeInteger(parentPid) || parentPid <= 0
  ) {
    return "not invoked by the canonical supervisor";
  }

  let guard;
  try {
    const info = await lstat(guardPath);
    if (
      !info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
    ) {
      return "guard record is not an owned regular file";
    }
    const raw = await readFile(guardPath, "utf8");
    if (raw.length > 4096) return "guard record is oversized";
    guard = JSON.parse(raw);
  } catch {
    return "guard record unreadable";
  }
  if (guard.schemaVersion !== 1 || guard.nonce !== nonce) {
    return "nonce mismatch";
  }
  if (guard.parentPid !== parentPid) return "guard parent mismatch";
  if (guard.lockPath !== CANONICAL_LOCK) return "wrong lock path in the guard";
  if (
    !Number.isSafeInteger(guard.issuedAt) ||
    Math.abs(now - guard.issuedAt) > 5 * 60_000
  ) return "guard record is stale";
  try {
    const parent = await readProcIdentity(parentPid);
    if (parent.starttime !== String(guard.parentStart)) {
      return "stale parent identity";
    }
  } catch {
    return "parent identity unverifiable";
  }
  return await verifyInheritedCanonicalLock(fd);
}

export async function inspectOwnedDirectory({
  directory,
  expectedUid = process.getuid(),
  lstatAdapter = lstat,
}) {
  try {
    const info = await lstatAdapter(directory);
    if (
      !info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid
    ) {
      return { ok: false, reason: "path is not an owned regular directory" };
    }
    return { ok: true, directory: path.resolve(directory) };
  } catch {
    return { ok: false, reason: "owned directory is missing" };
  }
}

export async function inspectExactProfile({
  profile,
  root = PROFILE_ROOT,
  expectedUid = process.getuid(),
  lstatAdapter = lstat,
}) {
  const absoluteRoot = path.resolve(root);
  const absoluteProfile = path.resolve(profile);
  if (
    path.dirname(absoluteProfile) !== absoluteRoot ||
    !RUN_ID_PATTERN.test(path.basename(absoluteProfile))
  ) return { ok: false, reason: "profile has the wrong exact prefix" };

  let rootInfo;
  let profileInfo;
  try {
    [rootInfo, profileInfo] = await Promise.all([
      lstatAdapter(absoluteRoot),
      lstatAdapter(absoluteProfile),
    ]);
  } catch {
    return { ok: false, reason: "profile or profile root is missing" };
  }
  if (
    !rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
    rootInfo.uid !== expectedUid
  ) {
    return {
      ok: false,
      reason: "profile root is not an owned regular directory",
    };
  }
  if (
    !profileInfo.isDirectory() || profileInfo.isSymbolicLink() ||
    profileInfo.uid !== expectedUid
  ) return { ok: false, reason: "profile is not an owned regular directory" };
  return { ok: true, profile: absoluteProfile };
}

export async function cleanupExactProfile(options) {
  const inspected = await inspectExactProfile(options);
  if (!inspected.ok) return { ...inspected, removed: false };
  const removeAdapter = options.removeAdapter ?? rm;
  await removeAdapter(inspected.profile, { recursive: true, force: false });
  return { ok: true, removed: true, profile: inspected.profile };
}

export async function attestOwnedGroup(pid, {
  expectedUid = process.getuid(),
  readIdentity = readProcIdentity,
} = {}) {
  const identity = await readIdentity(pid);
  if (
    identity.pid !== pid || identity.pgid !== pid || identity.sid !== pid ||
    identity.uid !== expectedUid
  ) {
    return {
      ok: false,
      reason:
        `PGID/SID attestation failed: pid=${pid} pgid=${identity.pgid} sid=${identity.sid}`,
      identity,
    };
  }
  return { ok: true, identity };
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(predicate, timeoutMs, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !await predicate();
}

async function procIdentities() {
  const rows = [];
  if (!HAS_PROC) {
    try {
      const { stdout } = await execFileAsync("/bin/ps", [
        "-axo",
        "pid=,state=,ppid=,pgid=,uid=,lstart=",
      ]);
      for (const line of stdout.split("\n")) {
        const parsed = parsePsIdentityLine(line);
        if (parsed) rows.push(parsed);
      }
    } catch {
      // ignore
    }
    return rows;
  }
  // A plain name listing: with `withFileTypes` Node lstat()s entries whose
  // type the kernel does not report, and a process that exits between the
  // listing and that lstat rejects the WHOLE readdir (ENOENT /proc/<pid>) —
  // which crashed the supervisor under process churn
  // (CAP-FB-20260830-SUITE-HONESTY-01). Numeric /proc entries are always
  // process directories, so no type check is needed.
  let names;
  try {
    names = await readdir("/proc");
  } catch {
    return rows;
  }
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      rows.push(await readProcIdentity(Number(name)));
    } catch {
      // Process exited while /proc was sampled.
    }
  }
  return rows;
}

export async function observeDescendants(rootPid, observed = new Map()) {
  const rows = await procIdentities();
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  for (const row of rows) {
    if (row.pid !== rootPid && descendants.has(row.pid)) {
      observed.set(row.pid, row);
    }
  }
  return observed;
}

export async function liveObservedResidue(observed) {
  const residue = [];
  for (const expected of observed.values()) {
    try {
      const current = await readProcIdentity(expected.pid);
      if (
        current.starttime === expected.starttime &&
        current.uid === expected.uid &&
        current.state !== "Z"
      ) residue.push(current);
    } catch {
      // Gone is clean.
    }
  }
  return residue;
}

export async function terminateAttestedGroup({
  attestation,
  observed,
  termWaitMs,
  killWaitMs,
}) {
  const pgid = attestation.identity.pgid;
  const leaderStart = attestation.identity.starttime;
  if (!groupAlive(pgid)) {
    return { termSent: false, killSent: false, survived: false };
  }
  try {
    const current = await readProcIdentity(attestation.identity.pid);
    if (
      current.starttime !== leaderStart || current.pgid !== pgid ||
      current.sid !== attestation.identity.sid ||
      current.uid !== attestation.identity.uid
    ) throw new Error("owned process-group identity changed");
  } catch (error) {
    // The leader may exit while owned descendants remain. In that case every
    // currently live group member must have been observed as this runner's
    // exact pid/starttime/uid descendant before any negative-PGID signal.
    const rows = (await procIdentities()).filter((row) => row.pgid === pgid);
    if (
      rows.length === 0 || rows.some((row) => {
        const prior = observed.get(row.pid);
        return !prior || prior.starttime !== row.starttime ||
          prior.uid !== row.uid;
      })
    ) throw error;
  }

  process.kill(-pgid, "SIGTERM");
  const termGone = await waitUntil(() => groupAlive(pgid), termWaitMs);
  if (termGone) return { termSent: true, killSent: false, survived: false };
  process.kill(-pgid, "SIGKILL");
  const killGone = await waitUntil(() => groupAlive(pgid), killWaitMs);
  return { termSent: true, killSent: true, survived: !killGone };
}

export async function resolveSupervisorConfig({
  env,
  repoRoot,
  expectedFixtureHash,
}) {
  const productionRunner = path.join(repoRoot, "scripts", "security-suite.ts");
  if (env.CAP_SECURITY_SELF_TEST !== SELF_TEST_TOKEN) {
    if (
      env.CAP_SECURITY_RUNNER || env.CAP_SECURITY_SELF_TEST_TIMEOUT_MS ||
      env.CAP_SECURITY_TEST_FORCE_ATTEST_MISMATCH ||
      env.CAP_SECURITY_TEST_ATTEST_DEADLINE_MS !== undefined ||
      env.CAP_SECURITY_TEST_FORCE_ATTEST_UNSETTLED !== undefined ||
      env.CAP_SECURITY_TEST_SAMPLE_FREEZE_MS !== undefined ||
      env.CAP_SECURITY_TEST_ACK_DEADLINE_MS !== undefined ||
      env.CAP_SECURITY_TEST_STUBBORN_BOOT_DELAY_MS !== undefined ||
      env.CAP_SECURITY_TEST_STUBBORN_CHILD_FAIL !== undefined ||
      env.CAP_SECURITY_TEST_ESCAPE_CHILD_FAIL !== undefined ||
      env.CAP_SECURITY_TEST_SCENARIO
    ) throw new Error("self-test-only override refused in production mode");
    if (!env.HOME || !path.isAbsolute(env.HOME)) {
      throw new Error("production HOME must be an absolute path");
    }
    return {
      selfTest: false,
      runner: productionRunner,
      command: "deno",
      args: ["run", "-A", productionRunner],
      timeoutMs: PRODUCTION_TIMEOUT_MS,
      attestDeadlineMs: 2_000,
      forceAttestationUnsettled: false,
      sampleFreezeMs: 0,
      termWaitMs: 5_000,
      killWaitMs: 5_000,
      evidenceRoot: path.join(
        env.HOME ?? "",
        ".local/state/chrome-agent-platform/security-suite",
      ),
      profileRoot: PROFILE_ROOT,
      forceAttestationMismatch: false,
      scenario: "production",
    };
  }

  const fixture = path.join(
    repoRoot,
    "tests",
    "fixtures",
    "security-suite-fake-runner.mjs",
  );
  const supplied = env.CAP_SECURITY_RUNNER ?? "";
  let fixtureInfo;
  try {
    fixtureInfo = await lstat(supplied);
  } catch {
    throw new Error("self-test fixture is missing");
  }
  if (
    supplied !== fixture || fixtureInfo.isSymbolicLink() ||
    !fixtureInfo.isFile() ||
    await realpath(supplied) !== fixture ||
    await sha256File(supplied) !== expectedFixtureHash
  ) throw new Error("self-test runner path/hash refused");

  const scenarios = new Set([
    "guard",
    "exit37",
    "signal",
    "timeout",
    "stubborn",
    "pgid-mismatch",
    "escape",
    "serialize",
  ]);
  const scenario = env.CAP_SECURITY_TEST_SCENARIO ?? "";
  if (!scenarios.has(scenario)) throw new Error("unknown self-test scenario");
  const timeoutMs = Number(env.CAP_SECURITY_SELF_TEST_TIMEOUT_MS ?? "1000");
  // chrome-agent-platform-2zqd: the upper bound is TEST-ONLY headroom, raised from 5_000 so a
  // declared self-test budget can sit ~3.6x above the worst first-sample/ACK latency measured on
  // this box (2_800 ms at loadavg ~10). An absurd value is still refused, and the lower bound is
  // unchanged, so this is not a general timeout increase.
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 20_000
  ) {
    throw new Error("self-test timeout is out of bounds");
  }
  // zfsl: the second, PRE-SAMPLE handshake clock. Preserve the production/default 2 s,
  // but make a self-test's settle window declared and bounded rather than a private literal.
  const attestDeadlineMs = Number(env.CAP_SECURITY_TEST_ATTEST_DEADLINE_MS ?? "2000");
  if (!Number.isSafeInteger(attestDeadlineMs) || attestDeadlineMs < 1 || attestDeadlineMs > 20_000) {
    throw new Error("CAP_SECURITY_TEST_ATTEST_DEADLINE_MS out of bounds (1..20000)");
  }
  if (env.CAP_SECURITY_TEST_FORCE_ATTEST_UNSETTLED !== undefined &&
      env.CAP_SECURITY_TEST_FORCE_ATTEST_UNSETTLED !== "1") {
    throw new Error("CAP_SECURITY_TEST_FORCE_ATTEST_UNSETTLED must be 1");
  }
  // a6x5: the third, SAMPLING-DELAY handshake clock. Preserve 0 ms default,
  // but ensure any declared test freeze is bounded and integer.
  const sampleFreezeMs = Number(env.CAP_SECURITY_TEST_SAMPLE_FREEZE_MS ?? "0");
  if (!Number.isSafeInteger(sampleFreezeMs) || sampleFreezeMs < 0 || sampleFreezeMs > 20_000) {
    throw new Error("CAP_SECURITY_TEST_SAMPLE_FREEZE_MS out of bounds (0..20000)");
  }
  return {
    selfTest: true,
    runner: fixture,
    command: process.execPath,
    args: [fixture],
    timeoutMs,
    attestDeadlineMs,
    forceAttestationUnsettled: env.CAP_SECURITY_TEST_FORCE_ATTEST_UNSETTLED === "1",
    sampleFreezeMs,
    termWaitMs: 250,
    killWaitMs: 1_000,
    evidenceRoot: durableDir("cap-sec-selftest-evidence"),
    profileRoot: PROFILE_ROOT,
    forceAttestationMismatch: scenario === "pgid-mismatch" &&
      env.CAP_SECURITY_TEST_FORCE_ATTEST_MISMATCH === "1",
    scenario,
  };
}

export async function makeReadOnly(paths) {
  for (const file of paths) {
    await chmod(file, 0o400).catch(() => {});
  }
}
