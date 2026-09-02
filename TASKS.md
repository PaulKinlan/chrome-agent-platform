# Chrome Agent Platform tasks

`TASKS.md` is the repository-local, public-safe recovery record for product
feedback, bugs, reviews, and active delivery lanes. It complements, but never
copies, the private coordination ledger. The stable `CAP-FB-*` ID is the only
join key between the two systems.

> Snapshot: 2026-08-30 15:00 UTC. Reconciled against exact public
> `origin/main@fc2255be` after the 2026-08-30 full-project reanalysis (`REVIEW-2026-08-30.md`). This file holds the **active** set only;
> completed entries live in `TASKS-DONE.md`. Active counts: **65 nonterminal**; every 2026-08-30 entry is written in the detailed hand-off format (owner directive 2026-08-30).
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
- `REVIEW-2026-08-30.md` — the full-project reanalysis before the exec demo: verified baseline,
  the ten findings leadership must hear, the cut and add lists, and the dependency-ordered
  work queue. It is the rationale; this file is the contract. Never take work from it alone.
- `REVIEW-2026-08-21.md` — the earlier independent architectural review (delivery diagnosis);
  kept as history.
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
  - 2026-08-31 09:45 UTC — sol r2 review REVISE: (1) matrix attestation identified the parent 0d5f1003 not the candidate — re-run AT the final tip so testedSourceCommit records the candidate; (2) the probe could pass before the panel finished rendering — now waits for the exact stable row count (31 = 27 rendered caps + 4 core) and asserts no install-only names; (3) TASKS.md DONE/TBD metadata finalized here; (4) the API_PERMISSIONS comment misclassified power/search/privacy as install-only — corrected (they are optional-listable and remain optional). All four fixed; gates re-run.
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

## Active lanes (claimed — 2026-09-02 02:21 UTC)

Entries below are being implemented RIGHT NOW by workers spawned from the reanalysis coordinator
session. Each worker is in its own worktree on the named branch off `origin/main@c2590adc`,
pushes that branch to origin, and the coordinator merges forward (build → units → journeys → explicit-SHA
push) and flips the entry to DONE. If you are another agent: do not start these; take an unclaimed entry
from the queue, set its Owner/Workspace/Branch in one commit BEFORE writing code, and append a History line.
This section is regenerated by the coordinator at every claim/merge.

| Entry | Branch | Claimed |
|---|---|---|
| `CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01` | `cap/loop-context-window` | 2026-09-02 02:21 UTC |
| `CAP-FB-20260901-ONE-CARD-PER-STEP-01` | `cap/one-card-per-step` | 2026-09-02 02:20 UTC |
| `CAP-FB-20260830-SUITE-HONESTY-01` | `cap/suite-honesty` | 2026-09-02 00:06 UTC |
| `CAP-FB-20260830-EXEC-DEMO-01` | `cap/exec-demo` | 2026-09-01 20:33 UTC |

## Open work queue

**This file holds only what is in progress or still to do — 65 entries.** Completed work is archived in [TASKS-DONE.md](TASKS-DONE.md) at triage; **merged is done** (Paul, 2026-08-28), so nothing sits in a terminal state here. Most urgent first (regenerated 2026-08-30). The entry itself is always the authority; where it disagrees with this table, the entry wins.

Regenerate after any status change (this exact command reproduces the table below):

```sh
awk '/^## \[CAP-FB/{h=$0; sub(/^## \[/,"",h); id=h; sub(/\].*/,"",id); t=h; sub(/^[^]]*\] */,"",t)} /^- Status:/{s=$3} /^- Priority:/{if(s!="DONE"&&s!="MERGED"&&s!="ABANDONED"&&id!~/YYYYMMDD/) printf "%-3s %-10s %s — %s\n",$3,s,id,t}' TASKS.md | sort
```

| Priority | Status | Task | What it is |
|---|---|---|---|
| P0 | IN_REVIEW | [`CAP-FB-20260829-APPROVAL-JOURNEY-REGRESSION-01`](#cap-fb-20260829-approval-journey-regression-01-restore-owner-direct-approval-journeys-after-inline-approvals) | Restore owner-direct approval journeys after inline approvals |
| P0 | IN_REVIEW | [`CAP-FB-20260829-BACKGROUND-RUN-TRANSCRIPT-01`](#cap-fb-20260829-background-run-transcript-01-scheduled-named-agent-runs-disappear-from-the-agent-conversation) | Scheduled named-agent runs disappear from the agent conversation |
| P0 | IN_REVIEW | [`CAP-FB-20260829-MIC-DEAD-MACOS-01`](#cap-fb-20260829-mic-dead-macos-01-macos-dictation-has-no-transcript-or-trustworthy-microphone-diagnostics) | macOS dictation has no transcript or trustworthy microphone diagnostics |
| P0 | IN_REVIEW | [`CAP-FB-20260829-TOOL-ARGUMENT-ROBUSTNESS-01`](#cap-fb-20260829-tool-argument-robustness-01-tool-call-argument-robustness-and-schema-accuracy) | Tool-call argument robustness and schema accuracy |
| P0 | IN_REVIEW | [`CAP-FB-20260829-URGENT-UI-REPAIR-01`](#cap-fb-20260829-urgent-ui-repair-01-restore-agents-and-create-dialog-visual-quality) | Restore Agents and create-dialog visual quality |
| P0 | OPEN | [`CAP-FB-20260821-WORKTREE-HYGIENE-01`](#cap-fb-20260821-worktree-hygiene-01-durable-worktrees-and-evidence-off-the-ram-backed-temp-filesystem) | Durable worktrees and evidence off the RAM-backed temp filesystem |
| P0 | OPEN | [`CAP-FB-20260830-EXEC-DEMO-01`](#cap-fb-20260830-exec-demo-01-the-five-minute-exec-demo-runs-end-to-end-on-a-fresh-profile) | The five-minute exec demo runs end to end on a fresh profile |
| P1 | BLOCKED | [`CAP-FB-20260819-PROACTIVE-TAB-DISCOVERY-01`](#cap-fb-20260819-proactive-tab-discovery-01-proactive-per-tab-site-agent-discovery-before-run) | Proactive per-tab Site Agent discovery before Run |
| P1 | IN_REVIEW | [`CAP-FB-20260827-DIALOG-CONSOLIDATION-01`](#cap-fb-20260827-dialog-consolidation-01-five-dialog-implementations-three-hand-rolled) | Five dialog implementations, three hand-rolled |
| P1 | IN_REVIEW | [`CAP-FB-20260829-AGENTS-SETTINGS-MERGE-01`](#cap-fb-20260829-agents-settings-merge-01-unify-interactive-and-scheduled-agents-in-settings-and-the-task-sidebar) | Unify interactive and scheduled agents in Settings and the task sidebar |
| P1 | IN_REVIEW | [`CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01`](#cap-fb-20260829-create-dialog-declutter-01-create-agent-dialog-is-cluttered-and-its-scheduletheme-controls-are-inconsistent) | Create-agent dialog is cluttered and its schedule/theme controls are inconsistent |
| P1 | IN_REVIEW | [`CAP-FB-20260829-HUB-HOME-BUTTON-01`](#cap-fb-20260829-hub-home-button-01-ntp-brand-returns-directly-home) | NTP brand returns directly Home |
| P1 | IN_REVIEW | [`CAP-FB-20260829-OWNER-OBSERVABILITY-01`](#cap-fb-20260829-owner-observability-01-owner-grade-console-and-run-logs) | Owner-grade console and run logs |
| P1 | OPEN | [`CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01`](#cap-fb-20260819-directory-tool-explorer-01-agent-directory-tool-explorer-and-enrollment-policy) | Agent Directory tool explorer and enrollment policy |
| P1 | OPEN | [`CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`](#cap-fb-20260819-permission-remediation-ux-01-user-facing-permission-management-and-run-remediation) | User-facing permission management and run remediation |
| P1 | OPEN | [`CAP-FB-20260819-UI-FLASH-RELAYOUT-01`](#cap-fb-20260819-ui-flash-relayout-01-intermittent-extension-wide-ui-flash-and-relayout-investigation) | Intermittent extension-wide UI flash and relayout investigation |
| P1 | OPEN | [`CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01`](#cap-fb-20260820-semantic-tool-search-01-local-semantic-search-over-the-complete-tool-catalog) | Local semantic search over the complete tool catalog |
| P1 | OPEN | [`CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01`](#cap-fb-20260823-extended-tool-families-01-extended-unixsystem-tool-family-admissions) | Extended Unix/system tool family admissions |
| P1 | OPEN | [`CAP-FB-20260823-PYODIDE-PYTHON-01`](#cap-fb-20260823-pyodide-python-01-python-in-the-browser-via-pyodide) | Python in the browser via Pyodide |
| P1 | OPEN | [`CAP-FB-20260825-DATA-EXPORT-IMPORT-01`](#cap-fb-20260825-data-export-import-01-owner-export-and-import-of-all-agent-data) | Owner export and import of all agent data |
| P1 | OPEN | [`CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01`](#cap-fb-20260825-headed-acceptance-lane-01-a-headed-browser-acceptance-lane) | A headed-browser acceptance lane |
| P1 | OPEN | [`CAP-FB-20260825-OWNER-DECISION-QUEUE-01`](#cap-fb-20260825-owner-decision-queue-01-product-decisions-blocking-tracked-work) | Product decisions blocking tracked work |
| P1 | OPEN | [`CAP-FB-20260825-UI-INTEGRATION-RED-01`](#cap-fb-20260825-ui-integration-red-01-scriptsui-integrationts-is-red-and-never-finishes) | scripts/ui-integration.ts is red and never finishes |
| P1 | OPEN | [`CAP-FB-20260825-WEBSTORE-RELEASE-01`](#cap-fb-20260825-webstore-release-01-the-path-to-a-published-extension) | The path to a published extension |
| P1 | OPEN | [`CAP-FB-20260827-SETTINGS-MONOLITH-01`](#cap-fb-20260827-settings-monolith-01-settings-is-one-88-screen-scroll-with-a-nav-that-only-scrolls) | Settings is one 8.8-screen scroll with a nav that only scrolls |
| P1 | OPEN | [`CAP-FB-20260830-HUB-CHROME-POLISH-01`](#cap-fb-20260830-hub-chrome-polish-01-hub-chrome-settings-styled-as-the-primary-button-agent-id-as-title-a-zero-width-directory-card-developer-icons-in-the-header) | Hub chrome: Settings styled as the primary button, agent id as title, a zero-width directory card, developer icons in the header |
| P1 | OPEN | [`CAP-FB-20260830-ONE-SHELL-01`](#cap-fb-20260830-one-shell-01-three-surfaces-three-shells-one-content-width-one-title-no-duplicate-chrome) | Three surfaces, three shells: one content width, one title, no duplicate chrome |
| P1 | OPEN | [`CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01`](#cap-fb-20260830-settings-hooks-permissions-tables-01-hooks-is-50-identical-cards-with-red-deny-buttons-permissions-is-19-identical-cards) | Hooks is 50+ identical cards with red Deny buttons; Permissions is 19 identical cards |
| P1 | OPEN | [`CAP-FB-20260901-ONE-CARD-PER-STEP-01`](#cap-fb-20260901-one-card-per-step-01-step-1-of-the-demo-shows-three-in-chat-permission-cards-plus-two-native-chrome-prompts--the-script-allows-one) | Step 1 of the demo shows three in-chat permission cards plus two native Chrome prompts — the script allows one |
| P1 | OPEN | [`CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01`](#cap-fb-20260902-loop-context-window-01-a-tool-loop-that-spans-more-than-one-inner-turn-loses-the-first-turns-tool-results) | A tool loop that spans more than one inner turn loses the first turn's tool results |
| P2 | BLOCKED | [`CAP-FB-20260822-MV3-WASM-RUNTIME-PROBE-01`](#cap-fb-20260822-mv3-wasm-runtime-probe-01-loaded-mv3-wasm-runtime-and-termination-probe) | Loaded-MV3 Wasm runtime and termination probe |
| P2 | BLOCKED | [`CAP-FB-20260822-OWNER-WASM-INSTALL-01`](#cap-fb-20260822-owner-wasm-install-01-owner-selected-wasm-package-lifecycle) | Owner-selected Wasm package lifecycle |
| P2 | IN_REVIEW | [`CAP-FB-20260829-PROVIDER-TOOLS-COPY-01`](#cap-fb-20260829-provider-tools-copy-01-explain-provider-run-tool-toggles-per-agent) | Explain provider-run tool toggles per agent |
| P2 | IN_REVIEW | [`CAP-FB-20260829-SETTINGS-NAV-ORDER-01`](#cap-fb-20260829-settings-nav-order-01-settings-nav-follows-the-rendered-document-order) | Settings nav follows the rendered document order |
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
| P2 | OPEN | [`CAP-FB-20260830-AGENT-SHARING-01`](#cap-fb-20260830-agent-sharing-01-share-an-agent-as-a-card-file-and-import-it-on-another-profile) | Share an agent as a card file and import it on another profile |
| P2 | OPEN | [`CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01`](#cap-fb-20260830-artifact-quick-fixes-01-small-artifact-defects-new-tab-opens-twice-an-empty-id-masks-the-real-error) | Small artifact defects: New tab opens twice, an empty id masks the real error |
| P2 | OPEN | [`CAP-FB-20260830-BUNDLE-BUDGET-01`](#cap-fb-20260830-bundle-budget-01-the-service-worker-bundle-is-456-mb-against-a-25-mb-budget-pyodide-would-load-unpinned-remote-code) | The service-worker bundle is 4.56 MB against a 2.5 MB budget; Pyodide would load unpinned remote code |
| P2 | OPEN | [`CAP-FB-20260830-FINGERPRINT-SURFACE-01`](#cap-fb-20260830-fingerprint-surface-01-every-website-can-fingerprint-the-extension) | Every website can fingerprint the extension |
| P2 | OPEN | [`CAP-FB-20260830-MODEL-CALL-ECONOMY-01`](#cap-fb-20260830-model-call-economy-01-a-19-kb-system-prompt-on-every-call-and-an-agent-do-nudge-that-costs-one-extra-call-per-turn) | A 19 KB system prompt on every call and an agent-do nudge that costs one extra call per turn |
| P2 | OPEN | [`CAP-FB-20260830-ON-DEVICE-PATH-01`](#cap-fb-20260830-on-device-path-01-chromes-built-in-model-prompt-api-handles-text-only-steps-on-device-with-a-hosted-model-for-planning-and-tools) | Chrome's built-in model (Prompt API) handles text-only steps on-device, with a hosted model for planning and tools |
| P2 | OPEN | [`CAP-FB-20260830-SEEDED-PROFILE-GATES-01`](#cap-fb-20260830-seeded-profile-gates-01-seed-warning-permissions-and-seeded-profile-budgets-into-the-journey-and-perf-gates) | Seed warning permissions and seeded-profile budgets into the journey and perf gates |
| P2 | OPEN | [`CAP-FB-20260830-SITE-PLAYBOOKS-01`](#cap-fb-20260830-site-playbooks-01-a-skill-can-be-bound-to-an-origin-so-the-agent-uses-site-specific-instructions-only-on-that-site) | A skill can be bound to an origin so the agent uses site-specific instructions only on that site |
| P2 | OPEN | [`CAP-FB-20260830-SUITE-HONESTY-01`](#cap-fb-20260830-suite-honesty-01-the-security-suite-never-loads-the-extension-two-wired-harnesses-are-red-outside-testall-42-harnesses-are-orphaned) | The security suite never loads the extension; two wired harnesses are red outside test:all; 42 harnesses are orphaned |
| P2 | OPEN | [`CAP-FB-20260831-TOOL-PIPELINES-01`](#cap-fb-20260831-tool-pipelines-01-no-way-to-chainpipe-tool-steps-into-a-small-script-co-do-style) | No way to chain/pipe tool steps into a small script (co-do-style) |
| P2 | OPEN | [`CAP-FB-20260901-WEBMCP-CALL-CONSENT-01`](#cap-fb-20260901-webmcp-call-consent-01-a-sites-webmcp-tool-runs-with-no-consent-card--decide-and-implement-the-consent-point-for-site-tools) | A site's WebMCP tool runs with no consent card — decide and implement the consent point for site tools |
| P2 | OPEN | [`CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01`](#cap-fb-20260902-budget-verdict-answered-01-a-run-that-calls-tools-and-writes-its-answer-on-its-last-allowed-step-is-settled-as-budget-reached-although-the-answer-landed) | A run that calls tools AND writes its answer on its last allowed step is settled as "Budget reached" although the answer landed |
| P3 | BLOCKED | [`CAP-FB-20260818-WIDER-REVIEW-01`](#cap-fb-20260818-wider-review-01-wider-goal-review-remediation-umbrella) | Wider-goal review remediation umbrella |
| P3 | OPEN | [`CAP-FB-20260821-RECIPES-SKILLS-RENAME-01`](#cap-fb-20260821-recipes-skills-rename-01-finish-the-recipes-to-skills-rename) | Finish the recipes to skills rename |
| P3 | OPEN | [`CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01`](#cap-fb-20260825-agent-picker-hub-rows-01-hub-agent-summary-rows-predate-the-shared-picker) | Hub agent summary rows predate the shared picker |
| P3 | OPEN | [`CAP-FB-20260827-DEAD-COMPONENTS-01`](#cap-fb-20260827-dead-components-01-components-ship-to-users-but-are-only-used-by-the-gallery) | Components ship to users but are only used by the gallery |
| P3 | OPEN | [`CAP-FB-20260830-CODE-HEALTH-01`](#cap-fb-20260830-code-health-01-route-raw-console-calls-through-cap-log-annotate-the-41-bare-catches) | Route raw console calls through cap-log; annotate the 41 bare catches |
| P3 | OPEN | [`CAP-FB-20260830-ICONOGRAPHY-GAPS-01`](#cap-fb-20260830-iconography-gaps-01-skills-without-icons-menus-without-icons-38-uppercase-kickers-in-the-gallery) | Skills without icons, menus without icons, 38 uppercase kickers in the gallery |
| P3 | OPEN | [`CAP-FB-20260830-PRIVACY-STATEMENT-01`](#cap-fb-20260830-privacy-statement-01-one-screen-that-says-what-the-extension-sends-and-stores-and-a-factory-reset-journey) | One screen that says what the extension sends and stores, and a factory-reset journey |
| P3 | OPEN | [`CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01`](#cap-fb-20260902-live-script-cleanup-01-scriptslive-every-tabts-kills-only-the-chromium-parent-and-leaves-children-and-temp-profiles-behind) | scripts/live-every-tab.ts kills only the Chromium parent and leaves children and temp profiles behind |

**The demo path is the only P0 lane (owner decision, 2026-08-27; reaffirmed by the 2026-08-30 reanalysis).** There are 19 P0 entries. `CAP-FB-20260830-EXEC-DEMO-01` is the umbrella for the five-minute exec demo and lists its blockers; the new P0s from the reanalysis are the tool-gating pair (`BROWSER-LEASE-DEADLOCK-01`, `DENIAL-TO-GRANT-CARD-01`), the first screen (`KEYLESS-FIRST-RESULT-01`, `FRESH-PROFILE-TEMPLATE-AGENTS-01`), the transcript (`TRANSCRIPT-FULL-ANSWER-01`, `SELECTION-REF-VALIDATE-FIRST-01`), the two security items a leadership audience will probe (`RUN-SCRIPT-FETCH-APPROVAL-01`, `UNTRUSTED-CONTENT-FENCING-01`) and the page-action decision (`PAGE-ACTION-TOOLS-01`). The Wasm lane stays at P2 until after the demo. `REVIEW-2026-08-30.md` section 5 is the dependency-ordered queue.

**Held by a product decision, not by engineering:** `CAP-FB-20260822-OWNER-WASM-INSTALL-01` and `CAP-FB-20260822-BUILTIN-WASM-TOOLS-01` wait on open questions Q13 and Q14, `CAP-FB-20260825-WEBSTORE-RELEASE-01` on Q11, `CAP-FB-20260830-HOST-ACCESS-STORY-01` on Q18, `CAP-FB-20260830-PAGE-ACTION-TOOLS-01` on Q19 and `CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01` on Q12. All are collected in `CAP-FB-20260825-OWNER-DECISION-QUEUE-01` with recommended defaults — clearing Q18, Q19 and Q12 unblocks the demo path for the least effort.


## Active

## [CAP-FB-20260829-APPROVAL-JOURNEY-REGRESSION-01] Restore owner-direct approval journeys after inline approvals
- Feedback: 2026-08-29 — the landed inline-approval merge left the full Chrome journey suite stopping at agent.delete because its helper treated every operational failure as a pending approval
- Updated: 2026-08-29 23:00 UTC
- Status: IN_REVIEW
- Priority: P0
- Owner: implementer (worktree lane)
- Workspace: active (local path private)
- Branch: `cap-approvals-journey-fix`
- Base: `cebb4601`
- Candidate: `cap-approvals-journey-fix` (local, not pushed)
- Shipping: —
- Acceptance: model-originated destructive calls retain inline stop-and-wait approval; owner-direct extension actions do not wait for a nonexistent Settings row; the journey helper enters the Settings resolver only for an explicit approval-gate response; required capabilities refuse before dependent teardown; permanent manifest host access is accepted as non-removable cleanup success
- Review: required fresh-session review of the candidate diff and falsification evidence before merge
- Gates: Chrome journeys 120/120; full Deno suite; production build; focused approval/capability/site-discovery tests; changed source pins observed RED without the fix and GREEN with it
- Blockers: —
- Next: independent review, then coordinator merge and rerun the gates on main
- Recover: `git show cap-approvals-journey-fix && git diff origin/main...cap-approvals-journey-fix`
- History:
  - 2026-08-29 23:00 UTC — reproduced the landed stop at 85/120. Root cause: owner-direct agent.delete executed immediately and returned an honest cleanup result, but the journey assumed every non-ok response meant an approval row existed. Restricted the resolver retry to explicit approval-gate errors. The newly reached checks exposed and repaired two existing install-grant consistency defects: required scripting refusal now precedes enrollment teardown, and agent cleanup trusts unregisterOriginScripts' authoritative success when host access is permanent. Falsification: focused source pins failed 2/9 without the service-worker fix and passed after restoration. Final gates: focused 44/44; Chrome journeys 120/120; full Deno 2389/2389; build passed.

## [CAP-FB-20260829-TOOL-ARGUMENT-ROBUSTNESS-01] Tool-call argument robustness and schema accuracy

- Feedback: 2026-08-29 — owner reported frequent argument sanitization failures, including a complete HTML document rejected while saving an artifact, and asked that every model-visible schema state the real enforced constraints
- Updated: 2026-08-29 20:52 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: implementation lane
- Workspace: active (local path private)
- Branch: `cap-tool-args`
- Base: `54d70a9b`
- Candidate: branch tip (three atomic commits; not pushed)
- Shipping: —
- Acceptance: complete artifact/script bodies use a designated bounded channel without truncation; list/search descriptors expose the source schema plus exact transport limits; every registered product schema passes schema/enforcement probes; rejected size/shape calls name the field, actual size, limit and remediation
- Review: independent acceptance review required
- Gates: 30 KiB HTML RED on base and GREEN after; focused lazy/catalog/search/cutover/Wasm discovery tests; full `nice -n 10 deno test --allow-all tests/` 2363/0; `npm run build` clean
- Blockers: independent review and coordinator integration
- Next: review the three-commit diff, then merge and run the same gates at the integration tip
- Recover: `git log --oneline 54d70a9b..cap-tool-args`
- History:
  - 2026-08-29 20:52 UTC — implemented a per-field elevated path matching the artifact (256 KiB) and script (64 KiB) stores while retaining ordinary 16 KiB string / 32 KiB payload / shape limits; schemas and enforcement now share one contract; failures are actionable. The 30 KiB owner case failed before the fix and passed byte-exact after it. Full suite and build pass; no push.

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
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: `docs/permission-remediation-design`
- Base: `cf0da958`
- Candidate: —
- Shipping: —
- Acceptance: Settings reflects actual Chrome optional permissions and site access separately from agent/task policy; a failed run names the exact tool, capability, origin, rationale, and least-privilege choices instead of a vague `<all_urls>` or permission error; the run pauses safely, creates a visible owner-only approval prompt or inbox item, grants only through a genuine browser gesture, and deterministically resumes the same run or records deny, cancel, revoke, and retry outcomes; pending and error history remains discoverable. The 2026-08-30 reanalysis narrows the first increment: the in-chat card is the owner-only prompt (it exists), every denial must reach it (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01), the policy the card explains is the three-class Read / Act / Destructive model (CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01), and the copy in Settings, the first-run banner and the card must describe the same thing — today `extension/options/options.html:189-190` says "Reading page text and listing tabs are always available" while `list_tabs` returns "tabs permission not granted" (`extension/lib/browser-tools.js:1565`).
  - Context: the conversation already renders an in-context approval card for denials shaped `{ waitingForPermission:true, permissionRequirement:{ reason, permissions[], grantOrigins[], grantGlobal } }` (`normalizePermissionRequirement` `extension/shared/conversation.js:407`; `approvePermissionRequirement` `:485` performs `chrome.permissions.request` on the click and `browser-control.set` for grants), and `permissionDenial()` (`extension/lib/browser-tools.js:297`) produces that shape. But twelve denial sites still return the legacy `permissionRequired: { capability }` (`browser-tools.js:387, 409, 828, 997, 1090, 1138, 1399, 1454, 1565, 1583, 1750, 5289`) and the card never appears for open_tab/navigate_tab/close_tab/list_tabs/read_page — the tools lane's "open tab doesn't open a tab". The `capability.request` route (`extension/background/service-worker.js:5807`) calls `requestCapability(id, { request:false })` and can only check, with a comment describing a retired install-grant model; `capability.revoke` (`:4048`) is the owner-approved revoke authority. Settings → Browser control (`options.html:187-206`) has the global switch `#browser-grant` and an "Allowed origins" textarea (`:198-204`), which the product lane recommends cutting in favour of per-origin Act grants. `extension/lib/chrome-tool-capabilities.js` classifies each tool (`list_tabs` read-only, `close_tab` mutating, ~`:238-246`). The journey suite drives Enable/Turn off at `scripts/chrome-journeys.ts:845-892` while a comment there still says "INSTALL-GRANTED MODEL"; headless Chrome auto-dismisses warning-bearing prompts, so the grant UI itself is only attestable headed (CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01) or with pre-seeded `Preferences` (CAP-FB-20260830-SEEDED-PROFILE-GATES-01). The design doc is `docs/permission-remediation-design.md`. What must NOT change: grants happen only on an owner gesture; permission grants are never model-callable; no silent broadening; `<all_urls>` posture is CAP-FB-20260830-HOST-ACCESS-STORY-01's decision, not this entry's.
  - Reproduce today: (1) `npm run build`, load the extension on a fresh profile; (2) hub: `@demo-tools open example.com in a new tab` — the `open_tab` card shows error text "tabs permission not granted — enable it from the chat when prompted" and no Allow card appears; (3) Settings → Browser control: read the sentence at `options.html:189-190`; then `chrome.runtime.sendMessage({type:"agent-worker.tool", name:"list_tabs"})` from the page — the denial contradicts it; (4) grep `permissionRequired` in `browser-tools.js`: twelve sites.
  - Files: `extension/lib/browser-tools.js` (the twelve `permissionRequired` sites → `permissionDenial(error, { reason, permissions:[…], grantOrigins:[…], grantGlobal })`; the `origins`-shaped requirements at `capture_screenshot` and `save_page_as_mhtml` → the same helper); `extension/shared/conversation.js` (`:407-460` — the card copy names the class: "Read", "Act on <origin>", "Destructive"; `:485-545` unchanged mechanics); `extension/background/service-worker.js:5807` (`capability.request` becomes an honest check route or is deleted; the comment is rewritten); `extension/options/options.html:187-206` (copy rewritten to the three classes; the textarea replaced by a read-only list of per-origin Act grants with Revoke); `extension/options/options.js` (`renderPermissions` `:1899` keeps Chrome optional permissions; a new "What the agent may do" block above it renders the policy); `docs/permission-remediation-design.md` (record the settled three-class policy); `scripts/chrome-journeys.ts:845-892` (fix the comment; add the card assertion). Do NOT touch `extension/lib/capabilities.js` grant mechanics or `extension/lib/browser-command-lease.js` (CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01).
  - Steps: (1) Land CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01 (every denial → one card) — it extends this entry and is its first increment. (2) Policy vocabulary: a `permissionClass(toolName)` helper over `chrome-tool-capabilities.js` returning `read | act | destructive`; the card and Settings render the class name and a one-sentence explanation from a single strings table in `extension/shared/permission-copy.js` (new, imported by both pages so the copy cannot diverge). (3) Settings: replace the Browser control paragraph and the Allowed-origins textarea with the class table plus per-origin Act grants and Revoke (revoke through `capability.revoke`/`browser-control.set` in the SW, never the page realm — CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01). (4) Deny/cancel/retry outcomes: the card's Deny writes a `permission-denied` journal entry and the run reaches a terminal Failed state with Retry within 5 s (no "Waiting for permission" forever). (5) History: pending approvals and denials are listed by the hub timeline (CAP-FB-20260828-HUB-AS-TIMELINE-01) — this entry only guarantees the journal rows exist. (6) Docs: `docs/permission-remediation-design.md`, `docs/CONSTITUTION.md` permission section, CHANGELOG, `scripts/check-vocabulary.mjs` for the class names.
  - Out of scope: the denial-to-card conversion itself (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01); the lease deadlock (CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01); which tools are destructive (CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01); host-access posture and README truth (CAP-FB-20260830-HOST-ACCESS-STORY-01); headed attestation of Chrome's own prompts (CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01).
- Review: pending independent permission-model, owner-authority, privacy, recovery, Settings-synchronization, accessibility, and loaded-MV3 review of `docs/permission-remediation-design.md`; where no independent session is available, an author review clearing the falsification gates
- Gates: exact-host, activeTab, optional capability, and `<all_urls>` denial/remediation matrix; genuine Settings and browser permission gestures; agent/task policy versus Chrome-state assertions; owner-only prompt and inbox AX/keyboard checks; view changes, tab reopen, service-worker restart, deny/cancel/revoke/retry, same-run resume, stale-owner fencing, and synchronized Settings screenshots; the falsification gates apply.
  - Unit: add `tests/permission-denial-shape.test.ts` — iterate every browser tool through the executor doubles with all permissions absent and assert each denial satisfies `normalizePermissionRequirement` (non-null) — this is the test that goes RED on any remaining `permissionRequired` site; add `tests/permission-copy.test.ts` asserting the card, Settings and first-run copy read the same class strings from one table and that "always available" no longer appears in `options.html`. Falsification: re-introduce one `permissionRequired` site (revert one hunk of step 1), expect RED on "every browser-tool denial normalizes to a requirement", restore, expect GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — "denial card: open_tab on a fresh profile renders exactly one approval card", "denial card: Deny reaches Failed with Retry within 5 s", "settings: browser control describes Read / Act / Destructive and lists per-origin grants" (the comment at `:889` corrected); a headed run recorded for the Chrome `tabs` prompt itself (screenshot `grant-prompt-headed.png`, environment named). Screenshots `denial-card-open-tab.png`, `settings-browser-control-classes.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138).
  - Constraints: grants only from the owner's click (`chrome.permissions.request` inside the click handler); revoke via the SW route; the card is a `role="dialog"`-free inline region with a labelled Allow/Deny pair reachable by keyboard; origin strings rendered with `textContent`; no fixed debug port; no `<all_urls>` broadening.
- Blockers: must build on, but remain a separate user-facing workstream from, `CAP-FB-20260819-PERMISSIONS-01`; no implementation may make permission grants model-callable, silently broaden site access, or blanket-grant `<all_urls>`; the first increment is CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01 (lands first)
- Next: after DENIAL-TO-GRANT-CARD-01 lands, add `permissionClass()` and the single copy table, then rewrite `extension/options/options.html:187-206`.
- Recover: `git show bbeff7b:TASKS.md && git grep -n "permissions.request\|optional_permissions\|all_urls" bbeff7b -- extension`
- History:
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Verified the card machinery (`conversation.js:407`, `:485`), `permissionDenial` (`browser-tools.js:297`), the twelve legacy `permissionRequired` sites, the check-only `capability.request` (`service-worker.js:5807`), and the Settings copy contradiction (`options.html:189-190` vs `browser-tools.js:1565`). Reanalysis sources: tools lane finding 2, product lane finding 11, security lane finding 4.
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
  - 2026-08-30 16:10 UTC — `tests/worktree-audit.test.ts` leaked every fixture repo and its sibling worktrees into the tmpfs (8,960 `hygiene-*` directories, ~336k inodes, /tmp at 100%; `tests/cdp-client.test.ts` began failing with ENOSPC for every lane). Fixed on `cap/worktree-audit-test-cleanup`: fixtures and their `-wt`/`-orphan-wt` siblings are removed in a `finally` for each test; proven by counting `/tmp/hygiene-*` before and after a run (equal). Stale leaked fixtures older than 60 minutes were removed by the coordinator; nothing else in /tmp was touched.

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
- Gates: name consistency grep across manifest, UI strings, docs and README; every required and `optional_permissions` entry, and the install-granted `host_permissions: ["<all_urls>"]` (Q18 (a)), mapped to a calling site; store-mode archive builds and loads clean; privacy policy cross-checked against every network call the extension can make
- Blockers: the final name and distribution channel are undecided — `docs/OPEN-QUESTIONS.md` Q11 (tracked in `CAP-FB-20260825-OWNER-DECISION-QUEUE-01`). The owner-selected Wasm policy question (Q13) determines whether Store mode ships bundled-only; do not resolve it inside this task
- Next: obtain the name decision, then produce the permission-justification table mapped to calling sites — that table is the long pole and can be built before the name lands
- Recover: `git grep -n "Chrome Agent Platform" -- extension README.md && grep -n "optional_permissions" -A 20 extension/manifest.json`
- History:
  - 2026-08-25 09:40 UTC — opened. `CAP-FB-20260822-PACKAGE-ARCHIVE-FRESHNESS-01` covers building archives from an exact inventory; it does not cover listing, policy, justifications or the name.

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
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: product owner
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: each of the five open questions has a recorded decision in `docs/OPEN-QUESTIONS.md`, and every task blocked on it has its `Blockers` updated in the same commit. The five: **Q11** final extension name and distribution channel (blocks `CAP-FB-20260825-WEBSTORE-RELEASE-01`); **Q12** the recommended default provider for the hub, given Gemini Nano is weak at tool-calling (shapes first-run quality); **Q13** whether a Chrome Web Store build may execute owner-selected local Wasm without violating the remotely-hosted-code policy (blocks `CAP-FB-20260822-OWNER-WASM-INSTALL-01`, currently `BLOCKED`); **Q14** the Co-do licence and provenance reconciliation — Apache-2.0 root against MIT package metadata — which must be settled before any Co-do binary is copied (blocks `CAP-FB-20260822-BUILTIN-WASM-TOOLS-01`); **Q16** grouped tabular artifact promotion — an atomic reservable keyed promotion with refcount and orphan collection, or an explicitly lower single-body cap (blocks `CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01`). Added 2026-08-30 with recommended defaults recorded in `docs/OPEN-QUESTIONS.md`: **Q18** the host-access posture — install-granted `<all_urls>` with passive detection, described truthfully, or optional host access with `activeTab`-only detection (blocks `CAP-FB-20260830-HOST-ACCESS-STORY-01`, shapes `WEBSTORE-RELEASE-01` and `PRIVACY-STATEMENT-01`); **Q19** whether page-action tools are in scope (blocks `CAP-FB-20260830-PAGE-ACTION-TOOLS-01`, and through it `SIDE-PANEL-COMPANION-01`); **Q20** whether the product is "browser control" first or "coworker" first (orders the post-demo queue). Q12 now carries a measured recommendation (Gemini 2.5 Flash; blocks `CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01`). Q15 remains inside `SEMANTIC-TOOL-SEARCH-01`
- Review: none — these are owner decisions, not reviewable work. An agent may prepare options and trade-offs; it may not decide.
- Gates: each decision written down with its rationale, and each dependent task's `Blockers` field updated to match
- Blockers: requires the product owner. Q13 and Q14 additionally need external input — Chrome Web Store policy wording and the upstream licence position respectively — which an agent can gather and summarise first
- Next: the owner answers Q18, Q19 and Q12 before the demo script can be final — the recommended defaults are written beside each question so a "yes" is enough; Q13, Q14 and Q16 are parked until after the demo
- Recover: `sed -n '/^## Open/,$p' docs/OPEN-QUESTIONS.md`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (product lane, with the security, tools and live lanes): recorded recommended defaults for Q11-Q16 and added Q18-Q20 in `docs/OPEN-QUESTIONS.md`. Three of them (Q18 host access, Q19 page actions, Q12 default model) gate demo-path entries; the rest are parked. See `REVIEW-2026-08-30.md` section 4.
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
## [CAP-FB-20260829-OWNER-OBSERVABILITY-01] Owner-grade console and run logs
- Feedback: 2026-08-29 — owner: tool calls and their details are missing from the console, local logs are over-redacted for an owner-only extension, and retained run logs are not discoverable
- Updated: 2026-08-29 23:58 BST
- Status: IN_REVIEW
- Priority: P1
- Owner: implementer (worktree lane)
- Workspace: active (local path private)
- Branch: `cap-observability`
- Base: `origin/main@90b4a837`
- Candidate: branch `cap-observability` (not pushed)
- Shipping: —
- Acceptance: Verbose logs every model-visible and resolved tool dispatch with name, arguments, paired start/end, outcome/error and duration across management, Chrome API, bundled Wasm, provider-server and WebMCP sources; Settings owns verbosity plus an explicit full-local-detail toggle; trace/export/report buffers remain redacted regardless; every retained conversation or background run is reachable through Run logs and has a bounded 200-entry View log timeline
- Review: required fresh-session review; author falsification records RED/GREEN focused assertions before handoff
- Gates: focused owner-observability/cap-log/lazy/run-scope/durable tests; full `nice -n 10 deno test --allow-all tests/`; developer build; loaded-extension Settings and Run logs journey
- Blockers: —
- Next: independent review of the candidate and browser evidence, then coordinator merge
- Recover: `git log --oneline --all --grep='owner-grade tool and run observability'`
- History:
  - 2026-08-30 00:12 BST — falsification: with product files restored to `origin/main@90b4a837` and only `tests/owner-observability.test.ts` present, the focused gate was RED at type-check because `runsForSurface` did not exist; restoring the candidate made the focused owner/cap-log/lazy set GREEN (32/32). The lazy hostile-accessor regression also caught an initial logger read of an untrusted `ok` getter; descriptor-only snapshots fixed it and returned the existing hostile-input test to green without weakening its assertion.
  - 2026-08-29 23:58 BST — candidate implemented: one paired `observeToolCall` seam wraps the lazy dispatcher (all catalog sources), direct worker Chrome/management dispatch and the WebMCP bridge; agent-do hooks also log search/list/execute envelope calls. Settings adds verbosity and full-local-detail controls while the export ring stays unconditionally redacted. The existing durable run registry is now discoverable after terminal settlement, paginates every retained run, and loads the latest 200 timeline rows per run instead of an unbounded dump.

- id: CAP-FB-20260826-OBSERVABILITY-01
  severity: P1
  status: done
  landed_version: 0.2.287
  summary: "Owner (2026-08-26): the extension has NO observability. Significant logging was requested before but isn't there. Clicking a task takes ~10s with zero trace of what's happening. One error seen: 'VM5974:2 Uncaught TypeError: Cannot read properties of undefined (reading startTime)' in et.reportAllChanges — that script is MINIFIED and is NOT our shipped code (our SW + options bundles are already unminified; grep confirms reportAllChanges absent), so it's a page the agent visited — we need logging to separate ours from theirs. REQUIREMENTS: (1) debug build with unminified code + source maps in npm run build; npm run build:production / --target=store stays the minified Store bundle; (2) a real logging layer — structured console logs with namespaces + levels + timing (grep-able like [cap:sw:grant]), console.groupCollapsed for runs; (3) performance.mark/measure around every slow path (task load, navigation, tool dispatch, model round-trips) + summary timing logs so a 10s task load becomes a readable breakdown; (4) use Chrome's native logging/performance features throughout (SW, NTP, side panel, content scripts); (5) a way to dump/ship the trace. Goal: use observability to improve the product. CRITICAL: debug mode must NOT weaken the production security assertions (seam scan, no-new-Function, oracle scan, bundled-tool verify) — logging verbosity is the only thing debug relaxes."


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

## [CAP-FB-20260829-URGENT-UI-REPAIR-01] Restore Agents and create-dialog visual quality
- Feedback: 2026-08-29 — owner reported visual regressions from the landed Agents merge and create-dialog declutter lanes: the background picker was replaced by 22 phantom rows, provider/template selects showed double arrows, agent edit actions drifted out of their action group, the template and microphone disappeared behind Advanced, and disclosures changed the dialog width
- Updated: 2026-08-29 23:22 BST
- Status: IN_REVIEW
- Priority: P0
- Owner: implementation lane
- Workspace: durable worktree
- Branch: `cap-ui-repair`
- Base: `origin/main@cebb4601`
- Candidate: `36d60d40` plus this tracker/changelog commit
- Shipping: —
- Acceptance: Settings uses one compact rich background-agent picker and lists only created/enabled agents; every base-select has one arrow, rich options and contained single-line closed state; agent actions share one group; create dialog visibly orders Name, what it does with voice, template, English schedule, then Advanced; dialog width is stable with disclosures contained
- Review: pending required independent acceptance review of candidate diff plus before/after screenshots
- Gates: visual KAT 11/11; full Deno suite 2388/0; developer build clean; focused source tests 15/15; changed source pins observed RED against the unfixed sources and GREEN after
- Blockers: —
- Next: independent acceptance review, then coordinator integration
- Recover: `git log --oneline --all --grep CAP-FB-20260829-URGENT-UI-REPAIR-01`
- History:
  - 2026-08-29 23:22 BST — candidate gated: real loaded-extension KAT 11/11 (including genuine Add click and opened rich pickers), full suite 2388/0 and developer build clean. Dialog geometry is 582px in collapsed, Advanced-open and Skills-open states with zero horizontal overflow. The new fixed-width source assertion failed against the prior product and passed after; the corrected Settings projection assertions failed against `cebb4601` and passed after.
  - 2026-08-29 23:18 BST — replaced the content-driven `min-width` with one clamped width plus shrink-safe Advanced/Skills containment. The browser width assertion moved from RED `[582,615.89,878.06]` to GREEN `[582,582,582]`; opened-disclosure screenshots were inspected and show no horizontal jump or overflow.
  - 2026-08-29 23:14 BST — restored the create-dialog hierarchy requested after visual review: Name and What it does remain first; microphone/Refine are visibly attached to the purpose field; the rich template select and English schedule follow before Advanced. The real-browser order and visible-voice assertions turned green while the separate width-jitter assertion remained RED for the next atomic fix.
  - 2026-08-29 23:10 BST — removed the hand-drawn chevron from the shared `<provider-select>` and styled the one native `::picker-icon`; rich options now carry safe inline SVG icons, the closed state is one-line/ellipsis/min-width contained, and Save/Edit/Delete share one wrapping `.ag-actions` row. Browser assertions for provider containment, one provider arrow, one template arrow and action grouping are green.
  - 2026-08-29 23:05 BST — RED browser run captured 1/10 pass: Settings rendered all 22 disabled background templates as rows; provider/template each had the native picker icon plus a custom SVG; voice/template/schedule were behind Advanced; opening Skills widened the dialog from 582px to 878px. First repair restores the compact rich background picker with an explicit Add action and projects only created/enabled agents into management rows; its two focused KAT assertions are now green.

## [CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01] Create-agent dialog is cluttered and its schedule/theme controls are inconsistent
- Feedback: 2026-08-29 — product owner asked to declutter persona controls, accept schedules in plain English, replace the large background-template list with a subtle select, and fix dark conversation contrast
- Updated: 2026-08-30 11:00 UTC
- Status: IN_REVIEW
- Priority: P1
- Owner: implementation session
- Workspace: active (local path private)
- Branch: `cap-create-dialog`
- Base: `origin/main@54d70a9b`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: create-agent keeps name, what-it-does and Create dominant while every persona/advanced capability remains reachable; schedules parse deterministic supported English into the existing period/task shape and reject ambiguous text inline; the large template/background choice becomes the same native base-select vocabulary as provider selection; message bubbles and JSON tool-response rows inherit scheme-aware surface and ink tokens through their shadow boundaries; follow-up (edit mode): the dialog footer is Cancel · Save only, "Regenerate avatar" sits beside the avatar in Advanced, "Delete agent" leaves the dialog (the agent view header already has Delete), and Advanced is a flat list of `capability-row`s (Avatar · Skills · Delegation · Context files) with no bordered sub-panel
- Review: independent round 1 REVISE (P1 partial schedule failure was discarded; P2 feedback recommended unsupported calendar timing); both fixed; independent round 2 PASS with no remaining findings
- Gates: focused dialog/parser/select/dark tests 21/21; dark token tests observed RED before each missing alias and GREEN after; post-review full suite 2367/0 and developer build clean; loaded-extension template journeys 37/0 and 6/0; new user-bubble and JSON-preview computed dark-color checks green (the shared dark-scheme audit retains its three documented pre-existing failures)
- Blockers: —
- Next: coordinator merges the five-commit candidate
- Recover: `git log --oneline --all --grep CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (ui lane): the Create state is the best-composed dialog in the product (clear hierarchy, one primary, stable width) — delivered. Edit mode is not: the footer carries four actions ("Delete agent" in danger red, "Regenerate avatar", "Cancel", "Save"), Advanced stacks nested cards (Avatar/Upload, Skills "54 available" as a nested disclosure, "Can delegate to", a Context files fieldset with a lone "+") inside a `<details>` inside a dialog, and Delete has three entry points. Recorded as a follow-up acceptance item; the in-review candidate is not blocked by it. Files: `extension/ntp/ntp.js` (`openAgentDialog`), `extension/shared/components.js` (`agent-dialog`).
  - 2026-08-29 21:05 UTC — independent review round 2 PASS: verified `scheduleError` propagation, explicit partial-success warning, supported-only examples and regression pins; no remaining findings
  - 2026-08-29 20:55 UTC — independent review round 1's two findings fixed: `{ ok: true, scheduleError }` now remains an honest partial success that opens the saved agent but warns that its schedule was not created, pinned across the SW and dialog contract; invalid feedback now suggests only schedules the parser accepts
  - 2026-08-29 20:42 UTC — five-commit candidate gated: full suite 2366/0, developer build clean, template journeys 37/0 and 6/0, focused 20/20, and both new computed dark-color checks green. The shared dark-scheme audit remains 34/3 because its pre-existing Options active-tab and artifact sample-count findings are outside this lane; the candidate-specific checks pass
  - 2026-08-29 21:30 UTC — diagnosed the related JSON response seam: keys/leaf values already resolve through scheme-aware ink/accent/muted tokens, but container preview text used undefined `--fg`, so near-black `#1c1a17` won on the dark panel. `--fg` now aliases `--text`; the new token test was observed RED before the alias (6/7) and GREEN after (7/7), with a loaded-extension computed-color assertion added
  - 2026-08-29 21:15 UTC — diagnosed user-bubble dark contrast precisely: custom properties do inherit across the message-bubble shadow boundary, but `--secondary-layer` was never defined, so its light `#efede8` fallback won; it now aliases the scheme-aware `--panel-2` token. The new token-chain test was observed RED before the alias (5/6) and GREEN after (6/6); a loaded-extension computed-color assertion was added
  - 2026-08-29 21:00 UTC — the large create-dialog template card list now reuses the shared `<provider-select>` native base-select with Custom agent as its default; starter-first catalogue order and editable one-step prefill are preserved, and the loaded-extension template journeys were updated to drive the real select
  - 2026-08-29 20:45 UTC — schedule input now parses deterministic interval English into the existing period/task shape, presents the interpretation in a polite inline status, and blocks garbage or calendar timing the interval-only scheduler cannot represent; focused parser/dialog tests 10/10
  - 2026-08-29 20:30 UTC — implementation started from current origin/main; the primary name/what-it-does path now precedes one collapsed Advanced disclosure containing avatar, template, persona tools, skills, schedule, delegation and context files

## [CAP-FB-20260829-AGENTS-SETTINGS-MERGE-01] Unify interactive and scheduled agents in Settings and the task sidebar
- Feedback: 2026-08-29 — owner directive: background agents and agents must be merged in Settings, and background agents must be visible in the left Agents menu on the task view
- Updated: 2026-08-29 UTC
- Status: IN_REVIEW
- Priority: P1
- Owner: implementation lane
- Workspace: durable worktree
- Branch: `cap-agents-merge`
- Base: `54d70a9b`
- Candidate: this commit
- Shipping: —
- Acceptance: Settings has one Agents nav destination and one management list containing named and scheduled/background agents without changing their stores or routes; rows distinguish on-demand, running schedules, and stopped schedules in plain language; persona/provider/schedule, enable/disable, duplicate, prompt edit, and delete remain reachable; the task sidebar lists stopped as well as running background agents and opens their existing detail/history surface
- Review: required fresh-session review of the candidate diff plus browser evidence
- Gates: focused agent display/deep-link/navigation/options tests; full Deno suite; developer build; loaded-extension Settings and task-sidebar interaction screenshots
- Blockers: —
- Next: independent acceptance review, then coordinator merge
- Recover: `git log --oneline --all --grep=CAP-FB-20260829-AGENTS-SETTINGS-MERGE-01`
- History:
  - 2026-08-29 20:29 UTC — implementation started from `origin/main@54d70a9b`; presentation-only merge keeps named-agent and background-recipe stores/routes distinct, preserves legacy `#background` and `#background-agents` links by normalizing both to `#agents`, and deliberately leaves callable-only filtering in the execution picker rather than applying it to display surfaces.
  - 2026-08-29 20:44 UTC — author falsification: with `agent-display.js` removed, its three changed tests failed type-check/import (RED); with `pure.js` and `options.html` restored to `origin/main`, the final deep-link/structure assertions failed 3 pass / 2 fail (RED). Restored candidate: focused suite 20/20 and build green.
  - 2026-08-29 21:02 UTC — first full suite reached 2359 pass / 4 fail and exposed cross-surface drift: generated changelog copy carried internal IDs, the security pin still hard-coded 13 Settings destinations, two onboarding strings named the removed Background agents section, and the sidebar repeated “Agents” in its accessible name. All four root causes fixed; focused regression set 34/34 and vocabulary/gallery/build green.
  - 2026-08-29 21:55 UTC — suite 2363 pass / 0 fail and developer build green. Real loaded-extension CDP acceptance seeded interactive agents, observed stopped schedules in the task sidebar, opened a stopped agent surface, deep-linked Settings to the unified list, enabled a stopped schedule and observed its marker change, then enabled provider tools and verified the Gemini/Anthropic billing copy plus per-agent search consequence.
  - 2026-08-29 22:02 UTC — expanded browser acceptance falsified the standalone Settings “Edit persona & schedule” fallback: it navigated to the agent surface but did not open the maintained dialog. Added one explicit, parsed `&edit=1` route; embedded Settings still uses its extension-owned parent message. Focused route/deep-link/display tests 20/20, suite 2364/0, and build green.
  - 2026-08-29 22:12 UTC — independent review REVISE (P1): Settings bypassed `projectUnifiedAgents`, so a named slug matching a recipe ID rendered one conceptual agent in the hub/sidebar but two conflicting Settings rows. Settings now consumes the shared projection; projected rows retain both source records and a collision renders one row with named controls plus a “Scheduled automation” subrow. Collision regression included; focused suite 29/29 and loaded-extension acceptance 12/12 with screenshots `.cache/agents-merge-evidence/01`–`06`.
  - 2026-08-29 22:24 UTC — first post-review full run 2364/1 caught the responsive source pin no longer matching a comma-grouped selector; retained the explicit narrow `.background-agent-row` rule and added its collision-control sibling. Focused responsive/display/schedule set 14/14, final suite 2365/0, developer build green.

## [CAP-FB-20260829-SETTINGS-NAV-ORDER-01] Settings nav follows the rendered document order
- Feedback: 2026-08-29 — while unifying Agents, the owner observed that Settings navigation listed Skills before Agents while the document rendered Agents before Skills
- Updated: 2026-08-29 UTC
- Status: IN_REVIEW
- Priority: P2
- Owner: implementation lane
- Workspace: durable worktree
- Branch: `cap-agents-merge`
- Base: `486066fc`
- Candidate: this commit
- Shipping: —
- Acceptance: Settings left-nav href order exactly equals the top-level panel section order
- Review: required with the parent Agents merge candidate
- Gates: parser pin over `options.html`; full suite and build
- Blockers: —
- Next: independent acceptance review, then coordinator merge
- Recover: `git log --oneline --all --grep=CAP-FB-20260829-SETTINGS-NAV-ORDER-01`
- History:
  - 2026-08-29 20:47 UTC — falsification RED: the new parser pin showed Skills before Agents in nav but after Permissions in the document; moved the existing Skills nav item after Permissions, producing exact order parity without moving any panel.

## [CAP-FB-20260829-PROVIDER-TOOLS-COPY-01] Explain provider-run tool toggles per agent
- Feedback: 2026-08-29 — owner could not tell what the per-agent provider-tool toggles enabled, and the global explainer still described Gemini only after Anthropic web search shipped
- Updated: 2026-08-29 UTC
- Status: IN_REVIEW
- Priority: P2
- Owner: implementation lane
- Workspace: durable worktree
- Branch: `cap-agents-merge`
- Base: `e52b22a6`
- Candidate: this commit
- Shipping: —
- Acceptance: the Providers panel names both Gemini grounding and Anthropic web search; the per-agent block has a visible heading, billing hint, and a consequence line saying enabled agents may search the web during runs; no controls move out of Providers
- Review: required with the parent Agents merge candidate
- Gates: focused copy contract; full suite and build
- Blockers: —
- Next: independent acceptance review, then coordinator merge
- Recover: `git log --oneline --all --grep=CAP-FB-20260829-PROVIDER-TOOLS-COPY-01`
- History:
  - 2026-08-29 20:52 UTC — falsification RED: the copy pin failed on the Gemini-only global explainer before the subheading, billing hint, stable per-agent list, and per-row consequence line were added.

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
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned (IA requires product-owner sign-off)
- Workspace: `cap-settings-cleanliness`
- Branch: `cap-settings-cleanliness`
- Base: `54c92834`
- Candidate: `cap-settings-cleanliness` (design + dead-control safe subset; pending review)
- Shipping: —
- Acceptance: opening Settings renders the requested section, not all twelve; the sidebar nav switches sections rather than scrolling to anchors; each section remains individually addressable by URL (the deep-link requirement the owner already set for the back-stack work); and the DOM node count on open drops substantially from the current 2,255. The single-history-entry back behaviour from `0.2.296` must be preserved; nav items are `<button aria-current="page">` and there are at most 8 top-level entries — Board permissions, Hooks, Tool library and Advanced → Observability demote into one Advanced page; the twelve 16x19 px section-anchor copy-link buttons become the section's own URL or are deleted; every `<select>` in `extension/options/options.html` carries `class="control"` so the shared base-select vocabulary applies, and the board-permissions Agent select has a placeholder option; "Access Mode" becomes sentence case; the Usage active-tab contrast (white on the dark-scheme accent, 2.39:1) is fixed by giving the accent-on-fill token its own dark ink in `extension/shared/theme.css` and the five hero-metric tiles become one line with the chart shown only when there is data — the "pre-existing" exemption in `scripts/a11y-audit.ts` and `scripts/kat-dark-scheme.ts` is removed; the changelog renders only when About is opened (last five entries plus "show all"); the 1.5 s usage timer stops when Usage is not visible; Settings opens with under 800 DOM nodes and the journey suite asserts the budget; the duplicated brand header inside the embedded frame is dropped
  - Context: the nav is thirteen `<a class="nav-item" data-section=…>` at `extension/options/options.html:16-52`, the sections thirteen `<section class="panel">` at `:65-329`, all rendered at load by the bootstrap at the end of `extension/options/options.js` (`renderToolLibrary()` at `:2930` is one of the calls). Nav clicks go through `navigationController.navigate(targetHash, { replace: true })` (`options.js:2906-2916`) and the section activation sets `aria-current` then `scrollIntoView` (`:2796-2810`) — a scroll, not a switch. Valid section ids are `SETTINGS_SECTIONS` (`extension/lib/pure.js:774`) and `tests/options-nav-order.test.ts` asserts nav order equals section order. Seven native `<select>` in `options.html`; the shared rule is `select.control { appearance: base-select }` at `extension/shared/components.js:6352`. `--btn-fg` is defined at `theme.css:31` and its dark half at `:52` (`light-dark(#ffffff, #101b18)`) — the Usage range button does not use it, which is why the 2.39:1 failure exists; no "pre-existing" string remains in `scripts/a11y-audit.ts` or `scripts/kat-dark-scheme.ts` at this tip (verified by grep), so the exemption lives in the lanes' evidence notes only — the fix is still one token. The Usage poll is `setInterval(... renderUsage ..., 1500)` at `options.js:2942` (a second 1.5 s timer at `:2853`). The About changelog renderer is `options.js:3020-3075` and fetches the full generated changelog on load. The six-group IA awaiting sign-off is in `docs/SETTINGS-CLEANLINESS.md:32-…`. What must NOT change: the replace-not-push history contract (`CAP-FB-20260826-BACK-STACK-01`), deep links `#<section>`, `tests/settings-cleanliness.test.ts`, `scripts/kat-settings-cleanliness.ts`.
  - Reproduce today: (1) `npm run build`, load the extension, open `options/options.html`; (2) `document.querySelectorAll("section.panel").length` = 13 and none is `hidden`; `document.body.scrollHeight` ≈ 12-13.7k px; `document.getElementsByTagName("*").length` ≈ 3,100 on this tip (About renders the whole changelog); (3) click "Hooks" in the nav: the page scrolls, the URL hash changes, all other sections stay in the DOM; (4) in the dark scheme, Settings → Usage: the selected "7 days" tab is white on `rgb(83,184,169)`.
  - Files: `extension/options/options.html` (nav `:16-52` → `<button class="nav-item" aria-current="page">`; sections `:65-329` gain `hidden` except the active one; the 12 `section-anchor` copy buttons removed; the seven `<select>` get `class="control"`; the embedded-frame brand header removed; "Access Mode" label); `extension/options/options.js` (`:2796-2810` activation → toggle `hidden` and focus the section heading instead of `scrollIntoView`; lazy renderers keyed by section — call `renderHooks`/`renderPermissions`/`renderToolLibrary`/About only on first activation; `:2942` and `:2853` timers gated on Usage visibility; `:3020-3075` About renders five entries plus "Show all"); `extension/lib/pure.js:774` (`SETTINGS_SECTIONS` — add the `advanced` group id; the demoted ids stay valid and resolve to the Advanced page with a sub-anchor); `extension/shared/theme.css` (the Usage range button uses `--btn-fg`); `docs/SETTINGS-CLEANLINESS.md`. Do NOT touch `extension/lib/navigation-controller*` beyond calling it; do NOT combine this with the dead-control removal already on `cap-settings-cleanliness`.
  - Steps: (1) Owner sign-off on the six-group IA (record the decision in History). (2) Section switching only: `hidden` on inactive sections, `aria-current="page"` on the nav button, focus moved to the section `<h2>` on switch, deep links intact; `tests/options-nav-order.test.ts` stays green. (3) Lazy mount: wrap each expensive renderer in a once-per-section guard; About fetches the changelog on first open; the usage timers start on Usage open and stop on leave. (4) Journey budget: assert `< 800` nodes on open and `< 2` screen heights per section. (5) Demote Board permissions, Hooks, Tool library, prompts/observability into one Advanced page (coordinate with CAP-FB-20260830-EXEC-BUILD-FLAG-01, which hides the same set by default — the flag decides visibility, this entry decides placement). (6) Selects: add `class="control"` to the seven; placeholder option for `#board-deny-agent`. (7) Contrast: the Usage range button uses `color: var(--btn-fg)`; the tiles become one line; extend `scripts/a11y-audit.ts` to fail on any AA contrast miss (no exemption list). (8) Remove the duplicated brand header inside the frame (coordinate with CAP-FB-20260830-ONE-SHELL-01 which drops the embedded H1s). (9) CHANGELOG; `docs/DESIGN.md` Settings section.
  - Out of scope: Hooks/Permissions card walls becoming tables (CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01 — lands after this); the changelog copy itself (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01); unlabeled controls (CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01 covers the `<label for>` sweep); the developer flag (CAP-FB-20260830-EXEC-BUILD-FLAG-01).
- Review: required — fresh-session review of the design and safe-subset diff; the later monolith implementation still requires before/after node counts and section heights from a real loaded extension
- Gates: Chrome journeys green (several journeys drive Settings sections by `.nav-item[data-section=...]`); a11y pass on the section switch (focus and heading order); the impeccable design pass; the falsification gates apply.
  - Unit: extend `tests/options-nav-order.test.ts` with "every section except the active one is hidden after activation" (drive `activateSection` in the DOM double) and "every select in options.html carries class control"; extend `tests/settings-cleanliness.test.ts` with "the Usage range button uses the accent-on-fill ink token". Falsification: revert step 2, expect RED on "inactive sections hidden", restore, expect GREEN; revert step 7's token change, expect RED on the contrast check in `scripts/a11y-audit.ts` (record the measured ratio), restore, expect GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — add "settings: opens with fewer than 800 DOM nodes", "settings: clicking Hooks hides Providers and focuses the Hooks heading", "settings: no section exceeds 2 viewport heights"; `deno run -A scripts/a11y-audit.ts` 17/17 and `deno run -A scripts/kat-dark-scheme.ts` with zero contrast failures. Screenshots `settings-providers-only.png`, `settings-hooks-only.png`, `settings-usage-dark-after.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138).
  - Constraints: nav buttons carry `aria-current="page"`; focus moves to the section heading on switch (`tabindex="-1"` on the `<h2>`); base-select vocabulary via `class="control"`; the changelog is rendered from generated data with `textContent` per entry (the existing renderer at `options.js:3040-3056` builds elements — keep that; `:3065` uses `innerHTML` for a static string only); no fixed debug port; no emoji.
- Blockers: —
- Next: owner sign-off on the six-group IA in `docs/SETTINGS-CLEANLINESS.md`; then implement one selected group at a time without combining that architecture change with the reviewed dead-control removal
- Recover: `git grep -n 'section.panel' -- extension/options/options.html`
- History:
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Verified the nav handler (`options.js:2906-2916`, replace-navigation) and the scroll activation (`:2796-2810`), the two 1.5 s timers (`:2853`, `:2942`), the About renderer (`:3020-3075`), seven native selects, and that no "pre-existing" exemption string exists in the two audit scripts at this tip — the contrast fix is one token on the Usage range button.
  - 2026-08-30 11:00 UTC — reanalysis (ui, perf and product lanes): still 12-13.7k px tall with all sections rendered; measured 3,115 DOM nodes on open, 2,059 of them the About section rendering the whole 72 KB changelog at load; 13 nav anchors plus 12 tiny copy-link buttons; 7 native `<select>`s against the base-select vocabulary used everywhere else; the Usage "7 days" tab is the only AA contrast failure across six surfaces in both schemes and has been marked "pre-existing" by three lanes instead of fixed (one token). Folded those into Acceptance. Sequencing: CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01 lands after this. The exec-build developer flag (CAP-FB-20260830-EXEC-BUILD-FLAG-01) removes most of the demoted sections from the default nav independently.
  - 2026-08-29 UTC — design-first cleanliness pass added `docs/SETTINGS-CLEANLINESS.md` with a six-group IA (Providers & models · Agents · Permissions & security · Tools · Data · Advanced). The safe subset removes only provably dead request-era UI: the unmatched Appearance nav/hash, the already-deleted Approvals hash, and the storage-verification button/component that could only repeat `permissions.contains()` for a required install grant. The long-page/one-section-at-a-time IA remains OPEN for owner sign-off.
  - 2026-08-27 23:30 UTC — measured in a real loaded extension: the Settings document is **12,837px tall — 8.8 viewport-heights — with 2,255 DOM nodes, and all twelve `section.panel` elements rendered and visible simultaneously** (`display:none` count: zero). The thirteen `.nav-item` controls scroll to anchors rather than switching views, so the information architecture the nav implies does not exist. Section heights: hooks 2,818 · permissions 2,182 · providers 1,762 · about 1,376 · tool-library 1,172 · prompts 1,016 · agents 729 · data 418 · local-folders 300 · background 269 · browser 211 · usage 202. Everything is built on every open regardless of what the owner came for.

## [CAP-FB-20260827-DEAD-COMPONENTS-01] Components ship to users but are only used by the gallery
- Feedback: 2026-08-27 — found during the pre-exec-demo UX audit
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cf0da958`
- Candidate: —
- Shipping: —
- Acceptance: every custom element defined in `extension/shared/components.js` that no extension page mounts has a recorded verdict — ADOPT (named page and owning entry) ADOPT-later (RETAIN, with the candidate home) — in the table below. Owner directive 2026-08-30: NOTHING is deleted; every element stays in `components.js` and keeps a gallery specimen until an entry adopts it. Done = every row in the table has ADOPT or RETAIN with a named target; `scripts/check-components.mjs` exists and passes with the RETAIN rows as its allowlist (each allowlist line carries the candidate home); `docs/components.html` labels each RETAIN specimen "Not yet in the product — reserved for <target>"; the `theme` install seed and the DESIGN.md Themes line are corrected; no component source is removed.
  - Context: the reanalysis ui lane (finding 14) found fourteen elements defined in `extension/shared/components.js` and referenced by nothing under `extension/` except the define line (verified in this tree by grep over `extension/`, `scripts/`, `tests/` excluding `dist/` and `components.js` itself; the only hit outside is a comment at `extension/options/options.js:52`). `conversation-run-status` is a fifteenth in the same state and is listed because CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01 adopts it. 42 elements are defined in total (8,855 lines). Owner directives 2026-08-30: agent templates are being INTEGRATED (`agent-template-card` is ADOPT, not delete); components the templates or the jobs board use are never cut. The install seed still writes `theme: "dark"` (`extension/background/service-worker.js:7724`) and `docs/DESIGN.md:27` still documents four themes; the gallery mounts `<theme-picker>` at `docs/components.html:16` and `:61`. Per-component table (name · what it renders · lines in `extension/shared/components.js` · verdict · target):
    - `agent-config-form` · a three-field form (Name, Instructions, Skills comma-list) with a "Save agent" button emitting `save` · `:6243-6275` · RETAIN · owner directive 2026-08-30: gallery components are kept for future use. Candidate home: a lightweight inline "quick agent" form for the side-panel companion (CAP-FB-20260830-SIDE-PANEL-COMPANION-01). Stays in the gallery with a specimen until adopted.
    - `agent-nav` · a `role="tab"` strip over a `VIEWS` list with `aria-selected` and a `navigate` event · `:6634-6655` · RETAIN · owner directive 2026-08-30. Candidate home: the tab strip for the side-panel companion views (CAP-FB-20260830-SIDE-PANEL-COMPANION-01) or the Settings pages once SETTINGS-MONOLITH-01 splits them. Stays in the gallery until adopted.
    - `agent-template-card` · a template card: name, 2-line persona, up to three skill chips + overflow, a "Starter" badge, a "Use" button with an accessible name · `:1874-1935` · ADOPT · CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01 (the template gallery in the create dialog / hub; `tests/template-cards.test.ts` already pins its rendering and the gallery specimen).
    - `artifact-inspector` · meta bar (type · size · origin), "Copy exact content", a bounded 64 KiB source `<pre>`, and an HTML preview through `createHtmlFrame` · `:2267-2330` · ADOPT · CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01 (source view + diff in the artifact viewer); no gallery specimen exists today — add one when adopted.
    - `loading-state` · a 3x3 pixel-grid loader with a label and optional elapsed seconds, `role="status"` · `:5212-5238` · ADOPT · CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01 (note: `conversation-run-status` embeds the same grid — that entry decides whether `loading-state` is used standalone, e.g. artifact preview loading, or merged and this one deleted).
    - `permission-row` · label + description, "Granted / Not granted · warns" state text, Enable/Disable button emitting `enable`/`disable` · `:1802-1836` · ADOPT · CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01 (the Permissions list; that entry picks between this and the currently used `capability-row` `:2135` and deletes the loser).
    - `prompt-bar` · a textarea with model pill, mic and attach buttons and a suggestion listbox · `:5650-5725` · RETAIN · owner directive 2026-08-30. Candidate home: the compact composer for the side-panel companion where the full `agent-composer` is too tall (CAP-FB-20260830-SIDE-PANEL-COMPANION-01). Stays in the gallery until adopted.
    - `run-task-button` · an accent button with a spinner and `run-task` event · `:791-820` · RETAIN · owner directive 2026-08-30. Candidate home: the "Run now" control on agent cards and the scheduled-run timeline rows (CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01). Stays in the gallery until adopted.
    - `screenshot-strip` · a horizontal strip of 96x64 thumbnails emitting `open` · `:4117-4144` · ADOPT · CAP-FB-20260830-GENERATED-IMAGE-STRIP-01 — the owner wants an image strip of generated things (screenshots the agent took, image artifacts it produced) in the thread and on the hub timeline; this component is the strip.
    - `site-agent-card` · `@host` badge, tool count, optional status, keyboard-operable `role="button"` emitting `select` · `:1839-1869` · ADOPT · CAP-FB-20260825-SITE-AGENT-SHOWCASE-01 (the "<host> offers N tools" chip above the composer and the Site Agents list).
    - `streaming-text` · markdown body with a blinking caret while `streaming`, source chips and action buttons · `:5560-5596` · ADOPT · CAP-FB-20260830-TRANSCRIPT-STREAMING-01 (the growing assistant bubble; it must append via `textContent`/the markdown renderer's escaping, never innerHTML on model text).
    - `theme-picker` · four 44 px swatches (Sunlit, Midnight, Neon, Terminal) emitting `theme-change` · `:1726-1753` · RETAIN · owner directive 2026-08-30 (nothing is deleted). The theme feature was removed at 0.2.301, so the specimen is labelled "not shipped" in the gallery; the `theme` seed at `service-worker.js` install and the Themes line in `docs/DESIGN.md` are still corrected because they describe a feature the product does not have.
    - `thinking-trace` · a `<details>` "reasoning" disclosure rendering an ordered step list (label + text) or slotted trace · `:5407-5444` · ADOPT · CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 (the collapsed run of steps; also a candidate body for CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01).
    - `tool-chips` · a wrap of pill chips with done/running/error dots emitting `select` · `:5449-5479` · ADOPT · CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 (the collapsed representation of consecutive successful calls).
    - `conversation-run-status` · a `role="status"` run banner with tone, pixel grid, label, Stop and an action button · `:5244-5297` · ADOPT · CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01 (the run banner).
  - Reproduce today: (1) `for c in agent-config-form agent-nav agent-template-card artifact-inspector loading-state permission-row prompt-bar run-task-button screenshot-strip site-agent-card streaming-text theme-picker thinking-trace tool-chips conversation-run-status; do grep -rl --include=*.js --include=*.html "$c" extension scripts tests | grep -v "extension/dist\|shared/components.js"; done` — only `extension/options/options.js` (a comment) prints; (2) open `docs/components.html` in a browser: the theme picker specimen renders four swatches for a feature the product no longer has.
  - Files: `scripts/check-components.mjs` (new); `tests/check-components.test.ts` (new); `docs/components.html` (specimen labels for the RETAIN rows; the `theme-picker` specimen gets the "not shipped" label, `:16` and `:61`); `docs/DESIGN.md` (remove the Themes line); `extension/background/service-worker.js` (remove the `theme` key from the install seed near `:7724`). Do NOT delete anything from `extension/shared/components.js`.
  - Steps: (1) Write `scripts/check-components.mjs`: parse every `customElements.define("<name>"` in `extension/shared/components.js`, grep every non-gallery `extension/**/*.{html,js}` (excluding `dist/`) for `<name>` as a tag or `document.createElement("<name>")`, and fail on any defined element that is neither mounted nor in the allowlist. Seed the allowlist with the six RETAIN rows, each with its candidate entry id in a comment. Run it — it must pass with exactly those six allowlisted and list nothing else (falsification baseline: remove one allowlist line, expect FAIL naming that element). (2) Add the gallery labels for the RETAIN specimens and the "not shipped" label on `theme-picker`. (3) Remove the `theme` install seed and the DESIGN.md Themes line. (4) Wire the checker into `npm run build` next to `check:gallery`. (5) `CHANGELOG.md` line in user language.
  - Out of scope: adopting any component (each target entry above); module-level dead code (CAP-FB-20260830-DEAD-CODE-CUT-01, which consumes this table); the `tool-directory-card` zero-width bug (ui lane finding 15 — file separately if not already tracked).
- Review: independent review by a different model/session where available, otherwise an author review clearing the falsification gates
- Gates: unit suite; `npm run check:gallery`; Chrome journeys green; the falsification gates apply.
  - Unit: add `tests/check-components.test.ts` running the checker in-process: "every defined element is mounted by a non-gallery page or allowlisted with an entry id" and "the allowlist contains only elements that are actually unmounted". Falsification: keep `run-task-button` defined but unlisted (i.e. run the check before step 3), expect RED naming exactly the six DELETE elements; after step 3 expect GREEN. Guard for deleted coverage: the checker itself is the assertion that fails if a deleted element is re-added without a consumer.
  - Browser: `npm run test:components` (`scripts/component-gallery-smoke.ts`) green with the specimens removed; `deno run -A scripts/chrome-journeys.ts` unchanged and green. Screenshot `gallery-after-dead-components.png` showing no theme picker and no prompt-bar specimen.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138).
  - Constraints: deletions are forward-only commits; the checker uses no eval; the gallery keeps importing the same `components.js` (`scripts/sync-gallery.mjs`); no emoji in specimens.
- Blockers: nothing may be deleted (owner directive 2026-08-30); `tool-chips` and `thinking-trace` wait on CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01, `screenshot-strip` on CAP-FB-20260830-GENERATED-IMAGE-STRIP-01; the other ADOPT rows are protected by their owning entries
- Next: write `scripts/check-components.mjs` with the six RETAIN rows allowlisted and watch it pass; then the gallery labels
- Recover: `git grep -n "customElements.define" -- extension/shared/components.js`
- History:
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Count 5 → 15 (the ui lane's 14 plus `conversation-run-status`); every element read in `extension/shared/components.js` and given a verdict in the table; `agent-template-card` is ADOPT per the owner's templates directive; the six DELETE rows were each verified to have no page, script or test consumer.
  - 2026-08-27 23:30 UTC — five custom elements are defined and shipped in `extension/shared/components.js` but referenced only by `docs/components.html`, never by any extension page: `theme-picker`, `run-task-button`, `tool-chips`, `prompt-bar`, `agent-nav`. `theme-picker` is straightforward dead code — theme switching was removed at `0.2.301` and the component was left behind, which is a miss against the owner's own cross-subsystem-consistency rule. The others are unbuilt primitives; `tool-chips` in particular may be exactly what the tool-card redesign needs, so it is called out as a blocker rather than deleted.
  - 2026-08-30 16:00 UTC — owner: "we will need some of those elements in the future, for example an image strip of things that get generated". Every DELETE verdict became RETAIN with a candidate home; `screenshot-strip` is adopted by the new CAP-FB-20260830-GENERATED-IMAGE-STRIP-01.

## [CAP-FB-20260829-MIC-DEAD-MACOS-01] macOS dictation has no transcript or trustworthy microphone diagnostics
- Feedback: 2026-08-29 — product owner reports no transcript text on macOS, a constant fallback waveform, no way to configure microphone access, and multiple possible input devices
- Updated: 2026-08-29 23:24 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: implementation worker
- Workspace: active (local path private)
- Branch: `cap-mic-devices`
- Base: `cebb4601a12b35385ff6e5272d9d2d4272586e5d`
- Candidate: this commit
- Shipping: —
- Acceptance: preserve the landed immediate SpeechRecognition start; only when at least two physical audio inputs exist, offer an anchored microphone picker that requests labels once, persists a selected meter device, and briefly shows its genuine live level; clearly state that Web Speech transcription always follows the OS default input and cannot be retargeted by the picker; use the selection only for the dictation meter; handle device disconnect; no-speech and audio-capture errors identify likely OS-default versus selected meter inputs and point to system sound settings; fallback waveform state is explicitly exposed and never presented as live audio
- Review: independent review REVISE on `3636164e` — P1 post-grant enumeration and P1 meter-request race fixes implemented; re-review pending
- Gates: original pre-fix KAT 43 pass / 1 device-picker fail; review-fix falsification on `3636164e` 56 pass / 4 fail including post-grant discovery and out-of-order request RED; revised candidate mic KAT 60/60 with live-level screenshot and axe clean; final full unit 2387/0; production security PASS; production build clean; gallery/changelog/task checks green; known main Chrome journey regression remains outside this diff
- Blockers: required reviewer; known `origin/main@cebb4601` inline-approval journey regression fails outside this diff before 35 downstream checks, with its fix lane in flight
- Next: reviewer re-reviews the revised tip and its RED/GREEN browser evidence
- Recover: `git show cap-mic-devices -- extension/shared/components.js scripts/kat-mic-state.ts tests/mic-button-state.test.ts`
- History:
  - 2026-08-29 23:24 UTC — post-commit final gates: full unit 2387/0, production security PASS with no survivor/residue/poison, mic KAT 60/60, and production build clean.
  - 2026-08-29 23:14 UTC — review REVISE on `3636164e` raised two P1s. Fixed hidden pre-permission discovery by re-enumerating exactly once after the first successful meter capture and treating that capture as the label grant. Fixed out-of-order meter adoption with a dedicated monotonically increasing request generation plus the captured selected-device identity; stop/reselection/devicechange invalidate pending requests and stale resolutions stop their tracks. The expanded real-browser KAT is RED on `3636164e` at 56 pass / 4 fail and GREEN on the revision at 60/60, including three deferred meter requests resolved newest-first then stale.
  - 2026-08-29 22:06 UTC — candidate implemented and rebased onto `origin/main@cebb4601`: the picker renders only for two or more physical inputs (default/communications aliases excluded), requests labels once, persists the exact meter device, runs a bounded four-second live analyser preview, and handles devicechange without claiming to retarget Web Speech. Three no-speech rounds and `audio-capture` now name OS-default versus meter inputs and the macOS recovery path; fallback title/ARIA/status identify animation rather than live level. Falsification: unchanged product 43 pass / 1 explicit device-picker fail; candidate 57/57 with screenshot and axe clean. Focused 17/17, unit 2387/0, security PASS, production build clean. Full Chrome journeys reproduce the known new-main inline-approval regression at 85/120; its fix lane is in flight and the remaining 35 checks are not reached.
  - 2026-08-29 21:45 UTC — ownership: prior mic-decoupling lane → implementation worker (owner follow-up adds device discovery and no-transcript diagnostics on the landed fix). Platform constraint accepted: SpeechRecognition has no device-selection input and follows the OS default; the selected device controls only getUserMedia meter/preview streams.
  - 2026-08-29 20:30 UTC — diagnosis: commit `ce6247ef` changed `start()` to await `_requestMicStream()` before constructing and starting SpeechRecognition. The composer already displays `mic-error` through `setStatus`, and the real NTP KAT proves `offsetParent` is non-null in the visible layout. Falsification on the unfixed source produced 39 pass / 4 fail: a rejected meter left the button idle with the old permission error, a never-settling meter left it idle indefinitely, and recognition did not start in either case. The candidate starts recognition first, renders the CSS fallback immediately, then adopts the meter stream asynchronously under the existing generation guard. Rejection leaves recognition active and reports only that the live waveform is unavailable; late streams are stopped after cancellation. Green evidence: focused 9/9, mic KAT 43/43, full unit 2359/0, final build clean.

## [CAP-FB-20260829-BACKGROUND-RUN-TRANSCRIPT-01] Scheduled named-agent runs disappear from the agent conversation
- Feedback: 2026-08-29 — product owner reports an hourly agent completes work in the background but opening that agent shows no conversation
- Updated: 2026-08-29 21:43 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: implementation worker
- Workspace: active (local path private)
- Branch: `cap-bgrun-transcript`
- Base: `55646fae`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: create a scheduled named agent, let its real alarm fire, open that agent through the real hub UI, and see the scheduled task/result in the same conversation as interactive runs
- Review: REVISE — P1 KAT asserted only the scheduled user bubble; fix applied, re-review pending
- Gates: focused scheduled-attribution 7/7; real-browser scheduled-run transcript RED 4/5 then GREEN 6/6 with both user/result bubbles visibly captured; full unit 2370 pass / 0 fail; developer build clean (95 generated files, 28 packages, CSP/oracle/Wasm assertions green)
- Blockers: —
- Next: reviewer checks the candidate diff and behavioral evidence, then the coordinator lands it without a manual version bump
- Recover: `git show cap-bgrun-transcript -- extension/background/service-worker.js tests/sched-attr.test.ts scripts/kat-background-run-transcript.ts`
- History:
  - 2026-08-29 21:22 UTC — real-browser RED: a real named agent and recurring schedule were created, the accelerated real alarm reached durable terminal state, and the real agent row opened, but its conversation had no transcript (4 pass / 1 fail). Root cause is an identity split introduced by immutable agent namespaces: interactive runs and `named-agent.history` use `agent.instanceId`, while the `agent:<slug>` alarm branch still wrote to `namedAgentMemory(slug)`. The candidate uses that already-loaded agent row's immutable instance ID, exactly matching the interactive and history paths, so both address the same OPFS journal.
  - 2026-08-29 21:28 UTC — falsification and green gates complete. The focused identity assertion fails on the unfixed line and passes after restoration; focused suite 7/7. The same real-browser journey is GREEN 5/5. Full unit suite 2370/0; final developer build and changelog sync clean. Author diff review found no security, accessibility, design, memory, or performance regression: this reuses the existing immutable instance identity already used by interactive runs and changes no authority or UI surface.
  - 2026-08-29 21:43 UTC — independent review REVISE (P1): `scripts/kat-background-run-transcript.ts` asserted only the scheduled user bubble, so the prior screenshot/claim did not prove a result transcript. Fixed with the explicit deterministic `@demo-tools` result, separate exact user and agent bubble assertions, bounded render polling, and a taller screenshot viewport. Re-run GREEN 6/6; the recaptured screenshot visibly contains the scheduled prompt, completed tool rows, and non-empty demo-model result. Re-review pending.



## [CAP-FB-20260829-HUB-HOME-BUTTON-01] NTP brand returns directly Home
- Feedback: 2026-08-29 — owner asked for the top-left Chrome Agent Platform title to become a Home control because browser Back replayed every task and view before reaching the hub
- Updated: 2026-08-29 22:28 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P1
- Owner: implementation worker
- Workspace: active (local path private)
- Branch: `cap-home-button`
- Base: `cebb4601a12b35385ff6e5272d9d2d4272586e5d`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: the NTP brand is a subtle keyboard-accessible control named Home; activating it from a task returns directly to the hub; + from a task/agent replaces that deep route with Home and focuses a fresh hub composer; no Home/new-task action issues Back, and Back from the resulting Home cannot resurrect an older deep view
- Review: author review 2026-08-29 PASS (security/a11y/design/history diff + falsification gates); independent acceptance review required and pending
- Gates: focused rooted-navigation/navigation-order set 29/29 GREEN (new assertion RED on base); full `nice -n 10 deno test --allow-all tests/` 2389/0 GREEN; `npm run build` rc=0; loaded-extension CDP clicks verified brand → hub, + → focused fresh composer, then Back stayed on hub; before/after screenshots retained as private evidence
- Blockers: —
- Next: independent acceptance review, then coordinator merge
- Recover: `git log --oneline --all --grep=CAP-FB-20260829-HUB-HOME-BUTTON-01`
- History:
  - 2026-08-29 22:12 UTC — implementation candidate prepared: the brand is a semantic Home button, deep-to-deep navigation replaces the current entry, direct deep links seed a hub root, and focused coverage pins root reset plus navigation order
  - 2026-08-29 22:12 UTC — owner expanded the same navigation lane: + from a task/agent must be a real Home destination, not Back. The shared `goHome` path now replace-navigates before closing the surface and focusing the fresh composer; settings Home, delete/invalid-surface recovery, artifact reuse and skill-use paths use the same destination semantics
  - 2026-08-29 22:28 UTC — author review PASS: the changed assertion failed against the unmodified controller and passed on the candidate; focused 29/29, full suite 2389/0, developer build rc=0. A loaded extension was driven with genuine CDP clicks: brand returned task → hub with Home focused; + returned a live task → hub with the fresh task input focused; browser Back did not restore the task. Three screenshots retained privately


## [CAP-FB-20260830-EXEC-DEMO-01] The five-minute exec demo runs end to end on a fresh profile
- Feedback: 2026-08-30 — reanalysis 2026-08-30 (all seven lanes); the umbrella for the demo the owner is about to give Chrome leadership. `REVIEW-2026-08-30.md` section 6 holds the script and its ranked blockers
- Updated: 2026-09-01 22:55 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: model worker (Fable 5 subagent) under the reanalysis coordinator session — CLAIMED; do not start a parallel attempt
- Workspace: active (local path private)
- Branch: `cap/exec-demo` (pushed to origin as the candidate branch; merged by the coordinator)
- Base: `d7e8b2b9`
- Candidate: this tracker commit (branch `cap/exec-demo`, two commits: the `demo-path` journey group; the rehearsal evidence + this History)
- Shipping: —
- Acceptance: the five-minute script in `REVIEW-2026-08-30.md` section 6 (1: group open tabs by topic; 2: a WebMCP site used as a tool; 3: isolation and consent shown in Settings; 4: a scheduled run that left a report; 5: make a shareable brief) runs headed on a genuinely fresh Chrome profile with a real key, is recorded as a screen capture with visible timestamps, shows at most ONE permission card per step, and never shows any of the strings `modelContent`, `search_tools`, `catalogGeneration`, `prompt-attestation`, `[demo model]` or `returned no content`. This entry closes only when every child entry in Blockers is DONE and the recording exists on durable storage.
  - Context: this is an umbrella, not a code change. Every real defect is owned by a child entry. The reason the demo fails today is (in ranked order, review section 6): no keyless first result and a bad key masked as "no content" (`KEYLESS-FIRST-RESULT-01`, `PROVIDER-ERROR-TRUTH-01`); a first screen with six actions and 22 disabled agents (`HUB-FIRST-RUN-01`, `FRESH-PROFILE-TEMPLATE-AGENTS-01`); the real answer swapped for nudge boilerplate and 7-25 s of blank waiting (`TRANSCRIPT-FULL-ANSWER-01`, `TRANSCRIPT-STREAMING-01`); raw lazy-protocol JSON in tool cards (`TOOL-CALL-LEGIBILITY-01`); "open a tab" refused because the Settings toggle leaks a lease and no card offers the fix (`BROWSER-LEASE-DEADLOCK-01`, `DENIAL-TO-GRANT-CARD-01`); no real WebMCP site (`SITE-AGENT-SHOWCASE-01`); an unapproved script fetch channel that must not be live on stage (`RUN-SCRIPT-FETCH-APPROVAL-01`). The product mechanics underneath are sound: at the baseline 40+ browser tools drove real side effects through the same executor the agent loop uses (`extension/background/service-worker.js:3551-3568` `executeWorkerTool`), WebMCP acceptance was 42/42, and four real providers completed the open-tab journey through the hub composer. What must NOT change: no child entry may be "fixed" here by editing the demo script around it; the script is fixed, the product moves.
  - Reproduce today: (1) build with `npm run build`; (2) launch headed Chrome with `--load-extension=extension` on an empty `--user-data-dir`; (3) open a new tab; (4) type "Group my open tabs by topic and give me a two-line summary of each group" into the composer (`<agent-composer id="composer">`, `extension/ntp/ntp.html:872`) and press Run task; (5) observe "[demo model] Task received (N chars)…" (no provider) — that is dead end 1; (6) configure a provider in Settings and repeat: observe either "browser control not granted…" with no card, or "another surface is driving the browser" after toggling Browser control in Settings, or a `search_tools` card with `modelContent` JSON. Each observation maps to a child entry above.
  - Files: none directly. The owner of each behaviour is named in Blockers. The only artefacts this entry produces are (a) the recording on durable storage, (b) a `demo-path` check group appended to `scripts/chrome-journeys.ts` (`EXPECTED` list at `:342`, `check()` at `:334`) that drives steps 1, 4 and 5 headless on a seeded-permission profile, and (c) the History line recording the recording's location class and sha256.
  - Steps: 1. Land the child entries in the order given in Next (each is its own commit cycle with its own review). 2. Once `BROWSER-LEASE-DEADLOCK-01`, `DENIAL-TO-GRANT-CARD-01`, `TRANSCRIPT-FULL-ANSWER-01` and `TOOL-CALL-LEGIBILITY-01` are DONE, add the `demo-path` group to `scripts/chrome-journeys.ts`: three new `EXPECTED` names — `"demo-path: step 1 groups tabs and renders sentences"` (assert at least one `chrome.tabGroups` group exists after the run and that the visible conversation text contains none of the six forbidden strings), `"demo-path: step 4 hub shows the scheduled run summary"` (seed a schedule with a 1-minute period, wait for the alarm, assert the timeline row), `"demo-path: step 5 artifact renders in the thread"` (assert an `<artifact-card>` element exists in the thread shadow root with a non-empty preview). Seed warning permissions through the profile `Preferences` file the way `scripts/webmcp-acceptance.ts` documents at `:54` ("test-manifest-pregranted") — headless auto-denies `tabs`. 3. Rehearse headed on a fresh profile with a real key on a current model (gemini-3.7-flash is the recommended default per `docs/OPEN-QUESTIONS.md` Q12; gpt-5.6-sol and claude-sonnet-5 as alternates); record with timestamps. 4. Store the recording on durable storage (never tmpfs), record its sha256 and location class in History. 5. Move this entry to DONE with the child IDs and the recording hash.
  - Out of scope: any product change (owned by the children); the deck; the choice of showcase site content (owned by `CAP-FB-20260825-SITE-AGENT-SHOWCASE-01`); the developer-flag build (`CAP-FB-20260830-EXEC-BUILD-FLAG-01`) is desirable but not a blocker.
- Review: author review 2026-09-01 — falsification gates cleared for the journey group (RED/GREEN signatures recorded verbatim below); no product change in this lane
- Gates: the recording; the `demo-path` journey group; the full suite green at the tip; every child DONE.
  - Unit: none added by this entry (each child carries its own). The unit gate here is the children's unit gates, all green at the tip.
  - Browser: `deno run -A scripts/chrome-journeys.ts` with the three `demo-path` checks named in Steps added to `EXPECTED` and passing. Falsification of the group: temporarily reintroduce the `permissionRequired` shape at `extension/lib/browser-tools.js:1399` (the open_tab denial) and observe `"demo-path: step 1 groups tabs and renders sentences"` go RED; restore; GREEN. Screenshots: one per script step from the headed rehearsal, plus the headless `demo-path` screenshots, showing the composer, the sentences in the transcript, the timeline row and the artifact card.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `origin/main@fc2255be`: 2457 unit pass, 138/138 journeys; the journey count grows by three).
  - Constraints: no fixed debugging port (`tests/harness-debug-port.test.ts`); the recording must contain no provider key (Settings key field is write-only; never show the key field unmasked on stage); no emoji in any copy touched by the children.
- Blockers: Depends on CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01, CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01, CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01, CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01, CAP-FB-20260830-KEYLESS-FIRST-RESULT-01, CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01, CAP-FB-20260827-HUB-FIRST-RUN-01, CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01, CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01, CAP-FB-20260825-SITE-AGENT-SHOWCASE-01, CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01 (all must land first)
- Next: land the two tool-gating entries first (lease deadlock, denial-to-grant card) — they remove most of the perceived "open tab does not open a tab" breakage without touching a tool; then `TRANSCRIPT-FULL-ANSWER-01` and `PROVIDER-ERROR-TRUTH-01`
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-EXEC-DEMO-01`
- History:
  - 2026-08-30 11:00 UTC — opened by the reanalysis consolidation. Baseline at `origin/main@fc2255be`: build clean, 2457 unit pass, 138/138 Chrome journeys, hub FCP 15-55 ms; four real providers driven through the hub (gpt-4.1, gemini-2.5-flash native, grok-4.3 and glm-4.5 via the compatible adapter). The product's mechanics are sound; the demo fails today on gating, on persistence of the answer, and on the first screen.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Model IDs in the 11:00 line are the ones the lanes ran; the rehearsal must use a current model (gemini-3.7-flash / gpt-5.6-sol / claude-sonnet-5).
  - 2026-09-01 20:33 UTC — CLAIMED by the reanalysis coordinator; worker started in its own worktree on `cap/exec-demo` off `origin/main@d7e8b2b9`. Other agents: pick a different entry.
  - 2026-09-01 22:55 UTC — worker (author review, no product change). **(1) `demo-path` journey group landed** in `scripts/chrome-journeys.ts`: the three EXPECTED checks named in Steps, driven on a SECOND headless Chrome whose fresh profile pre-holds only `tabs` + `tabGroups` (the two warned permissions headless can never grant — seeded in the profile's extension prefs before launch, the stand-in `scripts/keyless-first-result.ts` documents; nothing else seeded: no provider, developer flag off). Step 1 types the script's sentence into the real composer on the keyless local assistant, Allows the ONE in-chat browser-control card with a real click, then asserts ≥1 `chrome.tabGroups` group, sentences, ≤1 card (granted), and none of the six forbidden strings anywhere in the thread (light DOM + shadow roots, cards opened). Step 4 seeds `Reading digest` (period 1 min) BEFORE step 1 and waits for the REAL alarm (fires at ~64 s), then asserts the row on a fresh hub (`.tl-agent` = Reading digest, outcome, Done). Step 5 drives `@demo-edit-artifact` (the marker model behind the flag, a new thread) and asserts the `<artifact-card>` html-frame preview loaded from the store. Screenshots: `demo-path-step1-thread.png`, `demo-path-step4-timeline.png`, `demo-path-step5-artifact.png` (retained with `--retain`). Suite: 298 → 301 checks. **(2) Falsification, verbatim.** Tip (restored, run alone): `demo-path step 1: … allowed=true cards=[{"state":"granted"}] groups=1 forbidden=["search_tools"] … "The tab list could not be saved as an artifact this time."` → `FAIL: demo-path: step 1 groups tabs and renders sentences`; steps 4 and 5 `PASS`; `chrome journeys: 300/301 passed`. F1 — the mutation exactly as named (open_tab's `permissionDeniedResult("tabs", …)` → the `fc2255be:1399` legacy `{ error, permissionRequired: { capability: "tabs" } }`): `298/301` — step 1's line byte-identical to the tip (groups=1, forbidden=["search_tools"]) and two existing guards red (`Permission card: open_tab denial renders one approval card`, `Not now declines open_tab…`) → the named site is not on step 1's path (the keyless step 1 never calls open_tab). F2 — the same legacy shape reintroduced in the shared `permissionDenial()` producer (the denial behind open_tab's browser-control branch AND the `group_tabs` grant denial step 1 crosses): `demo-path step 1: … allowed=false cards=[] groups=0 forbidden=[] text="Your 3 tabs across 2 sites were not grouped because the tab-groups permission was not granted…"` → `FAIL` with the denial-class signature (no card, no group) and five screenshot/card guards red, `295/301`; restored → `300/301`. Steps 4 and 5 passed in every run. **(3) Step 1 is RED at the tip on product defects found by this group — not fixed here (out of scope), need child entries:** (a) after Allow on the in-chat card the resumed run's `group_tabs` card reads "Error: Owner approved the requested capability, but this attempt did not run. Retry group_tabs now with a fresh search_tools selection." — the model-facing retry sentence written at `extension/lib/agent.js:1061` is rendered as the owner-visible error (the `search_tools` leak); (b) the `create_asset` call issued in the same model step as the paused `group_tabs` fails on resume with a red `selection-scope-mismatch` card that dumps the raw HTML input, so the "Your open tabs" artifact is dropped and the plan strip reads "4 steps · 1 or more failed" (observed settling first and succeeding once — a race with the pause); (c) on a genuinely fresh profile the real model's step 1 shows THREE in-chat cards (tabs; tabGroups+tabs; browser control for the tabs' origins) plus TWO native Chrome prompts ("Read your browsing history"; tab groups) whose focused default is Deny — Acceptance says at most one card per step. **(4) Headed rehearsal** (a real X11 window on the desktop via Xwayland, `gemini-3.7-flash` through `GEMINI_API_KEY`, a genuinely fresh profile, the key set through the Settings principal with the preset base URL passed explicitly because PROVIDER-SET-NO-BASEURL-01 is in flight; the key never appears in any capture — checked): step 1 PASS with defects (a)+(c): 63 s, one real group "Web Development", a sentence answer; step 2 BLOCKED for the showcase site (SITE-AGENT-SHOWCASE-01 in flight) and rehearsed against `fixtures/webmcp-fixture.html` instead: Find site tools → picker → enrolled (hub shows "4 tools"), the verbatim ask answered "The cheapest widget is the Mini Widget priced at $2.50. The current cart total is $42.50 USD." in 44 s — with NO per-tool approval card (the script expects one Approve; needs a child entry or an Acceptance decision); step 3 PASS (Settings → Permissions, key absent from the page); step 4 PASS — the 1-minute alarm's run settled 151 s after scheduling (~90 s of model time; a headless probe with the real model saw it still Running… 70 s after its alarm — the script's "created ten minutes earlier" precondition is load-bearing) and the fresh hub shows "Summarise my open tabs — Reading digest · Here is a summary of your 6 open tabs…"; step 5 PASS — 16 s, "Web Research & Open Tabs Brief" renders in the step-1 thread as an html `<artifact-card>` (preview 9175 chars), no forbidden strings in that turn; step 6 PASS (fixture source). Script clock 3:17 plus the alarm wait. Evidence (durable, committed): `test-artifacts/exec-demo-rehearsal/` — 18 timestamp-stamped PNGs + `rehearsal-summary.json`; sha256: 01-step1-new-tab.png af7a1eab3c65dce437c3f088c41e9cd60e14e9242a9524d7f2b39dbb5715976f; 01-step1-typed.png 5b544cb6320c6c0da8c263b23d481278e89242a47009a575a7b340c3f7661093; 01-step1-card-1.png 78e12a2dd47ab96b7226eb24c17c08977733cd781201048945180c366b429632; 01-step1-native-prompt-1.png 0c7755b392a29dbddd61f3a6c6f21bd2138909c1860ab27fe6939f966edaea03; 01-step1-card-2.png 840c462aa381004ee417bf1d9b91dc271f7566bfba78f0785dfb494dae4bf739; 01-step1-native-prompt-2.png de98f41c1ad3eefc2884490e6fd7a166249b2599f1be03efcfc852022471be57; 01-step1-card-3.png af6f58ee506d822e1d5a75a4293e7ffa2d732666f7f203a1127985e0c59b0fd3; 01-step1-result.png 0ed2bf475262b8f9d1849856808f3df998465668588ee2bac0c5b4370ac6fbc7; 01-step1-tab-strip.png 2663510d7c17ffbbb9cb2387449a4d3ba5e68171c7d03c0736b9ea7f9aa91c62; 02-step2-picker.png 04d0e6b3ad6c4d0de253eb66095bddf1ff9ba277fe7b4f88631bf96fa77744ee; 02-step2-enrolled.png 91754dc772064afca7fb641d700814ef3e135458f1c300845e34fd0bf76c53ed; 02-step2-result.png 7def6323c8a1cee0e0f485c989ad9e5b086694dfce73cc50d1a744835da2ebee; 03-step3-permissions.png b035dc05a53b0cc3a3df72c3dc257e7e5195e848178736b31ddccae77e5e3586; 04-step4-timeline.png c175ec63d9ab14cd82c8be83ddafd27d3092a37434185cff54bb40211d8f658b; 04-step4-report-opened.png 97051217df412f86fc13dc7ebdea3e8c3498b86b06392e302541f113ec4f718c; 05-step5-typed.png d5c3099b2bee5153d4a39ad3139e70d9390a5fa5d7d8e823ef375dbd001726ed; 05-step5-artifact.png 89c62708b9b2226fe3b22a9419b2ae586a8fedea757c010bb0493a6e4c556e72; 06-step6-fixture-source.png cf79de2a7f2b20ade4e47f52f470b5c290bcc61f34b69d6a2510e2937f6d2467. **Remaining:** PROVIDER-SET-NO-BASEURL-01 and SITE-AGENT-SHOWCASE-01 (in flight); child entries for (a), (b), (c) and the missing step-2 approval card; the final headed screen recording once step 1 is clean (the `demo-path` step 1 check is the gate that says so).

## [CAP-FB-20260830-FINGERPRINT-SURFACE-01] Every website can fingerprint the extension
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 7. Any web page can detect that the extension is installed by fetching one of its web-accessible files or by reading a named global the detector defines.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cf0da958`
- Candidate: —
- Shipping: —
- Acceptance: `web_accessible_resources` no longer exposes `artifact/artifact.html`, `artifact/artifact.js` or `sandbox/artifact-preview.html` to `<all_urls>` (extension pages do not need a web match; if one is ever needed, `use_dynamic_url: true`); the MAIN-world detector hook is a per-document unguessable name (or a Symbol on a private object) rather than a non-configurable named global; a `fetch` of the resource from a web page fails and the global is absent, asserted in the browser.
  - Context: `extension/manifest.json` `web_accessible_resources` (the block at ~`:91-101`) lists the three files with `"matches": ["<all_urls>"]`. A page can `fetch("chrome-extension://<id>/artifact/artifact.js")` or iframe the viewer; `extension/artifact/artifact.js:14-16` reads `id`/`origin` from the query string and `:53` calls `send("asset.get", { origin, id })` for whatever it is given (the SW's sender check limits what a page can reach, but the existence probe succeeds). `extension/content/webmcp-detect-main.js:92-97` defines `globalThis[HOOK_KEY]` with `writable:false, configurable:false` on every page in the MAIN world; the WebMCP acceptance suite (`scripts/webmcp-acceptance.ts`) depends on the hook for the relay handshake. What must NOT change: the relay's HMAC/nonce handshake (`extension/content/bridge-auth.js`, `webmcp-detect-relay.js`); the artifact viewer's own extension-page use.
  - Reproduce today: (1) build, launch headless with the extension; open any http(s) page; (2) in the page: `fetch("chrome-extension://" + <id> + "/artifact/artifact.js").then(r => r.status)` → 200; (3) `typeof globalThis.__capWebmcpDetectBootstrap` → "function" (read `HOOK_KEY` in `webmcp-detect-main.js` for the exact name).
  - Files: `extension/manifest.json` (delete the `web_accessible_resources` entry, or restrict `matches` to nothing web-facing and set `use_dynamic_url: true`; verify the artifact viewer still opens from `artifacts/index.html` and the ntp — `git grep -n "artifact/artifact.html" -- extension`); `extension/content/webmcp-detect-main.js:92-97` and the isolated-world relay that calls the hook (`extension/content/webmcp-detect-relay.js`) — pass the hook name via the relay's nonce channel so it is per-document; `scripts/webmcp-acceptance.ts` if it references the global by name. Do NOT touch the bridge auth.
  - Steps: 1. Browser checks first (Gates) — RED. 2. Manifest change; confirm the viewer and preview still work from extension pages (`npm run test:chrome`). 3. Per-document hook name derived from the relay nonce; the relay calls it by that name. 4. `npm run test:webmcp` green. 5. Docs: `docs/CONSTITUTION.md` privacy list, `CHANGELOG.md`.
  - Out of scope: the host-access posture (`HOST-ACCESS-STORY-01`); the privacy statement (`PRIVACY-STATEMENT-01`).
- Review: pending
- Gates: the falsification gates apply.
  - Unit: extend `tests/settings-strings-audit.test.ts` or add `tests/manifest-war.test.ts` — read `extension/manifest.json` and assert no `web_accessible_resources` entry has `"<all_urls>"` in `matches`. Falsification: on the current tree RED; after step 2 GREEN.
  - Browser: `scripts/chrome-journeys.ts` gains `"fingerprint: artifact.js is not fetchable from a web page"` (evaluate the fetch in the fixture page; expect a network error) and `"fingerprint: no named detector global on a web page"` (evaluate `Object.getOwnPropertyNames(globalThis).some(n => n.startsWith("__capWebmcp"))` → false). `npm run test:webmcp` (42/42 at the baseline) stays green. Screenshot not required (evaluation evidence).
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `origin/main@fc2255be`: 2457 unit pass, 138/138 journeys; grows by two); `deno run -A scripts/webmcp-acceptance.ts` green.
  - Constraints: no fixed debug port; the per-document name must not be derivable from the extension id alone.
- Blockers: —
- Next: scope the resources and rename the hook
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-FINGERPRINT-SURFACE-01`
- History:
  - 2026-08-30 11:00 UTC — verified in source; the viewer embedded by a page would call `asset.get` for any id/origin it is given (`extension/artifact/artifact.js:14-16,54`).
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); every line reference re-verified against `origin/main@cf0da958`.

## [CAP-FB-20260830-SUITE-HONESTY-01] The security suite never loads the extension; two wired harnesses are red outside test:all; 42 harnesses are orphaned
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane findings 10 and 11, editing lane finding 15 and task T9. `npm run test:security` reports 7/7 without ever loading the extension, `test:a11y` and `test:components` are red and not part of `test:all`, and 42 of 62 browser harnesses run nowhere — so a green suite says less than it looks.
- Updated: 2026-09-02 03:20 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P2
- Owner: model worker (Fable 5 subagent) under the reanalysis coordinator session — CLAIMED; do not start a parallel attempt
- Workspace: active (local path private)
- Branch: `cap/suite-honesty` (pushed to origin as the candidate branch; merged by the coordinator)
- Base: `0f3877ca`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: `npm run test:all` runs and is green with `test:a11y`, `test:components` and a `test:kat` aggregate included; the security suite drives the loaded extension for sender-auth refusal, `cap:fetch` private-address refusal, `script.run` approval gating and cookie redaction; every browser harness launches through `launchChrome()`; every harness sets a real exit code; a reusable scripted OpenAI-compatible provider under `scripts/lib/` powers a keyless two-turn artifact journey in `scripts/chrome-journeys.ts`.
  - Context: `package.json` `test:all` = `check-tasks && check:vocabulary && npm test && test:security && test:chrome`; `test:a11y` (`scripts/a11y-audit.ts`, 15/17 today) and `test:components` (`scripts/component-gallery-smoke.ts`, 34/1) are defined but excluded; there is no `test:kat`. `scripts/security-suite.ts` refuses to run without the supervisor guard (25-40; `bash scripts/security-suite-supervisor.sh` holds the serialized-Chrome flock defined at its line 7) and its checks test `renderHtmlFrame` from `docs/components.js` on a fixture page (165-200: spawns Chromium itself with `--remote-debugging-port=0`, no `--load-extension`). `scripts/evidence-runner.sh:49` invokes `scripts/security-suite.ts` directly, which the guard refuses. Counts on this tree: 62 `scripts/*.ts`, 31 `kat-*.ts`, 37 files call `launchChrome(`, 24 spawn Chromium themselves with `=0` (safe form; `tests/harness-debug-port.test.ts:44-60` deliberately does not assert exclusivity yet). `scripts/flake-evidence.ts:88` always `Deno.exit(0)`; `panel-leak-probe.ts` and `repro-recent-activity.ts` set no exit code. The gallery smoke's byte-identity check (`component-gallery-smoke.ts:42-50`) compares `extension/shared/*.js` to `docs/*.js` raw, while `scripts/sync-gallery.mjs:40-53` deliberately rewrites three import paths — so the smoke check fails by design (a wrong test). The demo model (`extension/lib/models/demo-model.js`) has no `create_asset` fixture, so the only keyless way to drive artifact creation through the real lazy protocol is a scripted provider (the editing lane's `fake-provider.ts` in its scratchpad: a local HTTP server speaking the OpenAI chat-completions format, answering `search_tools` → `execute_tool(create_asset)` → text, then the edit turn; `scripts/agent-provider-picker.ts` already runs a scripted endpoint pattern to copy). What must NOT change: the no-fixed-port rule; the supervisor lock for the security suite; `launchChrome()` as the only spawn path.
  - Reproduce today: (1) `npm run test:a11y` → 15/17 FAIL; `npm run test:components` → 34/1 FAIL (the byte-identity check); (2) `grep -c "load-extension" scripts/security-suite.ts` → 0; (3) `ls scripts/kat-*.ts | wc -l` → 31 and `grep -l "kat-" package.json` → none; (4) `bash scripts/evidence-runner.sh` gate 13 → "SECURITY-SUITE REFUSED".
  - Files: `package.json` (scripts: `test:kat`, add a11y/components/kat to `test:all`), `scripts/security-suite.ts` (add the four extension-loaded journeys through `launchChrome({ extension })` + `waitForServiceWorker`), `scripts/security-suite-supervisor.sh` (unchanged; keep the lock), `scripts/evidence-runner.sh:49` (call the supervisor), `scripts/component-gallery-smoke.ts:42-50` (apply the same rewrite as `sync-gallery.mjs` before comparing, or call `npm run check:gallery` and drop the duplicate check), `scripts/flake-evidence.ts:88`, `scripts/panel-leak-probe.ts`, `scripts/repro-recent-activity.ts` (exit codes), the 24 self-spawning harnesses (migrate to `launchChrome()`; then flip `tests/harness-debug-port.test.ts` to assert exclusivity), new `scripts/lib/scripted-provider.ts` (`startScriptedProvider({ turns: [...] })` → `{ baseURL, requests[], close() }`, request-size logging, a `leakHits` array for the sandbox probe), `scripts/chrome-journeys.ts` (the two-turn Crumb journey: create → edit with approval → versions = 2 → sandbox probe zero hits → one tab per New tab click → bootstrap parses), `tests/fixtures/crumb-v1.html` / `crumb-v2.html` (shared with DIFF-LIBRARY-01), `scripts/kat-*.ts` (each either wired or deleted — list the decision per file in History). Do NOT add a fixed port anywhere.
  - Steps: (1) Scripted provider + the Crumb journey first (it is the falsification harness for the editing chain; it lands RED for the assertions those entries fix and stays green for the rest — mark the not-yet-fixed checks as `expectedRed` in the harness with the owning CAP-FB id so the suite is honest, never skipped silently). (2) Fix the gallery smoke comparison; add `test:components` to `test:all`. (3) Land FOCUS-ORDER-VISIBILITY-01's label fixes or, if sequencing prevents it, add `test:a11y` with the two known failures listed as `expectedRed` (owner ids) — then remove the list when they land. (4) Security suite: four extension-loaded checks — a page-context `chrome.runtime.sendMessage` to a non-report route is refused (sender-derived authority); `cap:fetch` to `http://127.0.0.1:<port>` / `10.0.0.1` / `169.254.169.254` / `localhost` returns a refusal (lands RED until RUN-SCRIPT-FETCH-APPROVAL-01); `script.run` from the model principal produces an approval card (same); `list_cookies` output contains no `value` field (COOKIE-TOOLS-CUT-01). (5) `test:kat`: a runner that executes every `scripts/kat-*.ts` in sequence under the serialized lock and fails on any nonzero exit; delete KATs whose behaviour is already a journey (record each). (6) Exit codes; `launchChrome()` migration; flip the exclusivity assertion. (7) `evidence-runner.sh` fix.
  - Out of scope: the product fixes the new checks reveal (each has its own entry: RUN-SCRIPT-FETCH-APPROVAL-01, COOKIE-TOOLS-CUT-01, FOCUS-ORDER-VISIBILITY-01, the editing chain); seeded-profile perf gates (SEEDED-PROFILE-GATES-01).
- Review: author review 2026-09-02 — falsification gates cleared (RED/GREEN recorded in History); no independent review (single-model mode)
- Gates: the falsification gates apply — measured at the candidate: unit 3006/3006 (2997 + the 9 custody self-tests), `test:security` 18/18 with the extension loaded, `test:security:injection` 3/3, `test:chrome` 315/315, `test:components` 37/0, `test:a11y` 31/0 + 2 owned expected-red (exit 0), `test:kat` 26 green / 18 owned expected-red / 0 failed
  - Unit: `tests/harness-debug-port.test.ts` — flip "the shared launcher owns the debugging-port flag" (44-60) to assert `launchChrome` is the ONLY writer of `--remote-debugging-port` once the migration is done; add `tests/scripts-exit-codes.test.ts` — "every scripts/*.ts that is wired into package.json ends with an explicit Deno.exit based on failures" (static scan for `Deno.exit(fails` / `Deno.exit(failures`). Falsification: leave one harness on its own spawn, expect RED on exclusivity, migrate it, GREEN.
  - Browser: `npm run test:all` green end to end; the Crumb journey checks listed in Steps (with `expectedRed` entries printed with their owning ids until they land); `deno run -A scripts/security-suite.ts` via the supervisor showing the four new extension-loaded checks in its output. Screenshots `journey-crumb-turn1.png`, `journey-crumb-turn2-approval.png`, `security-suite-extension-loaded.png` (the harness log showing `--load-extension` and the SW target).
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green (2457 / 138 at `fc2255be`; re-count and print the new totals in History).
  - Constraints: never name a debugging port; the serialized-Chrome lock for every browser harness (security lane finding 12 — take the lock in `launchChrome()` or the runner); no provider keys in fixtures; the scripted provider binds to loopback only and is killed with its Chrome.
- Blockers: —
- Next: coordinator merge of `cap/suite-honesty`; then the 18 owned-red KATs need a per-file owner decision (fix or retire) — the registry prints each one's failure mode on every `test:kat` run until then.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-SUITE-HONESTY-01`
- History:
  - 2026-09-02 03:20 UTC — CANDIDATE (author review). **Re-inventory first** (main had moved from 62 to 85 `scripts/*.ts`; 44 KATs; 32 self-spawning Chromium; 17 wired / 68 orphaned; every orphan run once, serialized): `test:components` 38/1 (the raw byte compare), `test:a11y` 31/2 (the Usage "7 days" chip at 2.39:1 and four 69x19 "Get a … API key" links — different defects from FOCUS-ORDER-VISIBILITY-01, which is DONE), 18 of 44 KATs red or hanging, `test:security:injection` red on `origin/main` itself (1/3, control run), the demo model already had the crumb create/update fixture (the entry's premise was stale) and the editing-chain entries were DONE, so the scripted provider's `expectedRed` list is empty. **What changed.** (1) `scripts/lib/scripted-provider.ts` — a loopback-only OpenAI-compatible provider that answers from a script (streamed tool-call deltas, `selectionRefOf()` reads the lazy protocol's ref back out of the request, `leakHits` counts any non-API request to its origin, `overflow` counts requests past the script); the dummy key `SCRIPTED_DUMMY_KEY` is not a credential (the provider gate refuses an empty key). Measured with a transcript probe: agent-do sends a synthetic "Continue working on the task…" user turn after a tool step and the run-text tracker hides the reply, so a turn is FOUR model calls (search, execute, answer, nudge reply) — documented in the module. (2) `scripts/chrome-journeys.ts` journey 3e2: the two-turn crumb chain through the REAL provider path — 4 calls create the artifact, turn 2 pauses on the approval card ("Update crumb-scripted.html? (+11 -3)" with the diff), a genuine Approve lands version 2 with the final text, and the edited page's `<img>`+`fetch` aimed at the provider's own origin never arrive (zero leak hits); 315/315. (3) `scripts/security-suite.ts` now launches through `launchChrome({ extension })` (log shows `--load-extension` and the SW target) and adds eleven extension-loaded checks: the page MAIN world has no `chrome.runtime`; the content-script world is refused on `agent.list` ("not authorized from a page") while `tools.list` still answers (the refusal is the route, not a dead channel); `cap:fetch` refuses 127.0.0.1, 10.0.0.1, 169.254.169.254 and localhost from a sandboxed script with zero attacker-host requests; a MODEL-initiated `run_script` through the scripted provider pauses on the approval card with the source shown and the script un-run (a direct `script.run` from an extension UI document is owner-direct by design — that probe was removed as wrong); `list_cookies` carries no `value`. 18/18 via the supervisor (`security-suite-approval-card.png` beside the run's guard record). (4) `component-gallery-smoke.ts`: the three raw byte compares replaced by one call to `sync-gallery.mjs --check` (single source; the rewrite is applied) — 37/0. (5) `scripts/lib/expected-red.ts` + `tests/expected-red.test.ts`: an owned failure runs, prints `EXPECTED-RED (<owner>)`, is counted apart, FAILS the run when it turns green, and a stale entry fails too; `a11y-audit.ts` carries the two Settings findings under CAP-FB-20260827-SETTINGS-MONOLITH-01 and CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01 (exit 0; 31/0 + 2). (6) `scripts/lib/harness-registry.ts` + `tests/harness-registry.test.ts`: every `scripts/*.ts` has exactly one class (6 gate / 12 named / 44 kat / 23 manual / 1 helper); a new file with no entry, a stale entry, a gate missing from `test:all`, or a KAT neither run nor set aside with a reason fails the unit suite. (7) `scripts/kat-runner.ts` (`npm run test:kat`): every KAT, sequentially, each under the serialized-Chrome lock with its budget counted from the moment it holds the browser; the 18 known reds carry `expectedRed` (owner) + `redReason` (failure mode) and are RUN with a 90 s cap, never skipped. (8) `tests/scripts-exit-codes.test.ts`: every non-helper harness exits on its own failures — `flake-evidence` (exit 1 only for a branch-only failure), `panel-leak-probe` (a steady-state leak verdict), `repro-recent-activity` (the live-explorer verdict), `focus-shots`, `thread-open-trace`, `opfs-wal-probe`, `live-run-evidence` gained real verdicts. (9) All 32 self-spawning harnesses migrated onto `launchChrome()` (four by hand, 28 by parallel workers with before/after tallies identical for every pre-existing red); `tests/harness-debug-port.test.ts` flipped to exclusivity; `launchChrome` gained `extension`/`profile`/`env`/`clearEnv` options and `openCdp()` (the private CDP client each harness carried). (10) `evidence-runner.sh` gate 13 calls the supervisor. (11) `package.json`: `test:all` = check-tasks, vocabulary, unit, security, injection, chrome, components, a11y, kat (`test:local-files` now runs inside `test:kat`). **Three gate disagreements settled.** (a) The gallery byte compare was a wrong test — replaced (above). (b) The concurrent-Chrome CDP timeouts: `launchChrome()` now takes the canonical lock for the browser's lifetime (`flock -w`, bounded by `CAP_CHROME_LOCK_WAIT_MS` = 20 min, printed when it queues, skipped inside the supervisor which already holds it, reentrant per process, released by closing the holder's stdin so a dead harness never leaves it held); `tests/chrome-launch-lock.test.ts` proves a launch queues behind a holder, a launch that cannot get the lock FAILS instead of starting, and a process may launch twice. Doing this exposed a latent race the slow stderr poll had masked: the launcher returns ~100 ms after spawn, early enough that arming `waitForDebuggerOnStart` paused the extension's FIRST boot, and a worker paused at first boot then closed by Journey 0 never answered the wake (probe: raw spawn 164 ms, launcher 15 s timeout, deterministic; control run of the unmodified suite 313/314) — the suite now waits for the running worker before arming auto-attach (165 ms again). (c) `tests/security-suite-custody.test.ts` failed load-dependently because its 20 s `/usr/bin/timeout` counted the time the supervisor spent queued on the same lock: the supervisor now prints `CAP_SECURITY_LOCK_WAIT`/`CAP_SECURITY_LOCK_ACQUIRED`, and `scripts/lib/lock-aware-command.ts` starts the 20 s budget at the marker with a separate bounded queue wait (10 min) reported as its own finding; `tests/lock-aware-command.test.ts` proves queueing longer than the budget passes once the marker arrives, a child that hangs AFTER the lock still fails on its budget, and a child that never gets the lock is reported as a lock-wait finding. Observed for real: an orphaned KAT held the lock for 10 min and the custody test reported the lock wait (8/9) rather than a phantom supervisor failure; with the lock free it is 9/9 in 4m40s while interleaved with the KAT runner. The same helper runs each KAT under `setsid` so a killed hang takes its process group and its lock with it. (12) `test:security:injection` needed the developer flag (the keyless assistant answered the tabs prompt itself): 1/3 → 3/3. **RED/GREEN, verbatim.** Exclusivity: RED `Values are not equal: a harness spawns Chrome itself instead of through launchChrome()` listing 32 files → GREEN `5 passed | 0 failed`. Registry: RED `harnesses on disk with no registry entry … kat-failed-runs.ts` (empty registry) → GREEN `8 passed`. Exit codes: with `Deno.exit(fail ? 1 : 0)` replaced by `Deno.exit(0)` in the gallery smoke, RED `every harness exits with a code derived from its own failures ... FAILED … component-gallery-smoke.ts`; restored, GREEN `2 passed | 0 failed`. Expected-red: RED (module absent: `Type checking failed`) → GREEN `5 passed`. Lock: `a launch queues behind another lane's holder and then proceeds … ok (3s)` / `a launch that cannot get the lock within its bound FAILS instead of starting … ok (1s)` / `one process may hold the lock across two browsers … ok`. Lock-aware: `4 passed | 0 failed`. **Counts at the candidate:** unit 3006/3006; security 18/18; injection 3/3; chrome 315/315 (was 138 at `fc2255be` in the entry text; 313 on this tree before the four new checks); components 37/0; a11y 31/0 + 2 owned; kat 26/0 + 18 owned. Screenshots kept privately: `journey-crumb-turn1.png`, `journey-crumb-turn2-approval.png` (the suite's own evidence dir), `security-suite-approval-card.png`, plus `security-suite-extension-loaded.log`. Docs: `AGENTS.md` (the CLAUDE.md target) gained the one-browser-at-a-time rule, the expected-red rule and the registry. Adjacent findings NOT fixed here (scope): the a11y Settings pair above; `agent-provider-picker.ts` 0/2 before and after (its `build-test-extension.mjs` copy does not load on this tree); `ui-integration` 25/1 + crash (`#run-log` gone from the hub); `system-prompts-integration` 3/11 (`<system-prompt-editor>` never renders); `agent-access-journeys` 81/7, `agent-directory-ui` 15/5, `capability-lifecycle` 12/9, `sidebar-parity` 18/2 (product drift, identical before/after); two other sessions' journey Chromiums (`~/.cache/cap-review/j2-1788309280806`, `…358903`) were still alive with no parent at the end of this lane and were left alone.
  - 2026-09-02 03:20 UTC — KAT decisions, per file (none deleted: no KAT's behaviour was shown to be a journey, so each runs; a red one is owned, printed, and capped). GREEN, kept: agent-board 45/0, agent-delegation 58/0, artifact-library-capacity 4/0, background-run-transcript 6/0, back-stack 6/0, bgagent-delete 11/0, composer-grow 11/0, failed-runs 7/0, generated-image-strip 5/0, hub-timeline 8/8, local-files, mcp-agent-ui 10/0, mcp-global-ui 10/0, mcp-tool-injection 13/0, mcp-transport 8/0 (needs the developer build; a stale dist is a real red), narrow-toggle 20/0, notify-icon 4/0, noun-discipline 14/0, patch-asset 8/0, progress-inline 13/0, provider-keyed-strip 4/0, providers-recommended 14/0, scheduled-next-run-widget 7/0, scheduled-run-output 6/0, tool-call-clarity 14/0, usage-viz 13/0. EXPECTED-RED, kept and run (owner → failure mode): activity-explorer 7/5 (backend "ok" scenario renders 1 row); agent-templates 13/24 (predates the templates redesign); artifact-preview 4/2 (no restricted preview host iframe any more); composer-slash-commands 4/5 (/tabs picker "(untitled)" rows); dark-scheme 33/4 → CAP-FB-20260827-SETTINGS-MONOLITH-01 (.btn 2.88:1 in dark); dialog-consolidation hangs (capped at 90 s); exec-build-flag 29/1 (fourteen nav items now); genui-error-state 16/2 → the generated-UI bootstrap lane; mic-state 59/1 (aria-allowed-attr on the device picker); permission-approval 8/1 (0 pending revocations); recent-activity crash (explorer never mounts); settings-cleanliness 6/1 (#providers not ready); task-lifecycle 0/1 (does not wait for the worker); task-view-simplify 21/1 (debug toggle still visible); template-cards 0/6 (no template select in the create dialog); ui-repair crash (null select); ux-lows 9/1 (two-column grid inactive); wasi-tranche2 1/9 (offscreen unavailable). Before → after: 85 → 86 files; gates in `test:all` 4 → 6; orphans 68 → 0; self-spawning 32 → 0; harnesses without a failure-derived exit 7 → 0; security checks 7 (no extension) → 18 (extension loaded).
  - 2026-08-30 11:00 UTC — measured: `npm run test:security` is 7/7 in 5.4 s but tests `renderHtmlFrame` on a fixture page; `test:a11y` 15/2 FAIL, `test:components` 34/1 FAIL, neither in `test:all`; 62 harnesses, 20 wired, 42 orphaned; no fixed port anywhere (good).
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); re-counted on the worktree: 62 `scripts/*.ts`, 31 KATs, 37 using `launchChrome(`, 24 self-spawning with `=0`; `package.json` `test:all` composition and the gallery smoke/sync mismatch (`component-gallery-smoke.ts:42-50` vs `sync-gallery.mjs:40-53`) re-verified.
  - 2026-09-02 00:06 UTC — CLAIMED by the reanalysis coordinator; worker started in its own worktree on `cap/suite-honesty` off `origin/main@9e5c8f76`. Other agents: pick a different entry.

## [CAP-FB-20260830-SEEDED-PROFILE-GATES-01] Seed warning permissions and seeded-profile budgets into the journey and perf gates
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane findings 11 and 12, tools lane finding 15. Every gate, journey and screenshot runs on a fresh profile, so the product's real regressions — it slows down with use, and warning-permission tools are never exercised headless — are invisible to the suite.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: The journey suite can pre-seed Chrome's `Preferences` so warning-gated tools (tabs, bookmarks, notifications…) run for real headless; `scripts/perf-leak-trace.ts` launches through `launchChrome()` and has a seeded phase (5 agents, 50 artifacts, 60 demo runs through the real routes) that asserts latency, long-task, CLS and hub CPU budgets and prints the numbers every run; the hub emits perf spans that appear in `observability.dumpTrace`; the seeded perf gate is RED on today's tree at the 60-run step and GREEN after OPFS-USAGE-WALK-01 — both recorded.
  - Context: `scripts/perf-leak-trace.ts` spawns Chromium itself (`new Deno.Command(CHROMIUM…)` at 33-43 with `--remote-debugging-port=0`, not `launchChrome()`), and its only latency check is `check(`${name} rendered fast (< 1000ms)`, ms < 1000)` (133) measured as document load + a 300 ms sleep on an empty profile; it does measure memory-write heap growth (keep that). `scripts/lib/chrome-launch.ts` exports `launchChrome` (46), `waitForServiceWorker` (129). The hub has no `performance.measure` entries of its own — `performance.getEntriesByType('measure')` is `[]` on every load; the only NTP span is `ntp:open_thread`; the SW side has `perfSpan(...)` (e.g. `thread.get:view` at `service-worker.js:4580`) and `observability.dumpTrace` (7214). Warning permissions: `scripts/chrome-journeys.ts` ~845-856 asserts only the fail-closed DENIAL for tabs/notifications because headless auto-denies the prompt; the reanalysis lanes worked around it by writing `Default/Preferences` → `extensions.settings[<extId>].granted_permissions = { api:[...], explicit_host:["<all_urls>"], scriptable_host:[...] }` before launch (tools lane `harness.ts:100-112`); no `scripts/` file does this today. Seeded numbers from the perf lane (fresh → 20 → 60 → 120 threads): `agent.run` 118-180 → 426-507 → 1.2-1.4 s → 2.5-2.6 s; `thread.get` 1 → 29 → 77 → 145 ms; hub composer-ready 27-49 ms, data-visible ~82 ms, zero long tasks, CLS 0. What must NOT change: `CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01` keeps one headed run for the real prompts; no fixed port.
  - Reproduce today: (1) `npm run test:perf` → 8/8 with "rendered fast" at ~25 ms; (2) `grep -n "granted_permissions" scripts/*.ts scripts/lib/*.ts` → nothing; (3) hub `performance.getEntriesByType("measure")` → `[]`.
  - Files: `scripts/lib/chrome-launch.ts` (a `seedGrantedPermissions(profileDir, extId, apis)` helper — the extension id is deterministic for an unpacked extension from its path/key; read it back from the first launch or compute from the manifest `key` if present; document which), `scripts/lib/seed-profile.ts` (new: `seedProfile(cdp, { agents:5, artifacts:50, runs:60 })` through the real routes `named-agent.create`, `asset.create`, `agent.run` with the demo provider), `scripts/perf-leak-trace.ts` (launch via `launchChrome`, add the seeded phase and the budget checks; print a table every run), `scripts/chrome-journeys.ts` (a `--seeded` fixture phase reusing `seed-profile.ts` for the checks that only show defects with data — thread view, activity explorer — and a `--grant tabs,notifications` mode using the Preferences seed for the warning-permission tool journeys), `extension/ntp/ntp.js` (`perfSpan`-style marks: `ntp:boot→composer-ready`, `ntp:thread-list-hydrated`, `ntp:agents-panel-hydrated`, `ntp:artifacts-panel-hydrated`, `ntp:send`), `extension/background/service-worker.js` (`observability.dumpTrace` 7214: accept page measures posted via a new `observability.page-measures` route from extension pages only), `tests/harness-debug-port.test.ts` (unchanged), `docs/CONSTITUTION.md` (state the seeded budgets next to the existing "<500ms/<1s" lines at 90-92). Do NOT add the seeding to every journey run by default (keep fresh-profile runs; add the seeded phase as a second pass so fresh-state regressions stay visible too).
  - Steps: (1) `seedGrantedPermissions` in `chrome-launch.ts` + a journey that grants `tabs` and drives `open_tab` end to end (extends HEADED-ACCEPTANCE-LANE-01; note in its History). (2) `seed-profile.ts` + the perf seeded phase with budgets: `agent.run` p50 < 400 ms at 60 runs, `thread.get` < 40 ms, `run.list` < 40 ms, composer-ready < 150 ms, data-visible < 250 ms, zero long tasks > 50 ms, CLS 0, hub CPU profile non-idle < 150 ms; run it on today's tree and record the RED numbers in History (this is the OPFS-USAGE-WALK-01 proof). (3) Migrate `perf-leak-trace.ts` to `launchChrome()`. (4) Hub perf spans + the page-measures route + `dumpTrace` merge. (5) `--seeded` phase in `chrome-journeys.ts` for the thread-view and activity checks. (6) Constitution numbers.
  - Out of scope: fixing the regressions the gate catches (OPFS-USAGE-WALK-01, RUN-LOG-COMPACTION-01); harness orphan clean-up (SUITE-HONESTY-01).
- Review: pending
- Gates: the falsification gates apply
  - Unit: `tests/harness-debug-port.test.ts` continues to pass (no port named); add `tests/perf-spans.test.ts` — "the hub's span names are a fixed list and dumpTrace merges page measures" (pure test on the merge helper). Falsification: the seeded perf gate itself — run it on today's tree, RED at 60 runs ("agent.run p50 under 400 ms"); after OPFS-USAGE-WALK-01, GREEN; record both numbers in this entry's History.
  - Browser: `deno run -A scripts/perf-leak-trace.ts` (seeded phase) printing the table; `deno run -A scripts/chrome-journeys.ts --grant tabs` — "open_tab creates a real tab with the seeded grant" with screenshot `journey-open-tab-granted.png`; `--seeded` phase screenshots `hub-seeded-1440.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green, plus `npm run test:perf` (2457 / 138 at `fc2255be`; re-count).
  - Constraints: never name a debugging port; the Preferences seed is test-only (never shipped); the page-measures route is extension-principal only; no absolute paths or profile locations in committed output.
- Blockers: —
- Next: land `seedGrantedPermissions` + the `open_tab` journey, then the seeded perf phase run RED on today's tree.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-SEEDED-PROFILE-GATES-01`
- History:
  - 2026-08-30 11:00 UTC — measured: `test:perf` passes 8/8 with a "rendered fast (< 1000ms)" check that is load event plus 300 ms sleep on an empty profile; every gate, journey and screenshot in the repo runs on a fresh profile, so use-proportional regressions are invisible; `performance.getEntriesByType('measure')` on the hub is empty.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); `perf-leak-trace.ts:33-43,133`, the absence of any `granted_permissions` seeding under `scripts/`, and the lane's Preferences-seed shape re-verified.

## [CAP-FB-20260830-DEAD-CODE-CUT-01] Delete the modules and gallery-only components nothing reaches, and make the build refuse an unreferenced file
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 13, ui lane finding 14, perf lane finding 7, editing lane finding 14. Extends CAP-FB-20260828-DEAD-SURFACES-01 (`chat/`, `memory/`) and CAP-FB-20260827-DEAD-COMPONENTS-01 (the per-component verdicts live there). The shipped package carries thousands of lines no page, route or manifest entry references, which a security reviewer has to read anyway.
- Updated: 2026-09-02 02:54 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: worker (reanalysis coordinator hand-off)
- Workspace: durable worktree for `cap/dead-code-cut`
- Branch: `cap/dead-code-cut`
- Base: `f54d8661`
- Candidate: this tracker commit
- Shipping: `origin/main@cbd07135`
- Acceptance: a build-time reachability assertion (`scripts/check-reachability.mjs`, run from `npm run build` and `npm run test:all`) walks imports from `extension/manifest.json`, every `extension/**/*.html` and the build entries in `build.mjs`, and fails on any shipped `.js` under `extension/` that is not reached; the verified-dead modules below are deleted; the gallery-only components DEAD-COMPONENTS-01 marks DELETE are removed with their specimens; the SharedWorker decision is made and the code matches it. Owner directive 2026-08-30: `extension/lib/agent-cards.js` (adopted by CAP-FB-20260830-AGENT-SHARING-01), `extension/lib/agent-templates.js`, `extension/lib/agent-board.js` and anything the templates or the jobs board use are NOT cut and must appear in the allowlist with that reason. Done = the check passes with an explicit, reasoned allowlist; the package inventory shrinks by exactly the deleted files.
  - Context: verified in this tree by grep over `extension/` (excluding `dist/`), `scripts/build.mjs` and `extension/manifest.json`: zero references for `extension/lib/profile-store.js`, `extension/shared/composer.js` (+ `.css`; superseded by `<agent-composer>` `extension/shared/components.js:4157`), `extension/lib/tabular-diff-artifacts.js` (and `tabular-diff-artifacts-core.js`, whose only consumer is that adapter), `extension/lib/code-diff-artifacts.js`, `extension/lib/opfs-tool-workspace.js`, `extension/lib/python-runtime.js`, `extension/lib/python-tool.js`, `extension/lib/agent-worker-client.js`, `extension/lib/js-minifier-tools.js`, `extension/lib/jwt-decode-tools.js`, `extension/lib/run-log-wal-memory.js`. Three modules the security lane listed are NOT dead and must not be deleted: `extension/lib/preference-bridge.js` (imported by `components.js`), `extension/shared/agent-candidates.js` (imported by `extension/shared/agent-registry.js`), `extension/lib/bundled-tool-packages.js` (imported by five files including the service worker). `extension/workers/agent-worker.js` exists and `reconcileAgentWorkers` runs at boot (`extension/background/service-worker.js:7789`) although no page imports `agent-worker-client.js` and no worker target appeared in any run (perf lane finding 7). The install seed still writes `theme: "dark"` (`service-worker.js:7724`) and `docs/DESIGN.md:27` still lists four themes; `docs/components.html:16,61` still mounts `<theme-picker>`. `code-diff-artifacts.js:508-571` holds the sha256 retention helpers CAP-FB-20260830-ARTIFACT-VERSIONS-01 reuses — fold them in before deleting the file. What must NOT change: the WASI bundled-package inventory (`bundled-tool-packages.js` and friends); `agent-templates.js`, `agent-board.js`, `agent-cards.js`; anything under `extension/lib/wasm*`.
  - Reproduce today: (1) in the worktree run `for m in profile-store composer.js tabular-diff-artifacts code-diff-artifacts opfs-tool-workspace python-runtime python-tool agent-worker-client js-minifier-tools jwt-decode-tools run-log-wal-memory; do grep -rl --include=*.js --include=*.html --include=*.json "$m" extension scripts/build.mjs | grep -v "extension/dist\|/$m"; done` — every line is empty; (2) `npm run build` succeeds and `dist/` contains each of them; (3) open `docs/components.html` and see the theme-picker specimen for a feature removed at 0.2.301.
  - Files: new `scripts/check-reachability.mjs` (node, no deps: parse `import`/`export … from`/`new Worker(`/`chrome.runtime.getURL("…js")` strings; seeds: manifest `background.service_worker`, `content_scripts[].js`, every `<script src>` in `extension/**/*.html`, `build.mjs` entry list); `package.json` (`build` and `test:all` scripts); `build.mjs` (call the check before bundling); the modules above (delete); `extension/shared/components.js` and `docs/components.html` (the DELETE set from CAP-FB-20260827-DEAD-COMPONENTS-01: `theme-picker :1726-1753`, `agent-nav :6634-6655`, `prompt-bar :5650-5725`, `run-task-button :791-820`, `screenshot-strip :4117-4144`, `agent-config-form :6243-6275`); `extension/background/service-worker.js:7724` (drop `theme`), `docs/DESIGN.md:27`; the SharedWorker set (`extension/workers/agent-worker.js`, `extension/lib/agent-worker-*.js`, `extension/background/routes/agent-worker.js`, `service-worker.js:7789`) plus `docs/AGENT-EXECUTION-ARCHITECTURE.md`. Do NOT touch `extension/chat/` and `extension/memory/` here (CAP-FB-20260830-ONE-SHELL-01 owns them) or `extension/lib/agent-cards.js`.
  - Steps: (1) Write `scripts/check-reachability.mjs` with an `ALLOWLIST` map `{ file: reason }`; run it and commit the current list as the allowlist so the check is green before any deletion (this is the inventory the owner asked for). (2) Delete the eleven verified-dead modules and `composer.css`; remove `tabular-diff-artifacts-core.js` only after confirming CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01 is ABANDONED or moved to a branch — otherwise allowlist it with that entry id. (3) Fold `code-diff-artifacts.js:508-571` and `:573-603` helpers into the versions store per CAP-FB-20260830-ARTIFACT-VERSIONS-01, then delete the file (or allowlist it citing that entry until it lands). (4) Apply the DELETE verdicts from CAP-FB-20260827-DEAD-COMPONENTS-01 and their gallery specimens; run `npm run check:gallery` (`scripts/sync-gallery.mjs --check`). (5) Drop the `theme` seed and the DESIGN.md Themes line. (6) SharedWorker decision: propose option B (remove `workers/agent-worker.js`, `agent-worker-client.js`, the `agent-worker` routes and `reconcileAgentWorkers`, and rewrite the architecture doc to say the loop runs in the service worker) unless the owner wants option A (wire it); record the decision in History before deleting. (7) Shrink the allowlist to at most the WASI/bundled entries and the three adopted modules; wire the check into `build`.
  - Out of scope: `chat/` and `memory/` (CAP-FB-20260830-ONE-SHELL-01); the ADOPT components (their target entries); bundle-size budgets (CAP-FB-20260830-BUNDLE-BUDGET-01); the Pyodide runtime decision (CAP-FB-20260822-PYODIDE-PYTHON-01 — `python-runtime.js`/`python-tool.js` are deleted here because no runtime binary ships; that entry re-adds them with a pinned runtime if it proceeds).
- Review: author review 2026-09-02 — falsification gates cleared (RED/GREEN recorded in History); no independent review available.
- Gates: the falsification gates apply.
  - Unit: add `tests/reachability.test.ts` that runs the checker in-process against `extension/` and asserts zero unlisted unreachable files, plus "the allowlist names only existing files with a non-empty reason". Falsification: add a throwaway `extension/lib/zz-dead.js` (untracked), expect RED on "zero unreachable files", delete it, expect GREEN. 2026-09-02: the planted-file RED and the GREEN are both observed and recorded in History (checker CLI, the unit test, and `npm run build` all refuse the planted file). Existing guard: `tests/template-cards.test.ts` and `tests/agent-cards.test.ts` must stay green (they prove the adopted modules are still present).
  - Browser: `deno run -A scripts/chrome-journeys.ts` unchanged and green after each deletion commit; `npm run test:components` (`scripts/component-gallery-smoke.ts`) green with the specimens removed; screenshot `gallery-after-cut.png` showing no theme picker.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138). 2026-09-02 at the candidate: build green (new line `build assertion: every one of 220 shipped source files is reached (190 from entry points, 19 RETAINED with a reason)`); unit 2998 pass / 1 fail — the one red is `tests/security-suite-custody.test.ts`, lock-bound while other work held the serialized Chrome lock (the lock file was present when the solo rerun was attempted, so it is recorded as lock-bound, not rerun); Chrome journeys 323/323; `npm run check:gallery` clean; `check-tasks` clean.
  - Constraints: no eval in the checker; the MV3 bundle still contains no `new Function`; deletions are forward-only commits (never history rewrites); nothing under `extension/dist-versions/` is touched by hand.
- History:
  - 2026-09-02 12:30 UTC — worker: the guard + the inventory + the first cut. (1) `scripts/check-reachability.mjs`: seeds = manifest entry points (service worker, content scripts, newtab, side panel, options, sandbox pages, web-accessible resources) + the esbuild entries parsed from `build.mjs`; edges = every string token in a JS/HTML/CSS file that names an existing package-local file (acorn tokenizer, so comments are not edges); `dist/<bundle>` references map to their source entry; a `RETAINED` map `{file: reason}` seeds the walk too, and a RETAINED line that names a missing file, has no reason, or is already reached from an entry is itself a finding. Wired into `build.mjs` before bundling and into `npm run test:all` (`check:reachability`). (2) Re-inventoried at `f54d8661` (not the entry's line numbers): 220 shipped source files; 190 reached from entry points; the unreached set differs from the 2026-08-30 Context — `preference-bridge.js`, `shared/agent-candidates.js`, `bundled-tool-packages.js`/`bundled-inventory.js` are NO LONGER imported by any page or the service worker, while `python-execution.js`, `tool-pipeline.js`, `run-log-wal-memory.js`, the js-minifier and jwt-decode chains are unreached too. (3) Deleted the two modules nothing imports anywhere (extension, scripts, tests, docs): `extension/shared/composer.js` (superseded by `<agent-composer>`) and `extension/lib/agent-worker-client.js` (no page ever called `connectAgentWorker`; `docs/AGENT-WORKER-PHASE4.md` records the removal). (4) RETAINED (19 roots, 30 files with what they import), each with its reason in the map: owner directives (`agent-cards.js`, `bundled-tool-packages.js`, `bundled-inventory.js`); OPEN entries (`chat/*`, `memory/*` → ONE-SHELL-01; `tabular-diff-artifacts*.js` → TABULAR-DIFF-ARTIFACTS-01 is OPEN not ABANDONED; `code-diff-artifacts.js` → ARTIFACT-VERSIONS-01; `python-*.js` → PYODIDE-PYTHON-01 is P1 OPEN); and the test-only set (`js-minifier-tools.js` + chain and the three minifier worker bundles, `jwt-decode-tools.js` + chain, `opfs-tool-workspace.js`, `profile-store.js`, `tool-pipeline.js`, `run-log-wal-memory.js`, `preference-bridge.js`, `shared/agent-candidates.js`) which only tests under `tests/` import — those are cut together with their tests in a follow-up because `tests/`/`scripts/` were held by the suite-honesty work at the time. `shared/composer.css` is reached through `chat/chat.html`. `agent-templates.js`/`agent-template-select.js`/`agent-board.js` are reached from entry points, so they need no RETAINED line. (5) Falsification, verbatim: planted `extension/lib/zz-dead.js` → `node scripts/check-reachability.mjs` printed `reachability check failed (1 finding(s)): - lib/zz-dead.js: shipped but nothing reaches it (delete it, or add it to RETAINED in scripts/check-reachability.mjs with a reason)` exit 1; `tests/reachability.test.ts` → `reachability: zero unlisted unreachable files under extension/ ... FAILED` (AssertionError listing `lib/zz-dead.js`); `npm run build` → `Error: reachability check failed (1 finding(s))` exit 1. Removed the file → checker exit 0 with `every one of 220 shipped source files is reached (190 from entry points, 19 RETAINED with a reason)`; `ok | 5 passed | 0 failed`; build green. (6) Not done here, by design: the gallery-only components (owner directive 2026-08-30 in DEAD-COMPONENTS-01: adopt/retain only, nothing deleted); the `theme` seed and DESIGN.md Themes line (DEAD-COMPONENTS-01 owns them); the SharedWorker decision — proposal stands as option B (retire `workers/agent-worker.js`, `agent-worker-host.js`, the `agent-worker` routes and `reconcileAgentWorkers`, rewrite `docs/AGENT-EXECUTION-ARCHITECTURE.md` to say the loop runs in the service worker) but it is the owner's call and all of that code is reached today, so nothing was touched. Adjacent finding: `scripts/scan-shipped.mjs` still names `extension/lib/agent-worker-client.js` as a canonical SharedWorker-host exemption; harmless (the scanner only visits existing files) and left for the suite-honesty work that owns `scripts/`.
  - 2026-09-02 02:54 UTC — DONE: merged forward by the coordinator and pushed as `origin/main@cbd07135`. Coordinator gates on the merged tip: build clean (reachability check green: 190 reached + 19 retained), check:gallery clean, journeys 327/327, unit 3006/0 excluding the lock-bound custody file. The duplicated History header in the worker's entry was folded into one.
- Blockers: the follow-up cut of the test-only modules (RETAINED lines marked "only tests import it") needs their tests under `tests/` deleted in the same commit; `tests/` and `scripts/` were owned by the suite-honesty work at the time of this cut, so that deletion waits for it to land. `chat/` and `memory/` stay RETAINED until CAP-FB-20260830-ONE-SHELL-01 decides them. The SharedWorker decision (option A wire / option B remove) is the owner's; the code is unchanged either way until it is recorded here.
- Next: none — archive to TASKS-DONE.md at triage
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-DEAD-CODE-CUT-01`
  - 2026-08-30 11:00 UTC — opened by the reanalysis consolidation (security lane finding 13, ui lane finding 14, perf lane finding 7, editing lane finding 14); baseline `origin/main@fc2255be`. Measured by a reference-graph script: 15 modules / 3,957 lines with zero references; 14 custom elements used by nothing but the gallery; `dist/workers/agent-worker.js` (2 MB) has no caller.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Re-verified the reference graph in this tree: 11 of the 15 modules are dead; `preference-bridge.js`, `agent-candidates.js` and `bundled-tool-packages.js` are referenced and stay; `agent-cards.js` is adopted by CAP-FB-20260830-AGENT-SHARING-01 per owner directive; agent templates and the jobs board are never cut.

## [CAP-FB-20260830-PRIVACY-STATEMENT-01] One screen that says what the extension sends and stores, and a factory-reset journey
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane, findings 9 and 17. Nothing in the product tells the owner what leaves the machine (provider calls, skill imports, the model-driven fetch) or that the provider key sits unencrypted in the profile, and the full factory reset has no browser-driven proof.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: A one-screen "What this extension sends and stores" page is reachable from Settings and states outbound destinations, stored data classes (including that the provider key is stored unencrypted in the profile), the host-access posture, and how to wipe; a `factory-reset` journey seeds every storage class, runs the reset from the Settings button and asserts `enumerateStorageTargets()` is empty afterwards.
  - Context: no telemetry or analytics endpoint exists (security lane grep of every literal host). Outbound today: provider APIs (api.anthropic.com, api.openai.com, generativelanguage.googleapis.com, api.deepseek.com, a user-supplied OpenAI-compatible base URL), `extension/lib/skill-import.js` (api.github.com / raw.githubusercontent.com on an explicit import), the model-driven `cap:fetch` (RUN-SCRIPT-FETCH-APPROVAL-01 gates it), the dormant Pyodide CDN (BUNDLE-BUDGET-01 removes or pins it). Stored: `chrome.storage.local` (`providerConfig` including the key — `extension/lib/provider.js` `kvGet/kvSet("providerConfig")`; enrollment, grants, hooks, threads, usage, scheduled tasks), OPFS (per-origin memory, durable runs, artifacts/scripts), `chrome.storage.session` (bridge nonces), IndexedDB (fs grants), Cache. Wipe: Settings → Data & memory per-store Clear (`scripts/data-memory-clear.ts` acceptance) and the factory reset — `extension/lib/factory-reset.js` `FACTORY_RESET_STORAGE_CLASSES` (14), `enumerateStorageTargets` (27), `executeFactoryReset` (104), wired to `#factory-reset-btn` in `extension/options/options.js:2495-2600` with a destructive confirm at 2588. Gap: the reset has unit coverage only — `grep -n factory scripts/chrome-journeys.ts` → nothing. Key hygiene positives to state: write-only Settings input, redacted reads, diagnostics scrubber, storage-hook key-names-only. What must NOT change: the reset semantics; the statement must be generated from the same lists the code uses where possible (e.g. render `FACTORY_RESET_STORAGE_CLASSES` labels rather than a hand-typed copy) so it cannot drift.
  - Reproduce today: (1) build; Settings has no privacy/data statement page (grep `options.html` for "sends" / "stores" → nothing); (2) `grep -n "factory" scripts/chrome-journeys.ts` → no journey.
  - Files: `extension/options/options.html` (a "Privacy" row under About linking to `privacy.html`, or a section rendered from data — prefer a separate small page `extension/privacy/privacy.html` + `privacy.js` so it can be linked from the Web Store listing too), `extension/privacy/privacy.js` (renders three lists: outbound — from a `OUTBOUND_HOSTS` constant exported by `extension/lib/provider.js` plus skill-import and cap:fetch entries with their gating state; stored — from `FACTORY_RESET_STORAGE_CLASSES`; wipe — links to Data & memory and the reset), `extension/lib/provider.js` (export `OUTBOUND_HOSTS` from the provider presets), `extension/manifest.json` (nothing — the page is an extension page, not web-accessible), `scripts/chrome-journeys.ts` (the factory-reset journey), `docs/PERMISSIONS.md` or the README's host-access section (link the page). Do NOT move keys to `chrome.storage.session` in this entry (optional follow-up; record the owner's decision).
  - Steps: (1) Factory-reset journey first: seed a provider config (demo, no real key), one thread, one artifact, one fs grant fixture (the KAT's OPFS handle), a hook deny, then click `#factory-reset-btn` with a genuine gesture, confirm, and assert `enumerateStorageTargets()` (call through a test-seam route or by reading each class from the page) returns empty and the first-run guide is back. (2) `OUTBOUND_HOSTS` export + the page with the three lists (textContent), one sentence each: "Sent: your messages and the page text you share go to the model provider you chose (host). Nothing else leaves this device unless you import a skill or approve a fetch." (3) The host-access sentence comes from HOST-ACCESS-STORY-01's decision (install-granted `<all_urls>` vs optional) — render it from a single constant that entry owns. (4) Link from Settings → About and from the README. (5) a11y pass on the page.
  - Out of scope: changing key storage; the host-access decision itself (HOST-ACCESS-STORY-01); gating `cap:fetch` (RUN-SCRIPT-FETCH-APPROVAL-01) and cookie tools (COOKIE-TOOLS-CUT-01) — the page states whatever their current state is, read from code where possible.
- Review: pending
- Gates: the falsification gates apply
  - Unit: extend the factory-reset tests (`grep -l factory-reset tests/`) with "the privacy page's stored-data list equals FACTORY_RESET_STORAGE_CLASSES labels" and "OUTBOUND_HOSTS lists every literal provider host in provider.js" (static scan of `provider.js` for `https://` literals vs the export). Falsification: add a new host literal to `provider.js` without exporting it, expect RED, add it, GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — "factory reset: after seeding every storage class, the Settings reset empties enumerateStorageTargets and restores first run" (screenshot `settings-factory-reset-after.png` showing the first-run guide) and "privacy page renders the three lists and the host-access sentence" (screenshot `privacy-page.png`); `deno run -A scripts/a11y-audit.ts` extended to the privacy page.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green (2457 / 138 at `fc2255be`; re-count).
  - Constraints: no keys in the page, logs or screenshots (seed the demo provider only); textContent; the page is not web-accessible; a11y — headings and lists, one `<h1>`; the reset journey uses a genuine gesture (`requireGenuineGesture` on the confirm).
- Blockers: Depends on CAP-FB-20260830-HOST-ACCESS-STORY-01 (must land first — the page states the host-access posture)
- Next: write the factory-reset journey (independent of the blocker) and land it; draft the page once the host-access decision is recorded.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-PRIVACY-STATEMENT-01`
- History:
  - 2026-08-30 11:00 UTC — verified: no telemetry or analytics endpoint exists; the full factory reset has no Chrome journey in `test:all`.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); `factory-reset.js` exports (14, 27, 104), the Settings wiring (`options.js:2495-2600`) and the absence of a journey re-verified.

## [CAP-FB-20260830-CODE-HEALTH-01] Route raw console calls through cap-log; annotate the 41 bare catches
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane, findings 14 and 15. Thirty-two `console.*` calls bypass the levelled, redacting logger, and dozens of empty `catch {}` blocks swallow errors with no comment saying why.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: No raw `console.*` call remains in the shipped extension tree outside `extension/lib/cap-log.js`; every empty catch carries a comment or a `capLog` call; a unit test greps the tree for both and stays green; the larger structural moves (route modules, component families) are recorded here as follow-ups, not done.
  - Context: `extension/lib/cap-log.js` exports `capLog(ns)` (line 235: a namespaced logger with `debug/info/warn/error`), `setLogVerbosity` (129), `scrubLogValue` (177: key redaction) and `dumpLogBuffer` (220); it is "off" by default in store builds (`build.mjs:278` `__CAP_BUILD_LOG_DEFAULT__`). Raw calls on this tree: `extension/background/service-worker.js` 17 (e.g. `console.error("reconcileAgentWorkers:", …)` at 7790), `extension/ntp/ntp.js` 3, `options.js` 0, `components.js` 0; 15 files under `extension/` (excluding dist and cap-log) contain at least one. Empty catches: the security lane counted 421 with 380 commented and 41 bare (multi-line forms included); a one-line grep `catch *{ *}` finds 22 (e.g. `service-worker.js:1940, 1941, 2024`). Largest files for the record: `components.js` 8,855 lines, `service-worker.js` 7,959 (144 inline routes at 3959-7274 beside five extracted route modules merged at 3931), `browser-tools.js` 5,415, `ntp.js` 3,654, `options.js` 3,155. TODO/FIXME census is 2. What must NOT change: log output in the developer build (cap-log at verbose prints the same information); the store build stays quiet.
  - Reproduce today: `grep -rn "console\.\(log\|warn\|error\|info\|debug\)(" extension --include=*.js -l | grep -v "dist/\|cap-log"` → 15 files; `grep -rn "catch *{ *}" extension --include=*.js | grep -v dist | wc -l` → 22.
  - Files: the 15 files from the grep (each gets `const log = capLog("<ns>")` and the call replaced with the matching level); the bare-catch sites (add `/* <why> */` or `log.debug`); new `tests/code-health.test.ts` (the two greps, with an explicit allowlist for `cap-log.js` and for test seams); `docs/tool-platform-architecture.md` (a "structure follow-ups" paragraph: per-namespace route modules for the 144 inline SW routes; one file per component family with the gallery sync as the invariant; no source file over 3,000 lines — target dates left to the owner). Do NOT start the route/component splits here.
  - Steps: (1) `tests/code-health.test.ts` with both greps (RED: 15 files / 22 sites). (2) Replace the 17 SW calls (the `console.error` in boot paths becomes `log.error` — cap-log's error level is always on), then ntp.js, then the remaining files; keep the same message text. (3) Annotate each bare catch: prefer a comment naming the swallowed condition (the existing style, e.g. `catch { /* no backend */ }`); where an error is genuinely surprising, `log.debug` it. (4) Extend the grep to the multi-line form (`catch\s*\{\s*\}` with `s` flag) so the count matches the lane's 41; annotate the remainder. (5) Docs paragraph.
  - Out of scope: dead-code deletion (DEAD-CODE-CUT-01); helper de-duplication (ESCAPEHTML-SINGLE-SOURCE-01); the actual route-module extraction and component-family split (follow-ups recorded in docs).
- Review: pending
- Gates: the falsification gates apply
  - Unit: `deno test tests/code-health.test.ts` — "no console.* outside cap-log in extension/ (excluding dist)", "no uncommented empty catch in extension/ (excluding dist)". Falsification: add `console.log("x")` to `ntp.js`, expect RED, remove, GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` stays green; one check "developer build: the SW boot logs the same reconcile/boot lines through cap-log at verbose" (compare the SW console tail before/after for the boot messages). No screenshot needed beyond the harness log.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green (2457 / 138 at `fc2255be`; re-count).
  - Constraints: no provider keys in logs (cap-log's `scrubLogValue` is the reason to route through it); store build stays silent by default.
- Blockers: —
- Next: write `tests/code-health.test.ts` (RED), then route the 17 service-worker calls.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-CODE-HEALTH-01`
- History:
  - 2026-08-30 11:00 UTC — measured: 421 empty catch bodies (380 commented, 41 bare); TODO/FIXME census is 2.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); re-counted on the worktree: 17 raw console calls in the SW, 3 in ntp.js, 15 files total; 22 one-line bare catches (the lane's 41 includes multi-line forms).

## [CAP-FB-20260830-BUNDLE-BUDGET-01] The service-worker bundle is 4.56 MB against a 2.5 MB budget; Pyodide would load unpinned remote code
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane, findings 6, 9, 10 and 13; security lane finding 8. The worker bundle is 82 percent over the constitution's stated budget and nothing in the build fails when it grows; the Python runtime would fetch ~10 MB from a CDN with empty integrity pins.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: The store-target service-worker bundle is at or under 3.0 MB with a build-time size gate that fails above it and prints the top contributors; the hub and side panel load one bundled module each; no `cdn.jsdelivr.net` string ships in any bundle (Pyodide is either bundled-and-pinned or deleted); cold-start busy window at or under 80 ms.
  - Context: measured on disk (developer build): `extension/dist/background/service-worker.js` 4,560,257 B, `extension/dist/options.bundle.js` 866,804 B, `extension/dist/workers/agent-worker.js` 2,036,242 B. `docs/CONSTITUTION.md:90-92` says "the SW bundle is ~2.5mb — watch it". Contributors (security lane): zod 1,063 KB, three provider SDKs plus gateway ~730 KB shipped unconditionally; `service-worker.js` imports `BUNDLED_INVENTORY` and `BUNDLED_TOOL_PACKAGE_ROWS` at lines 68-69 (data modules totalling 1,668 lines across `extension/lib/bundled-*.js`, used only by `tool.preview.run` and the Tool library) and `ai`/`zod` at 498-499. The agent worker bundle has no caller (`extension/lib/agent-worker-client.js` is imported by nothing; `reconcileAgentWorkers` at 7789 runs against an alive-set that can never fill) — that cut is CAP-FB-20260830-DEAD-CODE-CUT-01. `build.mjs` builds three entries (SW 285-296, options 297, worker 302-318), scrubs `new Function` (320-338) and has no size check or metafile. The hub loads ~41 unbundled modules (~1.1 MB) per tab. `extension/lib/python-runtime.js:13-24` pins URLs with `jsIntegrity: ""` and `wasmIntegrity: ""`, and `verifyIntegrity` (line 36) returns the text unchecked when the pin is empty; `python-tool.js` always reports unavailable today. Cold start today is 114-117 ms busy, so this is hygiene rather than a felt delay — do not trade behaviour for bytes. What must NOT change: `components.js` stays the single unbundled source that `scripts/sync-gallery.mjs` copies to `docs/` (`check:gallery`); the eval scrub and seam scan.
  - Reproduce today: (1) `npm run build:production`; (2) `ls -l extension/dist/background/service-worker.js` → over 4.5 MB; (3) `grep -c cdn.jsdelivr.net extension/dist/background/service-worker.js` → non-zero; (4) open the hub through `launchChrome()` and list `chrome-extension://` script loads from the page target (`Network.enable` + `responseReceived`) → ~41 module fetches.
  - Files: `build.mjs` (add `metafile: true` to the shared esbuild options at 275-279, a post-build size report, and the gate; add NTP and side-panel entries beside `OPT` at 282/297); `extension/background/service-worker.js:68-69` (dynamic-import the inventory data inside the `tool.preview.run` and tool-library routes) and 498-499 (provider adapter imports — grep `@ai-sdk/` and import the adapter only inside the provider factory in `extension/lib/provider.js`); `extension/ntp/ntp.html` and `extension/sidepanel/sidepanel.html` (point at `dist/ntp.bundle.js` / `dist/sidepanel.bundle.js`); `scripts/build-test-extension.mjs` (mirror every new entry — it rebuilds the SW and options into the isolated test copy at its lines 44-62 and must build the same entries); `extension/lib/python-runtime.js` + `extension/lib/python-tool.js` (delete, or bundle per `docs/PYODIDE-BOUNDED-BUILD.md` with non-empty sha384 pins); `docs/CONSTITUTION.md:92` (state the number the gate enforces). Do NOT split `components.js`.
  - Steps: (1) Metafile + report: in `build.mjs` write `dist/build-report.json` from `result.metafile` and print the top 15 inputs by bytes for the SW; commit this alone so the contributors are visible. (2) Gate: after the scrub, `stat` the SW and fail when the store target exceeds 3,000,000 B (developer target: warn only, source maps are external so sizes match); add the same assertion as a unit test reading the built file so CI sees it. (3) Move `bundled-inventory-data.js` / `bundled-tool-packages.data.js` behind `await import()` inside the two routes that use them (esbuild splits dynamic imports into `dist/chunks/*` — set `splitting: true, outdir` for the SW build or keep `outfile` and accept the inline chunk; verify the manifest still lists the SW as `type: module`). (4) Provider adapters: import `@ai-sdk/anthropic|openai|google|openai-compatible` lazily per configured provider inside the model factory; zod stays (agent-do needs it) but audit module-scope `z.object` construction in `extension/lib/management-tools.js`/`browser-tools.js` for lazy factories only if the report shows it matters. (5) Bundle NTP and side panel: new esbuild entries with the same `shared` config, `format:"esm"`, no node shims; keep `components.js` imported by relative path so the gallery sync is unchanged. (6) Pyodide: delete `python-runtime.js`, `python-tool.js`, their tests and the tool descriptor, OR land the bounded build with pins — record the choice in History; add the "no cdn.jsdelivr.net in dist" assertion either way. (7) Re-measure cold start with the perf lane's `sw-cold` method (Target.setAutoAttach on the SW + CPU profile, three runs) and record it.
  - Out of scope: deleting the agent-worker bundle and the 15 unreferenced modules (CAP-FB-20260830-DEAD-CODE-CUT-01 — land it first so the numbers here are measured on the smaller tree); route-module extraction (CAP-FB-20260830-CODE-HEALTH-01); components.js splitting (explicitly not now — add the hub CPU budget to SEEDED-PROFILE-GATES-01 instead).
- Review: pending
- Gates: the falsification gates apply
  - Unit: add `deno test tests/bundle-budget.test.ts` — "store-target service-worker bundle is at or under 3.0 MB", "no shipped bundle contains cdn.jsdelivr.net", "every dist entry is referenced by a manifest/html". Falsification: temporarily set the gate to 1 MB (or add a 1 MB literal string to the SW), expect RED on the size assertion, restore, expect GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` must stay green after the NTP/side-panel bundling (it drives both surfaces); add check "hub: exactly one extension script module load" (count `chrome-extension://.../dist/ntp.bundle.js` in `Network.responseReceived`). Screenshot `hub-after-bundling.png` identical in layout to today's hub.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green, plus `npm run check:gallery` (2457 / 138 at `fc2255be`; re-count).
  - Constraints: MV3 CSP — no eval, the scrub stays; no remote code (Chrome Web Store policy) — this is the security half of the entry; `components.js` single source; no fixed debug port.
- Blockers: Depends on CAP-FB-20260830-DEAD-CODE-CUT-01 (must land first — measure after the dead modules are gone)
- Next: land step 1 (metafile report) on its own so the contributor list is in the repo before any cut.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-BUNDLE-BUDGET-01`
- History:
  - 2026-08-30 11:00 UTC — measured: SW bundle 4,560,257 B (zod 1,063 KB, three provider SDKs plus gateway ~730 KB shipped unconditionally), agent worker 2,036,242 B with no caller, options bundle 866,804 B; the hub loads ~41 unbundled modules (~1.1 MB) per tab; cold-start busy window 114-117 ms today, so this is hygiene, not a felt delay.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); build entries and the Pyodide pin state re-verified in `build.mjs` and `python-runtime.js`.

## [CAP-FB-20260830-MODEL-CALL-ECONOMY-01] A 19 KB system prompt on every call and an agent-do nudge that costs one extra call per turn
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 15, editing lane finding 8, live lane finding 11. "Open a tab and tell me its title" costs six provider calls and ~28k input tokens; the last call of every tool-using turn exists only to answer "Continue working on the task".
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: The composed hub system prompt is under 6 KB (measured by a unit test on the registry), the agent-do continuation nudge is never sent after a step that already produced final text, a scripted provider that re-calls a tool on every nudge stops within 3 iterations with a visible "stopped after N steps" marker, and the two-turn artifact journey shows exactly 3 provider calls for the create turn.
  - Context: the prompt is composed by `composeSystemPrompt` in `extension/lib/system-prompts.js` (line 637; base + owner override + role + skills + runtime constraints layers) from `PROMPT_REGISTRY` (133) whose base content is `extension/lib/master-skill.js`; the file is 51,851 bytes and the run-log attestation records `composedBytes:17848` with `prefixMatch` (`extension/lib/agent.js:505`, journalled at `service-worker.js:2539`). The nudge is inside the bundled `agent-do@0.7.0` loop (`node_modules/agent-do/dist/src/loop.js:743-747` and the second copy at 1141, both bundled into the SW — `grep -c "Continue working on the task" extension/dist/background/service-worker.js` = 2): after every iteration with `hasToolCalls` it pushes a user message "Continue working on the task. If you are done, respond with your final summary without calling any tools." and calls the provider again with the whole transcript, even when that iteration already ended in final text. agent-do exposes the stop hook: `hooks.onStepStart` may return `{decision:"stop"}` (loop.js 619-629; `types.d.ts:364`), and `onStepComplete` receives `{step, hasToolCalls, text}` (loop.js 733-738). The product wires both at `extension/lib/agent.js:763` (`onStepStart`) and `:779` (`onStepComplete`, which already forwards `{type:"text", text, hasToolCalls}` to the UI), and configures `maxIterations` (402, default 12) and `innerStepLimit` (745). The lane evidence used gpt-4.1 and gemini-2.5-flash; the current model IDs to target are gpt-5.6-sol, gemini-3.7-flash, grok-4.6, glm-5.3 and claude-sonnet-5 — re-measure on those. What must NOT change: the protected constraints layer ordering (system-prompts 700-745), the attestation/`prefixMatch` bookkeeping, `innerStepLimit`.
  - Reproduce today: (1) build; (2) run the editing lane's scripted OpenAI-compatible provider pattern (promoted to `scripts/lib/scripted-provider.ts` by CAP-FB-20260830-SUITE-HONESTY-01; until then, its scratchpad `fake-provider.ts`) that answers `search_tools` → `execute_tool(create_asset)` → final text; (3) count HTTP requests at the fake provider — 4 where 3 did the work, the 4th body ~20 KB carrying the nudge; (4) with the demo provider on the hub, note the sidebar preview "Task received (19582 chars)" — that number is the prompt size; (5) script the provider to always answer a nudge with another tool call — observe 12 iterations / 25 calls and repeated agent bubbles with no user turn between them.
  - Files: `extension/lib/agent.js` (763-790: the hook wiring — add the stop predicate), `extension/lib/agent-loop.js` (58-66: mirror the predicate for the worker path so both loops agree), `extension/lib/system-prompts.js` (`composeSystemPrompt` 637; add a `promptBudget` measurement helper), `extension/lib/master-skill.js` (the prose to cut; keep the tool-name list but move per-tool usage rules into the tool `description` strings in `extension/lib/management-tools.js` and `browser-tools.js`), `tests/agent-do-logging.test.ts` (extend) and a new `tests/prompt-budget.test.ts`, `KNOWN-ISSUES.md` (only if agent-do proves unconfigurable — it is not; the hook exists). Do NOT touch `extension/lib/provider.js` error mapping (CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01).
  - Steps: (1) Stop predicate: in `agent.js` `onStepComplete` remember `lastStep = {hasToolCalls, text}`; in `onStepStart` return `{decision:"stop"}` when `lastStep.hasToolCalls && lastStep.text.trim().length > 0` (the step both called tools and wrote its final answer — the nudge would only ask for a repeat). Also count nudged iterations and stop at 3, emitting a progress event `{type:"stopped", reason:"iteration-cap", steps}` that `extension/shared/conversation.js` renders as a muted status line "Stopped after N steps" through the existing `conversation-run-status` element (`components.js:5297`) — never as another agent bubble. (2) Prompt budget: add `measurePromptLayers(scope)` in `system-prompts.js` returning bytes per layer; unit-test the hub composition is under 6,144 bytes. (3) Cut the manual: in `master-skill.js` remove the per-tool inventory prose (the tool descriptors are already shown to the model by `search_tools`/`list_tools`, lines 44-77 explain that mechanism — keep those), keep the artifacts model section (260+) to three sentences. (4) Provider caching: for Anthropic set the system block `cache_control: {type:"ephemeral"}` through the AI SDK provider options in the model factory; for OpenAI-compatible endpoints the stable prefix is enough — assert `prefixMatch` stays true in the run log. (5) Re-measure with the scripted provider (call count) and once with a real key on gpt-5.6-sol and claude-sonnet-5 (tokens, cost) and record in History.
  - Out of scope: the nudge summary overwriting the real answer on persist (CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01); streaming (CAP-FB-20260830-TRANSCRIPT-STREAMING-01); first-classing the top tools to remove `search_tools` round trips (record as a follow-up in this entry's History, do not do it here).
- Review: pending
- Gates: the falsification gates apply
  - Unit: `deno test tests/prompt-budget.test.ts` — "hub system prompt composes under 6,144 bytes" (call `composeSystemPrompt({baseId: hub base})` and measure UTF-8 bytes); extend `tests/agent-do-logging.test.ts` with "no continuation after a step that produced final text" (stub model: step 1 returns tool call + text; assert the model is invoked exactly once more at most, i.e. the second `onStepStart` returns stop) and "a tool-on-every-nudge model stops at 3 with a stopped event". Falsification: revert step 1, expect RED on "no continuation after a step that produced final text", restore, expect GREEN.
  - Browser: the keyless two-turn artifact journey in `deno run -A scripts/chrome-journeys.ts` (from SUITE-HONESTY-01) — check "artifact create turn is exactly 3 provider calls" (the scripted provider counts requests) and "runaway tool loop shows 'Stopped after 3 steps'" with screenshot `thread-stopped-after-steps.png` showing the status line and no repeated bubbles.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green (2457 / 138 at `fc2255be`; re-count).
  - Constraints: real library, not a reimplementation — configure agent-do through its hooks, never patch the bundle; no provider keys in logs; the stopped marker is textContent.
- Blockers: —
- Next: write the "no continuation after final text" unit test with a stub model, then add the `onStepStart` stop predicate at `agent.js:763`.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-MODEL-CALL-ECONOMY-01`
- History:
  - 2026-08-30 11:00 UTC — measured on the wire: `composedBytes:17848`; request bodies 20.5-51 KB; "open a tab and tell me its title" = 6 calls, 27.9k input tokens, USD 0.066 on gpt-4.1; the nudge is answered with a summary that then overwrites the real answer (see CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01); one mis-scripted run looped 12 iterations / 25 calls.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); confirmed agent-do 0.7.0 exposes `onStepStart → {decision:"stop"}` so no bundle patch or KNOWN-ISSUES escape hatch is needed; lane cost figures were taken on gpt-4.1/gemini-2.5-flash — re-measure on gpt-5.6-sol / claude-sonnet-5.

## [CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01] Small artifact defects: New tab opens twice, an empty id masks the real error
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane, findings 9 and 13. One click on "New tab" opens two viewer tabs; an agent that forgets the artifact id is told "requires owner approval" and retries the same call twelve times.
- Updated: 2026-08-31 09:15 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: One New tab click yields exactly one `artifact/artifact.html` target, and `asset.update` with an empty or unknown id returns "update_asset needs an existing id (use list_assets)" before the approval gate; both assertions are RED on the current tree.
  - Context: (a) `ArtifactCard` (`extension/shared/components.js:2144-2262`): `set preview` (2148) re-renders and re-wires; the base `attributeChangedCallback` (606-614) also re-renders + re-wires on any observed attribute change; `_wire` (2234-2255) adds `open-tab` listeners to the fresh nodes; the page adds `card.addEventListener("open-tab", …)` in `wireCard` (`extension/artifacts/index.js:99-107`) which calls `chrome.tabs.create`. Measured: one genuine `Input.dispatchMouseEvent` click → two viewer tabs. The bisect is between a doubled `_emit` (component) and a doubled page listener (index.js sets attributes at 56-63 THEN calls `wireCard` at 68 — if `wireCard` runs twice on a re-render path, that doubles). (b) `asset.update` route (`service-worker.js:5710`) builds `canonicalOperationTarget("asset", {origin, id})`, which yields no target for `id:""`, so `requireOwnerApproval` (3288-3290) returns "This operation requires owner approval." — the readable message already exists in `artifacts.js:712` but is never reached. What must NOT change: the approval gate for valid ids.
  - Reproduce today: (1) build; seed an artifact; open Artifacts; count `Target.getTargets` pages matching `artifact/artifact.html` before/after ONE click on New tab → 0 → 2. (2) From the lazy protocol send `update_asset {origin:"master", id:"", content:"x"}` → `{"error":"This operation requires owner approval.","ok":false}`.
  - Files: `extension/shared/components.js` (`ArtifactCard._wire` 2234), `extension/artifacts/index.js` (`wireCard` 99; the render loop 50-78), `extension/background/service-worker.js` (`asset.update` 5710), `tests/artifact-newtab.test.ts`, `tests/artifacts.test.ts`, `scripts/chrome-journeys.ts`.
  - Steps: (1) Add a journey check that counts viewer targets after one click (RED). (2) Make `_wire` idempotent with a per-wire `AbortController` (`{signal}` on each `addEventListener`, abort the previous at the top of `_wire`) AND guard `wireCard` with a `WeakSet` of wired cards; re-run the journey (GREEN) and note in History which side was doubling. (3) In `asset.update`, before `canonicalOperationTarget`: `if (typeof id !== "string" || !id) return {ok:false, error:"update_asset needs an existing id (use list_assets)"}`; after the gate, map `updateAsset`'s "asset not found" to the same sentence. (4) Unit tests.
  - Out of scope: everything else in the viewer/dialog (ARTIFACT-VIEWER-SOURCE-DIFF-01) and the patch tool (PATCH-ASSET-TOOL-01). If either of those lands first it absorbs its half of this entry — record the fold in History and close this entry as DONE by reference.
- Review: pending
- Gates: the falsification gates apply
  - Unit: extend `deno test tests/artifact-newtab.test.ts` — "one open-tab click dispatches exactly one open-tab event after preview and attribute re-renders"; extend `tests/artifacts.test.ts` (route-level) — "asset.update with an empty id returns the readable message and never calls requireOwnerApproval". Falsification: revert step 2, expect RED on "exactly one"; revert step 3, expect RED on "readable message"; restore both, GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — "library: one New tab click opens exactly one artifact viewer target". Screenshot `library-one-new-tab.png` with the harness log line showing the target count.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green (2457 / 138 at `fc2255be`; re-count).
  - Constraints: no fixed debug port; the error string must not leak other artifacts' names.
- Blockers: —
- Next: add the journey count check (RED), then the AbortController wire.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01`
- History:
  - 2026-08-30 11:00 UTC — measured: one genuine click opened two viewer tabs; an empty-id update returned "This operation requires owner approval" with no card.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); both listener sites (`components.js:2234`, `artifacts/index.js:99`) and the route order (`service-worker.js:5710` → 3290) re-verified.

## [CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01] Hooks is 50+ identical cards with red Deny buttons; Permissions is 19 identical cards
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane, finding 6. Two Settings sections are walls of identical rows where the dominant colour is danger red and every row shouts the same teal Enable.
- Updated: 2026-09-01 20:33 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: —
- Candidate: —
- Shipping: —
- Acceptance: Hooks is a compact table (event · Chrome API · state) with a per-row `<switch-toggle>` and one "Deny all" action, Permissions is a grouped list (Browsing · Content · System) of `<capability-row>`s with a ghost "Turn on" and the "Gates: …" detail behind a disclosure; neither section exceeds 900 px on a fresh profile, at most one red control is visible per viewport, and every row uses the shared components.
  - Context: `extension/options/options.html` sections `#permissions` (207-212, `<div id="permission-list">`) and `#hooks` (230-235, `<div id="hook-list">`). `extension/options/options.js` `renderPermissions` (1899-1985) builds a hand-rolled `div.perm-row` per capability with a `gates` line (`Gates: …`, ~1907) and a filled `btn small` "Enable" (~1936-1944); `renderHooks` (1989-2040) builds the SAME `perm-row` per hook with a `btn small danger` "Deny" button (2012-2020) that calls `hooks.deny`. Shared components that already exist: `<capability-row>` (`components.js:2135`, grid `28px 1fr auto` at 2067 — icon | name+description | action) and `<switch-toggle>` (1790, the direct enable/disable switch the gallery documents for permission rows at `docs/components.html:83`). `docs/DESIGN.md:26` makes danger `#b3261e` a semantic token and the impeccable craft floor bans same-size icon+heading+text card walls as page structure. Measured: hooks 2,818 px tall, permissions 2,182 px. What must NOT change: `hooks.deny` / `hooks.status` / capability request routes and their fail-closed semantics; the permission request must still happen on the user gesture (`chrome.permissions.request` from the page).
  - Reproduce today: (1) build; `launchChrome()`; open `options.html#hooks` and `#permissions` on a fresh profile; (2) measure `section.getBoundingClientRect().height` → 2,818 / 2,182; (3) count `.btn.danger` visible in the viewport → many.
  - Files: `extension/options/options.html` (207-212, 230-235: add group headings and a "Deny all" button; a `<table class="hooks">` with `<thead>` event/API/state), `extension/options/options.js` (`renderPermissions` 1899, `renderHooks` 1989), `extension/options/options.css` (table + group styles using `--panel-2`/`--border`), `extension/shared/components.js` (`<capability-row>` gains a `group` attribute only if needed — prefer plain `<h3>` group headings in the page), `scripts/kat-settings-cleanliness.ts` (extend with the height and red-control budgets), `tests/components.test.ts`. Do NOT hand-roll a new row markup — the gallery's `<capability-row>` + `<switch-toggle>` are the only allowed primitives.
  - Steps: (1) Permissions: group `CAPABILITIES` by a `group` field (add it to `extension/lib/capabilities.js` entries: Browsing = tabs/history/bookmarks/reading list/sessions…, Content = scripting/screenshot/downloads/clipboard…, System = notifications/idle/power/system.*); render `<h3>` per group and one `<capability-row icon name description action>` per capability with `action="Turn on"` as a ghost button and `action-state="on"` rendering a `<switch-toggle>`; move the `Gates:` sentence into the row's description `<details>`. (2) Hooks: `<table>` with `<th scope="col">` Event / Chrome API / Allowed; each row `<td>label</td><td><code>tabs.onCreated</code></td><td><switch-toggle checked=!denied aria-label="Allow ${label}"></switch-toggle></td>`; the switch's `change` calls `hooks.deny` with `denied: !checked`; a single "Deny all" ghost button above the table opens `confirmActionDialog({destructive:true, requireGenuineGesture:true})` (`components.js:5827`) — that confirm is the only red control. (3) Hide the API column under 720 px via a container query. (4) Budgets in the KAT + journey.
  - Out of scope: the IA (one section at a time; CAP-FB-20260827-SETTINGS-MONOLITH-01 — sequence after it so the tables are built once inside the new section shell); the 2.39:1 usage tab (SETTINGS-MONOLITH-01's update); `<select class="control">` migration (same).
- Review: pending
- Gates: the falsification gates apply
  - Unit: extend `deno test tests/components.test.ts` — "capability-row renders a switch-toggle when action-state is on and a ghost button otherwise"; add `tests/options-permissions-groups.test.ts` — "every capability declares a group from the allowed set". Falsification: remove `group` from one capability, expect RED, restore, GREEN.
  - Browser: `deno run -A scripts/kat-settings-cleanliness.ts` (wired into `test:all` per SUITE-HONESTY-01) — "hooks section under 900 px on a fresh profile", "permissions section under 900 px", "at most one danger control visible per viewport in Settings", "every hook/permission row is a capability-row or a table row with a switch-toggle"; `deno run -A scripts/chrome-journeys.ts` existing hooks/permissions checks stay green (they drive `hooks.deny` and capability enable through these sections — update selectors). Screenshots `options-hooks-table.png`, `options-permissions-grouped.png` at 1440x900 and 1024x700.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green (2457 / 138 at `fc2255be`; re-count).
  - Constraints: DESIGN.md — danger token only for the destructive confirm, accent only for state; a11y — `<table>` with column headers, every switch labelled with the hook/capability name, 24 px minimum targets; `chrome.permissions.request` still on the click; textContent for labels; the impeccable design pass.
- Blockers: Depends on CAP-FB-20260827-SETTINGS-MONOLITH-01 (sequencing only — land after the one-section-at-a-time IA so the tables are built once)
- Next: add the `group` field to `capabilities.js` with its unit test (safe to land before the monolith split), then the Hooks table.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01`
- History:
  - 2026-08-30 11:00 UTC — measured: hooks 2,818 px, permissions 2,182 px; danger red is the dominant colour on the Hooks page.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); `renderPermissions` 1899 / `renderHooks` 1989 and the shared `capability-row` (2135) / `switch-toggle` (1790) re-verified.
  - 2026-09-01 20:33 UTC — tracker correction: the recorded IN_REVIEW candidate `3627b693` on `cap-recent-activity-user` is a recent-activity-lane commit; no ref anywhere contains this entry's implementation (verified by content search across all heads and origin refs). Reset to OPEN; the metadata was a copy-paste error, no work was lost.

## [CAP-FB-20260830-ONE-SHELL-01] Three surfaces, three shells: one content width, one title, no duplicate chrome
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane, finding 10. Extends CAP-FB-20260828-DEAD-SURFACES-01 and CAP-FB-20260828-VIEW-FRAME-COLLAPSE-01. Artifacts, Directory and Settings each sit at a different left edge inside the hub, the embedded Artifacts view shows its name twice, and two unreachable pages (chat, memory explorer) still ship with their own shells.
- Updated: 2026-09-01 20:33 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: —
- Candidate: —
- Shipping: —
- Acceptance: `extension/chat/` and `extension/memory/` are deleted with no remaining reference; Artifacts, Directory, Skills and Settings share one `--content-max` / `--content-gutter` token pair so their content starts at the same left edge at 1440 and 1024 (measured); no embedded view shows its name twice.
  - Context: measured gutters: Artifacts 224 px, Directory 272 px, memory explorer 294 px; the embedded Artifacts view shows the frame bar "← Back | Artifacts" (`extension/ntp/ntp.html:926` `<span class="view-title" id="view-title">`) plus an `<h1>Artifacts</h1>` twenty pixels below; Settings shows a second brand header inside the frame. `chat/chat.html` and `memory/explorer.html` are referenced by no js/html/manifest (DEAD-SURFACES-01 confirmed it); `memory/explorer.js` also carries one of the four `escapeHtml` copies (line 75; ESCAPEHTML-SINGLE-SOURCE-01). Tokens live in `extension/shared/theme.css` (`--panel-2` 19, `--accent` 44; no content-width token exists today). The views are loaded in an iframe by `openView` in `extension/ntp/ntp.js` (grep `openView(`), which VIEW-FRAME-COLLAPSE-01 will replace; this entry is the bridge that makes them consistent now. What must NOT change: the hub's own layout; the views' functionality; `check:vocabulary`'s retired-file list (`scripts/check-vocabulary.mjs` RETIRED_FILES — add the two deleted pages so they cannot return).
  - Reproduce today: (1) build; `launchChrome()`; open the hub → Artifacts, Directory, Settings in turn; (2) for each, read the first content element's `getBoundingClientRect().left` inside the view frame → three different numbers; (3) in the Artifacts view, count `h1`/`.view-title` elements naming "Artifacts" → 2; (4) `grep -rn "chat/chat.html\|memory/explorer.html" extension --include=*.js --include=*.html --include=*.json` → only self-references.
  - Files: delete `extension/chat/` and `extension/memory/` (and their tests if any reference them — grep `tests/` for `chat.html`/`explorer.js`); `extension/shared/theme.css` (add `--content-max: 1040px; --content-gutter: clamp(16px, 4vw, 40px)`); `extension/artifacts/index.html`, `extension/directory/directory.html`, `extension/options/options.html`, the Skills surface (`extension/skills/skills-panel.js` renders inside Settings — inherits) — each page's root container gets `max-inline-size: var(--content-max); padding-inline: var(--content-gutter); margin-inline: auto`; `extension/ntp/ntp.html:926` / `ntp.js` `openView` (pass `?embedded=1` so the view hides its own `<h1>` and brand header when the frame bar names it — a `data-embedded` attribute on `<html>` and a CSS rule); `scripts/check-vocabulary.mjs` RETIRED_FILES; `docs/DESIGN.md` (document the token pair); `scripts/chrome-journeys.ts`. Do NOT start the iframe collapse itself.
  - Steps: (1) Delete the two surfaces, fix any test imports, add them to RETIRED_FILES; commit alone. (2) Tokens in `theme.css` + DESIGN.md line. (3) Apply the container rule to the three pages (and verify Skills inside Settings inherits). (4) Embedded mode: `openView` appends `embedded=1`; each view's boot script sets `document.documentElement.dataset.embedded = "1"` when present; CSS hides the page `<h1>`/brand header under `[data-embedded]` (the frame bar is the title). (5) Journey measurement + screenshots.
  - Out of scope: replacing the iframes with in-page views (CAP-FB-20260828-VIEW-FRAME-COLLAPSE-01); the fourteen dead components (CAP-FB-20260830-DEAD-CODE-CUT-01 / DEAD-COMPONENTS-01); Settings IA (SETTINGS-MONOLITH-01).
- Review: pending
- Gates: the falsification gates apply
  - Unit: extend `deno test tests/vocabulary.test.ts` (or the check it wraps) — "retired surfaces chat/chat.html and memory/explorer.html do not exist and are not referenced". Falsification: re-add an empty `extension/chat/chat.html`, expect RED, remove, GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — "embedded views share one content left edge at 1440" and "…at 1024" (read the first content block's `left` in Artifacts, Directory and Settings; assert equal within 1 px), "embedded Artifacts view shows its name exactly once". Screenshots `hub-view-artifacts-1440.png`, `hub-view-directory-1440.png`, `hub-view-settings-1440.png` with a drawn guide line at the shared edge (or the harness log with the three numbers).
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green, plus `npm run check:vocabulary` (2457 / 138 at `fc2255be`; re-count).
  - Constraints: one token source (`theme.css`); a11y — exactly one `<h1>` per document (hidden visually is fine only if the frame bar carries the accessible name); the impeccable design pass (consistency over expression).
- Blockers: —
- Next: delete the two surfaces (DEAD-SURFACES-01's own next action) and add them to RETIRED_FILES, then the token pair.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-ONE-SHELL-01`
- History:
  - 2026-08-30 11:00 UTC — measured: Artifacts 224 px gutter, Directory 272 px, memory explorer 294 px; the embedded Artifacts view shows a "← Back | Artifacts" bar plus an "Artifacts" H1 twenty pixels below it; Settings shows a second brand header under the frame bar.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); `#view-title` (`ntp.html:926`), the absence of a content-width token in `theme.css`, and the RETIRED_FILES mechanism in `check-vocabulary.mjs` re-verified.
  - 2026-09-01 20:33 UTC — tracker correction: the recorded IN_REVIEW candidate `3627b693` on `cap-recent-activity-user` is a recent-activity-lane commit; no ref anywhere contains this entry's implementation (verified by content search across all heads and origin refs). Reset to OPEN; the metadata was a copy-paste error, no work was lost.

## [CAP-FB-20260830-HUB-CHROME-POLISH-01] Hub chrome: Settings styled as the primary button, agent id as title, a zero-width directory card, developer icons in the header
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane, findings 9, 11, 15 and 19. On every screen the sidebar's Settings button is the only filled teal button (it reads as "selected"), an agent opened by URL is titled by its slug, a directory card can collapse to one character per line, and the hub header carries an amber "ready" dot plus shield and terminal popovers.
- Updated: 2026-09-01 20:33 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: —
- Candidate: —
- Shipping: —
- Acceptance: On the idle hub no footer button is filled and the open view's footer entry carries `aria-current="page"`; `#agent=named:writer` reloads to the title "Writer"; `<tool-directory-card>` never renders at zero width and the gallery smoke fails on any zero-width specimen; the header has no status text, no dot and at most one icon button when idle, with a status pill only while not ready.
  - Context: (1) `extension/ntp/ntp.html:844` `<button class="btn foot-btn" id="open-settings">` while Directory/Artifacts use `class="btn ghost foot-btn"` (838-841); `.btn` is the filled primary style and `.foot-btn` (491) only lays out; `docs/DESIGN.md:23-24` — accent "for primary actions, current selection, and state indicators only". (2) `extension/ntp/ntp.js:1926` `threadTitle.textContent = name || id || "Agent"` inside the agent-view opener; `applyCurrentHashRoute` (3366) reaches it with `name` undefined on a hash entry, so the header reads "writer" while the sidebar row (which passes the name) reads "Writer"; the background-agent path has the same shape at 1862. (3) `ToolDirectoryCard` (`components.js:1955-2032`) styles `:host { display:block; min-inline-size:0; container-type:inline-size; }` (1976) — a block child of a column flex parent with `container-type: inline-size` and no explicit inline size resolves to 0 px wide; measured in the gallery: 0 px wide, 3,599 px tall; unverified in the product (no enrolled site on a fresh profile) but the same CSS ships to `directory/directory.html`. (4) `ntp.html:864-867`: `<span class="status" id="status" role="status">` ("ready" with an amber dot — amber is the DESIGN "attention" colour), `<security-shield>` and `<error-console>` (defined at `components.js:7002` / `6942`; their popovers are `div.panel` with `aria-label` but no `role`); the console is a developer affordance on the home screen. What must NOT change: the keyboard reachability of Settings; the shield's role in surfacing security events (it moves, it is not deleted); the `status` element's `role="status"` semantics for the running/needs-approval states.
  - Reproduce today: (1) build; `launchChrome()`; hub; screenshot → Settings solid teal; (2) navigate to `#agent=named:writer` (after creating a named agent "Writer") and reload → header "writer"; (3) open `docs/components.html` (gallery smoke serves it) and measure the `tool-directory-card` specimen → width 0; (4) idle hub header → amber dot + "ready" + two icon buttons.
  - Files: `extension/ntp/ntp.html` (844: `btn ghost foot-btn`; 864-867: header), `extension/ntp/ntp.js` (`openView`: set/clear `aria-current="page"` + a `.current` class on the three footer buttons; `applyCurrentHashRoute` 3366 → resolve `named-agent.get` before the title at 1926; the status pill logic where `#status` is set — grep `status.textContent`), `extension/shared/components.js` (1976: add `inline-size: 100%` — or `align-self: stretch` — beside `container-type`; `security-shield`/`error-console` popovers gain `role="dialog"` + `aria-modal="false"` or move), `extension/options/options.html` (a home for the shield in Security → Permissions and the console under Advanced → Diagnostics, if the owner chooses "move" over "shortcut"), `scripts/component-gallery-smoke.ts` (assert every specimen width > 200 px), `scripts/chrome-journeys.ts`. Do NOT restyle `.btn` globally.
  - Steps: (1) Footer: class change + `aria-current` in `openView` (and clear on Back); `.foot-btn[aria-current="page"] { background: var(--panel-2) }`. (2) Title: in `applyCurrentHashRoute`, for `#agent=named:<id>` call `send("named-agent.get", {id})` and pass `name` through; never render a slug — fall back to "Agent" while loading. (3) Directory card: the one-line CSS fix + the gallery smoke assertion (RED on today's gallery). (4) Header: replace the permanent "ready" status with a pill that renders only for `connect-model` ("Connect a model"), `working` ("Working…"), `needs-approval` ("Needs approval") and is removed when idle; move the console trigger into Settings → Advanced → Diagnostics (keep `installPageDiagnostics` capture); keep the shield ONLY when `count > 0` (attention state) and otherwise hidden — this keeps the security signal without a permanent icon. (5) Journey checks + screenshots.
  - Out of scope: the first-run card and composer-first order (HUB-FIRST-RUN-01); the 22 template rows (FRESH-PROFILE-TEMPLATE-AGENTS-01); the running-state banner inside the conversation (THREAD-VIEW-RUN-STATE-01 — the header pill and that banner must agree on the state source; coordinate via `conversation-run-status`'s `state` vocabulary at `components.js:5241`).
- Review: pending
- Gates: the falsification gates apply
  - Unit: extend `deno test tests/components.test.ts` — "tool-directory-card host declares inline-size 100% alongside container-type" (static style assertion). Falsification: remove the `inline-size` declaration, expect RED, restore, GREEN.
  - Browser: `deno run -A scripts/component-gallery-smoke.ts` — "every specimen renders wider than 200 px" (RED today for the directory card); `deno run -A scripts/chrome-journeys.ts` — "hub: idle header has no status text, no dot, at most one icon button", "hub: no footer button is filled when idle; the open view's button has aria-current=page", "hub: #agent=named:writer reload shows Writer". Screenshots `hub-idle-header.png`, `hub-footer-settings-current.png`, `agent-view-title-writer.png`, `gallery-directory-card-width.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green, plus `npm run check:gallery` (2457 / 138 at `fc2255be`; re-count).
  - Constraints: DESIGN.md accent rule and semantic colours (amber is attention, not idle); inline SVG icons only; a11y — `aria-current` on the footer, `role="dialog"` on any popover kept, the status pill keeps `role="status"`; textContent for the agent name; the impeccable design pass.
- Blockers: —
- Next: the four are independent; land (1) footer class + `aria-current` and (2) the title resolve first, each with its journey check.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-HUB-CHROME-POLISH-01`
- History:
  - 2026-08-30 11:00 UTC — measured: Settings is solid teal on every screen; the agent view header reads "writer" while the dialog reads "Edit Writer"; the directory card specimen measured 0 px wide and 3,599 px tall; the header carries an amber "ready" dot plus shield and terminal popovers with no dialog/menu role.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); `ntp.html:844/864-867`, `ntp.js:1926/3366`, `components.js:1976` re-verified.
  - 2026-09-01 20:33 UTC — tracker correction: the recorded IN_REVIEW candidate `3627b693` on `cap-recent-activity-user` is a recent-activity-lane commit; no ref anywhere contains this entry's implementation (verified by content search across all heads and origin refs). Reset to OPEN; the metadata was a copy-paste error, no work was lost.

## [CAP-FB-20260830-USER-VOICE-COPY-01] Copy: system language throughout the empty states, toggles and delete dialogs
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane findings 22, 13 and 20. Extends CAP-FB-20260828-NOUN-DISCIPLINE-01 (nouns done; this is the verb/voice half). The product says "Discovery has not run yet.", "Keep the key — Storage is available.", "catalog generation e0b8…", and three different delete dialogs mention a "registry entry", a "system prompt override" and a "recurring alarm".
- Updated: 2026-09-02 03:08 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: worker (reanalysis lane)
- Workspace: durable worktree `user-voice-copy`
- Branch: `cap/user-voice-copy`
- Base: `f54d8661`
- Candidate: this tracker commit
- Shipping: `origin/main@4536eb3c`
- Acceptance: Every empty state and toggle description on the hub, Settings (outside Advanced), Artifacts, Directory and the side panel is one second-person sentence saying what the user can do next; the three delete-agent dialogs share one helper and one body; the demo provider's reply is a real sentence and the sidebar preview never shows a bracketed model tag; `scripts/check-vocabulary.mjs` bans the system words for user-facing strings and passes (RED against today's tree first).
  - Context: `scripts/check-vocabulary.mjs` already scans `SURFACES` (lines 32-47: ntp, artifacts, artifact, options, directory, sidepanel, components.js, skills-panel.js) for `BANNED_TERMS` (49-60: only `assets?` and `recipes?` today) and runs in `test:all` (`package.json` `check:vocabulary`); `tests/vocabulary.test.ts` wraps it. Delete dialogs: `extension/ntp/ntp.js:781-786` (background agent: "…cancel its scheduled task and remove the recurring alarm."), `ntp.js:2888-2896` (named agent: "…permanently remove the agent registry entry, its memory store, system prompt override, and custom provider configuration…"), `extension/options/options.js:1473` ("…remove the agent and its custom configuration…"); all three already call the shared `confirmActionDialog` (`components.js:5827`). Strings on screen (ui lane): "Discovery has not run yet.", "No Site Agents yet. Find tools from an open tab to add one.", "Keep the key — Storage is available.", "Site Agent diagnostics — Technical details for tool discovery on enrolled sites…", "200 tools visible to diagnostics · catalog generation e0b81ee74631", "Internal testing provider active. Choose a listed provider to replace it." (Providers page), "Multiple agents — When off, the hub is a single agent…", and the demo reply "[demo model] Task received (19401 chars). Configure a real provider in Settings to get real completions. This demo response proves the agent loop runs end-to-end." (`extension/lib/models/demo-model.js`, the `Task received` template — grep it). What must NOT change: Settings → Advanced may keep technical words (scope the checker by section id); the demo provider's `@demo-*` marker behaviour (KEYLESS-FIRST-RESULT-01 owns markers).
  - Reproduce today: (1) `npm run check:vocabulary` passes; (2) `grep -rn "Discovery has not run\|Storage is available\|catalog generation\|registry entry\|recurring alarm\|Internal testing provider" extension --include=*.js --include=*.html | grep -v dist` → hits; (3) build, hub, send a demo task → the sidebar preview and the agent bubble begin with "[demo model] Task received".
  - Files: `scripts/check-vocabulary.mjs` (extend `BANNED_TERMS` with `discovery|diagnostics|catalog|generation|registry|attestation|alarm|runtime|lifecycle|chars|override|has not run` scoped to user-facing surfaces, with an `ADVANCED_SCOPE` exemption for markup inside `<section id="prompts">`/Advanced and for `components.js` strings only rendered by diagnostics elements — implement by allowing an inline `/* vocab:advanced */` marker on a line or by excluding `error-console`/`security-shield` class bodies), `extension/shared/components.js` (new `deleteAgentDialog({name, kind})` beside `confirmActionDialog` 5827 returning the same promise; `FirstRunGuide` copy; explorer/empty-state strings), `extension/ntp/ntp.js:781-786, 2880-2900` and `extension/options/options.js:1473` (call the helper), `extension/ntp/ntp.html` / `extension/options/options.html` / `extension/sidepanel/sidepanel.html` (the empty states and toggle descriptions), `extension/lib/models/demo-model.js` (the reply template → "I'm the built-in demo, so I can't do this yet. Connect a model in Settings and ask again."), the thread preview writer in `extension/lib/durable-runs.js` (`MAX_PREVIEW_CHARS` 45 area — strip a leading `[… model]` tag from previews), `docs/COPY.md` (new: the voice rule in five lines and the banned list). Do NOT rename nouns already fixed by NOUN-DISCIPLINE-01.
  - Steps: (1) Widen the checker with the word list and the Advanced exemption; run it — RED; commit the checker with a temporary allowlist file `scripts/vocabulary-baseline.json` listing today's offenders so `test:all` stays green while the list burns down (the same baseline pattern as `scripts/check-tasks-baseline.json`). (2) `deleteAgentDialog` helper: title `Delete ${name}?`, body "Its memory and history are removed. Artifacts it made are kept." (background agents: "Its schedule stops and its history is removed."), `confirmLabel: "Delete"`, `destructive: true`, `requireGenuineGesture: true`; replace the three call sites. (3) Copy pass on the listed strings (second person, one sentence, names the next action): e.g. "Discovery has not run yet." → "Open a site and I'll look for tools you can use."; "Keep the key — Storage is available." → delete (HUB-FIRST-RUN-01 removes the stepper); "Internal testing provider active…" → "No model connected yet — pick one to start."; "catalog generation <hash>" → moves under Advanced → Diagnostics. (4) Demo reply + preview tag strip. (5) Burn the baseline to empty and delete the baseline file; `docs/COPY.md`.
  - Out of scope: the About/changelog copy (SETTINGS-WHATS-NEW-COPY-01); the hub activity rows (RECENT-ACTIVITY-USER-EVENTS-01); provider page structure (CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01) — only its one sentence is changed here.
- Review: author review 2026-09-02 — falsification gates cleared (RED/GREEN recorded in History)
- Gates: unit 2992 passed / 7 failed at the tip (the 7 are `tests/security-suite-custody.test.ts`, lock-bound while other lanes run — rerun alone: `ok | 9 passed | 0 failed`); Chrome journeys 327/327 (was 323; +4 named checks); `npm run check:vocabulary` OK with the widened checker (20 violations RED against `f54d8661`, 0 after); `check:gallery` OK
  - Unit: `deno test tests/vocabulary.test.ts` — the widened checker with an empty baseline; extend `tests/components.test.ts` — "deleteAgentDialog produces one body for named agents and one for background agents, and requires a genuine gesture". Falsification: add "registry entry" to an `options.html` paragraph, expect RED on the vocabulary test, remove, GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — "hub: demo reply is a sentence without a bracketed model tag", "hub: sidebar preview has no bracketed model tag", "hub + Settings: the three delete dialogs show the shared body". Screenshots `hub-demo-reply-voice.png`, `dialog-delete-agent-shared.png`, `options-providers-no-model-copy.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green, plus `npm run check:vocabulary` (2457 / 138 at `fc2255be`; re-count).
  - Constraints: textContent for all copy; DESIGN.md/impeccable voice (second person, one action per empty state); no emoji; the design pass on every touched empty state.
- Blockers: —
- Next: none — archive to TASKS-DONE.md at triage
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-USER-VOICE-COPY-01`
- History:
  - 2026-08-30 11:00 UTC — measured strings: "Discovery has not run yet.", "Keep the key — Storage is available.", "Site Agent diagnostics — Technical details for tool discovery on enrolled sites", "200 tools visible to diagnostics · catalog generation e0b8…", three delete-dialog bodies naming "registry entry", "system prompt override" and "recurring alarm".
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); the checker's SURFACES/BANNED_TERMS shape (`check-vocabulary.mjs:32-60`) and the three dialog bodies (`ntp.js:781-786, 2888-2896`; `options.js:1473`) re-verified.
  - 2026-09-02 UTC — candidate on `cap/user-voice-copy` (base `f54d8661`). Re-inventoried by grep: "Keep the key — Storage is available." and "Internal testing provider active" were already gone (HUB-FIRST-RUN-01, PROVIDER-DEFAULT-AND-KEY-FLOW-01); the demo literal is developer-flag-only since KEYLESS-FIRST-RESULT-01. Landed: (1) `scripts/check-vocabulary.mjs` rule `system-words` (discovery|diagnostics|catalog|generation|registry|attestation|alarm(s)|runtime|lifecycle|chars|override(s)|"has not run") with the Advanced exemption declared in the source (`data-developer="true"` / `data-vocab="advanced"` subtrees; `vocab:advanced` JS line or `vocab:advanced:start/end` region — only that rule honours it, "asset"/"recipe" stay banned inside Advanced) + `body:`/`title:` dialog keys added as visible sinks; RED against today's tree = 20 violations (ntp.js 514/519/534/1784/1785; options.html 150-175/242/367; options.js 2078; components.js 9580/10803/10850/11666/11790/11864/11883), GREEN = "vocabulary OK: 14 surfaces" after the copy pass — no baseline file was needed because the burn-down landed in the same commit. (2) `deleteAgentDialog({name, kind})` + `DELETE_AGENT_COPY` beside `confirmActionDialog` in components.js; the four call sites (ntp.js background row + thread-view Delete, options.js `.delete-named-agent`, sidepanel.js `#agent-delete`) call it; bodies: named "Its memory and history are removed. Artifacts it made are kept.", background "Its schedule stops and its history is removed.", site "It stops working on this site and its page tools are removed. Artifacts it made are kept."; title `Delete <name>?`, confirm "Delete", destructive, genuine gesture. (3) Copy: "Discovery has not run yet." → "Open a site and I'll look for tools you can use."; "WebMCP discovery: <origin>" → "Tools on <origin>"; "Cancel orphaned alarms" → "Stop schedules for deleted agents"; Multiple agents → "Let the hub hand parts of a task to your Site Agents."; Site Agent diagnostics block marked `data-vocab="advanced"` with its two descriptions rewritten; "core runtime permissions" → "the permissions the extension needs to run"; factory reset "alarms" → "schedules"; "Core runtime permission — the hub cannot boot without it." → "The hub cannot start without it."; "more chars" → "more characters"; Tool library "N tools visible to diagnostics · catalog generation" → "N tools available · tool list version"; `<system-prompt-editor>` and `<tool-library>` (Advanced/developer-only components) are `vocab:advanced` regions. (4) Demo reply → "[demo model] I'm the built-in demo, so I can't do this yet. Connect a model in Settings and ask again." — the `[demo model]` marker is kept deliberately: 9 harness files key on it to tell the test seam from a real provider (chrome-journeys 3474/3558, run-status-lifecycle, kat-scheduled-run-output, webmcp-acceptance…), and `threads.js previewOf` now strips a leading `[… model]` tag so the sidebar never shows it (a person's own "[urgent] …" prefix is kept). (5) `docs/COPY.md` (the five-line voice rule, the banned list, the before/after table). Unit gates written FIRST: RED = `FAILED | 54 passed | 8 failed` (vocabulary ×3, deleteAgentDialog, threads preview, agent-abort ×2 "the non-marker run is a normal sentence", task-lifecycle §7 "Stop schedules for deleted agents"), plus `agent-deletion-owner` RED on the old `confirmActionDialog` pin before it was repointed to `deleteAgentDialog(`; GREEN = all of the above ok, full unit 2992 passed. The `deleteAgentDialog` test lives in `tests/dialog-confirm-modernization.test.ts` (the fake-DOM harness for the shared dialog is there), not components.test.ts. Browser: 4 new journey checks — "hub + Settings: the delete-agent dialogs share one body in the reader's words" (hub `#delete-agent` and Settings `.delete-named-agent` both read body "Its memory and history are removed. Artifacts it made are kept.", accept "Delete", via genuine CDP clicks, cancelled), "Settings: the Providers page never speaks the system's words", "hub: demo reply is a sentence without a bracketed model tag", "hub: sidebar preview has no bracketed model tag" (5 stored assistant turns start with the marker; every index + DOM preview is tag-free) — 327/327; screenshots `dialog-delete-agent-shared.png`, `options-providers-no-model-copy.png`, `hub-demo-reply-voice.png` (retained run). `scripts/sidebar-parity.ts` and the journey's fresh-hub empty-copy list repointed to the new sentence. Out of scope, untouched: factory-reset dialog body ("Are you sure you want to delete everything?"), the About copy, activity rows.
  - 2026-09-02 03:08 UTC — DONE: merged forward by the coordinator and pushed as `origin/main@4536eb3c`. Coordinator gates on the merged tip: build clean, check:gallery + check:vocabulary clean, journeys 331/331, unit 3011/0 excluding the lock-bound custody file.

## [CAP-FB-20260830-ICONOGRAPHY-GAPS-01] Skills without icons, menus without icons, 38 uppercase kickers in the gallery
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane, finding 23. Some skill rows show an empty 28 px icon slot so the list misaligns, the composer's + menu is text-only where the rest of the product uses stroke icons, and the component gallery — the reference surface — uses uppercase tracked headings that DESIGN.md bans.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: No skill row renders an empty icon slot (every declared icon name resolves, with a generic fallback glyph); the + menu items carry the same 18 px stroke icons as the matching slash-palette entries; the gallery's specimen headings are sentence-case with the tag in `<code>` and the gallery smoke asserts zero uppercase headings.
  - Context: skills are defined in `extension/lib/recipes.js` (54 entries, every one declares `icon: "<name>"`); `extension/skills/skills-panel.js:28` renders `row.setAttribute("icon", SKILL_ICON[r.icon] ?? "")` from `extension/shared/skill-icons.js` (`SKILL_ICON`, line 7: 29 keys — accessible, ask, books, broom, calendar, camera, clock, cookie, doc, download, eye, folder, form, gauge, glasses, layers, link, mood, network, pen, pin, quote, scan, search, sleep, table, tags, target, translate). Verified gap: recipes reference `shield` (2), `check` (2), `user`, `send`, `globe` — five names with no key, so seven rows get `icon=""` and an empty slot. The + menu is `AttachButton` (`components.js:1551-1717`; items "Add file" 1588, "Choose agent" 1594, etc. are text-only `role="menuitem"` buttons) while the slash palette items in `extension/shared/composer-commands.js` carry icons. The gallery `docs/components.html` uses `<h3 class="spec">` for every specimen and `docs/showcase.css:20` sets `h3.spec { text-transform: uppercase; letter-spacing: .05em }` — 38 headings; `docs/DESIGN.md:248` bans "uppercase tracked kickers". What must NOT change: the `SKILL_ICON` inline-SVG `currentColor` convention (no emoji, no image files); `check:gallery` byte-identity of the synced JS.
  - Reproduce today: (1) `grep -oE 'icon: "[a-z-]+"' extension/lib/recipes.js | sort | uniq -c` vs the keys of `SKILL_ICON` → shield/check/user/send/globe missing; (2) build, open Settings → Skills → seven rows with an empty slot; (3) hub composer + menu → text-only items; (4) `grep -c 'class="spec"' docs/components.html` → 38, and `docs/showcase.css:20` uppercases them.
  - Files: `extension/shared/skill-icons.js` (add `shield`, `check`, `user`, `send`, `globe`, and `SKILL_ICON_FALLBACK` — a plain "skill" glyph), `extension/skills/skills-panel.js:28` (`SKILL_ICON[r.icon] ?? SKILL_ICON_FALLBACK`), `extension/shared/components.js` (`AttachButton` items 1586-1600: prepend the matching `ICONS.*` SVG, reuse the ones the palette uses), `extension/shared/composer-commands.js` (export the icon map so both share one source), `docs/showcase.css:20` (sentence case: remove `text-transform`/`letter-spacing`, keep size/colour), `docs/components.html` (headings already have the tag in `<code class="tag">` — only the caption text needs sentence case), `scripts/component-gallery-smoke.ts` (assert no heading has computed `text-transform: uppercase`), `tests/components.test.ts` (icon-key coverage test). Do NOT add image assets.
  - Steps: (1) Unit test "every recipe icon name is a SKILL_ICON key" (RED: five missing); add the five icons + fallback; GREEN. (2) + menu icons from the shared map. (3) Gallery CSS + smoke assertion (RED first: 38 uppercase headings). (4) Screenshots.
  - Out of scope: the skills list layout/IA in Settings (SETTINGS-MONOLITH-01); the dead gallery specimens (DEAD-CODE-CUT-01 / DEAD-COMPONENTS-01).
- Review: pending
- Gates: the falsification gates apply
  - Unit: extend `deno test tests/components.test.ts` — "every icon name declared in recipes.js resolves in SKILL_ICON" and "attach-button menu items each contain an inline svg". Falsification: remove the `shield` key again, expect RED on the first, restore, GREEN.
  - Browser: `deno run -A scripts/component-gallery-smoke.ts` — "gallery: zero uppercase headings" (RED today); `deno run -A scripts/chrome-journeys.ts` — "Settings: no skill row has an empty icon slot" (assert every `capability-row[icon]` in the skills list has a non-empty `icon` attribute). Screenshots `options-skills-icons.png`, `composer-plus-menu-icons.png`, `gallery-headings-sentence-case.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green, plus `npm run check:gallery` (2457 / 138 at `fc2255be`; re-count).
  - Constraints: inline SVG with `currentColor`, no emoji; DESIGN.md anti-slop bans (no kickers); a11y — menu items keep their text labels (icons `aria-hidden="true"`); the impeccable design pass.
- Blockers: —
- Next: the icon-coverage unit test (RED), then the five icons + fallback.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-ICONOGRAPHY-GAPS-01`
- History:
  - 2026-08-30 11:00 UTC — measured: 2 of 7 visible skills have an icon; seven text-only `+` menu items; 38 uppercase tracked kickers in the gallery that `docs/DESIGN.md` bans.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive); root cause pinned: five icon names used by recipes (`shield`, `check`, `user`, `send`, `globe`) are absent from `SKILL_ICON`, and `skills-panel.js:28` falls back to an empty string; the kicker style is `docs/showcase.css:20`.

## [CAP-FB-20260830-ON-DEVICE-PATH-01] Chrome's built-in model (Prompt API) handles text-only steps on-device, with a hosted model for planning and tools
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane, finding 16. With no key, "summarise this page" cannot be answered at all, even on a Chrome that ships Gemini Nano; the Prompt API adapter cannot call tools and silently falls back to the demo provider.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cf0da958`
- Candidate: —
- Shipping: —
- Acceptance: on a Prompt-API-capable Chrome with no provider key, "summarise this page" and "group my tabs by topic" complete: the deterministic tool steps (read_page, list_tabs, group_tabs) run through the keyless path from CAP-FB-20260830-KEYLESS-FIRST-RESULT-01 and the text steps (summarise, name the groups) run on-device; each assistant bubble is labelled with the model that produced it ("On-device (Gemini Nano)" or the hosted model id such as `gemini-3.7-flash`); when the Prompt API is unavailable the transcript says so in one sentence instead of falling to the demo string. Done = a headed run on a named Chrome version shows both prompts working keyless, screenshots attached; the unit tests pin the routing.
  - Context: `extension/lib/models/prompt-api-model.js:52-64` flattens `tool-call` and `tool-result` content parts into text and always returns `finishReason:"stop"` (`:162`, `:200`), so the AI SDK loop can never receive a tool call from it. `extension/lib/provider.js:196-212` chooses the Prompt API when available and otherwise returns `createDemoModel()` labelled "demo (prompt api unavailable)". `isLocalProvider` (`extension/lib/provider-gate.js:42`) already exempts both from the host-permission gate. Existing tests: `tests/prompt-api.test.ts` (`createPromptApiModel` options, readiness error, `isPromptApiAvailable`, the fresh-session attestation boundary at `:81`) and `tests/prompt-api-tokens.test.ts`. What must NOT change: the attestation boundary (a fresh session per call bound to the exact system message); the secret-free provider config; the provider gate's local-provider exemption.
  - Reproduce today: (1) on a Chrome with `LanguageModel` available (chrome://flags "Prompt API for Gemini Nano" enabled; record the version), load the extension on a fresh profile; (2) Settings → Providers → choose "Chrome built-in" (the Prompt API preset in `PROVIDER_CHOICES`, `extension/lib/provider.js:45-98`); (3) hub: "summarise this page" — the run either answers without reading the page (no tool call is possible) or, if the model is not ready, the reply is the demo string "[demo model] Task received…".
  - Files: `extension/lib/models/prompt-api-model.js` (keep the text adapter; add `supportsTools:false` metadata); `extension/lib/provider.js` (`:196-212` — return a routed pair `{ planner, textModel }` when a hosted provider is configured alongside the Prompt API, otherwise the keyless deterministic assistant plus the on-device text model); `extension/lib/agent.js` (the step loop — after a tool result, if the next step is text-only and an on-device model exists, call it; the hook point is where the model is invoked per step); `extension/shared/components.js` (`message-bubble` — a `model` attribute rendered as a small label); `extension/lib/error-report.js` (a `MODEL_UNAVAILABLE` category with the sentence "Chrome's built-in model is not available on this device — connect a model in Settings"). Do NOT touch `extension/lib/provider-gate.js` or the demo model.
  - Steps: (1) Land after CAP-FB-20260830-KEYLESS-FIRST-RESULT-01 defines the deterministic intent set; add a `textModel` slot to the resolved provider (`provider.js:196`) populated by `createPromptApiModel` when `isPromptApiAvailable()` is true. (2) In the loop, route a step to `textModel` only when the step has no tool definitions in scope (the deterministic assistant has already executed the tools) and the prompt is under the Prompt API context budget (`tests/prompt-api-tokens.test.ts` shows the token accounting). (3) Stamp every persisted assistant message with `modelId` (the thread store already carries provider ids for attestation — reuse that field) and render it on the bubble. (4) Replace the "demo (prompt api unavailable)" fallback with the `MODEL_UNAVAILABLE` error when the owner explicitly chose the built-in model. (5) Record the Chrome version and the headed evidence in History; update `docs/OPEN-QUESTIONS.md` Q12 (recommended default remains `gemini-3.7-flash` hosted; on-device is the keyless complement).
  - Out of scope: the deterministic keyless assistant itself (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01); the provider picker flow (CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01); a tools-capable on-device adapter (not available in the Prompt API today — do not emulate tool calls by parsing text).
- Review: pending
- Gates: the falsification gates apply.
  - Unit: extend `tests/prompt-api.test.ts` with "the resolved provider exposes an on-device text model when the Prompt API is available and a hosted key is absent" and "a text-only step after tool results is routed to the on-device model; a step with tools in scope is not". Falsification: revert step 2, expect RED on "text-only step is routed on-device", restore, expect GREEN.
  - Browser: a headed run (not headless — Gemini Nano is not available under `--headless=new` in the reference environment) on a Prompt-API-capable Chrome: the two prompts above, screenshots `on-device-summarise.png` and `on-device-group-tabs.png` showing the model label on each bubble; plus `deno run -A scripts/chrome-journeys.ts` unchanged and green (the journey suite runs keyless through the deterministic path).
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138).
  - Constraints: page text handed to the on-device model is untrusted data — it goes inside the same fenced envelope CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01 defines; no keys in logs; the model label is `textContent`; no fixed debug port.
- Blockers: Depends on CAP-FB-20260830-KEYLESS-FIRST-RESULT-01 (must land first).
- Next: after the keyless path lands, add the `textModel` slot in `extension/lib/provider.js:196-212` and the routing test.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-ON-DEVICE-PATH-01`
- History:
  - 2026-08-30 11:00 UTC — opened by the reanalysis consolidation (product lane finding 16); baseline `origin/main@fc2255be`. Built-in local models were removed at 0.2.307; Q12 remains open.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Model ids named in this entry follow the current list (`gemini-3.7-flash`, `gpt-5.6-sol`, `claude-sonnet-5`); on-device is Gemini Nano via the Prompt API.

## [CAP-FB-20260830-AGENT-SHARING-01] Share an agent as a card file and import it on another profile
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane, finding 20. Related: CAP-FB-20260825-DATA-EXPORT-IMPORT-01. An owner who built a useful agent has no way to hand it to a colleague; the card library exists in code but nothing in the UI calls it.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cf0da958`
- Candidate: —
- Shipping: —
- Acceptance: the agent view header and the edit dialog offer "Share agent", which downloads `<slug>.agent.json` built by the existing `exportAgentCardJson` (name, role, skills, avatar, schedule; never memory, keys, provider config or context-file bodies beyond the bounded core assets); the create dialog offers "Import agent" which accepts that file through `importAgentCard`, shows the validated name/role/skills for confirmation, and creates the agent. Done = export on profile A, import on profile B, run the same task on both and get equivalent tool calls; the journey suite drives export → import on one profile and asserts the imported agent's record equals the exported card's fields.
  - Context: `extension/lib/agent-cards.js` is complete and tested (`exportAgentCard` `:254`, `exportAgentCardJson` `:334`, `validateAgentCard` `:344`, `importAgentCard` `:567`, bounds `:22-34` including `MAX_CARD_JSON_BYTES` 2 MiB and `MAX_CARD_CORE_ASSETS` 8; `tests/agent-cards.test.ts` covers round-trip fidelity and hostile-input rejection) but has zero references from any extension page or route (verified by grep over `extension/` excluding `dist/`). Named agents are created through `createNamedAgent` (`extension/lib/named-agents.js:217`) and the create/edit dialog is `openAgentDialog` in `extension/ntp/ntp.js` (the template select is at `:2307-2319`). `docs/AGENT-PRODUCT-GAPS.md` G7 records "not shareable". Owner directive 2026-08-30: `agent-cards.js` is NOT dead code and must not be listed for deletion in CAP-FB-20260830-DEAD-CODE-CUT-01. What must NOT change: `importAgentCard`'s validation (no code, no memory, no keys, plain-data graph only, `assertPlainDataGraph` `:96`); the artifact viewer's download restrictions.
  - Reproduce today: (1) `npm run build`, load the extension; (2) create an agent from the hub +; (3) open it from the sidebar; the header offers Edit and Delete only; the edit dialog footer offers Delete agent · Regenerate avatar · Cancel · Save; there is no share or import anywhere; (4) `git grep -n "agent-cards" -- extension` returns only the module and its test.
  - Files: `extension/ntp/ntp.js` (agent view header near `:1926` where `threadTitle` is set; `openAgentDialog` for the Import control; the delete confirm at `:2880-2900` shows the dialog helper pattern); `extension/shared/components.js` (`agent-dialog` — an "Import agent" secondary action beside the template select; reuse `confirmActionDialog` for the confirmation step); `extension/background/service-worker.js` (two routes: `agent-card.export {id}` returning the JSON string via `exportAgentCardJson(await getNamedAgent(id), { schedule })`, and `agent-card.import {card}` calling `importAgentCard` then `createNamedAgent`); `extension/lib/agent-cards.js` (no changes expected). Do NOT touch `extension/lib/named-agents.js` validation or the memory stores.
  - Steps: (1) Add the two SW routes; the import route runs `validateAgentCard` and returns the normalized fields plus `dropped` reports for the owner to see before creation (two-phase: `agent-card.validate` then `agent-card.import`). (2) "Share agent" button in the agent view header (an inline SVG share icon, `currentColor`) → fetches `agent-card.export` → creates a Blob and an `<a download>` click from the user gesture. (3) "Import agent" in the create dialog → `<input type="file" accept=".json,application/json">` → read as text (bounded to `MAX_CARD_JSON_BYTES`) → `agent-card.validate` → confirmation panel listing name, role (clamped to 3 lines), skills chips, schedule → Create. (4) Add "Share" to the composer `/agent` palette entry only if CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01 has not removed peer actions; otherwise header only. (5) Update `docs/AGENT-PRODUCT-GAPS.md` G7, CHANGELOG, and the vocabulary check for the new strings.
  - Out of scope: whole-profile export/import (CAP-FB-20260825-DATA-EXPORT-IMPORT-01); sharing memory (never); `chrome-extension://…/import#…` links — do not add a URL-triggered import (it would let any page pre-fill an agent creation); the gallery of templates (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01).
- Review: pending
- Gates: the falsification gates apply.
  - Unit: add `tests/agent-card-routes.test.ts` with the route doubles pattern from `tests/named-agent-provider-route.test.ts` — "export never includes provider apiKey or memory" (create an agent with a provider override, export, assert no `apiKey`/`memory` keys) and "import of a card with a `script` field is rejected" (already exercised by `tests/agent-cards.test.ts`; assert the route surfaces the rejection). Falsification: revert the redaction in step 1 by passing the raw agent record, expect RED on "export never includes provider apiKey", restore, expect GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — add "agent card: export then import creates an equivalent agent" (export via the route, import via the dialog's file input using CDP `DOM.setFileInputFiles`, assert `named-agent.get` fields equal). Screenshot `agent-import-confirm.png` showing the confirmation panel with name, role and skills.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138).
  - Constraints: the imported card is untrusted — every field rendered with `textContent`; no innerHTML; no eval; the file input and both buttons have accessible names; no keys or memory in the export; no fixed debug port.
- Blockers: —
- Next: add the `agent-card.export` / `agent-card.validate` / `agent-card.import` routes in the service worker.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-AGENT-SHARING-01`
- History:
  - 2026-08-30 11:00 UTC — opened by the reanalysis consolidation (product lane finding 20); baseline `origin/main@fc2255be`. `docs/AGENT-PRODUCT-GAPS.md` G7 "not shareable"; nothing in the UI exports a card.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). `extension/lib/agent-cards.js` is adopted here, not deleted.

## [CAP-FB-20260830-SITE-PLAYBOOKS-01] A skill can be bound to an origin so the agent uses site-specific instructions only on that site
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane, finding 21. Skills are global: a "GitHub triage" playbook is offered everywhere and a site agent carries tools but no instructions about how to use them.
- Updated: 2026-08-30 14:30 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `cf0da958`
- Candidate: —
- Shipping: —
- Acceptance: a skill record may declare `origins: ["https://github.com/*"]` (match patterns, bounded to 8); the side-panel companion and the `/skill:` palette offer origin-bound skills only when the current tab matches; the skills layer of the system prompt includes a matching origin-bound skill automatically when the run's active tab matches; an enrolled site agent gains a bounded `notes` field ("On this site, always …", 2,000 chars) edited from the Directory/Agents card and appended to the same layer. Done = a "Fixture triage" playbook bound to the fixture origin is offered in the companion on the fixture tab, absent on example.com, and its instruction text appears in the composed system prompt for a run on the fixture tab (asserted through the run-log prompt attestation) — driven in the journey suite.
  - Context: skills are recipes: `RECIPES` in `extension/lib/recipes.js:77`, each with `requiredCapabilities` (`:10`, e.g. `:86`) and a category, aliased as skills at `:804-811`; `agentSkillIds` `:769` and `mergeRunSkills` `:784` decide which skills a run carries; the system prompt appends them in `appendSkillsLayer` (`extension/lib/system-prompts.js:806`, called from `resolveSystemPrompt` `:836`). A separate, already per-origin store exists: `extension/lib/skills.js` (`setSkills(origin, skills)` `:11`, `getSkills(origin)` `:16`, `buildSkillsPrompt` `:23`, `allSkills` `:31`) — this is the natural home for site notes. Imported skills go through `installImportedSkill` (`extension/lib/skill-import.js:175`). Site agents are read through `agent.get {origin}` (`extension/background/service-worker.js:5283`) and `agent.list` (`:4561`). The rename tension between recipes and skills is CAP-FB-20260821-RECIPES-SKILLS-RENAME-01 (open). What must NOT change: origin-keyed isolation — a note for origin A is never included in a run whose active tab is origin B; the skills layer stays a boundary layer (owner text cannot escape it).
  - Reproduce today: (1) `npm run build`, load the extension; (2) open the fixture from `fixtures/webmcp-server.ts` in a tab; (3) hub composer: type `/skill:` — every skill is listed regardless of the tab; (4) Settings → Agents → the enrolled site card has no instructions field; `git grep -n "origins" -- extension/lib/recipes.js` returns nothing.
  - Files: `extension/lib/recipes.js` (skill record: optional `origins` array validated as match patterns; `recipesForOrigin(url)` helper); `extension/lib/skills.js` (`setSkills`/`getSkills` already keyed by origin — add `notes`); `extension/lib/system-prompts.js` (`appendSkillsLayer` `:806` receives matching origin skills and the site note); `extension/background/service-worker.js` (`runTask` `:2217` resolves the active tab origin it already has for `read_page` and passes matches into `resolveSystemPrompt`); `extension/sidepanel/sidepanel.js` (list matching skills — after CAP-FB-20260830-SIDE-PANEL-COMPANION-01); `extension/shared/composer-commands.js` (filter `/skill:` entries by the active tab); `extension/directory/directory.js` and the Settings Agents card (`renderWebmcpStatus` in `options.js`) for the notes editor; `tests/recipes.test.ts` (the "every recipe has a prompt + a category" test at `:64` is the template for a new origins validation test). Do NOT touch `extension/lib/webmcp-authority.js` or the per-tool approval path.
  - Steps: (1) Schema: add optional `origins` to recipes with validation (`tests/recipes.test.ts`), and `notes` to the per-origin skills store (`skills.js`), bounded and stored under the origin key. (2) Matching helper `skillsForOrigin(origin)` returning built-in origin-bound skills plus the origin's notes; unit-tested with a non-matching origin returning nothing. (3) Prompt: `resolveSystemPrompt` gains `siteContext: { origin, skills, notes }` and `appendSkillsLayer` renders the note under a heading "On <host>" inside the skills boundary. (4) Composer `/skill:` filtering by the active tab (the hub already asks `agent.discoverable-tabs` at `ntp.js:590` — use the active tab's origin from it). (5) Companion listing (blocked on SIDE-PANEL-COMPANION-01). (6) Notes editor: a `<textarea>` with a `<label for>` on the site agent card, saved through a new `site-skills.set {origin, notes}` route that requires the Settings sender (`requireSettingsSender` as in `routes/provider.js:73`). (7) Ship one built-in origin-bound example bound to the fixture origin for the journey; docs: `docs/AGENT-PRODUCT-GAPS.md` G4, CHANGELOG.
  - Out of scope: the companion itself (CAP-FB-20260830-SIDE-PANEL-COMPANION-01); page-action tools (CAP-FB-20260830-PAGE-ACTION-TOOLS-01); renaming recipes to skills (CAP-FB-20260821-RECIPES-SKILLS-RENAME-01); importing playbooks from GitHub (existing `skill-import.js`, unchanged).
- Review: pending
- Gates: the falsification gates apply.
  - Unit: extend `tests/recipes.test.ts` with "origins on a skill are valid match patterns and bounded to 8" and add `tests/site-playbooks.test.ts` with "skillsForOrigin returns the bound skill and the note for a matching origin and nothing for another origin" and "the composed system prompt for origin A never contains origin B's note". Falsification: revert step 2's origin filter (return all bound skills), expect RED on "nothing for another origin", restore, expect GREEN.
  - Browser: `deno run -A scripts/chrome-journeys.ts` — add "site playbook: /skill: lists the fixture-bound skill on the fixture tab and not on example.com" and "site playbook: the run-log attestation for a fixture-tab run contains the note text". Screenshot `site-playbook-palette.png`.
  - Full suite: `npm run build && deno test tests/ && deno run -A scripts/chrome-journeys.ts` green at the tip (baseline at `fc2255be`: unit 2457 pass / 0 fail; Chrome journeys 138/138).
  - Constraints: notes are owner text inside the skills boundary layer, never above it; origin-keyed storage; `textContent` rendering; the notes textarea has a real `<label for>` (the unlabeled-control audit in `scripts/a11y-audit.ts` must stay green); no fixed debug port.
- Blockers: Depends on CAP-FB-20260830-SIDE-PANEL-COMPANION-01 (must land first — the companion is where matching skills are offered; steps 1-4, 6 and 7 can land ahead of it).
- Next: add the `origins` field with validation in `extension/lib/recipes.js` and the `notes` field in `extension/lib/skills.js`.
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-SITE-PLAYBOOKS-01`
- History:
  - 2026-08-30 11:00 UTC — opened by the reanalysis consolidation (product lane finding 21); baseline `origin/main@fc2255be`. `docs/AGENT-PRODUCT-GAPS.md` G4.
  - 2026-08-30 14:30 UTC — rewritten in the detailed hand-off format (owner directive). Verified `extension/lib/skills.js` already keys skills by origin — reuse it rather than adding a store.

## [CAP-FB-20260831-TOOL-PIPELINES-01] No way to chain/pipe tool steps into a small script (co-do-style)
- Feedback: 2026-08-31 — owner: "I want the tools to create better scripts to chain a couple of steps together so we can pipe things... my co-do projects used to do this, we need it here too." Today each tool call is standalone; there is no way to compose a few steps (e.g. list files -> grep -> summarize) into one reusable, inspectable pipeline the way co-do did.
- Updated: 2026-09-01 18:15 UTC
- Status: OPEN
- Resume: slice 2 — wire `run_pipeline` as a lazy-protocol meta-tool + plan-strip per-step visibility (see the DESIGN-DECISION + slice-2 plan in History)
- Priority: P2
- Owner: coordinator session — slice 1 landed; slice 2 unclaimed (pick up from Resume)
- Workspace: active (local path private)
- Branch: `cap/tool-pipelines` (slice 1 merged; reuse for slice 2)
- Base: `origin/main@331989d5`
- Candidate: `ad6dd2a8` (slice 1)
- Shipping: `origin/main@c0021d99` (slice 1 — the pure core + design; NOT yet model-callable)
- Acceptance: a bounded, safe way to chain a few tool steps into one pipeline where a step's output feeds the next (a "pipe"), inspectable and reusable, without eval/new Function (MV3 CSP). Design and land a first slice: a `run_pipeline`-style tool (or a saved-skill "recipe" of ordered steps with a declared data flow) that runs N existing tools in sequence, passing each result to the next by an explicit binding, surfaces each step in the transcript/plan-strip, fails closed with the same gates as its constituent tools, and can be saved and re-run. This is a DESIGN task first: write the model (declarative step list with input bindings vs a constrained expression pipe), then implement the minimal version. Reuse the existing sandbox (`extension/sandbox/`, no eval), the lazy protocol, and the plan strip (PLAN-STRIP-CHECKPOINTS-01) for visibility. Reference the co-do pipeline model the owner used.
  - Context: `run_script` exists (sandboxed JS, owner-approved) but is not a legible pipeline of tools; skills/recipes (`extension/lib/recipes.js` / skills) are prompt templates, not data-flow pipelines. The gap is composing TOOLS with piped IO.
  - Files (design will refine): a new pipeline module + tool def in `extension/lib/`, the sandbox for any expression evaluation (no eval), the lazy protocol for step dispatch, the plan strip + transcript for visibility, a save path in skills/recipes.
  - Steps: 1. Write the design (data-flow model, safety, what "pipe" means concretely, how it differs from run_script and skills) in the entry + docs/DESIGN.md. 2. Implement a minimal ordered-steps-with-bindings pipeline over existing tools. 3. Visibility via the plan strip. 4. Save + re-run.
  - Out of scope: a full scripting language; anything using eval/new Function.
- DESIGN DECISION (2026-09-01, slice 1): DECLARATIVE steps with bindings, NOT an expression pipe. A pipeline = `{ name?, steps: [{ id, tool, args }] }`; an arg may carry a binding token `{ $ref: "<earlierStepId>", path?: "a.b.0.c" }` that a PURE path lookup (no eval) replaces with the referenced step's result. Chosen over a constrained expression pipe because MV3 CSP forbids eval/new Function and a declarative form is more legible + serialisable (saveable as JSON). Three safety properties: (1) the tool NAME is fixed per step, never bindable — untrusted content from an earlier step can only land in a later step's DATA position, never choose the tool; (2) each step dispatches through the run's normal tool seam (`LazyToolProtocol.execute`, `extension/lib/lazy-tool-protocol.js:830`) so its owner-approval card + untrusted fence apply exactly as a direct call, and the card shows RESOLVED args; (3) fail-closed — `$ref` may reference only an EARLIER step (linear, no cycles), an unresolved binding halts with a structured error, step count + args size bounded. Contrast with `run_script` (one opaque sandboxed-JS blob approved by source digest): a pipeline is a legible chain of NAMED existing tools, each re-gated + each visible on its own plan-strip row. Full write-up in `docs/DESIGN.md` (Tool pipelines section) and the `extension/lib/tool-pipeline.js` header.
- Review: author review 2026-09-01 (slice 1) — the pure core's falsification gate cleared (RED/GREEN recorded); slice 2 pending its own review.
- Gates: the falsification gates apply.
  - Unit: DONE (slice 1) — `tests/tool-pipeline.test.ts` (7): a 3-step pipeline pipes each result forward (bindings resolved by pure path lookup); a failing step halts fail-closed with a structured error; a broken binding halts fail-closed; validate rejects forward/self refs, duplicate ids, over-limit, unknown tools. FALSIFIED: breaking `resolveStepArgs` (bindings no longer resolved) turns the pipe test + the fail-closed gate RED (3 failed); restored → 7/7 GREEN.
  - Browser: SLICE 2 — a journey running a small 2-3 step pipeline (demo tools, e.g. `@demo-pipeline` chaining memory_set → memory_get) and showing each step in the plan strip. Requires the live wiring below.
  - Full suite: `npm run build:production && deno test -A tests/` green — DONE for slice 1 (2937/0 at `c0021d99`, incl. the 7 new tests). NOTE: `tests/review49-regression.test.ts` imports from a HARD-CODED `file:///tmp/cap-artifact-tx-current-main/...` path; when that scratch checkout is absent the 9 tests fail with "Module not found" (environmental, unrelated to any code change) — restore with `ln -sfn <repo> /tmp/cap-artifact-tx-current-main`. Flagged as a latent flake to fix (use `import.meta.url`, not an absolute /tmp path).
  - Constraints: no eval/new Function (MV3 CSP); each step keeps its own gates/approvals; untrusted data fenced; one name per concept.
- Blockers: Depends on CAP-FB-20260831-FS-GRANT-TASK-USE-01 for a compelling file-pipeline demo (grep is a natural pipe source); PLAN-STRIP-CHECKPOINTS-01 (DONE) for visibility
- Next (SLICE 2): wire `run_pipeline` as a 4th lazy-protocol meta-tool in `createLazyProviderToolset` (`extension/lib/lazy-tool-protocol.js:1308`) whose handler runs `runPipeline` with a `dispatchTool` adapter that, per step, calls `protocol.search({query: step.tool})` → picks the exact-name entry's `selectionRef` → `protocol.execute({selectionRef, arguments: resolvedArgs}, context)` → returns `{ ok: r.ok, value: r.result, error: r.error }` (reuses the PUBLIC seam, no security-core edits; the fence is preserved as data flows). Add its wire descriptor + output schema to `LAZY_PROTOCOL_TOOL_WIRE` (`extension/lib/lazy-tool-wire.js`) and UPDATE the 3 tests that pin the eager meta-tool set (`lazy-tool-protocol.test.ts`, `lazy-provider-cutover.test.ts`, `provider-gate.test.ts`). For plan-strip PER-STEP visibility, thread `onProgress` into the frozen lazy context (`extension/lib/agent.js` contextReader, ~:878) and emit `step-start`/`step-end` per pipeline step via `runPipeline`'s `onStep`. Then the browser gate: add a `@demo-pipeline` marker to `extension/lib/models/demo-model.js` issuing a `run_pipeline` that chains `memory_set` → `memory_get`, and a journey asserting both steps render in the plan strip and the piped result is correct. Save-and-re-run (a pipeline stored as a structured skill payload) is a SLICE 3 — today's skills/recipes store is prompt-text only and needs a new `steps` field.
- Recover: `git log --oneline --all --grep=CAP-FB-20260831-TOOL-PIPELINES-01`
- Next: slice 2 (live wiring) — wire the declarative pipeline core into the run so a pipeline definition executes end to end; slice 1 (design + core) landed at origin/main@c0021d99
- History:
  - 2026-08-31 19:20 UTC — filed from owner feedback (co-do-style piped tool chains); design-first.
  - 2026-09-01 17:45 UTC — CLAIMED by the coordinator (owner asked to start it). Design-first.
  - 2026-09-01 18:15 UTC — SLICE 1 landed at `origin/main@c0021d99`. Design decided + documented (see DESIGN DECISION above + docs/DESIGN.md). The pure gated core `extension/lib/tool-pipeline.js` (validate/resolve/runPipeline) + `tests/tool-pipeline.test.ts` (7, RED-proven) landed; full suite 2937/0. No behavior change yet (module unimported) and no version bump — it is NOT model-callable until slice 2 wires `run_pipeline` (the seam is identified + specified in Next). Slice 1 was scoped deliberately: the live wiring touches the security-critical lazy protocol + the eager tool surface (3 pinned tests) + needs onProgress plumbing for plan-strip visibility, which is a focused next increment rather than a rushed change. Entry stays OPEN.

## [CAP-FB-20260901-ONE-CARD-PER-STEP-01] Step 1 of the demo shows three in-chat permission cards plus two native Chrome prompts — the script allows one
- Feedback: 2026-09-01 — EXEC-DEMO-01 headed rehearsal on a genuinely fresh profile with a real model: "Group my open tabs by topic" produced THREE in-chat cards (browser control, then `tabs`, then `tabGroups`) and TWO native Chrome prompts ("Read your browsing history", tab groups) with Deny as the focused default. The acceptance for the demo is at most ONE permission card per step.
- Updated: 2026-09-02 02:20 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: model worker (Fable 5 subagent) under the reanalysis coordinator session — CLAIMED; do not start a parallel attempt
- Workspace: active (local path private)
- Branch: `cap/one-card-per-step` (pushed to origin as the candidate branch; merged by the coordinator)
- Base: `f54d8661`
- Candidate: —
- Shipping: —
- Acceptance: On a fresh profile, a task whose first tool needs browser control + `tabs` + `tabGroups` shows ONE in-chat card listing the three things it will ask for, and ONE native Chrome prompt (Chrome batches a single `chrome.permissions.request` with several permissions into one prompt); Allow grants all of them; the run continues without a second card. The card copy names each capability in user language ("see your open tabs", "group tabs", "control the browser on this site") — never the Chrome permission tokens.
  - Context: each tool asks for exactly what it needs at the moment of need (the all-optional model, CLAUDE.md "Ask for permissions on need"), so a `group_tabs` call trips `browser control` (grant card), `tabs` (`permissionDeniedResult("tabs")` in `extension/lib/browser-tools.js`) and `tabGroups` in sequence, and each denial pauses the run once. The in-chat card is `<permission-approval-card>` (`extension/shared/components.js` `appendApproval` ~5422, keyed on `requirement.key`); the grant handler calls `chrome.permissions.request` per card. The fix is a per-tool declared requirement set: `extension/lib/chrome-tool-capabilities.js` already maps tools to capabilities — derive the FULL requirement (permissions + origins + browser-control) for the selected tool BEFORE the first denial and raise one combined requirement, and let the grant handler request all permissions in one `chrome.permissions.request({permissions:[…], origins:[…]})`. What must NOT change: nothing is requested before the model actually selects a tool that needs it; a denial of the combined request is one terminal denial (no cascade of three).
  - Reproduce today: fresh profile, real model, "Group my open tabs by topic and give me a two-line summary of each group" → count the cards and prompts (3 + 2). Screenshots from the rehearsal: `test-artifacts/exec-demo-rehearsal/01-step1-card-1..3.png`, `01-step1-native-prompt-1..2.png` on `cap/exec-demo`.
  - Files: `extension/lib/chrome-tool-capabilities.js` (a `requirementFor(toolName, {origin})` that returns `{permissions, origins, grantGlobal, reasons}`); `extension/lib/browser-tools.js` (the tools' permission pre-checks call it once and return ONE `permissionDenial` with the full set); `extension/lib/agent.js` / the grant handler (`chrome.permissions.request` with the full set; browser-control grant in the same click); `extension/shared/components.js` (card copy lists each capability in user language); tests + a journey on the seeded profile asserting exactly one card for a `group_tabs` run.
  - Steps: (1) unit RED-first: `requirementFor("group_tabs")` → `{permissions:["tabs","tabGroups"], browserControl:true}`; the tool's first denial carries all three. (2) implement. (3) journey: one `<permission-approval-card>` for the run; screenshot `one-card-per-step.png`. (4) headed check on a fresh profile: one card + one native prompt.
  - Out of scope: the native prompt's default focus (Chrome's); the re-execution after Allow (APPROVAL-RESUME-REEXECUTES-01).
- Review: pending
- Gates: the falsification gates apply
  - Unit: as Steps (1). Falsification: revert the combined requirement → "first denial carries all three" RED → restore → GREEN.
  - Browser: "demo-path: step 1 shows exactly one permission card" added to `EXPECTED`; `one-card-per-step.png`.
  - Full suite: green at the tip.
  - Constraints: request only on the owner's click; never widen a request beyond what the selected tool needs; the card copy is user language (no permission tokens); no emoji.
- Blockers: —
- Next: `requirementFor` + its unit test, then the single combined denial in `group_tabs`/`list_tabs`/`open_tab`.
- Recover: `git log --oneline --all --grep=CAP-FB-20260901-ONE-CARD-PER-STEP-01`
- History:
  - 2026-09-01 21:40 UTC — opened from the EXEC-DEMO-01 rehearsal (defect c); evidence screenshots on `cap/exec-demo@b6898cba`.
  - 2026-09-02 02:20 UTC — CLAIMED by the reanalysis coordinator; worker started in its own worktree on `cap/one-card-per-step` off `origin/main@f54d8661`. Other agents: pick a different entry.

## [CAP-FB-20260901-WEBMCP-CALL-CONSENT-01] A site's WebMCP tool runs with no consent card — decide and implement the consent point for site tools
- Feedback: 2026-09-01 — EXEC-DEMO-01 headed rehearsal, script step 2: after enrolling the fixture site's four tools, the ask was answered from the site's tools with NO approval card; the script expects one Approve. The destructive-action policy covers browser actions, not site-tool calls.
- Updated: 2026-09-01 21:40 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: —
- Candidate: —
- Shipping: —
- Acceptance: A recorded owner decision in `docs/OPEN-QUESTIONS.md` (Q20) on when a site tool asks, and the implementation of it. Recommended default: enrolling a site (the picker's Add) IS the consent for its READ tools for that profile; the FIRST call of a tool the site marks as mutating (or any tool when the site marks none) shows one "Use <site>'s <tool>?" card per run; the Settings → Site tools page shows the per-site decision and can revoke it. The demo script's step 2 is updated to match the decision (one Approve on the first mutating call, or none if the showcase uses only reads).
  - Context: WebMCP tool calls dispatch through the site sub-agent path (`extension/lib/agent-delegation.js`, the WebMCP bridge in `extension/content/bridge-auth.js` and the SW's `webmcp.*` routes); enrolment is per-origin (the picker at Discover, CAP-FB-20260830-WEBMCP-ACCEPTANCE-GREEN-01). There is no per-call consent today. `DESTRUCTIVE_ACTIONS` (`extension/lib/owner-approval.js:23`) is the mechanism to reuse for mutating site tools (`canonicalOperationTarget("webmcp", {origin, tool})`).
  - Reproduce today: enrol `fixtures/webmcp-fixture.html`, ask "What is the cheapest widget and the cart total?" → answered with no card (screenshot `02-step2-result.png` on `cap/exec-demo`).
  - Files: `docs/OPEN-QUESTIONS.md` (Q20 + the answer); `extension/lib/owner-approval.js` (the `webmcp.call` action + target kind); the WebMCP dispatch path (the first mutating call per run pays the card); `extension/options/options.js` (Site tools: the decision + revoke); `REVIEW-2026-08-30.md` §6 step 2 wording; tests + one journey.
  - Steps: (1) record the decision with the owner (this entry's History) — if the owner chooses "no card for reads", the demo script changes, not the product. (2) implement per the decision. (3) journey on the fixture: a mutating tool (`add_to_cart`) shows one card; a read (`list_widgets`) does not.
  - Out of scope: WebMCP discovery/enrolment (done); the showcase site content (SITE-AGENT-SHOWCASE-01).
- Review: pending
- Gates: the falsification gates apply
  - Unit: the `webmcp.call` action is in `DESTRUCTIVE_ACTIONS` and its target canonicalises `{origin, tool}`; falsification by reverting the set entry.
  - Browser: "site tools: first mutating call shows one card; a read shows none" in `EXPECTED`; screenshot `webmcp-call-consent.png`.
  - Full suite: green at the tip.
  - Constraints: the card names the site and the tool; enrolment consent is per profile and revocable; no consent is cached across runs for mutating tools.
- Blockers: Depends on the owner's decision (Q20)
- Next: put Q20 to the owner with the recommended default; implement once answered.
- Recover: `git log --oneline --all --grep=CAP-FB-20260901-WEBMCP-CALL-CONSENT-01`
- History:
  - 2026-09-01 21:40 UTC — opened from the EXEC-DEMO-01 rehearsal (defect d).

## [CAP-FB-20260902-ORIGIN-GRANT-UNION-01] A second site's Allow replaces the first site's browser-control grant, so the first site denies again
- Feedback: 2026-09-02 — found by the APPROVAL-RESUME-REEXECUTES-01 worker with a real model: after Allow on site A and then Allow on site B in the same run, a later call on site A is denied again — `setOriginBrowserControlGrant` writes ONE record, so the second grant overwrites the first instead of adding to it.
- Updated: 2026-09-02 03:23 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: worker (origin-grant-union lane)
- Workspace: durable worktree for the branch
- Branch: `cap/origin-grant-union`
- Base: `origin/main@f54d8661`
- Candidate: this tracker commit
- Shipping: `origin/main@94b81f74`
- Acceptance: Per-origin browser-control grants are a SET: Allow on B keeps A granted; Settings → Browser control lists every granted origin with its own Turn off; revoking one origin leaves the others; the run-scoped/expiring semantics of each grant are unchanged; a multi-site task ("read these three sites") shows at most one card per origin and never re-asks for an origin already allowed in the run.
  - Context: `setOriginBrowserControlGrant` (grep in `extension/lib/browser-tools.js` / `extension/lib/permission-orchestration.js`) stores a single origin record; `isBrowserControlGranted(origin)` reads it. The Allow handler in `extension/shared/conversation.js` (`approvePermissionRequirement`) calls `browser-control.set` with the card's `grantOrigins`. Settings → Browser control (`extension/options/options.js`) renders the single record. What must NOT change: the global grant stays separate; grants keep their expiry; the grant lock (`withGrantLock`) still serialises check + mutate; revoke goes through the service-worker route (SETTINGS-REVOKE-VIA-SW-01).
  - Reproduce today: real model, "Read example.com and example.org and compare them" → Allow (example.com) → Allow (example.org) → the model's follow-up call on example.com is denied with a new card.
  - Files: `extension/lib/browser-tools.js` / `permission-orchestration.js` (a `Map`/array of origin grants with per-origin expiry; `isBrowserControlGranted` checks membership; `setOriginBrowserControlGrant` adds; a `revokeOriginBrowserControlGrant(origin)`); `extension/background/routes/*` (`browser-control.set` adds, `browser-control.revoke` takes an origin); `extension/options/options.js` (list rows + per-row Turn off); tests (`tests/browser-control-grant*.test.ts`); one journey: two origins allowed in one run, both remain granted, Settings lists both, revoking one leaves the other.
  - Steps: (1) unit RED-first: "Allow on B keeps A granted", "revoke A leaves B". (2) implement the set. (3) Settings rows. (4) journey + screenshot `browser-control-two-origins.png`.
  - Out of scope: the number of cards per step (ONE-CARD-PER-STEP-01); host-access (Chrome site access) grants, which are already per-origin in Chrome.
- Review: author review 2026-09-02 — falsification gates cleared (RED/GREEN recorded below); no independent review — the review fleet is unavailable.
- Gates: the falsification gates apply
  - Unit: `tests/browser-control-grant-set.test.ts` (9 tests) written FIRST against the single-record store → RED: `grant set: Allow on B keeps A granted ... FAILED — AssertionError: Values are not equal: A stays granted after B's Allow — Actual false / Expected true` (`FAILED | 2 passed | 7 failed`); after the set store → GREEN: `ok | 9 passed | 0 failed`. The existing browser-control security files (`tests/browser-control*.test.ts`, `tests/browser-tool*.test.ts`, `tests/chrome-tools-t*.test.ts`, `tests/tools-browser.test.ts`, `tests/page-actions.test.ts`, `tests/permission-approval-in-context.test.ts`) stay green unchanged: `ok | 233 passed | 0 failed`.
  - Browser: four checks added to `EXPECTED` — "Browser control: revoking one origin through the service worker reports it gone", "Browser control: allowing a second origin keeps the first origin granted", "Browser control: Settings lists every allowed origin with its own Turn off" (a genuine CDP click on the row's Turn off), "Browser control: turning off one origin leaves the other origin granted"; evidence `browser-control-two-origins.png`. Two probes that asserted the single-record replace semantic ("wrong-origin grant is denied" in the journey suite and in `scripts/page-actions-journey.ts`) now revoke the first origin on its own before allowing the wrong one — the properties they protect (a wrong-origin grant never authorises, an expired grant never authorises) are unchanged, and the first run under the set contract showed the old assumption failing (the toggle synced to on because the wrong-origin grant was still live) before the probes were corrected.
  - Full suite: unit `ok | 3003 passed (14 steps) | 0 failed`; Chrome journeys `327/327 passed`; `scripts/page-actions-journey.ts` `15/15 checks passed`.
  - Constraints: bounded at 64 origin grants (oldest evicted first, `MAX_ORIGIN_GRANTS`); each entry keeps its own id + expiry (`grant.grants[]`, `grant.origins` stays the derived list every reader uses; a legacy list record is honoured entry by entry); every mutation still runs under `withGrantLock`; per-origin revoke is the new `browser-control.revoke` route only (Settings never writes the grant in its own realm) and confirms absence before reporting success; a global grant stays its own scope (revoking one origin under it is refused; adding origins scopes it down as before). `validateGrantFor` returns the ENTRY id, so a capture of A is discarded only when A's own authority changed.
- Blockers: —
- Next: none — archive to TASKS-DONE.md at triage
- Recover: `git log --oneline --all --grep=CAP-FB-20260902-ORIGIN-GRANT-UNION-01`
- History:
  - 2026-09-02 01:40 UTC — opened from the APPROVAL-RESUME-REEXECUTES-01 worker's live-model finding (adjacent defect b in its report).
  - 2026-09-02 — worker: the origins scope is a per-origin SET (`extension/lib/browser-tools.js`: `liveOriginGrantEntries`, union in `setOriginBrowserControlGrant`, `revokeOriginBrowserControlGrant`, `listOriginBrowserControlGrants`); `browser-control.get` returns `grants[{origin, expiresInMs}]` and `browser-control.revoke { origin }` is the per-origin revoke route; Settings → Browser control renders one `<origin-grant-row>` (new component, in the gallery) per allowed origin with its own Turn off, the field ADDS origins, and the listing follows storage changes live. Unit RED → GREEN recorded; journeys 327/327; page-actions 15/15. Candidate: this tracker commit.
  - 2026-09-02 03:23 UTC — DONE: merged forward by the coordinator and pushed as `origin/main@94b81f74`. Coordinator gates on the merged tip: build clean, check:gallery + check:vocabulary clean, journeys 335/335, page-actions 15/15, unit 3020/0 excluding the lock-bound custody file.

## [CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01] A tool loop that spans more than one inner turn loses the first turn's tool results
- Feedback: 2026-09-02 — found by the RUN-BUDGET-EVERY-ITEM-01 worker: agent-do keeps one iteration's tool outputs (`DEFAULT_HISTORY_KEEP_WINDOW = 1`), so a 30-tab read that spans three inner turns loses the first turn's page text before the digest is written; the digest can only cite what the last window still holds.
- Updated: 2026-09-02 02:21 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: model worker (Fable 5 subagent) under the reanalysis coordinator session — CLAIMED; do not start a parallel attempt
- Workspace: active (local path private)
- Branch: `cap/loop-context-window` (pushed to origin as the candidate branch; merged by the coordinator)
- Base: `b5680e0f`
- Candidate: —
- Shipping: —
- Acceptance: A run that reads N items across several inner turns can cite every item in its final answer: either the runtime keeps a bounded, redacted digest of every tool result of the run (not just the last window) in the model context, or each inner turn ends with a runtime-written running summary ("So far: 12 of 30 read — …") that carries forward. The live 30-tab check from RUN-BUDGET-EVERY-ITEM-01 (`scripts/live-every-tab.ts`) cites 30/30 when the loop is forced across three inner turns (set `innerStepLimit` to 8 for the check). Context size stays under the model-call economy budget (MODEL-CALL-ECONOMY-01 measures it).
  - Context: `extension/lib/agent.js` builds the agent-do agent with `innerStepLimit` (now `Math.max(2, Math.min(maxIterations, 24))` after RUN-BUDGET-EVERY-ITEM-01) and agent-do's history window (`DEFAULT_HISTORY_KEEP_WINDOW`, in the imported agent-do library — never reimplement it; use its options or the `onStepComplete`/`onPostToolUse` hooks to maintain a runtime summary). `extension/lib/run-text-steps.js` already separates the substantive text from the nudge reply. What must NOT change: results stay fenced as untrusted; the summary is runtime-written (never model-trusted claims); bounded bytes.
  - Reproduce today: `scripts/live-every-tab.ts` with `innerStepLimit` forced to 8 → the digest cites only the last window's tabs.
  - Files: `extension/lib/agent.js` (the hook that appends the bounded running digest to the continuation message, or the agent-do option that widens the kept window for tool results only); `extension/lib/run-budget.js` (the digest rides the budget events so the status row can show "12 of 30 read"); tests; the live check.
  - Steps: (1) reproduce and record the cited count. (2) unit RED-first with the scripted provider: a 12-item loop across three inner turns → the final text cites 12/12. (3) implement. (4) live check 30/30 across three turns; screenshot `every-tab-three-turns.png`.
  - Out of scope: provider context limits on small models (record only); the pipeline lane (TOOL-PIPELINES-01) as the structural alternative.
- Review: pending
- Gates: the falsification gates apply
  - Unit: as Steps (2); falsification by reverting the carry-forward → "cites 12/12" RED → restore → GREEN.
  - Browser: the live check output recorded in History; `every-tab-three-turns.png`.
  - Full suite: green at the tip.
  - Constraints: bounded digest bytes (e.g. 8 KiB), redacted, fenced; no reimplementation of agent-do.
- Blockers: Depends on CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01 (must land first — the budget events and the live check)
- Next: land RUN-BUDGET-EVERY-ITEM-01, then reproduce with `innerStepLimit` 8.
- Recover: `git log --oneline --all --grep=CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01`
- History:
  - 2026-09-02 01:40 UTC — opened from the RUN-BUDGET-EVERY-ITEM-01 worker's adjacent finding.
  - 2026-09-02 02:21 UTC — CLAIMED by the reanalysis coordinator; worker started in its own worktree on `cap/loop-context-window` off `origin/main@b5680e0f`. Other agents: pick a different entry.

## [CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01] A run that calls tools AND writes its answer on its last allowed step is settled as "Budget reached" although the answer landed
- Feedback: 2026-09-02 — LOOP-CONTEXT-WINDOW-01 worker, live 30-tab run at `maxIterations=3`: the digest was written and persisted, yet the terminal read "Budget reached (9 of 9)" and the Continue card appeared, because the budget verdict rule is "the last step had tool calls".
- Updated: 2026-09-02 05:10 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: —
- Candidate: —
- Shipping: —
- Acceptance: A run whose final model step produced substantive final text (per `extension/lib/run-text-steps.js` `finalText`) settles `ok:true` regardless of whether that step also called tools; "Budget reached — Continue" appears only when the budget ran out with NO substantive final text. The live check `scripts/live-every-tab.ts` at `CAP_LIVE_MAX_ITERATIONS=3` settles ok with 30/30 cited. The status row's counter and the Continue card are otherwise unchanged.
  - Context: `extension/lib/run-budget.js` (RUN-BUDGET-EVERY-ITEM-01) sets `exhausted:true` on the last `budget` event when the last iteration still had tool calls; `extension/lib/agent.js` `onComplete` / the SW terminal settle read that flag and write `errorCategory:"budget"`. The honest rule is "exhausted AND no substantive answer".
  - Reproduce today: `set -a; . ~/.env; set +a; CAP_LIVE_MAX_ITERATIONS=3 deno run -A scripts/live-every-tab.ts` → the digest is in the thread but the terminal is a budget stop.
  - Files: `extension/lib/run-budget.js` (the verdict takes `hasFinalText`), `extension/lib/agent.js` (pass `runText.finalText(e.result)` non-empty into the verdict), `extension/background/service-worker.js` (settle reads the verdict), `tests/run-budget*.test.ts`, the live check.
  - Steps: (1) unit RED-first: "exhausted with final text settles ok", "exhausted without final text settles budget". (2) implement. (3) live check at 3 iterations → ok; screenshot `budget-verdict-answered.png`.
  - Out of scope: the digest itself (landed); the Continue flow.
- Review: pending
- Gates: the falsification gates apply
  - Unit: as Steps (1); falsification by reverting the verdict → "settles ok" RED → restore → GREEN.
  - Browser: the existing budget journey checks stay green; the live-check output recorded in History.
  - Full suite: green at the tip.
  - Constraints: never claim ok for a run with no substantive text; the mutation-claim correction (`correctUnsupportedMutationClaims`) still applies to that text.
- Blockers: —
- Next: the two unit tests + the verdict change in run-budget.js.
- Recover: `git log --oneline --all --grep=CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01`
- History:
  - 2026-09-02 05:10 UTC — opened from the LOOP-CONTEXT-WINDOW-01 worker's adjacent observation 1.

## [CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01] scripts/live-every-tab.ts kills only the Chromium parent and leaves children and temp profiles behind
- Feedback: 2026-09-02 — LOOP-CONTEXT-WINDOW-01 worker: after its live runs 4 Chromium child processes and 2 temp profiles survived and were removed by hand; the journey suite already has descendant cleanup, the live script does not.
- Updated: 2026-09-02 05:10 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: —
- Candidate: —
- Shipping: —
- Acceptance: Every harness under `scripts/` that launches Chrome tears down the whole process group and its temp profile on exit (normal, error, SIGINT), verified by a test that launches through the shared helper, kills it, and asserts no descendant of that pid and no profile directory survive. `scripts/live-every-tab.ts` and any other script that spawns Chrome outside `launchChrome()`'s cleanup use the shared teardown.
  - Context: `scripts/lib/chrome-launch.ts` `launchChrome()` owns the launch; the journey suite's descendant cleanup ("cleanup hard-failed on descendants (none survived)") lives in `scripts/chrome-journeys.ts` — lift it into `chrome-launch.ts` as `closeChrome(handle)` and have every harness call it. SUITE-HONESTY-01 owns the harness inventory; coordinate (this entry is the teardown helper only).
  - Reproduce today: run `scripts/live-every-tab.ts`, then `pgrep -fa "cap-live-every-tab"` → survivors.
  - Files: `scripts/lib/chrome-launch.ts`, `scripts/live-every-tab.ts`, the other direct spawners found by `grep -ln "Deno.Command(\"chromium\|chrome" scripts/*.ts`, `tests/chrome-launch-teardown.test.ts` (new).
  - Steps: (1) unit RED-first with a fake process tree. (2) implement `closeChrome`. (3) run the live script and assert `pgrep` is empty afterwards; record in History.
  - Out of scope: the harness inventory (SUITE-HONESTY-01).
- Review: pending
- Gates: the falsification gates apply
  - Unit: as Steps (1); falsification by reverting the process-group kill → RED → restore → GREEN.
  - Browser: the pgrep evidence after a real live run.
  - Full suite: green at the tip.
  - Constraints: never a fixed debugging port; never kill processes outside the launched group.
- Blockers: —
- Next: `closeChrome` in chrome-launch.ts + its test.
- Recover: `git log --oneline --all --grep=CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01`
- History:
  - 2026-09-02 05:10 UTC — opened from the LOOP-CONTEXT-WINDOW-01 worker's adjacent observation 2.

