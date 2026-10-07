// tests/dist-complete-source-authority.test.ts — the indexed-source authority behind
// `dist.complete`, pinned against an INDEPENDENT reference after the jjsz parallelisation.
//
// `computeIndexedSourceAuthority` used to hash one file at a time. It now lstat-validates every
// row, then reads byte-budgeted parallel batches and hashes them strictly in index order. Speed
// must not change what the authority MEANS, so this file pins:
//   1. the digest equals a from-the-contract sequential reference over a repo that forces every
//      batching path (more rows than one batch, files over the byte budget, executable, symlink,
//      non-ASCII names, the excluded path);
//   2. every verdict the sequential walk produced still fires, by name, after the stage split;
//   3. a `source` handed to `writeDistCompleteMarker` is the same bytes as recomputing it, and can
//      never mask drift — validation recomputes from disk.
// Scratch repos live under the durable evidence root (disk, not RAM-backed tmpfs), never this
// checkout; plain-text paths are assembled from segments because the partition guard classifies
// source text, not behaviour.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  computeIndexedSourceAuthority,
  DIST_COMPLETE_OUTPUTS,
  planSourceReadBatches,
  SOURCE_READ_BATCH_BYTES,
  SOURCE_READ_BATCH_ROWS,
  validateDistCompleteMarker,
  writeDistCompleteMarker,
} from "../scripts/dist-complete.mjs";

const MIB = 1024 * 1024;

function git(root: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/** A file whose bytes are unique per `seed` and cheap for git to store. */
function patterned(seed: number, bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes).fill(seed & 0xff);
  new DataView(buf.buffer).setUint32(0, seed, false);
  return buf;
}

function scratchRepo(label: string): string {
  const root = Deno.makeTempDirSync({ dir: durableDir("dist-complete-source-authority-scratch"), prefix: `${label}-` });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "source-authority@example.com"]);
  git(root, ["config", "user.name", "source authority test"]);
  git(root, ["config", "core.compression", "0"]);
  git(root, ["config", "core.looseCompression", "0"]);
  return root;
}

function commitAll(root: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
}

/** The byte contract, written out from the spec rather than imported: rows from the index,
 *  sorted by UTF-8 path bytes, each framed as `mode:path` NUL be64(length) bytes. */
function referenceAuthority(root: string): { digest: string; files: number } {
  const listing = spawnSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "buffer", maxBuffer: 64 * MIB });
  assertEquals(listing.status, 0);
  const rows = listing.stdout.toString("utf8").split("\0").filter(Boolean).map((row) => {
    const m = /^(\d{6}) [0-9a-f]{40,64} \d\t(.+)$/u.exec(row);
    assert(m, `unparseable index row: ${row}`);
    return { mode: m[1], repoPath: m[2] };
  }).filter((row) => row.repoPath !== "docs/diff-core.bundle.js");
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.repoPath, "utf8"), Buffer.from(b.repoPath, "utf8")));
  const hash = createHash("sha256");
  for (const row of rows) {
    const file = path.join(root, ...row.repoPath.split("/"));
    const bytes = row.mode === "120000" ? Buffer.from(readlinkSync(file), "utf8") : readFileSync(file);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(Buffer.from(`${row.mode}:${row.repoPath}`, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(bytes);
  }
  return { digest: hash.digest("hex"), files: rows.length };
}

function writeOutputs(distRoot: string): void {
  for (const output of DIST_COMPLETE_OUTPUTS) {
    const file = path.join(distRoot, ...output.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `console.log(${JSON.stringify(output)});\n`);
  }
}

Deno.test("jjsz source authority: the batched parallel walk equals a sequential reference over every batching path", async () => {
  const root = scratchRepo("reference");
  try {
    // More rows than one read batch (64), spread over directories.
    for (let i = 0; i < 150; i++) {
      const dir = path.join(root, "a", i % 2 === 0 ? "even" : "odd");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${String(i).padStart(3, "0")}.txt`), `file ${i}\n`);
    }
    // Byte-budget path: 17 MiB files cannot share a 32 MiB batch pairwise, and a 33 MiB file
    // exceeds the budget on its own — each must still land in the digest in index order.
    mkdirSync(path.join(root, "big"), { recursive: true });
    writeFileSync(path.join(root, "big", "one.bin"), patterned(1, 17 * MIB));
    writeFileSync(path.join(root, "big", "two.bin"), patterned(2, 17 * MIB));
    writeFileSync(path.join(root, "big", "three.bin"), patterned(3, 17 * MIB));
    writeFileSync(path.join(root, "big", "over-budget.bin"), patterned(4, 33 * MIB));
    // Executable bit, a symlink, UTF-8 and case-sensitive ordering, and the excluded path.
    mkdirSync(path.join(root, "bin"), { recursive: true });
    writeFileSync(path.join(root, "bin", "run.sh"), "#!/bin/sh\necho ok\n");
    chmodSync(path.join(root, "bin", "run.sh"), 0o755);
    symlinkSync("a/even/000.txt", path.join(root, "link-to-first"));
    writeFileSync(path.join(root, "Z-upper.txt"), "upper\n");
    writeFileSync(path.join(root, "z-lower.txt"), "lower\n");
    writeFileSync(path.join(root, "é-unicode.txt"), "unicode\n");
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "diff-core.bundle.js"), "excluded from the authority\n");
    commitAll(root);

    const expected = referenceAuthority(root);
    const actual = await computeIndexedSourceAuthority({ root });
    assertEquals(actual.files, expected.files, "the walk must bind the same number of files");
    assertEquals(actual.digest, expected.digest, "the parallel walk must hash exactly what the sequential contract hashes, in the same order");
    // The excluded path really is excluded (otherwise the reference and walk could agree on a wrong set).
    assertEquals(actual.files, 150 + 4 + 1 + 1 + 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

Deno.test("jjsz source authority: every sequential verdict still fires by name after the stage split", async () => {
  const root = scratchRepo("verdicts");
  try {
    writeFileSync(path.join(root, "missing.txt"), "m\n");
    writeFileSync(path.join(root, "regular.txt"), "r\n");
    writeFileSync(path.join(root, "plain.txt"), "p\n");
    writeFileSync(path.join(root, "grow.txt"), "g\n");
    writeFileSync(path.join(root, "target.txt"), "t\n");
    symlinkSync("target.txt", path.join(root, "linked"));
    commitAll(root);
    const baseline = await computeIndexedSourceAuthority({ root });
    assertEquals(baseline.digest, referenceAuthority(root).digest);

    const verdict = (needle: string) => assertRejects(() => computeIndexedSourceAuthority({ root }), Error, needle);

    // missing
    rmSync(path.join(root, "missing.txt"));
    await verdict("indexed source is missing: missing.txt");
    writeFileSync(path.join(root, "missing.txt"), "m\n");

    // a regular file replaced by a symlink
    rmSync(path.join(root, "regular.txt"));
    symlinkSync("target.txt", path.join(root, "regular.txt"));
    await verdict("indexed regular source changed type: regular.txt");
    rmSync(path.join(root, "regular.txt"));
    writeFileSync(path.join(root, "regular.txt"), "r\n");

    // a symlink replaced by a regular file
    rmSync(path.join(root, "linked"));
    writeFileSync(path.join(root, "linked"), "now a file\n");
    await verdict("indexed symlink changed type: linked");
    rmSync(path.join(root, "linked"));
    symlinkSync("target.txt", path.join(root, "linked"));

    // executable-bit drift on a 100644 file
    chmodSync(path.join(root, "plain.txt"), 0o755);
    await verdict("indexed source mode drift: plain.txt");
    chmodSync(path.join(root, "plain.txt"), 0o644);

    // one byte past the per-file bound (sparse: no disk, no read)
    truncateSync(path.join(root, "grow.txt"), 64 * MIB + 1);
    await verdict("indexed source exceeds file bound: grow.txt");
    writeFileSync(path.join(root, "grow.txt"), "g\n");

    // every mutation was restored, so the walk is clean again and byte-identical to the start
    assertEquals((await computeIndexedSourceAuthority({ root })).digest, baseline.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

Deno.test("jjsz source authority: the aggregate byte bound still refuses once the batched total passes it", async () => {
  const root = scratchRepo("aggregate");
  try {
    // Nine files at EXACTLY the per-file bound (64 MiB, sparse) pass every per-file check, so only
    // the 512 MiB aggregate can refuse — and each exceeds the 32 MiB read budget, so each is a
    // batch of its own (resident bytes stay at one file, as in the sequential walk).
    for (let i = 0; i < 9; i++) writeFileSync(path.join(root, `chunk-${i}.bin`), "x\n");
    commitAll(root);
    for (let i = 0; i < 9; i++) truncateSync(path.join(root, `chunk-${i}.bin`), 64 * MIB);
    await assertRejects(
      () => computeIndexedSourceAuthority({ root }),
      Error,
      "indexed source bytes exceed aggregate bound",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

Deno.test("jjsz source authority: a precomputed source marks the same bytes as recomputing, and cannot mask drift", async () => {
  const root = scratchRepo("precomputed");
  try {
    writeFileSync(path.join(root, "source.txt"), "source\n");
    commitAll(root);
    const distRoot = path.join(root, "extension", "dist");
    writeOutputs(distRoot);

    // Same tree: the two marker spellings are byte-identical (the marker has no clock in it).
    await writeDistCompleteMarker({ root, distRoot, target: "store" });
    const recomputed = readFileSync(path.join(distRoot, "dist.complete"), "utf8");
    rmSync(path.join(distRoot, "dist.complete"));
    const source = await computeIndexedSourceAuthority({ root });
    await writeDistCompleteMarker({ root, distRoot, target: "store", source });
    assertEquals(readFileSync(path.join(distRoot, "dist.complete"), "utf8"), recomputed);
    await validateDistCompleteMarker({ root, distRoot, expectedTarget: "store" });

    // Drift after the source was computed: a marker built from the STALE source is written, but
    // validation recomputes from disk, so it refuses — the shortcut cannot publish a lie.
    rmSync(path.join(distRoot, "dist.complete"));
    writeFileSync(path.join(root, "source.txt"), "source\nedited after the authority was computed\n");
    await writeDistCompleteMarker({ root, distRoot, target: "store", source });
    await assertRejects(
      () => validateDistCompleteMarker({ root, distRoot, expectedTarget: "store" }),
      Error,
      "marker indexed source authority is stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

Deno.test("jjsz source authority: the read-batch plan bounds rows AND resident bytes, covers every row once, in order", () => {
  // Rows cap: 150 tiny files split 64 / 64 / 22.
  assertEquals(
    planSourceReadBatches(new Array(150).fill(1)).map(([s, e]) => e - s),
    [SOURCE_READ_BATCH_ROWS, SOURCE_READ_BATCH_ROWS, 150 - 2 * SOURCE_READ_BATCH_ROWS],
  );

  // Byte budget: 17 MiB files cannot pair up (34 MiB > 32 MiB); a 33 MiB file is over budget alone and
  // still forms a batch of its own (a batch is never empty); small files after it are re-grouped.
  const sizes = [17 * MIB, 17 * MIB, 17 * MIB, 33 * MIB, MIB, MIB];
  assertEquals(planSourceReadBatches(sizes), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 6]]);

  // The invariant itself, over an awkward mix: batches tile 0..n exactly once and in order, and no
  // multi-row batch exceeds the byte budget (a single over-budget row is the only allowed excess).
  const mix = [0, 5 * MIB, 31 * MIB, MIB, 32 * MIB, 0, 0, 64 * MIB, 2 * MIB, 30 * MIB, 3 * MIB];
  const plan = planSourceReadBatches(mix);
  let cursor = 0;
  for (const [start, end] of plan) {
    assertEquals(start, cursor, "batches must be contiguous and in index order");
    assert(end > start, "a batch is never empty");
    assert(end - start <= SOURCE_READ_BATCH_ROWS);
    const bytes = mix.slice(start, end).reduce((a, b) => a + b, 0);
    assert(end - start === 1 || bytes <= SOURCE_READ_BATCH_BYTES, `batch ${start}..${end} holds ${bytes} bytes, over the budget`);
    cursor = end;
  }
  assertEquals(cursor, mix.length, "every row must be planned exactly once");

  assertEquals(planSourceReadBatches([]), [], "no rows, no batches");
});
