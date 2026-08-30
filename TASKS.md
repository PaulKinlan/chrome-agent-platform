# Chrome Agent Platform tasks

`TASKS.md` is the repository-local, public-safe recovery record for product
feedback, bugs, reviews, and active delivery lanes. It complements, but never
copies, the private coordination ledger. The stable `CAP-FB-*` ID is the only
join key between the two systems.

> Snapshot: 2026-08-30 11:00 UTC. Reconciled against exact public
> `origin/main@fc2255be` after the 2026-08-30 full-project reanalysis (`REVIEW-2026-08-30.md`). This file holds the **active** set only;
> completed entries live in `TASKS-DONE.md`. Active counts: **115 nonterminal**, of which 19 are P0.
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

**This file holds only what is in progress or still to do — 115 entries.** Completed work is archived in [TASKS-DONE.md](TASKS-DONE.md) at triage; **merged is done** (Paul, 2026-08-28), so nothing sits in a terminal state here. Most urgent first (regenerated 2026-08-30). The entry itself is always the authority; where it disagrees with this table, the entry wins.

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
| P0 | IN_REVIEW | [`CAP-FB-20260830-WEBMCP-ACCEPTANCE-GREEN-01`](#cap-fb-20260830-webmcp-acceptance-green-01-restore-passive-webmcp-discovery-acceptance) | Restore passive WebMCP discovery acceptance |
| P0 | OPEN | [`CAP-FB-20260821-WORKTREE-HYGIENE-01`](#cap-fb-20260821-worktree-hygiene-01-durable-worktrees-and-evidence-off-the-ram-backed-temp-filesystem) | Durable worktrees and evidence off the RAM-backed temp filesystem |
| P0 | OPEN | [`CAP-FB-20260827-HUB-FIRST-RUN-01`](#cap-fb-20260827-hub-first-run-01-the-first-screen-is-an-onboarding-wall-not-a-command-center) | The first screen is an onboarding wall, not a command center |
| P0 | OPEN | [`CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01`](#cap-fb-20260827-tool-call-legibility-01-tool-call-cards-show-shape-not-answers) | Tool-call cards show shape, not answers |
| P0 | OPEN | [`CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01`](#cap-fb-20260830-browser-lease-deadlock-01-browser-control-grant-and-the-single-driver-lease-deadlock-each-other) | Browser-control grant and the single-driver lease deadlock each other |
| P0 | OPEN | [`CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01`](#cap-fb-20260830-denial-to-grant-card-01-every-browser-tool-denial-becomes-one-allow-card-in-the-conversation) | Every browser-tool denial becomes one Allow card in the conversation |
| P0 | OPEN | [`CAP-FB-20260830-EXEC-DEMO-01`](#cap-fb-20260830-exec-demo-01-the-five-minute-exec-demo-runs-end-to-end-on-a-fresh-profile) | The five-minute exec demo runs end to end on a fresh profile |
| P0 | OPEN | [`CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01`](#cap-fb-20260830-fresh-profile-template-agents-01-a-fresh-profile-lists-22-disabled-templates-as-agents-in-the-sidebar-and-side-panel) | A fresh profile lists 22 disabled templates as agents in the sidebar and side panel |
| P0 | OPEN | [`CAP-FB-20260830-KEYLESS-FIRST-RESULT-01`](#cap-fb-20260830-keyless-first-result-01-a-first-result-with-no-key--the-demo-provider-is-a-plumbing-proof-not-a-demo) | A first result with no key — the demo provider is a plumbing proof, not a demo |
| P0 | OPEN | [`CAP-FB-20260830-PAGE-ACTION-TOOLS-01`](#cap-fb-20260830-page-action-tools-01-the-control-chrome-story-has-no-page-interaction-tools) | The "control Chrome" story has no page-interaction tools |
| P0 | OPEN | [`CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01`](#cap-fb-20260830-run-script-fetch-approval-01-createscript--runscript-is-an-unapproved-exfiltration-and-ssrf-channel) | create_script + run_script is an unapproved exfiltration and SSRF channel |
| P0 | OPEN | [`CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01`](#cap-fb-20260830-selection-ref-validate-first-01-executetool-burns-the-single-use-selectionref-before-validating-arguments) | execute_tool burns the single-use selectionRef before validating arguments |
| P0 | OPEN | [`CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01`](#cap-fb-20260830-transcript-full-answer-01-the-real-answer-is-replaced-by-the-nudge-summary-and-the-persisted-transcript-is-clipped-to-240-characters) | The real answer is replaced by the nudge summary and the persisted transcript is clipped to 240 characters |
| P0 | OPEN | [`CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01`](#cap-fb-20260830-untrusted-content-fencing-01-page-text-reaches-the-model-raw--no-delimiting-no-injection-guidance-no-regression-probe) | Page text reaches the model raw — no delimiting, no injection guidance, no regression probe |
| P1 | **BLOCKED** | [`CAP-FB-20260819-PROACTIVE-TAB-DISCOVERY-01`](#cap-fb-20260819-proactive-tab-discovery-01-proactive-per-tab-site-agent-discovery-before-run) | Proactive per-tab Site Agent discovery before Run |
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
| P1 | OPEN | [`CAP-FB-20260825-SITE-AGENT-SHOWCASE-01`](#cap-fb-20260825-site-agent-showcase-01-make-sites-as-sub-agents-demonstrable-in-under-a-minute) | Make sites-as-sub-agents demonstrable in under a minute |
| P1 | OPEN | [`CAP-FB-20260825-UI-INTEGRATION-RED-01`](#cap-fb-20260825-ui-integration-red-01-scriptsui-integrationts-is-red-and-never-finishes) | scripts/ui-integration.ts is red and never finishes |
| P1 | OPEN | [`CAP-FB-20260825-WEBSTORE-RELEASE-01`](#cap-fb-20260825-webstore-release-01-the-path-to-a-published-extension) | The path to a published extension |
| P1 | OPEN | [`CAP-FB-20260827-SETTINGS-MONOLITH-01`](#cap-fb-20260827-settings-monolith-01-settings-is-one-88-screen-scroll-with-a-nav-that-only-scrolls) | Settings is one 8.8-screen scroll with a nav that only scrolls |
| P1 | OPEN | [`CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01`](#cap-fb-20260828-artifact-library-capacity-01-the-library-still-evicts-the-owners-oldest-artifact-silently) | The library still evicts the owner's oldest artifact silently |
| P1 | OPEN | [`CAP-FB-20260828-HUB-AS-TIMELINE-01`](#cap-fb-20260828-hub-as-timeline-01-the-hub-is-a-dashboard-it-should-be-a-composer-and-a-timeline) | The hub is a dashboard; it should be a composer and a timeline |
| P1 | OPEN | [`CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01`](#cap-fb-20260829-provider-set-no-baseurl-01-saving-a-preset-provider-without-a-base-url-yields-a-config-that-can-never-run) | Saving a preset provider without a base URL yields a config that can never run |
| P1 | OPEN | [`CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01`](#cap-fb-20260830-activity-ledger-undo-01-there-is-no-what-i-did-activity-ledger-with-undo) | There is no "what I did" activity ledger with undo |
| P1 | OPEN | [`CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01`](#cap-fb-20260830-artifact-diff-component-01-an-artifact-diff-web-component-in-the-shared-component-library) | An <artifact-diff> web component in the shared component library |
| P1 | OPEN | [`CAP-FB-20260830-ARTIFACT-VERSIONS-01`](#cap-fb-20260830-artifact-versions-01-immutable-versions-per-artifact-id-with-restore) | Immutable versions per artifact id, with restore |
| P1 | OPEN | [`CAP-FB-20260830-CLAIM-CHECK-BROWSER-TOOLS-01`](#cap-fb-20260830-claim-check-browser-tools-01-extend-the-mutation-claim-check-to-browser-memory-screenshot-and-delegate-tools) | Extend the mutation claim check to browser, memory, screenshot and delegate tools |
| P1 | OPEN | [`CAP-FB-20260830-COOKIE-TOOLS-CUT-01`](#cap-fb-20260830-cookie-tools-cut-01-cookie-reading-tools-send-the-users-session-cookies-to-the-model-provider) | Cookie-reading tools send the user's session cookies to the model provider |
| P1 | OPEN | [`CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01`](#cap-fb-20260830-destructive-action-policy-01-destructive-browser-actions-are-grant-gated-not-approval-gated-and-the-policy-is-invisible) | Destructive browser actions are grant-gated, not approval-gated, and the policy is invisible |
| P1 | OPEN | [`CAP-FB-20260830-DIFF-LIBRARY-01`](#cap-fb-20260830-diff-library-01-a-real-line-diff-library-bundled-csp-safe) | A real line-diff library, bundled CSP-safe |
| P1 | OPEN | [`CAP-FB-20260830-EDIT-APPROVAL-SHOWS-DIFF-01`](#cap-fb-20260830-edit-approval-shows-diff-01-the-assetupdate-approval-card-is-an-opaque-hash-it-must-show-the-diff) | The asset.update approval card is an opaque hash; it must show the diff |
| P1 | OPEN | [`CAP-FB-20260830-EXEC-BUILD-FLAG-01`](#cap-fb-20260830-exec-build-flag-01-a-developer-flag-that-hides-the-platform-lanes-from-the-default-surface) | A developer flag that hides the platform lanes from the default surface |
| P1 | OPEN | [`CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01`](#cap-fb-20260830-focus-order-visibility-01-body-dead-stop-in-the-tab-walk-invisible-focus-on-hint-links-unlabeled-settings-controls) | Body dead-stop in the tab walk, invisible focus on hint links, unlabeled Settings controls |
| P1 | OPEN | [`CAP-FB-20260830-HOST-ACCESS-STORY-01`](#cap-fb-20260830-host-access-story-01-install-time-allurls-host-access-contradicts-the-all-optional-story-told-everywhere-else) | Install-time <all_urls> host access contradicts the "all-optional" story told everywhere else |
| P1 | OPEN | [`CAP-FB-20260830-HUB-CHROME-POLISH-01`](#cap-fb-20260830-hub-chrome-polish-01-hub-chrome-settings-styled-as-the-primary-button-agent-id-as-title-a-zero-width-directory-card-developer-icons-in-the-header) | Hub chrome: Settings styled as the primary button, agent id as title, a zero-width directory card, developer icons in the header |
| P1 | OPEN | [`CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01`](#cap-fb-20260830-local-file-edit-tools-01-the-agent-cannot-read-or-write-a-local-file-fs-grantwrite-file-is-dead-code) | The agent cannot read or write a local file; fs-grant.write-file is dead code |
| P1 | OPEN | [`CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01`](#cap-fb-20260830-memory-recall-new-thread-01-memory-is-write-only-in-practice-the-model-never-reads-it-in-a-new-thread) | Memory is write-only in practice: the model never reads it in a new thread |
| P1 | OPEN | [`CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01`](#cap-fb-20260830-model-field-empty-save-01-typing-a-model-name-without-picking-it-saves-model-and-the-hub-silently-runs-the-demo-model) | Typing a model name without picking it saves model:"" and the hub silently runs the demo model |
| P1 | OPEN | [`CAP-FB-20260830-MODEL-TOOL-ADHERENCE-01`](#cap-fb-20260830-model-tool-adherence-01-with-gpt-41-make-me-a-website-never-creates-an-artifact-and-remember-x-is-answered-with-a-lie) | With gpt-4.1 "make me a website" never creates an artifact and "remember X" is answered with a lie |
| P1 | OPEN | [`CAP-FB-20260830-NOTIFY-ICON-PATH-01`](#cap-fb-20260830-notify-icon-path-01-the-notify-tool-never-works-it-references-an-icon-that-does-not-exist) | The notify tool never works: it references an icon that does not exist |
| P1 | OPEN | [`CAP-FB-20260830-ONE-SHELL-01`](#cap-fb-20260830-one-shell-01-three-surfaces-three-shells-one-content-width-one-title-no-duplicate-chrome) | Three surfaces, three shells: one content width, one title, no duplicate chrome |
| P1 | OPEN | [`CAP-FB-20260830-OPFS-USAGE-WALK-01`](#cap-fb-20260830-opfs-usage-walk-01-every-memory-write-walks-the-whole-opfs-tree--runs-get-slower-with-every-task) | Every memory write walks the whole OPFS tree — runs get slower with every task |
| P1 | OPEN | [`CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01`](#cap-fb-20260830-plan-strip-checkpoints-01-multi-tab-tasks-have-no-visible-plan-or-checkpoints-although-durable-runs-exist-underneath) | Multi-tab tasks have no visible plan or checkpoints although durable runs exist underneath |
| P1 | OPEN | [`CAP-FB-20260830-PRIVILEGED-URL-BLOCK-01`](#cap-fb-20260830-privileged-url-block-01-under-a-global-grant-the-model-can-open-and-navigate-to-chrome-pages) | Under a global grant the model can open and navigate to chrome:// pages |
| P1 | OPEN | [`CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01`](#cap-fb-20260830-provider-default-and-key-flow-01-a-recommended-default-provider-and-a-four-click-key-flow) | A recommended default provider and a four-click key flow |
| P1 | OPEN | [`CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01`](#cap-fb-20260830-provider-error-truth-01-a-provider-401-or-429-is-reported-as-the-model-returned-no-content) | A provider 401 or 429 is reported as "the model returned no content" |
| P1 | OPEN | [`CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01`](#cap-fb-20260830-recent-activity-user-events-01-recent-activity-shows-system-events-and-overflows-into-the-timestamp-column) | Recent activity shows system events and overflows into the timestamp column |
| P1 | OPEN | [`CAP-FB-20260830-RUN-LOG-COMPACTION-01`](#cap-fb-20260830-run-log-compaction-01-run-log-retention-is-retain-all-with-no-compaction) | Run-log retention is retain-all with no compaction |
| P1 | OPEN | [`CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01`](#cap-fb-20260830-scheduled-run-output-01-a-scheduled-agent-runs-but-leaves-nothing-behind) | A scheduled agent runs but leaves nothing behind |
| P1 | OPEN | [`CAP-FB-20260830-SCREENSHOT-TO-MODEL-01`](#cap-fb-20260830-screenshot-to-model-01-capturescreenshot-succeeds-but-the-model-cannot-see-the-image-and-the-owner-cannot-find-it) | capture_screenshot succeeds but the model cannot see the image and the owner cannot find it |
| P1 | OPEN | [`CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01`](#cap-fb-20260830-settings-hooks-permissions-tables-01-hooks-is-50-identical-cards-with-red-deny-buttons-permissions-is-19-identical-cards) | Hooks is 50+ identical cards with red Deny buttons; Permissions is 19 identical cards |
| P1 | OPEN | [`CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01`](#cap-fb-20260830-settings-revoke-via-sw-01-settings-turn-off-bypasses-the-service-worker-revoke-route) | Settings "Turn off" bypasses the service-worker revoke route |
| P1 | OPEN | [`CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01`](#cap-fb-20260830-settings-whats-new-copy-01-settings--about--whats-new-renders-raw-engineering-commit-subjects-to-the-user) | Settings → About → What's new renders raw engineering commit subjects to the user |
| P1 | OPEN | [`CAP-FB-20260830-SIDE-PANEL-COMPANION-01`](#cap-fb-20260830-side-panel-companion-01-the-side-panel-is-a-webmcp-status-surface-not-a-companion-bound-to-the-current-tab) | The side panel is a WebMCP status surface, not a companion bound to the current tab |
| P1 | OPEN | [`CAP-FB-20260830-SIDE-PANEL-TOOL-CUT-01`](#cap-fb-20260830-side-panel-tool-cut-01-opensidepanel-can-never-succeed-when-the-model-calls-it) | open_side_panel can never succeed when the model calls it |
| P1 | OPEN | [`CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01`](#cap-fb-20260830-slash-palette-combobox-01-the-slash-palette-is-not-an-accessible-combobox) | The slash palette is not an accessible combobox |
| P1 | OPEN | [`CAP-FB-20260830-THREAD-ARTIFACT-CARD-01`](#cap-fb-20260830-thread-artifact-card-01-artifacts-render-in-the-thread-from-the-store--today-no-artifact-card-renders-in-a-real-lazy-protocol-run) | Artifacts render in the thread from the store — today no artifact card renders in a real lazy-protocol run |
| P1 | OPEN | [`CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01`](#cap-fb-20260830-thread-view-run-state-01-the-conversation-is-a-fixed-height-box-with-no-run-state-identity-or-time) | The conversation is a fixed-height box with no run state, identity or time |
| P1 | OPEN | [`CAP-FB-20260830-TRANSCRIPT-STREAMING-01`](#cap-fb-20260830-transcript-streaming-01-nothing-streams--the-transcript-is-blank-until-the-whole-step-completes) | Nothing streams — the transcript is blank until the whole step completes |
| P2 | **BLOCKED** | [`CAP-FB-20260822-MV3-WASM-RUNTIME-PROBE-01`](#cap-fb-20260822-mv3-wasm-runtime-probe-01-loaded-mv3-wasm-runtime-and-termination-probe) | Loaded-MV3 Wasm runtime and termination probe |
| P2 | **BLOCKED** | [`CAP-FB-20260822-OWNER-WASM-INSTALL-01`](#cap-fb-20260822-owner-wasm-install-01-owner-selected-wasm-package-lifecycle) | Owner-selected Wasm package lifecycle |
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
| P2 | OPEN | [`CAP-FB-20260830-AGENT-SHARING-01`](#cap-fb-20260830-agent-sharing-01-sharing-and-handoff-do-not-exist-agent-cards-and-import) | Sharing and handoff do not exist: agent cards and import |
| P2 | OPEN | [`CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01`](#cap-fb-20260830-artifact-quick-fixes-01-small-artifact-defects-new-tab-opens-twice-an-empty-id-masks-the-real-error) | Small artifact defects: New tab opens twice, an empty id masks the real error |
| P2 | OPEN | [`CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01`](#cap-fb-20260830-artifact-viewer-source-diff-01-preview--source--diff-in-the-artifact-viewer-and-dialog-with-hand-edit-and-restore) | Preview | Source | Diff in the artifact viewer and dialog, with hand edit and restore |
| P2 | OPEN | [`CAP-FB-20260830-BUNDLE-BUDGET-01`](#cap-fb-20260830-bundle-budget-01-the-service-worker-bundle-is-456-mb-against-a-25-mb-budget-pyodide-would-load-unpinned-remote-code) | The service-worker bundle is 4.56 MB against a 2.5 MB budget; Pyodide would load unpinned remote code |
| P2 | OPEN | [`CAP-FB-20260830-DEAD-CODE-CUT-01`](#cap-fb-20260830-dead-code-cut-01-fifteen-unreferenced-modules-fourteen-gallery-only-components-and-a-2-mb-worker-bundle-nothing-calls) | Fifteen unreferenced modules, fourteen gallery-only components and a 2 MB worker bundle nothing calls |
| P2 | OPEN | [`CAP-FB-20260830-ESCAPEHTML-SINGLE-SOURCE-01`](#cap-fb-20260830-escapehtml-single-source-01-four-copies-of-escapehtml-two-of-them-weaker-than-the-canonical-one) | Four copies of escapeHtml, two of them weaker than the canonical one |
| P2 | OPEN | [`CAP-FB-20260830-FINGERPRINT-SURFACE-01`](#cap-fb-20260830-fingerprint-surface-01-every-website-can-fingerprint-the-extension) | Every website can fingerprint the extension |
| P2 | OPEN | [`CAP-FB-20260830-GENERATED-UI-BOOTSTRAP-SYNTAX-01`](#cap-fb-20260830-generated-ui-bootstrap-syntax-01-the-generated-document-preference-bootstrap-is-a-javascript-syntax-error) | The generated-document preference bootstrap is a JavaScript syntax error |
| P2 | OPEN | [`CAP-FB-20260830-HUB-POLLING-01`](#cap-fb-20260830-hub-polling-01-every-open-new-tab-polls-the-service-worker-every-5-s-for-the-life-of-the-tab) | Every open new tab polls the service worker every 5 s for the life of the tab |
| P2 | OPEN | [`CAP-FB-20260830-MODEL-CALL-ECONOMY-01`](#cap-fb-20260830-model-call-economy-01-a-19-kb-system-prompt-on-every-call-and-an-agent-do-nudge-that-costs-one-extra-call-per-turn) | A 19 KB system prompt on every call and an agent-do nudge that costs one extra call per turn |
| P2 | OPEN | [`CAP-FB-20260830-ON-DEVICE-PATH-01`](#cap-fb-20260830-on-device-path-01-no-chrome-native-on-device-path-the-prompt-api-adapter-cannot-call-tools) | No Chrome-native on-device path: the Prompt API adapter cannot call tools |
| P2 | OPEN | [`CAP-FB-20260830-PATCH-ASSET-TOOL-01`](#cap-fb-20260830-patch-asset-tool-01-a-patchasset-searchreplace-tool-so-an-edit-is-not-a-whole-file-rewrite-paid-for-twice) | A patch_asset search/replace tool so an edit is not a whole-file rewrite paid for twice |
| P2 | OPEN | [`CAP-FB-20260830-SEEDED-PROFILE-GATES-01`](#cap-fb-20260830-seeded-profile-gates-01-seed-warning-permissions-and-seeded-profile-budgets-into-the-journey-and-perf-gates) | Seed warning permissions and seeded-profile budgets into the journey and perf gates |
| P2 | OPEN | [`CAP-FB-20260830-SITE-PLAYBOOKS-01`](#cap-fb-20260830-site-playbooks-01-skills-are-global-and-never-bound-to-an-origin) | Skills are global and never bound to an origin |
| P2 | OPEN | [`CAP-FB-20260830-SUITE-HONESTY-01`](#cap-fb-20260830-suite-honesty-01-the-security-suite-never-loads-the-extension-two-wired-harnesses-are-red-outside-testall-42-harnesses-are-orphaned) | The security suite never loads the extension; two wired harnesses are red outside test:all; 42 harnesses are orphaned |
| P2 | OPEN | [`CAP-FB-20260830-USER-VOICE-COPY-01`](#cap-fb-20260830-user-voice-copy-01-copy-system-language-throughout-the-empty-states-toggles-and-delete-dialogs) | Copy: system language throughout the empty states, toggles and delete dialogs |
| P3 | **BLOCKED** | [`CAP-FB-20260818-WIDER-REVIEW-01`](#cap-fb-20260818-wider-review-01-wider-goal-review-remediation-umbrella) | Wider-goal review remediation umbrella |
| P3 | OPEN | [`CAP-FB-20260821-RECIPES-SKILLS-RENAME-01`](#cap-fb-20260821-recipes-skills-rename-01-finish-the-recipes-to-skills-rename) | Finish the recipes to skills rename |
| P3 | OPEN | [`CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01`](#cap-fb-20260825-agent-picker-hub-rows-01-hub-agent-summary-rows-predate-the-shared-picker) | Hub agent summary rows predate the shared picker |
| P3 | OPEN | [`CAP-FB-20260827-DEAD-COMPONENTS-01`](#cap-fb-20260827-dead-components-01-components-ship-to-users-but-are-only-used-by-the-gallery) | Components ship to users but are only used by the gallery |
| P3 | OPEN | [`CAP-FB-20260830-CODE-HEALTH-01`](#cap-fb-20260830-code-health-01-route-raw-console-calls-through-cap-log-annotate-the-41-bare-catches) | Route raw console calls through cap-log; annotate the 41 bare catches |
| P3 | OPEN | [`CAP-FB-20260830-ICONOGRAPHY-GAPS-01`](#cap-fb-20260830-iconography-gaps-01-skills-without-icons-menus-without-icons-38-uppercase-kickers-in-the-gallery) | Skills without icons, menus without icons, 38 uppercase kickers in the gallery |
| P3 | OPEN | [`CAP-FB-20260830-PRIVACY-STATEMENT-01`](#cap-fb-20260830-privacy-statement-01-one-screen-that-says-what-the-extension-sends-and-stores-and-a-factory-reset-journey) | One screen that says what the extension sends and stores, and a factory-reset journey |

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
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `784cd7f7275a7f63db856ee4231e523700bc861b`
- Candidate: —
- Shipping: —
- Acceptance: from a fresh profile, an owner reaches a working site-agent tool call in under a minute without reading documentation — a reachable entry point, at least one real origin whose WebMCP tools are discovered and invoked, and a visible result; the path states honestly what it granted and to which origin; nothing about the demonstration weakens origin isolation, per-tool first-run approval or the all-optional permission model; the fixture origin in `fixtures/` is usable for this without pretending to be a third-party site; a showcase site ships (a small hosted shop or issue tracker with 4-6 declared WebMCP tools, the same page also served from `fixtures/`) and the hub notices it: when the active tab reports tools the composer shows a chip "<host> offers 4 tools — use them?" whose click is the single grant; fresh profile, open the showcase, one click, ask "add the cheapest widget to my cart and tell me the total", see the site's tool cards and the page change, under 60 s, with the exact origin named in the grant; the Directory empty copy ("Browse the web with the extension installed; each enrolled origin becomes a Site Agent") is replaced with what actually happens
- Review: independent product, security and first-run review; a demonstration path that quietly broadens access to make itself smooth is a failure, not a success
- Gates: fresh-profile loaded-MV3 walkthrough timed end to end, with screenshots at each step; assert the exact permissions requested and that none is granted without a gesture; assert per-tool approval still fires; the same path re-run after a service-worker restart
- Blockers: Depends on CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 and CAP-FB-20260827-HUB-FIRST-RUN-01 (must land first — the chip needs a composer-first hub and legible tool cards); the page-identity and directory-vocabulary dependencies recorded on 2026-08-25 have landed
- Next: build the showcase site under `fixtures/` first (it is the demo asset), then the tab chip
- Recover: `ls fixtures && git grep -n "webmcpExpose\|modelContext" -- extension/content fixtures`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (product and live lanes): the WebMCP path is the strongest thing in the product — `scripts/webmcp-acceptance.ts` 42/42, passive detection with a tool count within 3 s, exact-tab picker, enrollment, per-tool approval, invocation with a visible page side effect, survives reload. It is not demonstrable in 60 s because the only origin with tools is the fixture on 127.0.0.1 (looks like a test), the entry is a "Find site tools" link in a card, and on a plain fresh profile the click needs the `scripting` prompt first. Folded the showcase site and the tab chip into Acceptance. Feeds CAP-FB-20260830-EXEC-DEMO-01 (demo step 2).
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
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `30cd7f59`
- Candidate: —
- Shipping: —
- Acceptance: the composer is the primary element of the hub in the steady state, not only on a fresh profile. The three separate status cards (Agents, Recent artifacts, Recent activity) become ONE activity stream with filters, so a returning owner sees what happened while they were away as a single chronological thing rather than three partial views of it. Drilling into an agent, an artifact or a run still works from that stream. An artifact's primary home becomes the thread that produced it — it is the output of the work, so it belongs with the work; the Artifacts gallery remains as the archive rather than the first place you look. Verified with before/after screenshots on a profile that has real history, not an empty one; after one interactive task, one scheduled run and one pending approval, the hub shows all three in order with one-click access and nothing else below the composer — the three cards (Agents, Recent artifacts, Recent activity) are cut, agent and site lists live in the sidebar only
- Review: fresh-session review; the impeccable design skill is mandatory
- Gates: Chrome journeys green; a11y pass; the impeccable design pass; hub render stays under the existing budget
- Blockers: Depends on CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01 and CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01 (must land first — the timeline renders their rows); the short-term explorer fixes are CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01 and may land before this
- Next: build the profile-with-history fixture first — every hub screenshot to date has been of an empty profile, which is why the composition problem was invisible
- Recover: `git grep -n "Recent artifacts\|Recent activity" -- extension/ntp/ntp.html`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (product lane): confirmed on a profile with real runs — after the demo flows the hub still does not answer "what is waiting on me"; the cards are catalogs of object types. Cut verdict on the three cards recorded in Acceptance. The current explorer's leaks and layout bug are split out as CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01 so they can land now.
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
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `84991bdd`
- Candidate: —
- Shipping: —
- Acceptance: saving a provider that HAS a known preset base URL (`anthropic`, `openai`, `gemini`, `deepseek`) without supplying one stores that preset rather than an empty string, so the permission preflight can derive a real origin; the BYO-endpoint provider, which has no preset, still requires one and says so; the effective base URL (config or preset) resolves through ONE helper used by `provider.set` (store it), `provider.status` (report it; `ok:false` for a config the gate will reject), the gate `providerOriginPattern` (`extension/lib/provider-gate.js:23-32`) and the adapter, so `provider.set {provider:"openai", apiKey, model}` followed by a run succeeds; a unit test on `providerOriginPattern` with a preset id
- Review: falsification — the assertion must go red against the current route, which stores `baseURL: ""`
- Gates: unit suite; the provider journeys
- Blockers: —
- Next: default `baseURL` from the provider descriptor in the `provider.set` route when the chosen provider has one
- Recover: `git grep -n "provider.set" -- extension/background/routes/provider.js`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (tools, perf, editing, product and live lanes): raised P3 → P1. Reproduced independently by five lanes as the first dead end of every programmatic setup: `provider.set` without `baseURL` stores `""`, `provider.status` still says `ok:true`, the hub strip says ready, and the run dies at "provider permission preflight failed closed: configured provider origin is invalid" with zero provider calls and no failed-run row. The live lane traced it to the gate reading only `cfg.baseURL` while the preset fallback lives in `extension/lib/provider.js:139-141`. Any onboarding or named-agent-override path that omits the URL is exposed; the Settings UI hides it by pre-filling the field. Feeds CAP-FB-20260830-EXEC-DEMO-01.
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

## [CAP-FB-20260829-TEMPLATE-CARDS-01] Agent templates render as visual cards
- Feedback: 2026-08-29 — product owner asked for visual template choices instead of plain list rows
- Updated: 2026-08-29 21:00 UTC
- Status: ABANDONED
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
- Blockers: superseded by the owner's later request for a subtle native select in `CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01`; the reusable card component remains in the gallery
- Next: none — the replacement select is tracked by `CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01`
- Recover: `git log --oneline --all --grep CAP-FB-20260829-TEMPLATE-CARDS-01`
- History:
  - 2026-08-29 21:00 UTC — superseded by the owner's later direction: the large create-dialog card list is replaced by the shared native base-select under `CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01`; the reusable card component and its gallery specimen remain, but this task's create-picker acceptance is intentionally no longer pursued
  - 2026-08-29 07:11 UTC — round-1 review's single P1 fixed without widening scope: `<agent-template-card>` articles now use border-box sizing, so their 14px padding and 1px border stay inside the equal-height grid track. The real-browser geometry pin failed before the fix with four -22px adjacent-row gaps (`content-box`) and passes after it; the replacement screenshot visibly shows clean row separation (SHA-256 `9378eb458b7489b7d96f42a6c854ce88ea21e759517b8f45b1a5b114ef1bb609`). Focused 30/30, visual-card KAT 10/10, existing template journey 38/38, production build clean, full suite 2118/0.
  - 2026-08-29 06:48 UTC — candidate gated. Shared `<agent-template-card>` renders name, bounded persona and skill badges with a Starter state; the create dialog orders the curated six first and one Use click applies the editable template. Real MV3 journey 9/9, existing template journey 38/38, full suite 2118/0. Axe ran clean on the gallery; repointing its fetch to a blocked local port made the same journey exit 1 at the axe gate. The rendered-gallery screenshot SHA-256 is `7187c6a9a74f15bbc8ffef873c387d42ba010a10edf8496f3bc2a0a1e4c28915`.
  - 2026-08-29 06:39 UTC — implementation started from current `origin/main`; baseline falsification recorded: all three source/component pins failed and the real-browser card journey failed 0/9 because the old picker rendered no cards

## [CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01] Tool-call cards show shape, not answers
- Feedback: 2026-08-27 — product owner: "the tools calling bubbles don't help as much, I'd expect some better info, then formatted and ability to see JSON input and response better"
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Note: 7 of 8 acceptance items delivered and gated; ONE remains (the in-context grant card for a permission denial, §2b)
- Priority: P0
- Owner: coordinator session
- Workspace: main
- Branch: main
- Base: `139b6f92`
- Candidate: `origin/main@757065b4`
- Shipping: `origin/main@757065b4`
- Acceptance: (1) the COLLAPSED head answers "what happened" without a click — tool label, the existing one-line result summary, duration, and for a failure the actual error text, not just a red "error" chip; (2) an ERROR card is expanded and styled as an error by default, and where the error is a permission/grant denial it renders the in-context approval card rather than prose; (3) the expanded view offers BOTH a structured view and a raw JSON view of inputs and result, with copy-to-clipboard on each, and remembers which the owner last chose; (4) the tree shows CONTENT not shape — an array of objects previews each row's identifying field inline instead of `0 object · 10`; (5) the synthetic `{keys}` root node is gone; (6) an `ok:true` envelope is not rendered as a data row when the status chip already carries it; (7) one expanded typical tool call fits in under ~40% of a 900px viewport; (8) no result summary is rendered twice; (9) `modelContent` is unwrapped before any result block renders — the card shows the tool's own result or error string, never the lazy envelope — and `search_tools`/`list_tools` cards are hidden entirely (they are protocol, not work); (10) none of `modelContent`, `catalogGeneration`, `stableId`, `schemaSummary`, `search_tools` appears in the visible text of a completed thread, asserted by a leakage probe in `scripts/chrome-journeys.ts` that is observed RED on the current tree
- Review: independent review by a different model/session; visual verification in a real loaded extension with before/after screenshots at 1440px and at a narrow width
- Gates: full unit suite; Chrome journeys green; a11y pass (the card is a `<details>`, the status chip is the live region — that must survive); the impeccable design pass
- Blockers: —
- Next: §2b (the in-context grant card for a denial — now the subject of CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01, which this entry consumes) plus the new items 9 and 10: unwrap the envelope and hide the protocol cards
- Recover: `git grep -n "buildToolCardDom" -- extension/shared/components.js`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (tools and product lanes): the cards are legible for a single call, but a real lazy-protocol run leaks the transport. Every real tool call renders as a `search_tools` card followed by the tool card; expanded output starts `{"modelContent":"{\"ok\":true,\"catalogGeneration\":\"92f3…\",\"results\":[{\"stableId\":…` and error cards show the envelope twice; `search_tools` cards leak `catalogGeneration` hashes. Added acceptance items 9 and 10. The container the cards sit in (fixed-height panel, no run banner, no identity on assistant turns) is tracked separately as CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01. Feeds CAP-FB-20260830-EXEC-DEMO-01.
  - 2026-08-29 — mutation-claim genuineness follow-up candidate on `cap-claim-genuineness-p2`: conventional proper-name subjects (`Alice`, `Google`) and possessive third-party subjects (`Our vendor`) no longer trigger assistant-action corrections. Review revision 3 keeps subjectless action reports (`Just`, `Now`, `As requested`) while making unmarked coordinated predicates inherit their third-party subject across both `and [then]` and `but [then]`; an explicit `I`/`we` or trailing `myself`/`ourselves` resumes first-person, including comma-separated and `by myself` forms. The coordinated matrix is behaviorally pinned, with unmarked inheritance RED on `d797f9c5` and both natural reflexive forms RED on `7d126607`. Known heuristic limits remain: team-relative clauses, lowercase subjects, quoted speech and semicolon-separated predicates. This narrows only the runtime honesty backstop; §2b remains the task's separate open product item.
  - 2026-08-27 23:30 UTC — captured with measured evidence from a real loaded extension (headless Chrome, 1440x1600, realistic payloads). **Measured:** one expanded `list_tabs` card is **462px** tall, `search_tools` **436px**; collapsed they are 33px each. Four tool calls expanded fill 1,316px — more than a 900px viewport, on the surface that is supposed to be the conversation. **The collapsed head shows only name + status + duration.** The `tool-result` summary ("8 tabs", "5 matches") is already computed and passed to the card, and is not shown in the head — so a collapsed row communicates almost nothing, while an expanded one floods. **An error card collapsed shows no error text at all:** a `group_tabs` failure renders as `group_tabs · error · 9ms`, and the actual message ("Tab grouping write operations are pending owner tab-management permission enrollment in Settings") is hidden behind a click — backwards for the one state the owner most needs to read. **The tree shows shape, not content:** an 8-tab result renders as eight `0 object · 10` rows, hiding every tab title behind eight more clicks. Every block carries a synthetic `{keys} object · N` root node that is pure noise and costs a level of indentation, and the `ok true` envelope field is rendered as a data row even though the green "done" chip already says it. The summary is duplicated — an "8 tabs" row, then the same thing structurally in the result tree. **There is no raw JSON view and no copy button** on the normal tool path at all; only the generate_ui branch has a "Raw payload" `<pre>`. That is the owner's exact ask and it is simply absent. Tool names render as raw snake_case (`memory_grep`) with no human label.
  - 2026-08-28 — shipped `origin/main@757065b4` (release 0.2.352), rebased twice onto a concurrently-advancing `main` and pushed fast-forward (never forced). Journey suite re-run green at the pushed tip. **Landed items 1, 2a, 3, 4, 5, 6, 7 and 8.** Measured in a real loaded extension, before → after on the same payloads: one expanded `list_tabs` card **462px → 328px** (under the §7 budget of ~40% of a 900px viewport) while showing the SAME 11 visible rows and strictly more information. (1) The collapsed head now carries the one-line summary — `list_tabs  8 tabs · done · 184ms` — and for a failure the actual error text in red rather than a bare chip; (2a) an error card styles as an error and opens itself; (3) every block has a JSON toggle and a Copy button, and the chosen view is remembered per block across the re-renders that rebuild a running card; (4) container rows preview their CONTENT (`tabIds  1800, 1801, 1802`, `0  Inbox — Gmail`) via the new `containerPreview` in `extension/shared/tool-tree.js`, so an array of objects is no longer ten identical `object · 10` rows; (5) the synthetic `{keys}` root row is gone and its children promoted; (6) `ok`/`summary`/`error` are stripped from the tree since the chip and the headline already carry them, and a block left with nothing substantive renders no block at all; (8) the duplicated summary row is gone. Row density tightened (27px → 22px per row) so the 200px scroll cap holds the same rows the old 260px cap did. Two findings came out of writing the tests, both fixed in the code rather than the assertions: a bare numeric `id` outranked `status` in the preview order (a row reading `7` says nothing), and `kind` was unrecognised. **Gates:** build clean; unit **1950 pass / 0 fail**; Chrome journeys **127/127**; gallery drift green. **Falsification:** nine deliberate regressions — neutered headline, un-stripped envelope, restored `{keys}`, no auto-open on error, empty previews, `id`-first ordering, containers stringified into previews, unpersisted view choice, and a globally-shared view choice — each drove exactly its own assertions red before being reverted.
  - 2026-08-27 23:30 UTC — note for the implementer: `<tool-chips>` already exists in `extension/shared/components.js` as a compact chip-row primitive and is currently used ONLY by the gallery, never by the product. It may be the right collapsed representation for a run of successful calls, with full cards reserved for failures and for the call the owner opens. Reuse it rather than adding a sixth representation.



## [CAP-FB-20260827-HUB-FIRST-RUN-01] The first screen is an onboarding wall, not a command center
- Feedback: 2026-08-27 — raised during the pre-exec-demo UX audit; the hub is the first thing anyone opening a new tab sees
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `139b6f92`
- Candidate: —
- Shipping: —
- Acceptance: on a fresh profile the composer is the visually primary element of the hub; the first-run card offers ONE next action rather than six competing ones; a fresh profile does not stack seven separate empty states; the zero state and the filtered-empty state use different copy; and the word "Agents" does not label three nested levels of the same view. Verified with before/after screenshots on a genuinely fresh profile; the composer is the first focusable element in DOM and visual order (Tab #1 lands in it) and is fully visible without scrolling at 1024x700; the first-run guide collapses to one sentence and one button ("Connect a model to start") rendered above the composer as a slim banner, with the browser-control choice moved to the in-context approval card at the moment a task needs it; no sentence in the guide mentions storage, Wasm, enrollment or "starter task"; the 3-step stepper and the "Weekly browsing review" example block are removed, not restyled; three example chips ("Group my tabs by topic", "Summarise this page", "Watch this price") sit under the composer; no empty-state copy renders for a store that has never had data
- Review: independent review by a different model/session; the impeccable design skill is mandatory here (PRODUCT.md principle 1 — one primary action per view — is what this breaks)
- Gates: Chrome journeys green (the first-run card is on the journey path); a11y pass; the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01 (must land first — the 22 template rows are 22 of the 40 tab stops before the composer)
- Next: decide what the single first action is — almost certainly "connect a provider", since nothing else works without one — and demote everything else
- Recover: `git grep -n "first-run-guide" -- extension/shared/components.js extension/ntp/ntp.js`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (ui and product lanes): still accurate and now measured further. Fresh-load tab walk: the composer textarea is tab stop 41 (stops 1-35 are the sidebar brand, +, 22 template rows, Directory/Artifacts/Settings, nub, shield, console; 36-40 are the guide, its dismiss X first); at 1024x700 the composer is entirely below the fold; the card is ~535 px tall at 1440. Copy inside it is system-side ("Keep the key — Storage is available.", a paragraph about per-origin site enrollment and Wasm tools). Files: `extension/ntp/ntp.html` (move `<main>` before `<aside>` or set initial focus), `extension/shared/components.js` (`first-run-guide`), `extension/ntp/ntp.js`. Feeds CAP-FB-20260830-EXEC-DEMO-01.
  - 2026-08-27 23:30 UTC — captured with a screenshot of a genuinely fresh profile in a real loaded extension. The first-run card is roughly 590px tall and contains **six competing actions**: "Allow browser control", "Continue without browser control", "Open provider settings", "Use starter task", "Create the Weekly browsing review agent", and a dismiss X — against PRODUCT.md's first principle, "one primary action per view". The composer, which is the actual point of the product, sits below it and is visually weaker. Below that a fresh profile stacks **seven empty states**: "No tasks yet", "No agents yet" (sidebar), "No named agents yet", "No Site Agents yet", "Discovery has not run yet", "No artifacts yet", "No activity matches". The last of those is the **filtered-empty** copy showing in a never-had-any-data state, which tells a new owner a filter is hiding something. "Agents" labels the sidebar section, the card, and a row inside the card — three nestings of one word. The cold empty hub is genuinely fast (DCL 117 ms, 153 nodes) — this is a composition problem, not a performance one.

## [CAP-FB-20260829-AGENT-BOARD-01] The shared jobs board: agents post and claim work
- Feedback: 2026-08-29 — owner voice note: "agents should be able to ask other agents for work… the chaos extension had a shared message board and a shared jobs board"
- Updated: 2026-08-29 UTC
- Status: DONE
- Priority: P1
- Owner: coordinator session
- Workspace: worker lane
- Branch: cap-agent-board
- Base: `c6406cc7`
- Candidate: `cdb8b491` (r5) — landed as merge `54d70a9b`
- Shipping: 0.2.400
- Acceptance: six management tools, claim lease/expiry, blockedBy DAG, delivery to poster thread, Tasks sidebar Board section
- Review: independent reviewer PASS (round 6); six rounds closed data-integrity findings (fold divergence, forgeable keys, destructive reads, eviction, admission reserve, claim churn, drain kick)
- Gates: suite 2358/0 at merge, board KAT 22/22, build green
- Blockers: none
- Next: idle-agent wake (deferred) — the per-edge deny layer LANDED 2026-08-30 (owner Settings UI, fail-closed guards, corrupt-store refusal)
- Recover: revert merge `54d70a9b`
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
- Permission model (owner decision 2026-08-29; deny layer landed 2026-08-30):
  default-open among named agents + the hub, plus owner-controlled per-edge
  DENY rules (Settings → Board permissions; owner-options principal only;
  fail-closed on malformed rules and corrupt store; rules load fresh inside
  each locked post/claim).
- DEFERRED (planned extensions): automatic wake of idle agents on post
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
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Priority: P1
- Owner: unassigned (IA requires product-owner sign-off)
- Workspace: `cap-settings-cleanliness`
- Branch: `cap-settings-cleanliness`
- Base: `54c92834`
- Candidate: `cap-settings-cleanliness` (design + dead-control safe subset; pending review)
- Shipping: —
- Acceptance: opening Settings renders the requested section, not all twelve; the sidebar nav switches sections rather than scrolling to anchors; each section remains individually addressable by URL (the deep-link requirement the owner already set for the back-stack work); and the DOM node count on open drops substantially from the current 2,255. The single-history-entry back behaviour from `0.2.296` must be preserved; nav items are `<button aria-current="page">` and there are at most 8 top-level entries — Board permissions, Hooks, Tool library and Advanced → Observability demote into one Advanced page; the twelve 16x19 px section-anchor copy-link buttons become the section's own URL or are deleted; every `<select>` in `extension/options/options.html` carries `class="control"` so the shared base-select vocabulary applies, and the board-permissions Agent select has a placeholder option; "Access Mode" becomes sentence case; the Usage active-tab contrast (white on the dark-scheme accent, 2.39:1) is fixed by giving the accent-on-fill token its own dark ink in `extension/shared/theme.css` and the five hero-metric tiles become one line with the chart shown only when there is data — the "pre-existing" exemption in `scripts/a11y-audit.ts` and `scripts/kat-dark-scheme.ts` is removed; the changelog renders only when About is opened (last five entries plus "show all"); the 1.5 s usage timer stops when Usage is not visible; Settings opens with under 800 DOM nodes and the journey suite asserts the budget; the duplicated brand header inside the embedded frame is dropped
- Review: required — fresh-session review of the design and safe-subset diff; the later monolith implementation still requires before/after node counts and section heights from a real loaded extension
- Gates: Chrome journeys green (several journeys drive Settings sections by `.nav-item[data-section=...]`); a11y pass on the section switch (focus and heading order); the impeccable design pass
- Blockers: —
- Next: owner sign-off on the six-group IA in `docs/SETTINGS-CLEANLINESS.md`; then implement one selected group at a time without combining that architecture change with the reviewed dead-control removal
- Recover: `git grep -n 'section.panel' -- extension/options/options.html`
- History:
  - 2026-08-30 11:00 UTC — reanalysis (ui, perf and product lanes): still 12-13.7k px tall with all sections rendered; measured 3,115 DOM nodes on open, 2,059 of them the About section rendering the whole 72 KB changelog at load; 13 nav anchors plus 12 tiny copy-link buttons; 7 native `<select>`s against the base-select vocabulary used everywhere else; the Usage "7 days" tab is the only AA contrast failure across six surfaces in both schemes and has been marked "pre-existing" by three lanes instead of fixed (one token). Folded those into Acceptance. Sequencing: CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01 lands after this. The exec-build developer flag (CAP-FB-20260830-EXEC-BUILD-FLAG-01) removes most of the demoted sections from the default nav independently.
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


## [CAP-FB-20260830-WEBMCP-ACCEPTANCE-GREEN-01] Restore passive WebMCP discovery acceptance
- Feedback: 2026-08-30 — automated production-path WebMCP acceptance was 11/37 because the fixture never entered the passively detected tab picker
- Updated: 2026-08-30 04:44 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: implementation worker
- Workspace: active (local path private)
- Branch: `cap-webmcp-acceptance-green`
- Base: `72bd0b1c`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: `scripts/webmcp-acceptance.ts` is 37/37 green headless from a fresh profile; the fixture is admitted only after authenticated passive detection; exact tab/document enrollment, invocation, reload and navigation checks remain green; full suite and build pass on the final commit
- Review: author review 2026-08-30 PASS (security/privacy, permission, document-identity, performance and test falsification); independent acceptance review required and pending
- Gates: baseline loaded-extension journey 11/37 RED; detector CDP/SW diagnosis recorded; changed focused tests observed 2/4 RED without the product fix and 4/4 GREEN with it; final-commit `npm run test:all` passed (2440 unit, security PASS, 131 Chrome journeys); developer build clean; loaded-extension WebMCP acceptance 37/37 GREEN
- Blockers: —
- Next: independent acceptance review, then coordinator merge
- Recover: `git show cap-webmcp-acceptance-green -- extension/manifest.json extension/background/service-worker.js tests/webmcp-detect-auth.test.ts tests/discoverable-tabs-tools.test.ts`
- History:
  - 2026-08-30 04:44 UTC — diagnosis against the harness-built variant: neither detector appeared in `manifest.content_scripts`, no dynamic detector was registered, the MAIN bootstrap hook was undefined, and `cap:knownWebmcpOrigins` was empty despite the fixture exposing four callable names. After restoring static HTTP(S) MAIN/ISOLATED probes, CDP showed both scripts, the HMAC bootstrap returned a nonce and the SW registry held the fixture's `(tabId, documentId)` snapshot. The picker remained empty because `webNavigation` is optional and unavailable in the two-permission variant; current-document reattestation now reads Chrome's `documentId` from a scripting `InjectionResult`, preserving the exact-document gate without another permission.
  - 2026-08-30 04:44 UTC — focused falsification was 2 pass / 2 fail with the product fix removed and 4/4 green restored. The real loaded-extension acceptance then completed 37/37 green, including picker admission, exact-tab invocation, visible side effects, fencing negatives, re-enrollment, reload and navigation.
  - 2026-08-30 04:49 UTC — final-commit gates passed: developer build clean; 2440 unit tests, security suite and 131 Chrome journeys green; WebMCP production-path acceptance 37/37 green. Author review found no blocker: static probes transport only an authenticated count, the exact `(tabId, documentId)` registry gate remains intact, no permission was broadened, and reattestation injects one bounded isolated no-op only into origins already present in the bounded passive registry.


## [CAP-FB-20260830-EXEC-DEMO-01] The five-minute exec demo runs end to end on a fresh profile
- Feedback: 2026-08-30 — reanalysis 2026-08-30 (all seven lanes); the umbrella for the demo the owner is about to give Chrome leadership. `REVIEW-2026-08-30.md` section 6 holds the script and its ranked blockers
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the five-minute script in `REVIEW-2026-08-30.md` section 6 (group tabs by topic; a WebMCP site as a tool; isolation and consent in Settings; a scheduled run that left a report; make a shareable brief) runs headed on a genuinely fresh profile with a real key, recorded as a screen capture with timestamps, with at most ONE permission card per step, no visible `modelContent`/`search_tools`/`catalogGeneration`/`prompt-attestation` text, and no "[demo model]" or "returned no content" string anywhere. Each numbered blocker in the review is a child entry listed in Blockers; this entry closes only when every child is DONE and the recording exists on durable storage
- Review: pending
- Gates: the recording; the full Chrome journey suite green at the tip; `scripts/chrome-journeys.ts` gains a `demo-path` group that drives steps 1, 4 and 5 headless with the seeded-permission profile
- Blockers: Depends on CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01, CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01, CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01, CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01, CAP-FB-20260830-KEYLESS-FIRST-RESULT-01, CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01, CAP-FB-20260827-HUB-FIRST-RUN-01, CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01, CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01, CAP-FB-20260825-SITE-AGENT-SHOWCASE-01, CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01 (all must land first)
- Next: land the two tool-gating entries first (lease deadlock, denial-to-grant card) — they remove most of the perceived "open tab does not open a tab" breakage without touching a tool
- Recover: `git log --oneline --all --grep=CAP-FB-20260830-EXEC-DEMO-01`
- History:
  - 2026-08-30 11:00 UTC — opened by the reanalysis consolidation. Baseline at `origin/main@fc2255be`: build clean, 2457 unit pass, 138/138 Chrome journeys, hub FCP 15-55 ms; four real providers driven through the hub (gpt-4.1, gemini-2.5-flash native, grok-4.3 and glm-4.5 via the compatible adapter). The product's mechanics are sound; the demo fails today on gating, on persistence of the answer, and on the first screen.

## [CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01] Browser-control grant and the single-driver lease deadlock each other
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane, findings 1 and 11; reproduced by the live lane on every run
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: grant set/revoke never takes the browser-command lease (`extension/lib/browser-tools.js:42-63,136-156` call the grant mutex with `destructive:false` or a dedicated mutex); revoke always succeeds and invalidates the live lease; the lease is released when a run ends for ANY reason (finally keyed on the lease id captured at acquire in `extension/background/service-worker.js` runTask, plus a clear on service-worker startup); the Settings switch reflects `browser-control.get` after a failed revoke, never its own click (`extension/options/options.js:1805-1870`); read tools (`save_page_as_mhtml`, screenshots) use `{destructive:false}` and succeed while another surface holds the lease. Journey: toggle ON in Settings, run "open example.com" in the hub, the tab opens; while a run holds the lease, toggle OFF succeeds and the next open_tab is denied. Falsification: the journey must be observed RED against the current tree (the toggle leaks a 15-minute `interactive` lease). Cut candidate: the single-driver lease has produced two deadlocks and no observed benefit — removing it and keeping only the grant is an acceptable resolution if recorded in History
- Review: pending
- Gates: unit test iterating every non-mutating tool under a foreign lease; the new journey; full suite green
- Blockers: —
- Next: decide keep-vs-remove for `extension/lib/browser-command-lease.js`; if kept, split authority from mutation as above
- Recover: `git grep -n "withGrantLock\|ensureBrowserCommandLease" -- extension/lib/browser-tools.js extension/lib/browser-command-lease.js`
- History:
  - 2026-08-30 11:00 UTC — measured in a real loaded extension: Settings toggle ON writes `cap:browser-command-lease = {surfaceId:"interactive", expiresAt:+15min}` and never releases it; a hub run's surface is its threadId, so every destructive tool in that run gets "another surface is driving the browser". Reverse case: with a named agent holding the lease, toggle OFF flashes "Browser control revoke failed" while the switch renders unchecked and `browser-control.get` still says active. A crashed run leaves its lease for 15 minutes. The live lane needed a manual `agent-worker.lease release` before every provider run.

## [CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01] Every browser-tool denial becomes one Allow card in the conversation
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane, finding 2; product lane activation funnel. Extends CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01 and the shipped CAP-FB-20260826-PERMISSIONS-SIMPLIFY-01, which covered a subset of tools
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: every browser-tool denial returns `permissionDenial(...)` with the exact Chrome permission(s) and the exact origin(s) or global scope — including the legacy `permissionRequired` sites at `extension/lib/browser-tools.js:1395-1400,1447-1452,1563-1568,1580-1585`, the bare `{error}` grant sites at `:1417-1420,1476-1485,1596-1600`, and the `origins`-shaped `capture_screenshot` (`:664-672`) and `save_page_as_mhtml` (`:3467-3475`) requirements; the conversation renders ONE approval card whose Allow performs `chrome.permissions.request` plus `browser-control.set` from the click (`extension/shared/conversation.js:398-460,474-530`); the `capability.request` route (`extension/background/service-worker.js:5807`) can request, not only check. A unit test asserts every browser-tool denial object satisfies `normalizePermissionRequirement`. Journey: on a fresh seeded-permission profile "open example.com in a new tab" yields one card, Allow opens the tab and the model reports the title; the suite asserts the card renders for open_tab, read_page and capture_screenshot denials. Falsification: revert one site to `permissionRequired` and observe the assertion RED
- Review: pending
- Gates: the unit contract test; the journey; full suite green
- Blockers: Depends on CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01 (must land first — the card cannot grant past a foreign lease)
- Next: write the denial-shape contract test first, then convert the sites until it passes
- Recover: `git grep -n "permissionRequired" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured: a fresh profile needs three separate owner actions before `open_tab` can succeed (warning-bearing `tabs` permission, the Browser control switch, no foreign lease) and none is requested in context; the denial shapes are dropped by `normalizePermissionRequirement`, so the error text says "enable it from the chat when prompted" while nothing prompts. Two error vocabularies coexist (`permissionRequired` vs `waitingForPermission`+`permissionRequirement`).

## [CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01] A provider 401 or 429 is reported as "the model returned no content"
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 8, perf lane finding 4, editing lane finding 12, product lane finding 4, live lane finding 6
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: provider HTTP failures are classified before the AI SDK collapses them into `AI_NoOutputGeneratedError`: 401/403 map to an authentication category with the provider's secret-safe message and a "Fix in Settings" action; 429/529 to rate-limited/overloaded with retry; 4xx schema errors to a request category; only a genuinely empty HTTP 200 stream says "returned no content" (`extension/lib/error-report.js:207-213`, `extension/lib/agent.js:634-640`, `extension/lib/provider.js` describeError, `extension/lib/durable-provider-dispatch.js`). A run refused in preflight creates the same failed-run row (with Retry) that a model failure does, and reaches a terminal Failed state within 5 s instead of sitting in "Waiting for permission" (`extension/shared/conversation.js:1137-1139`). Unit test covers the 401/429/empty mapping; journey with a deliberately wrong key shows the 401 bubble with the Settings link. Falsification: the mapping test must be RED on the current tree
- Review: pending
- Gates: unit mapping test; the bad-key journey; full suite green
- Blockers: —
- Next: capture the last provider HTTP error (already logged as `[provider] HTTP 401 ...`) in the model wrapper and carry it through the stream failure
- Recover: `git grep -n "AI_NoOutputGeneratedError\|returned no content" -- extension/lib`
- History:
  - 2026-08-30 11:00 UTC — reproduced with a 401 key on Anthropic, a wrong OpenAI key through the real Settings UI, and three HTTP 429 "insufficient balance" responses from a compatible provider: every case renders "returned no content — possibly overloaded — try a different model" while the service-worker console has the real status. Settings "Test connection" reports the truth; the very next run does not. A preflight-refused run does not appear in the Tasks list at all.

## [CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01] A recommended default provider and a four-click key flow
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 17, ui lane finding 20, live lane finding 14 (provider comparison), open question Q12
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: Settings → Providers recommends one provider (the Q12 default; the live lane's measured recommendation is Gemini 2.5 Flash with OpenAI gpt-4.1 as the documented alternative) with a "Get a key" link; the flow is pick provider → paste key → auto-selected model → Test (a one-token call plus a `list_tabs` dry run) → back to the hub with the composer focused; Base URL and Model id live under Advanced; the panel header is the form title only and the list item stops repeating the description; the demo-provider notice reads as guidance ("No model connected yet — pick one to start"), never "Internal testing provider active"; `chrome.storage` is not named in user copy; `.provider-panel` is not a tab stop (`extension/options/options.html`, `extension/options/options.js` renderProviders). Done = from the first-run line to a working first answer in four clicks with a valid key, screenshots before/after on a fresh profile
- Review: pending
- Gates: Chrome journeys (the provider journeys drive this page); a11y pass; the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01 and CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01 (must land first); the default itself is owner decision Q12 in `docs/OPEN-QUESTIONS.md`
- Next: owner confirms Q12; then rebuild the Providers page around the one recommended path
- Recover: `git grep -n "Internal testing provider" -- extension/options`
- History:
  - 2026-08-30 11:00 UTC — measured: seven presets with Base URL and Model id visible for every one, "Anthropic — Your Anthropic key (OpenAI-compatible endpoint)", and the selected provider shown twice. Live lane: OpenAI-compatible adapter and native Gemini lane both clean; Gemini follows the operating manual for create_asset/memory_set and is honest about images; gpt-4.1 ignored the platform tools for "make"/"remember" tasks twice (see CAP-FB-20260830-MODEL-TOOL-ADHERENCE-01).

## [CAP-FB-20260830-KEYLESS-FIRST-RESULT-01] A first result with no key — the demo provider is a plumbing proof, not a demo
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane findings 1 and 19, tools lane finding 14
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: on a fresh profile with no provider configured, "group my tabs by topic" produces real tab groups, a one-paragraph result and a tab-list artifact — either a deterministic local browser assistant for a fixed intent set (list/group/dedupe tabs, summarise titles, save a tab list) selected when provider=demo, or the Prompt API (Gemini Nano) for text-only steps with that fallback; the literal "[demo model] Task received (N chars)" at `extension/lib/models/demo-model.js:749` is unreachable from the composer; the `@demo-*` markers are never user-visible (gated behind the developer flag in CAP-FB-20260830-EXEC-BUILD-FLAG-01) and the sidebar task preview never shows a bracketed model tag; the `@demo-delegate` marker accepts an origin and stops after the first failed delegate instead of looping eight times (`demo-model.js:73`). Journey: fresh profile, the prompt above, assert groups exist and the artifact is listed
- Review: pending
- Gates: the keyless journey; full suite green
- Blockers: —
- Next: decide (a) deterministic local skills vs (b) Prompt API hybrid; (a) is buildable without any device dependency and is the recommended first step
- Recover: `git grep -n "Task received" -- extension/lib/models/demo-model.js`
- History:
  - 2026-08-30 11:00 UTC — measured: the only useful keyless paths are the `@demo-tools`, `@demo-create-agent`, `@demo-board` test seams; the first thing an exec sees after typing a task is the size of the system prompt. Time from first screen to first useful result is not reachable without a paid key.

## [CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01] A fresh profile lists 22 disabled templates as agents in the sidebar and side panel
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 2, product lane finding 3. Extends CAP-FB-20260829-URGENT-UI-REPAIR-01, which fixed the same projection in Settings only
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the hub sidebar Agents section and the side panel Agents tab list only created named agents and enabled/scheduled background agents — the same projection Settings now uses (`extension/ntp/ntp.js` sidebar agent projection near L1990-2100, `extension/shared/agent-registry.js`, `extension/sidepanel/sidepanel.js`); templates live behind the create dialog's template select and nowhere else. Done = a fresh profile's sidebar shows the empty state only; the sidebar count, the hub Agents panel count and Settings → Agents agree on the same profile; `scripts/chrome-journeys.ts` asserts the three counts are equal. Cut verdict: yes — the 22 recipe-backed background agents leave the default list; they remain one click away as templates
- Review: pending
- Gates: the count-equality journey; full suite green; the impeccable design pass
- Blockers: —
- Next: reuse the Settings projection from URGENT-UI-REPAIR-01 in the sidebar and side panel rather than writing a third one
- Recover: `git grep -n "agent-item" -- extension/ntp/ntp.js extension/sidepanel/sidepanel.js`
- History:
  - 2026-08-30 11:00 UTC — measured: 22 `button.agent-item` rows ("Sorting Hat", "Auto-pin favourites", ... each "Schedule off · every 30 min") on a fresh profile beside a panel header reading "0 agents · 0 site" and a body reading "No agents yet"; the side panel shows the same 22 as "Background agents … disabled". These rows are also 22 of the 40 tab stops that precede the composer.

## [CAP-FB-20260830-CLAIM-CHECK-BROWSER-TOOLS-01] Extend the mutation claim check to browser, memory, screenshot and delegate tools
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 9 (parts b and c)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `extension/lib/mutation-claim-check.js` (CLAIMS, lines 15-40, today agent create/update/delete and scheduling only) also checks open/navigate/close tab, memory_set, capture_screenshot, download and delegate claims against tool outcomes, so "I opened example.com" with a failed open_tab gets the correction line; the same final text is not re-rendered once per step (`extension/lib/agent.js:869,1018`). Unit tests per claim class; journey asserts a run with a failed open_tab and a success claim renders exactly one correction and one final bubble. Falsification: each new claim class observed RED before its rule
- Review: pending
- Gates: unit; journey; full suite green
- Blockers: —
- Next: add the tab/memory/screenshot/delegate claim patterns and the outcome lookup
- Recover: `git grep -n "CLAIMS" -- extension/lib/mutation-claim-check.js`
- History:
  - 2026-08-30 11:00 UTC — measured: one demo run rendered seven identical "Delegation succeeded. Worker response: ..." bubbles for a tool whose card said error, plus an orphaned running card. Live lane: gpt-4.1 said "I have saved that your favourite colour is green" with zero tool calls and nothing in memory.

## [CAP-FB-20260830-TRANSCRIPT-STREAMING-01] Nothing streams — the transcript is blank until the whole step completes
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane finding 3, live lane finding 5 (measured on four real providers)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: provider `text-delta` events are forwarded over the existing agent-progress channel as a coalesced (per animation frame or ~50 ms, bounded buffer) progress event and `<agent-conversation>` appends them to the current assistant bubble with textContent (markdown re-rendered only on completion); the pinned live-status row carries a real label from the first delta instead of an empty string (`extension/shared/conversation.js:1440-1444` renders text progress only when `hasToolCalls` is true today); the durable log still records the final text once and the final bubble is byte-identical to the non-streamed render. Done = a sampler observing the bubble every 250 ms sees at least 10 distinct lengths for a 1,400-token answer, time-to-first-visible-token under 1.5 s on gpt-4.1, and no long task over 50 ms while streaming a 400-word answer. Files: `extension/background/service-worker.js` (progress broadcast), `extension/lib/agent-loop.js`, `extension/shared/conversation.js`, `extension/shared/components.js`
- Review: pending
- Gates: a demo-provider journey (the demo model emits 24-char deltas at `extension/lib/models/demo-model.js:627`) asserting distinct-length count; full suite green
- Blockers: —
- Next: add the `text-delta` progress event and the bubble append API
- Recover: `git grep -n "hasToolCalls" -- extension/shared/conversation.js`
- History:
  - 2026-08-30 11:00 UTC — measured: on every real-provider run the assistant text appears in one paint after the step completes (`distinctTextLengthsObserved` = 2-3); gpt-4.1 provider TTFB 746 ms, text visible at 6.85 s; Gemini bakery turn text visible at 18.5 s. The service worker already uses `doStream`; chunks are not forwarded. A 7-25 s blank "Thinking..." is the demo's dominant feel.

## [CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01] The conversation is a fixed-height box with no run state, identity or time
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 12, editing lane finding 10. Extends CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 (the cards are legible; the room they sit in is not)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the conversation panel is content-height with the composer docked at the bottom of the viewport; assistant turns carry the agent avatar, name and time; a run banner ("Working — reading 4 tabs…") is visible while `run.status` is running, using the existing unused `conversation-run-status` element; every appended row (tool card, approval card, artifact card, bubble) scrolls the conversation to the bottom unless the owner has scrolled up; an update card is titled with the artifact's name rather than "Generated UI"; the programmatic title focus does not paint a focus ring. Done = a two-turn thread has no empty panel space at 1440x900; a screenshot 300 ms after send shows the running state; after an edit turn `scrollTop === scrollHeight - clientHeight`. Files: `extension/shared/components.js` (`agent-conversation`, `message-bubble`, `conversation-run-status`), `extension/ntp/ntp.html` (`#thread-view`)
- Review: pending
- Gates: Chrome journeys; a11y pass (`role=log` must survive); the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-TRANSCRIPT-STREAMING-01 (must land first — the banner and the growing bubble share the live-status row)
- Next: adopt `conversation-run-status` and make the panel content-height
- Recover: `git grep -n "conversation-run-status" -- extension/shared/components.js`
- History:
  - 2026-08-30 11:00 UTC — measured: a 620 px bordered panel with two bubbles in the top 180 px and 440 px of empty panel; `#status` stayed "ready" throughout a run; after an edit turn `scrollTop` was 267 of 587 with the closing message below the fold.

## [CAP-FB-20260830-NOTIFY-ICON-PATH-01] The notify tool never works: it references an icon that does not exist
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 3
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `extension/lib/browser-tools.js:2073` uses `icons/icon128.png` (the file that exists in `extension/icons/`); a unit assertion checks the default notification icon path exists in the built extension; with notifications granted the journey shows `notify` returning `{ok:true, notificationId}`. Falsification: the path-exists test is RED on the current tree
- Review: pending
- Gates: unit; journey with notifications seeded; full suite green
- Blockers: —
- Next: fix the path and add the existence test
- Recover: `git grep -n "icon-128" -- extension`
- History:
  - 2026-08-30 11:00 UTC — measured twice with notifications granted: `notify -> {"ok":false,"error":"Unable to download all specified images."}`.

## [CAP-FB-20260830-SIDE-PANEL-TOOL-CUT-01] open_side_panel can never succeed when the model calls it
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 4
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: Cut verdict: yes — remove `open_side_panel` from the browser toolset (`extension/lib/browser-tools.js`) and the capability table, or convert it into a request the UI fulfils on the owner's next click (a card "Open side panel for <url>"). Done = the tool is absent from `search_tools` results (a removal guard in the tests, the pattern in `tests/chrome-tools-t12.test.ts`), or the card path opens the panel in a headed run; the browser-tool count assertion in the journey suite is updated in the same commit
- Review: pending
- Gates: unit removal guard; journey tool-count; full suite green
- Blockers: —
- Next: remove the tool and its description; keep `chrome.sidePanel.open` for the owner gesture paths
- Recover: `git grep -n "open_side_panel" -- extension tests scripts`
- History:
  - 2026-08-30 11:00 UTC — measured: `chrome.sidePanel.open()` requires a user gesture and the tool runs in the service worker with none: "side panel could not open: sidePanel.open() may only be called in response to a user gesture." Its description promises otherwise.

## [CAP-FB-20260830-SCREENSHOT-TO-MODEL-01] capture_screenshot succeeds but the model cannot see the image and the owner cannot find it
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 5, live lane finding 3 (gpt-4.1 invented a description of a truncated base64 string)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `capture_screenshot` returns `{screenshotId, width, height, bytes}` and never inlines base64 into a text tool result; the run pipeline attaches the PNG as a multimodal image part on the next model call for vision-capable providers (`extension/lib/lazy-tool-protocol.js` result projection, `extension/lib/agent.js`); every model capture is persisted to the screenshots store (today only the owner path persists via `saveScreenshot`, `extension/background/service-worker.js:7751`) and the tool card shows the thumbnail; Artifacts/Screenshots lists it. Done = "take a screenshot of example.com and describe it" yields a description that mentions the actual heading text on a vision model, and `screenshots.list` is non-empty after the run
- Review: pending
- Gates: unit on the projection (no base64 in text results); journey with the demo provider asserting persistence and the card thumbnail; full suite green
- Blockers: —
- Next: change the tool's return shape and the projection; then the image part
- Recover: `git grep -n "captureTabScreenshot" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured on the wire: the tool result was 16,867 chars of base64 cut mid-stream (the 16 KiB string bound), sent as text; gpt-4.1 replied with a hallucinated description; Gemini said it cannot see images; `screenshots.list` after the run was `[]`.

## [CAP-FB-20260830-PRIVILEGED-URL-BLOCK-01] Under a global grant the model can open and navigate to chrome:// pages
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 6
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: browser mutations (`open_tab`, `navigate_tab`, `create_window`, and any tool that takes a destination) accept `http:`/`https:` destinations only and reject `chrome:`, `chrome-extension:`, `file:`, `about:`, `javascript:` and `data:` BEFORE the grant check, with a plain error (`extension/lib/browser-tools.js:1401-1417`; the root cause is `canonicalOrigin` returning null for non-http(s) at `extension/lib/memory.js:261-272` so `isBrowserControlGranted(null)` passes a global grant). Unit and journey assert `open_tab chrome://settings` is refused. Falsification: the assertion is RED on the current tree
- Review: pending
- Gates: unit; journey; security suite; full suite green
- Blockers: —
- Next: add a destination-scheme guard shared by all destination-taking tools
- Recover: `git grep -n "destOrigin" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured: `open_tab {url:"chrome://settings"} -> {"ok":true, tabId}` and `Target.getTargets` shows `chrome://settings/`.

## [CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01] Settings "Turn off" bypasses the service-worker revoke route
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 7
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the Settings Turn off button calls the `capability.revoke` route through the service worker (owner dialog, storage snapshot, and for `scripting` the tombstoning of every enrolled origin's bridge) and never the page-realm `revokeCapability` library call (`extension/options/options.js:1932`, import at `:19-20`); the page-realm revoke import is deleted; the false comment at `options.js:1926` goes with it. Done = turning off Site Agents in Settings unregisters the dynamic scripts of every enrolled origin, asserted via `chrome.scripting.getRegisteredContentScripts` in the journey. Falsification: the journey is RED on the current tree
- Review: pending
- Gates: journey; security suite; full suite green
- Blockers: —
- Next: route the button through the SW; keep permission REQUESTS in the page (they need the gesture)
- Recover: `git grep -n "revokeCapability" -- extension/options/options.js`
- History:
  - 2026-08-30 11:00 UTC — measured: "Context menus" Turn off went through with no dialog while the raw route from the same page returns "This operation requires owner approval in Settings"; enrolled bridges stay registered after Site Agents is turned off.

## [CAP-FB-20260830-PAGE-ACTION-TOOLS-01] The "control Chrome" story has no page-interaction tools
- Feedback: 2026-08-30 — reanalysis 2026-08-30 tools lane finding 10, product lane finding 5; open question Q19
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: EITHER a written owner decision in `docs/OPEN-QUESTIONS.md` Q19 that the product stays WebMCP-only for page interaction (and the demo script says so on the slide), OR a minimal grant-gated page-action family on `chrome.scripting` under the scripting permission and the origin grant: `find_elements` (bounded accessibility-tree snapshot with stable refs), `click_element`, `type_into`, `select_option`, `scroll_to`, `wait_for`; every action is recorded in the activity ledger and previewable (element highlight before click); the transcript shows each action as a sentence. Done (add path) = "on the example.com tab, fill the search box with X and press enter" works from the hub with one origin grant; three journey checks on the fixture page; the security suite adds an injection-to-page-action probe that asserts no action fires from page text
- Review: pending
- Gates: journey on `fixtures/`; security suite probe; full suite green
- Blockers: Depends on CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01, CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01 and CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01 (must land first — page actions without fencing and a ledger are the confused-deputy channel); the scope decision is owner question Q19
- Next: owner answers Q19; the recommended default is to add the minimal family
- Recover: `git grep -n "read_page" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured: the ~130 browser tools contain no click/type/fill/scroll/select tool; `read_page` returns innerText only; the only way to act on a page is a site that ships WebMCP tools. Every comparator leads with "it fills the form". Q17 removed the `debugger` route and nothing replaced it.

## [CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01] create_script + run_script is an unapproved exfiltration and SSRF channel
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 1
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `script.create` and `script.run` (and `schedule_task` with a `scriptId`) are in `DESTRUCTIVE_ACTIONS` (`extension/lib/owner-approval.js:23-46`) and gated by `requireOwnerApproval` with a card showing the full source (digest-bound) and the URLs it fetches; the `cap:fetch` bridge (`extension/background/service-worker.js:3965-3998`, `extension/lib/script-host.js:30-50`) sends `credentials:"omit"`, refuses loopback and private ranges (`localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`), and applies a per-run domain allow-list surfaced in the approval card. Done = a model-created script cannot run until the owner approves the exact source; a unit test proves `cap:fetch` refuses each private address; a Chrome journey shows the approval card. Cut verdict: remove `run_script` from the interactive toolset (`extension/lib/management-tools.js:353-398`) until the gate lands. Falsification: the private-address test is RED on the current tree
- Review: pending
- Gates: unit deny-list; journey approval card; security suite; full suite green
- Blockers: —
- Next: land the cut (remove run_script from the interactive toolset) in one commit, the gate in the next
- Recover: `git grep -n "cap:fetch" -- extension/background/service-worker.js extension/lib/script-host.js`
- History:
  - 2026-08-30 11:00 UTC — verified in source and by driving the executor: `script.create`/`script.run` have no `requireOwnerApproval`; `cap:fetch` accepts any http(s) URL (GET/HEAD), checks only that the extension holds host permission (it holds `<all_urls>`), and returns up to 1 MB of body to the model. Whether the fetch attaches cookies is UNVERIFIED; the URL alone is the exfiltration channel.

## [CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01] Page text reaches the model raw — no delimiting, no injection guidance, no regression probe
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane findings 2 and 3, live lane finding 12 (injection page driven against gpt-4.1 and gemini-2.5-flash)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: every untrusted tool result (read_page text, WebMCP descriptions and results, fetched bodies, board messages) is wrapped in a labelled block with a random per-run boundary token, and a protected constraint layer states that content inside those blocks is data, never instructions, and that no destructive tool is called because page content asked (`extension/lib/system-prompts.js`, `extension/lib/browser-tools.js:836-842`, `extension/lib/tools.js`, `extension/lib/tool-summary.js`); `read_page` returns `{untrusted:true, text}` and the assembled prompt (attestation preview) shows the boundary; `confirmActionDialog` defaults to `requireGenuineGesture:true` (`extension/shared/components.js:5827`); bulk-destructive tab actions (close more than one tab, close a tab the user did not name) take an approval card. A `security-injection` journey in `scripts/security-suite.ts` proves the passive path carries no description text, that an enrolled hostile origin's description is fenced in the prompt, and that with the demo provider scripted to obey, close_tab/navigate/run_script are refused or carded; the injection page joins the journey suite asserting the tab count is unchanged. Run once on a machine with provider egress and record the model outcome
- Review: pending
- Gates: security suite journey; unit on the fence; full suite green
- Blockers: —
- Next: add the boundary token and the constraint layer; then the suite journey
- Recover: `git grep -n "innerText.slice" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured: the injected page text arrives verbatim inside the tool result with no framing; the run held the browser-command lease and `close_tab` is classified mutating without approval, so a compliant model would have closed all five tabs with no card. Both tested models refused; the platform added no defence in depth. The capability wall held in the security lane's live experiment (zero exfil beacons; passive detection transports only a count).

## [CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01] Destructive browser actions are grant-gated, not approval-gated, and the policy is invisible
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 4, product lane finding 11. Extends CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: one policy surface with three visible classes — Read (page text, tab list: allowed after consent), Act (tabs/groups/bookmarks/page actions: ask first time per origin, then auto), Destructive (delete, wipe, downloads to disk, purchases via WebMCP: always ask) — with a per-agent override; the in-chat card names the class it is asking for; Settings, the first-run card and the card all describe the same three classes; the copy contradiction ("listing tabs is always available" vs `list_tabs` denied) is gone. The grant stays the capability, but `close_tab` of a tab the run did not open, `close_window`, `wipe_browsing_data`, `remove_bookmark`, `remove_cookie` and `set_cookie` join `DESTRUCTIVE_ACTIONS` with payload digests (`extension/lib/browser-tools.js`, `extension/lib/owner-approval.js`); `passwords` leaves the wipe enum entirely. Cut verdict: `wipe_browsing_data` is cut for the demo build; the "Allowed origins" textarea in Browser control (`extension/options/options.html:187-206`) folds into per-origin Act grants. Journey: a Read tool never prompts; a Destructive tool always shows the card
- Review: pending
- Gates: journey; security suite; a11y pass on the card; full suite green
- Blockers: Depends on CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01 (must land first — the card is the surface the policy speaks through)
- Next: write the three-class table into `docs/DESIGN.md` and `docs/permission-remediation-design.md`; then gate the listed tools
- Recover: `git grep -n "DESTRUCTIVE_ACTIONS" -- extension/lib/owner-approval.js`
- History:
  - 2026-08-30 11:00 UTC — measured: once a global grant is live, close_tab/open_tab/navigate_tab/wipe_browsing_data (dataTypes include passwords) run without a further owner decision; four mechanisms (31-row permission table, Allowed origins textarea, per-tool WebMCP approval, in-chat cards) and no single mental model.

## [CAP-FB-20260830-COOKIE-TOOLS-CUT-01] Cookie-reading tools send the user's session cookies to the model provider
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 5
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: cookie values are redacted by default (name, domain, expiry only) in `list_cookies` and `get_cookie` (`extension/lib/browser-tools.js:2182-2222,2245-2284`); returning a value requires an approval card; `httpOnly` cookies are never returned. Unit test: the tool result never contains `value` unless approved. Cut verdict: yes — `get_cookie`, `set_cookie` and `remove_cookie` leave the demo build (behind the developer flag from CAP-FB-20260830-EXEC-BUILD-FLAG-01)
- Review: pending
- Gates: unit; security suite; full suite green
- Blockers: —
- Next: redact values and gate the value path
- Recover: `git grep -n "list_cookies\|get_cookie" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — verified: with the cookies permission, "list cookies for github.com" shows values in the thread and sends them to the provider on the next call; combined with the unapproved fetch channel this is full session theft on prompt injection.

## [CAP-FB-20260830-HOST-ACCESS-STORY-01] Install-time <all_urls> host access contradicts the "all-optional" story told everywhere else
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 6, product lane finding 14, tools lane finding 13; open question Q18
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: product owner
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: one recorded posture in `docs/OPEN-QUESTIONS.md` Q18 — either (a) keep install-granted `<all_urls>` plus the passive detector on every page and say so truthfully in `README.md`, the first-run copy, `docs/CONSTITUTION.md` and the Store listing ("this extension can read every page in order to notice when a site offers tools; it acts only after you allow it"), or (b) move `<all_urls>` to `optional_host_permissions`, keep the WebMCP detector on `activeTab` plus JIT origin grants, and lose passive discovery. Then every surface agrees: `README.md` (today lines 85-87 say the manifest `permissions` is empty and there is no `<all_urls>`; line 149 says install-granted `<all_urls>`), `extension/lib/capabilities.js:317-325`, the `capability.request` route comment, `extension/lib/capabilities.js` `requestOriginHost`, `scripts/chrome-journeys.ts:881-889`, the `cap:fetch` and cookie error strings, and the WEBSTORE-RELEASE-01 entry. Done = `git grep -n "install-grant\|granted at install\|permissions is empty"` returns only the boot-set rows and the chosen posture; a vocabulary-style check fails on the retired claim. The README sentence is corrected in this tracker commit to state what the manifest actually declares
- Review: none — an owner decision; an agent prepares the two options
- Gates: the grep; the journey suite's manifest assertion; the security suite
- Blockers: owner decision Q18 (recommended default in `docs/OPEN-QUESTIONS.md`)
- Next: owner picks (a) or (b); then one docs-and-comments commit
- Recover: `git grep -n "all_urls" -- README.md extension/manifest.json extension/lib/capabilities.js`
- History:
  - 2026-08-30 11:00 UTC — verified: `extension/manifest.json` declares four required permissions, 31 optional permissions, `host_permissions: ["<all_urls>"]` and two content scripts on every http(s) page at `document_start`; `chrome.permissions.getAll()` on a fresh profile returns `<all_urls>`. The install prompt will read "Read and change all your data on all websites" — the first question a Chrome reviewer will ask.

## [CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01] There is no "what I did" activity ledger with undo
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 10
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: each mutating tool call writes a human sentence plus the inverse call when one exists (`list_recently_closed`/`restore_closed`, `ungroup_tabs`, `remove_bookmark` and their pairs already exist in `extension/lib/browser-tools.js`); the hub timeline and the side panel show "Undo" for the last N reversible actions; destructive actions without an inverse require the in-chat approval. Done = "close my duplicate tabs" renders "Closed 3 duplicate tabs · Undo" and Undo restores them, driven in the journey suite
- Review: pending
- Gates: journey; full suite green; the impeccable design pass
- Blockers: —
- Next: define the ledger row shape (sentence, tool, args digest, inverse) in the run log and render it in the timeline
- Recover: `git grep -n "restore_closed\|ungroup_tabs" -- extension/lib/browser-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured: Recent activity is a per-call log with role chips and Run logs is a debugger timeline; there is no action-level history and no reversal, although the inverse operations exist for most mutations.

## [CAP-FB-20260830-FINGERPRINT-SURFACE-01] Every website can fingerprint the extension
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 7
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `web_accessible_resources.matches` in `extension/manifest.json:88-97` no longer exposes `artifact/artifact.html`, `artifact/artifact.js` or `sandbox/artifact-preview.html` to `<all_urls>` (they are only embedded by extension pages; `use_dynamic_url:true` if a web match is ever needed); the MAIN-world detector hook at `extension/content/webmcp-detect-main.js:91-97` is a Symbol or per-document name rather than a non-configurable named global. Done = a `fetch` of the resource from a web page fails and the global is absent, asserted in the security suite
- Review: pending
- Gates: security suite; WebMCP acceptance still green; full suite green
- Blockers: —
- Next: scope the resources and rename the hook
- Recover: `git grep -n "web_accessible_resources" -- extension/manifest.json`
- History:
  - 2026-08-30 11:00 UTC — verified in source; the viewer embedded by a page would call `asset.get` for any id/origin it is given (`extension/artifact/artifact.js:14-16,54`).

## [CAP-FB-20260830-SUITE-HONESTY-01] The security suite never loads the extension; two wired harnesses are red outside test:all; 42 harnesses are orphaned
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane findings 10 and 11, editing lane finding 15 and T9
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `scripts/security-suite.ts` gains extension-loaded journeys (sender-auth refusal from a page, `cap:fetch` private-IP refusal, approval-card gating of `script.run`, cookie redaction); `test:a11y` and `test:components` join `test:all` and are green (five unlabeled Settings controls become `<label for>`; the gallery byte-identity assertion at `scripts/component-gallery-smoke.ts:47-49` compares after the known import rewrite in `scripts/sync-gallery.mjs:45-53`); every KAT under `scripts/kat-*.ts` is either wired into a `test:kat` aggregate or deleted; every harness launches through `launchChrome()` so `tests/harness-debug-port.test.ts` can assert exclusivity; harnesses with no exit code (`flake-evidence.ts`, `panel-leak-probe.ts`, `repro-recent-activity.ts`) set one; the editing lane's scripted OpenAI-compatible provider is promoted to `scripts/lib/scripted-provider.ts` and a keyless two-turn artifact journey (create, edit with approval, versions = 2, sandbox probe zero hits, one tab per New tab click, bootstrap parses) joins `scripts/chrome-journeys.ts`. Done = `npm run test:all` green and covering all of the above; `scripts/evidence-runner.sh:49` no longer invokes the supervisor-guarded suite directly
- Review: pending
- Gates: `test:all` green; `tests/harness-debug-port.test.ts`
- Blockers: —
- Next: land the scripted provider and the artifact journey first (it is the falsification harness for the editing chain)
- Recover: `git grep -n "test:all" -- package.json`
- History:
  - 2026-08-30 11:00 UTC — measured: `npm run test:security` is 7/7 in 5.4 s but tests `renderHtmlFrame` on a fixture page; `test:a11y` 15/2 FAIL, `test:components` 34/1 FAIL, neither in `test:all`; 62 harnesses, 20 wired, 42 orphaned; no fixed port anywhere (good).

## [CAP-FB-20260830-SEEDED-PROFILE-GATES-01] Seed warning permissions and seeded-profile budgets into the journey and perf gates
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane findings 11 and 12, tools lane finding 15
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the journey suite adopts profile `Preferences` pre-seeding of `granted_permissions` (the pattern every reanalysis lane used) so the headless suite drives every warning-gated tool for real, keeping one headed run for the prompts themselves (extends CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01); `scripts/perf-leak-trace.ts` launches through `launchChrome()` and gains a seeded phase (5 agents, 50 artifacts, 60 demo runs through the real routes) asserting `agent.run` wall under 400 ms, `thread.get` and `run.list` under 40 ms, hub composer-ready under 150 ms, data-visible under 250 ms, zero long tasks over 50 ms, CLS 0 and a hub CPU budget, printing the numbers on every run; `extension/ntp/ntp.js` gets perfSpan marks (boot to composer ready, thread list hydrated, agents and artifacts panels hydrated, each send) and pages post their measures into `observability.dumpTrace`. Falsification: the seeded perf gate must be RED on today's tree at the 60-run step (the OPFS walk) and GREEN after CAP-FB-20260830-OPFS-USAGE-WALK-01; record both
- Review: pending
- Gates: `test:perf`; `tests/harness-debug-port.test.ts`; full suite green
- Blockers: —
- Next: land the seeded fixture and the RED gate first; it is the proof for the OPFS entry
- Recover: `git grep -n "rendered fast" -- scripts/perf-leak-trace.ts`
- History:
  - 2026-08-30 11:00 UTC — measured: `test:perf` passes 8/8 with a "rendered fast (< 1000ms)" check that is load event plus 300 ms sleep on an empty profile; every gate, journey and screenshot in the repo runs on a fresh profile, so use-proportional regressions are invisible; `performance.getEntriesByType('measure')` on the hub is empty.

## [CAP-FB-20260830-ESCAPEHTML-SINGLE-SOURCE-01] Four copies of escapeHtml, two of them weaker than the canonical one
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 16
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the local `escapeHtml` copies in `extension/ntp/ntp.js:290` and `extension/options/options.js:2775` (which do not escape single quotes) and `extension/memory/explorer.js:75` are deleted and the canonical `extension/shared/components.js:77` export is imported (both files already import from components.js); `timeAgo`, `sha256Hex`, `fnv1a`, `truncateUtf8`, the 13 hand-rolled id generators and the 8 inline sleeps collapse onto `newId(prefix)`/`sleep` in `extension/lib/pure.js`. Done = one definition each, with a grep-guard unit test that fails on a second `function escapeHtml`
- Review: pending
- Gates: unit grep guard; full suite green
- Blockers: —
- Next: delete the copies and add the guard
- Recover: `git grep -n "function escapeHtml" -- extension`
- History:
  - 2026-08-30 11:00 UTC — verified: any single-quoted attribute built with the weak copy is an XSS seam.

## [CAP-FB-20260830-DEAD-CODE-CUT-01] Fifteen unreferenced modules, fourteen gallery-only components and a 2 MB worker bundle nothing calls
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane finding 13, ui lane finding 14, perf lane finding 7, editing lane finding 14. Extends CAP-FB-20260828-DEAD-SURFACES-01 (unchanged: `chat/`, `memory/`) and CAP-FB-20260827-DEAD-COMPONENTS-01 (count 5 → 14)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: delete the modules with zero references from the manifest, any HTML or the build (`extension/lib/profile-store.js`, `extension/shared/composer.js` and `.css`, `extension/lib/tabular-diff-artifacts.js` plus `tabular-diff-artifacts-core.js` whose only consumer is the dead adapter, `extension/lib/code-diff-artifacts.js` after its retention helpers are folded into CAP-FB-20260830-ARTIFACT-VERSIONS-01, `extension/lib/agent-cards.js` unless CAP-FB-20260830-AGENT-SHARING-01 adopts it, `extension/lib/opfs-tool-workspace.js`, `extension/lib/python-runtime.js` and `python-tool.js` unless the Pyodide lane bundles a pinned runtime, `extension/lib/preference-bridge.js`, `extension/lib/agent-worker-client.js`, `extension/lib/js-minifier-tools.js`, `extension/lib/jwt-decode-tools.js`, `extension/lib/run-log-wal-memory.js`, `extension/shared/agent-candidates.js`, `extension/lib/bundled-tool-packages.js`); delete the gallery-only elements `theme-picker`, `agent-nav`, `prompt-bar`, `run-task-button`, `screenshot-strip`, `agent-config-form`, `loading-state`, `streaming-text`, `thinking-trace`, `site-agent-card`, `artifact-inspector` (unless CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01 mounts it), `permission-row`, `agent-template-card` and their gallery specimens, keeping `tool-chips` and adopting `conversation-run-status`; remove the `theme` key from the install seed (`extension/background/service-worker.js:7724`) and the Themes line from `docs/DESIGN.md`; decide the SharedWorker architecture — wire `workers/agent-worker.js` through the offscreen host for named agents, or remove it and the boot reconcile at `service-worker.js:7789` and update `docs/AGENT-EXECUTION-ARCHITECTURE.md`. Add a build assertion that every shipped JS file is reachable from a manifest/HTML/build entry and a `scripts/check-components.mjs` that every `customElements.define` name appears in a non-gallery page or an allowlist of at most two entries. Done = the build fails on an unreferenced module; the package inventory shrinks by exactly those files (roughly 5,500 lines). Cut verdict: yes — that is the task
- Review: pending
- Gates: build; `check:gallery`; full suite green
- Blockers: Depends on CAP-FB-20260830-ONE-SHELL-01 (must land first — it decides `chat/` and `memory/`)
- Next: land the reachability assertion first so it lists the set, then delete
- Recover: `git grep -n "customElements.define" -- extension/shared/components.js | wc -l`
- History:
  - 2026-08-30 11:00 UTC — measured by a reference-graph script: 15 modules / 3,957 lines with zero references; 14 custom elements defined and used by nothing but the gallery; `dist/workers/agent-worker.js` (2 MB) has no caller — no worker, shared_worker or offscreen target appeared in any run, the loop runs in the service worker.

## [CAP-FB-20260830-PRIVACY-STATEMENT-01] One screen that says what the extension sends and stores, and a factory-reset journey
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane findings 9 and 17
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a one-screen "What this extension sends and stores" page linked from Settings, stating: outbound is provider APIs, explicit GitHub skill imports and the model-driven fetch (once gated); stored is `chrome.storage.local` (provider config including the key, unencrypted), OPFS memory/runs/artifacts, and session nonces; how to wipe (per-store Clear and the factory reset). A `factory-reset` journey seeds every storage class, runs the reset from the Settings button and asserts `enumerateStorageTargets()` is empty afterwards (`extension/lib/factory-reset.js:104-195`). Optionally the demo profile keeps keys in `chrome.storage.session`
- Review: pending
- Gates: the journey; a11y pass; full suite green
- Blockers: Depends on CAP-FB-20260830-HOST-ACCESS-STORY-01 (must land first — the page states the host-access posture)
- Next: write the page after Q18 is decided
- Recover: `git grep -n "enumerateStorageTargets" -- extension/lib/factory-reset.js`
- History:
  - 2026-08-30 11:00 UTC — verified: no telemetry or analytics endpoint exists; the full factory reset has no Chrome journey in `test:all`.

## [CAP-FB-20260830-CODE-HEALTH-01] Route raw console calls through cap-log; annotate the 41 bare catches
- Feedback: 2026-08-30 — reanalysis 2026-08-30 security lane findings 14 and 15
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the 32 raw `console.*` calls outside `extension/lib/cap-log.js` (17 in `extension/background/service-worker.js`, 3 in `extension/ntp/ntp.js`) go through cap-log; the 41 bare `catch {}` bodies carry a comment or a log; a unit test greps the shipped tree for `console.` outside cap-log and for uncommented empty catches. Longer term (record only): per-namespace route modules for the 144 inline SW routes, one file per component family with the gallery sync as the invariant — no source file over 3,000 lines
- Review: pending
- Gates: unit grep test; full suite green
- Blockers: —
- Next: the grep test first, then the 32 calls
- Recover: `git grep -n "console\.\(log\|warn\|error\)" -- extension/background/service-worker.js`
- History:
  - 2026-08-30 11:00 UTC — measured: 421 empty catch bodies (380 commented, 41 bare); TODO/FIXME census is 2.

## [CAP-FB-20260830-OPFS-USAGE-WALK-01] Every memory write walks the whole OPFS tree — runs get slower with every task
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane finding 1
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `extension/lib/memory.js` replaces the per-write directory walks (`storeUsage` at :533 and `globalUsage` at :548, both called from `setValueInner` at :624 and :647) with an incrementally maintained usage ledger — `{keys, bytes}` per store and a global total kept in the service worker, seeded by one walk per SW lifetime or persisted in an index updated on write/delete/tombstone, recomputed only on a quota-exceeded path or a checksum mismatch; quota semantics (8 MiB per origin, 64 MiB global) unchanged. Done = on a profile seeded with 120 demo threads, `agent.run` (demo) wall time is within 1.5x of the empty-profile time (under 300 ms), `thread.get` under 30 ms, `run.list` under 30 ms, asserted by the seeded gate in CAP-FB-20260830-SEEDED-PROFILE-GATES-01. Files: `extension/lib/memory.js`, `tests/memory*.test.ts`
- Review: pending
- Gates: the seeded perf gate RED before / GREEN after; unit; full suite green
- Blockers: —
- Next: land the ledger behind the same quota checks
- Recover: `git grep -n "globalUsage\|storeUsage" -- extension/lib/memory.js`
- History:
  - 2026-08-30 11:00 UTC — measured: `agent.run` with the demo model goes 118-180 ms empty → 426-507 ms at 20 threads → 2.54-2.62 s at 120; `thread.get` 1 → 145 ms; SW CPU profile at 80 threads shows `walk` at 251 ms inclusive per three runs; ~11 OPFS files per run, so the work is O(runs^2). Heap stays flat — it is I/O, not a leak.

## [CAP-FB-20260830-RUN-LOG-COMPACTION-01] Run-log retention is retain-all with no compaction
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane finding 2. Related: CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01 (the same silent-bound versus no-bound tension)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a run-log retention policy keeps full logs for the last N executions per thread (for example 10) and a global cap (for example 500 executions or 32 MiB), compacts older executions to a terminal summary row, and is visible in Settings → Data & memory with an explicit "keep everything" opt-in and in the `run.list` response (`extension/lib/durable-runs.js` normalizeRetention near :67, `extension/lib/run-log-wal.js`, `extension/lib/thread-run-view.js:38-41`). Done = a seeded 500-run profile stays under the cap, `thread.get` under 50 ms at 500 runs, and eviction does not itself trigger tree walks
- Review: pending
- Gates: seeded perf gate; unit; full suite green
- Blockers: Depends on CAP-FB-20260830-OPFS-USAGE-WALK-01 (must land first — eviction must not walk)
- Next: define the policy shape and the Settings row
- Recover: `git grep -n "retain-all" -- extension/lib/durable-runs.js`
- History:
  - 2026-08-30 11:00 UTC — measured: `retentionPolicy: {mode:"retain-all", automaticCompaction:false}`; 120 one-sentence demo runs produced 1,336 OPFS files and 960 KB of run logs; `thread.get:view` peaks at 286 ms for two-message threads because it reads up to 25 executions x 250 rows per open.

## [CAP-FB-20260830-HUB-POLLING-01] Every open new tab polls the service worker every 5 s for the life of the tab
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane finding 5
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `extension/shared/diagnostics-client.js:78-80` `startDiagnosticPolling(5000)` and `extension/options/options.js:2942` `setInterval(renderUsage, 1500)` are replaced by push — diagnostics/security changes emitted over the agent-progress port or a `chrome.storage.onChanged` revision key, refreshed on change and on visibility; usage refreshed by a broadcast after each run. Done = an idle open hub generates zero SW routes over 60 s (the journey counts `[cap:sw:route]` lines), the diagnostics panel still updates within 1 s of a new event, and the service worker is allowed to go idle
- Review: pending
- Gates: journey; full suite green
- Blockers: —
- Next: add the revision broadcast; remove the two timers
- Recover: `git grep -n "startDiagnosticPolling" -- extension/shared/diagnostics-client.js extension/ntp/ntp.js`
- History:
  - 2026-08-30 11:00 UTC — measured: `route diagnostics.list` + `route security.state` from each hub tab every 4,999 ms; three tabs = six wakes per 5 s; the 500-entry log ring dropped ~1,000 entries per 3 minutes, mostly this polling; the MV3 30 s idle teardown never happens while a new tab is open.

## [CAP-FB-20260830-BUNDLE-BUDGET-01] The service-worker bundle is 4.56 MB against a 2.5 MB budget; Pyodide would load unpinned remote code
- Feedback: 2026-08-30 — reanalysis 2026-08-30 perf lane findings 6, 9, 10 and 13, security lane finding 8
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: (a) the bundled-tool inventory and descriptor data modules move behind a dynamic import used only by `tool.preview.run` and the Tool library route; (b) the `ai`/`zod` import surface is audited — provider adapters imported per configured provider, zod schema construction at module scope made lazy; (c) `build.mjs` gains a size gate that fails when `dist/background/service-worker.js` exceeds 3.0 MB on the store target and prints the top contributors from the esbuild metafile; (d) the NTP and side panel entry points are bundled by the same esbuild step as options, with `check:gallery` still passing because `components.js` remains the single source; (e) `extension/lib/python-runtime.js:13-24` either bundles a bounded pinned Pyodide with non-empty sha384 pins or is deleted with `python-tool.js` — no `cdn.jsdelivr.net` string in the bundle. Done = store-target SW bundle at or under 3.0 MB, cold-start busy window at or under 80 ms, the size gate in `npm run build`, one module fetch per page. Do not split `components.js` now — add a hub CPU-profile budget to the perf gate instead
- Review: pending
- Gates: build size gate; `sw-cold` measurement; full suite green
- Blockers: Depends on CAP-FB-20260830-DEAD-CODE-CUT-01 (must land first — measure after the dead modules are gone)
- Next: the metafile report and the gate first, so the contributors are visible
- Recover: `ls -l extension/dist/background/service-worker.js`
- History:
  - 2026-08-30 11:00 UTC — measured: SW bundle 4,560,257 B (zod 1,063 KB, three provider SDKs plus gateway ~730 KB shipped unconditionally), agent worker 2,036,242 B with no caller, options bundle 866,804 B; the hub loads ~41 unbundled modules (~1.1 MB) per tab; cold-start busy window 114-117 ms today, so this is hygiene, not a felt delay.

## [CAP-FB-20260830-MODEL-CALL-ECONOMY-01] A 19 KB system prompt on every call and an agent-do nudge that costs one extra call per turn
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 15, editing lane finding 8, live lane finding 11
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the composed hub system prompt is budgeted (under 6 KB; product lane asks 4 KB) with reference material moved behind `list_tools` and tool-usage rules into tool descriptions (`extension/lib/system-prompts.js`), measured by a unit test on the registry; provider prompt caching is enabled for the stable prefix (the run log already records `prefixMatch`); the agent-do "Continue working on the task" nudge is sent only when the step ended on a tool result with no text — a `maxIterations`/continue predicate in `extension/lib/agent-loop.js` and `extension/lib/agent.js` — and a scripted provider that re-calls a tool on every nudge terminates within 3 iterations with a visible "stopped after N steps" marker; if agent-do cannot be configured, record it in KNOWN-ISSUES and cap iterations at 3. Done = the open-tab journey is at most 3 provider calls and at most 12k input tokens on gpt-4.1; the artifact create turn is exactly 3 provider calls; the demo model reports under 6,000 chars for a fresh hub task. Cut candidate: the manual's tool-inventory prose
- Review: pending
- Gates: unit prompt budget; journey call count with the scripted provider; full suite green
- Blockers: —
- Next: measure the prompt layers and cut; then the nudge predicate
- Recover: `git grep -n "Continue working on the task" -- extension/lib extension/dist/background/service-worker.js`
- History:
  - 2026-08-30 11:00 UTC — measured on the wire: `composedBytes:17848`; request bodies 20.5-51 KB; "open a tab and tell me its title" = 6 calls, 27.9k input tokens, USD 0.066 on gpt-4.1; the nudge is answered with a summary that then overwrites the real answer (see CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01); one mis-scripted run looped 12 iterations / 25 calls.

## [CAP-FB-20260830-DIFF-LIBRARY-01] A real line-diff library, bundled CSP-safe
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane, task T1
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: adopt `diff` (jsdiff, BSD-3-Clause, pure JS, no eval) — not a hand-rolled diff — imported from `extension/shared/diff-core.js` and built as an esbuild entry in `build.mjs` next to `options.bundle.js` producing `dist/shared/diff-core.bundle.js` so `components.js` and the service worker import one build; `"diff"` added to `package.json` dependencies; the existing no-`new Function` scrub, seam scan and store-target policy apply unchanged. Done = `tests/diff-core.test.ts` proves `diffLines` on the two bakery fixture bodies yields +10 -2 across two hunks, `structuredPatch` round-trips through `applyPatch` byte-identically, and the production bundle contains no `eval`/`Function(`
- Review: pending
- Gates: unit; build scrub; full suite green
- Blockers: —
- Next: add the dependency and the entry
- Recover: `git grep -n "options.bundle" -- build.mjs`
- History:
  - 2026-08-30 11:00 UTC — the retained `extension/lib/code-diff-artifacts.js` views are whole-file `-old +new` line lists, not hunks; nothing in the tree computes a real diff.

## [CAP-FB-20260830-ARTIFACT-VERSIONS-01] Immutable versions per artifact id, with restore
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T2 and finding 3
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: every `asset.create` (new or keyed update) and `asset.update` appends an immutable version row `asset-version:<id>:<n>` `{n, at, size, sha256, bodyRef, by:"model"|"owner", summary?}` and updates the head; bodies are content-addressed (`asset-blob:<sha256>`, refcounted) reusing the retention pattern of `extension/lib/code-diff-artifacts.js:508-571`; the last 20 versions per artifact are kept under a cap that counts against `ASSET_BOUNDS.maxIndexBytes`, with eviction visible (`versionsTruncated:true` on the head) — the same evict-versus-refuse decision as CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01, decided together; routes `asset.versions`, `asset.version-get`, `asset.restore` (owner-direct, creates a new head `by:"owner"`); the WAL compensation in `updateAssetLocked` (`extension/lib/artifacts.js:710-826`) covers the version row and the blob refcount. Done = after the two-turn bakery run `asset.versions` returns 2 rows with distinct sha256, restore of v1 makes v3 whose body equals v1 byte-for-byte, and a crash-recovery test covers a WAL interrupted between body write and version write
- Review: pending
- Gates: unit including WAL interruption; the scripted-provider artifact journey; full suite green
- Blockers: —
- Next: the version row and blob store under the existing asset lock
- Recover: `git grep -n "updateAssetLocked" -- extension/lib/artifacts.js`
- History:
  - 2026-08-30 11:00 UTC — verified: `updateAsset` is a WAL-compensated in-place overwrite; the old body exists only in the WAL until `clearWal`; `asset.list` after an edit is one row.

## [CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01] An <artifact-diff> web component in the shared component library
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T3
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: one reusable element in `extension/shared/components.js`, added to the gallery (`docs/components.html`, `scripts/sync-gallery.mjs`): properties `before`, `after`, `beforeLabel`, `afterLabel`, `language` (html|css|js|json|md|text), attributes `mode="unified|split"` and `context`; hunks from `structuredPatch`; renders with textContent only, neutralises control/bidi characters, truncates lines over 8 KB with a marker; header shows `+n -m` and hunk count; prev/next change buttons and hunk list focusable; `role="region"` with counts in the label, a live region announcing "change N of M", `aria-keyshortcuts` `]`/`[`; contrast per `docs/DESIGN.md` in both schemes; reduced motion respected; split falls back to unified under 720 px via container query; refuses to render more than 2,000 hunk lines and says so. Done = the gallery smoke shows the bakery diff in both modes, keyboard-only navigation reaches every hunk, `scripts/a11y-audit.ts` passes on the gallery, and a unit grep-guard proves the component never sets `innerHTML` from a diff line
- Review: pending
- Gates: gallery smoke; a11y audit; unit grep guard; `check:gallery`; the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-DIFF-LIBRARY-01 (must land first)
- Next: build the element against the fixture bodies
- Recover: `git grep -n "artifact-card" -- extension/shared/components.js | head -3`
- History:
  - 2026-08-30 11:00 UTC — opened from the editing lane's dependency-ordered plan.

## [CAP-FB-20260830-EDIT-APPROVAL-SHOWS-DIFF-01] The asset.update approval card is an opaque hash; it must show the diff
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T4 and finding 3
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the service worker stages the pending update `{id, name, oldSha256, newSha256, newContent}` under the approvalId, readable by the extension principal only (`extension/background/service-worker.js` `requireOwnerApproval` and `asset.update`, `extension/lib/owner-approval.js:525`); `maybeRenderApproval` (`extension/shared/conversation.js:1270-1271`) renders `<artifact-diff>` inside the approval card with the artifact name and `+n -m` in the title; Approve/Deny unchanged; the same card is reused for `script.update` and later local-file writes. Done = the bakery turn-2 approval card shows the two hunks (the header colour lines and the opening-hours lines) before the click; Deny leaves `asset.get` unchanged; the scripted-provider journey asserts the card body contains `+` lines with "Opening hours". Falsification: the journey assertion is RED on the current tree (the card shows only `Target reference: <hash>`)
- Review: pending
- Gates: journey; security review of the staged payload's principal gate; full suite green
- Blockers: Depends on CAP-FB-20260830-ARTIFACT-VERSIONS-01 and CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01 (must land first)
- Next: stage the payload; then render
- Recover: `git grep -n "Target reference" -- extension/shared/conversation.js`
- History:
  - 2026-08-30 11:00 UTC — measured in a real run: the card reads exactly "Approve asset.update? / Action: asset.update / Target reference: <32 hex>" with no artifact name, no content and no diff; the real change was +10 -2 and nothing in the UI said so.

## [CAP-FB-20260830-THREAD-ARTIFACT-CARD-01] Artifacts render in the thread from the store — today no artifact card renders in a real lazy-protocol run
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T5, findings 1, 2 and 10; live lane finding 10 (confirmed with a real model). CAP-FB-20260828-ARTIFACTS-IN-THREAD-01 is DONE but renders nothing in a real run — this is its successor
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `execute_tool(create_asset|update_asset)` results yield an `<artifact-card id=<asset id>>` live and on replay (`extension/shared/conversation.js` `artifactFromToolResult`, the tool-result handler near :1384-1440 and replay derivation near :840-860; bisect `unwrapLazyEnvelope` preferring `userSummary` at :749-750); the card's preview loads via `asset.get` (as `extension/artifacts/index.js:72-78` does) — the thread never mounts a frame from a bounded arg string (the "Generated UI" branch at `extension/shared/components.js:3608-3650` is dropped for those two tools and kept for `generate_ui`); an update card is titled by the artifact name and reads `Updated <name> (+n -m) [View diff]` opening `<artifact-diff>` over versions n-1 and n; stick-to-bottom scrolling on append. Done = after the two-turn bakery run the deep shadow-root walk counts 2 artifact cards live and 2 after reload plus reopen, the inner srcdoc `bodyText` starts with the page heading, and no frame is ever mounted from a string ending in an ellipsis. Falsification: revert the derivation fix and observe the card-count assertion RED
- Review: pending
- Gates: the scripted-provider journey; full suite green; the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-ARTIFACT-VERSIONS-01 (must land first — the diff control needs versions); the derivation fix itself has no dependency and may land first
- Next: bisect the derivation with the scripted provider, land the card, then the diff control
- Recover: `git grep -n "ARTIFACT_TOOLS" -- extension/shared/conversation.js`
- History:
  - 2026-08-30 11:00 UTC — measured: `{"artifactCards":0,"genui":1}` after turn 1, `{"artifactCards":0,"genui":2}` after turn 2 and after reload, while the asset store held the artifact the whole time; the srcdoc frame received 1,667 chars ending mid-`<style>` with an ellipsis (the display-bounded args string), so it paints only the body colour. The live lane saw the same blank 520 px frame with Gemini and a real 5 KB page.

## [CAP-FB-20260830-PATCH-ASSET-TOOL-01] A patch_asset search/replace tool so an edit is not a whole-file rewrite paid for twice
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T6 and finding 7
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `patch_asset(origin, id, edits:[{search, replace, all?}], expectVersion?)` in `extension/lib/management-tools.js`, applied server-side under the asset lock: each `search` must match exactly once (or `all:true`), `expectVersion` refuses a stale edit with `version_conflict` and the current head, the result is `{ok, id, version, added, removed}` computed with the diff library; `extension/lib/master-skill.js` tells the model to prefer it for edits and to `get_asset` only when it has not seen the body this turn; approval goes through the diff card; `update_asset` stays for full rewrites; `update_asset` with an empty id returns "update_asset needs an existing id (use list_assets)" before the approval gate instead of "This operation requires owner approval" (`extension/background/service-worker.js` `asset.update`, message already at `extension/lib/artifacts.js:713`). Done = the bakery colour change is one `patch_asset` call under 400 bytes of args, the thread shows `+1 -1`, and a stale `expectVersion` is refused without mutating
- Review: pending
- Gates: unit; the scripted-provider journey; full suite green
- Blockers: Depends on CAP-FB-20260830-ARTIFACT-VERSIONS-01 (must land first)
- Next: the route and the tool descriptor
- Recover: `git grep -n "update_asset" -- extension/lib/management-tools.js`
- History:
  - 2026-08-30 11:00 UTC — measured: edit-turn request bodies of 19.8-26.3 KB with the full document duplicated in args and echoed into the next prompt; an empty-id update masked the real problem and the model retried the same call 12 times.

## [CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01] Preview | Source | Diff in the artifact viewer and dialog, with hand edit and restore
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T7 and finding 6
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a segmented control Preview | Source | Diff in `extension/artifact/artifact.js` and `openArtifactDialog` (`extension/ntp/ntp.js`); Source mounts `<artifact-inspector>` (already built, gallery-only today) plus a bounded CSP-safe highlighter for html/css/js/json/md (a small tokenizer or a bundled highlight core with five languages, no eval — verified by the build scrub); Diff mounts `<artifact-diff>` with a version picker and a Restore button (owner-direct approval); hand edit is a textarea in Source with Save through `asset.update` (owner-direct); Copy and New tab stay; a single New tab click opens exactly one `artifact/artifact.html` target (`_wire` idempotent at `extension/shared/components.js:2148-2156,2258`). Done = keyboard-reachable toggle, highlighted source, restore creates a new version, the library dialog offers the same three modes, the journey asserts one tab per click. Falsification: the one-tab assertion is RED on the current tree (one click opens two)
- Review: pending
- Gates: journey; a11y pass; `check:gallery`; the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-ARTIFACT-VERSIONS-01 and CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01 (must land first); the double-open fix may land alone first
- Next: fix the double New tab first (small, independent); then the segmented control
- Recover: `git grep -n "Copy content" -- extension/artifact`
- History:
  - 2026-08-30 11:00 UTC — measured: viewer buttons are exactly ["← Back", "Copy content"]; one genuine CDP click on a library card's New tab opened two viewer tabs.

## [CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01] The agent cannot read or write a local file; fs-grant.write-file is dead code
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane task T8 and finding 4
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: two model tools gated on an existing grant — `read_local_file(grantId, relativePath)` bounded by `MAX_FS_TEXT_DECODE_BYTES` and `write_local_file(grantId, relativePath, content)` whose approval card is the diff card with the on-disk bytes as `before` (`extension/lib/management-tools.js`, `extension/lib/master-skill.js`, `extension/background/service-worker.js` fs-grant routes at ~4600-4700, `extension/lib/fs-grants.js`); writes go through `writeFsGrantFile` only after the approval resolves; a path outside the grant, a binary file, or over `MAX_FS_WRITE_BYTES` fails closed with a readable error. Done = with the KAT's OPFS fixture grant (`scripts/kat-local-files.ts`), "fix the typo in composer-local-file-known.txt" produces a diff approval card, the file changes only after Approve, and Deny leaves the bytes byte-identical (sha256 before/after). Cut alternative: if local-file editing is not on the demo path, cut the unreachable `fs-grant.write-file` route rather than ship it
- Review: pending
- Gates: KAT; security review of the grant boundary; full suite green
- Blockers: Depends on CAP-FB-20260830-EDIT-APPROVAL-SHOWS-DIFF-01 (must land first — same card)
- Next: decide demo-path relevance; if in, add the read tool first
- Recover: `git grep -n "write-file" -- extension/background/service-worker.js`
- History:
  - 2026-08-30 11:00 UTC — verified: every `fs-grant.*` route refuses any principal other than the owner surfaces; no tool references one; `fs-grant.write-file` has zero callers.

## [CAP-FB-20260830-GENERATED-UI-BOOTSTRAP-SYNTAX-01] The generated-document preference bootstrap is a JavaScript syntax error
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane finding 5
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `preferenceBootstrapScript()` at `extension/shared/components.js:353-363` closes `apply` after the locale branch so the listener and the `cap:preference-ready` post sit outside it; a unit test parses both injected scripts with `new Function(body)` (test-side only) and a journey asserts a rendered frame posts `cap:preference-ready` and its `documentElement.lang` equals the owner's locale. Falsification: the parse test is RED against the current string
- Review: pending
- Gates: unit; journey; full suite green
- Blockers: —
- Next: fix the brace and add the parse test
- Recover: `git grep -n "preferenceBootstrapScript" -- extension/shared/components.js`
- History:
  - 2026-08-30 11:00 UTC — measured: every `about:srcdoc` context throws `SyntaxError: Unexpected token ')'` (14 occurrences in one run); the documented theme/locale projection has never run.

## [CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01] Small artifact defects: New tab opens twice, an empty id masks the real error
- Feedback: 2026-08-30 — reanalysis 2026-08-30 editing lane findings 9 and 13
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `<artifact-card>` `_wire` is idempotent (abort-controller per render or one delegated click listener keyed by `data-act`, `extension/shared/components.js:2148-2156,2258`) and a journey asserts one New tab click yields exactly one `artifact/artifact.html` target; `asset.update` validates `id` (non-empty, present in the index) before the approval gate and returns the existing message from `extension/lib/artifacts.js:713`. Falsification: both assertions RED on the current tree. These may be folded into CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01 and CAP-FB-20260830-PATCH-ASSET-TOOL-01 if those land first; record the fold in History
- Review: pending
- Gates: journey; unit; full suite green
- Blockers: —
- Next: the two fixes in one small commit
- Recover: `git grep -n "_wire" -- extension/shared/components.js | head`
- History:
  - 2026-08-30 11:00 UTC — measured: one genuine click opened two viewer tabs; an empty-id update returned "This operation requires owner approval" with no card.

## [CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01] Settings → About → What's new renders raw engineering commit subjects to the user
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 3
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the About page (`extension/options/options.js:3020-3060`) shows only entries written for users — the last five that pass a filter plus a "Full release notes" link — and renders them only when About is opened; the changelog check (`scripts/check-changelog.mjs`, `tests/changelog.test.ts`) rejects recent entries that start with `merge:`/`chore`/`fix(`, contain a 7-40 hex SHA, or contain any of: journey, KAT, assertion, CDP, harness, worktree, lane, tracker, RED/GREEN. Done = a re-taken About screenshot shows five entries a non-engineer can read. Falsification: the widened check is RED against today's `CHANGELOG.md`
- Review: pending
- Gates: `check:changelog`; unit; journey screenshot
- Blockers: —
- Next: the filter in options.js first (immediate), then the widened check with a baseline for the backlog
- Recover: `git grep -n "CHANGELOG" -- extension/options/options.js`
- History:
  - 2026-08-30 11:00 UTC — measured: the page shows "v0.2.426 — merge: WebMCP acceptance green lane (0c9783c8) — detector registration restored, JIT scripting at discover, fresh-profile picker proof" and similar; the test rejects CAP-FB ids but SHAs and "merge:" pass. The About section alone is 2,059 DOM nodes because the whole 72 KB changelog renders at load.

## [CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01] Hooks is 50+ identical cards with red Deny buttons; Permissions is 19 identical cards
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 6
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: Hooks becomes a table (event · Chrome API · state) with a per-row `<switch-toggle>` and a single "Deny all", danger colour reserved for the confirm of a deny; Permissions becomes a grouped list (Browsing · Content · System) of `capability-row`s with a plain ghost "Turn on" and the "Gates: …" line behind a tooltip or `<details>` (`extension/options/options.html` hooks and permissions sections, `extension/options/options.js` `renderHooks`, `renderPermissions`, `extension/shared/components.js`). Done = neither section exceeds 900 px on a fresh profile; no more than one red control visible per viewport; all rows use the shared components. Cut: the per-hook API-name subtitle leaves the default view
- Review: pending
- Gates: Chrome journeys (several drive these sections); a11y pass; the impeccable design pass
- Blockers: Depends on CAP-FB-20260827-SETTINGS-MONOLITH-01 (sequencing only — land after the one-section-at-a-time IA so the tables are built once)
- Next: sequence after the monolith split
- Recover: `git grep -n "renderHooks\|renderPermissions" -- extension/options/options.js`
- History:
  - 2026-08-30 11:00 UTC — measured: hooks 2,818 px, permissions 2,182 px; danger red is the dominant colour on the Hooks page.

## [CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01] Recent activity shows system events and overflows into the timestamp column
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 4, product lane finding 19. Extends CAP-FB-20260828-HUB-AS-TIMELINE-01 (this is the short-term fix on the existing explorer)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the activity explorer (`extension/shared/components.js` `activity-explorer` near L7150-7300) whitelists user-meaningful kinds (task started/finished/failed, artifact created, approval requested/granted, schedule ran) and hides `prompt-attestation` rows and raw provider RESULT dumps behind Run logs; the row grid is `minmax(0,1fr) auto` with `min-inline-size:0` on the text cell; the zero state reads "Nothing has happened yet" and the filtered-empty state "No activity matches this filter"; the header (`extension/ntp/ntp.js` `hub-usage`) drops `$0.0000`/tokens for "2 runs today" (cost lives in Settings → Usage) and agrees with itself across renders. Done = two demo turns produce two rows; no text overlaps the time column at 1440 and 1024; the two empty-state strings differ. Cut: the `PROMPT-ATTESTATION` row type leaves this surface
- Review: pending
- Gates: Chrome journeys; the impeccable design pass
- Blockers: —
- Next: the whitelist and the grid fix
- Recover: `git grep -n "prompt-attestation" -- extension/shared/components.js extension/ntp/ntp.js`
- History:
  - 2026-08-30 11:00 UTC — measured: six rows for two user turns (TASK, PROMPT-ATTESTATION, RESULT twice); RESULT text runs under the "just now" column; "0 calls · 0 tokens · $0.0000" in one render and "2 calls · 80 tokens" in another of the same data.

## [CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01] Body dead-stop in the tab walk, invisible focus on hint links, unlabeled Settings controls
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane findings 7 and 24
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a 60-Tab walk from hub load never lands on `body` (the focusable-but-hidden element between `#hub-usage` and `aside#side` — likely `tabindex=0` on the hidden `#thread-conversation` — is fixed); every `:focus-visible` element in the hub has a non-none outline or box-shadow (`.hint-link` at `extension/ntp/ntp.html:639-650` gets the shared `outline: 2px solid var(--accent)` and a 24 px hit area); no interactive element in the hub is under 24 px on either axis (the four 39x21 `aex-plain-copy` buttons, the 16x19 section-anchor buttons); the first-run guide's dismiss X moves to the end of its tab sequence; every `field-label` span in `extension/options/options.html` becomes `<label for>` so `scripts/a11y-audit.ts` reports 17/17. Done = a CDP test in `tests/` walks focus and asserts the three properties; the a11y audit has zero failures
- Review: pending
- Gates: a11y audit 17/17; the new CDP focus test; full suite green
- Blockers: —
- Next: find the body stop; then the ring and the labels
- Recover: `git grep -n "outline: *none" -- extension/ntp/ntp.html`
- History:
  - 2026-08-30 11:00 UTC — measured: "BODY-STOP scrollTop=483" after the activity filter select; `a#bg-configure` and `a#discover-page` match `:focus-visible` with computed outline none; the audit reports five unlabeled Settings controls.

## [CAP-FB-20260830-ONE-SHELL-01] Three surfaces, three shells: one content width, one title, no duplicate chrome
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 10. Extends CAP-FB-20260828-DEAD-SURFACES-01 and CAP-FB-20260828-VIEW-FRAME-COLLAPSE-01
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `extension/chat/` and `extension/memory/` are deleted (the in-hub thread view superseded chat; the explorer renders raw JSON as "Master memory"); until the iframe collapse lands, one `--content-max: 1040px` / `--content-gutter` token pair is used by Artifacts, Directory, Skills and Settings (`extension/artifacts/index.html`, `extension/directory/directory.html`, `extension/options/options.html`); embedded views drop their own H1 when the frame bar already names them (`extension/ntp/ntp.html` `#view-title`) and Settings drops its duplicated brand header inside the frame. Done = the three embedded views share the same left edge at 1440 and 1024 (measured), no view shows its name twice, and no reference to `chat/chat.html` or `memory/explorer.html` remains. Cut verdict: yes for `chat/` and `memory/`
- Review: pending
- Gates: Chrome journeys; `check:vocabulary`; the impeccable design pass
- Blockers: —
- Next: delete the two surfaces (DEAD-SURFACES-01's own next action), then the token pair
- Recover: `git grep -n "chat/chat.html\|memory/explorer.html" -- extension`
- History:
  - 2026-08-30 11:00 UTC — measured: Artifacts 224 px gutter, Directory 272 px, memory explorer 294 px; the embedded Artifacts view shows a "← Back | Artifacts" bar plus an "Artifacts" H1 twenty pixels below it; Settings shows a second brand header under the frame bar.

## [CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01] The slash palette is not an accessible combobox
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 8
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: while a `/` or `@` palette is open the composer textarea carries `role="combobox" aria-autocomplete="list" aria-expanded aria-controls aria-activedescendant`, option ids are stable, and the highlighted option is announced (`extension/shared/components.js` `agent-composer`, `extension/shared/composer-commands.js`). Done = `scripts/a11y-audit.ts` gains a check that opens `/`, presses ArrowDown and asserts `aria-activedescendant` names the highlighted option, and the same for `@`. Falsification: the new check is RED on the current tree
- Review: pending
- Gates: a11y audit; Chrome journeys (composer commands); full suite green
- Blockers: —
- Next: add the ARIA wiring; the `+` menu is the correct reference implementation
- Recover: `git grep -n "role=\"listbox\"\|role=\\'listbox\\'" -- extension/shared/components.js`
- History:
  - 2026-08-30 11:00 UTC — measured: listbox present with 8 options and a visual highlight, textarea `role=null`, `aria-expanded=null`, `aria-activedescendant=null`; the `+` menu is a textbook accessible menu by contrast.

## [CAP-FB-20260830-HUB-CHROME-POLISH-01] Hub chrome: Settings styled as the primary button, agent id as title, a zero-width directory card, developer icons in the header
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane findings 9, 11, 15 and 19
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: (1) the sidebar Settings button is `btn ghost foot-btn` like Directory and Artifacts (`extension/ntp/ntp.html:844`) and the three footer entries get a real selected state (`aria-current="page"` + `--panel-2` fill) when their view is open; (2) `applyCurrentHashRoute` (`extension/ntp/ntp.js` near L1900-1930, L3395) resolves the agent record before rendering the title so `#agent=named:writer` shows "Writer", never the slug, with a journey assertion; (3) `<tool-directory-card>` gets `inline-size:100%` (or `align-self:stretch`) beside `container-type:inline-size` and `scripts/component-gallery-smoke.ts` asserts every specimen's width exceeds 200 px; (4) the header status becomes a single pill that appears only when NOT ready ("Connect a model", "Working…", "Needs approval") and the shield and console triggers move into Settings (Security → Permissions; Advanced → Diagnostics) or behind a developer shortcut. Done = on the idle hub no footer button is filled, the header has no status text, no dot and at most one icon button; the gallery smoke fails on a zero-width specimen. Cut: the console trigger on the hub
- Review: pending
- Gates: Chrome journeys; gallery smoke; the impeccable design pass
- Blockers: —
- Next: the four are independent; land (1) and (2) first
- Recover: `git grep -n "open-settings" -- extension/ntp/ntp.html`
- History:
  - 2026-08-30 11:00 UTC — measured: Settings is solid teal on every screen; the agent view header reads "writer" while the dialog reads "Edit Writer"; the directory card specimen measured 0 px wide and 3,599 px tall; the header carries an amber "ready" dot plus shield and terminal popovers with no dialog/menu role.

## [CAP-FB-20260830-USER-VOICE-COPY-01] Copy: system language throughout the empty states, toggles and delete dialogs
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane findings 22, 13 and 20. Extends CAP-FB-20260828-NOUN-DISCIPLINE-01 (nouns done; this is the verb/voice half)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a copy pass on every empty state and toggle description to "what you can do next" in second person, one sentence (`extension/ntp/ntp.html`, `extension/options/options.html`); one `deleteAgentDialog(agent)` helper in `extension/shared/components.js` replaces the three bodies at `extension/ntp/ntp.js:783,2880-2900` and `extension/options/options.js:1473` ("Delete Writer? Its memory and history are removed. Artifacts it made are kept."); the demo provider's reply is a real sentence; `catalog generation <hash>` moves behind Diagnostics detail. Done = `scripts/check-vocabulary.mjs` gains the words discovery, diagnostics, catalog, generation, registry, attestation, alarm, runtime, lifecycle, chars, override and "has not run" for user-facing strings outside Settings → Advanced, and passes. Falsification: the widened checker is RED on the current tree
- Review: pending
- Gates: `check:vocabulary`; Chrome journeys; the impeccable design pass
- Blockers: —
- Next: widen the checker with a baseline, then burn the list down
- Recover: `git grep -n "Discovery has not run" -- extension`
- History:
  - 2026-08-30 11:00 UTC — measured strings: "Discovery has not run yet.", "Keep the key — Storage is available.", "Site Agent diagnostics — Technical details for tool discovery on enrolled sites", "200 tools visible to diagnostics · catalog generation e0b8…", three delete-dialog bodies naming "registry entry", "system prompt override" and "recurring alarm".

## [CAP-FB-20260830-SIDE-PANEL-COMPANION-01] The side panel is a WebMCP status surface, not a companion bound to the current tab
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 18, product lane finding 8
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the side panel (`extension/sidepanel/sidepanel.html`, `extension/sidepanel/sidepanel.js`) opens on the CURRENT tab's origin (favicon + host) with its tool state and a conversation pinned to that tab — `read_page` of that tab implicit, that origin's WebMCP tools and any page-action tools offered first, the activity ledger for this tab with Undo, and "Continue in hub"; the URL field becomes a secondary "Open another site…" action; one `H1` (the second is removed, the label visually hidden); buttons do not wrap at 360 px (`white-space:nowrap`, icon-only fallback under 380 px); the numbered instructions card is cut. Done = on any page, open the panel (Alt+Shift+S), ask "what is this page and what can you do here", get an answer that lists the origin's tools; ask it to act; see the action logged
- Review: pending
- Gates: Chrome journeys; a11y pass (one H1); the impeccable design pass
- Blockers: Depends on CAP-FB-20260830-PAGE-ACTION-TOOLS-01 and CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01 (must land first — the companion's value is acting and logging); the layout fixes (H1, wrapping) may land alone first
- Next: land the layout fixes now; the companion after page actions
- Recover: `git grep -n "Open site" -- extension/sidepanel`
- History:
  - 2026-08-30 11:00 UTC — measured: "Side / panel" and "Open / site" wrap to two lines at 400 px; two H1s; the panel's first control asks the user to type a URL though it opened on a tab; the Agents tab lists the 22 disabled templates.

## [CAP-FB-20260830-ICONOGRAPHY-GAPS-01] Skills without icons, menus without icons, 38 uppercase kickers in the gallery
- Feedback: 2026-08-30 — reanalysis 2026-08-30 ui lane finding 23
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P3
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: every skill in `extension/skills/` declares an icon from `extension/shared/skill-icons.js` (fallback a generic skill glyph, never an empty slot); the `+` menu items get the same icons the `/tabs`, `/files`, `/agent` palette entries use (`extension/shared/components.js` `attach-button`); the gallery's specimen headings become sentence-case `<h3>` with the tag in `<code>` (`docs/components.html`). Done = no skill row renders an empty icon slot; the gallery has zero uppercase headings, asserted by `scripts/component-gallery-smoke.ts`
- Review: pending
- Gates: gallery smoke; `check:gallery`; the impeccable design pass
- Blockers: —
- Next: the icon declarations
- Recover: `git grep -n "text-transform: *uppercase" -- docs/components.html | wc -l`
- History:
  - 2026-08-30 11:00 UTC — measured: 2 of 7 visible skills have an icon; seven text-only `+` menu items; 38 uppercase tracked kickers in the gallery that `docs/DESIGN.md` bans.

## [CAP-FB-20260830-EXEC-BUILD-FLAG-01] A developer flag that hides the platform lanes from the default surface
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane findings 13 and 19
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a Settings → About → "Show developer features" flag, default off, gates: the Tool library's Wasm rows, Board permissions, Hooks, Advanced (system prompts), Provider server tools, the `@demo-*` markers, run-log attestation rows, the cookie value tools and `run_script` until gated. Done = a fresh profile's Settings nav shows Providers · Agents · Permissions · Skills · Usage · Data · About; the tool library lists browser and work tools only; nothing on the hub references the board; no code is deleted and the Wasm lane keeps its tasks at P2. Cut verdict: yes from the default surface, not from the repository
- Review: pending
- Gates: Chrome journeys (the board and hooks journeys set the flag); full suite green
- Blockers: —
- Next: the flag and the nav filter
- Recover: `git grep -n "board-permissions\|data-section=\"hooks\"" -- extension/options/options.html`
- History:
  - 2026-08-30 11:00 UTC — measured: "Board permissions" is the second item an exec sees in the Settings nav; the hub demo flows never touch any of the gated lanes.

## [CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01] A scheduled agent runs but leaves nothing behind
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 9. Related: CAP-FB-20260829-BACKGROUND-RUN-TRANSCRIPT-01
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: every scheduled run produces a report artifact (or appends to a rolling one) and a hub timeline entry "Tab Reporter ran 3 min ago — 4 tabs grouped, 1 note saved — Open", with an optional notification (the permission is already optional; the icon path fix is CAP-FB-20260830-NOTIFY-ICON-PATH-01). Done = create an agent with a one-minute schedule, wait one interval, reopen the new tab and see the run summary at the top of the hub without navigating; the artifact opens; the journey drives it with the scheduler's test clock
- Review: pending
- Gates: Chrome journeys; full suite green
- Blockers: Depends on CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01 (must land first — the timeline entry and the run banner share the run-state model); the artifact half may land alone
- Next: the report artifact on run completion
- Recover: `git grep -n "agent:" -- extension/lib/scheduler.js | head -3`
- History:
  - 2026-08-30 11:00 UTC — measured: the alarm fired within 60 s and `run.list` shows the execution, but the hub afterwards shows "No tasks yet", an empty Recent activity until refreshed, no artifact and no notification.

## [CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01] Multi-tab tasks have no visible plan or checkpoints although durable runs exist underneath
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 18
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a plan strip at the top of a running thread — steps the model declared (a `plan` tool or the first assistant message), the current step, tabs touched, pause/resume/stop — backed by the run registry in `extension/lib/durable-runs.js` (today the only UI is the hidden `<durable-run-registry>` under Run logs, `extension/ntp/ntp.html:950-952`); on interruption the run resumes from the registry rather than re-running. Done = a three-site task shows three steps advancing; closing and reopening the new tab mid-run shows the same strip resuming, driven in the journey suite with the demo provider's slow marker
- Review: pending
- Gates: Chrome journeys; a11y pass; the impeccable design pass
- Blockers: Depends on CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 (must land first — the strip and the cards share the step model)
- Next: define the plan event shape in the run log
- Recover: `git grep -n "durable-run-registry" -- extension/ntp/ntp.html`
- History:
  - 2026-08-30 11:00 UTC — a thread is a flat transcript with a Stop button; the durable-run architecture doc describes exactly the registry the strip needs.

## [CAP-FB-20260830-ON-DEVICE-PATH-01] No Chrome-native on-device path: the Prompt API adapter cannot call tools
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 16
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a hybrid — Gemini Nano via the Prompt API (structured output) for summarise/classify/extract steps and the keyless first result, a hosted model for planning and tool use (`extension/lib/models/prompt-api-model.js:55-62,152-200` today flattens tool calls into text and always returns `finishReason:"stop"`; `extension/lib/provider.js:200-208` falls back to demo). Done = with a Prompt-API-capable Chrome and no key, "summarise this page" and "group my tabs by topic" work on-device and the transcript labels which model did what
- Review: pending
- Gates: a headed run on a Prompt-API-capable Chrome (record the version); full suite green
- Blockers: Depends on CAP-FB-20260830-KEYLESS-FIRST-RESULT-01 (must land first)
- Next: after the keyless path, route text-only steps to the Prompt API when available
- Recover: `git grep -n "finishReason" -- extension/lib/models/prompt-api-model.js`
- History:
  - 2026-08-30 11:00 UTC — built-in local models were removed at 0.2.307; Q12 remains open.

## [CAP-FB-20260830-AGENT-SHARING-01] Sharing and handoff do not exist: agent cards and import
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 20. Related: CAP-FB-20260825-DATA-EXPORT-IMPORT-01
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: "Share agent" produces a JSON card (name, role, skills, schedule; no memory, no keys) as a file or an extension import link; "Import agent" on the create dialog; `extension/lib/agent-cards.js` is adopted or deleted in CAP-FB-20260830-DEAD-CODE-CUT-01. Done = export on one profile, import on another, the agent runs identically, driven in the journey suite
- Review: pending
- Gates: Chrome journeys; security review of the import path (no keys, no memory, no code); full suite green
- Blockers: —
- Next: define the card schema
- Recover: `git grep -n "agent-cards" -- extension`
- History:
  - 2026-08-30 11:00 UTC — `docs/AGENT-PRODUCT-GAPS.md` G7 "not shareable"; nothing in the UI exports a card.

## [CAP-FB-20260830-SITE-PLAYBOOKS-01] Skills are global and never bound to an origin
- Feedback: 2026-08-30 — reanalysis 2026-08-30 product lane finding 21
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P2
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a skill may declare `origins` patterns; the side-panel companion offers matching skills on that site; the site-agent record gains a note field ("on this site, always…"). Done = a "GitHub triage" playbook shows only on github.com and is used by the model there, driven with the fixture origin in the journey suite
- Review: pending
- Gates: Chrome journeys; full suite green
- Blockers: Depends on CAP-FB-20260830-SIDE-PANEL-COMPANION-01 (must land first)
- Next: the `origins` field on the skill record
- Recover: `git grep -n "requiredCapabilities" -- extension/lib/recipes.js | head -3`
- History:
  - 2026-08-30 11:00 UTC — `docs/AGENT-PRODUCT-GAPS.md` G4.

## [CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01] The real answer is replaced by the nudge summary and the persisted transcript is clipped to 240 characters
- Feedback: 2026-08-30 — reanalysis 2026-08-30 live lane finding 1 (reproduced on gpt-4.1, gemini-2.5-flash and grok-4.3)
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: every assistant text part of a run is persisted as a thread message in order (or at minimum the first substantive text is kept and the terminal appended), never the 240-char `terminal.summary` (`extension/lib/durable-runs.js:45,82-85,1524-1535` `MAX_PREVIEW_CHARS`); the back-fill in `extension/lib/thread-run-view.js:121-141` prefers `terminal.result` (16 KB) and never commits a preview as content via `commitTerminal`; the agent-do nudge reply is suppressed or hidden when the step before it already ended in text (or the loop stops on text-without-tool-calls instead of nudging — coordinate with CAP-FB-20260830-MODEL-CALL-ECONOMY-01). Done = journey: "list my open tabs" → reload the thread → the tab list is still the visible assistant message at full length; a unit test that reverts to summary-first goes RED. Cut candidate: the nudge — replace with a stop-when-text-without-tool-calls condition. Files also: `extension/lib/agent.js`, `extension/lib/threads.js`
- Review: pending
- Gates: unit (summary-first RED); journey; full suite green
- Blockers: —
- Next: change the back-fill preference and persist intermediate text; then the nudge
- Recover: `git grep -n "MAX_PREVIEW_CHARS" -- extension/lib/durable-runs.js extension/lib/thread-run-view.js`
- History:
  - 2026-08-30 11:00 UTC — measured live: gpt-4.1 rendered the tab list (259 chars) at +4.9 s; ~3 s later the nudge step produced "Here's a summary of what I've done…" and on re-render the tab list was gone; the 4,540-char HTML answer persisted as 299 chars ending in an ellipsis; Gemini persisted "I have completed the task of listing your open tabs." The loss is permanent — the 240-char string is committed as the thread's terminal message.

## [CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01] execute_tool burns the single-use selectionRef before validating arguments
- Feedback: 2026-08-30 — reanalysis 2026-08-30 live lane finding 2. Related: CAP-FB-20260829-TOOL-ARGUMENT-ROBUSTNESS-01
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P0
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a validation failure does not consume the selection — claim after validate, or return the same selectionRef in the error with `retryable:true` (`extension/lib/tool-selection.js:264-283` `claim()` deletes the record before `extension/lib/lazy-tool-protocol.js:683` reaches the validator); the `search_tools` schemaSummary states enums in a form models copy (they wrote `text/html` because the summary says `type: html|text|json|image|data` in prose). Unit test: invalid args then valid args with the same ref succeeds. Done = the Gemini bakery transcript ends with an artifact on the first turn. Falsification: the unit test is RED on the current tree (`selection-replayed`)
- Review: pending
- Gates: unit; the scripted-provider journey with a first-call schema slip; full suite green
- Blockers: —
- Next: move the claim after validation
- Recover: `git grep -n "selection-replayed" -- extension/lib`
- History:
  - 2026-08-30 11:00 UTC — measured: `lazy-arguments-invalid` (enum) then `selection-replayed` on the corrected retry; the run ended with two tool cards and no assistant text, and the operating manual forbids searching twice.

## [CAP-FB-20260830-MODEL-TOOL-ADHERENCE-01] With gpt-4.1 "make me a website" never creates an artifact and "remember X" is answered with a lie
- Feedback: 2026-08-30 — reanalysis 2026-08-30 live lane finding 4
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: the handful of first-class verbs are exposed directly as real tools on every call (`create_asset`, `update_asset`, `memory_set`, `memory_get`, `open_tab`, `list_tabs`, `read_page`, `capture_screenshot`) with the lazy catalogue kept for the long tail (`extension/lib/agent.js:1265-1290`, `extension/lib/lazy-tool-protocol.js`); or a post-step check re-prompts a "remember"/"make me" task that produced zero tool calls with the concrete tool. Done = "make me a bakery site", "remember my favourite colour is green" and the new-thread recall produce an asset and a memory key with both gpt-4.1 and gemini-2.5-flash in a keyed journey (recorded once with real keys), and with the scripted provider in the suite
- Review: pending
- Gates: the scripted-provider journey; one recorded keyed run; full suite green
- Blockers: Depends on CAP-FB-20260830-CLAIM-CHECK-BROWSER-TOOLS-01 and CAP-FB-20260830-MODEL-CALL-ECONOMY-01 (must land first — first-classing tools changes the prompt budget and the claim check catches the lie meanwhile)
- Next: first-class the eight verbs
- Recover: `git grep -n "search_tools" -- extension/lib/agent.js | head -3`
- History:
  - 2026-08-30 11:00 UTC — measured on the wire: the only tools sent are `search_tools`, `list_tools`, `execute_tool`; gpt-4.1 pasted 4.5 KB of HTML into chat twice and claimed "I have saved" with no tool call; Gemini and Grok followed the manual.

## [CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01] Memory is write-only in practice: the model never reads it in a new thread
- Feedback: 2026-08-30 — reanalysis 2026-08-30 live lane finding 9
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: a bounded memory digest (keys plus summaries, for example `owner-preferences`) is injected into the runtime-context layer of every hub prompt (`extension/lib/system-prompts.js`), and/or `memory_grep(task)` runs deterministically before the first model call with hits attached as context. Done = the two-thread journey ("remember my favourite colour is green" then, in a new thread, "what is my favourite colour?") answers "green" with the scripted provider and, recorded once, with two real providers
- Review: pending
- Gates: the two-thread journey; the prompt-budget unit test from CAP-FB-20260830-MODEL-CALL-ECONOMY-01 still passes; full suite green
- Blockers: —
- Next: the digest in the runtime-context layer
- Recover: `git grep -n "memory_grep" -- extension/lib/system-prompts.js`
- History:
  - 2026-08-30 11:00 UTC — measured: Gemini wrote `owner-favourite-colour`, then in a fresh thread answered "I do not know" with one call and no tool call; nothing in the request carried any memory content.

## [CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01] Typing a model name without picking it saves model:"" and the hub silently runs the demo model
- Feedback: 2026-08-30 — reanalysis 2026-08-30 live lane finding 7 (real Settings UI, real clicks). Extends CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01
- Updated: 2026-08-30 11:00 UTC
- Status: OPEN
- Resume: —
- Priority: P1
- Owner: unassigned
- Workspace: none
- Branch: none
- Base: `fc2255be`
- Candidate: —
- Shipping: —
- Acceptance: `<model-picker>` commits the typed text on blur/Enter/Use (value = input text when no option is chosen; `extension/options/options.js:705-707` `effectiveModel()` reads `picker.value` which the component sets only on selection); `provider.set` and `provider.status` fail (`ok:false, reason:"model id missing"`) for a keyed provider without a model; the hub never falls back to the demo model once a real provider is selected — it shows the Settings remediation bubble instead. Done = type "gpt-4.1", click Use, run → a real answer; save with an empty model → red status in Settings and in the hub. Falsification: the `provider.status` unit assertion is RED on the current tree (`ok:true` with `model:""`)
- Review: pending
- Gates: unit; the Settings provider journey; full suite green
- Blockers: —
- Next: the picker commit-on-blur and the status check
- Recover: `git grep -n "effectiveModel" -- extension/options/options.js`
- History:
  - 2026-08-30 11:00 UTC — measured: key typed, "gpt-4.1" typed with the suggestion list open, Use → "Set OpenAI as default.", `provider.get → {model:"", hasApiKey:true}`, `provider.status → ok:true`, hub strip "ready", run → "[demo model] Task received". Only "Test connection" noticed.
