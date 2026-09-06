// tests/chrome-slot-semaphore.test.ts — chrome-agent-platform-uzik
// The Chrome gates used to serialize on ONE canonical flock for the whole
// machine, even though every launch already gets its own kernel-assigned
// debugging port (`--remote-debugging-port=0`) and its own `--user-data-dir`.
// Isolation is per instance; exclusivity was buying nothing but a queue.
//
// The replacement is a BOUNDED-CONCURRENCY semaphore: N slot files, one flock
// each, first free slot wins. N is env-tunable (`CAP_CHROME_MAX_CONCURRENT`,
// default 4) so the box cannot be OOMed by 32 parallel test workers each
// launching a browser. Suites that genuinely need machine determinism opt into
// the canonical lock explicitly (`canonicalLock: true`).
//
// Pins here:
//   1. a default launch takes NO canonical lock — it starts while the canonical
//      lock is held by another lane;
//   2. the bound is real: with every slot held, a default launch FAILS honestly
//      within its bounded wait (never green, never skipped);
//   3. a free slot is taken and reported (`chromeSlot`), so evidence says which
//      slot a run used;
//   4. the slot is released when the browser exits, and when the launcher
//      process dies (flock is dropped by the kernel — no orphaned slot);
//   5. one process can never deadlock itself: asking for a slot while this
//      process already holds the whole bound throws IMMEDIATELY;
//   6. `canonicalLock: true` keeps the old exclusive semantics (queue, bounded
//      honest failure) for the suites that need them;
//   7. a fake-browser fixture with its own `lockPath` takes neither the
//      canonical lock nor a slot (chrome-agent-platform-51x4 preserved);
//   8. the slot wait is bounded by `CAP_CHROME_LOCK_WAIT_MS` and printed.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const SLOT_DIR = await Deno.makeTempDir({ prefix: "cap-slot-dir-" });
const CUSTOM_SCOPE = await Deno.makeTempFile({ prefix: "cap-slot-scope-" });
// chrome-agent-platform-1qr3: the "another lane owns the canonical lock"
// fixture is GATE, a scratch file the launcher resolves AS the canonical lock
// through CAP_CHROME_LOCK_PATH (read per call) — never the machine's real gate,
// which belongs to real browsers. The redirect itself is pinned by the
// canonicalLock:true test below and by chrome-launch-lock.test.ts.
const GATE = await Deno.makeTempFile({ prefix: "cap-slot-gate-" });
Deno.env.delete("CAP_SECURITY_NONCE");
Deno.env.delete("CAP_CHROME_LOCK_HELD");
Deno.env.set("CAP_CHROME_SLOT_DIR", SLOT_DIR);

const { launchChrome } = await import("../scripts/lib/chrome-launch.ts");
const {
  acquireChromeSlot,
  maxConcurrentChromes,
  slotFile,
  CHROME_SLOT_FILE_PREFIX,
} = await import("../scripts/lib/chrome-slots.ts");

async function fakeBrowser(): Promise<string> {
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    fake,
    "#!/bin/sh\necho \"DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc\" 1>&2\nsleep 30\n",
  );
  await Deno.chmod(fake, 0o755);
  return fake;
}

/** Hold a lock file exclusively from OUTSIDE this process (`-o` keeps the fd in
 *  flock itself, so killing flock releases it). */
function holdFile(path: string, seconds: number): Deno.ChildProcess {
  return new Deno.Command("flock", {
    args: ["-o", "-w", "15", path, "sleep", String(seconds)],
    stdout: "null",
    stderr: "null",
  }).spawn();
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

/** With env per-call (never module-load bound) a test can tune the bound
 *  without the load-order trap that pinned CHROME_LOCK_PATH. */
function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  return async () => {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(patch)) {
      saved.set(k, Deno.env.get(k));
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    try { await fn(); } finally {
      for (const [k, v] of saved) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  };
}

Deno.test("uzik: a default launch takes NO canonical lock (profiles+ports already isolate)", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "4", CAP_CHROME_LOCK_PATH: GATE },
  async () => {
    // Another lane owns the canonical lock (GATE, for this call) for the whole machine.
    const holder = await holdConfirmed(GATE);
    const fake = await fakeBrowser();
    const t0 = Date.now();
    try {
      const launched = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
      const elapsed = Date.now() - t0;
      assert(elapsed < 5000, `a default launch must not queue behind the canonical lock (${elapsed} ms)`);
      assert(launched.lockWaitMs < 2000, `a free slot costs a few ms of flock spawn (${launched.lockWaitMs} ms)`);
      assert(launched.chromeSlot >= 0, `the launch reports which slot it took (${launched.chromeSlot})`);
      await settled(launched.proc);
    } finally {
      await settled(holder);
      await Deno.remove(fake);
    }
  },
));

Deno.test("uzik: the bound is real — every slot held means an honest FAILURE, not a start", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "2", CAP_CHROME_LOCK_WAIT_MS: "800" },
  async () => {
    const holders = [await holdConfirmed(slotFile(0)), await holdConfirmed(slotFile(1))];
    const fake = await fakeBrowser();
    const t0 = Date.now();
    try {
      await assertRejects(
        () => launchChrome({ binary: fake, args: [], timeoutMs: 5000 }),
        Error,
        "could not take a Chrome slot",
      );
      const elapsed = Date.now() - t0;
      assert(elapsed < 10000, `the bounded wait is honoured (${elapsed} ms)`);
      assert(elapsed >= 700, `it actually waited for the bound (${elapsed} ms)`);
    } finally {
      for (const h of holders) await settled(h);
      await Deno.remove(fake);
    }
  },
));

Deno.test("uzik: a free slot is taken and reported, and a held one is skipped", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "3" },
  async () => {
    const held = [await holdConfirmed(slotFile(0)), await holdConfirmed(slotFile(2))];
    const fake = await fakeBrowser();
    try {
      const launched = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
      assertEquals(launched.chromeSlot, 1, "slot 1 was the only free one");
      await settled(launched.proc);
    } finally {
      for (const h of held) await settled(h);
      await Deno.remove(fake);
    }
  },
));

Deno.test("uzik: the slot is released when the browser exits", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "1" },
  async () => {
    const fake = await fakeBrowser();
    const launched = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
    assertEquals(launched.chromeSlot, 0);
    // While the browser lives, the only slot is taken.
    const blocked = new Deno.Command("flock", { args: ["-n", slotFile(0), "true"] }).spawn();
    assertEquals((await blocked.status).code, 1, "the slot is held while the browser lives");
    await settled(launched.proc);
    await new Promise((r) => setTimeout(r, 600));
    const probe = new Deno.Command("flock", { args: ["-w", "5", slotFile(0), "true"] }).spawn();
    assertEquals((await probe.status).code, 0, "the slot was released when the browser exited");
    await Deno.remove(fake);
  },
));

Deno.test("uzik: a launcher that DIES releases its slot (no orphaned semaphore)", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "1" },
  async () => {
    const fake = await fakeBrowser();
    // A separate process takes the only slot and is SIGKILLed mid-launch: the
    // flock holder dies with it, so the kernel drops the lock.
    const victim = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `Deno.env.set("CAP_CHROME_SLOT_DIR", ${JSON.stringify(SLOT_DIR)});
         Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "1");
         const { launchChrome } = await import(${JSON.stringify(new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href)});
         const c = await launchChrome({ binary: ${JSON.stringify(fake)}, args: [], timeoutMs: 5000 });
         console.log("SLOT " + c.chromeSlot);
         await new Promise((r) => setTimeout(r, 30000));`,
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn();
    try {
      // Wait until the victim reports its slot, then kill it outright.
      const reader = victim.stdout.getReader();
      const dec = new TextDecoder();
      let seen = "";
      const deadline = Date.now() + 15000;
      while (!seen.includes("SLOT") && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += dec.decode(chunk.value, { stream: true });
      }
      assert(seen.includes("SLOT 0"), `the victim took the only slot: ${seen}`);
      victim.kill("SIGKILL");
      await victim.status;
      await new Promise((r) => setTimeout(r, 800));
      const probe = new Deno.Command("flock", { args: ["-w", "5", slotFile(0), "true"] }).spawn();
      assertEquals((await probe.status).code, 0, "a dead launcher left no held slot");
    } finally {
      await settled(victim);
      await Deno.remove(fake);
    }
  },
));

Deno.test("uzik: one process can never deadlock itself on the bound", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "1", CAP_CHROME_LOCK_WAIT_MS: "20000" },
  async () => {
    const first = await acquireChromeSlot();
    assertEquals(first.slot, 0);
    const t0 = Date.now();
    try {
      // Asking for a second slot while this process holds the whole bound must
      // fail IMMEDIATELY — waiting would be waiting for itself (20 min default).
      await assertRejects(() => acquireChromeSlot(), Error, "already holds");
      assert(Date.now() - t0 < 3000, "the self-deadlock guard is immediate, not a bounded wait");
    } finally {
      first.release();
    }
  },
));

Deno.test("uzik: the bound is env-tunable and clamped (never 0, never NaN)", () => {
  const saved = Deno.env.get("CAP_CHROME_MAX_CONCURRENT");
  try {
    Deno.env.delete("CAP_CHROME_MAX_CONCURRENT");
    assertEquals(maxConcurrentChromes(), 4, "the documented default");
    Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "3");
    assertEquals(maxConcurrentChromes(), 3);
    Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "0");
    assertEquals(maxConcurrentChromes(), 1, "0 would deadlock every launch — clamped to 1");
    Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "-5");
    assertEquals(maxConcurrentChromes(), 1);
    Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "nonsense");
    assertEquals(maxConcurrentChromes(), 4, "an unparsable bound falls back to the default");
    Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "2.7");
    assertEquals(maxConcurrentChromes(), 2, "fractional bounds floor");
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_CHROME_MAX_CONCURRENT");
    else Deno.env.set("CAP_CHROME_MAX_CONCURRENT", saved);
  }
});

Deno.test("uzik: canonicalLock:true keeps exclusive machine determinism (queue + honest failure)", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "4" },
  async () => {
    const scope = await Deno.makeTempFile({ prefix: "cap-uzik-canonical-" });
    const holder = await holdConfirmed(scope);
    const fake = await fakeBrowser();
    try {
      Deno.env.set("CAP_CHROME_LOCK_PATH", scope);
      Deno.env.set("CAP_CHROME_LOCK_WAIT_MS", "800");
      await assertRejects(
        () => launchChrome({ binary: fake, args: [], timeoutMs: 5000, canonicalLock: true }),
        Error,
        "could not take the serialized-Chrome lock",
      );
      // Releasing the holder lets the opt-in launch proceed and take NO slot.
      await settled(holder);
      const launched = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, canonicalLock: true });
      assertEquals(launched.chromeSlot, -1, "the canonical scope is exclusive, not a slot");
      await settled(launched.proc);
    } finally {
      Deno.env.delete("CAP_CHROME_LOCK_PATH");
      Deno.env.delete("CAP_CHROME_LOCK_WAIT_MS");
      await settled(holder);
      await Deno.remove(fake);
      await Deno.remove(scope);
    }
  },
));

Deno.test("uzik: a fixture with its own lockPath takes neither the canonical lock nor a slot", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "1", CAP_CHROME_LOCK_PATH: GATE },
  async () => {
    // Every slot held AND the canonical lock held: an isolated fixture scope
    // still launches (51x4 — unit fixtures never queue behind a real gate).
    const slotHolder = await holdConfirmed(slotFile(0));
    const canonicalHolder = await holdConfirmed(GATE);
    const fake = await fakeBrowser();
    const t0 = Date.now();
    try {
      const launched = await launchChrome({
        binary: fake,
        args: [],
        timeoutMs: 5000,
        lockPath: CUSTOM_SCOPE,
      });
      assert(Date.now() - t0 < 5000, "an isolated fixture scope never queues behind the machine");
      assertEquals(launched.chromeSlot, -1, "a custom scope is not a slot");
      await settled(launched.proc);
    } finally {
      await settled(slotHolder);
      await settled(canonicalHolder);
      await Deno.remove(fake);
    }
  },
));

Deno.test("uzik: canonicalLock and lockPath together are refused (ambiguous scope)", async () => {
  const fake = await fakeBrowser();
  try {
    await assertRejects(
      () => launchChrome({ binary: fake, args: [], timeoutMs: 5000, canonicalLock: true, lockPath: CUSTOM_SCOPE }),
      Error,
      "ambiguous",
    );
  } finally {
    await Deno.remove(fake);
  }
});

Deno.test("uzik: the slot file naming is bounded and per-instance", () => {
  assertEquals(CHROME_SLOT_FILE_PREFIX, "cap-chrome-slot-");
  assertEquals(slotFile(0), `${SLOT_DIR}/cap-chrome-slot-0.lock`);
  assertEquals(slotFile(3), `${SLOT_DIR}/cap-chrome-slot-3.lock`);
  // A negative or fractional index is a caller bug, never a path escape.
  let threw = false;
  try { slotFile(-1); } catch { threw = true; }
  assert(threw, "slotFile refuses a negative index");
});

Deno.test("uzik: slots are held for the browser's lifetime, counted per process", withEnv(
  { CAP_CHROME_MAX_CONCURRENT: "4" },
  async () => {
    const a = await acquireChromeSlot();
    const b = await acquireChromeSlot();
    assert(a.slot !== b.slot, "two acquisitions in one process take two DIFFERENT slots");
    a.release();
    b.release();
    // After release the bound is free again.
    const c = await acquireChromeSlot();
    assert(c.slot >= 0);
    c.release();
  },
));

// ── static pins for the opt-in decisions (unpinned product choices are how a
//    gate silently drifts back to the machine-wide lock) ─────────────────────
const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("uzik: the load-sensitive journey suite opts into the canonical lock", async () => {
  // chrome-journeys.ts is 370 sequential CDP round-trips over minutes — the
  // eo4d.1 runs died on `cdp timeout: Runtime.evaluate` under machine load and
  // only passed in a quiet window. It keeps exclusivity while everything else
  // moves to slots. Honest caveat, recorded here so nobody over-claims: this
  // excludes other CAP browsers, NOT other lanes' compilers.
  const src = await Deno.readTextFile(`${ROOT}scripts/chrome-journeys.ts`);
  assert(
    /canonicalLock:\s*true/u.test(src),
    "chrome-journeys.ts must opt into the exclusive canonical lock",
  );
});

Deno.test("uzik: the security chain still bypasses the semaphore (it is already exclusive)", async () => {
  // CAP_SECURITY_NONCE / CAP_CHROME_LOCK_HELD must skip BOTH gates: the
  // supervisor holds the canonical lock on fd 9 and must not also spend a slot
  // of the machine's browser budget.
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/chrome-slots.ts`);
  assert(src.includes('CAP_SECURITY_NONCE'), "the slot semaphore honours the supervisor nonce");
  assert(src.includes('CAP_CHROME_LOCK_HELD'), "the slot semaphore honours an outer holder");
  const nonce = Deno.env.get("CAP_SECURITY_NONCE");
  try {
    Deno.env.set("CAP_SECURITY_NONCE", "test-nonce");
    const bypassed = await acquireChromeSlot();
    assertEquals(bypassed.slot, -1, "the nonce bypass takes no slot");
    bypassed.release();
  } finally {
    if (nonce === undefined) Deno.env.delete("CAP_SECURITY_NONCE");
    else Deno.env.set("CAP_SECURITY_NONCE", nonce);
  }
});

Deno.test("uzik: kat-runner no longer wraps KATs in an outer flock, and budgets from the slot marker", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/kat-runner.ts`);
  // Code lines only: the header comment explains the RETIRED outer-flock
  // pattern on purpose, and a comment must not satisfy (or trip) a guard.
  const code = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
  assertEquals(code.includes('executable: "flock"'), false, "no outer flock around a KAT");
  assertEquals(code.includes("CAP_CHROME_LOCK_HELD"), false, "the runner no longer claims the lock is held");
  assertEquals(code.includes("CHROME_LOCK_PATH"), false, "the runner no longer holds the canonical lock");
  assert(code.includes("CAP_CHROME_GATE_ACQUIRED"), "the budget starts at the KAT's own slot acquisition");
  assert(code.includes("CAP_CHROME_SLOT_MARKER"), "the runner asks the launcher to print that marker");
});

/** A stand-in browser that `exec`s its sleep, so killing it leaves no grandchild
 *  holding the stdout pipe open. The plain fakeBrowser()'s `sleep 30` survives
 *  its parent's SIGKILL and a subprocess then waits ~30 s for pipe EOF. */
async function fakeBrowserExec(): Promise<string> {
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    fake,
    `#!/bin/sh
echo "DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc" 1>&2
exec sleep 30
`,
  );
  await Deno.chmod(fake, 0o755);
  return fake;
}

Deno.test("uzik: the launcher prints the gate marker only when a runner asks for it", async () => {
  // The marker is how a budgeted runner avoids charging a harness for time it
  // spent QUEUEING for a slot (scripts/lib/lock-aware-command.ts). It goes to
  // stderr, never stdout: harnesses print their structured results there.
  const fake = await fakeBrowserExec();
  const evalSrc = `
    Deno.env.set("CAP_CHROME_SLOT_DIR", ${JSON.stringify(SLOT_DIR)});
    Deno.env.set("CAP_CHROME_MAX_CONCURRENT", "4");
    ${"" /* marker env set by the parent below */}
    const { launchChrome } = await import(${JSON.stringify(new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href)});
    const c = await launchChrome({ binary: ${JSON.stringify(fake)}, args: [], timeoutMs: 5000 });
    console.log("SLOT " + c.chromeSlot);
    try { c.proc.kill("SIGKILL"); } catch {}
    await c.proc.status;`;
  // --no-check: the subprocess only has to RUN the launcher, and type-checking
  // the imported module graph costs ~15 s per subprocess in the parallel phase.
  const withMarker = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", evalSrc],
    env: { CAP_CHROME_SLOT_MARKER: "1" },
    stdout: "piped", stderr: "piped",
  }).output();
  const without = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", evalSrc],
    stdout: "piped", stderr: "piped",
  }).output();
  const [a, b] = await Promise.all([withMarker, without]);
  const dec = new TextDecoder();
  assertEquals(a.code, 0, `the marker run launched: ${dec.decode(a.stderr)}`);
  assert(
    dec.decode(a.stderr).includes("CAP_CHROME_GATE_ACQUIRED slot="),
    `the marker is printed on stderr when asked: ${dec.decode(a.stderr)}`,
  );
  assertEquals(dec.decode(a.stdout).trim().startsWith("SLOT "), true, "the marker never reaches stdout");
  assertEquals(b.code, 0, `the quiet run launched: ${dec.decode(b.stderr)}`);
  assertEquals(
    dec.decode(b.stderr).includes("CAP_CHROME_GATE_ACQUIRED"),
    false,
    "no marker without the opt-in (harness output stays clean)",
  );
  await Deno.remove(fake);
});
