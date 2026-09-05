// scripts/test-partition.mjs — the single source of truth for the two-phase
// test partition (vj4s; hardened by 76hu). Imported by BOTH runners:
//   • scripts/run-tests.mjs (the full-suite merge gate, `npm test`)
//   • scripts/select-tests.mjs (per-commit subsets) and tests/test-partition-guard.test.ts
//
// Phase 1 (serial): tests that BUILD the extension or assert on shared build
//   artifacts in THIS worktree (extension/dist, dist-versions, bundled-tool
//   CAS, packages/bundled). They rewrite/verify the same paths; racing them
//   against each other or against dist readers failed 9 tests (vj4s par1 run).
// Phase 2 (parallel): everything else, `deno test --parallel`.
//
// Coverage is complete by construction: every tests/*.test.ts runs exactly
// once, and NEW test files default to the parallel set. The guard test
// (tests/test-partition-guard.test.ts) scans every test file's content and
// fails RED when a build-artifact hazard (spawning build.mjs or the
// bundled-tool generator, writing under extension/ or packages/, or reading
// extension/dist) is NOT in SERIAL (or the reviewed EXEMPTIONS list), so a
// new hazard can never silently join the parallel phase.

// SERIAL membership is pinned WITH a reason: adding a file to the serial set
// means stating why it is a shared-build-artifact hazard. The guard test
// asserts every entry carries one.
export const SERIAL_REASONS = {
  "tests/build-bootstrap.test.ts": "runs node build.mjs in-place (dist/dist-versions rewrite)",
  "tests/build-debug-mode.test.ts": "runs node build.mjs in-place (debug+store bundles)",
  "tests/build-tool-bundling.test.ts": "runs build.mjs / the bundled-tool generator in-place and mutates packages/bundled",
  "tests/bundled-tool-packages.test.ts": "asserts the shipped CAS bytes (races with rebuilds)",
  "tests/reachability.test.ts": "asserts the repo tree's generated-artifact state",
  "tests/tool-exec-preview.test.ts": "revalidates the REAL shipped bytes (races with rebuilds)",
  "tests/package-extension-freshness.test.ts": "driver packages dist + writes the dist-complete marker",
  // 76hu guard caught this post-merge arrival from main (390b2b3a): it stats
  // the built SW bundle and the dist.complete marker — shared build artifacts.
  "tests/bundle-budget.test.ts": "asserts the built dist bundle size + dist-complete marker (races with rebuilds)",
  // 76hu: the guard's reads-extension/dist class pins these two (previously
  // parallel; both consume the built diff-core bundle, a shared artifact).
  "tests/diff-core.test.ts": "imports/reads the built extension/dist diff-core bundle (shared build artifact)",
  "tests/owner-approval-security.test.ts": "imports the built extension/dist diff-core bundle (shared build artifact)",
};
export const SERIAL = new Set(Object.keys(SERIAL_REASONS));

// Files a content scan classifies as hazards but that are provably
// parallel-safe. Each exemption MUST state why the shared-artifact hazard
// does not apply; the guard test pins the reason. Keep this list tiny —
// membership is a review-time decision, never a default.
export const EXEMPTIONS = {
  "tests/evidence-durable.test.ts": "spawns the bundled-tool generator ONLY inside a pristine makeTempDir checkout materialization; every write goes to the temp dir, never to repo extension/ or packages/",
};

// A test that spawns one of these local drivers inherits the driver's hazard
// classification (the hazard lives in the driver, not the test wrapper).
export const DRIVER_REF_RE = /tests\/[\w.-]+\.(?:mjs|ts)/g;

const SPAWN_RE = /Deno\.Command\s*\(|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|\.spawn\s*\(|\bspawn\s*\(/;
const BUILD_REF_RE = /build\.mjs|build-bundled-tool-packages/;
const WRITE_CALL_RE = /(?:writeTextFile|writeFileSync|writeFile|mkdirSync|mkdir|removeSync|remove|copyFile|rename)\s*\(/g;
const TREE_LITERAL_RE = /["'`][^"'`\n]*(?:extension|packages)\/[^"'`\n]*["'`]/;
const READ_RE = /readTextFile|readFile|readFileSync|readDir|readdir|import\s*\(|\bfrom\s*["']/i;
const DIST_LITERAL_RE = /extension\/dist/;

// Write hazard = a write/remove call with a tree literal NEAR the call site
// (same statement or the assignment feeding it). A file that merely mentions
// extension/ paths for reads while writing elsewhere (a temp dir, an in-memory
// fake, a DOM stub) is not a write hazard — the near-miss list of 16 parallel
// files in 76hu proved the coarse any-write + any-literal scan far too broad.
function writesTree(text) {
  for (const m of text.matchAll(WRITE_CALL_RE)) {
    const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
    if (TREE_LITERAL_RE.test(around)) return true;
  }
  return false;
}

// Classify one test file's content (optionally merged with the text of local
// drivers it spawns). Returns the matched hazard class names; empty = safe,
// defaults to the parallel phase.
export function classifyHazards(text) {
  const classes = [];
  if (SPAWN_RE.test(text) && BUILD_REF_RE.test(text)) classes.push("spawns build.mjs or the bundled-tool generator");
  if (writesTree(text)) classes.push("writes under extension/ or packages/");
  if (READ_RE.test(text) && DIST_LITERAL_RE.test(text)) classes.push("reads extension/dist");
  return classes;
}

// Split a list of test files (repo-relative) into the two phases, preserving
// the full-run invariant: serial hazards first (never parallel), everything
// else parallel. Deterministic ordering for stable logs.
export function partition(files) {
  const sorted = [...files].sort();
  return {
    serial: sorted.filter((f) => SERIAL.has(f)),
    parallel: sorted.filter((f) => !SERIAL.has(f)),
  };
}
