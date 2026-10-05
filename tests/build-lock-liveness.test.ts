// The build lock's steal decision, including the zombie hole it used to have
// (chrome-agent-platform-r0v8).
//
// OBSERVED DEFECT: a build child SIGKILLed by the serial runner but not yet reaped was judged a LIVE
// holder, because kill(pid, 0) SUCCEEDS against a zombie and /proc/<pid>/stat still exists with an
// unchanged starttime. So the build spent its full bounded refusal (48 x 500ms) and then threw
// "another LIVE build (pid N) ... is not dead" — misleading text for a corpse — and the stale
// owner.json poisoned later runs and other lanes on the same box.
//
// The zombie cases below record the zombie's REAL starttime on purpose. If the fixture recorded a
// bogus starttime the lock would be stolen by the pid-reuse rule instead, and the test would pass
// with the zombie check removed entirely — proving nothing. Two assertions guard that: kill(pid, 0)
// must succeed against the fixture (the trap the old code fell into) and the recorded start must
// equal the zombie's current start (so reuse cannot be the reason it is dead).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  acquireBuildLock,
  buildOwnerIdentity,
  DEFAULT_ATTEMPTS,
  DEFAULT_INTERVAL_MS,
  holderIsDead,
  LOCK_DIRNAME,
  machineBootId,
  OWNERLESS_STALE_MS,
  parseProcStat,
  procStatFields,
} from "../scripts/lib/build-lock.mjs";

const decoder = new TextDecoder();

async function tmpRoot(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ prefix: `build-lock-${prefix}-` });
}

async function writeLock(root: string, owner: Record<string, unknown>): Promise<string> {
  const dir = `${root}/${LOCK_DIRNAME}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/owner.json`, JSON.stringify(owner));
  return dir;
}

async function lockToken(root: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(`${root}/${LOCK_DIRNAME}/owner.json`);
    return (JSON.parse(raw) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

async function procStatText(pid: number): Promise<string | null> {
  try {
    return await Deno.readTextFile(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
}

/** A child process that outlives the test so a stolen lock cannot be an artefact of it exiting. */
function spawnHolder(): Deno.ChildProcess {
  // `true &` forks a child that exits; `exec sleep` replaces the shell with the SAME pid, so the
  // exited child is reparented to a process that never waits for it and stays a ZOMBIE.
  return new Deno.Command("bash", { args: ["-c", "true & exec sleep 60"] }).spawn();
}

/** The holder's unreaped children, from /proc (no dependency on ps). */
async function childPids(pid: number): Promise<number[]> {
  try {
    const raw = await Deno.readTextFile(`/proc/${pid}/task/${pid}/children`);
    return raw.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function waitForZombieChild(holderPid: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    for (const child of await childPids(holderPid)) {
      const fields = procStatFields(child);
      if (fields.ok && fields.state === "Z") return child;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no zombie child appeared under pid ${holderPid}`);
}

Deno.test("r0v8: a ZOMBIE holder is dead, so the lock is stolen instead of refused", async () => {
  const holder = spawnHolder();
  const root = await tmpRoot("zombie");
  try {
    const zombiePid = await waitForZombieChild(holder.pid);
    const zombie = procStatFields(zombiePid);
    assert(zombie.ok, "fixture: the zombie's /proc entry must be readable");
    assertEquals(zombie.state, "Z", "fixture: the child must be a zombie");

    // THE TRAP, asserted so the fix cannot be read as pid reuse: the old code's two checks BOTH say
    // alive here. kill(pid, 0) succeeds against a zombie, and the starttime is unchanged.
    let killSucceeded = false;
    try {
      process.kill(zombiePid, 0);
      killSucceeded = true;
    } catch { /* would mean the fixture is not the case under test */ }
    assert(killSucceeded, "fixture: kill(pid, 0) must SUCCEED against the zombie (this is the defect)");

    await writeLock(root, {
      pid: zombiePid,
      token: "dead-holder-token",
      at: Date.now(),
      start: zombie.start, // the REAL starttime: only the Z state can make this dead
      boot: machineBootId(),
    });

    const ours = buildOwnerIdentity();
    const started = Date.now();
    await acquireBuildLock({ root, owner: ours, attempts: 2, intervalMs: 5 });
    const elapsed = Date.now() - started;

    assertEquals(await lockToken(root), ours.token, "the zombie's lock must now be OURS");
    assert(elapsed < 5000, `the steal must not wait out the refusal (took ${elapsed}ms)`);
    assertEquals(
      [...Deno.readDirSync(root)].filter((e) => e.name.startsWith(".lock-quarantine-")).length,
      0,
      "the quarantined dead lock must be removed, not left behind",
    );
  } finally {
    holder.kill();
    await holder.status.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("r0v8: a genuinely LIVE holder still refuses (the guarantee is kept)", async () => {
  const root = await tmpRoot("live");
  try {
    // A real live process with a real starttime: this process itself.
    const holder = buildOwnerIdentity();
    await writeLock(root, { ...holder, token: "someone-elses-live-token" });
    const ours = buildOwnerIdentity();
    await assertRejects(
      () => acquireBuildLock({ root, owner: ours, attempts: 2, intervalMs: 5 }),
      Error,
      "another LIVE build",
      "a live holder must still be refused",
    );
    assertEquals(await lockToken(root), "someone-elses-live-token", "the live lock must be untouched");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("r0v8: pid reuse (same pid, different starttime) is still stealable", async () => {
  const root = await tmpRoot("reuse");
  try {
    const holder = buildOwnerIdentity();
    await writeLock(root, { ...holder, token: "reused-pid-token", start: "1" });
    const ours = buildOwnerIdentity();
    await acquireBuildLock({ root, owner: ours, attempts: 2, intervalMs: 5 });
    assertEquals(await lockToken(root), ours.token, "a reused pid must not block the build");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("r0v8: a gone pid and a different boot are both stealable", async () => {
  const root = await tmpRoot("gone");
  try {
    // A pid that certainly no longer exists: reap a child, then use its pid.
    const child = new Deno.Command("true", { stdout: "null" }).spawn();
    const gonePid = child.pid;
    await child.status;
    assertEquals(await procStatText(gonePid), null, "fixture: the pid must be gone from /proc");

    await writeLock(root, { pid: gonePid, token: "gone-token", start: "1", boot: machineBootId() });
    let ours = buildOwnerIdentity();
    await acquireBuildLock({ root, owner: ours, attempts: 2, intervalMs: 5 });
    assertEquals(await lockToken(root), ours.token, "a gone pid must not block the build");

    await writeLock(root, {
      pid: process.pid,
      token: "other-boot-token",
      start: "1",
      boot: "a-different-boot-id",
    });
    ours = buildOwnerIdentity();
    await acquireBuildLock({ root, owner: ours, attempts: 2, intervalMs: 5 });
    assertEquals(await lockToken(root), ours.token, "a different boot must not block the build");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("r0v8: a vanished /proc entry is dead, an unreadable one stays alive", async () => {
  // The race the defect description names: kill() reports alive, but /proc says the pid is gone.
  const vanished = await holderIsDead(
    { pid: process.pid, start: "1", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: false, reason: "gone" }) },
  );
  assertEquals(vanished, true, "a missing /proc/<pid>/stat must mean stealable");

  const unreadable = await holderIsDead(
    { pid: process.pid, start: "1", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: false, reason: "unreadable" }) },
  );
  assertEquals(unreadable, false, "unreadable is not proof of death — refuse, do not steal");
});

Deno.test("r0v8: an ownerless lock is stealable only once observably old", async () => {
  const root = await tmpRoot("ownerless");
  try {
    await Deno.mkdir(`${root}/${LOCK_DIRNAME}`, { recursive: true }); // no owner.json
    const now = Date.now();
    assertEquals(
      await holderIsDead(null, { now: () => now, lockDirBirthtimeMs: () => now - 1000 }),
      false,
      "a young ownerless lock is the acquisition window and must never be stolen",
    );
    assertEquals(
      await holderIsDead(null, {
        now: () => now,
        lockDirBirthtimeMs: () => now - OWNERLESS_STALE_MS - 1,
      }),
      true,
      "an old ownerless lock is pre-era or manual residue and is stealable",
    );

    // End to end: a fresh ownerless lock refuses, and the refusal names the holder path.
    const ours = buildOwnerIdentity();
    await assertRejects(
      () => acquireBuildLock({ root, owner: ours, attempts: 2, intervalMs: 5 }),
      Error,
      "another LIVE build",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("parseProcStat reads state and starttime past a comm containing spaces and parens", () => {
  // "pid (comm) state ..." — comm may contain spaces AND parentheses, so a whole-line whitespace
  // split shifts every later field. Field 3 is state, field 22 is starttime: in the slice after the
  // closing ')', those are index 0 and index 19.
  const tail = Array.from({ length: 25 }, (_, i) => `v${i}`);
  tail[0] = "S";
  tail[19] = "987654";
  const parsed = parseProcStat(`4242 (my app (beta)) ${tail.join(" ")}`);
  assert(parsed, "the line must parse");
  assertEquals(parsed.state, "S");
  assertEquals(parsed.start, "987654", "starttime must be read from field 22, not field 21");
  assertEquals(parseProcStat("garbage"), null, "an unparseable line must be reported, not guessed");
  assertEquals(parseProcStat("1 (x) S"), null, "a truncated line must be reported, not guessed");
});

Deno.test("the refusal is bounded: the default budget is the documented 48 x 500ms", () => {
  assertEquals(DEFAULT_ATTEMPTS, 48);
  assertEquals(DEFAULT_INTERVAL_MS, 500);
  assertEquals(DEFAULT_ATTEMPTS * DEFAULT_INTERVAL_MS, 24_000, "24s bounded refusal");
});
