// chrome-agent-platform-qhuf2: the bd-sync-bound.sh contract. The fleet shim bounds
// the flock WAIT but never the HOLDER, so a hung `bd dolt push` (git send-pack stuck)
// held ~/.fleet/bd-sync.lock and the embedded dolt DB for 25+ minutes while every
// lane write failed with the misleading "database is locked by another dolt process".
// The wrapper is the project-side mitigation: bounded wait, bounded hold, and a
// sidecar that NAMES the live holder so the next lane kills the right process.
// Driven here against a FAKE bd on PATH — never against the real DB.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";

const WRAPPER = fromFileUrl(new URL("../scripts/bd-sync-bound.sh", import.meta.url));

interface RunResult {
  code: number;
  stderr: string;
  elapsedMs: number;
}

async function runWrapper(dir: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  const t0 = Date.now();
  const command = new Deno.Command("/bin/bash", {
    args: [WRAPPER, ...args],
    cwd: dir,
    env: {
      PATH: `${dir}/bin:/usr/bin:/bin`,
      HOME: dir,
      CAP_BD_SYNC_LOCK: `${dir}/sync.lock`,
      CAP_BD_SYNC_HOLDER: `${dir}/holder`,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
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

/** A live external holder of the lock, for the contention case. Returns its pid. */
async function spawnLockHolder(lock: string): Promise<Deno.ChildProcess> {
  const holder = new Deno.Command("flock", { args: [lock, "-c", "sleep 8"] });
  const child = holder.spawn();
  // The flock is only held once flock(1) has actually started; poll the lock's
  // contention by trying a zero-wait acquire from this process.
  for (let i = 0; i < 50; i++) {
    const probe = new Deno.Command("flock", { args: ["-w", "0", lock, "true"] });
    const probeOut = await probe.output();
    if (!probeOut.success) return child; // contended: the holder has it
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the external lock holder never acquired the lock");
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

Deno.test("qhuf2: a contender names the ALIVE holder pid and filters dead lines", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qhuf2-contend-" });
  await writeFakeBd(dir);
  const lock = `${dir}/sync.lock`;

  // Seed the sidecar with a DEAD pid line and a LIVE pid line. The dead one must be
  // filtered; the live one must be named.
  const sleeper = new Deno.Command("sleep", { args: ["8"] }).spawn();
  await Deno.writeTextFile(
    `${dir}/holder`,
    `pid=999999 cmd=bd-dolt-push start=dead-line\n` +
      `pid=${sleeper.pid} cmd=bd-dolt-push start=the-real-holder\n`,
  );
  const holder = await spawnLockHolder(lock);
  try {
    const contended = await runWrapper(dir, ["push"], { CAP_BD_SYNC_WAIT: "1" });
    assertEquals(contended.code, 3, `a contended lock must fail loudly (exit 3): ${contended.stderr}`);
    assertStringIncludes(contended.stderr, `pid=${sleeper.pid}`, "the contender must NAME the live holder pid");
    assertStringIncludes(contended.stderr, "kill the pid above", "the contender must say what to do about it");
    assertEquals(contended.stderr.includes("999999"), false, "a dead holder line must never be named");
    // The contender must NOT have removed the holder file it did not own.
    const holderKept = await Deno.readTextFile(`${dir}/holder`);
    assertStringIncludes(holderKept, "the-real-holder", "a losing contender must not delete the winner's sidecar");
  } finally {
    sleeper.kill("SIGKILL");
    await sleeper.status.catch(() => {});
    holder.kill("SIGKILL");
    await holder.status.catch(() => {});
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
