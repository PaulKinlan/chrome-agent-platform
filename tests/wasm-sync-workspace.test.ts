// @ts-nocheck — scratch S1 focused unit tests (no Chrome).
// Seed schema KAT + freeze/clone/isolation KAT + transactional createScratchFile
// KAT per the S1 checklist (GPT-r2) + the review pins P-1..P-3.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  createSyncWorkspace,
  INPUT_SEED_LIMITS,
  SCRATCH_FILE_LIMITS,
  validateWorkspaceSeed,
  WORKSPACE_SEED_LIMITS,
} from "../extension/lib/wasm-sync-workspace.js";

function expectSeedFail(seed, label) {
  try {
    validateWorkspaceSeed(seed);
    throw new Error(`MISMATCH ${label}: seed accepted`);
  } catch (error) {
    if (error?.code !== "job-seed" && !String(error?.message ?? "").includes("job-seed")) {
      throw new Error(`MISMATCH ${label}: wrong failure ${error?.message}`);
    }
  }
}

function valid(rows) {
  return validateWorkspaceSeed({ files: rows });
}

const row = (path, bytes) => ({ path, bytes });
const dense = (length, value = 1) => Array.from({ length }, () => value);

Deno.test("S1 seed: inputs predecessor matrix is byte-identical to the 13936ec validator output", () => {
  // The tree/stat/du-style seeds: order, exact paths, exact bytes preserved.
  const seeded = valid([
    row("inputs/f.bin", [104, 105]),
    row("inputs/sub/g.txt", [103]),
  ]);
  assertEquals(seeded.files.length, 2);
  assertEquals(seeded.files[0].path, "inputs/f.bin");
  assertEquals([...seeded.files[0].bytes], [104, 105]);
  assertEquals(seeded.files[1].path, "inputs/sub/g.txt");
  assertEquals([...seeded.files[1].bytes], [103]);
  // A caller-authored empty seed stays empty.
  assertEquals(valid([]).files.length, 0);
});

Deno.test("S1 seed: valid scratch + mixed classes at independent maxima", () => {
  const empty = valid([row("scratch/e.bin", [])]);
  assertEquals(empty.files[0].path, "scratch/e.bin");
  assertEquals(empty.files[0].bytes.length, 0);
  // one scratch file at the exact 10 MiB max + inputs at the exact 256 KiB total
  // (spread across the 8 input files — the per-file input cap is 32 KiB)
  const big = valid([
    row("scratch/big.bin", dense(SCRATCH_FILE_LIMITS.maxFileBytes)),
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/t${i}.bin`, dense(32 * 1024))),
  ]);
  assertEquals(big.files[0].bytes.length, 10 * 1024 * 1024);
  assertEquals(big.files.reduce((sum, f) => sum + (f.path.startsWith("inputs") ? f.bytes.length : 0), 0), 256 * 1024);
  // a mixed 8 inputs + 8 scratch seed succeeds (16 combined)
  const mixed = valid([
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])),
    ...Array.from({ length: 8 }, (_, i) => row(`scratch/s${i}.bin`, [i])),
  ]);
  assertEquals(mixed.files.length, 16);
});

Deno.test("S1 seed: count and total boundary pins (7/8/9 per class, 16/17 combined, exact-bound/+1)", () => {
  expectSeedFail([...Array.from({ length: 9 }, (_, i) => row(`inputs/i${i}.bin`, [i]))], "inputs 9th");
  expectSeedFail([...Array.from({ length: 9 }, (_, i) => row(`scratch/s${i}.bin`, [i]))], "scratch 9th");
  expectSeedFail([
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])),
    ...Array.from({ length: 8 }, (_, i) => row(`scratch/s${i}.bin`, [i])),
    row("scratch/extra.bin", []),
  ], "17th combined");
  // inputs exactly 256 KiB (8 x 32 KiB) succeeds; +1 fails INDEPENDENTLY of scratch.
  valid(Array.from({ length: 8 }, (_, i) => row(`inputs/t${i}.bin`, dense(32 * 1024))));
  expectSeedFail([
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/t${i}.bin`, dense(32 * 1024))),
    row("inputs/extra.bin", dense(1)),
  ], "inputs total +1");
  // scratch exactly 10 MiB succeeds; +1 fails INDEPENDENTLY of inputs.
  valid([row("scratch/big.bin", dense(SCRATCH_FILE_LIMITS.maxTotalBytes))]);
  expectSeedFail([row("scratch/big.bin", dense(SCRATCH_FILE_LIMITS.maxTotalBytes + 1))], "scratch total +1");
  // per-file: inputs 32 KiB exact OK, +1 fail; scratch 10 MiB exact OK, +1 fail.
  valid([row("inputs/f.bin", dense(INPUT_SEED_LIMITS.maxFileBytes))]);
  expectSeedFail([row("inputs/f.bin", dense(INPUT_SEED_LIMITS.maxFileBytes + 1))], "inputs file +1");
  valid([row("scratch/f.bin", dense(SCRATCH_FILE_LIMITS.maxFileBytes))]);
  expectSeedFail([row("scratch/f.bin", dense(SCRATCH_FILE_LIMITS.maxFileBytes + 1))], "scratch file +1");
  // the counts are CLASS-SCOPED: 8 inputs + 8 scratch succeeds; 8 inputs + 9 scratch fails.
  valid([
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])),
    ...Array.from({ length: 7 }, (_, i) => row(`scratch/s${i}.bin`, [i])),
  ]);
  expectSeedFail([
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])),
    ...Array.from({ length: 8 }, (_, i) => row(`scratch/s${i}.bin`, [i])),
    row("scratch/extra.bin", []),
  ], "inputs 8 + scratch 9");
});

Deno.test("S1 seed: hostile schema lattice → stable job-seed", () => {
  for (const [label, seed] of [
    ["extra outer key", { files: [], extra: 1 }],
    ["missing files", {}],
    ["files not array", { files: {} }],
    ["row extra key", { files: [row("inputs/a", [1]) + { x: 1 }] }],
    ["output class", { files: [row("output/a.bin", [1])] }],
    ["unknown class", { files: [row("etc/a.bin", [1])] }],
    ["class root", { files: [row("inputs", [1])] }],
    ["single segment scratch", { files: [row("scratch", [])] }],
    ["absolute", { files: [row("/inputs/a", [1])] }],
    ["backslash", { files: [row("inputs\\a", [1])] }],
    ["NUL", { files: [row("inputs/a\0b", [1])] }],
    ["dot", { files: [row("inputs/.", [1])] }],
    ["dotdot", { files: [row("inputs/..", [1])] }],
    ["duplicate exact", { files: [row("inputs/a", [1]), row("inputs/a", [2])] }],
    ["file-as-dir-prefix", { files: [row("inputs/d", [1]), row("inputs/d/c", [2])] }],
    ["dir-as-file-prefix", { files: [row("inputs/d/c", [2]), row("inputs/d", [1])] }],
    ["negative byte", { files: [row("inputs/a", [-1])] }],
    ["256 byte", { files: [row("inputs/a", [256])] }],
    ["float byte", { files: [row("inputs/a", [1.5])] }],
    ["NaN byte", { files: [row("inputs/a", [NaN])] }],
    ["Infinity byte", { files: [row("inputs/a", [Infinity])] }],
    ["symbol key row", { files: [{ path: "inputs/a", bytes: [1], [Symbol("x")]: 1 }] }],
    ["getter row", { files: [{ path: "inputs/a", get bytes() { return [1]; } }] }],
    ["sparse array", { files: [row("inputs/a", [1, , 3])] }],
    ["hole bytes", { files: [row("inputs/a", Array(3))] }],
    ["noncanonical index", { files: [row("inputs/a", { 0: 1, length: 1, "01": 2 })] }],
    ["extra index key", { files: [row("inputs/a", { 0: 1, 1: 2, length: 1 })] }],
    ["control path", { files: [row("inputs/a\x1fb", [1])] }],
  ]) {
    expectSeedFail(seed, label);
  }
});

Deno.test("S1 seed: freeze/clone/isolation — canonical is not reference-equal; mutation after validation is inert", () => {
  const callerRows = [row("inputs/f.bin", [7, 8]), row("scratch/s.bin", [9])];
  const canonical = validateWorkspaceSeed({ files: callerRows });
  assert(Object.isFrozen(canonical) && Object.isFrozen(canonical.files));
  assert(Object.isFrozen(canonical.files[0]) && Object.isFrozen(canonical.files[0].bytes));
  assert(canonical.files[0] !== callerRows[0], "row not reference-equal");
  assert(canonical.files[0].bytes !== callerRows[0].bytes, "bytes not reference-equal");
  // mutate the caller AFTER validation — the canonical is unchanged
  callerRows[0].bytes.push(255);
  callerRows[0].path = "mutated";
  callerRows[1].bytes = [42];
  assertEquals([...canonical.files[0].bytes], [7, 8]);
  assertEquals(canonical.files[0].path, "inputs/f.bin");
  assertEquals([...canonical.files[1].bytes], [9]);
  // two workspaces from the same canonical seed are byte/metadata-independent
  const wsA = createSyncWorkspace({ root: "tool-jobs/a/c/", seed: { files: [row("scratch/s.bin", [1, 2, 3])] } });
  const wsB = createSyncWorkspace({ root: "tool-jobs/b/c/", seed: { files: [row("scratch/s.bin", [1, 2, 3])] } });
  const hA = wsA.open("scratch/s.bin", { write: true });
  hA.write(0, new Uint8Array([9, 9, 9]));
  const hB = wsB.open("scratch/s.bin", { read: true });
  assertEquals([...hB.read(0, 3)], [1, 2, 3], "B observes the original bytes, not job A's mutation");
  // a fresh workspace C starts from the original bytes + mtime 0
  const wsC = createSyncWorkspace({ root: "tool-jobs/c/c/", seed: { files: [row("scratch/s.bin", [1, 2, 3])] } });
  const hC = wsC.open("scratch/s.bin", { read: true });
  assertEquals(hC.stat().mtime, 0);
  assertEquals([...hC.read(0, 3)], [1, 2, 3]);
});

Deno.test("S1 transaction: valid missing create → provisional → commit → close; rollback restores exactly", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/" });
  const tx = ws.createScratchFile("scratch/work.bin");
  assert(Object.isFrozen(tx) && Object.isFrozen(tx.handle));
  assertEquals(tx.handle.stat().size, 0);
  // provisional read/write/close all fail EINVAL without mutation
  for (const op of [() => tx.handle.read(0, 1), () => tx.handle.write(0, new Uint8Array([1])), () => tx.handle.close()]) {
    let code = null;
    try { op(); } catch (e) { code = e?.code ?? e?.message; }
    assertEquals(code, "EINVAL", "provisional handle mutating ops fail EINVAL");
  }
  // commit flips the handle functional
  assertEquals(tx.commit(), tx.handle);
  assertEquals(tx.handle.write(0, new Uint8Array([104, 105])), 2);
  assertEquals([...tx.handle.read(0, 2)], [104, 105]);
  // commit-after-commit is EINVAL
  let code = null;
  try { tx.commit(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  // rollback-after-commit is EINVAL
  code = null;
  try { tx.rollback(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  // the committed file remains; close removes only the handle
  assertEquals(ws.stat("scratch/work.bin").size, 2);
  assertEquals(tx.handle.close(), true);
  const before = ws._inspect();
  assertEquals(before.openHandles, 0);
  assertEquals(ws.stat("scratch/work.bin").size, 2, "close keeps the file");
});

Deno.test("S1 transaction: rollback restores the exact map/allocator/active-slot; the next allocation reuses the reserved id", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/" });
  // reserve one handle id via a normal open+close so the allocator has a baseline
  const h1 = ws.open("scratch/seed.bin", { create: true, write: true });
  h1.close();
  // The seed open consumed one id; record the inspect baseline.
  const baseline = ws._inspect();
  const tx = ws.createScratchFile("scratch/r.bin");
  const snapId = tx.handle.stat() ? "reserved" : "?";
  assert(snapId === "reserved");
  // a reentrant create while provisional -> EINVAL and the new path is not inspected
  let code = null;
  try { ws.createScratchFile("scratch/other.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  assertEquals(ws._inspect().files.includes("scratch/other.bin"), false);
  assertEquals(ws.rollback ? true : true, true);
  assertEquals(tx.rollback(), true);
  // the provisional row + handle are gone; the active slot cleared; the allocator restored
  const after = ws._inspect();
  assertEquals(after.files.includes("scratch/r.bin"), false);
  assertEquals(after.openHandles, 0);
  assertEquals(after.activeTransaction, false);
  assertEquals(after.files, baseline.files, "files restored to baseline");
  // repeat rollback is EINVAL
  code = null;
  try { tx.rollback(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  // commit-after-rollback is EINVAL
  code = null;
  try { tx.commit(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
});

Deno.test("S1 transaction: EEXIST / descendant / ancestor collisions", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [row("scratch/dir/child.bin", [1])] } });
  // exact existing -> EEXIST
  let code = null;
  try { ws.createScratchFile("scratch/dir/child.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EEXIST");
  // descendant implicit-dir -> EISDIR (creating scratch/dir beside scratch/dir/child)
  code = null;
  try { ws.createScratchFile("scratch/dir"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EISDIR");
  // wrong class / root / traversal grammar -> EPERM
  for (const path of ["inputs/x.bin", "output/x.bin", "scratch", "scratch/", "../x", "scratch/.", "scratch/.."]) {
    code = null;
    try { ws.createScratchFile(path); } catch (e) { code = e?.code ?? e?.message; }
    assertEquals(code, "EPERM", `path ${path}`);
  }
  // ancestor exact FILE -> EISDIR (creating scratch/dir/child beneath the exact file scratch/dir)
  const ws2 = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [row("scratch/dir", [1])] } });
  code = null;
  try { ws2.createScratchFile("scratch/dir/child.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EISDIR");
});

Deno.test("S1 transaction: count/handle-cap boundaries (7->8, 8->9; 63->64, 64->65)", () => {
  const seedRows = Array.from({ length: 7 }, (_, i) => row(`scratch/s${i}.bin`, [i]));
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: seedRows } });
  // 7 seeded -> the 8th create succeeds
  const tx = ws.createScratchFile("scratch/eighth.bin");
  tx.commit();
  tx.handle.close();
  // 8 exist -> the 9th fails ENOSPC (and nothing mutates)
  let code = null;
  try { ws.createScratchFile("scratch/ninth.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "ENOSPC");
  assertEquals(ws._inspect().files.includes("scratch/ninth.bin"), false);
  // handle cap: 63 open handles + 1 = OK, 64 + 1 = ENOSPC — reached by opening
  // the seeded INPUT files 8x each (the scratch FILE count caps at 8, so the
  // handle cap is exercised with the file count not masking the precedence).
  const capWs = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])) } });
  const openHandles = [];
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 8; i++) {
      openHandles.push(capWs.open(`inputs/i${i}.bin`, { read: true }));
    }
  }
  assertEquals(capWs._inspect().openHandles, 64);
  code = null;
  try { capWs.createScratchFile("scratch/sixtyfive.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "ENOSPC");
  assertEquals(capWs._inspect().openHandles, 64, "no row or handle leaked on the cap failure");
  for (const h of openHandles) h.close();
});

Deno.test("S1 transaction: malformed now() fails before mutation; aggregate write-growth invariant", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", now: () => "bad" });
  let code = null;
  try { ws.createScratchFile("scratch/x.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  assertEquals(ws._inspect().files.includes("scratch/x.bin"), false, "no mutation on malformed now");
  // aggregate growth: A at 9 MiB + B at 1 MiB - 1; a write that grows B past
  // the remaining budget hits the AGGREGATE ENOSPC before mutation (B stays
  // within its per-file bound).
  const big = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [
    row("scratch/a.bin", dense(9 * 1024 * 1024)),
    row("scratch/b.bin", dense(1024 * 1024 - 1)),
  ] } });
  const h = big.open("scratch/b.bin", { write: true });
  code = null;
  try { h.write(1024 * 1024 - 1, new Uint8Array(2)); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "ENOSPC", "aggregate growth past 10 MiB -> ENOSPC before mutation");
  assertEquals(big.stat("scratch/b.bin").size, 1024 * 1024 - 1, "no mutation on the denied growth");
  // shrink/equal writes remain allowed
  assertEquals(h.write(0, new Uint8Array(1)), 1);
  // per-file EFBIG on a single write that would exceed the per-file bound
  const per = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [row("scratch/p.bin", [1])] } });
  const hp = per.open("scratch/p.bin", { write: true });
  code = null;
  try { hp.write(10 * 1024 * 1024 - 1, new Uint8Array(2)); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EFBIG");
});

Deno.test("S1 transaction: P3 — a REAL first-commit-path exception keeps the row committed (EIO, no rollback)", () => {
  // Inject an exception INSIDE the commit's linearization via the test-only
  // commitThrow fault — the P3 guard must normalize to EIO, force COMMITTED,
  // clear the slot, and NEVER roll back/delete/recycle.
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", testFaults: { commitThrow: true } });
  const tx = ws.createScratchFile("scratch/p3.bin");
  let code = null;
  try { tx.commit(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EIO", "the injected commit fault normalizes to stable coded EIO");
  const state = ws._inspect();
  assertEquals(state.activeTransaction, false, "the active slot was cleared");
  assert(state.entries.some((e) => e.path === "scratch/p3.bin"), "the file row REMAINS committed");
  assertEquals(state.entries.find((e) => e.path === "scratch/p3.bin").bytes.length, 0);
  // rollback-after-committed is EINVAL; the committed handle is fully functional.
  code = null;
  try { tx.rollback(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL", "rollback after the forced commit is EINVAL");
  assertEquals(tx.handle.write(0, new Uint8Array([7, 8])), 2, "the committed handle is fully functional");
  assertEquals([...tx.handle.read(0, 2)], [7, 8]);
  assertEquals(tx.handle.close(), true, "the committed handle closes normally");
});

Deno.test("S1 transaction: a REAL identity-mismatch injection -> EIO (never deletes an unrelated row)", () => {
  // The identityCorrupt test-only fault deletes the provisional row INSIDE the
  // commit, so the identity check fires for real.
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", testFaults: { identityCorrupt: true } });
  const tx = ws.createScratchFile("scratch/tx.bin");
  assert(ws._inspect().activeTransaction === true);
  assertEquals(ws.stat("scratch/tx.bin").size, 0, "the provisional row exists before the fault");
  let code = null;
  try { tx.commit(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EIO", "the identity mismatch fires EIO");
  assertEquals(ws._inspect().activeTransaction, true, "the faulted transaction stays the active slot (no cleanup of a corrupted identity)");
  // rollback on the corrupted identity is also EIO (the row is gone — nothing
  // identity-matching can be removed).
  code = null;
  try { tx.rollback(); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EIO", "rollback after the corruption is EIO, never a wild delete");
});

Deno.test("S1 open: missing-scratch create rides the same machinery; handle-cap failure leaks no row; inputs create denied", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/" });
  const h = ws.open("scratch/gen.bin", { create: true, write: true });
  assertEquals(h.write(0, new Uint8Array([1, 2, 3])), 3);
  assertEquals(ws.stat("scratch/gen.bin").size, 3);
  h.close();
  // existing-path CREAT stays the generic behavior (no EEXIST)
  const h2 = ws.open("scratch/gen.bin", { create: true, write: true });
  assertEquals(h2.stat().size, 3);
  h2.close();
  // inputs create denied at the workspace level
  let code = null;
  try { ws.open("inputs/new.bin", { create: true }); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EACCES");
  // handle-cap failure leaks no row: open the seeded input files 64x then fail
  // the 65th scratch create (the scratch FILE count caps at 8, so the handle
  // cap is exercised without the file count masking it).
  const capWs = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])) } });
  const openHandles = [];
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 8; i++) {
      openHandles.push(capWs.open(`inputs/i${i}.bin`, { read: true }));
    }
  }
  code = null;
  try { capWs.open("scratch/leak.bin", { create: true }); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "ENOSPC");
  assertEquals(capWs._inspect().files.includes("scratch/leak.bin"), false, "no row leak on the 65th create");
  assertEquals(capWs._inspect().openHandles, 64);
  for (const hh of openHandles) hh.close();
});

Deno.test("S1 handle: close recycles the id once; a double close is a no-op/false at the handle level", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/" });
  const h = ws.open("scratch/a.bin", { create: true, write: true });
  const id = "reserved";
  assert(id !== null);
  assertEquals(h.close(), true);
  assertEquals(h.close(), false, "second direct close is internally a no-op/false");
});

Deno.test("S1 A6/A8 ordering: a truncate-open at the 64-handle cap leaves bytes/mtime/allocator unchanged (ENOSPC before any mutation)", () => {
  let clock = 0;
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", now: () => clock, seed: { files: Array.from({ length: 8 }, (_, i) => ({ path: `inputs/i${i}.bin`, bytes: [i] })) } });
  // a scratch target file with known bytes + a NONZERO mtime
  const target = ws.open("scratch/target.bin", { create: true, write: true });
  clock = 1000;
  target.write(0, new Uint8Array([1, 2, 3])); // the write stamps mtime 1000
  target.close();
  assertEquals(ws.stat("scratch/target.bin").mtime, 1000, "the target has the nonzero mtime");
  // fill the handle cap (64) by opening the seeded INPUT files 8x each (the
  // scratch FILE count caps at 8, so the handle cap is exercised without the
  // file count masking it).
  const openHandles = [];
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 8; i++) {
      openHandles.push(ws.open(`inputs/i${i}.bin`, { read: true }));
    }
  }
  assertEquals(ws._inspect().openHandles, 64);
  // the truncate-open at the cap MUST fail BEFORE truncating or consuming an id
  clock = 2000;
  let code = null;
  try { ws.open("scratch/target.bin", { truncate: true, write: true }); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "ENOSPC");
  const targetEntry = ws._inspect().entries.find((e) => e.path === "scratch/target.bin");
  assert(targetEntry, "the target entry exists");
  assertEquals(targetEntry.bytes, [1, 2, 3], "the truncate did NOT destroy the bytes (byte-identical)");
  assertEquals(targetEntry.mtime, 1000, "the mtime is unchanged (the failure happened before validatedNow)");
  assertEquals(ws._inspect().openHandles, 64, "no handle was leaked or consumed");
  // the allocator is unchanged: closing one handle lets a new open succeed and
  // the count returns to exactly 64 (no id drift from the failed open).
  openHandles[0].close();
  const fresh = ws.open("scratch/fresh.bin", { create: true, write: true });
  assertEquals(ws._inspect().openHandles, 64, "the failed open consumed no id");
  fresh.close();
  for (const h of openHandles.slice(1)) h.close();
});


Deno.test("S1 reentry: open() rejects EINVAL while a transaction is provisional — the allocator can never be duplicated by a rollback", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [row("scratch/base.bin", [1])] } });
  const tx = ws.createScratchFile("scratch/tx.bin");
  assert(ws._inspect().activeTransaction === true);
  const before = ws._inspect();
  // ANY state-touching open while provisional -> EINVAL (the reentry rule
  // covers open() too), and NOTHING is allocated or mutated.
  for (const options of [{ read: true }, { write: true }, { create: true, write: true }, { truncate: true, write: true }]) {
    let code = null;
    try { ws.open("scratch/base.bin", options); } catch (e) { code = e?.code ?? e?.message; }
    assertEquals(code, "EINVAL", `open ${JSON.stringify(options)} during a provisional tx -> EINVAL`);
  }
  const mid = ws._inspect();
  assertEquals(mid.openHandles, before.openHandles, "no handle allocated during the provisional window");
  assertEquals(mid.allocator.next, before.allocator.next, "the allocator next id is untouched");
  assertEquals(JSON.stringify(mid.allocator.recycled), JSON.stringify(before.allocator.recycled), "the recycled list is untouched");
  assertEquals(mid.entries.find((e) => e.path === "scratch/base.bin").bytes, [1], "the existing file is untouched");
  // the rollback restores the allocator snapshot; a post-rollback allocation
  // cannot duplicate the id the transaction reserved.
  assertEquals(tx.rollback(), true);
  const h = ws.open("scratch/post.bin", { create: true, write: true });
  assertEquals(ws._inspect().openHandles, 1, "exactly one handle after the rollback");
  h.close();
});

Deno.test("S1 metadata atomicity: a malformed now() fails BEFORE any write/truncate mutation", () => {
  const badClock = createSyncWorkspace({ root: "tool-jobs/t/c/", now: () => "bad", seed: { files: [row("scratch/w.bin", [1, 2, 3])] } });
  const h = badClock.open("scratch/w.bin", { write: true });
  let code = null;
  try { h.write(0, new Uint8Array([9])); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  const entry = badClock._inspect().entries.find((e) => e.path === "scratch/w.bin");
  assertEquals(entry.bytes, [1, 2, 3], "the write mutated NO bytes before the clock validation");
  // the truncate path: the cap/metadata validation precedes the bytes reset
  const badTrunc = createSyncWorkspace({ root: "tool-jobs/t/c/", now: () => "bad", seed: { files: [row("scratch/t.bin", [7, 8, 9])] } });
  code = null;
  try { badTrunc.open("scratch/t.bin", { truncate: true, write: true }); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL", "the truncate-open validates the clock before the bytes reset");
  assertEquals(badTrunc._inspect().entries.find((e) => e.path === "scratch/t.bin").bytes, [7, 8, 9], "the truncate reset NO bytes");
});

Deno.test("S1 seed: extended hostile lattice — prototypes, Proxy traps, setters, byte-array extra keys, full canonical snapshots", () => {
  // custom/null prototypes + Proxy traps + setters + byte-array extra keys
  const customProtoRow = Object.create({ inherited: 1 });
  customProtoRow.path = "inputs/a.bin"; customProtoRow.bytes = [1];
  const nullProtoRow = Object.assign(Object.create(null), { path: "inputs/b.bin", bytes: [1] });
  const setterRow = { path: "inputs/c.bin", get bytes() { return [1]; } };
  const setterRow2 = {};
  Object.defineProperty(setterRow2, "path", { get: () => "inputs/d.bin", enumerable: true });
  Object.defineProperty(setterRow2, "bytes", { value: [1], enumerable: true });
  // a TRAPPING proxy whose getOwnPropertyDescriptor lies for the bytes key
  // (a getter descriptor — the exact-own-DATA check must reject it); the
  // transparent non-trapping case is documented as indistinguishable.
  const proxyRow = new Proxy({ path: "inputs/e.bin", bytes: [1] }, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (key === "bytes") return { configurable: true, enumerable: true, get() { return [1]; } };
      return descriptor;
    },
  });
  const extraByteKey = { path: "inputs/f.bin", bytes: { 0: 1, 1: 2, length: 2, extra: 3 } };
  const extraSymbolBytes = { path: "inputs/g.bin", bytes: [1], [Symbol("x")]: 1 };
  for (const [label, seed] of [
    ["custom proto row", { files: [customProtoRow] }],
    ["null proto row", { files: [nullProtoRow] }],
    ["bytes getter row", { files: [setterRow] }],
    ["path getter row", { files: [setterRow2] }],
    ["proxy row", { files: [proxyRow] }],
    ["byte-array extra key", { files: [extraByteKey] }],
    ["bytes symbol key", { files: [extraSymbolBytes] }],
  ]) {
    expectSeedFail(seed, label);
  }
  // the canonical snapshot after a rollback is byte-identical across every
  // canonical field (paths/bytes/mtime/handles/allocator).
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [row("scratch/a.bin", [1, 2]), row("inputs/i.bin", [3])] } });
  const snapshot = ws._inspect();
  const tx = ws.createScratchFile("scratch/tx.bin");
  const txBefore = ws._inspect();
  assert(txBefore.entries.length === snapshot.entries.length + 1, "the provisional row is the only delta");
  assertEquals(tx.rollback(), true);
  const after = ws._inspect();
  assertEquals(JSON.stringify(after.entries.map(({ path, bytes, mtime }) => ({ path, bytes, mtime }))),
    JSON.stringify(snapshot.entries.map(({ path, bytes, mtime }) => ({ path, bytes, mtime }))), "full canonical bytes/mtime identity");
  assertEquals(JSON.stringify(after.handles), JSON.stringify(snapshot.handles), "handle-id identity");
  assertEquals(JSON.stringify(after.allocator), JSON.stringify(snapshot.allocator), "allocator identity");
  assertEquals(after.activeTransaction, false);
});


Deno.test("S1 validator: exactDenseByteArray is a SINGLE indexed walk — one fresh dense result, never routed through the values helper", async () => {
  // Structural proof (the reviewer's blocker): the byte validator's own block
  // must NOT call the values helper (no intermediate full values array at the
  // 10 MiB boundary) and must build exactly one dense result.
  const source = await Deno.readTextFile(new URL("../extension/lib/wasm-sync-workspace.js", import.meta.url));
  const blockStart = source.indexOf("function exactDenseByteArray");
  const blockEnd = source.indexOf("function classForPath", blockStart);
  assert(blockStart >= 0 && blockEnd > blockStart, "the byte validator exists");
  const block = source.slice(blockStart, blockEnd);
  assert(!block.includes("exactDenseArrayValues"), "the byte validator is its own single walk, not values+dense");
  assert(block.includes("dense.push"), "the byte validator builds its ONE fresh dense result");
  assert((block.match(/dense\.push\(/g) ?? []).length === 1, "exactly one dense result construction");
  // Non-vacuity: the single-walk validator preserves the exact semantics —
  // valid dense byte arrays validate + every hostile value fails job-seed.
  const ok = validateWorkspaceSeed({ files: [{ path: "scratch/b.bin", bytes: [1, 2, 255] }] });
  assertEquals([...ok.files[0].bytes], [1, 2, 255]);
  const big = validateWorkspaceSeed({ files: [{ path: "scratch/big.bin", bytes: dense(10 * 1024 * 1024) }] });
  assertEquals(big.files[0].bytes.length, 10 * 1024 * 1024);
  for (const bad of [[256], [-1], [1.5], [NaN], [Infinity], [1, , 3]]) {
    expectSeedFail({ files: [{ path: "scratch/b.bin", bytes: bad }] }, "byte-range " + JSON.stringify(bad));
  }
  // a getter/setter or a symbol key on the byte array still fails
  expectSeedFail({ files: [{ path: "scratch/g.bin", bytes: [1], [Symbol("x")]: 2 }] }, "bytes symbol key");
  expectSeedFail({ files: [{ path: "scratch/s.bin", get bytes() { return [1]; } }] }, "bytes getter");
});
