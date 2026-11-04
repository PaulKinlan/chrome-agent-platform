// tests/quiet-window-steal.test.ts — chrome-agent-platform-fbg7i
//
// The steal half of the quiet-window contract. fbg7i measured WHY a wall-clock
// budget reddened on a "quiet" box: the hypervisor was taking 40-88% of the
// vCPU (steal), which load average never reports. The evidence, captured on
// the exe.dev VM while tests/ntp-boot-staging-timing.test.ts failed:
//   - CDP trace: RunTasks of 77-105 ms with ~0 ms of traced work inside, on
//     the extension renderer, the browser process AND the GPU compositor
//     simultaneously (a page defect cannot idle every process at once).
//   - /proc/stat steal delta: p50 74%, p90 81% during the failing boot.
//   - The long-task durations fit the math exactly: ~25-45 ms of real work
//     stretched by 1/(1-steal).
//
// These tests pin the signal and its failure modes. They are HERMETIC (fbg7i
// review P1-2, the 30429 defect class): every readLoadSample call here drives
// injected seams only — hasProc, loadavg, runPs, a frozen clock, and the
// probeStealPct capability seam — and never reads the real host, never sleeps
// on a real timer, never consults Date.now(), and never trusts an ambient
// CAP_QUIET_MAX_STEAL_PCT. The one exception is deliberate and is the point of
// its own test: hasProc:true + an always-null probe refuses BEFORE any real
// read (the probe runs first), so even that case touches nothing on disk.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  defaultProbeStealPct,
  environmentLine,
  isQuiet,
  parseHostCpuTicks,
  quietReasons,
  readLoadSample,
  resolveSpec,
  stealPctBetween,
  type LoadSample,
} from "../scripts/lib/quiet-window.ts";

const REALISTIC_STAT = `cpu  34007799 51144966 19826949 745167573 5038009 0 2357730 92809720 0 0
cpu0 4250974 6389370 2478368 93183446 629751 0 294716 11601215 0 0
intr 12345
`;
// steal=92809720; total = sum of fields 0..7 (guest fields 8/9 are EXCLUDED — P1-3)
const REAL_TOTAL = 34007799 + 51144966 + 19826949 + 745167573 + 5038009 + 0 + 2357730 + 92809720;
const REAL_STEAL = 92809720;

Deno.test("fbg7i: parseHostCpuTicks reads the aggregate cpu line (steal is field 8)", () => {
  const ticks = parseHostCpuTicks(REALISTIC_STAT);
  assertEquals(ticks, { total: REAL_TOTAL, steal: REAL_STEAL });
});

Deno.test("fbg7i review P1-3: guest and guest_nice are NOT double-counted into the steal denominator", () => {
  // user=100 nice=50 system=25 idle=800 iowait=5 irq=0 softirq=5 steal=15 -> total 1000.
  // guest=200 and guest_nice=100 are already accounted inside user/nice by the kernel;
  // a denominator that adds them again would read 1300 and understate steal.
  const ticks = parseHostCpuTicks("cpu  100 50 25 800 5 0 5 15 200 100\n");
  assertEquals(ticks, { total: 1000, steal: 15 }, "guest ticks must not widen the denominator");
});

Deno.test("fbg7i: parseHostCpuTicks returns null on a missing, short, or non-numeric line", () => {
  assertEquals(parseHostCpuTicks("no cpu line here\n"), null);
  assertEquals(parseHostCpuTicks("cpu  1 2 3\n"), null); // fewer than 8 fields
  assertEquals(parseHostCpuTicks("cpu  1 2 3 4 5 6 7 nope\n"), null);
  assertEquals(parseHostCpuTicks(""), null);
});

Deno.test("fbg7i: stealPctBetween computes the delta percentage and refuses unanswerable windows", () => {
  // 100 total ticks elapse, 40 of them stolen -> 40%
  assertEquals(stealPctBetween({ total: 1000, steal: 100 }, { total: 1100, steal: 140 }), 40);
  // Counter reset (steal went backwards) -> unanswerable, never a negative verdict
  assertEquals(stealPctBetween({ total: 1000, steal: 500 }, { total: 1100, steal: 100 }), null);
  // No elapsed ticks -> unanswerable
  assertEquals(stealPctBetween({ total: 1000, steal: 100 }, { total: 1000, steal: 150 }), null);
  // Missing side -> unanswerable
  assertEquals(stealPctBetween(null, { total: 1100, steal: 140 }), null);
  assertEquals(stealPctBetween({ total: 1000, steal: 100 }, null), null);
});

const STEAL_STAT_A = `cpu  100 0 0 900 0 0 0 0 0 0\n`;
const STEAL_STAT_B = `cpu  100 0 0 940 0 0 0 60 0 0\n`; // +100 total, +60 steal -> 60%

Deno.test("fbg7i: defaultProbeStealPct brackets the window with two reads; failures are null, never throws", async () => {
  const reads = [STEAL_STAT_A, STEAL_STAT_B];
  let slept = 0;
  const pct = await defaultProbeStealPct({
    readProcStat: () => Promise.resolve(reads.shift()!),
    sleep: (ms) => { slept = ms; return Promise.resolve(); },
  });
  assertEquals(pct, 60);
  assert(slept >= 20, `the window sleep ran (${slept}ms)`);

  // A failed read is null (unmeasurable), not a throw and not 0%. The caller on
  // a /proc host turns this null into a refusal — pinned two tests below.
  assertEquals(await defaultProbeStealPct({ readProcStat: () => Promise.reject(new Error("EIO")) }), null);
  // Malformed content is null too.
  assertEquals(await defaultProbeStealPct({ readProcStat: () => Promise.resolve("garbage\n") }), null);
});

Deno.test("fbg7i review P2: the probe window is CLAMPED to [20ms, 1000ms] — env narrows, never widens", async () => {
  const probe = async () => {
    const reads = [STEAL_STAT_A, STEAL_STAT_B];
    let slept = -1;
    const pct = await defaultProbeStealPct({
      readProcStat: () => Promise.resolve(reads.shift()!),
      sleep: (ms) => { slept = ms; return Promise.resolve(); },
    });
    return { pct, slept };
  };
  const before = Deno.env.get("CAP_QUIET_STEAL_WINDOW_MS");
  try {
    Deno.env.set("CAP_QUIET_STEAL_WINDOW_MS", "999999");
    const wide = await probe();
    assertEquals(wide.slept, 1000, "a 999999ms ask clamps to the 1000ms ceiling — a probe can never outlast the wait it serves");
    assertEquals(wide.pct, 60);
    Deno.env.set("CAP_QUIET_STEAL_WINDOW_MS", "1");
    const narrow = await probe();
    assertEquals(narrow.slept, 20, "a 1ms ask clamps to the 20ms floor");
    Deno.env.set("CAP_QUIET_STEAL_WINDOW_MS", "55");
    const normal = await probe();
    assertEquals(normal.slept, 55, "inside the clamp the env is honored");
  } finally {
    if (before === undefined) Deno.env.delete("CAP_QUIET_STEAL_WINDOW_MS");
    else Deno.env.set("CAP_QUIET_STEAL_WINDOW_MS", before);
  }
});

// ── readLoadSample integration — injected seams only (review P1-2) ─────────
// One ordinary deno row; the ps-table shape the no-/proc branch parses.
const SCAN_ROWS = "  201 00:00.10 Wed Oct  7 12:26:48 2026 deno";

function hermeticDeps(stealPct: number | null) {
  return {
    hasProc: false, // no /proc walk, no /proc/loadavg — nothing real
    now: () => 0, // frozen clock, never Date.now()
    loadavg: () => [0.5, 0.5, 0.5],
    runPs: () => Promise.resolve({ code: 0, stdout: SCAN_ROWS }),
    probeStealPct: () => Promise.resolve(stealPct),
  };
}

Deno.test("fbg7i: readLoadSample carries an injected probe's stealPct onto the sample (hermetic)", async () => {
  const s = await readLoadSample(null, hermeticDeps(57.5));
  assertEquals(s.measurable, true, `injected seams measure: ${s.error ?? ""}`);
  assertEquals(s.stealPct, 57.5);
  assertEquals(s.load1, 0.5, "the injected loadavg is what the sample reports");
  const s2 = await readLoadSample(null, hermeticDeps(0));
  assertEquals(s2.stealPct, 0, "a measured 0% is a measurement, not a null");
});

Deno.test("fbg7i review P1-1: on a /proc host an unmeasurable steal probe REFUSES the sample (fail closed)", async () => {
  // hasProc:true + an always-null probe. The probe runs BEFORE loadavg or the
  // walk, so this hermetic case reads nothing real even on a Linux box — the
  // early refusal is exactly what is being pinned.
  for (const nullProbe of [
    () => Promise.resolve(null),
    () => Promise.reject(new Error("EIO")),
  ]) {
    const s = await readLoadSample(null, { hasProc: true, probeStealPct: nullProbe });
    assertEquals(s.measurable, false, "Linux + unmeasurable steal must refuse, not certify quiet");
    assertStringIncludes(s.error ?? "", "steal unmeasurable");
    assertStringIncludes(s.error ?? "", "fbg7i");
  }
});

Deno.test("fbg7i review P1-1: the no-/proc default probe is legitimately null — macOS keeps its prior behaviour", async () => {
  // No probe injected on the no-/proc branch: the default is the null probe,
  // the sample stays measurable, and stealPct null is the documented
  // no-signal shape — not a failure, not a verdict.
  const s = await readLoadSample(null, {
    hasProc: false,
    now: () => 0,
    loadavg: () => [0.5, 0.5, 0.5],
    runPs: () => Promise.resolve({ code: 0, stdout: SCAN_ROWS }),
  });
  assertEquals(s.measurable, true, `no-/proc default measures: ${s.error ?? ""}`);
  assertEquals(s.stealPct, null);
  assertEquals(isQuiet(s, resolveSpec({ maxStealPct: 10 })), true, "a macOS sample without a steal signal is judged by load alone");
});

// ── the verdict surface ─────────────────────────────────────────────────────
function sampleWith(stealPct: number | null | undefined): LoadSample {
  return {
    at: 0, // frozen — no Date.now() (review P1-2)
    load1: 0.1,
    load5: 0.1,
    load15: 0.1,
    cores: 8,
    loadPerCore: 0.0125,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
    measurable: true,
    stealPct,
  };
}

Deno.test("fbg7i: quietReasons names steal above the bound; at/below the bound and null stay quiet", () => {
  const spec = resolveSpec({ maxStealPct: 10 });

  const stolen = quietReasons(sampleWith(62), spec);
  assertEquals(stolen.length, 1);
  assertStringIncludes(stolen[0], "host CPU steal 62% > 10%");
  assertStringIncludes(stolen[0], "fbg7i");
  assertEquals(isQuiet(sampleWith(62), spec), false);

  // The boundary is inclusive-quiet: exactly AT the bound does not refuse.
  assertEquals(quietReasons(sampleWith(10), spec), []);
  assertEquals(quietReasons(sampleWith(3), spec), []);

  // null (the no-/proc no-signal shape) and undefined (hand-built sample) are
  // NOT verdicts in either direction. On Linux a null probe can no longer
  // reach this point — the sample is unmeasurable before quietReasons runs
  // (pinned in the P1-1 test above).
  assertEquals(quietReasons(sampleWith(null), spec), []);
  assertEquals(quietReasons(sampleWith(undefined), spec), []);
});

Deno.test("fbg7i: resolveSpec defaults the steal bound to 10% and honors an explicit spec (no ambient env)", () => {
  const before = Deno.env.get("CAP_QUIET_MAX_STEAL_PCT");
  Deno.env.delete("CAP_QUIET_MAX_STEAL_PCT"); // never trust an ambient setting (review P1-2)
  try {
    assertEquals(resolveSpec({}).maxStealPct, 10);
    assertEquals(resolveSpec({ maxStealPct: 25 }).maxStealPct, 25);
    Deno.env.set("CAP_QUIET_MAX_STEAL_PCT", "33");
    assertEquals(resolveSpec({}).maxStealPct, 33, "the env var is the operator override");
  } finally {
    if (before === undefined) Deno.env.delete("CAP_QUIET_MAX_STEAL_PCT");
    else Deno.env.set("CAP_QUIET_MAX_STEAL_PCT", before);
  }
});

Deno.test("fbg7i: environmentLine reports steal when measured and omits it when not", () => {
  assertStringIncludes(environmentLine(sampleWith(42)), "steal=42%");
  assert(!environmentLine(sampleWith(null)).includes("steal="), "null steal prints no steal field");
});
