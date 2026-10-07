// The build lock: owner identity, the liveness check that decides whether a lock may be stolen, and
// the acquisition loop. Extracted from build.mjs by chrome-agent-platform-r0v8 so the steal decision
// can be tested against a REAL zombie holder instead of being invoked only through a full build.
//
// WHY THE LIVENESS CHECK IS SUBTLE (the r0v8 defect, observed on this box): the check used to be
// "process.kill(pid, 0) succeeds -> alive, else read /proc/<pid>/stat and treat a changed starttime
// as pid reuse". A ZOMBIE passes BOTH: kill(pid, 0) succeeds against a zombie for as long as its
// parent has not reaped it, and /proc/<pid>/stat still exists with an unchanged starttime. So a build
// child that the serial runner SIGKILLed but whose parent had not yet reaped it was judged a LIVE
// holder: the build spent its full bounded refusal (48 x 500ms = 24s) and then threw
// "another LIVE build (pid N) ... is not dead" — a message that actively misleads, since the holder
// was a corpse. Seven serial-phase build tests reded for that reason in one full-suite run, none of
// them on an assertion. The lock outlives its owner, so the poison propagates to later runs.
//
// Sibling bead chrome-agent-platform-nz2r is complementary and does NOT fix this: nz2r makes
// test:changed ignore .build.lock-family residue as changed files; it does not change the liveness
// check.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HAS_PROC = (() => {
  try { return statSync("/proc").isDirectory(); } catch { return false; }
})();

const defaultProcRead = (p) => readFileSync(p, "utf8");

export const LOCK_DIRNAME = ".build.lock.d";
export const OWNER_FILE = "owner.json";
/** 48 x 500ms = the 24s bounded refusal the observed failure text came from. */
export const DEFAULT_ATTEMPTS = 48;
export const DEFAULT_INTERVAL_MS = 500;
/** An ownerless lock is never a mid-creation window (the dir is born fully populated), so it is
 *  only stealable once it is observably old — this is the age at which that is true. */
export const OWNERLESS_STALE_MS = 60_000;
export const QUARANTINE_PREFIX = ".lock-quarantine-";

export function machineBootId(read = defaultProcRead) {
  try {
    return String(read("/proc/sys/kernel/random/boot_id")).trim();
  } catch {
    return "unknown-boot";
  }
}

/**
 * Parse the fields of /proc/<pid>/stat that matter here.
 *
 * The format is `pid (comm) state ppid ... starttime ...`, and `comm` may contain BOTH spaces and
 * parentheses ("(node)", "((sd-pam))"). Fields after it are therefore read from AFTER THE LAST ')':
 * a whitespace split of the whole line silently shifts by one per space in the command name, which
 * would read the wrong field for state and starttime. In the slice after ')', index 0 is field 3
 * (state) and index 19 is field 22 (starttime).
 *
 * @returns {{state: string, start: string} | null} null when the line is not parseable.
 */
export function parseProcStat(text) {
  const raw = String(text ?? "");
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 20) return null;
  return { state: rest[0], start: rest[19] };
}

/** The environment `/bin/ps` runs under on a no-/proc platform (chrome-agent-platform-jjsz).
 *
 *  `lstart` is rendered with the CALLER's locale AND local time zone, and both are inherited from the
 *  environment. Measured on macOS 15.8, ONE live process prints as
 *    LC_ALL=C `Wed Oct  7 12:10:01 2026` | en_GB.UTF-8 `Wed  7 Oct 12:10:01 2026` |
 *    fr_FR `Mer  7 oct ...` | de_DE `Mi  7 Okt ...`, and as 12:26 / 21:26 / 08:26 under
 *    TZ=UTC / Asia/Tokyo / America/New_York.
 *  An owner started from a Terminal (LANG=en_GB, local zone) and a contender started from launchd, a GUI
 *  or CI (C locale, TZ unset) therefore recorded UNEQUAL start strings for one live process, and the
 *  pid-reuse compare in holderIsDead read that as "a different process": the lock was stolen from a LIVE
 *  build (two concurrent publishes, then the build GC removing the sibling's fresh version). Every writer
 *  AND reader of a start string now goes through this one environment, so the strings are comparable.
 *
 *  TZ=UTC is deliberate and not merely tidy: a child spawned with an explicit env that has NO TZ renders
 *  in the MACHINE zone. That is consistent between two readers on one machine, but not across a zone
 *  change (a laptop that sets its zone from its location while a long build runs), which would print the
 *  same live process at a different hour and read as pid reuse. UTC makes the string independent of both.
 *  `/bin/ps` is an absolute path, so no PATH is needed. */
export const PS_ENV = Object.freeze({ LC_ALL: "C", TZ: "UTC" });
/** A wedged `ps` must not hang the lock acquire: it is bounded, then killed (SIGKILL — a wedged ps may
 *  ignore SIGTERM). A timeout is "unreadable", which holderIsDead treats as ALIVE and polls again. */
export const PS_TIMEOUT_MS = 5_000;
/** `ps -o state=,lstart=` under PS_ENV prints `<state flags> <Www Mmm d hh:mm:ss yyyy>`. Anything else is
 *  not a start time and must not be compared as one. */
const PS_STATE_LSTART = /^(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/u;

/**
 * One `ps -o state=,lstart=` probe, classified (the no-/proc branch of procStatFields).
 *
 * ONLY exit status 1 with EMPTY stdout AND EMPTY stderr means "gone": that is exactly what
 * `ps -p <absent pid>` produces (measured: status 1, 0 bytes, 0 bytes). Every other outcome — a spawn
 * failure (EAGAIN/EMFILE/ENOENT), a timeout, a signal, any other status, any stderr text, an exit 0 with
 * no output — is "unreadable" (or "unparseable"), which holderIsDead already treats as ALIVE. The first
 * draft mapped ANY numeric non-zero status, and an empty exit-0 output, to "gone": a `ps` that merely
 * could not read the process table (a bad keyword also exits 1) was read as proof of death and the lock
 * of a LIVE build became stealable.
 */
function psStateAndStart(pid, exec, timeoutMs = PS_TIMEOUT_MS) {
  let r;
  try {
    r = exec("/bin/ps", ["-o", "state=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: PS_ENV,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
  } catch (e) {
    // A seam (or spawnSync itself) that throws failed to READ; that is never a verdict of absence.
    return { ok: false, reason: "unreadable", code: e?.code };
  }
  if (r?.error) return { ok: false, reason: "unreadable", code: r.error.code }; // spawn failure, timeout, over-large output
  if (r?.signal) return { ok: false, reason: "unreadable", code: r.signal }; // killed by a signal
  const stdout = typeof r?.stdout === "string" ? r.stdout : null;
  const stderr = typeof r?.stderr === "string" ? r.stderr : null;
  if (r?.status === 1 && stdout === "" && stderr === "") return { ok: false, reason: "gone" };
  if (r?.status !== 0 || stdout === null) return { ok: false, reason: "unreadable", code: r?.status };
  const row = stdout.trim();
  const m = PS_STATE_LSTART.exec(row);
  if (!m) return { ok: false, reason: row === "" ? "unreadable" : "unparseable" };
  return { ok: true, state: m[1][0] ?? "?", start: m[2].replace(/\s+/gu, " ") };
}

/**
 * Read a pid's state + start time from /proc (or `/bin/ps` when `/proc` is absent on macOS),
 * distinguishing "gone" from "unreadable".
 *
 * ENOENT means the pid no longer exists (the /proc entry is gone), which is itself proof of death
 * even when an earlier kill(pid, 0) succeeded — that race is exactly how a lock is orphaned.
 * Any other error (EACCES/EPERM) means the process EXISTS but we may not inspect it, and there the
 * conservative direction is to treat it as alive and refuse to steal.
 *
 * The no-/proc branch applies the same rule to `ps`'s own evidence (see psStateAndStart): only an
 * exit-1, empty-stdout, empty-stderr `ps` is "gone"; and it runs under PS_ENV so the start string is
 * the same whichever environment the owner and the contender were launched from.
 *
 * `deps` is a test seam, default = today's behaviour: `hasProc` overrides the /proc probe so the macOS
 * branch is reachable on Linux, and `exec` stands in for `spawnSync` (same return shape). A non-default
 * `read` always selects the /proc branch.
 *
 * @param {number | string} pid
 * @param {(path: string) => string} [read]  /proc reader (default: readFileSync utf8)
 * @param {{hasProc?: boolean, exec?: Function, timeoutMs?: number}} [deps]
 */
export function procStatFields(pid, read = defaultProcRead, deps = {}) {
  const { hasProc = HAS_PROC, exec = spawnSync, timeoutMs = PS_TIMEOUT_MS } = deps;
  if (!hasProc && read === defaultProcRead) return psStateAndStart(pid, exec, timeoutMs);
  try {
    const parsed = parseProcStat(read(`/proc/${pid}/stat`));
    if (!parsed) return { ok: false, reason: "unparseable" };
    return { ok: true, state: parsed.state, start: parsed.start };
  } catch (e) {
    return {
      ok: false,
      reason: e?.code === "ENOENT" ? "gone" : "unreadable",
      code: e?.code,
    };
  }
}

/** This process's holder identity: pid + a fresh token + /proc start ticks + the machine boot id
 *  (the boot id fences pid+starttime reuse across reboots, not only within one boot).
 *
 *  `start` is `null` — never a placeholder string — when the identity read failed. The first draft
 *  recorded "0", which is TRUTHY: every later compare against the live process then mismatched and
 *  read as pid reuse, so a build that merely failed to read its own identity could have its lock
 *  stolen out from under it (chrome-agent-platform-jjsz). `null` makes holderIsDead skip the reuse
 *  compare ("cannot prove reuse") and leave the holder alive.
 *
 *  `deps.procStat(pid)` is a test seam (default: procStatFields) returning `{ok, start, ...}`.
 *
 *  @param {number} [pid]
 *  @param {string} [boot]
 *  @param {{procStat?: (pid: number) => {ok: boolean, start?: string}}} [deps] */
export function buildOwnerIdentity(pid = process.pid, boot = machineBootId(), deps = {}) {
  const { procStat = procStatFields } = deps;
  const self = procStat(pid);
  return {
    pid,
    token: randomUUID(),
    at: Date.now(),
    start: self?.ok && self.start ? self.start : null,
    boot,
  };
}

/**
 * Decide whether the lock's recorded holder is dead, i.e. whether the lock is stealable.
 *
 * Dead when: no owner at all and the lock is observably old; a different boot; kill(pid, 0) reports
 * ESRCH; /proc/<pid>/stat has vanished; the state is `Z` (zombie) or `X` (dead); or the starttime
 * changed (pid reuse).
 * Alive when: kill reports EPERM; /proc/<pid>/stat is unreadable rather than missing; or the owner
 * matches in every respect.
 *
 * `deps` exists so the decision is testable without contriving a real process in each state:
 *   bootId, now, kill, procStat(pid) -> {ok, state, start, reason}, lockDirBirthtimeMs() -> number.
 */
export async function holderIsDead(holder, deps = {}) {
  const {
    bootId = machineBootId(),
    now = Date.now,
    kill = process.kill,
    procStat = null,
    lockDirBirthtimeMs = null,
  } = deps;

  if (!holder?.pid) {
    // Ownerless: only stealable when observably old (see OWNERLESS_STALE_MS).
    if (typeof lockDirBirthtimeMs !== "function") return false;
    const born = await lockDirBirthtimeMs();
    if (typeof born !== "number" || !Number.isFinite(born)) return false;
    return now() - born > OWNERLESS_STALE_MS;
  }

  // A different boot means the recorded pid+starttime cannot be this machine's live process.
  if (holder.boot && holder.boot !== bootId) return true;

  let killError = null;
  try {
    kill(holder.pid, 0);
  } catch (e) {
    killError = e;
  }
  // ESRCH = no such process. Anything else (EPERM) = it exists and we simply may not signal it.
  if (killError) return killError.code === "ESRCH";

  const probe = typeof procStat === "function"
    ? procStat(holder.pid)
    : procStatFields(holder.pid);
  const resolved = probe instanceof Promise ? await probe : probe;
  if (!resolved?.ok) {
    // kill() said alive but the /proc entry is gone: the process died in between (or was reaped).
    // An UNREADABLE entry is different and stays alive — refusing to steal is the safe direction.
    return resolved?.reason === "gone";
  }

  // THE r0v8 FIX: a zombie is a corpse. It answers kill(pid, 0) and keeps its starttime, so every
  // other test here calls it alive; it can never run another build. `X` is the transient dead state.
  if (resolved.state === "Z" || resolved.state === "X") return true;

  // pid reuse: same pid, different process (starttime is per-process, not per-pid).
  //
  // The compare only runs when BOTH sides carry a start. A holder whose start could not be recorded
  // (`start: null` — see buildOwnerIdentity) or a probe that returned none cannot PROVE reuse, so it is
  // treated as "cannot prove reuse" and the holder stays alive: the first draft recorded the truthy string
  // "0" on a failed read, which mismatched every later read and made a LIVE build's lock stealable
  // (chrome-agent-platform-jjsz).
  if (holder.start && resolved.start && String(resolved.start) !== String(holder.start)) return true;

  return false;
}

/**
 * Acquire the build lock, stealing only a provably-dead holder.
 *
 * Acquired with mkdir (atomic exclusivity; EEXIST when held) and the owner file written immediately
 * after. A steal is race-free via TOKEN-SPECIFIC QUARANTINE: the stealer renames the dead lock to a
 * unique name first — exactly one contender's rename can succeed — then removes it, so a successor's
 * fresh lock (a different directory inode) can never be deleted by a loser.
 *
 * @param {object} opts
 * @param {string} opts.root            repo root (quarantine + sweep live here)
 * @param {object} opts.owner           buildOwnerIdentity() result to write as the holder
 * @param {string} [opts.lockDir]       defaults to <root>/.build.lock.d
 * @param {number} [opts.attempts]      bounded refusal, in polls (default 48 -> 24s)
 * @param {number} [opts.intervalMs]    poll interval (default 500ms)
 * @param {object} [opts.livenessDeps]  injected into holderIsDead (tests only)
 */
export async function acquireBuildLock({
  root,
  owner,
  lockDir = join(root, LOCK_DIRNAME),
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  livenessDeps = {},
}) {
  const ownerPath = join(lockDir, OWNER_FILE);
  const deps = {
    lockDirBirthtimeMs: async () => {
      try {
        return (await stat(lockDir)).birthtimeMs;
      } catch {
        return null;
      }
    },
    ...livenessDeps,
  };

  const sleep = () => new Promise((r) => setTimeout(r, intervalMs));

  for (let attempt = 0;; attempt++) {
    try {
      await mkdir(lockDir); // EEXIST while held — the lock's existence is atomic
      await writeFile(ownerPath, JSON.stringify(owner));
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }

    let holder = null;
    try {
      holder = JSON.parse(await readFile(ownerPath, "utf8"));
    } catch {
      holder = null;
    }

    if (await holderIsDead(holder, deps)) {
      const quarantine = join(
        root,
        `${QUARANTINE_PREFIX}${holder?.token ?? "orphan"}-${process.pid}-${Date.now()}`,
      );
      try {
        await rename(lockDir, quarantine);
        await rm(quarantine, { recursive: true, force: true });
        continue; // retry the acquire with a fresh lock
      } catch {
        /* another contender quarantined it first — loop and retry */
      }
    }

    if (attempt >= attempts) {
      throw new Error(
        `another LIVE build (pid ${holder?.pid}) holds the build lock and is not dead — refusing to steal; if truly stuck, kill pid ${holder?.pid} or remove ${lockDir} manually`,
      );
    }
    await sleep();
  }

  // Stale staging/quarantine sweep (crashed contenders).
  for (const f of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (
      f.name.startsWith(".lock-stage-") || f.name.startsWith(QUARANTINE_PREFIX) ||
      f.name.startsWith(".owner.tmp-")
    ) {
      await rm(join(root, f.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  return { lockDir, owner };
}
