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
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  awaitQuietWindow,
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  environmentLine,
  HEAVY_PROCESS_NAMES,
  isQuiet,
  QuietWindowRefusedError,
  quietReasons,
  readLoadSample,
  resolveSpec,
  type LoadSample,
} from "../scripts/lib/quiet-window.ts";

const ROOT = new URL("..", import.meta.url).pathname;

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
  const s = await readLoadSample();
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
    assert(src.includes("QuietWindowRefusedError"), `${file} must handle the refusal`);
    assert(src.includes("ENVIRONMENTAL_REFUSAL_EXIT"), `${file} must exit with the environmental code`);
    assert(src.includes("ENVIRONMENTAL_REFUSAL_MARKER"), `${file} must print the marker line`);
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

Deno.test("mkax: the REAL journey gate refuses with exit 75 under artificial load", async () => {
  // End-to-end pin of the third verdict. Static source checks cannot prove the
  // handler is live (falsification: `if (e instanceof QuietWindowRefusedError)`
  // rewritten to `if (false)` left every textual assertion green), so drive the
  // actual harness: three processes named after real builders, a 1.5 s bound,
  // and the exit code plus the marker line it produces.
  //
  // Cost and blast radius, stated honestly: the burners live for a few seconds
  // and are named rustc/esbuild/cargo, so another lane's quiet-window gate
  // running in exactly that window waits a few seconds longer. It cannot fail
  // one: the wait is bounded and the refusal only happens at the END of a
  // bound, and this test's own bound is 1.5 s.
  const dir = await Deno.makeTempDir({ prefix: "cap-mkax-load-" });
  const names = ["rustc", "esbuild", "cargo"];
  const burners: Deno.ChildProcess[] = [];
  try {
    for (const n of names) {
      await Deno.copyFile("/bin/sleep", `${dir}/${n}`);
      burners.push(new Deno.Command(`${dir}/${n}`, { args: ["30"], stdout: "null", stderr: "null" }).spawn());
    }
    await new Promise((r) => setTimeout(r, 300));
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", `${ROOT}scripts/chrome-journeys.ts`],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
      env: {
        CAP_QUIET_WAIT_MS: "1500",
        CAP_QUIET_SAMPLE_MS: "200",
        CAP_QUIET_MAX_COMPILERS: "1",
        CAP_QUIET_SUSTAINED: "2",
      },
    }).output();
    const out = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
    assertEquals(run.code, ENVIRONMENTAL_REFUSAL_EXIT, `the gate refused environmentally: ${out.slice(-500)}`);
    assert(out.includes("ENVIRONMENT:"), `the verdict says environment: ${out.slice(-400)}`);
    assert(out.includes(ENVIRONMENTAL_REFUSAL_MARKER), "the greppable marker is printed");
    assert(out.includes("not a failure of the tree"), "it refuses to read as a product red");
    const marker = out.split("\n").find((l) => l.startsWith(ENVIRONMENTAL_REFUSAL_MARKER));
    const sample = JSON.parse(marker!.slice(ENVIRONMENTAL_REFUSAL_MARKER.length).trim());
    assert(sample.compilers >= 3, `the refusal carries the measured builders: ${JSON.stringify(sample)}`);
    assertEquals(sample.measurable, true);
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
