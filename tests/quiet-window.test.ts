// tests/quiet-window.test.ts — chrome-agent-platform-mkax
//
// A load-sensitive gate has THREE possible outcomes, and the whole point of
// this bead is that they stay distinguishable:
//   0  — it ran and the tree passed;
//   1  — it ran and the tree failed (a product red);
//   75 — it REFUSED to run because the box was not quiet (environmental).
// eo4d.1's history is why: 59/370 and 250/370 then `cdp timeout:
// Runtime.evaluate` at machine load >7 from other lanes' builds, and 370/370
// only in a quiet window. Those reds said nothing about the tree, and nothing
// in the repo could tell them apart from a real failure.
//
// The machine-wide Chrome lock never prevented them (it excluded other CAP
// browsers, not other lanes' rustc/esbuild), so the fix is a measurement with
// an honest verdict — and it must FAIL CLOSED: an unmeasurable box is never
// assumed quiet.
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  awaitQuietWindow,
  classifyActiveBuilders,
  classifyEvaluateTimeout,
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  environmentLine,
  evaluateTimeoutReport,
  HEAVY_PROCESS_NAMES,
  isCdpEvaluateTimeout,
  isQuiet,
  measureEvaluateTimeout,
  parseProcStatCpu,
  QuietWindowRefusedError,
  quietReasons,
  readLoadSample,
  resolveSpec,
  type LoadSample,
} from "../scripts/lib/quiet-window.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sample(over: Partial<LoadSample> = {}): LoadSample {
  return {
    at: Date.now(),
    load1: 1, load5: 1, load15: 1,
    cores: 32, loadPerCore: 1 / 32,
    compilers: 0, compilerNames: [],
    measurable: true,
    ...over,
  };
}

const SPEC = { maxLoadPerCore: 0.35, maxCompilers: 1, maxWaitMs: 1000, sampleMs: 50, sustainedSamples: 3 };

/** The real esbuild binary (not the .bin shim), so a spawned burner is a REAL
 *  compiler whose /proc comm is `esbuild`. Discovered rather than pinned to one
 *  platform directory: a pin names one machine's layout (chrome-agent-platform-icf1). */
export async function realEsbuildBinary(): Promise<string> {
  for await (const entry of Deno.readDir(`${ROOT}node_modules/@esbuild`)) {
    if (!entry.isDirectory) continue;
    const candidate = `${ROOT}node_modules/@esbuild/${entry.name}/bin/esbuild`;
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch { /* try the next platform */ }
  }
  throw new Error("no esbuild binary under node_modules/@esbuild/*/bin — the real-compiler fixtures cannot run");
}

/** A synthetic module for a real compile to burn CPU on. */
async function writeBurnerInput(path: string, lines: number): Promise<void> {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) parts.push(`export const v${i} = ${i} * 3 + Math.sqrt(${i}); // padding padding padding padding\n`);
  await Deno.writeTextFile(path, parts.join(""));
}

/** A burner input SIZED ON THIS BOX so that ONE compile outlasts `targetMs`.
 *
 *  Why calibration instead of a constant: the first version of these tests used
 *  a fixed ~35 MB input, which takes ~1.7 s on the author's machine and would
 *  finish inside a single sample on a faster one — so the sampler test asserted
 *  about a process that had already exited and the journey-gate test found a
 *  quiet window between two short compiles. Both failed ON THE REVIEWER'S BOX
 *  and passed on mine, with no difference in intention: the tests were measuring
 *  the machine as well as the code. The workload is now measured first and
 *  scaled until it covers the bound, so the fixture no longer depends on how
 *  fast the box compiles. Do NOT replace this with a constant size.
 *
 *  Returns the input path and one measured compile duration at that size. */
async function calibratedBurner(dir: string, targetMs: number): Promise<{ input: string; compileMs: number; lines: number }> {
  const bin = await realEsbuildBinary();
  const input = `${dir}/burner.js`;
  let lines = 100_000; // ~9 MB: a cheap first probe
  let compileMs = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    await writeBurnerInput(input, lines);
    const t0 = Date.now();
    const probe = new Deno.Command(bin, {
      args: [input, "--minify", `--outfile=${dir}/burner.min.js`, "--log-level=error"],
      stdout: "null", stderr: "null",
    }).spawn();
    await probe.status;
    compileMs = Date.now() - t0;
    if (compileMs >= targetMs) break;
    // Scale by the measured shortfall, bounded so a pathologically fast box
    // cannot ask for an input it cannot write.
    const scale = Math.min(10, Math.max(2, targetMs / Math.max(1, compileMs)));
    lines = Math.min(3_000_000, Math.round(lines * scale));
  }
  return { input, compileMs, lines };
}

/** Start ONE real compile of a calibrated input — a single long-lived pid, which
 *  is what lets the sampler test assert about the pid IT created. */
async function startCalibratedCompiler(dir: string, targetMs: number): Promise<{ proc: Deno.ChildProcess; pid: number; input: string; compileMs: number }> {
  const { input, compileMs } = await calibratedBurner(dir, targetMs);
  const bin = await realEsbuildBinary();
  const proc = new Deno.Command(bin, {
    args: [input, "--minify", `--outfile=${dir}/burner.run.min.js`, "--log-level=error"],
    stdout: "null", stderr: "null",
  }).spawn();
  return { proc, pid: proc.pid, input, compileMs };
}

Deno.test("dnop: a PARKED heavy-named daemon is not a build; a COMPILING one still is", async () => {
  // The measured defect: three esbuild SERVICE daemons (ages 1d14h, 2d00h,
  // 3d02h, CPU flat across a 10 s sample while load/core sat at 0.056) held the
  // journey gate closed on an idle box. The name match stays as evidence; the
  // THRESHOLD counts activity.
  const parked = sample({ compilers: 3, compilerNames: ["esbuild"], activeCompilers: 0, activeCompilerNames: [] });
  assertEquals(isQuiet(parked, resolveSpec(SPEC)), true, "three parked daemons are not a reason to wait");
  const parkedLine = environmentLine(parked, resolveSpec(SPEC));
  assert(parkedLine.includes("heavy-builders=3 active=0"), parkedLine);

  const compiling = sample({ compilers: 2, compilerNames: ["esbuild"], activeCompilers: 2, activeCompilerNames: ["esbuild"] });
  const reasons = quietReasons(compiling, resolveSpec(SPEC));
  assertEquals(reasons.length, 1, JSON.stringify(reasons));
  assert(reasons[0].includes("active heavy-builders 2"), reasons[0]);
  assert(reasons[0].includes("compiling: esbuild"), reasons[0]);
  const verdict = await awaitQuietWindow(
    { ...SPEC, maxWaitMs: 120 },
    { sample: async () => compiling, sleep: async () => {}, notice: () => {} },
  );
  assertEquals(verdict.ok, false, "a compiling process still refuses the gate inside its bound");

  // Fail closed: a sample that cannot say whether the name matches are compiling
  // (hand-built, or an older caller) falls back to the name match.
  assertEquals(isQuiet(sample({ compilers: 4, compilerNames: ["rustc"] }), resolveSpec(SPEC)), false);
});

Deno.test("dnop: activity is decided by CPU advance, and an unknown process fails closed", () => {
  const mk = (name: string, startTicks: string, cpuTicks: number) => ({ name, startTicks, cpuTicks });
  const prev = new Map([
    ["11", mk("esbuild", "100", 500)],   // will advance → active
    ["12", mk("rustc", "200", 40)],      // flat → idle
    ["13", mk("cargo", "300", 7)],       // pid reused (new start time) → active
  ]);
  const curr = new Map([
    ["11", mk("esbuild", "100", 520)],
    ["12", mk("rustc", "200", 40)],
    ["13", mk("cargo", "999", 9000)],
    ["14", mk("ninja", "400", 0)],       // never seen before → active (fail closed)
  ]);
  assertEquals(classifyActiveBuilders(prev, curr).sort(), ["11", "13", "14"]);
  // A first sample (no previous reading) treats every name match as active.
  assertEquals(classifyActiveBuilders(null, curr).sort(), ["11", "12", "13", "14"]);
});

Deno.test("dnop: /proc/<pid>/stat parsing survives a comm with spaces and parentheses", () => {
  // The bracketed comm may contain anything, so the parse starts after the LAST
  // ')': field 3 is then index 0 and utime/stime/starttime are 11/12/19. A
  // misparse here would classify every build as idle — the same defect again,
  // in the arithmetic instead of the name.
  const stat = "4242 (esbuild (vite)) S 1 4242 4242 0 -1 4194304 0 0 0 0 120 40 0 0 20 0 1 0 98765 0 0";
  const parsed = parseProcStatCpu(stat, "esbuild");
  assertEquals(parsed?.cpuTicks, 160);
  assertEquals(parsed?.startTicks, "98765");
  assertEquals(parsed?.name, "esbuild");
  assertEquals(parseProcStatCpu("garbage"), null);
});

Deno.test("dnop: the REAL sampler counts this test's compiling process and not its parked ones", async () => {
  // Ambient state is never assumed: every assertion names a pid THIS test
  // created, so another lane's build cannot make it pass or fail (p15i).
  const dir = await Deno.makeTempDir({ prefix: "cap-dnop-procs-" });
  const parked: Deno.ChildProcess[] = [];
  let compiler: Deno.ChildProcess | null = null;
  try {
    for (const n of ["rustc", "esbuild", "cargo"]) {
      await Deno.copyFile("/bin/sleep", `${dir}/${n}`);
      parked.push(new Deno.Command(`${dir}/${n}`, { args: ["30"], stdout: "null", stderr: "null" }).spawn());
    }
    await new Promise((r) => setTimeout(r, 500));
    const first = await readLoadSample();
    await new Promise((r) => setTimeout(r, 400));
    const second = await readLoadSample(first.cpu ?? null);
    assert(second.compilers >= 3, `the parked name matches are still counted as evidence: ${JSON.stringify(second.compilerNames)}`);
    const parkedPids = new Set(parked.map((p) => String(p.pid)));
    const parkedActive = classifyActiveBuilders(first.cpu, second.cpu).filter((pid) => parkedPids.has(pid));
    assertEquals(parkedActive, [], "the parked daemons this test started must NOT count as compiling");

    // Now a REAL compile, and the only process this test asserts about is the one
    // it started: a calibrated input keeps it running for SECONDS on any box, so
    // both samples below land inside the compile whatever the machine's speed.
    // (The previous fixed-size version was tuned to one box — see
    // calibratedBurner's comment; do not reintroduce a constant here.)
    const started = await startCalibratedCompiler(dir, 4000);
    compiler = started.proc;
    // Portability is ASSERTED, not assumed: the fixture proves on this box that
    // its workload outlasts the window the test needs, so a fast machine widens
    // the input instead of shrinking the measurement.
    assert(
      started.compileMs >= 4000,
      `the burner must outlast the sampling window on THIS box (calibrated to ${started.compileMs} ms); if this fails, the calibration could not scale the input far enough`,
    );
    await new Promise((r) => setTimeout(r, 250));
    const before = await readLoadSample(second.cpu ?? null);
    await new Promise((r) => setTimeout(r, 400));
    const after = await readLoadSample(before.cpu ?? null);
    const compilingPid = String(started.pid);
    assert(
      classifyActiveBuilders(before.cpu, after.cpu).includes(compilingPid),
      `a genuinely compiling process is active via CPU advance: ${JSON.stringify({ pid: compilingPid, compileMs: started.compileMs, active: classifyActiveBuilders(before.cpu, after.cpu), names: after.activeCompilerNames })}`,
    );
    // The name match is evidence about the box, so it is asserted only as a
    // LOWER bound over what this test created — never as an exact count.
    assert(
      second.compilerNames.includes("esbuild") && after.compilerNames.includes("esbuild"),
      `the park this test created is visible as a name match: ${JSON.stringify({ s2: second.compilerNames, after: after.compilerNames })}`,
    );
  } finally {
    for (const p of [...parked, compiler]) {
      if (!p) continue;
      try { p.kill("SIGKILL"); } catch { /* gone */ }
      try { await p.status; } catch { /* reaped */ }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("mkax: a quiet box starts the gate immediately", async () => {
  const notices: string[] = [];
  const v = await awaitQuietWindow(SPEC, {
    sample: async () => sample(),
    notice: (l) => notices.push(l),
    sleep: async () => {},
  });
  assertEquals(v.ok, true);
  if (v.ok) assertEquals(v.waitedMs < 200, true, `no meaningful wait (${v.waitedMs} ms)`);
  assertEquals(notices, [], "a box that is already quiet prints nothing");
});

Deno.test("mkax: the quiet must be SUSTAINED, not a one-sample dip", async () => {
  // noisy, noisy, quiet, quiet, quiet → starts on the third consecutive quiet.
  const script = [
    sample({ load1: 30, loadPerCore: 30 / 32 }),
    sample({ load1: 30, loadPerCore: 30 / 32 }),
    sample(), sample(), sample(),
  ];
  let i = 0;
  const v = await awaitQuietWindow(SPEC, {
    sample: async () => script[Math.min(i++, script.length - 1)],
    sleep: async () => {},
  });
  assertEquals(v.ok, true);
  assertEquals(i, 5, "it sampled until the streak was complete");
  // A dip in the middle resets the streak: quiet, quiet, NOISY, quiet, quiet,
  // quiet → six samples, not four.
  const script2 = [
    sample(), sample(),
    sample({ compilers: 9, compilerNames: ["rustc"] }),
    sample(), sample(), sample(),
  ];
  let j = 0;
  const v2 = await awaitQuietWindow(SPEC, {
    sample: async () => script2[Math.min(j++, script2.length - 1)],
    sleep: async () => {},
  });
  assertEquals(v2.ok, true);
  assertEquals(j, 6, "a mid-window spike restarts the streak");
});

Deno.test("mkax: a box that never quiets down REFUSES inside its bound", async () => {
  const notices: string[] = [];
  let calls = 0;
  const t0 = Date.now();
  const v = await awaitQuietWindow({ ...SPEC, maxWaitMs: 400, sampleMs: 50 }, {
    sample: async () => { calls++; return sample({ load1: 40, loadPerCore: 40 / 32, compilers: 6, compilerNames: ["rustc", "esbuild"] }); },
    notice: (l) => notices.push(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  assertEquals(v.ok, false);
  if (!v.ok) {
    assertEquals(v.reason, "timeout");
    assert(v.last !== null && v.last.compilers === 6, "the refusal carries the numbers");
  }
  assert(calls >= 3, `it kept measuring (${calls} samples)`);
  assert(Date.now() - t0 < 4000, "the bound is honoured, not the 20-minute default");
  assert(notices.length >= 1, "the wait was printed");
  assert(notices[0].includes("quiet-window: waiting"), `honest notice: ${notices[0]}`);
  assert(notices[0].includes("rustc"), `the notice says WHAT is holding the gate: ${notices[0]}`);
});

Deno.test("mkax: an unmeasurable box fails CLOSED (never assumed quiet)", async () => {
  const broken = sample({ measurable: false, error: "read /proc/loadavg: EPERM", loadPerCore: Infinity });
  const v = await awaitQuietWindow({ ...SPEC, sustainedSamples: 3 }, {
    sample: async () => broken,
    sleep: async () => {},
  });
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.reason, "unmeasurable");
  // And a sampler that THROWS is the same verdict, not an uncaught crash.
  const v2 = await awaitQuietWindow({ ...SPEC, sustainedSamples: 1 }, {
    sample: async () => { throw new Error("/proc went away"); },
    sleep: async () => {},
  });
  assertEquals(v2.ok, false);
  if (!v2.ok) assertEquals(v2.reason, "unmeasurable");
  // A single unreadable blip between good samples does NOT refuse.
  const script = [sample(), broken, sample(), sample(), sample()];
  let i = 0;
  const v3 = await awaitQuietWindow(SPEC, {
    sample: async () => script[Math.min(i++, script.length - 1)],
    sleep: async () => {},
  });
  assertEquals(v3.ok, true, "one unreadable sample is a blip, three in a row is an environment");
});

Deno.test("mkax: the refusal error is an ENVIRONMENT verdict, and its exit code is a third state", async () => {
  const err = await (async () => {
    try {
      const v = await awaitQuietWindow({ ...SPEC, maxWaitMs: 200, sampleMs: 50, sustainedSamples: 2 }, {
        sample: async () => sample({ load1: 20, loadPerCore: 20 / 32 }),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      if (!v.ok) throw new QuietWindowRefusedError(v);
      return null;
    } catch (e) { return e as QuietWindowRefusedError; }
  })();
  assert(err instanceof QuietWindowRefusedError);
  assert(err.message.startsWith("ENVIRONMENT:"), `the message says environment first: ${err.message}`);
  assert(err.message.includes("not a failure of the tree"), "it refuses to read as a product red");
  assert(err.message.includes("load/core"), "it carries the measured numbers");
  assert(err.sample !== null && err.sample.load1 === 20);
  // The three verdicts must not collide.
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, 75);
  const code: number = ENVIRONMENTAL_REFUSAL_EXIT;
  assert(code !== 0 && code !== 1, "75 is neither green nor a product red");
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, "CAP_ENVIRONMENTAL_REFUSAL");
  assert(environmentLine(err.sample).includes("load1=20.00"), "the evidence line carries the sample");
  assertEquals(environmentLine(null), "environment: no sample");
  assert(environmentLine(brokenSample()).includes("unmeasurable"));
});

function brokenSample(): LoadSample {
  return sample({ measurable: false, error: "no /proc", loadPerCore: Infinity });
}

Deno.test("mkax: thresholds are env-tunable, clamped, and read per call", () => {
  const keys = ["CAP_QUIET_MAX_LOAD_PER_CORE", "CAP_QUIET_MAX_COMPILERS", "CAP_QUIET_WAIT_MS", "CAP_QUIET_SAMPLE_MS", "CAP_QUIET_SUSTAINED"];
  const saved = new Map(keys.map((k) => [k, Deno.env.get(k)]));
  try {
    for (const k of keys) Deno.env.delete(k);
    const d = resolveSpec();
    assertEquals(d.maxLoadPerCore, 0.35);
    assertEquals(d.maxCompilers, 1);
    assertEquals(d.maxWaitMs, 600_000);
    assertEquals(d.sampleMs, 2000);
    assertEquals(d.sustainedSamples, 3);
    Deno.env.set("CAP_QUIET_MAX_LOAD_PER_CORE", "0.1");
    Deno.env.set("CAP_QUIET_MAX_COMPILERS", "0");
    Deno.env.set("CAP_QUIET_WAIT_MS", "5000");
    assertEquals(resolveSpec().maxLoadPerCore, 0.1, "read per call, no module-load trap");
    assertEquals(resolveSpec().maxCompilers, 0);
    assertEquals(resolveSpec().maxWaitMs, 5000);
    Deno.env.set("CAP_QUIET_MAX_LOAD_PER_CORE", "nonsense");
    assertEquals(resolveSpec().maxLoadPerCore, 0.35, "an unparsable threshold falls back, never NaN");
    Deno.env.set("CAP_QUIET_SAMPLE_MS", "1");
    assertEquals(resolveSpec().sampleMs, 50, "a 1 ms sample interval would spin — clamped");
    Deno.env.set("CAP_QUIET_SUSTAINED", "0");
    assertEquals(resolveSpec().sustainedSamples, 1, "at least one sample must be quiet");
    // An explicit spec beats the environment.
    assertEquals(resolveSpec({ maxLoadPerCore: 0.5 }).maxLoadPerCore, 0.5);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  }
});

Deno.test("mkax: quietReasons names what is holding the gate; heavy builders are a fixed conservative set", () => {
  assertEquals(quietReasons(sample(), resolveSpec(SPEC)), []);
  const loaded = quietReasons(sample({ load1: 30, loadPerCore: 30 / 32 }), resolveSpec(SPEC));
  assertEquals(loaded.length, 1);
  assert(loaded[0].includes("load/core"), loaded[0]);
  const building = quietReasons(sample({ compilers: 4, compilerNames: ["rustc"] }), resolveSpec(SPEC));
  assert(building[0].includes("heavy-builders 4 > 1"), building[0]);
  assert(building[0].includes("rustc"), "the notice names the builder class");
  assertEquals(isQuiet(sample(), resolveSpec(SPEC)), true);
  assertEquals(isQuiet(brokenSample(), resolveSpec(SPEC)), false);
  // The set is compilers and image/build pipelines — NOT browsers, test
  // workers or editors, which would make the gate wait on itself forever.
  for (const name of ["rustc", "cargo", "esbuild", "cc1", "ld.lld", "wasm-opt", "magick", "ffmpeg", "ninja"]) {
    assert(HEAVY_PROCESS_NAMES.has(name), `${name} counts as heavy`);
  }
  for (const name of ["chromium", "chrome", "deno", "node", "bash", "flock"]) {
    assertEquals(HEAVY_PROCESS_NAMES.has(name), false, `${name} must NOT count as heavy — the gate would wait on itself`);
  }
});

Deno.test("mkax: a real sample from this box is finite, bounded and evidence-shaped", async () => {
  // THE SCAN BUDGET IS SCOPED HERE ON PURPOSE (chrome-agent-platform-2bli). This test asks "can a
  // sample be taken on this box", but its default 400 ms /proc budget is exceeded by the suite's
  // OWN parallel phase (478 files, each spawning children): 1io9's refusal is then CORRECT — the
  // sample says so instead of reporting a partial count — and this assertion reddened for
  // unrelated changes (measured 2026-09-24: "proc scan truncated after 912 entries in 404 ms").
  // So the sample is taken with a deliberately larger budget, which is the operator remedy the
  // refusal message itself names, and the refusal keeps its own assertion below. The env is set and
  // restored inside one sequential test (Deno runs the tests in a file in order), so no other test
  // inherits it — the same pattern the hermetic 1io9 drill already uses.
  const withScanBudget = async <T>(entries: string, ms: string, fn: () => Promise<T>): Promise<T> => {
    const before = [Deno.env.get("CAP_QUIET_MAX_PROC_SCAN"), Deno.env.get("CAP_QUIET_MAX_PROC_SCAN_MS")] as const;
    Deno.env.set("CAP_QUIET_MAX_PROC_SCAN", entries);
    Deno.env.set("CAP_QUIET_MAX_PROC_SCAN_MS", ms);
    try {
      return await fn();
    } finally {
      if (before[0] === undefined) Deno.env.delete("CAP_QUIET_MAX_PROC_SCAN"); else Deno.env.set("CAP_QUIET_MAX_PROC_SCAN", before[0]);
      if (before[1] === undefined) Deno.env.delete("CAP_QUIET_MAX_PROC_SCAN_MS"); else Deno.env.set("CAP_QUIET_MAX_PROC_SCAN_MS", before[1]);
    }
  };
  const s = await withScanBudget("20000", "5000", () => readLoadSample());
  assertEquals(s.measurable, true, `this box is measurable: ${s.error ?? ""}`);
  assert(Number.isFinite(s.load1) && s.load1 >= 0, `load1 ${s.load1}`);
  assert(s.cores >= 1, `cores ${s.cores}`);
  assert(Number.isFinite(s.loadPerCore) && s.loadPerCore >= 0);
  assert(s.compilers >= 0 && Number.isInteger(s.compilers));
  assert(s.compilerNames.length <= 8, "the names are bounded — evidence, not a process inventory");
  // It must not inventory other lanes' work: names only, never arguments.
  const line = environmentLine(s);
  assert(line.includes("load1=") && line.includes("cores=") && line.includes("heavy-builders="), line);
  assertEquals(line.includes("worktrees"), false, "no paths or argv in the evidence line");
  // AND THE REFUSAL IS STILL REAL, pinned here so raising the budget above cannot read as "the
  // truncation path no longer matters": a budget that cannot be met must report measurable:false
  // with the partial count as evidence, never a quiet verdict built on an incomplete walk (1io9).
  const refused = await withScanBudget("20000", "0", () => readLoadSample());
  assertEquals(refused.measurable, false, "a /proc budget that cannot be met must refuse, not report a partial count");
  assert(String(refused.error ?? "").includes("truncated"), `the refusal must say what happened: ${refused.error}`);
});

Deno.test("mkax: the launcher refuses to START the browser when the box is not quiet", async () => {
  const { launchChrome } = await import("../scripts/lib/chrome-launch.ts");
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  const started = `${fake}.started`;
  await Deno.writeTextFile(
    fake,
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\necho "DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc" 1>&2\nexec sleep 10\n`,
  );
  await Deno.chmod(fake, 0o755);
  const scope = await Deno.makeTempFile({ prefix: "cap-mkax-scope-" });
  try {
    // An impossible threshold and a short bound: the box is never quiet enough.
    const err = await assertRejects(
      () => launchChrome({
        binary: fake,
        args: [],
        timeoutMs: 5000,
        lockPath: scope,
        requireQuiet: { maxLoadPerCore: -1, maxCompilers: -1, maxWaitMs: 300, sampleMs: 50, sustainedSamples: 1 },
      }),
      QuietWindowRefusedError,
      "ENVIRONMENT:",
    );
    assert(err instanceof QuietWindowRefusedError);
    assertEquals(
      await Deno.lstat(started).catch(() => null),
      null,
      "the browser was NEVER started — a refusal is not a launch that failed later",
    );
    // A permissive spec launches, and reports the wait it did (not) do.
    const launched = await launchChrome({
      binary: fake,
      args: [],
      timeoutMs: 5000,
      lockPath: scope,
      requireQuiet: { maxLoadPerCore: 1e9, maxCompilers: 1e9, maxWaitMs: 2000, sampleMs: 50, sustainedSamples: 1 },
    });
    assertEquals(launched.quietWaitMs >= 0, true);
    assert(launched.quietWaitMs < 2000, `a quiet-enough box starts at once (${launched.quietWaitMs} ms)`);
    try { launched.proc.kill("SIGKILL"); } catch { /* gone */ }
    await launched.proc.status;
  } finally {
    await Deno.remove(fake).catch(() => {});
    await Deno.remove(started).catch(() => {});
    await Deno.remove(scope).catch(() => {});
  }
});

Deno.test("mkax: a harness that does not ask for a quiet window is unaffected", async () => {
  const { launchChrome } = await import("../scripts/lib/chrome-launch.ts");
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    fake,
    `#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc" 1>&2\nexec sleep 10\n`,
  );
  await Deno.chmod(fake, 0o755);
  const scope = await Deno.makeTempFile({ prefix: "cap-mkax-scope2-" });
  try {
    const launched = await launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: scope });
    assertEquals(launched.quietWaitMs, 0, "no requirement, no wait, no measurement");
    try { launched.proc.kill("SIGKILL"); } catch { /* gone */ }
    await launched.proc.status;
  } finally {
    await Deno.remove(fake).catch(() => {});
    await Deno.remove(scope).catch(() => {});
  }
});

Deno.test("mkax: load-sensitive harnesses DECLARE themselves, and the declaration is honoured in source", async () => {
  // Acceptance: gates declare themselves rather than being hardcoded in a
  // runner. A declaration nobody honours is worse than none, so both
  // directions are checked: registry → source, and source → registry.
  const { HARNESSES } = await import("../scripts/lib/harness-registry.ts");
  const declared = Object.entries(HARNESSES)
    .filter(([, entry]) => entry.loadSensitive !== undefined)
    .map(([file, entry]) => [file, entry.loadSensitive as string] as const);
  assert(declared.length >= 1, "at least one harness declares itself load-sensitive");

  const honouring: string[] = [];
  for (const entry of Deno.readDirSync(`${ROOT}scripts`)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = Deno.readTextFileSync(`${ROOT}scripts/${entry.name}`);
    if (/requireQuiet:\s*(true|\{)/u.test(src)) honouring.push(entry.name);
  }

  const declaredNames = declared.map(([file]) => file).sort();
  assertEquals(
    honouring.sort(),
    declaredNames,
    "the registry's loadSensitive set and the sources that pass requireQuiet must be the SAME set",
  );

  for (const [file, reason] of declared) {
    assert(reason.length > 40, `${file}: the declaration must carry its evidence, got "${reason}"`);
    const src = Deno.readTextFileSync(`${ROOT}scripts/${file}`);
    // The refusal must reach a THIRD exit code with the greppable marker, or an
    // aggregator cannot tell an environmental refusal from a product red.
    //
    // chrome-agent-platform-lrok: these three pins asserted the BARE WORDS, and each
    // word occurs in the target twice — once in the import block (chrome-journeys.ts
    // :34-36) and once in the handler (:136-139). Mutant W2 (census wzez) deleted the
    // whole five-line handler and left `throw e;` plus the imports: every token dropped
    // to a single occurrence, all three pins PASSED, and this test stayed green. The
    // kill came only from the executing gate below ("the REAL journey gate refuses with
    // exit 75 under artificial load") — the pins that named the property were the ones
    // that could not see it disappear. An import binding is not a handler, so each
    // property is now anchored INSIDE the handler: the typed catch, then the marker and
    // the exit code reached from it. Bounded so a marker printed in some unrelated
    // statement cannot satisfy it. The imports stay unpinned on purpose — provenance is
    // the module's job, and these three prove USE. Kept generic: the assertion runs once
    // per harness that declares itself load-sensitive, so it pins the declaration rule
    // and not today's single member (proven by mutant W4 on the bead).
    assert(
      /instanceof\s+QuietWindowRefusedError\s*\)/.test(src),
      `${file} must catch the refusal BY TYPE — an import binding is not a handler`,
    );
    assert(
      /instanceof\s+QuietWindowRefusedError\s*\)[\s\S]{0,400}?ENVIRONMENTAL_REFUSAL_MARKER/.test(src),
      `${file} must print the greppable marker from inside the refusal handler`,
    );
    assert(
      /instanceof\s+QuietWindowRefusedError\s*\)[\s\S]{0,400}?Deno\.exit\(\s*ENVIRONMENTAL_REFUSAL_EXIT\s*\)/.test(src),
      `${file} must exit with the environmental code from inside the refusal handler`,
    );
  }
});

Deno.test("mkax: no harness may quiet the box by interfering with other lanes", async () => {
  // The DO-NOT in the bead: measure and wait, or refuse. Never kill, renice, or
  // cgroup somebody else's build to manufacture a quiet window.
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/quiet-window.ts`);
  for (const forbidden of ["kill", "renice", "SIGKILL", "SIGTERM", "pkill", "killall", "ionice", "taskset"]) {
    const code = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    assertEquals(code.includes(forbidden), false, `quiet-window.ts must not ${forbidden} anything`);
  }
});

Deno.test("mkax: the REAL journey gate refuses with exit 75 while a REAL compiler is compiling (dnop)", async () => {
  // End-to-end pin of the third verdict. Static source checks cannot prove the
  // handler is live (falsification: `if (e instanceof QuietWindowRefusedError)`
  // rewritten to `if (false)` left every textual assertion green), so drive the
  // actual harness.
  //
  // dnop: the burner is a REAL compile, not a name. Before this the test copied
  // /bin/sleep to rustc/esbuild/cargo — name-only load, which is the defect's
  // own shape, so it could not distinguish "a build is running" from "a process
  // is named esbuild". The real binary burns CPU on a generated input and the
  // gate must STILL refuse: an implementation that stopped counting genuine
  // builds would let the journey run under exactly the condition the declaration
  // exists to exclude.
  //
  // Blast radius, stated: the compile lives for a couple of seconds, so another
  // lane's quiet-window gate running in that window waits a little longer. It
  // cannot fail one — that wait is bounded and only ever ends in a refusal at
  // the END of a bound, and this test's own bound is 800 ms.
  const dir = await Deno.makeTempDir({ prefix: "cap-mkax-load-" });
  const burners: Deno.ChildProcess[] = [];
  try {
    const bin = await realEsbuildBinary();
    // REAL compiles, back to back and staggered, sized on THIS box so each lasts
    // seconds (calibratedBurner explains why a constant size cannot be used): a
    // single short compile finishes before the gate has finished starting up —
    // which is how the first version of this test started a whole journey run
    // instead of producing a refusal, and, on a faster reviewer box, how it
    // produced a quiet window BETWEEN two compiles. Other lanes' parked daemons
    // are deliberately part of the ambient environment: the property is that a
    // genuinely COMPILING process holds the gate, whatever else the box runs.
    const calibration = await calibratedBurner(dir, 3000);
    assert(
      calibration.compileMs >= 3000,
      `the burner must outlast the gate's bound on THIS box (calibrated to ${calibration.compileMs} ms)`,
    );
    const burn = (delayS: number) => new Deno.Command("/bin/bash", {
      args: ["-c", `sleep ${delayS}; for i in $(seq 1 40); do "${bin}" "${calibration.input}" --minify --outfile=/dev/null --log-level=error >/dev/null 2>&1; done`],
      stdout: "null", stderr: "null",
    }).spawn();
    burners.push(burn(0), burn(1));
    await new Promise((r) => setTimeout(r, 1500));
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", `${ROOT}scripts/chrome-journeys.ts`],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
      env: {
        CAP_QUIET_WAIT_MS: "800",
        CAP_QUIET_SAMPLE_MS: "150",
        CAP_QUIET_MAX_COMPILERS: "1",
        CAP_QUIET_SUSTAINED: "2",
        // zeew — TWO ambient assumptions removed, and the FIRST is the real one:
        //
        // 1. A PRIVATE fleet slot. The spawned gate takes the fleet-wide slot
        //    BEFORE it measures anything, so with the default path it queued
        //    behind whatever real gate another lane was running: measured 7m29s
        //    inside this test, by which time its own burners (40 × 3 s compiles)
        //    had exited — the refusal then came from the loaded box with
        //    activeCompilers 0, and the assertion says it wants a compiling
        //    process. The recorded payload: {"load1":25.39,"loadPerCore":0.79,
        //    "compilers":12,"activeCompilers":0}. A test about the quiet-window
        //    condition must not wait on the gate-slot condition.
        // 2. The LOAD ceiling, pinned out of the way, so the only condition that
        //    can cause this refusal is the test's own compiler (the
        //    startup-failure drill above pins it the same way).
        CAP_HEAVY_GATE_SLOT: `${dir}/gate.lock`,
        CAP_HEAVY_GATE_BOUND_MS: "1200",
        CAP_QUIET_MAX_LOAD_PER_CORE: "100",
      },
    }).output();
    const out = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
    assertEquals(run.code, ENVIRONMENTAL_REFUSAL_EXIT, `the gate refused environmentally: ${out.slice(-500)}`);
    assert(out.includes("ENVIRONMENT:"), `the verdict says environment: ${out.slice(-400)}`);
    assert(out.includes(ENVIRONMENTAL_REFUSAL_MARKER), "the greppable marker is printed");
    assert(out.includes("not a failure of the tree"), "it refuses to read as a product red");
    const marker = out.split("\n").find((l) => l.startsWith(ENVIRONMENTAL_REFUSAL_MARKER));
    const refusal = JSON.parse(marker!.slice(ENVIRONMENTAL_REFUSAL_MARKER.length).trim());
    assert(refusal.compilers >= 1, `the refusal carries the name match: ${JSON.stringify(refusal)}`);
    assert(
      refusal.activeCompilers >= 1,
      `the refusal is due to a COMPILING process, not a parked name: ${JSON.stringify(refusal)}`,
    );
    assertEquals(refusal.measurable, true);
    assert(out.includes("quiet-window: waiting"), "the wait was printed while it lasted");
    // It never got as far as a browser: no DevTools endpoint, no journey checks.
    assertEquals(out.includes("DevTools listening"), false, "no browser was started");
  } finally {
    for (const b of burners) {
      try { b.kill("SIGKILL"); } catch { /* gone */ }
      try { await b.status; } catch { /* reaped */ }
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 9t1p: an evaluate timeout has THREE causes, and only one is the box ──────
// qk7p mapped every evaluate timeout to "fleet load" WITHOUT reading the
// machine. Measured on the run that filed 9t1p: load/core 0.11, zero active
// compilers, three parked esbuild daemons — an idle box reported as fleet load,
// while the real cause was a service worker that never answered an in-page
// round trip. Every lane that read "fleet load" re-ran and wasted a run.

Deno.test("9t1p: a LOADED box keeps the environmental verdict and names the numbers", () => {
  const v = classifyEvaluateTimeout(sample({ load1: 30, loadPerCore: 30 / 32 }), resolveSpec(SPEC));
  assertEquals(v.cause, "loaded");
  assertEquals(v.environmental, true, "a genuinely loaded box is still a re-run verdict");
  assert(/WAS loaded/.test(v.reason), v.reason);
  assert(/load\/core 0\.94 > 0\.35/.test(v.reason), `the threshold breach is named: ${v.reason}`);
  assert(/load1=30\.00/.test(v.environment), `the reading is carried: ${v.environment}`);
});

Deno.test("9t1p: an IDLE box is NOT fleet load — it is a product red that says what it is", () => {
  // The exact shape of the filing run: quiet load, parked-but-not-compiling
  // esbuild daemons. This must not be reported as load, and must not exit 75.
  const idle = sample({
    load1: 3.5, loadPerCore: 0.11,
    compilers: 3, compilerNames: ["esbuild"],
    activeCompilers: 0, activeCompilerNames: [],
  });
  const v = classifyEvaluateTimeout(idle, resolveSpec(SPEC));
  assertEquals(v.cause, "idle-never-settled");
  assertEquals(v.environmental, false, "an idle box must never take the environmental re-run verdict");
  assert(/never settled/.test(v.reason), v.reason);
  assert(/NOT fleet load/.test(v.reason), `it must say what it is not: ${v.reason}`);
  assert(!/WAS loaded/.test(v.reason));
});

Deno.test("9t1p: an UNMEASURABLE box fails CLOSED to environmental, but never claims load", () => {
  for (
    const s of [
      null,
      sample({ measurable: false, error: "proc scan: permission denied", loadPerCore: Infinity }),
    ]
  ) {
    const v = classifyEvaluateTimeout(s, resolveSpec(SPEC));
    assertEquals(v.cause, "unmeasurable");
    assertEquals(v.environmental, true, "fail closed: an unmeasurable box is never assumed idle");
    assert(/could not be measured/.test(v.reason), v.reason);
    assert(!/WAS loaded/.test(v.reason), `a fail-closed verdict must not fabricate a load claim: ${v.reason}`);
  }
});

Deno.test("9t1p: the measurement takes TWO samples, so parked daemons are not counted as a build", async () => {
  // classifyActiveBuilders treats an unseen process as active (fail closed,
  // right for an admission gate). A single sample therefore reports three
  // PARKED esbuild daemons as three live builds — the dnop bug, and exactly the
  // misattribution this measurement exists to end. The second sample, taken
  // with the first's CPU map, is what makes "idle" measurable.
  const parked = new Map([
    ["101", { name: "esbuild", startTicks: "1", cpuTicks: 500 }],
    ["102", { name: "esbuild", startTicks: "2", cpuTicks: 900 }],
    ["103", { name: "esbuild", startTicks: "3", cpuTicks: 700 }],
  ]);
  const reads: Array<Map<string, unknown> | null | undefined> = [];
  const waits: number[] = [];
  const v = await measureEvaluateTimeout(SPEC, {
    read: (prev) => {
      reads.push(prev ?? null);
      // The REAL sampler's arithmetic decides activity: same cpuTicks across
      // both samples = nothing advanced = nothing compiling.
      const active = classifyActiveBuilders(prev ?? null, parked);
      return Promise.resolve(sample({
        load1: 3.5, loadPerCore: 0.11,
        compilers: 3, compilerNames: ["esbuild"],
        activeCompilers: active.length,
        activeCompilerNames: active.length ? ["esbuild"] : [],
        cpu: parked,
      }));
    },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(reads.length, 2, "two samples, or a parked daemon reads as a build");
  assertEquals(reads[0], null, "the first sample has no predecessor");
  assertEquals(reads[1], parked, "the second sample is compared against the first's CPU map");
  assertEquals(waits, [SPEC.sampleMs], "it waits one sample interval between the two reads");
  assertEquals(v.cause, "idle-never-settled", "three PARKED esbuilds are not a loaded box");
  assertEquals(v.environmental, false);
});

Deno.test("9t1p: a single-sample reading would have called that same idle box loaded", () => {
  // The control for the test above: with no predecessor, the same three parked
  // daemons classify as active and the verdict flips to `loaded`. This is why
  // the two-sample shape is the fix and not an optimisation.
  const firstOnly = classifyActiveBuilders(null, new Map([
    ["101", { name: "esbuild", startTicks: "1", cpuTicks: 500 }],
    ["102", { name: "esbuild", startTicks: "2", cpuTicks: 900 }],
    ["103", { name: "esbuild", startTicks: "3", cpuTicks: 700 }],
  ]));
  assertEquals(firstOnly.length, 3, "unseen processes fail closed to active");
  const v = classifyEvaluateTimeout(
    sample({
      load1: 3.5, loadPerCore: 0.11,
      compilers: 3, compilerNames: ["esbuild"],
      activeCompilers: firstOnly.length, activeCompilerNames: ["esbuild"],
    }),
    resolveSpec(SPEC),
  );
  assertEquals(v.cause, "loaded", "one sample misreads parked daemons as load — the bug being fixed");
});

Deno.test("9t1p: the exit decision — 75 carries the marker, a product red must NOT", () => {
  // This is the site the bead is about: the harness printed the refusal marker
  // and exited 75 for EVERY evaluate timeout. An aggregator greps that marker,
  // so a product red wearing it is re-run forever and never fixed.
  const loaded = classifyEvaluateTimeout(sample({ load1: 30, loadPerCore: 30 / 32 }), resolveSpec(SPEC));
  const env = evaluateTimeoutReport(loaded);
  assertEquals(env.exitCode, ENVIRONMENTAL_REFUSAL_EXIT);
  assert(env.line.startsWith(ENVIRONMENTAL_REFUSAL_MARKER), env.line);
  // The marker payload is machine-readable AND carries the reading, so the
  // "it was load" claim can be checked rather than taken on faith.
  const payload = JSON.parse(env.line.slice(ENVIRONMENTAL_REFUSAL_MARKER.length));
  assertEquals(payload.cause, "loaded");
  assert(/load1=30\.00/.test(payload.environment), payload.environment);

  const idle = classifyEvaluateTimeout(
    sample({ load1: 3.5, loadPerCore: 0.11, compilers: 3, compilerNames: ["esbuild"], activeCompilers: 0, activeCompilerNames: [] }),
    resolveSpec(SPEC),
  );
  const red = evaluateTimeoutReport(idle);
  assertEquals(red.exitCode, 1, "an idle box that never settled is a product red, not a re-run");
  assertEquals(red.line.includes(ENVIRONMENTAL_REFUSAL_MARKER), false,
    `a product red must not wear the environmental marker: ${red.line}`);
  assert(/PRODUCT RED/.test(red.line), red.line);
  assert(/load1=3\.50/.test(red.line), `the reading that justified it is printed: ${red.line}`);

  // Fail-closed stays a re-run verdict, and still never claims load.
  const unmeasured = evaluateTimeoutReport(classifyEvaluateTimeout(null, resolveSpec(SPEC)));
  assertEquals(unmeasured.exitCode, ENVIRONMENTAL_REFUSAL_EXIT);
  assertEquals(JSON.parse(unmeasured.line.slice(ENVIRONMENTAL_REFUSAL_MARKER.length)).cause, "unmeasurable");

  // The three exit codes stay distinct — 0/1/75, the contract this file opens with.
  assertEquals(new Set([0, red.exitCode, env.exitCode]).size, 3);
});

Deno.test("9t1p: the REAL harness routes its evaluate-timeout exit through the measured report", async () => {
  // A source pin would pass with the wiring removed, so this asserts the
  // STRUCTURE the harness must have: it measures at the catch, and its exit
  // site is the shared report rather than a hand-written marker line.
  const harness = await Deno.readTextFile(`${ROOT}scripts/chrome-journeys.ts`);
  const catchSite = harness.slice(harness.indexOf("if (isCdpEvaluateTimeout(String(e?.message ?? e)))"));
  assert(/measureEvaluateTimeout\(\)/.test(catchSite.slice(0, 1200)),
    "the catch must MEASURE the box, not assume load");
  assert(/evaluateTimeoutReport\(evaluateTimeoutVerdict\)/.test(harness),
    "the exit site must use the shared, tested decision");
  // The old fixed claim must be gone from the exit path entirely.
  assertEquals(harness.includes('{"reason":"cdp evaluate exceeded the budget under fleet load"}'), false,
    "the unconditional 'under fleet load' marker payload must not survive");
  // And the environmental exit must no longer be reachable without a verdict.
  assertEquals(/environmentalAbort/.test(harness), false,
    "the boolean that could not tell load from a hang is gone");
});

Deno.test("9t1p: the measurement stops at an unmeasurable FIRST sample (no second read)", async () => {
  let reads = 0;
  const v = await measureEvaluateTimeout(SPEC, {
    read: () => {
      reads++;
      return Promise.resolve(sample({ measurable: false, error: "/proc unreadable", loadPerCore: Infinity }));
    },
    wait: () => Promise.reject(new Error("must not wait after an unmeasurable read")),
  });
  assertEquals(reads, 1);
  assertEquals(v.cause, "unmeasurable");
  assertEquals(v.environmental, true);
});

Deno.test("qk7p: the journeys' CDP evaluate timeout is classified environmental", () => {
  // The abort signature from five real journeys runs at fleet density
  // (positions 278/229/229/195/159 of 370) — an evaluate that outlives the
  // budget is the machine, never the tree.
  assertEquals(isCdpEvaluateTimeout("journey failure: cdp timeout: Runtime.evaluate"), true);
  // Product failures must NOT take the environmental verdict.
  assertEquals(isCdpEvaluateTimeout("assertion failed: expected alice"), false);
  assertEquals(isCdpEvaluateTimeout("tool.preview.run returned no offscreen response"), false);
  assertEquals(isCdpEvaluateTimeout(""), false);
});

Deno.test("1io9: a TRUNCATED /proc walk is a refusal, never a quiet box", async () => {
  // The hole: the walk is bounded (MAX_PROC_SCAN entries / MAX_PROC_SCAN_MS) and
  // its PARTIAL count used to be returned as the sample, so a real compiler the
  // walk never reached was reported as zero builders and the gate opened under a
  // build. Driven in a CHILD process so no other test in this runner process can
  // observe the env override (m3a2), and via the budget itself rather than a
  // hand-built sample, so the walk is what is under test.
  const dir = await Deno.makeTempDir({ prefix: "cap-1io9-" });
  const script = `${dir}/truncated.mjs`;
  await Deno.writeTextFile(script, `
import { readLoadSample, isQuiet, resolveSpec, environmentLine } from ${JSON.stringify(`${ROOT}scripts/lib/quiet-window.ts`)};
const s = await readLoadSample();
console.log(JSON.stringify({
  measurable: s.measurable, error: s.error ?? null, compilers: s.compilers,
  quiet: isQuiet(s, resolveSpec({})), line: environmentLine(s),
}));
`);
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", script],
      cwd: ROOT, stdout: "piped", stderr: "piped",
      env: { CAP_QUIET_MAX_PROC_SCAN: "1" },
    }).spawn();
    const out = new TextDecoder().decode((await child.output()).stdout).trim().split("\n").pop()!;
    const sample = JSON.parse(out);
    assertEquals(sample.measurable, false, `a truncated walk is unmeasurable: ${out}`);
    assert(String(sample.error).includes("truncated after"), `the error names the truncation: ${sample.error}`);
    assert(String(sample.error).includes("NOT a quiet verdict"), sample.error);
    assertEquals(sample.quiet, false, "a truncated sample must never read as quiet");
    assert(String(sample.line).includes("unmeasurable"), `the evidence line says unmeasurable: ${sample.line}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

