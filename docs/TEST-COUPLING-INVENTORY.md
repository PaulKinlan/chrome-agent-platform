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
  values are legal.
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
- **The inheritance trap (verified by inspection; the rule is documented in
  machine-path-honesty's allowlist comment):** `DRIVER_REF_RE = /tests\/[\w.-]+\.(?:mjs|ts)/g`
  makes a test file inherit the hazard class of every SIBLING `tests/` path it merely
  MENTIONS — even inside an allowlist key or a comment. Assemble such strings at runtime
  (`"tests/" + name`), never as literals. Naming a serial-phase file in prose can push
  your parallel test into the serial class and redden the partition.
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
  `tests/tool-exec-preview.test.ts` (revalidates REAL shipped bytes), plus
  `scripts/package-archive.mjs`, `scripts/emscripten-abi-loaded.ts`,
  `scripts/evidence-runner.sh`.
- **Owed by a re-anchor:** ANY edit under `extension/` owes a rebuild before a test that
  reads dist; a whole `npm test` rebuilds and re-indexes first, which is why
  "dist.complete validation failed: marker indexed source authority is stale" appears
  only when a source edit is made WITHOUT the rebuild — an artifact-of-stale-build red,
  not a kill (AGENTS.md mode 4, measured).
- **Subject moves:** LOUD-BY-ACCIDENT: the message names marker authority, not your edit.
  This is also why those files are serial-phase: the marker is shared state.

## 10. tests/quiet-window.test.ts + scripts/lib/quiet-window.ts + the registry

- **Watches:** the three-verdict contract (0 ran-and-passed / 1 ran-and-failed /
  75 environmental refusal) and the agreement between the set of harnesses DECLARED
  load-sensitive (`loadSensitive` in `scripts/lib/harness-registry.ts`) and the set that
  actually honour it — a declaration nobody honours cannot survive; the guard fails if
  the two sets disagree.
- **Owed by a re-anchor:** a gate that reddens under machine load gets
  `launchChrome({ requireQuiet: true })` + a `loadSensitive` reason in the registry in
  the same commit, and maps its refusal to exit 75 + an `ENVIRONMENT:` line — never
  relabelled EXPECTED-RED, never manufactured by killing another lane's processes.
- **Subject moves:** LOUD naming the harness.

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

`tests/bgagent-delete.test.ts` holds `JOURNEY_CHECK_FLOOR = 11` against the 11
`check()` calls in `scripts/kat-bgagent-delete.ts`, and asserts the harness's printed
tally plus the `NOTE: Chrome for Testing: <path>` line. There is NO automated watcher
between the constant and the harness's checks — by design it is a floor (adding checks
is free), and the detection drill is the instance-removal mutant, verified: deleting one
`check()` call reddens the gate with "the journey ran 10 checks, below the 11 it owns".
**Owed by a re-anchor:** `grep -c "^check(\|^  check(" scripts/kat-bgagent-delete.ts`
before changing the harness's check count; the floor is a floor, so only REMOVAL needs
the constant updated. The resolver itself (`scripts/lib/chrome-for-testing.ts`) is the
single source of "which Chrome for Testing exists" for the gate and the harness — until
chrome-agent-platform-3khn lands there are TWO ways to name it in `scripts/` (the
resolver and seven literals), and a lane adding a harness will copy a neighbour, i.e.
the literal.

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
