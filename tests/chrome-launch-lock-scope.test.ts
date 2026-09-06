// tests/chrome-launch-lock-scope.test.ts — chrome-agent-platform-51x4, revised
// by chrome-agent-platform-uzik.
//
// 51x4 gave fake-browser unit fixtures their OWN lock scope (`lockPath`) so a
// unit test never waited >80 s behind a real acceptance lane. That property is
// preserved exactly.
//
// What uzik changed is the DEFAULT. It used to be the canonical
// serialized-Chrome lock — one browser per machine. It is now a slot of the
// bounded-concurrency semaphore, because every launch is already isolated by a
// kernel-assigned debugging port and its own `--user-data-dir`. So:
//   - a DEFAULT launch does not queue behind the canonical lock (that lock is
//     opt-in, `canonicalLock: true` — see tests/chrome-launch-lock.test.ts);
//   - a fixture's own scope still never queues behind the machine, and still
//     costs no slot;
//   - fixture scopes stay independent in both directions;
//   - a released scope leaves no residue behind.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const CANONICAL = "/tmp/cap-serialized-chrome-acceptance.lock";
const SCOPE_A = await Deno.makeTempFile({ prefix: "cap-lock-scope-a-" });
const SCOPE_B = await Deno.makeTempFile({ prefix: "cap-lock-scope-b-" });
const SLOT_DIR = await Deno.makeTempDir({ prefix: "cap-lock-scope-slots-" });
Deno.env.delete("CAP_SECURITY_NONCE");
Deno.env.delete("CAP_CHROME_LOCK_HELD");
Deno.env.set("CAP_CHROME_SLOT_DIR", SLOT_DIR);
Deno.env.delete("CAP_CHROME_LOCK_PATH");
const { launchChrome } = await import("../scripts/lib/chrome-launch.ts");
const { slotFile } = await import("../scripts/lib/chrome-slots.ts");

async function fakeBrowser(): Promise<string> {
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    fake,
    "#!/bin/sh\necho \"DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc\" 1>&2\nsleep 30\n",
  );
  await Deno.chmod(fake, 0o755);
  return fake;
}

function holdLock(path: string, seconds: number): Deno.ChildProcess {
  return new Deno.Command("flock", { args: ["-o", "-w", "15", path, "sleep", String(seconds)], stdout: "null", stderr: "null" }).spawn();
}

/** Hold `path` exclusively from OUTSIDE this process, and CONFIRM the hold
 *  before returning. A bare `setTimeout` race is load-dependent: under the
 *  32-worker parallel phase a 300 ms sleep can land seconds late, the holder's
 *  own `sleep` can have ended, and the assertion then measures nothing. Probing
 *  with `flock -n` until it fails makes "the gate is busy" an observed fact. */
async function holdConfirmed(path: string, seconds = 60): Promise<Deno.ChildProcess> {
  const holder = new Deno.Command("flock", {
    args: ["-o", "-w", "20", path, "sleep", String(seconds)],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const deadline = Date.now() + 20000;
  for (;;) {
    const probe = new Deno.Command("flock", { args: ["-n", path, "true"], stdout: "null", stderr: "null" }).spawn();
    const code = (await probe.status).code;
    if (code === 1) return holder; // busy → the hold is real
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  try { holder.kill("SIGKILL"); } catch { /* gone */ }
  await holder.status;
  throw new Error(`could not confirm an exclusive hold on ${path}`);
}


async function settled(proc: Deno.ChildProcess) {
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc.status; } catch { /* reaped */ }
}

Deno.test("uzik: the DEFAULT scope is no longer the canonical lock", async () => {
  // In a CLEAN subprocess: a shared test process can bind constants after
  // another file's env override — the pin must read the module's own defaults,
  // not the order the runner happened to load us in.
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", `
      import { CHROME_LOCK_PATH_DEFAULT } from "${new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href}";
      import { CHROME_SLOT_FILE_PREFIX, DEFAULT_MAX_CONCURRENT_CHROMES, slotFile } from "${new URL("../scripts/lib/chrome-slots.ts", import.meta.url).href}";
      console.log(JSON.stringify({ CHROME_LOCK_PATH_DEFAULT, CHROME_SLOT_FILE_PREFIX, DEFAULT_MAX_CONCURRENT_CHROMES, slot0: slotFile(0) }));`],
    stdout: "piped", stderr: "null", clearEnv: true,
  }).output();
  assertEquals(out.code, 0, "the eval subprocess ran");
  const seen = JSON.parse(new TextDecoder().decode(out.stdout).trim());
  assertEquals(seen.CHROME_LOCK_PATH_DEFAULT, CANONICAL, "the opt-in canonical lock keeps its path");
  assertEquals(seen.CHROME_SLOT_FILE_PREFIX, "cap-chrome-slot-");
  assertEquals(seen.DEFAULT_MAX_CONCURRENT_CHROMES, 4, "the documented default bound");
  assertEquals(seen.slot0, "/tmp/cap-chrome-slot-0.lock", "slots default to the tmpfs coordination dir");
});

Deno.test("uzik: a default launch proceeds while another lane holds the canonical lock", async () => {
  const holder = await holdConfirmed(CANONICAL); // the holder owns the machine's exclusive gate
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    const launched = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
    const elapsed = Date.now() - t0;
    assert(elapsed < 5000, `the default path must not queue behind the canonical lock (${elapsed} ms)`);
    assert(launched.chromeSlot >= 0, "it took a concurrency slot instead");
    await settled(launched.proc);
  } finally {
    await settled(holder);
    await Deno.remove(fake);
  }
});

Deno.test("51x4: a fake-browser fixture finishes while the whole machine is busy", async () => {
  // Canonical lock held AND every slot held: the fixture's own scope still runs.
  Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "1");
  const canonical = await holdConfirmed(CANONICAL);
  const slot = await holdConfirmed(slotFile(0));
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    const { proc, lockWaitMs, chromeSlot } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_A });
    const elapsed = Date.now() - t0;
    assert(elapsed < 4000, `the fixture must not queue behind the machine (${elapsed} ms)`);
    assert(lockWaitMs < 1500, `its own scope was free — a few ms of flock spawn, never a queue (${lockWaitMs} ms)`);
    assertEquals(chromeSlot, -1, "a fixture scope spends no slot of the browser budget");
    await settled(proc);
  } finally {
    Deno.env.delete("CAP_CHROME_MAX_CONCURRENT");
    await settled(canonical);
    await settled(slot);
    await Deno.remove(fake);
  }
});

Deno.test("51x4: a held fixture scope never leaks into another scope (and still fails honestly)", async () => {
  // Scope independence in the direction CI can prove: SCOPE_B held must not
  // block SCOPE_A, and a launch on the HELD scope still fails honestly. (The
  // canonical scope is never asserted FREE — under a real acceptance lane it is
  // legitimately held.)
  const scopeHolder = await holdConfirmed(SCOPE_B);
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    const { proc } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_A });
    assert(Date.now() - t0 < 4000, "one scope never queues behind another scope's holder");
    await settled(proc);
    Deno.env.set("CAP_CHROME_LOCK_WAIT_MS", "800");
    await assertRejects(
      () => launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_B }),
      Error,
      "could not take the serialized-Chrome lock",
    );
  } finally {
    Deno.env.delete("CAP_CHROME_LOCK_WAIT_MS");
    await settled(scopeHolder);
    await Deno.remove(fake);
  }
});

Deno.test("51x4: a released fixture scope leaves no lock residue behind", async () => {
  const fake = await fakeBrowser();
  const { proc } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_A });
  await settled(proc);
  await new Promise((r) => setTimeout(r, 800));
  // Another process takes the scope promptly → the fixture's holder exited.
  const probe = new Deno.Command("flock", { args: ["-w", "5", SCOPE_A, "true"] }).spawn();
  assertEquals((await probe.status).code, 0, "the fixture scope was released");
  await Deno.remove(fake);
});
