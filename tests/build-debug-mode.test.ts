// @ts-nocheck
// tests/build-debug-mode.test.ts — KATs for the build-MODE split
// (CAP-FB-20260826-OBSERVABILITY-01):
//   • the DEFAULT build (`node build.mjs`, no args) is the DEBUG bundle:
//     developer target marker + external sourcemaps;
//   • `--target=store` (npm run build:production) is the Store bundle: store
//     target marker, NO sourcemaps;
//   • identical security assertions run in both modes (the bundled-tool verify
//     gate runs before bundling in both — proven here by both builds passing
//     the same gates, and by the drift KAT in build-tool-bundling which runs
//     the DEFAULT = debug build and must still fail closed).
import { fileURLToPath } from "node:url";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pathMod = "node:path";
const path = (await import(pathMod)).default;
const fsMod = "node:fs/promises";
const { readFile, writeFile, access } = await import(fsMod);
import {
  validateDistCompleteMarker,
  INDEXED_SOURCE_EXCLUDED_PATHS,
} from "../scripts/dist-complete.mjs";
// chrome-agent-platform-kj9s: one MEASURED child bound shared by the build-heavy serial files,
// instead of a per-file hard-coded number (see PRODUCTION_BUILD_TIMEOUT_MS). The file's window
// (SERIAL_FILE_TIMEOUTS) still governs the whole file.
import { PRODUCTION_BUILD_TIMEOUT_MS } from "../scripts/test-partition.mjs";
const cpMod = "node:child_process";
const { spawnSync } = await import(cpMod);

const DIST = path.join(ROOT, "extension", "dist");

function build(args = []) {
  const r = spawnSync("node", ["build.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: PRODUCTION_BUILD_TIMEOUT_MS,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function exists(rel) {
  try {
    await access(path.join(DIST, rel));
    return true;
  } catch {
    return false;
  }
}

async function marker() {
  return JSON.parse(await readFile(path.join(DIST, "dist.complete"), "utf8"));
}

// ── chrome-agent-platform-kj9s: the mode assertions are regrouped onto TWO builds + one steady-state build ──
// Each build below is a REAL build and every assertion keeps its own discriminating power: the
// developer build's sourcemaps/define/marker are read from THAT build, the store build's absence of
// sourcemaps and its marker from THIS one, and the dev-vs-store source-authority equality compares
// the two markers THIS test made. The old file needed SIX builds and read the store bundle out of a
// PREVIOUS test's build (a cross-test shared-state dependency); nothing here depends on another test.

Deno.test("build mode: developer bundle emits sourcemaps; store bundle does not — markers, defines and source authority asserted on THIS test's own two builds", async () => {
  // 1. DEVELOPER (the default build: `node build.mjs` / `npm run build`).
  const devBuild = build();
  assertEquals(devBuild.code, 0, devBuild.stderr.slice(0, 2000));
  const devMarker = await marker();
  assertEquals(devMarker.target, "developer", "default build stamps the developer target");
  assert(await exists("background/service-worker.js.map"), "debug build emits the SW sourcemap");
  assert(await exists("options.bundle.js.map"), "debug build emits the options sourcemap");
  const devSw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
  assertStringIncludes(devSw, "sourceMappingURL=service-worker.js.map");
  const map = JSON.parse(await readFile(path.join(DIST, "background/service-worker.js.map"), "utf8"));
  assert(Array.isArray(map.sources) && map.sources.length > 10, "sourcemap names real sources");
  assert(
    map.sources.some((s) => String(s).includes("service-worker.js")),
    "sourcemap includes the SW entry source",
  );
  // The injected log-verbosity define is fully substituted in the DEBUG bundle.
  assert(!devSw.includes("__CAP_BUILD_LOG_DEFAULT__"), "define substituted in debug bundle");
  const devValidated = await validateDistCompleteMarker({ root: ROOT, distRoot: DIST, expectedTarget: "developer" });
  assertEquals(devValidated.target, "developer");

  // 2. STORE (`--target=store` / `npm run build:production`).
  const storeBuild = build(["--target=store"]);
  assertEquals(storeBuild.code, 0, storeBuild.stderr.slice(0, 2000));
  const storeMarker = await marker();
  assertEquals(storeMarker.target, "store", "store build stamps the store target");
  assert(!(await exists("background/service-worker.js.map")), "store build emits NO SW sourcemap");
  assert(!(await exists("options.bundle.js.map")), "store build emits NO options sourcemap");
  const storeSw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
  assert(!storeSw.includes("sourceMappingURL="), "store bundle carries no sourcemap comment");
  // …and the same define is fully substituted in the STORE bundle (read from THIS build).
  assert(!storeSw.includes("__CAP_BUILD_LOG_DEFAULT__"), "define substituted in store bundle");
  const storeValidated = await validateDistCompleteMarker({ root: ROOT, distRoot: DIST, expectedTarget: "store" });
  assertEquals(storeValidated.target, "store");

  // 3. Source authority is IDENTICAL across targets for the same extension source, and the circular
  //    generated bundle stays excluded from it.
  assertEquals(INDEXED_SOURCE_EXCLUDED_PATHS.size, 1, "exclusion set must contain exactly one member");
  assert(INDEXED_SOURCE_EXCLUDED_PATHS.has("docs/diff-core.bundle.js"), "docs/diff-core.bundle.js must be excluded from indexed source authority");
  assertEquals(storeValidated.source.digest, devValidated.source.digest, "underlying indexed source authority must match between dev and store targets");
  assertEquals(storeValidated.source.files, devValidated.source.files, "indexed source file count must match between dev and store targets");

  // 4. Tamper-evident gate (no build): modifying any real indexed source invalidates authority.
  const realFile = path.join(ROOT, "extension/lib/pure.js");
  const originalBytes = await readFile(realFile);
  try {
    await writeFile(realFile, originalBytes + "\n// tamper\n");
    let caught = null;
    try {
      await validateDistCompleteMarker({ root: ROOT, distRoot: DIST, expectedTarget: "store" });
    } catch (e) {
      caught = e;
    }
    assert(caught !== null, "modifying a real source file must fail validation");
    assertStringIncludes(caught.message, "marker indexed source authority is stale");
  } finally {
    await writeFile(realFile, originalBytes);
  }
});

Deno.test("build mode: --target=store leaves the STORE dist as the steady state the following serial files read", async () => {
  // The serial phase's later files (packaging, bundle-budget, tool-exec-preview) read a store dist;
  // this test owns leaving the tree in that state, instead of relying on an earlier test's build.
  const store = build(["--target=store"]);
  assertEquals(store.code, 0, store.stderr.slice(0, 2000));
  assertEquals((await marker()).target, "store");
  const validated = await validateDistCompleteMarker({ root: ROOT, distRoot: DIST, expectedTarget: "store" });
  assertEquals(validated.target, "store", "the steady-state store dist validates at its own target");
});
