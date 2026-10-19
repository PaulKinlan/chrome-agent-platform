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
import { durableDir, durableRoot } from "../scripts/lib/durable-root.mjs";
import { DEFAULT_PARALLEL_TIMEOUT_MS as RUN_PARALLEL_TIMEOUT_MS, areAllFailuresEnvironmental } from "../scripts/run-tests.mjs";
import { DEFAULT_PARALLEL_TIMEOUT_MS as SELECT_PARALLEL_TIMEOUT_MS } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

/**
 * chrome-agent-platform-6z8yi: clean up any stale 1k2a-parallel-* scratch directories
 * left behind if a previous test run was SIGKILLed before its finally block could run.
 */
/**
 * j2isq: the liveness probe's answers. ONLY positive proof of death authorizes
 * deletion; every uncertainty is UNKNOWN and must PRESERVE. A stale scratch
 * directory under durableRoot() is harmless — deleting a live lane's directory
 * is the bug this distinguishes.
 */
type PidState = "alive" | "dead" | "unknown";
const ALIVE: PidState = "alive";
const DEAD: PidState = "dead";
const UNKNOWN: PidState = "unknown";

/**
 * j2isq: an unreadable /proc entry is not evidence of death. EACCES/EPERM, a
 * container without /proc mounted, and hidepid all surface as a throw that the
 * old probe collapsed into `pidAlive = false` — the deletion authority.
 */
export function classifyStatError(err: unknown): PidState {
  return err instanceof Deno.errors.NotFound ? DEAD : UNKNOWN;
}

/**
 * j2isq: the non-Linux `ps` probe. A missing ps, a non-zero exit and empty
 * stdout are all "cannot answer", which is UNKNOWN, never dead. Only a real
 * state character decides — and a zombie (Z) holds nothing, so it is dead.
 */
export function classifyPsOutput(out: { success: boolean; stdout: Uint8Array } | null): PidState {
  if (!out || !out.success) return UNKNOWN;
  const state = new TextDecoder().decode(out.stdout).trim();
  if (!state) return UNKNOWN;
  return state[0] === "Z" ? DEAD : ALIVE;
}

/**
 * The platform-aware probe. `statProc` is injectable so a test can drive the real
 * probe AND the real sweep through the uncertainty paths a container actually
 * produces (hidepid, EPERM, no /proc) without faking the answer itself.
 */
export async function defaultPidState(
  pid: number,
  { statProc = Deno.stat }: { statProc?: (path: string) => Promise<unknown> } = {},
): Promise<PidState> {
  if (Deno.build.os === "linux") {
    try {
      await statProc(`/proc/${pid}`);
      return ALIVE;
    } catch (err) {
      return classifyStatError(err);
    }
  }
  try {
    const out = await new Deno.Command("ps", {
      args: ["-o", "state=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    return classifyPsOutput(out);
  } catch {
    return UNKNOWN;
  }
}

async function sweepStaleOrphanDirs(
  { pidState = defaultPidState }: { pidState?: (pid: number) => Promise<PidState> } = {},
) {
  const root = durableRoot();
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && entry.name.startsWith("1k2a-parallel-")) {
        // t4uvt: the fixture LABEL is multi-segment ("orphan-test", "residual-test"),
        // so the old `[^-]+` never matched the exact shape the 121-minute orphan
        // left behind — the sweep skipped it silently. The label may now contain
        // dashes; the trailing -<pid>-<8hex> tail is anchored, so the pid is always
        // the second-to-last segment. Safety is unchanged: the pid-liveness check
        // below is the only removal authority, and only this suite's own
        // 1k2a-parallel-* shapes match at all.
        const m = /^1k2a-parallel-(.+)-(\d+)-([0-9a-f]{8})$/.exec(entry.name);
        if (m) {
          // chrome-agent-platform-2jjit: the PID is the SECOND group — the label
          // before it may contain dashes. Parsing m[1] (the old group index)
          // yields NaN for multi-segment labels, /proc/NaN never stats, and the
          // sweep would treat a LIVE pid as dead and delete its directory.
          const pid = Number(m[2]);
          if (!Number.isSafeInteger(pid) || pid <= 0) continue;
          // j2isq: PRESERVE on any answer that is not positive proof of death.
          if ((await pidState(pid)) !== DEAD) continue;
          await Deno.remove(`${root}/${entry.name}`, { recursive: true }).catch(() => {});
        }
      }
    }
  } catch {}
}

await sweepStaleOrphanDirs();

Deno.test("2jjit: the sweep never deletes a LIVE pid's directory (multi-segment label included)", async () => {
  // 2jjit: the group-index drift made Number(m[1]) = NaN for "orphan-test"
  // labels, /proc/NaN never stats, and the liveness gate read "dead" — the sweep
  // would have deleted a LIVE pid's directory. A genuinely LIVE pid (a sleeping
  // child) with a real fixture shape must survive the sweep.
  const root = durableRoot();
  const child = new Deno.Command("sh", { args: ["-c", "sleep 30"] }).spawn();
  const livePid = child.pid;
  const multi = `${root}/1k2a-parallel-orphan-test-${livePid}-deadbeef`;
  const single = `${root}/1k2a-parallel-foo-${livePid}-deadbeef`;
  await Deno.mkdir(multi, { recursive: true });
  await Deno.mkdir(single, { recursive: true });
  try {
    await sweepStaleOrphanDirs();
    assertEquals(await Deno.stat(multi).then(() => true, () => false), true,
      `a LIVE pid's multi-segment directory must NEVER be swept: ${multi}`);
    assertEquals(await Deno.stat(single).then(() => true, () => false), true,
      `a LIVE pid's single-segment directory must NEVER be swept: ${single}`);
  } finally {
    child.kill("SIGKILL");
    await child.status;
    await Deno.remove(multi, { recursive: true }).catch(() => {});
    await Deno.remove(single, { recursive: true }).catch(() => {});
  }
});

Deno.test("2jjit: names that are not this suite's fixture shape are never swept", async () => {
  // The prefix alone must not authorize deletion: a directory that carries the
  // 1k2a-parallel- prefix but no -<pid>-<8hex> tail (an unrelated lane's
  // directory, or prose) is not this suite's fixture and must survive.
  const root = durableRoot();
  const strangers = [
    `${root}/1k2a-parallel-not-a-fixture`,
    `${root}/1k2a-parallel-`,
    `${root}/1k2a-parallel-orphan-test-not-a-pid-nothex`,
  ];
  for (const dir of strangers) await Deno.mkdir(dir, { recursive: true });
  try {
    await sweepStaleOrphanDirs();
    for (const dir of strangers) {
      assertEquals(await Deno.stat(dir).then(() => true, () => false), true,
        `a non-fixture name must never be swept: ${dir}`);
    }
  } finally {
    for (const dir of strangers) await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("t4uvt: the stale-orphan sweep matches the REAL orphan shape, multi-segment label included", async () => {
  // t4uvt: the reviewer's exact repro. The suite's largest fixture label is
  // multi-segment ("orphan-test"), and the old sweep regex `[^-]+` matched only a
  // single dash-free segment — so the EXACT directory shape the 121-minute orphan
  // left behind was never swept, while a synthetic single-segment dir was. A
  // genuinely dead pid (a child that has already exited) is the sweep's only
  // removal authority; a live pid's dir is never touched.
  const root = durableRoot();
  const child = new Deno.Command("sh", { args: ["-c", "exit 0"] }).spawn();
  const deadPid = child.pid;
  await child.status;
  const multi = `${root}/1k2a-parallel-orphan-test-${deadPid}-deadbeef`;
  const single = `${root}/1k2a-parallel-foo-${deadPid}-deadbeef`;
  await Deno.mkdir(multi, { recursive: true });
  await Deno.mkdir(single, { recursive: true });
  try {
    await sweepStaleOrphanDirs();
    assertEquals(await Deno.stat(multi).then(() => false, () => true), true,
      `the multi-segment orphan shape must be swept: ${multi}`);
    assertEquals(await Deno.stat(single).then(() => false, () => true), true,
      `the single-segment shape must still be swept: ${single}`);
  } finally {
    await Deno.remove(multi, { recursive: true }).catch(() => {});
    await Deno.remove(single, { recursive: true }).catch(() => {});
  }
});

Deno.test("j2isq: the sweep PRESERVES a fixture directory whenever the probe cannot answer", async () => {
  // The probe's uncertainty paths used to resolve to "dead", which IS the
  // deletion authority: an unreadable /proc (EACCES/EPERM, no /proc in a
  // container, hidepid) or a missing/empty `ps` deleted a directory whose pid
  // might be perfectly alive. Uncertainty must preserve; only proof of death
  // may delete.
  const root = durableRoot();
  const unknownDir = `${root}/1k2a-parallel-orphan-test-2147483646-deadbeef`;
  const deadDir = `${root}/1k2a-parallel-residual-test-2147483645-deadbeef`;
  await Deno.mkdir(unknownDir, { recursive: true });
  await Deno.mkdir(deadDir, { recursive: true });
  try {
    // The REAL probe and the REAL sweep run: only the filesystem answer is
    // injected, so this drives the classifier, the sweep's gate and the removal
    // authority together. A hidepid/EACCES /proc is the container reality, and a
    // `ps` that cannot answer is the macOS reality (same UNKNOWN answer).
    await sweepStaleOrphanDirs({
      pidState: (pid) =>
        pid === 2147483646
          ? defaultPidState(pid, {
            statProc: () => Promise.reject(new Deno.errors.PermissionDenied("hidepid hides /proc")),
          })
          : defaultPidState(pid, { statProc: () => Promise.reject(new Deno.errors.NotFound("no such process")) }),
    });
    assertEquals(await Deno.stat(unknownDir).then(() => true, () => false), true,
      `an UNKNOWN liveness answer must PRESERVE the directory: ${unknownDir}`);
    assertEquals(await Deno.stat(deadDir).then(() => false, () => true), true,
      `positive proof of death must still authorize deletion: ${deadDir}`);
  } finally {
    await Deno.remove(unknownDir, { recursive: true }).catch(() => {});
    await Deno.remove(deadDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("j2isq: only ENOENT from the /proc probe is death; every other error is unknown", () => {
  assertEquals(classifyStatError(new Deno.errors.NotFound("no such file")), DEAD);
  assertEquals(classifyStatError(new Deno.errors.PermissionDenied("denied")), UNKNOWN);
  assertEquals(classifyStatError(new Deno.errors.NotCapable("no capability")), UNKNOWN);
  // A bare Error is what a non-Deno stat failure looks like; never death.
  assertEquals(classifyStatError(new Error("EIO")), UNKNOWN);
});

Deno.test("j2isq: the ps probe cannot answer is UNKNOWN, never death", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  // A missing ps, a failing ps, and an empty state are all "cannot answer".
  assertEquals(classifyPsOutput(null), UNKNOWN);
  assertEquals(classifyPsOutput({ success: false, stdout: enc("") }), UNKNOWN);
  assertEquals(classifyPsOutput({ success: true, stdout: enc("\n") }), UNKNOWN);
  // A real state character decides.
  assertEquals(classifyPsOutput({ success: true, stdout: enc("Z\n") }), DEAD);
  assertEquals(classifyPsOutput({ success: true, stdout: enc("S\n") }), ALIVE);
  assertEquals(classifyPsOutput({ success: true, stdout: enc("R+") }), ALIVE);
});

Deno.test("j2isq: the real platform probe never calls a nonexistent pid alive", async () => {
  // The fail-safe direction is "preserve on uncertainty", so a dead pid may read
  // as UNKNOWN (a scratch directory survives); what must NEVER happen is a pid
  // with no process reading as ALIVE, which would strand real orphans forever.
  assert((await defaultPidState(2147483646)) !== ALIVE);
});

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
const initialPpid = Deno.ppid;
let sleeper = 0;
const ppidTimer = setInterval(() => {
  if (Deno.ppid !== initialPpid || Deno.ppid === 1) {
    if (sleeper > 0) {
      try { Deno.kill(sleeper, "SIGKILL"); } catch {}
    }
    Deno.exit(1);
  }
}, 50);
setTimeout(() => {
  if (sleeper > 0) {
    try { Deno.kill(sleeper, "SIGKILL"); } catch {}
  }
  Deno.exit(1);
}, 30000);

const b = new Deno.Command("bash", {
  args: ["-c", "sleep 30 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
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

Deno.test("6z8yi: cancelling parent while parallel child is running leaves no orphan Deno or sleeper process", async () => {
  const dir = await durableDir(`1k2a-parallel-cancel-test-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const pidFile = `${dir}/grandchild.pid`;
  const probeFile = `${dir}/zz-probe-cancel.test.ts`;

  const probeSrc = `
const initialPpid = Deno.ppid;
let sleeper = 0;
const ppidTimer = setInterval(() => {
  if (Deno.ppid !== initialPpid || Deno.ppid === 1) {
    if (sleeper > 0) {
      try { Deno.kill(sleeper, "SIGKILL"); } catch {}
    }
    Deno.exit(1);
  }
}, 50);
setTimeout(() => {
  if (sleeper > 0) {
    try { Deno.kill(sleeper, "SIGKILL"); } catch {}
  }
  Deno.exit(1);
}, 30000);

const b = new Deno.Command("bash", {
  args: ["-c", "sleep 30 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
await Deno.writeTextFile("${pidFile}", JSON.stringify({ denoPid: Deno.pid, sleeperPid: sleeper }));
Deno.test("hangs in parallel phase until parent cancel", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  let pids: { denoPid?: number; sleeperPid?: number } = {};
  try {
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "30000",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const child = proc.spawn();

    for (let i = 0; i < 50; i++) {
      try {
        const text = await Deno.readTextFile(pidFile);
        pids = JSON.parse(text);
        if (pids.denoPid && pids.sleeperPid) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(pids.denoPid && pids.denoPid > 0, "probe must have recorded denoPid");
    assert(pids.sleeperPid && pids.sleeperPid > 0, "probe must have recorded sleeperPid");

    // Cancel parent abruptly with SIGKILL while the child is actively running
    child.kill("SIGKILL");
    await child.status;

    // Verify both Deno child and sleeper process exit promptly and do not survive as orphans
    for (const targetPid of [pids.denoPid, pids.sleeperPid]) {
      let alive = true;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          if (Deno.build.os === "linux") {
            const stat = await Deno.readTextFile(`/proc/${targetPid}/stat`);
            const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
            if (state === "Z" || state === "X") {
              alive = false;
              break;
            }
          } else {
            const out = await new Deno.Command("ps", {
              args: ["-o", "state=", "-p", String(targetPid)],
              stdout: "piped",
              stderr: "null",
            }).output().catch(() => null);
            const s = out ? new TextDecoder().decode(out.stdout).trim() : "";
            if (!s || s[0] === "Z") {
              alive = false;
              break;
            }
          }
        } catch {
          alive = false;
          break;
        }
      }
      assertEquals(alive, false, `PID ${targetPid} must not survive parent cancellation`);
    }
  } finally {
    if (pids.denoPid) {
      try { Deno.kill(pids.denoPid, "SIGKILL"); } catch {}
    }
    if (pids.sleeperPid) {
      try { Deno.kill(pids.sleeperPid, "SIGKILL"); } catch {}
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("6z8yi/qvv7k: harness watchdog reaps detached parallel child on runner SIGKILL even without fixture ppid monitor", async () => {
  const dir = await durableDir(`1k2a-parallel-qvv7k-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const pidFile = `${dir}/grandchild.pid`;
  const probeFile = `${dir}/zz-probe-qvv7k.test.ts`;

  // Fixture has NO ppid monitor and NO self-defense timeout — it relies purely on the harness watchdog
  const probeSrc = `
await Deno.writeTextFile("${pidFile}", String(Deno.pid));
Deno.test("hangs without ppid monitor", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;
  await Deno.writeTextFile(probeFile, probeSrc);

  let denoPid = 0;
  try {
    const proc = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", probeFile],
      cwd: ROOT,
      env: {
        CAP_PARALLEL_TEST_TIMEOUT_MS: "30000",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const child = proc.spawn();

    for (let i = 0; i < 50; i++) {
      try {
        const text = await Deno.readTextFile(pidFile);
        denoPid = Number(text.trim());
        if (denoPid > 0) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(denoPid > 0, "probe must have recorded denoPid");

    // Abruptly kill the runner parent with SIGKILL (uncatchable)
    child.kill("SIGKILL");
    await child.status;

    // The harness watchdog must reap the detached Deno process group
    let alive = true;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        if (Deno.build.os === "linux") {
          const stat = await Deno.readTextFile(`/proc/${denoPid}/stat`);
          const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
          if (state === "Z" || state === "X") {
            alive = false;
            break;
          }
        } else {
          const out = await new Deno.Command("ps", {
            args: ["-o", "state=", "-p", String(denoPid)],
            stdout: "piped",
            stderr: "null",
          }).output().catch(() => null);
          const s = out ? new TextDecoder().decode(out.stdout).trim() : "";
          if (!s || s[0] === "Z") {
            alive = false;
            break;
          }
        }
      } catch {
        alive = false;
        break;
      }
    }
    assertEquals(alive, false, `detached PID ${denoPid} without ppid monitor must be reaped by harness watchdog`);
  } finally {
    if (denoPid > 0) {
      try { Deno.kill(denoPid, "SIGKILL"); } catch {}
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
const initialPpid = Deno.ppid;
let sleeper = 0;
const ppidTimer = setInterval(() => {
  if (Deno.ppid !== initialPpid || Deno.ppid === 1) {
    if (sleeper > 0) {
      try { Deno.kill(sleeper, "SIGKILL"); } catch {}
    }
    Deno.exit(1);
  }
}, 50);
setTimeout(() => {
  if (sleeper > 0) {
    try { Deno.kill(sleeper, "SIGKILL"); } catch {}
  }
  Deno.exit(1);
}, 30000);

await new Promise((r) => setTimeout(r, 2500));
const b = new Deno.Command("bash", {
  args: ["-c", "sleep 30 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
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
const initialPpid = Deno.ppid;
setInterval(() => {
  if (Deno.ppid !== initialPpid || Deno.ppid === 1) {
    Deno.exit(1);
  }
}, 50);
setTimeout(() => {
  Deno.exit(1);
}, 30000);

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
  args: ["-c", "sleep 30 & echo $! > ${pidFile}.sleep"],
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
