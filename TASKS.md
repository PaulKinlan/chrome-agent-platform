# Chrome Agent Platform tasks

`TASKS.md` is the repository-local, public-safe recovery record for product
feedback, bugs, reviews, and active delivery lanes. It complements, but never
copies, the private coordination ledger. The stable `CAP-FB-*` ID is the only
join key between the two systems.

> Snapshot: 2026-08-20 15:21 UTC. Reconcile before acting; status can advance in
> another reviewed worktree before this file reaches the integration branch.

## Safety boundary

This file is intended for a public repository. Never add credentials, personal
contact data, relay or provider message identifiers, agent session identifiers,
local absolute paths, private evidence locations, or private handoff IDs. Use a
model/role label for custody, a repository branch/ref, and Git object IDs.
Workspace paths and transport receipts stay in the private coordination ledger.

## Root documentation map

- `TASKS.md` — canonical delivery/task state and crash recovery.
- `KNOWN-ISSUES.md` — canonical review and system findings.
- `REVIEW-2026-08-21.md` — the independent architectural review: verified baseline,
  the measured delivery diagnosis, the reproduced defects, and the ordered work queue.
  It is the rationale; this file is the contract. Never take work from it alone.
- `AGENTS.md`, `PLAN.md`, and `README.md` — repository-wide operating rules,
  roadmap, and overview; these correctly remain at the root.
- `docs/DESIGN.md`, `docs/CONSTITUTION.md`, `docs/OPEN-QUESTIONS.md`, and
  `docs/UI-FIXES-TRACKER.md` — scoped design/product records; these correctly
  remain under `docs/`.
- `docs/KNOWN-ISSUES.md` — compatibility page only, linking to the root record.

## Entry schema

Every task uses every field below; use `—` rather than deleting a field.

```markdown
## [CAP-FB-YYYYMMDD-SLUG-NN] Title
- Feedback: YYYY-MM-DD — public-safe source and summary
- Updated: YYYY-MM-DD HH:MM UTC
- Status: OPEN | IN_REVIEW | MERGED | DONE | BLOCKED | ABANDONED
- Resume: prior state when BLOCKED, otherwise —
- Priority: P0 | P1 | P2 | P3
- Owner: model/role | unassigned
- Workspace: active (local path private) | none
- Branch: repository branch/ref | detached candidate | none
- Base: commit | —
- Candidate: commit | this tracker commit | —
- Shipping: remote/ref@commit | —
- Acceptance: observable acceptance criteria
- Review: reviewer role and PASS/BLOCK/pending result
- Gates: exact-commit checks; label reported or independently verified
- Blockers: text | —
- Next: one concrete next action
- Recover: repository-relative Git commands or —
- History:
  - YYYY-MM-DD HH:MM UTC — material event and evidence
```

IDs are immutable and never reused. The date is the feedback date; `NN`
disambiguates. Entries move intact to **Archive** after `CONFIRMED` or
`ABANDONED`; they are never deleted.

## State and evidence rules (Paul, 2026-08-21 — replaces the nine-state model)

Normal flow is **`OPEN → IN_REVIEW → MERGED → DONE`**, with `BLOCKED` and
`ABANDONED` as the two off-ramps.

- `OPEN` — not started, or being worked on. Leaves when a candidate commit exists
  and a reviewer is assigned.
- `IN_REVIEW` — a candidate exists and a **different model/session** is reviewing
  it. A failed review **stays** `IN_REVIEW` with the findings recorded in
  `Review`/`History`; it does not get its own state.
- `MERGED` — the candidate is on `origin/main`.
- `DONE` — merged **and** the Chrome journey suite green at that tip. Terminal.
  **`DONE` does not require a per-task product-owner interaction.** The previous
  model made the terminal state depend on explicit confirmation per task; the
  result was 0 of 31 tasks reaching it while this file grew without bound.
- `BLOCKED` — stopped on something external. Records an owner, the reason, one
  next action, and the `Resume` state.
- `ABANDONED` — will not be done. Records why. Terminal.

Two rules survive and are not negotiable: **a different model/session reviews
every change**, and **real-browser verification with evidence** — the 126-check
journey suite is a strong gate and it is sufficient. Content-addressed gate
evidence, live remote attestation and versioned acceptance packages are removed;
they produced 322 open handoff records and zero confirmations. Never fabricate
evidence or closure.

**A review is valid for its content, not its base.** If a candidate passed review
and `main` advanced without touching the same files, the review still stands —
rebase and land it. Re-review only what actually changed.

Historical test counts prove only their named commit. Use `reported` when the
current reviewer has not independently verified the evidence.

Entries written under the previous model are **not** rewritten. Read them through
this mapping: `IN_PROGRESS`/`FIX_REQUESTED` → `OPEN`;
`REVIEWING`/`REVIEW_PASSED`/`READY_FOR_BROWSER`/`INTEGRATING`/`GATED` →
`IN_REVIEW`; `PUSHED` → `MERGED`; `CONFIRMED` → `DONE`.

## Atomic ownership and updates

The **committed Git version** of this file is authoritative; line ordering in a
dirty working copy is not atomic.

1. Read the current tracker commit with `git log -1 --format=%H -- TASKS.md`.
2. To acquire or transfer custody, make one edit that changes `Owner`, `Updated`,
   `Next`, and appends one `ownership: old → new (reason)` History event. Commit
   that edit alone against the tracker commit read in step 1.
3. Ownership changes take effect only when that commit is accepted into the
   active integration ancestry. A competing commit is a compare-and-swap
   failure: re-read, reconcile, and retry; never silently overwrite it.
4. A material status, candidate, gate, blocker, or next-action update changes all
   affected fields and appends its evidence in the same commit. Reviewers may
   append a review event without taking implementation custody.
5. Automated writers must write a complete replacement file to a temporary file,
   flush it, and rename it; humans rely on the single Git commit as the atomic
   transaction. Never use “History first, fields later” as a crash guarantee.

## Crash recovery

On resume after a coordinator or worker loss:

1. Preserve before changing: run `git status --short`, `git diff -- TASKS.md`,
   and `git log -5 --oneline -- TASKS.md`. Never reset an interrupted draft.
2. Treat the last committed tracker version as authority. Save any dirty diff as
   a recovery patch outside the repository, then reconcile it entry by entry.
3. For every `IN_PROGRESS`, `FIX_REQUESTED`, `REVIEWING`, `READY_FOR_BROWSER`, or
   `INTEGRATING` entry, verify the recorded objects with
   `git cat-file -e <sha>^{commit}` and ancestry with
   `git merge-base --is-ancestor <base> <candidate>`. Use
   `git branch --contains <candidate>` only as a locator, not as acceptance.
4. Reconcile the stable task ID with the private coordination ledger. Publish
   only the public fields above. Authenticated commit/gate/remote evidence wins;
   otherwise retain the more conservative status.
5. If the candidate is missing, the branch diverged, ownership is ambiguous, or
   an uncommitted draft cannot be attributed, commit a transition to `BLOCKED`
   with `Resume`, recovery owner, blocker, one next action, and a `crash recovery
   audit` History event. Never guess or mark work complete.
6. Reconcile at least once per active workday and after any crash recovery. Log
   the timestamp in the reconciliation log below.

---

## Active

## [CAP-FB-20260819-TRACKER-01] Repository-local task and bug recovery
- Feedback: 2026-08-19 — product-owner recovery directive after task state was lost across coordinator failures
- Updated: 2026-08-19 17:29 UTC
- Status: INTEGRATING
- Resume: —
- Priority: P1
- Owner: gpt integration writer
- Workspace: active (local path private)
- Branch: `integrate/project-tracker-3402278`
- Base: `ffbdf282013717b34c80c4a2135dd6fa8992f63a`
- Candidate: this integration commit
- Shipping: —
- Acceptance: root tracker and Known Issues are public-safe, crash-recoverable, link-compatible, schema-valid, and independently reviewed
- Review: k3 PASS on accepted source `34022786a6badf5dececccb6e59f65db72143b83`; exact current-main integration review pending
- Gates: current-main pre-freeze schema 16/16, 23 Git objects, 9 ancestry relations, required status assertions, links, privacy/secret scan, byte-preserved root move, compatibility, six-doc scope, and diff-check pass
- Blockers: —
- Next: freeze the refreshed current-main docs commit and hand it to k3 for exact-integration review
- Recover: `git log -1 --format=%H -- TASKS.md && git diff -- TASKS.md`
- History:
  - 2026-08-19 16:40 UTC — replacement draft opened on the exact public base after the first writer disappeared.
  - 2026-08-19 17:01 UTC — ownership: glm recovery writer → gpt recovery writer (prior writer reached a hard usage limit); interrupted draft preserved for audit.
  - 2026-08-19 17:07 UTC — public schema, Git objects, Markdown links, root-history copy, compatibility page, privacy/secret patterns, docs-only scope, and diff all passed pre-freeze validation.
  - 2026-08-19 17:23 UTC — independent k3 review PASSed exact source `3402278`; no blocker/high/medium finding remained.
  - 2026-08-19 17:25 UTC — ownership: gpt recovery writer → gpt integration writer (current-main replay after review PASS); status advanced to INTEGRATING on exact `ffbdf28`.
  - 2026-08-19 17:29 UTC — current-main schema, object/ancestry, required statuses, links, privacy/secret patterns, history blobs, compatibility, six-doc scope, and diff all passed pre-freeze validation.

## [CAP-FB-20260818-USAGE-RECORDING-01] Model usage records are missing or misattributed
- Feedback: 2026-08-18 — repeated product-owner report invalidated earlier fixed claims
- Updated: 2026-08-19 17:12 UTC
- Status: REVIEW_PASSED
- Resume: —
- Priority: P1
- Owner: release coordinator
- Workspace: active (local path private)
- Branch: `usage-retry-fix`
- Base: `fc6975196bc68731b66ac205883a24cb67fd30d3`
- Candidate: `d6030b722f3df97899564595536ff040d29a2238`
- Shipping: —
- Acceptance: each real provider attempt records the correct attempt identity exactly once across async retry, synchronous throw, abort, and plain stream-object returns
- Review: deepseek-flash PASS on exact clean `d6030b7`
- Gates: independently verified hostile authority 40, probes 1–11, unit 535, security 7, and build; browser gate remains
- Blockers: public main advanced; the independently accepted range needs a fresh `ffbdf28` integration and browser gate
- Next: integrate `d6030b7` on current main, independently review exact integration bytes, then run loaded-MV3 usage/Chrome acceptance
- Recover: `git show --stat d6030b7 && git merge-base --is-ancestor fc69751 d6030b7`
- History:
  - 2026-08-18 18:20 UTC — opened after usage remained empty despite earlier claims.
  - 2026-08-19 16:58 UTC — reviewer reproduced synchronous-throw identity leakage and plain-object incompatibility on `fc69751`.
  - 2026-08-19 17:12 UTC — independent re-review PASSed narrow successor `d6030b7`; integration and browser acceptance remain open.

## [CAP-FB-20260818-RUN-STATUS-01] Visible task run-status lifecycle
- Feedback: 2026-08-18 — visible thinking/loading state repeatedly stuck or crossed task surfaces
- Updated: 2026-08-19 17:00 UTC
- Status: PUSHED
- Resume: —
- Priority: P0
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main`
- Base: `d2d7fe825c396804b6bd4296c23d42e351bd98df`
- Candidate: `ffbdf282013717b34c80c4a2135dd6fa8992f63a`
- Shipping: `origin/main@ffbdf282013717b34c80c4a2135dd6fa8992f63a`
- Acceptance: no stale status/title commit crosses a surface switch; overlapping runs settle only their own banner; lifecycle harness is deterministic
- Review: deepseek-flash PASS on the exact integration tip
- Gates: independently verified unit 542, security 7, lifecycle 30/30 twice, cross-surface 12/12; browser bundle `sha256:09bba8ef769b5ada039501140ff3564b8bf2d66c948e7c8b196030ada2f44043`
- Blockers: product-owner confirmation pending
- Next: obtain explicit confirmation, then move the intact entry to Archive
- Recover: `git show --stat ffbdf28 && git ls-remote origin refs/heads/main`
- History:
  - 2026-08-18 12:50 UTC — opened for the real extension lifecycle defect.
  - 2026-08-19 16:59 UTC — exact reviewed and gated integration `ffbdf28` was pushed and remotely verified.

## [CAP-FB-20260818-PROVIDER-PICKER-01] Configured-agent provider and model picker
- Feedback: 2026-08-18 — picker behavior and evidence harness were unreliable
- Updated: 2026-08-19 16:15 UTC
- Status: READY_FOR_BROWSER
- Resume: —
- Priority: P1
- Owner: glm implementer
- Workspace: active (local path private)
- Branch: `picker-harness-cdp`
- Base: `344df55c9a04bfbf376bb1f7862a749bdcb0083f`
- Candidate: `c7b5126507651711e819ccb37cb84b49da3a34a4`
- Shipping: —
- Acceptance: picker persists the intended provider/model and the external harness classifies failures without unbounded diagnostics or mixed snapshots
- Review: static reviewer found no remaining non-browser blocker
- Gates: reported tracked 13, unit 382, security 7, build and diff checks
- Blockers: two serialized exact-tip browser journeys remain
- Next: run two fresh-profile 50/50 journeys, then issue final PASS or BLOCK
- Recover: `git show --stat c7b5126 && git merge-base --is-ancestor 344df55 c7b5126`
- History:
  - 2026-08-18 12:55 UTC — opened from the broken picker report.
  - 2026-08-19 16:15 UTC — bounded, snapshot-consistent harness successor reached browser-ready state.

## [CAP-FB-20260818-SIDEPANEL-PARITY-01] Side-panel Agents and Tasks parity
- Feedback: 2026-08-18 — screenshot review found scrollbar, alignment, collapsed-content, and row-formatting regressions
- Updated: 2026-08-19 00:04 UTC
- Status: BLOCKED
- Resume: PUSHED
- Priority: P2
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main` history
- Base: —
- Candidate: `69439b1993c545cd1a15b268c5ccd6a622bded1c`
- Shipping: `origin/main@69439b1993c545cd1a15b268c5ccd6a622bded1c` (historical ancestor)
- Acceptance: Agents and Tasks retain matching expanded/collapsed/RTL geometry and product-owner confirmation
- Review: implementation and integration reviews historically passed
- Gates: historical browser evidence belongs to `69439b1`; not evidence for newer bytes
- Blockers: explicit product-owner confirmation and current-main regression check
- Next: verify the superseding current main and request confirmation
- Recover: `git show --stat 69439b1 && git merge-base --is-ancestor 69439b1 origin/main`
- History:
  - 2026-08-18 20:58 UTC — opened from screenshot feedback.
  - 2026-08-19 00:04 UTC — delivery evidence retained; confirmation gap kept the task blocked from its prior PUSHED state.

## [CAP-FB-20260819-AGENT-DIRECTORY-01] Agent Directory overlay and function cards
- Feedback: 2026-08-19 — full Directory must own the covered view and present truthful per-function metadata
- Updated: 2026-08-19 17:23 UTC
- Status: READY_FOR_BROWSER
- Resume: —
- Priority: P2
- Owner: release coordinator
- Workspace: active (local path private)
- Branch: `integrate/agent-directory-ac72ae1` (old-base reviewed candidate)
- Base: reviewed parent `d2d7fe825c396804b6bd4296c23d42e351bd98df`; required new target `ffbdf282013717b34c80c4a2135dd6fa8992f63a`
- Candidate: `38cdb15b19efe1ed5719354b7064bce112753974` (READY_FOR_BROWSER only on old base; not deliverable)
- Shipping: —
- Acceptance: covered sidebar controls are inert/hidden and restored exactly; responsive cards expose canonical descriptions, schema metadata, and function-specific accessible states
- Review: gemini static review classified exact old-base `38cdb15` READY_FOR_BROWSER; fresh current-main integration review pending
- Gates: old-base integration reported unit 542, static security 19, components 13, build/gallery/parse; no current-main browser evidence
- Blockers: public main advanced; the accepted Directory delta must be recreated and independently checked on `ffbdf28` before browser use
- Next: create one clean integration on `ffbdf28`, re-review exact bytes, then run Directory and broad Chrome journeys
- Recover: `git show --stat 38cdb15 && git show --stat ffbdf28`
- History:
  - 2026-08-19 13:20 UTC — opened from overlay and function-card feedback.
  - 2026-08-19 15:55 UTC — one-commit old-main integration froze with reviewed exclusive blobs preserved.
  - 2026-08-19 17:23 UTC — gemini static review classified `38cdb15` READY_FOR_BROWSER, but `origin/main` had advanced to `ffbdf28`; reintegration is mandatory before any browser or push claim.

## [CAP-FB-20260819-ASSETS-01] Assets browser and quick access
- Feedback: 2026-08-19 — make Assets inspectable, reusable, safely previewable, and reachable without losing full-browser navigation
- Updated: 2026-08-19 17:13 UTC
- Status: REVIEWING
- Resume: —
- Priority: P0
- Owner: flash and k3 reviewers
- Workspace: active (local paths private)
- Branch: detached Assets correction; `feat/assets-quick-drawer`
- Base: `dcb9efea366c50c6769811022fdb0a442ad6073b` (browser correction); `d2d7fe825c396804b6bd4296c23d42e351bd98df` (drawer)
- Candidate: `202b85ea7dd0e18ca1315f7b50f088145e9145f2`; `0ba92a254e7f1edfc734051780a3102ba6119aea`
- Shipping: —
- Acceptance: zero-egress interactive sandbox preview, distinct accessible names, concurrent CRUD persistence, and bounded drawer Open/Reuse/Browse across keyboard, pointer, RTL, narrow, and theme states
- Review: flash exact-tip browser review resumed on `202b85e`; k3 drawer static review is READY_FOR_BROWSER
- Gates: `202b85e` reports unit 530/build and awaits canonical browser/security/AX rerun; drawer reports unit 543/security 7/gallery/components 35
- Blockers: exact-tip interactive sandbox, concurrency, geometry, accessibility, and action journeys remain
- Next: flash returns PASS or BLOCK on `202b85e`; then run the separate drawer browser phase
- Recover: `git show --stat 202b85e && git show --stat 0ba92a2`
- History:
  - 2026-08-19 13:24 UTC — opened from two Assets usability reports.
  - 2026-08-19 17:04 UTC — browser review BLOCKed `dcb9efe` on non-interactive generated HTML and concurrent index loss.
  - 2026-08-19 17:13 UTC — successor `202b85e` added manifest-sandboxed interaction and serialized per-origin index mutation; canonical review resumed.

## [CAP-FB-20260819-PERMISSIONS-01] Task and agent permission orchestration
- Feedback: 2026-08-19 — replace mid-task broad-host failures with planned, minimal, owner-driven permission acquisition
- Updated: 2026-08-19 15:53 UTC
- Status: READY_FOR_BROWSER
- Resume: —
- Priority: P2
- Owner: gemini reviewer
- Workspace: active (local path private)
- Branch: `worker/permission-orchestration-20260819`
- Base: `5001b4b15291033e35fbd804b0763872ba03d55c`
- Candidate: `7e537d65db834f0415faafb0de1b15342566783d`
- Shipping: —
- Acceptance: exact capability/host planning, genuine owner gesture, deterministic wait/resume/deny/revoke, and honest task-vs-browser authority survive worker restart
- Review: gemini static audit found no Deno/source blocker and classified the exact candidate READY_FOR_BROWSER; final browser acceptance withheld
- Gates: independently checked permission 6, browser-tools 23, full 533, security 7, components 35, gallery and diff
- Blockers: headed permission prompts and task-scoped JIT/restart journey remain open
- Next: drive real owner-gesture grant/deny/revoke and same-identity restart behavior
- Recover: `git show --stat 7e537d6 && git merge-base --is-ancestor 5001b4b 7e537d6`
- History:
  - 2026-08-19 13:32 UTC — opened from permission-preflight feedback.
  - 2026-08-19 15:53 UTC — gemini static audit classified the exact candidate READY_FOR_BROWSER, not final PASS.

## [CAP-FB-20260818-WEBMCP-01] Real and inspectable WebMCP discovery
- Feedback: 2026-08-18 — discovery source and proof were not visible in DevTools
- Updated: 2026-08-18 19:16 UTC
- Status: PUSHED
- Resume: —
- Priority: P2
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main` history
- Base: —
- Candidate: `215d81595d91a2a17314c918dc360a2070a2b15f`
- Shipping: `origin/main@215d81595d91a2a17314c918dc360a2070a2b15f` (historical ancestor)
- Acceptance: production discovery is inspectable, sender-authenticated, generation-fenced, callable, and confirmed by the product owner
- Review: integration review PASS
- Gates: historical unit 420, security 7, WebMCP 35, Chrome 119, agent 88, prompts 44 and build
- Blockers: product-owner confirmation; headed operating-system permission gestures remain separate
- Next: obtain confirmation on current main
- Recover: `git show --stat 215d815 && git merge-base --is-ancestor 215d815 origin/main`
- History:
  - 2026-08-18 13:16 UTC — opened after discovery lacked inspectable proof.
  - 2026-08-18 19:16 UTC — reviewed integration pushed and remotely verified.

## [CAP-FB-20260818-AGENT-ACCESS-01] Side-panel orchestration and unified agent access
- Feedback: 2026-08-18 — shipped side panel was a stub and agent selection was fragmented
- Updated: 2026-08-18 18:49 UTC
- Status: PUSHED
- Resume: —
- Priority: P2
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main` history
- Base: —
- Candidate: `e3c81a1e86b5fb9749d880aade9976ff51d8263f`
- Shipping: `origin/main@e3c81a1e86b5fb9749d880aade9976ff51d8263f` (historical ancestor)
- Acceptance: one canonical picker and reference model serves panel, composers, commands, history, and scheduled tasks without cross-agent races
- Review: integration review PASS
- Gates: historical unit 386, security 7, gallery 35, a11y 17, prompt 60, system-prompt 44, agent 88, Chrome 119 and UI 13
- Blockers: product-owner confirmation
- Next: obtain confirmation on current main
- Recover: `git show --stat e3c81a1 && git merge-base --is-ancestor e3c81a1 origin/main`
- History:
  - 2026-08-18 13:34 UTC — opened and expanded to all agent-selection surfaces.
  - 2026-08-18 18:49 UTC — reviewed integration pushed and remotely verified.

## [CAP-FB-20260818-SIDEBAR-01] Collapsed-sidebar alignment and edge toggle
- Feedback: 2026-08-18 — collapsed actions and edge toggle were misaligned and inaccessible
- Updated: 2026-08-18 22:42 UTC
- Status: BLOCKED
- Resume: PUSHED
- Priority: P3
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main` history
- Base: —
- Candidate: `aa58b6d68d317b2d1bdc86bb0e41c7e837f6271f`
- Shipping: `origin/main@aa58b6d68d317b2d1bdc86bb0e41c7e837f6271f` (historical ancestor)
- Acceptance: centered keyboard/pointer controls and an accessible edge nub remain correct in the superseding parity build
- Review: historical implementation review passed
- Gates: historical evidence belongs to `aa58b6d`
- Blockers: superseding side-panel parity confirmation
- Next: fold verification into `CAP-FB-20260818-SIDEPANEL-PARITY-01`
- Recover: `git show --stat aa58b6d && git merge-base --is-ancestor aa58b6d origin/main`
- History:
  - 2026-08-18 13:25 UTC — opened for collapsed rail geometry.
  - 2026-08-18 22:42 UTC — blocked from prior PUSHED state pending superseding parity confirmation.

## [CAP-FB-20260818-TOOL-TREE-01] Explorable structured tool-call output
- Feedback: 2026-08-18 — raw escaped JSON was not usable
- Updated: 2026-08-18 23:11 UTC
- Status: BLOCKED
- Resume: PUSHED
- Priority: P3
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main` history
- Base: —
- Candidate: `5e3285aba0fadd779a1426c0d8e5c132d35379e7` (integration containing reviewed feature `3e97b890e7f362cc3721656b5239c10cd4c487e4`)
- Shipping: `origin/main@5e3285aba0fadd779a1426c0d8e5c132d35379e7` (historical ancestor)
- Acceptance: bounded, redacted, accessible object rendering remains present and receives product-owner confirmation
- Review: final feature and integration reviews passed
- Gates: historical targeted 83 and retained 42-check visual evidence
- Blockers: product-owner confirmation on a current descendant
- Next: verify ancestry and request confirmation
- Recover: `git show --stat 5e3285a && git merge-base --is-ancestor 5e3285a origin/main`
- History:
  - 2026-08-18 12:52 UTC — opened to replace raw JSON blobs.
  - 2026-08-18 23:11 UTC — historical delivery retained; confirmation gap kept the task blocked.

## [CAP-FB-20260818-WIDER-REVIEW-01] Wider-goal review remediation umbrella
- Feedback: 2026-08-18 — recovered independent review found omitted security, concurrency, bounds, and accessibility work
- Updated: 2026-08-19 00:10 UTC
- Status: BLOCKED
- Resume: FIX_REQUESTED
- Priority: P3
- Owner: review coordinator
- Workspace: none
- Branch: none
- Base: `98bbc96fed4339bfd349516db9e516221c134004` (historical review target)
- Candidate: —
- Shipping: —
- Acceptance: every mapped finding is either fixed with current-main evidence or retained as an explicit blocked residual
- Review: mapping complete; combined current-main revalidation pending
- Gates: —
- Blockers: artifact transaction and headed bounds lanes must clear before umbrella re-review
- Next: revalidate the combined current main after dependent lanes reach final verdicts
- Recover: `git show --stat 98bbc96`
- History:
  - 2026-08-18 20:15 UTC — recovered omitted review report and mapped findings.
  - 2026-08-19 00:10 UTC — umbrella blocked on independent remediation lanes.

## [CAP-FB-20260818-ARTIFACT-TX-01] Transactional and owner-confirmed artifact management
- Feedback: 2026-08-18 — wider review found split body/index writes and destructive-operation authority gaps
- Updated: 2026-08-19 17:23 UTC
- Status: READY_FOR_BROWSER
- Resume: —
- Priority: P2
- Owner: release coordinator
- Workspace: active (local path private)
- Branch: `integrate/artifact-tx-4eaf0d3` (old-base reviewed candidate)
- Base: reviewed parent `d2d7fe825c396804b6bd4296c23d42e351bd98df`; required new target `ffbdf282013717b34c80c4a2135dd6fa8992f63a`
- Candidate: `263342689639c50c4eb6608602a8fb25ec7cd1de` (READY_FOR_BROWSER only on old base; not deliverable)
- Shipping: owner-approval half is an ancestor of `origin/main@ffbdf282013717b34c80c4a2135dd6fa8992f63a`; transaction half unshipped
- Acceptance: crash-safe body/index/WAL recovery, monotonic per-key absence authority, bounded repair, scoped access, and exact owner confirmation all compose on current main
- Review: gemini static review classified exact old-base `2633426` READY_FOR_BROWSER; fresh current-main integration review pending
- Gates: old-base integration reported full 579, artifact/memory 49, static security 19, build/gallery/parse; no current-main browser CRUD/recovery evidence
- Blockers: public main advanced; the reviewed full artifact range must be recreated and independently checked on `ffbdf28` before browser use
- Next: create one clean integration on `ffbdf28`, re-review exact bytes, then run loaded-MV3 CRUD/restart and broad Chrome journeys
- Recover: `git show --stat 2633426 && git show --stat ffbdf28`
- History:
  - 2026-08-18 20:18 UTC — split transactional storage from the separately reviewed approval correction.
  - 2026-08-19 16:23 UTC — complete reviewed five-commit source range froze as one old-main integration commit.
  - 2026-08-19 17:23 UTC — gemini static review classified `2633426` READY_FOR_BROWSER, but `origin/main` had advanced to `ffbdf28`; reintegration is mandatory before any browser or push claim.

## [CAP-FB-20260818-BOUNDS-01] Bounds, UTF-8, race, and accessibility backlog
- Feedback: 2026-08-18 — wider review found stale mutations, unbounded diagnostics, encoding, and accessibility gaps
- Updated: 2026-08-19 14:14 UTC
- Status: BLOCKED
- Resume: READY_FOR_BROWSER
- Priority: P3
- Owner: headed-environment operator
- Workspace: active (local path private)
- Branch: `fix/bounds-current-main`
- Base: `768225be1746c07605ed31aff697f3a6c8513224`
- Candidate: `cc68ba4685dca8cb05bf18a2d829707f3fac603c`
- Shipping: —
- Acceptance: all code/AX regressions pass and a genuine headed permission-prompt race produces trace and screenshot evidence without bypasses
- Review: code and accessibility review clear; headed witness unavailable
- Gates: reported focused 17, unit 533, security 7, Chrome 119, UI 65, sidebar 20, a11y 17, build/gallery/drift
- Blockers: a headed environment capable of the real permission prompt
- Next: run the one remaining real permission-race witness or obtain an explicit waiver
- Recover: `git show --stat cc68ba4 && git merge-base --is-ancestor 768225b cc68ba4`
- History:
  - 2026-08-18 20:18 UTC — opened from wider-review findings.
  - 2026-08-19 14:14 UTC — code and AX gates cleared; honestly blocked on the headed environment.

## [CAP-FB-20260818-SYSPROMPT-01] Versioned system-prompt settings
- Feedback: 2026-08-18 — system-prompt editing required protected runtime policy and upgrade-safe owner customization
- Updated: 2026-08-18 17:10 UTC
- Status: PUSHED
- Resume: —
- Priority: P3
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main` history
- Base: —
- Candidate: `22fd2c04fea0465b6bbc081079af4f62acec8263`
- Shipping: `origin/main@22fd2c04fea0465b6bbc081079af4f62acec8263` (historical ancestor)
- Acceptance: effective prompt preview equals the sent prompt, protected constraints cannot be overridden, and upgrades never silently replace owner changes
- Review: independent review and integration gates passed
- Gates: historical unit 374, security 7, components 34, UI 13, system-prompt 44, Chrome 119, build/gallery
- Blockers: product-owner confirmation
- Next: obtain confirmation on current main
- Recover: `git show --stat 22fd2c0 && git merge-base --is-ancestor 22fd2c0 origin/main`
- History:
  - 2026-08-18 12:58 UTC — opened for versioned prompt customization.
  - 2026-08-18 17:10 UTC — reviewed integration pushed and remotely verified.

## [CAP-FB-20260819-CONVERSATION-RUN-STATUS-01] One truthful conversation run-status surface
- Feedback: 2026-08-19 — conversation feedback requested the preferred grid status inside agent conversations and removal of the duplicate thinking spinner; repeated 2026-08-20 feedback identified the still-live top-of-task `div.run-status > loading-state` as the unreplaced legacy surface
- Updated: 2026-08-20 15:21 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `ecf657fe2f9e32aee7b5e2043808f4f7978fd456`
- Candidate: —
- Shipping: —
- Acceptance: remove the standalone top-of-thread `div.run-status` presentation and its duplicate thinking state; every task and agent conversation renders exactly one shared conversation-owned grid status at the bottom of the transcript for queued, running, tool activity, retrying, waiting for permission, completed, failed, and cancelled states; status and accessible naming expose useful live activity rather than the generic `thinking…`; reconnect, reload, double-send and surface switches cannot create two status owners or reintroduce the legacy container
- Review: pending independent implementation review and exact loaded-MV3 visual/accessibility review
- Gates: component and lifecycle units; source assertion that the legacy top-of-thread container/render path is absent; loaded-MV3 task, named-agent, background-agent, and site-agent conversations; genuine working/tool/permission/retry/terminal states; raw AX single-live-region and name/state inspection; bottom-of-transcript placement; switch/reconnect/reload/double-send screenshots; zero duplicate spinner, stale status, generic-only activity, or top-of-thread banner
- Blockers: status presentation must reuse the lifecycle authority delivered under `CAP-FB-20260818-RUN-STATUS-01` without weakening its ownership fences; the historical `ffbdf28` push proves lifecycle fencing, not this still-open presentation replacement
- Next: replace `#run-status` plus `renderRunStatus()` with one conversation-owned shared component at the transcript boundary, remove the duplicate thinking renderer, and prepare real loaded-MV3 lifecycle, placement, visual, keyboard and AX evidence
- Recover: `git show ecf657f:TASKS.md && git grep -n "run-status\|renderRunStatus\|loading-state" ecf657f -- extension`
- History:
  - 2026-08-19 18:13 UTC — captured as a distinct presentation task; the pushed lifecycle task remains intact and is linked rather than reopened.
  - 2026-08-20 15:21 UTC — repeated product-owner feedback confirmed current main still renders the standalone top-of-task `div.run-status` containing a generic `thinking…` loading component. Priority raised to P0; the earlier lifecycle push is explicitly not presentation acceptance.

## [CAP-FB-20260819-COMPOSER-AGENT-MENTIONS-01] Composer copy and behavior for mentioning any agent
- Feedback: 2026-08-19 — composer feedback rejected site-agent-only reply wording because the same composer must mention any supported agent kind
- Updated: 2026-08-19 18:13 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: composer placeholder, accessible description, mention picker, keyboard completion, and send routing consistently say and implement mention-any-agent semantics across named, background, and site agents without implying a site-only reply path
- Review: pending independent copy, routing, accessibility, and exact loaded-MV3 review
- Gates: parser/picker/routing units; keyboard and pointer mention journeys for every agent kind; raw AX names and selected state; narrow/RTL/theme screenshots; no regression to canonical agent references
- Blockers: must preserve the canonical picker/reference behavior tracked by `CAP-FB-20260818-AGENT-ACCESS-01`
- Next: enumerate all composer placeholders, helper text, mention queries, and route-resolution branches, then write a single cross-surface contract
- Recover: `git show bbeff7b:TASKS.md && git grep -n "mention" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — captured separately from unified agent access because the requested copy and composer behavior remain incorrect after the earlier picker delivery.

## [CAP-FB-20260819-COVERED-NUB-VISIBILITY-01] Covered side-panel nub visibility across views
- Feedback: 2026-08-19 — the side-panel edge nub remains visible where the main page or another view covers it; the Directory-only correction is not a complete view policy
- Updated: 2026-08-19 18:13 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: a documented per-view policy keeps the nub available only where it is actionable and otherwise makes it hidden, inert, non-hit-testable, non-focusable, and absent from the unignored AX tree; closing or switching views restores the exact prior sidebar state
- Review: pending independent geometry, interaction, and accessibility review
- Gates: loaded-MV3 matrix for hub, task conversation, Settings, Directory, Skills, Assets, narrow, RTL, themes, pointer/keyboard focus, elementFromPoint, and raw AX; before/after screenshots and exact restoration assertions
- Blockers: must compose with `CAP-FB-20260819-AGENT-DIRECTORY-01`, `CAP-FB-20260818-SIDEBAR-01`, and `CAP-FB-20260818-SIDEPANEL-PARITY-01` without merging away their separate acceptance history
- Next: record the intended sidebar/nub visibility and stacking policy for every routable view, then add failing browser assertions for non-Directory covered views
- Recover: `git show bbeff7b:TASKS.md && git grep -n "side-toggle" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — opened as a generalized covered-view defect; existing Directory and sidebar tasks remain separate linked workstreams.

## [CAP-FB-20260819-DURABLE-BACKGROUND-RUNS-01] Durable runs independent of mounted UI
- Feedback: 2026-08-19 — task and agent runs must continue through task/view switches, Settings navigation, tab closure, and later reopen rather than being owned by mounted conversation UI
- Updated: 2026-08-19 19:56 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: `docs/durable-background-runs` (research complete; implementation unassigned)
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: workflow/service-worker state is the run authority; switching task, agent, Settings, or full views and closing/reopening the tab never cancels or loses an accepted run; reconnect shows bounded progress and exactly one terminal result; restart recovery is idempotent and stale UI owners cannot commit
- Review: design research complete (docs/durable-background-runs-design.md); independent review of the research pending, then the OPEN policy decisions (ad-hoc cancellation, orphan retention, reconnection progress granularity, resume-vs-orphan); subsequent independent architecture, crash-recovery, concurrency, and loaded-MV3 review required before implementation
- Gates: deterministic overlap/switch/view/reload/tab-close journeys; genuine service-worker termination and wake; persisted run identity and journal/result equality; reconnect progress; duplicate/loss checks; raw AX status; zero orphaned terminal or mounted-UI ownership
- Blockers: must extend, not replace, the surface fencing in `CAP-FB-20260818-RUN-STATUS-01`; permission waits must remain compatible with `CAP-FB-20260819-PERMISSIONS-01`
- Next: independent review of the completed lifecycle map and design (docs/durable-background-runs-design.md), then the owner's policy decisions — ad-hoc run cancellation, orphaned-record retention, reconnection progress granularity, and resume-vs-honest-orphaning (all explicitly OPEN); no implementation before those decisions
- Recover: `git show bbeff7b:TASKS.md && git grep -n "runSurfaceOwner\|progress" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — captured as a new durability goal rather than broadening the already-pushed visible lifecycle task after delivery.
  - 2026-08-19 19:35 UTC — research completed and frozen in docs/durable-background-runs-design.md: exact current-behavior map (ad-hoc runs have no durable state/lease vs scheduled tasks' full durability; tab close is safe via SW authority + surface fencing; no live-state replay on reconnect), durable per-run registry design (heartbeat, running/settling/terminal/orphaned phases), idempotent startup recovery sweep, run.list + progress-port replay reconnection, six acceptance criteria and six fixtures. Policy questions (ad-hoc cancellation, orphan retention, progress granularity, resume-vs-orphan) remain explicitly OPEN and unapproved.
  - 2026-08-19 19:56 UTC — re-review BLOCK corrected (final finding): the outbox now persists the full recoverable terminal payload (or durable payload reference), never only a digest; the thread assistant/status terminal append is idempotent by executionId; startup reconciliation completes outbox entries BEFORE any orphaning decision (a stale settling record with an outbox is completed, never orphaned); the fault matrix now covers the thread-write and outbox acknowledgement/removal boundaries. Policy questions remain explicitly OPEN and unapproved.
  - 2026-08-19 19:50 UTC — independent review BLOCK corrected (8 findings): scheduled behavior re-mapped truthfully (in-memory same-boot authority, heartbeat as storage-failure canary, boot-identity lock clear, re-arm reconciliation, creation-only quarantine, and the at-least-once duplicate window between journal commit and schedule removal); ad-hoc map now includes the durable thread authority and its three exact crash windows; exactly-once terminal now specified as an explicit commit protocol (idempotent journal result keyed by immutable executionId + CAS run transition + durable outbox + full fault matrix); run registry requires a newly reserved trusted master-store prefix (model writes cannot forge it); reconnect replay uses monotonic per-run revision + buffered-snapshot-drain; direct site-agent agent.delegate runs are in scope; canonical SW-issued executionId separated from client correlation/thread/schedule ids; heartbeats documented as freshness evidence, not survival. Policy questions remain explicitly OPEN and unapproved.

## [CAP-FB-20260819-SITE-AGENT-STATUS-CLEANUP-01] Site Agents and Agent Dev status cleanup
- Feedback: 2026-08-19 — basic task rows expose stale or noisy WebMCP injection and page-report status text that belongs in a diagnostic surface
- Updated: 2026-08-19 18:13 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: ordinary task and Site Agent rows show concise current execution state only; stale injection/page-report messages cannot persist or displace task status; bounded timestamped discovery and injection diagnostics remain available in the dedicated Site Agent or Agent Dev detail surface
- Review: pending independent information-architecture, bounds, freshness, and loaded-MV3 review
- Gates: status-source units; navigation/reload/injection failure and recovery journeys; row/detail screenshots; stale-generation fencing; diagnostic byte/count/time bounds; keyboard and raw AX inspection
- Blockers: diagnostic truth must remain inspectable under `CAP-FB-20260818-WEBMCP-01` while structured detail remains compatible with `CAP-FB-20260818-TOOL-TREE-01`
- Next: classify every WebMCP injection and page-report message as task status, transient progress, or bounded diagnostic, then move each to its owning surface
- Recover: `git show bbeff7b:TASKS.md && git grep -n "WebMCP\|injection\|page report" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — opened as a status-surface cleanup; existing WebMCP discovery evidence remains a linked requirement, not a substitute.

## [CAP-FB-20260819-DISCOVER-SITE-TOOLS-COPY-01] Truthful Site Agent and tool-discovery action copy
- Feedback: 2026-08-19 — “Discover this page” and “pick a tab to scan” overstate page scanning instead of describing tool and Site Agent discovery
- Updated: 2026-08-19 18:13 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: labels, descriptions, permission rationale, empty/error/success states, and announcements consistently describe discovering available tools and Site Agent capabilities for a selected tab; copy never promises general page scanning, reading, or verification that did not occur
- Review: pending independent product-copy, permissions, accessibility, and loaded-MV3 review
- Gates: repository copy inventory; state-transition units; real selected-tab discovery with no-tools, probable-tools, verified-tools, non-injectable, denied, and stale cases; accessible names/live announcements; localized-layout screenshots
- Blockers: action wording must remain consistent with `CAP-FB-20260818-WEBMCP-01`, `CAP-FB-20260819-PERMISSIONS-01`, and the page identity defined by `CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01`
- Next: define the discovery vocabulary and state table, then replace every page-scan label and assertion from one shared source
- Recover: `git show bbeff7b:TASKS.md && git grep -n "Discover this page\|pick a tab\|scan" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — captured as a truthful-copy task distinct from implementing proactive discovery or page-scoped identity.

## [CAP-FB-20260819-PROACTIVE-TAB-DISCOVERY-01] Proactive per-tab Site Agent discovery before Run
- Feedback: 2026-08-19 — before Run, the product should show what a selected tab is likely or verified to offer instead of waiting for a blind execution attempt
- Updated: 2026-08-19 18:13 UTC
- Status: BLOCKED
- Resume: OPEN
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: before Run, each selected tab shows bounded known or probable tool count, capability summary, injectability, owner-visible screenshot or description when authorized, current page state, and observation timestamp; heuristic/probable data is visually and accessibly distinct from verified discovery and stale data cannot authorize execution
- Review: pending independent privacy, permission, freshness, heuristic-truth, accessibility, and loaded-MV3 review
- Gates: deterministic heuristic-versus-verified units; selected-tab navigation/reload/injectability/permission matrix; screenshot/description provenance and bounds; stale timestamp fencing; raw AX labels; narrow/RTL/theme screenshots; no automatic broad permission request
- Blockers: implementation is blocked on the page/document/toolset identity contract in `CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01` and owner-driven permission behavior in `CAP-FB-20260819-PERMISSIONS-01`
- Next: complete the linked page identity and discovery-state contracts, then define the minimum pre-Run observation that is useful without overclaiming verification
- Recover: `git show bbeff7b:TASKS.md && git grep -n "discover-active\|active tab" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — captured in BLOCKED state because origin-only identity and permission semantics cannot safely support proactive per-tab claims yet.

## [CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01] Page-scoped Site Agent identity and lifecycle
- Feedback: 2026-08-19 — origin-only Site Agent identity conflates same-origin subpages that expose different WebMCP tools, titles, and navigation lifecycles
- Updated: 2026-08-19 18:13 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: Site Agent identity includes a page/document/navigation epoch and canonical toolset identity in addition to origin; same-origin subpages with different tools remain distinct, titles are useful and bounded, reload/navigation invalidates stale authority, and durable history reconnects only when identity continuity is proven
- Review: pending independent identity-model, migration, privacy, lifecycle, concurrency, and loaded-MV3 review
- Gates: same-origin multi-page fixtures with different tools; SPA navigation, full navigation, reload, back/forward, duplicate tabs, closed/reopened tabs, toolset mutation, stale-message fencing, bounded title and fingerprint checks, raw AX labels, and persisted-record migration
- Blockers: the identity must preserve origin isolation and sender authentication from `CAP-FB-20260818-WEBMCP-01` while composing with canonical references from `CAP-FB-20260818-AGENT-ACCESS-01`
- Next: design the canonical page identity, toolset fingerprint, navigation invalidation, and migration rules before changing storage or UI keys
- Recover: `git show bbeff7b:TASKS.md && git grep -n "canonicalOrigin\|site:" bbeff7b -- extension`
- History:
  - 2026-08-19 18:13 UTC — opened as the prerequisite identity task for proactive per-tab discovery; no origin-only record is relabelled as page-verified.

## [CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01] Agent Directory tool explorer and enrollment policy
- Feedback: 2026-08-19 — Directory feedback requested a page-aware tool explorer and raised, without resolving, the product boundary between enrolling an agent and approving individual tool use
- Updated: 2026-08-19 18:15 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: every listed tool has a bounded truthful description, input schema summary, useful metadata, and its source page URL, title, and origin; Declared and Approved controls remain contained in and accessibly labelled to the exact tool; pages or sites with zero verified tools are excluded; the enrollment-versus-per-tool-approval policy is documented as an explicit researched decision rather than inferred from feedback
- Review: research and product-policy decision pending before implementation; subsequent independent security, permissions, information-architecture, accessibility, and loaded-MV3 review required
- Gates: prior-art and threat-model note; policy decision record; production-registry fixtures with multiple pages/tools and zero-tool exclusions; tool-card containment and exact AX labels; page URL/title/origin provenance; narrow/RTL/theme screenshots; enrollment and per-tool approval journeys matching the chosen policy
- Blockers: implementation must not start until research distinguishes agent enrollment authority from per-tool invocation approval and records the product decision; page provenance depends on `CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01`
- Next: research enrollment and per-tool approval models, document trade-offs and abuse cases, and obtain an explicit product decision before designing controls
- Recover: `git show bbeff7b:TASKS.md && git grep -n "tool-directory-card\|approveTool\|agent.create" bbeff7b -- extension`
- History:
  - 2026-08-19 18:15 UTC — opened in research-first state and cross-linked to `CAP-FB-20260819-AGENT-DIRECTORY-01`; uncertainty was recorded as an unresolved policy question, not approval.

## [CAP-FB-20260819-UI-FLASH-RELAYOUT-01] Intermittent extension-wide UI flash and relayout investigation
- Feedback: 2026-08-19 — intermittent whole-interface flashes or relayouts are visible across the NTP and extension pages without a confirmed trigger or root cause
- Updated: 2026-08-19 18:15 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: the intermittent flash is reproducible or boundedly classified with synchronized recording and screenshots; CDP evidence distinguishes layout shift, full rerender, stylesheet/font/theme reload, iframe or screenshot artifact, view transition, navigation, and service-worker/state replacement; a demonstrated root cause is fixed and a browser regression proves no whole-UI flash under the reproducing sequence
- Review: research-first reproduction and trace analysis pending; any correction requires independent performance, rendering, accessibility, and exact loaded-MV3 review
- Gates: repeated fresh-profile NTP/chat/options/Directory/Assets/view-switch journeys; video or frame sequence with timestamps; Performance and tracing events; layout-shift rectangles; DOM/style/theme/font/navigation/view-transition mutation timeline; console/runtime/network logs; before/after screenshots; root-cause-specific regression with a visible no-flash oracle
- Blockers: no correction should be selected until evidence identifies the owning layer and excludes capture-only artifacts; intermittent reproduction may require a bounded matrix across routes, themes, viewport sizes, and service-worker restarts
- Next: build a read-only reproduction harness that records synchronized screenshots, CDP trace domains, DOM mutation markers, theme/style/font loads, navigation, view-transition events, and service-worker lifecycle before proposing a fix
- Recover: `git show bbeff7b:TASKS.md && git grep -n "startViewTransition\|data-theme\|location.reload" bbeff7b -- extension`
- History:
  - 2026-08-19 18:15 UTC — captured as a research-first extension-wide investigation; no single rendering subsystem or fix is assumed without trace evidence.

## [CAP-FB-20260819-RECENT-ACTIVITY-UI-01] Recent Activity layout, structured detail, and error truth
- Feedback: 2026-08-19 — Recent Activity on the NTP has overlapping timestamps, escaped tool/data details, unclear error visibility, and awkward filter spacing
- Updated: 2026-08-19 18:16 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: relative-time labels such as “10 minutes ago” remain visible and never overlap task or event text across supported widths and RTL; tool-call and data details parse and render as bounded accessible nested objects rather than escaped JSON or backslash strings; error events are truthfully represented and keyboard-discoverable/filterable so “no errors” is distinguishable from hidden errors; search and All agents filters have intentional compact spacing without residual padding
- Review: pending independent data-parsing, error-truth, bounds, visual, keyboard, and accessibility review
- Gates: long task/event/time fixtures; nested object/array/string/invalid-JSON fixtures; explicit error/no-error/filtered-error states; parser and bounds units; real loaded-MV3 wide, narrow, RTL, and Midnight screenshots; raw AX tree and keyboard traversal; overflow/hit-target checks; zero console/runtime errors
- Blockers: structured detail may reuse reviewed primitives from `CAP-FB-20260818-TOOL-TREE-01`, but that historical renderer and evidence do not prove Recent Activity parsing, layout, filtering, or error behavior
- Next: capture failing fixtures for long relative times, long event text, nested tool data, escaped strings, errors, and filter spacing, then define the Recent Activity row/detail/error contract before implementation
- Recover: `git show bbeff7b:TASKS.md && git grep -n "Recent activity\|activity-search\|All agents" bbeff7b -- extension`
- History:
  - 2026-08-19 18:16 UTC — opened as a separate NTP correctness task and linked to, but not claimed covered by, the historical structured tool renderer.

## [CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01] User-facing permission management and run remediation
- Feedback: 2026-08-19 — permission failures need truthful owner-facing diagnosis, least-privilege remediation, and deterministic run continuation rather than vague missing-permission messages
- Updated: 2026-08-19 19:40 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: `docs/permission-remediation-design`
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: Settings reflects actual Chrome optional permissions and site access separately from agent/task policy; a failed run names the exact tool, capability, origin, rationale, and least-privilege choices instead of a vague `<all_urls>` or permission error; the run pauses safely, creates a visible owner-only approval prompt or inbox item, grants only through a genuine browser gesture, and deterministically resumes the same run or records deny, cancel, revoke, and retry outcomes; pending and error history remains discoverable
- Review: pending independent permission-model, owner-authority, privacy, recovery, Settings-synchronization, accessibility, and loaded-MV3 review of `docs/permission-remediation-design.md`
- Gates: exact-host, activeTab, optional capability, and `<all_urls>` denial/remediation matrix; genuine Settings and browser permission gestures; agent/task policy versus Chrome-state assertions; owner-only prompt and inbox AX/keyboard checks; view changes, tab reopen, service-worker restart, deny/cancel/revoke/retry, same-run resume, stale-owner fencing, and synchronized Settings screenshots
- Blockers: must build on, but remain a separate user-facing workstream from, `CAP-FB-20260819-PERMISSIONS-01`; no implementation may make permission grants model-callable, silently broaden site access, or blanket-grant `<all_urls>`
- Next: obtain an explicit product decision on the agent/task policy layer, auto-resume, and one-shot JIT continuation (all explicitly unapproved) before any implementation; then design the owner-only inbox + paused-run resume state machine from `docs/permission-remediation-design.md`
- Recover: `git show bbeff7b:TASKS.md && git grep -n "permissions.request\|optional_permissions\|all_urls" bbeff7b -- extension`
- History:
  - 2026-08-19 19:40 UTC — fourth docs-review correction applied: the source-map intro is now the bounded "known user-visible sources observed during this review; not formal/exhaustive" wording, and the duplicate row-15 numbering is fixed.
  - 2026-08-19 19:37 UTC — third docs-review correction applied: added the shared/components.js:4548 role=status storage-permission source to the map and removed the prior History "corrected/completed" wording (no premature complete-map claim).
  - 2026-08-19 19:30 UTC — second docs-review corrections applied: the paused-run state machine now stops at the neutral `GRANTED_WAITING_RESUME_POLICY` state and branches BOTH open resume alternatives (no unconditional grant→RUNNING); the source map adds the conversation.js:395-449 inline retry + error-report.js:44-45 generic permission presentation and corrects the early provider gate to service-worker.js:1195-1203 + provider-gate.js:115-131; History no longer claims a complete map.
  - 2026-08-19 18:40 UTC — docs review BLOCK corrections applied: auto-resume vs explicit Resume left as two OPEN alternatives (neither normative); the source map corrected (global/origins scope labels, activeTab-or-tabs, injectScriptsIntoOpenTabs, scheduler/enrollment/options/ntp/components sources); activeTab is a target-tab invocation journey (not a Settings button); exact-origin is the minimum persistent host grant with narrowing in the policy layer only; <all_urls> is not declared and not a current choice; the Permissions lane is labeled an unshipped candidate; multi-run ordering and distinct DENIED vs CANCELLED defined; Updated timestamp reconciled.
  - 2026-08-19 18:40 UTC — public-safe research/design report added as `docs/permission-remediation-design.md` (maps the 12 missing-permission/error sources + Settings surfaces, separates Chrome optional/site state from agent/task policy, and designs the owner-only inbox, the paused-run resume state machine, deny/cancel/revoke/retry, the threat model, and loaded-MV3 fixtures). Auto-resume and one-shot JIT continuation remain explicitly unapproved.
  - 2026-08-19 18:17 UTC — opened as a distinct Settings and run-remediation UX task; the existing orchestration candidate remains linked and is not treated as user-facing acceptance.

## [CAP-FB-20260819-AGENT-DELETION-LIFECYCLE-01] Owner-only agent deletion and lifecycle cleanup
- Feedback: 2026-08-19 — owners need a discoverable, safe way to delete an agent while the policy for artifacts owned or produced by that agent remains unresolved
- Updated: 2026-08-19 18:18 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: `docs/agent-deletion-lifecycle` (research complete; implementation unassigned)
- Base: `bbeff7b7e0f44e240fc5418c266d1b4707e09ac1`
- Candidate: —
- Shipping: —
- Acceptance: only the owner can reach deletion; confirmation names the exact agent and previews bounded dependency counts and affected resource classes; active runs are safely blocked, cancelled, or settled before a transactional idempotent cleanup revokes schedules, permission and credential references, memory, threads and task links, and registry/index entries; partial failure is recoverable and auditable; deny and cancel mutate nothing; artifacts are never silently cascade-deleted while archive, ownership transfer, orphan/read-only retention, export, and cascade policies remain an explicit researched decision
- Review: design research complete (docs/agent-deletion-lifecycle-design.md) and corrected after an independent review's five findings; independent re-review pending, then the OPEN artifact-policy decision; subsequent independent owner-authority, transaction, privacy, concurrency, recovery, accessibility, and loaded-MV3 review required
- Gates: dependency-graph/count preview; exact-agent confirmation and owner-only AX/keyboard path; deny/cancel and least-privilege checks; active-run settle/cancel races; schedule/permission/reference/memory/thread/task/registry cleanup invariants; injected step failures with retry and idempotence; service-worker restart and concurrent delete/update; artifact policy fixtures for every researched option; before/after UI and raw storage evidence
- Blockers: artifact disposition must remain OPEN until research and an explicit product decision; cleanup must compose with `CAP-FB-20260818-ARTIFACT-TX-01`, approval and remediation authority in `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`, and agent identity/presentation in `CAP-FB-20260819-AGENT-DIRECTORY-01`
- Next: independent review of the design, then an explicit product decision on the artifact disposition policy (archive / transfer / orphan-read-only / export / cascade) — still OPEN; no implementation before the decision
- Recover: `git show bbeff7b:TASKS.md && git grep -n "agent.delete\|deleteAgent\|scheduled" bbeff7b -- extension`
- History:
  - 2026-08-19 18:18 UTC — opened as a research-first lifecycle task; artifact disposition uncertainty is recorded as unresolved and no cascade behavior is authorized.
  - 2026-08-19 19:05 UTC — research completed: full store map, gap analysis, owner-only transactional deletion state machine (durable intent, settle/cancel, idempotent resume, restart/concurrency safety), acceptance criteria, and storage fixtures frozen in docs/agent-deletion-lifecycle-design.md; the artifact disposition policy remains explicitly OPEN and unapproved.
  - 2026-08-19 19:20 UTC — independent review BLOCK corrected: embedded coreAssets now covered by the dependency preview and every artifact-disposition option (no silent registry-row deletion); a new durable agent-bound execution registry with deletion tombstone/generation and pre/post-write commit revalidation specified; the transaction authority is now an explicit dependency on the unshipped artifact-transaction lane or a self-contained minimal intent/reconcile protocol; exact registry key cap:namedAgents; the artifact disposition policy remains explicitly OPEN and unapproved.
  - 2026-08-19 19:45 UTC — re-review BLOCK corrected: store map made exact (memory/agents/<slug> per-agent stores, master-memory customRecipes key, cap:scheduledTasks, versioned journal.json files, cap:promptOverrides included; no cap:recipes, no canonical memory.json); failure semantics made fail-closed — any memory/prompt/dependency cleanup failure stops in a durable retryable CLEANUP_FAILED state BEFORE REGISTRY_REMOVED (never best-effort continue to authority-row removal).

## [CAP-FB-20260819-LOCAL-MODEL-MANAGEMENT-01] Downloadable in-extension local model management
- Feedback: 2026-08-19 — product-owner voice feedback requested on-demand local models inside the extension; the transcript's apparent “Gemma 4” wording is uncertain and is not a model claim, while Gemma and Qwen are the requested model families
- Updated: 2026-08-20 03:25 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: `docs/local-model-management-current-main`
- Base: `669016edc75531f014a1e8406d4d39192b26750c`
- Candidate: —
- Shipping: —
- Acceptance: Settings lets the owner explicitly discover, download on demand, select, update, and delete browser-local models without Ollama; model entries expose safe provenance, version, size, integrity and licence information before download; large downloads have truthful progress plus cancel, resumable recovery, integrity verification, and version-aware update behavior; quota, storage usage, deletion, device capability, WebGPU and Wasm compatibility are visible before destructive or expensive actions; a verified download supports inference with network disabled; no network access, model discovery, model download, selection change, update, or deletion occurs silently; every quota, compatibility, integrity, interruption, offline, and inference failure has a clear bounded recovery path
- Review: independently accepted TASKS-only source capture `676bfa0674d1525362b3496e81e3047dcefb6727`; exact current-main replay review pending, then independent runtime, supply-chain, licence, privacy, storage, performance, accessibility, and exact loaded-MV3 browser review
- Gates: document an evidence-based comparison of ONNX Runtime Web versus Transformers.js and justify any other browser-native runtime before adoption; use bounded small model/manifest/corruption/interruption fixtures in CI; drive the real loaded MV3 Settings UI through explicit discovery, download, progress, cancel/resume, integrity, select, offline inference, update, storage accounting, and deletion journeys with network assertions and before/after evidence; CI fixtures do not substitute for a real compatible model artifact and offline inference acceptance
- Blockers: exact browser-native runtime; exact Gemma and Qwen model IDs and parameter sizes; quantization formats; sources and licences; model update/version policy; storage backend and ownership, quota, eviction, atomicity, and recovery; and download integrity and supply-chain/security policy all remain OPEN; the design must compose with provider/model selection in `CAP-FB-20260818-PROVIDER-PICKER-01`, permission authority and remediation in `CAP-FB-20260819-PERMISSIONS-01` and `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`, and durable storage semantics in `CAP-FB-20260818-ARTIFACT-TX-01`
- Next: research the browser-native runtime, exact model IDs and sizes, quantization, sources and licences, compatibility, update/version, storage/ownership/quota/eviction/atomicity/recovery, integrity, and supply-chain/security matrices; record explicit decisions before implementing discovery or downloading any model
- Recover: `git show 669016e:TASKS.md && git log -1 --format=%H -- TASKS.md && git diff 669016e -- TASKS.md`
- History:
  - 2026-08-19 21:08 UTC — captured the local-model request as research-first OPEN work; no Ollama dependency, model identity, size, quantization, licence, runtime, or storage backend is inferred or approved from the uncertain voice transcription.
  - 2026-08-20 03:25 UTC — replayed the independently accepted public-safe task capture onto exact current public main; the extension-managed download goal remains OPEN, with no runtime, model identity or size, quantization, source or licence, update/version, storage/ownership/quota/eviction/atomicity/recovery, integrity, or supply-chain/security choice approved.

## [CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01] Local semantic search over the complete tool catalog
- Feedback: 2026-08-20 — product-owner requested WebMCP-relay/Modern-Web-Guidance-style retrieval so the model receives only the most relevant tools instead of every available definition
- Updated: 2026-08-20 15:21 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `ecf657fe2f9e32aee7b5e2043808f4f7978fd456`
- Candidate: —
- Shipping: —
- Acceptance: one local versioned catalog indexes every callable built-in tool, extension-provided tool, declared WebMCP tool and positively inferred WebMCP tool with stable source, scope, generation/document identity, bounded description, schema summary and searchable text; each run retrieves a bounded top-k set by semantic/cosine relevance plus deterministic exact-name/alias and lexical fallback, and only that authorized set is exposed to the model; retrieval never grants permission, bypasses source-specific dispatch, crosses origin/agent boundaries, revives removed tools, or lets untrusted tool text alter ranking policy or protected prompts; index updates, removals, extension upgrades, navigation, service-worker restart and offline startup converge without sending the whole catalog; owner diagnostics explain selected, excluded, stale and fallback results without exposing secrets or private data
- Review: research-first; independent architecture, retrieval-quality, security/privacy, lifecycle, performance and exact loaded-MV3 review required before implementation acceptance
- Gates: compare SQLite/Wasm and IndexedDB storage/indexing under MV3 CSP, worker lifetime, migration, quota and crash semantics; compare local embedding choices, dimensions, update cost and deterministic lexical fallback; build a versioned bounded corpus spanning all four tool sources with relevance/precision/recall and token-budget targets plus measured budgets for catalog-scale warm-query latency, cold/offline startup, full index build, incremental add/update/remove, persisted index bytes and peak memory; establish explicit device/corpus tiers and pass/fail budgets during research before implementation; exact-name, paraphrase, multi-intent, low-confidence, collision and no-match queries; adversarial descriptions/schema/prompt-injection and oversized/Unicode fixtures; source/generation/origin/permission fencing; add/update/remove/navigation/restart/offline/corruption recovery; loaded-MV3 proof that only selected descriptors reach the provider while non-selected tools remain undisclosed and uncallable
- Blockers: storage engine, local embedding model/runtime, ranking thresholds/top-k/token budget, hybrid semantic-versus-lexical policy, catalog schema, update authority and embedding provenance remain OPEN; the design must compose with `CAP-FB-20260818-WEBMCP-01`, page identity in `CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01`, canonical agent references in `CAP-FB-20260818-AGENT-ACCESS-01`, and permission remediation in `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`
- Next: study the existing WebMCP-relay registry and Modern Web Guidance search implementation, inventory every current tool registration/dispatch path, then write a decision matrix for catalog schema, SQLite versus IndexedDB, local embeddings, hybrid ranking, invalidation and security before selecting an implementation
- Recover: `git show ecf657f:TASKS.md && git grep -n "toolSetForOrigin\|MANAGEMENT_TOOL\|browserTools\|webmcpExpose\|document.modelContext" ecf657f -- extension`
- History:
  - 2026-08-20 15:21 UTC — opened as research-first semantic tool retrieval across built-in, extension, declared WebMCP and inferred WebMCP sources; no database, embedding model, threshold or runtime was inferred from the request.

## [CAP-FB-20260821-WORKTREE-HYGIENE-01] Durable worktrees and evidence off the RAM-backed temp filesystem
- Feedback: 2026-08-21 — independent architectural review found the build host's temporary filesystem at 100% inode use, which failed the unit suite, and found reviewed work and retained gate evidence stored only on tmpfs
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: the build host's temporary filesystem reports headroom sufficient to run the full unit and Chrome journey suites without an `ENOSPC`/inode failure; no git worktree and no retained gate-evidence bundle referenced by any `Gates:` field in this tracker resides on a RAM-backed filesystem; every worktree HEAD is reachable from a branch or an explicit rescue tag before that worktree is removed; worktrees holding no commits beyond `origin/main` are removed and `git worktree prune` reports a clean list; a written convention records where worktrees and evidence live and is added to `AGENTS.md`
- Review: independent verification that no commit reachable only from a removed worktree was lost, by comparing the pre-removal HEAD set against branch and tag reachability
- Gates: pre-removal inventory of every worktree HEAD with reachability classification; `df -i` before and after; `git worktree list` and `git worktree prune` output; `git fsck --unreachable` diff showing no newly unreachable commit; full unit suite green on the reclaimed host
- Blockers: seven detached candidates were reachable only from temp-filesystem worktree HEADs; they are preserved as local `rescue/tmp-detached-*` tags and must not be pruned until each is either merged, superseded on a branch, or explicitly abandoned in this tracker
- Next: inventory every worktree HEAD and classify it as reachable-from-branch, rescue-tagged, or unreachable; remove only the zero-work and duplicate-HEAD worktrees; then relocate the survivors to durable storage
- Recover: `git worktree list --porcelain && git tag -l 'rescue/*' && git fsck --unreachable`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D1/D2). Seven at-risk commits were tagged `rescue/tmp-detached-*` locally before this entry was written; no worktree, branch, or object was deleted.

## [CAP-FB-20260821-TRACKER-GIT-RECONCILE-01] Reconcile this tracker with the repository
- Feedback: 2026-08-21 — independent architectural review found at least nine tasks recorded as unassigned with no branch that have committed implementation work, and found only 2 of 430 commits carry a `CAP-FB-*` identifier
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: every task whose implementation exists in the repository records that branch and its exact tip commit in `Branch` and `Candidate`, with a `Status` no more advanced than the evidence supports; every task recorded as unassigned with no branch has been checked against `git for-each-ref` and `git worktree list` and genuinely has no work; each `Recover:` command, run verbatim, returns the task's own material; a commit-message convention requiring the `CAP-FB-*` identifier is added to `AGENTS.md` and enforced by a check
- Review: an independent session re-derives the task-to-branch mapping from the repository alone and confirms it matches the tracker, without consulting the private coordination ledger
- Gates: for every task with a recorded candidate, `git cat-file -e <sha>^{commit}` and `git merge-base --is-ancestor <base> <candidate>`; a verbatim run of every `Recover:` command with its output; a count of commits carrying a `CAP-FB-*` identifier before and after the convention lands
- Blockers: ownership transfers must follow the atomic compare-and-swap procedure in this file; a competing tracker commit is reconciled, never overwritten
- Next: enumerate every branch and worktree ahead of `origin/main`, map each to its task, and commit one reconciliation that writes the real `Branch`/`Candidate`/`Status` into the affected entries
- Recover: `git for-each-ref --format='%(refname:short)' refs/heads/ && git log --all --oneline --grep='CAP-FB' | wc -l`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.4). The nine confirmed task-to-branch mismatches are listed there; this task exists to correct them in the tracker, not to advance any of their statuses.

## [CAP-FB-20260821-STALE-BRANCH-TRIAGE-01] Land or abandon the unmerged branch backlog
- Feedback: 2026-08-21 — independent architectural review found 46 branches ahead of `origin/main`, several holding independently reviewed work, stalled by repeated base-change re-review
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: every branch ahead of `origin/main` reaches an explicit terminal disposition — merged, superseded by a named successor, or abandoned with a recorded reason — and the disposition is written into its owning task; the merged set passes the full unit and Chrome journey suites at the resulting tip; branch count ahead of `origin/main` is reduced to the actively worked lanes only; no branch is silently deleted
- Review: independent review of the merged range as one integration, and independent confirmation that each abandoned branch's task records why
- Gates: full unit suite and `scripts/chrome-journeys.ts` green at the post-triage tip; a per-branch disposition table with commit ranges; `git branch --merged` and `git branch --no-merged` before and after
- Blockers: requires a declared freeze window on `origin/main` — triaging against a moving base reproduces the exact failure this task exists to end; the freeze is an owner decision and is still outstanding. Note that rule 3 of the 2026-08-21 lifecycle decision ("a review is valid for its content, not its base") already removes most of the pressure: a candidate that passed review and does not conflict with what landed since can be rebased and merged without re-review
- Next: obtain the freeze window; meanwhile produce the per-branch disposition table and identify which branches rule 3 lets through without re-review
- Recover: `git for-each-ref --format='%(refname:short)' refs/heads/ | while read b; do echo "$b $(git rev-list --count origin/main..$b)"; done`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.2). No branch disposition is asserted here; the triage itself is the deliverable.

## [CAP-FB-20260821-DELIVERY-LIFECYCLE-01] Simplify the delivery lifecycle
- Feedback: 2026-08-21 — independent architectural review measured a 96% collapse in landed commits over 72 hours, correlated with the nine-state lifecycle and mandatory handoff protocol, with zero tasks reaching the terminal state
- Updated: 2026-08-21 10:15 UTC
- Status: MERGED
- Resume: —
- Priority: P0
- Owner: review author (landing the owner's decision)
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: this lifecycle commit
- Shipping: this lifecycle commit on `origin/main`
- Acceptance: the owner records an explicit decision on each proposed rule change in `REVIEW-2026-08-21.md` §7; `AGENTS.md`, `TASKS.md` and this repository's stated lifecycle are updated to match that decision in one commit; the two retained hard rules — independent review by a different model, and real-browser verification — remain stated and enforced; tasks that are shipped can reach a terminal state without a per-task owner interaction, or the terminal state is redefined so they can
- Review: owner decision required before any rule is changed; an independent session then verifies the documentation is internally consistent across `AGENTS.md`, `TASKS.md`, `PLAN.md` and `REVIEW-2026-08-21.md`
- Gates: a written decision per proposed rule; a cross-document consistency check for the lifecycle state list; landed-commits-per-day measured for one week after the change
- Blockers: —
- Next: run the Chrome journey suite at the merged tip and move to `DONE`; then measure landed-commits-per-day for one week against the pre-change baseline recorded in `REVIEW-2026-08-21.md` §2
- Recover: `git show cdc1a65:AGENTS.md && git log --oneline -- AGENTS.md TASKS.md`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.1, §2.3, §7). The measured evidence is recorded there; the proposed rules are explicitly proposals awaiting an owner decision.
  - 2026-08-21 10:15 UTC — **product owner approved all six proposed rule changes.** `AGENTS.md` and `TASKS.md` now state `OPEN → IN_REVIEW → MERGED → DONE` with `BLOCKED`/`ABANDONED` off-ramps; `DONE` no longer requires a per-task owner interaction. The two load-bearing rules are retained verbatim: a different model/session reviews every change, and real-browser verification with evidence. Content-addressed gate evidence, live remote attestation, versioned acceptance packages and the five intermediate states are removed. Rules 3–6 (review validity by content not base; `CAP-FB-*` in the commit subject; no worktree or evidence on a RAM-backed filesystem; no `-vN+1` without a commit in `-vN`) are recorded in `AGENTS.md`. Existing entries are deliberately NOT rewritten — a documented legacy-state mapping is published instead, so no prior status, evidence or acceptance is silently reclassified.

## [CAP-FB-20260821-PUSHED-TASK-CLOSEOUT-01] Close out the shipped-but-unconfirmed tasks
- Feedback: 2026-08-21 — independent architectural review found four tasks at `PUSHED` awaiting only product-owner confirmation, some since 2026-08-18, blocking three further tasks that name them as dependencies
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: `CAP-FB-20260818-RUN-STATUS-01`, `CAP-FB-20260818-WEBMCP-01`, `CAP-FB-20260818-AGENT-ACCESS-01` and `CAP-FB-20260818-SYSPROMPT-01` each reach a terminal state and move intact to Archive, or record a specific named regression preventing it; the tasks blocked on them (`CAP-FB-20260818-SIDEBAR-01`, `CAP-FB-20260818-TOOL-TREE-01`, `CAP-FB-20260818-SIDEPANEL-PARITY-01`) are unblocked or re-blocked on a different, stated reason
- Review: a current-main regression check covering the four features, presented to the owner as one confirmation request rather than four
- Gates: `scripts/chrome-journeys.ts` at the current tip (the independent review recorded 126/126 at `300bea1`, a documentation-only ancestor of the current tip); each shipped commit confirmed as an ancestor of `origin/main` with `git merge-base --is-ancestor`
- Blockers: — (the 2026-08-21 lifecycle decision removed the per-task confirmation requirement; `DONE` is now merged plus the journey suite green at that tip, which all four already satisfy pending one regression run)
- Next: run one regression pass at the current tip covering all four features, then move all four to `DONE` and archive them
- Recover: `git merge-base --is-ancestor ffbdf28 origin/main && git merge-base --is-ancestor 215d815 origin/main`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.1). No confirmation is inferred and no status of the four tasks is changed by this entry.

## [CAP-FB-20260821-FIRST-RUN-ONBOARDING-01] First-run setup and the session-only storage cliff
- Feedback: 2026-08-21 — independent architectural review reproduced a fresh install showing empty states plus a red error badge, with no onboarding path, and confirmed an API key entered without the optional storage permission is lost on the next service-worker restart
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: a first run with zero granted permissions presents a clear path to a working state — choose a provider, supply a key, grant storage in the same owner gesture, and complete one seeded task that produces a visible artifact; entering a credential while storage is ungranted warns at the point of entry that the value will not survive a worker restart, and offers the grant inline; the ungranted-storage condition is presented as a setup step, not as an error-console fault; the extension still boots and degrades gracefully with zero permissions; no permission is requested outside a genuine owner gesture and none becomes model-callable
- Review: independent permission-model, first-run information-architecture, accessibility and exact loaded-MV3 review
- Gates: fresh-profile loaded-MV3 walkthrough with before/after screenshots; assert the credential warning renders before the value is accepted; service-worker restart after a granted and an ungranted save, asserting retention and loss respectively; keyboard-complete and screen-reader labelling of the setup path; zero-permission boot still clean
- Blockers: must not weaken the all-optional permission model or pre-request any capability; must compose with `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01` rather than duplicate its remediation surface
- Next: inventory every state a zero-permission fresh profile can reach, then specify the minimum setup path and the credential-durability warning contract before building UI
- Recover: `git grep -n "storage permission not granted\|session-only" -- extension && git grep -n "permissions.request" -- extension/options`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D5). The existing warning is honest and is not treated as a defect in itself; the defect is the absence of a path forward and the silent credential loss.

## [CAP-FB-20260821-WEBMCP-STATUS-ALIGNMENT-01] Hub WebMCP discovery status renders outside its card
- Feedback: 2026-08-21 — independent architectural review reproduced the hub's WebMCP discovery status line rendering flush to the panel edge, misaligned with every sibling row and breaking the card boundary
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: the discovery status line aligns with every other row inside its panel across expanded, collapsed, narrow, wide, RTL and every shipped theme; the fix is expressed once in shared style rather than as a one-off override; no sibling row's geometry regresses; the status text remains bounded and truthful about attested-versus-page-reported values
- Review: independent visual, geometry and accessibility review against exact loaded-MV3 screenshots
- Gates: loaded-MV3 before/after screenshots at wide and narrow viewports, RTL, and at least two themes; computed inline-start padding asserted equal to sibling rows; no change to the status text contract
- Blockers: `.panel-body` sets `padding: 4px 0`, so each row supplies its own inline padding; `#webmcp-hub-status` has no rule in the repository and is written directly via `textContent` at `extension/ntp/ntp.js:113`. Fix the shared row treatment rather than adding another one-off, per the heavy-componentization rule in `AGENTS.md`
- Next: reproduce at the current tip, then correct the shared panel-row treatment and capture before/after evidence
- Recover: `git grep -n "webmcp-hub-status\|panel-body" -- extension/ntp`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D4). Reproduced on a clean build of `300bea1`; present in no prior tracker.

## [CAP-FB-20260821-DEAD-SURFACE-REMOVAL-01] Remove superseded surfaces and the published mock site
- Feedback: 2026-08-21 — independent architectural review found six stale design mocks duplicated into the published documentation site, a published front page titled "UI mocks", and two shipped surfaces that no longer carry a job
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: the `mock/` directory and its duplicated copies under `docs/` are removed; the published front page presents the component gallery and a real product screenshot rather than dead mocks, or is withdrawn; the Chrome Prompt API and demo-local providers are removed from the user-facing provider picker while remaining reachable for internal testing if still needed; the side panel's Page tab is either given a stated job or folded into the Agents view; every removal is checked for inbound references across code, docs, tests and the gallery sync before it lands
- Review: independent review that no live surface, test, gallery entry or documentation link references a removed file
- Gates: full unit suite, `scripts/chrome-journeys.ts`, `npm run check:gallery` and `npm run test:components` green after removal; a repository-wide grep for each removed path returning no hits; a loaded-MV3 screenshot of the provider picker without the internal entries
- Blockers: removing providers from the picker must not remove a provider a user has already selected without a stated migration; the Page-tab decision is a product decision, not a cleanup
- Next: produce the removal inventory with inbound-reference counts per item, then land the uncontroversial removals separately from the Page-tab decision
- Recover: `git ls-files mock docs && git grep -n "prompt-api\|demo" -- extension/options extension/lib/provider.js`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §4). The provider-picker removal restates a backlog item standing since 2026-08-17 and is folded here so it has acceptance criteria and a gate.

## [CAP-FB-20260821-SW-ROUTE-MODULARIZATION-01] Split the service-worker route surface
- Feedback: 2026-08-21 — independent architectural review found 127 message routes in a single 4,799-line flat handler object, identifying it as a structural cause of cross-lane merge conflict and the serialized integration queue
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: routes are grouped into modules by subsystem behind a thin dispatcher; the sender-authorization decision, the page-route allowlist and the error-shaping path remain single authorities and are not duplicated per module; the external message contract is byte-identical — every route name, request shape and response shape unchanged; the bundle contains no new `eval`/`new Function`; no behavior change is bundled with the move
- Review: independent security review specifically confirming the page-route allowlist and sender authorization cannot be bypassed through any new module boundary
- Gates: full unit suite and `scripts/chrome-journeys.ts` green; `npm run test:security`; a diff-derived list proving the set of route names before and after is identical; bundle size and service-worker registration time compared before and after
- Blockers: must not start until `CAP-FB-20260821-STALE-BRANCH-TRIAGE-01` completes — a wide mechanical move performed while 46 branches are outstanding would invalidate all of them
- Next: after the branch triage, produce the route-to-module map and confirm the authorization seams before moving any code
- Recover: `git grep -c '^  \(async \)\?"' -- extension/background/service-worker.js`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D7). Explicitly sequenced after the branch triage to avoid invalidating outstanding work.

## [CAP-FB-20260821-RECIPES-SKILLS-RENAME-01] Finish the recipes to skills rename
- Feedback: 2026-08-21 — independent architectural review found the product concept named "Skills" in the UI while the code still ships a recipes directory, a 655-line recipes module and a `RECIPES` import, the drift `AGENTS.md` already cites as its worked example
- Updated: 2026-08-21 09:55 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: one vocabulary is used end to end — directory names, module names, exported symbols, route names, slash commands, autocomplete entries, UI copy, tests and documentation; a repository-wide grep for the retired term returns only intentional historical references in changelog or archive entries; stored user data written under the old naming continues to load, or a stated migration converts it
- Review: independent cross-subsystem review covering the composer, command registry, autocomplete, settings, hub and gallery
- Gates: full unit suite, `scripts/chrome-journeys.ts`, `npm run check:gallery` and `npm run test:components` green; a repository-wide grep for the retired term with each remaining hit justified; a loaded-MV3 pass over every surface that names the concept; a fixture proving pre-rename stored data still loads
- Blockers: the couplings named in `AGENTS.md` — composer, command registry, autocomplete, skills/agents registry — must all be updated together; a partial rename is what produced this entry
- Next: produce the full occurrence inventory across code, storage keys, routes, tests and docs before renaming anything
- Recover: `git grep -in "recipe" -- extension lib tests scripts docs`
- History:
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D8).

---

## Archive

No entries yet. Move only `CONFIRMED` or `ABANDONED` entries here with their
complete field set and History.

## Reconciliation log

- 2026-08-19 17:01 UTC — recovered the interrupted draft; reconciled stable CAP task IDs against the private coordination ledger, exact Git objects, current refs, and active worktree state. Public entries retain only role labels, repository refs, commit/evidence hashes, and conservative delivery states.
- 2026-08-19 17:07 UTC — reconciled after `origin/main` advanced to `ffbdf28`; run-status now records PUSHED, while the old-base Directory and artifact integrations explicitly require fresh current-main integrations.
- 2026-08-19 17:25 UTC — reconciled k3 tracker PASS, usage `d6030b7` REVIEW_PASSED, Assets successor `202b85e` REVIEWING, explicit gemini permission attribution, and old-base Directory/artifact READY_FOR_BROWSER classifications. No private coordination identifiers were copied.
- 2026-08-19 18:18 UTC — captured thirteen distinct product-feedback tasks on exact public `bbeff7b`; linked prior run-status, agent-access, sidebar, Directory, WebMCP, tool-tree, permission, and artifact-transaction tasks without merging or rewriting their histories. The additions retain unresolved enrollment-versus-tool-approval and agent-artifact-disposition decisions as research, treat intermittent whole-UI flashing as a trace-first investigation, keep Recent Activity layout/data/error truth separate from historical renderer evidence, and separate user-facing permission remediation from the existing orchestration candidate. New entries contain only public role custody, repository objects, acceptance criteria, and conservative OPEN/BLOCKED states.
- 2026-08-20 15:21 UTC — on exact public `ecf657f`, opened semantic tool retrieval across all four tool sources and strengthened the already-open conversation-status presentation task after repeated feedback proved the standalone top-of-task banner remains. No implementation or prior lifecycle acceptance was inferred.
- 2026-08-21 09:55 UTC — reconciled against an independent architectural review of exact public `300bea1` (documentation-only ancestor of `cdc1a65`). The review executed the build, the unit suite (632 pass, one environment-caused failure), the Chrome journey suite (126/126) and five surface captures. Ten new tasks were opened on exact `cdc1a65` covering worktree/evidence durability, tracker-to-repository reconciliation, the unmerged branch backlog, the delivery lifecycle decision, shipped-task closeout, first-run setup, one reproduced hub alignment defect, superseded-surface removal, service-worker route modularization and the unfinished recipes rename. No existing task's status, owner or evidence was altered, and no prior acceptance was inferred. Full rationale and the ordered work queue are in `REVIEW-2026-08-21.md`.
- 2026-08-21 10:15 UTC — the product owner approved all six rule changes in `REVIEW-2026-08-21.md` §7. The delivery lifecycle in this file and in `AGENTS.md` is now `OPEN → IN_REVIEW → MERGED → DONE` with `BLOCKED`/`ABANDONED` off-ramps, and `DONE` no longer depends on a per-task owner interaction. Independent review by a different model/session and real-browser verification are retained unchanged; content-addressed gate evidence, live remote attestation and versioned acceptance packages are removed. **No existing entry was rewritten** — a legacy-state mapping is published in the state rules instead, so no prior status, evidence or acceptance is silently reclassified. `CAP-FB-20260821-DELIVERY-LIFECYCLE-01` moves to `MERGED`; the confirmation blocker on `CAP-FB-20260821-PUSHED-TASK-CLOSEOUT-01` is cleared and the freeze-window pressure on `CAP-FB-20260821-STALE-BRANCH-TRIAGE-01` is reduced by rule 3.
