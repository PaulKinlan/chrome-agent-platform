// tests/kat-finalizer-guards.test.ts — the guards of scripts/lib/kat-finalizer.ts
// that the committed suite did not pin.
//
// Every test here exists because a MUTATION of one guard survived the whole
// selected suite (`npm run test:changed`) on origin/main @ ea037b90, and a
// divergence probe then proved the mutation is NOT equivalent: pristine goes
// RED where the mutant goes GREEN. The mutation sweep, the mutants, the probe
// harness and the adjudication table are in cap-evidence/finalizer-sweep/.
//
// Deliberately a SEPARATE file from tests/kat-bistro-finalizer.test.ts so it
// cannot collide with the in-flight qml6 candidate, which edits that file.
//
// These tests execute the PRODUCTION exports with injected I/O seams (the 3yfs
// rule: never a simulated evaluator), except the allocator and poison-stat
// tests, which run against the REAL Deno filesystem because the guard under
// test IS the production default seam.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { allocateRunEvidenceDir, finalizeKatExecution, sanitizeKatLogError, teardownChromeAndProfile } from "../scripts/lib/kat-finalizer.ts";

// Real-filesystem scratch goes under the DURABLE root, never tmpfs (bead chp;
// tests/durable-root.test.ts statically guards /tmp evidence literals).
const scratch = () => mkdtemp(join(durableDir("scratch") + "/", "cap-finalizer-guards-"));

const REPORT = {
  expected: "head-1",
  head: "head-1",
  tree: "tree-1",
  dirty: false,
  mainWorldSha256: "mw-1",
  url: "https://example.com/",
  browserVersion: "test",
  lockWaitMs: 0,
  outDir: "/mock/out",
};
const RESULT = "/mock/out/result.json";

/** Minimal seams: everything succeeds unless a test overrides it. */
function seams() {
  const calls = [];
  const exits = [];
  const infos = [];
  const errors = [];
  let payload = "";
  const s = {
    stageReport: async (path, p) => { calls.push(`stage:${path}`); payload = p; return { dev: 1, ino: 42, size: p.length }; },
    readReportFile: async (path) => { calls.push(`readback:${path}`); return payload; },
    renameReportFile: async (from, to) => { calls.push(`rename:${from}->${to}`); },
    statReportFile: async (path) => { calls.push(`stat:${path}`); return { dev: 1, ino: 42, size: payload.length }; },
    syncReportDir: async (dir) => { calls.push(`syncdir:${dir}`); },
    writeTextFile: async () => {},
    removeReportFile: async () => {},
  };
  return {
    calls, exits, infos, errors, s,
    payload: () => payload,
    setPayload: (p) => { payload = p; },
  };
}

function finalize(k, over = {}) {
  return finalizeKatExecution({
    runError: null,
    checks: [{ name: "c1", passed: true }],
    teardown: {
      cdp: null, chrome: null, profilePath: null,
      poisonPath: "/mock/out/no-poison",
      withTimeout: (p) => p,
      statFile: async () => false,
      ...(over.teardown || {}),
    },
    report: REPORT,
    writeTextFile: over.writeTextFile ?? k.s.writeTextFile,
    stageReport: k.s.stageReport,
    readReportFile: k.s.readReportFile,
    renameReportFile: k.s.renameReportFile,
    statReportFile: k.s.statReportFile,
    syncReportDir: k.s.syncReportDir,
    removeReportFile: k.s.removeReportFile,
    exit: (c) => k.exits.push(c),
    logError: (...p) => k.errors.push(p.map(String).join(" ")),
    logInfo: (...p) => k.infos.push(p.map(String).join(" ")),
  });
}

// ── (a) the staged readback is BYTE-exact, not length-exact ──────────────────
// Mutant C2 (`stagedBack.length !== payload.length`) survived the suite: a
// staged temp whose bytes were corrupted WITHOUT changing length published a
// GREEN receipt. Divergence: pristine RED, mutant GREEN + receipt announced.
Deno.test("kat-finalizer guards: a staged temp that reads back the SAME LENGTH but different bytes is RED (C2)", async () => {
  const k = seams();
  k.s.readReportFile = async (path) => {
    k.calls.push(`readback:${path}`);
    if (!path.endsWith("/result.json")) {
      // same length, different bytes — a bit flip inside the staged receipt
      const p = k.payload();
      return p.replace('"head": "head-1"', '"head": "HEAD-2"').padEnd(p.length, " ").slice(0, p.length);
    }
    return k.payload();
  };
  const r = await finalize(k);
  assertEquals(k.payload().length, (await k.s.readReportFile("/mock/out/x.tmp")).length, "the corruption must be length-preserving or this test proves nothing");
  assertEquals(r.state, "RED", "a length-only readback check would publish these bytes as GREEN");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null);
  assert(String(r.reportError).includes("result_stage_readback_mismatch"));
});

// ── (b) contradictory bytes at the rejection read are CORRUPTION ─────────────
// Mutant E2 dropped the re-throw, so a positive byte MISMATCH fell through to
// the inode path. Divergence: pristine RED, mutant GREEN + announced, while
// logging "reconciled to committed" for a file whose bytes contradict ours.
Deno.test("kat-finalizer guards: a rejected rename whose (b) read returns CONTRADICTORY bytes stays corruption even when the later read matches and the inode is identical (E2)", async () => {
  const k = seams();
  let reads = 0;
  k.s.renameReportFile = async () => { throw new Error("EXDEV: rename rejected"); };
  k.s.readReportFile = async (path) => {
    k.calls.push(`readback:${path}`);
    if (path === RESULT) {
      reads++;
      // contradictory at (b); a concurrent writer "fixes" it by (d)
      return reads === 1 ? '{"contradictory":true}\n' : k.payload();
    }
    return k.payload();
  };
  k.s.statReportFile = async () => ({ dev: 1, ino: 42, size: k.payload().length }); // FULLY matching
  const r = await finalize(k);
  assertEquals(r.state, "RED", "contradictory bytes are corruption — the inode is NEVER consulted, not even a fully matching one");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null);
  assert(String(r.reportError).includes("result_publish_readback_mismatch"));
  assert(!k.errors.some((l) => /reconciled to committed/i.test(l)), "nothing may claim a reconciliation that never happened");
});

// ── (b) a NULL identity never authorizes ─────────────────────────────────────
// Mutant E6 dropped the both-sides-non-null precondition, so null === null
// ACKed a rejected rename. E7 reduced the ACK to size alone. Divergence:
// pristine RED, both mutants GREEN + announced.
Deno.test("kat-finalizer guards: a NULL staged identity never ACKs a rejected rename, even when the later read matches byte-for-byte (E6/E7)", async () => {
  const k = seams();
  let reads = 0;
  k.s.stageReport = async (path, p) => { k.calls.push(`stage:${path}`); k.setPayload(p); return { dev: null, ino: null, size: p.length }; };
  k.s.renameReportFile = async () => { throw new Error("EXDEV: rename rejected"); };
  k.s.readReportFile = async (path) => {
    if (path === RESULT) { reads++; if (reads === 1) throw new Error("EIO transient"); return k.payload(); }
    return k.payload();
  };
  k.s.statReportFile = async () => ({ dev: null, ino: null, size: k.payload().length });
  const r = await finalize(k);
  assertEquals(r.state, "RED", "null === null must NEVER authorize: both sides must carry a real dev/ino");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null);
  assert(k.exits.includes(1));
  assert(!k.errors.some((l) => /reconciled to committed/i.test(l)));
});

// ── (b) dev is part of the identity ─────────────────────────────────────────
// Mutant E8 compared ino and size only. Inode numbers repeat across devices,
// so a same-ino/different-dev file is NOT our publication. Divergence:
// pristine RED, mutant GREEN + announced.
Deno.test("kat-finalizer guards: the same inode on a DIFFERENT device never ACKs a rejected rename (E8)", async () => {
  const k = seams();
  let reads = 0;
  k.s.renameReportFile = async () => { throw new Error("EXDEV: rename rejected"); };
  k.s.readReportFile = async (path) => {
    if (path === RESULT) { reads++; if (reads === 1) throw new Error("EIO transient"); return k.payload(); }
    return k.payload();
  };
  k.s.statReportFile = async () => ({ dev: 7, ino: 42, size: k.payload().length }); // same ino, OTHER dev
  const r = await finalize(k);
  assertEquals(r.state, "RED", "dev is part of the identity — inode numbers repeat across devices");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null);
});

// ── (b) an unverified publish is fatal ──────────────────────────────────────
// Mutant E4 deleted `if (!committed) throw renameErr`, and E5 reduced the ACK
// to `Boolean(st)` — ANY existing file would acknowledge a rejected rename.
Deno.test("kat-finalizer guards: a rejected rename acknowledged by NO check is fatal, and a foreign same-size file never ACKs (E4/E5)", async () => {
  const k = seams();
  let reads = 0;
  k.s.renameReportFile = async () => { throw new Error("EXDEV: rename rejected"); };
  k.s.readReportFile = async (path) => {
    if (path === RESULT) { reads++; if (reads === 1) throw new Error("EIO transient"); return k.payload(); }
    return k.payload();
  };
  k.s.statReportFile = async (path) => { k.calls.push(`stat:${path}`); return { dev: 9, ino: 99, size: k.payload().length }; };
  const r = await finalize(k);
  assertEquals(r.state, "RED");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null, "a foreign file with an identical size is not our publication");
  assert(k.calls.some((c) => c === `stat:${RESULT}`), "the identity check must actually have been consulted");
  assert(String(r.reportError).includes("EXDEV"), "the receipt names the rename rejection honestly, not a downstream symptom");
});

// ── (d) an unavailable post-publish read reconciles ONLY by identity ─────────
// Mutant G3 reduced this to `Boolean(st)`. The committed sibling test's name
// says "absent/mismatched → RED" but its loop only exercises ABSENT (null) and
// a MATCHING identity — never a present-but-mismatched one, so G3 survived.
Deno.test("kat-finalizer guards: an unavailable post-publish read with a PRESENT-BUT-MISMATCHED inode is result_publish_unverified, never an ACK (G3)", async () => {
  const k = seams();
  k.s.readReportFile = async (path) => {
    if (path === RESULT) throw new Error("EIO on post-publish read");
    return k.payload();
  };
  k.s.statReportFile = async (path) => (path === RESULT ? { dev: 9, ino: 99, size: k.payload().length } : null);
  const r = await finalize(k);
  assertEquals(r.state, "RED", "a present file that is not ours must never ACK");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null);
  assert(String(r.reportError).includes("result_publish_unverified"));
  assert(!k.errors.some((l) => /identity matches/i.test(l)));
});

// ── (d) corruption is never reconciled by the inode ─────────────────────────
// Mutant G4 dropped the re-throw, so a byte MISMATCH fell through to the inode.
// The committed sibling injects `size: 1` against a staged identity of
// `size: payload.length`, so its "matching inode" does NOT actually match —
// the test passed for the wrong reason and G4 survived. This one matches fully.
Deno.test("kat-finalizer guards: contradictory published bytes are RED even with a FULLY matching dev/ino/size (G4)", async () => {
  const k = seams();
  k.s.readReportFile = async (path) => (path === RESULT ? '{"corrupted":true}\n' : k.payload());
  k.s.statReportFile = async () => ({ dev: 1, ino: 42, size: k.payload().length }); // genuinely identical
  const r = await finalize(k);
  assertEquals(r.state, "RED", "corruption is never reconciled by the inode, not even an exactly matching one");
  assertEquals(r.exitCode, 1);
  assertEquals(r.receiptPath, null);
  assert(String(r.reportError).includes("result_publish_readback_mismatch"));
  assert(!k.errors.some((l) => /identity matches/i.test(l)), "the log must not claim an identity reconciliation for corrupt bytes");
});

// ── the allocator's EXCLUSIVE create (real default FS) ──────────────────────
// Mutant I1 made the default mkdirExclusive recursive. The committed allocator
// tests inject the mkdirExclusive seam, so the production DEFAULT was never
// exercised: a collision silently returned ANOTHER run's evidence directory,
// complete with its prior receipt. Divergence: pristine throws AlreadyExists,
// mutant aliases.
Deno.test("kat-finalizer guards: the REAL allocator default refuses a collision instead of aliasing another run's evidence (I1)", async () => {
  const parent = await scratch();
  const fixed = "11111111-2222-3333-4444-555555555555";
  try {
    await Deno.mkdir(parent, { recursive: true });
    // another run already owns the exact child this invocation would mint
    await Deno.mkdir(`${parent}/run-${fixed}`);
    await Deno.writeTextFile(`${parent}/run-${fixed}/result.json`, '{"state":"GREEN","prior":true}\n');

    // uuid is pinned so the collision is deterministic; EVERY filesystem seam
    // is the production default (real Deno.mkdir).
    await assertRejects(
      () => allocateRunEvidenceDir(parent, { uuid: () => fixed }),
      Deno.errors.AlreadyExists,
      undefined,
      "a collision must fail closed, never alias another run's evidence",
    );
    // and the foreign receipt must be untouched, not adopted
    assertEquals(
      await Deno.readTextFile(`${parent}/run-${fixed}/result.json`),
      '{"state":"GREEN","prior":true}\n',
    );
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {});
  }
});

// ── the poison detector's REAL default statFile ─────────────────────────────
// Mutant K4 made the default NotFound branch return TRUE. Every committed test
// injects `statFile`, so the production default — Deno.stat plus its NotFound
// classification — was never executed at all. Left unguarded, a missing poison
// file reads as a poisoned slot and turns every clean run RED.
Deno.test("kat-finalizer guards: the REAL default poison stat — an ABSENT file is not a detection, a PRESENT file is (K4)", async () => {
  const dir = await scratch();
  try {
    await Deno.mkdir(dir, { recursive: true });
    const absent = await teardownChromeAndProfile({
      cdp: null, chrome: null, profilePath: null,
      poisonPath: `${dir}/no-such-poison-file`,
      withTimeout: (p) => p,
      // NO statFile, NO removeDir: the production defaults on a real filesystem
    });
    assertEquals(absent.poisonDetected, false, "a poison path that does not exist is not a poisoned slot");
    assertEquals(absent.cleanupError, null);

    await Deno.writeTextFile(`${dir}/poison`, "x");
    const present = await teardownChromeAndProfile({
      cdp: null, chrome: null, profilePath: null,
      poisonPath: `${dir}/poison`,
      withTimeout: (p) => p,
    });
    assertEquals(present.poisonDetected, true, "a real poison file IS detected by the default seam");
    assert(String(present.cleanupError).includes("poison_slot_detected"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── cleanup errors AGGREGATE ────────────────────────────────────────────────
// Mutant K2 replaced the append with an assignment. No committed test drives
// TWO teardown failures at once, so the first error was silently dropped from
// the authoritative receipt.
Deno.test("kat-finalizer guards: two teardown failures both reach the receipt, aggregated in order (K2)", async () => {
  const k = seams();
  const r = await finalize(k, {
    teardown: {
      cdp: { send: async () => ({}), close: () => { throw new Error("cdp close boom"); } },
      profilePath: "/mock/profile",
      removeDir: async () => { throw new Error("profile rm boom"); },
    },
  });
  assertEquals(r.state, "RED");
  const parts = String(r.cleanupError).split("; ");
  assertEquals(parts.length, 2, `both failures must be reported, got: ${r.cleanupError}`);
  assert(parts[0].includes("cdp_close_failed"), `the FIRST failure must survive: ${r.cleanupError}`);
  assert(parts[1].includes("profile_cleanup_failed"), `the SECOND failure must be appended: ${r.cleanupError}`);
});

// ── the ll7q sanitizer bounds ───────────────────────────────────────────────
// Mutants J5 (no first-line bound) and J6 (no 512-char bound) both survived:
// no committed test feeds a multi-line or oversized foreign error, so the log
// could be grown or forged by whatever an OS error happens to contain.
Deno.test("kat-finalizer guards: sanitizeKatLogError is bounded to the FIRST line and to 512 chars (J5/J6)", () => {
  const multi = sanitizeKatLogError(new Error("clean first line\nsecond line carries /home/paul kinlan/cap/run-1234/result.json"));
  assertEquals(multi, "clean first line", "a multi-line foreign error must not be able to forge extra log lines");
  assert(!multi.includes("\n"));

  const oversized = sanitizeKatLogError(new Error("E" + "x".repeat(4000)));
  assertEquals(oversized.length, 512, "the sanitizer's bound is 512 characters");

  // the bound is applied AFTER masking, so a path cannot survive by padding
  const paddedPath = sanitizeKatLogError(new Error(`${"/home/paul kinlan/cap/run-1234/result.json".repeat(40)}`));
  assert(paddedPath.length <= 512);
  assert(!/\/home\/paul kinlan/.test(paddedPath), "no run path survives the sanitizer at any length");
});
