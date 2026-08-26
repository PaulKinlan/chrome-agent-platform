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


## [CAP-FB-20260825-USAGE-AUTHORITY-PROBE-FAIL-01] usage-authority.test.ts PROBE-2/4 failing on main (usage-store CAS subsystem)

- Feedback: 2026-08-25 — discovered during independent review: `usage-authority.test.ts` PROBE-2 and PROBE-4 FAIL at exact base cde1166 AND at 7aaf8c6 (reproduced in clean worktrees). Pre-existing, NOT attributable to the persistence log-redesign (confirmed by two independent reviewers).
- Updated: 2026-08-25 12:55 UTC
- Status: MERGED
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `7aaf8c6`
- Candidate: —
- Shipping: `origin/main@ced852d` (0.2.259)
- Acceptance: usage-authority.test.ts PROBE-2/4 pass on main; the usage-store CAS subsystem's failing invariant identified and fixed (or the probe corrected if the expectation drifted); no other usage-authority probes regressed; full suite green.
- Review: pending independent review
- Gates: reproduce PROBE-2/4 on clean base; root-cause; fix + KAT; full suite green
- Blockers: —
- Next: reproduce PROBE-2/4 with verbose output, identify the failing usage-store CAS invariant
- Recover: `deno test -A tests/usage-authority.test.ts`
- History:
  - 2026-08-25 13:2x UTC — LANDED at 0.2.259. Root cause: probe expectation DRIFT (store correct, untouched) — the shared mkRow fixture hardcoded timestamp 2026-08-18, which aged past the deliberate RETENTION_MS=7-day retention, so sanitizeRow correctly discarded every fixture row at write time (PROBE-2/4 failed; PROBE-1/5/7 were passing vacuously asserting absence). Fix test-only: mkRow uses fresh timestamps; new PROBE-FIXTURE-GUARD pins the deliberate retention drop (8-day row discarded, fresh row lands) so the class fails loudly next time. Review PASS (Gemini cd381a1b), 1577/1577. Full suite now green.

  - 2026-08-25 12:55 UTC — captured from independent review evidence (k3 + Pro both reproduced on clean base).

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

Every task in this file that is not in a terminal state, most urgent first. **32 open**. The entry itself is always the authority; where it disagrees with this table, the entry wins.

Regenerate after any status change (this exact command reproduces the table below):

```sh
awk '/^## \[CAP-FB/{h=$0; sub(/^## \[/,"",h); id=h; sub(/\].*/,"",id); t=h; sub(/^[^]]*\] */,"",t)} /^- Status:/{s=$3} /^- Priority:/{if(s!="DONE"&&s!="MERGED"&&s!="ABANDONED"&&id!~/YYYYMMDD/) printf "%-3s %-10s %s — %s\n",$3,s,id,t}' TASKS.md | sort
```

| Priority | Status | Task | What it is |
|---|---|---|---|
| P0 | **BLOCKED** | [`CAP-FB-20260822-MV3-WASM-RUNTIME-PROBE-01`](#cap-fb-20260822-mv3-wasm-runtime-probe-01-loaded-mv3-wasm-runtime-and-termination-probe) | Loaded-MV3 Wasm runtime and termination probe |
| P0 | **BLOCKED** | [`CAP-FB-20260822-OWNER-WASM-INSTALL-01`](#cap-fb-20260822-owner-wasm-install-01-owner-selected-wasm-package-lifecycle) | Owner-selected Wasm package lifecycle |
| P0 | OPEN | [`CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`](#cap-fb-20260819-permission-remediation-ux-01-user-facing-permission-management-and-run-remediation) | User-facing permission management and run remediation |
| P0 | OPEN | [`CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01`](#cap-fb-20260820-semantic-tool-search-01-local-semantic-search-over-the-complete-tool-catalog) | Local semantic search over the complete tool catalog |
| P0 | IN_REVIEW | [`CAP-FB-20260821-WORKTREE-HYGIENE-01`](#cap-fb-20260821-worktree-hygiene-01-durable-worktrees-and-evidence-off-the-ram-backed-temp-filesystem) | Durable worktrees and evidence off the RAM-backed temp filesystem |
| P0 | OPEN | [`CAP-FB-20260822-BUILTIN-WASM-TOOLS-01`](#cap-fb-20260822-builtin-wasm-tools-01-provenance-clean-bundled-wasm-tool-tranche) | Provenance-clean bundled Wasm tool tranche |
| P0 | OPEN | [`CAP-FB-20260822-SPREADSHEET-TOOLKIT-01`](#cap-fb-20260822-spreadsheet-toolkit-01-bounded-spreadsheet-and-table-workflow-toolkit) | Bounded spreadsheet and table workflow toolkit |
| P0 | OPEN | [`CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01`](#cap-fb-20260822-tabular-diff-artifacts-01-read-only-tabular-diff-artifact-custody) | Read-only tabular-diff artifact custody |
| P0 | OPEN | [`CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01`](#cap-fb-20260822-tool-platform-abuse-gates-01-tool-platform-abuse-quota-and-lifecycle-gates) | Tool platform abuse, quota and lifecycle gates |
| P0 | IN_REVIEW | [`CAP-FB-20260822-WASM-EXECUTION-HOST-02`](#cap-fb-20260822-wasm-execution-host-02-gate-2-source-only-fresh-worker-host-recomposed) | Gate 2 source-only fresh-Worker host (recomposed) |
| P0 | OPEN | [`CAP-FB-20260822-WASM-TOOL-PLATFORM-01`](#cap-fb-20260822-wasm-tool-platform-01-co-do-style-browser-native-tool-operating-platform) | Co-do-style browser-native tool operating platform |
| P1 | **BLOCKED** | [`CAP-FB-20260819-PROACTIVE-TAB-DISCOVERY-01`](#cap-fb-20260819-proactive-tab-discovery-01-proactive-per-tab-site-agent-discovery-before-run) | Proactive per-tab Site Agent discovery before Run |
| P1 | OPEN | [`CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01`](#cap-fb-20260819-directory-tool-explorer-01-agent-directory-tool-explorer-and-enrollment-policy) | Agent Directory tool explorer and enrollment policy |
| P1 | OPEN | [`CAP-FB-20260819-UI-FLASH-RELAYOUT-01`](#cap-fb-20260819-ui-flash-relayout-01-intermittent-extension-wide-ui-flash-and-relayout-investigation) | Intermittent extension-wide UI flash and relayout investigation |
| P1 | OPEN | [`CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01`](#cap-fb-20260823-comprehensive-chrome-tools-01-comprehensive-chrome-extension-api-tool-coverage) | Comprehensive Chrome extension API tool coverage |
| P1 | OPEN | [`CAP-FB-20260823-DIALOG-CONFIRM-MODERNIZATION-01`](#cap-fb-20260823-dialog-confirm-modernization-01-replace-all-windowconfirm-with-native-dialog-modals) | Replace all window.confirm with native dialog modals |
| P1 | OPEN | [`CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01`](#cap-fb-20260823-extended-tool-families-01-extended-unixsystem-tool-family-admissions) | Extended Unix/system tool family admissions |
| P1 | OPEN | [`CAP-FB-20260823-PYODIDE-PYTHON-01`](#cap-fb-20260823-pyodide-python-01-python-in-the-browser-via-pyodide) | Python in the browser via Pyodide |
| P1 | OPEN | [`CAP-FB-20260825-DATA-EXPORT-IMPORT-01`](#cap-fb-20260825-data-export-import-01-owner-export-and-import-of-all-agent-data) | Owner export and import of all agent data |
| P1 | OPEN | [`CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01`](#cap-fb-20260825-headed-acceptance-lane-01-a-headed-browser-acceptance-lane) | A headed-browser acceptance lane |
| P1 | OPEN | [`CAP-FB-20260825-OWNER-DECISION-QUEUE-01`](#cap-fb-20260825-owner-decision-queue-01-product-decisions-blocking-tracked-work) | Product decisions blocking tracked work |
| P1 | OPEN | [`CAP-FB-20260825-SITE-AGENT-SHOWCASE-01`](#cap-fb-20260825-site-agent-showcase-01-make-sites-as-sub-agents-demonstrable-in-under-a-minute) | Make sites-as-sub-agents demonstrable in under a minute |
| P1 | OPEN | [`CAP-FB-20260825-UI-INTEGRATION-RED-01`](#cap-fb-20260825-ui-integration-red-01-scriptsui-integrationts-is-red-and-never-finishes) | scripts/ui-integration.ts is red and never finishes |
| P1 | OPEN | [`CAP-FB-20260825-WEBSTORE-RELEASE-01`](#cap-fb-20260825-webstore-release-01-the-path-to-a-published-extension) | The path to a published extension |
| P2 | IN_REVIEW | [`CAP-FB-20260823-AGENT-ICON-ON-CREATE-01`](#cap-fb-20260823-agent-icon-on-create-01-generate-the-agent-icon-at-creation-not-on-click) | Generate the agent icon at creation, not on click |
| P2 | IN_REVIEW | [`CAP-FB-20260825-AGENT-ROLE-PREVIEW-01`](#cap-fb-20260825-agent-role-preview-01-the-hub-agent-list-prints-the-whole-role) | The hub agent list prints the whole role |
| P2 | OPEN | [`CAP-FB-20260825-CONCURRENCY-RESIDUALS-01`](#cap-fb-20260825-concurrency-residuals-01-close-the-four-open-concurrency-verifications) | Close the four open concurrency verifications |
| P2 | OPEN | [`CAP-FB-20260825-DELEGATE-ATTACHMENTS-PROGRESS-01`](#cap-fb-20260825-delegate-attachments-progress-01-site-agent-delegation-is-text-only) | Site-agent delegation is text-only |
| P2 | OPEN | [`CAP-FB-20260825-I18N-FOUNDATION-01`](#cap-fb-20260825-i18n-foundation-01-no-internationalisation-foundation) | No internationalisation foundation |
| P3 | **BLOCKED** | [`CAP-FB-20260818-WIDER-REVIEW-01`](#cap-fb-20260818-wider-review-01-wider-goal-review-remediation-umbrella) | Wider-goal review remediation umbrella |
| P3 | OPEN | [`CAP-FB-20260821-RECIPES-SKILLS-RENAME-01`](#cap-fb-20260821-recipes-skills-rename-01-finish-the-recipes-to-skills-rename) | Finish the recipes to skills rename |
| P3 | OPEN | [`CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01`](#cap-fb-20260825-agent-picker-hub-rows-01-hub-agent-summary-rows-predate-the-shared-picker) | Hub agent summary rows predate the shared picker |

**Held by a product decision, not by engineering:** `CAP-FB-20260822-OWNER-WASM-INSTALL-01` and `CAP-FB-20260822-BUILTIN-WASM-TOOLS-01` wait on open questions Q13 and Q14, and `CAP-FB-20260825-WEBSTORE-RELEASE-01` on Q11. All three are collected in `CAP-FB-20260825-OWNER-DECISION-QUEUE-01` — clearing that entry unblocks the most work for the least effort.


## Active

## [CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01] Comprehensive Chrome extension API tool coverage

- Updated: 2026-08-26 — OWNER OVERRIDE: "add in them all if available on chrome
  (not Chrome os)". Scope expanded from the 16 named APIs to ALL desktop-Chrome
  extension APIs. Tranches: T1 windows/action/commands LANDED 0.2.205; T2
  alarms/bookmarks/notifications/idle/contextMenus LANDED 0.2.225; T3 tabGroups
  + T4 downloads DISPATCHED (flash lane); T5 system/topSites/permissions + T6
  readingList/pageCapture DISPATCHED (k3 lane); wave-2 batch 1 DISPATCHED
  (subagent workers): T7 sessions+history, T8 cookies/browsingData/contentSettings,
  T13 deep tab control (move/duplicate/pin/reload/back-forward/zoom/discard/highlight
  + action enable/disable + sidePanel options). Wave-2 batch 2 QUEUED: T9
  privacy/proxy/fontSettings/power/search/tts, T10 declarativeNetRequest/webNavigation/
  webRequest-observation, T11 management/runtime/sidePanel, T12 debugger-CDP/
  userScripts/scripting-registerContentScripts (+desktopCapture best-effort).
  EXCLUDED with rationale (not desktop-Chrome or dead): Chrome OS-only APIs
  (wallpaper, fileSystemProvider, fileBrowserHandler, networking.onc/config,
  vpnProvider, documentScan, printerProvider, loginState), enterprise.* policy APIs,
  MV2-only browserAction/pageAction, Chrome-App-era serial/usb/bluetooth/socket,
  identity/gcm (no local utility), processes (removed), speechRecognitionPrivate/
  metricsPrivate (private APIs). Prior Phase-1 exclusions (downloads.open, history,
  cookies, declarativeNetRequest, contentSettings) OVERRIDDEN by owner — all now
  included, grant-gated. Silent-broad-host-access and model-chosen-navigate-URL
  exclusions REMAIN (security invariants, need explicit per-origin consent flows).
- Feedback: 2026-08-23 — product owner (early request, still missing): the
  browser tools are NOT a comprehensive set of Chrome extension APIs. The
  tool is supposed to manage the entire browser, so the Chrome extension APIs
  should be available as tools. Missing examples named: chrome.action
  (icon/badge/background colour), alarms, bookmarks, downloads, contextMenus,
  commands, idle, notifications, pageCapture, permissions, readingList,
  scripting, sidePanel, system.memory, system.display, system.cpu, windows
  (create/manage), tabGroups, topSites. Example: a "sorting hat" background
  agent needs tabGroups but there's no tabGroups tool. The existing
  management tools are liked; the rest is missing
- Status: OPEN
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `bd85bf7`
- Candidate: —
- Shipping: —
- Acceptance: an inventory of ALL chrome.* extension APIs, marking which are
  already exposed as tools and which are missing; the missing high-value APIs
  (action, alarms, bookmarks, downloads, contextMenus, commands, idle,
  notifications, pageCapture, permissions, readingList, scripting, sidePanel,
  system.*, windows, tabGroups, topSites) become bounded, permission-gated
  tools with truthful schemas; each respects the owner-permission model and
  does not silently broaden grants; dangerous/irrelevant APIs explicitly
  excluded with rationale
- Review: pending independent API-coverage/permissions/schema review
- Gates: coverage inventory table; per-API bounded schema; permission gating;
  no silent grant broadening; exclusion rationale for unsafe APIs
- Blockers: needs a design/inventory phase before implementation; composes
  with the permission model and the lazy tool catalog
- Next: produce the chrome.* API inventory + gap plan + per-API tool design
- Recover: `git grep -n "chrome\.\|browserToolset\|managementToolset" -- extension/lib`
- History:
  - 2026-08-23 23:20 UTC — Phase 1 inventory DONE (Pro,
    /tmp/cap-chrome-api-coverage/PRO.md 16505d51): exposed today = tabs,
    sidePanel, scripting.executeScript(read_page), storage via 9 browser + 27
    management tools; ALL 16 owner-named APIs missing. Tranche plan:
    T1 windows+action+commands (read-only, no new permission) →
    T2 alarms+bookmarks+notifications+idle+contextMenus (already declared) →
    T3 tabGroups (sorting-hat unlock) → T4 downloads+scripting-register →
    T5 system.memory/display/cpu+topSites+permissions-read →
    T6 readingList+pageCapture (most sensitive). 10 explicit exclusions
    (silent broad host access, declarativeNetRequest, webNavigation, history,
    proxy/vpn, downloads.open, model-chosen navigate URLs,
    notification-onclick-to-model-URL, contentSettings/cookies,
    enterprise.management.install). TRANCHE 1 DELIVERED (K3, 797f101, in
    review): 8 tools — windows list/create/focus/close/move, action
    set/get state, commands list — zero new manifest permissions, grant-lock
    origin re-reads (smuggle-class defense), owner-scoped action state,
    registry parity 46 tools, 1309/1309 suite. LANDED as 0.2.205 (`origin/main@0d308ce`)
  - 2026-08-24 15:55 UTC — TRANCHE 2 LANDED (0.2.225,
    origin/main@4e4cdee967d6355f0d9b4246000e343d2f29b100): 12 tools — alarms
    create/list/clear, bookmarks create/list/remove, notifications
    notify/clear, idle query, contextMenus create/list/remove; all five
    permissions already-declared (manifest version-only); 58 total platform
    tools; dangerous-pair verified (context enum only, no onclick/click-URL
    authority).
  - 2026-08-23 23:05 UTC — captured from product-owner voice feedback;
    revives the early "go through all Chrome extension APIs and create tools"
    request.

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
  - 2026-08-23 22:45 UTC — feasibility research verdict FEASIBLE-WITH-CAVEATS
    (Pro, /tmp/cap-pyodide-feasibility/PRO.md 869b8098): core 8–12 MB fits a
    NEW default-tier admission (not tiny); MPL-2.0 in allowlist, CPython
    PSF-2.0 needs a one-line addition; CSP already has wasm-unsafe-eval so the
    core loads but eval/exec must be top-level-only; OPFS content-addressed
    cache + per-job scratch; separate Emscripten dispatcher profile (no WASI
    host widening); MVS = a stdin/stdout python tool over the cached core
    reusing package authority.
  - 2026-08-23 22:05 UTC — captured from direct product-owner feedback.


## [CAP-FB-20260823-AGENT-ICON-ON-CREATE-01] Generate the agent icon at creation, not on click

- Feedback: 2026-08-23 — product owner: when an agent is created, its icon
  should be generated immediately, not lazily on click
- Updated: 2026-08-23 20:35 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: `/home/paulkinlan/worktrees/cap-agent-icon-1dfcb86`
- Branch: detached
- Base: `1dfcb865a064ded345ab661dbb26dff31db0dca9`
- Candidate: GLM implementation (bounded creation-time avatar follow-up)
- Shipping: —
- Acceptance: agent creation produces the icon as part of the creation
  transaction (or bounded immediate follow-up) so every surface shows the
  final icon without a click-triggered generation; failure falls back to a
  deterministic placeholder, never a broken image
- Review: pending independent storage, failure-fallback and loaded-MV3 review
- Gates: create-then-list shows icon; generation failure placeholder;
  no click dependency; storage bound
- Blockers: —
- Next: locate the lazy icon generation call site and move it into creation
- Recover: `git grep -n "icon" -- extension/lib extension/shared`
- History:
  - 2026-08-23 20:35 UTC — captured from direct product-owner feedback.
  - 2026-08-23 21:20 UTC — diagnosis: the ONLY generator was the edit-dialog
    "Regenerate avatar" button (named-agent.avatar returns a preview; the icon
    persisted only when the owner clicked). Fix: `generateAvatarForCreatedAgent`
    (lib/named-agents.js, dependency-injected + time-bounded 20s) runs as a
    bounded immediate follow-up inside the SW `named-agent.create` handler —
    never blocking the create response, only when the created agent has no
    avatar, persisting ONLY if the stored agent still has none (a concurrent
    owner edit always wins). No key / generation failure / timeout / agent
    gone → avatar stays null and every render surface keeps the deterministic
    initialAvatar placeholder (data:image/svg+xml — never a broken image,
    existing onerror fallback unchanged). Storage bounded: the existing
    128px-JPEG downscale. Covers BOTH creation paths (UI dialog + the model's
    named_agent.create management tool — same route). Gates:
    agent-icon-on-create (new, 6) + named-agents + named-agents-provider +
    agent-registry + named-agent-provider-route + sw-route-modularization +
    owner-approval-security + dialog-confirm-modernization + tools-management —
    107/107.


## [CAP-FB-20260823-DIALOG-CONFIRM-MODERNIZATION-01] Replace all window.confirm with native dialog modals

- Feedback: 2026-08-23 — product owner: per modern web guidance, every
  `window.confirm` usage should become a native `<dialog>` modal popup
- Updated: 2026-08-23 20:08 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `aca0759e6a8ebfe82c9dba0650566eeeb15334d0`
- Candidate: —
- Shipping: —
- Acceptance: an exhaustive inventory of blocking prompt/confirm usage is
  replaced by native `<dialog>` elements with focus trapping, Escape/cancel
  semantics, promise-based results, and theme/RTL/narrow correctness; no
  blocking synchronous dialogs remain; destructive confirmations name the
  exact object being acted on
- Review: pending independent UX, accessibility, focus-management and
  loaded-MV3 review
- Gates: full inventory before/after; dialog AX labels and focus order;
  cancel/deny mutate nothing; keyboard-only flows; narrow/RTL/theme
  screenshots
- Blockers: —
- Next: inventory every window.confirm/window.prompt/alert call site in
  extension pages and side panel
- Recover: `git grep -n "window.confirm\|window.prompt\|window.alert" -- extension`
- History:
  - 2026-08-23 20:08 UTC — captured from direct product-owner feedback with
    the explicit instruction to follow modern web guidance.

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
- Next: design the owner-only inbox + paused-run resume state machine from `docs/permission-remediation-design.md` under the settled policy — grants remembered at the narrowest practical scope, no per-invocation prompts, explicit broad host grant allowed and revocable; recoverable permission problems pause visibly and resume after resolution
- Recover: `git show bbeff7b:TASKS.md && git grep -n "permissions.request\|optional_permissions\|all_urls" bbeff7b -- extension`
- History:
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
- Priority: P0
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
- Priority: P0
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
- Priority: P0
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
- Priority: P0
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
  - 2026-08-22 18:48 UTC — implemented only the PASSed source design on exact
    public `462d21d`; no route, Chrome run, execution, UI or mutation was added.

## [CAP-FB-20260822-OWNER-WASM-INSTALL-01] Owner-selected Wasm package lifecycle

- Feedback: 2026-08-22 — the long-term platform should let owners install
  reviewed local packages without making installation model-callable or silently
  broadening authority
- Updated: 2026-08-22 20:12 UTC
- Status: BLOCKED
- Resume: OPEN
- Priority: P0
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
- Priority: P0
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
  - 2026-08-22 09:30 UTC — opened as a later functional tranche; this catalog
    slice contains no spreadsheet runtime or UI.

## [CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01] Tool platform abuse, quota and lifecycle gates

- Feedback: 2026-08-22 — every tool-platform phase needs adversarial and
  exact-browser gates rather than a security pass deferred until the end
- Updated: 2026-08-22 09:30 UTC
- Status: OPEN
- Resume: —
- Priority: P0
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
- Priority: P0
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
- Updated: 2026-08-22 07:30 UTC
- Status: IN_REVIEW
- Resume: OPEN
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
- Blockers: the dirty worktrees (tracked + untracked changes) must be preserved or consciously reconciled first; the durable/tmpfs relocation of the remaining worktrees is deferred until then
- Next: Residual: no candidate commit exists; the 18 dirty worktrees (tracked + untracked) must be preserved or consciously reconciled before any destructive cleanup, and the durable/tmpfs relocation is deferred until then. Next action: run `node scripts/worktree-audit.mjs` (read-only), agree the dirty-preservation plan with the owner, then (a) remove the clean worktrees holding nothing beyond origin/main + `git worktree prune`, (b) bind the unreachable detached heads under `rescue/*` tags, (c) move the durable evidence off the RAM-backed tmpfs.
- Recover: `git worktree list --porcelain && git tag -l 'rescue/*' && git fsck --unreachable`
- History:
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
- Next: produce the full occurrence inventory across code, storage keys, routes, tests and docs before renaming anything
- Recover: `git grep -in "recipe" -- extension lib tests scripts docs`
- History:
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
- Candidate: —
- Shipping: —
- Acceptance: a documented, repeatable headed run that covers the three gaps currently recorded as permanently open — (a) a screenshot success path, since headless auto-denies arbitrary-tab capture; (b) one full enrollment lifecycle as a single journey: enroll, discover, invoke, clean up, retry; (c) the two WebMCP operating-system permission prompts from `docs/WEBMCP-ACCEPTANCE.md`. The run states plainly which steps needed a human click and which were automated; its evidence is written to durable storage, never to a RAM-backed filesystem; a headless run continues to pass unchanged and continues to assert fail-closed behaviour
- Review: independent review that the headed path exercises production code rather than a test-only shortcut — the round-28 WebMCP block was caused by acceptance that bypassed the implementation
- Gates: the headed run itself, with retained screenshots; the existing headless suites still green and still asserting fail-closed denial; explicit labelling of every manual gesture
- Blockers: needs a machine with a display. If none is available, that must be recorded as the blocker with a named owner rather than leaving three residuals permanently open in `KNOWN-ISSUES.md`
- Next: confirm whether a headed environment is available at all; if not, mark this `BLOCKED` with that owner and stop re-litigating the three residuals separately
- Recover: `grep -n "headed\|HEADED" scripts/webmcp-acceptance.ts && sed -n '1,40p' docs/WEBMCP-ACCEPTANCE.md`
- History:
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

## [CAP-FB-20260825-KEYBOARD-COMMANDS-01] No keyboard shortcuts anywhere
- Feedback: 2026-08-25 — independent gap review found the manifest declares no `commands`, so a power-user tool aimed at people who return to it repeatedly across a day cannot be reached or driven from the keyboard
- Updated: 2026-08-25 17:10 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: claude-opus-5 implementer session
- Workspace: active (local path private)
- Branch: detached candidate on `origin/main`
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: this commit
- Shipping: —
- Acceptance: a small, deliberate set of shortcuts — open the hub, start a task, open the side panel, focus the composer — declared in the manifest, remappable through Chrome's own shortcut settings, and discoverable in-product; the set is small enough to be memorable rather than exhaustive; no shortcut fires a destructive or permission-granting action; nothing conflicts with a common browser default
- Review: author self-review 2026-08-25 (findings recorded in History and fixed); **no independent review** — the product owner asked the author to review directly
- Gates: 18/18 loaded-MV3 checks on a fresh profile — `chrome.commands.getAll()` reports all three with real bound chords; `#compose` focuses the composer on BOTH the already-open-tab path and the fresh-tab boot path; no command injects task text; the side-panel command finds `sidePanel` ungranted and fails closed without requesting it; Settings lists the chords Chrome actually reports. Plus 6 unit tests, full unit suite, gallery drift, changelog and tasks-schema gates
- Blockers: —
- Next: an independent pass on the permission and payload constraints if one becomes cheap; otherwise closed
- Recover: `git grep -n "KEYBOARD_COMMANDS\|hubUrlForCommand" -- extension && python3 -c "import json;print(json.load(open('extension/manifest.json'))['commands'])"`
- History:
  - 2026-08-25 17:10 UTC — **AUTHOR SELF-REVIEW, not the independent review the lifecycle requires.** The product owner asked for the review directly, so it was done by the same session that wrote the change. Recorded as such: a self-review cannot cover what the author was blind to, which is the whole point of the different-model rule. Four defects were found across the three changes and fixed in one commit; details in each entry below. An independent pass is still worth having on the permission and payload constraints.
  - 2026-08-25 17:10 UTC — self-review found one defect. **MEDIUM:** the side-panel command's permission guard did not guard — `chrome.permissions?.contains?.(…).catch(…)` yields `undefined` when `contains` is missing and `.catch` on `undefined` throws, so the fail-closed-with-a-reason path could never run in precisely the situation it existed for. Rewritten as try/catch with an explicit `=== true`; the active-tab lookup had the same shape and was fixed with it. Re-verified 18/18 in a loaded extension afterwards. Fixed in `6320fd8`.
  - 2026-08-25 14:10 UTC — implemented and verified in a real loaded extension. Three commands: `open-hub` (`Alt+Shift+H`), `new-task` (`Alt+Shift+K`, lands on the hub with the composer focused) and `open-side-panel` (`Alt+Shift+S`). The acceptance named four; "start a task" and "focus the composer" collapse into the same action, so shipping a fourth redundant chord was rejected rather than padded to match the wording.
  - 2026-08-25 14:10 UTC — **the browser run caught two real defects that source review would not have.** (1) Chrome SILENTLY DROPPED `Alt+Shift+A`, `Alt+Shift+N`, `Alt+Shift+T` and `Alt+Shift+C` — a dropped `suggested_key` produces no error and no binding, so the shortcuts would simply never have fired. The shipped chords were chosen by probing what Chrome actually binds, not by reading a reserved-key list. (2) `#compose` did nothing when a hub tab was already open: setting the hash is a `push` navigation and `shouldDispatchForNavigationType` deliberately suppresses those, so the router never saw it. A `hashchange` listener now handles that one focus-only route; it touches no view state, so it cannot race the dispatcher.
  - 2026-08-25 14:10 UTC — constraints enforced in code, not just documented: no command is destructive; none calls `chrome.permissions.request` (a key chord is not a gesture aimed at a specific grant, so a prompt from one would be a consent dark pattern); the side-panel command checks `permissions.contains` and fails closed with an actionable diagnostic; no command carries a payload, so a shortcut can never inject task text. Settings renders `chrome.commands.getAll()` rather than the manifest's suggested keys, so it stays truthful after an owner remaps or clears a binding.
  - 2026-08-25 12:30 UTC — ownership: unassigned → claude-opus-5 implementer session (taking the lane; no other session is on it per the 00:14 fleet board)
  - 2026-08-25 09:40 UTC — opened. Verified absent: `extension/manifest.json` contains no `commands` key.

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

## [CAP-FB-20260825-TRACKER-INTEGRITY-01] Enforce the tracker's own entry schema
- Feedback: 2026-08-25 — a gap sweep found three entries violating the schema this file defines: two headings with no body at all, and one heading carrying three complete field sets with conflicting statuses
- Updated: 2026-08-25 17:10 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: claude-opus-5 implementer session
- Workspace: none
- Branch: `origin/main`
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: this commit
- Shipping: —
- Acceptance: `CAP-FB-20260822-WASI-FDSTAT-FLAGS-01` is resolved — it holds **three** field sets under one heading (`DONE`, `IN_REVIEW`, `DONE`), so its real state is unreadable and any tool or reader gets a different answer depending on which one it takes. The 2026-08-25 archive split read only the first and moved it to `TASKS-DONE.md`, so a field set reading `IN_REVIEW` is now filed as completed work. Either split it into distinct IDs for the distinct pieces of work, or reconcile it to a single authoritative field set with the superseded history moved into `History`. Separately, a check runs as the first step of `npm run test:all` (this repository has no CI) and fails when any heading does not carry exactly one of each schema field, when a `Status` or `Priority` value is outside the declared set, or when a `CAP-FB` ID is duplicated or reused across `TASKS.md` and `TASKS-DONE.md`
- Review: author self-review 2026-08-25 (findings recorded in History and fixed); **no independent review** — the product owner asked the author to review directly
- Gates: the schema check run against the current file, demonstrated failing on a deliberately malformed entry and passing on the corrected file; the `Open work queue` index regenerated and matching the checker's output exactly
- Blockers: —
- Next: an independent pass on the FDSTAT field-set split if one becomes cheap; otherwise closed
- Recover: `awk '/^## \[CAP-FB/{id=$0} /^- Status:/{print id}' TASKS.md TASKS-DONE.md | uniq -c | awk '$1!=1'`
- History:
  - 2026-08-25 17:10 UTC — **AUTHOR SELF-REVIEW, not the independent review the lifecycle requires.** The product owner asked for the review directly, so it was done by the same session that wrote the change. Recorded as such: a self-review cannot cover what the author was blind to, which is the whole point of the different-model rule. Four defects were found across the three changes and fixed in one commit; details in each entry below. An independent pass is still worth having on the FDSTAT field-set split.
  - 2026-08-25 17:10 UTC — self-review found one defect. **LOW:** the gate was wired to nothing. Its acceptance said "a check runs in CI", but this repository has no CI, so that was unachievable as written rather than merely unfinished. It is now the first step of `npm run test:all`, the aggregate gate that is actually run. Fixed in `6320fd8`.
  - 2026-08-25 12:55 UTC — **root cause found and repaired.** The three field sets under the `CAP-FB-20260822-WASI-FDSTAT-FLAGS-01` heading were not duplicates: they were the missing bodies of the two headings that had none. The `IN_REVIEW` set is verbatim `CAP-FB-20260822-WASM-EXECUTION-HOST-02` (Gate-2 recomposed source, branch `recompose/gate2-6662dfa`, candidate `086ee3d`) and the `DONE` set is verbatim `CAP-FB-20260822-WASM-EXECUTION-HOST-01` (pure WASI host contract, shipped `462d21d`). Each was moved to its own heading with no field value altered, replacing the conservative placeholders written on 2026-08-25 09:40. `-02` is therefore genuinely `IN_REVIEW` with real reviewed work behind it, not the unknown-scope `BLOCKED` recorded earlier. A stray `- Next:` line describing `086ee3d` had also been dropped mid-Gates inside the `-01` text; it moved to `-02` where its candidate lives. FDSTAT now carries exactly one field set, describing `fd_fdstat_set_flags` only, with its own fields unchanged.
  - 2026-08-25 12:55 UTC — gate landed: `scripts/check-tasks.mjs` / `npm run check:tasks`, proven to fail on both real defects (a body-less heading and the three-field-set entry) and to pass on the repaired files. 37 violations predating the gate are baselined rather than mass-edited, because they sit in entries owned by live lanes; the gate is strict for anything new. `Resume` is now required only on `BLOCKED` entries — it was omitted on 23 entries, which is the fleet having already voted against requiring it everywhere.
  - 2026-08-25 12:30 UTC — ownership: unassigned → claude-opus-5 implementer session (taking the lane; documentation/tooling only, no code-lane collision)
  - 2026-08-25 09:40 UTC — opened. The two empty headings (`CAP-FB-20260822-WASM-EXECUTION-HOST-01` and `-02`) were recovered in this same commit and are not part of this task; the FDSTAT merged-heading defect and the missing check are.

## [CAP-FB-20260822-WASM-EXECUTION-HOST-02] Gate 2 source-only fresh-Worker host (recomposed)
- Feedback: 2026-08-22 — the reviewed package host needs hard termination,
  byte-bounded sync workspaces, an audit-before-instantiate scan and a bounded
  result envelope before any route can reach it
- Updated: 2026-08-22 20:30 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: recomposed source candidate on this branch
- Workspace: active (local path private)
- Branch: `recompose/gate2-6662dfa`
- Base: `6662dfa2870ef1729b7e3ba68c3393d40f7db474`
- Candidate: this commit (`086ee3d` PASSed source, renumbered `0.2.159`)
- Shipping: —
- Acceptance: the recomposed source tree preserves the PASSed Gate-2 facts —
  synchronous per-job workspace, audit-before-instantiate, the exact 15-key
  result envelope with bounded stdout/stderr content, one finish() for
  timeout/abort, scanner-owned execution-host exemption (fixed canonical path
  + exact call shape) and the scanner-owned worker-host exemption (the one
  non-literal fresh-Worker construction); executor/offscreen host remain
  UNREACHABLE source-only until a separately reviewed route successor lands
- Review: the recomposed source PASSed independent review as `086ee3d`; that exact object was renumbered to the `0.2.159`/`0.2.160` landing, so the recorded candidate is not an ancestor of main and the review verdict is not yet bound to a reachable commit
- Gates: final independent review PASS on `086ee3d` (26/26 focused, full
  1056/1056, build rc 0); recomposed gates re-run on this commit

- History:
  - 2026-08-25 12:30 UTC — recovered by `CAP-FB-20260825-TRACKER-INTEGRITY-01`. This field set had been concatenated under the `CAP-FB-20260822-WASI-FDSTAT-FLAGS-01` heading, which carried three complete field sets while this entry's own heading carried none. Restored verbatim; no field value was altered by the move.
  - 2026-08-22 20:40 UTC — Store package scan after the recomposed push passed
    ABSOLUTE source paths to the scanner; the canonical exemptions compared only
    relative paths and flagged the execution-host Wasm + worker-host Worker
    constructions. Fixed with a scanner-owned canonical path matcher
    (`isCanonicalScannedPath`) that accepts the exact normalized repo tail
    (relative or absolute) and rejects lookalikes/suffix tricks; added
    absolute-positive + lookalike-negative tests for BOTH exemptions. Store
    package build/package/validate pass on `0.2.160`.
- Blockers: the recorded candidate `086ee3d` is not an ancestor of `origin/main`; the Gate-2 semantics it carries are byte-contained on main at `aca0759` under the renumbered landing, so the candidate reference must be reconciled before this entry can advance
- Next: the Gate-2 semantics (wasm-execution-worker/executor/bounds/offscreen-host/sync-workspace + the scanner-owned canonical exemptions) are byte-contained on main at aca0759; the recorded candidate 086ee3d is NOT an ancestor (renumbered to the 0.2.159/0.2.160 landing). Next action: reconcile the Candidate field to the renumbered tip, confirm the supersession, then advance to MERGED.
- Recover: `git show 086ee3d -- extension/lib/wasm-execution-worker.js
  extension/lib/wasm-executor.js extension/lib/wasm-executor-bounds.js
  extension/lib/wasm-offscreen-host.js extension/lib/wasm-sync-workspace.js
  tests/wasm-fixture-builder.mjs tests/wasm-host-gate2.test.ts
  scripts/scan-shipped.mjs build.mjs`

## [CAP-FB-20260825-MAIN-GATES-RED-01] Main is red: Chrome journeys abort and two usage probes fail
- Feedback: 2026-08-25 — an unrelated lane ran the full gates before landing and found three failures already on `origin/main`; both suites reproduce identically with all local work stashed
- Updated: 2026-08-25 17:10 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: claude-opus-5 implementer session
- Workspace: active (local path private)
- Branch: detached candidate on `origin/main`
- Base: `0626e6b`
- Candidate: this commit and its parent
- Shipping: —
- Acceptance: `deno run -A scripts/chrome-journeys.ts` reaches 126/126 again, and `tests/usage-authority.test.ts` PROBE-2 and PROBE-4 pass. Each failure is traced to the commit that introduced it and fixed there, or explicitly reclassified with evidence if the assertion — not the product — is what is wrong
- Review: author self-review 2026-08-25 (findings recorded in History and fixed); **no independent review** — the product owner asked the author to review directly
- Gates: Chrome journeys **127/127** (was 91/126 on untouched main); unit **1584/0**; security suite PASS; build, gallery drift, changelog and tasks-schema green. The regression test was verified to fail against the unfixed router with the exact production error
- Blockers: —
- Next: an independent pass on the durable key routing and thread-id validation if one becomes cheap; otherwise closed
- Recover: `deno run -A scripts/chrome-journeys.ts 2>&1 | tail -5 && deno test -A tests/usage-authority.test.ts 2>&1 | tail -5`
- History:
  - 2026-08-25 17:10 UTC — **AUTHOR SELF-REVIEW, not the independent review the lifecycle requires.** The product owner asked for the review directly, so it was done by the same session that wrote the change. Recorded as such: a self-review cannot cover what the author was blind to, which is the whole point of the different-model rule. Four defects were found across the three changes and fixed in one commit; details in each entry below. An independent pass is still worth having on the durable key routing and thread-id validation.
  - 2026-08-25 17:10 UTC — self-review found two defects in this change. **HIGH:** the durable thread-id charset admitted `..`; `encodeURIComponent("..")` is `".."`, so the key reached a directory name and was refused only because OPFS happens to reject it. The original test covered `../escape` (already rejected for the slash) and not the bare form — the test looked thorough and was not. Dots removed from the charset; `..`, `.` and the length bound are now covered. **MEDIUM:** making the index persist meant every deleted thread leaked `durable/threads/<id>` forever, against the memory-resilience constraint; `deleteThread` now reclaims it best-effort. Both fixed in `6320fd8`.
  - 2026-08-25 16:05 UTC — **all three failures resolved; the suite is green.** The usage-authority probes were fixed independently by another lane (`ced852d`). The remaining two were one product bug and one stale test, not the same thing.
  - 2026-08-25 16:05 UTC — **P0 product bug.** `agent.run` returned `invalid durable-run key: thread-runs:<threadId>` for EVERY task. The 0.2.257 log redesign (`ee970b3`) added a `thread-runs:<threadId>` reverse index written through `durableRunMemory`, but the durable key router only understood `run-registry` and the five `run*:<executionId>` prefixes; a thread id is not an execution id, so `durableStoreForKey` threw, and because every run links its thread on the way in the throw took the run with it. The router now gives `thread-runs:` its own bounded per-thread store mirroring the per-execution layout, `keys()` enumerates them, and thread ids are validated against a bounded safe charset (`thread-runs:../escape` and an empty id are rejected). No migration: the feature never successfully wrote a key. This single bug was killing the five journey checks that ask the agent to actually produce a result.
  - 2026-08-25 16:05 UTC — **stale test, product correct.** The suite aborted at "pending owner approval did not render in exact Settings" and lost the last 30 checks. `ab02213` made `asset.delete`/`agent.delete`/`named-agent.delete`/`recipe.delete` owner-direct, so an owner surface click no longer queues an approval; three journey steps still waited for a row that is now correctly never created. Disenroll now asserts the new behaviour POSITIVELY (a genuine owner click leaves no `agent.delete` approval queued) rather than simply dropping the old assertion, and the deny/worker-restart paths moved to `asset.update`, which is still gated and exercises the identical deny flow — coverage preserved, not removed.
  - 2026-08-25 14:40 UTC — opened with attribution evidence. **Chrome journeys: 96/126**, aborting at `journey failure: pending owner approval did not render in exact Settings`, immediately after `Settings: Disenroll button present for an enrolled agent`; the remaining 30 checks report `(not reached)`. **Unit: `tests/usage-authority.test.ts` PROBE-2** ("a concurrent initializer loser must mirror the WINNING authority, not its own" — `authority holds the migrated legacy row exactly once`) **and PROBE-4** ("after corruption repair, a valid write succeeds") fail. All three were reproduced on pristine `0626e6b` with unrelated local work stashed, and again with it restored, at the identical abort point — so they predate that work and are not caused by it. Filed rather than fixed in passing: the journey abort sits in the approvals/enrollment path and the usage probes in the ledger, both owned by other lanes.

## [CAP-FB-20260825-DATA-MEMORY-CLEAR-01] Data & memory Clear looks like it does nothing
- Feedback: 2026-08-25 — product owner: "The clear button doesn't work in Data & memory (at least for site agents)."
- Updated: 2026-08-25 19:20 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: claude-opus-5 implementer session
- Workspace: active (local path private)
- Branch: detached candidate on `origin/main`
- Base: `2c25e82`
- Candidate: this commit
- Shipping: this commit on `origin/main`
- Acceptance: clicking Clear on a site agent's row in Settings → Data & memory visibly empties that store without a reload — the memory explorer's key count for the origin drops to zero; the store really is empty; the agent stays enrolled, because clearing memory is not a revocation; and the owner is told what actually happened rather than being shown a success message the code never checked
- Review: author self-review 2026-08-25 (two further defects found and fixed, below); **no independent review** — the product owner asked the author to review directly
- Gates: `scripts/data-memory-clear.ts` **13/13** on a clean profile, with both regressions verified to FAIL against the unfixed code (`before=4 after=4` for the stale count, `after=[]` for the collapsed tree); unit 1591/0; Chrome journeys 127/127; security suite PASS
- Blockers: —
- Next: an independent pass if one becomes cheap; otherwise closed. `extension/memory/explorer.js` is a separate removal candidate, not a fix for this report
- Recover: `npm run test:data-clear && git grep -n "renderMemoryExplorer" -- extension/options/options.js`
- History:
  - 2026-08-25 19:20 UTC — **author self-review, not independent.** Two further defects found in my own fix, both fixed here. **(1) I introduced a UX regression:** making the explorer refresh meant it rebuilt the whole tree with every node collapsed, so clearing snapped shut whatever the owner had expanded — on precisely the refresh where they are looking at that store. Expansion is now keyed by a stable `data-mem-id` and restored across the rebuild, and a restored store re-fetches its (now empty) keys. Individual key/value nodes are deliberately NOT restored: their content can be stale after a clear, and collapsing one is far less disruptive than losing the tree. **(2) A third Clear button exists** in `extension/memory/explorer.js` with the same ignore-the-result shape. It is NOT reachable — nothing in the extension, tests or scripts links `memory/explorer.html` — so it is not the button in this report and is recorded as a removal candidate rather than fixed in place, which would have meant maintaining a dead surface.
  - 2026-08-25 19:20 UTC — also checked and found clean: every other `memory.clear` caller tolerates the new result shape (`scripts/opfs-real-browser.ts`, `scripts/chrome-journeys.ts` and the route-modularization test all ignore or destructure it safely).
  - 2026-08-25 18:30 UTC — reproduced exactly as reported and fixed. The data WAS being cleared; the UI just never showed it. The origin-row handler called `renderData()` (which redraws the enrolled-origins list, unchanged by a clear) but not `renderMemoryExplorer()` — and the explorer is the surface that displays keys and counts, so it kept showing the cleared store's old count until a reload. Both Clear handlers now refresh both surfaces.
  - 2026-08-25 18:30 UTC — second defect found while fixing the first: `memory.clear` resolved to `undefined`, so neither handler could tell success from failure and both flashed "Cleared…" unconditionally. The route now returns `{ok:true, origin}` or `{ok:false, error}`, and both handlers report the real outcome. A button that lies about having worked is the same class of bug as one that does nothing.
  - 2026-08-25 18:30 UTC — checked and ruled out a worse possibility: `clear()` does remove the site store's `enrolled` key, but enrollment authority does not live there, so a clear never silently disenrolls a Site Agent. Asserted in the new script so it stays true.
  - 2026-08-25 18:30 UTC — coverage lives in a dedicated `scripts/data-memory-clear.ts` on a clean profile rather than inside the 127-check journey suite. Adding it there first was tried and rejected: the fixture had to be created mid-suite, where accumulated global state (a revoked `storage` capability, several enrolled origins) made the explorer assertions unreliable, and the extra enrolled origin made a later step's first-match `.origin-row .disenroll-origin` click remove the wrong agent. A focused script tests the button instead of the suite's history.


## [CAP-FB-20260825-SITE-DISCOVERABILITY-01] Site-agent discoverability + content-script boot reconciliation

- Feedback: 2026-08-25 — product owner: "I can't work out how site agents get discovered and approved any more... I'm refreshing a site and it doesn't appear and I don't see any console logs."
- Updated: 2026-08-25 20:3x UTC
- Status: MERGED
- Priority: P1
- Owner: Gemini
- Workspace: cap-site-discovery-2c25e82
- Branch: —
- Base: `2c25e82`
- Candidate: `e152f7c0`
- Shipping: `origin/main@2bff0af` (0.2.267)
- Root cause: (a) chicken-and-egg — discovery required the content script to run, which only ran on ENROLLED origins (ensureOriginScriptsRegistered registers per-origin + host permission, transactional), so an un-enrolled site surfaced nothing; (b) enrolled origins' dynamic content scripts were not reconciled on SW startup/browser boot, so an enrolled site went silent after a restart ("no logs").
- Fix: proactive discovery — NTP + Settings surface open discoverable pages with one-click "Add Site Agent"/"Enroll" (explicit owner gesture, host-permission request, no typing origins) + discovered-but-not-enrolled listing; reconcileEnrolledOriginScriptsOnBoot() re-registers enrolled origins' scripts on boot. Security model verified hard (Pro e384c626): zero broad injection, host-permission grant stays owner-gesture, transactional enroll/rollback intact.
- Acceptance: an owner can see which open pages are discoverable and enroll one with a single explicit gesture, without typing an origin; discovery no longer requires the origin to be enrolled first; an already-enrolled origin's content scripts are re-registered on service-worker/browser boot so it does not go silent after a restart; no broad injection is introduced and the host-permission grant stays behind an owner gesture with transactional enroll/rollback intact
- Review: PASS (Pro e384c626), 1595/1595, manifest untouched.
- Gates: independent security review (Pro `e384c626`) confirming zero broad injection, owner-gesture host-permission grant and intact transactional enroll/rollback; 1595/1595 unit; manifest unchanged
- Blockers: —
- Next: — (MERGED at `0.2.267`; move to Archive on the next reconciliation)
- Recover: `git show 2bff0af --stat && git grep -n "reconcileEnrolledOriginScriptsOnBoot" -- extension`
- History:
  - 2026-08-25 22:45 UTC — schema fields completed by an unrelated lane so `npm run check:tasks` passes. This entry used `Root cause:`/`Fix:` in place of the schema's `Acceptance`/`Gates`/`Blockers`/`Next`/`Recover`; the missing fields were filled in FROM the text already present. No status, owner, candidate, shipping ref, review verdict or history event was altered, and no custody was taken.
  - 2026-08-25 20:3x UTC — LANDED at 0.2.267. Discovery is now discoverable and enrolled sites survive restart.
- id: CAP-FB-20260825-CAIRN-DOMEXC-01
  severity: P1
  status: done
  landed_version: 0.2.270
  summary: "Renamed ALL ~40 foreign 'cairn' identifiers to cap-* consistently (bridge channel __cap_bridge, CapBridgeAuth, __capInternal/__capHook markers, __capMainWorldBootstrap SW↔main-world handoff) across all 8 files; zero cairn refs remain except the intentional legacy storage key 'cairn:usage' (preserved as immutable migration read-source so pre-rename usage rows aren't orphaned). MAC/auth semantics untouched (pure rename). Also: DOMException now reports its bounded spec NAME (33-name WebIDL allowlist, genuineness via instanceof against native constructor captured at document_start, .message NEVER crosses) — so 'tool failed (DOMException)' now says e.g. 'DOMException: NotAllowedError'. KATs: cairn-rename.test.ts + 3 DOMException tests. 1601/1601."
- id: CAP-FB-20260825-MIC-VIEWTRANSITION-01
  severity: P1
  status: done
  landed_version: 0.2.272
  summary: "Create-agent dialog mic now REPLACES the field with the cumulative transcript (matches composer/prompt-bar) instead of appending it — dictating two utterances no longer doubles the text. View transitions removed: navigation now applies update() synchronously (no document.startViewTransition), making navigation instant/not janky, while focus routing (generation-guarded routeFocus + focusExplicitRouteTarget) is preserved so keyboard focus isn't lost. KATs: mic-transcript.test.ts + view-transition.test.ts. NOTE: during integration a worktree-overwrite briefly lost the cairn rename; it was restored from the reviewed commit and both fixes landed together at 0.2.272 (1593/1593)."
- id: CAP-FB-20260825-INVENTORY-DRIFT-01
  severity: P0
  status: done
  landed_version: 0.2.275
  summary: "npm run build failed with 'bundled-tool VERIFY FAILED — byte-drift: extension/lib/bundled-inventory-data.js'. Root cause: the inventory embeds a top-level 'release' field derived from package.json, but the machine-local post-commit hook bumps package.json AFTER the inventory is committed, so every version bump drifted the inventory and the build's verify gate failed closed. FIX: (1) regenerated the inventory to the current version (full regen — only bundled-inventory-data.js changed, the 26 Wasm binaries are reproducible/byte-identical); (2) STRUCTURAL: scripts/bump-version.mjs now keeps the inventory's 'release' field in lockstep on every bump (targeted patch, byte-equivalent to regen for a version-only change) AND stages it so the post-commit hook's amend bundles it — this fixes every machine since bump-version.mjs is committed. Also adopted: run 'npm run build' before every commit. 80 generated files byte-identical; full build RC=0."

## [CAP-FB-20260825-AGENT-ROLE-PREVIEW-01] The hub agent list prints the whole role
- Feedback: 2026-08-25 — product owner: "The agent list on the ntp page doesn't have a truncated role/description, it contains pretty much all of the description and it looks terrible."
- Updated: 2026-08-25 22:40 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P2
- Owner: claude-opus-5 implementer session
- Workspace: active (local path private)
- Branch: detached candidate on `origin/main`
- Base: `7642f76`
- Candidate: this commit
- Shipping: this commit on `origin/main`
- Acceptance: a long agent role in the hub's Named agents list renders as a short, scannable preview rather than a paragraph — at most two lines, the row no taller than ~90px — while the full role remains in the DOM for screen readers and reachable on hover; the fix lives in the shared row component so every list using it behaves the same; the sidebar's existing short preview is unaffected
- Review: pending — a different model/session should confirm the clamp does not harm any other `capability-row` consumer and that the full text really does stay available to assistive technology
- Gates: `scripts/agent-role-preview.ts` 7/7 on a clean profile, verified to FAIL against the unclamped component with exactly the reported symptom (`lines: 4`, `rowHeight: 111`); unit 1595/0; Chrome journeys 127/127; gallery drift clean
- Blockers: —
- Next: obtain the independent review, then close
- Recover: `npm run test:role-preview && git grep -n "line-clamp" -- extension/shared/components.js`
- History:
  - 2026-08-25 22:40 UTC — reproduced and fixed. `6986082` had truncated the SIDEBAR list and missed the main Named agents panel, which passes the role straight into `capability-row`'s `description`. A 334-character role rendered as five lines and grew the row to 111px; measured before/after 111px → 79px.
  - 2026-08-25 22:40 UTC — fixed in the shared component rather than at the one call site: `capability-row`'s `.desc` now clamps to two lines. That fixes every consumer at once, which is what the heavy-componentization rule in `AGENTS.md` asks for, and it CLAMPS rather than truncates — the full role stays in the DOM so a screen reader still reads it, and a `title` exposes it on hover. Cutting the string at the call site would have thrown the rest away.
  - 2026-08-25 22:40 UTC — coverage is a focused `scripts/agent-role-preview.ts`. Adding the checks to `scripts/ui-integration.ts` was tried and abandoned: that suite is already red on main (five failures, identical values with all local work stashed — a demo task does not create a thread, and three overlay checks cascade off it) and does not reach its own end inside 1800s, so checks appended there can never run. Filed separately as `CAP-FB-20260825-UI-INTEGRATION-RED-01`.

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

## [CAP-FB-20260826-OWNER-BATCH-01] Owner bug/feature batch (2026-08-26, Telegram)

Owner-described batch of bugs + UX issues. Each entry: analysis + acceptance. Prioritize + delegate.

- Feedback: 2026-08-26 — product owner (Telegram): a batch of bugs and UX issues. Each child entry below carries its own analysis + acceptance.
- Updated: 2026-08-26 23:30 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `c224d28b`
- Candidate: —
- Shipping: —
- Acceptance: every child is prioritized and delegated with its analysis + acceptance; each child's own acceptance criteria are recorded per child below
- Review: per-child — each child that becomes a candidate gets an independent review by a different model/session (standing rule); children carry their own review state
- Gates: per-child gates — each child lands behind its own acceptance and the full-suite-green gate
- Blockers: —
- Next: prioritize the P0 children — usage/token accounting, permission-model simplification, and the agent-worker architecture decision — and delegate each with its recorded analysis + acceptance
- Recover: `grep -n "^- id: CAP-FB-20260826" TASKS.md`
- History:
  - 2026-08-26 20:26 UTC — batch captured from product-owner Telegram (ea800309, 12 items)
  - 2026-08-26 20:58 UTC — permission-system simplification recorded as P0 (c8f06bbe)
  - 2026-08-26 23:30 UTC — agent-worker shared-worker architecture decision recorded as P0, phased (680c8904)

- id: CAP-FB-20260826-BACK-STACK-01
  severity: P1
  status: open
  summary: "Back-button stack management broken. Settings → Back goes to a BLANK screen; must press Back twice. Happens for multiple surfaces (click assets, click back twice). ALSO: inside Settings there's no easy way to get Home without clicking Back for every settings sub-page. Owner's steer: once inside the settings page, use history.replaceState (don't push every settings sub-view onto history) — but still allow linking to individual parts of the settings page. ANALYSIS: the route/view state machine pushes sub-views onto history (or fails to restore the prior view), producing a blank intermediate state. FIX: settings sub-navigation uses replaceState (one history entry for the whole settings surface) + back from settings returns to the prior home view in one step; deep-linkable settings sections still get their own addressable state. ACCEPTANCE: Settings→(any sub-page)→Back returns to Home in ONE press, no blank screen; assets→Back works in one press; each settings section is still linkable."
- id: CAP-FB-20260826-NTP-ADD-AGENT-01
  severity: P2
  status: open
  summary: "NTP agents folder '+' button (on the settings panel, not side panel) to add an agent should be scoped to YOUR named agent. Owner likes the empty-state affordance: 'No named agents yet — create one in Tasks / Create an agent / or /agent create / or click button'. ACCEPTANCE: the agents-folder '+' creates a named agent; the empty state shows that affordance text + the create paths."
- id: CAP-FB-20260826-DISCOVERED-SITE-SPACING-01
  severity: P2
  status: open
  summary: "'Discovered open pages — click to add site' grey dialog box butts straight against the edge of the main agents container (no padding/margin) — looks terrible. FIX: add proper padding/margin around the discovered-sites box inside the agents container."
- id: CAP-FB-20260826-RECENT-ACTIVITY-FILTER-01
  severity: P1
  status: open
  summary: "Recent activity: the search text box + the 'all agents' button + the filter don't work. ACCEPTANCE: typing in search filters the recent-activity list; 'all agents' + the per-agent filter actually filter."
- id: CAP-FB-20260826-USAGE-TOKENS-01
  severity: P0
  status: open
  assign: best-agent
  summary: "Usage calls + token numbers STILL aren't working (owner: works on his other projects incl. the chaos extension). The usage/token attribution isn't surfacing real numbers. This is the owner's explicit top-priority in the batch — assign to the strongest agent. ANALYSIS: the onUsage hook → usage-store path exists (usage.js); the tokens/calls either aren't being recorded from agent-do or aren't being read back into the UI. Compare against the chaos extension's working usage accounting. ACCEPTANCE: per-run + per-agent token/call counts are real, match the provider's actual usage, and render in the UI (and survive reload)."
- id: CAP-FB-20260826-BACKGROUND-AGENTS-UNIFY-01
  severity: P2
  status: open
  summary: "Background agents are separate from the agents box — owner wants them UNIFIED: background agents appear IN the agents list (with a 'runs in background' indicator), always accessible from there, and mentionable in the chat text box (@-mention) if not already. ACCEPTANCE: the agents list (side panel + NTP) includes background agents with a background indicator; they can be opened/messaged/@-mentioned like named agents."
- id: CAP-FB-20260826-DELETE-AGENT-FOLDER-01
  severity: P2
  status: open
  summary: "After deleting all of an agent's data (memory + OPFS), the owner can't delete the named agent's folder/record itself (had 'sorting hat', deleted all data, wants the agent folder gone too). Add the ability to fully delete a named agent (its folder + record), not just its data. ACCEPTANCE: from the agent, the owner can delete the named agent entirely (folder + registry record + memory + OPFS), with confirmation."
- id: CAP-FB-20260826-TOOL-LIBRARY-COUNT-01
  severity: P2
  status: open
  summary: "Tool library says 'browser tools: 130' but the list clearly doesn't show 130. The bundled-packages count should be double-checked too. ANALYSIS: the count comes from the registry bounds (130) but the rendered list is filtered/truncated or groups differently, so the visible rows << 130. ACCEPTANCE: the tool library shows all 130 browser tools (or honestly labels the grouping), and the bundled-package count is verified against the actual shipped packages."
- id: CAP-FB-20260826-LOCAL-MODELS-HIDE-01
  severity: P2
  status: open
  summary: "Hide the local-models feature — the download never works (Chrome built-in AI ~10GB storage cap: 'insufficient storage available, 10GB below required payload 10.53GB' even though it claims a 5.72GB install payload). Owner's steer: remove/simplify the local-model download code now; LATER, load models (gguf) from the user's local drive via OPFS using the directory handle + file handle. ACCEPTANCE: the local-models UI is hidden/removed and the dead download code simplified; a follow-up note records the OPFS-file-handle model-loading idea."
- id: CAP-FB-20260826-APPROVALS-REMOVE-01
  severity: P2
  status: open
  summary: "The 'approval session' section inside the settings panel — is it still used? Owner thinks the whole interface doesn't work: if the agent requests access, going to a weird settings page to approve doesn't work. Approvals should be IN the context of the agent or the task being done, not a settings page. ACCEPTANCE: the orphaned approvals settings section is removed; approval prompts surface in-context (in the agent/task that needs them)."
- id: CAP-FB-20260826-SYSTEM-PROMPT-01
  severity: P2
  status: open
  summary: "Update the built-in default system prompt to be more accurate to the types of tasks it can do (now that the toolset grew to 130 tools). Also: the agent should ALWAYS search for the tool first — we have a search/list-tools (query_tools) capability; give more examples of search-then-execute, WITHOUT bloating the system prompt context. ACCEPTANCE: the default system prompt reflects the real toolset, instructs search-then-execute with query_tools examples, and stays context-bounded."
- id: CAP-FB-20260826-HEADER-HOME-01
  severity: P3
  status: open
  summary: "In the settings panel, clicking the 'Chrome agent platform' header should take you back to the homepage. Small UX affordance; pairs with BACK-STACK-01."
- id: CAP-FB-20260826-PERMISSIONS-SIMPLIFY-01
  severity: P0
  status: open
  summary: "Owner (frustrated, P0): the permission system is a MESS. (1) The sorting-hat demo failed with 'Tab grouping write operations are pending owner tab-management permission enrollment in Settings' EVEN THOUGH all permissions are enabled — there are TWO confusing layers (the chrome API permission AND the separate expiring browser-control GRANT) and the owner can't tell which one to grant. (2) 'It should be asking me in context' — when a tool needs a permission/grant, the approval must surface IN the agent/task context, not send the owner to a Settings page. (3) Settings UI can't REMOVE a permission; the 'needs permission' security label never surfaces where to manage it. GOAL (owner's words): 'make it super simple and easy to use and understand.' REDESIGN: (a) ONE coherent mental model — when a tool needs something, an approval surfaces in-context ('This agent wants to group tabs — Allow?') and one click grants what's needed; (b) diagnose why the demo said 'pending enrollment' despite enabled permissions (which layer failed — is the grant expiring/not-set, is tabGroups separate from tabs and un-granted, or a real detection bug?); (c) Settings becomes a clear inventory — every permission with a plain-English label + what it enables + a working add/remove toggle, and 'needs permission' labels link to the exact control; (d) the in-context approval is the primary path, Settings is the management/inventory path. ACCEPTANCE: the sorting-hat demo works after a single in-context approval; every permission is add/removable in Settings with a plain-English label; no 'pending enrollment' dead-ends."
- id: CAP-FB-20260826-AGENT-WORKERS-01
  severity: P0
  status: in-progress
  summary: "Owner DECISION (2026-08-26): adopt the per-agent SHARED WORKER execution architecture (docs/AGENT-EXECUTION-ARCHITECTURE.md). Each agent (background/named/site) = its own shared worker ({name: agentId}), hosted by the single offscreen document (reason WORKERS — the SW cannot create workers directly), bootstrapped through the SW (alarms wake SW → SW ensures offscreen host + worker alive → dispatch). MessagePorts passed to CLIENTS (NTP/sidepanel) via a SW-validated handshake so the UI holds a live port and keeps the worker alive 'as much as possible'. BroadcastChannel (cap:agent:<id>) for state. SW stays the authority for routing/auth/grant-lock/redaction/storage. PHASES: P1 foundation (offscreen host bootstrap + agent-worker shared-worker shell + SW connect/port handshake + alive-set reconciliation + documented pattern) → P2 migrate the agent-do run loop into the worker (tool exec, provider calls, durable-run interaction from the worker context) → P3 durability mapping (run progress/logs survive worker death via durable-runs/OPFS) → P4 UI ports everywhere + background agents fully on workers. Acceptance per phase; P1 KATs: bootstrap, port handshake, keep-alive across host/client death, reconcile-on-wake."
