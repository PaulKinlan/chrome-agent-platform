// tests/kat-bistro-finalizer.test.ts — Verification of scripts/kat-webmcp-bistro.ts
// finalizer ordering, guaranteed teardown, fail-closed exit reporting, lock/poison hygiene,
// and caller binding to scripts/lib/kat-finalizer.ts (06qj; 5l73+06qj successor).
//
// The caller tests execute the PRODUCTION finalizeKatExecution with injected
// I/O seams — never a simulated evaluator (the 3yfs blocking review). The
// falsification test proves a mutated finalizer (failure fields discarded)
// turns the same executable test RED.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { allocateRunEvidenceDir, finalizeKatExecution, sanitizeKatLogError, stageReceiptFile, teardownChromeAndProfile } from "../scripts/lib/kat-finalizer.ts";

const root = new URL("..", import.meta.url).pathname;

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

const PASSING_CHECKS = [{ name: "c1", passed: true }];

Deno.test("kat-bistro: the KAT delegates the finalizer sequence to the production function, exactly once", async () => {
  const scriptText = await Deno.readTextFile(`${root}/scripts/kat-webmcp-bistro.ts`);
  assert(scriptText.includes("?toolautosubmit"), "KAT must append ?toolautosubmit");
  assert(scriptText.includes("openCdp"), "KAT must use canonical openCdp client");
  assert(scriptText.includes("withTimeout"), "KAT must bound execution with withTimeout");
  assert(
    /import\s*\{[^}]*\bfinalizeKatExecution\b[^}]*\}\s*from\s*["']\.\/lib\/kat-finalizer\.ts["']/.test(scriptText),
    "KAT must import finalizeKatExecution from ./lib/kat-finalizer.ts (any formatting)",
  );
  assert(
    /import\s*\{[^}]*\ballocateRunEvidenceDir\b[^}]*\}\s*from\s*["']\.\/lib\/kat-finalizer\.ts["']/.test(scriptText),
    "KAT must import allocateRunEvidenceDir from ./lib/kat-finalizer.ts (any formatting)",
  );
  assert(/\ballocateRunEvidenceDir\(OUT_PARENT\)/.test(scriptText), "the KAT mints OUT via the real allocator");
  const finallyIdx = scriptText.indexOf("finally {");
  assert(finallyIdx > 0, "KAT must contain finally block");
  const finallyBody = scriptText.slice(finallyIdx);
  assert(finallyBody.includes("await finalizeKatExecution("), "the finally block calls the production finalizer");
  assertEquals(
    (scriptText.match(/await finalizeKatExecution\(/g) ?? []).length,
    1,
    "the KAT calls the finalizer EXACTLY once (no duplicate inline teardown/report)",
  );
  assert(!finallyBody.includes("Deno.writeTextFile"), "no report writes inline in the KAT");
  // The ONE inline exit is the failure-derived outcome exit (the suite-honesty
  // scanner's pattern) — never a constant, never a second exit.
  assertEquals(
    (finallyBody.match(/Deno\.exit\(/g) ?? []).length,
    1,
    "exactly one inline exit in the KAT: Deno.exit(outcome.exitCode)",
  );
  assert(finallyBody.includes("Deno.exit(outcome.exitCode)"), "the exit code comes from the finalizer's decision");
});

Deno.test("kat-bistro finalizer: teardownChromeAndProfile executes clean and failure-injected paths correctly", async () => {
  const calls: string[] = [];

  // Helper to mock withTimeout
  const mockWithTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    calls.push(`withTimeout:${ms}`);
    return await promise;
  };

  // Case 1: Clean teardown succeeds with null cleanupError
  calls.length = 0;
  const cleanProc = {
    status: Promise.resolve({ success: true, code: 0 }),
    kill: (sig: number | Deno.Signal) => calls.push(`kill:${sig}`),
  };
  const cleanCdp = {
    send: async (method: string) => {
      calls.push(method);
      return {};
    },
    close: () => calls.push("CDP.close"),
  };
  const resClean = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async (p) => {
      calls.push(`remove:${p}`);
    },
    statFile: async () => false,
  });

  assertEquals(resClean.cleanupError, null);
  assertEquals(resClean.poisonDetected, false);
  assert(calls.includes("Browser.close"));
  assert(calls.includes("CDP.close"));
  assert(calls.includes("remove:/mock/profile"));

  // Case 2: Process hangs after SIGKILL -> status:4000 rejection is NOT swallowed and records cleanupError
  calls.length = 0;
  const hungProc = {
    status: new Promise(() => {}), // never settles
    kill: (sig: number | Deno.Signal) => calls.push(`kill:${sig}`),
  };
  const timeoutFailingWithTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    calls.push(`withTimeout:${ms}`);
    throw new Error(`injected process deadline ${ms}`);
  };

  const resHung = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: hungProc },
    profilePath: "/mock/profile",
    withTimeout: timeoutFailingWithTimeout,
    removeDir: async (p) => {
      calls.push(`remove:${p}`);
    },
    statFile: async () => false,
  });

  assert(resHung.cleanupError !== null, "Hung process must produce non-null cleanupError");
  assert(
    resHung.cleanupError.includes("browser_teardown_failed"),
    "cleanupError must indicate browser teardown failure",
  );
  assert(calls.includes("kill:SIGKILL"));

  // Case 3: Profile removal rejection records cleanupError
  calls.length = 0;
  const resProfileFail = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async () => {
      throw new Error("injected profile removal EPERM");
    },
    statFile: async () => false,
  });

  assert(resProfileFail.cleanupError !== null);
  assert(resProfileFail.cleanupError.includes("profile_cleanup_failed"));

  // Case 4: cdp.close throw does NOT prevent Chrome process kill/status check
  calls.length = 0;
  const throwingCdp = {
    send: async (method: string) => {
      calls.push(method);
      return {};
    },
    close: () => {
      calls.push("CDP.close");
      throw new Error("injected CDP transport crash");
    },
  };
  const resCdpCrash = await teardownChromeAndProfile({
    cdp: throwingCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async (p) => {
      calls.push(`remove:${p}`);
    },
    statFile: async () => false,
  });

  assert(resCdpCrash.cleanupError !== null);
  assert(resCdpCrash.cleanupError.includes("cdp_close_failed"));
  assert(calls.includes("CDP.close"));
  assert(
    calls.includes("withTimeout:8000"),
    "Chrome status check MUST still execute after cdp.close fails",
  );
  assert(calls.includes("remove:/mock/profile"), "Profile cleanup MUST still execute");

  // Case 5: Non-NotFound statFile error (e.g. EACCES / I/O) is NOT ignored and records cleanupError
  calls.length = 0;
  const resStatError = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async () => {},
    statFile: async () => {
      throw new Error("EACCES: permission denied");
    },
  });

  assert(resStatError.cleanupError !== null);
  assert(
    resStatError.cleanupError.includes("poison_stat_failed"),
    "statFile failure must append poison_stat_failed",
  );

  // Case 6: Poison slot detection
  const resPoison = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async () => {},
    statFile: async () => true, // poison file exists
  });

  assertEquals(resPoison.poisonDetected, true);
  assert(resPoison.cleanupError !== null);
  assert(resPoison.cleanupError.includes("poison_slot_detected"));
});

function makeSeams(overrides = {}) {
  const calls = [];
  const files = new Map();
  const exits = [];
  const infos = [];
  const errors = [];
  const seams = {
    cdp: {
      send: async (m) => { calls.push(`cdp:${m}`); return {}; },
      close: () => calls.push("cdp:close"),
    },
    chrome: {
      proc: {
        status: Promise.resolve({ success: true, code: 0 }),
        kill: (sig) => calls.push(`kill:${sig}`),
      },
    },
    profilePath: "/mock/profile",
    withTimeout: (p) => p,
    removeDir: async (p) => calls.push(`remove:${p}`),
    statFile: async () => false,
    writeTextFile: async (path, text) => {
      calls.push(`write:${path}`);
      files.set(path, text);
    },
    stageReport: async (path, payload) => {
      calls.push(`stage:${path}`);
      files.set(path, payload);
      return { dev: 1, ino: 42, size: payload.length };
    },
    readReportFile: async (path) => {
      calls.push(`readback:${path}`);
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    renameReportFile: async (from, to) => {
      calls.push(`rename:${from}->${to}`);
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    statReportFile: async (path) => {
      calls.push(`stat:${path}`);
      if (!files.has(path)) return null;
      return { dev: 1, ino: 42, size: files.get(path).length };
    },
    syncReportDir: async (dir) => {
      calls.push(`syncdir:${dir}`);
    },
    removeReportFile: async (path) => {
      calls.push(`rm:${path}`);
      files.delete(path);
    },
    exit: (code) => exits.push(code),
    logError: (...parts) => errors.push(parts.map(String).join(" ")),
    logInfo: (...parts) => infos.push(parts.map(String).join(" ")),
    ...overrides,
  };
  return { calls, files, exits, infos, errors, seams };
}

function finalizeWith(seams, { runError = null, checks = PASSING_CHECKS } = {}) {
  const { calls: _c, files: _f, exits: _e, infos: _i, seams: s } = seams;
  return finalizeKatExecution({
    runError,
    checks,
    teardown: {
      cdp: s.cdp,
      chrome: s.chrome,
      profilePath: s.profilePath,
      withTimeout: s.withTimeout,
      removeDir: s.removeDir,
      statFile: s.statFile,
    },
    report: REPORT,
    writeTextFile: s.writeTextFile,
    stageReport: s.stageReport,
    readReportFile: s.readReportFile,
    renameReportFile: s.renameReportFile,
    statReportFile: s.statReportFile,
    syncReportDir: s.syncReportDir,
    removeReportFile: s.removeReportFile,
    exit: s.exit,
    logError: s.logError,
    logInfo: s.logInfo,
  });
}

Deno.test("kat-bistro caller: clean run — staged, fsynced, atomically published, verified GREEN with the receipt path", async () => {
  const seams = makeSeams();
  const result = await finalizeWith(seams);
  assertEquals(result.state, "GREEN");
  assertEquals(result.exitCode, 0);
  assertEquals(result.reportError, null);
  assertEquals(result.receiptPath, "/mock/out/result.json");
  assertEquals(seams.exits.length, 0, "a GREEN run never exits nonzero");
  const logWrite = seams.calls.indexOf("write:/mock/out/kat.log");
  const stage = seams.calls.findIndex((c) => c.startsWith("stage:/mock/out/result.json."));
  assert(logWrite >= 0 && stage > logWrite, "kat.log is written BEFORE the result stage");
  const tmpPath = seams.calls[stage].slice("stage:".length);
  assert(/result\.json\.[0-9a-f-]{36}\.tmp$/.test(tmpPath), "the stage is a FULL-UUID unique temp");
  assert(seams.calls.includes(`readback:${tmpPath}`), "the staged temp is read back exactly before publish");
  assert(seams.calls.includes(`rename:${tmpPath}->/mock/out/result.json`), "the publish is an atomic rename");
  assert(seams.calls.includes("syncdir:/mock/out"), "the directory entry is fsynced after the rename");
  assert(seams.calls.includes("readback:/mock/out/result.json"), "the published receipt is verified");
  assert(seams.files.has("/mock/out/result.json"));
  assert(!seams.files.has(tmpPath), "the temp is consumed by the rename");
  assertEquals(JSON.parse(seams.files.get("/mock/out/result.json")).state, "GREEN");
  assert(seams.files.get("/mock/out/kat.log").includes("RESULT: 1/1; GREEN"));
  assert(!seams.calls.some((c) => c.startsWith("rm:")), "no deletion on the success path");
});

Deno.test("kat-bistro caller: teardown cleanup failure forces RED + exit 1, receipt published RED", async () => {
  const seams = makeSeams({
    removeDir: async () => { throw new Error("injected profile removal EPERM"); },
  });
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED");
  assert(result.cleanupError?.includes("profile_cleanup_failed"));
  assertEquals(result.exitCode, 1);
  assertEquals(seams.exits, [1]);
  const resultJson = JSON.parse(seams.files.get("/mock/out/result.json"));
  assertEquals(resultJson.state, "RED");
  assert(String(resultJson.error ?? "").includes("profile_cleanup_failed"));
});

Deno.test("kat-bistro caller: poison detection forces RED + exit 1", async () => {
  const seams = makeSeams({ statFile: async () => true });
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED");
  assertEquals(result.poisonDetected, true);
  assertEquals(result.exitCode, 1);
  assertEquals(seams.exits, [1]);
});

Deno.test("kat-bistro caller: a run error forces RED + exit 1", async () => {
  const seams = makeSeams();
  const result = await finalizeWith(seams, { runError: "boom" });
  assertEquals(result.state, "RED");
  assertEquals(seams.exits, [1]);
  assertEquals(JSON.parse(seams.files.get("/mock/out/result.json")).error, "boom");
});

Deno.test("kat-bistro caller: a FAILED check forces RED + exit 1", async () => {
  const seams = makeSeams();
  const result = await finalizeWith(seams, { checks: [{ name: "c1", passed: false }] });
  assertEquals(result.state, "RED");
  assertEquals(seams.exits, [1]);
});

Deno.test("kat-bistro caller: kat.log write failure folds into RED, the result publishes RED, exit 1", async () => {
  const seams = makeSeams({
    writeTextFile: async (path, text) => {
      seams.calls.push(`write:${path}`);
      if (path.endsWith("kat.log")) throw new Error("injected log ENOSPC");
      seams.files.set(path, text);
    },
  });
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED");
  assert(result.reportError?.includes("ENOSPC"));
  assertEquals(seams.exits, [1]);
  const resultJson = JSON.parse(seams.files.get("/mock/out/result.json"));
  assertEquals(resultJson.state, "RED");
  assert(String(resultJson.error).includes("kat_log_write_failed"));
});

Deno.test("kat-bistro caller: prior GREEN + stage-open failure — RED, exit 1, NO receipt claimed, the prior file untouched", async () => {
  const seams = makeSeams({
    stageReport: async (path, payload) => {
      seams.calls.push(`stage:${path}`);
      throw new Error("EACCES read-only dir");
    },
    removeReportFile: async () => { throw new Error("removal fails too"); }, // removal is never load-bearing
  });
  // A PRIOR run's GREEN sits in the (reused) dir.
  seams.files.set("/mock/out/result.json", JSON.stringify({ state: "GREEN", head: "prior-run" }));
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED");
  assertEquals(result.exitCode, 1);
  assertEquals(seams.exits[0], 1);
  assertEquals(result.receiptPath, null, "THIS run claims no receipt");
  // The prior file is not this run's receipt — untouched, never announced by this run.
  assert(JSON.parse(seams.files.get("/mock/out/result.json")).head === "prior-run");
  assert(!seams.infos.some((t) => t.includes("KAT receipt:")), "no receipt line on failure");
});

Deno.test("kat-bistro caller: temp write emits bytes THEN rejects (partial and full) — nothing publishes, RED + exit 1, removal failure changes nothing", async () => {
  for (const full of [false, true]) {
    const seams = makeSeams({
      stageReport: async (path, payload) => {
        seams.calls.push(`stage:${path}`);
        seams.files.set(path, full ? payload : payload.slice(0, 40)); // bytes land…
        throw new Error("injected write-then-reject"); // …then the stage rejects
      },
      removeReportFile: async () => { throw new Error("rm EBUSY"); }, // removal failure must not matter
    });
    const result = await finalizeWith(seams);
    assertEquals(result.state, "RED", `write-then-reject (full=${full})`);
    assertEquals(result.exitCode, 1);
    assert(!seams.files.has("/mock/out/result.json"));
    assertEquals(result.receiptPath, null);
  }
});

Deno.test("kat-bistro caller: rename rejects AFTER effect — exact content readback ACKNOWLEDGES the commit (never RED beside GREEN)", async () => {
  const seams = makeSeams();
  seams.seams.renameReportFile = async (from, to) => {
    seams.calls.push(`rename:${from}->${to}`);
    seams.files.set(to, seams.files.get(from)); // the effect happens…
    seams.files.delete(from);
    throw new Error("injected rename reject after effect"); // …then rejects
  };
  const result = await finalizeWith(seams);
  assertEquals(result.state, "GREEN", "the committed-but-rejected publish is acknowledged via exact content readback");
  assertEquals(result.exitCode, 0);
  assertEquals(seams.exits.length, 0);
  assert(seams.files.has("/mock/out/result.json"));
  assertEquals(result.receiptPath, "/mock/out/result.json");
});

Deno.test("kat-bistro caller: rename rejects, read THROWS, matching staged inode → ACK via identity", async () => {
  const seams = makeSeams();
  seams.seams.stageReport = async (path, payload) => {
    seams.calls.push(`stage:${path}`);
    seams.files.set(path, payload);
    return { dev: 1, ino: 42, size: payload.length };
  };
  seams.seams.renameReportFile = async (from, to) => {
    seams.calls.push(`rename:${from}->${to}`);
    seams.files.set(to, seams.files.get(from));
    seams.files.delete(from);
    throw new Error("injected rename reject after effect");
  };
  // The final read is UNAVAILABLE (throws), the stat reports the staged inode.
  seams.seams.readReportFile = async (path) => {
    seams.calls.push(`readback:${path}`);
    if (path === "/mock/out/result.json") throw new Error("EIO on final read");
    if (!seams.files.has(path)) throw new Error(`ENOENT ${path}`);
    return seams.files.get(path);
  };
  // The staged identity's size must equal the payload for the identity check.
  let stagedSize = 0;
  seams.seams.stageReport = async (path, payload) => {
    seams.calls.push(`stage:${path}`);
    seams.files.set(path, payload);
    stagedSize = payload.length;
    return { dev: 1, ino: 42, size: payload.length };
  };
  seams.seams.statReportFile = async (path) => {
    if (path === "/mock/out/result.json") return { dev: 1, ino: 42, size: stagedSize };
    return null;
  };
  const result = await finalizeWith(seams);
  assertEquals(result.state, "GREEN", "unavailable read + matching staged inode ACKs the committed publication");
  assertEquals(seams.exits.length, 0);
});

Deno.test("kat-bistro caller: rename rejects, read throws, inode ABSENT or MISMATCHED → RED, no authoritative result", async () => {
  for (const stat of [null, { dev: 9, ino: 99, size: 1 }]) {
    const seams = makeSeams();
    seams.seams.stageReport = async (path, payload) => {
      seams.calls.push(`stage:${path}`);
      seams.files.set(path, payload);
      return { dev: 1, ino: 42, size: payload.length };
    };
    seams.seams.renameReportFile = async () => { throw new Error("rename failed, no effect"); };
    seams.seams.readReportFile = async (path) => {
      if (path === "/mock/out/result.json") throw new Error("EIO");
      if (!seams.files.has(path)) throw new Error(`ENOENT ${path}`);
      return seams.files.get(path);
    };
    seams.seams.statReportFile = async () => stat;
    const result = await finalizeWith(seams);
    assertEquals(result.state, "RED", `inode ${stat === null ? "absent" : "mismatched"} never ACKs`);
    assertEquals(result.exitCode, 1);
    assert(!seams.files.has("/mock/out/result.json"));
    assertEquals(result.receiptPath, null);
  }
});

// qml6: the sibling test above throws on EVERY read of result.json, so its (d)
// post-publish verification read throws too and guard (d) decides the outcome.
// That leaves guard (b)'s inode-identity check unpinned: moving `committed = true`
// BEFORE the atomic rename keeps the whole suite GREEN while turning a foreign,
// byte-identical prior receipt into an announced GREEN. This test closes exactly
// that window — the (b) read is unavailable, the inode is FOREIGN, and the (d)
// read SUCCEEDS with matching bytes, so guard (b) is the only thing left.
Deno.test("kat-bistro caller: rename rejects, the (b) read is UNAVAILABLE, the inode is FOREIGN and the (d) read SUCCEEDS with matching bytes — RED, nothing announced (qml6)", async () => {
  const seams = makeSeams();
  let stagedPayload = "";
  let resultReads = 0;
  seams.seams.stageReport = async (path, payload) => {
    seams.calls.push(`stage:${path}`);
    seams.files.set(path, payload);
    // Capture the EXACT payload so the (d) read can return byte-identical
    // content: the receipt is a deterministic function of the run's identity
    // fields, so a prior run of the same commit in a REUSED outDir leaves a
    // byte-identical GREEN behind. Only the inode says whose file this is.
    stagedPayload = payload;
    return { dev: 1, ino: 42, size: payload.length };
  };
  seams.seams.renameReportFile = async () => {
    seams.calls.push("rename:rejected");
    throw new Error("EXDEV: rename rejected, no effect");
  };
  seams.seams.readReportFile = async (path) => {
    seams.calls.push(`readback:${path}`);
    if (path === "/mock/out/result.json") {
      resultReads++;
      // (b) reconciliation read: UNAVAILABLE — a transient error, so there are
      // no contradictory bytes and the inode identity must decide.
      if (resultReads === 1) throw new Error("EIO: transient read failure");
      // (d) post-publish verification read: SUCCEEDS, bytes match exactly.
      return stagedPayload;
    }
    if (!seams.files.has(path)) throw new Error(`ENOENT ${path}`);
    return seams.files.get(path);
  };
  // The file at result.json is NOT this run's staged temp. Size matches (the
  // prior receipt is byte-identical) — dev/ino do not, and size alone must never
  // authorize an ACK.
  seams.seams.statReportFile = async (path) => {
    seams.calls.push(`stat:${path}`);
    return { dev: 9, ino: 99, size: stagedPayload.length };
  };

  const result = await finalizeWith(seams);

  assertEquals(
    result.state,
    "RED",
    "a FOREIGN inode never ACKs a rejected rename, not even when the (d) read matches byte-for-byte",
  );
  assertEquals(result.exitCode, 1);
  assert(seams.exits.includes(1), "the fail-closed exit seam fires with 1");
  assertEquals(result.receiptPath, null, "no receipt is attributable to this run");
  assert(
    !seams.infos.some((line) => /KAT receipt:/i.test(line)),
    "no receipt path is ever announced on a failed publication",
  );
  assert(
    seams.calls.some((c) => c === "stat:/mock/out/result.json"),
    "guard (b) actually consulted the inode identity — the mutant skips this call",
  );
  assert(
    !seams.errors.some((line) => /reconciled to committed/i.test(line)),
    "a rejected rename against a foreign inode is never logged as reconciled-to-committed",
  );
});

Deno.test("kat-bistro caller: rename rejects and the final read returns CONTRADICTORY bytes — RED (corruption), the inode is never consulted", async () => {
  const seams = makeSeams();
  seams.seams.stageReport = async (path, payload) => {
    seams.calls.push(`stage:${path}`);
    seams.files.set(path, payload);
    return { dev: 1, ino: 42, size: payload.length };
  };
  seams.seams.renameReportFile = async (from, to) => {
    seams.calls.push(`rename:${from}->${to}`);
    seams.files.set(to, "{\"state\":\"GREEN\",\"corrupt\":true}\n"); // contradictory bytes land
    seams.files.delete(from);
    throw new Error("injected rename reject after effect");
  };
  // The staged inode WOULD match — it must not matter: contradictory bytes are corruption.
  seams.seams.statReportFile = async (path) => path === "/mock/out/result.json" ? { dev: 1, ino: 42, size: 0 } : null;
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED", "a positive mismatching read is corruption — the inode never ACKs it");
  assertEquals(result.exitCode, 1);
  assertEquals(result.receiptPath, null);
});

Deno.test("kat-bistro caller: resolved rename + post-publish byte MISMATCH is RED even with a matching inode", async () => {
  const seams = makeSeams();
  seams.seams.stageReport = async (path, payload) => {
    seams.calls.push(`stage:${path}`);
    seams.files.set(path, payload);
    return { dev: 1, ino: 42, size: payload.length };
  };
  seams.seams.readReportFile = async (path) => {
    seams.calls.push(`readback:${path}`);
    if (path === "/mock/out/result.json") return "{\"corrupted\":true}\n"; // contradictory bytes
    if (!seams.files.has(path)) throw new Error(`ENOENT ${path}`);
    return seams.files.get(path);
  };
  seams.seams.statReportFile = async () => ({ dev: 1, ino: 42, size: 1 }); // would "match" — must not matter
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED", "contradictory published bytes are corruption — RED regardless of inode");
  assertEquals(result.exitCode, 1);
});

Deno.test("kat-bistro caller: resolved rename + post-publish read UNAVAILABLE + matching inode → ACK; absent/mismatched → RED", async () => {
  for (const stat of [{ dev: 1, ino: 42, size: -1 }, null]) {
    const seams = makeSeams();
    let stagedPayload = "";
    seams.seams.stageReport = async (path, payload) => {
      seams.calls.push(`stage:${path}`);
      seams.files.set(path, payload);
      stagedPayload = payload;
      return { dev: 1, ino: 42, size: payload.length };
    };
    seams.seams.readReportFile = async (path) => {
      seams.calls.push(`readback:${path}`);
      if (path === "/mock/out/result.json") throw new Error("EIO on post-publish read");
      if (!seams.files.has(path)) throw new Error(`ENOENT ${path}`);
      return seams.files.get(path);
    };
    seams.seams.statReportFile = async (path) => {
      if (path !== "/mock/out/result.json") return null;
      if (stat === null) return null;
      return { ...stat, size: stagedPayload.length };
    };
    const result = await finalizeWith(seams);
    if (stat && stat.dev === 1 && stat.ino === 42) {
      assertEquals(result.state, "GREEN", "unavailable read + matching inode ACKs");
      assertEquals(result.exitCode, 0);
    } else {
      assertEquals(result.state, "RED", "absent/foreign inode never ACKs");
      assertEquals(result.exitCode, 1);
    }
  }
});

Deno.test("kat-bistro caller: a PERSISTENT directory-sync failure is honest RED (content committed, not durable); transient retries succeed", async () => {
  // Persistent failure → RED, and the reportError names the dir-sync barrier.
  const persistent = makeSeams({ syncReportDir: async () => { throw new Error("syncfs EIO"); } });
  const r1 = await finalizeWith(persistent);
  assertEquals(r1.state, "RED", "no durable GREEN without the dir barrier");
  assert(r1.reportError?.includes("result_dir_sync_failed"));
  assertEquals(persistent.exits[0], 1);
  // Transient failure then success → GREEN.
  let attempts = 0;
  const transient = makeSeams({
    syncReportDir: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
    },
  });
  const r2 = await finalizeWith(transient);
  assertEquals(r2.state, "GREEN", "a transient dir-sync failure reconciles within the bound");
  assertEquals(attempts, 2, "retried, then succeeded");
});

Deno.test("kat-bistro caller: an exit seam that RETURNS cannot yield a returned GREEN (publish failure)", async () => {
  const seams = makeSeams({
    stageReport: async () => { throw new Error("injected EIO"); },
  });
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED", "a returned exit seam never yields GREEN after a publish failure");
  assertEquals(result.exitCode, 1);
  assert(result.reportError && result.reportError.length <= 512, "reportError is recorded, bounded");
  assertEquals(result.receiptPath, null);
});

Deno.test("kat-bistro caller: no publish/sync failure ever ANNOUNCES a receipt path", async () => {
  for (const overrides of [
    { stageReport: async () => { throw new Error("EIO"); } },
    { renameReportFile: async () => { throw new Error("rename EIO no effect"); }, readReportFile: async (p) => { if (!p.endsWith(".tmp")) throw new Error("EIO"); const f = arguments; throw new Error("EIO"); } },
    { syncReportDir: async () => { throw new Error("syncfs EIO"); } },
  ]) {
    const seams = makeSeams(overrides);
    await finalizeWith(seams);
    assert(!seams.infos.some((t) => t.includes("KAT receipt:")), "no receipt line on failure");
    assert(!seams.infos.some((t) => /evidence \//.test(t)), "no evidence-path announcement before authority");
  }
});

Deno.test("kat-bistro stager: the REAL stageReceiptFile on a durable temp — exact bytes, identity, createNew refusal, no-progress guard", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kat-stage-" });
  try {
    const tmp = `${dir}/result.json.t1.tmp`;
    const payload = JSON.stringify({ state: "GREEN", head: "h1" }) + "\n";
    const identity = await stageReceiptFile(tmp, payload);
    assertEquals(identity.size, payload.length, "the stat identity size is the exact payload length");
    assert(typeof identity.ino === "number" && identity.ino !== null, "this host reports inodes (Linux)");
    assertEquals(await Deno.readTextFile(tmp), payload, "the staged bytes are exact");
    // createNew refuses a second stage at the same path (O_EXCL).
    await assertRejects(() => stageReceiptFile(tmp, payload), Error, "");
    // The no-progress guard: an injected writer that reports 0 bytes fails closed.
    await assertRejects(
      () =>
        stageReceiptFile(`${dir}/result.json.t2.tmp`, payload, {
          openFile: async () => ({
            writeSync: () => 0,
            sync: async () => {},
            stat: async () => ({ dev: 1, ino: 7, size: 0 }),
            close: () => {},
          }),
        }),
      Error,
      "result_stage_write_no_progress",
    );
    // The suite detects a fsync/write-all deletion: the production body MUST
    // carry the durability barrier and the loop (a mutation removing them is
    // caught here, source-level, because behavior cannot observe fsync).
    const src = await Deno.readTextFile(`${root}/scripts/lib/kat-finalizer.ts`);
    assert(src.includes("await file.sync()"), "the real stager must fsync (the durability barrier)");
    assert(src.includes("result_stage_write_no_progress"), "the real stager must guard no-progress writes");
    assert(src.includes("createNew: true"), "the real stager must open O_EXCL (createNew)");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("kat-bistro allocator BEHAVIOR (ljh0): the real allocator — recording seams, distinct full-UUID children, exclusive-collision refusal", async () => {
  const mkdirCalls = [];
  // Repeated REAL calls (the real crypto.randomUUID): distinct full-UUID children.
  const a = await allocateRunEvidenceDir("/mock/parent", {
    mkdirParent: async (p) => mkdirCalls.push(`parent:${p}`),
    mkdirExclusive: async (p) => mkdirCalls.push(`exclusive:${p}`),
  });
  const b = await allocateRunEvidenceDir("/mock/parent", {
    mkdirParent: async (p) => mkdirCalls.push(`parent:${p}`),
    mkdirExclusive: async (p) => mkdirCalls.push(`exclusive:${p}`),
  });
  assert(a !== b, "two invocations mint DISTINCT children");
  for (const child of [a, b]) {
    assert(/\/run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(child), `full UUID child: ${child}`);
    assert(child.startsWith("/mock/parent/"), "the child is contained in the exact parent");
  }
  assertEquals(mkdirCalls.filter((c) => c.startsWith("parent:")).length, 2, "the parent mkdir ran per call");
  assertEquals(mkdirCalls.filter((c) => c.startsWith("exclusive:")).length, 2, "the child create is the EXCLUSIVE mkdir — removing it is caught here");
  // Collision: the exclusive create throws BEFORE any path is returned.
  let threw = null;
  try {
    await allocateRunEvidenceDir("/mock/parent", {
      mkdirParent: async () => {},
      mkdirExclusive: async () => {
        const e = new Error("already exists");
        e.name = "AlreadyExists";
        throw e;
      },
    });
  } catch (e) { threw = e; }
  assert(threw?.name === "AlreadyExists", "a collision refuses — never aliases");
});

Deno.test("kat-bistro stager BEHAVIOR (ljh0): the real stageReceiptFile — partial-write fake records the exact byte stream + strict sync→stat→close ordering; zero-progress fails closed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kat-stage-behavior-" });
  try {
    const payload = JSON.stringify({ state: "GREEN", note: "x".repeat(64) }) + "\n";
    const order = [];
    let assembled = new Uint8Array(0);
    const fakeFile = {
      writeSync: (chunk) => {
        // Force 3-byte PARTIAL writes and accumulate the true byte stream.
        const piece = chunk.subarray(0, Math.min(3, chunk.length));
        const next = new Uint8Array(assembled.length + piece.length);
        next.set(assembled); next.set(piece, assembled.length);
        assembled = next;
        order.push(`write:${piece.length}`);
        return piece.length;
      },
      sync: async () => { order.push("sync"); },
      stat: async () => {
        order.push("stat");
        return { dev: 1, ino: 7, size: assembled.length };
      },
      close: () => order.push("close"),
    };
    const identity = await stageReceiptFile(`${dir}/s1.tmp`, payload, { openFile: async () => fakeFile });
    assertEquals(new TextDecoder().decode(assembled), payload, "the write-all loop assembles the exact payload from partial writes");
    assertEquals(identity.size, payload.length);
    assert(order[order.length - 3] === "sync" && order[order.length - 2] === "stat" && order[order.length - 1] === "close",
      `strict ordering sync→stat→close (got ${order.slice(-3).join(",")})`);
    // Zero progress fails closed — and the guard error is the named one (a
    // mutant without the guard hits the fake's safety valve instead = RED here).
    let guardError = null;
    const zeroFile = {
      writeSync: (chunk) => { order.push("write0"); if (order.filter((c) => c === "write0").length > 50) throw new Error("SAFETY-VALVE (the guard is missing)"); return 0; },
      sync: async () => {}, stat: async () => ({ dev: 1, ino: 7, size: 0 }), close: () => {},
    };
    try {
      await stageReceiptFile(`${dir}/s2.tmp`, payload, { openFile: async () => zeroFile });
    } catch (e) { guardError = e; }
    assert(guardError, "zero progress must throw");
    assert(String(guardError.message).includes("result_stage_write_no_progress"), `the guard error, not the safety valve: ${guardError?.message}`);
    // createNew collision propagates.
    await assertRejects(
      () => stageReceiptFile(`${dir}/s3.tmp`, payload, { openFile: async () => { const e = new Error("already exists"); e.name = "AlreadyExists"; throw e; } }),
      Error, "",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("kat-bistro ll7q: publication logs never carry run paths — before OR without the locator", async () => {
  // The sanitizer: internal codes pass through (path-free by construction);
  // foreign OS errors lose every path token.
  assertEquals(sanitizeKatLogError(new Error("result_dir_sync_failed: Error: syncfs EIO")).includes("/"), false, "internal code stays path-free");
  const foreign = new Error("ENOENT: no such file or directory, open '/mock/out/run-abc/result.json.x.tmp'");
  assertEquals(sanitizeKatLogError(foreign).includes("/mock/out"), false, "foreign error paths are stripped");
  assert(sanitizeKatLogError(foreign).includes("[path]"), "the placeholder marks the removal");
  // End-to-end: a publish failure logs NOTHING containing the out dir, and no
  // receipt line is emitted.
  const seams = makeSeams({ stageReport: async () => { throw new Error("EACCES open '/mock/out/result.json.t.tmp'"); } });
  const result = await finalizeWith(seams);
  assertEquals(result.state, "RED");
  assertEquals(result.receiptPath, null);
  assert(!seams.errors.some((t) => t.includes("/mock/out")), "no log carries the run path");
  assert(!seams.infos.some((t) => t.includes("KAT receipt:")), "no receipt line on failure");
});

Deno.test("kat-bistro allocator BEHAVIOR (real default FS): absent nested parent created recursively, full-UUID child exists, repeat uniqueness, cleanup", async () => {
  const tmpRoot = await Deno.makeTempDir({ prefix: "kat-alloc-real-" });
  try {
    const absentParent = `${tmpRoot}/nested-absent-parent/evidence`;
    const child1 = await allocateRunEvidenceDir(absentParent);
    // The ABSENT parent is created recursively by the real default seams.
    assert((await Deno.stat(absentParent)).isDirectory, "the parent exists after the call");
    // The child exists, is a directory, is contained, and is a full-UUID child.
    assert((await Deno.stat(child1)).isDirectory, "the child dir exists");
    assert(child1.startsWith(absentParent + "/"), "the child is contained in the parent");
    assert(/\/run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(child1), `full-UUID child: ${child1}`);
    // Repeat: a second call mints a DIFFERENT fresh child (real crypto.randomUUID).
    const child2 = await allocateRunEvidenceDir(absentParent);
    assert(child2 !== child1, "repeat mints a distinct fresh child");
    assert((await Deno.stat(child2)).isDirectory);
    // Collision refusal at the DEFAULT seams: minting the SAME child must refuse.
    // (prove via the exclusive-create contract on the real FS: mkdir on an
    // existing dir is an error path in the exclusive seam — driven through the
    // recording seams below to assert it is the exclusive call that refuses.)
    const seen = [];
    await assertRejects(
      () => allocateRunEvidenceDir(absentParent, {
        mkdirParent: async () => {},
        mkdirExclusive: async (p) => {
          seen.push(p);
          throw Object.assign(new Error("already exists"), { name: "AlreadyExists" });
        },
      }),
      Error,
      "already exists",
    );
    assert(seen.length === 1, "the exclusive create is what refuses the collision");
  } finally {
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("kat-bistro stager BEHAVIOR: an injected file.sync() rejection fails closed — rejection propagates, stat is NOT called, close IS called", async () => {
  const order = [];
  const syncFailingFile = {
    writeSync: (chunk) => { order.push("write"); return chunk.length; },
    sync: async () => { order.push("sync"); throw new Error("injected_fsync_eio"); },
    stat: async () => { order.push("stat"); return { dev: 1, ino: 1, size: 0 }; },
    close: () => order.push("close"),
  };
  await assertRejects(
    () => stageReceiptFile("/mock/tmp", "payload", { openFile: async () => syncFailingFile }),
    Error,
    "injected_fsync_eio",
  );
  assert(!order.includes("stat"), "stat must NOT be called when sync fails (unverified durability is never inspected)");
  assert(order.includes("close"), "close MUST run in finally even when sync fails");
  assert(order.indexOf("close") === order.length - 1, "close is the LAST call");
});

Deno.test("kat-bistro ll7q sanitizer VARIANTS: whitespace paths, Windows backslashes, relative run paths — all masked", () => {
  const cases = [
    ["ENOENT: open '/home/paul kinlan/cap/run-1234/result.json' failed", "/home/paul kinlan", "whitespace inside the path"],
    ["Error: ENOENT, open 'C:\\Users\\paul\\cap\\run-1234'", "C:\\Users\\paul", "Windows drive-letter backslashes"],
    ["failed at \\mock\\out\\run-1234\\result.json", "\\mock\\out", "Windows UNC-style backslashes"],
    ["writing run-11111111-2222-3333-4444-555555555555/result.json failed", "run-11111111-2222-3333-4444-555555555555", "relative run path"],
    ["temp result.json.11111111-2222-3333-4444-555555555555.tmp rejected", "result.json.11111111-2222-3333-4444-555555555555.tmp", "relative tmp result path"],
  ];
  for (const [input, leak, label] of cases) {
    const out = sanitizeKatLogError(new Error(input));
    assert(!out.includes(leak), `${label} leaked: ${JSON.stringify(out)}`);
    assert(out.includes("[path]"), `${label} should carry the placeholder: ${JSON.stringify(out)}`);
  }
});
