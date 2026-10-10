// tests/heavy-gate-static.test.ts — static structural tests for scripts/heavy-gate.ts (chrome-agent-platform-o29c0).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { DEFAULT_HEAVY_GATE_TIMEOUT_MS, filesFor, main } from "../scripts/heavy-gate.ts";
import {
  BUILD_GATE,
  HEAVY_GATE,
  HEAVY_GATE_FILES,
  HEAVY_GATE_REASONS,
  SERIAL,
} from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("heavy-gate static: exports main and filesFor, matching HEAVY_GATE_FILES exactly", () => {
  assertEquals(typeof main, "function");
  assertEquals(typeof filesFor, "function");
  assertEquals(filesFor([]), [...HEAVY_GATE_FILES]);
  assertEquals(filesFor(["tests/foo.test.ts", "--flag"]), ["tests/foo.test.ts"]);
  assertEquals(HEAVY_GATE_FILES.length, 19);
  assertEquals(DEFAULT_HEAVY_GATE_TIMEOUT_MS, 1200_000);
});

Deno.test("heavy-gate: tyyl0 skip filter pin ensures default npm test partition contains zero HEAVY_GATE files", async () => {
  const { defaultTestPlan, enumerateRunnerTests } = await import("../scripts/run-tests.mjs");
  const all = enumerateRunnerTests();
  const plan = defaultTestPlan(all);
  const heavyInDefault = [...plan.serialFiles, ...plan.parallel].filter((f) => HEAVY_GATE.has(f));
  assertEquals(
    heavyInDefault,
    [],
    `default npm test partition must contain zero HEAVY_GATE files, but contained: ${heavyInDefault.join(", ")}`,
  );
});

Deno.test("heavy-gate: every HEAVY_GATE file is enumerated, has a reason, and exists on disk", () => {
  const reasons = HEAVY_GATE_REASONS as Record<string, string>;
  for (const file of HEAVY_GATE_FILES) {
    assert(typeof reasons[file] === "string" && reasons[file].length > 0, `${file} must have a non-empty reason in HEAVY_GATE_REASONS`);
    assert(Deno.statSync(`${ROOT}${file}`).isFile, `${file} must exist on disk`);
  }
});

Deno.test("heavy-gate: no HEAVY_GATE file collides with BUILD_GATE or SERIAL", () => {
  for (const file of HEAVY_GATE_FILES) {
    assert(!BUILD_GATE.has(file), `${file} in HEAVY_GATE must not be in BUILD_GATE`);
    assert(!SERIAL.has(file), `${file} in HEAVY_GATE must not be in SERIAL`);
  }
});
