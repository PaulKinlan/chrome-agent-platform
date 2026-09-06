// tests/package-scripts-exist.test.ts — every file an npm script invokes exists
// (chrome-agent-platform-i845).
//
// chrome-agent-platform-raou deleted scripts/check-tasks.mjs (the gate that
// checked the layout of a task file retired on 2026-09-02) but left package.json
// pointing at it twice: `check:tasks` and the FIRST step of `test:all`. Both
// exited 1 with MODULE_NOT_FOUND from that commit on, so the documented
// everything-gate was unrunnable and nobody noticed — harness-registry.test.ts
// checks the `npm run …` steps of test:all against the harness registry, but
// a bare `node scripts/…` step, and any `check:*` script, were nobody's.
//
// The rule: a path under scripts/ that appears in an npm script value is a file
// on disk, and every `npm run <name>` step inside a script names a script that
// exists. Mechanical, so the next deletion cannot leave a dangling command.

import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("../", import.meta.url).pathname;
const pkg = JSON.parse(Deno.readTextFileSync(`${ROOT}package.json`));
const scripts: Record<string, string> = pkg.scripts ?? {};

/** Paths under scripts/ that a command line invokes: after a separator or at
 *  the start, up to the next shell separator or quote. Globs are not files. */
function scriptRefs(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/(?:^|[\s&|;(])((?:\.\/)?scripts\/[^\s&|;)"']+)/g)) {
    if (!m[1]!.includes("*")) out.push(m[1]!.replace(/^\.\//, ""));
  }
  return out;
}

/** The `npm run <name>` steps of a command line. */
function npmRunSteps(cmd: string): string[] {
  return [...cmd.matchAll(/\bnpm run ([^\s&|;]+)/g)].map((m) => m[1]!);
}

const exists = (rel: string) => {
  try { return Deno.statSync(`${ROOT}${rel}`).isFile; } catch { return false; }
};

Deno.test("i845 detector honesty: the extractor sees every invocation shape and ignores what is not a file", () => {
  assertEquals(scriptRefs("node scripts/a.mjs"), ["scripts/a.mjs"]);
  assertEquals(scriptRefs("deno run -A scripts/b.ts -- --flag"), ["scripts/b.ts"]);
  assertEquals(scriptRefs("bash ./scripts/c.sh"), ["scripts/c.sh"]);
  assertEquals(scriptRefs("node scripts/x.mjs && npm run y && deno run -A scripts/z.ts"), ["scripts/x.mjs", "scripts/z.ts"]);
  assertEquals(scriptRefs("node scripts/lib/d.mjs --check"), ["scripts/lib/d.mjs"]);
  assertEquals(scriptRefs("node build.mjs --target=store"), [], "a root file is not a scripts/ reference");
  assertEquals(scriptRefs("npm run check:vocabulary && npm test"), [], "npm steps reference names, not files");
  assertEquals(scriptRefs("deno test -A scripts/*.test.ts"), [], "a glob is not a file");
  assertEquals(npmRunSteps("node scripts/x.mjs && npm run a && npm test && npm run b:c"), ["a", "b:c"]);
});

Deno.test("i845: every scripts/ file an npm script invokes exists on disk", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const ref of scriptRefs(cmd)) {
      seen++;
      if (!exists(ref)) missing.push(`${name} → ${ref}`);
    }
  }
  assertEquals(missing, [], "an npm script points at a file that is not there — delete the script or the reference with the file");
  assert(seen >= 30, `the extractor still sees the repo's script references (${seen})`);
});

Deno.test("i845: every `npm run <name>` step inside a script names a script that exists", () => {
  const dangling: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const step of npmRunSteps(cmd)) if (!(step in scripts)) dangling.push(`${name} → npm run ${step}`);
  }
  assertEquals(dangling, []);
});

Deno.test("i845: test:all starts with a real gate — nothing checks the retired task file's layout any more", () => {
  const all = scripts["test:all"];
  assert(typeof all === "string" && all.length > 0, "test:all is defined");
  const steps = all.split("&&").map((s) => s.trim()).filter(Boolean);
  assert(steps.length >= 5, `test:all is the everything-gate (${steps.length} steps)`);
  assert(!/check-tasks|check:tasks/.test(all), "the retired task-file gate is gone from test:all");
  assert(!("check:tasks" in scripts), "no check:tasks script survives (the task file is retired history)");
  const first = steps[0]!;
  const firstRun = npmRunSteps(first)[0];
  assert(
    firstRun ? firstRun in scripts : scriptRefs(first).every(exists),
    `test:all's first step is runnable: ${first}`,
  );
});
