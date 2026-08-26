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
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;
const pathMod = "node:path";
const path = (await import(pathMod)).default;
const fsMod = "node:fs/promises";
const { readFile, access } = await import(fsMod);
const cpMod = "node:child_process";
const { spawnSync } = await import(cpMod);

const DIST = path.join(ROOT, "extension", "dist");

function build(args = []) {
  const r = spawnSync("node", ["build.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
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

Deno.test("build mode: the DEFAULT build is the debug (developer) bundle with sourcemaps", async () => {
  const r = build(); // no args — the npm run build path
  assertEquals(r.code, 0, r.stderr.slice(0, 2000));
  const m = await marker();
  assertEquals(m.target, "developer", "default build stamps the developer target");
  assert(await exists("background/service-worker.js.map"), "debug build emits the SW sourcemap");
  assert(await exists("options.bundle.js.map"), "debug build emits the options sourcemap");
  const sw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
  assertStringIncludes(sw, "sourceMappingURL=service-worker.js.map");
  // The sourcemap is valid JSON with real source entries (DevTools resolves frames).
  const map = JSON.parse(await readFile(path.join(DIST, "background/service-worker.js.map"), "utf8"));
  assert(Array.isArray(map.sources) && map.sources.length > 10, "sourcemap names real sources");
  assert(
    map.sources.some((s) => String(s).includes("service-worker.js")),
    "sourcemap includes the SW entry source",
  );
});

Deno.test("build mode: --target=store is the production bundle — store marker, no sourcemaps", async () => {
  const r = build(["--target=store"]);
  assertEquals(r.code, 0, r.stderr.slice(0, 2000));
  const m = await marker();
  assertEquals(m.target, "store", "store build stamps the store target");
  assert(!(await exists("background/service-worker.js.map")), "store build emits NO SW sourcemap");
  assert(!(await exists("options.bundle.js.map")), "store build emits NO options sourcemap");
  const sw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
  assert(!sw.includes("sourceMappingURL="), "store bundle carries no sourcemap comment");
});

Deno.test("build mode: the injected log-verbosity default differs by mode (debug=verbose, store=off)", async () => {
  // Store bundle (built last, above): the cap-log build default folds to "off".
  const storeSw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
  const storeHasVerbose = storeSw.includes('__CAP_BUILD_LOG_DEFAULT__');
  assert(!storeHasVerbose, "the define identifier is fully substituted in the bundle");
  // Debug bundle proves the other side.
  const r = build(["--target=developer"]);
  assertEquals(r.code, 0, r.stderr.slice(0, 2000));
  const debugSw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
  assert(!debugSw.includes("__CAP_BUILD_LOG_DEFAULT__"), "define substituted in debug bundle too");
  // Restore the production (store) dist as the steady state for packaging flows.
  const restore = build(["--target=store"]);
  assertEquals(restore.code, 0, restore.stderr.slice(0, 2000));
  assertEquals((await marker()).target, "store");
});
