// CAP-FB-20260830-SUITE-HONESTY-01, revised by chrome-agent-platform-uzik.
//
// The canonical serialized-Chrome lock is now OPT-IN (`canonicalLock: true`) —
// it survives for the suites whose evidence needs machine determinism (the
// security custody chain). Everything else takes a slot of the bounded
// concurrency semaphore (tests/chrome-slot-semaphore.test.ts).
//
// What this file pins about the OPT-IN path, unchanged from the original:
//   - a launch queues behind another holder of the canonical lock;
//   - a launch that never gets it within its bound FAILS (never green);
//   - one process may hold it across two browsers, and releases it when the
//     last one exits;
//   - the wait is reported (`lockWaitMs`) so evidence says how long a gate queued.
// A stand-in "browser" prints Chrome's DevTools banner.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const origLockPath = Deno.env.get("CAP_CHROME_LOCK_PATH");
Deno.env.delete("CAP_SECURITY_NONCE");
Deno.env.delete("CAP_CHROME_LOCK_HELD");
// The launcher resolves the canonical path per call. A fresh path for each
// test prevents an earlier browser's asynchronous release or stale holder
// from being mistaken for this test's external flock under load.
const { launchChrome, teardownChrome } = await import("../scripts/lib/chrome-launch.ts");

const activeLocks = new Set<string>();
const activeFakes = new Set<string>();

async function fixtureLock(): Promise<string> {
  const lock = await Deno.makeTempFile({ prefix: "cap-chrome-lock-test-" });
  activeLocks.add(lock);
  // The parent resilience test attributes ALL markers to this child run.
  console.log(`CAP_LOCK_FIXTURE:${lock}`);
  Deno.env.set("CAP_CHROME_LOCK_PATH", lock);
  return lock;
}

async function fakeBrowser(): Promise<string> {
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  activeFakes.add(fake);
  await Deno.writeTextFile(
    fake,
    "#!/bin/sh\necho \"DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc\" 1>&2\nsleep 30\n",
  );
  await Deno.chmod(fake, 0o755);
  return fake;
}

async function removeTempFile(path: string, set?: Set<string>): Promise<void> {
  try {
    await Deno.remove(path);
  } catch { /* already gone */ }
  set?.delete(path);
}

/** Hold the canonical lock path exclusively from OUTSIDE this process, and CONFIRM the hold
 *  before returning. A bare `setTimeout` race is load-dependent: under the
 *  32-worker parallel phase a 300 ms sleep can land seconds late, the holder's
 *  own `sleep` can have ended, and the assertion then measures nothing. Probing
 *  with `flock -n` until it fails makes "the gate is busy" an observed fact. */
async function holdConfirmed(path: string, _seconds = 60): Promise<Deno.ChildProcess> {
  const holder = new Deno.Command("flock", {
    args: ["-o", "-w", "20", path, "cat"],
    stdin: "piped",
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
  try { await holder.stdin?.close(); } catch { /* gone */ }
  try { holder.kill("SIGKILL"); } catch { /* gone */ }
  await holder.status;
  throw new Error(`could not confirm an exclusive hold on ${path}`);
}


async function settled(proc: Deno.ChildProcess) {
  try { await proc.stdin?.close(); } catch { /* already closed */ }
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc.status; } catch { /* reaped */ }
}

Deno.test("uzik: an opt-in canonical launch queues behind another lane's holder and then proceeds", async () => {
  const lock = await fixtureLock();
  let holder: Deno.ChildProcess | undefined = undefined;
  let fake: string | undefined = undefined;
  let launched: Awaited<ReturnType<typeof launchChrome>> | undefined = undefined;
  try {
    holder = await holdConfirmed(lock);
    fake = await fakeBrowser();
    // Start the launch, keep the gate busy for at least a second, then release:
    // the queue time is OURS, so machine load can only make it longer, never
    // turn this into a measurement of nothing.
    const launching = launchChrome({ binary: fake, args: [], timeoutMs: 8000, canonicalLock: true });
    await new Promise((r) => setTimeout(r, 1200));
    await settled(holder);
    holder = undefined;
    launched = await launching;
    assert(launched.lockWaitMs > 0, `it really queued behind the holder (${launched.lockWaitMs} ms)`);
    assertEquals(launched.chromeSlot, -1, "the canonical scope is exclusive, not a slot");
  } finally {
    if (launched) await settled(launched.proc);
    if (holder) await settled(holder);
    if (fake) await removeTempFile(fake, activeFakes);
    await removeTempFile(lock, activeLocks);
  }
});

Deno.test("uzik: an opt-in canonical launch that cannot get the lock within its bound FAILS instead of starting", async () => {
  const lock = await fixtureLock();
  let holder: Deno.ChildProcess | undefined = undefined;
  let fake: string | undefined = undefined;
  try {
    holder = await holdConfirmed(lock);
    Deno.env.set("CAP_CHROME_LOCK_WAIT_MS", "800");
    fake = await fakeBrowser();
    await assertRejects(
      async () => {
        const unexpected = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, canonicalLock: true });
        // If the launch succeeds, assertRejects must still fail — but first
        // release its browser/ref so the next test cannot inherit a live lock.
        await teardownChrome(unexpected);
      },
      Error,
      "could not take the serialized-Chrome lock within 800 ms",
    );
  } finally {
    Deno.env.delete("CAP_CHROME_LOCK_WAIT_MS");
    if (holder) await settled(holder);
    if (fake) await removeTempFile(fake, activeFakes);
    await removeTempFile(lock, activeLocks);
  }
});

Deno.test("uzik: one process may hold the canonical lock across two browsers, and releases it when the last exits", async () => {
  const lock = await fixtureLock();
  let fake: string | undefined = undefined;
  let a: Awaited<ReturnType<typeof launchChrome>> | undefined = undefined;
  let b: Awaited<ReturnType<typeof launchChrome>> | undefined = undefined;
  try {
    fake = await fakeBrowser();
    a = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, canonicalLock: true });
    b = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, canonicalLock: true });
    // Successful first launch proves acquisition; a wall-clock ceiling here
    // measures fork/exec scheduling under parallel load, not lock correctness.
    assertEquals(a.chromeSlot, -1, "the first launch took the canonical scope");
    assertEquals(b.lockWaitMs, 0, "the second is reentrant inside this process — no queue");
    await settled(a.proc);
    a = undefined;
    // One browser still alive → the lock is still held, without a blind sleep.
    const blocked = new Deno.Command("flock", { args: ["-n", lock, "true"], stdout: "null", stderr: "null" }).spawn();
    assertEquals((await blocked.status).code, 1, "the lock lives until the LAST browser exits");
    await settled(b.proc);
    b = undefined;
    // Wait for the actual release callback; scheduler load may delay it, but
    // a never-released lock must still fail within a finite bound.
    let released = false;
    const deadline = Date.now() + 10000;
    do {
      const probe = new Deno.Command("flock", { args: ["-n", lock, "true"], stdout: "null", stderr: "null" }).spawn();
      released = (await probe.status).code === 0;
      if (released) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    assert(released, "the canonical lock was released after the last browser exited");
  } finally {
    if (a) await settled(a.proc);
    if (b) await settled(b.proc);
    if (fake) await removeTempFile(fake, activeFakes);
    await removeTempFile(lock, activeLocks);
  }
});

Deno.test("uzik: a clean process still defaults CHROME_LOCK_PATH to the canonical literal", async () => {
  // Earlier tests overrode the path, so read the default the way the
  // security custody chain depends on it: in a CLEAN subprocess. The supervisor
  // verifies an inherited flock against exactly that literal
  // (scripts/security-suite-custody.mjs verifyInheritedCanonicalLock), so a
  // rename here would break the custody gate before Chrome ever starts.
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { CHROME_LOCK_PATH, CHROME_LOCK_PATH_DEFAULT } from "${new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href}";
       console.log(JSON.stringify({ CHROME_LOCK_PATH, CHROME_LOCK_PATH_DEFAULT }))`,
    ],
    stdout: "piped",
    stderr: "null",
    clearEnv: true,
  }).output();
  assertEquals(out.code, 0, "the eval subprocess ran");
  const seen = JSON.parse(new TextDecoder().decode(out.stdout).trim());
  assertEquals(seen.CHROME_LOCK_PATH_DEFAULT, "/tmp/cap-serialized-chrome-acceptance.lock");
  assertEquals(seen.CHROME_LOCK_PATH, seen.CHROME_LOCK_PATH_DEFAULT, "no env → the canonical default");
});

Deno.test("cleanup: chrome-launch-lock restores env after temporary lock fixtures", async () => {
  if (origLockPath === undefined) Deno.env.delete("CAP_CHROME_LOCK_PATH");
  else Deno.env.set("CAP_CHROME_LOCK_PATH", origLockPath);
  for (const lock of [...activeLocks]) {
    await removeTempFile(lock, activeLocks);
  }
  for (const fake of [...activeFakes]) {
    await removeTempFile(fake, activeFakes);
  }
});
