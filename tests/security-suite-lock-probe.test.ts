// chrome-agent-platform-jjsz: the no-/proc (macOS) canonical-lock probe must FAIL CLOSED.
//
// The first macOS draft of `verifyInheritedCanonicalLock` returned "verified" for ANY flock
// rejection, so a box without a `flock` binary (or a usage error, or a signal) read as "the
// supervisor's lock is held". These tests pin the verdict table with an injected runner (so
// they run on Linux CI too, where the real branch is never taken) and then prove the real
// `flock` agrees with the table: held -> verified, free -> refused.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { FLOCK_HELD_EXIT, probeCanonicalLockHeld } from "../scripts/security-suite-custody.mjs";

const NOT_HELD = "canonical inherited lock has no live exclusive flock";
const UNVERIFIED = "canonical inherited lock could not be verified (flock unavailable or failed)";

const rejectWith = (props: Record<string, unknown>) => () =>
  Promise.reject(Object.assign(new Error("flock failed"), props));

/**
 * Run each cleanup step in its OWN try/catch and never throw (jjsz N8). Cleanup in a `finally` must never
 * replace the assertion error that is already propagating, and one failing step must not skip the steps
 * after it. A swallowed failure is still REPORTED (stderr by default), so a leak does not go unseen: it is
 * only barred from becoming the test's verdict. Never use it for the ASSERTING part of a test.
 */
async function cleanupSteps(
  steps: Array<() => unknown>,
  report: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      report(`cleanup step failed (ignored so it cannot mask the test's own result): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

Deno.test("probeCanonicalLockHeld: only the distinctive held status proves the lock is live", async () => {
  // The held shape is the distinctive status AND a silent stderr (jjsz F4): a real held flock writes
  // nothing, whereas every failure of flock's own prints a diagnostic.
  assertEquals(
    await probeCanonicalLockHeld("/x", rejectWith({ code: FLOCK_HELD_EXIT, stderr: "" })),
    null,
  );
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

// A RAW probe: it runs the real `flock` binary, never the library under test, so a regression in the
// library can only turn the real-flock tests RED, never silently IGNORED. Both real-flock tests in this
// file (this one and the jjsz F4 one below) share it, so the file has ONE policy: they run wherever
// `flock` works and are skipped, visibly as `ignored`, where it does not. The verdict-table tests above
// drive `probeCanonicalLockHeld` through its `run` seam and run on EVERY host, so the logic stays
// covered when these two are skipped.
const FLOCK_AVAILABLE = (() => {
  try {
    return new Deno.Command("flock", { args: ["--version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "probeCanonicalLockHeld: the REAL flock agrees — a live holder is verified, a released lock is refused",
  ignore: !FLOCK_AVAILABLE,
  fn: async () => {
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
      await cleanupSteps([() => Deno.removeSync(dir, { recursive: true })]);
    }
  },
});

// ---------------------------------------------------------------------------------------------
// chrome-agent-platform-jjsz F4: the held status must not collide with flock's OWN failure statuses.
//
// The first macOS draft used 73. util-linux flock exits 73 (EX_CANTCREAT) when it cannot open the lock
// file on a read-only or full filesystem, so an unusable lock path would have read as "held". The held
// verdict now needs a status flock never uses for itself AND a silent stderr (every own failure prints a
// diagnostic). The tests pin those PROPERTIES, then prove with the real flock that a genuinely held lock
// still verifies and an own failure does not.
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F4: the held status sits outside every range flock or a launcher uses for its own failures", () => {
  assert(
    Number.isInteger(FLOCK_HELD_EXIT) && FLOCK_HELD_EXIT > 1 && FLOCK_HELD_EXIT < 256,
    `FLOCK_HELD_EXIT must be a status in 2..255, got ${FLOCK_HELD_EXIT}`,
  );
  const sysexits = Array.from({ length: 15 }, (_, i) => 64 + i); // 64..78
  for (const own of [...sysexits, 1, 126, 127, 255]) {
    assert(
      FLOCK_HELD_EXIT !== own,
      `FLOCK_HELD_EXIT ${FLOCK_HELD_EXIT} collides with ${own}, a status flock or a launcher uses for its own failures`,
    );
  }
});

Deno.test("jjsz F4: a flock status that collides with the held status never reads as held", async () => {
  const diagnostic = "flock: cannot open lock file /x: Read-only file system\n";

  // The held status WITH a diagnostic is a failure of flock's own that reused our code.
  assertEquals(
    await probeCanonicalLockHeld("/x", rejectWith({ code: FLOCK_HELD_EXIT, stderr: diagnostic })),
    UNVERIFIED,
    "the held status with a non-empty stderr is not proof of a held lock",
  );

  // The held status whose stderr cannot be confirmed silent.
  for (const stderr of [undefined, null, " ", "\n"]) {
    assertEquals(
      await probeCanonicalLockHeld("/x", rejectWith({ code: FLOCK_HELD_EXIT, stderr })),
      UNVERIFIED,
      `the held status with stderr ${JSON.stringify(stderr)} must not verify`,
    );
  }

  // Every sysexits status is one of flock's own failures, silent or not.
  for (let code = 64; code <= 78; code++) {
    for (const stderr of ["", diagnostic]) {
      assertEquals(
        await probeCanonicalLockHeld("/x", rejectWith({ code, stderr })),
        UNVERIFIED,
        `sysexits status ${code} (stderr ${JSON.stringify(stderr)}) must not prove the lock is held`,
      );
    }
  }
});

Deno.test({
  name: "jjsz F4: REAL flock — a held lock exits with the held status and a SILENT stderr, an own failure does not",
  ignore: !FLOCK_AVAILABLE,
  fn: async () => {
    const dir = Deno.makeTempDirSync({ dir: durableDir("jjsz-lock-probe-scratch"), prefix: "f4-" });
    const lock = `${dir}/canonical.lock`;
    Deno.writeTextFileSync(lock, "");
    // The holder takes the exclusive lock, announces it, then blocks on stdin; that pipe is its only life line.
    const holder = new Deno.Command("flock", {
      args: ["-x", lock, "sh", "-c", "echo held; cat >/dev/null"],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const decoder = new TextDecoder();
    const reader = holder.stdout.getReader();
    const rawFlock = async (path: string) => {
      const out = await new Deno.Command("flock", {
        args: ["-n", "-E", String(FLOCK_HELD_EXIT), path, "true"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: out.code, stderr: decoder.decode(out.stderr) };
    };
    try {
      let announced = "";
      while (!announced.includes("held")) {
        const { value, done } = await reader.read();
        if (done) break;
        announced += decoder.decode(value);
      }
      assert(announced.includes("held"), "fixture: the flock holder must announce that it owns the lock");

      // The raw contract the verdict rests on: held = the held status and nothing on stderr.
      const held = await rawFlock(lock);
      assertEquals(held.code, FLOCK_HELD_EXIT, "a held lock must exit with the held status");
      assertEquals(held.stderr, "", "a held lock must be SILENT on stderr: the held verdict relies on it");
      assertEquals(await probeCanonicalLockHeld(lock), null, "a genuinely held lock must verify");

      // An own failure of flock's: the lock path cannot be opened. It must differ from the held shape
      // and must never verify.
      const unopenable = `${dir}/no-such-dir/canonical.lock`;
      const own = await rawFlock(unopenable);
      assert(own.code !== FLOCK_HELD_EXIT, `an unopenable path must not exit ${FLOCK_HELD_EXIT}`);
      assert(own.stderr.length > 0, "an own failure of flock must explain itself on stderr");
      assertEquals(
        await probeCanonicalLockHeld(unopenable),
        UNVERIFIED,
        "an unopenable lock path must never read as held",
      );

      // Release: the lock is free again and the probe says so.
      await holder.stdin.close();
      await holder.status;
      assertEquals(await probeCanonicalLockHeld(lock), NOT_HELD, "a released lock must not verify");
    } finally {
      try { holder.kill("SIGKILL"); } catch { /* already gone */ }
      try { await holder.stdin.close(); } catch { /* already closed */ }
      try { await reader.cancel(); } catch { /* already drained */ }
      try { await holder.status; } catch { /* reaped */ }
      await cleanupSteps([() => Deno.removeSync(dir, { recursive: true })]);
    }
  },
});

// ---------------------------------------------------------------------------------------------
// jjsz N8: cleanup in a `finally` must never replace the real assertion error.
//
// The helper is exercised with INJECTED failing steps (a real teardown failure cannot be produced on
// demand). Drill: make the helper rethrow, or stop at the first failing step, and this test goes RED.
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz N8: the cleanup helper never throws, runs every later step after a failing one, reports the failure, and cannot replace the error already propagating", async () => {
  const ran: string[] = [];
  const reported: string[] = [];
  await cleanupSteps([
    () => {
      ran.push("synchronous step that throws");
      throw new Error("injected synchronous failure");
    },
    async () => {
      ran.push("asynchronous step that rejects");
      await Promise.resolve();
      throw new Error("injected asynchronous failure");
    },
    () => {
      ran.push("step after the failures");
    },
  ], (line) => reported.push(line));
  assertEquals(
    ran,
    ["synchronous step that throws", "asynchronous step that rejects", "step after the failures"],
    "every step ran, in order, although the ones before it failed",
  );
  assertEquals(reported.length, 2, "each swallowed failure is reported once, never silent");
  assert(reported[0].includes("injected synchronous failure"), reported[0]);
  assert(reported[1].includes("injected asynchronous failure"), reported[1]);

  // End to end through a `finally`, the shape of every site: the test's OWN error is what surfaces.
  const own = new Error("the assertion that actually failed");
  const surfaced = await assertRejects(async () => {
    try {
      throw own;
    } finally {
      await cleanupSteps([() => {
        throw new Error("injected cleanup failure");
      }], () => {});
    }
  });
  assertStrictEquals(surfaced, own, "a failing cleanup must not replace the error that was already propagating");
});
