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
import { execFileSync } from "node:child_process";
import { syncGallery } from "./scripts/sync-gallery.mjs";
import { syncChangelog } from "./scripts/sync-changelog.mjs";
import {
  computeIndexedSourceAuthority,
  validateDistCompleteMarker,
  writeDistCompleteMarker,
} from "./scripts/dist-complete.mjs";
import {
  deltaBetween,
  parseChangelog,
  readLastBuiltVersion,
  renderDelta,
  shouldRecordBuild,
  writeLastBuiltVersion,
  DEFAULT_BUILT_VERSION_PATH,
} from "./scripts/changelog-delta.mjs";

function parseBuildTarget(args) {
  if (!Array.isArray(args) || args.length > 1) {
    throw new Error("usage: node build.mjs [--target=developer|store] [--regen-tools]");
  }
  // DEFAULT is the DEBUG (developer) build: sourcemaps + verbose logging by
  // default, so `npm run build` gives the owner diagnosable traces. The Store
  // bundle is the explicit `--target=store` (`npm run build:production`).
  // Identical security assertions run in BOTH modes — the mode flips ONLY
  // sourcemap emission and the default log verbosity.
  if (args.length === 0 || args[0] === "--target=developer") return "developer";
  if (args[0] === "--target=store") return "store";
  if (args[0] === "--target=enterprise") {
    throw new Error("target_enterprise_not_enabled");
  }
  throw new Error(`unsupported build target argument: ${args[0]}`);
}

// --regen-tools is the EXPLICIT opt-in to fully regenerate the bundled Wasm
// tool packages; the default build only VERIFIES them (see below).
const RAW_ARGS = process.argv.slice(2);
const REGEN_TOOLS = RAW_ARGS.includes("--regen-tools");
const BUILD_TARGET = parseBuildTarget(RAW_ARGS.filter((a) => a !== "--regen-tools"));
const ROOT = new URL(".", import.meta.url).pathname;
const EXT_DIR = path.join(ROOT, "extension");
const DIST = path.join(EXT_DIR, "dist");
const COMPLETE_MARKER = path.join(DIST, "dist.complete");
// Owner-requested build output: the changelog delta since the LAST SUCCESSFUL
// build. The record lives in .build/ (gitignored, invocation-local, outside
// dist and dist-versions — never shipped, never in the indexed-source scan,
// and it survives the dist-versions GC by design). Never fails the build:
// every read/parse error degrades to a one-line warning.
const BUILT_VERSION_PATH = path.join(ROOT, DEFAULT_BUILT_VERSION_PATH);

// Windows: directory rename-over-existing is unreliable (EBUSY/EPERM with
// AV/indexers). Fail CLEARLY rather than half-publish.
if (process.platform === "win32") {
  throw new Error("atomic directory publish is not supported on Windows in this build — publish from WSL/Linux/CI");
}

// Bundled-tool truthfulness gate: the shipped Wasm tool packages are GENERATED
// artifacts. The default build runs the generator in --verify mode and FAILS
// CLOSED on any drift (hand edit, stale bytes, ungenerated file), so
// `npm run build` truthfully bundles the exact pinned tools. Full regeneration
// never happens implicitly — only via the explicit --regen-tools flag.
execFileSync(process.execPath, [
  path.join(ROOT, "scripts/build-bundled-tool-packages.mjs"),
  ...(REGEN_TOOLS ? [] : ["--verify"]),
], { cwd: ROOT, stdio: "inherit" });

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
async function walkWasm(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'dist-versions' || entry.name === 'dist-archives')) continue;
    if (entry.isDirectory()) await walkWasm(p, out);
    else if (entry.isFile() && extname(p) === ".wasm") out.push(p);
  }
  return out;
}
const { scanShippedJs, scanBundledWasmFiles } = await import("./scripts/scan-shipped.mjs");
const shippedJs = await walkJs("extension");
// The __zod_*/__vite_* oracle exemption applies ONLY inside the generated
// dependency bundles (esbuild inlines the zod/vite source there) — never in
// shipped source files.
const violations = await scanShippedJs(shippedJs, {
  generatedBundles: new Set([path.join(ROOT, "extension", "dist", "background", "service-worker.js"), path.join(ROOT, "extension", "dist", "options.bundle.js"), path.join(ROOT, "extension", "dist", "shared", "diff-core.bundle.js")]),
  // NOTE: the execution-host exemption is NOT caller-supplied — the scanner
  // owns the fixed canonical path + the exact allowed call shape.
  allowedDynamicEvaluatorFiles: new Set([
    "extension/sandbox/script-sandbox.js",
  ]),
  readText: (f) => readFile(f, "utf8"),
});
if (violations.length > 0) {
  throw new Error(
    `shipped-code scan failed (${violations.length} violation(s)):\n` +
    violations.map((v) => `  - ${v}`).join("\n"),
  );
}
console.log(`build assertion: no test controls/oracles in ${shippedJs.length} shipped JS files (AST export + oracle walk)`);

// Bundled-lane Wasm ships inventory-only: every content-addressed binary
// under extension/wasm/cas/ is mapped to its exact manifest executable via
// the generated bundled inventory (extension/lib/bundled-inventory-data.js).
// A binary with no exact manifest mapping still fails the build closed.
const shippedWasm = await walkWasm("extension");
const { BUNDLED_INVENTORY } = await import("./extension/lib/bundled-inventory-data.js");
const manifestByFile = new Map();
for (const identity of BUNDLED_INVENTORY.manifests) {
  const manifestRel = `extension/wasm/manifests/${identity.pkg}-${identity.version}.manifest.json`;
  const manifest = JSON.parse(await readFile(join(ROOT, manifestRel), "utf8"));
  for (const executable of manifest.executables ?? []) {
    const casRel = `extension/wasm/cas/${executable.sha256}.wasm`;
    if (manifestByFile.has(casRel)) throw new Error(`bundled-Wasm manifest collision: ${casRel}`);
    manifestByFile.set(casRel, executable);
  }
}
const wasmViolations = await scanBundledWasmFiles(shippedWasm, {
  readBytes: (file) => readFile(file),
  manifestByFile,
});
if (wasmViolations.length > 0) {
  throw new Error(`bundled-Wasm scan failed (${wasmViolations.length} violation(s)):\n${wasmViolations.map((value) => `  - ${value}`).join("\n")}`);
}
console.log(`build assertion: ${shippedWasm.length} bundled Wasm binaries; exact manifest + bounded raw scan required`);

// Sync the design-system source into the docs/ component gallery (single
// source of truth = extension/shared/; see scripts/sync-gallery.mjs). The
// docs/ copies are committed too so the GitHub Pages showcase works standalone.
await syncGallery();
// CHANGELOG.md is canonical and tracked; extension/CHANGELOG.md is an ignored
// generated package file. A clean git archive therefore needs the production
// build to materialize and verify it before the extension is copied/loaded.
await syncChangelog({ check: false });
await syncChangelog({ check: true });

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

// Module-scope state for the owner-requested build changelog delta: the
// version probe runs inside the try below, but the record write happens AFTER
// the outer finally (the final fatal step), so the variables are hoisted here.
let previousBuiltVersion = null;
let currentVersion = null;
let currentChangelog = null;
// Set true only after the dist.complete marker validated + the publish
// completed; the version record runs AFTER every fatal finalizer (see
// shouldRecordBuild) so a late death never records a success.
let buildSucceeded = false;

try {
  // Snapshot the previous successful build version + the current package
  // version BEFORE the build so the delta can be printed on success.
  // Fail-safe: unreadable/missing record or malformed changelog → warn +
  // continue (this feature must never fail the build).
  try {
    previousBuiltVersion = await readLastBuiltVersion(BUILT_VERSION_PATH);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    currentVersion = typeof pkg?.version === "string" ? pkg.version : null;
    currentChangelog = await readFile(
      path.join(ROOT, "CHANGELOG.md"),
      "utf8",
    ).catch((e) => {
      console.error(`warning: could not read CHANGELOG.md (${e?.message ?? e}) — skipping the build changelog delta`);
      return null;
    });
  } catch {
    // warn-only; the build must never fail over this feature
  }

  // Staging: private, same-filesystem, fully built BEFORE any dist mutation.
  const STAGE = path.join(EXT_DIR, `.dist-stage-${process.pid}-${Date.now()}`);
  await rm(STAGE, { recursive: true, force: true });
  try {
    if (process.env.CAP_TEST_SEAM === "1") {
      throw new Error("CAP_TEST_SEAM=1 is not allowed for the production build");
    }

    // Bind the build to a stable indexed-source snapshot. The marker is
    // recomputed after bundling and the build fails if source bytes changed
    // while esbuild was running.
    const sourceBefore = await computeIndexedSourceAuthority({ root: ROOT });

    // Build MODE (developer = debug / store = production). The mode flips
    // exactly two things: external sourcemaps (debug only) and the default
    // log verbosity injected as __CAP_BUILD_LOG_DEFAULT__ (cap-log.js reads
    // it; the owner's explicit storage choice always wins). NOTHING below
    // relaxes any security assertion — the bundled-tool verify gate, seam
    // scan, no-new-Function scrub, oracle/test-control AST scan and the
    // dist.complete marker authority run identically in both modes.
    const DEBUG_BUILD = BUILD_TARGET === "developer";
    const shared = {
      bundle: true, format: "esm", target: "chrome120", platform: "browser",
      logLevel: "silent", sourcemap: DEBUG_BUILD, legalComments: "none",
      define: {
        __CAP_BUILD_LOG_DEFAULT__: JSON.stringify(DEBUG_BUILD ? "verbose" : "off"),
      },
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
    // components.js imports the diff core by its DIST path (so the unbundled
    // extension pages resolve it at runtime); when esbuild bundles the options
    // page it must inline the SOURCE wrapper instead, so a clean checkout
    // builds without a stale/absent dist and the bundle never depends on
    // build order (CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01).
    const diffCoreFromSource = {
      name: "cap-diff-core-from-source",
      setup(b) {
        b.onResolve({ filter: /dist\/shared\/diff-core\.bundle\.js$/ }, () => ({ path: path.join(EXT_DIR, "shared/diff-core.js") }));
      },
    };
    await build({ ...shared, entryPoints: [path.join(EXT_DIR, "options/options.js")], outfile: OPT, plugins: [diffCoreFromSource] });
    // The diff core (CAP-FB-20260830-DIFF-LIBRARY-01): jsdiff lives in
    // node_modules, so the ONE wrapper module is bundled and every page /
    // component / the SW imports this single build by relative path.
    const DIFF_CORE = path.join(STAGE, "shared/diff-core.bundle.js");
    await mkdir(path.dirname(DIFF_CORE), { recursive: true });
    await build({ ...shared, entryPoints: [path.join(EXT_DIR, "shared/diff-core.js")], outfile: DIFF_CORE });
    // PHASE-2 agent worker bundle: the per-agent shared worker runs the
    // agent-do loop (lib/agent-loop.js → agent-do + ai) — those live in
    // node_modules, so the worker MUST be bundled (native ESM can't resolve
    // node_modules in the browser). Same `shared` config, no node shims (the
    // loop stack is browser-only: fetch/streams).
    const WORKER = path.join(STAGE, "workers/agent-worker.js");
    await mkdir(path.dirname(WORKER), { recursive: true });
    await build({
      ...shared,
      entryPoints: [path.join(EXT_DIR, "workers/agent-worker.js")],
      outfile: WORKER,
      format: "esm",
      // agent-do pulls @modelcontextprotocol/sdk (MCP) which imports node: builtins
      // even on the browser path — same shims as the SW bundle.
      inject: [path.join(ROOT, "browser-shim-process.js")],
      alias: {
        "node:fs": shimNode, "node:fs/promises": shimNode, "node:path": shimNode,
        "node:os": shimNode, "node:crypto": shimNode, "node:process": shimNode,
        "node:stream": shimNode, "node:util": shimNode, "node:module": shimNode,
        "node:child_process": shimNode, fs: shimNode, path: shimNode, child_process: shimNode,
      },
    });

    // Scrub + seam-scan IN STAGING (both the SW AND the agent-worker bundle —
    // agent-do/ai/mcp-sdk carry a `new Function`/`new F("")` evaluator that the
    // store-target policy forbids as a dynamic source evaluator).
    let occurrences = 0;
    let zodProbes = 0;
    for (const scrubPath of [SW, WORKER, DIFF_CORE]) {
      let bundle = await readFile(scrubPath, "utf8");
      if (bundle.includes("key-sentinel") || bundle.includes("__CAP_TEST_SEAM")) {
        throw new Error("production bundle unexpectedly contains test-seam markers — refusing to publish");
      }
      occurrences += (bundle.match(/new Function\s*\(/g) ?? []).length;
      bundle = bundle.replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(");
      zodProbes += (bundle.match(/new F\(""\)/g) ?? []).length;
      bundle = bundle.replace(/new F\(""\)/g, '(() => { throw new Error("eval disabled (MV3 CSP)"); })()');
      await writeFile(scrubPath, bundle);
      const remaining = (bundle.match(/new Function\s*\(|eval\s*\(|new F\(""\)/g) ?? []).length;
      if (remaining > 0) throw new Error(`bundle still contains ${remaining} eval sites after cleaning`);
    }

    // Per-FILE mode preservation from the previous tree (fall back to defaults
    // for new files).
    const prevMode = async (rel) => {
      try { const st = await stat(path.join(DIST, rel)); return st.mode & 0o777; } catch { return null; }
    };
    for (const rel of ["background/service-worker.js", "options.bundle.js", "shared/diff-core.bundle.js"]) {
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
    // only while dist/dist.complete exists. Lock owner, PID, wall-clock time,
    // stage path and version ID are invocation custody and MUST NOT enter this
    // production byte. The marker binds stable indexed source plus exact
    // generated output bytes and is therefore reproducible and verifiable.
    const sourceAfter = await computeIndexedSourceAuthority({ root: ROOT });
    if (
      sourceAfter.digest !== sourceBefore.digest ||
      sourceAfter.files !== sourceBefore.files
    ) {
      throw new Error(
        "indexed source changed during build — refusing to publish a mixed-generation dist",
      );
    }
    await writeDistCompleteMarker({
      root: ROOT,
      distRoot: STAGE,
      target: BUILD_TARGET,
    });
    await validateDistCompleteMarker({
      root: ROOT,
      distRoot: STAGE,
      expectedTarget: BUILD_TARGET,
    });

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
    // The dist is published and the marker validated — the build is a genuine
    // success from here. The changelog-delta print + version record are NOT
    // done here: they run AFTER the final fatal step (staging cleanup + lock
    // release) below, so a build that dies in a finalizer never records a
    // version (see shouldRecordBuild).
    buildSucceeded = true;
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

// Owner-requested build output: print the changelog delta since the last
// SUCCESSFUL build, then record THIS version for the next build. This runs
// after the FINAL fatal step (staging cleanup + lock release above): a build
// that died in a finalizer never records a version, so the next build's delta
// is always honest. Warn-only — this feature never fails the build.
if (shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })) {
  try {
    if (currentVersion) {
      if (!previousBuiltVersion) {
        // First build / fresh clone: one line, not the whole changelog.
        console.log(`First build at ${currentVersion} — no previous version recorded.`);
      } else {
        const parsed = currentChangelog ? parseChangelog(currentChangelog) : [];
        const delta = deltaBetween(parsed, previousBuiltVersion, currentVersion);
        if (delta.length > 0) {
          const rendered = renderDelta(delta);
          console.log(`\nNew since the last build (${previousBuiltVersion} → ${currentVersion}):\n${rendered}`);
        }
        // previous == current → silent (nothing new to say)
      }
      await writeLastBuiltVersion(BUILT_VERSION_PATH, currentVersion);
    }
  } catch (e) {
    console.error(`warning: changelog delta print failed (${e?.message ?? e}) — build itself is fine`);
  }
}
