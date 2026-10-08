// chrome-agent-platform-ltkj.3 — committed contract for the loaded Emscripten
// runtime acceptance harness (scripts/emscripten-runtime-loaded.ts, class "manual").
// Pure functions + source pins only; no browser runs here.
//
// Invariants verified:
//   - harness handles teardownOk / never-delete-live order correctly
//   - harness uses launchChrome with --disable-crash-reporter
//   - harness drives both call paths (Settings tool.package.run + SW broker)
//   - harness drives runtime falsifications
//   - harness uses durableDir and writes result.json
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("runtime harness: source pins — teardown-delete ordering + crash reporter flag", async () => {
  const harnessSource = await Deno.readTextFile("scripts/emscripten-runtime-loaded.ts");

  // Crash reporter flag per coord directive
  assert(
    harnessSource.includes('"--disable-crash-reporter"'),
    "harness passes --disable-crash-reporter to launchChrome",
  );

  // Teardown contract
  assert(
    harnessSource.includes("let teardownOk = false"),
    "harness initializes teardownOk = false",
  );
  assert(
    harnessSource.includes("if (teardownOk && copyRoot)"),
    "scratch copy is removed only if teardown succeeded (never-delete-live)",
  );
  assert(
    harnessSource.includes("retainedCopyRoot = copyRoot"),
    "scratch copy is retained on teardown failure",
  );

  // Both call paths
  assert(
    harnessSource.includes('"tool.package.run"'),
    "harness exercises Settings tool.package.run route",
  );
  assert(
    harnessSource.includes("args: [6, 7, 0.5]"),
    "harness tests positive native operation with valid args",
  );
  assert(
    harnessSource.includes("result !== 42.5"),
    "harness asserts expected scalar operation result (42.5)",
  );

  // Falsifications
  assert(
    harnessSource.includes("extraKeysRun"),
    "harness tests malformed envelope falsification",
  );
  assert(
    harnessSource.includes("outOfBoundsRun"),
    "harness tests out-of-bounds argument falsification",
  );
  assert(
    harnessSource.includes("staleVersionRun"),
    "harness tests stale graph/version falsification",
  );
  assert(
    harnessSource.includes("directHostRun"),
    "harness tests direct non-SW sender falsification",
  );

  // Durable evidence
  assert(
    harnessSource.includes('durableDir("astra", "ltkj3")'),
    "evidence is written to durableDir astra/ltkj3",
  );
  assert(
    harnessSource.includes('result.json'),
    "harness outputs result.json",
  );
});

Deno.test("runtime harness: harness-registry entry is present and classified manual", async () => {
  const registryText = await Deno.readTextFile("scripts/lib/harness-registry.ts");
  assert(
    registryText.includes('"emscripten-runtime-loaded.ts"'),
    "emscripten-runtime-loaded.ts is registered in harness-registry.ts",
  );
  assert(
    registryText.includes('class: "manual"'),
    "harness is classified as manual in harness registry",
  );
});
