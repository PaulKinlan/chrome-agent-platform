// scripts/lib/kat-finalizer.ts — Reusable fail-closed browser and profile teardown helper for KATs (06qj).
// Guarantees independent execution of every teardown phase, confirmed process exit after SIGKILL,
// strict error aggregation, profile unlinking, and poison slot detection.
//
// 5l73+06qj successor: this module also owns finalizeKatExecution — the KAT's
// production teardown → decision → result-writes → fail-closed exit sequence,
// extracted from scripts/kat-webmcp-bistro.ts verbatim so the committed tests
// execute the REAL caller (never a simulated evaluator). A cleanup failure, a
// poisoned slot, or a report-write failure can never leave a GREEN behind.

export interface TeardownChromeAndProfileOptions {
  cdp?: {
    send(method: string, params?: unknown): Promise<unknown>;
    close(): void;
  } | null;
  chrome?: {
    proc: {
      status: Promise<{ success: boolean; code?: number }>;
      // 39br: the actual launcher type (Deno.ChildProcess.kill accepts the
      // numeric signal | Deno.Signal union) — never the arbitrary `string`.
      kill(signal: number | Deno.Signal): void;
    };
  } | null;
  profilePath?: string | null;
  poisonPath?: string;
  withTimeout: <T>(promise: Promise<T>, ms: number) => Promise<T>;
  removeDir?: (path: string) => Promise<void>;
  statFile?: (path: string) => Promise<boolean>;
}

export interface TeardownResult {
  cleanupError: string | null;
  poisonDetected: boolean;
}

export async function teardownChromeAndProfile(
  options: TeardownChromeAndProfileOptions,
): Promise<TeardownResult> {
  const {
    cdp,
    chrome,
    profilePath,
    poisonPath = "/tmp/cap-chrome-slot-POISON",
    withTimeout,
    removeDir = (path) => Deno.remove(path, { recursive: true }),
    statFile = async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (
          error instanceof Deno.errors.NotFound ||
          (error as { name?: string })?.name === "NotFound" ||
          (error as { code?: string })?.code === "ENOENT" ||
          String(error).includes("NotFound")
        ) {
          return false;
        }
        throw error;
      }
    },
  } = options;

  let cleanupError: string | null = null;
  function recordCleanupError(msg: string) {
    cleanupError = cleanupError ? `${cleanupError}; ${msg}` : msg;
    console.error(msg);
  }

  // 1. CDP teardown (Browser.close and CDP transport close independently guarded)
  if (cdp) {
    try {
      await withTimeout(cdp.send("Browser.close"), 4_000).catch(() => {});
    } catch (err) {
      recordCleanupError(
        `cdp_browser_close_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      cdp.close();
    } catch (err) {
      recordCleanupError(
        `cdp_close_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Chrome process termination (ALWAYS runs even if CDP close threw)
  if (chrome) {
    try {
      await withTimeout(chrome.proc.status, 8_000).catch(async () => {
        try {
          chrome?.proc.kill("SIGKILL");
        } catch {
          /* process may already have exited */
        }
        await withTimeout(chrome.proc.status, 4_000);
      });
    } catch (procErr) {
      recordCleanupError(
        `browser_teardown_failed: ${procErr instanceof Error ? procErr.message : String(procErr)}`,
      );
    }
  }

  // 3. Profile directory cleanup (ALWAYS runs even if process or CDP cleanup threw)
  if (profilePath) {
    try {
      await removeDir(profilePath);
    } catch (rmErr) {
      const rmMsg = `profile_cleanup_failed: ${
        rmErr instanceof Error ? rmErr.message : String(rmErr)
      }`;
      recordCleanupError(rmMsg);
    }
  }

  // 4. Poison slot detection
  let poisonDetected = false;
  try {
    const exists = await statFile(poisonPath);
    if (exists) {
      poisonDetected = true;
      recordCleanupError("poison_slot_detected");
    }
  } catch (statErr) {
    recordCleanupError(
      `poison_stat_failed: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
    );
  }

  return { cleanupError, poisonDetected };
}

// ── The production finalizer (the KAT's caller seam) ────────────────────────

export interface KatCheckEntry {
  name: string;
  passed: boolean;
  detail?: unknown;
}

export interface FinalizeKatExecutionOptions {
  /** The run's error text (null when the KAT body completed). */
  runError: string | null;
  /** Every check entry the KAT recorded (pass/fail counts derive from it). */
  checks: KatCheckEntry[];
  /** The teardown inputs (cdp/chrome/profilePath/poisonPath + seams). */
  teardown: TeardownChromeAndProfileOptions;
  /** The report's identity/evidence fields, written verbatim. */
  report: {
    expected: string;
    head: string;
    tree: string;
    dirty: boolean;
    mainWorldSha256: string;
    url: string;
    browserVersion: unknown;
    lockWaitMs: number | null;
    outDir: string;
  };
  /** I/O seams (production: Deno.* per the GLM staged-publication checklist). */
  writeTextFile?: (path: string, text: string) => Promise<void>;
  /** Stage the payload: open(createNew) → write-all → file.sync() →
   * stat identity → close. Returns the staged file's {dev, ino, size}
   * (dev/ino are null on platforms without them — the identity reconciliation
   * requires both sides non-null, so a null identity simply never ACKs). */
  stageReport?: (path: string, payload: string) => Promise<{ dev: number | null; ino: number | null; size: number }>;
  readReportFile?: (path: string) => Promise<string>;
  renameReportFile?: (from: string, to: string) => Promise<void>;
  statReportFile?: (path: string) => Promise<{ dev: number | null; ino: number | null; size: number } | null>;
  /** fsync the DIRECTORY entry after the atomic rename (GLM: Deno.open(dir,
   * {read:true}).sync()). A persistent failure is reported honestly — never a
   * durable-GREEN claim without the barrier. */
  syncReportDir?: (dir: string) => Promise<void>;
  removeReportFile?: (path: string) => Promise<void>;
  exit?: (code: number) => never | void;
  logError?: (...parts: unknown[]) => void;
  logInfo?: (...parts: unknown[]) => void;
}

export interface FinalizeKatExecutionResult {
  state: "GREEN" | "RED";
  /** The bounded exit code the CALLER applies (Deno.exit(outcome.exitCode)) —
   * 0 on GREEN, 1 on RED. The finalizer ALSO invokes the exit seam on RED
   * (production Deno.exit terminates there); if an injected seam ever RETURNS,
   * the result still carries RED + exitCode 1 — a returned seam can never
   * yield a GREEN result. */
  exitCode: 0 | 1;
  cleanupError: string | null;
  poisonDetected: boolean;
  reportError: string | null;
  /** The exact published receipt path (null when publication failed). */
  receiptPath: string | null;
}

/** The exact production sequence the KAT runs ONCE in its finally block:
 * teardown (fail-closed helper) → the GREEN/RED decision (a run error, a failed
 * check, a cleanup error, or a poisoned slot each force RED) → BOTH report
 * writes (result.json + kat.log; a write failure is fatal and exit(1)s) →
 * fail-closed exit(1) on RED. Tests inject the I/O seams and execute THIS
 * function — never a simulation of it. */
export async function finalizeKatExecution(
  options: FinalizeKatExecutionOptions,
): Promise<FinalizeKatExecutionResult> {
  const {
    runError,
    checks,
    teardown,
    report,
    writeTextFile = (path, text) => Deno.writeTextFile(path, text),
    stageReport = stageReceiptFile,
    readReportFile = (path) => Deno.readTextFile(path),
    renameReportFile = (from, to) => Deno.rename(from, to),
    statReportFile = async (path) => {
      try {
        const st = await Deno.stat(path);
        return { dev: st.dev, ino: st.ino, size: st.size };
      } catch { return null; }
    },
    syncReportDir = async (dir) => {
      const d = await Deno.open(dir, { read: true });
      try { await d.sync(); } finally { d.close(); }
    },
    removeReportFile = (path) => Deno.remove(path),
    exit = (code) => Deno.exit(code),
    logError = console.error,
    logInfo = console.log,
  } = options;

  const { cleanupError, poisonDetected } = await teardownChromeAndProfile(teardown);

  const pass = checks.filter((c) => c.passed).length;
  const failCount = checks.length - pass;
  const isGreen = !runError && failCount === 0 && !cleanupError && !poisonDetected;
  const resultData = {
    state: isGreen ? "GREEN" : "RED",
    error: runError || cleanupError,
    cleanupError,
    poisonDetected,
    expected: report.expected,
    head: report.head,
    tree: report.tree,
    dirty: report.dirty,
    mainWorldSha256: report.mainWorldSha256,
    url: report.url,
    browserVersion: report.browserVersion,
    lockWaitMs: report.lockWaitMs,
    checks,
  };

  // Report-order invariant (coordinator 2026-09-06): no failure may leave an
  // authoritative GREEN result.json. kat.log is written FIRST — a log-write
  // error folds into the final RED result; result.json is written LAST; if
  // the result write fails there is NO valid result (exit 1) and the
  // misleading kat.log is removed best-effort. Teardown has ALWAYS completed
  // by this point.
  let reportError: string | null = null;
  let finalGreen = isGreen;
  try {
    await writeTextFile(
      `${report.outDir}/kat.log`,
      checks.map((c) => `${c.passed ? "PASS" : "FAIL"}: ${c.name}`).join("\n") +
        `\nRESULT: ${pass}/${checks.length}; ${isGreen ? "GREEN" : "RED"}\n` +
        (cleanupError ? `CLEANUP ERROR: ${cleanupError}\n` : ""),
    );
  } catch (logErr) {
    // The log is not authoritative — fold its failure into the final RED.
    reportError = (logErr instanceof Error ? logErr.message : String(logErr)).slice(0, 512);
    logError("KAT log write failed:", sanitizeKatLogError(logErr));
    finalGreen = false;
    resultData.state = "RED";
    resultData.error = resultData.error ?? `kat_log_write_failed: ${reportError}`;
  }
  // Authoritative receipt publication (z6xw; sol's r6 closure + the GLM Deno
  // checklist): stage to a UNIQUE same-dir temp via open(createNew) → write-all
  // → file.sync() (the fsync durability barrier — data + metadata incl. size)
  // → record the staged inode identity {dev, ino, size} + close → exact temp
  // readback → ATOMIC same-dir rename. If the rename RESOLVES, the publication
  // is committed: a later readback FAILURE (an unavailable read — no
  // contradictory bytes) reconciles by the staged inode identity, while a
  // positive byte MISMATCH is corruption and is ALWAYS RED (the inode never
  // reconciles contradictory content). If the rename REJECTS after a possible
  // effect, reconcile by exact final bytes, then by {dev,ino,size} inode
  // identity (both sides non-null); only a genuinely unverified publish is
  // RED. Deletion is never load-bearing: the unique temp is never
  // authoritative and its best-effort removal changes nothing.
  const resultPath = `${report.outDir}/result.json`;
  const tmpPath = `${report.outDir}/result.json.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify({ ...resultData, state: finalGreen ? "GREEN" : "RED" }, null, 2) + "\n";
  try {
    // (a) stage: exclusive create + write-all + fsync + identity + exact readback.
    const stagedIdentity = await stageReport(tmpPath, payload);
    const stagedBack = await readReportFile(tmpPath);
    if (stagedBack !== payload) throw new Error("result_stage_readback_mismatch");

    // (b) the atomic rename; a REJECTION reconciles by exact content, then by
    // the staged inode identity (the read threw — no contradictory bytes).
    let committed = false;
    try {
      await renameReportFile(tmpPath, resultPath);
      committed = true;
    } catch (renameErr) {
      // A positive MISMATCHING read is corruption — RED immediately, the inode
      // is never consulted. The inode reconciles ONLY an unavailable read.
      let readUnavailable = false;
      try {
        const finalBytes = await readReportFile(resultPath);
        if (finalBytes !== payload) throw new Error("result_publish_readback_mismatch");
        committed = true;
      } catch (readErr) {
        if (readErr instanceof Error && readErr.message === "result_publish_readback_mismatch") throw readErr;
        readUnavailable = true;
      }
      if (!committed && readUnavailable) {
        // null === null must NEVER authorize: every identity field must be
        // present on BOTH sides before equality means anything.
        const st = await statReportFile(resultPath);
        committed = Boolean(st && st.dev != null && st.ino != null &&
          stagedIdentity.dev != null && stagedIdentity.ino != null &&
          st.dev === stagedIdentity.dev && st.ino === stagedIdentity.ino &&
          st.size === stagedIdentity.size);
      }
      if (!committed) throw renameErr;
      logError("KAT result publish rejected after effect; reconciled to committed by exact identity readback:", sanitizeKatLogError(renameErr));
    }

    // (c) the directory entry must survive too — fsync the dir on EVERY
    // committed path (resolved or reconciled), bounded retries. A persistent
    // failure is honest RED: the content is committed but NOT durable, and no
    // durable GREEN is ever claimed without the barrier.
    let dirSynced = false;
    let lastDirErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !dirSynced; attempt++) {
      try { await syncReportDir(report.outDir); dirSynced = true; }
      catch (dirErr) { lastDirErr = dirErr; }
    }
    if (!dirSynced) throw new Error(`result_dir_sync_failed: ${String(lastDirErr)}`);

    // (d) post-publish verification. Contradictory bytes are CORRUPTION — RED,
    // NEVER reconciled by the inode. An UNAVAILABLE read reconciles by the
    // staged inode identity (verified synced before the atomic rename).
    try {
      const published = await readReportFile(resultPath);
      if (published !== payload) throw new Error("result_publish_readback_mismatch");
    } catch (verifyErr) {
      if (verifyErr instanceof Error && verifyErr.message === "result_publish_readback_mismatch") throw verifyErr;
      const st = await statReportFile(resultPath);
      // The same null-equality guard: both sides present before equality counts.
      const identityOk = Boolean(st && st.dev != null && st.ino != null &&
        stagedIdentity.dev != null && stagedIdentity.ino != null &&
        st.dev === stagedIdentity.dev && st.ino === stagedIdentity.ino &&
        st.size === stagedIdentity.size);
      if (!identityOk) throw new Error("result_publish_unverified");
      logError("KAT receipt readback unavailable post-publish; the staged inode identity matches — the committed publication stands");
    }
  } catch (err) {
    // No authoritative result at all. finalGreen drops NOW: an exit seam that
    // RETURNS (tests) must never yield a returned GREEN.
    reportError = (err instanceof Error ? err.message : String(err)).slice(0, 512);
    finalGreen = false;
    resultData.state = "RED";
    resultData.error = resultData.error ?? `result_publish_failed: ${reportError}`;
    logError("FATAL: Failed to publish the KAT result:", sanitizeKatLogError(err));
    // The unique temp is never authoritative — removal is best-effort hygiene,
    // never load-bearing (a removal failure changes nothing).
    try { await removeReportFile(tmpPath); } catch { /* best effort */ }
    // kat.log IS load-bearing, in the other direction (ln0e; the report-order
    // invariant above): it asserts a RESULT this run never published, so a
    // surviving GREEN log beside no authoritative receipt is a dishonest
    // artifact. Removed UNCONDITIONALLY on publication failure — the log is
    // never authoritative (the returned receiptPath, the exit code and this
    // FATAL line are), and a conditional "only when it claims GREEN" rule would
    // add a branch that would itself need pinning. Accepted cost: an
    // already-RED log goes too. Still best-effort — a read-only directory
    // cannot be cleaned, and the honest answer there is a null receiptPath,
    // never an exception escaping this catch.
    try { await removeReportFile(`${report.outDir}/kat.log`); } catch { /* best effort */ }
    // ONE fail-closed exit path: exit, then RETURN the RED result immediately
    // (a returned exit seam in tests must not fall through to the RED exit
    // below and double-record).
    exit(1);
    return { state: "RED", exitCode: 1, cleanupError, poisonDetected, reportError, receiptPath: null };
  }

  // No evidence path is announced here: a path is authoritative ONLY via the
  // returned receiptPath (non-null) — the caller prints the exact receipt line
  // after that. (sol's structural authority rule; an orphan temp is quarantine
  // residue, never authority.)
  logInfo(
    `\nKAT Result: ${pass} passed, ${failCount} failed (cleanup: ${cleanupError ?? "ok"})`,
  );
  if (!finalGreen) exit(1);

  return {
    state: finalGreen ? "GREEN" : "RED",
    exitCode: finalGreen ? 0 : 1,
    cleanupError,
    poisonDetected,
    reportError,
    receiptPath: resultPath,
  };
}


/** The run's evidence directory allocator (sol's r6 pin): a FULL-UUID child
 * under the parent, created EXCLUSIVELY (non-recursive mkdir — a collision
 * fails closed, never aliases another run's evidence). Bound to the invocation
 * by construction. Extracted so the tests execute the REAL allocator. */
export async function allocateRunEvidenceDir(
  parent: string,
  {
    mkdirParent = (path: string) => Deno.mkdir(path, { recursive: true }),
    mkdirExclusive = (path: string) => Deno.mkdir(path),
    uuid = () => crypto.randomUUID(),
  }: {
    mkdirParent?: (path: string) => Promise<void>;
    mkdirExclusive?: (path: string) => Promise<void>;
    uuid?: () => string;
  } = {},
): Promise<string> {
  await mkdirParent(parent);
  const child = `${parent}/run-${uuid()}`;
  await mkdirExclusive(child); // throws (AlreadyExists) on any collision
  return child;
}

/** The REAL receipt stager (the finalizer's default stageReport seam) —
 * exported so the committed tests execute IT directly (an injected-seam test
 * alone would stay GREEN if this body were deleted). The GLM checklist:
 * open(createNew) — O_EXCL, a tmp collision fails closed; write-ALL loop with
 * a no-progress guard; file.sync() (fsync — data AND metadata incl. size);
 * the {dev, ino, size} identity recorded pre-close; then close. */
export async function stageReceiptFile(
  path: string,
  payload: string,
  {
    openFile = (p: string) => Deno.open(p, { write: true, createNew: true }),
  }: { openFile?: (path: string) => Promise<Deno.FsFile> } = {},
): Promise<{ dev: number | null; ino: number | null; size: number }> {
  const file = await openFile(path);
  try {
    const bytes = new TextEncoder().encode(payload);
    let off = 0;
    while (off < bytes.length) {
      // writeSync may write PARTIAL bytes; a 0-byte write would loop forever —
      // no progress fails closed.
      const wrote = file.writeSync(bytes.subarray(off));
      if (wrote === 0) throw new Error("result_stage_write_no_progress");
      off += wrote;
    }
    await file.sync();
    const st = await file.stat();
    return { dev: st.dev, ino: st.ino, size: st.size };
  } finally {
    file.close();
  }
}

/** ll7q: publication/teardown logs never carry run paths (the run-child dir,
 * the result, or the tmp stage) — the receipt is announced ONLY by the exact
 * `KAT receipt:` line after a non-null receiptPath. Internal codes are
 * path-free by construction; foreign (OS/Deno) errors have any absolute path
 * tokens replaced with [path]. Bounded to the first line, 512 chars. */
export function sanitizeKatLogError(err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err).split("\n")[0];
  return raw
    // Absolute POSIX paths, INCLUDING whitespace inside the path — masked to
    // the next quote/paren/comma or the end of the line (safe over-mask after
    // an unquoted path, never an under-mask).
    .replace(/(?:[A-Za-z]:)?\/[^\n"',()]*(?=["',()]|$)/g, "[path]")
    // Windows backslash paths (drive-letter and UNC), whitespace included.
    .replace(/(?:[A-Za-z]:)?\\[^\n"',()]*(?=["',()]|$)/g, "[path]")
    // Relative run paths: run-<uuid>[/...] and result*.json tokens.
    .replace(/\brun-[0-9a-f-]{4,}(?:\/[\w.-]+)*/g, "[path]")
    .replace(/\bresult\.json(?:\.[\w-]+\.tmp)?\b/g, "[path]")
    .slice(0, 512);
}
