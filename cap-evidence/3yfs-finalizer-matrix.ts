// cap-evidence/3yfs-finalizer-matrix.ts — independent false-GREEN probe
// (chrome-agent-platform-3yfs).
//
// Executes the REAL production finalizer (scripts/lib/kat-finalizer.ts,
// finalizeKatExecution + stageReceiptFile) with controlled IO/CDP/process
// seams — no simulation, no copied logic — and asks the two questions the bead
// names: can an EVIDENCE-WRITE failure skip cleanup, and can a CLEANUP failure
// leave a GREEN? Every case records whether teardown actually ran.
//
// Exit 0 only when every case matches its expectations, including GREEN controls;
// exit 1 on any unexpected state, cleanup, receipt, or exit result.
// @ts-nocheck — evidence probe, untyped seams in the house pattern.
import { finalizeKatExecution } from "../scripts/lib/kat-finalizer.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = durableDir(`3yfs-matrix-${Date.now()}`);
const results: Array<{ name: string; verdict: string; detail: unknown }> = [];
let falseGreens = 0;

/** The exact teardown inputs a real KAT assembles, with per-case refusal. */
function teardownInputs(opts: {
  removeDirFails?: boolean;
  chromeNeverDies?: boolean;
  chromePresent?: boolean;
  browserCloseRejects?: boolean;
  poison?: boolean;
  onCleanup?: () => void;
}) {
  const calls = { removeDir: 0, kill: 0, cdpSend: 0, cdpClose: 0, stat: 0 };
  const never = new Promise(() => {});
  const chrome = opts.chromePresent === false ? null : {
    proc: {
      status: opts.chromeNeverDies ? never : Promise.resolve({ success: true, code: 0 }),
      kill: () => { calls.kill++; },
    },
  };
  return {
    calls,
    teardown: {
      cdp: {
        send: async () => {
          calls.cdpSend++;
          if (opts.browserCloseRejects) throw new Error("browser_close_refused");
          return {};
        },
        close: () => { calls.cdpClose++; },
      },
      chrome,
      profilePath: `${ROOT}/profile`,
      poisonPath: `${ROOT}/poison`,
      // Small bounded waits: the seam is the injectable one the tests use.
      withTimeout: (p: Promise<unknown>) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("teardown_wait_expired")), 25))]),
      removeDir: async () => {
        calls.removeDir++;
        opts.onCleanup?.();
        if (opts.removeDirFails) throw new Error("profile_remove_refused");
      },
      statFile: async () => { calls.stat++; return opts.poison === true; },
    },
  };
}

async function runCase(
  name: string,
  expect: { state: "GREEN" | "RED"; cleanupRan?: boolean; receipt?: "yes" | "null" },
  build: () => {
    inputs?: { calls: Record<string, number>; teardown: unknown };
    teardown?: unknown;
    runError: string | null;
    checks: Array<{ name: string; passed: boolean }>;
    seams?: Record<string, unknown>;
  },
) {
  const outDir = `${ROOT}/${name.replace(/[^a-z0-9]+/gi, "-")}`;
  await Deno.mkdir(outDir, { recursive: true });
  const built = build();
  const teardown = built.inputs?.teardown ?? built.teardown;
  const runError = built.runError;
  const checks = built.checks;
  const seams = built.seams ?? {};
  const calls = built.inputs?.calls ?? null;
  const exits: number[] = [];
  const outcome = await finalizeKatExecution({
    runError,
    checks,
    teardown,
    report: {
      expected: "3yfs matrix", head: "0".repeat(40), tree: "0".repeat(40), dirty: false,
      mainWorldSha256: "0".repeat(64), url: "about:blank", browserVersion: "probe",
      lockWaitMs: null, outDir,
    },
    exit: (code: number) => { exits.push(code); },
    logError: () => {},
    logInfo: () => {},
    ...seams,
  } as never);
  const writeFailure = name.startsWith("write");
  const teardownRan = calls ? calls.removeDir > 0 || calls.kill > 0 || calls.cdpSend > 0 : null;
  const ok = outcome.state === expect.state
    && (expect.cleanupRan === undefined || teardownRan === expect.cleanupRan)
    && (expect.receipt === undefined || (expect.receipt === "null" ? outcome.receiptPath === null : outcome.receiptPath !== null))
    && (expect.state === "GREEN" ? exits.length === 0 || exits[0] === 0 : (outcome.exitCode === 1))
    && (!writeFailure || teardownRan === true);
  if (!ok) falseGreens += expect.state === "RED" && outcome.state === "GREEN" ? 1 : 0;
  results.push({
    name,
    verdict: ok ? "OK" : "UNEXPECTED",
    detail: { state: outcome.state, exitCode: outcome.exitCode, cleanupError: outcome.cleanupError, receiptPath: outcome.receiptPath, exitSeam: exits, teardownRan },
  });
  if (writeFailure && teardownRan !== true) falseGreens++;
}

// 1. clean
await runCase("clean", { state: "GREEN", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: true }],
}));

// 2. cleanup failure alone must force RED
await runCase("cleanup-profile-removal-fails", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({ removeDirFails: true }), runError: null, checks: [{ name: "c1", passed: true }],
}));

// 3. the browser never dies even after SIGKILL → RED
await runCase("cleanup-browser-never-dies", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({ chromeNeverDies: true }), runError: null, checks: [{ name: "c1", passed: true }],
}));

// 4. evidence-write failure (kat.log) must still have run teardown
await runCase("write-kat-log-fails", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: true }],
  seams: { writeTextFile: async () => { throw new Error("kat_log_refused"); } },
}));

// 5. evidence-write failure (result stage) must still have run teardown
await runCase("write-result-stage-fails", { state: "RED", cleanupRan: true, receipt: "null" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: true }],
  seams: { stageReport: async () => { throw new Error("stage_open_refused"); } },
}));

// 6. rename rejected, reconciliation unavailable, foreign inode → no receipt
await runCase("write-rename-unreconcilable", { state: "RED", cleanupRan: true, receipt: "null" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: true }],
  seams: {
    renameReportFile: async () => { throw new Error("rename_refused"); },
    readReportFile: async () => { throw new Error("read_unavailable"); },
    statReportFile: async () => ({ dev: 1, ino: 2, size: 3 }),
  },
}));

// 7. persistent directory-sync failure is honest RED
await runCase("write-dir-sync-fails", { state: "RED", cleanupRan: true, receipt: "null" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: true }],
  seams: { syncReportDir: async () => { throw new Error("dir_sync_refused"); } },
}));

// 8. ZERO checks recorded: a run that verified nothing
await runCase("vacuity-no-checks-recorded", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [],
}));

// 9. Browser.close rejects and there is NO process handle to confirm the kill
await runCase("cleanup-browser-close-rejects-no-handle", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({ browserCloseRejects: true, chromePresent: false }),
  runError: null, checks: [{ name: "c1", passed: true }],
}));

// 10. Browser.close rejects but the process IS confirmed dead → GREEN is honest
await runCase("cleanup-browser-close-rejects-process-dies", { state: "GREEN", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({ browserCloseRejects: true }),
  runError: null, checks: [{ name: "c1", passed: true }],
}));

// 11. the run itself failed
await runCase("run-error", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({}), runError: "boom", checks: [{ name: "c1", passed: true }],
}));

// 12. one failed check
await runCase("failed-check", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: false }],
}));

// 13. a poisoned slot
await runCase("poison-slot", { state: "RED", cleanupRan: true, receipt: "yes" }, () => ({
  inputs: teardownInputs({ poison: true }), runError: null, checks: [{ name: "c1", passed: true }],
}));

// 14. an exit seam that RETURNS must not yield a returned GREEN on a publish failure
await runCase("write-publish-failure-exit-returns", { state: "RED", cleanupRan: true, receipt: "null" }, () => ({
  inputs: teardownInputs({}), runError: null, checks: [{ name: "c1", passed: true }],
  seams: { stageReport: async () => { throw new Error("stage_refused"); }, exit: () => {} },
}));

const unexpectedCases = results.filter((result) => result.verdict === "UNEXPECTED").map((result) => result.name);
// falseGreens remains a diagnostic; over-rejection and other predicate failures count too.
console.log(JSON.stringify({ root: ROOT, falseGreens, unexpectedCases, results }, null, 2));
if (unexpectedCases.length > 0) {
  console.log(`\nPROBE FAILED: ${unexpectedCases.length} unexpected case(s): ${unexpectedCases.join(", ")}.`);
  Deno.exit(1);
}
console.log(`\nPROBE PASSED: every case matched expectations (${results.length} cases).`);
