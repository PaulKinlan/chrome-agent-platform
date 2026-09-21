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

Deno.test("86gg: the SAME slow file is killed by the flat bound and survives the scaled one", async () => {
  // A file that does real work for ~3.5s. With a 2s flat bound it dies (the
  // false red the fleet was seeing); with the same file under 3x load the
  // default scales to 6s and it passes — which is the whole change.
  const dir = await durableDir("86gg-serial-timeout");
  const slow = `${dir}/zz-slow-${Date.now()}.test.ts`;
  await Deno.writeTextFile(
    slow,
    'Deno.test("slow but progressing", async () => { await new Promise((r) => setTimeout(r, 3500)); });\n',
  );
  const flat = runSerialFile(slow, { timeoutMs: 2_000, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT });
  assertEquals(flat.timedOut, true, "the flat bound kills a 3.5s file at a 2s bound");

  const scaled = serialFileTimeoutMs({ base: 2_000, loadPerCpu: 3 });
  assertEquals(scaled, 6_000);
  const survived = runSerialFile(slow, { timeoutMs: scaled, stdio: ["ignore", "ignore", "ignore"], cwd: ROOT });
  assertEquals(survived.timedOut, false, "the scaled bound lets the same file finish");
  assertEquals(survived.code, 0);
  await Deno.remove(dir, { recursive: true });
});
