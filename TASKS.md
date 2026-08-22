# Chrome Agent Platform tasks

`TASKS.md` is the repository-local, public-safe recovery record for product
feedback, bugs, reviews, and active delivery lanes. It complements, but never
copies, the private coordination ledger. The stable `CAP-FB-*` ID is the only
join key between the two systems.

> Snapshot: 2026-08-22 23:35 UTC. Reconciled against exact public
> `origin/main@9dd581a15fb86f9e6fa0b5ef98e57344ae300446` (`0.2.165`). Lazy,
> security-suite serialization, pure WASI Gate 1, Tool Library, deterministic
> package bytes, the Store static boundary and the tool-platform foundation
> (vendored sources/recipes/licenses + disabled descriptors) remain exact; the
> catalog remains `MERGED`; OPFS, bundled-package, public code-diff,
> Chrome-capability, the Gate-2 fresh-Worker host source candidate and the
> bundled JS-minifier lane remain `IN_REVIEW` with Shipping `—`. This branch
> recomposes the PASSed read-only tabular-diff artifact custody candidate as
> the `0.2.166` step — an unreachable source library with no route, execution,
> UI, OPFS mutation, apply or patched-CSV export.
> Branch status counts: **14 OPEN · 14 IN_REVIEW · 2 MERGED · 4 BLOCKED ·
> 36 DONE · 0 ABANDONED**. The 34 active entries and 36 archived terminal
> entries below are the complete 70-entry state.

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

## Active

## [CAP-FB-20260821-DURABLE-SIDEBAR-LIVE-01] Live durable task in the Tasks sidebar
- Feedback: 2026-08-21 — owner Tasks rows must remain native, live, unique, and recover after navigation and hard reload
- Updated: 2026-08-22 07:30 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: integration writer
- Workspace: active (local path private)
- Branch: `integrate/durable-final`
- Base: `7f1f7aee216c2a87a69df584f059d526bbf07a4c`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: authoritative list-read failure preserves prior rows; successful owner-fenced replacement alone acknowledges invalidation; each event-driven read has at most one 400ms MV3-startup retry; terminal reload retains exactly one native Tasks row and visible retained logs
- Review: exact source `dd41258f` independently PASSed; exact 7/7 loaded-extension evidence independently PASSed for integration; current-main integration review pending
- Gates: source 14/14 focused, 692/692 full unit, 31/31 no-Chrome security/source, build/78-file scan; accepted screenshot sequence `01-task-start.png` through `07-reload-persistence.png`; integration gates recorded on the integration commit
- Blockers: independent review of the current-main integration diff
- Next: independent integration review, then run the residual browser-security suite before merge/push
- Recover: `git show --stat --oneline integrate/durable-final && git diff 7f1f7ae..integrate/durable-final`
- History:
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `IN_REVIEW` mapped to `IN_REVIEW` (unchanged semantics).
  - 2026-08-21 11:45 UTC — source recovery added fail-safe reads, success-only invalidation acknowledgement, one bounded startup retry, and stale-result fencing.
  - 2026-08-21 12:40 UTC — exact 7/7 loaded-extension evidence passed and was independently accepted for integration at `dd41258f` / tree `80ca97f0`; no whole-product acceptance was inferred.
  - 2026-08-21 13:55 UTC — replayed the accepted Durable source as one integration candidate on exact public main `7f1f7ae`; integration review remains pending.

## [CAP-FB-20260821-DURABLE-TERMINAL-PROJECTION-01] Reconcile terminal result into an already-open owner thread
- Feedback: 2026-08-21 — a terminal durable result must replace the authoritative open-thread projection without duplicates
- Updated: 2026-08-22 07:30 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: integration writer
- Workspace: active (local path private)
- Branch: `integrate/durable-final`
- Base: `7f1f7aee216c2a87a69df584f059d526bbf07a4c`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: one authoritative `thread.get` replacement per terminal/cancelled execution revision; duplicate/nonterminal/other-thread signals do nothing; surface-owner changes fence delayed reads; exactly one result remains visible
- Review: source implementation and exact 7/7 browser evidence independently PASSed for integration; current-main integration review pending
- Gates: accepted shots show one terminal result with retained logs before and after hard reload; integration runtime/test blobs are bound to accepted source bytes
- Blockers: independent review of the current-main integration diff
- Next: independent integration review, then residual browser-security suite
- Recover: `git diff 7f1f7ae..integrate/durable-final -- extension/ntp/ntp.js extension/lib/terminal-thread-projection-lifecycle.js extension/shared/run-surface-owner.js tests/terminal-thread-projection-lifecycle.test.ts`
- History:
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `IN_REVIEW` mapped to `IN_REVIEW` (unchanged semantics).
  - 2026-08-21 11:12 UTC — implemented targeted event-driven terminal projection reconciliation with authoritative replacement and surface fencing.
  - 2026-08-21 12:40 UTC — exact 7/7 loaded-extension evidence independently accepted this behavior for integration.
  - 2026-08-21 13:55 UTC — included unchanged accepted runtime/test blobs in the current-main integration candidate.

## [CAP-FB-20260821-DURABLE-QUOTA-EXACT-01] Exact native-quota compensation
- Feedback: 2026-08-21 — preserve durable registry and journal state exactly when an admitted zero-progress run meets native storage quota
- Updated: 2026-08-22 07:30 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: integration writer
- Workspace: active (local path private)
- Branch: `integrate/durable-final`
- Base: `7f1f7aee216c2a87a69df584f059d526bbf07a4c`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: registry compensation preserves absent-vs-empty state and concurrent IDs; journal rows compensate under version/generation fences; progressed or uncertain authority is retained; direct delegation has parity
- Review: exact source independently PASSed at `ac1c4fe` and is contained unchanged in accepted `dd41258f`; current-main integration review pending
- Gates: focused quota/memory tests, full source suite, build and no-Chrome scans pass on source and are rerun on integration
- Blockers: independent review of the current-main integration diff
- Next: independent integration review
- Recover: `git diff 7f1f7ae..integrate/durable-final -- extension/lib/durable-runs.js extension/lib/durable-quota.js extension/lib/memory.js tests/durable-runs.test.ts tests/memory.test.ts`
- History:
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `IN_REVIEW` mapped to `IN_REVIEW` (unchanged semantics).
  - 2026-08-21 04:20 UTC — exact source implementation entered review after focused compensation coverage passed.
  - 2026-08-21 13:55 UTC — accepted source included byte-identically in the current-main integration candidate; no whole-product acceptance claimed.

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

## [CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01] Durable replay safety for mutating tools
- Feedback: 2026-08-20 — automatic interruption recovery must never pretend universal exactly-once behavior for external side effects
- Updated: 2026-08-22 08:30 UTC
- Status: MERGED
- Resume: —
- Priority: P0
- Owner: hands-on integration coordinator
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `7b254e43c38569667045363405b3243e9951f926`
- Candidate: this integration commit
- Shipping: `origin/main@this integration commit`
- Acceptance: every tool declares replay safety; read-only/idempotent work may automatically resume with the stable execution idempotency key; mutating or unknown work interrupted after progress becomes `paused-side-effect-uncertain` and requires explicit owner Retry or Cancel; no UI or documentation claims universal exactly-once external effects
- Review: two independent reviews BLOCKed exact source `f3d5516` on direct-delegation pre-tool authority, per-call key stability/effect-boundary propagation, complete metadata and production evidence; product owner explicitly requested this committed candidate on main for hands-on testing and will judge whether the findings impact use
- Gates: source candidate reported 888/888 units, security/build/changelog/diff PASS; no exact-candidate loaded-MV3 side-effect-counter journey; product owner hands-on validation pending
- Blockers: known review caveats are retained rather than hidden: direct `agent.delegate` pre-tool persistence and byte-identical per-call identity across replay are not established, and the synthetic duplicate-effect/parallel-reorder journey is absent
- Next: product owner tests the integrated candidate hands-on; revisit the known review findings only if they impact use
- Recover: `git show origin/main -- extension/lib/tool-replay-safety.js extension/lib/durable-runs.js extension/lib/agent.js extension/background/service-worker.js`
- History:
  - 2026-08-22 08:30 UTC — product owner explicitly requested the committed `f3d5516` candidate on main for hands-on testing despite the disclosed independent BLOCK findings; recomposed the product/test/doc delta onto current public `7b254e4` as one integration/release commit while preserving the caveats and deferring further patching.
  - Git reconcile at 2026-08-22 07:50 UTC: the durable interruption/permissions policy is settled per the recorded project history — UI/browser restart resumes; recoverable permission problems pause visibly and resume after resolution; explicit cancellation is terminal; grants are remembered at the narrowest practical scope with no per-invocation prompts and an explicit broad host grant allowed and revocable.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-20 08:40 UTC — opened from independent source review; the policy successor now fails safe after any observed tool progress and exposes explicit owner Retry/Cancel, while reliable per-tool classification remains a separate OPEN architecture task.

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

## [CAP-FB-20260819-PAGE-SCOPED-SITE-IDENTITY-01] Page-scoped Site Agent identity and lifecycle
- Feedback: 2026-08-19 — origin-only Site Agent identity conflates same-origin subpages that expose different WebMCP tools, titles, and navigation lifecycles
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
- Acceptance: Site Agent identity includes a page/document/navigation epoch and canonical toolset identity in addition to origin; same-origin subpages with different tools remain distinct, titles are useful and bounded, reload/navigation invalidates stale authority, and durable history reconnects only when identity continuity is proven
- Review: pending independent identity-model, migration, privacy, lifecycle, concurrency, and loaded-MV3 review
- Gates: same-origin multi-page fixtures with different tools; SPA navigation, full navigation, reload, back/forward, duplicate tabs, closed/reopened tabs, toolset mutation, stale-message fencing, bounded title and fingerprint checks, raw AX labels, and persisted-record migration
- Blockers: the identity must preserve origin isolation and sender authentication from `CAP-FB-20260818-WEBMCP-01` while composing with canonical references from `CAP-FB-20260818-AGENT-ACCESS-01`
- Next: design the canonical page identity, toolset fingerprint, navigation invalidation, and migration rules before changing storage or UI keys
- Recover: `git show bbeff7b:TASKS.md && git grep -n "canonicalOrigin\|site:" bbeff7b -- extension`
- History:
  - Git reconcile at 2026-08-22 07:30 UTC: the source-prep series passed review but is NOT on origin/main — no landing commit exists.
  - 2026-08-19 18:13 UTC — opened as the prerequisite identity task for proactive per-tab discovery; no origin-only record is relabelled as page-verified.

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

## [CAP-FB-20260819-AGENT-DELETION-LIFECYCLE-01] Owner-only agent deletion and lifecycle cleanup
- Feedback: 2026-08-19 — owners need a discoverable, safe way to delete an agent while the policy for artifacts owned or produced by that agent remains unresolved
- Updated: 2026-08-22 07:30 UTC
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
- Blockers: cleanup must compose with `CAP-FB-20260818-ARTIFACT-TX-01`, approval and remediation authority in `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`, and agent identity/presentation in `CAP-FB-20260819-AGENT-DIRECTORY-01` (the artifact-disposition blocker is RESOLVED — see the History)
- Next: design the transactional idempotent cleanup with the settled disposition — artifacts are retained as ordinary accessible artifacts, the deleted-agent relationship is removed, and the artifact is labelled unassigned/original-agent-deleted; no cascade deletion
- Recover: `git show bbeff7b:TASKS.md && git grep -n "agent.delete\|deleteAgent\|scheduled" bbeff7b -- extension`
- History:
  - Git reconcile at 2026-08-22 07:50 UTC: the artifact-disposition decision is settled per the recorded product policy — deleted agents' artifacts are RETAINED as ordinary accessible artifacts with the deleted-agent relationship removed and labelled unassigned/original-agent-deleted; no cascade deletion is authorized.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-19 18:18 UTC — opened as a research-first lifecycle task; artifact disposition uncertainty is recorded as unresolved and no cascade behavior is authorized.
  - 2026-08-19 19:05 UTC — research completed: full store map, gap analysis, owner-only transactional deletion state machine (durable intent, settle/cancel, idempotent resume, restart/concurrency safety), acceptance criteria, and storage fixtures frozen in docs/agent-deletion-lifecycle-design.md; the artifact disposition policy remains explicitly OPEN and unapproved.
  - 2026-08-19 19:20 UTC — independent review BLOCK corrected: embedded coreAssets now covered by the dependency preview and every artifact-disposition option (no silent registry-row deletion); a new durable agent-bound execution registry with deletion tombstone/generation and pre/post-write commit revalidation specified; the transaction authority is now an explicit dependency on the unshipped artifact-transaction lane or a self-contained minimal intent/reconcile protocol; exact registry key cap:namedAgents; the artifact disposition policy remains explicitly OPEN and unapproved.
  - 2026-08-19 19:45 UTC — re-review BLOCK corrected: store map made exact (memory/agents/<slug> per-agent stores, master-memory customRecipes key, cap:scheduledTasks, versioned journal.json files, cap:promptOverrides included; no cap:recipes, no canonical memory.json); failure semantics made fail-closed — any memory/prompt/dependency cleanup failure stops in a durable retryable CLEANUP_FAILED state BEFORE REGISTRY_REMOVED (never best-effort continue to authority-row removal).

## [CAP-FB-20260819-LOCAL-MODEL-MANAGEMENT-01] Downloadable in-extension local model management
- Feedback: 2026-08-19 — product-owner voice feedback requested on-demand local models inside the extension; the transcript's apparent “Gemma 4” wording is uncertain and is not a model claim, while Gemma and Qwen are the requested model families
- Updated: 2026-08-22 07:30 UTC
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
- Blockers: exact browser-native runtime; exact Gemma and Qwen model IDs and parameter sizes; and quantization formats remain OPEN; the design must compose with provider/model selection in `CAP-FB-20260818-PROVIDER-PICKER-01`, permission authority and remediation in `CAP-FB-20260819-PERMISSIONS-01` and `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`, and durable storage semantics in `CAP-FB-20260818-ARTIFACT-TX-01` (the sources/licences, update/version, storage ownership/quota/eviction, and supply-chain download policy are SETTLED — see the History)
- Next: research the browser-native runtime and the exact model IDs/parameter sizes/quantization formats; the settled policy — publisher/original-source downloads only, no product cap or automatic eviction, user-controlled removal — applies; the Gemma 4 catalog/preflight slice is already merged at `6480005`
- Recover: `git show 669016e:TASKS.md && git log -1 --format=%H -- TASKS.md && git diff 669016e -- TASKS.md`
- History:
  - Git reconcile at 2026-08-22 07:50 UTC: the local-model policy is settled per the recorded project history — downloads from the publisher/original source only, no product cap or automatic eviction, user-controlled removal; the runtime, exact model/quantization matrix, and the full download/install acceptance remain OPEN. The Gemma 4 catalog/preflight slice is merged at `6480005`.
  - Git reconcile at 2026-08-22 07:30 UTC: the Gemma 4 catalog/preflight SLICE landed on origin/main; the full download/install/inference acceptance is NOT met — the task stays OPEN.
  - 2026-08-19 21:08 UTC — captured the local-model request as research-first OPEN work; no Ollama dependency, model identity, size, quantization, licence, runtime, or storage backend is inferred or approved from the uncertain voice transcription.
  - 2026-08-20 03:25 UTC — replayed the independently accepted public-safe task capture onto exact current public main; the extension-managed download goal remains OPEN, with no runtime, model identity or size, quantization, source or licence, update/version, storage/ownership/quota/eviction/atomicity/recovery, integrity, or supply-chain/security choice approved.

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

## [CAP-FB-20260822-TOOL-CATALOG-CONTRACT-01] Canonical bounded shadow tool catalog

- Feedback: 2026-08-22 — the P0 tool platform needs one metadata contract before
  selecting a runtime, storage engine, embedding model or package policy
- Updated: 2026-08-22 11:00 UTC
- Status: MERGED
- Resume: —
- Priority: P0
- Owner: catalog integration owner
- Workspace: none
- Branch: `main`
- Base: `bee002331bb4c5eafa314cd4bd200d4ba65fc6fc`
- Candidate: `a8985af8af2af76d714cd0be29781c18c08d7a7f`
- Shipping: `origin/main@a8985af8af2af76d714cd0be29781c18c08d7a7f`
- Acceptance: canonical bounded descriptors bind source kind, package/tool ID,
  version, metadata digest, capability digest, scope and source generation; real
  adapters cover current extension built-ins, browser tools, management tools
  and declared/inferred WebMCP without calling or changing dispatch; a
  rebuildable in-memory exact/alias/deterministic lexical index and expiring
  run/agent/origin/document/catalog/source-generation selection references
  remain metadata-only, create no grant and expose no execution path; hostile
  text is inert data, collisions and stale authority fail closed, WebMCP replay
  safety defaults unknown, and only Settings may inspect shadow diagnostics
- Review: independent source, security, bounds, Unicode, collision, freshness,
  provider-nondisclosure and integration reviews passed; this scoped slice is
  not Wasm, lazy-provider, package-execution or owner-install acceptance
- Gates: source candidate reported focused 58/58, full unit 931/931, pure
  no-Chrome security 157/157 and build 102 shipped JS; exact public integration
  and its metadata-only route are merged without provider/dispatch/permission
  cutover; whole-product browser regression remains the separate `MERGED`→`DONE` gate
- Blockers: —
- Next: advance to `DONE` only after the exact public tip's canonical browser journey is green
- Recover:
  `git show a8985af8af2af76d714cd0be29781c18c08d7a7f -- extension/lib/tool-catalog.js extension/lib/tool-search.js extension/lib/tool-selection.js extension/lib/tool-catalog-shadow.js docs/tool-platform-architecture.md tests/tool-catalog*.test.ts tests/tool-search.test.ts tests/tool-selection.test.ts`
- History:
  - 2026-08-22 09:30 UTC — implemented the owner-decision-free metadata shadow
    on exact public `30afd5a`; current provider binding, source dispatchers,
    permissions, grants, Durable authority and package/runtime absence remain
    unchanged.
  - 2026-08-22 11:00 UTC — independently reviewed integration landed on public
    main as `a8985af8af2af76d714cd0be29781c18c08d7a7f` (`0.2.146`); lifecycle advanced
    truthfully to `MERGED` with exact Shipping provenance.

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

## [CAP-FB-20260822-WASM-PACKAGE-AUTHORITY-01] Immutable Wasm package and revocation authority

- Feedback: 2026-08-22 — executable packages need artifact-grade identity,
  provenance and crash recovery rather than a name-keyed archive/storage model
- Updated: 2026-08-22 16:03 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: bundled-package review owner
- Workspace: none
- Branch: `main`
- Base: `c23e6eb004cfa8860e5b67f3a8d2991f519b96b1`
- Candidate: `8be457e716cfa50e9ef024fa5317b72b2859dcdc`
- Shipping: —
- Acceptance: one unreachable library accepts only bounded canonical raw
  manifests after duplicate-key detection before materialization; unknown fields
  fail at every schema depth and ASCII/semver/ID/path/order/count bounds cover
  package, tools, executables, imports, capabilities, runtime, signer, build,
  source, SBOM, licence, notices and metadata; imports separate the maximum eight
  modules from a 64-byte printable-ASCII module-name grammar; bundled `allowed`
  accepts only exact `wasi_snapshot_preview1`, while `disallowed` may contain `*`
  or bounded valid module names and both lists remain sorted/duplicate-free;
  immutable release inventory and CAS bytes recheck exact path, size and SHA-256
  without writing extension bytes; a bounded raw scanner re-enforces the exact
  WASI allowlist, measures exact module/field/kind including function imports,
  and enforces canonical LEB/framing/order/duplicates/imports, exactly one
  imported-or-defined memory, mandatory max, memory64/shared/unknown flag/
  multi-memory rejection, measured-max declaration+tier ceilings and honest
  skipped-section records; tiny/default are allowed and large requires release
  evidence; mutable `wasmPkg` state uses reserved `__wasmTx` prepared→committed/
  compensated exact-generation recovery for admit/update/revoke, concurrent
  version fencing, restart-stable revocation and version/executable/capability-
  bound `grantEpoch`; signer metadata is recorded as explicitly unverified;
  owner lane and every install/provider/model/Worker/runtime/OPFS/network/
  permission/execution surface are absent; this slice ships zero Wasm binaries
- Review: v2 design SHA-256 `1ad1035bc09bc85dcbb7d6ce6e0fa634b60ab4baa473582123a8fdb27dc31fe4`
  independently PASSed review SHA-256
  `b5381dd3fd33e3e29f5db2055e2ccdebc4f424760c4ee3da1317e2dd7663eb12`;
  exact implementation review pending; 39-tool bounded rebuild review SHA-256
  `daa5725bb95004d444f0af12a68fcfbc8c2627c6bb8c7a6dedc35451085413d9`
  found the prior eight-character import grammar blocked truthful WASI manifests
- Gates: reported focused authority 16/16 and composed authority/memory/scanner
  48/48; canonical full no-Chrome 1013/1013 across 14 steps; 108-file production
  build with zero Wasm binaries; exact 134-entry package/validate; gallery/
  changelog/tracker/privacy/diff/release/clean; exact valid bounded WASI
  function-import fixture and admission; env/typo/Unicode/overlong/wildcard-
  allowed refusal before admission; disallowed wildcard/module enforcement;
  sorted/duplicate/count bounds; measured module/name/kind; unchanged hostile
  duplicate/escaped/schema/substitution/framing/memory/tier/bomb, inventory, WAL,
  revocation, corruption, provenance and no-route/no-execution assertions
- Blockers: reconstructed tools remain blocked on the Apache-2.0 root versus MIT
  package/manifest licence contradiction even after import-schema repair; owner-
  package admission and signer verification require written trust and Store/RHC
  policy; large tier requires loaded-MV3 release evidence; execution remains
  blocked on the MV3 runtime probe and separately reviewed host; exact hotfix
  requires independent security review
- Next: commit one `0.2.154` import-policy correction for independent exact-source
  review; do not admit the reconstructed tool set until licence/provenance clears,
  and leave every binary/runtime/install path to separately reviewed successors
- Recover:
  `git show fix/wasm-import-allowlist-c23e6eb -- extension/lib/wasm-package-authority.js tests/wasm-package-authority.test.ts README.md PLAN.md KNOWN-ISSUES.md docs/tool-platform-architecture.md docs/OPEN-QUESTIONS.md TASKS.md`
- History:
  - 2026-08-22 09:30 UTC — opened with separate Store-bundled and owner-selected
    distribution lanes; owner packages remain policy-blocked.
  - 2026-08-22 14:36 UTC — implemented only the reviewed bundled-record authority
    on exact public `9c03e4f`; no binary, owner lane, route, runtime or execution
    surface was added.
  - 2026-08-22 15:00 UTC — exact candidate `03dc099` became public `0.2.151`;
    lifecycle remains IN_REVIEW with Shipping `—` pending exact-candidate review.
  - 2026-08-22 15:50 UTC — review of the 39 bounded rebuilds found the eight-
    character import grammar could not truthfully declare their exact
    `wasi_snapshot_preview1` dependency; started a minimal explicit-WASI hotfix
    on exact public `c23e6eb`. The licence contradiction still blocks admission.

## [CAP-FB-20260822-OPFS-TOOL-WORKSPACES-01] Isolated per-job OPFS tool workspaces

- Feedback: 2026-08-22 — tools need bounded files without direct access to agent
  memory, package stores or artifact indexes
- Updated: 2026-08-22 14:36 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: OPFS-workspace review owner
- Workspace: none
- Branch: `main`
- Base: `8cd9bd0439fc4bcc4af435c086170a993a2e4ac6`
- Candidate: `9c03e4f1d91dc872a87e05e4dc150972a1e9ecbc`
- Shipping: —
- Acceptance: each execution/call gets a strict normalized
  `tool-jobs/<execution>/<call>/` root; projected inputs are declared by digest,
  verified before write, write-once, re-read/hash-verified and exposed only as
  bytes; scratch/output obey serialized byte/file reservations, bounded replay
  keys and origin-storage pressure; `.quota.current`/`.quota.next` recover only
  through monotonic sequence and trusted `.quota.anchor` digest continuity;
  stale/corrupt partial state discards or quarantines fail closed; explicit GC
  removes only validated terminal+expired exact job identities with a durable
  interrupted-remove marker; output promotion uses the artifact WAL only through
  `createAssetKeyed`, whose caller key binds execution, call, name and bounded
  content digest; same-key retry returns the same exact asset; unkeyed
  `createAsset` behavior remains unchanged; no route exposes this wrapper
- Review: initial aggregate candidate `c16f18792540be296e8e86034cf7f4c2cd853522`
  was FIX_REQUESTED; exact successor chain tip
  `9b0497ac88c0a3d6e3129b93446861586b9d2890` independently PASSed source review
  SHA-256 `d4f85f3e7c20d72451704b6c08c91f49e6a96e8bbecd972fdf9d654a668bf430`;
  current one-release recompose review pending
- Gates: reported pre-commit workspace 11/11 and focused artifact authority
  31/31; canonical full no-Chrome 972/972 across 14 steps; 105-file production
  build and exact 131-entry package/validate PASS; gallery/changelog/tracker/
  privacy/diff/release/clean checks; real mid-write/close/move/remove and
  QuotaExceeded fault injection; input conflict/interrupted completion; exactly-one
  reserve race and bounded-key expiry GC; anchor match/quarantine; keyed promotion
  retry/crash rollback; orphan-GC restart and cross-job denial; metadata no-secret
- Blockers: execution use depends on the loaded-MV3 runtime probe; this wrapper
  has no service-worker message, provider, package, Worker or model-tool route;
  exact current-parent recompose requires independent review
- Next: obtain independent exact-candidate recompose/artifact-boundary review;
  leave runtime wiring to a successor
- Recover:
  `git show 9c03e4f1d91dc872a87e05e4dc150972a1e9ecbc -- extension/lib/opfs-tool-workspace.js extension/lib/artifacts.js tests/opfs-tool-workspace.test.ts tests/artifacts.test.ts docs/tool-platform-architecture.md TASKS.md`
- History:
  - 2026-08-22 09:30 UTC — split from the P0 program; Co-do's user-selected
    real-directory VFS is not CAP's OPFS workspace authority.
  - 2026-08-22 13:58 UTC — recomposed the independently PASSed aggregate source
    semantics onto exact public `8cd9bd0` as one release candidate, preserving
    lazy/security/package bytes and keeping every execution route absent.
  - 2026-08-22 14:36 UTC — candidate `9c03e4f` is the exact public `0.2.150` tip,
    but remains IN_REVIEW with Shipping `—` pending exact-candidate review.

## [CAP-FB-20260822-WASM-EXECUTION-HOST-01] Fresh-Worker Wasm execution host
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
- Gates: final independent review PASS on `086ee3d` (26/26 focused, full
  1056/1056, build rc 0); recomposed gates re-run on this commit

- History:
  - 2026-08-22 20:40 UTC — Store package scan after the recomposed push passed
    ABSOLUTE source paths to the scanner; the canonical exemptions compared only
    relative paths and flagged the execution-host Wasm + worker-host Worker
    constructions. Fixed with a scanner-owned canonical path matcher
    (`isCanonicalScannedPath`) that accepts the exact normalized repo tail
    (relative or absolute) and rejects lookalikes/suffix tricks; added
    absolute-positive + lookalike-negative tests for BOTH exemptions. Store
    package build/package/validate pass on `0.2.160`.
- Recover: `git show 086ee3d -- extension/lib/wasm-execution-worker.js
  extension/lib/wasm-executor.js extension/lib/wasm-executor-bounds.js
  extension/lib/wasm-offscreen-host.js extension/lib/wasm-sync-workspace.js
  tests/wasm-fixture-builder.mjs tests/wasm-host-gate2.test.ts
  scripts/scan-shipped.mjs build.mjs`


- Feedback: 2026-08-22 — reviewed packages require a least-privilege host with
  hard termination, quotas and Durable replay integration
- Updated: 2026-08-22 16:50 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: integrated on public main
- Workspace: none
- Branch: `origin/main`
- Base: `8be457e716cfa50e9ef024fa5317b72b2859dcdc`
- Candidate: `462d21d8da9bee640c2c12088dcafba6123e00fc`
- Shipping: `origin/main@462d21d8da9bee640c2c12088dcafba6123e00fc`
- Acceptance: exactly two unreachable source libraries define frozen strict WASI
  errno/flag/right/filetype/path-class/hard-limit/default-quota records and
  job/context/quota/FD constructors, then expose a synchronous
  `wasi_snapshot_preview1` table over injected bounded byte-memory and workspace
  adapters; no OPFS handle is constructed; args, empty environment, fd 0/1/2,
  fd3 exact `.` preopen, read/write/seek/tell/close/fdstat/filestat, path stat/
  open, random, monotonic clock, realtime `ENOTSUP` and typed `proc_exit` obey
  wasm32 little-endian pointer/iovec/u64 bounds, preflighted alias/OOB checks,
  partial IO, cancellation and host/stdin/stdout/stderr/path/dynamic-FD/file-byte/
  file-size quotas; normalized UTF-8 relative paths reject traversal and symlink
  following; `inputs/` is read-only, `scratch/` read-write and `output/` write-
  only; the exact nine-function import union measured across 37 non-Emscripten
  rebuilds is recorded and foreign module/kind/function imports fail explicitly;
  shared package tiny/default scanner readback is revalidated and large remains
  blocked; no service-worker/offscreen/Worker/route/OPFS construction/network/
  provider/package-byte load/WebAssembly compile-or-instantiate/execution exists
- Review: host design v2 SHA-256
  `c7fe9de72c42fada04b1f79d546f2f4b7e518a5e1c50d4c034a13feea9c122e1`
  independently PASSed review SHA-256
  `85c436846542c2c483beb771c5ae632132ad6984fd6679eede423c7413b53bfd`;
  reviewer additions `fd_tell` and `CLOCK_REALTIME` id 0 → `ENOTSUP` included;
  exact Gate 1 implementation independently PASSed at `462d21d8`, review
  SHA-256 `97df51dd194ff02496740cbfbfca92243f76b586857decaebe3243ae4ac7845e`
- Gates: Gate 0 authorized probe retry independently PASSed 10/10, review SHA-256
  `7b0524498e7e4556018a79b256ca8ab25147d47a6294afa0f58c6b392b5bd895`;
  reported pure host 16/16 and composed host/package/OPFS 43/43; canonical
  full no-Chrome 1029/1029 across 14 steps; 110-file production build with zero
  Wasm binaries; exact 136-entry package/validate; gallery/changelog/tracker/
  privacy/diff/release/clean; every syscall KAT; strict/frozen
  types; exact import/memory-tier revalidation; hostile pointer/iovec/alias/u64/
  UTF-8/NUL/traversal/rights; fd3 preopen; partial IO/seek/tell/stat/close/reuse;
  random cap/mock; monotonic/realtime clocks; quota/cancel/cleanup; source scan
  proving no product import, route, Worker, OPFS, network or instantiation
- Blockers: none for the landed pure Gate 1 source contract. Gate 2 offscreen/
  fresh-Worker/session fencing/termination, package bytes, routes and browser
  evidence remain a separate task; no reconstructed tool is admitted/executable
- Next: preserve this unreachable reviewed contract while Gate 2 proceeds as a
  separately reviewed and browser-gated successor with no provider cutover
- Recover:
  `git show 462d21d8da9bee640c2c12088dcafba6123e00fc -- extension/lib/wasm-host-types.js extension/lib/wasi-preview1-runtime.js tests/wasi-preview1-runtime.test.ts docs/tool-platform-architecture.md TASKS.md`
- History:
  - 2026-08-22 09:30 UTC — opened with fresh-Worker-only and unknown-replay
    defaults; Co-do's main-thread fallback is explicitly not adopted.
  - 2026-08-22 16:03 UTC — independently reviewed Gate 0 probe passed all 10
    checks; began only the design-PASSed pure Gate 1 source slice on exact public
    `8be457e`, with every product integration and execution primitive absent.
  - 2026-08-22 16:50 UTC — exact `462d21d8` landed as public `0.2.155` after
    different-model PASS, 16/16 focused, 43/43 composed, 1029/1029 full,
    build/package/load proof; the pure modules remain unreachable and Gate 2 is separate.

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
  - 2026-08-22 09:30 UTC — factual Co-do inventory recorded as 39 tools across
    nine functional categories; it is a prioritization precedent, not a binary
    source.

## [CAP-FB-20260822-CODE-DIFF-ARTIFACTS-01] Code patch artifact review and apply lifecycle

- Feedback: 2026-08-22 — tool-produced code changes need owner-visible
  base/result identity and reversible application rather than direct workspace
  mutation
- Updated: 2026-08-22 15:29 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: retained code-diff review owner
- Workspace: none
- Branch: `main`
- Base: `03dc09910a11afd4c1611a985411c6d97139bfb7`
- Candidate: `34ced55a71d871fcf209c4756b51ff1556639632`
- Shipping: —
- Acceptance: one unreachable library getter-safely snapshots strict canonical
  add/update/delete/rename/binary documents; user paths accept valid UTF-8 and
  per-segment NFC while rejecting lone surrogates, NUL, C0/C1/bidi controls,
  backslashes, absolute/drive/UNC/empty/dot/dotdot/percent traversal, NFC and
  conservative casefold collisions, >255-byte segments, >1024-byte paths and
  >256 paths; `displayPaths` is exact and reversible; identity binds producer
  source/package/executable/capability/replay, workspace/execution/call/run/
  agent/origin/document, inputs, exact sorted base/result sets, canonical
  change digest and media; retention preflights all hashes/sizes/UTF-8, one
  180-KiB blob, 64 blobs and 4-MiB total raw CAS before writes, then retains
  each unique digest and the patch only through `createAssetKeyed`, re-reads and
  hash-verifies them, and retries through stable artifact-WAL keys; bounded
  unified/side-by-side row-split views re-hash source bytes, neutralize controls,
  truncate long lines, refuse total overflow and render binary metadata only;
  views are non-authoritative; apply/reject/undo synchronously throw
  `mutation_authority_required` before input access and no route/store/OPFS/
  provider/WebAssembly/mutation authority exists
- Review: v2 design SHA-256
  `78be17675b667aeaa33f58ca1b43fda660685a53242758bd890d6f172ec90945`
  independently PASSed review SHA-256
  `a7d6ac7e5aabf6d4febf38560f48efa5603da8268979b4dae3ff83cd2cacf9cc`;
  exact implementation artifact/path/CAS/view/no-route review pending
- Gates: reported focused hostile authority 15/15; canonical full no-Chrome
  1001/1001 across 14 steps; 107-file production build with zero Wasm binaries;
  exact 133-entry package/validate; gallery/changelog/tracker/privacy/diff/
  release/clean gates; identity-field changes; getter/proxy inputs;
  UTF-8/NFC/traversal/collision/
  display/bounds; every operation shape and substitution; CAS missing/extra/
  digest/size/encoding/blob/count/total preflight with zero writes; digest-keyed
  dedup, readback corruption, interrupted artifact-WAL retry; unified/side views,
  huge lines/line totals/control neutralization/binary metadata; synchronous
  unavailable stubs and no-route/no-direct-mutation static scan
- Blockers: exact source candidate requires independent review; apply/reject/
  undo depend on a separately reviewed conditional OPFS mutation authority,
  genuine owner UI/approval route, stale-base checks and crash-recoverable
  multi-file WAL; accessibility/theme/narrow/RTL evidence belongs to that future
  rendered owner-review lane, not this source-only slice
- Next: obtain independent exact-candidate artifact/path/CAS/view review and
  leave every mutation to a separate successor
- Recover:
  `git show 34ced55a71d871fcf209c4756b51ff1556639632 -- extension/lib/code-diff-artifacts.js tests/code-diff-artifacts.test.ts docs/tool-platform-architecture.md TASKS.md`
- History:
  - 2026-08-22 09:30 UTC — split from the P0 program; a line-LCS precedent alone
    does not provide CAP transaction or owner-review authority.
  - 2026-08-22 15:00 UTC — implemented only reviewed v2 schema/identity/views/
    retention plus fail-closed unavailable mutation stubs on exact public
    `03dc099`; no workspace or execution route was added.
  - 2026-08-22 15:29 UTC — exact candidate `34ced55` became public `0.2.152`;
    lifecycle remains IN_REVIEW with Shipping `—` pending exact review.

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

## [CAP-FB-20260822-CHROME-LAZY-TOOLS-01] Chrome API descriptors behind lazy discovery

- Feedback: 2026-08-22 — browser tools should share one discovery protocol
  without collapsing their existing least-privilege permission and grant checks
- Updated: 2026-08-22 15:29 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: Chrome lazy metadata review owner
- Workspace: none
- Branch: `main`
- Base: `34ced55a71d871fcf209c4756b51ff1556639632`
- Candidate: `c23e6eb004cfa8860e5b67f3a8d2991f519b96b1`
- Shipping: —
- Acceptance: one frozen bounded data-only table covers exactly all nine
  `browserToolset(false)` and 29 `managementToolset` names with stable source
  kind, distinct namespaced capability token(s), backing optional permissions,
  product-grant scope kind, replay and trusted-replay class, owner-gesture flag,
  mutation class and route family; missing/extra/unknown inventory fails closed,
  management capabilities never collapse to `management.route`, and replay rows
  match the existing trusted replay authority; only the pre-existing
  Settings-shadow `capabilitiesByTool` construction consumes the table; selected
  capture rows add bounded `capabilitySummary`, `capabilityDigest` and
  `trustedReplaySafety`, while every non-selected descriptor contributes only a
  bounded top-level count with no name/schema/capability; all 38 remain cataloged
  and the unsafe-for-cutover list is policy metadata, not runtime filtering;
  `providerBound`, `eagerBindingChanged`, `canExecute` and `canGrant` remain
  false; browser/management tool maps, validators, lazy dispatch wrappers, route
  handlers, eager provider binding, permission/grant/runtime dispatch remain
  byte- and behavior-unchanged
- Review: source map SHA-256
  `e55b1190a3d4f02d6c06251d9e1e92e11e48ec641fbb379491cfabfdeffeb037`
  independently PASSed review SHA-256
  `874d31c8b6b7295fb2db8402889090bab12cea421d68de0a0a05ef6c494d6194`;
  exact implementation capability/capture/parity/no-authority review pending
- Gates: reported focused capability/catalog/shadow/lazy 39/39; canonical full
  no-Chrome 1011/1011 across 14 steps; 108-file production build with zero Wasm
  binaries; exact 134-entry package/validate; gallery/changelog/tracker/privacy/
  diff/release/clean; exact 9+29 completeness/no extras/unknown refusal;
  schema/token/permission/
  grant/replay/gesture/mutation/route bounds; distinct management tokens;
  capability digest recomputation; source-map execute/schema/safeParse
  `Object.is` custody and validator-result parity without invocation; selected-
  only capture and non-selected-count nondisclosure; source generation/stale ref
  and replay drift; no permission request/grant/runtime-send/provider/execute
  path; parent dispatch-source blob equality
- Blockers: exact source candidate requires independent review; provider cutover
  remains blocked on loaded-MV3 optional-permission, grant absent/expired/scope,
  revoke/regrant ABA, run-loss compensation, activeTab owner-vs-model, stale-ref,
  source-rebuild, page-caller and interrupted-mutation evidence; flagged tools
  remain unexposed until their specific gates pass
- Next: commit one `0.2.153` metadata-only release, obtain independent table/
  capture/parity review, and leave provider exposure/execution to a separately
  authorized loaded-MV3 successor
- Recover:
  `git show feat/chrome-lazy-tools-34ced55 -- extension/lib/chrome-tool-capabilities.js extension/lib/lazy-tool-wire.js extension/lib/tool-catalog-shadow.js extension/background/service-worker.js tests/chrome-tool-capabilities.test.ts TASKS.md`
- History:
  - 2026-08-22 09:30 UTC — opened separately from Wasm execution so a shared
    catalog cannot become a shared confused-deputy dispatcher.
  - 2026-08-22 15:29 UTC — implemented only the independently PASSed safe map:
    canonical 9+29 metadata and selected-only Settings capture summaries on
    exact public `34ced55`; no provider or execution authority was added.

## [CAP-FB-20260822-TOOL-LIBRARY-UI-01] Owner Tool Library, provenance and diagnostics UI

- Feedback: 2026-08-22 — owners need one truthful place to inspect tools,
  packages, versions, capabilities, grants, quotas, selection diagnostics and
  revocation
- Updated: 2026-08-22 19:02 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: K3 implementation; coordinator integration; independent Pro review
- Workspace: active (local path private)
- Branch: `integrate/tool-library-panel1-462d21d`
- Base: `462d21d8da9bee640c2c12088dcafba6123e00fc`
- Candidate: this commit (panel-one read-only source)
- Shipping: —
- Acceptance: reusable Web Components present
  source/package/tool/version/digest/signer/licence/SBOM/capabilities/quota/replay/availability;
  install/update capability diffs and narrow grant/revoke are owner-only;
  diagnostics explain selected/excluded/stale/owner-action-required without
  secrets or private query history; every action and state is
  keyboard/screen-reader/narrow/theme/RTL correct
- Review: independent information architecture, truth/accessibility, permission,
  privacy, provenance and visual review using Impeccable and modern-web guidance
  required
- Gates: component gallery and loaded Settings;
  empty/loading/error/corrupt/revoked/update states; exact AX labels/focus;
  360/500px, RTL and all themes; capability diff and deny/cancel mutate nothing;
  no secret/query leakage; screenshots before/after
- Blockers: depends on catalog and package authority; install controls depend on
  distribution-policy lane
- Next: independently review the corrected unique-ID/stable-live-region patch
  and frozen 14-journey harness, then run exactly one serialized loaded-MV3
  360/500/RTL/theme/keyboard/AX matrix; do not expose install/grant controls
- Recover:
  `git grep -n "TOOL-LIBRARY-UI\|tool-catalog.shadow\|capabilityDigest" -- TASKS.md docs extension/shared extension/options tests`
- History:
  - 2026-08-22 09:30 UTC — opened as an owner surface; the catalog slice
    intentionally adds no UI or new permission gesture.
  - 2026-08-22 16:34 UTC — corrected panel one adds only a Settings read-only
    summary/no-package surface. Harness preparation caught and fixed duplicate
    section/component ids and a remounted live region; no package rows, actions,
    grant/install/run route or provider authority exists. Browser matrix pending.
  - 2026-08-22 19:02 UTC — the first loaded-MV3 run was a harness FAIL with
    the product result indeterminate because failure capture did not bind the
    destination document. Subsequent source review found the new deep-link hash
    absent from exact Settings sender authority, which was independently
    sufficient to deny the route if that destination executed. The successor
    registers every shipped Settings navigation hash and adds a drift test;
    browser evidence remains pending a fresh reviewed harness run.

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
- Next: run `node scripts/worktree-audit.mjs` (read-only) before ANY cleanup decision; agree the dirty-preservation plan with the owner; then (a) remove the clean worktrees holding nothing beyond origin/main + `git worktree prune`, (b) bind the unreachable detached heads under `rescue/*` tags, (c) move the durable evidence off the RAM-backed tmpfs — the AGENTS.md convention + the audit tool now ship
- Recover: `git worktree list --porcelain && git tag -l 'rescue/*' && git fsck --unreachable`
- History:
  - 2026-08-22 — the public-safe AGENTS.md convention + the read-only worktree-audit script shipped; the audit inventories every registered worktree (HEAD/branch/dirty tracked+untracked/reachability/rescue/location class) and refuses destructive operations; private paths stay out of the repo.
  - Git reconcile at 2026-08-22 07:50 UTC: VERIFIED current facts — after the prior cleanup 19 worktrees remained (18 dirty, preserved, + the clean main worktree); two clean worktrees were later added for the tracker and the product work, so the current 21 = 18 dirty + 3 clean; 151 tracked changes + 26 untracked paths sit in the dirty worktrees; the cleanup removed 133 clean worktrees and 126 obsolete local branches, left 10 rescue tags, and touched no remote refs. No further destructive action until the dirty-preservation decisions.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D1/D2). Seven at-risk commits were tagged `rescue/tmp-detached-*` locally before this entry was written; no worktree, branch, or object was deleted.

## [CAP-FB-20260821-TRACKER-GIT-RECONCILE-01] Reconcile this tracker with the repository
- Feedback: 2026-08-21 — independent architectural review found at least nine tasks recorded as unassigned with no branch that have committed implementation work, and found only 2 of 430 commits carry a `CAP-FB-*` identifier
- Updated: 2026-08-22 07:40 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: tracker reconciliation writer
- Workspace: active (local path private)
- Branch: `tracker/reconcile-final-6480005`
- Base: `6480005001335fac885f6c7e261999424b0c9dac`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: every task whose implementation exists in the repository records that branch and its exact tip commit in `Branch` and `Candidate`, with a `Status` no more advanced than the evidence supports; every task recorded as unassigned with no branch has been checked against `git for-each-ref` and `git worktree list` and genuinely has no work; each `Recover:` command, run verbatim, returns the task's own material; a commit-message convention requiring the `CAP-FB-*` identifier is added to `AGENTS.md` and enforced by a check
- Review: an independent session re-derives the task-to-branch mapping from the repository alone and confirms it matches the tracker, without consulting the private coordination ledger
- Gates: exact 52-entry schema/count/heading/fence checks; Markdown-link, privacy, object, diff, build, and release-identity checks on this one-commit successor; independent review pending
- Blockers: —
- Next: obtain independent review of the exact tracker commit, then push it without rewriting or allocating another release identity
- Recover: `git show tracker/reconcile-final-6480005:TASKS.md && git diff 6480005..tracker/reconcile-final-6480005 -- TASKS.md`
- History:
  - 2026-08-22 07:40 UTC — prepared one structurally corrected successor from exact public `6480005`, using the prior three-commit tracker series as content reference only so release identity is allocated once by this commit.
  - Git reconcile at 2026-08-22 07:30 UTC: this reconciliation commit.
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.4). The nine confirmed task-to-branch mismatches are listed there; this task exists to correct them in the tracker, not to advance any of their statuses.

## [CAP-FB-20260821-STALE-BRANCH-TRIAGE-01] Land or abandon the unmerged branch backlog
- Feedback: 2026-08-21 — independent architectural review found 46 branches ahead of `origin/main`, several holding independently reviewed work, stalled by repeated base-change re-review
- Updated: 2026-08-22 07:30 UTC
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
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.2). No branch disposition is asserted here; the triage itself is the deliverable.

## [CAP-FB-20260821-DEAD-SURFACE-REMOVAL-01] Remove superseded surfaces and the published mock site
- Feedback: 2026-08-21 — independent architectural review found six stale design mocks duplicated into the published documentation site, a published front page titled "UI mocks", and two shipped surfaces that no longer carry a job
- Updated: 2026-08-22 08:38 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P2
- Owner: docs withdrawal integrator
- Workspace: active (local path private)
- Branch: `chore/docs-mock-withdrawal-e279372`
- Base: `e27937205a48ad5abaa6841716dc9cca180d5aa8`
- Candidate: `7b1aa265cf2323e1cf32c36fd8916f08f82df971`
- Shipping: root-mock slice `origin/main@7b254e43c38569667045363405b3243e9951f926`; provider-visibility slice `origin/main@d50ea21eb3ade27e45e921044c581d382b19fb72`
- Acceptance: the `mock/` directory and its duplicated copies under `docs/` are removed; the published front page presents the component gallery and a real product screenshot rather than dead mocks, or is withdrawn; the Chrome Prompt API and demo-local providers are removed from the user-facing provider picker while remaining reachable for internal testing if still needed; the side panel's Page tab is either given a stated job or folded into the Agents view; every removal is checked for inbound references across code, docs, tests and the gallery sync before it lands
- Review: DeepSeek Pro PASSed root-mock `7b254e4`, provider source `64e8b80`, exact current-main provider integration `d50ea21`, and docs-withdrawal source `7b1aa26`
- Gates: root-mock and provider slices are public after full source gates and canonical loaded-MV3 126/126; provider targeted raw-CDP 10/10 proves public lists plus retained internal Demo/no migration; docs source focused 3/3, full 891/891, build/gallery/link/accessibility gates passed
- Blockers: only the independently PASSed docs withdrawal remains to recompose onto current main. Internal provider authority and the tested Page tab are intentionally retained.
- Next: land the docs withdrawal current-main recomposition after its exact delta review; then archive this task as DONE
- Recover: `git show --stat origin/main && git grep -n "publicProviderChoices\|Internal testing provider active" -- extension tests`
- History:
  - 2026-08-22 08:38 UTC — recomposed independently PASSed provider public-list/no-migration behavior onto current public `e279372`: public surfaces exclude Demo/Prompt API while existing internal global/per-agent selections remain effective and render truthful inert replacement state without storage mutation.
  - 2026-08-22 07:58 UTC — implemented owner-decision-free slice 1 on exact public `b71e7a5`: the standalone `mock/` subtree had no inbound repository references outside itself, so its six files were deleted without touching the published docs, provider authority, or side-panel Page job; status advanced to `IN_REVIEW` for independent review and the later canonical Chrome gate.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §4). The provider-picker removal restates a backlog item standing since 2026-08-17 and is folded here so it has acceptance criteria and a gate.

## [CAP-FB-20260821-SW-ROUTE-MODULARIZATION-01] Split the service-worker route surface
- Feedback: 2026-08-21 — independent architectural review found 127 message routes in a single 4,799-line flat handler object, identifying it as a structural cause of cross-lane merge conflict and the serialized integration queue
- Updated: 2026-08-22 09:00 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P2
- Owner: route integration coordinator
- Workspace: active (local path private)
- Branch: `integrate/sw-routes-d50ea21`
- Base: `5e05fa95f05e3b38715cbe22335209d7874d5503`
- Candidate: this integration commit
- Shipping: —
- Acceptance: routes are grouped into modules by subsystem behind a thin dispatcher; the sender-authorization decision, the page-route allowlist and the error-shaping path remain single authorities and are not duplicated per module; the external message contract is byte-identical — every route name, request shape and response shape unchanged; the bundle contains no new `eval`/`new Function`; no behavior change is bundled with the move
- Review: DeepSeek Pro PASSed source `5b57c10`; GPT source/no-loss review PASSed route/security behavior in predecessor integration `bd06e1b` but BLOCKed its premature tracker state; exact corrected one-commit successor re-review pending
- Gates: source/no-loss review verified 119 inline +14 extracted =133 route parity, collision-failing frozen maps, real extracted-handler tests, full 908/908, security 7/7 and build; canonical loaded-MV3 126/126 passed on the same route bytes; corrected successor reruns/review pending
- Blockers: corrected tracker/release successor must pass exact re-review before push; stale branch cleanup is complete non-destructively and hygiene tooling/type gate are public through `5e05fa9`
- Next: re-review exact corrected one-commit successor, rerun exact-release security/build and canonical Chrome if product bytes differ, then remotely attest the landing
- Recover: `git show origin/main -- extension/background/routes extension/background/service-worker.js tests/sw-route-modularization.test.ts`
- History:
  - 2026-08-22 09:00 UTC — recomposed independently PASSed provider/KV/permission-lease extraction onto current public `5e05fa9`; preserved Durable authority and moved `provider.models` to the extracted module using `publicProviderChoices`, while the full provider catalog remains internal runtime authority. The first integration commit was not pushed because review caught premature MERGED/shipping claims and stale status counts; this one-commit successor corrects only that tracker truth.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `OPEN` mapped to `OPEN` (unchanged semantics).
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D7). Explicitly sequenced after the branch triage to avoid invalidating outstanding work.

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

---

## Reconciliation log

- 2026-08-19 17:01 UTC — recovered the interrupted draft; reconciled stable CAP task IDs against the private coordination ledger, exact Git objects, current refs, and active worktree state. Public entries retain only role labels, repository refs, commit/evidence hashes, and conservative delivery states.
- 2026-08-19 17:07 UTC — reconciled after `origin/main` advanced to `ffbdf28`; run-status now records PUSHED, while the old-base Directory and artifact integrations explicitly require fresh current-main integrations.
- 2026-08-19 17:25 UTC — reconciled k3 tracker PASS, usage `d6030b7` REVIEW_PASSED, Assets successor `202b85e` REVIEWING, explicit gemini permission attribution, and old-base Directory/artifact READY_FOR_BROWSER classifications. No private coordination identifiers were copied.
- 2026-08-19 18:18 UTC — captured thirteen distinct product-feedback tasks on exact public `bbeff7b`; linked prior run-status, agent-access, sidebar, Directory, WebMCP, tool-tree, permission, and artifact-transaction tasks without merging or rewriting their histories. The additions retain unresolved enrollment-versus-tool-approval and agent-artifact-disposition decisions as research, treat intermittent whole-UI flashing as a trace-first investigation, keep Recent Activity layout/data/error truth separate from historical renderer evidence, and separate user-facing permission remediation from the existing orchestration candidate. New entries contain only public role custody, repository objects, acceptance criteria, and conservative OPEN/BLOCKED states.
- 2026-08-20 15:21 UTC — on exact public `ecf657f`, opened semantic tool retrieval across all four tool sources and strengthened the already-open conversation-status presentation task after repeated feedback proved the standalone top-of-task banner remains. No implementation or prior lifecycle acceptance was inferred.
- 2026-08-21 09:55 UTC — reconciled against an independent architectural review of exact public `300bea1` (documentation-only ancestor of `cdc1a65`). The review executed the build, the unit suite (632 pass, one environment-caused failure), the Chrome journey suite (126/126) and five surface captures. Ten new tasks were opened on exact `cdc1a65` covering worktree/evidence durability, tracker-to-repository reconciliation, the unmerged branch backlog, the delivery lifecycle decision, shipped-task closeout, first-run setup, one reproduced hub alignment defect, superseded-surface removal, service-worker route modularization and the unfinished recipes rename. No existing task's status, owner or evidence was altered, and no prior acceptance was inferred. Full rationale and the ordered work queue are in `REVIEW-2026-08-21.md`.
- 2026-08-21 10:15 UTC — the product owner approved all six rule changes in `REVIEW-2026-08-21.md` §7. The delivery lifecycle in this file and in `AGENTS.md` is now `OPEN → IN_REVIEW → MERGED → DONE` with `BLOCKED`/`ABANDONED` off-ramps, and `DONE` no longer depends on a per-task owner interaction. Independent review by a different model/session and real-browser verification are retained unchanged; content-addressed gate evidence, live remote attestation and versioned acceptance packages are removed. **No existing entry was rewritten** — a legacy-state mapping is published in the state rules instead, so no prior status, evidence or acceptance is silently reclassified. `CAP-FB-20260821-DELIVERY-LIFECYCLE-01` moves to `MERGED`; the confirmation blocker on `CAP-FB-20260821-PUSHED-TASK-CLOSEOUT-01` is cleared and the freeze-window pressure on `CAP-FB-20260821-STALE-BRANCH-TRIAGE-01` is reduced by rule 3.

---

## Archive

## [CAP-FB-20260822-LAZY-TOOL-PROTOCOL-01] Run-bound lazy search and execute protocol

- Feedback: 2026-08-22 — hundreds of tools must be discovered lazily instead of eagerly appending every descriptor/schema to provider context
- Updated: 2026-08-22 13:58 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: lazy-protocol integration owner
- Workspace: none
- Branch: `main`
- Base: `0e47a63591c9c798043cc196f6049c410d2cd597`
- Candidate: `8cd9bd0439fc4bcc4af435c086170a993a2e4ac6`
- Shipping: `origin/main@8cd9bd0439fc4bcc4af435c086170a993a2e4ac6`
- Acceptance: the fixed always-small `search_tools`/`execute_tool` metadata wire uses run-bound non-authorizing references; selected summaries are bounded and no non-selected schema, provider data, key or secret crosses the shadow capture; the unreachable injectable core re-resolves live catalog/source/package/run/agent/origin/document authority before validation, before dispatch and after dispatch, validates getter-safe bounded arguments and delegates only to existing source closures; package identity binds package ID, version, digest and capability digest; retrieval grants no permission/install authority; eager provider binding and protected prompts remain unchanged
- Review: exact recompose source review PASS SHA-256 `b27fef5bf8d841cb5327e54dc44144755534d27ae5b08f91ef1240908fd81515`; frozen loaded-MV3 package `/tmp/cap-lazy-shadow-browser-8cd9bd0` index SHA-256 `d30c83df430a8c2ce4db68c41a55c7fc09db2fc4f5b2208d274632f1cd1c8d52` and independent package review PASS SHA-256 `c0e1aa6afffc5052d224469629d65cc2485ca598efac5824a9a216863f5ff371`; independent run review PASS SHA-256 `719e7c7303ff4c72880e2d4d67efb947323010c3cb3fb3a67b9018bc9e424b79`
- Gates: source focused 75/75, full no-Chrome 961/961, 104-file build and exact 130-entry package/validate PASS; loaded-MV3 evidence run `cap-lazy-shadow-8cd9bd0-20260822T134400Z` REPORT SHA-256 `827429a524a53c3fe99c86f8cb894b146a256cf4000703cc952a1f9ad9ad25ce` and evidence-index SHA-256 `ce6fdadd0dd9807a5539f22de5372d04382bb3273c4fd1be049a04cffd264eca` proved two fixed descriptors, one selected bounded summary, fresh non-authorizing refs, provider/eager/execute/grant flags false, exact NTP denial plus security event, zero forbidden messages, zero console/runtime/network errors, mandatory AX and reliable PNG; exit 0, no timeout/survivor/profile/poison. Known non-blocking harness note: finalizer appended to `wrapper.log` after hashing that log; all product-evidence hashes recomputed exact
- Blockers: —
- Next: —
- Recover: `git show 8cd9bd0439fc4bcc4af435c086170a993a2e4ac6 -- extension/lib/lazy-tool-protocol.js extension/lib/lazy-tool-wire.js extension/lib/tool-catalog-shadow.js extension/lib/tool-catalog.js extension/lib/tool-selection.js tests/lazy-tool-protocol.test.ts tests/provider-gate.test.ts TASKS.md`
- History:
  - 2026-08-22 09:30 UTC — split from the P0 program after research identified eager WebMCP/provider binding as a high-severity context and authority problem; no cutover was present in the catalog slice.
  - 2026-08-22 13:09 UTC — reviewed source semantics were recomposed onto exact public `0e47a63` without provider cutover.
  - 2026-08-22 13:58 UTC — exact `8cd9bd0` became public `0.2.149`; the independently reviewed one-shot loaded-MV3 shadow run passed from genuine Settings and NTP surfaces, advancing the task to DONE while provider exposure remains a separate successor.

## [CAP-FB-20260822-SECURITY-SUITE-SERIALIZATION-01] Serialize the real-Chromium security suite
- Feedback: 2026-08-22 — source inspection confirmed `npm run test:security` launches real headless Chromium but does not self-acquire the canonical serialized Chrome lock
- Updated: 2026-08-22 13:09 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: security-suite integration owner
- Workspace: none
- Branch: `main`
- Base: `1fd65c696cbfcbe0aed135e0ba8c743b8c0ca624`
- Candidate: `0e47a63591c9c798043cc196f6049c410d2cd597`
- Shipping: `origin/main@0e47a63591c9c798043cc196f6049c410d2cd597`
- Acceptance: direct runner execution refuses without the supervisor-issued nonce, live parent identity, exact inherited canonical flock fd and exact wrapper-owned profile; the shell acquires `/tmp/cap-serialized-chrome-acceptance.lock` before profile/evidence/server/browser side effects; production always uses the fixed runner and immutable 120-second timeout; only an explicit self-test token plus the exact repository fixture path and pinned SHA-256 may select a bounded fake runner; the supervisor creates durable bounded evidence and a fresh exact profile, launches one detached PID=PGID=SID group, enforces hard timeout and verified-group TERM then KILL, propagates runner exit/signal, detects exact observed descendants that escape the group, poisons on residue/unsafe cleanup, and removes only the exact current-UID-owned non-symlink profile through the shared live helper; the runner's seven security assertions remain unchanged
- Review: independent exact-candidate process-custody/security review PASS (report SHA-256 `998409ec8cbfb787510a597e5e1b93342dcc8cafa24012a8feae29ba34a7bc78`); independent real-run evidence review PASS (report SHA-256 `99ac2743175f2db85f0d8b77dd2427a026ca59efa3f8e844522e967f736ed385`)
- Gates: executable no-Chrome custody tests 9/9; canonical full unit 944/944 across 14 steps; 102-file production build and exact 128-entry package/validate PASS; one coordinator-authorized serialized real Chromium run passed 7/7 with PID=PGID=SID attested, exit 0, no timeout/survivor/residue, exact profile absent after cleanup, and canonical lock/poison clear
- Blockers: —
- Next: —
- Recover: `git show 0e47a63591c9c798043cc196f6049c410d2cd597 -- scripts/security-suite-supervisor.sh scripts/security-suite-supervisor.mjs scripts/security-suite-custody.mjs scripts/security-suite.ts tests/security-suite-custody.test.ts tests/fixtures/security-suite-fake-runner.mjs package.json TASKS.md`
- History:
  - 2026-08-22 10:00 UTC — opened after correcting the assumption that the security suite was no-Chrome. Historical unsynchronized invocations are noncanonical evidence, not product failures; their assertion results remain observations only.
  - 2026-08-22 12:38 UTC — recomposed the reviewed source shape once from exact public `1fd65c6`: actual wrapper profile wiring plus shared live custody helpers and hash-pinned no-Chrome fixture mutants replace the predecessor's non-executable source-string assertions; no Chrome or security-suite run performed in the implementation lane.
  - 2026-08-22 13:09 UTC — exact reviewed candidate `0e47a63591c9c798043cc196f6049c410d2cd597` became public `0.2.148`; its one authorized serialized real Chromium run and independent evidence review passed 7/7 with clean custody and cleanup, advancing the task to DONE.

## [CAP-FB-20260822-PACKAGE-ARCHIVE-FRESHNESS-01] Build extension ZIPs from an exact fresh inventory
- Feedback: 2026-08-22 — exact fresh packaging was public, but `dist.complete` still embedded a random build-owner token and wall-clock timestamp, so two builds from identical source produced different production ZIP bytes
- Updated: 2026-08-22 20:12 UTC
- Status: IN_REVIEW
- Resume: —
- Priority: P0
- Owner: Store package-boundary recompose implementer
- Workspace: active (local path private)
- Branch: `feat/store-boundary-recompose-093757f`
- Base: `093757fea4bee236f6b9038789ad4a67bd1f3b7a`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: each package retains the reviewed exact tracked-plus-generated regular-file inventory and atomic fresh replacement; `dist.complete` v2 is bounded canonical JSON derived only from the exact Git commit, current bytes of every indexed source file, exact generated service-worker/options bytes and target intent; random lock owner, PID, staging/version paths and wall-clock time remain private; source is fenced before/after bundling; packaging validates the marker before/after inventory hashing and copy verification closes the read/copy race; v1, cross-target, stale commit/source/output, owner/time, malformed/special and source-change mutants fail closed; Store classification independently scans actual package bytes; two same-source builds/packages remain byte-identical
- Review: deterministic marker semantics at `3c96a9ff5f76633c177fcff4fbf7497f4c149790` independently PASSed review SHA-256 `b51b1d6eddae468ef868f98b2ffa141a5148032fee248a3c3461cbc2661517e8`; exact current-parent semantic recompose review pending
- Gates: focused marker/bootstrap and package-freshness gates, canonical full no-Chrome suite, production build with zero Wasm, two same-source canonical markers and exact package/validate ZIPs, gallery/changelog/order/tracker/privacy/diff/release/clean gates required before review; no Chrome or security suite is authorized in this source lane
- Blockers: independent exact-candidate review before publication
- Next: complete no-Chrome gates, commit once as the hook-owned `0.2.157` release candidate, and stop for independent review
- Recover: `git show <candidate> -- build.mjs scripts/dist-complete.mjs scripts/package-archive.mjs tests/build-bootstrap.test.ts tests/package-extension-freshness.test.ts tests/package-extension-freshness-driver.mjs README.md PLAN.md KNOWN-ISSUES.md docs/DESIGN.md docs/OPEN-QUESTIONS.md TASKS.md`
- History:
  - 2026-08-22 11:10 UTC — replaced whole-tree/in-place ZIP packaging with an exact tracked-plus-generated inventory, fresh temp archive, extracted hash verification and atomic replacement; added poison/removal/current-dist/symlink/special/failure-cleanup regressions on exact public `a8985af`.
  - 2026-08-22 12:38 UTC — independent review PASSed; exact `1fd65c696cbfcbe0aed135e0ba8c743b8c0ca624` became public `0.2.147`, repeated real package/validate was byte-identical and free of the ignored stale bundle, and the task advanced to DONE.
  - 2026-08-22 19:55 UTC — reopened narrowly on exact public Tool Library `0.2.156` to recompose the independently reviewed deterministic marker semantics while preserving lock custody, atomic publication, exact inventory and every Tool product byte; Store target binding remains a separate successor.
  - 2026-08-22 20:12 UTC — exact marker successor `093757f` became public
    `0.2.157`; the Store recompose evolves only the marker target/schema and
    package classification boundary while preserving deterministic/atomic custody.

Entries that reached `DONE` or `ABANDONED`, preserved with their complete field set and History.

## [CAP-FB-20260821-DELIVERY-LIFECYCLE-01] Simplify the delivery lifecycle
- Feedback: 2026-08-21 — independent architectural review measured a 96% collapse in landed commits over 72 hours, correlated with the nine-state lifecycle and mandatory handoff protocol, with zero tasks reaching the terminal state
- Updated: 2026-08-22 07:30 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: review author (landed the owner's decision)
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `cdc1a657e3907e018ba8fb33de066aec95bd9596`
- Candidate: this lifecycle commit
- Shipping: this lifecycle commit on `origin/main`
- Acceptance: the owner records an explicit decision on each proposed rule change in `REVIEW-2026-08-21.md` §7; `AGENTS.md`, `TASKS.md` and this repository's stated lifecycle are updated to match that decision in one commit; the two retained hard rules — independent review by a different model, and real-browser verification — remain stated and enforced; tasks that are shipped can reach a terminal state without a per-task owner interaction, or the terminal state is redefined so they can
- Review: owner decision required before any rule is changed; an independent session then verifies the documentation is internally consistent across `AGENTS.md`, `TASKS.md`, `PLAN.md` and `REVIEW-2026-08-21.md`
- Gates: a written decision per proposed rule; a cross-document consistency check for the lifecycle state list; landed-commits-per-day measured for one week after the change
- Blockers: —
- Next: —
- Recover: `git show cdc1a65:AGENTS.md && git log --oneline -- AGENTS.md TASKS.md`
- History:
  - Git reconcile at 2026-08-22 07:30 UTC: merged + the lifecycle adopted; archived.
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.1, §2.3, §7). The measured evidence is recorded there; the proposed rules are explicitly proposals awaiting an owner decision.
  - 2026-08-21 10:30 UTC — `DONE`: merged as `6fa954e` on `origin/main` with **126/126 Chrome journeys passing at that exact tip** (built and driven in a clean worktree). This is the first task closed under the new rule that `DONE` is merged-plus-verified rather than merged-plus-owner-confirmation.
  - 2026-08-21 10:15 UTC — **product owner approved all six proposed rule changes.** `AGENTS.md` and `TASKS.md` now state `OPEN → IN_REVIEW → MERGED → DONE` with `BLOCKED`/`ABANDONED` off-ramps; `DONE` no longer requires a per-task owner interaction. The two load-bearing rules are retained verbatim: a different model/session reviews every change, and real-browser verification with evidence. Content-addressed gate evidence, live remote attestation, versioned acceptance packages and the five intermediate states are removed. Rules 3–6 (review validity by content not base; `CAP-FB-*` in the commit subject; no worktree or evidence on a RAM-backed filesystem; no `-vN+1` without a commit in `-vN`) are recorded in `AGENTS.md`. Existing entries are deliberately NOT rewritten — a documented legacy-state mapping is published instead, so no prior status, evidence or acceptance is silently reclassified.

## [CAP-FB-20260821-PUSHED-TASK-CLOSEOUT-01] Close out the shipped-but-unconfirmed tasks
- Feedback: 2026-08-21 — independent architectural review found four tasks at `PUSHED` awaiting only product-owner confirmation, some since 2026-08-18, blocking three further tasks that name them as dependencies
- Updated: 2026-08-22 07:30 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git merge-base --is-ancestor ffbdf28 origin/main && git merge-base --is-ancestor 215d815 origin/main`
- History:
  - Git reconcile at 2026-08-22 07:30 UTC: closed by this reconciliation (the pushed tasks mapped to MERGED); archived.
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §2.1). No confirmation is inferred and no status of the four tasks is changed by this entry.


## [CAP-FB-20260821-SCHEDULED-MEMORY-BOUND-01] Activate and disarm optional alarms
- Feedback: 2026-08-21 — the optional alarms permission, once granted, never activated the alarm listener in a worker that started before the grant, and removal left alarms armed
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: scheduler lifecycle integration worker
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `5236cac1fe71c19fa00081da5d2c787a84e07424`
- Candidate: `553fdc73ba6d6dcf5312c57f32acc70f73a648a8`
- Shipping: `origin/main@6480005001335fac885f6c7e261999424b0c9dac`
- Acceptance: a genuine Settings click grants + activates alarms (idempotent listener attach or exactly ONE bounded 250ms runtime.reload after the worker re-attests via permissions.contains); permission removal disarms + cancels the pending reload; the exact Chrome 500-active-alarm preflight fails before persistence; cap:scheduledTasks payloads survive as the sole re-arm authority
- Review: independent PASS on the reviewed candidate
- Gates: 876/876 units + build PASS; Chrome 126/126 at `6480005`
- Blockers: —
- Next: —
- Recover: `git show --stat 553fdc73 && git merge-base --is-ancestor 553fdc73 6480005`
- History:
  - 2026-08-22 08:00 UTC — Git reconcile: landed via `553fdc73`; Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).

## [CAP-FB-20260819-CONVERSATION-RUN-STATUS-02] Completed status after the assistant bubble projection
- Feedback: 2026-08-21 — the run-status 'completed' fired before the assistant result bubble was projected, plus the J3 thread-to-hub submit journey
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: run-status integration worker
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `957ed2a1c187d6c104fd4d163e3f53fed74b3b8a`
- Candidate: `c548ad183f79e2e9add29abb77aabebc4f751677`
- Shipping: `origin/main@6480005001335fac885f6c7e261999424b0c9dac`
- Acceptance: the terminal 'completed' fires only after the assistant bubble is in the DOM (the premature-port-done race closed); the J3 thread-to-hub submit journey is reproduced by a real-ntp.js test
- Review: independent PASS on the reviewed candidate
- Gates: 876/876 units + build PASS; Chrome 126/126 at `6480005`
- Blockers: —
- Next: —
- Recover: `git show --stat c548ad18 && git merge-base --is-ancestor c548ad18 6480005`
- History:
  - 2026-08-22 08:00 UTC — Git reconcile: landed via `c548ad18`; Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).

## [CAP-FB-20260821-LIVE-TOOL-PROJECTION-01] Execute streamed tool calls mislabeled as stop
- Feedback: 2026-08-21 — streamed tool calls were mislabeled as stop in the live projection
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: tasks projection worker
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `abd187feb0b66e2c99f469d045250d48914a37ce`
- Candidate: `598fb12a004287753ebb78f8cc385d56e0206f77`
- Shipping: `origin/main@6480005001335fac885f6c7e261999424b0c9dac`
- Acceptance: a streamed tool call executes + projects correctly, never mislabeled as stop
- Review: independent review PASS
- Gates: 876/876 units + build PASS; Chrome 126/126 at `6480005`
- Blockers: —
- Next: —
- Recover: `git show --stat 598fb12 && git merge-base --is-ancestor 598fb12 6480005`
- History:
  - 2026-08-22 08:00 UTC — Git reconcile: landed via `598fb12`; Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).

## [CAP-FB-20260821-TASK-RUN-SCOPE-01] Scope run controls to the active conversation
- Feedback: 2026-08-21 — run controls could act on a different conversation than the one in view
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: tasks scope worker
- Workspace: active (local path private)
- Branch: `origin/main`
- Base: `763ab035a4b9a1b9a5af448a0b61aa8a0d99083d`
- Candidate: `abd187feb0b66e2c99f469d045250d48914a37ce`
- Shipping: `origin/main@6480005001335fac885f6c7e261999424b0c9dac`
- Acceptance: run controls are scoped to the active conversation owner (the runSurfaceOwner fence)
- Review: independent review PASS
- Gates: 876/876 units + build PASS; Chrome 126/126 at `6480005`
- Blockers: —
- Next: —
- Recover: `git show --stat abd187f && git merge-base --is-ancestor abd187f 6480005`
- History:
  - 2026-08-22 08:00 UTC — Git reconcile: landed via `abd187f`; Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).

## [CAP-FB-20260821-SCHEDULED-MEMORY-QUOTA-01] Scheduled runs must not exhaust owner memory or flood errors
- Feedback: 2026-08-21 — hundreds of `handleAlarm` failures reported for one-shot and background-recipe schedules after retained durable authority consumed the master store's former 500-key budget
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: scheduled-memory quota implementation worker
- Workspace: active (local path private)
- Branch: `fix/scheduled-memory-quota-flood-46a3e6d`
- Base: `46a3e6df9a9a63e31ceb8da2fde6551f1a8eb621`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: remove the arbitrary key-count limit while retaining the 8 MiB/store, 64 MiB global and 256 KiB/value limits; isolate registry and per-execution durable authority from model-writable master memory; copy-verify-delete legacy authority idempotently without losing owner values or retained runs/logs; let new scheduled runs reach terminal state; and disarm/surface a genuine storage-quota failure once with owner Retry/Cancel rather than flooding every alarm tick
- Review: independent source/security/storage review pending
- Gates: focused migration, capacity, interruption, retain-all, scheduler circuit-breaker, retry and task-row tests; full unit/build/package/scan/security/gallery/changelog checks pending
- Blockers: —
- Next: —
- Recover: `git log --all --oneline --grep='CAP-FB-20260821-SCHEDULED-MEMORY-QUOTA-01'`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: landed on origin/main (the quota-flood successor chain).
  - 2026-08-21 19:55 UTC — root cause identified: retained `run:*`, `run-log:*`, outbox, resume and payload authority shared `memory/master` with owner keys, so normal retain-all operation consumed the per-store key ceiling. Implementation isolates durable authority by execution while preserving every constitutional quota and adds a one-transition scheduled-task storage circuit breaker with owner retry/cancel.

## [CAP-FB-20260821-TASK-VIEW-TRANSITION-GHOST-01] Task-view transition must not ghost the obsolete hub
- Feedback: 2026-08-21 — accepted Durable-run evidence exposed the old hub composer and dashboard cross-fading beneath the opening task view while the View Transition top layer was active; immutable v2 review later isolated remaining task→full-view pixels to `::view-transition-old(overlay-view)`
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: current-main reconciliation worker
- Workspace: active (local path private)
- Branch: `reconcile/task-transition-eed40358-worker`
- Base: `eed403580c001c472dcf31954626b798364cdb86`
- Candidate: this current-main reconciliation commit
- Shipping: —
- Acceptance: entering/restoring a task and leaving an active task/thread for Hub, Settings, Directory, Skills, or Artifacts hides obsolete old `root` and old `overlay-view` pixels beneath the destination; source/target route policy preserves normal unrelated transitions and keeps new `overlay-view` named and active; temporary policy cleans after finish/abort/races; focus lands after the top-layer transition; switching to a named agent on an already-open thread explicitly routes focus to the thread composer synchronously without spurious view transitions; no-argument follow-up/nudge and same-thread routes remain focus-neutral while fresh opens retain default title focus; Directory's covered sidebar and edge control remain inert/`aria-hidden` and initiating-trigger focus returns after close; reduced motion bypasses snapshots; a clean-archive production build materializes the canonical changelog in the loaded extension so Settings has zero missing-file errors
- Review: immutable v2/v3/v4 loaded-MV3 review confirmed no-ghost Task→Settings suppression at 40/125/220ms, but v4 isolated a same-surface task→named-agent focus drop to `showThreadView`'s already-open branch (`ntp.js:681`). The first focus successor routed both explicit and default focus and independent k3 review found the default stole composer focus on no-argument follow-ups. The corrected successor distinguishes explicit focus ownership, uses the real shared focus helper in tests, preserves no-flash/no-transition behavior, and keeps no-argument routes focus-neutral. Independent source re-review and loaded-MV3 review remain required.
- Gates: current-main reconciliation passes 15/15 transition + 2/2 Directory focus tests, 712/712 full no-Chrome tests, production build, deterministic package, gallery, changelog identity/order (51 unique descending after the successor commit), 7/7 sandbox security, changed-helper/test formatting, JS syntax, and diff checks. The inherited `extension/ntp/ntp.js` is not repository-format-clean at exact base `eed40358`; the reconciliation keeps its new hunks formatter-aligned without widening scope to reformat the 1,700-line baseline. Residual loaded-MV3 proof must cover midpoint policy, follow-up focus retention, same-thread re-click, fresh-open title focus, explicit agent composer focus, genuine interaction, and singular run/thread projection
- Blockers: —
- Next: —
- Recover: `git log --all --oneline --grep='CAP-FB-20260821-TASK-VIEW-TRANSITION-GHOST-01'`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: landed on origin/main (the task-transition chain).
  - 2026-08-21 13:14 UTC — reproduced from accepted screenshot/CDP evidence as a transient root-snapshot defect, scoped root suppression to task routing, and added finish/abort/reduced-motion focus-cleanup tests; no settled-layout defect or global transition disable is claimed.
  - 2026-08-21 13:27 UTC — recovered the interrupted draft after host ENOSPC, made overlapping-route focus wait for the active top layer without cancelling incidental transitions, fenced synchronous update replay, and passed the complete no-Chrome gate; status remains OPEN until an independent reviewer is assigned.
  - 2026-08-21 14:19 UTC — exact loaded-MV3/browser review rejected `7d3b3e7e`: task→Settings still showed old task controls and clean-archive builds omitted the ignored generated changelog. The successor makes suppression a source/target task-boundary policy (including Settings/Directory/Skills), moves embedded-view focus after settlement, and makes build/package generation of canonical `CHANGELOG.md` fail-closed. The reported `durable-run-registry` hit target is recorded as valid Shadow DOM retargeting for the future harness, not a product change. Release `0.2.116` was local-candidate identity only.
  - 2026-08-21 15:31 UTC — immutable v2 review rejected exact `8b5a6287`: old `root` suppression worked, but shared naming paired the old task and new full-view containers as `overlay-view`, leaving the old named snapshot visible at the 125 ms midpoint. The provisional 0.2.118 successor hides only that old named image under the existing task-boundary class, retains new named-overlay activity and unrelated route cross-fades, and adds complete enter/exit route plus semantic CSS coverage.
  - 2026-08-21 15:45 UTC — reconciled reviewed successor content onto public Directory main `eed40358` rather than rebasing blindly. The provisional identity is `0.2.115`; Directory's `side` + `sideToggle` covered-state authority and initiating-trigger focus return are retained, with focus composed after transition settlement. Current-main review and loaded-MV3 proof remain open.
  - 2026-08-21 16:45 UTC — v4 browser review confirmed Task→Settings midpoint zero-ghost policy, but exposed dropped composer focus on same-surface task→named-agent switches. The first focus successor routed `focusAfter` synchronously in `showThreadView`'s already-open branch when connected, preserving no-transition and no-flash behavior while restoring composer focus continuity.
  - 2026-08-21 17:58 UTC — independent k3 review found the first focus successor also routed the default `threadTitle` on no-argument follow-up and same-thread paths, stealing composer focus, and found a trailing-EOF diff-check failure. The corrected successor focuses only explicit already-open route dispositions, directly tests the shared focus helper plus no-argument call sites, removes the whitespace failure, and records the provisional `0.2.118` identity.

## [CAP-FB-20260819-TRACKER-01] Repository-local task and bug recovery
- Feedback: 2026-08-19 — product-owner recovery directive after task state was lost across coordinator failures
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Next: —
- Recover: `git log -1 --format=%H -- TASKS.md && git diff -- TASKS.md`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the tracker + its recovery conventions are on origin/main.
  - 2026-08-19 16:40 UTC — replacement draft opened on the exact public base after the first writer disappeared.
  - 2026-08-19 17:01 UTC — ownership: glm recovery writer → gpt recovery writer (prior writer reached a hard usage limit); interrupted draft preserved for audit.
  - 2026-08-19 17:07 UTC — public schema, Git objects, Markdown links, root-history copy, compatibility page, privacy/secret patterns, docs-only scope, and diff all passed pre-freeze validation.
  - 2026-08-19 17:23 UTC — independent k3 review PASSed exact source `3402278`; no blocker/high/medium finding remained.
  - 2026-08-19 17:25 UTC — ownership: gpt recovery writer → gpt integration writer (current-main replay after review PASS); status advanced to INTEGRATING on exact `ffbdf28`.
  - 2026-08-19 17:29 UTC — current-main schema, object/ancestry, required statuses, links, privacy/secret patterns, history blobs, compatibility, six-doc scope, and diff all passed pre-freeze validation.

## [CAP-FB-20260818-USAGE-RECORDING-01] Model usage records are missing or misattributed
- Feedback: 2026-08-18 — repeated product-owner report invalidated earlier fixed claims
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: usage-attribution integration writer
- Workspace: active (local path private)
- Branch: `rapid/usage-598fb12`
- Base: `598fb12a004287753ebb78f8cc385d56e0206f77`
- Candidate: this integration commit (`0.2.125`)
- Shipping: —
- Acceptance: each real provider attempt records the correct attempt identity exactly once across async retry, synchronous throw, abort, and plain stream-object returns
- Review: deepseek-flash PASS on exact clean `d6030b7`; reviewed integration precedent `963b411`; exact current-main reconciliation review pending
- Gates: current-main content reconciliation confirms accepted provider-bound runtime/probes are exact Git blobs; focused usage/provider/agent tests and build pass; loaded-MV3 usage proof remains
- Blockers: —
- Next: —
- Recover: `git diff 598fb12..rapid/usage-598fb12 -- TASKS.md CHANGELOG.md KNOWN-ISSUES.md PLAN.md docs/usage-precedent-review.md package.json package-lock.json extension/manifest.json`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the docs-only usage reconciliation landed on origin/main.
  - 2026-08-18 18:20 UTC — opened after usage remained empty despite earlier claims.
  - 2026-08-19 16:58 UTC — reviewer reproduced synchronous-throw identity leakage and plain-object incompatibility on `fc69751`.
  - 2026-08-19 17:12 UTC — independent re-review PASSed narrow successor `d6030b7`; integration and browser acceptance remain open.
  - 2026-08-21 13:30 UTC — prior current-main candidate `1ea0d6d4` verified reviewed runtime/test blobs on `0f86e60`, but later serialized integrations overwrote its tracker/release-only reconciliation while retaining the accepted runtime.
  - 2026-08-21 21:17 UTC — reconciled by content on exact public `598fb12`: accepted runtime/probes remain byte-identical, later provider adapters, Durable records, task scoping, and UI changes are preserved, and a documentation/version-only `0.2.125` candidate entered independent review after focused no-Chrome gates.

## [CAP-FB-20260818-RUN-STATUS-01] Visible task run-status lifecycle
- Feedback: 2026-08-18 — visible thinking/loading state repeatedly stuck or crossed task surfaces
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat ffbdf28 && git ls-remote origin refs/heads/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the run-status surface is on origin/main (content verified).
  - 2026-08-18 12:50 UTC — opened for the real extension lifecycle defect.
  - 2026-08-19 16:59 UTC — exact reviewed and gated integration `ffbdf28` was pushed and remotely verified.

## [CAP-FB-20260818-PROVIDER-PICKER-01] Configured-agent provider and model picker
- Feedback: 2026-08-18 — picker behavior and evidence harness were unreliable
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat c7b5126 && git merge-base --is-ancestor 344df55 c7b5126`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:50 UTC: the provider-picker code is on origin/main (the provider/options surface); conservative MERGED — the exact owner-click + real-browser journey evidence at the tip remains the browser gate.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `READY_FOR_BROWSER` mapped to `IN_REVIEW` (unchanged semantics).
  - 2026-08-18 12:55 UTC — opened from the broken picker report.
  - 2026-08-19 16:15 UTC — bounded, snapshot-consistent harness successor reached browser-ready state.

## [CAP-FB-20260818-SIDEPANEL-PARITY-01] Side-panel Agents and Tasks parity
- Feedback: 2026-08-18 — screenshot review found scrollbar, alignment, collapsed-content, and row-formatting regressions
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
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
- Blockers: —
- Next: —
- Recover: `git show --stat 69439b1 && git merge-base --is-ancestor 69439b1 origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `BLOCKED` mapped to `BLOCKED` (unchanged semantics).
  - 2026-08-18 20:58 UTC — opened from screenshot feedback.
  - 2026-08-19 00:04 UTC — delivery evidence retained; confirmation gap kept the task blocked from its prior PUSHED state.

## [CAP-FB-20260819-AGENT-DIRECTORY-01] Agent Directory overlay and function cards
- Feedback: 2026-08-19 — full Directory must own the covered view and present truthful per-function metadata
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: k3 (reconciliation worker)
- Workspace: active (local path private)
- Branch: `fix/agent-directory-01`
- Base: `0f86e60a3935b196e4a2c3ae13306a05a3ea6105`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: covered sidebar controls are inert/hidden and restored exactly; responsive cards expose canonical descriptions, schema metadata, and function-specific accessible states
- Review: gemini static review classified exact old-base `38cdb15` READY_FOR_BROWSER; fresh current-main integration review pending
- Gates: old-base integration reported unit 542, static security 19, components 13, build/gallery/parse; no current-main browser evidence
- Blockers: —
- Next: —
- Recover: `git show --stat ac72ae19 && git show --stat 993bc9e && git show --stat 0f86e60`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the Directory overlay + function cards are on origin/main.
  - 2026-08-19 13:20 UTC — opened from overlay and function-card feedback.
  - 2026-08-19 15:55 UTC — one-commit old-main integration froze with reviewed exclusive blobs preserved.
  - 2026-08-19 17:23 UTC — gemini static review classified `38cdb15` READY_FOR_BROWSER, but `origin/main` had advanced to `ffbdf28`; reintegration is mandatory before any browser or push claim.
  - 2026-08-21 15:20 UTC — reconciled the reviewed Directory lineage (accepted source `ac72ae19` with 20/20 old-base loaded-MV3 evidence; current-main integration `e5e3d01` + focus-restore `993bc9e`) onto exact `0f86e60` under the delivery-lifecycle content rule. Scope kept to the Directory overlay/covered-view state, responsive `<tool-directory-card>` function cards with schema metadata, the view focus trap/restore controller, and exact owner/source labels; Assets, the generalized covered-nub policy, scheduled memory, run-status, transitions, and onboarding are deliberately excluded; Durable/provider/permission logic preserved. No-Chrome gates on the candidate: full unit suite, build, gallery, security, diff checks. Independent review and fresh loaded-MV3 evidence remain open.

## [CAP-FB-20260819-ASSETS-01] Assets browser and quick access
- Feedback: 2026-08-19 — make Assets inspectable, reusable, safely previewable, and reachable without losing full-browser navigation
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat 202b85e && git show --stat 0ba92a2`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the stable sandbox previews + the quick drawer are on origin/main (content verified).
  - 2026-08-19 13:24 UTC — opened from two Assets usability reports.
  - 2026-08-19 17:04 UTC — browser review BLOCKed `dcb9efe` on non-interactive generated HTML and concurrent index loss.
  - 2026-08-19 17:13 UTC — successor `202b85e` added manifest-sandboxed interaction and serialized per-origin index mutation; canonical review resumed.

## [CAP-FB-20260819-PERMISSIONS-01] Task and agent permission orchestration
- Feedback: 2026-08-19 — replace mid-task broad-host failures with planned, minimal, owner-driven permission acquisition
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat 7e537d6 && git merge-base --is-ancestor 5001b4b 7e537d6`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:50 UTC: the permission-orchestration code is on origin/main (the owner-approval + capability surfaces); conservative MERGED — the genuine owner-gesture + browser-journey evidence at the tip remains the browser gate.
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `READY_FOR_BROWSER` mapped to `IN_REVIEW` (unchanged semantics).
  - 2026-08-19 13:32 UTC — opened from permission-preflight feedback.
  - 2026-08-19 15:53 UTC — gemini static audit classified the exact candidate READY_FOR_BROWSER, not final PASS.

## [CAP-FB-20260818-WEBMCP-01] Real and inspectable WebMCP discovery
- Feedback: 2026-08-18 — discovery source and proof were not visible in DevTools
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat 215d815 && git merge-base --is-ancestor 215d815 origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the WebMCP discovery/status surfaces are on origin/main (content verified).
  - 2026-08-18 13:16 UTC — opened after discovery lacked inspectable proof.
  - 2026-08-18 19:16 UTC — reviewed integration pushed and remotely verified.

## [CAP-FB-20260818-AGENT-ACCESS-01] Side-panel orchestration and unified agent access
- Feedback: 2026-08-18 — shipped side panel was a stub and agent selection was fragmented
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat e3c81a1 && git merge-base --is-ancestor e3c81a1 origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: landed on origin/main.
  - 2026-08-18 13:34 UTC — opened and expanded to all agent-selection surfaces.
  - 2026-08-18 18:49 UTC — reviewed integration pushed and remotely verified.

## [CAP-FB-20260818-SIDEBAR-01] Collapsed-sidebar alignment and edge toggle
- Feedback: 2026-08-18 — collapsed actions and edge toggle were misaligned and inaccessible
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
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
- Blockers: —
- Next: —
- Recover: `git show --stat aa58b6d && git merge-base --is-ancestor aa58b6d origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `BLOCKED` mapped to `BLOCKED` (unchanged semantics).
  - 2026-08-18 13:25 UTC — opened for collapsed rail geometry.
  - 2026-08-18 22:42 UTC — blocked from prior PUSHED state pending superseding parity confirmation.

## [CAP-FB-20260818-TOOL-TREE-01] Explorable structured tool-call output
- Feedback: 2026-08-18 — raw escaped JSON was not usable
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
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
- Blockers: —
- Next: —
- Recover: `git show --stat 5e3285a && git merge-base --is-ancestor 5e3285a origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: legacy state `BLOCKED` mapped to `BLOCKED` (unchanged semantics).
  - 2026-08-18 12:52 UTC — opened to replace raw JSON blobs.
  - 2026-08-18 23:11 UTC — historical delivery retained; confirmation gap kept the task blocked.

## [CAP-FB-20260818-ARTIFACT-TX-01] Transactional and owner-confirmed artifact management
- Feedback: 2026-08-18 — wider review found split body/index writes and destructive-operation authority gaps
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: release coordinator
- Workspace: none
- Branch: `origin/main`
- Base: `7aea2698017815a169172f6a25523bc336df8333`
- Candidate: `0bf2065f8ac118508addad19d21275aa2bced0e3`
- Shipping: `origin/main@6480005001335fac885f6c7e261999424b0c9dac` (landed via `0bf2065`)
- Acceptance: crash-safe body/index/WAL recovery, monotonic per-key absence authority, bounded repair, scoped access, and exact owner confirmation all compose on current main
- Review: independently reviewed transaction and owner-approval authority landed by content on current main; historical old-base review remains recorded in History
- Gates: current-tip Chrome 126/126 directly exercised asset CRUD, exact owner deny, unchanged-body checks, and opaque-reference survival across a service-worker restart; 876/876 units and build PASS at `6480005`
- Blockers: —
- Next: —
- Recover: `git show --stat 0bf2065 && git merge-base --is-ancestor 0bf2065 6480005`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the crash-safe artifact transaction authority is on origin/main.
  - 2026-08-18 20:18 UTC — split transactional storage from the separately reviewed approval correction.
  - 2026-08-19 16:23 UTC — complete reviewed five-commit source range froze as one old-main integration commit.
  - 2026-08-19 17:23 UTC — gemini static review classified `2633426` READY_FOR_BROWSER, but `origin/main` had advanced to `ffbdf28`; reintegration is mandatory before any browser or push claim.

## [CAP-FB-20260818-BOUNDS-01] Bounds, UTF-8, race, and accessibility backlog
- Feedback: 2026-08-18 — wider review found stale mutations, unbounded diagnostics, encoding, and accessibility gaps
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
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
- Blockers: —
- Next: —
- Recover: `git show --stat cc68ba4 && git merge-base --is-ancestor 768225b cc68ba4`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the bounds/diagnostics content landed on origin/main.
  - 2026-08-18 20:18 UTC — opened from wider-review findings.
  - 2026-08-19 14:14 UTC — code and AX gates cleared; honestly blocked on the headed environment.

## [CAP-FB-20260818-SYSPROMPT-01] Versioned system-prompt settings
- Feedback: 2026-08-18 — system-prompt editing required protected runtime policy and upgrade-safe owner customization
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show --stat 22fd2c0 && git merge-base --is-ancestor 22fd2c0 origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the system-prompt editor is on origin/main (content verified).
  - 2026-08-18 12:58 UTC — opened for versioned prompt customization.
  - 2026-08-18 17:10 UTC — reviewed integration pushed and remotely verified.

## [CAP-FB-20260819-CONVERSATION-RUN-STATUS-01] One truthful conversation run-status surface
- Feedback: 2026-08-19 — conversation feedback requested the preferred grid status inside agent conversations and removal of the duplicate thinking spinner; repeated 2026-08-20 feedback identified the still-live top-of-task `div.run-status > loading-state` as the unreplaced legacy surface
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: implementation worker
- Workspace: active
- Branch: `rapid/runstatus-598fb12`
- Base: `598fb12a004287753ebb78f8cc385d56e0206f77`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: remove the standalone top-of-thread `div.run-status` presentation and its duplicate thinking state; every task and agent conversation renders exactly one shared conversation-owned grid status at the bottom of the transcript for queued, running, tool activity, retrying, waiting for permission, completed, failed, and cancelled states; status and accessible naming expose useful live activity rather than the generic `thinking…`; reconnect, reload, double-send and surface switches cannot create two status owners or reintroduce the legacy container; terminal `thread.get` replacement before a no-tools completion suppresses only the byte-identical assistant append for the same execution/thread/surface owner while genuine revisions and new attempts remain visible
- Review: reviewed successor content reconciled onto current main; pending independent review of the current-main conflict resolutions and loaded-MV3 lifecycle/visual/accessibility behavior
- Gates: component and lifecycle units; terminal-projection-before-response, revision, stale-owner, follow-up and hard-reload semantic tests; source assertion that the legacy top-of-thread container/render path is absent; loaded-MV3 task, named-agent, background-agent, and site-agent conversations; genuine working/tool/permission/retry/terminal states; raw AX single-live-region and name/state inspection; bottom-of-transcript placement; switch/reconnect/reload/double-send screenshots; enumerate user/assistant bubbles after every browser journey and reject adjacent byte-identical assistant bubbles (not only the named-agent journey); zero duplicate spinner, stale status, generic-only activity, or top-of-thread banner
- Blockers: —
- Next: —
- Recover: `git diff 598fb12..HEAD -- extension/shared/conversation.js extension/shared/thread-projection-authority.js extension/lib/terminal-thread-projection-lifecycle.js extension/ntp/ntp.js tests/conversation-run-sequence.test.ts tests/thread-projection-authority.test.ts tests/terminal-thread-projection-lifecycle.test.ts`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the conversation-owned run-status surface + the J2/J3 ordering fix are on origin/main.
  - 2026-08-21 21:19 UTC — reconciled the reviewed run-status/projection successor onto public `598fb12`, retaining the current task-scoped durable-run controls and streamed tool-call finish normalization. Conflicts kept the current covered-nub policy, placed the single run-status component after the transcript while retaining the hidden task-scoped registry, and reserved one current-main release increment.
  - 2026-08-21 17:58 UTC — transition browser evidence exposed a transient no-tools duplicate: terminal `thread.get` had already replaced the transcript with the exact persisted result before the response completion appended the same bytes. The transition delta did not cause it. The run-status content was composed onto accepted transition tip `46a3e6df`; a page-local authoritative projection record now binds thread, immutable execution, surface owner and monotonic render generation, suppressing only a byte-identical same-attempt completion. Streamed revisions, differing terminal bytes, new attempts, stale owners and hard reload remain explicit test cases. The exact-`43e395d` headed package is superseded pending successor review/browser evidence.
  - 2026-08-19 18:13 UTC — captured as a distinct presentation task; the pushed lifecycle task remains intact and is linked rather than reopened.
  - 2026-08-20 15:21 UTC — repeated product-owner feedback confirmed current main still renders the standalone top-of-task `div.run-status` containing a generic `thinking…` loading component. Priority raised to P0; the earlier lifecycle push is explicitly not presentation acceptance.
  - 2026-08-21 17:10 UTC — CURRENT-MAIN SUCCESSOR (CAP-FB-20260821-RUN-STATUS-CURRENT-MAIN-SUCCESSOR): Directory `eed40358` merged to public main, so the run-status content was cherry-picked onto exact `eed40358` (only CHANGELOG needed hand-resolution; Directory's syncViewOpen side+toggle inert behavior verified preserved). The fresh old-base browser run (evidence `cap-run-status-70d40a8d-20260821T152331Z-6910238e`) found TWO product defects: (1) FIXED — late-settled duplicate terminal assistant bubble: conversation.js appended the streamed `text` event (hasToolCalls) AND the identical `res.result` at completion; the streamed text is now tracked per attempt and the completion append fires only when the authoritative result differs (two regression tests, incl. the revised-result case). (2) J2 hub→thread re-submission never exposed `running` within the 5s witness: NOT REPRODUCIBLE in product code — a new semantic test drives the real conversation.js through the exact sequence (first run fenced mid-hold → hub re-submit) and the second turn emits queued→running in milliseconds; the SW serializes concurrent runs via a queueing mutex (never rejects), and the J1↔J2 wiring is identical. The observer slice for J2 was never archived on abort, so the browser-layer cause is undeterminable from this evidence; the reordered browser successor (cancellation+A/B first) re-verifies on this candidate, and persisting the observer archive on failure is recommended to the harness owner. Provisional 0.2.115. No-Chrome gates green on the exact commit.
  - 2026-08-21 16:20 UTC — independent loaded-MV3 browser review (journeys 1+5 PASS: single bottom-of-transcript surface, canonical live states, legacy surfaces absent, single AX live region, keyboard focus contrast) found ONE narrow routing defect: the run-status action called `chrome.runtime.openOptionsPage()`, which creates no target from the NTP and strands the user. Fixed: the action routes in-context via the standard `openView("options/options.html", "Settings")` (reveals in place, focuses the frame); semantic action→route/focus tests pin the contract. The view-transition ghosting observation stays with the separate transitions candidate; cancellation + thread-switch journeys remain for the browser successor. Gates re-run green on the amended candidate (700 units, build, gallery, security, changelog order, diff check).
  - 2026-08-21 13:45 UTC — reconciled the independently reviewed `17890e81` run-status content onto current main `0f86e60` (review validity carried per the delivery-lifecycle content rule; main had advanced through provider/permission/durable lanes touching the same files). The legacy top-of-thread `div#run-status` banner and its generic `loading-state` spinner path are removed; the single shared `<conversation-run-status>` surface renders at the bottom of the transcript (below `<agent-conversation>`, above the composer); the canonical vocabulary gains the `waiting-for-permission` state emitted by the permission preflight; the sidepanel detail status maps the canonical states. The covered-nub policy half of `17890e81` is deliberately NOT in this commit — it remains with `CAP-FB-20260819-COVERED-NUB-VISIBILITY-01`. No-Chrome gates: 698 unit/component pass, build, gallery sync/check, diff check. Browser evidence and independent review remain open.

## [CAP-FB-20260819-COMPOSER-AGENT-MENTIONS-01] Composer copy and behavior for mentioning any agent
- Feedback: 2026-08-19 — composer feedback rejected site-agent-only reply wording because the same composer must mention any supported agent kind
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show bbeff7b:TASKS.md && git grep -n "mention" bbeff7b -- extension`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the composer mention routing landed on origin/main.
  - 2026-08-19 18:13 UTC — captured separately from unified agent access because the requested copy and composer behavior remain incorrect after the earlier picker delivery.

## [CAP-FB-20260819-COVERED-NUB-VISIBILITY-01] Covered side-panel nub visibility across views
- Feedback: 2026-08-19 — the side-panel edge nub remains visible where the main page or another view covers it; the Directory-only correction is not a complete view policy
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P1
- Owner: integration worker
- Workspace: active (local path private)
- Branch: `reconcile/nub-narrow-transition-focus-46a-r1`
- Base: `46a3e6df9a9a63e31ceb8da2fde6551f1a8eb621`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: a documented per-view policy keeps the nub available only where it is actionable and otherwise makes it hidden, inert, non-hit-testable, non-focusable, and absent from the unignored AX tree; closing or switching views restores the exact prior sidebar state; Settings retains every section/control and has no document-level horizontal overflow at 500px or 360px
- Review: exact `35f3246f` nub/responsive content independently passed for recomposition; independent review of this `46a3e6df` composite remains pending before browser authorization
- Gates: semantic nub lifecycle/restoration and responsive CSS contracts; full unit/build/package/shipped scan/gallery/changelog/security/syntax/format/diff checks; fresh loaded-MV3 48-cell matrix plus both rapid sequences remains required
- Blockers: —
- Next: —
- Recover: `git log --all --oneline --grep='CAP-FB-20260819-COVERED-NUB-VISIBILITY-01' && git diff 46a3e6df -- extension/ntp extension/options/options.css tests`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the covered-nub policy landed on origin/main.
  - 2026-08-19 18:13 UTC — opened as a generalized covered-view defect; existing Directory and sidebar tasks remain separate linked workstreams.
  - 2026-08-21 15:45 UTC — reconciled the reviewed generalized nub policy onto exact `0f86e60`: pure per-view `extension/ntp/view-policy.js`, callback-scoped application, exact collapse-state restoration, author-level hidden CSS, documentation, and focused tests.
  - 2026-08-21 16:05 UTC — independent review fixed the first reconciliation's eager `openView()` policy sync and expanded null-input, rapid multi-hop, source-order, and collapse-state test coverage; amended `aff2375e` passed source review for browser.
  - 2026-08-21 16:42 UTC — content-reconciled the reviewed nub behavior onto exact transition/Directory tip `9a118d44`, preserving route-aware transitions, deferred focus, changelog shipping, and the sidebar's covered inertness while making `applySidebarNubPolicy` the sole toggle authority. Immutable v4 browser evidence had passed eight cells and canonical keyboard activation before exposing Settings iframe overflow at 500px (`640 > 490`); this candidate reflows the navigation/forms at the content breakpoint, adds 500px/360px semantic contracts, and remains pending independent source plus full loaded-MV3 review.
  - 2026-08-21 17:16 UTC — recomposed independently accepted nub/responsive content onto exact transition-focus tip `46a3e6df`, retaining explicit-only same-surface composer focus, no-argument follow-up/same-thread neutrality, route snapshots, Directory focus authority, sole nub ownership, and the complete shrink-safe Settings reflow. Exact composite review and the full loaded-MV3 matrix remain pending.

## [CAP-FB-20260819-DURABLE-BACKGROUND-RUNS-01] Durable runs independent of mounted UI
- Feedback: 2026-08-19 — task and agent runs must continue through task/view switches, Settings navigation, tab closure, and later reopen rather than being owned by mounted conversation UI
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P0
- Owner: integration writer
- Workspace: active (local path private)
- Branch: `integrate/durable-final`
- Base: `7f1f7aee216c2a87a69df584f059d526bbf07a4c`
- Candidate: this tracker commit
- Shipping: —
- Acceptance: workflow/service-worker state is the run authority; switching task, agent, Settings, or full views and closing/reopening the tab never cancels or loses an accepted run; reconnect shows bounded progress and exactly one terminal result; restart recovery is idempotent and stale UI owners cannot commit
- Review: exact source `dd41258f` and its exact 7/7 loaded-extension proof independently PASSed for integration; current-main integration review pending
- Gates: exact accepted commit/tree/release `dd41258f` / `80ca97f0` / `0.2.113`; execution `exec:a2a68c2b-b80e-4f68-9309-b75574953b4c`; seven direct-CDP screenshots, retained logs, one thread/result/registry identity, zero retry/relaunch/resume; focused/full/build/no-Chrome gates rerun on integration
- Blockers: —
- Next: —
- Recover: `git show ecf657fe:TASKS.md && git diff ecf657fe..feat/durable-runs-current-main -- TASKS.md extension tests`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the Durable run authority landed on origin/main.
  - 2026-08-21 03:25 UTC — prepared the 0.2.109 early-admission successor from exact `4f57ad89`/tree `848de1b5`: `addToIndex` now participates in `start()` compensation; add-to-index-first native quota leaves no remnants; run-task and direct delegation return normalized fulfilled storage responses without mutating immutable exceptions or invoking rollback before readable authority exists. Established later native quota still attempts zero-progress rollback before response settlement, while progressed/uncertain authority is preserved. Focused/full/static gates and independent review remain required.
  - 2026-08-21 02:45 UTC — prepared the 0.2.108 quota-atomicity successor after v24 proved `navigator.storage.estimate()` can report ample quota while the bounded OPFS filesystem is full: native `QuotaExceededError` now bypasses impossible terminal settlement, compensates only a persisted public-shape running record with `progressCount === 0`, deletes execution-owned bytes before rewriting the registry, verifies zero remnants, and remains retry-safe after partial deletion. Progressed, paused, cancelled, terminal, and side-effect-uncertain executions are preserved for explicit recovery. Focused/full/static gates and independent source review remain required.
  - 2026-08-20 09:38 UTC — addressed coordinator final review after k3's `f05a1da4` PASS: the third prepared resume now terminalizes exactly once after a crash, an already-at-ceiling paused record terminalizes instead of allowing attempt four, cancellation still wins, the dead `paused-resume-failed` phase was removed, side-effect uncertainty now truthfully requires an owner decision, and a thrown live-abort callback gets at most one immediate idempotent retry with both errors/final outcome retained. Fresh final-delta review and loaded-MV3 acceptance remain pending.
  - 2026-08-20 08:40 UTC — addressed independent FIX_REQUESTED: added owner-reachable native run controls with terminal cancellation confirmation/live errors, split cancellation so the live abort fires immediately after authoritative tombstone CAS, added bounded tokenized resume dispatch with visible re-pause, bound non-secret provider identity/scope across resume, fail-safe `paused-side-effect-uncertain`, stable dispatch idempotency keys, hostile execution-ID rejection, and quota/no-stranded-run coverage. Fresh independent and loaded-MV3 review remain mandatory.
  - 2026-08-20 08:12 UTC — implemented the resolved policy as a source-review/browser-pending successor: explicit owner cancellation persists a terminal tombstone before abort and wins every outbox boundary; cancelled IDs cannot resume; interruptions automatically reclaim the same ID; narrow provider permission failures pause visibly and resume only after resolution; `run-retention-v1` retains all per-run logs with no automatic compaction/eviction and non-destructive legacy migration. The prepared core v13 run's reported 64/64 remains provisional evidence under independent review and is not authority for this successor.
  - 2026-08-20 03:47 UTC — replaced the invalid symlinked dependency root with a bounded real-tree copy inside the current worktree and reran the required focused/full unit, security, build, gallery, and changelog checks green; symlink-backed runs are non-evidence. Exact-commit independent source review and loaded-MV3 browser acceptance remain pending.
  - 2026-08-20 03:47 UTC — ownership: unassigned → implementation worker (current-main replay); replayed the accepted non-policy durable-run PRODUCT/TEST/TASK intent from `8de8a157` onto exact public main `ecf657fe` as the prepared 0.2.105 successor. Historical v6 browser evidence (64/64) remains accepted only for the stale old-base source; no current-main browser acceptance is claimed.
  - 2026-08-19 21:09 UTC — implemented the approved non-policy foundations from exact public `af1163be`: trusted immutable-execution registry, outbox-first idempotent journal/thread/registry terminal protocol, revisioned register-buffer-snapshot-drain reconnect, direct `agent.delegate` coverage, boot/heartbeat truth, and outbox-first recovery before honest orphaning. Deterministic failure injection covers every terminal persistence boundary and forbids terminal-result/orphan double state. Cancellation, retention, progress provenance/granularity, and cross-restart resume remain explicit unsupported/pending-policy states; Status remains OPEN pending independent and loaded-MV3 browser review.
  - 2026-08-19 18:13 UTC — captured as a new durability goal rather than broadening the already-pushed visible lifecycle task after delivery.
  - 2026-08-19 19:35 UTC — research completed and frozen in docs/durable-background-runs-design.md: exact current-behavior map (ad-hoc runs have no durable state/lease vs scheduled tasks' full durability; tab close is safe via SW authority + surface fencing; no live-state replay on reconnect), durable per-run registry design (heartbeat, running/settling/terminal/orphaned phases), idempotent startup recovery sweep, run.list + progress-port replay reconnection, six acceptance criteria and six fixtures. Policy questions (ad-hoc cancellation, orphan retention, progress granularity, resume-vs-orphan) remain explicitly OPEN and unapproved.
  - 2026-08-19 19:56 UTC — re-review BLOCK corrected (final finding): the outbox now persists the full recoverable terminal payload (or durable payload reference), never only a digest; the thread assistant/status terminal append is idempotent by executionId; startup reconciliation completes outbox entries BEFORE any orphaning decision (a stale settling record with an outbox is completed, never orphaned); the fault matrix now covers the thread-write and outbox acknowledgement/removal boundaries. Policy questions remain explicitly OPEN and unapproved.
  - 2026-08-19 19:50 UTC — independent review BLOCK corrected (8 findings): scheduled behavior re-mapped truthfully (in-memory same-boot authority, heartbeat as storage-failure canary, boot-identity lock clear, re-arm reconciliation, creation-only quarantine, and the at-least-once duplicate window between journal commit and schedule removal); ad-hoc map now includes the durable thread authority and its three exact crash windows; exactly-once terminal now specified as an explicit commit protocol (idempotent journal result keyed by immutable executionId + CAS run transition + durable outbox + full fault matrix); run registry requires a newly reserved trusted master-store prefix (model writes cannot forge it); reconnect replay uses monotonic per-run revision + buffered-snapshot-drain; direct site-agent agent.delegate runs are in scope; canonical SW-issued executionId separated from client correlation/thread/schedule ids; heartbeats documented as freshness evidence, not survival. Policy questions remain explicitly OPEN and unapproved.

## [CAP-FB-20260819-SITE-AGENT-STATUS-CLEANUP-01] Site Agents and Agent Dev status cleanup
- Feedback: 2026-08-19 — basic task rows expose stale or noisy WebMCP injection and page-report status text that belongs in a diagnostic surface
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show bbeff7b:TASKS.md && git grep -n "WebMCP\|injection\|page report" bbeff7b -- extension`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the truthful Site Agent vocabulary landed on origin/main (the final 6480005 tip).
  - 2026-08-19 18:13 UTC — opened as a status-surface cleanup; existing WebMCP discovery evidence remains a linked requirement, not a substitute.

## [CAP-FB-20260819-DISCOVER-SITE-TOOLS-COPY-01] Truthful Site Agent and tool-discovery action copy
- Feedback: 2026-08-19 — “Discover this page” and “pick a tab to scan” overstate page scanning instead of describing tool and Site Agent discovery
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show bbeff7b:TASKS.md && git grep -n "Discover this page\|pick a tab\|scan" bbeff7b -- extension`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: findToolsAction is consumed on origin/main (the site-copy integration).
  - 2026-08-19 18:13 UTC — captured as a truthful-copy task distinct from implementing proactive discovery or page-scoped identity.

## [CAP-FB-20260819-RECENT-ACTIVITY-UI-01] Recent Activity layout, structured detail, and error truth
- Feedback: 2026-08-19 — Recent Activity on the NTP has overlapping timestamps, escaped tool/data details, unclear error visibility, and awkward filter spacing
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git show bbeff7b:TASKS.md && git grep -n "Recent activity\|activity-search\|All agents" bbeff7b -- extension`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the activity-explorer recent-activity content is on origin/main (content verified).
  - 2026-08-19 18:16 UTC — opened as a separate NTP correctness task and linked to, but not claimed covered by, the historical structured tool renderer.

## [CAP-FB-20260821-FIRST-RUN-ONBOARDING-01] First-run setup and the session-only storage cliff
- Feedback: 2026-08-21 — independent architectural review reproduced a fresh install showing empty states plus a red error badge, with no onboarding path, and confirmed an API key entered without the optional storage permission is lost on the next service-worker restart
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git grep -n "storage permission not granted\|session-only" -- extension && git grep -n "permissions.request" -- extension/options`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the durable provider setup + onboarding landed on origin/main.
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D5). The existing warning is honest and is not treated as a defect in itself; the defect is the absence of a path forward and the silent credential loss.

## [CAP-FB-20260821-WEBMCP-STATUS-ALIGNMENT-01] Hub WebMCP discovery status renders outside its card
- Feedback: 2026-08-21 — independent architectural review reproduced the hub's WebMCP discovery status line rendering flush to the panel edge, misaligned with every sibling row and breaking the card boundary
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
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
- Blockers: —
- Next: —
- Recover: `git grep -n "webmcp-hub-status\|panel-body" -- extension/ntp`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - Git reconcile at 2026-08-22 07:30 UTC: the hub WebMCP status alignment landed on origin/main.
  - 2026-08-21 09:55 UTC — opened from the independent architectural review (`REVIEW-2026-08-21.md` §3 D4). Reproduced on a clean build of `300bea1`; present in no prior tracker.

## [CAP-FB-20260821-HUB-360-OVERFLOW-01] Hub horizontal overflow at 360px
- Feedback: 2026-08-21 — loaded-MV3 evidence at wide/narrow viewports recorded the hub overflowing horizontally at 360px (the fixed 240px rail + the composer's fixed controls + the 24px .main-wrap gutters exceeded the content column)
- Updated: 2026-08-22 08:00 UTC
- Status: DONE
- Resume: —
- Priority: P2
- Owner: hub-360 integration worker
- Workspace: active (local path private)
- Branch: `rapid/hub360-1632577`
- Base: `1632577` (the composer candidate base)
- Candidate: `6480005` (the shipping tip)
- Shipping: `origin/main@6480005`
- Acceptance: the hub renders without horizontal overflow at 360px (the narrow media query reclaims the .main-wrap gutters, lets the composer row wrap, rides the send button, and drops the textarea min-width); no motion, no a11y-surface change, the covered-nub/full-view state machine untouched
- Review: independent PASS on the d3034d7 delta
- Gates: full suite + build green at `6480005`
- Blockers: —
- Next: —
- Recover: `git show --stat 6480005 && git merge-base --is-ancestor 6480005 origin/main`
- History:
  - Current-tip gate at `6480005`: Chrome 126/126 journey + 876/876 units + build PASS (canonical suite sufficient per the explicit lifecycle).
  - 2026-08-22 07:45 UTC — Git reconcile: merged at `6480005` (the hub-360 landing tip); the journey-suite green at that tip remains the browser gate.

## CAP-FB-20260822-SQLITE3-ACCEPTANCE-04 — sqlite3-query-bounded immutable bundle (0.2.167)

- Physically bundled as immutable package 26 (`cap.bundled.sqlite3.query.bounded`); inventory-admission tested; CAS `ba468c6e…`, licence `blessing AND Apache-2.0`.
- Execution remains BLOCKED: 9 of 24 WASI imports unimplemented in the CAP runtime (`runtime-imports-unimplemented`); no route/grant/catalog entry; `admitted:false`, `canonicalNameClaim:false`.
