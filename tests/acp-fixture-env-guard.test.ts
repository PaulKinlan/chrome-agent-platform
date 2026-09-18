// tests/acp-fixture-env-guard.test.ts — chrome-agent-platform-tqfg:
// Guard: no test file may publish CAP_ACP_FIXTURE_* through process environment.
//
// `deno test --parallel` runs all test files in ONE process. Any `Deno.env.set`
// of a CAP_ACP_FIXTURE_* variable pollutes the process environment and is
// silently inherited by concurrent adapter spawns. jp78 fixed this in
// tests/acp-runner.test.ts by passing childEnv to createAcpServer. This guard
// prevents the reverse leak from ever returning by failing closed if any test file
// sets a fixture knob on Deno.env.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";

const TESTS_DIR = fromFileUrl(new URL(".", import.meta.url));

/** Strip single-line (//) and multi-line (/* ... *\/) comments, preserving string literals */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

/** Check whether code contains active Deno.env.set calls for CAP_ACP_FIXTURE_* */
export function findFixtureEnvSetters(code: string): string[] {
  const stripped = stripComments(code);
  const pattern = /\bDeno\.env\.set\s*\(\s*(["'`])(CAP_ACP_FIXTURE_[A-Z0-9_]+)\1/g;
  const matches: string[] = [];
  for (const m of stripped.matchAll(pattern)) {
    matches.push(m[2]);
  }
  return matches;
}

Deno.test("guard: no test file may publish CAP_ACP_FIXTURE_* through process env (Deno.env.set)", () => {
  const offenders: string[] = [];

  for (const entry of Deno.readDirSync(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".test.ts")) continue;
    // Skip this guard test itself
    if (entry.name === "acp-fixture-env-guard.test.ts") continue;

    const fullPath = `${TESTS_DIR}/${entry.name}`;
    const content = Deno.readTextFileSync(fullPath);
    const setters = findFixtureEnvSetters(content);
    if (setters.length > 0) {
      offenders.push(`${entry.name}: sets [${setters.join(", ")}]`);
    }
  }

  assertEquals(
    offenders,
    [],
    `Test files must NOT mutate process environment with CAP_ACP_FIXTURE_* (use createAcpServer childEnv instead):\n${offenders.join("\n")}`,
  );
});

Deno.test("tqfg detector honesty: scanner detects Deno.env.set across syntax variants and ignores comment citations", () => {
  const syntheticWithSets = `
    // This is a comment citing Deno.env.set("CAP_ACP_FIXTURE_LOG", "log")
    /* Multi-line comment citing Deno.env.set('CAP_ACP_FIXTURE_HOLD_TEXT', "hold") */
    function setup() {
      Deno.env.set("CAP_ACP_FIXTURE_LOG", "/path/to/log");
      Deno.env.set('CAP_ACP_FIXTURE_HOLD_TEXT', 'held');
      Deno.env.set(\`CAP_ACP_FIXTURE_DIE_ON_SPAWN\`, '1');
    }
  `;

  const detected = findFixtureEnvSetters(syntheticWithSets);
  assertEquals(detected, [
    "CAP_ACP_FIXTURE_LOG",
    "CAP_ACP_FIXTURE_HOLD_TEXT",
    "CAP_ACP_FIXTURE_DIE_ON_SPAWN",
  ]);

  const commentsOnly = `
    // Deno.env.set("CAP_ACP_FIXTURE_LOG", "1")
    /* Deno.env.set('CAP_ACP_FIXTURE_ASK_PERMISSION', '1') */
  `;
  assertEquals(findFixtureEnvSetters(commentsOnly), []);
});
