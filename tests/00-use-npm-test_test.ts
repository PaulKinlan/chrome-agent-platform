// tests/00-use-npm-test_test.ts — a raw `deno test tests/` sweep stops here.
//
// Paul, 2026-09-04: agents kept running the raw serial sweep after every edit
// even though AGENTS.md said not to; docs are not teeth. The auto-discovered
// deno.jsonc excludes tests/*.test.ts, so a raw sweep loads ONLY this module
// (named *_test.ts on purpose), which prints the right commands and fails at
// once. The repo's runners pass `--config deno.runner.jsonc` and export
// CAP_TEST_RUNNER=1, so under them this module is a no-op that holds its pins:
//
//   npm test                                 the full suite (two-phase, ~90 s)
//   npm run test:changed                     the tests your change reaches
//   npm run test:file -- tests/<name>.test.ts one file
//
// @ts-nocheck — the guard runs at module evaluation.

export const RUNNER_ENV = "CAP_TEST_RUNNER";

export function refusalMessage() {
  return [
    "",
    "deno test refused: a raw whole-suite sweep runs the files serially for minutes and is not the gate.",
    "Use the repo's runners (they pass --config deno.runner.jsonc so every file is seen):",
    "  npm test                                 the full suite (two-phase, parallel where safe, ~90 s)",
    "  npm run test:changed                     the tests your change reaches, plus the security core",
    "  npm run test:file -- tests/<name>.test.ts one file",
    "See AGENTS.md → Testing.",
    "",
  ].join("\n");
}

if (Deno.env.get(RUNNER_ENV) !== "1") {
  console.error(refusalMessage());
  throw new Error("deno test refused: use npm test / npm run test:changed / npm run test:file");
}

// ---- pins (only reachable through the runner) ----
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("guard: deno.jsonc hides tests/*.test.ts from raw sweeps; deno.runner.jsonc keeps npm resolution", async () => {
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "");
  const auto = JSON.parse(strip(await Deno.readTextFile(`${ROOT}deno.jsonc`)));
  assertEquals(auto.test.exclude, ["tests/*.test.ts"]);
  const runner = JSON.parse(strip(await Deno.readTextFile(`${ROOT}deno.runner.jsonc`)));
  assertEquals(runner.nodeModulesDir, "manual");
  assertEquals(runner.lock, false, "runner runs must never rewrite deno.lock (an explicit --config strips the npm entries)");
  assertEquals(auto.nodeModulesDir, "manual", "both configs resolve npm deps the same way");
  const pkg = JSON.parse(await Deno.readTextFile(`${ROOT}package.json`));
  for (const key of ["test:file", "test:tools"]) {
    assertStringIncludes(pkg.scripts[key], "--config deno.runner.jsonc", `${key} must bypass the exclude`);
    assertStringIncludes(pkg.scripts[key], `${RUNNER_ENV}=1`, `${key} must carry the runner marker so this guard stands down`);
  }
  for (const runner of ["scripts/run-tests.mjs", "scripts/select-tests.mjs"]) {
    const src = await Deno.readTextFile(`${ROOT}${runner}`);
    assertStringIncludes(src, "deno.runner.jsonc", `${runner} must pass the runner config`);
    assertStringIncludes(src, RUNNER_ENV, `${runner} must export the runner marker`);
  }
});

Deno.test("guard: a real raw sweep fails at once with the runner commands and runs nothing else; the runner sees everything", async () => {
  // A throwaway repo: the two configs, this guard, and one trivial *.test.ts,
  // swept the way an agent types it. RED raw, GREEN through the runner.
  const dir = await Deno.makeTempDir({ prefix: "cap-guard-" });
  await Deno.mkdir(`${dir}/tests`);
  await Deno.copyFile(`${ROOT}deno.jsonc`, `${dir}/deno.jsonc`);
  await Deno.copyFile(`${ROOT}deno.runner.jsonc`, `${dir}/deno.runner.jsonc`);
  const guard = (await Deno.readTextFile(new URL(import.meta.url))).split("// ---- pins")[0];
  await Deno.writeTextFile(`${dir}/tests/00-use-npm-test_test.ts`, guard);
  await Deno.writeTextFile(`${dir}/tests/zz.test.ts`, 'Deno.test("trivial", () => { console.log("TRIVIAL RAN"); });\n');
  const run = async (args, env) => {
    const t0 = performance.now();
    const out = await new Deno.Command(Deno.execPath(), { args, cwd: dir, env, stdout: "piped", stderr: "piped" }).output();
    return { code: out.code, ms: performance.now() - t0, text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
  };
  try {
    const raw = await run(["test", "-A", "tests/"], { [RUNNER_ENV]: "" });
    assert(raw.code !== 0, "a raw sweep must fail");
    assertStringIncludes(raw.text, "deno test refused");
    assertStringIncludes(raw.text, "npm run test:changed");
    assert(!raw.text.includes("TRIVIAL RAN"), "no other test may run in a raw sweep");
    assert(raw.ms < 15_000, `a raw sweep must fail fast, took ${raw.ms.toFixed(0)} ms`);
    const viaRunner = await run(["test", "-A", "--config", "deno.runner.jsonc", "tests/"], { [RUNNER_ENV]: "1" });
    assertEquals(viaRunner.code, 0, `runner sweep must pass; got ${viaRunner.code}: ${viaRunner.text.slice(0, 400)}`);
    assertStringIncludes(viaRunner.text, "TRIVIAL RAN");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
