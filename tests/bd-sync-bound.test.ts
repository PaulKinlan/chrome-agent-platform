// chrome-agent-platform-qhuf2: the bd-sync-bound.sh contract. The fleet shim bounds
// the flock WAIT but never the HOLDER, so a hung `bd dolt push` (git send-pack stuck)
// held ~/.fleet/bd-sync.lock and the embedded dolt DB for 25+ minutes while every
// lane write failed with the misleading "database is locked by another dolt process".
// The wrapper is the project-side mitigation: bounded wait, bounded hold (TERMINATE,
// never warn), and a sidecar that NAMES the live holder so the next lane kills the
// right process.
//
// Review rework (qhuf2 P1/P2): the sidecar is written ONLY after lock acquisition —
// a WAITER's pid never appears in it, so the kill guidance can never name an
// innocent waiting lane (pinned below with TWO simultaneous contenders). And the
// post-commit hook's raw fallback when the wrapper is missing is LOUD, never
// silent (pinned via beads-push.sh itself).
// Driven here against a FAKE bd on PATH — never against the real DB.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";

const WRAPPER = fromFileUrl(new URL("../scripts/bd-sync-bound.sh", import.meta.url));
const HOOK = fromFileUrl(new URL("../scripts/git-hooks/beads-push.sh", import.meta.url));

interface RunResult {
  code: number;
  stderr: string;
  elapsedMs: number;
}

function wrapperEnv(dir: string, env: Record<string, string>): Record<string, string> {
  return {
    PATH: `${dir}/bin:/usr/bin:/bin`,
    HOME: dir,
    CAP_BD_SYNC_LOCK: `${dir}/sync.lock`,
    CAP_BD_SYNC_HOLDER: `${dir}/holder`,
    ...env,
  };
}

function wrapperCommand(dir: string, args: string[], env: Record<string, string>): Deno.Command {
  return new Deno.Command("/bin/bash", {
    args: [WRAPPER, ...args],
    cwd: dir,
    env: wrapperEnv(dir, env),
    stdout: "piped",
    stderr: "piped",
  });
}

async function runWrapper(dir: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  const t0 = Date.now();
  const output = await wrapperCommand(dir, args, env).output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
    elapsedMs: Date.now() - t0,
  };
}

/** A fake `bd` that logs its argv and (optionally) sleeps like a hung git send-pack. */
async function writeFakeBd(dir: string): Promise<string> {
  const bin = `${dir}/bin`;
  await Deno.mkdir(bin, { recursive: true });
  const path = `${bin}/bd`;
  await Deno.writeTextFile(
    path,
    `#!/bin/bash\nprintf '%s\\n' "bd $*" >> "${dir}/argv.log"\n` +
      `if [ -n "\${CAP_FAKE_BD_SLEEP:-}" ]; then sleep "\${CAP_FAKE_BD_SLEEP}"; fi\nexit 0\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

/** Poll until the lock is actually contended (a zero-wait acquire fails). */
async function waitUntilHeld(lock: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const probe = new Deno.Command("flock", { args: ["-w", "0", lock, "true"] });
    const probeOut = await probe.output();
    if (!probeOut.success) return; // contended: the holder has it
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the lock holder never acquired the lock");
}

/** A live external holder of the lock (holds flock, writes NO sidecar), for the
 * stale-record case. */
async function spawnExternalLockHolder(lock: string): Promise<Deno.ChildProcess> {
  const holder = new Deno.Command("flock", { args: [lock, "-c", "sleep 8"] });
  const child = holder.spawn();
  await waitUntilHeld(lock);
  return child;
}

/** Poll until the sidecar exists (the holder stamps it right AFTER acquiring,
 * so contention can be observed a moment before the file appears). */
async function waitUntilSidecar(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      return await Deno.readTextFile(path);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`the holder sidecar never appeared at ${path}`);
}

Deno.test("qhuf2: bd-sync-bound passes argv through, bounds the hold, and always cleans the holder sidecar", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qhuf2-pass-" });
  await writeFakeBd(dir);

  // 1. Pass-through: `push --force-with-lease` reaches bd as `dolt push --force-with-lease`,
  //    exit 0, and the EXIT trap removed the holder sidecar.
  const ok = await runWrapper(dir, ["push", "--force-with-lease"], {});
  assertEquals(ok.code, 0, `a healthy sync must exit 0: ${ok.stderr}`);
  const argv = await Deno.readTextFile(`${dir}/argv.log`);
  assertStringIncludes(argv, "dolt push --force-with-lease");
  const holderAfterOk = await Deno.stat(`${dir}/holder`).then(() => true, () => false);
  assertEquals(holderAfterOk, false, "the holder sidecar must be removed after a clean run");

  // 2. Hold bound: a hung sync dies at the bound (exit 124), fast, lock released.
  const t0 = Date.now();
  const hung = await runWrapper(dir, ["push"], { CAP_FAKE_BD_SLEEP: "30", CAP_BD_SYNC_HOLD: "1" });
  const elapsed = Date.now() - t0;
  assertEquals(hung.code, 124, `the hold bound must kill the hung sync (exit 124): ${hung.stderr}`);
  assertEquals(elapsed < 15_000, true, `the bound must fire in seconds, not after the fake hang (${elapsed}ms)`);
  assertStringIncludes(hung.stderr, "hold bound");
  const holderAfterHang = await Deno.stat(`${dir}/holder`).then(() => true, () => false);
  assertEquals(holderAfterHang, false, "the holder sidecar must be removed even after a bound kill");
  // The lock must be RELEASED: a zero-wait acquire succeeds again.
  const probe = new Deno.Command("flock", {
    args: ["-w", "1", `${dir}/sync.lock`, "true"],
  });
  const probeOut = await probe.output();
  assertEquals(probeOut.success, true, "the lock must be released after the bound kill");
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test("qhuf2 (P2): a stale DEAD holder line is filtered and the trip points at the lock instead of guessing", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qhuf2-stale-" });
  await writeFakeBd(dir);
  const lock = `${dir}/sync.lock`;

  // An external process holds the flock but writes NO sidecar (a holder outside
  // the wrapper, or one SIGKILLed before cleanup): the sidecar carries only a
  // DEAD pid line. The trip must not name the dead pid as a killable holder.
  await Deno.writeTextFile(`${dir}/holder`, `pid=999999 cmd=bd-dolt-push start=dead-line\n`);
  const holder = await spawnExternalLockHolder(lock);
  try {
    const contended = await runWrapper(dir, ["push"], { CAP_BD_SYNC_WAIT: "1" });
    assertEquals(contended.code, 3, `a contended lock must fail loudly (exit 3): ${contended.stderr}`);
    assertEquals(contended.stderr.includes("999999"), false, "a DEAD holder line must never be named as killable");
    assertStringIncludes(contended.stderr, "no LIVE holder is recorded", "the trip must say honestly that no live holder is recorded");
    assertStringIncludes(contended.stderr, "lsof", "and point at inspecting the lock file directly");
    assertStringIncludes(contended.stderr, "fleet-cilm5");
    // The loser must not delete a sidecar it does not own.
    const holderKept = await Deno.readTextFile(`${dir}/holder`);
    assertStringIncludes(holderKept, "dead-line", "a losing contender must not delete the sidecar");
  } finally {
    holder.kill("SIGKILL");
    await holder.status.catch(() => {});
  }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test("qhuf2 (P2): TWO simultaneous contenders — the trip names the HOLDER only, and waiters are never recorded", async () => {
  // The review's exact scenario: with several waiting lanes, the pre-acquisition
  // write let the kill guidance name a WAITER. Now: the holder stamps the sidecar
  // AFTER acquiring; the two contenders write nothing, and both trips must name
  // the holder's pid and NEITHER contender's.
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qhuf2-two-" });
  await writeFakeBd(dir);
  const lock = `${dir}/sync.lock`;

  // The real holder: a wrapper run whose fake bd sleeps like a hung send-pack.
  const holderChild = wrapperCommand(dir, ["push"], { CAP_FAKE_BD_SLEEP: "8", CAP_BD_SYNC_HOLD: "30" }).spawn();
  const holderPid = holderChild.pid;
  try {
    await waitUntilHeld(lock);
    // The sidecar exists ONLY because the holder acquired it, and names ONLY the holder.
    const sidecar = await waitUntilSidecar(`${dir}/holder`);
    assertStringIncludes(sidecar, `pid=${holderPid} `, "the sidecar names the acquiring holder");
    assertEquals(sidecar.trim().split("\n").length, 1, "the sidecar holds exactly ONE line while a single holder runs");

    // Two contenders race the same locked wrapper simultaneously.
    const [resA, resB] = await Promise.all([
      (async () => {
        const c = wrapperCommand(dir, ["push"], { CAP_BD_SYNC_WAIT: "1" }).spawn();
        const pid = c.pid;
        const out = await c.output();
        return { pid, code: out.code, stderr: new TextDecoder().decode(out.stderr) };
      })(),
      (async () => {
        const c = wrapperCommand(dir, ["push"], { CAP_BD_SYNC_WAIT: "1" }).spawn();
        const pid = c.pid;
        const out = await c.output();
        return { pid, code: out.code, stderr: new TextDecoder().decode(out.stderr) };
      })(),
    ]);

    for (const [name, res, other] of [["A", resA, resB], ["B", resB, resA]] as const) {
      assertEquals(res.code, 3, `contender ${name} must trip the bounded wait (exit 3): ${res.stderr}`);
      assertStringIncludes(res.stderr, `pid=${holderPid}`, `contender ${name} must NAME the holder pid`);
      assertStringIncludes(res.stderr, "kill the pid above", `contender ${name} must carry the kill guidance`);
      assertEquals(res.stderr.includes(`pid=${other.pid} `), false,
        `contender ${name} must NEVER name the other WAITER (pid ${other.pid}) as a holder`);
    }

    // After both losers exited: the sidecar is STILL exactly the holder's line —
    // no waiter pid was ever recorded, and the losers did not delete it.
    const sidecarAfter = await Deno.readTextFile(`${dir}/holder`);
    assertStringIncludes(sidecarAfter, `pid=${holderPid} `, "the holder's record survives the losers");
    assertEquals(sidecarAfter.trim().split("\n").length, 1, "waiters are NEVER recorded in the sidecar");
  } finally {
    holderChild.kill("SIGKILL");
    await holderChild.status.catch(() => {});
  }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test("qhuf2: FLEET_BD_LOCKED=1 skips the wrapper's own lock (the shim's bypass) and stays bounded", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qhuf2-nested-" });
  await writeFakeBd(dir);
  const nested = await runWrapper(dir, ["pull"], { FLEET_BD_LOCKED: "1" });
  assertEquals(nested.code, 0, `the nested path must run bd directly: ${nested.stderr}`);
  const argv = await Deno.readTextFile(`${dir}/argv.log`);
  assertStringIncludes(argv, "dolt pull");
  const holderAbsent = await Deno.stat(`${dir}/holder`).then(() => true, () => false);
  assertEquals(holderAbsent, false, "the nested path must not write a holder sidecar (the outer holder owns it)");
  const lockAbsent = await Deno.stat(`${dir}/sync.lock`).then(() => true, () => false);
  assertEquals(lockAbsent, false, "the nested path must not create our lock file");
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test("qhuf2 (P1): the post-commit hook routes through the bound, and a MISSING wrapper falls back LOUDLY, never silently", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qhuf2-hook-" });
  await writeFakeBd(dir);
  await Deno.mkdir(`${dir}/scripts/git-hooks`, { recursive: true });
  await Deno.copyFile(HOOK, `${dir}/scripts/git-hooks/beads-push.sh`);
  // beads-push.sh resolves its log via git; give it a real (empty) repo.
  const gitInit = await new Deno.Command("git", { args: ["init", "-q", dir], cwd: dir }).output();
  assertEquals(gitInit.success, true, "temp git repo for the hook");

  const runHook = async (): Promise<{ code: number; stderr: string }> => {
    const out = await new Deno.Command("sh", {
      args: [`${dir}/scripts/git-hooks/beads-push.sh`],
      cwd: dir,
      env: {
        PATH: `${dir}/bin:/usr/bin:/bin`,
        HOME: dir,
        CAP_BD_SYNC_LOCK: `${dir}/sync.lock`,
        CAP_BD_SYNC_HOLDER: `${dir}/holder`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
  };

  // Case 1 — wrapper MISSING: the raw push still runs (a commit is never blocked)
  // but the fallback NAMES itself loudly on stderr and in the log.
  const loud = await runHook();
  assertEquals(loud.code, 0, "the hook must never block a commit");
  assertStringIncludes(loud.stderr, "UNBOUNDED", "the raw fallback must say LOUDLY that the push is unbounded");
  assertStringIncludes(loud.stderr, "qhuf2", "and name the bead so the warning is actionable");
  const loudLog = await Deno.readTextFile(`${dir}/.git/beads-push.log`);
  assertStringIncludes(loudLog, "UNBOUNDED", "the warning is captured in the push log too");
  const argvLoud = await Deno.readTextFile(`${dir}/argv.log`);
  assertStringIncludes(argvLoud, "dolt push", "the raw fallback did push");

  // Case 2 — wrapper PRESENT: the hook routes through the bound and stays quiet.
  await Deno.copyFile(WRAPPER, `${dir}/scripts/bd-sync-bound.sh`);
  await Deno.chmod(`${dir}/scripts/bd-sync-bound.sh`, 0o755);
  await Deno.remove(`${dir}/argv.log`);
  const routed = await runHook();
  assertEquals(routed.code, 0, `the routed push must succeed: ${routed.stderr}`);
  assertEquals(routed.stderr.includes("UNBOUNDED"), false, "a routed push must NOT claim to be unbounded");
  const argvRouted = await Deno.readTextFile(`${dir}/argv.log`);
  assertStringIncludes(argvRouted, "dolt push", "the wrapper carried the push to bd");
  const holderAfter = await Deno.stat(`${dir}/holder`).then(() => true, () => false);
  assertEquals(holderAfter, false, "the wrapper cleaned its sidecar after the routed push");
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});
