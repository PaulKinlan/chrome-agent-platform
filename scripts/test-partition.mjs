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
//   NOTE: Phase 2 includes real-browser execution (tests/chrome-profile-location.test.ts
//   unconditionally launches Chromium under a unit-scope lockPath; see docs/CHROME-TEST-CONTRACT.md).
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
  "tests/store-doc-denial.test.ts": "runs node build.mjs in-place and reads the built extension/dist bundles (shared build artifacts)",
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
  // cc18: reads the three built page bundles to assert they ship zero
  // WebAssembly API calls (the j6au tree-shaking property) — a rebuild mid-read
  // is exactly the race this phase exists to prevent.
  "tests/wasm-tree-shaking.test.ts": "reads the built extension/dist page bundles (shared build artifacts)",
  "tests/emscripten-abi-loaded-harness.test.ts": "requires current Store dist artifacts and prepares the live extension, briefly creating/removing its reserved probe directory",
  "tests/owner-approval-security.test.ts": "imports the built extension/dist diff-core bundle (shared build artifact)",
  "tests/chrome-launch-lock.test.ts": "tests process-global Chrome canonical lock and mutates CAP_CHROME_LOCK_PATH (races with other lock tests)",
  "tests/chrome-launch-lock-scope.test.ts": "tests Chrome lock scopes and mutates CAP_CHROME_SLOT_DIR (races with other lock tests)",
  "tests/chrome-slot-semaphore.test.ts": "tests Chrome bounded concurrency semaphore and mutates CAP_CHROME_SLOT_DIR (races with other lock tests)",
  // mee3: pins the four adjudicated survivors (S15 dead-holder accounting, S9
  // blocking probe, S16/S17 the unreported wait). Each test owns a unique
  // temporary slot dir so it cannot touch another lane's slots, but it still
  // mutates process-global CAP_CHROME_SLOT_DIR and asserts on wall-clock
  // queueing thresholds (a 1500 ms skip bound against a 2000 ms marker window),
  // which is exactly what the 32-worker parallel phase makes flaky.
  "tests/chrome-slot-semaphore-honesty.test.ts": "mutates CAP_CHROME_SLOT_DIR and makes wall-clock queueing assertions (races/flakes with other lock tests under the parallel phase)",
  // 4lc0: this file IMPORTS the bundled-tool generator for one constant
  // (AGENT_DESCRIPTIONS). Importing it RUNS it — the generator's work is at module top
  // level and its isMain flag gates only the final process.exit — so a run of this test
  // rewrites all 38 files in extension/wasm/cas. Measured in isolation (per-file mtime
  // fingerprint of the CAS dir changes), and in the nco2 subset that regeneration landed
  // inside the parallel phase while tests/gzip-preview.test.ts was reading a CAS file,
  // which failed NotFound: the false red this bead exists for. The spawn-based hazard
  // scan could not see an import, which is why this entry and the IMPORT_BUILD_RE class
  // in this file are the same fix.
  "tests/tool-descriptions.test.ts": "imports scripts/build-bundled-tool-packages.mjs, whose import-time work regenerates extension/wasm/cas (38 files) — measured; readers race it",
};
export const SERIAL = new Set(Object.keys(SERIAL_REASONS));

// Files a content scan classifies as hazards but that are provably
// parallel-safe. Each exemption MUST state why the shared-artifact hazard
// does not apply; the guard test pins the reason. Keep this list tiny —
// membership is a review-time decision, never a default.
export const EXEMPTIONS = {
  "tests/evidence-durable.test.ts": "spawns the bundled-tool generator ONLY inside a pristine makeTempDir checkout materialization; every write goes to the temp dir, never to repo extension/ or packages/",
  // 4lc0 re-review: the fresh-instance gate plants `tests/*.test.ts` files in a makeTempDir scratch tree
  // and walks it. The write-hazard heuristic sees a write call near an `extension/` literal (the SAFE
  // fixture string it plants) and correctly flags the text — but every write goes to the scratch tree,
  // never to repo extension/ or packages/, and the file it writes is not in the real census at all.
  "tests/test-partition-guard.test.ts": "plants fixtures in a makeTempDir scratch tree; the extension/ literal is a fixture string, not a write target",
  // 4lc0 round 5: the rule is now "naming the generator at all is a hazard", so these five are the
  // OVER-DECLARATION it costs. Each was read before being exempted: none of them loads or executes
  // anything — they read the build script's TEXT, list it as a path to scan, assert that package
  // scripts or documents MENTION it, or say its name in a comment. Reading build.mjs is not loading
  // it (the script is source, not generated output), and executing the generator is the hazard.
  "tests/changelog-shipping.test.ts": "reads ../build.mjs as TEXT to check what the changelog ships; never loads or runs it",
  "tests/file-url-root-guard.test.ts": "lists ROOT/build.mjs as a path to scan and pins the generator path as a STRING; no import, require or execution",
  "tests/package-scripts-exist.test.ts": "asserts a package.json script REFERENCE to build.mjs resolves; it never imports the generator",
  "tests/risk-register-contract.test.ts": "asserts the risk register CITES build.mjs for the bundle budget; documentation text only",
  "tests/zod-jitless-fallback.test.ts": "mentions build.mjs in a comment describing how the pipeline scrubs; no load",
  "tests/durable-root.test.ts": "scans test file paths including serial build tests for tmpdir literals; executes no build or extension writes",
};

// A test that SPAWNS or IMPORTS one of these local drivers inherits the
// driver's hazard classification (the hazard lives in the driver, not the test
// wrapper). 8b8w/f94p: the first version of this rule keyed on the bare path
// SHAPE and matched any mention — a comment explaining a test made the
// explaining file inherit that test's hazards (measured 2026-09-25: a
// synthetic wrapper whose only mention of tests/wasm-tree-shaking.test.ts is
// inside a comment inherited "reads extension/dist" through DRIVER_REF_RE, and
// the live cc18 workaround was an evasive comment that refused to name its
// subject). The rule is now REFERENCE-SCOPED: only a module specifier
// (import/from/require/dynamic import) or a spawn/exec argument list can carry
// a driver reference, because those are the shapes that actually LOAD or RUN
// the driver. RESIDUE, stated so it is not implied away: a path assembled at
// runtime ("tests/" + name) is invisible to every text detector here — it was
// equally invisible to the old mention rule, so the fix does not widen that
// hole; and a COMMENTED-OUT import still matches its shape (fail-closed: the
// cost is an inheritance a lane did not need, never a silent parallel writer).
const DRIVER_LOAD_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'][^"'\n]*?(tests\/[\w.-]+\.(?:mjs|ts))["']/g;
const DRIVER_SPAWN_RE = /(?:Deno\.Command\s*\(|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|\.spawn(?:Sync)?\s*\()[^;`]{0,400}?(tests\/[\w.-]+\.(?:mjs|ts))/g;

/** The tests/* drivers a file's text actually loads or spawns — the ONLY
 * references whose hazard classification a mentioning file inherits. A prose
 * mention (comment, doc string, explanatory note) is not a reference. */
export function realDriverRefs(text) {
  const refs = new Set();
  for (const re of [DRIVER_LOAD_RE, DRIVER_SPAWN_RE]) {
    for (const m of text.matchAll(re)) refs.add(m[1]);
  }
  return [...refs];
}

const SPAWN_RE = /Deno\.Command\s*\(|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|\.spawn\s*\(|\bspawn\s*\(/;
const BUILD_REF_RE = /build\.mjs|build-bundled-tool-packages/;
// 4lc0: a test that IMPORTS a build module runs it — module side effects are the same hazard
// as spawning it, and the SPAWN_RE rule above cannot see the shape that let
// tests/tool-descriptions.test.ts join the parallel phase while regenerating
// extension/wasm/cas on import.
//
// THE FIRST VERSION OF THIS RULE MATCHED ONE LINE SHAPE and was evadable: an independent review
// (cap-astra, 2026-09-24, ~/cap-evidence/4lc0-astra-review-20260924/REVIEW.md) took the SAME live
// import, split it over three lines, and the guard went 5/0 while the real partition put that
// file in the parallel phase and reproduced 8 CAS NotFound failures — the known writer stayed
// correctly serial throughout, so the containment held and only the DETECTOR was blind. So the
// rule is written against the SPECIFIER, not against a line shape:
//   import … from "<build module>"   (any wrapping between the clause and `from`)
//   import "<build module>"          (bare side-effect import)
//   import("<build module>")         (dynamic import, literal specifier)
//   require("<build module>")        (CJS)
// RESIDUE, stated so it is not implied away: a specifier built at RUNTIME (`import(someVar)`) is
// not visible to any text detector, and a COMMENTED-OUT import DOES match (fail-closed: the cost
// is a declaration the lane did not need, never a silent parallel writer — a bare mention in
// prose does not match). The bounded
// `[\s\S]{0,400}?` window keeps the match linear and local to one statement region.
// SPACING IS NOT A RULE EITHER (cap-astra re-review, 2026-09-24): the first version required
// whitespace after `import`, so a MINIFIED import — `import{AGENT_DESCRIPTIONS}from"…"` — went
// undetected (guard 6/0) while a fresh instance of it ran in the parallel phase and reproduced 8
// CAS NotFound failures. `\\bimport\\b` plus `from\\s*` covers every spacing including none, and the
// bare form is no longer line-anchored for the same reason (a minifier puts it mid-line).
const BUILD_MODULE_SPEC = `["'][^"'\n]*(?:build\\.mjs|build-bundled-tool-packages)[^"'\n]*["']`;
// A STRING NAMING THE GENERATOR IS A HAZARD, WHATEVER SYNTAX CARRIES IT (cap-astra round 5, coord-
// endorsed). Every earlier version of this rule modelled WHICH syntax could load the generator — the
// line shape, then spacing, then comments, then quote delimiters — and each round found the shape
// that was not modelled. Round 5's was a NO-SUBSTITUTION TEMPLATE: `import(`build-…`)` loads the
// module exactly like a quoted string, the quote-only class called it safe, and the reviewer planted
// one that reproduced EIGHT CAS NotFound in the parallel phase while this census reported 6/0.
//
// The taxonomy is therefore GONE rather than extended. If the file names the generator or build.mjs
// at all — in an import, a require, a re-export, a bare string, a template, a comment, docs prose —
// it is a hazard and must be declared SERIAL or exempted with a reason. That over-declares, which is
// the correct direction: the cost is a declaration a lane did not need; the alternative is a
// generator running in the parallel phase.
const GENERATOR_NAME_RE = /(?:build\.mjs|build-bundled-tool-packages)/;
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
  if (GENERATOR_NAME_RE.test(text)) classes.push("names build.mjs or the bundled-tool generator (a load hazard whatever the syntax)");
  if (writesTree(text)) classes.push("writes under extension/ or packages/");
  if (READ_RE.test(text) && DIST_LITERAL_RE.test(text)) classes.push("reads extension/dist");
  return classes;
}

/**
 * THE GUARD'S INVARIANT, as a pure function (4lc0 re-review): every content hazard must be in SERIAL
 * or carry a reviewed EXEMPTIONS reason. Extracted so the real census check and the fresh-instance
 * gate test the SAME rule — the first version of the gate proved the classifier on a path it only
 * claimed, and bypassing the census left all six guard tests green (cap-astra, 2026-09-24).
 * `entries` are [repoRelativePath, content] pairs; the result is the hazard files that would run in
 * the PARALLEL phase, so an empty result is the safe answer.
 */
export function unserialisedHazards(entries) {
  const violations = [];
  for (const [rel, text] of entries) {
    const classes = classifyHazards(text);
    if (!classes.length) continue; // safe → defaults to the parallel phase
    if (SERIAL.has(rel)) continue;
    const reason = EXEMPTIONS[rel];
    if (typeof reason === "string" && reason.trim().length > 0) continue;
    violations.push(`${rel} — ${classes.join("; ")}`);
  }
  return violations;
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
