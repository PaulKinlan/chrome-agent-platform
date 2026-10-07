# Test-coupling inventory — every cross-file watcher

Provenance: chrome-agent-platform-icf1 (2026-09-09). The AGENTS.md canon amendment
("file-disjointness is not suite-greenness" and friends) is gated on this document
landing, so it is written to be cited.

**Who this is for:** the agent about to re-anchor, retire, move, or satisfy any pin,
allowlist entry, sentinel, count or file list whose SUBJECT lives in a DIFFERENT file.
This repo is dense with watchers whose subjects are other files; two lanes touching
disjoint files can still break each other through one. Before touching a token, grep it
(see the three book rules at the bottom), read every watcher below that names it, and run
the union check.

Each entry states: what the watcher watches, what a re-anchor owes it (the literal
command), whether it fails LOUD or SILENT when its subject moves, and which way
staleness runs. "LOUD" means the failure names the subject; "LOUD-BY-ACCIDENT" means it
fails but the message points somewhere else; "SILENT" means it passes unchanged. Verdicts
labelled **verified** were proven by a run or a mutant (this bead's, or a reviewer lane's
whole-suite mutant run); **inspection** means read from the source, not executed.

---

## 1. tests/machine-path-honesty.test.ts

- **Watches:** every file under `tests/` (recursive walk, asserts >100 files) for an
  absolute path under `/home`, `/root`, `/Users` reaching a filesystem call — as a
  literal or through a const. Line comments are skipped; `file://` URLs and env-fixture
  values are legal — EXCEPT a `file://` URL naming a home directory that reaches
  `import(…)`, literal or through a const (`detectUrlImportHomeLiteral`, added
  2026-10-06 by hi7t after review49-regression.test.ts imported the author's own
  worktree and died 0/9 on every other machine). A file URL that is only parsed or
  compared (`new URL(…)`) stays legal, and its probe holds that boundary.
- **Owed by a re-anchor:** `git grep -n "/home/\|/root/\|/Users/" -- tests/` before
  removing any absolute path from a test; the allowlist key is `` file::path `` so a
  one-line move does not break it.
- **Subject moves:** LOUD, verified — names `file:line [kind]` and the path. With the
  allowlist EMPTY (icf1), any new absolute home path is an immediate red with no
  exception path; re-introducing the retired Chrome pin reds it naming the exact line.
- **Staleness:** self-tracking, verified — an allowlist entry that stops matching any hit
  FAILS (`staleEntries`, probed by its own test). Empty today, so the main stale
  assertion cannot fail; the probe is what keeps the mechanism honest.
- **Harness coverage (resolved in chrome-agent-platform-3khn @ f75e6afb):** walks both `tests/`
  and `scripts/` (`tests/machine-path-honesty.test.ts:250`). All seven `kat-*` harnesses were migrated to
  `resolveChromeForTesting()` and `scripts/lib/chrome-process-ownership.ts`; the machine-path guard
  asserts zero home-directory paths across both directories with an empty `ALLOWED` map.

## 2. tests/substring-pin-honesty.test.ts

- **Watches:** the whole repo's substring pins (`src.includes(...)` and `assertMatch`
  shapes) over REAL target files: are they attributed, do they have a live occurrence, a
  shadow, an absence proof — plus a set of repo-wide sentinels and hard-count floors.
- **Owed by a re-anchor:** `git grep -n "<the pinned token>" -- <target file>` and label
  every occurrence (comment / import / binding / live construct) before retiring or
  re-anchoring anything the guard attributes. Its ALLOWED keys are intent-keyed; an entry
  that stops matching fails like machine-path-honesty's.
- **Subject moves:** LOUD with counter names. New vacuous pin → red; deleted target file
  → `stats.missing` red ("a miss here is a resolver bug").
- **The counts are watchers too** (verified by inspection of the assertions at
  `tests/substring-pin-honesty.test.ts:1955-2002`): exact `skippedBuildArtifact === 2`,
  `skippedInterpolated === 13`; floors `attributedPins >= 699`,
  `propertyReceivers >= 300`, `unattributed >= 1000`, `skippedAbsence >= 100`,
  `skippedDisjunction >= 9`, `targets >= 73`; and `testFiles` must equal a live
  `readDirSync` of `tests/`. Adding/removing pins ANYWHERE in the repo moves these
  numbers, so an unrelated lane's new test file can redden this guard through a count,
  with a message about a statistic — LOUD-BY-ACCIDENT if you do not know the coupling.
  The drill: read the counter the message names, not just your own diff.

## 3. tests/test-partition-guard.test.ts + scripts/test-partition.mjs

- **Watches:** (a) every test file whose CONTENT is a build-artifact hazard (spawns the
  build, writes under `extension/` or `packages/`, reads `extension/dist`) must be in
  `SERIAL_REASONS` or `EXEMPTIONS`; (b) SERIAL/EXEMPTIONS entries must exist on disk with
  non-empty reasons and never both; (c) the phase split is total and disjoint; (d) a new
  hazard-free file defaults to parallel.
- **Owed by a re-anchor:** if your test spawns `node build.mjs`, writes into the shipped
  tree, or reads `extension/dist`, add it to `SERIAL_REASONS` in
  `scripts/test-partition.mjs` with the reason in the SAME commit.
- **The inheritance rule (reference-scoped by 8b8w/f94p, 2026-09-25):** the partition guard
  merges a test file with the text of every `tests/*` driver the file LOADS (import/from/
  require specifier) or SPAWNS (spawn/exec argument). A PROSE mention — a comment, a doc
  string, an allowlist key naming a sibling test — is no longer a reference and inherits
  nothing (the old mention rule made a census comment pull a serial file's reads-dist hazard
  into the mentioning file; measured, then fixed). Runtime assembly of sibling paths is no
  longer REQUIRED for the partition's sake, though machine-path-honesty's allowlist keeps
  the convention for its own reasons. What still inherits: a real module specifier or spawn
  argument — including a COMMENTED-OUT one (fail-closed).
- **The build-artifact rule (comment-stripped by o4m2):** `classifyHazards` strips JS
  comments (`//` to any ECMAScript LineTerminator and `/* ... */` block comments, with
  full string/template/interpolation/regex awareness) before scanning for `build.mjs` /
  `build-bundled-tool-packages.mjs` references, aligning it with the driver rule so
  prose comments explaining build variables never force a pure test into `EXEMPTIONS`.
- **Subject moves:** LOUD, naming file and hazard classes.

## 4. tests/docs-process-truth.test.ts

- **Watches:** the honesty of the process docs — `citedPaths()` over `AGENTS.md` (every
  path it cites must EXIST on disk; ≥30 citations must still be seen), retirement
  markers on every line that names a retired tracker in `POINTER_DOCS` (`README.md`,
  `PLAN.md`, `AGENTS.md`, `docs/KNOWN-ISSUES*.md`, `docs/AGENT-MODEL.md`,
  `docs/UI-FIXES-TRACKER.md`), RETIRED banners in the four retired trackers, the banned
  project name (a case-insensitive match over EVERY tracked markdown file, allowlisted
  to a closed four-file set), and no empty section in AGENTS.md.
- **Owed by a re-anchor:** before removing/renaming any doc or path, `git grep -rn
  "<path>" -- AGENTS.md README.md PLAN.md docs/`; before adding a tracked markdown file,
  keep it free of the banned name unless it joins the allowlist.
- **Subject moves:** LOUD naming the doc and line. Two couplings worth naming:
  (1) the canon amendment must not cite a new doc before that doc is committed — a cited
  path that does not exist is a red, the same shape as the 1fd1a980 incident;
  (2) the banned-name allowlist is a closed set — a new doc cannot carry the banned name
  even to explain the ban (this inventory's first draft did exactly that, while
  documenting the rule, and was fixed before landing).

## 5. tests/reachability.test.ts + scripts/check-reachability.mjs

- **Watches:** every source file under `extension/` must be reached from a manifest
  entry point, a build entry, or a `RETAINED` root with a non-empty reason. The guard
  plants an unreferenced file in a copy of the tree to prove it can fail.
- **Owed by a re-anchor:** `node scripts/check-reachability.mjs` (or run the guard)
  after deleting/renaming anything under `extension/`; new unreferenced code needs an
  entry point or a RETAINED line with a reason.
- **Subject moves:** LOUD (names the unreachable files); stale RETAINED lines are
  reported too (missing file, already-reached file, empty reason) — self-tracking both
  ways.

## 6. tests/vocabulary.test.ts + `npm run check:vocabulary`

- **Watches:** noun discipline over the extension's user-facing surfaces (`extension/ntp/
  ntp.html`, `extension/ntp/ntp.js`, and the other surfaces the check scans) — banned and
  drifted vocabulary, one view/one title rules.
- **Owed by a re-anchor:** `npm run check:vocabulary` after renaming a user-facing noun
  or adding a surface; scanSource fixtures in the guard are assembled strings, so the
  guard's own text stays clean.
- **Subject moves:** LOUD naming the surface and the offending string.

## 7. tests/harness-registry.test.ts + scripts/lib/harness-registry.ts

- **Watches:** every TOP-LEVEL `scripts/*.ts` has exactly one registry entry with a
  class (`gate`/`named`/`kat`/`manual`/`helper`); every `kat-*.ts` is either run by
  `scripts/kat-runner.ts` or in `RETIRED_KATS` with a reason; KAT verdicts are read from
  `.cache/kat-verdicts.json` (`KAT_VERDICTS_PATH`) and `staleExpectedReds()` reports an
  expected-red KAT last seen green.
- **Owed by a re-anchor:** `harnessFiles()` reads top-level `scripts/*.ts` only — "lib/
  is not a harness" — so a new `scripts/lib/*.ts` owes nothing here, while a new
  top-level script owes a registry entry in the same commit. `bd`-side: the registry
  entry, not the file, is what makes a KAT run.
- **Subject moves:** LOUD (counts and names). A harness file deleted without retiring its
  entry is a red; an unregistered new harness is a red.

## 8. scripts/lib/expected-red.ts + scripts/kat-runner.ts

- **Watches:** owned failures. An EXPECTED-RED check keeps running, is printed with its
  owner, counted apart from real failures — and the run FAILS the moment it turns green
  (prune the entry), the moment an owned name never runs (`stale()`), or on a hang.
- **Owed by a re-anchor:** the registry's expected-red entries pin TALLIES
  (`kat-genui-error-state` "15/3", `kat-mic-state` "59/1", `kat-ux-lows` "8/2"). Anything
  that can move a tally — including a browser-version change (icf1's resolver resolves
  the NEWEST Chrome for Testing) — owes re-adjudication of the entry with a reason, in
  the registry, before landing.
- **Subject moves:** LOUD by construction — this module is itself a mode-4 detector: a
  verdict that moved for a reason other than the property under test turns into an
  explicit failure instead of a green.

## 9. The dist-complete indexed-source marker

- **Watches:** `extension/dist` artifacts are indexed and marked
  (`scripts/dist-complete.mjs`); consumers: `tests/build-bootstrap.test.ts` and
  `tests/build-debug-mode.test.ts` (produce markers), `tests/bundle-budget.test.ts`,
  `tests/package-extension-freshness-driver.mjs` (writes the marker),
  `tests/dist-staleness-note.test.ts` (writes scratch markers),
  `tests/tool-exec-preview.test.ts` (revalidates REAL shipped bytes), plus
  `scripts/package-archive.mjs`, `scripts/emscripten-abi-loaded.ts`,
  `scripts/evidence-runner.sh`.
  **Since chrome-agent-platform-o2t3 the marker binds TWELVE outputs**
  (`DIST_COMPLETE_OUTPUTS`: SW, options, ntp, sidepanel, diff-core, agent worker, plus
  the six secondary surface bundles — artifacts, artifact, directory, privacy,
  offscreen, user-wasm-store-client), and `STORE_BUNDLE_BUDGETS` in
  `scripts/bundle-budget.mjs` must name the SAME set
  (`tests/bundle-budget.test.ts` "every generated bundle has a ceiling"). o2t3 closed
  the gap in which those six declared a `budget:` in build.mjs but were named by
  neither list, so nothing reported their size and the marker recorded no hash for
  them; `tests/bundle-budget.test.ts` now also pins every declared budget to a reported
  one and every archived bundle to a recorded one. Before o2t3 (chrome-agent-platform
  9epn.4) the marker bound SIX outputs. Both scratch
  fixtures above iterate `DIST_COMPLETE_OUTPUTS`, so adding a bundle to the build means
  adding it to BOTH lists and nothing else; a scratch fixture that hand-writes two
  files will fail with `generated output is missing or special: <path>`.
- **Owed by a re-anchor:** ANY edit under `extension/` owes a rebuild before a test that
  reads dist; a whole `npm test` rebuilds and re-indexes first, which is why
  "dist.complete validation failed: marker indexed source authority is stale" appears
  only when a source edit is made WITHOUT the rebuild — an artifact-of-stale-build red,
  not a kill (AGENTS.md mode 4, measured).
- **Subject moves:** LOUD-BY-ACCIDENT: the message names marker authority, not your edit.
  This is also why those files are serial-phase: the marker is shared state.

## 9a. The per-surface bundle references and the unbundled-page census (9epn.4)

- **Watches:** `STORE_BUNDLE_BUDGETS` (scripts/bundle-budget.mjs) — the store build
  REPORTS every bundle against its reference (owner decision Paul, 2026-10-05:
  sizes are measured and reported, not enforced; `assertBundleBudget` still
  fails closed on duplicated/drifted dependency inputs) and
  `tests/bundle-budget.test.ts` prints the sizes recorded in
  `dist.complete` against the same table (report-only).
  `tests/unbundled-page-census.test.ts` pins
  the transitive STATIC-import byte total of each raw-module page (artifact,
  artifacts, directory, privacy, offscreen) at its measured value with
  **zero headroom**.
- **Owed by a re-anchor:** any byte added to a module in those graphs — above all
  `extension/shared/components.js`, which every page imports — reds the census. That is
  the design (growth must be accepted consciously), not a flake: re-measure with
  `node scripts/lib/page-import-census.mjs . --modules`, move the pin, and NAME the move
  in the report. Subset gates do not select the census (it reads files dynamically);
  only `npm test` shows it. The bundling bead ratchets the pins down.
- **Subject moves:** LOUD: the assertion names the page, the new total, the pin, the
  delta and the re-measure command.

## 10. tests/quiet-window.test.ts + tests/quiet-window-static.test.ts + scripts/lib/quiet-window.ts + the registry

- **Split by chrome-agent-platform-fgik:** the assertions that read tracked source as
  data — the registry ↔ source agreement below, and the `scripts/chrome-journeys.ts`
  pins — live in `tests/quiet-window-static.test.ts`, which spawns nothing and is in
  the ALWAYS_ON set. `tests/quiet-window.test.ts` keeps the burner/waiting workload
  (real esbuild processes, load sampling, refusal simulation) and runs in the full
  suite only: it cost 23s as an always-on member and injected compiler load into
  other lanes' gates. A pin that names a file must name the one it is actually in.
- **Watches:** the three-verdict contract (0 ran-and-passed / 1 ran-and-failed /
  75 environmental refusal) and the agreement between the set of harnesses DECLARED
  load-sensitive (`loadSensitive` in `scripts/lib/harness-registry.ts`) and the set that
  actually honour it — a declaration nobody honours cannot survive; the guard fails if
  the two sets disagree.
  **Also watches `scripts/chrome-journeys.ts` FROM the test file (9t1p):** its
  evaluate-timeout catch must call `measureEvaluateTimeout()` and its exit site must go
  through `evaluateTimeoutReport()`, with the retired `environmentalAbort` boolean and
  the fixed `"under fleet load"` marker payload both absent. That is a cross-file
  watcher: the subject lives in the harness, the assertion lives in the test.
- **Owed by a re-anchor:** a gate that reddens under machine load gets
  `launchChrome({ requireQuiet: true })` + a `loadSensitive` reason in the registry in
  the same commit, and maps its refusal to exit 75 + an `ENVIRONMENT:` line — never
  relabelled EXPECTED-RED, never manufactured by killing another lane's processes.
  Anything that moves the journeys' abort path owes `git grep -n "measureEvaluateTimeout\\|evaluateTimeoutReport\\|environmentalAbort"`: an evaluate timeout is classified by
  MEASUREMENT (`loaded` / `idle-never-settled` / `unmeasurable`), and only the first and
  last are environmental — an idle box that never settled is a product red and its line
  must not carry `CAP_ENVIRONMENTAL_REFUSAL`.
- **Subject moves:** LOUD naming the harness.

## 10b. tests/journey-scripted-probe.test.ts + `runScriptedToolProbe` in scripts/chrome-journeys.ts

- **Watches:** the probe's own expectation (9t1p). It SOURCE-EXTRACTS
  `runScriptedToolProbe` (from `async function runScriptedToolProbe(` to the
  `/** Capture a PNG screenshot` comment) and executes it with every collaborator and
  the clock injected — importing the harness would launch browsers, and a substring pin
  on the shortfall throw would pass with the throw deleted.
- **Owed by a re-anchor:** renaming the function, or moving the `captureShot` comment
  that bounds the slice, breaks the extraction LOUDLY (`the real runScriptedToolProbe
  must be found`). Changing the shortfall message means updating the assertions that
  name the count, the elapsed time, the run phase, and the unanswered-round-trip case.
  The probe must keep failing where the expectation breaks rather than returning a
  partial result.
- **Subject moves:** LOUD at import time.

## 11. tests/harness-debug-port.test.ts

- **Watches:** `scripts/` RECURSIVELY — any fixed `--remote-debugging-port=` anywhere,
  and any spawn path other than `launchChrome()` writing the flag. `launchChrome` is the
  only writer of the debugging-port flag in the repo.
- **Owed by a re-anchor:** `git grep -n "remote-debugging-port" -- scripts/` after
  touching any browser spawn; new harnesses spawn only through
  `scripts/lib/chrome-launch.ts`.
- **Subject moves:** LOUD naming the file and the port.

## 12. tests/chrome-profile-isolation.test.ts + tests/chrome-profile-location.test.ts

- **Watches:** EVERY launch site — profile isolation (per-instance profiles;
  `instanceProfile()` when the base is an operator knob) and profile location (outside
  the repository, durable root, via `chromeProfileDir()`); the location guard copies a
  whole tree under a live browser to prove the failure it exists for.
- **Owed by a re-anchor:** `git grep -n "user-data-dir" -- scripts/ tests/` after any
  launch-site change; never `--user-data-dir=${ROOT}.cache/…`.
- **Subject moves:** LOUD naming the launch site.

## 13. tests/security-suite-custody.test.ts

- **Watches:** the production custody chain (its supervisor/runner scripts plus
  `scripts/lib/chrome-launch.ts` and `scripts/lib/chrome-slots.ts`) as immutable,
  hash-pinned files; the absence of the retired slot-poison mechanism in those files'
  CODE (comment-stripped read); and the absence of the retired marker file on the box.
- **Owed by a re-anchor:** touching any file in its list owes re-running this guard, and
  its custody-chain hashes are re-pinned deliberately, not incidentally. A transient
  poison marker left by another lane reddens a whole `npm test` for everyone (yr6e) —
  environmental-looking, so check the marker before blaming the tree.
- **Subject moves:** LOUD naming the file and the reason.

## 14. tests/changelog.test.ts + extension/options/changelog-filter.js

- **Watches:** CHANGELOG.md — entries descending, latest equals `package.json` version,
  `extension/CHANGELOG.md` byte-identical to root, the recent-five partition, and the
  user-facing filter (conventional prefixes, bare SHAs, jargon
  `journey|KAT|assertion|CDP|harness|worktree|lane|tracker|splice`, RED/GREEN,
  workflow-status words, leaked joiners) over the visible bullets.
- **Owed by a re-anchor:** the post-commit hook bumps and writes the entry from your
  commit subject — write subjects whose SANITIZED form is user-sayable (`scripts/
  bump-version.mjs` strips ids and substitutes journey→check); `npm run check:changelog`
  before pushing.
- **Subject moves:** LOUD (order, lockstep, drift, and banned-vocabulary offenders are
  all named).

## 15. scripts/select-tests.mjs (`npm run test:changed`) + scripts/run-tests.mjs

- **Watches:** the changed-subset gate selects every test that transitively imports what
  changed plus the always-on security/vocabulary core, and FAILS CLOSED to the full
  suite when a changed executable/config file has no reachable test — the honest
  direction, but it means a green `test:changed` is sometimes the FULL suite in disguise
  (icf1 observed exactly that: `scripts/kat-bgagent-delete.ts` is referenced via
  `new URL(...).pathname`, never imported, so the subset was refused).
- **Owed by a re-anchor:** a new test file is only proven by `npm test`, never by
  `test:changed` alone (a fleet lesson from 2026-09-07); anything touching `scripts/` or
  a shared runner gets the full suite.
- **Subject moves:** run-tests LOUD if a SERIAL entry stops existing; select-tests LOUD
  printing the uncovered files.

## 16. The Chrome-slot / canonical-lock test family

`tests/chrome-launch-lock.test.ts`, `tests/chrome-launch-lock-scope.test.ts`,
`tests/chrome-slot-semaphore.test.ts`, `tests/chrome-slot-semaphore-honesty.test.ts`
mutate process-global env (`CAP_CHROME_LOCK_PATH`, `CAP_CHROME_SLOT_DIR`) and assert on
wall-clock queueing — they live in the SERIAL phase for that reason, and the partition
guard keeps them there. **Owed:** a new test that mutates those variables joins SERIAL
with a reason or owns a unique slot dir; in the 32-worker parallel phase it flakes
exactly like the failures that put the others there. **Subject moves:** LOUD-BY-ACCIDENT
(a timeout or a queueing assertion, not "you raced me").

## 17. The journey-tally coupling (added by icf1)

`tests/bgagent-delete.test.ts` holds `JOURNEY_CHECK_FLOOR = 15` against the 15
`check()` calls in `scripts/kat-bgagent-delete.ts`, and asserts the harness's printed
tally plus the `NOTE: Chrome for Testing: <path>` line. There is NO automated watcher
between the constant and the harness's checks — by design it is a floor (adding checks
is free), and the detection drill is the instance-removal mutant, verified: deleting one
`check()` call reddens the gate with "the journey ran 14 checks, below the 15 it owns".
**Owed by a re-anchor:** `grep -c "^check(\|^  check(" scripts/kat-bgagent-delete.ts`
before changing the harness's check count; the floor is a floor, so only REMOVAL needs
the constant updated. The resolver itself (`scripts/lib/chrome-for-testing.ts`) is the
single source of "which Chrome for Testing exists" for the gate and the harness — until
chrome-agent-platform-3khn lands there are TWO ways to name it in `scripts/` (the
resolver and seven literals), and a lane adding a harness will copy a neighbour, i.e.
the literal.

## 18. tests/wasm-tree-shaking.test.ts + the built page bundles (added by cc18)

- **Watches:** the three BUILT page bundles — `extension/dist/options.bundle.js`,
  `ntp.bundle.js`, `sidepanel.bundle.js` — for any `WebAssembly.{instantiate,
  instantiateStreaming,compile,compileStreaming,validate,Module,Instance}` call site.
  Wasm executes in the workers (`extension/lib/wasm-execution-worker.js`,
  `wasm-stream-worker.js`); a page bundle carrying a call means the j6au tree-shaking
  stopped holding. The subject is a BUILT ARTIFACT, not a source file, so the test is in
  SERIAL (`scripts/test-partition.mjs`) and fails closed when `extension/dist` is absent
  rather than skipping.
- **The trap it exists around:** each page bundle contains the bare word `WebAssembly`
  five times and every one is UI copy ("Add a WebAssembly file"). A bare-word grep counts
  5 and means nothing; `scripts/lib/wasm-call-scan.mjs` counts API calls and returns 0.
  Never re-anchor this to a word count.
- **Owed by a re-anchor:** adding any `import` to `extension/options/options.js`,
  `ntp/ntp.js` or `sidepanel/sidepanel.js` that transitively reaches a wasm runtime; the
  guard names the offending bundle and the call site. The POSITIVE CONTROL
  (`wasm-tools/python/pyodide.asm.js`, tracked, 21 real calls) must keep reporting > 0 —
  if it ever reports 0 the scanner is broken and a clean result proves nothing.
- **Detection drill, run 2026-09-23:** a static
  `import { runWorkerJob } from "../lib/wasm-execution-worker.js"` in the options entry
  took `options.bundle.js` from 0 to 1 call site and reddened the property assertion by
  name; removing it restored 4/4. (A first mutant attempt using a `globalThis.__cap…`
  keep-alive was REFUSED by build.mjs's shipped-code scan as a test oracle — the build
  exited 1 and wrote no bundles, so the stale zeros it left behind were not a result.)
- **Subject moves:** LOUD naming the bundle and the call site.

---

## 19. tests/sw-dispatch-authority-census.test.ts + routes and companion docs (zb58/r073)

- **What watches what:** `tests/sw-dispatch-authority-census.test.ts` derives the 285 registered service-worker routes from AST composition (`mergeRouteMaps`) and guards count and naming consistency across companion documentation:
  - `extension/background/routes/ROUTE_MAP.md` (total count and group breakdowns)
  - `docs/RISK-REGISTER.md` (R11 unclassified mutation routes)
  - `THREAT_MODEL.md` (broker registered routes and gap census)
  - `docs/ARCHITECTURE.md:211` (complete 285-route population)
  - `docs/NATIVE-AGENT-POSITION-PLAN.md:37` (285-route dispatch authority)
- **The trap it exists around:** Moving or adding a service worker route updates AST composition but leaves doc route counts silently stale (e.g. 258/276 rot before zb58/r073).
- **Owed by a re-anchor:** Whenever a route is added, renamed, or deleted, update the corresponding module, `ROUTE_MAP.md`, `RISK-REGISTER.md`, `THREAT_MODEL.md`, `ARCHITECTURE.md`, and `NATIVE-AGENT-POSITION-PLAN.md`.
- **Subject moves:** LOUD, naming the specific document and asserting AST population equality.

---

## 20. scripts/check-owed-changelog.mjs + tests/owed-changelog-ledger.test.ts (added by xe11)

- **What watches what:** the owed-changelog ledger — `scripts/check-owed-changelog.mjs`
  (chained into `npm run check:changelog` by `scripts/sync-changelog.mjs`, aliased as
  `npm run check:changelog-ledger`, and live-asserted by the last test in
  `tests/owed-changelog-ledger.test.ts`) reads **HEAD's** `CHANGELOG.md` plus EVERY
  surface that declares the version (package.json, `extension/manifest.json`
  `version` + `version_name` — the extension's build identity, package-lock.json
  root + `packages[""]`, and the generated inventory's `release`), with fenced
  code blocks stripped before the heading scan (a `## [x.y.z]` quoted inside a
  fence is documentation, not a release). It finds the commit that introduced the
  newest `## [x.y.z]` heading (pickaxe `-S`), and fails when any non-merge commit
  after it changes shipped product code (`extension/` minus `*.md`,
  `bundled-inventory-data.js`, `dist/`) without a release entry, or when ANY
  surface's version and the newest heading disagree — each disagreeing surface
  named with its version, never just "package.json".
- **The trap it exists around:** the identity check (`check-changelog.mjs`) compares the
  changelog against `package.json` — a STALL keeps both sides equally stale and green
  (0.3.577 sat unchanged for a full day while 200+ commits landed; the post-commit bump
  hook was not installed in the checkout's shared `.git/hooks`).
- **Owed by a re-anchor:** if the product-surface definition moves (new top-level
  product dir, a new generated file under `extension/`), update `isProductPath` — its
  truth lives in `tests/owed-changelog-ledger.test.ts`'s classifier test. The ledger is
  HEAD-based by design: uncommitted entries are invisible, so the gate reads clean only
  once the release commit exists.
- **Subject moves:** LOUD — the failure names each owed commit (sha + subject + files),
  the release it falls behind, and (for the agreement leg) every disagreeing
  version surface with its version.

---

## 21. tests/source-inspecting-tests-guard.test.ts + test-reachable shared source modules (2irv/i0rf)

- **Watches:** repo-root/top-level-source directory walks in `tests/**` require
  a guard in `ALWAYS_ON`; afpl covers nested support helpers outside fixtures.
  For an imported module **outside** `tests/` (e.g. `scripts/lib/harness-registry.ts`,
  `scripts/select-tests.mjs`, `build.mjs`), 2irv classifies the real source file
  and follows `buildReverseGraph()` back to an `ALWAYS_ON` test. i0rf also
  checks imported executable `tests/fixtures/**/*.{js,ts,mjs}` modules, without
  scanning JSON, HTML or unimported data fixtures. Helpers/fixtures cannot be
  listed as test guards themselves.
- **Edge truth (i0rf):** `new URL(path, import.meta.url)` is an edge only in
  executable source code, not in a string/template/regexp/comment quoted by a
  test. Acorn's lexer retains edges on unsupported syntax rather than hiding
  them. 57uw also reports each Acorn lexer failure to the always-on audit by
  source path while selection retains the edges: otherwise an unlexable
  always-on test with a quoted URL could silently credit a phantom consumer.
  The single pinned exception, `scripts/perf-gallery-previews.ts`, has TS syntax
  Acorn cannot tokenize and retains only `..` (a directory, not an executable
  import); any new failure or disappearance of that exception is a named RED
  until reviewed. A test node TERMINATES the consumer walk: another always-on
  test that merely reads that test's text cannot inherit its imports. A direct
  always-on source-text read of the actual module remains a direct consumer
  (this is how `tests/changelog-shipping.test.ts` covers `build.mjs`), but a
  quoted URL in a synthetic source sample never becomes one.
- **Owed by a re-anchor:** when moving a repo walk into a shared source/helper,
  ensure a consuming test is in `SOURCE_INSPECTING_GUARDS` (or make the source
  read directly by the already-always-on test); run
  `npm run test:file -- tests/source-inspecting-tests-guard.test.ts` after the
  move. New executable modules with no importing test already fail closed to the
  full suite via `changedWithoutCoverage`.
- **Subject moves:** LOUD — an uncovered outside-root walker is named. The
  real-tree falsifications remove actual always-on consumers of `build.mjs` and
  `scripts/lib/harness-registry.ts`; i0rf needs to remove only the two tests
  that execute the registry, not `substring-pin-honesty` (it only quoted a URL
  in a synthetic template). An in-memory source mutation of the **real**
  test-imported `tests/fixtures/build-once.mjs` proves an executable fixture
  walk is caught without creating a transient test file in the parallel suite.
  57uw pins runner-vs-audit test credit: `npm test` recursively discovers
  `tests/**/*.test.ts`, including a hypothetical `tests/fixtures/**/*.test.ts`;
  fixture tests are data, never credited as an always-on consumer, and the
  guard asserts none currently exist. `*.test.js` files are terminal graph
  nodes but do not count as coverage because the runner never executes them.
  Synthetic names/edges falsify both policies without creating test files.
- **Known limit (i0rf N3):** a shipped entry such as `extension/privacy/privacy.js`
  is bundled into `extension/dist/privacy.bundle.js` but is not a key in the
  test reverse-import graph. `changedWithoutCoverage` does fail an edit of the
  source closed to the full suite; that does NOT mean this scanner can see a
  repo walk in the source. Generated bundles are excluded. Custom walk names,
  unparsed dynamic imports, and source-root aliases the classifier cannot
  recognize also remain outside its proof.

## 22. The build-concurrency, build-once and reap-the-leader watchers (chrome-agent-platform-jjsz)

- **Watches:** these tests read or execute a file other than their own, so editing the
  subject can redden them with a message that names the rule, not your edit.
  `tests/build-parallel-discipline.test.ts` reads `build.mjs` and `scripts/package-archive.mjs`
  as TEXT (an acorn AST, never imported or run): every staging fan-out goes through
  `settleAll` and is awaited (never `Promise.all` / `race` / `any` / `allSettled`, no
  `globalThis` or `Reflect` indirection), every `package-archive.mjs` function that calls a
  write primitive is held to the same rule, the one `writeBuildOnceRecord` call sits after the
  last top-level `try` with its exact arguments and nothing fatal after it, and the GC grace
  goes through `resolveGcGraceMs`. It has a reasoned entry in `scripts/test-partition.mjs`.
  `tests/build-once-record.test.ts` EXECUTES `scripts/lib/build-once-record.mjs` (the one
  writer of `serial-build-once/<key>.json`) against real files and judges it with an oracle
  that deliberately does not import the gate; its "fixture tie" tests compare the written
  directory, file name and property list with the reader in `tests/fixtures/build-once.mjs`
  (what `build-smoke` and `store-doc-denial` trust). `tests/build-concurrency.test.ts` pins
  `settleAll` and `resolveGcGraceMs` (`scripts/lib/build-concurrency.mjs`),
  `tests/scrub-zod-doc.test.ts` pins the fast path in `scripts/lib/scrub-zod-doc.mjs`, and
  `tests/jjsz-lifeline-runner-exit.test.ts` reads `scripts/security-suite.ts`,
  `scripts/page-actions-journey.ts` and `scripts/keyless-first-result.ts` as text to pin each
  `reapLeaderAndSettle` call site.
- **Owed by a re-anchor:** editing a fan-out, the record call, the GC grace or a leader kill in
  one of those files owes `npm run test:file -- tests/<each file named above>.test.ts` before
  you believe the change is local. Changing the record's shape in `tests/fixtures/build-once.mjs`
  owes the same shape in `scripts/lib/build-once-record.mjs`; changing what the discipline test
  reads owes its `scripts/test-partition.mjs` reason.
- **Subject moves:** LOUD, verified by mutation: reverting or weakening each pinned rule turned a
  named test red across 258 worker mutants and 63 coordinator mutants of the build pins (the
  one survivor was an equivalent mutant: `exitCode == 0` behind a `typeof exitCode === "number"`
  guard). The reap pins were drilled in a private snapshot too: 26 of 28 mutants of the helper,
  the fixture and the three call sites went red with the intended killer. One (the helper's
  `kill` removed) never terminates, because the leader is never signalled and the helper tests
  wait on it, so it was stopped by hand and is not counted as a clean kill. One survived (the
  import deleted while the call stays), which is why the binding pin exists; its 12 mutants (four
  per script: import deleted, another export aliased to the name, imported from another module,
  defined locally) are each killed by that pin alone.
- **Known limits, stated in the test headers (not claimed closed):** a write through a primitive
  outside the 20 names the discipline test lists; an imported helper that fans out with
  `Promise.all` internally; a fatal raised from an exit handler after the record call; and a
  new script that bare-kills a launched leader and then exits or relaunches: the reap pins are
  per-site, not a rule (`chrome-agent-platform-6efbv`).

---

## The four book rules

**(a) File-disjointness is not suite-greenness.** Two lanes whose diffs touch disjoint
files can still break each other through any watcher above — a count floor in
substring-pin-honesty, a partition hazard inherited from a mentioned path, a cited path
in AGENTS.md, a tally in the harness registry. Neither lane alone can see it; only the
union gated together can. Proven repeatedly: icf1's resolver tests alone were green while
an unrelated lane's change moved `test:changed`'s selection; the 9t1b lesson (a new
helper passed its own file and broke `tests/chrome-profile-isolation.test.ts`) is the
same shape one directory over.

**(b) Scratch-worktree-at-tip for the union check.** The recipe, never a lane's own dirty
tree: `git fetch origin && git worktree add ~/worktrees/union-<name> --detach origin/main`,
apply/merge both sides, set the worktree up (`npm ci && deno install && npm run build` —
each missing step fails somewhere that does not name it), then `npm run test:changed`
knowing it may fail closed, and `npm test` at that tip. Merges land through the
coordinator with both sides' features preserved. Durable storage, never tmpfs.

**(c) Grep the token before retiring it.** The origin incident: c9y8's R4 sentinel
watched a bare-word pin; lrok re-anchored that pin away; main went red at 1fd1a980 until
glm-flash-1's repair d7af497f. One grep would have caught it. The drill, before retiring
or moving ANY pin, token, count or path:

```
git grep -n "<token>" -- tests/ scripts/ docs/ AGENTS.md README.md PLAN.md
git log -S"<token>" --oneline        # who pinned it, and what for
bd list --desc-contains "<token>" --status open,in_progress,blocked,closed
```

Every hit is a watcher you owe. If a hit is a COUNT (a floor or an exact number), assume
your change moves it until you have re-run the guard that owns it. If a hit is in this
inventory, re-read its entry.

**(d) Subset gates cannot see cross-cutting guards (canon, 2026-09-11; dqc1).**
Subset gates (`npm run test:changed`) select tests via static reverse-dependency analysis.
Cross-cutting guards inspect dynamic file trees without statically importing every target.
If an un-imported guard is tripped, `test:changed` will not run it. Proven live on
2026-09-11: `atve`'s `27ec8926` tripped `tests/test-partition-guard.test.ts`, and main
stayed red across four subsequent subset-gated landings until `npm test` ran.
Full contract and breakdown in `docs/CHROME-TEST-CONTRACT.md`.
