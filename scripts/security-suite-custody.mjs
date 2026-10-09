// Shared live custody helpers for the serialized real-Chromium security suite.
// Production supervision and no-Chrome mutants call these same functions.
//
// Platform note (chrome-agent-platform-jjsz): process identity is read from `/proc` where it exists and
// from `/bin/ps` on macOS. `ps` cannot report a session id, so a macOS identity carries `sid` = `pgid` and
// the PGID/SID attestation proves less there (see parsePsIdentityLine and attestOwnedGroup). A `ps` that
// cannot answer is "unreadable", which is never treated as "gone" (see readProcIdentity).

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
  // Linux kernel threads have no userspace process group/session (both 0).
  // kthreadd (pid 2, parent 0) and its direct children (parent 2) cannot
  // descend from our positive-pid runner, but their rows are readable and
  // must not make a healthy /proc scan look unreadable.
  const kernelThread = identity.pgid === 0 && identity.sid === 0 &&
    (identity.pid === 2 && identity.ppid === 0 || identity.ppid === 2);
  if (
    !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
    !Number.isSafeInteger(identity.ppid) || identity.ppid < 0 ||
    (!kernelThread && (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 0 ||
      !Number.isSafeInteger(identity.sid) || identity.sid <= 0)) ||
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
    // NOT A MEASUREMENT (chrome-agent-platform-jjsz F5). macOS `ps` has no session-id keyword (`sess`
    // prints 0 for every process and `tpgid` is the terminal's group), so the session id CANNOT be read
    // here and is set EQUAL TO THE PGID. Consequence: attestOwnedGroup's `sid === pid` half is vacuous on
    // this branch and only `pgid === pid` (+ uid) is proven; see attestOwnedGroup. The STAT column's `s`
    // flag does mark a session leader and could close that gap; it is not wired, and nothing here may
    // read this field as evidence of a session.
    sid: pgid,
    starttime,
    uid,
  };
}

/** `ps` ran, and the process is not there. Carries `code: "ENOENT"` so it has the same shape as the
 *  missing `/proc/<pid>/stat` of the Linux branch (chrome-agent-platform-jjsz F2). */
export class ProcessGoneError extends Error {
  /** @param {number | null} pid */
  constructor(pid) {
    super(`process ${pid} not found`);
    this.name = "ProcessGoneError";
    this.code = "ENOENT";
    this.pid = pid;
  }
}

/** `ps` could NOT tell whether the process exists: a spawn failure, a timeout, a signal, an unexpected
 *  status or stderr, or output that holds nothing parseable. This is never "gone", and it deliberately
 *  does NOT carry `code: "ENOENT"`: a missing `/bin/ps` rejects with a native ENOENT of its own, and the
 *  two must stay distinguishable (chrome-agent-platform-jjsz F2). */
export class ProcessUnreadableError extends Error {
  /** @param {number | null} pid @param {string} detail @param {unknown} [cause] */
  constructor(pid, detail, cause) {
    super(`process ${pid ?? "table"} unreadable: ${detail}`);
    this.name = "ProcessUnreadableError";
    this.code = "EPROCUNREADABLE";
    this.pid = pid;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A wedged `ps` must not hang custody: it is bounded and then killed (SIGKILL, since a wedged ps may
 *  ignore SIGTERM). The whole-table read is larger than a single-pid read, hence the buffer.
 *  `makePsRun(timeoutMs)` builds the runner so a test can shorten the bound and prove it. */
export const PS_TIMEOUT_MS = 5_000;
export const makePsRun = (timeoutMs = PS_TIMEOUT_MS) => (file, args) =>
  execFileAsync(file, args, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
const defaultPsRun = makePsRun();

/**
 * Read one process's identity: `/proc` where it exists, `/bin/ps` where it does not (macOS).
 *
 * The no-/proc branch separates "gone" from "unreadable", because custody treats gone as CLEAN and
 * everything else as unproven (chrome-agent-platform-jjsz F2). ONLY a `ps` that exits 1 with EMPTY
 * stdout AND EMPTY stderr, which is exactly what `ps -p <absent pid>` produces (measured on macOS 15.8),
 * is a ProcessGoneError. Every other outcome is a ProcessUnreadableError: a spawn failure, a timeout, a
 * signal, any other status, any stderr, an exit 0 with an empty or unparseable row.
 *
 * `deps` is a test seam, defaults = today's behaviour: `hasProc` selects the branch (so the macOS one
 * runs on Linux) and `run(file, args)` stands in for the promisified execFile.
 *
 * @param {number} pid
 * @param {{hasProc?: boolean, run?: (file: string, args: string[]) => Promise<{stdout: string, stderr: string}>}} [deps]
 */
export async function readProcIdentity(pid, deps = {}) {
  const { hasProc = HAS_PROC, run = defaultPsRun } = deps;
  if (!hasProc) {
    let stdout;
    try {
      ({ stdout } = await run("/bin/ps", [
        "-o",
        "pid=,state=,ppid=,pgid=,uid=,lstart=",
        "-p",
        String(pid),
      ]));
    } catch (error) {
      if (
        error?.code === 1 && !error.signal && error.killed !== true &&
        error.stdout === "" && error.stderr === ""
      ) throw new ProcessGoneError(pid);
      throw new ProcessUnreadableError(
        pid,
        `ps failed (${error?.code ?? error?.signal ?? error?.message ?? "unknown"})`,
        error,
      );
    }
    const parsed = typeof stdout === "string" ? parsePsIdentityLine(stdout.trim()) : null;
    if (!parsed) throw new ProcessUnreadableError(pid, "ps exited 0 with no parseable row");
    return parsed;
  }
  // Do not race the two reads in Promise.all: an EMFILE from one and ENOENT
  // from the other can otherwise report whichever rejection settles first.
  const procInfo = await stat(`/proc/${pid}`);
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  return { ...parseProcStat(raw), uid: procInfo.uid };
}

/** True only when the error is a /proc entry DISAPPEARING, i.e. the process
 *  exited between the group-alive check and the identity read. Distinguished
 *  from every other read failure, which must stay fail-closed: an unreadable
 *  /proc for a process that still exists is not the same fact as a vanished one.
 *  chrome-agent-platform-8ixk. */
export function isVanishedProcError(error) {
  return error?.code === "ENOENT";
}

/** True only when a signal found NO SUCH PROCESS GROUP — the group finished dying
 *  between the alive check and the kill. Distinguished from every other kill
 *  failure (EPERM, EINVAL), which must still propagate: refusing to signal a group
 *  we are not allowed to touch is a real custody finding, not a benign exit.
 *  chrome-agent-platform-8ixk. */
export function isVanishedGroupError(error) {
  return error?.code === "ESRCH";
}

/** The run's custody finding, derived in ONE place because the ORDER is the
 *  semantics: severe findings displace benign ones, and a benign teardown marker
 *  must never be the reason a receipt reports when something real went wrong.
 *  Precedence, most severe first: descendant residue, then an unverified
 *  process-table observation, then an owned group that survived, followed by
 *  cleanup refusal, teardown throw, and finally benign races. The established
 *  residue-over-survived ordering remains; unverified observation cannot be
 *  displaced by a benign marker. chrome-agent-platform-8ixk / yuu9s. */
export function custodyReasonFor({
  survived = false,
  residueCount = 0,
  observationUnverifiedReason = "",
  cleanupOk = true,
  cleanupReason = "",
  leaderExited = false,
  groupGoneBeforeSignal = false,
  teardownThrew = "",
} = {}) {
  let reason = "";
  if (survived) reason = "owned-group-survived";
  if (observationUnverifiedReason) reason = `observation-unverified:${observationUnverifiedReason}`;
  if (residueCount > 0) reason = "descendant-residue";
  if (!cleanupOk) reason ||= `cleanup-refused:${cleanupReason}`;
  if (teardownThrew) reason ||= `teardown-threw:${teardownThrew}`;
  if (leaderExited) reason ||= "leader-exited-before-identity-read";
  if (groupGoneBeforeSignal) reason ||= "group-gone-before-signal";
  return reason;
}

/** Keep verified receipt bytes unchanged; only an unreadable identity adds evidence. */
export function residueForReceipt(residue) {
  return residue.map(({ pid, starttime, pgid, sid, unverified, unverifiedReason }) => ({
    pid, starttime, pgid, sid,
    ...(unverified ? { unverified: true, unverifiedReason } : {}),
  }));
}

export async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** `flock -n -E <code>` exits with this status when the lock is held by another open file
 *  description. A distinctive value (not the default 1) so a usage error, a signal or a
 *  missing binary can never be mistaken for "held".
 *
 *  It must also sit OUTSIDE every range flock itself uses to report its OWN failures. util-linux
 *  flock exits with sysexits codes when it cannot open the lock file (EX_NOINPUT 66, EX_OSERR 71,
 *  EX_CANTCREAT 73 on a read-only or full filesystem) and EX_USAGE 64 on a usage error, and a
 *  launcher reports 126 (cannot execute), 127 (not found) and 255 by convention. The first draft
 *  chose 73, which collides with the EX_CANTCREAT case (chrome-agent-platform-jjsz). 97 is outside
 *  sysexits 64-78, 126, 127 and 255, and is not 1 (the default conflict status, which a generic
 *  failure also produces). tests/security-suite-lock-probe.test.ts pins this property, not the
 *  number. */
export const FLOCK_HELD_EXIT = 97;

/**
 * No-/proc platforms (macOS) have no `fdinfo` `lock:` line, so liveness of the canonical
 * lock is proven by FAILING to take it ourselves. Only the distinctive "held" status proves
 * it, and only with an EMPTY stderr: every way flock can fail on its own (cannot open the lock
 * file, usage, fork) prints a diagnostic, so a status that merely COLLIDES with FLOCK_HELD_EXIT
 * can never read as held. Acquiring the lock (nobody holds it), a missing `flock`, a signal or any
 * other status all FAIL CLOSED (chrome-agent-platform-jjsz: the first draft returned null for ANY
 * rejection, which read a missing binary as "held"). `run` is injectable so every verdict is
 * testable on every platform.
 *
 * WHAT THIS PROVES ON macOS, AND WHAT IT DOES NOT. Combined with the dev/ino comparison in
 * verifyInheritedCanonicalLock (the file behind fd 9 IS the canonical lock file), a "held" verdict
 * proves the lock file is locked by SOMEONE. It cannot prove that fd 9 ITSELF is the open file
 * description holding the lock: macOS has no `/proc/self/fdinfo`, so nothing attributes the lock to
 * a descriptor. A process that merely inherited a descriptor on the right file while the real holder
 * is somebody else (another supervisor, a stray flock) passes here, and fails on Linux, whose branch
 * reads the `lock:` line of `/proc/self/fdinfo/<fd>`. `flock` is resolved through PATH, exactly as
 * scripts/security-suite-supervisor.sh resolves the `flock -x 9` that takes the lock in the first
 * place, so this adds no trust boundary.
 *
 * @param {string} [lockPath]
 * @param {(file: string, args: string[]) => Promise<unknown>} [run]
 * @returns {Promise<string | null>} null when the lock is proven held, else the refusal reason.
 */
export async function probeCanonicalLockHeld(
  lockPath = CANONICAL_LOCK,
  run = (file, args) => execFileAsync(file, args),
) {
  try {
    await run("flock", ["-n", "-E", String(FLOCK_HELD_EXIT), lockPath, "true"]);
    return "canonical inherited lock has no live exclusive flock";
  } catch (e) {
    if (e?.code === FLOCK_HELD_EXIT && e.stderr === "") return null;
    return "canonical inherited lock could not be verified (flock unavailable or failed)";
  }
}

/**
 * Verify that the inherited lock descriptor is the canonical lock and that the lock is live.
 *
 * Two platform branches. With `/proc` the descriptor's target and its `fdinfo` `lock:` line prove the
 * descriptor itself holds the exclusive flock. Without it (macOS) the verdict is weaker, by necessity:
 * the descriptor's device and inode must equal the canonical lock file's (the descriptor IS that file)
 * and `flock` must fail to take the lock (somebody holds it); see probeCanonicalLockHeld for what that
 * does and does not prove.
 *
 * `deps` is a test seam, every default = today's behaviour (chrome-agent-platform-jjsz F3: the no-/proc
 * branch cannot run on Linux, so it had no test of its verdicts): `hasProc` selects the platform
 * branch, `fstat(fd)` and `statPath(path)` read the descriptor and the lock path, and
 * `probe(lockPath)` is probeCanonicalLockHeld. The /proc branch does not use them.
 *
 * @param {number} [fd]
 * @param {{
 *   hasProc?: boolean,
 *   fstat?: (fd: number) => {dev: number | bigint, ino: number | bigint},
 *   statPath?: (path: string) => {dev: number | bigint, ino: number | bigint},
 *   probe?: (lockPath: string) => Promise<string | null>,
 * }} [deps]
 * @returns {Promise<string | null>} null when verified, else the refusal reason.
 */
export async function verifyInheritedCanonicalLock(fd = 9, deps = {}) {
  const {
    hasProc = HAS_PROC,
    fstat = fstatSync,
    statPath = statSync,
    probe = probeCanonicalLockHeld,
  } = deps;
  if (!hasProc) {
    let fdStat;
    try {
      fdStat = fstat(fd);
    } catch {
      return "canonical inherited lock fd is missing";
    }
    let lockStat;
    try {
      lockStat = statPath(CANONICAL_LOCK);
    } catch {
      return "inherited lock fd has the wrong target";
    }
    if (fdStat.dev !== lockStat.dev || fdStat.ino !== lockStat.ino) {
      return "inherited lock fd has the wrong target";
    }
    return await probe(CANONICAL_LOCK);
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

/**
 * Attest that `pid` leads a process group (and, where the platform lets us read it, a session) that
 * this uid owns, so a negative-PGID signal can only reach that group.
 *
 * WHAT IT PROVES DIFFERS BY PLATFORM (chrome-agent-platform-jjsz F5).
 *  - Linux (`/proc`): `pid === pgid && pid === sid && uid === expectedUid`. The session id is READ from
 *    `/proc/<pid>/stat`, so a runner that only called setpgid(0, 0) and never setsid() is refused.
 *  - macOS (no `/proc`): `ps` has no session-id keyword, so parsePsIdentityLine sets `sid` EQUAL TO
 *    `pgid`. The `sid === pid` clause is therefore implied by `pgid === pid` and proves nothing about a
 *    session: only `pgid === pid` and the uid are attested. A runner that did setpgid(0, 0) without
 *    setsid() passes here and is refused on Linux.
 * The supervisor starts the runner with `detached: true` (libuv calls setsid) on both platforms, so
 * real runs ARE session leaders by construction; the attestation on macOS just does not verify it. The
 * STAT column's `s` flag marks a session leader and could close that gap; it is not wired.
 *
 * @param {number} pid
 * @param {{
 *   expectedUid?: number,
 *   readIdentity?: (pid: number) => Promise<{pid: number, pgid: number, sid: number, uid: number}>,
 * }} [options]
 */
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

/**
 * Every process on the box as an identity row. On `/proc` platforms only ENOENT for an individual
 * vanished process is skipped. An unreadable table or a non-ENOENT identity failure cannot
 * silently become an empty/partial table: custody cannot infer that no descendants remain.
 *
 * The no-/proc branch (macOS) does NOT turn a failed `ps` into an empty table (chrome-agent-platform-jjsz
 * F2): an empty table reads as "no descendants" and "no group members", which custody treats as clean,
 * so a `ps` that failed, timed out or printed nothing would have reported a quiet machine. It rejects with
 * a ProcessUnreadableError instead. Rows that do not parse are skipped, not fatal: on a healthy macOS 15.8
 * table a handful of rows legitimately fail parsePsIdentityLine (5 of 883 measured: `uid` prints as `-2`
 * for the `nobody` account and the uid group is digits-only), and none of those can be this runner's
 * descendant. Only a table with NO parseable row is refused.
 *
 * `deps` selects the branch and permits deterministic failures of the Linux listing/identity read.
 *
 * @param {{hasProc?: boolean, run?: (file: string, args: string[]) => Promise<{stdout: string, stderr: string}>, listProcNames?: () => Promise<string[]>, readIdentity?: (pid: number) => Promise<any>}} [deps]
 */
export async function procIdentities(deps = {}) {
  const {
    hasProc = HAS_PROC, run = defaultPsRun,
    listProcNames = () => readdir("/proc"), readIdentity = readProcIdentity,
  } = deps;
  const rows = [];
  if (!hasProc) {
    let stdout;
    try {
      ({ stdout } = await run("/bin/ps", [
        "-axo",
        "pid=,state=,ppid=,pgid=,uid=,lstart=",
      ]));
    } catch (error) {
      throw new ProcessUnreadableError(
        null,
        `ps failed (${error?.code ?? error?.signal ?? error?.message ?? "unknown"})`,
        error,
      );
    }
    for (const line of String(stdout).split("\n")) {
      const parsed = parsePsIdentityLine(line);
      if (parsed) rows.push(parsed);
    }
    if (rows.length === 0) {
      throw new ProcessUnreadableError(null, "ps exited 0 with no parseable row");
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
    names = await listProcNames();
  } catch (error) {
    throw new ProcessUnreadableError(null, `proc table listing failed (${error?.code ?? error?.message ?? "unknown"})`, error);
  }
  let unreadable = 0;
  let firstError;
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      rows.push(await readIdentity(Number(name)));
    } catch (error) {
      if (isVanishedProcError(error)) continue; // Normal /proc process churn.
      unreadable++;
      firstError ??= error;
    }
  }
  if (unreadable || rows.length === 0) {
    throw new ProcessUnreadableError(null,
      `proc table has ${unreadable} unreadable identity row(s) (${firstError?.code ?? firstError?.message ?? "no readable rows"})`,
      firstError);
  }
  return rows;
}

/**
 * Walk the ppid chain from `rootPid` over ONE process-table sample and record every descendant in
 * `observed`. It rejects when the table cannot be read (ProcessUnreadableError on either
 * platform, see procIdentities) and leaves `observed` untouched, so a failed sample cannot read as "no
 * descendants". `deps` is procIdentities' test seam.
 *
 * @param {number} rootPid
 * @param {Map<number, any>} [observed]
 * @param {Parameters<typeof procIdentities>[0]} [deps]
 */
export async function observeDescendants(rootPid, observed = new Map(), deps = {}) {
  const rows = await procIdentities(deps);
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

/**
 * The observed descendants that are still live: same pid, starttime and uid, and not a zombie.
 *
 * "Gone is clean" holds only when we KNOW it is gone. ProcessGoneError (a successful `ps` absence)
 * and raw ENOENT from a vanished /proc entry are clean; EMFILE/EACCES or an unreadable `ps` are
 * unverified residue, with a bounded reason. A failed observation never proves the pid exited.
 *
 * `readIdentity(pid)` is a test seam; legacy `hasProc` callers remain accepted but
 * the gone/unreadable rule no longer varies by platform.
 *
 * @param {Map<number, any>} observed
 * @param {{readIdentity?: (pid: number) => Promise<any>, hasProc?: boolean}} [deps]
 */
export async function liveObservedResidue(observed, deps = {}) {
  const { readIdentity = readProcIdentity } = deps;
  const residue = [];
  for (const expected of observed.values()) {
    try {
      const current = await readIdentity(expected.pid);
      if (
        current.starttime === expected.starttime &&
        current.uid === expected.uid &&
        current.state !== "Z"
      ) residue.push(current);
    } catch (error) {
      // Gone is clean.
      if (error instanceof ProcessGoneError || isVanishedProcError(error)) continue;
      residue.push({
        ...expected,
        unverified: true,
        unverifiedReason: String(error?.message ?? error).slice(0, 200),
      });
    }
  }
  return residue;
}

export async function terminateAttestedGroup({
  attestation,
  observed,
  termWaitMs,
  killWaitMs,
  readIdentity = readProcIdentity,
  listIdentities = procIdentities,
  isAlive = groupAlive,
  kill = process.kill,
}) {
  const pgid = attestation.identity.pgid;
  const leaderStart = attestation.identity.starttime;
  if (!isAlive(pgid)) {
    return { termSent: false, killSent: false, survived: false };
  }
  try {
    const current = await readIdentity(attestation.identity.pid);
    if (
      current.starttime !== leaderStart || current.pgid !== pgid ||
      current.sid !== attestation.identity.sid ||
      current.uid !== attestation.identity.uid
    ) throw new Error("owned process-group identity changed");
  } catch (error) {
    // A leader whose /proc entry has VANISHED while the group is also gone is the
    // BENIGN case, not an attestation failure: termination wanted the process
    // gone, and an absent /proc/<pid> plus a dead group is the strongest evidence
    // that it is. Rethrowing this ENOENT used to escape the supervisor as an
    // uncaught rejection, so the run wrote NO receipt at all — no
    // CAP_SECURITY_RESULT, no verdict — and a death this way got attributed to the
    // environment because there was nothing left to read (8ixk).
    // BOTH conditions are required, and that is the fail-closed boundary: an
    // unreadable /proc for a group that is STILL ALIVE falls through to the
    // ownership check below and can still throw. Only ENOENT qualifies, and the
    // only ENOENT source inside this try is the /proc read.
    if (isVanishedProcError(error) && !isAlive(pgid)) {
      return {
        termSent: false,
        killSent: false,
        survived: false,
        leaderExited: true,
      };
    }
    // The leader may exit while owned descendants remain. In that case every
    // currently live group member must have been observed as this runner's
    // exact pid/starttime/uid descendant before any negative-PGID signal.
    let table;
    try {
      table = await listIdentities();
    } catch {
      // chrome-agent-platform-jjsz F2: an unreadable process table (no-/proc: procIdentities now rejects)
      // proves nothing about who is in the group, so nothing is signalled. The ORIGINAL error is what
      // the caller sees, exactly as when the table used to come back empty.
      throw error;
    }
    const rows = table.filter((row) => row.pgid === pgid);
    if (
      rows.length === 0 || rows.some((row) => {
        const prior = observed.get(row.pid);
        return !prior || prior.starttime !== row.starttime ||
          prior.uid !== row.uid;
      })
    ) throw error;
  }

  // The group can vanish between the alive check above and this signal — which is
  // the outcome termination WANTED, not an error. ESRCH here used to escape as an
  // uncaught rejection, so the run left NO receipt at all and its death read as
  // environmental (8ixk; reproduced independently in review with a live owned
  // fixture: both identity reads complete, the child then dies before completion
  // is delivered, process.kill throws killESRCH, Node exits 1, no result).
  try {
    kill(-pgid, "SIGTERM");
  } catch (error) {
    if (!isVanishedGroupError(error)) throw error;
    return {
      termSent: false,
      killSent: false,
      survived: false,
      groupGoneBeforeSignal: true,
    };
  }
  const termGone = await waitUntil(() => isAlive(pgid), termWaitMs);
  if (termGone) return { termSent: true, killSent: false, survived: false };
  // Same race on the escalation: the group can finish dying during the SIGTERM
  // wait, so SIGKILL can also find nothing to signal.
  try {
    kill(-pgid, "SIGKILL");
  } catch (error) {
    if (!isVanishedGroupError(error)) throw error;
    return {
      termSent: true,
      killSent: false,
      survived: false,
      groupGoneBeforeSignal: true,
    };
  }
  const killGone = await waitUntil(() => isAlive(pgid), killWaitMs);
  return { termSent: true, killSent: true, survived: !killGone };
}

// A teardown that throws must NOT take the receipt with it. The whole point of the
// custody chain is that every run leaves an attested verdict; an uncaught rejection
// from here leaves an evidence directory with no CAP_SECURITY_RESULT, and a death
// with no receipt gets attributed to the environment because there is nothing left
// to read (8ixk). The known races are now handled inside terminateAttestedGroup, but
// the guarantee is structural rather than an enumeration: whatever throws, the
// receipt is still written and says what happened.
/**
 * @typedef {{
 *   termSent: boolean;
 *   killSent: boolean;
 *   survived: boolean;
 *   leaderExited?: boolean;
 *   groupGoneBeforeSignal?: boolean;
 *   teardownThrew?: string;
 * }} AttestedTermination
 */

/**
 * @param {Record<string, unknown>} args
 * @returns {Promise<AttestedTermination>}
 */
export async function terminateAttestedGroupSafely(args) {
  try {
    return await terminateAttestedGroup(args);
  } catch (error) {
    let reason = "";
    try {
      if (error && typeof error === "object") {
        if ("message" in error && typeof error.message === "string") {
          reason = error.message.trim();
        }
      }
      if (!reason) {
        reason = String(error ?? "").trim();
      }
    } catch {
      reason = "teardown-failed-unstringable";
    }
    if (!reason) reason = "teardown-failed";
    return {
      termSent: false,
      killSent: false,
      survived: false,
      teardownThrew: reason.slice(0, 200),
    };
  }
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
      env.CAP_SECURITY_TEST_SIMULATE_VANISHED_LEADER !== undefined ||
      env.CAP_SECURITY_TEST_FORCE_OBSERVATION_UNREADABLE !== undefined ||
      env.CAP_SECURITY_TEST_FORCE_RESIDUE_UNREADABLE !== undefined ||
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
      forceObservationUnreadable: false,
      forceResidueUnreadable: false,
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
  for (const name of ["CAP_SECURITY_TEST_FORCE_OBSERVATION_UNREADABLE", "CAP_SECURITY_TEST_FORCE_RESIDUE_UNREADABLE"]) {
    if (env[name] !== undefined && env[name] !== "1") throw new Error(`${name} must be 1`);
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
    forceObservationUnreadable: env.CAP_SECURITY_TEST_FORCE_OBSERVATION_UNREADABLE === "1",
    forceResidueUnreadable: env.CAP_SECURITY_TEST_FORCE_RESIDUE_UNREADABLE === "1",
    sampleFreezeMs,
    termWaitMs: 250,
    killWaitMs: 1_000,
    evidenceRoot: durableDir("cap-sec-selftest-evidence"),
    profileRoot: PROFILE_ROOT,
    forceAttestationMismatch: scenario === "pgid-mismatch" &&
      env.CAP_SECURITY_TEST_FORCE_ATTEST_MISMATCH === "1",
    simulateVanishedLeader: env.CAP_SECURITY_TEST_SIMULATE_VANISHED_LEADER === "1",
    scenario,
  };
}

export async function makeReadOnly(paths) {
  for (const file of paths) {
    await chmod(file, 0o400).catch(() => {});
  }
}
