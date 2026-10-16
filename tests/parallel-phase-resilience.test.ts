// tests/parallel-phase-resilience.test.ts — chrome-agent-platform-1k2a.
//
// Root-causes and prevents the systemic full-gate failure where npm test appeared
// to hang past totals and timed out at rc=124:
//   1. Default parallel timeout: sized for the growing 570+ test suite (1800s / 30m,
//      overriding the legacy 600s default which false-redded with ETIMEDOUT / rc=124
//      under normal VM load).
//   2. Process group isolation: parallel phase spawns detached and kills the
//      entire process group on timeout AND on exit, so no orphaned grandchildren
//      (Chromium renderers/zygotes, background subprocesses) linger past process.exit.
//   3. Subset execution: run-tests.mjs accepts explicit files on CLI so bounded
//      verification can run without executing the entire 597-file suite.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { DEFAULT_PARALLEL_TIMEOUT_MS as RUN_PARALLEL_TIMEOUT_MS, areAllFailuresEnvironmental } from "../scripts/run-tests.mjs";
import { DEFAULT_PARALLEL_TIMEOUT_MS as SELECT_PARALLEL_TIMEOUT_MS } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

/**
 * Pure scale factor calculation given machine load and CPU count (chrome-agent-platform-v6kut).
 * Caps strictly at maxScale (default 4x) regardless of ambient load spikes.
 */
export function computeLoadScale(load: number, cpus: number, maxScale = 4): number {
  if (Number.isNaN(load) || !Number.isFinite(cpus) || cpus <= 0 || load <= 0) return 1;
  const ratio = Math.max(1, load / cpus);
  return Math.min(maxScale, ratio);
}

/**
 * Computes a load-scaled timeout for resilience tests (chrome-agent-platform-ln7uw).
 * Under gate load, Deno process initialization + TypeScript compilation can take
 * several seconds before line 1 of a test probe executes. Sizing the ready-marker
 * timeout with load (min 15s, ceiling 60s) prevents false-124 flakes on busy heavy slots.
 */
export function loadScaledTimeout(baseMs = 15_000, maxScale = 4, load?: number, cpus?: number): number {
  try {
    const l = typeof load === "number" && !Number.isNaN(load) ? load : Deno.loadavg()[0];
    const c = typeof cpus === "number" && !Number.isNaN(cpus) && cpus > 0 ? cpus : (navigator.hardwareConcurrency || 1);
    const scale = computeLoadScale(l, c, maxScale);
    return Math.round(baseMs * scale);
  } catch {
    return baseMs;
  }
}

Deno.test("1k2a: DEFAULT_PARALLEL_TIMEOUT_MS is at least 30 minutes (1,800,000 ms)", () => {
  assert(RUN_PARALLEL_TIMEOUT_MS >= 1_800_000, `run-tests default was ${RUN_PARALLEL_TIMEOUT_MS}`);
  assert(SELECT_PARALLEL_TIMEOUT_MS >= 1_800_000, `select-tests default was ${SELECT_PARALLEL_TIMEOUT_MS}`);
});

Deno.test("1k2a: run-tests.mjs exits with rc=0 after printing totals for a passing test", async () => {
  const { code, stdout, stderr } = await new Deno.Command("node", {
    args: ["scripts/run-tests.mjs", "tests/vocabulary.test.ts"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  assertEquals(code, 0, `expected rc=0, got ${code}:\n${err}\n${out}`);
  assertStringIncludes(out, "run-tests: parallel phase (1 files) GREEN");
  assertStringIncludes(out, "run-tests: 1 files total, 0 skipped");
});

Deno.test("1k2a: parallel phase timeout kills entire process group leaving no orphans", async () => {
  const dir = await durableDir(`1k2a-parallel-orphan-test-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const pidFile = `${dir}/grandchild.pid`;
  const probeFile = `${dir}/zz-probe-hang.test.ts`;

  const probeSrc = `
const b = new Deno.Command("bash", {
  args: ["-c", "sleep 300 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
const sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
await Deno.writeTextFile("${pidFile}", String(sleeper));
Deno.test("hangs in parallel phase", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  let orphanPid = 0;
  try {
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "5000",
        CAP_PARALLEL_READY_FILE: pidFile,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 124, `expected code 124 on parallel timeout, got ${code}:\n${err}\n${out}`);
    assert(out.includes("TIMED OUT") || err.includes("TIMED OUT"));

    const sleeperText = await Deno.readTextFile(pidFile).catch(() => "");
    orphanPid = Number(sleeperText.trim()) || 0;
    assert(orphanPid > 0, "probe must have spawned sleeper");

    // Wait boundedly for process to be gone or zombie
    let alive = true;
    for (let i = 0; i < 20; i++) {
      let state: string | null = null;
      try {
        const stat = await Deno.readTextFile(`/proc/${orphanPid}/stat`);
        state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      } catch {
        if (Deno.build.os === "darwin") {
          const out = await new Deno.Command("/bin/ps", {
            args: ["-o", "state=", "-p", String(orphanPid)],
            stdout: "piped",
            stderr: "null",
          }).output().catch(() => null);
          const s = out ? new TextDecoder().decode(out.stdout).trim() : "";
          state = s ? s[0] : null;
        }
      }
      if (state === null || state === "Z" || state === "X") {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assertEquals(alive, false, `orphan PID ${orphanPid} must be killed on parallel timeout`);
  } finally {
    if (orphanPid > 0) {
      try { Deno.kill(orphanPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("1k2a/5nhz: parallel phase timeout with cold-boot delay awaits ready marker before starting timer", async () => {
  const dir = await durableDir(`1k2a-parallel-delayed-boot-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const pidFile = `${dir}/grandchild.pid`;
  const probeFile = `${dir}/zz-probe-delayed-hang.test.ts`;

  // Simulates a heavy cold boot: sleeps 2.5s before spawning sleeper and writing pidFile.
  // Delay (2500ms) exceeds execution timeout (1500ms), proving the timeout starts only after readiness.
  const probeSrc = `
await new Promise((r) => setTimeout(r, 2500));
const b = new Deno.Command("bash", {
  args: ["-c", "sleep 300 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
const sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
await Deno.writeTextFile("${pidFile}", String(sleeper));
Deno.test("delayed boot hangs in parallel phase", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  let orphanPid = 0;
  try {
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "1500",
        CAP_PARALLEL_READY_FILE: pidFile,
        CAP_PARALLEL_READY_TIMEOUT_MS: "15000",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 124, `expected code 124 on parallel timeout, got ${code}:\n${err}\n${out}`);
    assert(out.includes("TIMED OUT") || err.includes("TIMED OUT"));

    const sleeperText = await Deno.readTextFile(pidFile).catch(() => "");
    orphanPid = Number(sleeperText.trim()) || 0;
    assert(orphanPid > 0, "probe must have spawned sleeper despite cold boot delay");

    let alive = true;
    for (let i = 0; i < 20; i++) {
      try {
        const stat = await Deno.readTextFile(`/proc/${orphanPid}/stat`);
        const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        if (state === "Z" || state === "X") {
          alive = false;
          break;
        }
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assertEquals(alive, false, `orphan PID ${orphanPid} must be killed on parallel timeout`);
  } finally {
    if (orphanPid > 0) {
      try { Deno.kill(orphanPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("1k2a/5nhz: parallel phase fails closed with diagnostic if ready marker never appears", async () => {
  const dir = await durableDir(`1k2a-parallel-never-ready-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const missingReadyFile = `${dir}/nonexistent-ready.marker`;
  const probeFile = `${dir}/zz-probe-never-ready.test.ts`;

  // Fixture never writes the ready marker
  const probeSrc = `
Deno.test("never writes marker", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  try {
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "5000",
        CAP_PARALLEL_READY_FILE: missingReadyFile,
        CAP_PARALLEL_READY_TIMEOUT_MS: "500",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 124, `expected code 124 on unready timeout, got ${code}:\n${err}\n${out}`);
    assert(
      out.includes("parallel phase ready marker") || err.includes("parallel phase ready marker"),
      `output must include diagnostic naming missing ready marker:\n${err}\n${out}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("1k2a/5nhz: parallel phase fails closed if child exits 0 without writing ready marker", async () => {
  const dir = await durableDir(`1k2a-parallel-exit-unready-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const missingReadyFile = `${dir}/unwritten.marker`;
  const probeFile = `${dir}/zz-probe-exit-unready.test.ts`;

  // Fixture passes immediately without writing marker
  const probeSrc = `
Deno.test("passes immediately without marker", () => {
  // finishes with exit 0
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  try {
    const timeoutMs = String(loadScaledTimeout(15_000));
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: timeoutMs,
        CAP_PARALLEL_READY_FILE: missingReadyFile,
        CAP_PARALLEL_READY_TIMEOUT_MS: timeoutMs,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 124, `expected code 124 when exiting without marker, got ${code}:\n${err}\n${out}`);
    assert(
      out.includes("child exited before creating ready marker") ||
        err.includes("child exited before creating ready marker"),
      `output must name early exit before ready marker:\n${err}\n${out}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("1k2a/5nhz: parallel phase succeeds when child writes ready marker and exits immediately", async () => {
  const dir = await durableDir(`1k2a-parallel-fast-ready-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const readyFile = `${dir}/fast.marker`;
  const probeFile = `${dir}/zz-probe-fast-ready.test.ts`;

  const probeSrc = `
await Deno.writeTextFile("${readyFile}", "ready");
Deno.test("passes immediately after marker", () => {});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  try {
    const timeoutMs = String(loadScaledTimeout(15_000));
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: timeoutMs,
        CAP_PARALLEL_READY_FILE: readyFile,
        CAP_PARALLEL_READY_TIMEOUT_MS: timeoutMs,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 0, `expected code 0 for fast marker-then-exit, got ${code}:\n${err}\n${out}`);
    assertStringIncludes(out, "run-tests: parallel phase (1 files) GREEN");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("v6kut: computeLoadScale and loadScaledTimeout are bounded, load-responsive, and capped at maxScale independent of ambient load", () => {
  // Pure scale calculation across load spectrum (test-honesty: proven without ambient box state)
  assertEquals(computeLoadScale(0, 1), 1, "zero/idle load returns floor scale 1");
  assertEquals(computeLoadScale(1, 1), 1, "load equal to CPUs returns scale 1");
  assertEquals(computeLoadScale(2, 1), 2, "load 2x CPUs returns scale 2");
  assertEquals(computeLoadScale(3, 1), 3, "load 3x CPUs returns scale 3");
  assertEquals(computeLoadScale(4, 1), 4, "load 4x CPUs returns maxScale 4");
  assertEquals(computeLoadScale(100, 1), 4, "extreme load caps at maxScale 4");
  assertEquals(computeLoadScale(Infinity, 1), 4, "infinite load caps strictly at maxScale 4");

  // Non-finite or negative inputs fail safe to floor 1
  assertEquals(computeLoadScale(NaN, 1), 1);
  assertEquals(computeLoadScale(1, 0), 1);
  assertEquals(computeLoadScale(-5, 1), 1);

  // Injected load tests for loadScaledTimeout proving 60s ceiling on any box
  assertEquals(loadScaledTimeout(15_000, 4, 0, 1), 15_000, "floor is 15s");
  assertEquals(loadScaledTimeout(15_000, 4, 2, 1), 30_000, "2x load gives 30s");
  assertEquals(loadScaledTimeout(15_000, 4, 100, 1), 60_000, "100x load capped at 60s ceiling");
  assertEquals(loadScaledTimeout(15_000, 4, Infinity, 1), 60_000, "Infinity load capped at 60s ceiling");
});

Deno.test("1k2a: passing parallel test that leaves an orphan process has orphan reaped on exit", async () => {
  const dir = await durableDir(`1k2a-parallel-residual-test-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const pidFile = `${dir}/grandchild.pid`;
  const probeFile = `${dir}/zz-probe-pass-orphan.test.ts`;

  // Passes immediately, but leaves background sleeper
  const probeSrc = `
const b = new Deno.Command("bash", {
  args: ["-c", "sleep 300 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
const sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
await Deno.writeTextFile("${pidFile}", String(sleeper));
Deno.test("passes leaving an orphan", () => {
  // finishes immediately
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  let orphanPid = 0;
  try {
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 0, `expected code 0 for passing test, got ${code}:\n${err}\n${out}`);
    assertStringIncludes(out, "run-tests: parallel phase (1 files) GREEN");
    assertStringIncludes(out, "run-tests: 1 files total, 0 skipped");

    const sleeperText = await Deno.readTextFile(pidFile).catch(() => "");
    orphanPid = Number(sleeperText.trim()) || 0;
    assert(orphanPid > 0, "probe must have spawned sleeper");

    // Residual group kill must have killed the orphan sleeper
    let alive = true;
    for (let i = 0; i < 20; i++) {
      let state: string | null = null;
      try {
        const stat = await Deno.readTextFile(`/proc/${orphanPid}/stat`);
        state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      } catch {
        if (Deno.build.os === "darwin") {
          const out = await new Deno.Command("/bin/ps", {
            args: ["-o", "state=", "-p", String(orphanPid)],
            stdout: "piped",
            stderr: "null",
          }).output().catch(() => null);
          const s = out ? new TextDecoder().decode(out.stdout).trim() : "";
          state = s ? s[0] : null;
        }
      }
      if (state === null || state === "Z" || state === "X") {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assertEquals(alive, false, `residual group kill must terminate orphan PID ${orphanPid} on exit`);
  } finally {
    if (orphanPid > 0) {
      try { Deno.kill(orphanPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ic1pa: areAllFailuresEnvironmental classifies QuietWindowRefusedError and machine quietness errors as environmental", () => {
  const quietRefusalOutput = `
 ERRORS 

mkax: quiet-window gate refused under heavy build load => ./tests/quiet-window.test.ts:500:6
error: QuietWindowRefusedError: ENVIRONMENT: machine is not quiet enough for this gate (waited 600000 ms, still load/core 0.94 > 0.35, 9 active heavy-builders). Not started — this is an environmental refusal (exit 75), not a failure of the tree.
  throw new QuietWindowRefusedError(verdict);
        ^

 FAILURES 
`;

  assertEquals(areAllFailuresEnvironmental(quietRefusalOutput), true);

  const markerRefusalOutput = `
 ERRORS 

test with refusal marker => ./tests/some.test.ts:10:6
error: Error: CAP_ENVIRONMENTAL_REFUSAL {"reason":"host-loaded"}
  throw new Error("CAP_ENVIRONMENTAL_REFUSAL");
        ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(markerRefusalOutput), true);

  const productFailureOutput = `
 ERRORS 

genuine product bug => ./tests/real.test.ts:20:6
error: AssertionError: Values are not equal. Expected 5, got 51.
  throw new AssertionError(message);
        ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(productFailureOutput), false);

  // Finding P1: Test name containing refusal marker/class must NOT convert an assertion failure to environmental
  const testNamedRefusalFailingAssertion = `
 ERRORS 

ic1pa: areAllFailuresEnvironmental classifies QuietWindowRefusedError and machine quietness errors as environmental => ./tests/parallel-phase-resilience.test.ts:423:6
error: AssertionError: Values are not equal.
  throw new AssertionError(message);
        ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(testNamedRefusalFailingAssertion), false, "test name with QuietWindowRefusedError must not mask AssertionError");

  // Finding 2y5h7 (Round 2 review): Assertion body naming QuietWindowRefusedError must NOT convert an assertion failure to environmental
  const assertRejectsForgedBody = `
 ERRORS 

genuine product regression => ./tests/quiet-window.test.ts:445:6
error: AssertionError: Expected error to be instance of "QuietWindowRefusedError", but was "Error".
  throw new AssertionError(message);
        ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(assertRejectsForgedBody), false, "assertRejects errorBody naming QuietWindowRefusedError must not mask AssertionError");
});

Deno.test("ic1pa: processGroup returns null on ESRCH / vanished process", async () => {
  const { processGroup } = await import("../scripts/lib/process-tree.ts");
  // 1. Natural ENOENT check
  const nonExistentPid = 2_147_483_000;
  const result = processGroup(nonExistentPid);
  assertEquals(result, null, "processGroup must return null without throwing on non-existent process");

  // 2. Finding P2: Injected ESRCH / osError 3 check (distinct from Deno.errors.NotFound)
  const esrchError = new Error("No such process: readfile /proc/12345/stat");
  (esrchError as any).osError = 3;
  (esrchError as any).code = "ESRCH";

  const esrchResult = processGroup(12345, {
    readProcStat: () => {
      throw esrchError;
    },
  });
  assertEquals(esrchResult, null, "processGroup must return null when reading stat throws ESRCH");
});

Deno.test("ri0x8: captureSnapshotWithRetry survives transient MHTML generation failure and fails closed on exhausted attempts", async () => {
  const { captureSnapshotWithRetry } = await import("../scripts/lib/load-retry.ts");

  // 1. Transient failure on attempts 1-2, success on attempt 3
  let callCount = 0;
  const mockCdp = {
    send: async (method: string) => {
      callCount++;
      if (method === "Page.captureSnapshot") {
        if (callCount < 3) {
          throw new Error("Page.captureSnapshot: Failed to generate MHTML");
        }
        return { result: { data: "Content-Type: multipart/related\nimage-loaded:20\n" } };
      }
      return {};
    },
  };

  const result = await captureSnapshotWithRetry(mockCdp as any, "session-1", 5, {
    sleep: async () => {},
  });

  assertEquals(result.attempts, 3, "must retry through transient MHTML failure");
  assertEquals(result.status, "loaded:20", "must return success status when attempt succeeds");

  // 2. Exhausted failures: rethrows error carrying environmentLine
  const failingCdp = {
    send: async () => {
      throw new Error("Page.captureSnapshot: Failed to generate MHTML");
    },
  };

  let caughtError: Error | null = null;
  try {
    await captureSnapshotWithRetry(failingCdp as any, "session-2", 3, {
      readLoadSample: async () => ({
        measurable: true,
        loadPerCore: 4.0,
        activeCompilers: 9,
      }),
      environmentLine: () => "live-chrome=7 load1=12.50 heavy-builders=2[esbuild,cargo]",
      sleep: async () => {},
    });
  } catch (e: any) {
    caughtError = e;
  }

  assert(caughtError !== null, "must throw when all attempts exhaust");
  assert(
    caughtError!.message.includes("Page.captureSnapshot failed after 3 attempts [live-chrome=7 load1=12.50 heavy-builders=2[esbuild,cargo]]"),
    `error message must include attempt count and environmentLine: ${caughtError!.message}`,
  );
});
