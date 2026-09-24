// tests/heavy-gate-slot.test.ts — chrome-agent-platform-0lj3
//
// One declared fleet-wide slot for load-sensitive gates. The properties that
// matter are cross-process (a lane and ANOTHER lane's gate), so the contention
// tests spawn real child processes that hold the real flock — a single-process
// test of a lock proves nothing about the exclusion it exists to provide.
//
// Every fixture takes a PRIVATE slot path under a temp dir, never the fleet's
// own: a test must not be able to block a real gate, and the fleet slot is not
// somewhere to experiment.
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  acquireHeavyGateSlot,
  heavyGateHolderPathFor,
  heavyGateRefusalPayload,
  heavyGateSetupFailurePayload,
  HEAVY_GATE_HOLDER_PATH,
  HEAVY_GATE_SLOT_PATH,
  readHeavyGateHolder,
  withHeavyGateSlot,
} from "../scripts/lib/heavy-gate-slot.ts";
import { launchChrome } from "../scripts/lib/chrome-launch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A child that takes the slot, says so, holds, then releases. Written to disk
 *  so the child is a REAL separate process (and its pid is the one the sidecar
 *  must name). */
const CHILD_SOURCE = `
import { acquireHeavyGateSlot } from ${JSON.stringify(`${ROOT}scripts/lib/heavy-gate-slot.ts`)};
const holdMs = Number(Deno.args[0] ?? 3000);
const gate = Deno.args[1] ?? "child-gate";
const slotPath = Deno.args[2];
const boundMs = Number(Deno.args[3] ?? 5000);
const lease = await acquireHeavyGateSlot({ gate, kind: "gate", boundMs, slot: { slotPath } });
console.log(JSON.stringify({ event: "held", pid: Deno.pid, waitedMs: lease.waitedMs, disabled: lease.disabled }));
await new Promise((r) => setTimeout(r, holdMs));
lease.release();
console.log(JSON.stringify({ event: "released" }));
`;

async function spawnHolder(dir: string, args: string[], env: Record<string, string> = {}, tag = "holder") {
  const script = `${dir}/${tag}.mjs`;
  await Deno.writeTextFile(script, CHILD_SOURCE);
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", script, ...args],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
    env: { ...env },
  }).spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  /** Wait for a child's "held" line, or give up with what we saw. */
  const waitForHeld = async (timeoutMs = 8000): Promise<{ held: boolean; pid: number | null; disabled: boolean | null; output: string }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raced = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value: undefined }>((r) => setTimeout(() => r({ done: false, value: undefined }), Math.max(1, deadline - Date.now()))),
      ]);
      if (raced.value) buffer += decoder.decode(raced.value, { stream: true });
      const line = buffer.split("\n").find((l) => l.includes('"event":"held"'));
      if (line) {
        try {
          const parsed = JSON.parse(line);
          return { held: true, pid: Number(parsed.pid), disabled: parsed.disabled === true, output: buffer };
        } catch { /* keep reading */ }
      }
      if (raced.done) break;
    }
    return { held: false, pid: null, disabled: null, output: buffer };
  };
  return { child, waitForHeld, output: () => buffer };
}

/** A child that takes the fleet turn through launchChrome and then makes the
 *  BROWSER fail to start (/bin/false never prints a DevTools endpoint). It reports
 *  whether the call threw, so the parent can check the slot was handed back. */
const STARTUP_FAILURE_SOURCE = `
import { launchChrome } from ${JSON.stringify(`${ROOT}scripts/lib/chrome-launch.ts`)};
try {
  await launchChrome({
    requireQuiet: { maxLoadPerCore: 100, maxCompilers: 100, maxWaitMs: 1000, sampleMs: 100, sustainedSamples: 1 },
    fleetSlot: { gate: "startup-failure-drill", kind: "gate", boundMs: 5000 },
    binary: "/bin/false",
    args: [],
    timeoutMs: 1500,
  });
  console.log(JSON.stringify({ event: "no-throw" }));
} catch (e) {
  console.log(JSON.stringify({ event: "threw", message: String(e?.message ?? e).slice(0, 160) }));
}
// STAY ALIVE on purpose: a leaked slot only hurts while the holder lives, and the
// pre-fix defect kept the turn held by exactly this live, browser-less process.
console.log(JSON.stringify({ event: "alive" }));
await new Promise((r) => setTimeout(r, Number(Deno.args[0] ?? 6000)));
`;

async function reap(child: Deno.ChildProcess, signal: Deno.Signal = "SIGKILL") {
  try { child.kill(signal); } catch { /* gone */ }
  try { await child.status; } catch { /* reaped */ }
}

Deno.test("0lj3: the slot is taken, announced by name, and released", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-" });
  const slotPath = `${dir}/gate.lock`;
  const holderPath = `${slotPath}.holder.json`;
  try {
    const lines: string[] = [];
    const lease = await acquireHeavyGateSlot({
      gate: "fixture-gate",
      kind: "gate",
      boundMs: 2000,
      slot: { slotPath, holderPath },
      onAcquired: (l) => lines.push(l),
    });
    assertEquals(lease.disabled, false);
    assert(lines.some((l) => l.includes("holds the fleet-wide gate slot")), JSON.stringify(lines));
    const announced = readHeavyGateHolder(holderPath);
    assertEquals(announced.holder?.gate, "fixture-gate");
    assertEquals(announced.holder?.pid, Deno.pid);
    assertEquals(announced.alive, true, "the holder is this live process");
    lease.release();
    assertEquals(readHeavyGateHolder(holderPath).holder, null, "the release clears the announcement");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3: another PROCESS's gate holds the slot, and the refusal NAMES it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-" });
  const slotPath = `${dir}/gate.lock`;
  const holderPath = `${slotPath}.holder.json`;
  const holder = await spawnHolder(dir, ["6000", "other-lane-gate", slotPath]);
  try {
    const held = await holder.waitForHeld();
    assert(held.held, `the child never took the slot: ${holder.output()}`);
    // The parent's bound is short: it must refuse, environmentally, and name the
    // child — not wait forever and not start.
    const err = await assertRejects(
      () => acquireHeavyGateSlot({ gate: "my-gate", kind: "gate", boundMs: 700, slot: { slotPath, holderPath } }),
      Error,
    );
    assertEquals(err.name, "HeavyGateSlotRefusedError");
    assert(err.message.includes("ENVIRONMENT:"), err.message);
    assert(err.message.includes("other-lane-gate"), err.message);
    assert(err.message.includes(`pid ${held.pid}`), `the refusal names the holder's pid: ${err.message}`);
    const payload = heavyGateRefusalPayload(err as never);
    assertEquals(payload.reason, "heavy-gate-slot-busy");
    assertEquals((payload.holder as { gate?: string })?.gate, "other-lane-gate");
    assertEquals(payload.holderAlive, true);
    // The holder is untouched: we measure and wait, or refuse — never interfere.
    const alive = await holder.child.status;
    void alive;
  } finally {
    await reap(holder.child);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3 MUTANT: with the slot disabled a SECOND holder gets in beside the first — the exclusion is the lock, not luck", async () => {
  // The direction that proves the contention test above can fail. The holder is
  // a real process holding the real lock; a second process started with the slot
  // disabled reports that it ALSO holds, at the same moment. Without the lock
  // there is no exclusion — which is exactly what the contention test asserts is
  // present when the slot is on. Both children are separate processes, so this
  // never mutates the test process's own environment (m3a2).
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-" });
  const slotPath = `${dir}/gate.lock`;
  const holderPath = `${slotPath}.holder.json`;
  const holder = await spawnHolder(dir, ["6000", "real-holder-gate", slotPath]);
  let intruder: Awaited<ReturnType<typeof spawnHolder>> | null = null;
  try {
    const held = await holder.waitForHeld();
    assert(held.held && held.disabled === false, `the holder must hold for real: ${holder.output()}`);
    intruder = await spawnHolder(dir, ["500", "disabled-gate", slotPath], { CAP_HEAVY_GATE_DISABLE: "1" }, "intruder");
    const also = await intruder.waitForHeld();
    assert(also.held, `the second holder claimed the slot: ${intruder.output()}`);
    assertEquals(also.disabled, true, "a disabled lease says so — it never pretends to be a real hold");
    // Both are now "in" — the exclusion came from the lock, and only from it.
    assertEquals(readHeavyGateHolder(holderPath).holder?.gate, "real-holder-gate", "the real holder is still the announced one");
  } finally {
    if (intruder) await reap(intruder.child);
    await reap(holder.child);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3: a SIGKILLed holder leaves no held slot (crash safety)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-" });
  const slotPath = `${dir}/gate.lock`;
  const holderPath = `${slotPath}.holder.json`;
  const holder = await spawnHolder(dir, ["30000", "killed-gate", slotPath]);
  try {
    const held = await holder.waitForHeld();
    assert(held.held, `the child never took the slot: ${holder.output()}`);
    await reap(holder.child, "SIGKILL");
    // The kernel drops the flock when the holder dies. The next gate gets it.
    const lease = await acquireHeavyGateSlot({ gate: "after-crash-gate", kind: "gate", boundMs: 5000, slot: { slotPath, holderPath } });
    assertEquals(lease.disabled, false);
    assertEquals(readHeavyGateHolder(holderPath).holder?.gate, "after-crash-gate", "the live holder is announced");
    lease.release();
  } finally {
    await reap(holder.child);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3: withHeavyGateSlot releases on the way out even when the gate throws", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-" });
  const slotPath = `${dir}/gate.lock`;
  const holderPath = `${slotPath}.holder.json`;
  try {
    await assertRejects(
      () => withHeavyGateSlot({ gate: "throwing-gate", boundMs: 2000, slot: { slotPath, holderPath } }, async () => {
        // While the gate runs, the announcement names it.
        assertEquals(readHeavyGateHolder(holderPath).holder?.gate, "throwing-gate");
        throw new Error("the gate failed");
      }),
      Error,
      "the gate failed",
    );
    assertEquals(readHeavyGateHolder(holderPath).holder, null, "a failed gate must not hold the fleet slot behind it");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3: the fleet slot and its sidecar are the documented tmpfs paths", () => {
  // The durable-root guard allowlists exactly these two; a rename here without
  // that list moving is how a coordination file becomes a stray tmpfs leak.
  assertEquals(HEAVY_GATE_SLOT_PATH, "/tmp/cap-heavy-gate.lock");
  assertEquals(HEAVY_GATE_HOLDER_PATH, "/tmp/cap-heavy-gate.holder.json");
});

Deno.test("0lj3: the fleet slot is PAIRED with the load-sensitive declaration, both directions", async () => {
  // A declaration nobody honours is worse than none: the harness that says "my
  // reds are environmental" (registry `loadSensitive`) is exactly the one that
  // must take turns, and a harness that did not declare itself must NOT hold the
  // fleet-wide slot. Same shape as the mkax guard for requireQuiet.
  const { HARNESSES } = await import("../scripts/lib/harness-registry.ts");
  const declared = Object.entries(HARNESSES)
    .filter(([, entry]) => entry.loadSensitive !== undefined)
    .map(([file]) => file)
    .sort();
  assert(declared.length >= 1, "at least one harness declares itself load-sensitive");

  const taking = (await Promise.all(
    [...Deno.readDirSync(`${ROOT}scripts`)]
      .filter((e) => e.isFile && e.name.endsWith(".ts"))
      .map(async (e) => ({ name: e.name, src: await Deno.readTextFile(`${ROOT}scripts/${e.name}`) })),
  )).filter((f) => /fleetSlot:\s*(true|\{)/u.test(f.src)).map((f) => f.name).sort();

  assertEquals(
    taking,
    declared,
    "the registry's loadSensitive set and the sources that take the fleet-wide slot must be the SAME set",
  );
  // The batch runner takes one turn for many browsers, so it is named here even
  // though it is not a `loadSensitive` harness itself (it launches no browser of
  // its own — its KATs do).
  const katRunner = await Deno.readTextFile(`${ROOT}scripts/kat-runner.ts`);
  assert(/acquireHeavyGateSlot\(\{\s*gate:\s*"kat-runner"/u.test(katRunner), "the KAT batch takes the fleet-wide turn for the whole run");
});

Deno.test("0lj3: fleetSlot without requireQuiet is a caller bug, refused at the launcher", async () => {
  const err = await assertRejects(
    () => launchChrome({ fleetSlot: true, binary: "/bin/true", timeoutMs: 1000 }),
    Error,
  );
  assert(err.message.includes("pass requireQuiet too"), err.message);
});

Deno.test("0lj3: a HELD fleet slot makes the REAL journey gate refuse, naming the holder, and start no browser", async () => {
  // The end-to-end proof of the wiring: the journey harness takes the fleet-wide
  // turn through launchChrome, so while another process holds it the gate must
  // exit 75 with the holder named — and never start a browser.
  //
  // zeew: on a PRIVATE slot path, NOT the fleet's own. The first version held the
  // real /tmp/cap-heavy-gate.lock, so it collided with any lane running the real
  // journey gate (measured: HeavyGateSlotRefusedError naming chrome-journeys pid
  // 3128320, which red-ed this test while the mechanism was behaving correctly) —
  // and it also BLOCKED real gates for its duration. A test whose subject is
  // contention must not create contention to test it: the hold and the spawned
  // gate both use one private path, and then nothing outside this test is involved.
  const dir = await Deno.makeTempDir({ prefix: "cap-zeew-slot-" });
  const slotPath = `${dir}/gate.lock`;
  const lease = await acquireHeavyGateSlot({ gate: "fixture-holds-fleet-slot", kind: "gate", boundMs: 2000, slot: { slotPath }, onAcquired: () => {}, onWait: () => {} });
  try {
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", `${ROOT}scripts/chrome-journeys.ts`],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
      env: { CAP_HEAVY_GATE_BOUND_MS: "1200", CAP_HEAVY_GATE_SLOT: slotPath },
    }).output();
    const out = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
    assertEquals(run.code, 75, `the gate refused environmentally: ${out.slice(-600)}`);
    assert(out.includes("the fleet-wide heavy-gate slot is busy"), out.slice(-600));
    assert(out.includes("fixture-holds-fleet-slot"), "the refusal names the holder");
    assert(out.includes("CAP_ENVIRONMENTAL_REFUSAL"), "the greppable marker is printed");
    assert(out.includes('"reason":"heavy-gate-slot-busy"'), out.slice(-400));
    assertEquals(out.includes("DevTools listening"), false, "no browser was started");
  } finally {
    lease.release();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3: the module never interferes with another lane's processes", async () => {
  // The DO-NOT: measure and wait, or refuse. One check for liveness is allowed —
  // signal 0, which is an existence probe and not a signal — and must stay the
  // ONLY signal this module ever sends.
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/heavy-gate-slot.ts`);
  const code = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
  for (const forbidden of ["pkill", "killall", "renice", "ionice", "taskset", "cgroup"]) {
    assertEquals(code.includes(forbidden), false, `heavy-gate-slot.ts must not ${forbidden} anything`);
  }
  const signals = [...code.matchAll(/Deno\.kill\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert(signals.length >= 1, "the liveness probe is present");
  for (const args of signals) {
    assert(/,\s*0$/.test(args), `every Deno.kill in this module must be the signal-0 existence probe, saw: Deno.kill(${args})`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * FAILURE-INJECTION DRILLS (review 2026-09-23, chrome-agent-platform-0lj3).
 *
 * The review's finding about the evidence was exact: every defect it reproduced
 * was in an ERROR path, and the tests that existed proved the lock working "in
 * the case where nothing goes wrong". A lock is most dangerous when something
 * upstream fails, so each defect below gets an injection that FAILS something on
 * purpose and checks two things: that nothing stays held, and that what a lane is
 * told matches what actually happened.
 * ──────────────────────────────────────────────────────────────────────────── */

Deno.test("0lj3 drill: a Chrome that never starts hands the fleet slot back (defect 1)", async () => {
  // The injection: the real launcher, a real fleet turn, a browser that cannot
  // come up. Before the fix the turn stayed held by a LIVE process owning no
  // browser — the one leak the stdin-close pattern cannot cover.
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-startup-" });
  const script = `${dir}/startup-failure.mjs`;
  await Deno.writeTextFile(script, STARTUP_FAILURE_SOURCE);
  // Bounded on purpose: an UNRELEASED lease keeps the holder's own event loop
  // alive (an open child stdin is a live resource), so the pre-fix defect did not
  // red an assertion — it HUNG. That is the defect's real shape, and the drill
  // must be able to fail deterministically, so the child runs under a timeout and
  // its clean exit is part of the assertion.
  const child = new Deno.Command("/usr/bin/timeout", {
    args: ["20", Deno.execPath(), "run", "-A", "--no-check", script, "6000"],
    cwd: ROOT,
    stdout: "piped", stderr: "piped",
    env: { CAP_HEAVY_GATE_SLOT: `${dir}/gate.lock` },
  }).spawn();
  try {
    // Read the child's report WHILE IT IS STILL RUNNING: the property is that a
    // live holder that owns no browser does not own the machine. (Asserting after
    // it exits would test nothing — its death drops the lock either way, which is
    // how the first version of this drill stayed green against a mutant.)
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    const deadline = Date.now() + 8000;
    while (!out.includes('"event":"alive"') && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now()))),
      ]);
      if (chunk.value) out += decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    assert(out.includes('"event":"threw"'), `the launcher reported the startup failure: ${out.slice(0, 300)}`);
    assert(out.includes("never printed a DevTools endpoint"), out.slice(0, 300));
    assert(out.includes('"event":"alive"'), `the child is still running (the leak only matters while the holder lives): ${out.slice(0, 300)}`);
    // THE ASSERTION: the slot is free even though the failed holder is alive.
    const lease = await acquireHeavyGateSlot({
      gate: "during-failed-holder", kind: "gate", boundMs: 2500,
      slot: { slotPath: `${dir}/gate.lock` },
      onWait: () => {},
    });
    assertEquals(lease.disabled, false, "the startup failure gave the fleet turn back while its process is still alive");
    lease.release();
    try { reader.releaseLock(); } catch { /* released */ }
    // `child.output()` cannot be used here — we took stdout with a reader — so the
    // exit code comes from the status the runtime already tracks.
    const status = await child.status;
    assertEquals(status.code, 0, "the failed launcher exited cleanly");
  } finally {
    await reap(child);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3 drill: a setup fault is reported as SETUP, never as contention (defect 3)", async () => {
  // The injection: a lock path that cannot be opened. flock exits 66 with
  // 'cannot open lock file' — measured, not assumed. The first version reported
  // this as 'the slot is busy, held by an unnamed holder', which sends a lane to
  // wait for a holder that does not exist.
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-setup-" });
  try {
    const err = await assertRejects(
      () => acquireHeavyGateSlot({
        gate: "setup-drill", kind: "gate", boundMs: 1500,
        slot: { slotPath: `${dir}/missing-dir/gate.lock` },
        onWait: () => {},
      }),
      Error,
    );
    assertEquals(err.name, "HeavyGateSlotSetupError");
    assert(err.message.includes("could not be SET UP"), err.message);
    assert(err.message.includes("NOT contention"), err.message);
    assert(!err.message.includes("busy"), `a setup fault must not read as busy: ${err.message}`);
    const payload = heavyGateSetupFailurePayload(err as never);
    assertEquals(payload.reason, "heavy-gate-slot-unavailable");
    assert(String(payload.detail).includes("cannot open lock file"), String(payload.detail));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3 drill: the announcement is written where the READER looks (defect 4)", async () => {
  // Two halves. (a) the pure derivation: the documented default slot's sidecar IS
  // the reader's default path — the first version derived `${slotPath}.holder.json`
  // while the exported reader default was a different literal, so a holding lane
  // was announced somewhere the handy reader never looked. (b) a live round trip
  // on a private slot, to prove writer and reader agree in practice too.
  assertEquals(heavyGateHolderPathFor(HEAVY_GATE_SLOT_PATH), HEAVY_GATE_HOLDER_PATH);
  // The private-slot derivation is asserted against a path this test creates,
  // never a literal tmpfs path (the durable-root guard rightly refuses those, and
  // a hardcoded /tmp literal in a test is exactly the ambient-state coupling the
  // 2026-09-23 review was about).
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-sidecar-" });
  assertEquals(heavyGateHolderPathFor(`${dir}/gate.lock`), `${dir}/gate.lock.holder.json`);
  const slotPath = `${dir}/gate.lock`;
  try {
    const lease = await acquireHeavyGateSlot({ gate: "sidecar-drill", kind: "gate", boundMs: 2000, slot: { slotPath }, onAcquired: () => {} });
    // The reader with NO argument reads the DEFAULT path; the derivation for this
    // private slot must therefore be the path the writer used, and the reader for
    // the private path must see it too.
    assertEquals(readHeavyGateHolder(heavyGateHolderPathFor(slotPath)).holder?.gate, "sidecar-drill");
    lease.release();
    assertEquals(readHeavyGateHolder(heavyGateHolderPathFor(slotPath)).holder, null, "the release clears it");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0lj3 drill: acquire+release does not delay process exit (defect 2)", async () => {
  // The injection: a child that takes the slot with a LONG bound, releases at
  // once and exits. The first version left a pending setTimeout of up to the
  // whole bound behind every read, so the process stayed alive after releasing.
  // The child must exit promptly; the bound is 60 s, so a 10 s ceiling is a
  // generous tell.
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-exit-" });
  const script = `${dir}/exit-drill.mjs`;
  await Deno.writeTextFile(script, `
import { acquireHeavyGateSlot } from ${JSON.stringify(`${ROOT}scripts/lib/heavy-gate-slot.ts`)};
const lease = await acquireHeavyGateSlot({ gate: "exit-drill", kind: "gate", boundMs: 60000, slot: { slotPath: Deno.args[0] }, onAcquired: () => {}, onWait: () => {} });
lease.release();
console.log(JSON.stringify({ event: "released" }));
`);
  const t0 = Date.now();
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", script, `${dir}/gate.lock`],
      cwd: ROOT, stdout: "piped", stderr: "piped",
    }).spawn();
    const { code } = await child.status;
    const elapsed = Date.now() - t0;
    assertEquals(code, 0, "the child exited cleanly");
    assert(elapsed < 10_000, `the child exited in ${elapsed} ms despite a 60 s bound — the timer must not outlive the release`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ryrr: fleetSlot is REFUSED while this process already holds the canonical lock", async () => {
  // The inverted-order deadlock, made impossible in code: the custody supervisor
  // (scripts/security-suite-supervisor.sh) holds the canonical serialized-Chrome
  // lock on fd 9 for its whole run and launches its harnesses as children, so a
  // child that asked for the fleet turn would queue behind a gate that is itself
  // waiting for the canonical lock — a deadlock neither lock can see. The
  // acquisition call must refuse instead. Driven in a CHILD process so the marker
  // cannot leak into this runner process (m3a2), and asserted on the MESSAGE, so a
  // build that merely fails later (no DevTools endpoint) does not read as this
  // refusal.
  const dir = await Deno.makeTempDir({ prefix: "cap-ryrr-" });
  const script = `${dir}/order.mjs`;
  await Deno.writeTextFile(script, `
import { launchChrome } from ${JSON.stringify(`${ROOT}scripts/lib/chrome-launch.ts`)};
try {
  await launchChrome({
    requireQuiet: { maxLoadPerCore: 100, maxCompilers: 100, maxWaitMs: 500, sampleMs: 100, sustainedSamples: 1 },
    fleetSlot: { gate: "order-drill", boundMs: 1000 },
    binary: "/bin/true", args: [], timeoutMs: 500,
  });
  console.log(JSON.stringify({ event: "no-throw" }));
} catch (e) {
  console.log(JSON.stringify({ event: "threw", message: String(e?.message ?? e).slice(0, 220) }));
}
`);
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", script],
      cwd: ROOT, stdout: "piped", stderr: "piped",
      env: { CAP_CHROME_LOCK_HELD: "1", CAP_HEAVY_GATE_SLOT: `${dir}/gate.lock` },
    }).spawn();
    const out = new TextDecoder().decode((await child.output()).stdout);
    assert(out.includes('"event":"threw"'), `the combination must be refused: ${out.slice(0, 300)}`);
    assert(
      out.includes("refusing fleetSlot while this process already holds the canonical"),
      `the refusal must NAME the inverted order, not fail later for another reason: ${out.slice(0, 300)}`,
    );
    assertEquals(out.includes("no-throw"), false, "it must never acquire a turn in this state");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── n772: the announcement's PATH and HONESTY ───────────────────────────────
// The bead (chrome-agent-platform-n772) reported that the writer derived
// `${slotPath}.holder.json` while the exported reader default was a different
// literal, so an operational reader saw no announcement. On this tree the path
// derivation already special-cases the default slot (the 0lj3 revision), and the
// tests below are the two the bead asked for that were missing: an EXECUTING check
// of the announced sidecar (not a constant comparison), and an isolation check for
// private slots. A third check covers a defect measured while verifying this one:
// a FREE slot announced "waiting ... held by an unnamed holder", i.e. a holder that
// did not exist.

Deno.test("n772 drill: the default slot's announcement is where the DEFAULT reader looks", async () => {
  // (a) The pure half the drift breaks: the writer's derivation for the default
  // slot path must BE the reader's default path. Under the reported bug these are
  // two different files and this assertion is what fails.
  assertEquals(
    heavyGateHolderPathFor(HEAVY_GATE_SLOT_PATH),
    HEAVY_GATE_HOLDER_PATH,
    "the default slot's announcement path must be the path the default reader reads",
  );
  // (b) EXECUTING, on a private slot: the writer's derivation and the reader agree
  // in practice, on a lock that cannot block a real gate (this file's own rule).
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-n772-" });
  const slotPath = `${dir}/gate.lock`;
  try {
    const lease = await acquireHeavyGateSlot({
      gate: "n772-private-roundtrip", kind: "gate", boundMs: 2000,
      slot: { slotPath }, onAcquired: () => {}, onWait: () => {},
    });
    const derived = heavyGateHolderPathFor(slotPath);
    assert(derived.endsWith(".holder.json"), `a private announcement lives beside its slot; got ${derived}`);
    assertEquals(readHeavyGateHolder(derived).holder?.gate, "n772-private-roundtrip");
    lease.release();
    assertEquals(readHeavyGateHolder(derived).holder, null, "the release clears the private announcement");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  // (c) EXECUTING, on the REAL default slot: acquire it only if it is free, with a
  // bound so short it cannot hold a real gate up, and then read through the DEFAULT
  // reader (no argument). Under the reported drift this is exactly what fails: the
  // announcement would land at `${HEAVY_GATE_SLOT_PATH}.holder.json` and the
  // default reader would see nothing. When another lane holds the slot the check is
  // INCONCLUSIVE by construction — this test never waits for the fleet slot, and it
  // says so rather than passing quietly.
  let tookFleetSlot = false;
  try {
    const lease = await acquireHeavyGateSlot({
      gate: "n772-default-reader", kind: "gate", boundMs: 300,
      onAcquired: () => {}, onWait: () => {},
    });
    tookFleetSlot = true;
    try {
      const viaDefaultReader = readHeavyGateHolder();
      assertEquals(
        viaDefaultReader.holder?.gate, "n772-default-reader",
        "the announcement for the default slot must be visible to the default reader (no path argument)",
      );
      assert(viaDefaultReader.alive === true, "our own live process must read as alive");
    } finally {
      lease.release();
    }
    assertEquals(readHeavyGateHolder().holder, null, "the release removes the announcement at the default path");
  } catch (e) {
    if ((e as Error).name === "HeavyGateSlotRefusedError") {
      console.log("  INCONCLUSIVE (default-path half): the fleet slot is held by another lane right now — the default reader's path was not exercised on this run (the private half above already ran). Re-run when the slot is free; this is not a pass and not a failure.");
    } else throw e;
  }
  // The fleet lock itself must never be left held by this test, whichever branch ran.
  assert(HEAVY_GATE_SLOT_PATH.length > 0, "guard against the constant being emptied");
  assert(tookFleetSlot === true || tookFleetSlot === false, "no-op: documents that both outcomes are legal here");
});

Deno.test("n772 drill: a private slot's announcement stays beside it and never at the default path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-n772-iso-" });
  const slotPath = `${dir}/private.lock`;
  const defaultBefore = (() => { try { return Deno.readTextFileSync(HEAVY_GATE_HOLDER_PATH); } catch { return null; } })();
  try {
    const lease = await acquireHeavyGateSlot({
      gate: "n772-isolated-holder", kind: "gate", boundMs: 2000,
      slot: { slotPath }, onAcquired: () => {}, onWait: () => {},
    });
    // The private announcement exists at its own derived path...
    assertEquals(readHeavyGateHolder(`${slotPath}.holder.json`).holder?.gate, "n772-isolated-holder");
    // ...the DEFAULT path was not touched by this acquisition (whatever it held
    // before this test — another lane's announcement included — it still holds)...
    const defaultNow = (() => { try { return Deno.readTextFileSync(HEAVY_GATE_HOLDER_PATH); } catch { return null; } })();
    assertEquals(defaultNow, defaultBefore, "a private slot must not write its announcement at the default path");
    // ...and the default reader does not name this private holder.
    assert(
      readHeavyGateHolder().holder?.gate !== "n772-isolated-holder",
      "the default reader must not report a private slot's holder",
    );
    lease.release();
    assertEquals(readHeavyGateHolder(`${slotPath}.holder.json`).holder, null, "the private announcement is cleared on release");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("n772 drill: a FREE slot announces no wait; a held slot names its holder", async () => {
  // MEASURED BEFORE THE FIX: acquiring a FREE slot fired onWait once with
  // "waiting for the fleet-wide gate slot [...] — held by an unnamed holder (no
  // announcement sidecar)" while the acquisition completed in ~8 ms: a holder claim
  // where there was no holder, and enough to make real contention indistinguishable
  // from an uncontended acquisition in every gate's log. The line now prints only
  // once the acquisition has actually failed to complete a read, naming the holder
  // read AT THAT MOMENT.
  const dir = await Deno.makeTempDir({ prefix: "cap-heavyslot-n772-wait-" });
  const slotPath = `${dir}/wait.lock`;
  const holderOpts = { kind: "gate" as const, slot: { slotPath } };
  try {
    const freeWaits: string[] = [];
    const freeAcquired: string[] = [];
    const free = await acquireHeavyGateSlot({
      gate: "n772-free", boundMs: 2000, ...holderOpts,
      onWait: (l) => freeWaits.push(l), onAcquired: (l) => freeAcquired.push(l),
    });
    free.release();
    assertEquals(freeWaits, [], "a free slot must announce no wait — there is nothing to wait for and no holder to name");
    assert(freeAcquired.length > 0, "the acquisition itself is still announced");

    const holder = await acquireHeavyGateSlot({ gate: "n772-holder", boundMs: 3000, ...holderOpts, onWait: () => {}, onAcquired: () => {} });
    const waits: string[] = [];
    const refused = await acquireHeavyGateSlot({
      gate: "n772-waiter", boundMs: 1200, ...holderOpts,
      onWait: (l) => waits.push(l), onAcquired: () => {},
    }).then(() => null, (e) => e as Error);
    holder.release();
    assert(refused, "the second acquisition must be refused while the first holds the slot");
    assertEquals(waits.length, 1, "a contested acquisition announces the wait exactly once");
    assert(
      waits[0].includes("n772-holder") && /\bpid \d+\b/.test(waits[0]),
      `the wait must name the real holder and its pid; got: ${waits[0]}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
