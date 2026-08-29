# Chrome Agent Platform tasks

`TASKS.md` is the repository-local, public-safe recovery record for product
feedback, bugs, reviews, and active delivery lanes. It complements, but never
copies, the private coordination ledger. The stable `CAP-FB-*` ID is the only
join key between the two systems.

> Snapshot: 2026-08-25 09:40 UTC. Reconciled against exact public
> `origin/main@cde116` after the archive split. This file holds the **active** set only;
> completed entries live in `TASKS-DONE.md`. Active counts: **32 nonterminal** and **1 terminal not yet archived**.
> See the Open work queue below; regenerate it rather than hand-editing the counts.

## Safety boundary

This file is intended for a public repository. Never add credentials, personal
contact data, relay or provider message identifiers, agent session identifiers,
local absolute paths, private evidence locations, or private handoff IDs. Use a
model/role label for custody, a repository branch/ref, and Git object IDs.
Workspace paths and transport receipts stay in the private coordination ledger.

## Root documentation map

- `TASKS.md` — canonical delivery/task state and crash recovery. Active work only.
- `TASKS-DONE.md` — completed entries archived out of `TASKS.md`, kept intact. IDs are
  unique across both files; look in both before concluding a task does not exist.
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

Every task uses every field below; use `—` rather than deleting a field. The one
exception is `Resume`, which records the state a `BLOCKED` entry may return to and
is required only there.

`scripts/check-tasks.mjs` (`npm run check:tasks`) enforces this schema across
`TASKS.md` and `TASKS-DONE.md`: exactly one of each field per heading, `Status` and
`Priority` inside the declared sets, and no id duplicated across the two files. It
carries a baseline of violations that predate it — the gate fails on anything new,
and `scripts/check-tasks-baseline.json` must only ever shrink.

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
disambiguates. Entries move intact to **Archive** after `DONE` or `ABANDONED`;
they are never deleted.

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

## Open work queue

**This file holds only what is in progress or still to do — 39 entries.** Completed work is archived in [TASKS-DONE.md](TASKS-DONE.md) at triage; **merged is done** (Paul, 2026-08-28), so nothing sits in a terminal state here. Most urgent first (regenerated 2026-08-28). The entry itself is always the authority; where it disagrees with this table, the entry wins.

Regenerate after any status change (this exact command reproduces the table below):

```sh
awk '/^## \[CAP-FB/{h=$0; sub(/^## \[/,"",h); id=h; sub(/\].*/,"",id); t=h; sub(/^[^]]*\] */,"",t)} /^- Status:/{s=$3} /^- Priority:/{if(s!="DONE"&&s!="MERGED"&&s!="ABANDONED"&&id!~/YYYYMMDD/) printf "%-3s %-10s %s — %s\n",$3,s,id,t}' TASKS.md | sort
```

| Priority | Status | Task | What it is |
|---|---|---|---|
| P0 | IN_REVIEW | [`CAP-FB-20260829-WEBMCP-INJECTION-01`](#cap-fb-20260829-webmcp-injection-01-find-site-tools-cannot-select-or-inject-a-new-webmcp-page) | Find site tools cannot select or inject a new WebMCP page |
| P0 | DONE | [`CAP-FB-20260829-MAIN-GATES-RED-03`](#cap-fb-20260829-main-gates-red-03-the-journey-suite-is-red-on-main-49-checks-still-assert-the-pre-p0-all-optional-permission-model) | Journey suite red on main — 49 checks assert the pre-P0 permission model |
| P1 | IN_REVIEW | [`CAP-FB-20260829-AGENT-BOARD-01`](#cap-fb-20260829-agent-board-01-the-shared-jobs-board-agents-post-and-claim-work) | The shared jobs board — agents post and claim work |
| P0 | OPEN | [`CAP-FB-20260821-WORKTREE-HYGIENE-01`](#cap-fb-20260821-worktree-hygiene-01-durable-worktrees-and-evidence-off-the-ram-backed-temp-filesystem) | Durable worktrees and evidence off the RAM-backed temp filesystem |
| P0 | OPEN | [`CAP-FB-20260827-HUB-FIRST-RUN-01`](#cap-fb-20260827-hub-first-run-01-the-first-screen-is-an-onboarding-wall-not-a-command-center) | The first screen is an onboarding wall, not a command center |
| P0 | OPEN | [`CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01`](#cap-fb-20260827-tool-call-legibility-01-tool-call-cards-show-shape-not-answers) | Tool-call cards show shape, not answers |
| P0 | DONE | [`CAP-FB-20260828-NOUN-DISCIPLINE-01`](#cap-fb-20260828-noun-discipline-01-one-name-per-concept--assetsartifacts-skillsrecipes-agents-three-deep) | One name per concept — Assets/Artifacts, Skills/recipes, Agents three deep |
| P1 | **BLOCKED** | [`CAP-FB-20260819-PROACTIVE-TAB-DISCOVERY-01`](#cap-fb-20260819-proactive-tab-discovery-01-proactive-per-tab-site-agent-discovery-before-run) | Proactive per-tab Site Agent discovery before Run |
| P3 | OPEN | [`CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01`](#cap-fb-20260829-provider-set-no-baseurl-01-saving-a-preset-provider-without-a-base-url-yields-a-config-that-can-never-run) | Saving a preset provider without a base URL yields a config that can never run |
| P1 | DONE | [`CAP-FB-20260829-FIXED-DEBUG-PORTS-01`](#cap-fb-20260829-fixed-debug-ports-01-nine-harnesses-hard-code-a-debug-port-so-a-kat-can-report-green-against-the-wrong-browser) | Nine harnesses hard-code a debug port and can pass against the wrong browser |
| P1 | OPEN | [`CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01`](#cap-fb-20260819-directory-tool-explorer-01-agent-directory-tool-explorer-and-enrollment-policy) | Agent Directory tool explorer and enrollment policy |
| P1 | OPEN | [`CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`](#cap-fb-20260819-permission-remediation-ux-01-user-facing-permission-management-and-run-remediation) | User-facing permission management and run remediation |
| P1 | OPEN | [`CAP-FB-20260819-UI-FLASH-RELAYOUT-01`](#cap-fb-20260819-ui-flash-relayout-01-intermittent-extension-wide-ui-flash-and-relayout-investigation) | Intermittent extension-wide UI flash and relayout investigation |
| P1 | OPEN | [`CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01`](#cap-fb-20260820-semantic-tool-search-01-local-semantic-search-over-the-complete-tool-catalog) | Local semantic search over the complete tool catalog |
| P1 | OPEN | [`CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01`](#cap-fb-20260823-extended-tool-families-01-extended-unixsystem-tool-family-admissions) | Extended Unix/system tool family admissions |
| P1 | OPEN | [`CAP-FB-20260823-PYODIDE-PYTHON-01`](#cap-fb-20260823-pyodide-python-01-python-in-the-browser-via-pyodide) | Python in the browser via Pyodide |
| P1 | OPEN | [`CAP-FB-20260825-DATA-EXPORT-IMPORT-01`](#cap-fb-20260825-data-export-import-01-owner-export-and-import-of-all-agent-data) | Owner export and import of all agent data |
| P1 | OPEN | [`CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01`](#cap-fb-20260825-headed-acceptance-lane-01-a-headed-browser-acceptance-lane) | A headed-browser acceptance lane |
| P1 | OPEN | [`CAP-FB-20260825-OWNER-DECISION-QUEUE-01`](#cap-fb-20260825-owner-decision-queue-01-product-decisions-blocking-tracked-work) | Product decisions blocking tracked work |
| P1 | OPEN | [`CAP-FB-20260825-SITE-AGENT-SHOWCASE-01`](#cap-fb-20260825-site-agent-showcase-01-make-sites-as-sub-agents-demonstrable-in-under-a-minute) | Make sites-as-sub-agents demonstrable in under a minute |
| P1 | OPEN | [`CAP-FB-20260825-UI-INTEGRATION-RED-01`](#cap-fb-20260825-ui-integration-red-01-scriptsui-integrationts-is-red-and-never-finishes) | scripts/ui-integration.ts is red and never finishes |
| P1 | OPEN | [`CAP-FB-20260825-WEBSTORE-RELEASE-01`](#cap-fb-20260825-webstore-release-01-the-path-to-a-published-extension) | The path to a published extension |
| P1 | IN_REVIEW | [`CAP-FB-20260827-DIALOG-CONSOLIDATION-01`](#cap-fb-20260827-dialog-consolidation-01-five-dialog-implementations-three-hand-rolled) | Five dialog implementations, three hand-rolled |
| P1 | OPEN | [`CAP-FB-20260827-SETTINGS-MONOLITH-01`](#cap-fb-20260827-settings-monolith-01-settings-is-one-88-screen-scroll-with-a-nav-that-only-scrolls) | Settings is one 8.8-screen scroll with a nav that only scrolls |
| P1 | OPEN | [`CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01`](#cap-fb-20260828-artifact-library-capacity-01-the-library-still-evicts-the-owners-oldest-artifact-silently) | The library still evicts the owner's oldest artifact silently |
| P1 | OPEN | [`CAP-FB-20260828-HUB-AS-TIMELINE-01`](#cap-fb-20260828-hub-as-timeline-01-the-hub-is-a-dashboard-it-should-be-a-composer-and-a-timeline) | The hub is a dashboard; it should be a composer and a timeline |
| P2 | **BLOCKED** | [`CAP-FB-20260822-MV3-WASM-RUNTIME-PROBE-01`](#cap-fb-20260822-mv3-wasm-runtime-probe-01-loaded-mv3-wasm-runtime-and-termination-probe) | Loaded-MV3 Wasm runtime and termination probe |
| P2 | **BLOCKED** | [`CAP-FB-20260822-OWNER-WASM-INSTALL-01`](#cap-fb-20260822-owner-wasm-install-01-owner-selected-wasm-package-lifecycle) | Owner-selected Wasm package lifecycle |
| P2 | OPEN | [`CAP-FB-20260822-BUILTIN-WASM-TOOLS-01`](#cap-fb-20260822-builtin-wasm-tools-01-provenance-clean-bundled-wasm-tool-tranche) | Provenance-clean bundled Wasm tool tranche |
| P2 | OPEN | [`CAP-FB-20260822-SPREADSHEET-TOOLKIT-01`](#cap-fb-20260822-spreadsheet-toolkit-01-bounded-spreadsheet-and-table-workflow-toolkit) | Bounded spreadsheet and table workflow toolkit |
| P2 | OPEN | [`CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01`](#cap-fb-20260822-tabular-diff-artifacts-01-read-only-tabular-diff-artifact-custody) | Read-only tabular-diff artifact custody |
| P2 | OPEN | [`CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01`](#cap-fb-20260822-tool-platform-abuse-gates-01-tool-platform-abuse-quota-and-lifecycle-gates) | Tool platform abuse, quota and lifecycle gates |
| P2 | OPEN | [`CAP-FB-20260822-WASM-TOOL-PLATFORM-01`](#cap-fb-20260822-wasm-tool-platform-01-co-do-style-browser-native-tool-operating-platform) | Co-do-style browser-native tool operating platform |
| P2 | OPEN | [`CAP-FB-20260825-CONCURRENCY-RESIDUALS-01`](#cap-fb-20260825-concurrency-residuals-01-close-the-four-open-concurrency-verifications) | Close the four open concurrency verifications |
| P2 | OPEN | [`CAP-FB-20260825-DELEGATE-ATTACHMENTS-PROGRESS-01`](#cap-fb-20260825-delegate-attachments-progress-01-site-agent-delegation-is-text-only) | Site-agent delegation is text-only |
| P2 | OPEN | [`CAP-FB-20260825-I18N-FOUNDATION-01`](#cap-fb-20260825-i18n-foundation-01-no-internationalisation-foundation) | No internationalisation foundation |
| P2 | OPEN | [`CAP-FB-20260828-DEAD-SURFACES-01`](#cap-fb-20260828-dead-surfaces-01-two-html-surfaces-ship-to-users-and-nothing-links-to-them) | Two HTML surfaces ship to users and nothing links to them |
| P2 | OPEN | [`CAP-FB-20260828-TOOL-LIBRARY-GROUPING-01`](#cap-fb-20260828-tool-library-grouping-01-group-tools-by-what-they-are-for-not-by-chrome-api) | Group tools by what they are for, not by Chrome API |
| P2 | OPEN | [`CAP-FB-20260828-VIEW-FRAME-COLLAPSE-01`](#cap-fb-20260828-view-frame-collapse-01-collapse-the-iframe-view-model-into-one-hub-document) | Collapse the iframe view model into one hub document |
| P3 | **BLOCKED** | [`CAP-FB-20260818-WIDER-REVIEW-01`](#cap-fb-20260818-wider-review-01-wider-goal-review-remediation-umbrella) | Wider-goal review remediation umbrella |
| P3 | OPEN | [`CAP-FB-20260821-RECIPES-SKILLS-RENAME-01`](#cap-fb-20260821-recipes-skills-rename-01-finish-the-recipes-to-skills-rename) | Finish the recipes to skills rename |
| P3 | OPEN | [`CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01`](#cap-fb-20260825-agent-picker-hub-rows-01-hub-agent-summary-rows-predate-the-shared-picker) | Hub agent summary rows predate the shared picker |
| P3 | OPEN | [`CAP-FB-20260827-DEAD-COMPONENTS-01`](#cap-fb-20260827-dead-components-01-components-ship-to-users-but-are-only-used-by-the-gallery) | Components ship to users but are only used by the gallery |

**The demo path is the only P0 lane (owner decision, 2026-08-27).** There were thirteen
P0s, seven of them the bundled-Wasm tool platform — a lane that is invisible in a demo and
largely blocked on owner licence/Store-policy decisions. The owner re-prioritised: the three
things an exec actually experiences are P0, the Wasm lane drops to **P2** until after the
demo, and permission-remediation and semantic tool search drop to **P1**. No scope,
acceptance or evidence changed on any of them — only ordering. The five remaining P0s are
`HUB-FIRST-RUN-01`, `TOOL-CALL-LEGIBILITY-01`, `THREAD-OPEN-SEQUENTIAL-READS-01`, the
in-review gate repair `MAIN-GATES-RED-02`, and `WORKTREE-HYGIENE-01` (which protects the
evidence every other task depends on).

**Held by a product decision, not by engineering:** `CAP-FB-20260822-OWNER-WASM-INSTALL-01` and `CAP-FB-20260822-BUILTIN-WASM-TOOLS-01` wait on open questions Q13 and Q14, and `CAP-FB-20260825-WEBSTORE-RELEASE-01` on Q11. All three are collected in `CAP-FB-20260825-OWNER-DECISION-QUEUE-01` — clearing that entry unblocks the most work for the least effort.


## Active

## [CAP-FB-20260829-WEBMCP-INJECTION-01] Find site tools cannot select or inject a new WebMCP page

- Feedback: 2026-08-29 — product owner reported that WebMCP content scripts no longer inject and the hub's Find site tools action does nothing
- Updated: 2026-08-29 20:45 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: implementation worker
- Workspace: active (local path private)
- Branch: `cap-webmcp-fix`
- Base: `54d70a9b`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: from a fresh profile, a real WebMCP page appears in the Find site tools picker before enrollment; choosing it injects both MAIN and ISOLATED scripts immediately, discovers its tools, and production invocation reaches the exact chosen tab; proactive discovery still excludes pages with no known tools
- Review: independent review required; pending
- Gates: production browser journey observed RED on the base (picker omitted the fixture) and GREEN after the fix (35/35); focused WebMCP tests 33/33; full unit suite 2358/0; developer build clean
- Blockers: —
- Next: commit the candidate, then send it for independent review
- Recover: `git show cap-webmcp-fix && deno run -A scripts/webmcp-acceptance.ts`
- History:
  - 2026-08-29 20:45 UTC — root cause reproduced in the production browser path: `agent.discoverable-tabs` required tools to exist in the registry before it offered a page, but the page could not report tools until selection enrolled it and injected the bridge. The unchanged base omitted the fixture and never executed either content script; the candidate separates explicit picker candidates from tools-only proactive discovery and passes all 35 production-path browser checks.

## [CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01] Extended Unix/system tool family admissions

- Feedback: 2026-08-23 — product owner requested common Unix and system tools
  as additional WASM admissions: awk, sed, jq, date as the common set;
  pandoc, tesseract, qpdf, pup, qsv, mlr, zq, htmlq, numbat, fend, xan,
  lychee, bttf, tokei as the complex set
- Updated: 2026-08-23 22:05 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `0fae090`
- Candidate: —
- Shipping: —
- Acceptance: each candidate gets the full admission pipeline — provenance
  and licence audit first (GPL-family tools need explicit policy disposition
  before any build), deterministic retained-build preflight under the safe
  build environment, import/memory census against the supported set, bounded
  immutable spec contract, and separate reviewed admission; jq is the
  frontrunner (selection already PASSed as jq_filter_bounded); no candidate
  ships without the five never-fabricate inputs
- Review: pending licence triage, then per-candidate independent reviews
- Gates: licence allowlist disposition per tool; build feasibility per tool;
  import/memory bounds per tool; serial admission ordering
- Blockers: licence triage must precede any GPL-family build work
- Next: run the licence/feasibility triage across all eighteen candidates
- Recover: `git grep -n "EXTENDED-TOOL-FAMILIES" -- TASKS.md`
- History:
  - 2026-08-29 08:30 UTC — bounded awk/date tranche candidate: clean-room
    preview-1 binaries admitted through immutable bundled manifests/CAS and the
    Settings-only `tool.preview.run` route. Awk documents literal matching with
    optional edge anchors; date rejects invalid and missing `-d` operands.
    Retained byte-identical rebuilds, provenance, notices, SBOMs, direct KATs,
    and loaded-extension browser evidence are included. This event makes no
    tokei or sed admission claim; the broader family task remains open.
  - 2026-08-27 01:11 UTC — RUST LANE STATUS: htmlq DONE (0.2.309-era, first
    lane proof), numbat DONE (runnable WASI calc), bttf DONE (direct CLI),
    tokei BLOCKED (native-only deps: memmap via grep-searcher, home via dirs,
    rayon runtime-panic — none of v12.1.2/v13/v14 build for wasip1; licence-clean;
    deferred pending dep patching or upstream change). xan BLOCKED (pager→errno@0.2.8 nightly-only thread_local on wasi; 0.59.0+0.60.0 verified; licence-clean; deferred). qsv BLOCKED (tikv-jemallocator default feature + native deps; 3 versions verified; licence-clean; deferred). RUST LANE COMPLETE: 3 landed (htmlq, numbat, bttf — all reviewed + verified-runnable) / 3 blocked (tokei, xan, qsv — native-dep class; all licence-clean; need dep patching or upstream changes). T3 TRIO: sed ADMITTED (minised 1.16 BSD-3, reproducible, ran) — in review; awk (onetrueawk, Lucent-permissive) + date (toybox 0BSD) honest STOP (build env). jq build honest STOP (no wasi-sdk 22.1.8 in env; upstream jq-1.8.2 pinned + MIT COPYING vendored hash-pinned). C-LANE UNBLOCK: the sed recipe (clang 22.1.8 + wasi-sysroot-22.0 + compiler-rt builtins) PROVEN by reproducing sed byte-identically — the earlier 'no wasi-sdk' stops were wrong; the real per-tool blockers are SOURCE-level: jq needs pthread/threads, awk needs setjmp/fork emulation, date needs toybox build-system integration — all join the patch-or-defer set (same disposition decision as tokei/xan/qsv). OWNER DECISION (2026-08-27): PATCH — maintain patched forks to get all six in. Tranche 1 (easy): qsv drop-jemallocator-default, xan errno-0.3 bump via pager patch, jq single-threaded; Tranche 2 (deep): tokei (memmap→in-memory reads, home shim, rayon serial), awk (setjmp/fork emulation), date (toybox build integration). Each patched fork: pinned commit + provenance + licence audit + full admission pipeline.
  - 2026-08-26 23:22 UTC — OWNER DECISION (option a): APPROVED the permissive
    routes — toybox 0BSD for the awk/sed/date trio, onetrueawk, NetBSD-style
    sed, and the fend pre-1.4.0 MIT pin. T3 unblocks on those routes. PANDOC
    REMAINS BLOCKED (GPLv2+ has no permissive route; ~58MB wasm large-tier).
    lychee = offline-file mode only. zq/zed = frozen provenance, admittable.
    TIER 1 DISPATCHED: jq admission (NOTICES + retained build + census + spec
    contract) + the Rust one-lane standup (htmlq first as lane proof, then
    numbat, bttf, tokei, xan, qsv serially).
  - 2026-08-26 23:15 UTC — LICENCE/FEASIBILITY TRIAGE DONE (read-only research,
    /tmp/cap-extended-tool-families-research/GLM.md da8f7f2c): 18/18 candidates
    inventoried. GPL-family blockers (5 candidates, ONE owner decision unblocks):
    pandoc GPLv2+ (+~58MB wasm large-tier), fend GPL-3.0+ since v1.4.0 (pin
    pre-1.4.0 MIT as escape hatch), awk/sed/date (GNU/busybox GPL — permissive
    routes: toybox 0BSD, onetrueawk, NetBSD-style sed, or the house clean-room C
    pattern a2/b2). Feasibility: lychee network-bound (offline-file mode only),
    zq/zed upstream ARCHIVED (frozen provenance), tesseract needs a traineddata
    asset class, jq needs NOTICES for decNumber ICU + Heimdal-derived code.
    TIER PLAN: T1 = jq + 6 Rust one-lane wins (htmlq, numbat, bttf, tokei, xan,
    qsv) — 7 admissions for 2 toolchain investments; T2 = qpdf, tesseract,
    pup/mlr/zq (Go wasip1 lane); T3 = the 6 decision-blocked. NEXT: owner
    decision on the GPL/permissive routes unblocks T3; T1 is actionable without
    it. No admission claims made.
  - 2026-08-23 22:05 UTC — captured from direct product-owner feedback.

## [CAP-FB-20260823-PYODIDE-PYTHON-01] Python in the browser via Pyodide

- Feedback: 2026-08-23 — product owner wants to run Python in the browser,
  possibly via Pyodide
- Updated: 2026-08-23 22:05 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `0fae090`
- Candidate: —
- Shipping: Lane A contract slice `origin/main@5e623a526aafb80a77e2c527ceddf5a5425a8d7a` (0.2.235); Lane B real interpreter + tool-surface wiring deferred (browser-gated)
- Acceptance: a feasibility decision with evidence — Pyodide (or alternative)
  core size and memory footprint measured against the extension's budget,
  CSP/wasm interaction verified in loaded MV3, licence disposition (Pyodide
  MPL-2.0 + CPython PSF), OPFS persistence model for the runtime and
  packages, sandboxing boundary versus the existing fresh-Worker host, and a
  minimum viable slice definition if feasible
- Review: pending independent architecture/licence/security review of the
  feasibility report
- Gates: measured size/memory; licence allowlist disposition; CSP probe;
  OPFS model; isolation boundary analysis
- Blockers: —
- Next: owner decision on pursuing the MVS — resolve the four caveats:
  default-tier admission (+ memory evidence gate), a bounded-memory Pyodide
  build (stock 4 GB MAXIMUM_MEMORY exceeds every tier), the PSF-2.0 allowlist
  line, and the top-level-only CSP constraint
- Recover: `git grep -n "PYODIDE" -- TASKS.md`
- History:
  - 2026-08-26 23:25 UTC — OWNER DECISION: OPTION A — approve the Pyodide MVS
    with the four resolutions (default-tier admission + memory-evidence gate;
    bounded MAXIMUM_MEMORY≤2048-page build; the one reviewed PSF-2.0 licence
    line; top-level-only non-eval PyProxy entrypoint). DISPATCHED: pinned tag +
    bounded build → default-tier runtime via the existing authority,
    content-addressed OPFS cache, ONE python stdin/stdout tool (≤2KiB in,
    ≤64KiB out, top-level-only, existing termination fence), separate Emscripten
    dispatcher profile, WASI host NOT widened, zero manifest/key/network change.
  - 2026-08-26 23:23 UTC — OWNER-DECISION PACKET (read-only,
    /tmp/cap-pyodide-decision/GLM.md a6c2ebaa): all 4 caveats verified against
    committed source (default-tier 16MiB fits Pyodide core 8.4-12.3MB; bounded
    MAXIMUM_MEMORY≤2048-page build required; PSF-2.0 needs one reviewed licence
    line; CSP fine via the non-eval PyProxy entrypoint). OPTIONS: A approve MVS
    with the 4 resolutions (recommended: +8-12MB OPFS-cached runtime, one
    python stdin/stdout tool, zero manifest/key changes) / B defer to the
    26-tool + Rust/Go lanes / C MicroPython-RustPython / D network service.
    NEXT: owner decision A/B/C/D.
  - 2026-08-23 22:45 UTC — feasibility research verdict FEASIBLE-WITH-CAVEATS
    (Pro, /tmp/cap-pyodide-feasibility/PRO.md 869b8098): core 8–12 MB fits a
    NEW default-tier admission (not tiny); MPL-2.0 in allowlist, CPython
    PSF-2.0 needs a one-line addition; CSP already has wasm-unsafe-eval so the
    core loads but eval/exec must be top-level-only; OPFS content-addressed
    cache + per-job scratch; separate Emscripten dispatcher profile (no WASI
    host widening); MVS = a stdin/stdout python tool over the cached core
    reusing package authority.
  - 2026-08-23 22:05 UTC — captured from direct product-owner feedback.




## [CAP-FB-20260818-WIDER-REVIEW-01] Wider-goal review remediation umbrella
- Feedback: 2026-08-18 — recovered independent review found omitted security, concurrency, bounds, and accessibility work
- Updated: 2026-08-22 07:30 UTC
- Status: BLOCKED
- Resume: OPEN
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
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `BLOCKED` mapped to `BLOCKED` (unchanged semantics).
  - 2026-08-18 20:15 UTC — recovered omitted review report and mapped findings.
  - 2026-08-19 00:10 UTC — umbrella blocked on independent remediation lanes.

## [CAP-FB-20260819-PROACTIVE-TAB-DISCOVERY-01] Proactive per-tab Site Agent discovery before Run
- Feedback: 2026-08-19 — before Run, the product should show what a selected tab is likely or verified to offer instead of waiting for a blind execution attempt
- Updated: 2026-08-22 07:30 UTC
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
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `BLOCKED` mapped to `BLOCKED` (unchanged semantics).
  - 2026-08-19 18:13 UTC — captured in BLOCKED state because origin-only identity and permission semantics cannot safely support proactive per-tab claims yet.


## [CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01] Agent Directory tool explorer and enrollment policy
- Feedback: 2026-08-19 — Directory feedback requested a page-aware tool explorer and raised, without resolving, the product boundary between enrolling an agent and approving individual tool use
- Updated: 2026-08-22 07:30 UTC
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
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-19 18:15 UTC — opened in research-first state and cross-linked to `CAP-FB-20260819-AGENT-DIRECTORY-01`; uncertainty was recorded as an unresolved policy question, not approval.

## [CAP-FB-20260819-UI-FLASH-RELAYOUT-01] Intermittent extension-wide UI flash and relayout investigation
- Feedback: 2026-08-19 — intermittent whole-interface flashes or relayouts are visible across the NTP and extension pages without a confirmed trigger or root cause
- Updated: 2026-08-22 07:30 UTC
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
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-19 18:15 UTC — captured as a research-first extension-wide investigation; no single rendering subsystem or fix is assumed without trace evidence.

## [CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01] User-facing permission management and run remediation
- Feedback: 2026-08-19 — permission failures need truthful owner-facing diagnosis, least-privilege remediation, and deterministic run continuation rather than vague missing-permission messages
- Updated: 2026-08-22 07:30 UTC
- Status: OPEN
- Resume: —
- Priority: P1
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
- Next: design the owner-only inbox + paused-run resume state machine from `docs/permission-remediation-design.md` under the settled policy — grants remembered at the narrowest practical scope, no per-invocation prompts, explicit broad host grant allowed and revocable; recoverable permission problems pause visibly and resume after resolution
- Recover: `git show bbeff7b:TASKS.md && git grep -n "permissions.request\|optional_permissions\|all_urls" bbeff7b -- extension`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - Git reconcile at 2026-08-22 07:50 UTC: the agent/task permission policy layer is settled per the recorded project history — see the durable interruption/permissions policy (auto-resume on restart, visible pause + resume for recoverable permission problems, terminal explicit cancellation, narrowest-scope remembered grants, no per-invocation prompts, explicit broad host grant allowed and revocable).
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-19 19:40 UTC — fourth docs-review correction applied: the source-map intro is now the bounded "known user-visible sources observed during this review; not formal/exhaustive" wording, and the duplicate row-15 numbering is fixed.
  - 2026-08-19 19:37 UTC — third docs-review correction applied: added the shared/components.js:4548 role=status storage-permission source to the map and removed the prior History "corrected/completed" wording (no premature complete-map claim).
  - 2026-08-19 19:30 UTC — second docs-review corrections applied: the paused-run state machine now stops at the neutral `GRANTED_WAITING_RESUME_POLICY` state and branches BOTH open resume alternatives (no unconditional grant→RUNNING); the source map adds the conversation.js:395-449 inline retry + error-report.js:44-45 generic permission presentation and corrects the early provider gate to service-worker.js:1195-1203 + provider-gate.js:115-131; History no longer claims a complete map.
  - 2026-08-19 18:40 UTC — docs review BLOCK corrections applied: auto-resume vs explicit Resume left as two OPEN alternatives (neither normative); the source map corrected (global/origins scope labels, activeTab-or-tabs, injectScriptsIntoOpenTabs, scheduler/enrollment/options/ntp/components sources); activeTab is a target-tab invocation journey (not a Settings button); exact-origin is the minimum persistent host grant with narrowing in the policy layer only; <all_urls> is not declared and not a current choice; the Permissions lane is labeled an unshipped candidate; multi-run ordering and distinct DENIED vs CANCELLED defined; Updated timestamp reconciled.
  - 2026-08-19 18:40 UTC — public-safe research/design report added as `docs/permission-remediation-design.md` (maps the 12 missing-permission/error sources + Settings surfaces, separates Chrome optional/site state from agent/task policy, and designs the owner-only inbox, the paused-run resume state machine, deny/cancel/revoke/retry, the threat model, and loaded-MV3 fixtures). Auto-resume and one-shot JIT continuation remain explicitly unapproved.
  - 2026-08-19 18:17 UTC — opened as a distinct Settings and run-remediation UX task; the existing orchestration candidate remains linked and is not treated as user-facing acceptance.


## [CAP-FB-20260822-WASM-TOOL-PLATFORM-01] Co-do-style browser-native tool operating platform

- Feedback: 2026-08-22 — product owner elevated a Co-do-style Wasm/tool
  operating layer with lazy discovery, owner authority, provenance, OPFS
  workspaces and artifact outputs to P0
- Updated: 2026-08-22 09:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: tool-platform program coordinator
- Workspace: none
- Branch: none
- Base: `30afd5acc85597a3c23c6addbbb76e191c6435c8`
- Candidate: —
- Shipping: —
- Acceptance: the complete program delivers a metadata-first unified catalog,
  bounded lazy provider protocol, loaded-MV3-proven fresh-Worker Wasm host,
  artifact-grade package/provenance/revocation authority, isolated OPFS job
  workspaces, provenance-clean bundled tools, code-diff artifacts, Chrome API
  lazy discovery, owner-facing Tool Library, policy-separated owner install,
  spreadsheet/data workflows and continuous abuse gates without weakening
  existing owner grants, source dispatch, optional permissions,
  run/origin/agent/document/generation fences or replay safety
- Review: independent architecture/security/replay/privacy/Store-policy review
  at each dependency boundary plus different-session source and exact loaded-MV3
  review for every executable or UI slice
- Gates: all 13 split tasks below satisfy their own gates in dependency order;
  exact merged tip passes full unit/security/canonical Chrome, provider
  nondisclosure, source revocation, credential/network capture, Store/RHC scan
  and provenance/licence review
- Blockers: owner-selected Wasm in a Chrome Web Store build remains blocked on
  written remotely hosted code policy; Co-do's Apache-2.0 root versus MIT
  package/generated-manifest metadata and per-binary provenance are unresolved;
  runtime/resource numbers require loaded-MV3 measurements
- Next: independently review and land the shadow catalog contract, then run the
  MV3 runtime probe and lazy-protocol provider-capture work without enabling
  execution or owner installs
- Recover:
  `git grep -n "CAP-FB-20260822-.*TOOL\|CAP-FB-20260822-.*WASM\|CAP-FB-20260822-.*OPFS\|CAP-FB-20260822-.*SPREADSHEET" -- TASKS.md docs/tool-platform-architecture.md`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 09:30 UTC — opened the P0 master program from source research
    pinned to [PaulKinlan/Co-do](https://github.com/PaulKinlan/Co-do) commit
    `d3ebdbd5066f16a2bb8a2b8cb8af4b57c8ae324a`: exactly 39 factual built-ins
    grouped as text 12, crypto 6, data 6, file 6, code 5,
    search/compression/database/media 1 each. No Co-do code or binary is
    accepted by this record.

## [CAP-FB-20260822-MV3-WASM-RUNTIME-PROBE-01] Loaded-MV3 Wasm runtime and termination probe

- Feedback: 2026-08-22 — Wasm CSP, nested Worker, offscreen, OPFS, import and
  termination behavior must be measured in the shipped extension before choosing
  an ABI or host
- Updated: 2026-08-22 10:16 UTC
- Status: BLOCKED
- Resume: IN_REVIEW
- Priority: P2
- Owner: unassigned
- Workspace: active (local path private)
- Branch: `feat/mv3-wasm-runtime-probe-30afd5a`
- Base: `30afd5acc85597a3c23c6addbbb76e191c6435c8`
- Candidate: `cab69d262590d394dd5994b7cbfaf60ba320686e`
- Shipping: —
- Acceptance: an isolated loaded-MV3 experiment proves or rejects bundled Wasm
  compilation under shipped CSP, offscreen-hosted fresh dedicated Workers,
  Worker termination of an infinite loop, declared memory maxima, import
  inspection, OPFS access strategy, service-worker/offscreen interruption and
  zero main-thread fallback without changing production grants or installing
  packages
- Review: independent MV3/CSP/isolation/resource/cleanup review of the immutable
  probe and evidence required
- Gates: source/self-test candidate 19/19; exact bundled fixture hashes;
  permitted/forbidden import matrix; infinite-loop deadline; memory
  growth/compile bomb; Worker/offscreen/service-worker termination; OPFS
  read/write isolation; console/CSP/network capture; no surviving Worker/profile;
  canonical Chrome only under the serialized lock. `npm run test:security` is
  DEFERRED because it launches unsynchronized Chromium; one prior unlocked
  invocation is INVALID noncanonical evidence, not a product result
- Blockers: the reviewed serialized run reached the loaded extension but the
  driver sent `runtime.sendMessage` from the service worker to itself; Chrome
  does not deliver that message back to the same worker listener, so the first
  response was empty and all Wasm/isolation/OPFS rows were HARNESS failures.
  The driver also lacks fail-fast/failed-run receipts, accepts restart
  classification without a responsive replacement worker, misnames its JSON
  hash manifest `.sha256`, and removes `run-init.json` on non-zero completion.
  No Wasm runtime product result was observed
- Next: parked. A successor must directly invoke the registered test route in
  the service-worker context, fail fast with a durable receipt, require a
  rotated and responsive replacement for restart PASS, retain failed-run init
  evidence, and pass a new independent source/custody review before one newly
  authorized serialized run
- Recover:
  `git grep -n "MV3-WASM-RUNTIME-PROBE\|wasm-unsafe-eval\|OFFSCREEN_DOCUMENT\|Worker" -- TASKS.md docs extension tests scripts`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 09:30 UTC — opened as the second owner-decision-free technical
    proof; Co-do's Worker/main-thread behavior is precedent only and cannot
    substitute for loaded-MV3 evidence.
  - 2026-08-22 10:16 UTC — candidate `cab69d2` passed final source/custody review;
    its sole authorized run recorded 1 PASS / 9 FAIL with screenshot, AX,
    redacted telemetry and valid hashes. Independent review classified the
    failures as HARNESS plus minor EVIDENCE defects, not Wasm product failures,
    because the driver self-messaged the service worker and never reached the
    registered runtime route. The candidate is parked; no retry or shipping.

## [CAP-FB-20260822-BUILTIN-WASM-TOOLS-01] Provenance-clean bundled Wasm tool tranche

- Feedback: 2026-08-22 — the operating layer needs useful bundled tools,
  beginning with filesystem/text/data essentials rather than arbitrary uploads
- Updated: 2026-08-22 09:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `30afd5acc85597a3c23c6addbbb76e191c6435c8`
- Candidate: —
- Shipping: —
- Acceptance: each admitted bundled binary has pinned source, digest,
  licence/notices, SBOM, reproducible build where practical, declared
  capabilities/resources/replay class and compatibility tests; Tranche A covers
  gzip/archive, grep/search/replace, stat/tree/du/hash, diff/patch,
  CSV/JSON/TOML/YAML, sort/uniq/join/cut/head/tail and selected formatters
  without weakening global quotas
- Review: independent per-binary provenance/licence/build/security/compatibility
  review and loaded-MV3 execution evidence required
- Gates: deterministic build/digest; licence/notices/SBOM; known-answer and
  hostile input fixtures per tool; quota profiles; offline execution; no
  network/credential access; cross-tool pipeline bounds; low-memory-device tiers
- Blockers: depends on execution host and package provenance authority; Co-do
  binaries are not accepted inputs until its licence/provenance contradiction is
  resolved independently
- Next: select one provenance-clean bundled gzip source only after the runtime
  host passes, then expand by reviewed functional tranche
- Recover:
  `git grep -n "BUILTIN-WASM-TOOLS\|gzip\|SBOM\|Tranche A" -- TASKS.md docs extension tests`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-23 23:15 UTC — durable evidence migration LANDED (0.2.198, tip
    4bd429b): in-repo evidence tree is the sole generator root — full verify
    works on any fresh checkout with zero /tmp dependency; total scrub of
    /tmp and absolute build-host paths from all shipped bytes (owner
    directive); repair commits restored the gitignored d3/sqlite3 dist
    binaries and the dist marker.
  - 2026-08-24 17:45 UTC — R12 sqlite3_query_bounded admission LANDED as
    0.2.228 (origin/main@5161c6963e0ea6e2321dffb375041f7ae588cd24): the 26th
    enabled tool — 26/0 posture, ALL 26 bundled Wasm tools enabled. Browser
    gate PASS (sqlite preview runs SELECT 1 in a real browser). SQLite WASI
    train COMPLETE.
  - 2026-08-24 16:00 UTC — the full sqlite WASI runtime LANDED as 0.2.227
    (origin/main@4c6cca287d87d20fa12a69a128a84403bb3cdbb8): the S2 scratch
    directory foundation + R3 lookup-follow + R4 FILE-follow + R5 resize +
    R6 timestamps + R10 alias/open profiles + R10c rights constants + R11
    six imports (fd_sync, mkdir, rmdir, unlink, readlink stub, poll stub);
    SUPPORTED 20→28; sqlite3 admission (R12) is the last step to 26/26.
  - 2026-08-24 13:20 UTC — the R3-R6 runtime train LANDED as 0.2.216
    (origin/main@8c91093ecb802659522f89c063933e6a979be2f0): lookup-follow,
    FILE dirflags, bounded resize, explicit timestamps; SUPPORTED 20→22;
    touch/truncate/sqlite3 admissions remain next per the plan.
  - 2026-08-23 22:00 UTC — build integrity landed as 0.2.191 (45ca99f):
    `npm run build` runs the package generator in verify mode by default
    (fail-closed zero-drift over all 80 generated outputs) with full
    regeneration only behind explicit --regen-tools; 1265/1265 full suite;
    rebase conflict resolution dogfooded byte-exact (regen left zero diff).
  - 2026-08-22 09:30 UTC — factual Co-do inventory recorded as 39 tools across
    nine functional categories; it is a prioritization precedent, not a binary
    source.

## [CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01] Read-only tabular-diff artifact custody

- Feedback: 2026-08-22 — retain a complete bounded semantic table comparison
  without giving descriptive rows code-patch or workspace-mutation authority
- Updated: 2026-08-22 18:48 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: retained tabular-diff source owner
- Workspace: active (local path private)
- Branch: `feat/tabular-diff-artifacts-462d21d`
- Base: `462d21d8da9bee640c2c12088dcafba6123e00fc`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: one import-free pure core fatally decodes and strictly validates
  complete canonical `cap-tabular-diff-v1` bytes, duplicate/escaped-equivalent
  keys, exact schema/row/cell/count/order semantics and semantic/options/source
  receipts; operation identity binds bundled package/tool/executable/capability/
  replay and full workspace/call/input fences; deterministic 180-KiB opaque byte
  chunks retain at most one MiB through a separate manifest schema/media and only
  injected keyed create/read authority; all chunks are immediately read back,
  reassembled and revalidated before the manifest is written last; retries are
  keyed and idempotent; capacity failure reports the missing aggregate
  reservation/refcount/orphan-GC policy without deleting or evicting anything;
  bounded summary/schema/row/cell previews are inert non-authoritative data;
  apply/reject/undo/patched-CSV export refuse before input access
- Review: integration design independently PASSed; exact source candidate review
  pending
- Gates: focused canonical K-BASE/O-BASE, Unicode/chunk/content boundaries through
  exact one MiB, identity mutants, hostile proxies/accessors, manifest-last,
  readback corruption/missing/reordered chunks, retry/interruption/capacity orphan
  accounting, preview control/formula/scalar-safe truncation, no-truncation and
  static no-route/no-OPFS/no-code-diff/no-mutation import graph; exact source
  candidate passed focused 12/12, full no-Chrome 1041/1041 across 14 steps and
  the 112-file production-JS build with zero bundled Wasm binaries
- Blockers: existing asset API has no grouped capacity reservation, refcount or
  orphan collector, so this adapter remains unreachable; any route/runtime/UI,
  artifact access-control acceptance, grouped promotion/GC or table mutation is
  a separately reviewed successor
- Next: commit the narrow source candidate and obtain independent exact-diff
  schema/identity/chunk/quota/no-authority review
- Recover:
  `git show feat/tabular-diff-artifacts-462d21d -- extension/lib/tabular-diff-artifacts-core.js extension/lib/tabular-diff-artifacts.js tests/tabular-diff-artifacts.test.ts docs/tool-platform-architecture.md TASKS.md`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 18:48 UTC — implemented only the PASSed source design on exact
    public `462d21d`; no route, Chrome run, execution, UI or mutation was added.

## [CAP-FB-20260822-OWNER-WASM-INSTALL-01] Owner-selected Wasm package lifecycle

- Feedback: 2026-08-22 — the long-term platform should let owners install
  reviewed local packages without making installation model-callable or silently
  broadening authority
- Updated: 2026-08-22 20:12 UTC
- Status: BLOCKED
- Resume: OPEN
- Priority: P2
- Owner: distribution-policy owner
- Workspace: active (local path private)
- Branch: `feat/store-boundary-recompose-093757f`
- Base: `093757fea4bee236f6b9038789ad4a67bd1f3b7a`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: an explicit owner-selected file enters staged validation,
  provenance/signature/licence/SBOM and capability/version diff review, then
  atomic install/update/revoke; grants key exact immutable
  package/tool/version/executable/capability identity and never survive relevant
  change; model/page cannot install, update, trust a signer or grant capability
- Review: independent Store/RHC legal-policy, supply-chain, owner-gesture,
  package transaction, grant, accessibility and loaded-MV3 review required
- Gates: credential-free Store precursor requires marker-v2 exact target,
  legacy/cross-target refusal, exact CSP, tracked/generated scanner, empty Worker
  allowlist, zero unmanifested Wasm and exact archive parity; owner cancel/deny,
  malformed/archive-bomb/substitution/signature/revocation/update, grant
  invalidation, concurrent install, crash recovery, offline restart, no
  network/provider credentials, written RHC decision and owner-package-specific
  packaging remain separate
- Blockers: Chrome Web Store execution of owner-uploaded/downloaded Wasm
  requires written policy clearance; until then this is limited to a separately
  packaged unpacked/enterprise/developer lane and Store mode remains
  bundled-only
- Next: obtain the distribution-policy determination after package authority and
  Tool Library review; do not add owner execution to the Store build meanwhile
- Recover:
  `git grep -n "OWNER-WASM-INSTALL\|owner-selected\|remotely hosted code\|Store lane" -- TASKS.md docs extension tests`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 09:30 UTC — intentionally BLOCKED at the distribution boundary;
    digests, signatures and an owner click are not treated as automatic
    Store-policy clearance.
  - 2026-08-22 20:12 UTC — added only the credential-free Store package/static
    precursor over exact public `0.2.157`: target intent and scanner evidence do
    not clear written-policy, owner gesture, signer, install or execution gates.

## [CAP-FB-20260822-SPREADSHEET-TOOLKIT-01] Bounded spreadsheet and table workflow toolkit

- Feedback: 2026-08-22 — the P0 operating layer should support knowledge-work
  table filtering, joins, grouping, pivots, formulas and useful artifact
  previews
- Updated: 2026-08-22 09:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `30afd5acc85597a3c23c6addbbb76e191c6435c8`
- Candidate: —
- Shipping: —
- Acceptance: provenance-clean bundled tools perform bounded CSV/table filter,
  join, group, aggregate, pivot and explicit-range formula evaluation; schemas
  preserve data types and locale choices; large/full data remains local while
  provider receives bounded summaries; previews and outputs are artifact-backed,
  inspectable and reversible
- Review: independent numerical/data correctness, formula safety,
  locale/encoding, quota, privacy, artifact and accessible grid review required
- Gates: golden CSV/TSV/Unicode/quoted/missing/type fixtures;
  joins/group/pivot/formulas; row/column/cell/byte ceilings; hostile formulas;
  low-memory/offline runs; provider capture; artifact preview screenshots and AX
  grid semantics
- Blockers: depends on bundled tool host and artifact UI; no spreadsheet engine
  or formula language is selected yet
- Next: define representative knowledge-work fixtures and error budgets after
  the bundled execution tranche is accepted
- Recover:
  `git grep -n "SPREADSHEET-TOOLKIT\|pivot\|formula\|CSV" -- TASKS.md docs extension tests`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 09:30 UTC — opened as a later functional tranche; this catalog
    slice contains no spreadsheet runtime or UI.

## [CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01] Tool platform abuse, quota and lifecycle gates

- Feedback: 2026-08-22 — every tool-platform phase needs adversarial and
  exact-browser gates rather than a security pass deferred until the end
- Updated: 2026-08-22 09:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: security review coordinator
- Workspace: none
- Branch: none
- Base: `30afd5acc85597a3c23c6addbbb76e191c6435c8`
- Candidate: —
- Shipping: —
- Acceptance: a cumulative matrix covers catalog prompt
  injection/Unicode/collisions/bounds, package substitution/revocation/archive
  bombs/imports, infinite loops/compile bombs/memory/output/host calls, OPFS
  traversal/quota/locks/isolation, stale Worker responses, restart/replay
  classes, grant/permission races, credentials/network/privacy, provider
  nondisclosure, artifacts/diffs and Store/RHC rejection at every phase
- Review: independent red-team/security/privacy/replay/performance and
  loaded-MV3 review required continuously, not only at final release
- Gates: pure hostile fixtures plus serialized fresh-profile loaded-MV3 cases;
  exact source/build hashes; network and provider captures; no
  credentials/cookies/tokens; Worker/profile/OPFS cleanup; crash points;
  source/package/document/catalog revocation; canonical full
  unit/security/Chrome at each merged tip
- Blockers: evolves with every split task; arbitrary-package cases remain
  distribution-lane blocked until policy allows them
- Next: land catalog hostile-input and stale-reference tests as tranche one,
  then extend the matrix with each runtime/package/workspace slice
- Recover:
  `git grep -n "TOOL-PLATFORM-ABUSE-GATES\|hostile\|selection-source-stale\|RHC" -- TASKS.md docs extension tests`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 09:30 UTC — opened with the catalog slice's hostile metadata,
    Unicode, collision, bound, source-revocation, expiry and
    provider-nondisclosure tests as its first tranche.

## [CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01] Local semantic search over the complete tool catalog

- Feedback: 2026-08-20 — product-owner requested
  WebMCP-relay/Modern-Web-Guidance-style retrieval so the model receives only
  the most relevant tools instead of every available definition
- Updated: 2026-08-22 09:30 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: tool-platform research owner
- Workspace: none
- Branch: none
- Base: `ecf657fe2f9e32aee7b5e2043808f4f7978fd456`
- Candidate: —
- Shipping: —
- Acceptance: one local versioned catalog indexes every callable built-in tool,
  extension-provided tool, declared WebMCP tool and positively inferred WebMCP
  tool with stable source, scope, generation/document identity, bounded
  description, schema summary and searchable text; each run retrieves a bounded
  top-k set by semantic/cosine relevance plus deterministic exact-name/alias and
  lexical fallback, and only that authorized set is exposed to the model;
  retrieval never grants permission, bypasses source-specific dispatch, crosses
  origin/agent boundaries, revives removed tools, or lets untrusted tool text
  alter ranking policy or protected prompts; index updates, removals, extension
  upgrades, navigation, service-worker restart and offline startup converge
  without sending the whole catalog; owner diagnostics explain selected,
  excluded, stale and fallback results without exposing secrets or private data
- Review: P0 tool-platform research fixes this as the sole semantic-retrieval
  authority; the catalog contract's deterministic exact/alias/lexical fallback
  is a prerequisite, not a duplicate semantic engine; independent architecture,
  retrieval-quality, security/privacy, lifecycle, performance and exact
  loaded-MV3 review required before semantic implementation acceptance
- Gates: compare SQLite/Wasm and IndexedDB storage/indexing under MV3 CSP,
  worker lifetime, migration, quota and crash semantics; compare local embedding
  choices, dimensions, update cost and deterministic lexical fallback; build a
  versioned bounded corpus spanning all four tool sources with
  relevance/precision/recall and token-budget targets plus measured budgets for
  catalog-scale warm-query latency, cold/offline startup, full index build,
  incremental add/update/remove, persisted index bytes and peak memory;
  establish explicit device/corpus tiers and pass/fail budgets during research
  before implementation; exact-name, paraphrase, multi-intent, low-confidence,
  collision and no-match queries; adversarial
  descriptions/schema/prompt-injection and oversized/Unicode fixtures;
  source/generation/origin/permission fencing;
  add/update/remove/navigation/restart/offline/corruption recovery; loaded-MV3
  proof that only selected descriptors reach the provider while non-selected
  tools remain undisclosed and uncallable
- Blockers: embedding model/runtime, ranking thresholds/top-k/token budget,
  semantic storage engine (SQLite versus IndexedDB), device tiers, update
  authority, telemetry and embedding provenance remain OPEN; the lexical shadow
  slice selects none of them; the design must compose with
  `CAP-FB-20260822-TOOL-CATALOG-CONTRACT-01`,
  `CAP-FB-20260822-LAZY-TOOL-PROTOCOL-01`, `CAP-FB-20260818-WEBMCP-01`, page
  identity, canonical agent references and permission remediation
- Next: measure candidate local embedding/index implementations against the
  bounded canonical catalog and lexical baseline, then record the
  engine/storage/device-tier decision before adding semantic ranking
- Recover:
  `git show ecf657f:TASKS.md && git grep -n "toolSetForOrigin\|MANAGEMENT_TOOL\|browserTools\|webmcpExpose\|document.modelContext" ecf657f -- extension`
- History:
  - 2026-08-27 23:55 UTC — priority changed by owner decision: the demo path is the only P0 lane until the exec demo. This entry is not on the path an exec walks and is not blocked by anything on it; it resumes at its recorded priority afterwards. No scope, acceptance or evidence changed.
  - 2026-08-22 09:30 UTC — Paul elevated the Co-do-style tool operating platform
    and this existing semantic-retrieval task to P0. The ID remains
    authoritative and unique; the new catalog slice implements only the required
    deterministic lexical baseline and makes no embedding/SQLite choice.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN`
    (unchanged semantics).
  - 2026-08-20 15:21 UTC — opened as research-first semantic tool retrieval
    across built-in, extension, declared WebMCP and inferred WebMCP sources; no
    database, embedding model, threshold or runtime was inferred from the
    request.

## [CAP-FB-20260821-WORKTREE-HYGIENE-01] Durable worktrees and evidence off the RAM-backed temp filesystem
- Feedback: 2026-08-21 — independent architectural review found the build host's temporary filesystem at 100% inode use, which failed the unit suite, and found reviewed work and retained gate evidence stored only on tmpfs
- Updated: 2026-08-28 UTC
- Status: OPEN
- Resume: OPEN
- Note: the loss risk is CLOSED (every at-risk head is bound under a rescue tag); what remains is a cleanup decision that is the owner's to make
- Priority: P0
- Owner: coordinator session (audit + rescue binding); owner decision pending on removal
- Workspace: none
- Branch: none
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: —
- Shipping: —
- Acceptance: the build host's temporary filesystem reports headroom sufficient to run the full unit and Chrome journey suites without an `ENOSPC`/inode failure; no git worktree and no retained gate-evidence bundle referenced by any `Gates:` field in this tracker resides on a RAM-backed filesystem; every worktree HEAD is reachable from a branch or an explicit rescue tag before that worktree is removed; worktrees holding no commits beyond `origin/main` are removed and `git worktree prune` reports a clean list; a written convention records where worktrees and evidence live and is added to `AGENTS.md`
- Review: independent verification that no commit reachable only from a removed worktree was lost, by comparing the pre-removal HEAD set against branch and tag reachability
- Gates: pre-removal inventory of every worktree HEAD with reachability classification; `df -i` before and after; `git worktree list` and `git worktree prune` output; `git fsck --unreachable` diff showing no newly unreachable commit; full unit suite green on the reclaimed host
- Blockers: the dirty worktrees (tracked + untracked changes) must be preserved or consciously reconciled first; the durable/tmpfs relocation of the remaining worktrees is deferred until then
- Next: OWNER DECISION. Nothing further can be removed safely without it. The 11 worktrees carrying work not on `origin/main` are now all bound under `rescue/*` tags, so the cleanup is reversible — but the call on which to keep as live workspaces and which to retire is a working-practice decision, not an engineering one. Ask on the three named lines below.
- Recover: `git worktree list --porcelain && git tag -l 'rescue/*' && git fsck --unreachable`
- History:
  - 2026-08-28 — **re-measured; the recorded facts were badly stale and the real risk was different from the one described.** Actual state: **28 worktrees, 26 of them already on durable storage and only 2 on tmpfs** (both merely carrying one untracked file, with heads that are on `origin/main`) — not the "71 registered worktrees" on a RAM-backed filesystem the entry claimed. `/tmp` is at 90% inode use (936,204 of 1,048,576) and 43% of 46 GB, with both suites running green, so the `ENOSPC` acceptance condition is already met. The tmpfs relocation this task was largely about is therefore **already done**. The REAL exposure was elsewhere and is now closed: **11 worktree HEADs carried commits not reachable from `origin/main`, and none was rescue-tagged.** Three mattered — `073c59f3` (a cairn→cap rename, 1 commit) and `1e55c7cb` (6 commits of P0 permissions work) were held by **no ref whatsoever**, one `git worktree remove` from garbage collection; and `0816727f` is the second-writer `main` from the KNOWN-ISSUES force-push incident, 2 commits ahead and not on `origin/main`. Branch-held heads were not safe either: a prior cleanup on this repo deleted 126 local branches. **All 11 are now bound under `rescue/*` tags** (25 total, up from 13); the audit re-run reports `unreachable+untagged: 0`. Purely additive — no worktree removed, no ref deleted, no history rewritten.
  - 2026-08-28 — corrected to OPEN at triage. It was recorded IN_REVIEW while its own `Candidate:` field reads `—`; the lifecycle requires a candidate commit to be in review, so the state was not truthful. Nothing about the work changed.
  - 2026-08-22 — the public-safe AGENTS.md convention + the read-only worktree-audit script shipped; the audit inventories every registered worktree (HEAD/branch/dirty tracked+untracked/reachability/rescue/location class) and refuses destructive operations; private paths stay out of the repo.
  - Git reconcile at 2026-08-22 07:50 UTC: VERIFIED current facts — after the prior cleanup 19 worktrees remained (18 dirty, preserved, + the clean main worktree); two clean worktrees were later added for the tracker and the product work, so the current 21 = 18 dirty + 3 clean; 151 tracked changes + 26 untracked paths sit in the dirty worktrees; the cleanup removed 133 clean worktrees and 126 obsolete local branches, left 10 rescue tags, and touched no remote refs. No further destructive action until the dirty-preservation decisions.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D1/D2). Seven at-risk commits were tagged `rescue/tmp-detached-*` locally before this entry was written; no worktree, branch, or object was deleted.

  - 2026-08-23 20:12 UTC — sweep: no candidate (Candidate —); the prior cleanup left 18 dirty + 3 clean worktrees and 10 rescue tags; no further destructive action is warranted.

## [CAP-FB-20260821-RECIPES-SKILLS-RENAME-01] Finish the recipes to skills rename
- Feedback: 2026-08-21 — independent architectural review found the product concept named "Skills" in the UI while the code still ships a recipes directory, a 655-line recipes module and a `RECIPES` import, the drift `AGENTS.md` already cites as its worked example
- Updated: 2026-08-22 07:30 UTC
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
- Next: the UI half is done (see the 2026-08-28 entry). What remains is the INTERNAL half: `extension/lib/recipes.js` and its `RECIPES` export, the `recipe.*` message routes (`recipe.delete` is in `OWNER_DIRECT_ACTIONS`, so this touches the approval boundary), and the tests named after them (`tests/recipes.test.ts`, `tests/recipe-delete-order.test.ts`). Treat it as a routes/security rename with its own review, not as copy editing
- Recover: `git grep -in "recipe" -- extension lib tests scripts docs`
- History:
  - 2026-08-28 23:55 UTC — the USER-FACING half was absorbed by `CAP-FB-20260828-NOUN-DISCIPLINE-01`: the last user-facing "recipe" copy is gone (Settings → Background agents), `extension/recipes/skills-panel.js` moved to `extension/skills/skills-panel.js`, and `shared/recipe-icons.js`/`RECIPE_ICON` became `shared/skill-icons.js`/`SKILL_ICON`. `extension/recipes/` no longer exists. A `check:vocabulary` rule now fails the build on user-facing "recipe", so the UI half cannot regress while the internal half waits. Remaining scope narrowed to the module, the routes and their tests.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D8).

## [CAP-FB-20260825-DATA-EXPORT-IMPORT-01] Owner export and import of all agent data
- Feedback: 2026-08-25 — independent gap review found no way for an owner to export or restore anything they have built; clearing site data or resetting the profile destroys every agent, memory, thread and artifact irrecoverably
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: an owner can export a single portable bundle covering named/background/site agents, their per-agent OPFS memory and run history, threads, artifacts, skills, scheduled tasks and non-secret settings, from a genuine owner gesture in Settings; the bundle is inspectable (documented format, not an opaque blob) and states plainly what it excludes; import restores into a clean profile with the same agent identities, memory contents and artifact references, or reports exactly what could not be restored and why; **provider API keys are never included** — the bundle records which providers were configured, never their secrets; import is transactional and never partially overwrites existing data without an explicit owner choice; export works with zero optional permissions granted or states clearly which grant it needs
- Review: independent security/privacy review of what the bundle contains (a full memory export is a high-value exfiltration target and must not be model-callable), plus data-integrity, transaction, and loaded-MV3 review
- Gates: round-trip fixture — build a profile with several agents, memories, threads and artifacts, export, wipe, import, assert identity-level equality; assert no credential material anywhere in the bundle bytes; assert export and import are unreachable from any model toolset; partial-failure and corrupt-bundle handling; large-bundle bounds; service-worker restart mid-export
- Blockers: must compose with the deletion transaction in `CAP-FB-20260819-AGENT-DELETION-LIFECYCLE-01` and the artifact custody rules in `CAP-FB-20260818-ARTIFACT-TX-01`; the bundle format is a versioned contract and needs to be right the first time
- Next: inventory every durable store the extension writes (per-agent OPFS tiers, master memory, `chrome.storage` keys, IndexedDB usage ledger, artifact bodies) and write the bundle format contract before any UI
- Recover: `git grep -n "masterMemory\|memory/agents/\|cap:scheduledTasks\|cap:namedAgents" -- extension/lib`
- History:
  - 2026-08-25 09:40 UTC — opened. Verified absent: Settings exposes no export or import control, and `docs/OPEN-QUESTIONS.md` Q4 recorded a sync/export path as a deferred future option that was never scheduled.

## [CAP-FB-20260825-WEBSTORE-RELEASE-01] The path to a published extension
- Feedback: 2026-08-25 — independent gap review found no tracked work for actually publishing: the extension is still named "Chrome Agent Platform" (a stated placeholder), and existing packaging work covers building a ZIP, not shipping one
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: a decided final name applied consistently across the manifest, every UI surface, the documentation and the repository; a store listing with description, screenshots and category; a privacy policy that accurately describes what the extension stores locally and what it sends to a provider; a written justification for every optional permission and host permission in the manifest, each traceable to the feature that needs it; a store-mode build produced by the existing archive path and validated by `scripts/validate-package-load.ts`; a documented plan for responding to a review rejection
- Review: independent review of the permission justifications against the actual code (a justification that overstates or understates what a permission is used for is a rejection risk and a trust problem), and of the privacy policy against the real data flows
- Gates: name consistency grep across manifest, UI strings, docs and README; every `optional_permissions` and `optional_host_permissions` entry mapped to a calling site; store-mode archive builds and loads clean; privacy policy cross-checked against every network call the extension can make
- Blockers: the final name and distribution channel are undecided — `docs/OPEN-QUESTIONS.md` Q11 (tracked in `CAP-FB-20260825-OWNER-DECISION-QUEUE-01`). The owner-selected Wasm policy question (Q13) determines whether Store mode ships bundled-only; do not resolve it inside this task
- Next: obtain the name decision, then produce the permission-justification table mapped to calling sites — that table is the long pole and can be built before the name lands
- Recover: `git grep -n "Chrome Agent Platform" -- extension README.md && grep -n "optional_permissions" -A 20 extension/manifest.json`
- History:
  - 2026-08-25 09:40 UTC — opened. `CAP-FB-20260822-PACKAGE-ARCHIVE-FRESHNESS-01` covers building archives from an exact inventory; it does not cover listing, policy, justifications or the name.

## [CAP-FB-20260825-SITE-AGENT-SHOWCASE-01] Make sites-as-sub-agents demonstrable in under a minute
- Feedback: 2026-08-25 — independent review, restating §5 of `REVIEW-2026-08-21.md`: sites-as-sub-agents is the genuinely novel claim and the one thing nothing else does, and it is the hardest capability in the product to actually see working
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: from a fresh profile, an owner reaches a working site-agent tool call in under a minute without reading documentation — a reachable entry point, at least one real origin whose WebMCP tools are discovered and invoked, and a visible result; the path states honestly what it granted and to which origin; nothing about the demonstration weakens origin isolation, per-tool first-run approval or the all-optional permission model; the fixture origin in `fixtures/` is usable for this without pretending to be a third-party site
- Review: independent product, security and first-run review; a demonstration path that quietly broadens access to make itself smooth is a failure, not a success
- Gates: fresh-profile loaded-MV3 walkthrough timed end to end, with screenshots at each step; assert the exact permissions requested and that none is granted without a gesture; assert per-tool approval still fires; the same path re-run after a service-worker restart
- Blockers: depends on page identity from `CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01` and the discovery/enrollment vocabulary in `CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01`; sequence after those rather than duplicating their decisions
- Next: define what the sixty-second path actually is — which entry point, which origin, which tool, what the owner sees — and get that agreed before building anything
- Recover: `ls fixtures && git grep -n "webmcpExpose\|modelContext" -- extension/content fixtures`
- History:
  - 2026-08-25 09:40 UTC — opened. Deliberately left untracked on 2026-08-21 as an opportunity needing a product decision; opened now because the surrounding lanes have landed and it is the differentiator with no owner.

## [CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01] A headed-browser acceptance lane
- Feedback: 2026-08-25 — three separate residuals in `KNOWN-ISSUES.md` all reduce to the same missing capability: there is no headed run, so anything requiring a real operating-system permission prompt cannot be proven
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: this commit (`scripts/headed-acceptance.ts` — the headed macro; the RUN itself remains queued)
- Shipping: —
- Acceptance: a documented, repeatable headed run that covers the three gaps currently recorded as permanently open — (a) a screenshot success path, since headless auto-denies arbitrary-tab capture; (b) one full enrollment lifecycle as a single journey: enroll, discover, invoke, clean up, retry; (c) the two WebMCP operating-system permission prompts from `docs/WEBMCP-ACCEPTANCE.md`. The run states plainly which steps needed a human click and which were automated; its evidence is written to durable storage, never to a RAM-backed filesystem; a headless run continues to pass unchanged and continues to assert fail-closed behaviour
- Review: independent review that the headed path exercises production code rather than a test-only shortcut — the round-28 WebMCP block was caused by acceptance that bypassed the implementation
- Gates: the headed run itself, with retained screenshots; the existing headless suites still green and still asserting fail-closed denial; explicit labelling of every manual gesture
- Blockers: needs a machine with a display. If none is available, that must be recorded as the blocker with a named owner rather than leaving three residuals permanently open in `KNOWN-ISSUES.md`
- Next: run the macro in an unlocked session with Paul present as the human clicker, then close with the retained manifest + screenshots (the pre-flight already fails closed with exit 2 while the session is locked)
- Recover: `grep -n "headed\|HEADED" scripts/webmcp-acceptance.ts && sed -n '1,40p' docs/WEBMCP-ACCEPTANCE.md`
- History:
  - 2026-08-27 00:40 UTC — HEADED MACRO SCRIPTED (`scripts/headed-acceptance.ts`):
    pre-flight fail-closed (exit 2 without `--headed`, without grim/hyprctl, or
    with empty `hyprctl -j monitors` — verified live against the locked session),
    headed chromium `--ozone-platform=wayland` with the REAL extension (no
    manifest variant), the one journey (enroll → screenshot success → discover →
    pick → invoke → clean up → retry) with 4 labelled MANUAL steps (action-icon
    capture, enroll host prompt, WebMCP tabs prompt, WebMCP host prompt) driving
    the production selectors (`#enroll-origin`/`#enroll-btn`/`#discover-page`/
    picker/`.disenroll-origin`), grim + CDP evidence to durable storage (default
    `$HOME/cap-evidence/headed-acceptance/<ts>`, tmpfs refused), a machine-verifiable
    `headed-acceptance-manifest.json`, and the headless suites untouched
    (they keep asserting the fail-closed denials).
  - 2026-08-26 23:26 UTC — ENVIRONMENT DETERMINATION (read-only,
    /tmp/cap-headed-acceptance-env/GLM.md f49bc865): headed display AVAILABLE —
    ACTIONABLE, NOT BLOCKED. Hyprland 0.55.4 on seat0 (SDDM autologin), Xwayland
    :0 + wayland-1 live, grim+slurp installed, chromium 150 present. Transient
    probe caveat: hyprlock + empty hyprctl monitors (locked late-night session) —
    a SCHEDULING PRECONDITION (run in an unlocked session with an active monitor
    + Paul present as the human clicker), not headlessness. NEXT: write the
    headed script (chromium --ozone-platform=wayland, grim evidence to durable
    storage, per-step manual-gesture labels, headless suites unchanged/fail-closed),
    then run it in an unlocked window with Paul.
  - 2026-08-25 09:40 UTC — opened to consolidate three residuals that have each been carried as "needs a headed test" without an owner: no headed screenshot success path, no full real-enrollment lifecycle journey, and the WebMCP OS prompt gate.

## [CAP-FB-20260825-OWNER-DECISION-QUEUE-01] Product decisions blocking tracked work
- Feedback: 2026-08-25 — five questions in `docs/OPEN-QUESTIONS.md` block or shape tracked tasks but appear nowhere in the work queue, so they are invisible when planning
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: product owner
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: each of the five open questions has a recorded decision in `docs/OPEN-QUESTIONS.md`, and every task blocked on it has its `Blockers` updated in the same commit. The five: **Q11** final extension name and distribution channel (blocks `CAP-FB-20260825-WEBSTORE-RELEASE-01`); **Q12** the recommended default provider for the hub, given Gemini Nano is weak at tool-calling (shapes first-run quality); **Q13** whether a Chrome Web Store build may execute owner-selected local Wasm without violating the remotely-hosted-code policy (blocks `CAP-FB-20260822-OWNER-WASM-INSTALL-01`, currently `BLOCKED`); **Q14** the Co-do licence and provenance reconciliation — Apache-2.0 root against MIT package metadata — which must be settled before any Co-do binary is copied (blocks `CAP-FB-20260822-BUILTIN-WASM-TOOLS-01`); **Q16** grouped tabular artifact promotion — an atomic reservable keyed promotion with refcount and orphan collection, or an explicitly lower single-body cap (blocks `CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01`)
- Review: none — these are owner decisions, not reviewable work. An agent may prepare options and trade-offs; it may not decide.
- Gates: each decision written down with its rationale, and each dependent task's `Blockers` field updated to match
- Blockers: requires the product owner. Q13 and Q14 additionally need external input — Chrome Web Store policy wording and the upstream licence position respectively — which an agent can gather and summarise first
- Next: for each of the five, prepare a one-page options-and-consequences summary so the decision is cheap to make; start with Q13 and Q14, which are the two currently holding P0 lanes `BLOCKED`
- Recover: `sed -n '/^## Open/,$p' docs/OPEN-QUESTIONS.md`
- History:
  - 2026-08-25 09:40 UTC — opened so undecided questions are visible in the work queue rather than only in a separate document. Q15 (semantic index engine) is deliberately excluded: `docs/OPEN-QUESTIONS.md` states it stays inside `CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01` and must not be duplicated.

## [CAP-FB-20260825-DELEGATE-ATTACHMENTS-PROGRESS-01] Site-agent delegation is text-only
- Feedback: 2026-08-25 — carried as a residual under `CAP-FB-20260818-AGENT-ACCESS-01` since 2026-08-18 with no task of its own; re-verified against current source
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: a delegated site-agent run accepts the same attachments a hub run accepts, or states precisely which types it cannot accept and why; the run streams live progress to the delegating surface rather than returning only a final result; the composer stops having to warn that attachments were dropped because they no longer are; delegation keeps its current generation revalidation, preemptive revocation and journal-write fencing unchanged
- Review: independent review that the progress stream cannot leak one origin's run detail into another's surface, and that attachment handling does not widen what a site worker can read
- Gates: unit coverage for attachment pass-through and progress fan-out; a loaded-MV3 delegation showing live progress and a delivered attachment; disenrollment mid-run still discards the journal; concurrent delegations to different origins stay isolated
- Blockers: —
- Next: confirm the intended scope with the owner — full parity with hub runs, or a stated subset — then extend the `agent.delegate` route signature
- Recover: `git grep -n 'async "agent.delegate"' -A 3 -- extension/background/service-worker.js`
- History:
  - 2026-08-25 09:40 UTC — opened. Verified in current source: the `agent.delegate` route signature accepts `origin`, `task`, `threadId` and resume/execution parameters, and has no attachments parameter. `KNOWN-ISSUES.md` has recorded this as a follow-up since 2026-08-18 without an ID.

## [CAP-FB-20260825-CONCURRENCY-RESIDUALS-01] Close the four open concurrency verifications
- Feedback: 2026-08-25 — `KNOWN-ISSUES.md` carries four deep concurrency items each phrased as "verify no residual", none of which has an owner, a test, or a task
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: each of the four is closed by a failing-then-passing test rather than by inspection — (a) version-scoped CAS in the memory and journal compensation path, checked for remaining ABA windows; (b) the first sync/invoke generation requirement, checked for any residual generationless path; (c) `runGenCells` per-run isolation, checked for residual shared state; (d) MAIN-world cancellation tombstone eviction under sustained load. Anything that turns out not to be reachable is recorded as such with the reasoning, not silently dropped
- Review: independent concurrency review; a test that cannot fail against the pre-fix code proves nothing and must be rejected
- Gates: for each item, a test that fails against a deliberately reverted guard and passes against current source; the full unit suite; `npm run test:security`
- Blockers: —
- Next: start with (d) — tombstone eviction under load is the only one of the four with an unbounded-growth failure mode rather than a correctness one
- Recover: `sed -n '/^### Concurrency edge-cases/,/^### /p' KNOWN-ISSUES.md`
- History:
  - 2026-08-25 09:40 UTC — opened. The fundamental cooperative-cancellation limit documented alongside these four is explicitly **not** in scope: an already-started page side effect cannot be unwound, that is a browser constraint, and it is documented in `docs/DESIGN.md` rather than treated as a defect.


## [CAP-FB-20260825-I18N-FOUNDATION-01] No internationalisation foundation
- Feedback: 2026-08-25 — independent gap review found no `_locales` directory and no `default_locale`; every user-visible string is hardcoded English across the hub, Settings, side panel, chat and components
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: a `default_locale` and an `_locales/en` message catalogue exist; user-visible strings resolve through the catalogue rather than being hardcoded, including strings inside the shared Web Components; the component gallery renders identically after the migration; adding a second locale requires only a new catalogue and no code change. Shipping additional translations is explicitly **not** in scope — this task is the foundation only
- Review: independent review that no string escapes the catalogue and that the gallery drift guard still holds
- Gates: `npm run check:gallery` no drift; `npm run test:components`; the Chrome journey suite green — the journeys assert on visible text, so this migration is exactly the kind of change that breaks them silently; a grep-based inventory of remaining hardcoded user-visible strings with each survivor justified
- Blockers: this touches nearly every surface at once and will conflict with any concurrent UI lane. Sequence it deliberately — do not start it alongside an open UI task
- Next: produce the string inventory and decide whether the migration is worth doing before a name and distribution decision, or after
- Recover: `ls extension/_locales 2>/dev/null || echo absent; grep -n "default_locale" extension/manifest.json || echo absent`
- History:
  - 2026-08-25 09:40 UTC — opened as a foundation task, not a translation project. Priority reflects that it blocks nothing today but gets more expensive with every surface added.

## [CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01] Hub agent summary rows predate the shared picker
- Feedback: 2026-08-25 — carried as a residual under `CAP-FB-20260818-AGENT-ACCESS-01` since 2026-08-18 with no task of its own; re-verified against current source
- Updated: 2026-08-25 09:40 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: the hub's Named, Background and Site agent summary rows are expressed through the same shared agent component the rest of the product uses, so the three lists gain live registry updates and consistent behaviour for free; visible behaviour and the surfaces the rows open are unchanged; the component is exercised in the gallery
- Review: independent visual and behavioural review that nothing regressed — this is a consistency change and must not become a redesign
- Gates: `npm run check:gallery`; `npm run test:components`; `scripts/sidebar-parity.ts`; loaded-MV3 before/after screenshots of all three lists in expanded, collapsed and RTL layouts
- Blockers: `AGENTS.md` requires new UI to be a reusable component in the single-source components file and names hand-rolled duplicates as the cause of past bugs — this is the last known instance of that pattern in the hub
- Next: confirm the shared component covers the three summary presentations before changing anything; if it does not, extend it rather than forking it
- Recover: `git grep -c "capability-row" -- extension/ntp/ntp.js && git grep -c "agent-picker" -- extension/ntp/ntp.js`
- History:
  - 2026-08-25 09:40 UTC — opened. Verified in current source: `extension/ntp/ntp.js` uses `capability-row` five times and `agent-picker` zero times.



## [CAP-FB-20260825-UI-INTEGRATION-RED-01] scripts/ui-integration.ts is red and never finishes
- Feedback: 2026-08-25 — found while adding coverage for an unrelated UI fix; the suite fails five checks and exceeds its time budget before reaching its own end
- Updated: 2026-08-25 22:40 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `7642f76`
- Candidate: —
- Shipping: —
- Acceptance: `deno run -A scripts/ui-integration.ts` completes and prints its `RESULT` line within a stated budget, and every check passes or is removed with a recorded reason. In particular a demo task creates a thread in the sidebar again — the three overlay failures cascade from that one and are not separate defects until proven so
- Review: independent review of whichever fix lands, since this is one of the two suites that catch owner-visible UI regressions
- Gates: the suite reaching `RESULT` with zero failures, and the run time recorded so the budget is a fact rather than a guess
- Blockers: —
- Next: determine whether "running a demo task creates a thread in the sidebar" is a product regression or a stale harness assumption before touching the overlay checks that depend on it
- Recover: `deno run -A scripts/ui-integration.ts 2>&1 | grep -E "^FAIL|RESULT"`
- History:
  - 2026-08-25 22:40 UTC — opened with attribution evidence. Five failures: the `+` menu bounds check, "running a demo task creates a thread in the sidebar" (`items: 0`), "clicking the sidebar thread opens the thread surface", "overlay-open matrix: the thread overlay is OPEN" (`noThread: true`) and the midnight-theme nub check (`overlayVisible: false`). All five reproduce with identical values on pristine `7642f76` with local work stashed, so they predate that work. The suite also did not print `RESULT` within 1800s on pristine main, so it is over budget as well as red — checks appended near its end are unreachable, which is why an unrelated fix's coverage went into its own script instead.
- id: CAP-FB-20260826-OBSERVABILITY-01
  severity: P1
  status: done
  landed_version: 0.2.287
  summary: "Owner (2026-08-26): the extension has NO observability. Significant logging was requested before but isn't there. Clicking a task takes ~10s with zero trace of what's happening. One error seen: 'VM5974:2 Uncaught TypeError: Cannot read properties of undefined (reading startTime)' in et.reportAllChanges — that script is MINIFIED and is NOT our shipped code (our SW + options bundles are already unminified; grep confirms reportAllChanges absent), so it's a page the agent visited — we need logging to separate ours from theirs. REQUIREMENTS: (1) debug build with unminified code + source maps in npm run build; npm run build:production / --target=store stays the minified Store bundle; (2) a real logging layer — structured console logs with namespaces + levels + timing (grep-able like [cap:sw:grant]), console.groupCollapsed for runs; (3) performance.mark/measure around every slow path (task load, navigation, tool dispatch, model round-trips) + summary timing logs so a 10s task load becomes a readable breakdown; (4) use Chrome's native logging/performance features throughout (SW, NTP, side panel, content scripts); (5) a way to dump/ship the trace. Goal: use observability to improve the product. CRITICAL: debug mode must NOT weaken the production security assertions (seam scan, no-new-Function, oracle scan, bundled-tool verify) — logging verbosity is the only thing debug relaxes."


## [CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01] The library still evicts the owner's oldest artifact silently
- Feedback: 2026-08-28 — found while fixing `CAP-FB-20260828-ARTIFACT-DURABILITY-01`; same bug class, deliberately not folded into that fix
- Updated: 2026-08-28 04:30 UTC
- Status: OPEN
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `4ed8cf8a`
- Candidate: —
- Shipping: —
- Acceptance: the artifact library never silently discards the owner's work. When the index reaches its bound the owner is told and given a choice — the create fails honestly, or old artifacts are offered for review — rather than the oldest row being dropped inside a write it did not ask for. Whatever the policy, a test proves an artifact cannot leave the library without either an explicit `asset.delete` or an owner-visible decision
- Review: fresh-session review; falsification — the test must be shown failing against a build that still evicts silently
- Gates: unit suite; Chrome journeys green; `npm run test:opfs`
- Blockers: needs an owner decision — refusing a create fails a task mid-run, while evicting loses work silently. Both are bad in different ways and it is a product call, not an engineering one
- Next: put the two options to the owner with the real numbers (the bound is now ~15,000 rows) before building either
- Recover: `git grep -n "maxIndexBytes" -- extension/lib/artifacts.js`
- History:
  - 2026-08-28 04:30 UTC — the index carries a byte bound and, when a create would exceed it, drops the OLDEST rows (`idx = idx.slice(1)`) and records eviction obligations to clean their bodies. For a library whose stated purpose is being "the central source of all the information that has been created by the worker", silently discarding the oldest thing the person made is the wrong terminal behaviour — it is the same class as the bug just fixed, reached by a different route. The durability fix raised the bound from 128 KiB to 2 MiB (~940 rows to ~15,000) because the bound had been PER ORIGIN and became shared, which would otherwise have been a capacity regression. That defers the problem by roughly an order of magnitude; it does not fix it, and it is recorded here rather than left implied.


## [CAP-FB-20260828-TOOL-LIBRARY-GROUPING-01] Group tools by what they are for, not by Chrome API
- Feedback: 2026-08-28 — follows from the product thesis: the toolset has two families (running the browser, doing the work) and the UI shows neither
- Updated: 2026-08-28 02:00 UTC
- Status: OPEN
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `d551074b`
- Candidate: —
- Shipping: —
- Acceptance: the tool library presents tools grouped by purpose — the two families the product is actually built around, "running the browser" and "doing the work", subdivided into task-shaped groups a person would recognise (tabs & windows, reading & capture, files & data, text & documents, …) — rather than one flat list ordered by which Chrome API implements them. Each group says in one plain line what it lets you ask for. The 126-row honesty from `0.2.312` is preserved: the count and the rows still agree
- Review: fresh-session review; the impeccable design pass on the grouping and its copy
- Gates: unit suite; Chrome journeys green; the tool-count assertion still passes
- Blockers: —
- Next: the grouping is a product judgement, not a data problem — draft the two families and their subgroups against the real 126 names before touching the UI
- Recover: `git grep -n "routeFamily\|tool-library" -- extension/lib/chrome-tool-capabilities.js extension/options/options.js | head`
- History:
  - 2026-08-28 02:00 UTC — the registry already carries a `routeFamily` per tool (`browser.tabs`, `browser.debugger`, …), but that axis is the implementing Chrome API, which is an engineering fact rather than a user one. A flat 126-item list ordered that way does not help a person predict what they can ask the agent to do, which is the actual job the tool library has.

## [CAP-FB-20260828-NOUN-DISCIPLINE-01] One name per concept — Assets/Artifacts, Skills/recipes, Agents three deep
- Feedback: 2026-08-28 — product owner: "the UI is starting to get messy". Root-caused in PRODUCT.md, "Where the product is going": the product speaks three vocabularies for the same nouns
- Updated: 2026-08-28 23:55 UTC
- Status: DONE
- Priority: P0
- Owner: implementer (worktree lane)
- Workspace: active (local path private)
- Branch: `worktree-agent-a451ff5ed1d15409d`
- Base: `d654b0a4`
- Candidate: `worktree-agent-a451ff5ed1d15409d` (release `0.2.355`, rebased onto `origin/main@d654b0a4`; NOT pushed — a concurrent session is writing to this repo, so the owner merges)
- Shipping: `origin/main@4e0ed332`
- Acceptance: exactly one user-facing name per concept, and the code agrees with it. **Artifacts**, never Assets: the sidebar item, the hub card, both `openView` titles and the route family all say the same word. **Skills**, never recipes: `recipes/index.html` and the `recipe.*` routes are renamed to match the nav that already says Skills. **Agents** appears once per view, not as a sidebar section AND a card AND a row inside that card. **Skills is not a top-level view** (owner, 2026-08-28): it is currently a sidebar destination opening `recipes/index.html`, but a skill is something you attach to an agent or include in a task, not a place you go — it belongs where it is used, with management living in Settings alongside the other agent configuration. A `check:vocabulary` script fails the build on a banned term the way `check:gallery` fails on component drift, so this cannot come back
- Review: PENDING — fresh-session review of the diff on branch `worktree-agent-a451ff5ed1d15409d`. Falsification already recorded below (the gate observed RED on the unfixed tree, GREEN after)
- Gates: full unit suite; Chrome journeys green (several journeys select views by label); gallery drift; the new vocabulary check
- Blockers: —
- Next: fresh-session review of the branch, then merge. The deliberate remainder is the `asset.*` / `recipe.*` WIRE ROUTES, the `*_asset` model-facing tool names, the `management.asset.*` capability ids and the `asset:` OPFS keys — those are a persisted security/data boundary (approval digests, `DESTRUCTIVE_ACTIONS`/`OWNER_DIRECT_ACTIONS`, per-agent tool allowlists, stored artifact bodies), not vocabulary, and renaming them is its own reviewed change. `check:vocabulary` deliberately does not scan them, so the gate can never be satisfied by weakening it
- Recover: `git grep -n "NOUN-DISCIPLINE" -- TASKS.md scripts/check-vocabulary.mjs`
- History:
  - 2026-08-29 00:40 UTC — **two gates were inherited RED from `origin/main@d654b0a4` and repaired here, without changing anyone's meaning** (flagged for the owning lanes): (a) `tests/changelog.test.ts` failed because the auto-bump hook had written raw commit subjects containing `CAP-FB-` ids into the `0.2.353` and `0.2.354` changelog entries — both rewritten as plain user-facing English; (b) `scripts/check-tasks.mjs` reported 2 new schema violations because `CAP-FB-20260821-WORKTREE-HYGIENE-01` and `CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01` had appended a qualifier to the enum `Status:` field — the exact wording was MOVED verbatim to a `Note:` line and `Status:` left as `OPEN`. No content deleted, no assertion weakened.
  - 2026-08-29 00:40 UTC — rebased onto `origin/main@d654b0a4` (release `0.2.355`). The concurrently-landed `TOOL-CALL-LEGIBILITY` and composer-auto-grow edits to `extension/shared/components.js` auto-merged; the only conflicts were the hook-generated version files, all resolved to upstream. Full gates re-run at the rebased tip. One PRE-EXISTING red was inherited from `origin/main@d654b0a4` and fixed here rather than carried: `tests/changelog.test.ts` failed because the auto-bump hook had written raw commit subjects containing `CAP-FB-` ids into the `0.2.353` and `0.2.354` changelog entries; both are now plain user-facing English. Still NOT pushed.
  - 2026-08-28 23:55 UTC — implemented on `worktree-agent-a451ff5ed1d15409d` (base `2607d954`), NOT pushed to main (a concurrent session is writing to this repo; a force-push destroyed landed work earlier today).
    **Artifacts is the single user-facing name.** The sidebar button (`open-assets`/"Assets" → `open-artifacts`/"Artifacts"), the quick drawer (`<asset-quick-drawer>` → `<artifact-quick-drawer>`, its heading/search/empty/browse copy, its `browse-assets`/`asset-open`/`asset-reuse` events → `artifact-*`, its exports `ASSET_QUICK_LIMITS`/`selectQuickAssets`/`quickAssetOwner`/`formatQuickAsset*` → `ARTIFACT_*`/`*Artifact*`), the composer mention group ("Assets" → "Artifacts"), and BOTH `openView("artifacts/index.html", …)` call sites (one said "Assets", one said "Artifacts" — the exact defect in the feedback) now say one word. `attachAssetToComposer` → `attachArtifactToComposer`. The agent editor's "Core assets" became **Context files** — owner-supplied INPUT is a different concept from agent OUTPUT and may not borrow the artifact noun either; the persisted `coreAssets` field is untouched.
    **Agents once per view.** The hub card was `<section aria-label="Agents">` → `<h2>Agents</h2>` → `<span>Agents</span>`; the aria-label became `aria-labelledby` on the h2 and the inner row became "Yours". The same duplicate-accessible-name defect was found and fixed on the Recent artifacts and Recent activity sections by the new checker.
    **Skills.** The sidebar destination was already gone (skills-in-settings landed earlier); this change removes the last user-facing "recipe" copy (Settings → Background agents said "each wraps a recipe"), moves `extension/recipes/skills-panel.js` → `extension/skills/skills-panel.js`, and renames `shared/recipe-icons.js`/`RECIPE_ICON` → `shared/skill-icons.js`/`SKILL_ICON`. `/skill:<id>`, the `use-skill` bridge and agent skill attachment are untouched. Absorbs the UI half of `CAP-FB-20260821-RECIPES-SKILLS-RENAME-01`; that entry keeps the `recipe.*` route/`lib/recipes.js` half.
    **The gate.** `scripts/check-vocabulary.mjs` + `npm run check:vocabulary` (also wired into `test:all`), modelled on `sync-gallery.mjs --check`. It extracts only USER-VISIBLE strings (HTML text nodes, visible attributes, a declared list of JS sinks, and HTML template literals — collapsing `${…}` holes while keeping string literals written inside them) and applies four rules: banned terms (`asset`, `recipe`), Skills-is-not-a-destination, one governed noun per `<section>`, and no aria-label duplicating a heading. 14 surfaces scanned.
    **Falsification (recorded, not asserted):** with the four source files stashed to their pre-fix state the gate reported **23 violations** across `ntp.html` (4 + the nested-Agents + 3 duplicate-accessible-name), `ntp.js` (5), `components.js` (9) and `options.html` (1) and exited 1; restored, it reports 0 and exits 0. `tests/vocabulary.test.ts` (12 tests) went **8 passed / 4 failed** against the unfixed tree and 12/12 after; each falsification test also feeds the FIXED markup and asserts zero findings, so no rule passes by returning true.
    **Gates at this commit:** `npm run build` clean (80 generated files byte-identical, 26 packages / 65 shipped files); `npm test` **1946 passed / 0 failed** (1934 before, +12 new); `npm run test:chrome` **127/127**; `npm run check:gallery` clean; `node scripts/check-tasks.mjs` no new violations; `npm run check:vocabulary` clean.
    **Real-browser evidence:** `scripts/kat-noun-discipline.ts` loads the real MV3 extension and asserts the rendered nouns — **14/14 passed**, no page errors, with screenshots (hub, quick drawer, and the Artifacts view reached from both call sites). Both entry points produce the view title "Artifacts".
  - 2026-08-28 02:40 UTC — owner: "Skills shouldn't be a tab... but artifacts and [Assets] we should clear that up." So: Artifacts is the single name, and the Skills sidebar destination goes. That removes one of the four iframe views outright, which also shrinks `CAP-FB-20260828-VIEW-FRAME-COLLAPSE-01`.
  - 2026-08-28 01:10 UTC — captured from a product audit of the shipped extension. The same view is `Assets` in the hub sidebar, `Recent artifacts` on the card beside it, `artifacts/index.html` on disk and `asset.*` in the routes — and `extension/ntp/ntp.js` opens it with the title "Assets" at one call site and "Artifacts" at another, so the SAME view has two titles in one file. `Skills` in the nav is `recipes/index.html` served by `recipe.*` routes; `CAP-FB-20260821-RECIPES-SKILLS-RENAME-01` is the unfinished half of that and should be absorbed here or sequenced with it. `Agents` labels a sidebar section, a hub card, and a row inside that card. This is the cheapest item in the whole UI backlog and the fastest one a person feels — a user builds a mental model out of nouns, and three names for one noun means there is no model to build.

## [CAP-FB-20260828-HUB-AS-TIMELINE-01] The hub is a dashboard; it should be a composer and a timeline
- Feedback: 2026-08-28 — product audit; pairs with CAP-FB-20260827-HUB-FIRST-RUN-01 (that one is the first-run card, this one is the steady state)
- Updated: 2026-08-28 01:10 UTC
- Status: OPEN
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `30cd7f59`
- Candidate: —
- Shipping: —
- Acceptance: the composer is the primary element of the hub in the steady state, not only on a fresh profile. The three separate status cards (Agents, Recent artifacts, Recent activity) become ONE activity stream with filters, so a returning owner sees what happened while they were away as a single chronological thing rather than three partial views of it. Drilling into an agent, an artifact or a run still works from that stream. An artifact's primary home becomes the thread that produced it — it is the output of the work, so it belongs with the work; the Artifacts gallery remains as the archive rather than the first place you look. Verified with before/after screenshots on a profile that has real history, not an empty one
- Review: fresh-session review; the impeccable design skill is mandatory
- Gates: Chrome journeys green; a11y pass; the impeccable design pass; hub render stays under the existing budget
- Blockers: —
- Next: build the profile-with-history fixture first — every hub screenshot to date has been of an empty profile, which is why the composition problem was invisible
- Recover: `git grep -n "Recent artifacts\|Recent activity" -- extension/ntp/ntp.html`
- History:
  - 2026-08-28 02:00 UTC — **better rationale, from the owner's own framing of the product.** This was filed as a composition problem (three cards, weak composer). The stronger statement: the product is a coworking environment for knowledge workers, and coworking is organised around WORK, while the hub is organised around OBJECT TYPES. Agents / Recent artifacts / Recent activity are three catalogs answering "what objects exist?" A colleague-shaped environment answers "what is in flight, what is waiting on me, what came back while I was away?" — the same information with a different spine. Judge the redesign against that question, not against card count.
  - 2026-08-28 01:10 UTC — captured from a product audit. PRODUCT.md states the job as "start a task, see what's happening, and drill in". Today the hub answers the second half with three mostly-empty cards and answers the first half with a composer placed below them. A returning power user mid-task needs somewhere to say the next thing and a record of what happened while they were gone; three partial views of the second thing is not that.

## [CAP-FB-20260828-DEAD-SURFACES-01] Two HTML surfaces ship to users and nothing links to them
- Feedback: 2026-08-28 — product audit of the shipped surface inventory
- Updated: 2026-08-28 01:10 UTC
- Status: OPEN
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `30cd7f59`
- Candidate: —
- Shipping: —
- Acceptance: `extension/chat/chat.html` and `extension/memory/explorer.html` are removed along with their JS, or a reachable entry point is added on purpose. The packaged extension contains no HTML document that nothing references. A build assertion enumerates shipped HTML entry points and fails on an unreferenced one, so the next dead surface is caught at build time
- Review: fresh-session review; falsification — the build assertion must be shown failing against an unreferenced page
- Gates: unit suite; Chrome journeys green; `npm run package` succeeds and the archive inventory shrinks by exactly the removed files
- Blockers: confirm with the owner that neither is a deliberate future entry point before deleting
- Next: check whether `chat/chat.html` was superseded by the in-hub thread view — if so it is a straightforward delete
- Recover: `for f in $(find extension -name '*.html' -not -path '*/dist*'); do echo "$f $(grep -rl $(basename $f) extension --include=*.js --include=*.html --include=*.json | grep -v dist | grep -vc $f)"; done`
- History:
  - 2026-08-28 01:10 UTC — twelve HTML surfaces ship. `extension/chat/chat.html` and `extension/memory/explorer.html` are referenced by nothing — no JS, no HTML, no manifest entry. The memory explorer was already noted as unreachable during the 2026-08-25 Data-and-memory work and recorded as "a removal candidate" rather than removed; it has been shipping unreachable ever since. Dead surfaces are not free: they are packaged, they are scanned by the Store gates, and they make the product look larger and less considered than it is.

## [CAP-FB-20260828-VIEW-FRAME-COLLAPSE-01] Collapse the iframe view model into one hub document
- Feedback: 2026-08-28 — product audit; the single largest structural lever in the UI, and deliberately sequenced AFTER the exec demo
- Updated: 2026-08-28 01:10 UTC
- Status: OPEN
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `30cd7f59`
- Candidate: —
- Shipping: —
- Acceptance: Settings, Directory, Skills and Artifacts render as client-side views of the hub document rather than separate documents inside `#view-frame`. Back navigation is ordinary history with no joint top-frame/iframe stack; each view is still addressable by URL; the single-history-entry behaviour from `0.2.296` is preserved by construction rather than by special-casing. The defect classes this retires are named and their regression tests kept: back-stack, view-transition ghosting, covered-nub inertness, and the intermittent flash/relayout
- Review: fresh-session review; this is large enough to warrant staging behind a flag and landing view by view
- Gates: full unit suite; Chrome journeys green at every stage; a11y pass on focus movement between views; the impeccable design pass; hub render budget
- Blockers: sequenced after the exec demo by owner priority — it is the biggest lever and the biggest risk, and the demo path comes first
- Next: do NOT start before the demo. When it starts, take Directory first: it is the smallest view and the least used, so it proves the pattern cheaply
- Recover: `git grep -n "openView\|view-frame" -- extension/ntp/ntp.js`
- History:
  - 2026-08-28 01:10 UTC — captured from a product audit. Settings, Directory, Skills and Artifacts are separate HTML documents loaded into an iframe of the new-tab page — all same-origin extension pages, so the iframe buys no isolation. It costs: a joint history stack between the top frame and the iframe (two separate back-button fixes, `0.2.296` and `0.2.304`), a full document bootstrap per view switch, and the Settings monolith, because when a view is a document the way to add a feature is to append a `<section>` — which is how Settings reached 12,837px with all twelve panels rendered simultaneously. Five tracked defects trace to this one decision. `CAP-FB-20260827-SETTINGS-MONOLITH-01` can be done independently and first; this entry is the general fix.

## [CAP-FB-20260829-SILENT-PROVIDER-RUN-01] WITHDRAWN — the provider gate does report itself; the harness was reading the wrong DOM
- Feedback: 2026-08-29 — raised by this session, then withdrawn by this session on better evidence
- Updated: 2026-08-29 UTC
- Status: ABANDONED
- Priority: P0
- Owner: coordinator session
- Workspace: main
- Branch: main
- Base: `8f3b03d0`
- Candidate: —
- Shipping: —
- Acceptance: n/a — withdrawn. The behaviour it described does not exist
- Review: n/a
- Gates: n/a
- Blockers: —
- Next: nothing. The one genuine observation that came out of it is tracked separately as `CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01`
- Recover: `git log --oneline --all --grep=SILENT-PROVIDER-RUN-01`
- History:
  - 2026-08-29 — **WITHDRAWN. The claim was false and the fault was in my measurement, not the product.** I reported that a keyed provider without host access produced "no assistant message, no error, no status, no approval card". It produces a correct, styled error bubble with a remediation action. Re-measured reading the conversation through its shadow root: with a valid base URL the transcript says *"the configured provider's exact origin is not granted / grant the exact provider origin in Settings, then run this task again"* with a **Fix in Settings** control, and `runConversationTurn` sets `state: "waiting-for-permission"` before it. My probe sampled `document.body.innerText.slice(-260)` — the composer area — and counted `message-bubble` elements in the light DOM, so it could not see anything the conversation had rendered inside `<agent-conversation>`'s shadow root. It reported silence because it was looking somewhere silent. The harness has been fixed to read the bubbles themselves; a harness that can report "nothing happened" when something did is worse than no harness, which is the same class of defect as `CAP-FB-20260829-FIXED-DEBUG-PORTS-01`. **The "Fix in Settings" routing is also deliberate, not a shortfall:** `runConversationTurn` documents that calling `chrome.permissions.request` after the asynchronous provider lookup is rejected by Chrome as not being a user gesture, so Settings is the only surface that can genuinely request it. That is a considered design, and the AGENTS.md rule it appeared to violate is in fact satisfied — the failure names the exact origin and offers the remedy.


## [CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01] Saving a preset provider without a base URL yields a config that can never run
- Feedback: 2026-08-29 — the one real observation left from the withdrawn `CAP-FB-20260829-SILENT-PROVIDER-RUN-01`
- Updated: 2026-08-29 UTC
- Status: OPEN
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `84991bdd`
- Candidate: —
- Shipping: —
- Acceptance: saving a provider that HAS a known preset base URL (`anthropic`, `openai`, `gemini`, `deepseek`) without supplying one stores that preset rather than an empty string, so the permission preflight can derive a real origin; the BYO-endpoint provider, which has no preset, still requires one and says so
- Review: falsification — the assertion must go red against the current route, which stores `baseURL: ""`
- Gates: unit suite; the provider journeys
- Blockers: —
- Next: default `baseURL` from the provider descriptor in the `provider.set` route when the chosen provider has one
- Recover: `git grep -n "provider.set" -- extension/background/routes/provider.js`
- History:
  - 2026-08-29 — measured. `provider.set` with `{ provider: "anthropic", apiKey, model }` and no `baseURL` stores `baseURL: ""`, even though `extension/lib/provider.js` carries `https://api.anthropic.com/v1` as that provider's preset. The permission preflight then derives no origin and the run fails with *"provider permission preflight failed closed: configured provider origin is invalid"* — which blames the origin rather than the missing default. Supplying the base URL explicitly produces the correct message instead (*"the configured provider's exact origin is not granted"*). Low priority because the Settings UI fills the preset, so this is reachable mainly by the route; but a config that can never run should not be storable when the product already knows the right value.

## [CAP-FB-20260829-FIXED-DEBUG-PORTS-01] Nine harnesses hard-code a debug port, so a KAT can report green against the wrong browser
- Feedback: 2026-08-29 — surfaced by the noun-discipline lane: "an early KAT run gave a full page of false failures because a fixed debug port silently attached to another lane's chromium"
- Updated: 2026-08-29 UTC
- Status: DONE
- Priority: P1
- Owner: implementation session (author review; falsification gates cleared)
- Workspace: active (local path private)
- Branch: `cap-fb-20260829-fixed-debug-ports-01`
- Base: `84991bddd` (`origin/main` at the rebase)
- Candidate: `origin/main@ab454213`
- Shipping: `origin/main@ab454213`
- Acceptance: no browser-driving script hard-codes a debug port; every one launches with `--remote-debugging-port=0` and discovers the real port from the `DevTools listening` line (the pattern 28 scripts already use); each converted harness still passes on its own; and two harnesses that previously shared a port pass when run CONCURRENTLY, which is the case that produced false results
- Review: author review 2026-08-29 — falsification cleared in real browsers (a decoy browser holding the old fixed port; the pre-change harness reported the decoy tree's string, the converted harness reported its own). No independent review: no second model is available, per AGENTS.md "Review without a second model"
- Gates: each converted KAT green individually; a concurrent run of the previously-colliding pair green; `npm run build`, `npm test`, `npm run test:chrome`, `npm run check:gallery`, `node scripts/check-tasks.mjs`
- Blockers: —
- Next: owner merges the candidate to `origin/main`
- Recover: `git log --oneline --all --grep CAP-FB-20260829-FIXED-DEBUG-PORTS-01`
- History:
  - 2026-08-29 — verified independently by the coordinator session and merged. Cherry-picked onto current `main` (the tracker row and CHANGELOG conflicted and were resolved keeping both lanes' content). **My own falsification, not the implementer's:** adding `--remote-debugging-port=9351` to `kat-usage-viz.ts` drove the gate RED (4 pass / 1 fail); removing it returned to green — so the gate fails for the right reason. A `grep` for a fixed port anywhere under `scripts/` now returns nothing outside the launcher. Gates at the merge tip: build clean, unit **2004 pass / 0 fail**, Chrome journeys **127/127**, gallery + tracker schema green. **One correction applied on merge:** the second test was named "only the shared launcher writes the debugging-port flag" but asserted merely that the launcher is *among* the writers — roughly thirty other scripts spawn Chrome themselves with the safe `=0` form. Renamed to "the shared launcher owns the debugging-port flag" and documented the scope in the test, because a test that claims more than it checks is the same defect class this entry exists to fix. The safety property (no script may name a port) is enforced by the first test and is unaffected. Migrating the remaining ~30 scripts onto `launchChrome()` is a separate cleanup, not a defect.
  - 2026-08-29 — **converted, falsified and gated.** Twelve harnesses now launch through one shared `scripts/lib/chrome-launch.ts`; `launchChrome()` passes `--remote-debugging-port=0` and reads the DevTools endpoint out of its OWN child's stderr, so the endpoint provably belongs to this process and there is no probe to race. The port-0 form was used everywhere — no harness needed the weaker probe-then-bind fallback — and the two scripts that already carried private copies of that helper (`kat-noun-discipline`, `kat-bgagent-delete`) were folded onto the shared launcher too, leaving one spawn path instead of nine fixed ports and two copies. FALSIFICATION: a decoy browser was started holding 9351 (the port `kat-usage-viz` hard-coded) running a deliberately altered copy of the extension; the PRE-CHANGE harness, pointed at the real tree, reported `FAIL: cost card is labelled an estimate — "costs are DECOY approximations (this tree is NOT under test)"` — a string that exists only in the decoy — proving it drove a browser it did not launch; the converted harness, with that same decoy still holding the port, passed 13/13 against the real tree. CONCURRENCY: `kat-usage-viz` + `kat-ux-lows` (both 9351) run together — before, one lane hung to a 300 s timeout when the other killed the browser they were sharing; after, both finish with their solo results. Individually every harness matches its pre-change tally: back-stack 6/0, dark-scheme 32/3, narrow-toggle 20/0, usage-viz 13/0, ux-lows 9/1, axe-audit 7/0, providers-tabs 19/0, agent-templates 13/0, composer-grow 11/0, noun-discipline 14/0, bgagent-delete 11/0 (the 3 dark-scheme and 1 ux-lows failures are pre-existing contrast/landmark findings, unchanged by this work); `kat-failed-runs` went from hanging for the full 300 s timeout against a live zombie on 9357 to 7/0 in 10 s. TWO THINGS FOUND THAT THE REPORT DID NOT DESCRIBE: the slow port poll was also masking a startup race — reading the endpoint off stderr is fast enough that MV3 has not registered its service worker yet, so eight harnesses gained an explicit bounded `waitForServiceWorker()` instead of depending on how long a probe happened to take; and `kat-bgagent-delete`'s own helper called `Deno.listen` outside its `try`, so a taken port threw out of the function rather than moving on to the next. A new gate, `tests/harness-debug-port.test.ts`, fails on any fixed debugging port anywhere in `scripts/` and on a launcher that would accept a caller-chosen one; it was observed RED with a port reintroduced into `kat-usage-viz` and GREEN with it removed.
  - 2026-08-29 — measured, then corrected after the reporting lane pointed out the failure mode is worse than "a flake". **A fixed-port harness does not merely hang or error — it attaches to another lane's browser and reports confident PASS/FAIL results about an extension it is not testing.** The reporting run produced 7 such results. That means a fixed-port harness can go **green against the wrong tree**, which is worse than a red suite, because the output reads as evidence. Eleven scripts name a port; two of them (`kat-bgagent-delete` on `cbf89c33`, `kat-noun-discipline`) already probe for a free one, leaving **nine hard-coded**. Four ports are each claimed by two of those nine: 9347 (`kat-narrow-toggle`, `kat-dark-scheme`), 9351 (`kat-usage-viz`, `kat-ux-lows`), 9353 (`kat-providers-tabs`, `axe-audit`), 9359 (`kat-agent-templates`, `kat-composer-grow`); `kat-failed-runs` holds 9357, the port `kat-bgagent-delete` starts probing from. 28 other scripts already launch with `--remote-debugging-port=0` and read the real port off the `DevTools listening` line, and `scripts/kat-noun-discipline.ts` carries a reusable `freePort()` (probe `/json/version`, then bind-test) — so both the pattern and a helper are already in-repo.

## [CAP-FB-20260829-TEMPLATE-CARDS-01] Agent templates render as visual cards
- Feedback: 2026-08-29 — product owner asked for visual template choices instead of plain list rows
- Updated: 2026-08-29 07:11 UTC
- Status: IN_REVIEW
- Priority: P1
- Owner: implementation session
- Workspace: active (local path private)
- Branch: `cap-template-picker-cards`
- Base: `origin/main@54c92834`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: the create-agent picker renders every shipped template through shared visual cards with name, a one-to-two-line persona summary, at most three skill badges plus an overflow count, and a labelled Use action; the curated six render first with a Starter badge; one Use click applies the editable persona/skills and Create persists it through the existing named-agent route; axe fails closed; a real loaded-extension screenshot proves the result
- Review: fresh-session review round 1 REVISE (one P1: content-box articles overlapped adjacent rows by 22px); round 2 re-review pending
- Gates: pre-change RED 3/3 source/component failures and 0/9 browser journey; round-2 geometry RED 9 pass / 1 fail with four -22px row gaps and content-box sizing; focused 30/30; production build clean; visual-card KAT 10/10 with equal-height, non-overlapping rows; existing template journey 38/38; blocked-axe probe exits 1 at the axe check while 8 other checks pass; full suite 2118/0; gallery/vocabulary/tracker/check-clean gates green
- Blockers: —
- Next: fresh-session round-2 re-review of the one-line sizing fix, geometry pin and replacement screenshot
- Recover: `git log --oneline --all --grep CAP-FB-20260829-TEMPLATE-CARDS-01`
- History:
  - 2026-08-29 07:11 UTC — round-1 review's single P1 fixed without widening scope: `<agent-template-card>` articles now use border-box sizing, so their 14px padding and 1px border stay inside the equal-height grid track. The real-browser geometry pin failed before the fix with four -22px adjacent-row gaps (`content-box`) and passes after it; the replacement screenshot visibly shows clean row separation (SHA-256 `9378eb458b7489b7d96f42a6c854ce88ea21e759517b8f45b1a5b114ef1bb609`). Focused 30/30, visual-card KAT 10/10, existing template journey 38/38, production build clean, full suite 2118/0.
  - 2026-08-29 06:48 UTC — candidate gated. Shared `<agent-template-card>` renders name, bounded persona and skill badges with a Starter state; the create dialog orders the curated six first and one Use click applies the editable template. Real MV3 journey 9/9, existing template journey 38/38, full suite 2118/0. Axe ran clean on the gallery; repointing its fetch to a blocked local port made the same journey exit 1 at the axe gate. The rendered-gallery screenshot SHA-256 is `7187c6a9a74f15bbc8ffef873c387d42ba010a10edf8496f3bc2a0a1e4c28915`.
  - 2026-08-29 06:39 UTC — implementation started from current `origin/main`; baseline falsification recorded: all three source/component pins failed and the real-browser card journey failed 0/9 because the old picker rendered no cards

## [CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01] Tool-call cards show shape, not answers
- Feedback: 2026-08-27 — product owner: "the tools calling bubbles don't help as much, I'd expect some better info, then formatted and ability to see JSON input and response better"
- Updated: 2026-08-29 UTC
- Status: OPEN
- Note: 7 of 8 acceptance items delivered and gated; ONE remains (the in-context grant card for a permission denial, §2b)
- Priority: P0
- Owner: coordinator session
- Workspace: main
- Branch: main
- Base: `139b6f92`
- Candidate: `origin/main@757065b4`
- Shipping: `origin/main@757065b4`
- Acceptance: (1) the COLLAPSED head answers "what happened" without a click — tool label, the existing one-line result summary, duration, and for a failure the actual error text, not just a red "error" chip; (2) an ERROR card is expanded and styled as an error by default, and where the error is a permission/grant denial it renders the in-context approval card rather than prose; (3) the expanded view offers BOTH a structured view and a raw JSON view of inputs and result, with copy-to-clipboard on each, and remembers which the owner last chose; (4) the tree shows CONTENT not shape — an array of objects previews each row's identifying field inline instead of `0 object · 10`; (5) the synthetic `{keys}` root node is gone; (6) an `ok:true` envelope is not rendered as a data row when the status chip already carries it; (7) one expanded typical tool call fits in under ~40% of a 900px viewport; (8) no result summary is rendered twice
- Review: independent review by a different model/session; visual verification in a real loaded extension with before/after screenshots at 1440px and at a narrow width
- Gates: full unit suite; Chrome journeys green; a11y pass (the card is a `<details>`, the status chip is the live region — that must survive); the impeccable design pass
- Blockers: —
- Next: §2b only — when a tool fails because a permission was never granted, render the existing in-context approval card instead of the error prose, so the owner can grant it from the transcript. Everything else in the acceptance list is landed and gated
- Recover: `git grep -n "buildToolCardDom" -- extension/shared/components.js`
- History:
  - 2026-08-29 — mutation-claim genuineness follow-up candidate on `cap-claim-genuineness-p2`: conventional proper-name subjects (`Alice`, `Google`) and possessive third-party subjects (`Our vendor`) no longer trigger assistant-action corrections. Review revision 3 keeps subjectless action reports (`Just`, `Now`, `As requested`) while making unmarked coordinated predicates inherit their third-party subject across both `and [then]` and `but [then]`; an explicit `I`/`we` or trailing `myself`/`ourselves` resumes first-person, including comma-separated and `by myself` forms. The coordinated matrix is behaviorally pinned, with unmarked inheritance RED on `d797f9c5` and both natural reflexive forms RED on `7d126607`. Known heuristic limits remain: team-relative clauses, lowercase subjects, quoted speech and semicolon-separated predicates. This narrows only the runtime honesty backstop; §2b remains the task's separate open product item.
  - 2026-08-27 23:30 UTC — captured with measured evidence from a real loaded extension (headless Chrome, 1440x1600, realistic payloads). **Measured:** one expanded `list_tabs` card is **462px** tall, `search_tools` **436px**; collapsed they are 33px each. Four tool calls expanded fill 1,316px — more than a 900px viewport, on the surface that is supposed to be the conversation. **The collapsed head shows only name + status + duration.** The `tool-result` summary ("8 tabs", "5 matches") is already computed and passed to the card, and is not shown in the head — so a collapsed row communicates almost nothing, while an expanded one floods. **An error card collapsed shows no error text at all:** a `group_tabs` failure renders as `group_tabs · error · 9ms`, and the actual message ("Tab grouping write operations are pending owner tab-management permission enrollment in Settings") is hidden behind a click — backwards for the one state the owner most needs to read. **The tree shows shape, not content:** an 8-tab result renders as eight `0 object · 10` rows, hiding every tab title behind eight more clicks. Every block carries a synthetic `{keys} object · N` root node that is pure noise and costs a level of indentation, and the `ok true` envelope field is rendered as a data row even though the green "done" chip already says it. The summary is duplicated — an "8 tabs" row, then the same thing structurally in the result tree. **There is no raw JSON view and no copy button** on the normal tool path at all; only the generate_ui branch has a "Raw payload" `<pre>`. That is the owner's exact ask and it is simply absent. Tool names render as raw snake_case (`memory_grep`) with no human label.
  - 2026-08-28 — shipped `origin/main@757065b4` (release 0.2.352), rebased twice onto a concurrently-advancing `main` and pushed fast-forward (never forced). Journey suite re-run green at the pushed tip. **Landed items 1, 2a, 3, 4, 5, 6, 7 and 8.** Measured in a real loaded extension, before → after on the same payloads: one expanded `list_tabs` card **462px → 328px** (under the §7 budget of ~40% of a 900px viewport) while showing the SAME 11 visible rows and strictly more information. (1) The collapsed head now carries the one-line summary — `list_tabs  8 tabs · done · 184ms` — and for a failure the actual error text in red rather than a bare chip; (2a) an error card styles as an error and opens itself; (3) every block has a JSON toggle and a Copy button, and the chosen view is remembered per block across the re-renders that rebuild a running card; (4) container rows preview their CONTENT (`tabIds  1800, 1801, 1802`, `0  Inbox — Gmail`) via the new `containerPreview` in `extension/shared/tool-tree.js`, so an array of objects is no longer ten identical `object · 10` rows; (5) the synthetic `{keys}` root row is gone and its children promoted; (6) `ok`/`summary`/`error` are stripped from the tree since the chip and the headline already carry them, and a block left with nothing substantive renders no block at all; (8) the duplicated summary row is gone. Row density tightened (27px → 22px per row) so the 200px scroll cap holds the same rows the old 260px cap did. Two findings came out of writing the tests, both fixed in the code rather than the assertions: a bare numeric `id` outranked `status` in the preview order (a row reading `7` says nothing), and `kind` was unrecognised. **Gates:** build clean; unit **1950 pass / 0 fail**; Chrome journeys **127/127**; gallery drift green. **Falsification:** nine deliberate regressions — neutered headline, un-stripped envelope, restored `{keys}`, no auto-open on error, empty previews, `id`-first ordering, containers stringified into previews, unpersisted view choice, and a globally-shared view choice — each drove exactly its own assertions red before being reverted.
  - 2026-08-27 23:30 UTC — note for the implementer: `<tool-chips>` already exists in `extension/shared/components.js` as a compact chip-row primitive and is currently used ONLY by the gallery, never by the product. It may be the right collapsed representation for a run of successful calls, with full cards reserved for failures and for the call the owner opens. Reuse it rather than adding a sixth representation.



## [CAP-FB-20260827-HUB-FIRST-RUN-01] The first screen is an onboarding wall, not a command center
- Feedback: 2026-08-27 — raised during the pre-exec-demo UX audit; the hub is the first thing anyone opening a new tab sees
- Updated: 2026-08-27 23:30 UTC
- Status: OPEN
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `139b6f92`
- Candidate: —
- Shipping: —
- Acceptance: on a fresh profile the composer is the visually primary element of the hub; the first-run card offers ONE next action rather than six competing ones; a fresh profile does not stack seven separate empty states; the zero state and the filtered-empty state use different copy; and the word "Agents" does not label three nested levels of the same view. Verified with before/after screenshots on a genuinely fresh profile
- Review: independent review by a different model/session; the impeccable design skill is mandatory here (PRODUCT.md principle 1 — one primary action per view — is what this breaks)
- Gates: Chrome journeys green (the first-run card is on the journey path); a11y pass; the impeccable design pass
- Blockers: —
- Next: decide what the single first action is — almost certainly "connect a provider", since nothing else works without one — and demote everything else
- Recover: `git grep -n "first-run-guide" -- extension/shared/components.js extension/ntp/ntp.js`
- History:
  - 2026-08-27 23:30 UTC — captured with a screenshot of a genuinely fresh profile in a real loaded extension. The first-run card is roughly 590px tall and contains **six competing actions**: "Allow browser control", "Continue without browser control", "Open provider settings", "Use starter task", "Create the Weekly browsing review agent", and a dismiss X — against PRODUCT.md's first principle, "one primary action per view". The composer, which is the actual point of the product, sits below it and is visually weaker. Below that a fresh profile stacks **seven empty states**: "No tasks yet", "No agents yet" (sidebar), "No named agents yet", "No Site Agents yet", "Discovery has not run yet", "No artifacts yet", "No activity matches". The last of those is the **filtered-empty** copy showing in a never-had-any-data state, which tells a new owner a filter is hiding something. "Agents" labels the sidebar section, the card, and a row inside the card — three nestings of one word. The cold empty hub is genuinely fast (DCL 117 ms, 153 nodes) — this is a composition problem, not a performance one.

## [CAP-FB-20260829-AGENT-BOARD-01] The shared jobs board: agents post and claim work
- Feedback: 2026-08-29 — owner voice note: "agents should be able to ask other agents for work… the chaos extension had a shared message board and a shared jobs board"
- Updated: 2026-08-29 UTC
- Status: IN_REVIEW
- Priority: P1
- Owner: coordinator session
- Workspace: worker lane
- Branch: cap-agent-board
- Base: `c6406cc7`
- Candidate: see lane evidence at `~/.local/state/chrome-agent-platform/agent-board/`
- Shipping: —
- What it is: the async/broadcast complement to `delegate_to_agent`. A hub-level
  event-sourced board (jobs + messages logs in the master memory tier) where any
  named agent or the hub posts work, and any capable agent claims it (atomic
  claim + 5-minute lease + heartbeat, the scheduler's exact constants). Tools:
  board_post_job / board_claim_job / board_complete_job / board_send_message /
  board_list / board_read. Results ride back on the job record; the Tasks
  sidebar gains a "Board" grouping (open jobs + latest messages, bounded,
  textContent-only). Guards are pure functions in `extension/lib/agent-board.js`
  mirroring `agent-delegation.js`; caller identity comes from the route context
  (never model args).
- Permission model (owner decision 2026-08-29): v1 is FULLY OPEN among named
  agents + the hub. The guard seam (canPostJob/canClaimJob taking the agents
  registry) and the data model (targetAgent/requiredCapability fields, poster +
  claimant identity on every event) are built so a future per-edge deny layer
  slots in without redesign.
- DEFERRED (planned extensions, not in this lane): per-edge board permissions
  (the deny layer over the guard seam); automatic wake of idle agents on post
  (scheduler/alarm machinery — v1 wakes live surfaces via broadcastProgress);
  bidding/auctions; cross-device boards; A2A wire-protocol interop.
- History:
  - 2026-08-29 — lane built: board lib + SW routes + 6 management tools +
    capability/replay classifications + Tasks-sidebar grouping; 20 unit tests +
    12-check browser KAT (screenshot evidence) green; suite 2266/0.
  - 2026-08-29 — review round 1 REVISE (6×P1 + 3×P2) fixed: board log keys
    reserved from the model's memory_set/memory_get/keys (memory.js
    MASTER_RESERVED_KEYS + hidden namespace; the store uses setTrusted/
    getStrict); event-time lease expiry in the fold (expired claims are
    reclaimable); pruning preserves settled jobs an open job still depends
    on; both logs byte-bounded (192 KiB < the 256 KiB per-value cap) with
    superseded-heartbeat compaction + a fail-closed board-full post gate;
    stale model contexts denied (never hub-escalated); settlements commit
    the result to the poster's thread through the durable thread-commit seam
    (idempotent by board:<jobId>); visible row metadata (never title-only);
    the browser KAT now drives a REAL named-agent claim→complete via the
    @demo-board demo-model marker + asserts live UI refresh; heartbeat
    parity pinned. 31 unit tests + 22-check KAT green; suite 2277/0.
  - 2026-08-29 — review round 2 REVISE (3×P1) fixed: failed/malformed log
    reads propagate instead of becoming destructive empty-log writes (only a
    successful null read means absent; routes surface a structured
    board-store-error); byte/count eviction now leaves compact settled
    TOMBSTONES (identity + outcome + truncated result + delivery state) so
    acknowledged settlements stay retry-idempotent (alreadySettled) and
    readable, with full records capped separately from tombstones;
    poster-thread delivery is durable — the pending delivery persists WITH
    the settle event, the settle ACK waits on the idempotent
    board:<jobId> thread commit, and a startup drain plus the
    repeated-settle path re-attempt delivery. 37 unit tests + 22-check KAT
    green; suite 2283/0.

## [CAP-FB-20260829-MAIN-GATES-RED-03] Journey suite red on main after the install-granted permission change
- Feedback: 2026-08-29 — found by running the suite on `origin/main`
- Updated: 2026-08-29 UTC
- Status: DONE
- Priority: P0
- Owner: coordinator session
- Workspace: main
- Branch: main
- Base: `2c84f2fa`
- Candidate: —
- Shipping: —
- Acceptance: `npm run test:chrome` green at the tip, with the permission checks asserting the CURRENT install-granted model rather than deleted
- Review: author review 2026-08-29 with the falsification gate cleared
- Gates: journeys 120/120; unit 2243/0; build, tracker schema, gallery, vocabulary green
- Blockers: —
- Next: —
- Recover: `git grep -n "install-granted, not optional" -- scripts/chrome-journeys.ts`
- History:
  - 2026-08-29 — **fixed: 78/127 → 120/120.** Two of the three causes were product bugs the suite had correctly caught, not test drift.
    **(1) Test drift.** The product moved to 36 permanent install-granted permissions plus `host_permissions: ["<all_urls>"]`; the suite still drove `.grant-perm` / `.revoke-perm` controls that no longer exist. The 11 permission checks were rewritten as 4 that describe the real model: the manifest's install-granted shape, every capability granted at install (read from the worker's authoritative map rather than a DOM scrape that carried no ids), the Settings panel being a read-only diagnostic with zero controls, and `capability.revoke` still requiring owner approval. The enrollment and screenshot checks flipped from asserting a headless denial to asserting the now-reachable success path; refusal is still covered by the wrong-origin, expired-grant and post-revoke probes. `audioCapture`/`videoCapture` report not-granted under headless, so the panel check deliberately asserts read-only-ness rather than universal grantedness — otherwise it would fail for an environment reason.
    **(2) Product bug — every site-agent delete failed.** `unregisterOriginScripts` treated a per-origin host permission that `contains()` still reports as a teardown failure. Under `<all_urls>` that permission is permanent and `permissions.remove` cannot touch it, so deletion always returned `"host permission still present after remove"` despite having removed the scripts and cleared memory. Per-origin host revocation is now recognised as NOT APPLICABLE in that model, and the delete/retry routes no longer gate success on it. Their fallback error also claimed `"OPFS clear failed"` when clearing had succeeded; it now says what actually happened.
    **(3) Product bug — a revoke that could never succeed destroyed state first.** Every `capability.revoke` branch does its dependent teardown before removing the permission (scripting tombstones every enrolled origin so a running bridge is rejected from that instant). That ordering is right when revocation is possible, but a required manifest permission can never be removed — Chrome answers `"You cannot remove required permissions."` — so the operation took the origins' authority with it on the way to a guaranteed failure. `isRequiredCapability()` now refuses in `capabilities.js` before any branch runs. The journey asserts the corrected property directly: **a refused revoke tombstones NOTHING.**
    **Falsification:** removing the guard restores the destructive path and drives "a refused revoke tombstones NOTHING" RED (117/120); restoring returns 120/120. The delete fix was verified by observing the exact error string disappear from the route response between runs.


## [CAP-FB-20260827-DIALOG-CONSOLIDATION-01] Five dialog implementations, three hand-rolled
- Feedback: 2026-08-27 — product owner: "There's lots of issues with dialogs"
- Updated: 2026-08-27 23:30 UTC
- Status: IN_REVIEW
- Priority: P1
- Owner: coordinator session
- Workspace: main
- Branch: main
- Base: `139b6f92`
- Candidate: —
- Shipping: —
- Acceptance: every modal in the extension is raised through the shared component vocabulary — `<agent-dialog>` for a content dialog, `confirmActionDialog` for a decision — with no hand-rolled `document.createElement("dialog")` left outside `extension/shared/components.js`. Focus trap, Escape, backdrop light-dismiss, focus return, the destructive default-focus rule, scrollable overflow and theme/RTL/narrow behaviour are then identical everywhere by construction. Each converted site keeps its exact current semantics — in particular the provider-approval dialog must still be able only to DENY on dismissal, never approve
- Review: author review 2026-08-29 with the falsification gates cleared (see History); a11y behaviours driven in a real loaded extension by `scripts/kat-dialog-consolidation.ts` rather than asserted from source
- Gates: full unit suite; Chrome journeys green; gallery drift check green; the impeccable design pass
- Blockers: —
- Next: owner review of the three converted surfaces in the product. The remaining consolidation work — the ~30 other scripts and any future modal — is now prevented by construction rather than by convention, since there is one confirm and one shell
- Recover: `git grep -n 'createElement("dialog")' -- extension/`
- History:
  - 2026-08-29 — **all three hand-rolled dialogs converted; `createElement("dialog")` now appears exactly once in the extension, inside the shared component itself.** (1) `extension/artifacts/index.js` artifact delete → `confirmActionDialog`, gaining backdrop light-dismiss, an `aria-label` and a settled guard it did not have; its 13 lines of bespoke `.delete-dialog` CSS are deleted. (2) `confirmAgentProviderMutation` → the shared confirm. **This one carried a security property the shared confirm lacked** — approve only on a click that is `isTrusted` AND has active user activation — so rather than keep the duplicate for it, the property moved INTO the shared component as `requireGenuineGesture`, alongside `returnFocusTo` and `note`. Every future approval now gets it by construction instead of by remembering to re-implement it. (3) `editRecipePrompt` → `<agent-dialog>`, the content shell; it gains a close button and backdrop dismissal it never had, and its bespoke panel/backdrop CSS is replaced by the shell's. **Evidence, driven in a real loaded extension (`scripts/kat-dialog-consolidation.ts`, 18/18):** a destructive confirm focuses Cancel; a backdrop click resolves false and removes the node; a non-destructive confirm focuses the confirm control; **an untrusted scripted click cannot approve** and the refusal is explained in the dialog; Escape denies; the shell is announced by its title and its body scrolls on overflow. That last group is why this is a KAT and not only a unit test — a DOM shim cannot tell you whether `event.isTrusted` gating actually holds. **Falsification:** `tests/provider-options-approval.test.ts` pinned the OLD implementation's source lines and had to be rewritten; it now pins the property across BOTH halves (the call site must ASK for the check, the component must IMPLEMENT it and gate the true result on it), because asserting only one half would let the flag become a no-op or let the call site quietly stop passing it. Four deliberate regressions — call site drops the flag, component drops the trusted-click check, the guard warns without refusing, and the hand-rolled duplicate returns — each drove it red before being reverted. **Gates:** build clean; unit **2004 pass / 0 fail**; Chrome journeys **127/127**; gallery, vocabulary and tracker schema green.
  - 2026-08-27 23:30 UTC — captured by source audit. **Five dialog implementations ship.** Two are the intended shared ones in `extension/shared/components.js`: `<agent-dialog>` (the content-dialog shell) and `confirmActionDialog` (the promise-based confirm). Three are hand-rolled duplicates outside the component system: `extension/artifacts/index.js:83` (artifact delete), `extension/options/options.js:1236` (`confirmAgentProviderMutation`), and `extension/options/options.js:1555` (`editRecipePrompt`). This is precisely the failure mode the owner already named as a project rule — "never hand-roll a one-off version of an existing component (the blank-toggle + menu bugs came from hand-rolled duplicates)" — and it is the most likely explanation for dialogs behaving inconsistently: each of the five owns its own focus, dismiss, overflow and sizing behaviour, so a fix to one does not reach the others.
  - 2026-08-27 23:30 UTC — **good news worth recording:** `window.confirm` / `window.alert` / `window.prompt` are already fully eliminated from the extension; the only remaining occurrence is the explanatory comment above `confirmActionDialog`. `CAP-FB-20260823-DIALOG-CONFIRM-MODERNIZATION-01` is therefore substantially further along than its OPEN status suggests — what is left of that task is this consolidation.

## [CAP-FB-20260827-SETTINGS-MONOLITH-01] Settings is one 8.8-screen scroll with a nav that only scrolls
- Feedback: 2026-08-27 — raised during the pre-exec-demo UX audit
- Updated: 2026-08-29 UTC
- Status: OPEN
- Priority: P1
- Owner: unassigned (IA requires product-owner sign-off)
- Workspace: `cap-settings-cleanliness`
- Branch: `cap-settings-cleanliness`
- Base: `54c92834`
- Candidate: `cap-settings-cleanliness` (design + dead-control safe subset; pending review)
- Shipping: —
- Acceptance: opening Settings renders the requested section, not all twelve; the sidebar nav switches sections rather than scrolling to anchors; each section remains individually addressable by URL (the deep-link requirement the owner already set for the back-stack work); and the DOM node count on open drops substantially from the current 2,255. The single-history-entry back behaviour from `0.2.296` must be preserved
- Review: required — fresh-session review of the design and safe-subset diff; the later monolith implementation still requires before/after node counts and section heights from a real loaded extension
- Gates: Chrome journeys green (several journeys drive Settings sections by `.nav-item[data-section=...]`); a11y pass on the section switch (focus and heading order); the impeccable design pass
- Blockers: —
- Next: owner sign-off on the six-group IA in `docs/SETTINGS-CLEANLINESS.md`; then implement one selected group at a time without combining that architecture change with the reviewed dead-control removal
- Recover: `git grep -n 'section.panel' -- extension/options/options.html`
- History:
  - 2026-08-29 UTC — design-first cleanliness pass added `docs/SETTINGS-CLEANLINESS.md` with a six-group IA (Providers & models · Agents · Permissions & security · Tools · Data · Advanced). The safe subset removes only provably dead request-era UI: the unmatched Appearance nav/hash, the already-deleted Approvals hash, and the storage-verification button/component that could only repeat `permissions.contains()` for a required install grant. The long-page/one-section-at-a-time IA remains OPEN for owner sign-off.
  - 2026-08-27 23:30 UTC — measured in a real loaded extension: the Settings document is **12,837px tall — 8.8 viewport-heights — with 2,255 DOM nodes, and all twelve `section.panel` elements rendered and visible simultaneously** (`display:none` count: zero). The thirteen `.nav-item` controls scroll to anchors rather than switching views, so the information architecture the nav implies does not exist. Section heights: hooks 2,818 · permissions 2,182 · providers 1,762 · about 1,376 · tool-library 1,172 · prompts 1,016 · agents 729 · data 418 · local-folders 300 · background 269 · browser 211 · usage 202. Everything is built on every open regardless of what the owner came for.

## [CAP-FB-20260827-DEAD-COMPONENTS-01] Components ship to users but are only used by the gallery
- Feedback: 2026-08-27 — found during the pre-exec-demo UX audit
- Updated: 2026-08-27 23:30 UTC
- Status: OPEN
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `139b6f92`
- Candidate: —
- Shipping: —
- Acceptance: `theme-picker` is deleted (its feature was removed at `0.2.301`); each of `run-task-button`, `tool-chips`, `prompt-bar` and `agent-nav` is either adopted by the product or removed with a one-line reason; the gallery and the drift check stay green either way
- Review: independent review by a different model/session
- Gates: unit suite; `npm run check:gallery`; Chrome journeys green
- Blockers: `tool-chips` should NOT be deleted before `CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01` decides whether it becomes the collapsed tool representation
- Next: delete `theme-picker` — it is unambiguous dead code for a removed feature
- Recover: `git grep -n "customElements.define" -- extension/shared/components.js`
- History:
  - 2026-08-27 23:30 UTC — five custom elements are defined and shipped in `extension/shared/components.js` but referenced only by `docs/components.html`, never by any extension page: `theme-picker`, `run-task-button`, `tool-chips`, `prompt-bar`, `agent-nav`. `theme-picker` is straightforward dead code — theme switching was removed at `0.2.301` and the component was left behind, which is a miss against the owner's own cross-subsystem-consistency rule. The others are unbuilt primitives; `tool-chips` in particular may be exactly what the tool-card redesign needs, so it is called out as a blocker rather than deleted.


