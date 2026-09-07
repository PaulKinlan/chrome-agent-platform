// chrome-agent-platform-mee3 — REGRESSION PINS for the four adjudicated semaphore
// survivors: S15 (a holder that dies keeps its slot), S9 (the non-blocking probe
// becomes blocking), S16 (the wait LENGTH is never reported) and S17 (queueing is
// never announced).
//
// Each pin exists because a divergence probe showed pristine and the mutant differ
// OBSERVABLY — the mee3 rule is that a survivor is not a gap until a probe proves
// it. Evidence: cap-evidence/launch-sweep-r2/slots-adjudication.json.
//
// ── WHY THE EXISTING SUITE MISSED ALL FOUR ───────────────────────────────────
// tests/chrome-slot-semaphore.test.ts already has "a launcher that DIES releases
// its slot". It does not pin S15, and the difference is the whole finding: that
// test SIGKILLs a SEPARATE PROCESS and then asserts the LOCK FILE is free
// (`flock -w 5 slotFile(0) true`). That property belongs to the KERNEL — when a
// process dies the kernel closes its fds and drops the flock — so it holds no
// matter what this module does, and it holds under the S15 mutation. What nothing
// pinned is the module's OWN in-process accounting: `heldSlots`, the Set that the
// self-deadlock guard reads. S15 removes
//     holder.status.then(() => { heldSlots.delete(index); })
// and the kernel-level property still passes while the Set keeps counting dead
// holders forever. So a process whose browsers merely DIED eventually trips its
// own guard and refuses to launch anything.
//
// S9, S16 and S17 are the same shape in a quieter register: a LEAK, a STALL and a
// SILENCE. None of them makes anything go red, which is why a green suite never
// surfaced them.
//
// ── S9: THE BEAD'S STRONG CLAIM WAS REFUTED, THIS PINS WHAT IS ACTUALLY TRUE ──
// The sweep recorded S9 as "the rotation never rotates: launches re-serialize on
// slot 0 and the bounded concurrency is silently lost." The probe refutes the
// strong form and this file pins the real defect instead:
//   - The bound is NOT lost. trySlot has its own internal 2000 ms marker-read
//     deadline, so even a blocking flock is killed after ~2 s, the outer loop
//     regains control and still re-checks `elapsed >= bound`. A run that cannot
//     get a slot still fails honestly.
//   - What IS true: (a) the mutant OVERSHOOTS its own cap by more than a second,
//     because the deadline can only be consulted BETWEEN attempts, never during
//     one; and (b) every busy slot costs a ~2 s STALL instead of an instant skip.
//     The rotation does still reach a free slot — it just pays 2 s per busy slot
//     on the way, which with the default bound of 4 is up to ~6 s of avoidable
//     queueing per launch.
//
// ── ISOLATION AND LOAD-TOLERANCE ─────────────────────────────────────────────
// Every test owns a UNIQUE temporary slot dir, so it can never touch the shared
// /tmp slot files another lane's browser gate is using, and `pgrep -f <unique
// path>` can never match a stranger's holder. CAP_CHROME_SLOT_DIR is
// process-global and the queueing assertions are wall-clock sensitive, so this
// file belongs in the serial phase with the other lock tests — see
// scripts/test-partition.mjs. Thresholds are chosen for large margins on BOTH
// sides (pristine ~10-100 ms vs a 1500 ms limit; a 4 s hold vs a 1500 ms notice
// threshold) so a slow box makes them slower, not wrong.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { acquireChromeSlot, heldSlotCount, type ChromeSlot } from "../scripts/lib/chrome-slots.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const savedEnv = new Map<string, string | undefined>();
function setEnv(k: string, v: string | undefined) {
  if (!savedEnv.has(k)) savedEnv.set(k, Deno.env.get(k));
  if (v === undefined) Deno.env.delete(k);
  else Deno.env.set(k, v);
}
function restoreEnv() {
  for (const [k, v] of savedEnv) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  savedEnv.clear();
}

/** Point the semaphore at a slot dir this test alone owns. */
async function ownSlotDir(max: number, waitMs?: number): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "cap-slot-pin-" });
  setEnv("CAP_CHROME_SLOT_DIR", dir);
  setEnv("CAP_CHROME_MAX_CONCURRENT", String(max));
  setEnv("CAP_CHROME_LOCK_WAIT_MS", waitMs === undefined ? undefined : String(waitMs));
  // Either bypass would make acquireChromeSlot return slot -1 without touching the
  // semaphore at all, so the test would pass while measuring nothing.
  setEnv("CAP_SECURITY_NONCE", undefined);
  setEnv("CAP_CHROME_LOCK_HELD", undefined);
  setEnv("CAP_CHROME_SLOT_MARKER", undefined);
  return dir;
}
const slotFileIn = (dir: string, i: number) => `${dir}/cap-chrome-slot-${i}.lock`;

/** Hold a slot externally AND CONFIRM the hold. A bare sleep is load-dependent:
 *  under a busy box the holder can start late and the assertion measures nothing,
 *  so "busy" is probed until it is an observed fact. -o keeps the fd in flock
 *  itself, so killing flock releases it. */
async function holdConfirmed(path: string, seconds: number): Promise<Deno.ChildProcess> {
  await Deno.writeTextFile(path, "").catch(() => {});
  const holder = new Deno.Command("flock", {
    args: ["-o", "-w", "20", path, "sleep", String(seconds)],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const deadline = Date.now() + 20000;
  for (;;) {
    const probe = new Deno.Command("flock", { args: ["-n", path, "true"], stdout: "null", stderr: "null" }).spawn();
    if ((await probe.status).code === 1) return holder; // busy -> the hold is real
    assert(Date.now() < deadline, `holdConfirmed: never observed ${path} busy`);
    await sleep(50);
  }
}

async function dropHolder(holder: Deno.ChildProcess | null) {
  if (!holder) return;
  try {
    holder.kill("SIGKILL");
  } catch { /* already gone */ }
  await holder.status.catch(() => {});
}

/** Kill the flock holder the MODULE spawned for a slot file, and the `cat`
 *  grandchild that inherits its lock fd. `pgrep -f` on a path unique to this test
 *  cannot match a stranger. Throws if nothing was alive, because a test that kills
 *  no holder is not testing the guard it claims to. */
async function killModuleHolder(path: string): Promise<number> {
  const found = new Deno.Command("pgrep", { args: ["-f", path], stdout: "piped", stderr: "null" }).spawn();
  const out = new TextDecoder().decode((await found.output()).stdout);
  const pids = out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== Deno.pid);
  assert(pids.length > 0, `killModuleHolder: no live holder of ${path} — nothing to kill, so nothing is being tested`);
  let killed = 0;
  for (const pid of pids) {
    const kids = new Deno.Command("pgrep", { args: ["-P", String(pid)], stdout: "piped", stderr: "null" }).spawn();
    const kout = new TextDecoder().decode((await kids.output()).stdout);
    for (const k of kout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)) {
      try {
        Deno.kill(k, "SIGKILL");
        killed++;
      } catch { /* already gone */ }
    }
    try {
      Deno.kill(pid, "SIGKILL");
      killed++;
    } catch { /* already gone */ }
  }
  return killed;
}

async function releaseAll(slots: ChromeSlot[]) {
  for (const s of slots) {
    try {
      s.release();
    } catch { /* already gone */ }
  }
  await sleep(200);
}

async function cleanup(dir: string, holders: (Deno.ChildProcess | null)[]) {
  for (const h of holders) await dropHolder(h);
  for (let i = 0; i < 4; i++) await killModuleHolder(slotFileIn(dir, i)).catch(() => {});
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  restoreEnv();
}

// ══ S15 — a holder that dies on its own must free the slot ═══════════════════
Deno.test("mee3: a holder that DIES frees its slot in this process's own accounting (not just in the kernel)", async () => {
  const dir = await ownSlotDir(2);
  const taken: ChromeSlot[] = [];
  try {
    // Two rounds, because the defect is cumulative: one dead holder is a leaked
    // count, two dead holders with a bound of 2 is a process that can never
    // launch again. Note the count does NOT accumulate under pristine — each kill
    // is accounted for, so this process holds exactly one slot at a time. Asserting
    // accumulation here would be asserting the mutant's behaviour.
    for (const round of [1, 2]) {
      const slot = await acquireChromeSlot();
      taken.push(slot);
      assertEquals(heldSlotCount(), 1, `round ${round}: exactly one slot is held right after acquiring`);
      // The module's own words for this guard are "a holder that dies on its own
      // (killed flock) frees the slot too" — so kill the flock, and deliberately do
      // NOT call release(). Release is the caller's path; this is the crash path.
      const killed = await killModuleHolder(slotFileIn(dir, slot.slot));
      assert(killed >= 1, `round ${round}: killed the module's flock holder (${killed} pids)`);
      // Poll rather than sleep a fixed guess: pristine drops the count almost
      // immediately, the mutant never does, and the bound makes that a fact rather
      // than a race.
      const deadline = Date.now() + 4000;
      while (heldSlotCount() > 0 && Date.now() < deadline) await sleep(50);
      assertEquals(
        heldSlotCount(),
        0,
        `round ${round}: a holder that DIED is still counted as held. The kernel dropped the lock, but this process's own heldSlots did not — which is what the self-deadlock guard reads.`,
      );
    }
    // The consequence, and the assertion that actually matters: after two of its
    // own browsers died, can this process still launch one?
    const third = await acquireChromeSlot();
    taken.push(third);
    assert(third.slot >= 0, "a third launch is still possible after two holders died");
    await releaseAll(taken);
    assertEquals(heldSlotCount(), 0, "every slot is accounted for again at the end");
  } finally {
    await releaseAll(taken);
    await cleanup(dir, []);
  }
});

Deno.test("mee3: dead holders cannot push a process into its own self-deadlock refusal", async () => {
  const dir = await ownSlotDir(2);
  const taken: ChromeSlot[] = [];
  try {
    for (const _i of [0, 1]) {
      const slot = await acquireChromeSlot();
      taken.push(slot);
      await killModuleHolder(slotFileIn(dir, slot.slot));
      const deadline = Date.now() + 4000;
      while (heldSlotCount() > 0 && Date.now() < deadline) await sleep(50);
    }
    // Under the mutation heldSlots still counts both dead holders, so the guard
    // fires and the process refuses to wait for itself — a denial of the gate
    // caused by nothing but browsers dying.
    const err = await acquireChromeSlot().then(
      (s) => {
        taken.push(s);
        return null;
      },
      (e) => e as Error,
    );
    assertEquals(err, null, `a process whose holders DIED must not be refused: ${err?.message ?? ""}`);
  } finally {
    await releaseAll(taken);
    await cleanup(dir, []);
  }
});

// ══ S9 — the probe must be NON-BLOCKING ══════════════════════════════════════
Deno.test("mee3: a busy slot is SKIPPED instantly, not queued on — the rotation still rotates", async () => {
  const max = 4;
  const dir = await ownSlotDir(max, 20000);
  const holders: Deno.ChildProcess[] = [];
  try {
    // The first index this process will probe is (Deno.pid + heldSlots.size) % max,
    // and heldSlots is empty here. Making THAT slot the busy one is what makes the
    // test deterministic: a blocking probe stalls on its very first attempt, while
    // a non-blocking one fails fast and rotates to a free slot.
    const first = Deno.pid % max;
    const free = (first + 1) % max;
    for (let i = 0; i < max; i++) {
      if (i === free) {
        await Deno.writeTextFile(slotFileIn(dir, i), "").catch(() => {});
        continue;
      }
      holders.push(await holdConfirmed(slotFileIn(dir, i), 6));
    }
    const t0 = Date.now();
    const slot = await acquireChromeSlot();
    const elapsed = Date.now() - t0;
    try {
      assertEquals(slot.slot, free, "the rotation reached the one free slot instead of queueing on a busy one");
      // trySlot's marker window is 2000 ms, so a blocking probe cannot return in
      // under ~2 s. 1500 ms leaves pristine (typically 10-100 ms) a wide margin and
      // still sits clear of the stall.
      assert(
        elapsed < 1500,
        `skipping ${max - 1} busy slots took ${elapsed} ms — a non-blocking probe costs milliseconds each, a blocking one costs a full 2000 ms marker window`,
      );
    } finally {
      slot.release();
    }
  } finally {
    await sleep(200);
    await cleanup(dir, holders);
  }
});

Deno.test("mee3: the wait cap is enforced DURING a probe, not only between them", async () => {
  const cap = 500;
  const dir = await ownSlotDir(1, cap);
  const holders: Deno.ChildProcess[] = [];
  try {
    // The only slot is held far longer than the cap, so the honest outcome is a
    // loud failure at the cap. With a blocking probe the cap cannot be consulted
    // until the 2000 ms marker window expires, so the failure lands ~1.5 s late:
    // the promise "the wait is capped" becomes the wait is capped, plus one probe.
    holders.push(await holdConfirmed(slotFileIn(dir, 0), 12));
    const t0 = Date.now();
    const err = await assertRejects(
      () => acquireChromeSlot(),
      Error,
      `could not take a Chrome slot within ${cap} ms`,
    );
    const elapsed = Date.now() - t0;
    assert(err instanceof Error, "a run that cannot get a slot fails loudly, never green and never skipped");
    assert(
      elapsed < 1500,
      `failing at a ${cap} ms cap took ${elapsed} ms — the cap was only checked between probe attempts, not during one`,
    );
  } finally {
    await cleanup(dir, holders);
  }
});

// ══ S16 + S17 — the wait must be ANNOUNCED and MEASURED ══════════════════════
Deno.test("mee3: a queueing launch SAYS it is waiting, and reports how long the wait was", async () => {
  const dir = await ownSlotDir(1, 20000);
  const holders: Deno.ChildProcess[] = [];
  const lines: string[] = [];
  const orig = console.error;
  try {
    // A 4 s hold guarantees the wait crosses the module's 1500 ms threshold twice:
    // once while queueing (the announcement) and once on success (the length).
    holders.push(await holdConfirmed(slotFileIn(dir, 0), 4));
    console.error = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    };
    let waitedMs = -1;
    try {
      const slot = await acquireChromeSlot();
      waitedMs = slot.waitedMs;
      slot.release();
    } finally {
      console.error = orig;
    }
    const joined = lines.join("\n");
    assert(waitedMs > 1500, `the acquisition really did queue (waitedMs=${waitedMs})`);

    // S17 — the queueing announcement. Nothing else in the system says "the box is
    // busy and this gate is waiting", so without it a stalled lane looks hung.
    assert(
      /launchChrome: waiting for a Chrome slot — all 1 are busy \(CAP_CHROME_MAX_CONCURRENT=1, waited \d+ ms\)/.test(joined),
      `queueing was never announced. stderr was:\n${joined || "(empty)"}`,
    );

    // S16 — the wait LENGTH. The module's header lists HONEST ("the wait is printed
    // when it happens, with its length") as a carried-over property, and waitedMs is
    // the serialization evidence that lands in every KAT receipt. The mutant still
    // RETURNS a correct waitedMs while printing nothing, so the returned value is
    // not a substitute for the line.
    const took = joined.match(/launchChrome: took Chrome slot (\d+) after (\d+) ms \(bound (\d+)\)/);
    assert(took, `the wait length was never reported. stderr was:\n${joined || "(empty)"}`);
    assertEquals(Number(took![2]) > 1500, true, "the reported length is the real wait, not a placeholder");
    assertEquals(took![3], "1", "the report names the bound it was waiting under");
    assertEquals(waitedMs > 1500, true, "the returned waitedMs agrees with the printed one");
  } finally {
    console.error = orig;
    await sleep(200);
    await cleanup(dir, holders);
  }
});
