// tests/serial-phase-failure-attribution.test.ts — chrome-agent-platform-dsoq.
//
// THE DEFECT (measured during the r0v8 landing): the serial phase printed
//   "run-tests: serial phase (19 build/artifact files) FAILED (1/19 failed) in 475s"
// and named NO failing file. Worse, several serial files print no "running N tests" banner when they
// fail early (a type-check error prints only "Check <file>" plus an error), so "which file failed" was
// not recoverable by reading the log either. A landing gate that reports a COUNT without a NAME cannot
// be acted on: the merger could not tell whether the change under test caused the failure, and had to
// re-run the whole bounded gate — once losing it entirely to queue-wait (exit 124).
//
// WHAT THIS TEST DOES: runs the REAL aggregator (scripts/lib/serial-phase.mjs -> runSerialFiles)
// against a deliberately FAILING fixture beside a passing one, through a driver that mirrors how
// run-tests.mjs calls it, and asserts:
//   1. the failing file is NAMED in the summary,
//   2. its captured output is surfaced,
//   3. a durable per-file log path is named,
//   4. the count line is still printed (the fix ADDS a name to the count, it does not replace it),
//   5. the PASSING file is not blamed — a report that names everything is not attribution,
//   6. the aggregator still returns the first failing exit code.
// The fixtures live in the durable evidence root, never in tests/: a deliberately failing file inside
// tests/ would be picked up by the suite itself.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const decoder = new TextDecoder();

Deno.test("dsoq: a failing serial file is NAMED, with its captured output, and passing files are not blamed", async () => {
  const dir = durableDir(`dsoq-attribution-${Deno.pid}`);
  const passFile = join(dir, "zz-dsoq-passing.test.ts");
  const failFile = join(dir, "zz-dsoq-failing.test.ts");
  const driver = join(dir, "zz-dsoq-driver.mjs");

  await Deno.writeTextFile(
    passFile,
    `Deno.test("fixture: passes", () => {\n  if (1 !== 1) throw new Error("unreachable");\n});\n`,
  );
  await Deno.writeTextFile(
    failFile,
    `Deno.test("fixture: deliberately fails", () => {\n  throw new Error("DSOQ_DELIBERATE_FAILURE");\n});\n`,
  );
  // The driver mirrors run-tests.mjs: the default stdio, the repo cwd (so the runner's --config
  // resolves), and the aggregator's return value printed where the test can read it.
  await Deno.writeTextFile(
    driver,
    `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
      `const rc = runSerialFiles([process.argv[2], process.argv[3]], {\n` +
      `  stdio: "pipe",\n  cwd: ${JSON.stringify(ROOT)},\n  timeoutMs: 120000,\n});\n` +
      `console.log("DSOQ_DRIVER_RC=" + rc);\n`,
  );

  const { code, stdout, stderr } = await new Deno.Command("node", {
    args: [driver, passFile, failFile],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = decoder.decode(stdout) + decoder.decode(stderr);

  try {
    // (1) THE FIX: the failing file is NAMED.
    assert(
      out.includes("zz-dsoq-failing.test.ts"),
      `the failing serial file must be named in the output:\n${out}`,
    );
    assert(
      out.includes("FAILING SERIAL FILE(S)"),
      `the phase must print a named failing-file block, not only a count:\n${out}`,
    );
    // (2) its captured output is surfaced.
    assert(
      out.includes("DSOQ_DELIBERATE_FAILURE"),
      `the failing file's captured output must be surfaced:\n${out}`,
    );
    // (4) the count line survives: this ADDS attribution, it does not replace the summary.
    assert(
      /serial phase \(2 build\/artifact files\) FAILED \(1\/2 failed\)/.test(out),
      `the count line must still be printed:\n${out}`,
    );
    // (5) attribution, not a blanket list: the passing file must not be named as failing.
    const failingBlock = out.slice(out.indexOf("FAILING SERIAL FILE(S)"));
    assert(
      !failingBlock.includes("zz-dsoq-passing.test.ts"),
      `the passing file must not be blamed:\n${failingBlock}`,
    );
    // (3) a durable per-file log is named and really exists.
    const logPath = out.match(/(\/\S*serial-phase-logs\/\S+\.log)/)?.[1];
    assert(logPath, `a per-file log path must be named:\n${out}`);
    assert(
      (await Deno.stat(logPath)).isFile,
      `the named per-file log must exist on disk: ${logPath}`,
    );
    assert(
      (await Deno.readTextFile(logPath)).includes("DSOQ_DELIBERATE_FAILURE"),
      `the per-file log must hold that file's captured output: ${logPath}`,
    );
    // (6) the aggregator's contract is unchanged: first failing code, and the driver ran clean.
    assert(out.includes("DSOQ_DRIVER_RC=1"), `the aggregator must return the first failing code:\n${out}`);
    assertEquals(code, 0, `the driver itself must exit 0 (its rc is reported in-band):\n${out}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── chrome-agent-platform-grj9: the dsoq review's two reporting residuals ────
// Both are the same unreadable-gate class the rest of this file guards, from two
// further directions: a failure whose REASON never reaches the report, and evidence
// that two worktrees can silently overwrite.

/** Spawn a driver that calls runSerialFiles and echoes what the test needs to read.
 *  `extra` is spliced into the options object (the spawn-error case passes env). */
async function grj9Driver(dir: string, extra = ""): Promise<string> {
  const driver = join(dir, "zz-grj9-driver.mjs");
  await Deno.writeTextFile(
    driver,
    `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
      `console.log("GRJ9_PID=" + process.pid);\n` +
      `const rc = runSerialFiles([process.argv[2]], {\n` +
      `  stdio: "pipe",\n  cwd: ${JSON.stringify(ROOT)},\n  timeoutMs: 30000,\n${extra}\n});\n` +
      `console.log("GRJ9_DRIVER_RC=" + rc);\n`,
  );
  return driver;
}

Deno.test("grj9: an OS-level spawn error's REASON reaches the captured failure output", async () => {
  // The defect: the captured text was stdout+stderr ONLY, so a spawnSync-level failure
  // (here a REAL ENOENT — PATH is emptied, so the runtime cannot be resolved at all)
  // was attributed to the file with exit 1 and NO explanation. `result.error` is where
  // that reason lives, and it must reach both the printed block and the per-file log.
  const dir = durableDir(`grj9-spawn-error-${Deno.pid}`);
  const failFile = join(dir, "zz-grj9-spawn-fail.test.ts");
  await Deno.writeTextFile(failFile, `Deno.test("fixture: never reached", () => {});\n`);
  try {
    const driver = await grj9Driver(dir, `  env: { PATH: "" },`);
    const { code, stdout, stderr } = await new Deno.Command("node", {
      args: [driver, failFile],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = decoder.decode(stdout) + decoder.decode(stderr);

    assert(
      out.includes("ENOENT"),
      `the spawn error's reason must appear in the captured output (pre-fix it was dropped):\n${out}`,
    );
    assert(
      out.includes("spawnSync") || out.includes("spawn"),
      `the reason must identify it as a spawn failure:\n${out}`,
    );
    // Attribution still works: the file is named, and the phase still fails (rc 1).
    assert(out.includes("zz-grj9-spawn-fail.test.ts"), `the failing file must still be named:\n${out}`);
    assert(out.includes("FAILING SERIAL FILE(S)"), `the named block must still print:\n${out}`);
    assert(out.includes("GRJ9_DRIVER_RC=1"), `the phase must return the failing code:\n${out}`);
    assertEquals(code, 0, `the driver itself exits 0 (its rc is reported in-band):\n${out}`);
    // The reason must reach the DURABLE LOG too — that is the evidence a gate reader keeps.
    const logPath = out.match(/(\/\S*serial-phase-logs\/\S+\.log)/)?.[1];
    assert(logPath, `a per-file log path must be named:\n${out}`);
    const logged = await Deno.readTextFile(logPath);
    assert(logged.includes("ENOENT"), `the per-file log must hold the spawn reason: ${logPath}\n${logged}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("grj9: the durable per-file log path is namespaced by the run's pid", async () => {
  // The defect: the log dir is shared across worktrees and the stamp was
  // millisecond-resolution only, so two runs failing the same file in the same
  // millisecond wrote the same path and overwrote each other's evidence. Two runs
  // (two processes, hence two pids) must produce DIFFERENT paths, and each path must
  // carry the pid of the run that wrote it — that last assertion is what makes this
  // bite pre-fix deterministically (there was no pid in the path at all).
  const dir = durableDir(`grj9-pid-scope-${Deno.pid}`);
  const failFile = join(dir, "zz-grj9-pid-fail.test.ts");
  await Deno.writeTextFile(
    failFile,
    `Deno.test("fixture: deliberately fails", () => {\n  throw new Error("GRJ9_DELIBERATE_FAILURE");\n});\n`,
  );
  try {
    const driver = await grj9Driver(dir);
    const runs: { pid: string; log: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const { stdout, stderr } = await new Deno.Command("node", {
        args: [driver, failFile],
        cwd: ROOT,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = decoder.decode(stdout) + decoder.decode(stderr);
      const pid = out.match(/GRJ9_PID=(\d+)/)?.[1];
      const log = out.match(/(\/\S*serial-phase-logs\/\S+\.log)/)?.[1];
      assert(pid, `each run must report its pid:\n${out}`);
      assert(log, `each run must name its per-file log:\n${out}`);
      runs.push({ pid, log });
    }
    assert(runs[0].pid !== runs[1].pid, "the two runs must be different processes");
    assert(runs[0].log !== runs[1].log, `two runs must not share a log path:\n${runs.map((r) => r.log).join("\n")}`);
    for (const r of runs) {
      assert(
        r.log.includes(`-p${r.pid}`),
        `the log path must carry the pid of the run that wrote it (got ${r.log} for pid ${r.pid})`,
      );
      assert((await Deno.stat(r.log)).isFile, `the named log must exist: ${r.log}`);
      assert(
        (await Deno.readTextFile(r.log)).includes("GRJ9_DELIBERATE_FAILURE"),
        `each run's log must hold its own captured output: ${r.log}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── chrome-agent-platform-ulcw: the COUNT and its durable logs share ONE run id ──────────────────────
// THE DEFECT: for one run's stamp the durable per-file logs named more files than the summary counted
// (the bead's "1/6 failed while two failure logs existed"). Measured on this tree, the accounting was
// ALREADY correct per call — a run with one exit-failure and one timeout-failure prints 2/3 and names
// both — so the divergence the bead saw is a RUN-IDENTITY defect: the millisecond stamp + pid was not
// unique per call, and the summary did not print any run id at all, so a reader counting logs under a
// timestamp saw a different set from the run that printed the count. This test pins BOTH halves: the
// count/name/timeout-distinction of a two-failure run, and that the summary's run id is what every one
// of ITS logs carries and that two calls in one process never share an id.
Deno.test("ulcw: TWO failing files (one exit, one TIMEOUT) are both counted, both named, and the run id ties the count to exactly its own logs", async () => {
  const dir = durableDir(`ulcw-two-failures-${Deno.pid}`);
  const passFile = join(dir, "zz-ulcw-pass.test.ts");
  const exitFile = join(dir, "zz-ulcw-exit.test.ts");
  const hangFile = join(dir, "zz-ulcw-hang.test.ts");
  const driver = join(dir, "zz-ulcw-driver.mjs");
  await Deno.writeTextFile(passFile, `Deno.test("fixture: passes", () => {});\n`);
  await Deno.writeTextFile(
    exitFile,
    `Deno.test("fixture: exits non-zero", () => {\n  throw new Error("ULCW_EXIT_FAILURE");\n});\n`,
  );
  await Deno.writeTextFile(
    hangFile,
    `Deno.test("fixture: hangs", async () => {\n  setInterval(() => {}, 1000);\n  await new Promise(() => {});\n});\n`,
  );
  await Deno.writeTextFile(
    driver,
    `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
      `import { mkdirSync, readdirSync } from "node:fs";\n` +
      `const logDir = ${JSON.stringify(join(Deno.env.get("HOME") ?? "", "cap-evidence", "serial-phase-logs"))};\n` +
      `mkdirSync(logDir, { recursive: true });\n` +
      `const files = [process.argv[2], process.argv[3], process.argv[4]];\n` +
      `const opts = { stdio: "pipe", cwd: ${JSON.stringify(ROOT)}, timeoutMs: 120000, perFileTimeoutMs: { [process.argv[4]]: 2000 } };\n` +
      `const runs = [];\n` +
      // TWO calls in ONE process: the only shape that can prove the IN-PROCESS counter. Two separate
      // node processes would each start the counter at r1, which is exactly how the FIRST version of
      // this test was vacuous (it would have passed with the counter deleted).
      `for (let i = 0; i < 2; i++) {\n` +
      `  const before = new Set(readdirSync(logDir));\n` +
      `  const captured = [];\n` +
      `  const realLog = console.log;\n` +
      `  console.log = (...a) => captured.push(a.join(" "));\n` +
      `  const rc = runSerialFiles(files, opts);\n` +
      `  console.log = realLog;\n` +
      `  const text = captured.join("\\n");\n` +
      `  runs.push({\n` +
      `    rc,\n` +
      `    out: text,\n` +
      `    id: (text.match(/FAILED \\(2\\/3 failed\\) in \\d+s \\[run ([^\\]]+)\\]/) || [])[1] ?? null,\n` +
      `    added: readdirSync(logDir).filter((f) => !before.has(f) && f.includes("-p" + process.pid + "-")),\n` +
      `  });\n` +
      `}\n` +
      `console.log("ULCW_RUNS=" + JSON.stringify(runs));\n`,
  );
  const driverRun = await new Deno.Command("node", {
    args: [driver, passFile, exitFile, hangFile],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = decoder.decode(driverRun.stdout) + decoder.decode(driverRun.stderr);
  const runsLine = out.split("\n").find((l) => l.startsWith("ULCW_RUNS="));
  assert(runsLine, `the driver must report its two runs:\n${out}`);
  const runs = JSON.parse(runsLine.slice("ULCW_RUNS=".length)) as {
    rc: number;
    out: string;
    id: string | null;
    added: string[];
  }[];
  try {
    assertEquals(runs.length, 2, "the driver must make TWO calls in ONE process");
    // (1) THE COUNT, from the FIRST call's own captured output: two of three failed, BOTH named.
    const first = runs[0].out;
    assert(
      /serial phase \(3 build\/artifact files\) FAILED \(2\/3 failed\)/.test(first),
      `the count must be 2/3:\n${first}`,
    );
    const failingBlock = first.slice(first.indexOf("FAILING SERIAL FILE(S)"));
    assert(
      failingBlock.includes("zz-ulcw-exit.test.ts") && failingBlock.includes("zz-ulcw-hang.test.ts"),
      `both failing files must be named:\n${failingBlock}`,
    );
    assert(
      !failingBlock.includes("zz-ulcw-pass.test.ts"),
      `the passing file must not be blamed:\n${failingBlock}`,
    );
    assert(
      failingBlock.includes("exit 1") && failingBlock.includes("exit 124, TIMED OUT"),
      `the exit failure and the TIMEOUT must be distinguished:\n${failingBlock}`,
    );
    // (2) THE INVARIANT, per call: exactly one durable log per counted failure, EVERY one carrying that
    // call's run id - the count and its evidence are tied by one value, not inferred from a timestamp.
    for (const run of runs) {
      assertEquals(run.added.length, 2, `one durable log per counted failure (got ${JSON.stringify(run.added)})`);
      assert(run.id, `every call must print its run id:\n${run.out}`);
      for (const log of run.added) {
        assert(log.includes(run.id), `log ${log} must carry its own call's run id ${run.id}`);
      }
    }
    // (3) THE COUNTER, NOT THE CLOCK - what the first version of this test got WRONG: it ran each call
    // in a separate node process, so both ids ended -r1 and the assertion passed even with the counter
    // DELETED. Two calls in ONE process must be separated by the SEQUENCE.
    assert(/-r1$/.test(runs[0].id ?? ""), `the first call's run id must end in -r1 (got ${runs[0].id})`);
    assert(/-r2$/.test(runs[1].id ?? ""), `the second call in the SAME process must end in -r2 (got ${runs[1].id})`);
    assert(runs[0].id !== runs[1].id, `two calls must not share a run id (${runs[0].id} vs ${runs[1].id})`);
    // (4) the aggregator's contract is unchanged: first failing code.
    assertEquals(runs[0].rc, 1, `the aggregator must return the first failing code (got ${runs[0].rc})`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
