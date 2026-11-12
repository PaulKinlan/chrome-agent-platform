// tests/build-gate-static.test.ts — static structural tests for scripts/build-gate.ts (chrome-agent-platform-h65e).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { main } from "../scripts/build-gate.ts";
import { BUILD_GATE_FILES } from "../scripts/test-partition.mjs";

Deno.test("build-gate static: exports main function and matches BUILD_GATE_FILES", () => {
  assertEquals(typeof main, "function");
  assert(BUILD_GATE_FILES.length >= 3);
  assert(BUILD_GATE_FILES.includes("tests/build-bootstrap.test.ts"));
  assert(BUILD_GATE_FILES.includes("tests/build-debug-mode.test.ts"));
  assert(BUILD_GATE_FILES.includes("tests/build-tool-bundling.test.ts"));
});

// ── y4lbe: an environmental refusal is narrated as a REFUSAL, never "FAILED with exit code 75" ──
// The tier a lane reads FIRST must not call a refusal a failure (the combined
// top-level code already re-combines correctly; this pins the lane-facing line).

import { durableDir } from "../scripts/lib/durable-root.mjs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

async function runBuildGateWithFixture(fixtureSource: string): Promise<{ code: number; out: string }> {
  const dir = durableDir(`y4lbe-${Deno.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const fixture = joinPath(dir, "zz-y4lbe-fixture.test.ts");
    await Deno.writeTextFile(fixture, fixtureSource);
    const scriptPath = fileURLToPath(new URL("../scripts/build-gate.ts", import.meta.url));
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", scriptPath, fixture],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    return { code: out.code, out: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const Y4LBE_REFUSAL_FIXTURE = `Deno.test("fixture: environmental refusal", () => {
  throw new Error('CAP_ENVIRONMENTAL_REFUSAL {"reason":"host-loaded"}');
});
`;

const Y4LBE_PRODUCT_FIXTURE = `Deno.test("fixture: product failure", () => {
  throw new Error("AssertionError: a genuine product red");
});
`;

Deno.test("y4lbe: a build-gate run whose serial tier refuses (75) prints REFUSED — never 'FAILED with exit code 75'", async () => {
  const { code, out } = await runBuildGateWithFixture(Y4LBE_REFUSAL_FIXTURE);
  assertEquals(code, 75, `the refusal exit code is preserved upward (run-tests.mjs re-combines it):\n${out}`);
  assert(out.includes("REFUSED"), `the lane-facing line names a refusal:\n${out}`);
  assert(!out.includes("FAILED with exit code 75"), `a refusal must never read as FAILED:\n${out}`);
  assert(!out.includes("ALL") || !out.includes("GREEN"), `a refusal records no PASS:\n${out}`);
});

Deno.test("y4lbe: a genuine product failure in build-gate still prints FAILED with the raw code (falsification side)", async () => {
  const { code, out } = await runBuildGateWithFixture(Y4LBE_PRODUCT_FIXTURE);
  assertEquals(code, 1, `a product red keeps its raw code:\n${out}`);
  assert(out.includes("FAILED with exit code 1"), `a product red is narrated as FAILED:\n${out}`);
});
