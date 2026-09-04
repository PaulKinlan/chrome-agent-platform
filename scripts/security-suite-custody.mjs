// Shared live custody helpers for the serialized real-Chromium security suite.
// Production supervision and no-Chrome mutants call these same functions.

import { createHash } from "node:crypto";
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
import { durableDir } from "./lib/durable-root.mjs";

export const CANONICAL_LOCK = "/tmp/cap-serialized-chrome-acceptance.lock";
export const SLOT_POISON = "/tmp/cap-chrome-slot-POISON";
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

export async function readProcIdentity(pid) {
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
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5_000
  ) {
    throw new Error("self-test timeout is out of bounds");
  }
  return {
    selfTest: true,
    runner: fixture,
    command: process.execPath,
    args: [fixture],
    timeoutMs,
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
