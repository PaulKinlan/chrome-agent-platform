// tests/kat-finalizer-log-residue.test.ts — bead ln0e.
//
// The report-order invariant in scripts/lib/kat-finalizer.ts states that when
// the result write fails "there is NO valid result (exit 1) and the misleading
// kat.log is removed best-effort". The landed code removed only the staged temp,
// so a failed publication left kat.log on disk asserting `RESULT: n/n; GREEN`
// beside a result.json that either did not exist or belonged to an earlier run.
//
// Owner decision (coord, 2026-09-06): REMOVE it. The log is never authoritative
// — the receipt path, the exit code and the FATAL log channel are — and a
// surviving GREEN claim beside no authoritative receipt is exactly the dishonest
// artifact this module exists to prevent. The removal is UNCONDITIONAL on
// publication failure; a conditional "only when it claims GREEN" rule would add
// a second branch that would itself need pinning. Accepted cost: on a run that
// was already RED we also delete a log that said RED.
//
// These tests run the PRODUCTION finalizeKatExecution. Test 1 uses the REAL
// Deno filesystem with EVERY filesystem seam at its production default; tests
// 2-4 inject seams to pin the mechanism and the fix's own failure modes.
//
// Deliberately a separate file: it must not collide with the in-flight qml6
// (tests/kat-bistro-finalizer.test.ts) or 2b6a
// (tests/kat-finalizer-guards.test.ts) candidates.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { finalizeKatExecution } from "../scripts/lib/kat-finalizer.ts";

// Real-filesystem scratch goes under the DURABLE root, never tmpfs (bead chp;
// tests/durable-root.test.ts statically guards /tmp evidence literals).
const scratch = () => mkdtemp(join(durableDir("scratch") + "/", "cap-ln0e-"));

const REPORT = (outDir) => ({
  expected: "head-1", head: "head-1", tree: "tree-1", dirty: false,
  mainWorldSha256: "mw-1", url: "https://example.com/", browserVersion: "test",
  lockWaitMs: 0, outDir,
});
const PASSING = [{ name: "bistro_loaded", passed: true }, { name: "order_submitted", passed: true }];

/** Collect every regular file under `dir` (one level of subdirectories too). */
async function collectFiles(dir) {
  const out = [];
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      for await (const c of Deno.readDir(p)) if (c.isFile) out.push(`${p}/${c.name}`);
    } else if (e.isFile) out.push(p);
  }
  return out;
}

const GREEN_CLAIM = /RESULT:[^\n]*GREEN|"state":\s*"GREEN"/;

// ── 1. the real filesystem: a failed publication leaves NO GREEN-claiming artifact
//
// The publication is made to fail WITHOUT touching permissions or ownership:
// result.json is a NON-EMPTY DIRECTORY, so the atomic rename of the staged temp
// onto it rejects with a real OS error (`Is a directory`, os error 21). kat.log,
// written first into the same writable directory, succeeds — which is exactly
// the residue this bead is about. Every filesystem seam stays at its production
// default, so this exercises the real Deno.remove path.
Deno.test("ln0e: a failed publication removes kat.log — no artifact in the evidence dir claims GREEN (real FS)", async () => {
  const outDir = await scratch();
  try {
    await Deno.mkdir(`${outDir}/result.json`);
    await Deno.writeTextFile(`${outDir}/result.json/placeholder.txt`, "not a receipt\n");

    const exits = [];
    const errors = [];
    const outcome = await finalizeKatExecution({
      runError: null,
      checks: PASSING,
      teardown: {
        cdp: null, chrome: null, profilePath: null,
        poisonPath: `${outDir}/no-poison`,
        withTimeout: (p) => p,
      },
      report: REPORT(outDir),
      // NO filesystem seams injected — production defaults (real Deno).
      exit: (c) => exits.push(c),
      logError: (...p) => errors.push(p.map(String).join(" ")),
      logInfo: () => {},
    });

    // The fail-closed behaviour itself (already correct before this fix).
    assertEquals(outcome.state, "RED");
    assertEquals(outcome.exitCode, 1);
    assertEquals(outcome.receiptPath, null, "no receipt is attributable to this run");
    assert(exits.includes(1), "the fail-closed exit seam fired with 1");
    assert(/os error 21|Is a directory/i.test(String(outcome.reportError)),
      `the real rename rejection must be the reported cause, got: ${outcome.reportError}`);

    // THE FIX: kat.log must be gone.
    const logGone = await Deno.stat(`${outDir}/kat.log`).then(() => false, () => true);
    assert(logGone, "kat.log survived a failed publication still claiming GREEN");

    // And nothing else in the evidence directory may claim a GREEN result.
    const claiming = [];
    for (const f of await collectFiles(outDir)) {
      const body = await Deno.readTextFile(f).catch(() => "");
      if (GREEN_CLAIM.test(body)) claiming.push(f.replace(outDir, "<outDir>"));
    }
    assertEquals(claiming, [], "a failed publication left a GREEN-claiming artifact behind");

    // The staged temp is quarantine residue and must also be gone.
    const tmps = (await collectFiles(outDir)).filter((f) => f.endsWith(".tmp"));
    assertEquals(tmps, [], "an orphan staged temp was left behind");
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── 2. the mechanism: removal is ATTEMPTED for kat.log, not just for the temp
//
// Pins the fix through the injected seam so a future refactor cannot satisfy
// test 1 by some other route while silently dropping the removal.
Deno.test("ln0e: on a publish failure the finalizer attempts to remove BOTH the staged temp and kat.log", async () => {
  const removed = [];
  const exits = [];
  const outcome = await finalizeKatExecution({
    runError: null,
    checks: PASSING,
    teardown: {
      cdp: null, chrome: null, profilePath: null, poisonPath: "/mock/out/no-poison",
      withTimeout: (p) => p, statFile: async () => false,
    },
    report: REPORT("/mock/out"),
    writeTextFile: async () => {},
    stageReport: async () => { throw new Error("ENOSPC: stage open failed"); },
    readReportFile: async () => { throw new Error("ENOENT"); },
    renameReportFile: async () => {},
    statReportFile: async () => null,
    syncReportDir: async () => {},
    removeReportFile: async (p) => { removed.push(p); },
    exit: (c) => exits.push(c),
    logError: () => {}, logInfo: () => {},
  });

  assertEquals(outcome.state, "RED");
  assertEquals(outcome.exitCode, 1);
  assertEquals(outcome.receiptPath, null);
  assert(removed.includes("/mock/out/kat.log"),
    `kat.log removal was not attempted; removals were: ${JSON.stringify(removed)}`);
  assert(removed.some((p) => p.startsWith("/mock/out/result.json.") && p.endsWith(".tmp")),
    `the staged temp removal was not attempted; removals were: ${JSON.stringify(removed)}`);
  // kat.log is removed AFTER the receipt failure is known, never before.
  assert(removed.indexOf("/mock/out/kat.log") >= 0);
  assert(exits.includes(1));
});

// ── 3. non-over-removal: a SUCCESSFUL publication keeps its log
//
// The other failure mode of the fix — deleting kat.log unconditionally, not just
// on publication failure, would destroy the diagnostic on every healthy run.
Deno.test("ln0e: a successful publication RETAINS kat.log beside the receipt", async () => {
  const outDir = await scratch();
  try {
    const exits = [];
    const outcome = await finalizeKatExecution({
      runError: null,
      checks: PASSING,
      teardown: {
        cdp: null, chrome: null, profilePath: null, poisonPath: `${outDir}/no-poison`,
        withTimeout: (p) => p,
      },
      report: REPORT(outDir),
      exit: (c) => exits.push(c),
      logError: () => {}, logInfo: () => {},
    });

    assertEquals(outcome.state, "GREEN");
    assertEquals(outcome.exitCode, 0);
    assertEquals(outcome.receiptPath, `${outDir}/result.json`);
    assertEquals(exits, [], "a GREEN run must not invoke the fail-closed exit");

    const log = await Deno.readTextFile(`${outDir}/kat.log`);
    assert(/RESULT: 2\/2; GREEN/.test(log), "the healthy run's log must survive");
    const receipt = JSON.parse(await Deno.readTextFile(`${outDir}/result.json`));
    assertEquals(receipt.state, "GREEN");
    // and the log and the receipt must AGREE — that is the whole point
    assertEquals(/GREEN/.test(log), receipt.state === "GREEN");
    const tmps = (await collectFiles(outDir)).filter((f) => f.endsWith(".tmp"));
    assertEquals(tmps, [], "no orphan staged temp after a clean publication");
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── 4. the removal stays BEST-EFFORT
//
// A read-only or already-clean directory must not turn a handled publish failure
// into an unhandled one: a throwing removal inside the catch would escape and
// crash the KAT instead of exiting 1 with an honest RED.
Deno.test("ln0e: a removal that THROWS stays best-effort — still RED, exit 1, no receipt, nothing escapes", async () => {
  const exits = [];
  const outcome = await finalizeKatExecution({
    runError: null,
    checks: PASSING,
    teardown: {
      cdp: null, chrome: null, profilePath: null, poisonPath: "/mock/out/no-poison",
      withTimeout: (p) => p, statFile: async () => false,
    },
    report: REPORT("/mock/out"),
    writeTextFile: async () => {},
    stageReport: async () => { throw new Error("EACCES: stage open failed"); },
    readReportFile: async () => { throw new Error("ENOENT"); },
    renameReportFile: async () => {},
    statReportFile: async () => null,
    syncReportDir: async () => {},
    removeReportFile: async (p) => { throw new Error(`EROFS: cannot remove ${p}`); },
    exit: (c) => exits.push(c),
    logError: () => {}, logInfo: () => {},
  });

  assertEquals(outcome.state, "RED", "a removal failure must never change the verdict");
  assertEquals(outcome.exitCode, 1);
  assertEquals(outcome.receiptPath, null);
  assert(exits.includes(1), "the fail-closed exit still fires when cleanup is impossible");
  assert(/EACCES/.test(String(outcome.reportError)),
    `the reported cause is the PUBLISH failure, not the cleanup failure: ${outcome.reportError}`);
});
