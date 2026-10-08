// tests/type-check.test.ts — gate-speed (2026-10-08): the up-front type check that lets the serial
// and parallel phases run with --no-check (scripts/lib/type-check.mjs, scripts/run-tests.mjs).
// The property: moving the type check must not weaken it. A file that PASSES at runtime but does not
// type-check must still fail `npm test`, and the check must cover every file the run executes.
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { typeCheckArgs } from "../scripts/lib/type-check.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

Deno.test("gate-speed: the up-front check is `deno check` with the runner config over exactly the given files", () => {
  assertEquals(typeCheckArgs(["tests/a.test.ts", "tests/b.test.ts"]), [
    "check", "--config", "deno.runner.jsonc", "tests/a.test.ts", "tests/b.test.ts",
  ]);
});

async function runTests(files: string[]) {
  const { code, stdout, stderr } = await new Deno.Command("node", {
    args: ["scripts/run-tests.mjs", ...files],
    cwd: ROOT,
    env: { CAP_TEST_JOBS: "2" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, out: new TextDecoder().decode(stdout), err: new TextDecoder().decode(stderr) };
}

Deno.test("gate-speed: a file that passes at runtime but fails the type check still FAILS the run", async () => {
  const dir = await durableDir(`gate-speed-typecheck-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const bad = `${dir}/zz-type-error.test.ts`;
  await Deno.writeTextFile(
    bad,
    `const n: number = "not a number";\nDeno.test("fixture: passes at runtime", () => { if (typeof n !== "string") throw new Error("unreachable"); });\n`,
  );
  try {
    const { code, out, err } = await runTests([bad, "tests/vocabulary.test.ts"]);
    assertNotEquals(code, 0, `a type error must fail the run:\n${out}\n${err}`);
    assertStringIncludes(out, "type-checking 2 file(s) up front", "the check covers every file the run executes");
    assertStringIncludes(out + err, "TYPE CHECK FAILED", "the failure is named as a type-check failure");
    assertStringIncludes(out + err, "TS2322", "the compiler's own diagnostic is printed");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("gate-speed: a green check runs the phases with --no-check and the run stays green", async () => {
  const { code, out, err } = await runTests(["tests/vocabulary.test.ts", "tests/parallel-plan.test.ts"]);
  assertEquals(code, 0, `expected a green run:\n${out}\n${err}`);
  assertStringIncludes(out, "type-checking 2 file(s) up front");
  assertStringIncludes(out, "type check GREEN (2 file(s))");
  assert(!out.includes("TYPE CHECK FAILED"), out);
});
