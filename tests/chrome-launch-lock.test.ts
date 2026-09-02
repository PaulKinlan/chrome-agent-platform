// CAP-FB-20260830-SUITE-HONESTY-01 — launchChrome() takes the serialized-Chrome
// lock for the browser's lifetime: a launch queues behind another holder, a
// launch that never gets the lock FAILS (never green), and one process may
// launch twice. A stand-in "browser" prints Chrome's DevTools banner.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const LOCK = await Deno.makeTempFile({ prefix: "cap-chrome-lock-test-" });
Deno.env.set("CAP_CHROME_LOCK_PATH", LOCK);
Deno.env.delete("CAP_SECURITY_NONCE");
Deno.env.delete("CAP_CHROME_LOCK_HELD");
// Import AFTER the env is set: the module reads the lock path at load.
const { launchChrome } = await import("../scripts/lib/chrome-launch.ts");

async function fakeBrowser(): Promise<string> {
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    fake,
    "#!/bin/sh\necho \"DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc\" 1>&2\nsleep 30\n",
  );
  await Deno.chmod(fake, 0o755);
  return fake;
}

function holdLock(seconds: number): Deno.ChildProcess {
  // -o keeps the lock fd in flock itself (not the sleep), so killing flock releases it.
  return new Deno.Command("flock", { args: ["-o", LOCK, "sleep", String(seconds)], stdout: "null", stderr: "null" }).spawn();
}

Deno.test("a launch queues behind another lane's holder and then proceeds", async () => {
  const holder = holdLock(3);
  await new Promise((r) => setTimeout(r, 300)); // the holder has the lock
  const fake = await fakeBrowser();
  const t0 = Date.now();
  const { proc, lockWaitMs } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
  const elapsed = Date.now() - t0;
  assert(elapsed >= 2000, `expected to wait for the holder, waited ${elapsed} ms`);
  assert(lockWaitMs >= 2000, `lockWaitMs should record the queue (${lockWaitMs})`);
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  await proc.status;
  try { holder.kill("SIGKILL"); } catch { /* gone */ }
  await holder.status;
  await Deno.remove(fake);
});

Deno.test("a launch that cannot get the lock within its bound FAILS instead of starting", async () => {
  const holder = holdLock(30);
  await new Promise((r) => setTimeout(r, 300));
  Deno.env.set("CAP_CHROME_LOCK_WAIT_MS", "1000");
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    await assertRejects(
      () => launchChrome({ binary: fake, args: [], timeoutMs: 5000 }),
      Error,
      "could not take the serialized-Chrome lock",
    );
  } finally {
    Deno.env.delete("CAP_CHROME_LOCK_WAIT_MS");
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    await holder.status;
    await Deno.remove(fake);
  }
  assert(Date.now() - t0 < 6000, "the bound is honoured");
});

Deno.test("one process may hold the lock across two browsers, and releases it when the last exits", async () => {
  const fake = await fakeBrowser();
  const a = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
  const b = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
  assertEquals(b.lockWaitMs, 0);
  try { a.proc.kill("SIGKILL"); } catch { /* gone */ }
  await a.proc.status;
  try { b.proc.kill("SIGKILL"); } catch { /* gone */ }
  await b.proc.status;
  await new Promise((r) => setTimeout(r, 300));
  // Another process can now take it promptly.
  const probe = new Deno.Command("flock", { args: ["-w", "3", LOCK, "true"] }).spawn();
  const s = await probe.status;
  assertEquals(s.code, 0, "the lock was released after the last browser exited");
  await Deno.remove(fake);
});
