// tests/chrome-launch-lock-scope.test.ts — chrome-agent-platform-51x4
// The serialized-Chrome lock exists so two REAL browsers never fight for the
// box. Fake-browser unit fixtures (/bin/true, a shell script printing the
// DevTools banner) used to take the SAME canonical lock — a unit test waited
// >80 s behind a real acceptance lane and the outer command died. Now:
//   - fake fixtures take their OWN isolated lock scope (lockPath) and finish
//     while the canonical lock is held by a real gate;
//   - the DEFAULT scope is still the canonical lock (real harnesses share it);
//   - scopes are independent in BOTH directions (holding a fixture scope must
//     not unblock the canonical queue).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const CANONICAL = "/tmp/cap-serialized-chrome-acceptance.lock";
const SCOPE_A = await Deno.makeTempFile({ prefix: "cap-lock-scope-a-" });
const SCOPE_B = await Deno.makeTempFile({ prefix: "cap-lock-scope-b-" });
Deno.env.delete("CAP_SECURITY_NONCE");
Deno.env.delete("CAP_CHROME_LOCK_HELD");
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

function holdLock(path: string, seconds: number): Deno.ChildProcess {
  return new Deno.Command("flock", { args: ["-o", "-w", "15", path, "sleep", String(seconds)], stdout: "null", stderr: "null" }).spawn();
}

Deno.test("the default lock scope IS the canonical serialized-Chrome lock", async () => {
  // In a CLEAN subprocess: a shared test process can bind the constant after
  // another file's CAP_CHROME_LOCK_PATH override — the pin must read the
  // module's own default, not the order the runner happened to load us in.
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", `import { CHROME_LOCK_PATH } from "${new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href}"; console.log(CHROME_LOCK_PATH)`],
    stdout: "piped", stderr: "null", clearEnv: true,
  }).output();
  assertEquals(out.code, 0, "the eval subprocess ran");
  assertEquals(new TextDecoder().decode(out.stdout).trim(), CANONICAL,
    "real harnesses keep sharing the canonical lock");
});

Deno.test("a fake-browser fixture finishes while the canonical lock is held by a real gate", async () => {
  const holder = holdLock(CANONICAL, 20);
  await new Promise((r) => setTimeout(r, 400)); // the holder owns the canonical lock
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    const { proc, lockWaitMs } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_A });
    const elapsed = Date.now() - t0;
    assert(elapsed < 4000, `the fixture must not queue behind the canonical lock (${elapsed} ms)`);
    assert(lockWaitMs < 1500, `its own scope was free — a few ms of flock spawn, never a queue (${lockWaitMs} ms)`);
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    await proc.status;
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    await holder.status;
    await Deno.remove(fake);
  }
});

Deno.test("the canonical default still queues (and fails honestly) behind a real gate", async () => {
  const holder = holdLock(CANONICAL, 20);
  await new Promise((r) => setTimeout(r, 400));
  Deno.env.set("CAP_CHROME_LOCK_WAIT_MS", "800");
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    await assertRejects(
      () => launchChrome({ binary: fake, args: [], timeoutMs: 5000 }),
      Error,
      "could not take the serialized-Chrome lock",
    );
    assert(Date.now() - t0 < 6000, "the bounded wait is honoured");
  } finally {
    Deno.env.delete("CAP_CHROME_LOCK_WAIT_MS");
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    await holder.status;
    await Deno.remove(fake);
  }
});

Deno.test("a held fixture scope never leaks into another scope (and the held scope still fails honestly)", async () => {
  // Scope independence in the direction CI can prove: SCOPE_B held must not
  // block SCOPE_A, and a launch on the HELD scope still fails honestly. (The
  // canonical scope is never asserted FREE — under a real acceptance lane it
  // is legitimately held; that direction is covered by the default-queues
  // test above plus the CHROME_LOCK_PATH constant pin.)
  const scopeHolder = holdLock(SCOPE_B, 20);
  await new Promise((r) => setTimeout(r, 400));
  const fake = await fakeBrowser();
  const t0 = Date.now();
  try {
    const { proc } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_A });
    assert(Date.now() - t0 < 4000, "one scope never queues behind another scope's holder");
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    await proc.status;
    Deno.env.set("CAP_CHROME_LOCK_WAIT_MS", "800");
    await assertRejects(
      () => launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_B }),
      Error,
      "could not take the serialized-Chrome lock",
    );
  } finally {
    Deno.env.delete("CAP_CHROME_LOCK_WAIT_MS");
    try { scopeHolder.kill("SIGKILL"); } catch { /* gone */ }
    await scopeHolder.status;
    await Deno.remove(fake);
  }
});

Deno.test("a released fixture scope leaves no lock residue behind", async () => {
  const fake = await fakeBrowser();
  const { proc } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: SCOPE_A });
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  await proc.status;
  await new Promise((r) => setTimeout(r, 800));
  // Another process takes the scope promptly → the fixture's holder exited.
  const probe = new Deno.Command("flock", { args: ["-w", "5", SCOPE_A, "true"] }).spawn();
  assertEquals((await probe.status).code, 0, "the fixture scope was released");
  await Deno.remove(fake);
});
