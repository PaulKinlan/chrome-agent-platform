// chrome-profile-dir.ts — Chrome profiles live OUTSIDE the repository.
// chrome-agent-platform-9t1b
//
// Why: ~32 harnesses put their `--user-data-dir` in `${ROOT}.cache/kat-<name>-<stamp>`
// — inside the working tree. A live Chrome profile is a directory of files the
// browser creates and unlinks while it runs (`Default/DIPS-journal`, lock files,
// the WAL). Anything that copies, packages, archives, builds over or measures
// the tree therefore races a live browser, and loses in a way that reads as a
// defect in whatever happened to be copying:
//
//   cp: cannot stat '<repo>/.cache/kat-bgagent-delete-1788697263982/Default/
//   DIPS-journal': No such file or directory
//
// That exact failure reddened `tests/cdp-client.test.ts` during a full
// `npm test` (found while de-serializing the Chrome gates in
// chrome-agent-platform-uzik, which made harnesses overlap for the first time).
// `.cache/` is gitignored, so none of it belongs in a copy of the tree anyway.
//
// The durable root is also the RIGHT place on the merits: profiles are
// hundreds of megabytes of scratch, and `scripts/lib/durable-root.mjs` refuses
// a RAM-backed target — `/tmp` here is a 46 GB tmpfs that has already been
// exhausted by suites (bead chp).
//
// Profiles are per-instance by construction (pid + wall clock + random), so two
// lanes running the same harness can never share one: sharing a profile means
// Chrome's SingletonLock makes the second launch fail or attach to the first
// run's browser, and one run's cleanup then deletes the other's live profile.

import { durableRoot, isRamBacked } from "./durable-root.mjs";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";

/** Sub-directory of the durable root that holds harness Chrome profiles. */
export const PROFILE_ROOT_NAME = "cap-chrome-profiles";

/** Minimum `olderThanMs` permitted when pruning the shared profile root, so a
 *  brand-new directory created by `chromeProfileDir()` cannot be deleted in the
 *  window before Chrome writes `SingletonLock` (chrome-agent-platform-xvco). */
export const SHARED_ROOT_MIN_OLDER_THAN_MS = 60_000;
/** Admission is bounded, not eviction: unknown/live locks are never deleted to make room. */
export const MAX_CHROME_PROFILE_DIRS = 512;

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u;

function suffix(): string {
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${Deno.pid}-${Date.now()}-${rand}`;
}

/**
 * A fresh per-instance Chrome profile directory OUTSIDE the repository, on
 * disk, created and ready to pass as `--user-data-dir`.
 *
 * `name` identifies the harness (`kat-dark-scheme`, `j2`, …) so a leaked
 * profile can be attributed; it is validated rather than interpolated, because
 * it becomes a path segment.
 */
export function chromeProfileDir(
  name: string,
  { root = `${durableRoot()}/${PROFILE_ROOT_NAME}`, maxEntries = MAX_CHROME_PROFILE_DIRS }:
    { root?: string; maxEntries?: number } = {},
): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `chromeProfileDir: not a profile name (${JSON.stringify(name)}) — ` +
        "expected /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/ (it becomes a path segment)",
    );
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_CHROME_PROFILE_DIRS) {
    throw new Error(`chromeProfileDir: maxEntries must be an integer in 1..${MAX_CHROME_PROFILE_DIRS}`);
  }
  const base = durableRoot().replace(/\/+$/u, "");
  const defaultRoot = `${base}/${PROFILE_ROOT_NAME}`;
  if (root !== defaultRoot && !(root.startsWith(`${defaultRoot}-`) &&
    /^[a-zA-Z0-9-]+$/.test(root.slice(defaultRoot.length + 1)))) {
    throw new Error("chromeProfileDir: fixture root must be a direct cap-chrome-profiles-* child of the durable root");
  }
  // Shared root and isolated test fixtures are both durable. Never follow a
  // symlinked profile root to a checkout or a different filesystem.
  if (isRamBacked(root) || isInsideRepo(root)) throw new Error(`chromeProfileDir: unsafe profile root ${root}`);
  Deno.mkdirSync(root, { recursive: true });
  if (Deno.realPathSync(root) !== root) throw new Error(`chromeProfileDir: refusing symlinked root ${root}`);
  const lock = Deno.openSync(`${root}/.admission.lock`, { create: true, read: true, write: true });
  try {
    // Kernel flock serializes creators across lanes. A killed creator drops
    // the fd automatically; a stale lockfile is not a stale lock. Holding this
    // through BOTH count and mkdir prevents two launches admitting over cap.
    lock.lockSync(true);
    let count = 0;
    for (const entry of Deno.readDirSync(root)) if (entry.isDirectory) count++;
    if (count >= maxEntries) {
      throw new Error(`chromeProfileDir: admission cap ${maxEntries} reached (${count} profiles); ` +
        "no live/unknown profile is deleted to make room — inspect the stale-lock report");
    }
    const dir = `${root}/${name}-${suffix()}`;
    Deno.mkdirSync(dir); // exclusive: a name collision is a refusal, not reuse
    return dir;
  } finally {
    // Failure to acquire the lock must not turn the admission check into an
    // unlocked best-effort count; close also releases on exception/SIGKILL.
    lock.close();
  }
}

/** The repo root this harness tree belongs to (the directory holding `.git`). */
export function repoRoot(from = import.meta.url): string {
  // This file is <root>/scripts/lib/chrome-profile-dir.ts, so the root is two
  // directories up from the module URL.
  return new URL("../../", from).pathname.replace(/\/$/u, "");
}

/** True when `dir` is the repo root or inside it. Symlinks are resolved so a
 *  profile cannot be smuggled into the tree through one. */
export function isInsideRepo(dir: string, root = repoRoot()): boolean {
  const real = resolveExisting(dir);
  const realRoot = resolveExisting(root);
  const withSlash = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
  return real === realRoot.replace(/\/$/u, "") || real.startsWith(withSlash);
}

/** realpath the DEEPEST existing ancestor and re-append the rest: a profile
 *  path is usually not created yet, and `realPathSync` throws on a missing leaf.
 *  Without this a symlink that points INTO the tree looks outside it. */
function resolveExisting(path: string): string {
  let current = path.replace(/\/+$/u, "") || "/";
  const tail: string[] = [];
  for (;;) {
    try {
      const real = Deno.realPathSync(current);
      return tail.length ? `${real}/${tail.reverse().join("/")}` : real;
    } catch {
      const parent = current.slice(0, current.lastIndexOf("/")) || "/";
      if (parent === current) return path; // ran out of ancestors
      tail.push(current.slice(current.lastIndexOf("/") + 1));
      current = parent;
    }
  }
}

/** The three states a profile directory's `SingletonLock` can be in:
 *
 * - `live`:    `SingletonLock` is a `<hostname>-<pid>` symlink and that PID is
 *              alive on THIS host (including `EPERM`/`PermissionDenied` when
 *              owned by another user such as root). Never pruned.
 * - `absent`:  no `SingletonLock` at all (`ENOENT`/`NotFound`). Chrome unlinks
 *              its lock on a clean exit, so this is the only state that
 *              positively means "not running" and delegates to the age rule.
 * - `unknown`: a lock entry exists but cannot be proven live on this host
 *              (unreadable/non-symlink `EINVAL`, malformed target, another
 *              host's lock, non-positive PID, or a dead PID `ESRCH`). Kept and
 *              counted in `unknown` so crashed-browser residue stays visible
 *              without risking cross-namespace or unverified deletion. */
export type ProfileLiveness = "live" | "absent" | "unknown";

export type ProfileLockEvidence = {
  liveness: ProfileLiveness;
  pidStatus: "alive" | "dead" | "permission-denied" | "unverifiable" | "absent";
  lockTarget: string | null;
  ownerHost: string | null;
  ownerPid: number | null;
};

/** Diagnostics only: a dead PID is UNKNOWN for deletion even if local. */
export function profileLockEvidence(path: string): ProfileLockEvidence {
  const evidence: ProfileLockEvidence = {
    liveness: "unknown", pidStatus: "unverifiable", lockTarget: null, ownerHost: null, ownerPid: null,
  };
  let target: string;
  try {
    target = readlinkSync(`${path}/SingletonLock`);
  } catch (e) {
    const kind = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name;
    if (kind === "ENOENT" || kind === "NotFound") {
      evidence.liveness = "absent";
      evidence.pidStatus = "absent";
    }
    return evidence; // malformed or unreadable locks stay unknown
  }
  evidence.lockTarget = target;
  const match = /^(.*)-(\d+)$/u.exec(target);
  if (!match) return evidence;
  evidence.ownerHost = match[1];
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return evidence;
  evidence.ownerPid = pid;
  if (match[1] !== hostname()) return evidence; // foreign host: no local PID proof
  try {
    Deno.kill(pid, 0); // signal 0: existence only, not ownership or deletion authority
    evidence.liveness = "live";
    evidence.pidStatus = "alive";
  } catch (e) {
    const kind = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name;
    if (kind === "EPERM" || kind === "PermissionDenied") {
      evidence.liveness = "live";
      evidence.pidStatus = "permission-denied";
    } else if (kind === "ESRCH" || kind === "NotFound") {
      evidence.pidStatus = "dead"; // still UNKNOWN: orphan/namespace/late attach may survive
    }
  }
  return evidence;
}

/** Existing conservative three-state contract: dead lock remains UNKNOWN. */
export function profileLiveness(path: string): ProfileLiveness {
  return profileLockEvidence(path).liveness;
}

export type StaleProfileEvidence = ProfileLockEvidence & {
  name: string;
  createdBy: string | null;
  createdPid: number | null;
  createdAtMs: number | null;
  ageMs: number | null;
};

/** Read-only inventory, never a deletion predicate. Lists every local dead-PID lock. */
export function reportChromeProfileDirs(
  { root = `${durableRoot()}/${PROFILE_ROOT_NAME}`, now = Date.now() }:
    { root?: string; now?: number } = {},
): { directories: number; stale: StaleProfileEvidence[]; live: number; absent: number; unknown: number; errors: string[] } {
  if (!Number.isFinite(now)) throw new Error("reportChromeProfileDirs: now must be finite");
  const report = { directories: 0, stale: [] as StaleProfileEvidence[], live: 0, absent: 0,
    unknown: 0, errors: [] as string[] };
  let entries: Deno.DirEntry[];
  try { entries = [...Deno.readDirSync(root)]; }
  catch (e) {
    if (e instanceof Deno.errors.NotFound) return report;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    report.directories++;
    const path = `${root}/${entry.name}`;
    const evidence = profileLockEvidence(path);
    if (evidence.liveness === "live") { report.live++; continue; }
    if (evidence.liveness === "absent") { report.absent++; continue; }
    report.unknown++;
    if (evidence.pidStatus !== "dead") continue;
    const created = /^(.+)-(\d+)-(\d{10,})-([0-9a-f]{4})$/u.exec(entry.name);
    let ageMs: number | null = null;
    try { ageMs = Math.max(0, now - (Deno.statSync(path).mtime?.getTime() ?? now)); }
    catch (e) { report.errors.push(`${entry.name}: ${String((e as Error)?.message ?? e)}`); }
    report.stale.push({ ...evidence, name: entry.name, createdBy: created?.[1] ?? null,
      createdPid: created ? Number(created[2]) : null, createdAtMs: created ? Number(created[3]) : null,
      ageMs });
  }
  return report;
}

/**
 * Prune lockless (`absent`) Chrome profile directories under `root` whose mtime
 * age is at least `olderThanMs` (default 6 h).
 *
 * Safety invariants (chrome-agent-platform-z5ym, chrome-agent-platform-xvco):
 * - `olderThanMs` must be a finite non-negative number; on the shared profile
 *   root (`${durableRoot()}/${PROFILE_ROOT_NAME}`) it must be at least
 *   `SHARED_ROOT_MIN_OLDER_THAN_MS` (60 s) so a directory just created by
 *   `chromeProfileDir()` cannot be pruned before Chrome writes `SingletonLock`.
 * - `root` must be an normalized absolute path whose basename is
 *   `cap-chrome-profiles` or `cap-chrome-profiles-*`, so a caller cannot pass
 *   `durableRoot()` (one level too high, where every child looks lockless).
 * - Only `absent` (lockless) profiles are eligible for age-based removal;
 *   `live` profiles are kept, and `unknown` locked profiles (including crashed
 *   browsers with dead-PID locks) are kept and reported in `unknown`.
 */
export async function pruneChromeProfileDirs(
  {
    olderThanMs = 6 * 60 * 60_000,
    now = Date.now(),
    // Injectable so a test can exercise pruning against its OWN fixture root
    // instead of the shared one every lane's live browsers live under.
    root = `${durableRoot()}/${PROFILE_ROOT_NAME}`,
  }: { olderThanMs?: number; now?: number; root?: string } = {},
): Promise<{ removed: number; kept: number; unknown: number; errors: string[] }> {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new Error(
      `pruneChromeProfileDirs: olderThanMs must be a non-negative finite number (got ${olderThanMs}) — ` +
        "a negative threshold is refused (chrome-agent-platform-z5ym)",
    );
  }
  const cleanRoot = typeof root === "string" ? root.replace(/\/+$/u, "") : "";
  const segments = cleanRoot.split("/");
  const base = segments.at(-1) ?? "";
  const validRootBase =
    base === PROFILE_ROOT_NAME ||
    (base.startsWith(`${PROFILE_ROOT_NAME}-`) && base.length > PROFILE_ROOT_NAME.length + 1);
  if (!cleanRoot.startsWith("/") || segments.includes("..") || segments.includes(".") || !validRootBase) {
    throw new Error(
      `pruneChromeProfileDirs: refusing root ${JSON.stringify(root)} — basename must be ` +
        `"${PROFILE_ROOT_NAME}" or "${PROFILE_ROOT_NAME}-*" so the pruner cannot be pointed one level too high ` +
        "(chrome-agent-platform-xvco)",
    );
  }
  const sharedRoot = `${durableRoot().replace(/\/+$/u, "")}/${PROFILE_ROOT_NAME}`;
  if (cleanRoot === sharedRoot && olderThanMs < SHARED_ROOT_MIN_OLDER_THAN_MS) {
    throw new Error(
      `pruneChromeProfileDirs: olderThanMs on the shared profile root must be >= ${SHARED_ROOT_MIN_OLDER_THAN_MS} ms ` +
        `(got ${olderThanMs}) so a just-created lockless profile cannot be deleted before Chrome writes SingletonLock (chrome-agent-platform-xvco)`,
    );
  }
  const out = { removed: 0, kept: 0, unknown: 0, errors: [] as string[] };
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(cleanRoot)];
  } catch {
    return out; // nothing created yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const path = `${cleanRoot}/${entry.name}`;
    let mtime = 0;
    try {
      mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
    } catch {
      out.errors.push(`${entry.name}: unstatable`);
      continue;
    }
    if (now - mtime < olderThanMs) { out.kept++; continue; }
    // Only `absent` (no lock — a clean exit) may reach removal via the age rule.
    // `live` is never pruned, and `unknown` is kept AND counted separately so
    // crashed-browser residue stays visible instead of hiding inside `kept`.
    const liveness = profileLiveness(path);
    if (liveness === "live") { out.kept++; continue; }
    if (liveness === "unknown") { out.kept++; out.unknown++; continue; }
    try {
      Deno.removeSync(path, { recursive: true });
      out.removed++;
    } catch (e) {
      out.errors.push(`${entry.name}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return out;
}
