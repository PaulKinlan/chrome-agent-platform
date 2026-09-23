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
     - **Serial Phase (16 build/artifact files)**: Runs with process isolation; exercises builds, bundling, locks, and packaging.
     - **Parallel Phase (472+ files)**: Runs inside a shared `deno test --parallel` process; exercises unit tests and in-memory mocks.
     A single headline count (e.g. "4404 passed") obscures whether the serial phase ran at all and masks phase-specific environmental failures. Every landing report must state: `16 serial files + N parallel files = Total files, X passed, Y failed, Z ignored, wall time Ts`.

4. **Union Changelog Reconciliation & Monotonic Numbering**
   - *Why*: Every candidate branch generates a version bump from its commit message. Rebase collisions in `CHANGELOG.md` frequently lead careless mergers to overwrite another lane's release notes. Mergers must union-resolve changelog bodies: preserve all prior version sections, preserve all user-facing bullets, and place the new release block on top. Patch numbers in the `0.3.x` series must be strictly contiguous (no gaps, no duplicates); missing numbers fail `scripts/check-changelog.mjs`.

5. **Renumber at Landing, Never Pre-emptively**
   - *Why*: Lanes cannot know which branch will clear review first. Pre-emptive rebumping creates secondary collisions across in-flight lanes. Authoring lanes keep their draft version; the merger lane assigns the definitive version number at the moment of landing.

6. **Real-Browser Verification ("It Serves" is not "It Works")**
   - *Why*: Passing unit tests or HTTP 200 responses do not prove UI works. A test harness can report `18/2 passed` while having crashed on line 1 without executing a single check. Where a branch touches user-visible UI, component behavior, or harness drivers, the merger must drive the actual behavior in a real browser (CDP / headless Chrome) and assert on measured geometry and state.

7. **Immediate Bead Linking and Closing (`beads-landing-link.mjs`)**
   - *Why*: Code without tracker updates creates phantom open issues; closed tracker issues without landed commits create phantom delivered features. Running `node scripts/beads-landing-link.mjs <range> --comment <landing-sha>` connects the commit to the bead permanently via git remote metadata, followed by `bd close <id>`.

---

## 2. Environmental Reds Classification: Mechanisms vs Mood

When a test run fails, never guess and never blame ambient load without mechanism proof. Only three known environmental failure modes may be classified as environmental; all others are product stops:

| Name | Trigger / Symptom | Phase | Mechanism & Discriminator |
|---|---|---|---|
| **`fnmr` futex hang** | `build-bundled-tool-packages.mjs --verify` hangs > 120s (`futex_do_wait`) | Serial (`tests/build-tool-bundling.test.ts:136`) | Rare Node/Deno futex deadlock in child process. **Discriminator**: Runs in ~1–2s when executed in isolation (`npm run test:file -- tests/build-tool-bundling.test.ts`). |
| **`m3a2` env race** | `ENOENT: mkdir '/proc/cap-chp-impossible/...'` | Parallel (`tests/dist-staleness-note.test.ts`) | `tests/durable-root.test.ts:69` mutates process-global `CAP_DURABLE_ROOT` in the shared parallel test process. **Discriminator**: Passes 100% in isolation; fails only when racing `durable-root.test.ts`. |
| **`4vfj` stale selector** | 4 combobox checks fail on `#task-input` | Standalone (`npm run test:a11y`) | Pre-existing selector drift on unmodified main prior to composer-target migration. |

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

**Rule**: If a failure does not match one of these three exact signatures with its isolation discriminator proven, it is a **PRODUCT RED** and the branch must NOT land.

---

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
#    - CHANGELOG.md: union-merge bodies, place new version at top, preserve all prior bullets
#    - Version files: update package.json, package-lock.json, extension/manifest.json,
#      and extension/lib/bundled-inventory-data.js to the next sequential version

# 4. Sync changelog and verify order/vocabulary
npm run sync:changelog
npm run check:changelog
npm run check:changelog-order
npm run check:vocabulary

# 5. Commit with appropriate subject (avoiding post-commit double-bump)
git add CHANGELOG.md package.json package-lock.json extension/manifest.json extension/lib/bundled-inventory-data.js ...
git commit -m "chrome-agent-platform-<bead>: <summary of user-visible change>"

# 6. Rebuild production store bundle (mandatory after commit)
npm run build:production
npm run check:dist

# 7. Run focused test / real-browser driver
npm run test:file -- tests/<relevant>.test.ts
# (If UI/harness): deno run -A scripts/<harness>.ts

# 8. Run full two-phase suite gate
npm test > /tmp/npm-test-<bead>.log 2>&1
# Verify exit 0, zero failures, record wall time and phase counts

# 9. Push explicit SHA to main
git push origin <commit-sha>:main

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
5. **Full Gates on the Stacked Tip**: Run the full two-phase suite (`npm test`) on the final landed tree. Never assume that because the base was green and the dependent was green on its local parent, the union on main is green.

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


