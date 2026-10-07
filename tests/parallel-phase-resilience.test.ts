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
import { DEFAULT_PARALLEL_TIMEOUT_MS as RUN_PARALLEL_TIMEOUT_MS } from "../scripts/run-tests.mjs";
import { DEFAULT_PARALLEL_TIMEOUT_MS as SELECT_PARALLEL_TIMEOUT_MS } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

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
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "5000",
        CAP_PARALLEL_READY_FILE: missingReadyFile,
        CAP_PARALLEL_READY_TIMEOUT_MS: "5000",
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
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "5000",
        CAP_PARALLEL_READY_FILE: readyFile,
        CAP_PARALLEL_READY_TIMEOUT_MS: "5000",
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
