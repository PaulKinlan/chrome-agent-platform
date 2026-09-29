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

import { durableDir, durableRoot, isRamBacked } from "./durable-root.mjs";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";

/** Sub-directory of the durable root that holds harness Chrome profiles. */
export const PROFILE_ROOT_NAME = "cap-chrome-profiles";

/** Minimum `olderThanMs` permitted when pruning the shared profile root, so a
 *  brand-new directory created by `chromeProfileDir()` cannot be deleted in the
 *  window before Chrome writes `SingletonLock` (chrome-agent-platform-xvco). */
export const SHARED_ROOT_MIN_OLDER_THAN_MS = 60_000;

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
export function chromeProfileDir(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `chromeProfileDir: not a profile name (${JSON.stringify(name)}) — ` +
        "expected /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/ (it becomes a path segment)",
    );
  }
  const dir = durableDir(PROFILE_ROOT_NAME, `${name}-${suffix()}`);
  // durableDir already refuses a RAM-backed root; assert the two properties
  // this module exists for, so a future CAP_DURABLE_ROOT pointing at a checkout
  // or at tmpfs fails here rather than in a copy race three weeks later.
  if (isRamBacked(dir)) throw new Error(`chromeProfileDir: ${dir} is RAM-backed`);
  if (isInsideRepo(dir)) {
    throw new Error(`chromeProfileDir: ${dir} is inside the repository (bead 9t1b)`);
  }
  return dir;
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

/** Classify a Chrome profile directory's `SingletonLock` state (`live`, `absent`, or `unknown`). */
export function profileLiveness(path: string): ProfileLiveness {
  let target = "";
  try {
    target = readlinkSync(`${path}/SingletonLock`);
  } catch (e) {
    // NotFound = no lock (clean exit). Anything else (EINVAL when the lock is
    // not a symlink, EACCES, ...) is unreadable: UNKNOWN, never "fresh" and
    // never "stale enough to delete". node:fs errors carry `code` (ENOENT);
    // Deno's own errors carry `name` (NotFound) — accept either.
    const kind = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name;
    return kind === "ENOENT" || kind === "NotFound" ? "absent" : "unknown";
  }
  const match = /^(.*)-(\d+)$/u.exec(target);
  if (!match) return "unknown";
  const [, host, pidText] = match;
  if (host !== hostname()) return "unknown"; // another machine's profile: cannot prove it is dead
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    Deno.kill(pid, 0); // signal 0: existence check only
    return "live";
  } catch (e) {
    // PermissionDenied = it exists but is not ours -> live. NotFound = a dead
    // pid -> UNKNOWN (a namespace may hide the real owner), never stale.
    const kind = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name;
    return kind === "EPERM" || kind === "PermissionDenied" ? "live" : "unknown";
  }
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
