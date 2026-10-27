# CAP Project Merger Playbook

This playbook documents the non-negotiable landing standards, verification procedures, and operational disciplines for the Chrome Agent Platform dedicated merger lane (`cap-merger-*`).

Every landing on `origin/main` must follow this procedure. A merger lane does not author feature code; it verifies candidate branches that have cleared independent review, runs gating suites, reconciles changelog bodies, pushes explicit SHAs, links beads, and maintains task tracker integrity.

---

## 1. Core Principles: Why the Rules Exist

1. **Tree Identity (`git rev-parse HEAD^{tree}`)**
   - *Why*: A review verifies an exact tree object, not a mutable branch name or reference. Fast-forwards and rebases can silently carry unreviewed commits, drop another lane's changelog notes, or resurrect deleted artifacts. Comparing `reviewed_sha^{tree}` to `landed_sha^{tree}` (or confirming clean disjoint union on rebase) proves that what was reviewed is what actually ships.

2. **Explicit SHA Push (`git push origin <sha>:main`)**
   - *Why*: Pushing branch names (`git push origin main` or `git push origin HEAD`) pushes whatever ref happens to be checked out, which races concurrent checkouts and can accidentally push untested local state or advance main to the wrong commit. Pushing an exact 40-character SHA fails closed if remote `main` has moved.

3. **Two-Phase Suite Reporting (Serial + Parallel Breakdown)**
   - *Why*: The test suite operates in two fundamentally different phases:
     - **Serial Phase (19 build/artifact files)**: Runs with process isolation; exercises builds, bundling, locks, and packaging.
     - **Parallel Phase (472+ files)**: Runs inside a shared `deno test --parallel` process; exercises unit tests and in-memory mocks.
     A single headline count (e.g. "4404 passed") obscures whether the serial phase ran at all and masks phase-specific environmental failures. Every landing report must state: `19 serial files + N parallel files = Total files, X passed, Y failed, Z ignored, wall time Ts`.

4. **Union Changelog Reconciliation & Monotonic Numbering**
   - *Why*: Candidate branches carry release notes only in commit trailers. The merger stamps one release on the union; preserve all user-facing bullets and prior changelog sections. Patch numbers in the `0.3.x` series must remain contiguous (no gaps, no duplicates); missing numbers fail `scripts/check-changelog.mjs`.

5. **Renumber at Landing, Never Pre-emptively**
   - *Why*: Lanes cannot know which branch will clear review first. Authoring lanes keep the last landed version, with no draft stamp; the merger assigns one definitive version on the union.

6. **Real-Browser Verification ("It Serves" is not "It Works")**
   - *Why*: Passing unit tests or HTTP 200 responses do not prove UI works. A test harness can report `18/2 passed` while having crashed on line 1 without executing a single check. Where a branch touches user-visible UI, component behavior, or harness drivers, the merger must drive the actual behavior in a real browser (CDP / headless Chrome) and assert on measured geometry and state.

7. **Immediate Bead Linking and Closing (`beads-landing-link.mjs`)**
   - *Why*: Code without tracker updates creates phantom open issues; closed tracker issues without landed commits create phantom delivered features. Running `node scripts/beads-landing-link.mjs <range> --comment <landing-sha>` connects the commit to the bead permanently via git remote metadata, followed by `bd close <id>`.

---

## 2. Environmental Reds Classification: Mechanisms vs Mood

When a test run fails, never guess and never blame ambient load without mechanism proof. The three named signatures below have their own discriminators. For a failure matching none of them, the **only load-attribution exception for a red test gate** is the evidence-gated rule below; otherwise it is a product stop. A pre-run quiet-window refusal (exit 75) is not a red test verdict:

| Name | Trigger / Symptom | Phase | Mechanism & Discriminator |
|---|---|---|---|
| **`fnmr` futex hang** | `build-bundled-tool-packages.mjs --verify` hangs > 120s (wchan `futex_do_wait` ≤6.6, `futex_wait_queue` ≥6.7 — i0u7) | Dedicated build gate / serial (`tests/build-tool-bundling.test.ts:136`) | Rare Node/Deno futex deadlock in child process. **Discriminator**: Runs in ~1–2s when executed in isolation (`npm run test:file -- tests/build-tool-bundling.test.ts`). |
| **`m3a2` env race** | `ENOENT: mkdir '/proc/cap-chp-impossible/...'` | Parallel (`tests/dist-staleness-note.test.ts`) | `tests/durable-root.test.ts:69` mutates process-global `CAP_DURABLE_ROOT` in the shared parallel test process. **Discriminator**: Passes 100% in isolation; fails only when racing `durable-root.test.ts`. |
| **`4vfj` stale selector** | 4 combobox checks fail on `#task-input` | Standalone (`npm run test:a11y`) | Pre-existing selector drift on unmodified main prior to composer-target migration. |
| **`3nurz` CDP deadline under named builder load** | `waitForServiceWorker: Target.getTargets: deadline exceeded` or CDP evaluate/send deadline (`CdpLoadTimeoutError`, `CdpEvaluateLoadTimeoutError`) | Parallel real-browser / KAT | DevTools CDP socket or worker registration starved by concurrent heavy builders (`chrome-agent-platform-56hfm`). **Discriminator**: Requires contemporaneous host sample naming concurrent active heavy-builder job(s) (`activeBuilderJobs > 0` or non-empty `compilerNames`). On an idle box or suite parallel-phase load alone with zero named builder jobs, it strictly remains `PRODUCT RED` (`exit 1`) and blocks landing. Passes in isolation (`npm run test:file`). |

### Non-signature load reds: a narrow, evidence-gated exception (chrome-agent-platform-m9g43)

A failing gate with **no matching named signature** is environmental **only when BOTH** of these independent facts are in the landing bead, tied to the **same exact tree**:

1. **Isolation:** every test that failed in the gate passes when run alone on that same tree. Record each command, tree SHA and verdict; a green subset or a different commit is not the discriminator.
2. **Named overlap:** the failing gate's contemporaneous log names a concurrent heavy job (including a live or orphaned builder), with its **PID, kind and overlap with the gate window** recorded. Quote the log lines and the gate start/end times. Load average, elapsed time, an unrelated job observed only afterwards, or an assertion that the box was busy is not a substitute for a named overlapping process.

The timeout rule below still applies: an earlier failed assertion is a PRODUCT FAILURE even if both load discriminators happen to hold.

If isolation passes but the log does **not** name an overlapping heavy job, the result remains a **PRODUCT RED**: no load-classified retry and no landing. The `xy6n2` union red at `af43d57dc` prompted this rule: two untouched-file reds coincided with the `mwj7v` fast job (reported PID `1202953`), but coincidence and isolation alone cannot classify that gate. The gate log must itself name the overlapping PID/kind in its window before this exception applies; otherwise even this example stays a PRODUCT RED. If both facts hold, **copy the red log and exact-tree cache verdict into the bead's evidence bundle before invalidation** (the next gate can overwrite them), then invalidate only that exact-tree cache record so the next invocation really executes. Wait for the competing job to exit; do not kill another lane's processes. Measure quiet using the project's quiet-window criteria (or the gate's declared quiet precondition), not merely an empty heavy slot; a quiet-window exit 75 is a refusal, not a rerun verdict or permission to land. Permit **one** cache-invalidated quiet re-run of the same full gate/tree and record its counts, ignored count, exit and overlap check. A repeated red is a hard stop as a PRODUCT RED; **no third attempt** and no retry-until-green. Only a green quiet full gate plus the usual remaining gates can permit landing. That green does not erase the first red or prove a fix; both attempts and the reason for this narrow exception stay on the bead.

**Preemption is not a load-red signature** (`fleet-uhxq`). The hub now prints `[preempted by a priority job]` for a preempted job and automatically retries that job **once**. Check the exit status **against that marker** before calling it preempted: an exit 124 without the marker is a bound timeout, not evidence of preemption, and a marker without the matching exit is not a clean verdict. Preserve the preemption record and judge the retry's actual test verdict under the rules above; never relabel a hang as a preemption or launch another manual retry merely because the marker appeared.

### The Timeout Classification Rule (chrome-agent-platform-im52)

**A timeout is environmental ONLY if nothing failed before it.**
A timeout that follows a failed assertion is a **PRODUCT FAILURE**, and the preceding failed assertion is what must be reported.
- **Operational Drill**: Whenever a gate or test receipt reports `timedOut: true` or exit code 124, **never** dismiss it as environmental on the headline alone. Always inspect the inner log (e.g. `runner.log`) from the beginning:
  - If an assertion line printed `FAIL` prior to the timeout, the timeout was caused by retries/polling waiting on a failed precondition. It is a **PRODUCT DEFECT**.
  - Only if the run was healthy and genuinely hung on an external resource or lock without preceding failed assertions can it be considered for environmental classification.

### The Ambient State Leakage Principle (The Mirror of Environmental Reds — dnop)

**A box making greens that are not the code's merit is the mirror image of a box making reds that are not the code's fault.**
- Tests must strictly scope their inputs to what the test itself controls.
- When a test measures ambient system processes (e.g. daemon counts, loadavg, background workers), it will pass on one machine and fail deterministically on another where the ambient background daemon count differs (as seen on `dnop`: passed with 3 parked daemons on author's box, failed with 6 on reviewer's box).
- Never allow tests to rely on or assert against unisolated system process counts. Fixtures must create their own controlled processes and mock or isolate ambient scans.

### The Reviewer Environment Artifact Principle (Disclosed Caveats Protection)

**A reviewer's fresh worktree is not the author's environment, and a failure that only reproduces in the reviewer's setup is setup, not code.**
- Common reviewer setup traps include: symlinked `node_modules` lacking specific packages (such as `@esbuild`), missing `.deno` cache stores, or inherited user environment variables.
- Authors must explicitly disclose environment caveats in handoffs (e.g. "symlinked dep root can distort measurements"). A disclosed caveat in an author report protects reviewers from filing false reds against sound code.
- When a reviewer observes a failure absent from the author's report, verify whether the failure persists under a pristine, fully-isolated checkout (`npm ci` + `deno install` + real dependencies) before rejecting a candidate.

**Rule**: A failure that matches neither a named signature with its discriminator nor **both** non-signature load discriminators above is a **PRODUCT RED**; the branch must NOT land. An environmental classification only authorizes the single quiet, cache-invalidated full re-run, never a landing on a red verdict.

---

### Measuring a gate phase: the noise floor is 1.35x (chrome-agent-platform-og9m7)

Before quoting a wall-clock number as evidence for a permanent change, read
[docs/GATE-MEASUREMENT-PROTOCOL.md](GATE-MEASUREMENT-PROTOCOL.md). Four **identical** arms of the always-on gate
on one tree, page cache warmed, all green, measured 193 s / 176 s / 238 s / 187 s: a **1.35x spread with no code
difference**, uncorrelated with the reported load (the fastest arm ran at the highest load), and with no
cold-first-arm effect. That sample is a noise floor, not an A/B (load recorded after only, one schedule repeated,
no per-arm scheduler log). The threshold is `max(measured identical-arm spread, worst same-schedule pair)` over a **window** (the last 10 valid
comparisons, or the last 30 days if fewer), which is **~2x today** (1.35x here, ~2.0x from the widest known
same-schedule pair). The window matters: an all-time maximum can only grow, so it would be set by the worst artefact
ever recorded and never relax. So a comparison under today's ~2x is `undecided`, not a small win, and per-suite timings
taken from a concurrent run vary far more than the phase total (median 2.39x, p90 5.0x across the same four arms).
Interleave arms (A B A B), run at least two per side, print load before and after each, and grep the log for the
line proving which scheduler actually ran - an off switch that silently does nothing produces three copies of the
same arm and reads as "no effect". If the machine cannot be measured (truncated probe, refused scan), the run is
**not evidence**: fail closed. A bound raise requires a valid measured comparison; it can never be inferred from
this protocol existing.

## 3. Step-by-Step Landing Checklist

Execute every landing inside a dedicated durable worktree (e.g. `~/worktrees/cap-merger-landing`):

```bash
# 1. Update local refs and create a clean landing branch off current origin/main
cd ~/worktrees/cap-merger-landing
git fetch origin
git checkout -b merge/<bead>-landing origin/main

# 2. Apply candidate branch
git cherry-pick <candidate-sha> -n

# 3. Resolve merge conflicts
#    - .beads/issues.jsonl: restore from HEAD (Dolt DB is authoritative)
git checkout HEAD -- .beads/issues.jsonl
# Before any manual bd export overwrites that committed snapshot, check for
# committed IDs missing from the canonical DB. Stop and investigate if it fails;
# NEVER bulk-import an old passive export to make this check green (vf69).
# If the deletion is intentional, the project coordinator must record the exact
# IDs + snapshot ref on a decision bead and use the one-commit exact-ID override
# documented in docs/BEADS-EXPORT-DIVERGENCE.md; do not bypass all hooks.
node scripts/check-beads-export-divergence.mjs
# 3a. STAMP ONCE after applying all candidates, before the landing commit.
# Pass each candidate SHA with a Release-note trailer; the command reads trailers
# from those commits, deduplicates their user-facing bullets and writes ONE new
# version/changelog/About/inventory stamp on the union. Do not pass merge commits
# or arbitrary ancestors: name only the candidate commits landing in this batch.
node scripts/bump-version.mjs patch --landing --from <candidate-sha> [--from <next-candidate-sha> ...]
# The stamp is IDEMPOTENT per batch (x0vas): if every note this batch would write
# already appears verbatim in the NEWEST CHANGELOG section (and the six surfaces
# agree), the command writes nothing and exits 0 — so a re-run after a gate
# failure or an amended landing message cannot mint a duplicate release. A batch
# with any NEW effect still stamps normally.
# EVERY --from candidate must supply a Release-note trailer, or be named as
# --internal <same-candidate-sha> explicitly if it is internal-only. A mixed
# batch with an unnamed trailer-less candidate FAILS rather than silently
# losing a user-facing change under another candidate's release heading.
# If the union has an additional synthesized user-facing effect, pass
# --user-note "<what the user gets>" explicitly. A union with only explicit
# internal candidates mints nothing; 'Release-note: none: internal' is an
# ERROR, not a release. For a
# legacy union with surfaces ONE patch ahead of the latest CHANGELOG entry,
# add --reconcile-merge to this command rather than hand-resetting six files.
# The shared .git/hooks/post-commit dispatcher runs the tracked hook from the
# committing worktree. Confirm the union contains the new hook before the
# landing commit; an older worktree can still amend/stamp commits.

# 4. Sync changelog and verify order/vocabulary
npm run sync:changelog
npm run check:changelog
npm run check:changelog-order
npm run check:vocabulary
# The ledger reads committed HEAD, so run it AFTER step 5 as well; step 4
# alone cannot certify the new release stamp. The full landing gate enforces
# the committed union ledger; lane tests defer owed entries by git ancestry,
# never by a worktree's branch name.

# 5. Commit the union stamp with an appropriate subject (no hook bump)
git add CHANGELOG.md extension/CHANGELOG.md package.json package-lock.json extension/manifest.json extension/lib/bundled-inventory-data.js extension/about/about.html ...
git commit -m "chrome-agent-platform-<bead>: <summary of user-visible change>"
npm run check:changelog-ledger   # checks the committed release against product commits

# 6. Rebuild production store bundle (mandatory after commit)
npm run build:production
npm run note:dist   # NOTE (not a gate) — the real dist gate is npm test's serial phase

# 7. Run focused test / real-browser driver
npm run test:file -- tests/<relevant>.test.ts
# (If UI/harness): deno run -A scripts/<harness>.ts

# 7b. Landing-range clearance check (chrome-agent-platform-drhi7)
# A delta-scoped PASS is not per-commit clearance: on a linear branch a review-failed
# ancestor must not be cleared by a later commit's PASS. Run BEFORE the full gate:
node scripts/check-landing-clearance.mjs <previous-main>..<candidate-sha>
# exit 0 range clear · exit 1 a review-failed bead's commit is INSIDE the range (named) —
#   fix or re-review that bead, or land a range that excludes it · exit 75 environmental
#   (git/bd unusable; `bd dolt pull` first — the checker reads the LOCAL bd replica).
# fleet-land-message still enforces the TIP's own clearance (CURRENT/STALE/DIVERGED/...);
# this rung adds the ancestor scan. Integration into fleet-land-message itself is
# tracked in the fleet (drhi7 defect).

# 8. Run full two-phase suite gate and dedicated build gate (Option D: chrome-agent-platform-h65e)
npm test > /tmp/npm-test-<bead>.log 2>&1
# Verify exit 0, zero failures, record wall time and phase counts
# Exit 76 = INCOMPLETE (chrome-agent-platform-5xg1w): the run selected files it did NOT execute (a
#   serial-phase abort skipped the non-guard parallel files). It is NOT a verdict on the tree — never
#   file it as a completed FAIL; the manifest says outcome:"incomplete", skipped:N. See
#   docs/CHROME-TEST-CONTRACT.md §2.1 exit-code vocabulary.
# Run dedicated heavy build-behaviour and WASM/fixture gates:
npm run test:build > /tmp/npm-test-build-<bead>.log 2>&1
npm run test:heavy > /tmp/npm-test-heavy-<bead>.log 2>&1
# Verify exit 0, zero failures (runs build-bootstrap, build-debug-mode, build-tool-bundling; heavy WASM tier)
#
# THE RECEIPT DECIDES WHAT THE RUN CERTIFIES (upqhp/juubk/tu8w9/gezg6). `npm run test:heavy`
# writes a receipt for its exact tree, and `node scripts/gate-receipt.mjs` consumes it. Since
# tu8w9 that receipt also records the CPU steal it ran under, so a green run is not automatically
# a TIMING credential:
#   exit 0  full credential — steal measured, below threshold (default 20%)
#   exit 2  nothing usable — missing / wrong tree / stale / not a pass / incomplete
#   exit 3  ACCOUNTING-ONLY — the box was starved (measured avg 58.6%, peak 87% on this VM once),
#           or the receipt carries no steal evidence. Every enumerated suite passed and 0 were
#           skipped, so the run is acceptable for ACCOUNTING and claims NO timing.
# Accept the accounting path explicitly with `node scripts/gate-receipt.mjs --accept-accounting-only`
# (it prints HEAVY_RECEIPT_ACCOUNTING_ONLY and exits 0). Never accept 3 by ignoring it: the
# durations from a starved run are not evidence, and re-running on an idle box is what buys one.

# 9. Push explicit SHA to main
git push origin <commit-sha>:main

# 9a. Tag the release (the repo's release identity — xe11). The tag points at the
# LANDED main sha, so it is created HERE, at landing — never on a worker/release
# branch (the branch tip is not the release; the merger owns this step).
git tag -a v<version> -m "Release v<version> — <date>: <one-line headline>" <commit-sha>
git push origin v<version>

# 10. Link and close bead
node scripts/beads-landing-link.mjs <previous-main>..<commit-sha> --comment <commit-sha>
bd close <bead-id> --reason "Landed on origin/main @ <commit-sha> (v0.3.xxx). <Summary of fix>. Full two-phase suite green (<S> serial + <P> parallel = <T> files, <N> passed, wall <W>s)."
bd dolt push
```

---

## 4. Changelog Entry Guidelines

- **User-Facing Behavior**: Describe what the user experiences, what changed, or what bug was prevented. Never write commit subjects, file paths, or test assertions into public notes.
- **`internal:` Prefix**: When a commit is strictly engineering infrastructure, tooling, or measurement with no visible user effect, prefix the bullet with `internal:` (enabled since v0.3.450+). This allows truthful release notes while filtering internal copy from readable views.
- **Never Include Ticket Tokens**: Drop all parentheticals and issue IDs like `(cwy2)` or `(CAP-FB-...)` from release notes. The bead is the issue record; release notes are read by end users.

---

## 5. Landing Stacked Candidates

When work is divided into a base capability branch and one or more dependent feature branches (e.g. `4vfj` introducing a resolver and `im52` migrating a suite to use it):

1. **Strict Ordering**: The base branch must land on `origin/main` FIRST. A dependent branch cannot land alone because its imports or dependencies do not yet exist on main.
2. **Rebase Onto Landed Base**: Once the base lands on main at `<base-sha>`, rebase the dependent branch onto that exact landed tip (`git rebase origin/main` or `git cherry-pick <dependent-commit> -n`).
3. **No Accidental Duplication or Reversion**: Carefully inspect `git diff <base-sha>` to verify that the rebase:
   - Does NOT reintroduce deleted code or revert changes delivered by the base.
   - Does NOT duplicate changelog notes or version bump files.
   - Contains ONLY the delta of the dependent change.
4. **Independent Numbering**: The dependent branch receives its own sequential version bump and its own distinct changelog bullet upon landing.
5. **Full Gates on the Stacked Tip**: Run the full two-phase suite (`npm test`), dedicated build gate (`npm run test:build`), and heavy gate (`npm run test:heavy`) on the final landed tree. Never assume that because the base was green and the dependent was green on its local parent, the union on main is green.

---

## 6. DOM Migration & Mid-Flight Conflict Guard

When landing a branch that changes DOM structure, element selectors, or shared component implementations (such as `muc` migrating hub rows to `<agent-picker>`):

1. **Sweep Changed Selectors Across the Merged Tree**:
   - Grep the entire repository for the old selectors (e.g. `capability-row`) to detect tests or harnesses that landed while the branch was in flight. Moving only the drivers present at a branch's base misses drivers added by concurrent landings (e.g. `agent-header-rename-reload.test.ts` landed with `7zf0` while `muc` was in flight).
2. **The `-S` Addition Sweep**:
   - For every shared file touched by the branch (e.g. `extension/shared/components.js`), perform a `git log -S'<added-string>'` across recent commits on `origin/main` to ensure that additions from recent landings (e.g. `diay`'s `_scrollSelectedIntoView()`) are NOT silently dropped during union resolution.
3. **Pristine Attribution Discipline**:
   - If a candidate or suite fails against a merged tree, verify the failure against a pristine worktree of `origin/main` before assuming it is local to the candidate branch.
4. **Per-Commit Ingestion Sweep**:
   - When a landing incorporates or squashes commits from an author's branch, verify every single commit:
     `for c in $(git log --format=%H origin/X ^origin/main); do git show --stat $c; done`
     Confirm that each commit's distinctive behavior, helpers, or notes are present on main rather than dropped during union authoring.

---

## 7. The Form of a Clearance: Verdict Comments Are the Wire Format

Three landings on 2026-10-23 stalled on clearance FORM alone, with no code defect involved. A clearance is a machine-parsed record, not prose or a mood — `fleet-land-message` reads the verdict comment's field lines and matches them structurally against the branch it was handed. The rules, each paid for with a round trip:

1. **Verdict comments are the wire format.** Labels are only a cross-check. The parser reads field lines, not prose: the pin comes from a `Delta: <merge-base>..<sha>` line (equivalently `@<sha>`, `commit: <sha>`, or `tip: <sha>`); a comment without one resolves UNPINNED and is not cleared. A bare `Pinned sha: <sha>` line is read by humans only — no fleet parser reads it — and when it disagrees with the `Delta` sha, the `Delta` sha wins silently, so the two must name the same commit. This is the w6kc0 case: a prose clearance with no field lines.
2. **The verdict must name the branch that will be merged.** The parser matches the branch string in the verdict against the branch handed to it. A verdict naming `fleet/fixer-dfif5` cannot clear a merge of `fleet/fixer`.
3. **The pinned sha must equal that branch's tip.** A pinned sha that is an ancestor (a "logical" pin) is refused as tip-moved/STALE: resolution is structural, not historical. One fallback: if the tip moved because the branch was rebased and the reviewed delta is byte-identical per changed file, the existing clearance is reused (`rebased: delta identical to tip ...`). A verdict is dead when the delta changed — the branch carries unreviewed commits — not merely when the sha moved; then get a new one naming the new tip.
4. **A `cleared:` label must not name a sha the branch tip does not have.** If clearance will be given against a future UNION tree, post no `cleared:` label at all — the union gate produces the tree, and the verdict on the branch supplies the delta.
5. **Renaming or splitting a branch invalidates every verdict that names the old name.** When a branch is split, each new branch needs its own verdict naming the new branch string, even if the commits are unchanged. This is the 3li6g/dfif5 split case: a verdict naming `fleet/fixer` died the moment `fleet/fixer` pointed at a different tip, although the pinned commit itself was correct.

Worked examples that resolved first try: b9dtq's verdict on `fleet/reach2-b9dtq` (pin 73f6809c6, resolved from the verdict's `Delta` line, tip match) and dfif5's on `fleet/fixer-dfif5` (pin 21f836950, likewise resolved from its `Delta` line, tip match) — the `Pinned sha:` lines in both were for the human reader. When writing a verdict, re-read rules 2 and 3 against the CURRENT branch state at the moment of landing — pins are checked structurally at merge time, not at review time.
