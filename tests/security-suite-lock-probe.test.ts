// chrome-agent-platform-jjsz: the no-/proc (macOS) canonical-lock probe must FAIL CLOSED.
//
// The first macOS draft of `verifyInheritedCanonicalLock` returned "verified" for ANY flock
// rejection, so a box without a `flock` binary (or a usage error, or a signal) read as "the
// supervisor's lock is held". These tests pin the verdict table with an injected runner (so
// they run on Linux CI too, where the real branch is never taken) and then prove the real
// `flock` agrees with the table: held -> verified, free -> refused.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { FLOCK_HELD_EXIT, probeCanonicalLockHeld } from "../scripts/security-suite-custody.mjs";

const NOT_HELD = "canonical inherited lock has no live exclusive flock";
const UNVERIFIED = "canonical inherited lock could not be verified (flock unavailable or failed)";

const rejectWith = (props: Record<string, unknown>) => () =>
  Promise.reject(Object.assign(new Error("flock failed"), props));

Deno.test("probeCanonicalLockHeld: only the distinctive held status proves the lock is live", async () => {
  assertEquals(await probeCanonicalLockHeld("/x", rejectWith({ code: FLOCK_HELD_EXIT })), null);
});

Deno.test("probeCanonicalLockHeld: acquiring the lock means nobody holds it", async () => {
  assertEquals(
    await probeCanonicalLockHeld("/x", () => Promise.resolve({ stdout: "", stderr: "" })),
    NOT_HELD,
  );
});

Deno.test("probeCanonicalLockHeld: a missing flock binary fails closed, never reads as held", async () => {
  assertEquals(await probeCanonicalLockHeld("/x", rejectWith({ code: "ENOENT" })), UNVERIFIED);
});

Deno.test("probeCanonicalLockHeld: the default conflict status, a usage status and a signal all fail closed", async () => {
  const failures: Record<string, unknown>[] = [
    { code: 1 }, // flock's DEFAULT conflict code, which a usage error also produces
    { code: 2 },
    { code: 64 },
    { code: 127 },
    { code: null, signal: "SIGKILL" },
    {}, // a rejection carrying no status at all
  ];
  for (const failure of failures) {
    assertEquals(
      await probeCanonicalLockHeld("/x", rejectWith(failure)),
      UNVERIFIED,
      `rejection ${JSON.stringify(failure)} must not prove the lock is held`,
    );
  }
});

Deno.test("probeCanonicalLockHeld: asks flock for exactly the distinctive conflict code on the lock path", async () => {
  let seen: string[] = [];
  await probeCanonicalLockHeld("lock-path-under-test", (file: string, args: string[]) => {
    seen = [file, ...args];
    return rejectWith({ code: FLOCK_HELD_EXIT })();
  });
  assertEquals(seen, ["flock", "-n", "-E", String(FLOCK_HELD_EXIT), "lock-path-under-test", "true"]);
});

Deno.test("probeCanonicalLockHeld: the REAL flock agrees — a live holder is verified, a released lock is refused", async () => {
  const dir = Deno.makeTempDirSync({ dir: durableDir("jjsz-lock-probe-scratch"), prefix: "probe-" });
  const lock = `${dir}/canonical.lock`;
  Deno.writeTextFileSync(lock, "");
  // The holder takes the exclusive lock, announces it, then blocks on stdin. Its only life
  // line is that pipe, so a dying test process closes it and the holder exits with it.
  const holder = new Deno.Command("flock", {
    args: ["-x", lock, "sh", "-c", "echo held; cat >/dev/null"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const decoder = new TextDecoder();
  const reader = holder.stdout.getReader();
  let announced = "";
  try {
    while (!announced.includes("held")) {
      const { value, done } = await reader.read();
      if (done) break;
      announced += decoder.decode(value);
    }
    assert(announced.includes("held"), "the flock holder must announce that it owns the lock");

    assertEquals(
      await probeCanonicalLockHeld(lock),
      null,
      "a lock held by a live open file description must verify",
    );

    // Release: closing stdin ends `cat`, the holder exits, the kernel drops the lock.
    await holder.stdin.close();
    await holder.status;
    assertEquals(
      await probeCanonicalLockHeld(lock),
      NOT_HELD,
      "a lock nobody holds must be refused, not verified",
    );
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
    try { await holder.stdin.close(); } catch { /* already closed */ }
    try { await reader.cancel(); } catch { /* already drained */ }
    try { await holder.status; } catch { /* reaped */ }
    Deno.removeSync(dir, { recursive: true });
  }
});
