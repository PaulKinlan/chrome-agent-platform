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
    ? `import { runParallel } from ${JSON.stringify(join(ROOT, "scripts/run-tests.mjs"))};\n` +
      `const rc = runParallel([process.argv[2]], { timeoutMs: 2500 });\n`
    : `process.env.CAP_PARALLEL_TEST_TIMEOUT_MS = "2500";\n` +
      `const { runPartitioned } = await import(${JSON.stringify(join(ROOT, "scripts/select-tests.mjs"))});\n` +
      `const rc = runPartitioned([process.argv[2]]);\n`;
  await Deno.writeTextFile(driver, target + `console.log("WEFF_DRIVER_RC=" + rc);\n`);
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

for (const site of ["run-tests", "select-tests"] as const) {
  Deno.test(`weff: ${site} parallel timeout names candidates in a STDOUT-ONLY capture`, async () => {
    const { code, out, name } = await drive(site);
    assertEquals(code, 0, `driver should report its phase result without hiding a crash:\n${out}`);
    const prefix = site + ":";
    const notice = `${prefix} parallel phase TIMED OUT after`;
    const block = `${prefix} TIMED-OUT PARALLEL PHASE CANDIDATE FILE(S)`;
    assertStringIncludes(out, `${prefix} parallel phase candidates`, `the pre-phase candidate list must survive a mid-phase kill:\n${out}`);
    assertStringIncludes(out.split(notice)[0], name, `the pre-phase list must name the candidate:\n${out}`);
    assertStringIncludes(out, notice, `the immediate timeout notice, not only a later summary, must reach stdout:\n${out}`);
    assertStringIncludes(out, block, `stdout must carry the named timeout block:\n${out}`);
    assertStringIncludes(out.slice(out.indexOf(block)), name, `the block itself must name its candidate:\n${out}`);
    assertStringIncludes(out, "culprit unconfirmed", `do not call every parallel candidate a proven failure:\n${out}`);
    assertStringIncludes(out, "WEFF_DRIVER_RC=124", `the fixture must actually hit the phase timeout:\n${out}`);
    assert(!out.includes(`${site === "run-tests" ? "select-tests" : "run-tests"}: parallel phase TIMED OUT after`),
      `the other site's notice must not satisfy this pin:\n${out}`);
  });
}
