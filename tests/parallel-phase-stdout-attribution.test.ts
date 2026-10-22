// weff: the parallel-phase timeout must name its candidate file(s) on stdout
// even if a consumer discards stderr. Deno schedules files concurrently, so a
// timeout cannot honestly claim which candidate was the culprit.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const decoder = new TextDecoder();

async function drive(site: "run-tests" | "select-tests") {
  const dir = durableDir(`weff-${site}-${Deno.pid}`);
  const hung = join(dir, `zz-weff-${site}-hung.test.ts`);
  const driver = join(dir, `zz-weff-${site}-driver.mjs`);
  await Deno.writeTextFile(hung,
    `Deno.test("fixture: holds the event loop past the phase bound", async () => {\n` +
      `  await new Promise((resolve) => setTimeout(resolve, 30000));\n});\n`);
  const target = site === "run-tests"
    ? `process.env.CAP_PARALLEL_TEST_TIMEOUT_MS = "2500";\n` +
      `const { main } = await import(${JSON.stringify(join(ROOT, "scripts/run-tests.mjs"))});\n` +
      `await main([process.argv[2]]);\n` // main exits 124; its CLI-file seam runs just the hung fixture.
    : `process.env.CAP_PARALLEL_TEST_TIMEOUT_MS = "2500";\n` +
      `const { runPartitioned } = await import(${JSON.stringify(join(ROOT, "scripts/select-tests.mjs"))});\n` +
      `const rc = await runPartitioned([process.argv[2]]);\n` +
      `console.log("WEFF_DRIVER_RC=" + rc);\n`;
  await Deno.writeTextFile(driver, target);
  try {
    // STDERR is deliberately thrown away, not consulted to satisfy assertions.
    const { code, stdout } = await new Deno.Command("node", {
      args: [driver, hung], cwd: ROOT, stdout: "piped", stderr: "null",
    }).output();
    return { code, out: decoder.decode(stdout), name: hung.split("/").at(-1)! };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("weff: a symlinked run-tests entry cannot exit green without running the gate", async () => {
  const dir = durableDir(`weff-main-guard-${Deno.pid}`);
  const link = join(dir, "zz-weff-run-tests-link.mjs");
  const driver = join(dir, "zz-weff-main-guard-driver.mjs");
  await Deno.symlink(join(ROOT, "scripts/run-tests.mjs"), link);
  await Deno.writeTextFile(driver,
    `import { isRunTestsEntry } from ${JSON.stringify(join(ROOT, "scripts/run-tests.mjs"))};\n` +
      `console.log("WEFF_SYMLINK_ENTRY=" + isRunTestsEntry(process.argv[2]));\n` +
      `console.log("WEFF_IMPORTED_DRIVER=" + isRunTestsEntry(process.argv[1]));\n`);
  try {
    const { code, stdout } = await new Deno.Command("node", {
      args: [driver, link], cwd: ROOT, stdout: "piped", stderr: "null",
    }).output();
    const out = decoder.decode(stdout);
    assertEquals(code, 0, `the guard probe must not crash:\n${out}`);
    assertStringIncludes(out, "WEFF_SYMLINK_ENTRY=true", "a symlinked entry must run the gate");
    assertStringIncludes(out, "WEFF_IMPORTED_DRIVER=false", "importing the module must not launch the full suite");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

for (const site of ["run-tests", "select-tests"] as const) {
  Deno.test(`weff: ${site} parallel timeout names candidates in a STDOUT-ONLY capture`, async () => {
    const { code, out, name } = await drive(site);
    assertEquals(code, site === "run-tests" ? 124 : 0, `driver must report the timed-out phase result:\n${out}`);
    const prefix = site + ":";
    const notice = `${prefix} parallel phase TIMED OUT after`;
    const block = `${prefix} TIMED-OUT PARALLEL PHASE CANDIDATE FILE(S)`;
    assertStringIncludes(out, `${prefix} parallel phase candidates`, `the pre-phase candidate list must survive a mid-phase kill:\n${out}`);
    assertStringIncludes(out.split(notice)[0], name, `the pre-phase list must name the candidate:\n${out}`);
    assertStringIncludes(out, notice, `the immediate timeout notice, not only a later summary, must reach stdout:\n${out}`);
    assertStringIncludes(out, block, `stdout must carry the named timeout block:\n${out}`);
    assertStringIncludes(out.slice(out.indexOf(block)), name, `the block itself must name its candidate:\n${out}`);
    assertStringIncludes(out, "culprit unconfirmed", `do not call every parallel candidate a proven failure:\n${out}`);
    if (site === "run-tests") {
      assertStringIncludes(out, "run-tests: 1 files total", `the full-gate CLI-file path must reach its summary:\n${out}`);
      // jtrny: a phase killed by its own bound must say HOW FAR IT GOT, and the summary must not read as a
      // completion. The old code printed no status line for a timed-out phase, so the only
      // completion-shaped line left in a real gate log was this summary ("N files total ... wall Xs") — two
      // agents read a 15%-done starved phase as a finished suite plus a mysterious 568s POST-TEST tail.
      assertStringIncludes(
        out,
        "run-tests: parallel phase progress at the kill: 0 of 1 file(s) completed a test, 1 produced no completed result",
        `a killed phase must state what it measurably achieved:\n${out}`,
      );
      assertStringIncludes(
        out,
        "run-tests: parallel phase (1 files) TIMED-OUT in",
        `a killed phase must print a status line of its own shape, not only the planner summary:\n${out}`,
      );
      assertStringIncludes(
        out,
        "— INCOMPLETE: parallel phase killed at its 2.5s bound",
        `the planner summary must refuse to read as completion when a phase was killed:\n${out}`,
      );
    } else {
      assertStringIncludes(out, "WEFF_DRIVER_RC=124", `the selector fixture must hit its phase timeout:\n${out}`);
    }
    assert(!out.includes(`${site === "run-tests" ? "select-tests" : "run-tests"}: parallel phase TIMED OUT after`),
      `the other site's notice must not satisfy this pin:\n${out}`);
  });
}

Deno.test("w9kty: select-tests runPartitioned maps child SIGKILL to 137 and SIGTERM to 143", async () => {
  const dir = durableDir(`w9kty-sig-${Deno.pid}`);
  const killFile = join(dir, "zz-w9kty-kill.test.ts");
  const termFile = join(dir, "zz-w9kty-term.test.ts");
  const driver = join(dir, "zz-w9kty-driver.mjs");
  await Deno.writeTextFile(killFile, `Deno.test("k", () => { Deno.kill(Deno.pid, "SIGKILL"); });\n`);
  await Deno.writeTextFile(termFile, `Deno.test("t", () => { Deno.kill(Deno.pid, "SIGTERM"); });\n`);
  await Deno.writeTextFile(driver,
    `const { runPartitioned } = await import(${JSON.stringify(join(ROOT, "scripts/select-tests.mjs"))});\n` +
    `const target = process.argv[2];\n` +
    `const rc = await runPartitioned([target]);\n` +
    `console.log("W9KTY_RC=" + rc);\n`);
  try {
    const { code: codeKill, stdout: outKill } = await new Deno.Command("node", {
      args: [driver, killFile], cwd: ROOT, stdout: "piped", stderr: "null",
    }).output();
    assertEquals(codeKill, 0, "driver must exit cleanly");
    assertStringIncludes(decoder.decode(outKill), "W9KTY_RC=137", "select-tests must map SIGKILL to 137");

    const { code: codeTerm, stdout: outTerm } = await new Deno.Command("node", {
      args: [driver, termFile], cwd: ROOT, stdout: "piped", stderr: "null",
    }).output();
    assertEquals(codeTerm, 0, "driver must exit cleanly");
    assertStringIncludes(decoder.decode(outTerm), "W9KTY_RC=143", "select-tests must map SIGTERM to 143");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
