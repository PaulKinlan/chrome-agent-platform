// scripts/lib/durable-root.mjs — the ONE durable-root rule (bead
// chrome-agent-platform-chp; owner directive CAP-FB-20260821-WORKTREE-HYGIENE-01).
// /tmp on the build host is RAM-backed tmpfs: suites and acceptance runs
// exhausted its inodes (2026-08-21 architectural review; 2026-09-03/04 fleet
// night lost review batches), and git worktrees registered under /tmp vanished
// on wipes. Evidence, big scratch copies, Chrome profiles, and scratch
// worktrees belong on DISK. Truly ephemeral coordination files (the chrome
// lock, slot poison) stay on tmpfs — a reboot auto-clears stale locks, which
// is a feature. Plain ESM with node: imports so BOTH runtimes (deno test/journey
// scripts and node build scripts) share this one rule.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** True when `dir` sits on a RAM-backed filesystem (tmpfs/ramfs per /proc/mounts). */
export function isRamBacked(dir) {
  let best = null;
  try {
    for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
      const parts = line.split(" ");
      const mountPoint = parts[1];
      const fsType = parts[2];
      if (!mountPoint) continue;
      const mp = mountPoint.replaceAll("\\040", " ");
      if ((dir === mp || dir.startsWith(mp + "/")) && (best === null || mp.length > best.mp.length)) {
        best = { mp, fsType };
      }
    }
  } catch {
    // No /proc/mounts (non-Linux): fall back to the known RAM-backed prefixes.
    return ["/tmp", "/dev/shm", "/run"].some((p) => dir === p || dir.startsWith(p + "/"));
  }
  return best ? best.fsType === "tmpfs" || best.fsType === "ramfs" : false;
}

/**
 * The durable evidence/scratch root: $CAP_DURABLE_ROOT ?? $HOME/cap-evidence.
 * THROWS when the resolved root is RAM-backed — never silently falls back to
 * tmpfs (that silence is what the bead bans).
 */
export function durableRoot() {
  // An EMPTY override (CAP_DURABLE_ROOT="" — the classic result of shell
  // parameter expansion of an unset var) means UNSET: ?? alone keeps "",
  // and join("", …) would then yield a RELATIVE CWD path with no refusal
  // (review P2 on 62696628).
  const override = process.env.CAP_DURABLE_ROOT;
  const root = override && override.trim() !== ""
    ? override
    : join(homedir(), "cap-evidence");
  if (isRamBacked(root)) {
    throw new Error(
      `durable root ${root} is RAM-backed (tmpfs) — evidence and scratch must survive ` +
        `a reboot (bead chp). Point CAP_DURABLE_ROOT at a disk-backed directory.`,
    );
  }
  return root;
}

export const DEFAULT_DURABLE_DIR_MAX_ENTRIES = 1000;
// The entry cap alone is not a disk bound (iqt8f: 5000 entries x the measured
// ~5.7 MB/scratch dir exceeds this host's disk). The real bound is free space:
// refuse to create a NEW durable dir once available disk drops below this
// reserve, whatever size each entry turns out to be.
//
// nudb2: this reserve is ADVISORY, because the volume it measures is not ours.
// The durable root ($HOME/cap-evidence) sits on the ROOT filesystem here, shared
// with every repo, worktree, node_modules store and rustc/deno build on the host.
// Measuring that volume cannot tell evidence growth from nine heavy builders, so
// throwing on it converted ONE lane's disk state into a fleet-wide gate outage:
// the merger's union gate redded 13/13 with "CAP_DURABLE_DIR_MIN_FREE_BYTES
// exceeded" at 481 MB free (2026-10-16) while cap-evidence itself held 204 MB.
// Landing below this reserve now reports a NAMED warning and creates the dir; a
// bounded, age-gated trim of stale scratch runs first to relieve it.
export const DEFAULT_DURABLE_DIR_MIN_FREE_BYTES = 512 * 1024 * 1024;
// The evidence-viability floor: what is left that protects the EVIDENCE volume
// from being filled past the point where evidence can be written at all. Below
// this, creating a scratch dir is refused loudly (fail closed, named) — that is
// the integrity half, and it is a separate, much smaller bound than the shared-fs
// reserve above because it is about OUR writes, not the host's other tenants.
// Sized from the measured ~5.7 MB/scratch dir (iqt8f) with headroom for the run
// that fills it. Set CAP_DURABLE_DIR_FLOOR_BYTES=0 to disable it.
export const DEFAULT_DURABLE_DIR_FLOOR_BYTES = 32 * 1024 * 1024;
// The bounded self-cleaning trim (nudb2): stale entries under these top-level
// durable-root directories are the only thing a low-free event may remove, and
// only when they are older than the age bound, oldest first, up to the entry
// bound. Nothing a live run just created is ever a candidate (age gate), and no
// other lane's evidence directory is in the allowlist.
export const DEFAULT_DURABLE_DIR_TRIM_NAMES = ["serial-phase-logs", "acp-fixture-logs", "scratch", "tmp"];
export const EPOCH_SUFFIX_RE = /^.+-[0-9]{10,}$/;
export const DEFAULT_DURABLE_DIR_TRIM_MIN_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_DURABLE_DIR_TRIM_MAX_ENTRIES = 200;
// The stat budget for the staleness walk (kkczc/zcg7p): proving an entry stale means looking at its
// whole subtree, so the walk is bounded and an unfinished walk means "unknown", which keeps the
// entry. 20k stats is a fraction of a second and this path only runs when free space is low.
export const DEFAULT_DURABLE_DIR_TRIM_MAX_STATS = 20000;

function parseCapEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  const valid = Number.isFinite(parsed) && Number.isInteger(parsed) &&
    (allowZero ? parsed >= 0 : parsed > 0);
  if (!valid) {
    throw new Error(
      `${name} invalid: expected ${allowZero ? "non-negative" : "positive"} integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * The free-space policy for creating a durable dir, as a PURE function so both
 * branches are testable without touching this host's disk (nudb2).
 *
 * `fatal` means the evidence volume cannot accept evidence (integrity: fail
 * closed, named). `warning` means the shared volume is low but creating the dir
 * is still the right call: the condition is named, the trim already ran, and the
 * write either succeeds or fails on its own terms.
 */
export function freeSpaceVerdict({ free, minFree, floor, anchor, dir }) {
  if (free === null || free === undefined) return {};
  if (floor > 0 && free < floor) {
    return {
      fatal: `CAP_DURABLE_DIR_FLOOR exceeded: ${anchor} has ${free} bytes free (floor ${floor}, ` +
        `requested ${dir}) — too little left on the evidence volume to write durable evidence there`,
    };
  }
  if (minFree > 0 && free < minFree) {
    return {
      warning: `CAP_DURABLE_DIR_LOW_FREE_WARNING: ${anchor} has ${free} bytes free (advisory reserve ` +
        `${minFree}, requested ${dir}) — this volume also holds repos, worktrees and builds, so low free ` +
        `space here is not proof that evidence grew; creating the dir anyway`,
    };
  }
  return {};
}

/**
 * The NEWEST mtime in an entry's subtree, or null when it could not be established (chrome-agent-
 * platform-zcg7p).
 *
 * The entry's own mtime is not its age: writing into an existing file leaves the parent directory's
 * mtime untouched, and the reviewer's repro showed a live >1h run being deleted that way. A run that
 * is still working has a recently written file, so the maximum over the subtree is the honest "last
 * touched" signal. Symlinks are never followed (chrome-agent-platform-kkczc) and the walk is bounded:
 * exhausting the budget, an unreadable directory, or a vanished path returns null, which the caller
 * treats as NOT stale and therefore keeps.
 */
function newestMtimeMs(path, budget) {
  let newest = null;
  const stack = [path];
  while (stack.length) {
    if (budget.left <= 0) return null;
    budget.left--;
    const current = stack.pop();
    let st;
    try {
      st = lstatSync(current); // lstat: a symlink is itself, never its target
    } catch {
      return null; // vanished under us: unprovable, so keep
    }
    if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let names;
      try {
        names = readdirSync(current);
      } catch {
        return null; // unreadable subtree: unprovable, so keep
      }
      for (const name of names) stack.push(join(current, name));
    }
  }
  return newest;
}

/**
 * Bounded self-cleaning trim of stale scratch under the durable root (nudb2).
 * Allowlisted directories only, age-gated oldest-first, entry-bounded, and every
 * failure ignored: the trim is relief, never a new way for a gate to fail.
 *
 * Two reviewer findings are pinned here (chrome-agent-platform-zcg7p, -kkczc): an
 * entry is stale only when the NEWEST mtime anywhere in its subtree is older than
 * the bound, and an allowlisted parent must be a REAL directory - a symlink is not
 * followed, and symlinked entries are never removed - so the allowlist cannot be
 * used to reach another lane's evidence.
 * @returns {{removed: number, before: number|null, after: number|null}}
 */
export function trimStaleScratch(root, {
  names = DEFAULT_DURABLE_DIR_TRIM_NAMES,
  minAgeMs = DEFAULT_DURABLE_DIR_TRIM_MIN_AGE_MS,
  maxEntries = DEFAULT_DURABLE_DIR_TRIM_MAX_ENTRIES,
  maxStats = DEFAULT_DURABLE_DIR_TRIM_MAX_STATS,
  now = Date.now(),
} = {}) {
  const before = freeBytesAt(root);
  const budget = { left: maxStats };
  let removed = 0;
  for (const name of names) {
    if (removed >= maxEntries || budget.left <= 0) break;
    const parent = join(root, name);
    let parentStat;
    try {
      parentStat = lstatSync(parent);
    } catch {
      continue; // not present or unreadable: nothing to trim
    }
    if (!parentStat.isDirectory()) continue; // a symlinked or non-directory allowlisted name is not ours
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: nothing to trim
    }
    const candidates = [];
    for (const entry of entries) {
      const path = join(parent, entry.name);
      if (entry.isSymbolicLink()) continue; // never remove through a link
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue; // raced away by its owner: it is already gone
      }
      if (st.isSymbolicLink()) continue;
      const newest = newestMtimeMs(path, budget);
      if (newest === null) continue; // could not prove it stale: keep it
      if (now - newest >= minAgeMs) candidates.push({ path, newest });
    }
    candidates.sort((a, b) => a.newest - b.newest); // oldest first: the newest scratch survives
    for (const candidate of candidates) {
      if (removed >= maxEntries) break;
      try {
        rmSync(candidate.path, { recursive: true, force: true });
        removed++;
      } catch {
        // a failed removal is not fatal: the create still has the verdict path
      }
    }
  }
  // Also trim stale top-level epoch-suffixed run directories directly under root (wvg1s)
  if (removed < maxEntries && budget.left > 0) {
    let topEntries;
    try {
      topEntries = readdirSync(root, { withFileTypes: true });
    } catch {
      topEntries = [];
    }
    const topCandidates = [];
    for (const entry of topEntries) {
      if (entry.isSymbolicLink()) continue;
      if (!EPOCH_SUFFIX_RE.test(entry.name)) continue;
      const path = join(root, entry.name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const match = /-([0-9]{10,})$/.exec(entry.name);
      const suffixTs = match ? Number(match[1]) : 0;
      if (suffixTs > 0 && now - suffixTs < minAgeMs) continue; // suffix is fresher than minAgeMs: keep

      const newest = newestMtimeMs(path, budget);
      if (newest === null) continue; // could not prove it stale: keep it
      if (now - newest >= minAgeMs) topCandidates.push({ path, newest });
    }
    topCandidates.sort((a, b) => a.newest - b.newest);
    for (const candidate of topCandidates) {
      if (removed >= maxEntries) break;
      try {
        rmSync(candidate.path, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  }
  return { removed, before, after: freeBytesAt(root) };
}

/** Return the nearest existing ancestor of `path`, falling back to `homedir()`. */
export function nearestExistingAncestor(path) {
  let cur = path;
  while (cur && !existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur && existsSync(cur) ? cur : homedir();
}

function freeBytesAt(path) {
  try {
    const st = statfsSync(path);
    const avail = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(avail) ? avail : null;
  } catch {
    return null; // statfs unavailable: the entry cap still applies.
  }
}

/** The allowlisted trim set, from CAP_DURABLE_DIR_TRIM_NAMES ("" disables the trim). */
function trimNames() {
  const raw = process.env.CAP_DURABLE_DIR_TRIM_NAMES;
  if (raw === undefined) return DEFAULT_DURABLE_DIR_TRIM_NAMES;
  return raw.split(",").map((name) => name.trim()).filter((name) => name !== "" && name !== "." && !name.includes("/"));
}

/** A mkdir -p'd named dir under the durable root. Throws if RAM-backed. */
export function durableDir(...parts) {
  const dir = join(durableRoot(), ...parts);
  if (isRamBacked(dir)) {
    throw new Error(`refusing RAM-backed evidence dir ${dir} (bead chp)`);
  }
  if (!existsSync(dir)) {
    const cap = parseCapEnv("CAP_DURABLE_DIR_MAX_ENTRIES", DEFAULT_DURABLE_DIR_MAX_ENTRIES);
    const minFree = parseCapEnv(
      "CAP_DURABLE_DIR_MIN_FREE_BYTES",
      DEFAULT_DURABLE_DIR_MIN_FREE_BYTES,
      { allowZero: true },
    );
    const floor = parseCapEnv("CAP_DURABLE_DIR_FLOOR_BYTES", DEFAULT_DURABLE_DIR_FLOOR_BYTES, { allowZero: true });
    const parent = parts.length > 1 ? join(durableRoot(), ...parts.slice(0, -1)) : durableRoot();
    try {
      if (existsSync(parent)) {
        let count = readdirSync(parent).length;
        if (count >= cap) {
          // Relieve entry cap pressure from stale scratch and epoch-suffixed run dirs (wvg1s)
          const root = durableRoot();
          const trim = trimStaleScratch(root, {
            names: trimNames(),
            minAgeMs: parseCapEnv("CAP_DURABLE_DIR_TRIM_MIN_AGE_MS", DEFAULT_DURABLE_DIR_TRIM_MIN_AGE_MS, { allowZero: true }),
            maxEntries: parseCapEnv("CAP_DURABLE_DIR_TRIM_MAX_ENTRIES", DEFAULT_DURABLE_DIR_TRIM_MAX_ENTRIES, { allowZero: true }),
          });
          if (trim.removed > 0) {
            count = readdirSync(parent).length;
          }
        }
        if (count >= cap) {
          throw new Error(
            `CAP_DURABLE_DIR_MAX_ENTRIES exceeded: ${parent} has ${count} entries (limit ${cap}, requested ${dir})`,
          );
        }
      }
      if (minFree > 0 || floor > 0) {
        const root = durableRoot();
        const anchor = nearestExistingAncestor(parent);
        let free = freeBytesAt(anchor);
        const low = free !== null && ((minFree > 0 && free < minFree) || (floor > 0 && free < floor));
        if (low) {
          // Try to relieve the condition from OUR OWN stale scratch before deciding anything.
          const trim = trimStaleScratch(root, {
            names: trimNames(),
            minAgeMs: parseCapEnv("CAP_DURABLE_DIR_TRIM_MIN_AGE_MS", DEFAULT_DURABLE_DIR_TRIM_MIN_AGE_MS, { allowZero: true }),
            maxEntries: parseCapEnv("CAP_DURABLE_DIR_TRIM_MAX_ENTRIES", DEFAULT_DURABLE_DIR_TRIM_MAX_ENTRIES, { allowZero: true }),
          });
          if (trim.removed > 0) {
            console.error(
              `CAP_DURABLE_DIR_TRIM: removed ${trim.removed} stale scratch entr${trim.removed === 1 ? "y" : "ies"} ` +
                `under ${root} (free ${trim.before} -> ${trim.after} bytes)`,
            );
            free = trim.after;
          }
        }
        const verdict = freeSpaceVerdict({ free, minFree, floor, anchor, dir });
        if (verdict.fatal) throw new Error(verdict.fatal);
        // Named, loud, and NOT fatal (nudb2): a shared-volume low-free condition must
        // not be able to stop every lane on the host from running its gate.
        if (verdict.warning) console.error(verdict.warning);
      }
    } catch (err) {
      if (err.message && err.message.startsWith("CAP_DURABLE_DIR_")) throw err;
    }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
