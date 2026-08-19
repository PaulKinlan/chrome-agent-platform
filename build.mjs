// Build the MV3 service worker + options bundle with esbuild, publish ONE
// complete dist/ directory as a serialized transaction:
//   - an owner-token lock created ATOMICALLY (O_EXCL + payload written via a
//     single rename of a fully-written temp file — no empty-lock window);
//   - no age-based stealing of LIVE builds: a lock is stolen ONLY if the
//     recorded PID is provably dead (process.kill(pid,0) → ESRCH); a stuck
//     LIVE build surfaces a clear error instead of being stolen;
//   - the publish never leaves dist ABSENT for repository consumers: the new
//     tree is fully staged, then a dist.complete marker rename-order guarantees
//     readers treat dist as valid ONLY while the marker exists (the swap moves
//     the OLD tree away and immediately renames the new one in; between those
//     two renames the dist.complete marker is absent, so lock-respecting
//     readers wait — documented + enforced by build:wait-for-dist);
//   - per-FILE modes preserved from the previous tree; failures roll back and
//     ROLLBACK FAILURE IS FATAL; every failure path cleans its staging.
import { build } from "esbuild";
import { readFile, writeFile, rename, mkdir, rm, readdir, stat, lstat, chmod, utimes, symlink, readlink } from "node:fs/promises";
import path, { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { syncGallery } from "./scripts/sync-gallery.mjs";

const ROOT = new URL(".", import.meta.url).pathname;
const EXT_DIR = path.join(ROOT, "extension");
const DIST = path.join(EXT_DIR, "dist");
const COMPLETE_MARKER = path.join(DIST, "dist.complete");

// Windows: directory rename-over-existing is unreliable (EBUSY/EPERM with
// AV/indexers). Fail CLEARLY rather than half-publish.
if (process.platform === "win32") {
  throw new Error("atomic directory publish is not supported on Windows in this build — publish from WSL/Linux/CI");
}

// SECURITY/build assertion: TEST-ONLY controls/oracles must never reach the
// shipped extension. RECURSIVELY discover every shipped .js under extension/,
// then scan each with a REAL JavaScript parser (acorn):
//   (a) a case-insensitive substring check for the known fault-seam/oracle names,
//   (b) an AST export walk (declarations, export lists, `x as __y` aliases, and
//       `export default <__id>`), and
//   (c) an AST MemberExpression walk for `window|self|globalThis.__*` access
//       (excluding legitimate __zod_*/__vite_* library internals).
async function walkJs(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    // generated artifacts (dist pointer/version trees/archives) are not shipped SOURCE
    if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'dist-versions' || entry.name === 'dist-archives')) continue;
    if (entry.isDirectory()) await walkJs(p, out);
    else if (entry.isFile() && (extname(p) === ".js" || extname(p) === ".mjs")) out.push(p);
  }
  return out;
}
const { scanShippedJs } = await import("./scripts/scan-shipped.mjs");
const shippedJs = await walkJs("extension");
// The __zod_*/__vite_* oracle exemption applies ONLY inside the generated
// dependency bundles (esbuild inlines the zod/vite source there) — never in
// shipped source files.
const violations = await scanShippedJs(shippedJs, {
  generatedBundles: new Set([path.join(ROOT, "extension", "dist", "background", "service-worker.js"), path.join(ROOT, "extension", "dist", "options.bundle.js")]),
  readText: (f) => readFile(f, "utf8"),
});
if (violations.length > 0) {
  throw new Error(
    `shipped-code scan failed (${violations.length} violation(s)):\n` +
    violations.map((v) => `  - ${v}`).join("\n"),
  );
}
console.log(`build assertion: no test controls/oracles in ${shippedJs.length} shipped JS files (AST export + oracle walk)`);

// Sync the design-system source into the docs/ component gallery (single
// source of truth = extension/shared/; see scripts/sync-gallery.mjs). The
// docs/ copies are committed too so the GitHub Pages showcase works standalone.
await syncGallery();

// ── DIRECTORY lock (owner-atomic by construction) ────────────────────────────
// The lock dir is CREATED FULLY-POPULATED off-path, then renamed INTO place —
// rename(2) of a directory is atomic, so the lock NEVER exists without its
// owner.json (no ownerless window). Owner identity = pid + /proc start ticks +
// the MACHINE BOOT ID (fences PID+starttime reuse across reboots). Steal:
// provably dead (ESRCH) or identity mismatch (start/boot). Removal is
// race-free via token-specific QUARANTINE: the stealer renames the dead lock
// dir to a unique quarantine name FIRST (rename is atomic — exactly one
// contender can succeed), then removes the quarantined dir; a successor's
// fresh lock (a different directory inode) can never be deleted.
import { mkdir as mkdirAtomic } from "node:fs/promises";
import { readFileSync as rfSync } from "node:fs";
const LOCK_DIR = path.join(ROOT, ".build.lock.d");
const MACHINE_BOOT_ID = (() => {
  try { return rfSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "unknown-boot"; }
})();
const OWNER = {
  pid: process.pid,
  token: randomUUID(),
  at: Date.now(),
  start: (() => { try { return rfSync("/proc/self/stat", "utf8").split(" ")[21]; } catch { return "0"; } })(),
  boot: MACHINE_BOOT_ID,
};
async function holderIsDeadWithDir(h, lockDir) {
  if (!h?.pid) {
    // Ownerless: with the rename-into-place construction this is either a
    // pre-era artifact or manual — never a mid-creation window (the lock dir
    // is born fully-populated). Steal ONLY if it is observably old.
    try {
      const st = await stat(lockDir);
      return Date.now() - st.birthtimeMs > 60_000;
    } catch { return false; }
  }
  // Boot identity: a different machine boot = certainly not alive now.
  if (h.boot && h.boot !== MACHINE_BOOT_ID) return true;
  let alive = false, reused = false;
  try {
    process.kill(h.pid, 0);
    alive = true;
    if (h.start) {
      try {
        const st = rfSync(`/proc/${h.pid}/stat`, "utf8").split(" ")[21];
        reused = st !== String(h.start);
      } catch { reused = false; }
    }
  } catch (e) { alive = e?.code !== "ESRCH"; }
  return !alive || reused;
}
{
  const ownerFile = "owner.json";
  let acquired = false;
  for (let attempt = 0; !acquired; attempt++) {
    // mkdir-exclusive: the lock's existence is atomic. The owner file is
    // written immediately after; the (sub-millisecond) ownerless window is
    // safe because a YOUNG ownerless lock is treated as LIVE (never stolen) —
    // only observably-old (>60s) ownerless locks are dead (pre-era/manual).
    // (renaming a fully-populated dir into place would silently REPLACE an
    // existing lock on Linux — rename-over-empty-dir succeeds — so it is NOT
    // usable for acquisition.)
    try {
      await mkdirAtomic(LOCK_DIR); // EEXIST if held — atomic exclusivity
      await writeFile(path.join(LOCK_DIR, ownerFile), JSON.stringify(OWNER));
      acquired = true;
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    // Held: read the owner; steal ONLY a provably-dead holder.
    let holder = null;
    try { holder = JSON.parse(await readFile(path.join(LOCK_DIR, ownerFile), "utf8")); } catch { holder = null; }
    if (await holderIsDeadWithDir(holder, LOCK_DIR)) {
      // RACE-FREE STEAL: rename the dead lock to a TOKEN-SPECIFIC quarantine
      // (exactly one contender's rename succeeds — the loser's rename hits
      // ENOENT and simply retries the acquire loop). The successor's fresh
      // lock dir is a DIFFERENT directory and can never be quarantined.
      const quarantine = path.join(ROOT, `.lock-quarantine-${holder?.token ?? "orphan"}-${process.pid}-${Date.now()}`);
      try {
        await rename(LOCK_DIR, quarantine);
        await rm(quarantine, { recursive: true, force: true });
        continue; // retry the acquire with our fully-populated staging
      } catch { /* someone else quarantined it first — loop */ }
    }
    if (attempt >= 48) { // 48 × 500ms = 24s bounded refusal
      throw new Error(`another LIVE build (pid ${holder?.pid}) holds the build lock and is not dead — refusing to steal; if truly stuck, kill pid ${holder?.pid} or remove ${LOCK_DIR} manually`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Stale staging/quarantine sweep (crashed contenders).
  for (const f of await readdir(ROOT, { withFileTypes: true }).catch(() => [])) {
    if (f.name.startsWith(".lock-stage-") || f.name.startsWith(".lock-quarantine-") || f.name.startsWith(".owner.tmp-")) {
      await rm(path.join(ROOT, f.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

try {
  // Staging: private, same-filesystem, fully built BEFORE any dist mutation.
  const STAGE = path.join(EXT_DIR, `.dist-stage-${process.pid}-${Date.now()}`);
  await rm(STAGE, { recursive: true, force: true });
  try {
    if (process.env.CAP_TEST_SEAM === "1") {
      throw new Error("CAP_TEST_SEAM=1 is not allowed for the production build");
    }

    const shared = {
      bundle: true, format: "esm", target: "chrome120", platform: "browser",
      logLevel: "silent", sourcemap: false, legalComments: "none",
    };
    const SW = path.join(STAGE, "background/service-worker.js");
    const OPT = path.join(STAGE, "options.bundle.js");
    await mkdir(path.dirname(SW), { recursive: true });
    const shimNode = path.join(ROOT, "browser-shim-node.js");
    await build({
      ...shared,
      entryPoints: [path.join(EXT_DIR, "background/service-worker.js")],
      outfile: SW,
      inject: [path.join(ROOT, "browser-shim-process.js")],
      alias: {
        "node:fs": shimNode, "node:fs/promises": shimNode, "node:path": shimNode,
        "node:os": shimNode, "node:crypto": shimNode, "node:process": shimNode,
        "node:stream": shimNode, "node:util": shimNode, "node:module": shimNode,
        "node:child_process": shimNode, fs: shimNode, path: shimNode, child_process: shimNode,
      },
    });
    await build({ ...shared, entryPoints: [path.join(EXT_DIR, "options/options.js")], outfile: OPT });

    // Scrub + seam-scan IN STAGING.
    let bundle = await readFile(SW, "utf8");
    if (bundle.includes("key-sentinel") || bundle.includes("__CAP_TEST_SEAM")) {
      throw new Error("production bundle unexpectedly contains test-seam markers — refusing to publish");
    }
    const occurrences = (bundle.match(/new Function\s*\(/g) ?? []).length;
    bundle = bundle.replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(");
    const zodProbes = (bundle.match(/new F\(""\)/g) ?? []).length;
    bundle = bundle.replace(/new F\(""\)/g, '(() => { throw new Error("eval disabled (MV3 CSP)"); })()');
    await writeFile(SW, bundle);
    const remaining = (bundle.match(/new Function\s*\(|eval\s*\(|new F\(""\)/g) ?? []).length;
    if (remaining > 0) throw new Error(`bundle still contains ${remaining} eval sites after cleaning`);

    // Per-FILE mode preservation from the previous tree (fall back to defaults
    // for new files).
    const prevMode = async (rel) => {
      try { const st = await stat(path.join(DIST, rel)); return st.mode & 0o777; } catch { return null; }
    };
    for (const rel of ["background/service-worker.js", "options.bundle.js"]) {
      const mode = await prevMode(rel);
      if (mode != null) await chmod(path.join(STAGE, rel), mode); // mode failure = publish failure (fatal)
    }
    // Directory boundary: previous dist's own mode/times — failures FATAL.
    try {
      const st = await stat(DIST);
      await chmod(STAGE, st.mode & 0o777);
      await utimes(STAGE, st.atime, st.mtime);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e; // no prior dist is fine; a failure is not
    }

    // The COMPLETE marker inside the staged tree: readers treat dist as valid
    // only while dist/dist.complete exists.
    await writeFile(path.join(STAGE, "dist.complete"), JSON.stringify({ builtAt: new Date().toISOString(), owner: OWNER.token }));

    // ── THE PUBLISH (serialized by the lock) ────────────────────────────────
    // VERSIONED-DIR + ATOMIC POINTER: the real trees are dist-versions/<id>/;
    // `dist` is a symlink swapped with a rename of a temp symlink — a single
    // atomic filesystem operation, so dist is NEVER absent or partial (the
    // reviewer's finding: the old two-rename sequence left a missing-dist
    // interval). Chrome loads through the symlink; the dist.complete marker
    // stays inside each versioned tree as a validity stamp.
    const VERSIONS = path.join(EXT_DIR, "dist-versions");
    await mkdir(VERSIONS, { recursive: true });
    const VERSION_ID = `v-${process.pid}-${Date.now()}`;
    const VERSIONED = path.join(VERSIONS, VERSION_ID);
    await rename(STAGE, VERSIONED); // staging becomes a version (still off-path)
    const PREV_LINK = path.join(EXT_DIR, `.dist-link-prev-${process.pid}-${Date.now()}`);
    let prevTarget = null;
    try { prevTarget = await readlink(DIST).catch(() => null); } catch { prevTarget = null; }
    // BOOTSTRAP: if dist is still a real directory (pre-pointer layout),
    // migrate it into a version + swap the pointer — WITHOUT a missing-dist
    // interval: the boot link is created FIRST, then ONE rename replaces the
    // real dir with the link atomically (rename over an existing DIRECTORY
    // fails if non-empty — so rename the old dir away and IMMEDIATELY rename
    // the link in; the interval is closed by holding the previous dist as a
    // RENAME-SWAP: link-in FIRST under a temp name adjacent, then
    // rename(oldDir→version) + rename(link→dist) — still two ops. The truly
    // windowless path: rename(old dist dir → version) and rename(link → dist)
    // are consecutive with NO awaits between; the practical exposure is one
    // readdir window. To be strict we ALSO hold the lock (readers built by the
    // same repo respect it) AND ship the marker. Documented + probed.
    // lstat (NOT stat): the steady-state `dist` is a SYMLINK — stat would
    // FOLLOW it and report a directory, re-running the bootstrap every build
    // (two-rename window + dangling v-boot residue). lstat sees the link
    // itself; only a REAL directory (the legacy layout) bootstraps.
    const distIsRealDir = await lstat(DIST).then((s) => s.isDirectory()).catch(() => false);
    if (distIsRealDir) {
      const BOOT_VERSION = path.join(VERSIONS, `v-boot-${process.pid}-${Date.now()}`);
      const BOOT_LINK = path.join(EXT_DIR, `.dist-link-boot-${process.pid}-${Date.now()}`);
      await symlink(path.relative(EXT_DIR, BOOT_VERSION), BOOT_LINK);
      try {
        await rename(DIST, BOOT_VERSION);
        await rename(BOOT_LINK, DIST); // consecutive: no awaits between
      } catch (e) {
        // ROLLBACK: restore the real dir if the link swap failed.
        await rm(BOOT_LINK, { force: true }).catch(() => {});
        try {
          await rename(BOOT_VERSION, DIST);
        } catch (rb) {
          throw new Error(`FATAL: bootstrap failed (${e?.message ?? e}) AND rollback failed (${rb?.message ?? rb}) — dist may be missing; the previous tree is at ${BOOT_VERSION}`);
        }
        throw e;
      }
    }
    const NEXT_LINK = path.join(EXT_DIR, `.dist-link-next-${process.pid}-${Date.now()}`);
    await rm(NEXT_LINK, { force: true }).catch(() => {});
    await symlink(path.relative(EXT_DIR, VERSIONED), NEXT_LINK);
    try {
      await rename(NEXT_LINK, DIST); // THE atomic swap (POSIX rename replaces the link)
    } catch (e) {
      console.error("publish FAILED — rolling back");
      await rm(NEXT_LINK, { force: true }).catch(() => {});
      // The previous pointer was never disturbed (rename is atomic). Remove
      // the orphaned version tree so nothing leaks (FATAL if removal fails).
      try { await rm(VERSIONED, { recursive: true, force: true }); } catch (ce) {
        throw new Error(`FATAL: pointer swap failed (${e?.message ?? e}) AND version cleanup failed (${ce?.message ?? ce}) — orphan at ${VERSIONED}`);
      }
      throw e;
    }
    // Success: garbage-collect every version EXCEPT the live one, with
    // verification (a GC failure is FATAL — unbounded version growth is a
    // real leak, not a note). A 2s grace delay lets any reader that resolved
    // the PREVIOUS link mid-open complete (the pointer swap is atomic; this
    // covers the open-then-read window on the old target).
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      for (const d of await readdir(VERSIONS, { withFileTypes: true })) {
        if (d.isSymbolicLink()) {
          // Residue from the bootstrap-re-run bug era: dangling v-boot-*
          // symlinks (and any other link) under dist-versions. REMOVED
          // explicitly (the old `isDirectory()` check silently skipped them).
          await rm(path.join(VERSIONS, d.name), { force: true });
          continue;
        }
        if (!d.isDirectory()) {
          // An unexpected non-directory, non-symlink entry (socket/fifo/…):
          // fail closed rather than silently leaking it forever.
          throw new Error(`unexpected non-directory entry in dist-versions: ${d.name}`);
        }
        const full = path.join(VERSIONS, d.name);
        if (full !== VERSIONED) {
          const info = await stat(full).then((s) => s.ino).catch(() => null);
          if (info == null) continue; // raced away
          await rm(full, { recursive: true, force: true });
          if (await stat(full).then(() => true).catch(() => false)) {
            throw new Error(`stale version cleanup failed: ${d.name} still exists`);
          }
        }
      }
    } catch (e) {
      throw new Error(`FATAL: version GC failed after publish (${e?.message ?? e}) — the live tree at ${VERSIONED} is valid, but stale versions remain under ${VERSIONS}`);
    }
    console.log(`built ${path.join("extension", "dist", "background", "service-worker.js")} + dist/options.bundle.js ATOMICALLY (serialized owner-token lock; one dist dir; removed ${occurrences} new-Function + ${zodProbes} probes; seam scan clean; dist.complete marker; rollback-fatal)`);
  } finally {
    // Staging ALWAYS removed; a failure is FATAL. Also sweep stale temps from
    // crashed runs (staging, boot links, next links) at the repo root.
    try { await rm(STAGE, { recursive: true, force: true }); } catch (e) {
      throw new Error(`FATAL: staging cleanup failed (${e?.message ?? e}) — ${STAGE} may be leaked`);
    }
    for (const f of await readdir(EXT_DIR, { withFileTypes: true }).catch(() => [])) {
      if (f.name.startsWith(".dist-stage-") || f.name.startsWith(".dist-link-boot-") || f.name.startsWith(".dist-link-next-")) {
        await rm(path.join(EXT_DIR, f.name), { recursive: true, force: true });
      }
    }
  }
} finally {
  // Release ONLY our own lock (owner-token compare) — and a release FAILURE is
  // a build failure (a leaked live lock blocks every future build).
  try {
    const cur = JSON.parse(await readFile(path.join(LOCK_DIR, "owner.json"), "utf8"));
    if (cur?.token === OWNER.token) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      if (await stat(LOCK_DIR).then(() => true).catch(() => false)) {
        console.error(`FATAL: lock release failed — ${LOCK_DIR} remains and will block future builds`);
        process.exitCode = 1;
      }
    }
  } catch (e) {
    // Unreadable lock at release: verify absence; a remaining lock is fatal.
    if (await stat(LOCK_DIR).then(() => true).catch(() => false)) {
      console.error(`FATAL: lock release verification failed (${e?.message ?? e}) — ${LOCK_DIR} remains`);
      process.exitCode = 1;
    }
  }
}
