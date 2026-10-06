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
  const dir = await durableDir("86gg-serial-timeout");
  const hung = `${dir}/zz-hung-${Date.now()}.test.ts`;
  // The fixture must keep the event loop ALIVE *and* never finish. Two shapes
  // that are NOT hangs, measured while writing this test: a bare
  // `await new Promise(() => {})` (no pending I/O, so Deno exits by itself in
  // ~0.45s with code 1) and a non-awaiting test that starts an interval (the test
  // completes, so the runner reports success). Only a repeating timer INSIDE a
  // never-resolving async test holds the runner open — which is what the bound
  // must kill.
  await Deno.writeTextFile(
    hung,
    'Deno.test("hangs forever", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
  );
  const r = runSerialFile(hung, { timeoutMs: 2_000, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT });
  assertEquals(r.timedOut, true, "a file that never finishes must be killed");
  assertEquals(r.code, 124);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("cihz/86gg: the scaled bound is STRICTLY above the flat bound, and a kill happens only below the fixture's DECLARED work", async () => {
  // WHY THIS REPLACED THE OLD FORM (chrome-agent-platform-cihz): it used a 3.5s fixture, a 2s flat bound and a
  // 6s scaled bound, so the "survives" half left only ~2.5s for deno STARTUP — and at loadavg ~7 deno's own
  // startup ate it, flipping a real assertion on the box rather than on the code (measured: 3/5 fails at the
  // ia4z tip, 1/4 with main's runner, and 4/4 at loadavg ~7.2 including 2/2 on the pristine base).
  // The fix is to stop letting the clock decide: the fixture DECLARES its work, the flat bound sits BELOW that
  // declared work (so a kill is structural — the file cannot exit before its own timer), and the scaled bound
  // sits far enough ABOVE it that deno startup cannot consume the difference.
  const dir = await durableDir("cihz-scaled-bound");
  const SLOW_MS = 5_000; // the fixture's DECLARED work, asserted directly rather than inferred from elapsed time
  const FLAT_MS = 4_000; // strictly below SLOW_MS -> the kill cannot be a race with the box's load
  const slow = `${dir}/zz-cihz-slow-${Date.now()}.test.ts`;
  await Deno.writeTextFile(
    slow,
    `Deno.test("slow but progressing", async () => { await new Promise((r) => setTimeout(r, ${SLOW_MS})); });\n`,
  );
  try {
    // (1) THE CONTRACT, pure and clock-free: scaling must be STRICTLY greater than the flat bound, and it must
    // still be the documented formula. This is the assertion that fails if the scaling is removed.
    const scaled = serialFileTimeoutMs({ base: FLAT_MS, loadPerCpu: 3 });
    assertEquals(scaled, 12_000, "the scaled bound must remain base x loadPerCpu");
    assert(
      scaled > FLAT_MS,
      `the scaled bound must be STRICTLY greater than the flat bound (${scaled} vs ${FLAT_MS})`,
    );
    // (2) BELOW the declared work: a kill is STRUCTURAL. The fixture cannot exit before SLOW_MS, so any bound
    // under it kills on every run, at every load — there is nothing here for load to flip.
    const killed = runSerialFile(slow, { timeoutMs: FLAT_MS, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT });
    assertEquals(
      killed.timedOut,
      true,
      `a ${FLAT_MS}ms bound must kill a file that declares ${SLOW_MS}ms of work`,
    );
    assertEquals(killed.code, 124, "a killed file reports exit 124");
    // (3) ABOVE it: the same file finishes under the scaled bound, with SLOW_MS + deno startup <= scaled. The
    // 7s of headroom (12_000 - 5_000) is the load allowance that the old 6_000 - 3_500 = 2.5s did not have.
    const survived = runSerialFile(slow, { timeoutMs: scaled, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT });
    assertEquals(
      survived.timedOut,
      false,
      `the scaled bound (${scaled}ms) must let ${SLOW_MS}ms of declared work finish even with startup inside it`,
    );
    assertEquals(survived.code, 0, "the surviving file must exit cleanly");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── chrome-agent-platform-kj9s: per-file windows ──────────────────────────────
// A per-file bound exists for files whose cost is set by BUILD COUNT (build-bootstrap: 3 production
// builds; build-debug-mode: dev + store + a steady-state store). build-tool-bundling is NOT listed:
// measured 10s, so it stays on the base window. This pins that the map is CONSULTED for a listed file and that the
// base window still governs an unlisted one — the failure mode this must not have is "the override
// silently does nothing and the file is still killed by the base".
Deno.test("kj9s: a per-file bound overrides the base window for the files that need it, and only those", async () => {
  const dir = await durableDir("kj9s-per-file-bounds");
  const hung = `${dir}/zz-hung-perfile-${Date.now()}.test.ts`;
  const fine = `${dir}/zz-fine-perfile-${Date.now()}.test.ts`;
  await Deno.writeTextFile(
    hung,
    'Deno.test("hangs forever", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
  );
  await Deno.writeTextFile(
    fine,
    'Deno.test("finishes fast", () => { if (1 !== 1) throw new Error("unreachable"); });\n',
  );
  const started = Date.now();
  const rc = runSerialFiles([hung, fine], {
    timeoutMs: 60_000, // a base window so generous that only the override can explain a fast kill
    perFileTimeoutMs: { [hung]: 2_000 },
    stdio: ["ignore", "ignore", "ignore"],
    cwd: ROOT,
  });
  const elapsed = Date.now() - started;
  assertEquals(rc, 124, "the hung file must be killed and its exit reported");
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
  await Deno.remove(dir, { recursive: true });
});
