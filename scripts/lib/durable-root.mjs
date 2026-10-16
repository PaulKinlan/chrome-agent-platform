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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** A mkdir -p'd named dir under the durable root. Throws if RAM-backed. */
export function durableDir(...parts) {
  const dir = join(durableRoot(), ...parts);
  if (isRamBacked(dir)) {
    throw new Error(`refusing RAM-backed evidence dir ${dir} (bead chp)`);
  }
  if (!existsSync(dir)) {
    const rawCap = process.env.CAP_DURABLE_DIR_MAX_ENTRIES;
    let cap = DEFAULT_DURABLE_DIR_MAX_ENTRIES;
    if (rawCap !== undefined && rawCap.trim() !== "") {
      const parsed = Number(rawCap);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `CAP_DURABLE_DIR_MAX_ENTRIES invalid: expected positive integer, got ${JSON.stringify(rawCap)}`,
        );
      }
      cap = parsed;
    }
    const parent = parts.length > 1 ? join(durableRoot(), ...parts.slice(0, -1)) : durableRoot();
    try {
      if (existsSync(parent)) {
        const count = readdirSync(parent).length;
        if (count >= cap) {
          throw new Error(
            `CAP_DURABLE_DIR_MAX_ENTRIES exceeded: ${parent} has ${count} entries (limit ${cap}, requested ${dir})`,
          );
        }
      }
    } catch (err) {
      if (err.message && err.message.includes("CAP_DURABLE_DIR_MAX_ENTRIES exceeded")) throw err;
    }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
