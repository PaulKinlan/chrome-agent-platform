// chrome-agent-platform-jjsz F3 — the no-/proc (macOS) branch of verifyInheritedCanonicalLock.
//
// That branch is the ONLY thing standing between a stray process holding a descriptor on some other
// file and the supervisor's custody check, and it could not run on Linux, so none of its verdicts had a
// test. It now takes optional seams (`hasProc`, `fstat`, `statPath`, `probe`; defaults = the previous
// behaviour), which pin the verdict table on EVERY platform:
//   - the descriptor is missing                      -> refused, nothing else consulted
//   - the lock path cannot be read                   -> refused, the probe is NOT called
//   - device or inode differs (fd is another file)   -> refused, the probe is NOT called
//   - same file, lock held                           -> verified (null)
//   - same file, lock not held / unverifiable        -> the probe's refusal, never "ok"
// A real-descriptor / real-flock integration test at the end runs the same branch against real stat
// data, never touching the real canonical lock.
import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";
import { closeSync, fstatSync, openSync, statSync } from "node:fs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  CANONICAL_LOCK,
  probeCanonicalLockHeld,
  verifyInheritedCanonicalLock,
} from "../scripts/security-suite-custody.mjs";

const MISSING = "canonical inherited lock fd is missing";
const WRONG_TARGET = "inherited lock fd has the wrong target";
const NOT_HELD = "canonical inherited lock has no live exclusive flock";
const UNVERIFIED = "canonical inherited lock could not be verified (flock unavailable or failed)";

type Stat = { dev: number | bigint; ino: number | bigint };

function seams(
  over: {
    fstat?: (fd: number) => Stat;
    statPath?: (path: string) => Stat;
    probe?: (path: string) => Promise<string | null>;
  } = {},
) {
  const calls = { fstat: [] as number[], statPath: [] as string[], probe: [] as string[] };
  const deps = {
    hasProc: false,
    fstat: (fd: number): Stat => {
      calls.fstat.push(fd);
      return (over.fstat ?? (() => ({ dev: 7, ino: 42 })))(fd);
    },
    statPath: (path: string): Stat => {
      calls.statPath.push(path);
      return (over.statPath ?? (() => ({ dev: 7, ino: 42 })))(path);
    },
    probe: (path: string): Promise<string | null> => {
      calls.probe.push(path);
      return (over.probe ?? (() => Promise.resolve(null)))(path);
    },
  };
  return { calls, deps };
}

const failing = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

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

Deno.test("jjsz F3: a missing descriptor is refused and nothing else is consulted", async () => {
  const { calls, deps } = seams({ fstat: failing("EBADF") });
  assertEquals(await verifyInheritedCanonicalLock(9, deps), MISSING);
  assertEquals(calls.statPath, [], "the lock path must not be read once the descriptor is missing");
  assertEquals(calls.probe, [], "the lock must not be probed once the descriptor is missing");
});

Deno.test("jjsz F3: an unreadable lock path is refused and the probe is NOT called", async () => {
  const { calls, deps } = seams({ statPath: failing("ENOENT") });
  assertEquals(await verifyInheritedCanonicalLock(9, deps), WRONG_TARGET);
  assertEquals(calls.probe, [], "an unverifiable target must never reach the lock probe");
});

Deno.test("jjsz F3: a descriptor on a DIFFERENT file is refused and the probe is NOT called", async (t) => {
  const differs: Array<[string, Stat, Stat]> = [
    ["different device", { dev: 7, ino: 42 }, { dev: 8, ino: 42 }],
    ["different inode", { dev: 7, ino: 42 }, { dev: 7, ino: 43 }],
    ["different device and inode", { dev: 7, ino: 42 }, { dev: 8, ino: 43 }],
    ["different inode (bigint)", { dev: 7n, ino: 42n }, { dev: 7n, ino: 43n }],
    ["different device (bigint)", { dev: 7n, ino: 42n }, { dev: 9n, ino: 42n }],
  ];
  for (const [name, fdStat, lockStat] of differs) {
    await t.step(name, async () => {
      const { calls, deps } = seams({ fstat: () => fdStat, statPath: () => lockStat });
      assertEquals(
        await verifyInheritedCanonicalLock(9, deps),
        WRONG_TARGET,
        "fd 9 must be the canonical lock file, not merely some file while the lock is held by someone",
      );
      assertEquals(calls.probe, [], "the probe must not run for a descriptor on another file");
    });
  }
});

Deno.test("jjsz F3: the same file with the lock HELD is verified, probing exactly the canonical path", async () => {
  const { calls, deps } = seams({ probe: () => Promise.resolve(null) });
  assertEquals(await verifyInheritedCanonicalLock(11, deps), null);
  assertEquals(calls.fstat, [11], "the descriptor under test is the one asked about");
  assertEquals(calls.statPath, [CANONICAL_LOCK], "the descriptor is compared with the canonical lock file");
  assertEquals(calls.probe, [CANONICAL_LOCK], "exactly one probe, on the canonical lock path");

  // Equal bigint stats are the same file too.
  const big = seams({
    fstat: () => ({ dev: 7n, ino: 42n }),
    statPath: () => ({ dev: 7n, ino: 42n }),
  });
  assertEquals(await verifyInheritedCanonicalLock(9, big.deps), null);
  assertEquals(big.calls.probe, [CANONICAL_LOCK]);
});

Deno.test("jjsz F3: the same file with the lock NOT held or unverifiable returns the probe's refusal, never ok", async (t) => {
  for (const refusal of [NOT_HELD, UNVERIFIED]) {
    await t.step(refusal, async () => {
      const { calls, deps } = seams({ probe: () => Promise.resolve(refusal) });
      assertEquals(await verifyInheritedCanonicalLock(9, deps), refusal);
      assertEquals(calls.probe, [CANONICAL_LOCK]);
    });
  }
});

Deno.test("jjsz F3: the descriptor defaults to 9 (the supervisor's lock descriptor)", async () => {
  const { calls, deps } = seams();
  await verifyInheritedCanonicalLock(undefined, deps);
  assertEquals(calls.fstat, [9]);
});

Deno.test("jjsz F3: hasProc: true never takes the no-/proc branch", async () => {
  // A descriptor number no process has: the /proc branch cannot read /proc/self/fd/<n> (absent on macOS,
  // ENOENT on Linux), so it reports the descriptor missing — without ever calling the no-/proc seams.
  const { calls, deps } = seams({ probe: () => Promise.resolve(null) });
  assertEquals(
    await verifyInheritedCanonicalLock(2_147_483_000, { ...deps, hasProc: true }),
    MISSING,
  );
  assertEquals(calls, { fstat: [], statPath: [], probe: [] });
});

// ---------------------------------------------------------------------------------------------
// The same branch against REAL descriptors, REAL stat data and the REAL flock. The canonical lock path
// is mapped to a scratch file by the `statPath`/`probe` seams, so the machine's real lock is never read.
// ---------------------------------------------------------------------------------------------

const FLOCK_AVAILABLE = (() => {
  try {
    return new Deno.Command("flock", { args: ["--version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "jjsz F3: REAL descriptors and flock — the lock file's own descriptor verifies, another file's does not",
  ignore: !FLOCK_AVAILABLE,
  fn: async () => {
    const dir = Deno.makeTempDirSync({ dir: durableDir("jjsz-lock-probe-scratch"), prefix: "f3-" });
    const lock = `${dir}/canonical.lock`;
    const other = `${dir}/other-file`;
    Deno.writeTextFileSync(lock, "");
    Deno.writeTextFileSync(other, "");
    let lockFd = -1;
    let otherFd = -1;
    const holder = new Deno.Command("flock", {
      args: ["-x", lock, "sh", "-c", "echo held; cat >/dev/null"],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const reader = holder.stdout.getReader();
    const decoder = new TextDecoder();
    const probed: string[] = [];
    const real = {
      hasProc: false,
      // fstat is left to its DEFAULT (fstatSync) so the real default is exercised too.
      statPath: () => statSync(lock),
      probe: (_path: string) => {
        probed.push(_path);
        return probeCanonicalLockHeld(lock);
      },
    };
    try {
      let announced = "";
      while (!announced.includes("held")) {
        const { value, done } = await reader.read();
        if (done) break;
        announced += decoder.decode(value);
      }
      assert(announced.includes("held"), "fixture: the flock holder must announce that it owns the lock");

      lockFd = openSync(lock, "r");
      otherFd = openSync(other, "r");
      assert(
        fstatSync(lockFd).ino !== fstatSync(otherFd).ino,
        "fixture: the two descriptors must be different files",
      );

      assertEquals(
        await verifyInheritedCanonicalLock(lockFd, real),
        null,
        "the lock file's own descriptor, while the lock is held, must verify",
      );
      assertEquals(probed, [CANONICAL_LOCK], "and the probe ran on the canonical path");

      probed.length = 0;
      assertEquals(
        await verifyInheritedCanonicalLock(otherFd, real),
        WRONG_TARGET,
        "a descriptor on ANOTHER file must be refused even though the lock is held by someone",
      );
      assertEquals(probed, [], "the probe must not have run for another file's descriptor");

      closeSync(otherFd);
      const closedFd = otherFd;
      otherFd = -1;
      assertEquals(
        await verifyInheritedCanonicalLock(closedFd, real),
        MISSING,
        "a descriptor that is not open must be reported missing",
      );

      // Release the lock: the same descriptor now has nothing live behind it.
      await holder.stdin.close();
      await holder.status;
      assertEquals(
        await verifyInheritedCanonicalLock(lockFd, real),
        NOT_HELD,
        "a lock nobody holds must be refused even with the right descriptor",
      );
    } finally {
      for (const fd of [lockFd, otherFd]) {
        if (fd >= 0) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }
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
