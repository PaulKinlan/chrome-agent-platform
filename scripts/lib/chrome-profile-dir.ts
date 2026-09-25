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

/**
 * Remove profile directories older than `olderThanMs` (default 6 h). Harnesses
 * have never cleaned up after themselves and the durable root is not a dump:
 * `scripts/kat-runner.ts` calls this once per run so the directory
 * self-prunes. A profile in use is newer than the threshold, so this never
 * touches a live browser — and a removal failure is not fatal (a leaked profile
 * is a hygiene problem, not a red gate).
 */
/** Is this profile directory owned by a LIVE browser? Chrome leaves
 *  `SingletonLock` as a symlink whose target is `<hostname>-<pid>`.
 *
 *  The age rule is only a PROXY for liveness ("a live browser is minutes old")
 *  and it is exactly wrong when a caller passes an all-deleting threshold:
 *  tests/chrome-profile-location.test.ts ran `pruneChromeProfileDirs({
 *  olderThanMs: -1 })` against the SHARED root to test the absent-root path,
 *  which removed every profile on the box — including another lane's live
 *  Chrome mid-KAT, whose OPFS state then vanished under the running extension
 *  (chrome-agent-platform-z5ym, measured: a run's root marker and every
 *  execution dir gone mid-run, no product delete).
 *
 *  Fails SAFE: an unreadable lock, a malformed target, or a lock from another
 *  HOST is treated as live, because a wrongly kept profile costs disk while a
 *  wrongly removed one costs a lane's run. A profile with no lock at all is not
 *  live (a killed browser may leave none), and the age rule still applies. */
export function profileIsLive(path: string): boolean {
  let target = "";
  try {
    target = readlinkSync(`${path}/SingletonLock`);
  } catch {
    return false; // no lock: a dead/never-started profile — let the age rule decide
  }
  const match = /^(.*)-(\d+)$/u.exec(target);
  if (!match) return true; // an unreadable shape must never authorize a removal
  const [, host, pidText] = match;
  if (host !== hostname()) return true; // another machine's profile: cannot prove it is dead
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    Deno.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (e) {
    return (e as { name?: string })?.name !== "NotFound"; // EPERM = it exists, just not ours
  }
}

export async function pruneChromeProfileDirs(
  {
    olderThanMs = 6 * 60 * 60_000,
    now = Date.now(),
    // Injectable so a test can exercise pruning against its OWN fixture root
    // instead of the shared one every lane's live browsers live under.
    root = `${durableRoot()}/${PROFILE_ROOT_NAME}`,
  }: { olderThanMs?: number; now?: number; root?: string } = {},
): Promise<{ removed: number; kept: number; errors: string[] }> {
  const out = { removed: 0, kept: 0, errors: [] as string[] };
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch {
    return out; // nothing created yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const path = `${root}/${entry.name}`;
    let mtime = 0;
    try {
      mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
    } catch {
      out.errors.push(`${entry.name}: unstatable`);
      continue;
    }
    if (now - mtime < olderThanMs) { out.kept++; continue; }
    // A LIVE browser is never pruned, whatever threshold the caller passed:
    // the lock's pid is checked before the age rule can authorize a removal.
    if (profileIsLive(path)) { out.kept++; continue; }
    try {
      Deno.removeSync(path, { recursive: true });
      out.removed++;
    } catch (e) {
      out.errors.push(`${entry.name}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return out;
}
