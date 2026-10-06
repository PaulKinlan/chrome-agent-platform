// tests/select-tests-always-on.test.ts — chrome-agent-platform-kz27.
//
// THE DEFECT: a subset gate cannot see a guard that reads tracked source as data (no static import
// edges), so BOTH failure modes hide them — a FAIL-CLOSED selector (which was the whole of jfbn's
// gate) and a serial failure that skips the parallel phase. Two guard violations reached main from one
// landing while every gate reported green, because the guards never ran.
//
// This test pins the two guarantees the bead's acceptance asks for:
//   1. A FAIL-CLOSED selection SURFACES the always-on guard set, so a lane knows exactly what a subset
//      gate just failed to cover (a bare "FULL_SUITE" tells it nothing).
//   2. The set is runnable on its own, by name, without the selector choosing it.
// It also pins the LIST ADDITION that made the gap visible: four tree-walking guards, including
// tests/durable-root.test.ts, were missing from ALWAYS_ON.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { alwaysOnGuards, failClosedPlan, SOURCE_INSPECTING_GUARDS } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("kz27: the four tree-walking guards are IN the always-on list, and every entry exists", () => {
  for (
    const guard of [
      "tests/durable-root.test.ts",
      "tests/chrome-profile-location.test.ts",
      "tests/dialog-confirm-modernization.test.ts",
      "tests/single-source-helpers.test.ts",
    ]
  ) {
    assert(
      SOURCE_INSPECTING_GUARDS.includes(guard),
      `${guard} reads the repo tree as data and must be always-on (kz27)`,
    );
  }
  // A list is only a list if its members are real: an entry naming a file that does not exist would
  // "cover" nothing while looking reassuring.
  for (const file of SOURCE_INSPECTING_GUARDS) {
    assert(existsSync(join(ROOT, file)), `always-on guard ${file} must exist on disk`);
  }
});

Deno.test("kz27: a FAIL-CLOSED selection NAMES the always-on guard set it could not cover", () => {
  const plan = failClosedPlan({ uncovered: ["scripts/merge-closing-block.sh"], list: true });
  assertEquals(plan.action, "list", "with --list the caller prints FULL_SUITE and runs nothing");
  const text = plan.output.join("\n");
  assertStringIncludes(text, "FAIL CLOSED");
  assertStringIncludes(text, "scripts/merge-closing-block.sh");
  assertStringIncludes(text, "FULL_SUITE".replace("FULL_SUITE", "FULL suite")); // the message, not the token
  // THE REGRESSION: every always-on guard is named, so a lane can run them explicitly. Before kz27
  // the fail-closed path printed a file list and "FULL_SUITE" and nothing about the guards.
  for (const guard of alwaysOnGuards()) {
    assert(text.includes(guard), `the fail-closed report must name the guard ${guard}`);
  }
  assert(
    text.includes("tests/durable-root.test.ts"),
    "durable-root must be named: it is the guard whose absence from ALWAYS_ON hid a real violation",
  );
});

Deno.test("kz27: the always-on set is runnable by name (--always-on) without the selector choosing it", async () => {
  // node, not process.execPath: under deno that is the DENO binary, which then refuses the script's
  // env access (measured: NotCapable on CAP_PARALLEL_TEST_TIMEOUT_MS). This mirrors production, where
  // npm runs the selector with node.
  const { code, stdout, stderr } = await new Deno.Command("node", {
    args: ["scripts/select-tests.mjs", "--list", "--always-on"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0, `--always-on --list must succeed: ${new TextDecoder().decode(stderr)}`);
  const listed = out.split("\n").map((l) => l.trim()).filter(Boolean);
  assertEquals(listed, alwaysOnGuards(), "--always-on --list must print exactly the always-on set");
  assert(
    listed.includes("tests/durable-root.test.ts"),
    "durable-root must be in the set, so a lane can run it explicitly (kz27)",
  );
});
