#!/usr/bin/env node
// scripts/run-tests.mjs — the FULL suite in two phases (vj4s: serial `deno
// test -A tests/` cost ~6m48s because deno runs files serially by default).
//
//   Phase 1 (serial): tests that BUILD the extension or assert on shared
//     build artifacts in THIS worktree (extension/dist, dist-versions,
//     bundled-tool CAS). They rewrite/verify the same paths; racing them
//     against each other or against dist readers failed 9 tests (par1 run).
//   Phase 2 (parallel): everything else, `deno test --parallel` (one worker
//     per CPU). No file in this phase writes shared build artifacts.
//
// Coverage is complete by construction: every tests/*.test.ts runs exactly
// once; the serial set is validated to exist, and NEW test files default to
// the parallel set (the safe default — a new build-artifact test that races
// fails loudly and belongs in SERIAL with its reason).
//
// `deno test -A tests/` still works unchanged (serial, slower). Both commands
// run the identical file set; this script is the merge gate via `npm test`.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERIAL = new Set([
  "tests/build-bootstrap.test.ts", // runs node build.mjs in-place (dist/dist-versions rewrite)
  "tests/build-debug-mode.test.ts", // runs node build.mjs in-place (debug+store bundles)
  "tests/build-tool-bundling.test.ts", // runs build.mjs / build-bundled in-place
  "tests/bundled-tool-packages.test.ts", // asserts the shipped CAS bytes (races with rebuilds)
  "tests/reachability.test.ts", // asserts the repo tree's generated-artifact state
  "tests/tool-exec-preview.test.ts", // revalidates the REAL shipped bytes (races with rebuilds)
  "tests/package-extension-freshness.test.ts", // packages dist + writes the dist-complete marker
]);

// Recursive: `deno test tests/` walks subdirectories, so this walk must too
// (a non-recursive readdir would silently drop future tests/**/ nested files).
const all = readdirSync("tests", { recursive: true })
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `tests/${f}`)
  .sort();
const missing = [...SERIAL].filter((f) => !all.includes(f));
if (missing.length > 0) {
  console.error(`run-tests: SERIAL names files that do not exist: ${missing.join(", ")}`);
  process.exit(2);
}
const parallel = all.filter((f) => !SERIAL.has(f));

function run(files, flags, label) {
  const t0 = Date.now();
  const r = spawnSync("deno", ["test", "-A", ...flags, ...files], { stdio: "inherit" });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nrun-tests: ${label} ${r.status === 0 ? "GREEN" : "FAILED"} in ${secs}s`);
  return r.status ?? 1;
}

const t0 = Date.now();
let rc = run([...SERIAL], [], `serial phase (${SERIAL.size} build/artifact files)`);
if (rc === 0) rc = run(parallel, ["--parallel"], `parallel phase (${parallel.length} files)`);
console.log(`run-tests: ${all.length} files total, wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(rc);
