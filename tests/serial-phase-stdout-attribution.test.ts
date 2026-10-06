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
import { assert, assertStringIncludes } from "jsr:@std/assert@1";
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
