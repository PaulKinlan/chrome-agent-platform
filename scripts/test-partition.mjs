// scripts/test-partition.mjs — the single source of truth for the ordered
// test partition (vj4s; hardened by 76hu and o49qg). Imported by BOTH runners:
//   • scripts/run-tests.mjs (the full-suite merge gate, `npm test`)
//   • scripts/select-tests.mjs (per-commit subsets) and tests/test-partition-guard.test.ts
//
// Phase 1 (serial): shared-artifact writers and process-global hazards. In-place
//   rebuilds must finish BEFORE any read-only dist consumer runs.
// Phase 2 (post-build read-only, parallel): reviewed artifact consumers. The full
//   runner checks the build lock and watches/verifies dist throughout this batch.
// Phase 3 (parallel): everything else, `deno test --parallel`. The unchanged
//   per-change runner combines phases 2+3 in ONE parallel process, after serial.
//   NOTE: Phase 2 includes real-browser execution (tests/chrome-profile-location.test.ts
//   unconditionally launches Chromium under a unit-scope lockPath; see docs/CHROME-TEST-CONTRACT.md).
//
// Coverage is complete by construction: every tests/*.test.ts runs exactly
// once, and NEW test files default to the parallel set. The guard test
// (tests/test-partition-guard.test.ts) scans every test file's content and
// fails RED when a build-artifact hazard (spawning build.mjs or the
// bundled-tool generator, writing under extension/ or packages/, or reading
// extension/dist) is NOT in SERIAL (or the reviewed EXEMPTIONS list).

// SERIAL membership is pinned WITH a reason: adding a file to the serial set
// means stating why it is a shared-build-artifact hazard. The guard test
// asserts every entry carries one.
export const SERIAL_REASONS = {
  "tests/build-sdk-dedup.test.ts": "spawns build.mjs to assert the AI SDK deduplication guard behaviors in different layouts",
  "tests/build-smoke.test.ts": "fast smoke-level assertion in npm test: a store build of THIS tree exited 0 (run now, or reused from the record build.mjs writes only when it exits 0 for the same commit and source authority) and the live dist.complete validates (chrome-agent-platform-h65e, jjsz)",
  "tests/build-bootstrap.test.ts": "runs node build.mjs in-place (dist/dist-versions rewrite)",
  "tests/store-doc-denial.test.ts": "runs node build.mjs in-place and reads the built extension/dist bundles (shared build artifacts)",
  "tests/build-debug-mode.test.ts": "runs node build.mjs in-place (debug+store bundles)",
  "tests/build-tool-bundling.test.ts": "runs build.mjs / the bundled-tool generator in-place and mutates packages/bundled",
  "tests/reachability.test.ts": "asserts the repo tree's generated-artifact state",
  "tests/package-extension-freshness.test.ts": "driver packages dist + writes the dist-complete marker",
  // nz2r: writes a stale build stage dir under extension/ to prove the
  // per-change gate is immune to killed-build residue (swept in its finally).
  "tests/select-tests-residue.test.ts": "plants build residue under extension/ to prove test:changed ignores it (removed in finally)",
  // elst: plants an untracked scripts/kat-*.ts probe in the real tree for its real-tree falsification;
  // races harness-registry's scripts/ census and residue on kill REDs two always-on guards.
  "tests/real-browser-teardown.test.ts": "plants an untracked scripts/kat-*.ts probe in the real tree for its real-tree falsification; races harness-registry's scripts/ census and residue on kill REDs two always-on guards",
  // mwz3/yx2h: the allowlist guard writes extension/lib/__probe_stray_gesture_reader.js
  // to the REAL repo tree for its end-to-end falsification, then removes it in finally.
  // A kill before finally leaves untracked shipped-path residue that poisons
  // the guard's own allowlist and makes test:changed fail closed to the full suite.
  "tests/requires-owner-gesture-column-allowlist.test.ts": "writes an untracked probe in the real repo extension/lib tree; killed-run residue trips its allowlist and changed-file selection",
  "tests/emscripten-abi-loaded-harness.test.ts": "requires current Store dist artifacts and prepares the live extension, briefly creating/removing its reserved probe directory",
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
  // 3vi7 + cihz: tests/serial-phase-timeout.test.ts makes wall-clock kill/survive assertions
  // (a fixture that DECLARES 5000 ms of work, killed under a 4000 ms flat bound and surviving a
  // 12000 ms scaled one) which race and flake under the 32-worker parallel phase on a heavily
  // loaded fleet machine. cihz made the kill structural and the survive margin wide, but the
  // assertions are still real elapsed time, so the declaration stands.
  "tests/serial-phase-timeout.test.ts": "wall-clock kill/survive bounds assertions (declared 5000 ms work vs 4000 ms flat / 12000 ms scaled bounds) race the parallel phase",
  // 20e2u: launches real Chrome to load extension/dist bundles and verify dynamic chunk resolution.
  "tests/chunk-resolution-browser.test.ts": "launches Chrome to load extension/dist bundles and verify dynamic chunk resolution; races serial builds mutating dist/",
  // chrome-agent-platform-jdgjy: boots ntp.html in real headless Chrome and asserts on
  // median long task count (0) and stage1-composer latency (<150ms). Concurrent load in the
  // 32-worker parallel phase causes CPU starvation during boot, failing full gates with
  // median long tasks 1 vs 0 and composer latency up to 383ms, while passing 4/0 in isolation.
  // Running serially before the parallel phase removes the concurrent load.
  "tests/ntp-boot-staging.test.ts": "staged-boot unit mechanics (runStagedBoot ordering, fault isolation, deferred custom elements); kept serial for schedule stability after its wall-clock assertions moved to tests/ntp-boot-staging-timing.test.ts (chrome-agent-platform-mr1ak)",
};
export const SERIAL = new Set(Object.keys(SERIAL_REASONS));

// Reviewed read-only consumers run after all serial rebuilds. Keep these in
// partition(...).parallel as well: select-tests.mjs consumes only serial/parallel
// and MUST NOT silently drop the five when it runs a changed-file subset.
export const READ_ONLY_DIST_REASONS = Object.freeze({
  "tests/diff-core.test.ts": "imports the built diff-core bundle without writing it",
  "tests/wasm-tree-shaking.test.ts": "reads three built page bundles without writing them",
  "tests/bundle-budget.test.ts": "reads the built budget/metafile/marker and build.mjs SOURCE without running a build",
  "tests/bundled-tool-packages.test.ts": "reads shipped inventory/CAS and generator SOURCE; its only child command is git provenance",
  "tests/tool-exec-preview.test.ts": "revalidates shipped CAS and manifests without writing them",
});
export const READ_ONLY_DIST = new Set(Object.keys(READ_ONLY_DIST_REASONS));

// Build-behaviour tests moved to the dedicated npm run test:build gate (Option D / chrome-agent-platform-h65e).
// These files run multiple in-place builds and are partitioned out of standard npm test to eliminate
// load variance and save ~8 minutes on every lane's gate.
export const BUILD_GATE_REASONS = {
  "tests/build-bootstrap.test.ts": "runs node build.mjs in-place (dist/dist-versions rewrite; 2 production builds)",
  "tests/build-debug-mode.test.ts": "runs node build.mjs in-place (debug+store bundles; mode alternation)",
  "tests/build-tool-bundling.test.ts": "runs build.mjs / the bundled-tool generator in-place (verify-mode drift check and regen)",
};
export const BUILD_GATE_FILES = Object.freeze(Object.keys(BUILD_GATE_REASONS));
export const BUILD_GATE = new Set(BUILD_GATE_FILES);

// Heavy WASM and binary fixture tests moved to the dedicated npm run test:heavy tier (chrome-agent-platform-o29c0).
// packages/bundled/evidence/, wasm-tools/, and docs/admissions/ hold >30MB of binaries (Pyodide, image decoders,
// SQLite, WASI tools). Loading and instantiating these inside parallel Deno isolates spikes RAM (>3GB) and starves
// CPUs on loaded fleet machines. Tiering them to npm run test:heavy keeps the default gate fast and focused while
// preserving full coverage in the dedicated tier and test:all.
export const HEAVY_GATE_REASONS = {
  "tests/python-runtime.test.ts": "loads >10MB Pyodide WebAssembly runtime in-process and executes Python code",
  "tests/python-wheel-unpack.test.ts": "loads Pyodide runtime to test wheel unpacking and offline package execution",
  "tests/python-storage-guard.test.ts": "loads Pyodide runtime to test ambient storage guards and Python imports",
  "tests/zxing-admission.test.ts": "loads 2.7MB ZXing WASM and executes real streaming worker image decoding",
  "tests/compressops-admission.test.ts": "loads 2.8MB CompressOps WASM and executes real streaming worker compression jobs",
  "tests/imageops-admission.test.ts": "loads 1.5MB ImageOps WASM and executes real streaming worker image operations",
  "tests/jxl-admission.test.ts": "loads 4.3MB JXL WASM and executes real streaming worker image decoding",
  "tests/oxipng-admission.test.ts": "loads 652KB OxiPNG WASM and executes real streaming worker PNG optimization",
  "tests/avif-admission.test.ts": "loads 4.3MB AVIF evidence binaries and executes real job-lane worker",
  "tests/callexport-admission.test.ts": "loads multiple MBs of call-export WASM evidence binaries (b2, c2, d3)",
  "tests/t3-trio-admission.test.ts": "loads awk/sed/grep WASM binaries and runs WASI instances",
  "tests/unix-tools-admission.test.ts": "instantiates WASM binaries and executes WASI tool streaming KAT",
  "tests/wasi-preview1-runtime.test.ts": "instantiates WASM binaries and executes extensive WASI preview1 runtime test matrix",
  "tests/wasm-external-sort.test.ts": "runs memory-intensive WASM external merge sort with large allocations",
  "tests/wasm-host-gate2.test.ts": "compiles and runs multiple WASM binaries through worker lifecycle and abort paths",
  "tests/emscripten-blake3-admission.test.ts": "loads blake3 wasm evidence and executes adapter KAT vectors",
  "tests/emscripten-numeric-acceptance.test.ts": "builds acceptance package with numeric WASM evidence and audits graph",
  "tests/emscripten-module-audit.test.ts": "loads and audits multiple large schema-2 Emscripten WASM binaries",
  "tests/emscripten-abi-evidence.test.ts": "loads 1.2MB emscripten-abi evidence and executes native profile tests",
  // chrome-agent-platform-mr1ak: the WALL-CLOCK half of the NTP boot contract. Measured in a real
  // browser, and on a shared fleet box the load is sibling lanes' test workers (high load/core, zero
  // compilers), which the contention classification cannot see - so a scheduler stall read as a
  // product defect and reddened the FULL gate at load/core 0.84 against the repo's own 0.35 bound.
  // The FULL gate keeps boot coverage without a timing budget (ntp-rpc-census and the other
  // browser tests load ntp.html and assert outcomes; the structural boot-scheduler assertions stay
  // in tests/ntp-boot-staging.test.ts).
  // WARNING, measured during review: this tier is NOT a quiet box. scripts/heavy-gate.ts runs
  // `deno test --parallel` over these 20 files, 19 of which are RAM/CPU-saturating WASM and Pyodide
  // stress suites, and it neither acquires the fleet slot nor promotes an environmental refusal.
  // What this entry buys is that a landing no longer takes a load-dependent verdict; a wall-clock
  // budget still needs the box quiet, and the repo's only mechanism for that is a test acquiring it
  // itself via scripts/lib/quiet-window.ts (awaitQuietWindow) - the follow-up the hub must decide.
  "tests/ntp-boot-staging-timing.test.ts":
    "wall-clock NTP boot budgets (median long tasks 0, composer-ready < 150ms, thread-hydrated <= 250ms) in a real browser; kept out of the FULL gate so a landing does not take a load-dependent verdict, but note this tier runs in parallel with WASM stress suites and is not itself quiet",
};
export const HEAVY_GATE_FILES = Object.freeze(Object.keys(HEAVY_GATE_REASONS));
export const HEAVY_GATE = new Set(HEAVY_GATE_FILES);

/**
 * The bound for ONE child production build, used by the build-heavy serial files instead of a
 * hard-coded 180s/300s (chrome-agent-platform-kj9s). MEASURED on this 2-vCPU box at load ~5, warm
 * worktree: `node build.mjs --target=store` ~72s and `node build.mjs` (developer) ~59s (evidence:
 * the kj9s bead, which names the two timing gates and their per-file measurements; the raw log paths
 * are recorded THERE and deliberately not here, because a temp-path literal in this file trips the
 * always-on durable-root guard and reds every lane's subset gate — chrome-agent-platform-j3o1).
 * 300s is ~4x the measured store
 * build: enough that a loaded box does not SIGKILL a build (a killed build cannot release its lock,
 * which is how the old 180s bound seeded the zombie/stale-lock symptom), while a genuinely hung
 * build is still killed here and NAMED before the file window expires.
 */
export const PRODUCTION_BUILD_TIMEOUT_MS = 300_000;

/**
 * Per-file serial windows (chrome-agent-platform-kj9s). ONE global window for every serial file was
 * the mismatch that made a handful of build-heavy files look like a capacity problem: those files run
 * several REAL production builds, so their cost is a property of build COUNT, not of tree health.
 * Every value here is DERIVED from the child bound and that file's build count — see THE ONE RULE
 * below; it is never a multiple of measured work — and ONLY files that genuinely need it are listed;
 * every other serial file keeps the base window, so a hang there is still caught fast.
 *
 * MEASURED 2026-10-06 by gate kj9s-measure AFTER the 7->3 / 6->3 regroup (the box was deliberately
 * loaded: a merger gate was running concurrently, so these are pessimistic):
 *   build-bootstrap      278s  (3 production builds + 2 ZIP packagings; ~216s quiet at ~72s/build)
 *   build-debug-mode     173s  (developer + store + steady-state store)
 *   build-tool-bundling   10s  -> NEEDS NO BOUND. This corrects an UNMEASURED earlier estimate of
 *                               ~510s: the two generator "regenerations" are sub-second, and the
 *                               file's only build.mjs calls are fail-fast (bogus flag, disabled
 *                               target, drifted verify). It keeps the base window.
 *   store-doc-denial       6s  via the memoized record (97s when it really builds) -> base window.
 * Per-file serial windows (chrome-agent-platform-kj9s). ONE global window for every serial file was
 * the mismatch that made a handful of build-heavy files look like a capacity problem: those files run
 * several REAL production builds, so their cost is a property of build COUNT, not of tree health.
 * ONLY files that genuinely need it are listed; every other serial file keeps the base window, so a
 * hang there is still caught fast. A per-file entry REPLACES the load-scaled base window rather than
 * scaling with it (serial-phase.mjs picks `perFileTimeoutMs?.[file] ?? timeoutMs`), so the entry is an
 * ABSOLUTE number and nothing else scales it.
 *
 * THE ONE RULE (review finding chrome-agent-platform-zv3kh replaced the stale measured-x3 wording that
 * used to live here, and chrome-agent-platform-rppwx is what that wording cost us): a window is DERIVED
 * from the child bound and the builds the file can run, never from a multiple of measured work.
 *
 *     window = BUILD_GATE_CHILD_BUILDS[file] x PRODUCTION_BUILD_TIMEOUT_MS + FILE_WINDOW_SLACK_MS
 *
 * The reason is attribution, not headroom. These files run SEQUENTIAL real builds, each under its own
 * child bound, and a LATER child cannot be NAMED until the EARLIER ones have finished, so the window
 * must exceed (the builds before the hung one, each worth up to its own bound) + one child bound. A
 * window sized as measured-work x k silently violates that: at 350s, a 100s first build plus a hung
 * second needed 400s to be named and this window SIGKILLed the group 50s first, leaving only "the file
 * timed out". tests/test-partition-guard.test.ts ASSERTS the derived invariant, so the table cannot be
 * hand-edited back below it.
 *
 * DO NOT size an entry from a measurement. Measurement's role here is EVIDENCE ONLY: it shows the
 * measured work is 5-7x below the floor (so no plausible load reaches it), and it caught that the old
 * 550_000 for build-debug-mode was already below 3 x the child bound. If a remeasurement ever suggests
 * a number smaller than the derived floor, the measurement is not the thing to change - see
 * chrome-agent-platform-fa2h1, where the child bound itself is the lever.
 *
 * MEASURED 2026-10-06 by gate kj9s-measure AFTER the 7->3 / 6->3 regroup (the box was deliberately
 * loaded: a merger gate was running concurrently, so these are pessimistic):
 *   build-bootstrap      278s  (3 production builds + 2 ZIP packagings; ~216s quiet at ~72s/build)
 *   build-debug-mode     173s  (developer + store + steady-state store)
 *   build-tool-bundling   10s  -> NEEDS NO BOUND. This corrects an UNMEASURED earlier estimate of
 *                               ~510s: the two generator "regenerations" are sub-second, and the
 *                               file's only build.mjs calls are fail-fast (bogus flag, disabled
 *                               target, drifted verify). It keeps the base window.
 *   store-doc-denial       6s  via the memoized record (97s when it really builds) -> base window.
 *
 * RE-MEASURED 2026-10-17 by gate testbuild-tn7wh (exit 0, 148s wall), because the 2026-10-06 numbers
 * had stopped describing the work: chrome-agent-platform-6gk81 then cut build-bootstrap 3->2 and
 * build-debug-mode 3->2 real builds (test:build 140.8s -> 103.3s), and the old 850s/550s had been
 * carried over unexamined. The box was loaded: 8 cores (nproc), load ~11, so about 1.4 per CPU —
 * ABOVE idle and below the base window's MAX_LOAD_SCALE of 4. (An earlier revision of this comment
 * claimed "2 vCPU = 5.5 per CPU, ABOVE MAX_LOAD_SCALE of 4". That was WRONG: the 2-vCPU figure is a
 * stale note in build.mjs from an older VM size, and I repeated it without checking. Corrected by
 * nproc/node os.cpus(). It is a loaded-box measurement, not a saturated-box one, and it is Linux-only
 * — the Mac and concurrency conditions the bead's acceptance names are an OPEN GAP, recorded on the
 * bead, not something this block may imply it covered.)
 *   build-bootstrap   83.8s  (2 production builds + 2 ZIP packagings)
 *   build-debug-mode  57.4s  (developer + store; steady-state restoral is validate-or-build)
 *   build-tool-bundling 6.3s -> still needs no bound, and its 2026-10-06 note stands.
 * A second loaded run (gate testbuild-tn7wh-verify, exit 0) is the reason the numbers below are cited
 * as a RANGE, not a point: bootstrap 84.4s (stable), tool-bundling 5.9s (stable), but debug-mode
 * 86.8s — 1.5x its first run — so a single measurement of that file is not a safe basis for a bound.
 *
 * THE FLOOR IS THE CHILD BOUNDS, NOT THE MEASUREMENT (review finding chrome-agent-platform-rppwx).
 * The windows were briefly set to x3 of the measured work (350s each). That was WRONG, and the
 * arithmetic is why: each of these files runs SEVERAL sequential real builds, and each build carries
 * its own PRODUCTION_BUILD_TIMEOUT_MS bound. The child bound kills and NAMES a hung build at (its own
 * start + that bound). A LATER child cannot be named before the EARLIER ones have finished, so for the
 * child bound to fire before this file window, the window must exceed
 *
 *     (the builds before the hung one, each worth up to its own bound) + one child bound
 *
 * i.e. at least N x PRODUCTION_BUILD_TIMEOUT_MS for a file that can run N builds. At 350s a first
 * build of 100s plus a hung second build needed 400s to be named, and the 350s file window SIGKILLed
 * the group 50s earlier, leaving only "the file timed out" — the exact attribution this table exists
 * to preserve. So each window is DERIVED from BUILD_GATE_CHILD_BUILDS and the child bound below,
 * never from a multiple of measured work, and tests/test-partition-guard.test.ts now ASSERTS that
 * invariant so it cannot drift again.
 *
 * What the measurement is therefore worth, stated plainly: it shows the measured work is 5-7x BELOW
 * the floor (so the floor is child-bound-driven and no reasonable load will reach it), and it shows
 * the OLD values were unsound TOO — 550_000 for build-debug-mode was already below 3 x 300_000, so it
 * never guaranteed child attribution either. It does NOT justify a smaller window, and this change is
 * not the speed win the bead hoped for: the real lever for catching a hang sooner is
 * PRODUCTION_BUILD_TIMEOUT_MS itself (300s, roughly 7x the ~42s measured build), whose reduction
 * carries a documented lock-leak risk and so needs its own measurement and review.
 */

/**
 * How many REAL production builds each build-behaviour file can run. This is what its window is
 * floored by (chrome-agent-platform-rppwx): a file's window must outlast every build BEFORE the hung
 * one plus one child bound, or the file window kills the hang before the child bound can name it.
 *   build-bootstrap   2 (two production builds, plus two ZIP packagings inside the same window)
 *   build-debug-mode  3 (a developer build, a store build, and the fail-closed steady-state restoral:
 *                        validate-or-build, so it builds only when the marker does NOT validate. It is
 *                        counted because a window must cover the worst case the file can REACH, not
 *                        the common case it usually takes.)
 * A file with no entry here keeps one child bound of headroom — enough for the base window, which no
 * entry may replace without this arithmetic.
 */
export const BUILD_GATE_CHILD_BUILDS = Object.freeze(
  /** @type {Record<string, number>} */ ({
    "tests/build-bootstrap.test.ts": 2,
    "tests/build-debug-mode.test.ts": 3,
  }),
);

/** Slack added to a derived window: the phase's own bookkeeping, and the ZIP packagings riding inside
 *  build-bootstrap's window, none of which has a child bound of its own to be named by. */
export const FILE_WINDOW_SLACK_MS = 50_000;

/** Derive a file window from the child bound and the builds that file can run (rppwx). */
function fileWindowMs(file) {
  return (BUILD_GATE_CHILD_BUILDS[file] ?? 1) * PRODUCTION_BUILD_TIMEOUT_MS + FILE_WINDOW_SLACK_MS;
}

export const SERIAL_FILE_TIMEOUTS = Object.freeze({
  // 2 builds x 300s + 50s = 650s, against 83.8-84.4s measured work.
  "tests/build-bootstrap.test.ts": fileWindowMs("tests/build-bootstrap.test.ts"),
  // 3 builds x 300s + 50s = 950s, against 57.4-86.8s measured work. RAISED from 550_000, which was
  // already below 3 x 300_000 and so never guaranteed child attribution (rppwx).
  "tests/build-debug-mode.test.ts": fileWindowMs("tests/build-debug-mode.test.ts"),
});

// Files a content scan classifies as hazards but that are provably
// parallel-safe. Each exemption MUST state why the shared-artifact hazard
// does not apply; the guard test pins the reason. Keep this list tiny —
// membership is a review-time decision, never a default.
export const EXEMPTIONS = {
  // uikt5: every git commit and release-stamp write occurs in a unique mkdtemp
  // scratch repository, deleted in finally. The checkout is only read for
  // source copies; no production or shared build artifact is mutated.
  "tests/post-commit-hook.test.ts": "writes extension/manifest.json and version surfaces only inside a unique mkdtemp scratch git repository removed in finally; reads tracked hook/stamper sources without touching the shared checkout",
  // uvtk4: the fixture first creates a unique temporary-directory root, and
  // all writes to extension/ and version files use paths joined under it. The
  // checkout is only read for source copies; no shared build artifact changes.
  "tests/bump-version-sanitize.test.ts": "writes extension/manifest.json and other version surfaces only inside each unique temporary-directory fixture, removed in finally; the checkout is read-only and parallel execution is safe",
  // bvj5: flagged twice by the conservative detectors; both hits checked in the file
  // rather than assumed. (1) "names build.mjs" is a READ - the only reference is
  // Deno.readTextFile(build.mjs) as static input, with no Deno.Command, no spawn and
  // no import of it anywhere in the file. The detector says itself that reading is
  // not loading and that EXEMPTIONS exists for exactly this case. (2) "writes under
  // extension/ or packages/" is a path STRING in a private sandbox: every write goes
  // into a per-test Deno.makeTempDir under durableDir("scratch") that mirrors the real
  // extension layout so the unbuilt-tree case can be asserted, and it is removed in a
  // finally. Nothing shared is read or written, so concurrent execution is harmless.
  "tests/mcp-zod-peer-parity.test.ts": "reads build.mjs as TEXT as static input (never spawned, never imported); every write is confined to a per-test makeTempDir sandbox under durableDir(scratch) removed in a finally - no shared artifact is touched, so parallel execution is harmless",
  // o49qg: these five classify as artifact hazards, but are audited read-only.
  // The sixth (tool-exec-preview) has no classifier hit and must NOT be given a
  // dead exemption. Both runners finish SERIAL first; the full runner also
  // guards the read-only post-build batch against an active/restarted build.
  "tests/diff-core.test.ts": "reads only the built diff-core bundle; post-build read-only batch follows serial rebuilds",
  "tests/wasm-tree-shaking.test.ts": "reads only built page bundles; post-build read-only batch follows serial rebuilds",
  "tests/bundle-budget.test.ts": "reads built bundles and build.mjs text; does not execute its source-string execFileSync snippet; post-build batch follows serial rebuilds",
  "tests/bundled-tool-packages.test.ts": "reads shipped CAS and generator text; Deno.Command runs git only; post-build batch follows serial rebuilds",
  // chrome-agent-platform-fixn: the drift guard plants mutated about.html / inventory fixtures
  // inside makeTempDir scratch trees to verify drift detection and fail-closed attribution;
  // the real repo tree is read, never written.
  "tests/about-page-drift-guard.test.ts": "writes mutated about.html fixtures only inside makeTempDir scratch trees to prove drift detection; the repo tree is read, never written",
  "tests/evidence-durable.test.ts": "spawns the bundled-tool generator ONLY inside a pristine makeTempDir checkout materialization; every write goes to the temp dir, never to repo extension/ or packages/",
  // yvvvd: gate-full-exact-tip unit tests test runFullGate selective build-tier logic with in-memory mocks
  "tests/gate-full-exact-tip.test.ts": "mentions build.mjs as a mock changed-file path in pure unit tests of runFullGate (in-memory mocks for ensure and run, no build spawned or executed)",
  // xe11: the owed-changelog ledger test builds throwaway git FIXTURE repos in a
  // makeTempDir and writes `extension/lib/tool.js` INSIDE them (the product-path
  // that makes a fixture commit owed). The extension/ and extension/dist literals
  // are fixture strings in temp dirs, never repo paths — and the ledger's CLI runs
  // with --repo pointing at the fixture, never at the checkout.
  "tests/owed-changelog-ledger.test.ts": "writes extension/* paths only inside its own makeTempDir git fixtures (with --repo pinned to the fixture); the repo tree is read, never written",
  // 4lc0 re-review: the fresh-instance gate plants `tests/*.test.ts` files in a makeTempDir scratch tree
  // and walks it. The write-hazard heuristic sees a write call near an `extension/` literal (the SAFE
  // fixture string it plants) and correctly flags the text — but every write goes to the scratch tree,
  // never to repo extension/ or packages/, and the file it writes is not in the real census at all.
  "tests/test-partition-guard.test.ts": "plants fixtures in a makeTempDir scratch tree; the extension/ literal is a fixture string, not a write target",
  // chrome-agent-platform-xru1: the note-contract test spawns dist-staleness-note.mjs with cwd set
  // to a durableDir scratch; its "extension/dist" literal is a path constructed INSIDE that scratch
  // (freshScratch wipes it per case) — the repo tree is never read or written. The assertions are
  // exit code 0 (the never-fail contract) and the note's wording.
  "tests/dist-note-contract.test.ts": "runs the note script inside a durableDir scratch; extension/dist is a scratch-relative path, not a repo write",
  // 4lc0 round 5 + o4m2: naming the generator in CODE (including string/template literals) is a
  // hazard, while comment prose is stripped before scanning (o4m2 aligned the build-artifact
  // detector with 8b8w's comment-ignoring driver rule). Each remaining entry was read before being
  // exempted: none of these four loads or executes anything — they read the build script's TEXT,
  // list it as a path to scan, or assert that package scripts or documents mention it in a string
  // literal. (tests/zod-jitless-fallback.test.ts and tests/bounded-child.test.ts were exempted
  // here until o4m2 stripped comments before scanning; with comment prose no longer classified as
  // a hazard, both files classify with NO hazard classes and their dead exemptions were retired.)
  "tests/changelog-shipping.test.ts": "reads ../build.mjs as TEXT to check what the changelog ships; never loads or runs it",
  // bbz3s: the driver mention is a textual call-order assertion, like changelog-shipping;
  // the resolver itself reads only per-case durable scratch stores/locks.
  "tests/security-dependency-resolution.test.ts": "reads build.mjs only as TEXT for pre-bundle call order and tests the imported pure resolver against isolated durable scratch stores; never loads/spawns a build or writes shared node_modules/dist",
  "tests/file-url-root-guard.test.ts": "lists ROOT/build.mjs as a path to scan and pins the generator path as a STRING; no import, require or execution",
  "tests/package-scripts-exist.test.ts": "asserts a package.json script REFERENCE to build.mjs resolves; it never imports the generator",
  "tests/risk-register-contract.test.ts": "asserts the risk register CITES build.mjs for the bundle budget; documentation text only",
  // (tests/durable-root.test.ts was exempted here until 8b8w reference-scoped
  // the driver inheritance: with prose mentions no longer inheriting, the file
  // classifies with NO hazard classes and there is nothing left to exempt —
  // measured by audiofeed-astra's review and re-measured on the widened
  // delimiters.)
  // i1i9 removed the 4lc0 hazard AT THE SOURCE instead of working around it: the
  // generator's top-level work now lives in main(), called only under the existing
  // isMain guard. Measured on this tree — a fresh-process import yields
  // AGENT_DESCRIPTIONS (38 entries), prints no `OK: 38 packages …` generation line, and
  // leaves the per-file mtime fingerprint of extension/wasm/cas unchanged, where before
  // the same import rewrote all 38 files. So the import and the child probe below are
  // reads: they cannot race a rebuild because they do not cause one. tests/
  // tool-descriptions.test.ts pins that purity, so a regression re-serialises this file
  // the moment the child probe reds.
  "tests/tool-descriptions.test.ts": "imports the bundled-tool generator for its one pure export and spawns a no-write child that does the same; since chrome-agent-platform-i1i9 the generation work runs only under isMain, so neither the import nor the probe writes extension/wasm/cas — measured (CAS mtime fingerprint unchanged, no generation line on stdout)",
  // chrome-agent-platform-3337: the browser-dependencies test bundles agent-do and the REAL
  // agent-worker entry to MEMORY (esbuild write:false) and executes them under fakes; it names
  // build.mjs only as a STRING in a consumer list which it then reads as TEXT, to prove the
  // process.env define+banner pair cannot be split. Nothing is imported or spawned from build.mjs, and
  // the only file written is a makeTempDir it removes — no read or write touches repo extension/ or
  // packages/.
  "tests/browser-dependencies.test.ts": "names build.mjs only inside a consumer list read as TEXT (never spawned or loaded); all bundles are in-memory (write:false) and the one written file is a removed temp dir",
  // ltkj.2: the loaded-admission harness contract test asserts on harness SOURCE text (naming
  // build.mjs/the generator inside string pins, never spawning either); the acceptance builder it
  // executes only READS tracked evidence files and returns bytes in memory. Zero filesystem writes.
  "tests/emscripten-admission-loaded-harness.test.ts": "names build.mjs only inside harness-source TEXT pins (never spawned or loaded); the acceptance builder runs read-only over tracked evidence and returns in-memory bytes; no writes at all",
  // chrome-agent-platform-jjsz: the build-discipline test parses build.mjs and scripts/package-archive.mjs
  // with acorn to pin the settleAll fan-out rule and the build-once record ordering. Its ONLY I/O is one
  // Deno.readTextFileSync per source file; it imports neither script (importing build.mjs RUNS a build),
  // spawns nothing and writes nothing, so it cannot race a rebuild of extension/dist.
  "tests/build-parallel-discipline.test.ts": "reads build.mjs and scripts/package-archive.mjs as TEXT (one readTextFileSync each) and parses them with acorn; never imported, spawned or run, and performs no writes at all",
  // chrome-agent-platform-l3dc2: the capture-site pin reads build.mjs as TEXT and parses it with
  // acorn to check the two captured fields; build.mjs is never imported (importing it RUNS a build),
  // never spawned, and the generator is untouched. The only writes are one durableDir("scratch") record
  // tree created and removed inside the same test, so no shared artifact is read or written and
  // concurrent execution cannot race a rebuild of extension/dist.
  "tests/build-once-capture.test.ts": "reads build.mjs as TEXT and parses it with acorn to pin the captured record fields (never imported, spawned or run); the only writes are a durableDir(scratch) record tree removed in the same test's finally",
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
// runtime ("tests/" + name, or a SUBSTITUTING template `../tests/${n}`) is
// invisible to every text detector here — it was equally invisible to the old
// mention rule, so the fix does not widen that hole; a hoisted-const path
// (const D = "tests/x.mjs" … spawned later) is equally dataflow-invisible;
// within a spawn argument region the window also ends at the first `;`, so a
// driver path AFTER a semicolon inside the args escapes the same way; and a
// COMMENTED-OUT import still matches its shape (fail-closed: the cost is
// an inheritance a lane did not need, never a silent parallel writer).
// NO-SUBSTITUTION TEMPLATES ARE NOT RESIDUE (audiofeed-astra's review of this
// fix): `import(`../tests/x.mjs`)` loads the module exactly like a quoted
// specifier — the shape that cost the generator taxonomy round 5 — so the
// delimiter classes include the backtick and the spawn window crosses it.
const DRIVER_LOAD_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`][^"'`\n]*?(tests\/[\w.-]+\.(?:mjs|ts))["'`]/g;
const DRIVER_SPAWN_RE = /(?:Deno\.Command\s*\(|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|\.spawn(?:Sync)?\s*\()[^;]{0,400}?(tests\/[\w.-]+\.(?:mjs|ts))/g;

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

// o4m2: strip JS comments (`//` to any ECMAScript LineTerminator: LF, CR, U+2028,
// U+2029; and `/* ... */` block comments) with full lexical awareness of single/double
// quoted strings, template literals, `${...}` template interpolations, and regex
// literals (including `\/` escapes, `[...]` character classes, and `if/while/for/with (...)`
// condition parens). A naive regex comment-stripper in 4lc0 round 2/3 failed when a regex
// literal `/\/\//` or `/"/` was misread as a comment/string or when CR/LS/PS terminated a
// line comment; this single-pass O(n) scanner handles all four ECMAScript LineTerminators
// and preserves strings, templates, interpolations, and regex literals verbatim while
// replacing comment spans with whitespace so comment prose mentioning `build.mjs` or
// `build-bundled-tool-packages.mjs` never forces a pure test into SERIAL or EXEMPTIONS.
const REGEX_OK_SIG = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}",
  ";", "+", "-", "*", "/", "%", "~", "^", "<", ">",
]);
const REGEX_OK_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new",
  "delete", "void", "throw", "do", "else", "yield", "await", "case",
]);
const REGEX_PAREN_WORDS = new Set(["if", "while", "for", "with"]);

function isLineTerminator(c) {
  return c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
}

function scanQuoted(text, i) {
  const q = text[i];
  let j = i + 1;
  const n = text.length;
  while (j < n) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (isLineTerminator(c)) return j;
    if (c === q) return j + 1;
    j++;
  }
  return n;
}

function scanRegex(text, i) {
  const n = text.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = text[j];
    if (isLineTerminator(c)) return null;
    if (c === "\\") {
      if (j + 1 < n && isLineTerminator(text[j + 1])) return null;
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      j++;
      while (j < n && /[a-z]/i.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return null;
}

function stripTemplate(text, i) {
  const n = text.length;
  const parts = ["`"];
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === "\\") {
      parts.push(text.slice(j, j + 2));
      j += 2;
      continue;
    }
    if (c === "`") {
      parts.push("`");
      return { out: parts.join(""), next: j + 1 };
    }
    if (c === "$" && text[j + 1] === "{") {
      const inner = stripCodeRange(text, j + 2, true);
      parts.push("${", inner.out);
      j = inner.next;
      continue;
    }
    parts.push(c);
    j++;
  }
  return { out: parts.join(""), next: n };
}

function stripCodeRange(text, start, stopAtClosingBrace) {
  const n = text.length;
  const parts = [];
  let i = start;
  let braceDepth = stopAtClosingBrace ? 1 : 0;
  let prevSig = "";
  let prevWord = "";
  let afterRegexParen = false;
  let noRegexBefore = -1;
  const parenStack = [];
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      parts.push(c);
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = scanQuoted(text, i);
      parts.push(text.slice(i, j));
      prevSig = c;
      prevWord = "";
      afterRegexParen = false;
      i = j;
      continue;
    }
    if (c === "`") {
      const tpl = stripTemplate(text, i);
      parts.push(tpl.out);
      prevSig = "`";
      prevWord = "";
      afterRegexParen = false;
      i = tpl.next;
      continue;
    }
    if (c === "/") {
      if (text[i + 1] === "/") {
        let j = i + 2;
        while (j < n && !isLineTerminator(text[j])) j++;
        parts.push(" ");
        i = j;
        continue;
      }
      if (text[i + 1] === "*") {
        const k = text.indexOf("*/", i + 2);
        const j = k < 0 ? n : k + 2;
        const raw = text.slice(i + 2, k < 0 ? n : k);
        parts.push(/[\n\r\u2028\u2029]/.test(raw) ? "\n" : " ");
        i = j;
        continue;
      }
      const allow =
        afterRegexParen ||
        (prevSig === "" && !prevWord) ||
        REGEX_OK_WORD.has(prevWord) ||
        (!prevWord && REGEX_OK_SIG.has(prevSig));
      if (allow && i >= noRegexBefore) {
        const j = scanRegex(text, i);
        if (j !== null) {
          parts.push(text.slice(i, j));
          prevSig = "/";
          prevWord = "";
          afterRegexParen = false;
          i = j;
          continue;
        }
        let eol = i + 1;
        while (eol < n && !isLineTerminator(text[eol])) eol++;
        noRegexBefore = eol;
      }
      parts.push("/");
      prevSig = "/";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (c === "(") {
      parenStack.push(REGEX_PAREN_WORDS.has(prevWord));
      parts.push("(");
      prevSig = "(";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (c === ")") {
      afterRegexParen = parenStack.pop() === true;
      parts.push(")");
      prevSig = ")";
      prevWord = "";
      i++;
      continue;
    }
    if (c === "{") {
      if (stopAtClosingBrace) braceDepth++;
      parts.push("{");
      prevSig = "{";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (c === "}") {
      if (stopAtClosingBrace) {
        braceDepth--;
        if (braceDepth === 0) {
          parts.push("}");
          return { out: parts.join(""), next: i + 1 };
        }
      }
      parts.push("}");
      prevSig = "}";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && isWordChar(text[j])) j++;
      prevWord = text.slice(i, j);
      prevSig = prevWord[prevWord.length - 1];
      afterRegexParen = false;
      parts.push(prevWord);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && (isWordChar(text[j]) || text[j] === ".")) j++;
      const num = text.slice(i, j);
      prevWord = "";
      prevSig = num[num.length - 1];
      afterRegexParen = false;
      parts.push(num);
      i = j;
      continue;
    }
    parts.push(c);
    prevWord = "";
    prevSig = c;
    afterRegexParen = false;
    i++;
  }
  return { out: parts.join(""), next: n };
}

export function stripComments(text) {
  return stripCodeRange(text, 0, false).out;
}

const SPAWN_CALL_RE = /(?:Deno\.Command|spawnSync|execFileSync|execSync|\.spawn|\bspawn)\s*\(/g;
const BUILD_REF_RE = /build\.mjs|build-bundled-tool-packages/;
// 4lc0 + o4m2: a test that IMPORTS or SPAWNS a build module runs it — module side effects are the
// same hazard as spawning it, and the SPAWN_CALL_RE rule above cannot see an import/re-export/require
// (including a no-substitution template specifier `import(`../scripts/build-bundled-tool-packages.mjs`)`).
// Rather than modelling every JS import syntax, any CODE reference to `build.mjs` or
// `build-bundled-tool-packages` (after stripping comments via `stripComments(text)`) is flagged and
// must be declared SERIAL or exempted with a reason. Stripping comments first (o4m2) aligns this
// detector with `realDriverRefs` (8b8w/f94p): prose comments explaining how `build.mjs` works no
// longer force pure unit tests into `EXEMPTIONS`.
const GENERATOR_NAME_RE = /(?:build\.mjs|build-bundled-tool-packages)/;
const WRITE_CALL_RE = /(?:writeTextFile|writeFileSync|writeFile|mkdirSync|mkdir|removeSync|remove|copyFile|rename)\s*\(/g;
const TREE_LITERAL_RE = /["'`][^"'`\n]*(?:extension|packages)\/[^"'`\n]*["'`]/;
const READ_RE = /readTextFile|readFile|readFileSync|readDir|readdir|import\s*\(|\bfrom\s*["']/i;
const DIST_LITERAL_RE = /extension\/dist/;

const BUILD_BINDING_RE = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=[^;\n]*(?:build\.mjs|build-bundled-tool-packages)/g;

// Extract invocation arguments inside matching parentheses
function getCallArgs(text, startIndex) {
  let depth = 1;
  let i = startIndex;
  while (i < text.length && depth > 0 && (i - startIndex) < 500) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    i++;
  }
  return text.slice(startIndex, i > startIndex ? i - 1 : startIndex);
}

// In READ_ONLY_DIST, the ONLY permitted child process execution is the reviewed
// git provenance check in tests/bundled-tool-packages.test.ts (lines 563-566).
// Enumerated strictly by call-site signature, not merely by file path.
// The check is anchored to the actual first invocation argument (the invoked executable):
// it requires the invoked command to be "git" (or 'git') and its args to match the exact
// reviewed provenance check: ["cat-file", "-e", `${baseline.takenAt}^{commit}`].
// Any other arguments, different executable, or spoofed signature in unrelated argument
// text will not match.
export function isReviewedReadOnlySpawn(rel, argsSnippet) {
  if (rel !== "tests/bundled-tool-packages.test.ts") return false;
  if (typeof argsSnippet !== "string") return false;
  return /^\s*["']git["']\s*,\s*\{[^}]*?\bargs:\s*\[\s*["']cat-file["']\s*,\s*["']-e["']\s*,\s*`\$\{baseline\.takenAt\}\^\{commit\}`\s*\]/.test(argsSnippet);
}

// Spawn hazard = a process spawn call whose invocation arguments target
// build.mjs or the bundled-tool generator directly or via simple argument bindings
// (including arrays, concatenations, and joins).
function spawnsBuild(text) {
  const boundVars = [];
  for (const m of text.matchAll(BUILD_BINDING_RE)) {
    boundVars.push(m[1]);
  }
  let targetPattern = BUILD_REF_RE;
  if (boundVars.length > 0) {
    const escaped = boundVars.map((v) => v.replace(/[$]/g, "\\$")).join("|");
    targetPattern = new RegExp(`(?:build\\.mjs|build-bundled-tool-packages|\\b(?:${escaped})\\b)`);
  }

  const spawnCallRe = /(?<!['"`])\b(?:Deno\.Command|spawnSync|execFileSync|execSync|\.spawn|\bspawn)\s*\(/g;
  for (const m of text.matchAll(spawnCallRe)) {
    const args = getCallArgs(text, m.index + m[0].length);
    if (targetPattern.test(args)) return true;
  }
  return false;
}

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
// defaults to the parallel phase. Comments are stripped first (o4m2) so prose
// comments never trigger hazard classes.
export function classifyHazards(text) {
  const code = stripComments(text);
  const classes = [];
  if (spawnsBuild(code)) classes.push("spawns build.mjs or the bundled-tool generator");
  if (GENERATOR_NAME_RE.test(code)) classes.push("names build.mjs or the bundled-tool generator (a load hazard whatever the syntax)");
  if (writesTree(code)) classes.push("writes under extension/ or packages/");
  if (READ_RE.test(code) && DIST_LITERAL_RE.test(code)) classes.push("reads extension/dist");
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
// uikt5: this exemption is for ONE isolated scratch-git fixture, not every
// writer that happens to live in this test file. Assert the scratch root and
// cleanup at their actual sites, then inspect every write/copy call destination.
// A future write to the real checkout must revoke the exemption automatically.
function isolatedLandingFixture(text) {
  const code = stripComments(text);
  if (!/const dir = await mkdtemp\(path\.join\(tmpdir\(\), "cap-landing-stamp-"\)\)/.test(code) ||
      !/const hook = path\.join\(dir, "\.git\/hooks\/post-commit"\)/.test(code) ||
      !/finally\s*\{\s*await rm\(dir, \{ recursive: true, force: true \}\)/.test(code)) return false;
  for (const match of code.matchAll(WRITE_CALL_RE)) {
    const name = match[0].slice(0, -1).trim();
    const args = getCallArgs(code, match.index + match[0].length).trim();
    if (name === "copyFile") {
      if (!/^path\.join\(ROOT, rel\), path\.join\(dir, rel\)$/.test(args) &&
          !/^path\.join\(ROOT, "scripts\/git-hooks\/post-commit"\), hook$/.test(args)) return false;
    } else if (!/^(?:path\.join\(dir,\s*[^)]*\)|dir|hook)\s*(?:,|$)/.test(args)) {
      return false;
    }
  }
  return true;
}

export function unserialisedHazards(entries) {
  const violations = [];
  for (const [rel, text] of entries) {
    const classes = classifyHazards(text);

    // A reviewed read-only exemption must never silently become a tree writer or spawn a build/unreviewed process.
    if (READ_ONLY_DIST.has(rel)) {
      if (classes.includes("writes under extension/ or packages/")) {
        violations.push(`${rel} — new write hazard in the read-only post-build batch`);
        continue;
      }
      if (classes.includes("spawns build.mjs or the bundled-tool generator")) {
        violations.push(`${rel} — new build-spawn hazard in the read-only post-build batch`);
        continue;
      }
      // Inspect every spawn call in a READ_ONLY_DIST file. Only the single reviewed git provenance
      // signature in bundled-tool-packages is permitted (exactly 1 occurrence); any other spawn,
      // any duplicate reviewed spawn, or any spawn whose arguments cannot be resolved in a
      // READ_ONLY_DIST file must be flagged.
      const code = stripComments(text);
      const spawnCallRe = /(?<!['"`])\b(?:Deno\.Command|spawnSync|execFileSync|execSync|\.spawn|\bspawn)\s*\(/g;
      let hasUnreviewedSpawn = false;
      let reviewedSpawnCount = 0;
      for (const m of code.matchAll(spawnCallRe)) {
        const args = getCallArgs(code, m.index + m[0].length);
        if (isReviewedReadOnlySpawn(rel, args)) {
          reviewedSpawnCount++;
        } else {
          hasUnreviewedSpawn = true;
          break;
        }
      }
      if (
        hasUnreviewedSpawn ||
        (rel === "tests/bundled-tool-packages.test.ts" && reviewedSpawnCount !== 1) ||
        (rel !== "tests/bundled-tool-packages.test.ts" && reviewedSpawnCount > 0)
      ) {
        violations.push(`${rel} — unreviewed spawn in the read-only post-build batch`);
        continue;
      }
    }

    if (!classes.length) continue; // safe → defaults to the parallel phase
    if (SERIAL.has(rel)) continue;
    const reason = EXEMPTIONS[rel];
    if (typeof reason === "string" && reason.trim().length > 0 &&
        (rel !== "tests/post-commit-hook.test.ts" || isolatedLandingFixture(text))) continue;
    violations.push(`${rel} — ${classes.join("; ")}`);
  }
  return violations;
}

// Keep the serial/parallel return shape for the unchanged changed-file runner
// AND its typed guard. The full runner extracts READ_ONLY_DIST from parallel
// for its guarded post-build batch. Deterministic ordering and total coverage.
export function partition(files) {
  const sorted = [...files].sort();
  return {
    serial: sorted.filter((f) => SERIAL.has(f)),
    parallel: sorted.filter((f) => !SERIAL.has(f)),
  };
}
