#!/usr/bin/env node
// cap-evidence/b0ld8-gc-grace-harness.mjs — chrome-agent-platform-b0ld8.
//
// WHAT THIS MEASURES, AND WHY IT EXISTS
//
// build.mjs publishes by creating `extension/dist-versions/v-<pid>-<ts>`, atomically swapping the
// `extension/dist` symlink to it, then (only when a PRIOR version exists) waiting `gcGraceMs` and
// `rm -rf`-ing every other version directory. The wait is the whole point: a reader that resolved
// the OLD target through the symlink just before the swap is still reading files INSIDE it, and
// removing that tree underneath it turns those reads into ENOENT.
//
// The grace was a fixed, guessed 2000 ms; jjsz cut the default to a guessed 50 ms. 2000 ms cost
// about half of a warm `build:production`, so the number matters — but nobody had measured the thing
// it exists to cover: HOW LONG A REAL READER'S BURST LASTS after it has resolved the target. That is
// what this harness measures, and then it measures the race directly against the real sequence.
//
// Faithfulness notes, because a harness that measures the wrong thing is worse than none:
//   * The sandbox mirrors the real `extension/dist` (28 files, ~19 MB); --mirror copies the real tree.
//   * The publish order is IDENTICAL to build.mjs: symlink next -> atomic rename -> readdir ->
//     [grace] -> rm -rf every other version directory.
//   * Every reader PINS the old target BEFORE the swap, and that pin is asserted, so a reader can
//     never trivially "pass" by resolving the NEW tree after the swap. That was the first version's
//     bug: it re-resolved inside the reader and under-counted failures.
//   * Grace 0 is the positive control for the race: if it does NOT lose readers, the harness is not
//     measuring the race at all and the whole table is meaningless.
//
// Usage:
//   node cap-evidence/b0ld8-gc-grace-harness.mjs [--mirror] [--trials=N] [--readers=N] [--load] [--json]
//
// This is a probe, not a gate: it reports, it does not assert. The default it justifies is pinned
// behaviourally by tests/build-concurrency.test.ts.

import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_DIST = path.join(ROOT, "extension", "dist");

const flags = new Set(process.argv.slice(2));
const num = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const MIRROR = flags.has("--mirror");
const JSON_OUT = flags.has("--json");
const LOAD = flags.has("--load");
const LOAD_HARD_STOP_MS = 120_000;
const TRIALS = num("trials", 3);
const READERS = num("readers", 2);

// The real bundle sizes, largest first: 28 files totalling ~19 MB.
const REAL_SIZES = [6_000_000, 4_000_000, 3_000_000, 2_000_000, 1_500_000, 1_000_000, 600_000, 400_000];
const REL_FOR = (i) =>
  i % 3 === 0 ? path.join("chunks", `chunk-${i}.js`)
  : i % 3 === 1 ? path.join("background", `bg-${i}.js`)
  : `file-${i}.js`;

async function cloneShape(dir) {
  await mkdir(path.join(dir, "chunks"), { recursive: true });
  await mkdir(path.join(dir, "background"), { recursive: true });
  for (let i = 0; i < 28; i++) {
    const size = i < REAL_SIZES.length ? REAL_SIZES[i] : 120_000;
    await writeFile(path.join(dir, REL_FOR(i)), Buffer.alloc(size, 0x41 + (i % 20)));
  }
}

// NOTE (b0ld8): rel is taken against the ROOT, not the current recursion dir. Taking it against
// `dir` drops the chunks//background/ prefix, and every reader then ENOENTs on a path that never
// existed - which made EVERY grace, including 2000ms, look like a lost tree. That is the vacuous
// table this probe exists to avoid, so the root is threaded explicitly.
async function walk(dir, root = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, root)));
    else out.push({ rel: path.relative(root, full), size: (await stat(full)).size });
  }
  return out;
}

async function makeSandbox() {
  const root = await mkdtemp(path.join(durableDir("scratch"), "b0ld8-gc-"));
  const versions = path.join(root, "dist-versions");
  await mkdir(versions, { recursive: true });
  const oldDir = path.join(versions, "v-old-1-1000");
  const newDir = path.join(versions, "v-new-2-2000");
  if (MIRROR) await cp(REAL_DIST, oldDir, { recursive: true, dereference: true });
  else await cloneShape(oldDir);
  await mkdir(newDir, { recursive: true });
  await writeFile(path.join(newDir, "dist.complete"), "new");
  const dist = path.join(root, "dist");
  await symlink(path.relative(root, oldDir), dist); // exactly build.mjs's shape: relative link
  const files = await walk(oldDir);
  return { root, versions, oldDir, newDir, dist, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

// ------------------------------------------------------------------ readers
// Every reader does its whole burst against an ALREADY-PINNED directory, so the tree it reads is
// unambiguously the one the GC is about to delete.

const KINDS = {
  // collectPackageInventory's shape: hash every file in the resolved tree.
  async "hash-tree"(dir, files) {
    const h = createHash("sha256");
    for (const f of files) {
      await new Promise((res, rej) => {
        const s = createReadStream(path.join(dir, f.rel));
        s.on("data", (c) => h.update(c));
        s.on("error", rej);
        s.on("end", res);
      });
    }
    return h.digest("hex");
  },
  // copy-built-tree.mjs's shape (cp -rL): read the whole tree out to a destination.
  async "copy-tree"(dir, files, dest) {
    for (const f of files) {
      const to = path.join(dest, f.rel);
      await mkdir(path.dirname(to), { recursive: true });
      await cp(path.join(dir, f.rel), to);
    }
  },
  // A focused test reading a couple of bundles.
  async "single-file"(dir, files) {
    await readFile(path.join(dir, files[0].rel));
    await readFile(path.join(dir, files[files.length - 1].rel));
  },
};

/** Run one reader burst against `dir`; report errors and how long the burst took. */
async function burst(kind, dir, files, dest) {
  const t0 = performance.now();
  const errors = [];
  try {
    await KINDS[kind](dir, files, dest);
  } catch (e) {
    errors.push(`${e?.code ?? ""} ${e?.message ?? e}`.trim());
    // A probe that silently counts failures cannot be debugged (b0ld8): show the first one on demand.
    if (process.env.B0LD8_DEBUG) console.error(`[reader:${kind}] ${errors[0]}`);
  }
  return { errors, elapsed: Math.round((performance.now() - t0) * 100) / 100 };
}

// ---------------------------------------------------------------- publisher
// EXACTLY build.mjs's order.

async function publishAndGc({ versions, newDir, root, dist }, graceMs) {
  const next = path.join(root, `.dist-link-next-${process.pid}-${Date.now()}`);
  await rm(next, { force: true }).catch(() => {});
  await symlink(path.relative(root, newDir), next);
  await rename(next, dist); // THE atomic swap
  const entries = await readdir(versions, { withFileTypes: true });
  const hasPrior = entries.some((d) => d.isDirectory() && path.join(versions, d.name) !== newDir);
  if (hasPrior && graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const full = path.join(versions, d.name);
    if (full !== newDir) await rm(full, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- sweep

async function sweep(box, kind, graces) {
  const rows = [];
  for (const graceMs of graces) {
    let failed = 0, total = 0, mispinned = 0;
    const bursts = [];
    for (let t = 0; t < TRIALS; t++) {
      // Rebuild a fresh old tree and pointer for each trial (the previous GC removed it).
      await rm(box.oldDir, { recursive: true, force: true });
      if (MIRROR) await cp(REAL_DIST, box.oldDir, { recursive: true, dereference: true });
      else await cloneShape(box.oldDir);
      await rm(box.dist, { force: true });
      await symlink(path.relative(box.root, box.oldDir), box.dist);

      const dests = [];
      for (let r = 0; r < READERS; r++) {
        const d = path.join(box.root, `copy-${t}-${r}`);
        await mkdir(d, { recursive: true });
        dests.push(d);
      }

      // 1. PIN the old target BEFORE the swap, and ASSERT the pin is the old tree. Without this the
      //    measurement can silently degrade to "readers resolved the new tree and nothing raced".
      const pinned = await Promise.all(Array.from({ length: READERS }, () => realpath(box.dist)));
      for (const p of pinned) if (p !== box.oldDir) mispinned++;

      // 2. Start every burst against the pinned old tree.
      const work = pinned.map((p, r) => burst(kind, p, box.files, dests[r]));

      // 3. Let the bursts get going, then swap + GC at the worst moment.
      await new Promise((r) => setTimeout(r, 2));
      await publishAndGc(box, graceMs);

      for (const s of await Promise.all(work)) {
        total++;
        if (s.errors.length > 0) failed++;
        bursts.push(s.elapsed);
      }
      for (const d of dests) await rm(d, { recursive: true, force: true });
    }
    bursts.sort((a, b) => a - b);
    rows.push({
      graceMs,
      readers: total,
      failed,
      mispinned,
      burstMs: { min: bursts[0], median: bursts[Math.floor(bursts.length / 2)], max: bursts[bursts.length - 1] },
    });
  }
  return rows;
}

// A genuinely loaded box, not a pretend one: in-process setInterval callbacks all share the single
// event loop, so the earlier version of this was worth about ONE core. These are child processes, one
// per core minus two (leaving room for the harness), and each SELF-TERMINATES after its hard deadline
// so a SIGKILLed parent can never leave an orphan for the reaper to find.
let loadChildren = [];
function startLoad() {
  const cpus = os.cpus().length;
  const workers = Math.max(1, cpus - 2);
  const busy = `const end=Date.now()+${LOAD_HARD_STOP_MS}; while (Date.now()<end) {}`;
  for (let i = 0; i < workers; i++) {
    loadChildren.push(spawn(process.execPath, ["-e", busy], { stdio: "ignore" }));
  }
  console.error(`load: ${workers} busy child processes on ${cpus} cpus (self-terminating at ${LOAD_HARD_STOP_MS}ms)`);
  const reap = () => {
    for (const c of loadChildren) {
      try { c.kill("SIGKILL"); } catch { /* already gone */ }
    }
    loadChildren = [];
  };
  process.on("exit", reap);
  return reap;
}

async function main() {
  const box = await makeSandbox();
  const stopLoad = LOAD ? startLoad() : null;
  const graces = [0, 10, 25, 50, 100, 200, 500, 2000];
  const out = {
    bead: "chrome-agent-platform-b0ld8",
    mirror: MIRROR, load: LOAD, cpus: os.cpus().length,
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    sandbox: { files: box.files.length, bytes: box.bytes },
    trials: TRIALS, readersPerTrial: READERS,
    sweeps: {},
  };
  for (const kind of Object.keys(KINDS)) out.sweeps[kind] = await sweep(box, kind, graces);
  // A kind that is already safe at grace 0 (the single-file reader: it wins the race outright) must
  // report 0, not the next grace in the table. The earlier `&& r.graceMs > 0` excluded that row, so
  // the summary printed 10 ms for a reader its own rows show never failing - chrome-agent-platform-m7tfe.
  out.smallestSafeGraceMs = Object.fromEntries(
    Object.entries(out.sweeps).map(([k, rows]) => [k, rows.find((r) => r.failed === 0)?.graceMs ?? null]),
  );
  if (stopLoad) stopLoad();
  await rm(box.root, { recursive: true, force: true });

  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  console.log(`sandbox: ${out.sandbox.files} files, ${(out.sandbox.bytes / 1e6).toFixed(1)} MB` +
    `${MIRROR ? " (real extension/dist)" : " (synthesized to the real shape)"}`);
  console.log(`host: ${out.cpus} cpus, load ${out.loadAvg.join(" / ")}, --load=${LOAD}`);
  for (const [kind, rows] of Object.entries(out.sweeps)) {
    console.log(`\n${kind}:`);
    for (const r of rows) {
      console.log(`  grace ${String(r.graceMs).padStart(4)}ms -> ${r.failed}/${r.readers} readers lost the tree` +
        ` (mispinned ${r.mispinned})   burst min/med/max ${r.burstMs.min}/${r.burstMs.median}/${r.burstMs.max} ms`);
    }
    console.log(`  smallest grace with ZERO failures: ${out.smallestSafeGraceMs[kind]} ms`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
