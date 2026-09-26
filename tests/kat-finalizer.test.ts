// tests/kat-finalizer.test.ts — Consolidated verification of scripts/lib/kat-finalizer.ts (chrome-agent-platform-3a16)
//
// Consolidates the three KAT finalizer test suites into one authoritative home:
//   1. Core finalizer sequence, ordering, teardown, lock/poison hygiene, and caller binding (27 tests from kat-bistro-finalizer)
//   2. Mutation-surviving guard pins: ladder, exclusive create, poison stat, log bounds, A2 poison-isolation (16 tests from kat-finalizer-guards)
//   3. Report-order log residue cleanup pins (4 tests from kat-finalizer-log-residue)
// Total: 47 tests, keeping every assertion byte-identical.
// @ts-nocheck

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  allocateRunEvidenceDir,
  finalizeKatExecution,
  sanitizeKatLogError,
  stageReceiptFile,
  teardownChromeAndProfile,
} from "../scripts/lib/kat-finalizer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

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
  // chrome-agent-platform-cvlf: the caller's decision units live in
  // lib/kat-bistro-caller.ts and are EXECUTED by tests/kat-bistro-caller.test.ts
  // (settleBistroRun runs the production finalizer exactly once, ordered, with
  // the failure-derived exit — behavioural pins). This check stays as the
  // WIRING integrity pin: the script wires the extracted unit, and the unit
  // imports the production finalizer + allocator (never a simulated evaluator).
  const scriptText = await Deno.readTextFile(`${root}/scripts/kat-webmcp-bistro.ts`);
  // chrome-agent-platform-uodl: this was `assert(scriptText.includes("?toolautosubmit"))`.
  // The URL construction moved to lib/kat-bistro-caller.ts, so in THIS file the
  // token occurs only in the header comment (:4) and a console.log (:124). Mutant
  // U-U1p removed the flag from URL_BISTRO and this assertion still passed — 27/0.
  // The flag is now pinned where it is built, by tests/kat-bistro-caller.test.ts
  // ("the demo URL carries the toolautosubmit flag (U1)"), which DID kill U-U1p.
  // So this file keeps the property it can actually prove about wiring: the demo
  // URL has ONE source of truth and never grows a second copy here.
  assert(!/french-bistro/.test(scriptText), "the demo URL has one source of truth — URL_BISTRO in lib/kat-bistro-caller.ts, pinned there");
  assert(scriptText.includes("openCdp"), "KAT must use canonical openCdp client");
  assert(
    /import\s*\{[^}]*\bsettleBistroRun\b[^}]*\}\s*from\s*["']\.\/lib\/kat-bistro-caller\.ts["']/.test(scriptText),
    "KAT must wire the extracted settle unit from ./lib/kat-bistro-caller.ts (any formatting)",
  );
  assert(/\bsettleBistroRun\(\{/.test(scriptText), "the finally block delegates to the extracted settle unit");
  assert(!/\bDeno\.exit\(/.test(scriptText), "the script owns NO inline exit — the settle unit derives it from the finalizer decision");

  const libText = await Deno.readTextFile(`${root}/scripts/lib/kat-bistro-caller.ts`);
  assert(
    /import\s*\{[^}]*\bfinalizeKatExecution\b[^}]*\}\s*from\s*["']\.\/kat-finalizer\.ts["']/.test(libText),
    "the settle unit imports the PRODUCTION finalizer (any formatting)",
  );
  assert(
    /import\s*\{[^}]*\ballocateRunEvidenceDir\b[^}]*\}\s*from\s*["']\.\/kat-finalizer\.ts["']/.test(libText),
    "the evidence-dir unit defaults to the PRODUCTION allocator (any formatting)",
  );
  assertEquals(
    (libText.match(/await finalize\(/g) ?? []).length,
    1,
    "the settle unit calls the finalizer EXACTLY once (no duplicate inline teardown/report)",
  );
  assertEquals(
    (libText.match(/exit\(outcome\.exitCode\)/g) ?? []).length,
    1,
    "exactly one decision-derived exit in the settle unit: exit(outcome.exitCode)",
  );
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


// ============================================================================
// 2. KAT Finalizer Guards (from tests/kat-finalizer-guards.test.ts — 2b6a + 23r0 A2)
// ============================================================================

const scratchGuards = () => mkdtemp(join(durableDir("scratch") + "/", "cap-finalizer-guards-"));

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
    // `checks` is overridable so a case can exercise the zero-check guard; the
    // default keeps every other test's single passing check.
    checks: over.checks ?? [{ name: "c1", passed: true }],
    // The function form is passed THROUGH, not spread: it is the seam for an
    // outcome the teardown options cannot express (a poisoned slot with no
    // cleanup error — the A2 pin below).
    teardown: typeof over.teardown === "function" ? over.teardown : {
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
  const parent = await scratchGuards();
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
  const dir = await scratchGuards();
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

// ── (A2) a poisoned slot is RED INDEPENDENTLY of cleanupError ──────────────────
// The sweep's mutant A2 (removing `!poisonDetected` from `isGreen`) survived both
// the committed suite and a 19-input divergence probe: the teardown OPTIONS can
// only ever produce poison WITH a cleanup error (the poison branch records both),
// so `!cleanupError` already forced RED and the clause was untestable. The function
// form of `teardown` is the missing input, and this pins the clause itself.
Deno.test("kat-finalizer guards: a POISONED slot is RED independently of cleanupError (A2)", async () => {
  const k = seams();
  const r = await finalize(k, { teardown: async () => ({ cleanupError: null, poisonDetected: true }) });
  assertEquals(r.poisonDetected, true, "the poison must reach the result, or this test proves nothing");
  assertEquals(r.cleanupError, null, "and this case must carry NO cleanup error, or it re-tests the coupling instead");
  assertEquals(r.state, "RED", "a poisoned slot is RED even when every other field is clean");
  assertEquals(r.exitCode, 1);
  assert(k.exits.includes(1), "the fail-closed exit fires");
  assertEquals(JSON.parse(k.payload()).state, "RED", "and the published receipt says so");
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

// ── 3yfs: the two remaining false-GREEN holes, found by an independent probe
// (cap-evidence/3yfs-finalizer-matrix.ts) that executes THIS production
// function with controlled IO/CDP/process seams.
//
// (a) ZERO checks recorded: the decision only asked whether any check FAILED, so
// a run that reached no check at all published an authoritative GREEN 0/0 — a
// pass for work that never happened. An empty list is a harness failure.
Deno.test("kat-finalizer guards: a run that recorded ZERO checks is RED — 0/0 is not a pass (3yfs)", async () => {
  const k = seams();
  const outcome = await finalize(k, { checks: [] });
  assertEquals(outcome.state, "RED");
  assertEquals(outcome.exitCode, 1);
  assertEquals(k.exits, [1], "the failure-derived exit is 1");
  const receipt = JSON.parse(k.payload());
  assertEquals(receipt.state, "RED");
  assertEquals(receipt.error, "no_checks_recorded");
  assertEquals(receipt.checks, []);
});

// (b) A rejected/timed-out Browser.close was swallowed by `.catch(() => {})`, so
// with no process handle NOTHING confirmed the browser was gone and the run
// still passed. The process handle is the authority; without one, the failure is
// a cleanup error.
Deno.test("kat-finalizer guards: a rejected Browser.close with NO process handle is a cleanup failure, never GREEN (3yfs)", async () => {
  const k = seams();
  const outcome = await finalize(k, {
    teardown: {
      cdp: { send: async () => { throw new Error("browser_close_refused"); }, close: () => {} },
      chrome: null,
      profilePath: null,
      poisonPath: "/mock/out/no-poison",
      withTimeout: (p) => p,
      statFile: async () => false,
    },
  });
  assertEquals(outcome.state, "RED");
  assertEquals(outcome.exitCode, 1);
  assert(String(outcome.cleanupError).includes("cdp_browser_close_failed"));
  assertEquals(JSON.parse(k.payload()).state, "RED");
});

// (b-counter) The same rejected Browser.close WITH a confirmed process exit is
// NOT over-red: the kill/status path is the authority, and a merely slow
// graceful close must not fail an otherwise clean run.
Deno.test("kat-finalizer guards: a rejected Browser.close WITH a confirmed process exit stays GREEN (3yfs)", async () => {
  const k = seams();
  const outcome = await finalize(k, {
    teardown: {
      cdp: { send: async () => { throw new Error("browser_close_refused"); }, close: () => {} },
      chrome: { proc: { status: Promise.resolve({ success: true, code: 0 }), kill: () => {} } },
      profilePath: null,
      poisonPath: "/mock/out/no-poison",
      withTimeout: (p) => p,
      statFile: async () => false,
    },
  });
  assertEquals(outcome.state, "GREEN");
  assertEquals(outcome.cleanupError, null);
});

// (c) The bead's ORIGINAL defect: an evidence-write failure exiting before
// cleanup. The writes are after the teardown by construction now — pinned here
// so a future reordering cannot silently skip cleanup on a write failure.
Deno.test("kat-finalizer guards: an evidence-write failure still ran the FULL teardown first (3yfs)", async () => {
  const k = seams();
  const calls: string[] = [];
  const outcome = await finalize(k, {
    writeTextFile: async () => { throw new Error("kat_log_refused"); },
    teardown: {
      cdp: {
        send: async () => { calls.push("browser-close"); return {}; },
        close: () => { calls.push("cdp-close"); },
      },
      chrome: { proc: { status: Promise.resolve({ success: true, code: 0 }), kill: () => calls.push("kill") } },
      profilePath: "/mock/profile",
      poisonPath: "/mock/out/no-poison",
      withTimeout: (p) => p,
      removeDir: async () => { calls.push("remove-profile"); },
      statFile: async () => false,
    },
  });
  assertEquals(outcome.state, "RED");
  assertEquals(calls, ["browser-close", "cdp-close", "remove-profile"], "every teardown phase ran before the failed write");
  assertEquals(k.exits, [1]);
});


// ============================================================================
// 3. KAT Finalizer Log Residue (from tests/kat-finalizer-log-residue.test.ts — ln0e)
// ============================================================================

const scratchResidue = () => mkdtemp(join(durableDir("scratch") + "/", "cap-ln0e-"));
const REPORT_RESIDUE = (outDir) => ({
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
  const outDir = await scratchResidue();
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
      report: REPORT_RESIDUE(outDir),
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
    report: REPORT_RESIDUE("/mock/out"),
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
  const outDir = await scratchResidue();
  try {
    const exits = [];
    const outcome = await finalizeKatExecution({
      runError: null,
      checks: PASSING,
      teardown: {
        cdp: null, chrome: null, profilePath: null, poisonPath: `${outDir}/no-poison`,
        withTimeout: (p) => p,
      },
      report: REPORT_RESIDUE(outDir),
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
    report: REPORT_RESIDUE("/mock/out"),
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

