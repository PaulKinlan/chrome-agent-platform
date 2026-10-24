// tests/serial-window-steal.test.ts — chrome-agent-platform-8qy5d.
//
// The binding-constraint evidence that decided this file (merger gate attempt 2
// on union 44ae8c6a1, 2026-10-24T03:29-03:49Z): tests/reachability.test.ts was
// killed at its per-file 180s bound (exit 124 at 180.5s) while the box measured
// 64.7% AVERAGE hypervisor steal (>=20% in 719/720 samples, peak 94%), and the
// gate log contained ZERO "serial timeout scaled" lines — the load-based
// scaling of chrome-agent-platform-86gg never engaged, because steal
// deschedules vCPUs WITHOUT raising the guest loadavg that currentLoadPerCpu()
// reads. Because a serial failure skips the parallel phase by design (w6kc0),
// 703 of 751 parallel files never ran.
//
// Three properties are pinned here, per the coord mandate:
//   1. the window is steal-aware (a starved box scales, a quiet one does not);
//   2. the decision is sampled AT THE WAIT, per file, never once per run;
//   3. EVERY measured decision is logged — the silence of the old not-scaled
//      path is what cost the whole night, so "not scaled" now PRINTS its
//      measured load and steal instead of saying nothing.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  DEFAULT_SERIAL_FILE_TIMEOUT_MS,
  MAX_LOAD_SCALE,
  STEAL_DEAD_BAND,
  STEAL_SAMPLE_MS,
  currentStealFractionSync,
  resolveSerialFileWindow,
  runSerialFiles,
  serialFileTimeoutMs,
  serialWindowDecisionLine,
  stealFractionFromStatSamples,
  stealJiffiesFromStatLine,
  stealScaleComponent,
} from "../scripts/lib/serial-phase.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── 1. The scale arithmetic: a starved box scales, a quiet one does not ──────

Deno.test("8qy5d: steal below the dead band, zero and unmeasurable scale nothing", () => {
  assertEquals(stealScaleComponent(null), 1, "unmeasurable steal must not scale (the decision line says so instead)");
  assertEquals(stealScaleComponent(Number.NaN), 1);
  assertEquals(stealScaleComponent(0), 1, "a genuinely quiet box must get exactly the base window");
  assertEquals(stealScaleComponent(0.005), 1);
  assertEquals(stealScaleComponent(STEAL_DEAD_BAND), 1, "the dead band itself is noise: no scaling");
  assertEquals(stealScaleComponent(0.0201), 1 / (1 - 0.0201), "just above the dead band the compensation begins");
});

Deno.test("8qy5d: the merger's measured starvation scales the window to base/(1-S)", () => {
  // 64.7% steal -> the child gets ~35% of the CPU -> base-sized work takes
  // base/0.353 of wall clock. This is the honest compensation; a tuned factor
  // would be a magic number. 180s / 0.353 = 509.9s, inside the x4 ceiling —
  // i.e. THIS scaling, engaged at the wait, would have saved the killed run
  // (the file needed ~180.5s; 509.9s covers it with room).
  const S = 0.647;
  assertEquals(stealScaleComponent(S), 1 / (1 - S));
  assertEquals(
    serialFileTimeoutMs({ loadPerCpu: 0.25, steal: S }),
    Math.round(DEFAULT_SERIAL_FILE_TIMEOUT_MS / (1 - S)),
    "starvation must scale the window even while loadavg reads IDLE — that is the failure mode that killed the night",
  );
  assert(
    serialFileTimeoutMs({ loadPerCpu: 0.25, steal: S }) > 180.5 * 1000,
    "the scaled window must exceed the 180.5s the merger's run died at",
  );
});

Deno.test("8qy5d: extreme steal clamps at the same x4 ceiling (the bound still bounds)", () => {
  assertEquals(stealScaleComponent(0.99), MAX_LOAD_SCALE);
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 0.25, steal: 0.99 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS * MAX_LOAD_SCALE);
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 0.25, steal: 1.5 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS * MAX_LOAD_SCALE);
});

Deno.test("8qy5d: more steal never means less time, and steal never SHRINKS a loaded window", () => {
  let previous = 0;
  for (const steal of [0, 0.02, 0.1, 0.3, 0.5, 0.647, 0.8, 0.95, 1.2]) {
    const ms = serialFileTimeoutMs({ loadPerCpu: 0.25, steal });
    assert(ms >= previous, `steal ${steal} produced ${ms}ms, below the previous ${previous}ms`);
    previous = ms;
  }
  assertEquals(
    serialFileTimeoutMs({ loadPerCpu: 3, steal: 0.5 }),
    DEFAULT_SERIAL_FILE_TIMEOUT_MS * 3,
    "load and steal take the MAX, not the product: steal must never reduce what loadavg already earned",
  );
});

Deno.test("8qy5d: the pre-existing 86gg load-only semantics are unchanged when steal is not given", () => {
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 1 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS);
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 2 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS * 2);
  assertEquals(serialFileTimeoutMs({ loadPerCpu: 0.25 }), DEFAULT_SERIAL_FILE_TIMEOUT_MS, "loadavg alone at an idle reading still floors at x1");
});

// ── 2. The /proc/stat parser: exact, and null on anything unmeasurable ──────

Deno.test("8qy5d: the steal fraction from two /proc/stat snapshots is dSteal/dTotal over the first 8 fields", () => {
  // user nice system idle iowait irq softirq STEAL guest guest_nice
  const a = stealJiffiesFromStatLine("cpu  1000 0 500 80000 100 0 200 300 50 50\ncpu0 100 0 50 8000 10 0 20 30 5 5\n");
  const b = stealJiffiesFromStatLine("cpu  2000 0 900 160000 200 0 300 900 50 50\n");
  assertEquals(a, { steal: 300, total: 1000 + 0 + 500 + 80000 + 100 + 0 + 200 + 300 });
  const fraction = stealFractionFromStatSamples(a, b);
  // dSteal = 900 - 300 = 600; dTotal = 164300 - 82100 = 82200
  assertEquals(fraction, 600 / 82200);
  // guest/guest_nice excluded from the total: the kernel counts guest inside user,
  // so including them would double-count and dilute the fraction.
  assertEquals(stealFractionFromStatSamples(a, b), 600 / (164300 - 82100));
});

Deno.test("8qy5d: unmeasurable counter states yield null, never a guess", () => {
  const a = stealJiffiesFromStatLine("cpu  100 0 50 800 10 0 20 30 5 5");
  assertEquals(stealFractionFromStatSamples(null, a), null, "a missing first sample is unmeasurable");
  assertEquals(stealFractionFromStatSamples(a, a), null, "a zero-delta window is unmeasurable");
  const reset = stealJiffiesFromStatLine("cpu  10 0 5 80 1 0 2 3 0 0");
  assertEquals(stealFractionFromStatSamples(a, reset), null, "counters that went backwards (fresh boot) are unmeasurable");
  assertEquals(stealJiffiesFromStatLine("intr 123456"), null, "not the aggregate cpu line");
  assertEquals(stealJiffiesFromStatLine("cpu  1 2 3"), null, "fewer than 8 fields cannot yield a steal reading");
  assertEquals(stealJiffiesFromStatLine(""), null);
  assertEquals(stealJiffiesFromStatLine(undefined), null);
});

// ── 3. The sampler: two reads bracketing a bounded wait, at the call site ────

Deno.test("8qy5d: currentStealFractionSync samples /proc/stat twice around a bounded wait", () => {
  const reads = [
    "cpu  100 0 50 800 10 0 20 30 5 5",
    "cpu  200 0 90 1600 20 0 30 90 5 5",
  ];
  let calls = 0;
  const sleeps: number[] = [];
  const steal = currentStealFractionSync({
    readFile: (() => reads[calls++] ?? "") as unknown as typeof readFileSync,
    sleepSync: (ms: number) => sleeps.push(ms),
  });
  assertEquals(calls, 2, "exactly two /proc/stat reads bracket the window");
  assertEquals(sleeps, [STEAL_SAMPLE_MS], "the wait is the declared sample window");
  assertEquals(steal, 60 / 1020, "dSteal=60 over dTotal=2030-1010=1020");
});

Deno.test("8qy5d: an unreadable /proc/stat (non-Linux, sandboxed) yields null — unmeasurable, not zero", () => {
  const steal = currentStealFractionSync({
    readFile: () => {
      throw new Error("ENOENT");
    },
    sleepSync: () => {},
  });
  assertEquals(steal, null);
});

// ── 4. The decision line: the log whose absence cost the night ───────────────

Deno.test("8qy5d: a starved decision logs the scaled window WITH the measured numbers", () => {
  const ms = serialFileTimeoutMs({ loadPerCpu: 0.25, steal: 0.647 });
  const line = serialWindowDecisionLine({ file: "tests/reachability.test.ts", loadPerCpu: 0.25, steal: 0.647, ms });
  assertStringIncludes(line, "serial timeout scaled to");
  assertStringIncludes(line, "tests/reachability.test.ts");
  assertStringIncludes(line, "steal 64.7%");
  assertStringIncludes(line, "load 0.25 per CPU");
  assertStringIncludes(line, "at the wait");
  assertStringIncludes(line, `ceiling x${MAX_LOAD_SCALE}`);
});

Deno.test("8qy5d: a quiet decision logs NOT SCALED and still names the measurements", () => {
  const line = serialWindowDecisionLine({ file: "tests/x.test.ts", loadPerCpu: 0.31, steal: 0.004, ms: DEFAULT_SERIAL_FILE_TIMEOUT_MS });
  assertStringIncludes(line, "not scaled");
  assertStringIncludes(line, "180s");
  assertStringIncludes(line, "steal 0.4%");
  assertStringIncludes(line, "load 0.31 per CPU");
  assertStringIncludes(line, "at the wait");
});

Deno.test("8qy5d: an unmeasurable steal is SAID, not silently treated as zero", () => {
  const line = serialWindowDecisionLine({ file: "tests/x.test.ts", loadPerCpu: 0.31, steal: null, ms: DEFAULT_SERIAL_FILE_TIMEOUT_MS });
  assertStringIncludes(line, "steal unmeasurable", "the reader of a dead run must know the signal was missing, not fine");
});

Deno.test("8qy5d: an operator override is logged as the operator's unscaled number", () => {
  const line = serialWindowDecisionLine({ file: "tests/x.test.ts", loadPerCpu: 4, steal: 0.9, override: "90000", ms: 90000 });
  assertStringIncludes(line, "operator override CAP_SERIAL_TEST_TIMEOUT_MS");
  assertStringIncludes(line, "unscaled");
});

Deno.test("8qy5d: resolveSerialFileWindow classifies the three sources of a window", () => {
  assertEquals(resolveSerialFileWindow({ loadPerCpu: 0.25, steal: 0 }), { ms: DEFAULT_SERIAL_FILE_TIMEOUT_MS, scaled: false, override: false });
  const starved = resolveSerialFileWindow({ loadPerCpu: 0.25, steal: 0.647 });
  assertEquals(starved.scaled, true);
  assertEquals(starved.override, false);
  const overridden = resolveSerialFileWindow({ loadPerCpu: 0.25, steal: 0.647, override: "30000" });
  assertEquals(overridden, { ms: 30000, scaled: false, override: true });
});

// ── 5. The real path: runSerialFiles measures per file at the wait and LOGS ──

Deno.test("8qy5d: the real serial phase prints one measured decision line per file", async () => {
  // Two instant PASSING fixtures, no table entry, no explicit timeoutMs: the
  // measured branch must fire PER FILE against the real /proc/stat of this
  // machine and print its decision either way. This is the property the
  // merger's dead run did not have: whatever the box was doing, the gate log
  // names the measured load and steal for every serial file it bounded.
  const dir = await durableDir("8qy5d-steal-window", `${process.pid}-${Date.now()}`);
  const fixtures = [`${dir}/zz-steal-a-${process.pid}.test.ts`, `${dir}/zz-steal-b-${process.pid}.test.ts`];
  try {
    for (const f of fixtures) {
      await Deno.writeTextFile(f, `Deno.test("8qy5d fixture passes instantly", () => {});\n`);
    }
    const driver = `${dir}/zz-steal-driver-${process.pid}.mjs`;
    await Deno.writeTextFile(
      driver,
      `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
        `const rc = runSerialFiles(process.argv.slice(2), {\n` +
        `  stdio: "pipe",\n  cwd: ${JSON.stringify(ROOT)},\n  perFileTimeoutMs: {},\n});\n` +
        `console.log("STEAL_DRIVER_RC=" + rc);\n`,
    );
    const { code, stdout, stderr } = await new Deno.Command("node", {
      args: [driver, ...fixtures],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assertEquals(code, 0, `the fixtures must pass:\n${out}`);
    for (const f of fixtures) {
      const lines = out.split("\n").filter((l) => l.includes(f) && (l.includes("serial window") || l.includes("serial timeout scaled")));
      assertEquals(
        lines.length,
        1,
        `exactly one measured decision line for ${f} (per-file sampling, not once per run):\n${out}`,
      );
      assertStringIncludes(lines[0], "at the wait", `the decision line must name when the measurement happened:\n${out}`);
      assert(
        /steal \d+\.\d+%|steal unmeasurable/.test(lines[0]),
        `the decision line must carry the measured steal or say it was unmeasurable:\n${out}`,
      );
    }
    assert(
      out.includes("STEAL_DRIVER_RC=0"),
      `the driver must report success:\n${out}`,
    );
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
});
