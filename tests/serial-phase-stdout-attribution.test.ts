// tests/serial-phase-stdout-attribution.test.ts — chrome-agent-platform-ia4z.
//
// The per-file failure notices and the named failing-file block must survive a
// STDOUT-ONLY capture. A gate consumer that keeps stdout and loses stderr must still be
// able to NAME the failing file, because a count without a name is how a red gets
// misattributed to whoever changed something — which happened twice on 2026-10-06
// (0iln's gate and o2t3's, where the name had to be recovered from the durable belt).
//
// Two failures are covered because they arrive by different paths: a non-zero exit and
// a per-file TIMEOUT kill. The timeout path matters most, because the surrounding gate
// is often killed at its own bound, so an end-of-phase-only mechanism loses the name.
//
// The fixtures live in the durable evidence root, never in tests/: a deliberately
// failing file inside tests/ would be collected by the suite it is meant to test.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const decoder = new TextDecoder();

async function runDriver(driver: string, args: string[]) {
  const { stdout, stderr } = await new Deno.Command("node", {
    args: [driver, ...args],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

Deno.test("ia4z: a failing serial file is NAMED in a STDOUT-ONLY capture, with its exit code", async () => {
  const dir = durableDir(`ia4z-stdout-${Deno.pid}`);
  const passFile = join(dir, "zz-ia4z-passing.test.ts");
  const failFile = join(dir, "zz-ia4z-failing.test.ts");
  const driver = join(dir, "zz-ia4z-driver.mjs");
  await Deno.writeTextFile(
    passFile,
    `Deno.test("fixture: passes", () => {\n  if (1 !== 1) throw new Error("unreachable");\n});\n`,
  );
  await Deno.writeTextFile(
    failFile,
    `Deno.test("fixture: deliberately fails", () => {\n  throw new Error("IA4Z_DELIBERATE_FAILURE");\n});\n`,
  );
  // The driver mirrors run-tests.mjs: the default stdio and the repo cwd, so the runner's
  // --config resolves. Its own marker line goes to stdout, which is the stream under test.
  await Deno.writeTextFile(
    driver,
    `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
      `const rc = runSerialFiles([process.argv[2], process.argv[3]], {\n` +
      `  stdio: "pipe",\n  cwd: ${JSON.stringify(ROOT)},\n  timeoutMs: 120000,\n});\n` +
      `console.log("IA4Z_DRIVER_RC=" + rc);\n`,
  );

  const { out, err } = await runDriver(driver, [passFile, failFile]);
  try {
    // THE FIX (ia4z): stdout ALONE carries the name, the exit code and the named block.
    assertStringIncludes(
      out,
      "zz-ia4z-failing.test.ts",
      `a stdout-only capture must name the failing serial file:\n${out}`,
    );
    assert(
      /FAILED \(exit [1-9][0-9]*/.test(out),
      `a stdout-only capture must carry the failing file's exit code:\n${out}`,
    );
    const blockAt = out.indexOf("FAILING SERIAL FILE(S)");
    assert(blockAt >= 0, `a stdout-only capture must carry the named failing-file block, not only a count:\n${out}`);
    // The block's OWN entries must name the file on stdout: the per-file FAILED line above already
    // contains the name, so asserting the name anywhere in stdout would pass even if the block's
    // entries were reverted to stderr only (reviewer P2).
    assertStringIncludes(
      out.slice(blockAt),
      "zz-ia4z-failing.test.ts",
      `the named block itself must name the failing file on stdout:\n${out.slice(blockAt)}`,
    );
    // stderr keeps both, because a human running the command reads it there (coord's ask).
    assertStringIncludes(err, "zz-ia4z-failing.test.ts", `stderr must still name the file:\n${err}`);
    assertStringIncludes(err, "FAILING SERIAL FILE(S)", `stderr must still carry the block:\n${err}`);
    // And the passing file is not blamed on either stream.
    assert(!out.includes("zz-ia4z-passing.test.ts FAILED"), "the passing file must not be blamed");
    assert(!err.includes("zz-ia4z-passing.test.ts FAILED"), "the passing file must not be blamed");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ia4z: a per-file TIMEOUT is NAMED in a STDOUT-ONLY capture too", async () => {
  const dir = durableDir(`ia4z-stdout-timeout-${Deno.pid}`);
  const hung = join(dir, "zz-ia4z-hung.test.ts");
  const driver = join(dir, "zz-ia4z-timeout-driver.mjs");
  // A never-resolving promise does NOT hold Deno's event loop, so the fixture sometimes
  // exits 1 all by itself and the case never exercises the timeout path (measured: 2 of 5
  // runs). A sleep longer than the per-file bound keeps a real timer pending, so the BOUND
  // is what ends it — the same shape dsoq's timeout fixture uses.
  await Deno.writeTextFile(
    hung,
    `Deno.test("fixture: sleeps past the bound", async () => {\n  await new Promise((r) => setTimeout(r, 30000));\n});\n`,
  );
  await Deno.writeTextFile(
    driver,
    `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
      `const hung = process.argv[2];\n` +
      `const rc = runSerialFiles([hung], {\n` +
      `  stdio: "pipe",\n  cwd: ${JSON.stringify(ROOT)},\n  timeoutMs: 60000,\n` +
      `  perFileTimeoutMs: { [hung]: 2000 },\n});\n` +
      `console.log("IA4Z_DRIVER_RC=" + rc);\n`,
  );

  const { out, err } = await runDriver(driver, [hung]);
  try {
    assertStringIncludes(
      out,
      "zz-ia4z-hung.test.ts",
      `a stdout-only capture must name the timed-out file (this is the path a bound-killed gate sees):\n${out}`,
    );
    // "TIMED OUT after" is the IMMEDIATE runner notice's wording; the loop's later line says
    // "FAILED (exit 124, TIMED OUT) in ...". Asserting only the latter would pass even if the
    // immediate notice were reverted to stderr (reviewer P2).
    assertStringIncludes(
      out,
      "TIMED OUT after",
      `a stdout-only capture must carry the immediate TIMED OUT notice, not only the later FAILED line:\n${out}`,
    );
    assert(
      /FAILED \(exit 124/.test(out),
      `a stdout-only capture must also carry the exit code for the timeout kill:\n${out}`,
    );
    assertStringIncludes(err, "zz-ia4z-hung.test.ts", `stderr must still name the timed-out file:\n${err}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// chrome-agent-platform-tn7wh: the serial phase must publish what each file COST, on the passing path
// too. Before this, runSerialFiles computed the per-file elapsed time and printed it only when a file
// failed, so a green gate log said "the phase took 103s" and nothing about the three files inside it.
// The two windows in SERIAL_FILE_TIMEOUTS are supposed to be MEASURED WORK x ~3 (test-partition.mjs),
// and with no per-file number on success there was nothing to re-measure them against — which is how
// they came to be sized against builds the files no longer run. This asserts the emission contract
// that makes the next re-measurement mechanical: one grep over any gate log.
Deno.test("tn7wh: every serial file reports its own duration on the PASSING path too", async () => {
  const dir = durableDir(`tn7wh-durations-${Deno.pid}`);
  const passFile = join(dir, "zz-tn7wh-passing.test.ts");
  const failFile = join(dir, "zz-tn7wh-failing.test.ts");
  const driver = join(dir, "zz-tn7wh-driver.mjs");
  await Deno.writeTextFile(
    passFile,
    `Deno.test("fixture: passes", () => {\n  if (1 !== 1) throw new Error("unreachable");\n});\n`,
  );
  // The failing fixture is present ON PURPOSE: it is what puts the named FAILING SERIAL FILE(S) block
  // in the output, so the test can prove the passing file's duration line is not inside it. A report
  // that named the passing file in the failure block would be the misattribution this suite exists
  // to prevent.
  await Deno.writeTextFile(
    failFile,
    `Deno.test("fixture: deliberately fails", () => {\n  throw new Error("TN7WH_DELIBERATE_FAILURE");\n});\n`,
  );
  await Deno.writeTextFile(
    driver,
    `import { runSerialFiles } from ${JSON.stringify(join(ROOT, "scripts/lib/serial-phase.mjs"))};\n` +
      `const rc = runSerialFiles([process.argv[2], process.argv[3]], {\n` +
      `  stdio: "pipe",\n  cwd: ${JSON.stringify(ROOT)},\n  timeoutMs: 120000,\n});\n` +
      `console.log("TN7WH_DRIVER_RC=" + rc);\n`,
  );

  const { out } = await runDriver(driver, [passFile, failFile]);
  try {
    // The passing file's own cost is printed, named, and numeric. `\S+` because a serial file is
    // named by path; the duration is to ONE decimal, the same resolution the failure line uses, so a
    // re-measurement does not have to round before comparing.
    const durations = [...out.matchAll(/run-tests: serial file (\S+) (GREEN|FAILED|REFUSED)[^\n]*? in ([\d.]+)s/g)];
    const passLine = durations.find((m) => m[1] === passFile);
    assert(
      passLine,
      `the passing serial file must report its own duration on success (tn7wh); got: ${JSON.stringify(durations.map((m) => m[0]))}`,
    );
    assertEquals(passLine[2], "GREEN", `the passing file's line must not be a failure verdict: ${passLine[0]}`);
    assert(
      Number(passLine[3]) > 0 && Number.isFinite(Number(passLine[3])),
      `the reported duration must be a real measurement, got ${passLine[3]}`,
    );
    // grep-ability is the contract: one line per file, in the shape the window table cites.
    assert(
      /^run-tests: serial file /m.test(passLine[0]),
      `the duration must be its own greppable line, got ${JSON.stringify(passLine[0])}`,
    );
    // A duration is not a verdict: the word FAILED next to a PASSING file is what the attribution
    // tests treat as blame, so the success line must never carry it.
    assert(
      !passLine[0].includes("FAILED"),
      `the passing file's duration line must not read as blame: ${passLine[0]}`,
    );
    const blockAt = out.indexOf("FAILING SERIAL FILE(S)");
    if (blockAt >= 0) {
      assert(
        !out.slice(blockAt).includes(passFile),
        `the passing file's duration must not be listed in the failure block:\n${out.slice(blockAt)}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
