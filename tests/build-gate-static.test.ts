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

// gate-speed: the two-tree build gate is used ONLY for a full, clean, committed run.
Deno.test("build-gate: two-tree mode only for a full run of a clean tree; every other case is one tree, serially", async () => {
  const { oneTreeReason, SIBLING_FILES } = await import("../scripts/build-gate.ts");
  assertEquals(oneTreeReason({ cliFiles: [], dirty: "", env: {} }), null);
  assert(oneTreeReason({ cliFiles: ["tests/build-bootstrap.test.ts"], dirty: "", env: {} }));
  assert(oneTreeReason({ cliFiles: [], dirty: " M scripts/x.mjs", env: {} }));
  assert(oneTreeReason({ cliFiles: [], dirty: "", env: { CAP_BUILD_GATE_ONE_TREE: "1" } }));
  // The sibling runs a SUBSET of the gate's own files; nothing outside the gate can be routed there.
  for (const f of SIBLING_FILES) assert(BUILD_GATE_FILES.includes(f), `${f} is not a build-gate file`);
  assert(SIBLING_FILES.length < BUILD_GATE_FILES.length, "at least one file stays in this tree");
});
