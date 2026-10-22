// tests/serial-phase-timeout.test.ts — chrome-agent-platform-86gg.
//
// A flat 180s per-file bound is sized for an idle box: the same BUILD work takes
// several times longer under the fleet's normal load, so the bound false-reds
// exactly when the box is busy. The fix scales the DEFAULT by load per CPU (with
// a ceiling, so it stays a bound) and leaves an explicit
// CAP_SERIAL_TEST_TIMEOUT_MS unscaled, because that number is the operator's.
//
// The test that matters is the last one: the SAME slow file is killed by the
// flat bound and survives the scaled one, so the change is a sizing fix rather
// than a licence — and the kill test beside it proves the bound still bounds.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  DEFAULT_SERIAL_FILE_TIMEOUT_MS,
  MAX_LOAD_SCALE,
  runSerialFile,
  runSerialFiles,
  serialFileTimeoutMs,
} from "../scripts/lib/serial-phase.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// chrome-agent-platform-nyi3q: every fixture below used a SHARED durable directory name and removed it
// recursively, so two lanes running this suite at the same time deleted each other's fixture files
// mid-spawn. Measured on 2026-10-16: the same two cases failed on two different trees in the same
// minutes with `deno` exiting 1 in 0.0s and `spawnSync deno ETIMEDOUT`, and passed whenever the suite ran
// alone. A per-run subdirectory makes the fixture owned by the run that created it.
let fixtureRunSeq = 0;
const fixtureDir = (name: string) => durableDir(name, `${process.pid}-${Date.now()}-${fixtureRunSeq++}`);

Deno.test("86gg: an idle box gets exactly the base timeout", () => {
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 1 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS);
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 0 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS);
  assertEquals(serialFileTimeoutMs({ loadPerCpu: Number.NaN }), DEFAULT_SERIAL_FILE_TIMEOUT_MS);
});

Deno.test("86gg: the timeout scales with load per CPU and stops at the ceiling", () => {
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 2 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS * 2);
  assertEquals(
    serialFileTimeoutMs({ loadPerCpu: MAX_LOAD_SCALE + 5 }),
    DEFAULT_SERIAL_FILE_TIMEOUT_MS * MAX_LOAD_SCALE,
    "load beyond the ceiling must clamp, so the bound stays a bound",
  );
});

Deno.test("86gg: an explicit CAP_SERIAL_TEST_TIMEOUT_MS wins and is never scaled", () => {
  const explicit = 12_345;
  assertEquals(
    serialFileTimeoutMs({ loadPerCpu: 9, override: String(explicit) }),
    explicit,
    "the operator's number is the operator's number",
  );
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 3, override: 999 }), 999);
});

Deno.test("86gg: more load never means less time (monotone)", () => {
  let previous = 0;
  for (const load of [1, 1.5, 2, 3, 4, 6, 20]) {
    const ms = serialFileTimeoutMs({ loadPerCpu: load });
    assert(ms >= previous, `load ${load} produced ${ms}ms, below the previous ${previous}ms`);
    previous = ms;
  }
});

Deno.test("86gg: the bound still BOUNDS — a hung file is killed (exit 124)", async () => {
  // Durable-routed per the repo's durable-root guard (tmpdir usage is only allowed
  // through this helper) — the same guard this suite is about, catching my scratch.
  const dir = await fixtureDir("86gg-serial-timeout");
  const hung = `${dir}/zz-hung-${Date.now()}.test.ts`;
  // The fixture must keep the event loop ALIVE *and* never finish. Two shapes
  // that are NOT hangs, measured while writing this test: a bare
  // `await new Promise(() => {})` (no pending I/O, so Deno exits by itself in
  // ~0.45s with code 1) and a non-awaiting test that starts an interval (the test
  // completes, so the runner reports success). Only a repeating timer INSIDE a
  // never-resolving async test holds the runner open — which is what the bound
  // must kill.
  try {
    await Deno.writeTextFile(
      hung,
      'Deno.test("hangs forever", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
    );
    const r = runSerialFile(hung, { timeoutMs: 2_000, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT });
    assertEquals(r.timedOut, true, "a file that never finishes must be killed");
    assertEquals(r.code, 124);
  } finally {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* ignore */ }
  }
});


// ── chrome-agent-platform-whl7d: the execution window must not have to pay for deno's BOOT ─────────
// The declared-work shape (cihz) was right, but it still put the bound over `spawn -> boot -> work`.
// Measured in the merger's full gate on 2026-10-22 (load 3.9, .beads/embeddeddolt at 2.0GB): a fixture
// whose own body is INSTANT reported `GREEN in 14.4s`, i.e. deno cold boot alone cost ~14s, so the
// 12000ms scaled window bought the 5000ms of declared work only ~7s of boot — and this case redded
// `the scaled bound (12000ms) must let 5000ms of declared work finish even with startup inside it`.
// A bound that has to cover a boot the box can lengthen 3-14x is asserting the box, not the code. The
// serial phase already has the right seam for this: the READY HANDSHAKE
// (`CAP_SERIAL_READY_FILE` / scripts/lib/serial-runner.mjs) starts the execution timer only once the
// child says its runtime is up. So boot is bounded by the READY window (measurable, load-classified by
// classifyReadyMarkerTimeout) and the execution bound covers only the fixture's DECLARED work again.
// Numbers below are DECLARED relationships; the 12000ms bound is unchanged (whl7d: do not raise it to
// fit the change that blocked on it).
const CIHZ_SLOW_MS = 5_000; // the fixture's DECLARED work, asserted directly rather than inferred from elapsed time
const CIHZ_FLAT_MS = 4_000; // strictly below CIHZ_SLOW_MS -> the kill cannot be a race with the box's load
const CIHZ_BOOT_ALLOWANCE_MS = 120_000; // the READY window: boot is measured, and never charged to the execution bound
// What the execution window must still have spare after the declared work: the runner's 50ms marker
// poll plus timer delivery on a starved loop. A relationship, not a number to raise when a gate reds.
const CIHZ_MIN_EXECUTION_HEADROOM_MS = 3_500;

Deno.test("cihz/86gg: the scaled bound is STRICTLY above the flat bound, and a kill happens only below the fixture's DECLARED work", async () => {
  // WHY THIS REPLACED THE OLD FORM (chrome-agent-platform-cihz): it used a 3.5s fixture, a 2s flat bound and a
  // 6s scaled bound, so the "survives" half left only ~2.5s for deno STARTUP — and at loadavg ~7 deno's own
  // startup ate it, flipping a real assertion on the box rather than on the code (measured: 3/5 fails at the
  // ia4z tip, 1/4 with main's runner, and 4/4 at loadavg ~7.2 including 2/2 on the pristine base).
  // The fix is to stop letting the clock decide: the fixture DECLARES its work, the flat bound sits BELOW that
  // declared work (so a kill is structural — the file cannot exit before its own timer), and whl7d moved boot
  // OUT of both bounds through the ready handshake, so the "survives" half measures the bound and not the box.
  const dir = await fixtureDir("cihz-scaled-bound");
  const stamp = Date.now();
  // Each run needs its OWN marker: serial-runner starts the execution timer as soon as a marker exists, so a
  // marker left behind by the previous run would put that run's boot back inside its bound.
  const slowFixture = async (label: string) => {
    const marker = `${dir}/ready-${label}-${stamp}.marker`;
    const file = `${dir}/zz-cihz-slow-${label}-${stamp}.test.ts`;
    await Deno.writeTextFile(
      file,
      `await Deno.writeTextFile(${JSON.stringify(marker)}, "ready");\n` +
        `Deno.test("slow but progressing", async () => { await new Promise((r) => setTimeout(r, ${CIHZ_SLOW_MS})); });\n`,
    );
    return { file, marker };
  };
  const markerSeen = (marker: string) => Deno.readTextFile(marker).then((body) => body.trim() === "ready");
  try {
    // (1) THE CONTRACT, pure and clock-free: scaling must be STRICTLY greater than the flat bound, it must
    // still be the documented formula, and the execution window must leave the declared work real headroom.
    // This is the assertion that fails if the scaling is removed or silently flattened.
    const scaled = serialFileTimeoutMs({ base: CIHZ_FLAT_MS, loadPerCpu: 3 });
    assertEquals(scaled, 12_000, "the scaled bound must remain base x loadPerCpu");
    assert(
      scaled > CIHZ_FLAT_MS,
      `the scaled bound must be STRICTLY greater than the flat bound (${scaled} vs ${CIHZ_FLAT_MS})`,
    );
    assert(
      scaled - CIHZ_SLOW_MS >= CIHZ_MIN_EXECUTION_HEADROOM_MS,
      `the execution window must leave at least ${CIHZ_MIN_EXECUTION_HEADROOM_MS}ms of headroom above the ` +
        `fixture's ${CIHZ_SLOW_MS}ms of declared work, got ${scaled - CIHZ_SLOW_MS}ms (bound ${scaled}ms)`,
    );
    // (2) BELOW the declared work: a kill is STRUCTURAL. The fixture cannot exit before CIHZ_SLOW_MS, so any
    // bound under it kills on every run, at every load — there is nothing here for load to flip.
    const kill = await slowFixture("kill");
    const killed = runSerialFile(kill.file, {
      timeoutMs: CIHZ_FLAT_MS,
      readyFile: kill.marker,
      readyTimeoutMs: CIHZ_BOOT_ALLOWANCE_MS,
      stdio: ["ignore", "ignore", "pipe"],
      cwd: ROOT,
    });
    assertEquals(
      await markerSeen(kill.marker),
      true,
      "the fixture must report readiness, so the kill is the bound and not a boot-runaway",
    );
    assertEquals(
      killed.timedOut,
      true,
      `a ${CIHZ_FLAT_MS}ms bound must kill a file that declares ${CIHZ_SLOW_MS}ms of work`,
    );
    assertEquals(killed.code, 124, "a killed file reports exit 124");
    // (3) ABOVE it: the same declared work finishes under the scaled bound, with the execution clock started
    // at readiness — so boot is inside the READY window and the headroom is only poll/timer latency.
    const live = await slowFixture("live");
    const survived = runSerialFile(live.file, {
      timeoutMs: scaled,
      readyFile: live.marker,
      readyTimeoutMs: CIHZ_BOOT_ALLOWANCE_MS,
      stdio: ["ignore", "ignore", "pipe"],
      cwd: ROOT,
    });
    assertEquals(await markerSeen(live.marker), true, "the surviving run must also have reached readiness");
    assertEquals(
      survived.timedOut,
      false,
      `the scaled bound (${scaled}ms) must let ${CIHZ_SLOW_MS}ms of declared work finish once the execution ` +
        `clock starts at readiness (stderr: ${survived.stderr?.toString().trim() || "none"})`,
    );
    assertEquals(survived.code, 0, "the surviving file must exit cleanly");
    // The readiness handshake must have been the arbiter: a killed-on-boot run would still report 124 and
    // could masquerade as a bound test, so name that failure mode explicitly.
    assert(
      !(survived.stderr?.toString() ?? "").includes("READY_MARKER_TIMEOUT"),
      `the survive half must fail on the EXECUTION bound, never on the ready window: ${survived.stderr?.toString()}`,
    );
  } finally {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* ignore */ }
  }
});


// ── chrome-agent-platform-kj9s: per-file windows ──────────────────────────────
// A per-file bound exists for files whose cost is set by BUILD COUNT (build-bootstrap: 3 production
// builds; build-debug-mode: dev + store + a steady-state store). build-tool-bundling is NOT listed:
// measured 10s, so it stays on the base window. This pins that the map is CONSULTED for a listed file and that the
// base window still governs an unlisted one — the failure mode this must not have is "the override
// silently does nothing and the file is still killed by the base".
Deno.test("kj9s: a per-file bound overrides the base window for the files that need it, and only those", async () => {
  const dir = await fixtureDir("kj9s-per-file-bounds");
  const hung = `${dir}/zz-hung-perfile-${Date.now()}.test.ts`;
  const fine = `${dir}/zz-fine-perfile-${Date.now()}.test.ts`;
  try {
    await Deno.writeTextFile(
      hung,
      'Deno.test("hangs forever", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
    );
    await Deno.writeTextFile(
      fine,
      'Deno.test("finishes fast", () => { if (1 !== 1) throw new Error("unreachable"); });\n',
    );
    // The batch form: the killed file's exit is reported, and the neighbour beside it still runs.
    assertEquals(
      runSerialFiles([hung, fine], {
        timeoutMs: 60_000, // a base window so generous that only the override can explain a fast kill
        perFileTimeoutMs: { [hung]: 2_000 },
        stdio: ["ignore", "ignore", "ignore"],
        cwd: ROOT,
      }),
      124,
      "the hung file must be killed and its exit reported",
    );
    // chrome-agent-platform-whl7d: the TIMING claim belongs to the hung file's OWN run. It used to be
    // measured across the whole batch, so it silently included the second file's deno COLD BOOT — and a
    // fixture with an instant body still takes 10-14s to boot on this box (measured), which redded
    // `elapsed < 20_000` at 22207ms in the 2026-10-22 fast gate while the override was working correctly.
    // A kill cannot be slowed down by boot (the bound starts at spawn), so this run is boot-proof.
    const started = Date.now();
    const killedRc = runSerialFiles([hung], {
      timeoutMs: 60_000,
      perFileTimeoutMs: { [hung]: 2_000 },
      stdio: ["ignore", "ignore", "ignore"],
      cwd: ROOT,
    });
    const elapsed = Date.now() - started;
    assertEquals(killedRc, 124, "the hung file alone is killed too");
    assert(
      elapsed < 20_000,
      `the per-file override (2s) must govern the listed file, not the 60s base — took ${elapsed}ms`,
    );
    // The unlisted file keeps the base window and passes (no override invented for it).
    assertEquals(
      runSerialFiles([fine], { timeoutMs: 60_000, perFileTimeoutMs: { [hung]: 2_000 }, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT }),
      0,
      "an unlisted file runs under the base window and passes",
    );
  } finally {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* ignore */ }
  }
});

