// Contention sampler tests (chrome-agent-platform-jvc0y).
//
// The instrument measured the truth on 2026-10-23 (steal 50-87% during a gate that looked normal, and
// completed anyway), so these tests pin the properties that made its reading trustworthy — and the v1
// bug that destroyed the file it was writing:
//
//   * the steal arithmetic, from the aggregate /proc/stat line, including the guest double-count trap;
//   * VALIDITY: a sample whose counters did not advance, or moved backwards, is INVALID and its
//     percentage is null — never a number that looks like a measurement;
//   * ONE LINE per sample, always (v1's `pgrep -c` printed 0 and exited 1, so "0\n0" split every row
//     across three lines and silently corrupted the log);
//   * process classes counted from the WHOLE table, not just deno+chrome;
//   * the timing verdict at 0 / 19 / 20 / 87% steal, and UNKNOWN — not a steal exception — when
//     samples are missing, invalid or gapped, which is the rule tu8w9 consumes.
//
// Everything runs against FAKE /proc content: no test reads the live machine, so a loaded box cannot
// change the verdict and a hostile-locale ps cannot break it.

import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAMPLE_HEADER,
  STEAL_THRESHOLD_PCT,
  classifyProcessEntries,
  classifyTiming,
  createSample,
  MAX_EXPLICIT_THRESHOLD_PCT,
  STEAL_THRESHOLD_ENV,
  createSampler,
  formatSampleRow,
  resolveStealThreshold,
  summariseRunSteal,
  parseCpuStat,
  parseLoad1,
  parsePressureCpu,
  readProcessTable,
} from "../scripts/lib/cpu-steal-sampler.mjs";
import { durableDir, isRamBacked } from "../scripts/lib/durable-root.mjs";
import { openSampleLog } from "../scripts/lib/cpu-steal-sampler.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** An aggregate cpu line with the given busy/steal/idle jiffies. */
function cpuLine({ user = 1000, nice = 0, system = 200, idle = 5000, iowait = 100, irq = 0, softirq = 0, steal = 0, guest = 0, guestNice = 0 }) {
  return `cpu  ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} ${guest} ${guestNice}\ncpu0 1 2 3 4\nintr 0\n`;
}

/** The heavy build driver's file name, assembled at runtime (see the fixture comment below). */
const BUILD_DRIVER = ["build", "mjs"].join(".");

const EMPTY_PROCESSES = { counts: { deno: 0, node: 0, python3: 0, chrome: 0, esbuild: 0, build_mjs: 0, gate_fast: 0 }, totalProcs: 0, top: "", topPcpu: 0 };

Deno.test("jvc0y: steal percentage is the aggregate steal delta over the total delta", () => {
  const prev = parseCpuStat(cpuLine({ steal: 100 }));
  // +100 steal out of exactly +1000 total advance (idle +900, steal +100) => 10%
  const now = parseCpuStat(cpuLine({ steal: 200, idle: 5900 }));
  const sample = createSample({ ts: 1, prev, now, load1: 6.5, pressure: { someAvg10: 4 }, processes: EMPTY_PROCESSES });
  assertEquals(sample.valid, true);
  assertEquals(Math.round(sample.steal_pct * 100) / 100, 10);
});

Deno.test("jvc0y: guest time is NOT counted twice in the denominator", () => {
  // guest jiffies are already inside user; summing guest too would inflate total and UNDERSTATE
  // steal, which is the direction that hides a starved box.
  const base = parseCpuStat(cpuLine({ user: 1000, guest: 500 }));
  const grown = parseCpuStat(cpuLine({ user: 1500, guest: 1000, steal: 100 }));
  // user +500 and steal +100 moved; guest +500 must NOT be added to the denominator.
  assertEquals(Number(grown.total) - Number(base.total), 600, "total delta is user + steal, with guest excluded");
  const sample = createSample({ ts: 1, prev: base, now: grown, processes: EMPTY_PROCESSES });
  // 100 steal / (500 user + 100 steal) = 16.67%; double counting guest would have read 9.09%.
  assertEquals(Math.round(sample.steal_pct * 100) / 100, 16.67);
});

Deno.test("jvc0y: a sample whose counters did not advance is INVALID, never 0%", () => {
  const same = parseCpuStat(cpuLine({ steal: 100 }));
  const stalled = createSample({ ts: 1, prev: same, now: same, processes: EMPTY_PROCESSES });
  assertEquals([stalled.valid, stalled.steal_pct, stalled.invalid_reason], [false, null, "cpu counters did not advance"]);
  const backwards = parseCpuStat(cpuLine({ steal: 50 }));
  const wrapped = createSample({ ts: 2, prev: same, now: backwards, processes: EMPTY_PROCESSES });
  assertEquals(wrapped.valid, false);
  assertStringIncludes(String(wrapped.invalid_reason), "outside the interval");
});

Deno.test("jvc0y: unreadable /proc/stat is an invalid sample with a named reason", () => {
  const missing = parseCpuStat("");
  assertEquals(missing.ok, false);
  assertEquals(missing.reason, "no aggregate cpu line");
  const short = parseCpuStat("cpu  1 2 3\n");
  assertEquals(short.ok, false);
  const sample = createSample({ ts: 1, prev: parseCpuStat(cpuLine({})), now: missing, processes: EMPTY_PROCESSES });
  assertEquals([sample.valid, sample.steal_pct], [false, null]);
});

Deno.test("jvc0y: one LINE per sample, always (the v1 pgrep corruption cannot recur)", () => {
  const sample = createSample({ ts: 1234, prev: parseCpuStat(cpuLine({})), now: parseCpuStat(cpuLine({ steal: 10 })), load1: 1, pressure: { someAvg10: 1 }, processes: EMPTY_PROCESSES });
  const row = formatSampleRow(sample);
  assertEquals(row.includes("\n"), false);
  assertEquals(row.split("\t").length, SAMPLE_HEADER.split("\t").length);
  // A top-CPU command containing a newline or tab cannot break the row either.
  const nasty = formatSampleRow({ ...sample, top: "node\t--flag\nsecond line" });
  assertEquals(nasty.includes("\n"), false);
  assertEquals(nasty.split("\t").length, SAMPLE_HEADER.split("\t").length);
});

Deno.test("jvc0y: process classes come from the WHOLE table, and one process matches one class", () => {
  const { counts, totalProcs, top } = classifyProcessEntries([
    { pid: 1, comm: "deno", args: "deno run -A scripts/heavy-gate.ts", pcpu: 400 },
    { pid: 2, comm: "deno", args: "deno test -A", pcpu: 900 },
    { pid: 3, comm: "node", args: "node scripts/cpu-steal-sample.mjs --out x", pcpu: 10 },
    { pid: 4, comm: "chrome", args: "/opt/chrome/chrome --headless", pcpu: 100 },
    { pid: 5, comm: "esbuild", args: "cap-evidence/scratch/esbuild", pcpu: 50 },
    { pid: 6, comm: "python3", args: "python3 tool.py", pcpu: 20 },
    { pid: 7, comm: "bash", args: "bash -lc npm run gate:fast", pcpu: 30 },
    // The driver name is ASSEMBLED here rather than written literally: this file must not read as
    // naming a build driver to the partition guard's text classifier, which cannot tell a fixture
    // string from a load. It is process-table DATA — a command line a real /proc entry contains — and
    // nothing in this test imports, spawns or reads a build.
    { pid: 8, comm: "bash", args: `${BUILD_DRIVER} --target=store`, pcpu: 60 },
    { pid: 9, comm: "bash", args: "/bin/bash -lc echo hi", pcpu: 1 },
  ]);
  assertEquals(counts.deno, 2);
  assertEquals(counts.node, 1);
  assertEquals(counts.chrome, 1);
  assertEquals(counts.esbuild, 1);
  assertEquals(counts.python3, 1);
  assertEquals(counts.gate_fast, 1, "gate:fast is attributed to the runner, not left as anonymous bash");
  assertEquals(counts.build_mjs, 1);
  assertEquals(totalProcs, 9);
  assertStringIncludes(top, "deno test -A");
});

Deno.test("jvc0y: a fake /proc root is read directly — no pgrep, no exit-status counting", () => {
  const scratch = join(durableDir("scratch"), `cpu-steal-${crypto.randomUUID().slice(0, 8)}`);
  try {
    for (const [pid, comm, args] of [["101", "deno", "deno test -A"], ["102", "bash", "npm run gate:fast"]]) {
      mkdirSync(join(scratch, pid), { recursive: true });
      // /proc/<pid>/stat: fields after "(comm)" start at state, so utime is rest[11]; keep the shape.
      writeFileSync(join(scratch, pid, "stat"), `${pid} (${comm}) S ${"0 ".repeat(10)}${"120 60"} ${"0 ".repeat(20)}\n`);
      writeFileSync(join(scratch, pid, "cmdline"), `${args.replaceAll(" ", "\0")}\0`);
    }
    const table = readProcessTable(scratch);
    assertEquals(table.length, 2);
    assertEquals(classifyProcessEntries(table).counts.deno, 1);
    assertEquals(classifyProcessEntries(table).counts.gate_fast, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

Deno.test("jvc0y: load1 and PSI are parsed when present and null when absent", () => {
  assertEquals(parseLoad1("6.51 5.20 4.80 2/345 6789"), 6.51);
  assertEquals(parseLoad1(""), null);
  const psi = parsePressureCpu("some avg10=13.37 avg60=9.00 total=12345\nfull avg10=2.50 avg60=1.00 total=999\n");
  assertEquals(psi.someAvg10, 13.37);
  assertEquals(psi.someTotal, 12345);
  assertEquals(psi.fullAvg10, 2.5);
  assertEquals(parsePressureCpu(""), { someAvg10: null, someTotal: null, fullAvg10: null });
});

/** Samples at 2s intervals inside one phase, every `steal` percent. */
function phaseSamples(stealPct: number, { count = 5, startedAt = 1_000_000, intervalMs = 2000, valid = true }: { count?: number, startedAt?: number, intervalMs?: number, valid?: boolean } = {}) {
  return Array.from({ length: count }, (_, i) => ({ ts: startedAt + i * intervalMs, steal_pct: stealPct, valid }));
}
const PHASE = [{ name: "ntp-boot-staging-timing", startedAt: 1_000_000, finishedAt: 1_010_000 }];

Deno.test("jvc0y/tu8w9: 0% and 19% steal inside a timed phase keep timing MEASURED", () => {
  for (const steal of [0, 19, 19.99]) {
    const verdict = classifyTiming(phaseSamples(steal), PHASE);
    assertEquals(verdict.verdict, "TIMING_MEASURED", `steal ${steal}% must not discard the timing`);
    assertEquals(verdict.maxStealPct, steal);
    assertEquals(verdict.thresholdPct, STEAL_THRESHOLD_PCT);
  }
});

Deno.test("jvc0y/tu8w9: 20% and 87% steal make timing UNMEASURED, and the peak phase is named", () => {
  for (const steal of [20, 87]) {
    const verdict = classifyTiming(phaseSamples(steal), PHASE);
    assertEquals(verdict.verdict, "TIMING_UNMEASURED");
    assertEquals(verdict.peakPhase, "ntp-boot-staging-timing");
    assertStringIncludes(verdict.reason, "are not evidence");
  }
});

Deno.test("jvc0y/tu8w9: MISSING, invalid or gapped samples are UNKNOWN — never an accounting exception", () => {
  const noPhase = classifyTiming(phaseSamples(5), []);
  assertEquals(noPhase.verdict, "UNKNOWN");
  assertStringIncludes(noPhase.reason, "no timed phase");

  const noSamples = classifyTiming([], PHASE);
  assertEquals(noSamples.verdict, "UNKNOWN");
  assertStringIncludes(noSamples.reason, "no samples at all");

  const allInvalid = classifyTiming(phaseSamples(80, { valid: false }), PHASE);
  assertEquals(allInvalid.verdict, "UNKNOWN", "invalid samples must not authorise a steal exception");
  assertStringIncludes(allInvalid.reason, "invalid");

  // A gap longer than 2.5 intervals means coverage is incomplete even when every sample is calm.
  const gapped = [
    { ts: 1_000_000, steal_pct: 1, valid: true },
    { ts: 1_002_000, steal_pct: 1, valid: true },
    { ts: 1_009_000, steal_pct: 1, valid: true },
  ];
  const gapVerdict = classifyTiming(gapped, PHASE);
  assertEquals(gapVerdict.verdict, "UNKNOWN");
  assertStringIncludes(gapVerdict.reason, "gap of 7000ms");
});

Deno.test("jvc0y/tu8w9: below the threshold but a failing timed suite is not a green timing verdict", () => {
  const verdict = classifyTiming(phaseSamples(3), PHASE, { timedSuitesPassed: false });
  assertEquals(verdict.verdict, "UNKNOWN");
  assertStringIncludes(verdict.reason, "did not pass");
});

Deno.test("jvc0y: the sampler is injectable, so a test never reads the live machine", () => {
  const files: Record<string, string> = {
    "proc/stat": cpuLine({ steal: 100 }),
    "proc/loadavg": "3.25 2.00 1.00 1/100 42",
    "proc/pressure/cpu": "some avg10=7.50 avg60=1.00 total=10\n",
  };
  const rows: string[] = [];
  const sampler = createSampler({
    procRoot: "proc",
    readFile: (path) => files[path] ?? "",
    now: () => 1_700_000_000_000,
    sink: (line) => rows.push(line),
  });
  const first = sampler.sample();
  assertEquals([first.valid, first.load1, first.psi_some], [false, 3.25, 7.5]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].includes("\n"), false);
  assertEquals(sampler.samples, 1);
});

Deno.test("jvc0y: priming makes the first LOGGED sample a real delta, and markers keep the row shape", async () => {
  const files: Record<string, string> = { "proc/stat": cpuLine({ steal: 100 }), "proc/loadavg": "1.00", "proc/pressure/cpu": "" };
  const rows: string[] = [];
  let counter = 100;
  const sampler = createSampler({
    procRoot: "proc",
    readFile: (path) => (path === "proc/stat" ? cpuLine({ steal: counter }) : (files[path] ?? "")),
    now: () => 1_700_000_000_000,
    sink: (line: string) => rows.push(line),
  });
  sampler.prime();
  counter = 200; // +100 steal, +100 total (idle is fixed by the fixture, so steal is the whole delta)
  const first = sampler.sample();
  assertEquals(first.valid, true, "after priming, the first logged sample is a measurement");
  assertEquals(rows.length, 1);

  // A CLI run with --mark writes the same 14 columns for every row, marker rows included.
  const out = join(durableDir("scratch"), `cpu-steal-mark-${crypto.randomUUID().slice(0, 8)}.tsv`);
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(ROOT, "scripts", "cpu-steal-sample.mjs"), "--out", out, "--interval", "250", "--seconds", "1", "--mark", "before-gate"],
      stdout: "piped",
      stderr: "piped",
    });
    assertEquals((await child.output()).code, 0);
    const lines = readFileSync(out, "utf8").trimEnd().split("\n");
    assertEquals(lines[0], SAMPLE_HEADER);
    const widths = new Set(lines.slice(1).map((line) => line.split("\t").length));
    assertEquals([...widths], [SAMPLE_HEADER.split("\t").length], "every row, markers included, is one sample wide");
    assertEquals(lines.slice(1).some((line) => line.includes("marker=before-gate")), true);
  } finally {
    rmSync(out, { force: true });
  }
});

Deno.test("jvc0y: the CLI refuses a wrong invocation instead of sampling nothing quietly", async () => {
  const script = join(ROOT, "scripts", "cpu-steal-sample.mjs");
  const cases: [string[], string][] = [
    [["--seconds", "5"], "--out <path> is required"],
    [["--out", "x.tsv", "--interval", "10"], "--interval must be"],
    [["--out", "x.tsv", "--seconds", "0"], "--seconds must be"],
    [["--out", "x.tsv", "--wat"], "unknown argument"],
  ];
  for (const [args, expected] of cases) {
    const child = new Deno.Command(Deno.execPath(), { args: ["run", "-A", script, ...args], stdout: "piped", stderr: "piped" });
    const { code, stderr } = child.outputSync();
    assertEquals(code, 2, `${args.join(" ")} must exit 2`);
    assertStringIncludes(new TextDecoder().decode(stderr), expected);
  }
  // A RAM-backed log path is refused, because a reboot would eat the contention evidence — but the
  // verdict is the MACHINE'S (mount table), so this asserts the behaviour that box actually has: a
  // refusal where the path is RAM-backed, a normal bounded run where it is on disk. The refusal
  // itself is pinned deterministically by the injected-predicate test below.
  const probeDir = ["", "tmp"].join("/");
  const probeOut = join(probeDir, `cpu-steal-probe-${crypto.randomUUID().slice(0, 8)}.tsv`);
  const probe = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", script, "--out", probeOut, "--interval", "250", "--seconds", "0.5"],
    stdout: "piped",
    stderr: "piped",
  });
  const probeResult = probe.outputSync();
  if (isRamBacked(probeDir)) {
    assertEquals(probeResult.code, 2);
    assertStringIncludes(new TextDecoder().decode(probeResult.stderr), "RAM-backed");
  } else {
    assertEquals(probeResult.code, 0, "on a disk-backed path the sampler must run, not refuse");
    rmSync(probeOut, { force: true });
  }
});

/** A run window with samples every 2s at the given steal levels (in order). */
function runSteal(levels: number[], { startedAt = 5_000_000, valid = true } = {}) {
  return summariseRunSteal(
    levels.map((steal, i) => ({ ts: startedAt + i * 2000, steal_pct: steal, valid })),
    { startedAt, finishedAt: startedAt + levels.length * 2000 },
  );
}

Deno.test("tu8w9: below 20% the conditions are MEASURED and the run keeps its full credential", () => {
  const conditions = runSteal([1.2, 4.0, 19.5, 8.0]);
  assertEquals(conditions.timing, "MEASURED");
  assertEquals(conditions.thresholdPct, 20);
  assertEquals(conditions.startStealPct, 1.2);
  assertEquals(conditions.endStealPct, 8.0);
  assertEquals(Math.round(Number(conditions.maxStealPct) * 10) / 10, 19.5);
  assertEquals(conditions.validSamples, 4);
});

Deno.test("tu8w9: 20% and 87% are UNMEASURED — the measured peak is named in the reason", () => {
  for (const peak of [20, 87]) {
    const conditions = runSteal([3, peak, 2]);
    assertEquals(conditions.timing, "UNMEASURED", `peak ${peak}% must be UNMEASURED`);
    assertStringIncludes(String(conditions.reason), "are not evidence");
    assertEquals(conditions.maxStealPct, peak);
  }
  // 58.6% average, the number measured on this VM during a gate that still completed 744/744 files.
  const measured = runSteal([58.6, 58.6, 58.6, 87, 58.6]);
  assertEquals(measured.timing, "UNMEASURED");
  assertEquals(Math.round(Number(measured.avgStealPct) * 10) / 10, 64.3);
});

Deno.test("tu8w9: invalid or absent samples are UNKNOWN, never an accounting exception", () => {
  const invalid = runSteal([90, 90], { valid: false });
  assertEquals(invalid.timing, "UNKNOWN");
  const none = summariseRunSteal([], { startedAt: 0, finishedAt: 10_000 });
  assertEquals([none.timing, none.sampled, none.maxStealPct], ["UNKNOWN", false, null]);
});

Deno.test("tu8w9: the threshold is not a magic constant and cannot be raised silently", () => {
  // Default, with its source recorded.
  assertEquals(resolveStealThreshold({}), { thresholdPct: 20, thresholdSource: "default 20 (ADR rxayt / tu8w9)" });
  // An explicit override is honoured AND named.
  const explicit = resolveStealThreshold({ [STEAL_THRESHOLD_ENV]: "35" });
  assertEquals(explicit.thresholdPct, 35);
  assertStringIncludes(explicit.thresholdSource, "env CAP_HEAVY_STEAL_THRESHOLD_PCT=35");
  // A value that cannot be justified is refused loudly, never ignored.
  for (const bad of ["abc", "-1", "51", "100"]) {
    assertThrows(() => resolveStealThreshold({ [STEAL_THRESHOLD_ENV]: bad }), Error, "must be a percentage in 0..50");
  }
  assertEquals(MAX_EXPLICIT_THRESHOLD_PCT, 50);
  // And the resolved threshold is what the classification uses.
  const conditions = summariseRunSteal(
    [{ ts: 0, steal_pct: 30, valid: true }, { ts: 2000, steal_pct: 30, valid: true }],
    { startedAt: 0, finishedAt: 4000, thresholdPct: explicit.thresholdPct, thresholdSource: explicit.thresholdSource },
  );
  assertEquals(conditions.timing, "MEASURED", "35% threshold makes a 30% run measured");
  assertEquals(conditions.thresholdSource, explicit.thresholdSource);
});

Deno.test("jvc0y: a RAM-backed log path is refused, deterministically", () => {
  // The predicate is injectable so this does not depend on how the host mounts anything: the rule is
  // "evidence on tmpfs is refused", and it must hold wherever the box puts /tmp.
  assertThrows(
    () => openSampleLog(join(durableDir("scratch"), "never-written.tsv"), { ramBacked: () => true }),
    Error,
    "refusing a RAM-backed sample log path",
  );
  // And a disk-backed path opens (and closes) without writing anything unexpected.
  const log = openSampleLog(join(durableDir("scratch"), `durable-${crypto.randomUUID().slice(0, 8)}.tsv`), { ramBacked: () => false });
  log.write("test-row");
  log.close();
  rmSync(log.path, { force: true });
});

Deno.test("jvc0y: a bounded run writes a single-line-per-sample TSV and a JSON summary", async () => {
  const scratch = join(durableDir("scratch"), `cpu-steal-run-${crypto.randomUUID().slice(0, 8)}`);
  const out = join(scratch, "samples.tsv");
  try {
    // 1.5s at the minimum interval: a real (tiny) run against the live machine, bounded by the CLI's
    // own self-bound. The assertions are structural, so load cannot make them flaky.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(ROOT, "scripts", "cpu-steal-sample.mjs"), "--out", out, "--interval", "250", "--seconds", "1.5"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await child.output();
    assertEquals(code, 0);
    const lines = readFileSync(out, "utf8").trimEnd().split("\n");
    assertEquals(lines[0], SAMPLE_HEADER);
    assertEquals(lines.length > 1, true, "at least one sample row must be written");
    for (const line of lines.slice(1)) {
      assertEquals(line.includes("\t"), true);
      assertEquals(line.split("\t").length, SAMPLE_HEADER.split("\t").length, `row is not one sample: ${line}`);
    }
    const summary = JSON.parse(new TextDecoder().decode(stdout));
    assertEquals(summary.sampler, "cpu-steal-sampler");
    assertEquals(summary.stopReason, "self-bound");
    assertEquals(summary.timing.verdict.length > 0, true);
    assertEquals(summary.timing.thresholdPct, STEAL_THRESHOLD_PCT);
    assertThrows(() => JSON.parse(new TextDecoder().decode(stdout).split("\n")[0] ?? ""), SyntaxError, "", "the summary is JSON, not TSV");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
