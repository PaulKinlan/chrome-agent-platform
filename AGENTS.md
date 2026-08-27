# Agent Guidance — Chrome Agent Platform

Every agent (human or model) working on this repo reads this first.

## The project
A Chrome extension (MV3) that makes Chrome the agent platform: a new-tab agent
hub, per-site sub-agents (WebMCP/inferred tools), origin-keyed OPFS memory,
browser control, recipes, and a chat surface. See docs/DESIGN.md + PLAN.md. The
Durable run authority is mapped in
[docs/DURABLE-RUN-ARCHITECTURE.md](docs/DURABLE-RUN-ARCHITECTURE.md), including
its exact accepted source/evidence boundary and integration status.

## The constitution
**docs/CONSTITUTION.md is non-negotiable.** Every change must satisfy the
security, accessibility, design, memory-resilience, and performance constraints
there. The reviewer agents check against it.

## The workflow (LLM-as-judge)
1. Build (a worker implements).
2. Review (a fresh session on the diff where possible; otherwise an author review
   clearing the falsification gates — against the constitution: security,
   accessibility, design, memory/perf, severity + file/line).
3. Fix (the worker addresses the findings).
4. Re-review (the reviewer confirms each finding resolved, with evidence).
5. Push only after re-review clears.

## Hard rules
- **TASKS.md is the source of truth for task state — update it after EVERY completion.** Whenever a task lands, is reviewed, changes state, or a bug is captured, update its TASKS.md entry in the SAME commit cycle (status, Shipping `origin/main@<sha>`, a dated History line). A completion that does not update TASKS.md is not complete. Mark landed work MERGED with the exact public commit; never leave landed work marked OPEN/IN_REVIEW.
- Never accept "it serves" as "it works" — drive the real behavior in a browser
  (CDP) with screenshots as evidence.
- Real libraries, not patterns (agent-do is imported, not reimplemented).
- Origin-keyed OPFS memory; never cross-origin access.
- No emoji icons (inline SVG, currentColor).
- No chaos references.
- No provider keys in the bundle/logs/receipts.
- The bundle contains no eval/new Function (MV3 CSP).
- Untrusted data renders with textContent/escaping, never innerHTML.

## The skills
- **impeccable** (.agents/skills/impeccable) — the design skill. Use it for EVERY
  UI/design task (the craft-floor, PRODUCT.md, DESIGN.md). Always loaded for design work.
- **modern-web-guidance** (.agents/skills/modern-web-guidance) — modern web APIs
  (base-select, Popover API, CSS anchor-positioning, View Transitions). Use it for
  any modern-web feature.
- skills/web-resilience-audit + skills/web-resilience-fix — the project's
  resilience checks. Run them on the surfaces where applicable.

## Working conventions (Paul, 2026-08-16)
- **Track every ask.** Every product issue/request gets a stable entry in root
  `TASKS.md`; UI detail also lives in `docs/UI-FIXES-TRACKER.md`, and review/system
  findings live in root `KNOWN-ISSUES.md`. Nothing is dropped.
  Work through them in subagents; advance each only with the required evidence.
- **Resolve open questions.** Read docs/OPEN-QUESTIONS.md; mark the questions Paul
  has answered (with the answer) + surface the genuinely-open ones.
- **Prioritize known issues.** Work the known-issues + tracker backlog actively,
  not just new features.
- **Work the plan.** PLAN.md is the active roadmap — keep it moving; update it as
  pieces land.
- **Full-suite-green gate.** Never report work done (or push) without the full
  Chrome journey suite + unit tests green. A regression is a stop.
- **Visual verification.** UI work is verified by driving the real UI in headless
  Chrome (CDP) with screenshots, before + after. "It serves" is not "it works".
- **Heavy componentization (Paul, 2026-08-16).** Every piece of UI is a reusable
  Web Component in the single-source extension/shared/components.js (custom
  elements, MV3-CSP-safe, no eval). Reuse is critical for consistency — never
  hand-roll a one-off version of an existing component (the blank-toggle +
  + menu bugs came from hand-rolled duplicates). New UI pieces (e.g.
  <agent-identity>) become components + are added to the gallery
  (docs/components.html — the playground where components are tested in isolation
  without running the extension). The gallery imports the SAME components.js
  (scripts/sync-gallery.mjs; check:gallery fails on drift).
- **Scale out (Paul, 2026-08-17; review half superseded 2026-08-27).** Spawn subagents
  for parallel implementation where the work genuinely divides. The review half of this
  rule — delegating to other instances (sol, GLM-5.3, deepseek-v4-pro) — no longer
  applies: that fleet is not available. See "Review without a second model". Findings
  are still tracked in KNOWN-ISSUES and actioned; they now come from review passes and
  from the owner using the product.
- **Continuous skill/quality runs (Paul, 2026-08-17).** Spin up subagents to
  regularly run the quality skills in the background: the impeccable design pass
  (the UI consistency), the modern-web-guidance checks, and the web-resilience
  audit + fix (skills/web-resilience-audit + skills/web-resilience-fix). These run
  continuously — the UI, the modern-web correctness, and the resilience are always
  being verified, not one-off.
- **Ask for permissions on need, never fail silently (Paul, 2026-08-17).** When a
  feature needs a permission (a screenshot needs activeTab/host access, a capture
  needs audioCapture/videoCapture, a provider needs its host), REQUEST it on the
  user gesture (chrome.permissions.request) — do NOT just fail with "permission
  required". The all-optional model means features ask for their permission at the
  moment of need, with a clear grant flow + a clear error only if the user denies.
  A feature that just fails with "permission required" is a bug.
- **Docs never drift (Paul, 2026-08-17).** Before every commit, update the docs to
  match the change: PLAN.md (the roadmap state), root KNOWN-ISSUES.md (the open/
  fixed findings), docs/DESIGN.md (the design system), docs/OPEN-QUESTIONS.md,
  docs/UI-FIXES-TRACKER.md, CHANGELOG.md (the version entry). A commit that lands
  a feature/fix WITHOUT updating the docs is incomplete — the docs are part of the
  change. Stale docs are a defect (GLM flagged PLAN.md showing landed items as
  "in flight"). When in doubt, grep the docs for the thing you changed.
- **Cross-subsystem consistency (Paul, 2026-08-17).** When you change one
  subsystem, CHECK + UPDATE every related part. Examples that broke: renaming
  recipes→skills left the / command saying "task" + the autocomplete not updated;
  the all-optional host permissions broke the provider fetch. A change is not done
  until the related surfaces (the commands, the autocomplete, the UI, the docs,
  the tests) are updated. Keep a mental (or written) map of the couplings: the
  composer ↔ the command registry ↔ the autocomplete ↔ the skills/agents registry;
  the permissions ↔ every feature that needs them; the components ↔ the pages that
  use them. When in doubt, grep for the old term/concept across the repo.
- **Validation (Paul, 2026-08-16; revised 2026-08-27).** The intercom review fleet is
  gone, so validation is now: the falsification gates on the change itself, the full
  suite green, real-browser evidence, and the owner exercising the product. Commit and
  push frequently — Paul tests regularly, and shipping something he can actually click
  is worth more than a review queue that never drains. Never let a change sit
  unreviewed; "reviewed" now means a declared author or fresh-session pass, not a
  second instance.

## Testing
- deno test tests/ — the pure/unit suite.
- Load the extension in headless Chrome + verify the surfaces render + the
  journeys work (CDP). See docs/CONSTITUTION.md for the required journeys.

## The current review (2026-08-21) — read before picking up work

[`REVIEW-2026-08-21.md`](REVIEW-2026-08-21.md) is an independent architectural review of
exact `origin/main@300bea1`, executed rather than read from trackers. It confirms the
baseline healthy (build clean, 632 unit pass, 126/126 Chrome journeys, 62 ms hub render)
and identifies why delivery stalled. **Section 6 is an ordered work queue.** Every finding
carries a `CAP-FB-*` ID that exists in [`TASKS.md`](TASKS.md) with full acceptance criteria
and gates; defects also appear in [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md).

Take work by following the atomic-ownership procedure in `TASKS.md`, never from the review
alone. Two behaviours the review calls out specifically:

- **Put the `CAP-FB-*` ID in the commit subject.** Only 2 of 430 commits do today, which is
  why every `Recover:` command in the tracker fails to find its own work.
- **Never create a `-vN+1` attempt with no commit in `-vN`.** Stop and escalate instead.
  Seventeen worktrees currently hold zero work; ten share one versioned prep name.

## Repository-local task recovery (2026-08-19)

Root [`TASKS.md`](TASKS.md) is the durable, public-safe product task record.
Root [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) is the canonical review/system issue
record; `docs/KNOWN-ISSUES.md` remains a compatibility link.

- Create a stable `CAP-FB-YYYYMMDD-SLUG-NN` entry when feedback arrives. Never
  rename, reuse, or delete an ID; archive the complete entry only after its
  terminal state.
- The accepted Git commit containing `TASKS.md` is authoritative. Ownership and
  material fields change together with one History event in one commit. A
  concurrent tracker edit is a compare-and-swap conflict that must be reconciled,
  never overwritten. Reviewers may append review evidence without taking
  implementation custody.
- After a crash, preserve any dirty diff, read the last committed tracker state,
  verify recorded commits and ancestry, reconcile the stable ID with the private
  coordination ledger, and choose the more conservative state when evidence is
  incomplete. Missing/diverged/ambiguous work becomes `BLOCKED` with a recovery
  owner, prior state, blocker, and one next action.
- Never publish local absolute paths, session/relay/provider IDs, transport
  receipts, credentials, personal data, or private evidence locations. Public
  entries use role labels, repository refs, Git object IDs, and content hashes.
- Reconcile at least once per active workday and after any recovery. Full schema,
  state/evidence requirements, atomic ownership, and recovery commands live in
  `TASKS.md`.

## Worktree and evidence hygiene (Paul, 2026-08-22 — CAP-FB-20260821-WORKTREE-HYGIENE-01)

- **Durable worktrees** for every lane live under `~/worktrees/` (durable storage), NEVER on the
  RAM-backed tmpfs; the tmpfs is for transient build/evidence scratch only.
- **Reachability before removal:** no worktree is removed/pruned/reset until its HEAD is provably
  reachable from `origin/main` or an explicit `rescue/*` tag. Unreachable heads are bound under a
  rescue tag BEFORE any cleanup, and dirty worktrees (tracked + untracked changes) are preserved —
  never destroyed — until an owner decision reconciles them.
- **Serialized Chrome evidence** (the canonical lock, acceptance runs, screenshots) is written
  outside the tmpfs to a durable evidence path; the evidence survives reboots.
- **The read-only audit** `node scripts/worktree-audit.mjs` inventories every registered worktree
  (HEAD/branch/dirty tracked+untracked/reachability/rescue/location class) and REFUSES destructive
  operations; private absolute paths are reported as class counts only, never committed.
- Run the audit before any worktree/prune/cleanup decision and before reporting hygiene state.

## Review and delivery lifecycle (Paul, 2026-08-21 — replaces the nine-state model)

**`OPEN → IN_REVIEW → MERGED → DONE`**, with `BLOCKED` and `ABANDONED` as the two
off-ramps. That is the whole lifecycle.

| State | Means | To leave it you need |
|---|---|---|
| `OPEN` | Not started, or being worked on. | A candidate commit and a reviewer. |
| `IN_REVIEW` | A candidate exists and is under review — a fresh session on the diff where possible, an author review with the falsification gates otherwise. The `Review:` field says which. | A review verdict. A failed review stays `IN_REVIEW` with the findings recorded — it does not need its own state. |
| `MERGED` | On `origin/main`. | The Chrome journey suite green at that tip. |
| `DONE` | Merged **and** the journey suite green at that tip. Terminal. | — |
| `BLOCKED` | Stopped on something external. Records an owner, the reason, and one next action. | Resolution of the named blocker. |
| `ABANDONED` | Will not be done. Records why. Terminal. | — |

`DONE` **does not require a per-task owner interaction.** The nine-state model made the
terminal state depend on explicit product-owner confirmation per task, and the result was
0 of 31 tasks reaching it while the tracker grew without bound. Merged plus green is the
bar. Paul reviews what landed when he wants to, not as a gate on every entry.

Legacy entries written under the old model map as: `IN_PROGRESS`/`FIX_REQUESTED` → `OPEN`;
`REVIEWING`/`REVIEW_PASSED`/`READY_FOR_BROWSER`/`INTEGRATING`/`GATED` → `IN_REVIEW`;
`PUSHED` → `MERGED`; `CONFIRMED` → `DONE`. Existing entries are **not** rewritten — read
them through this mapping.

### The rules that survive, and the ones that went

Two rules are load-bearing and are not negotiable:

1. **Every change is reviewed, and the review is labelled for what it actually was.**
   (Revised by Paul, 2026-08-27 — see "Review without a second model" below.) The old
   rule required a DIFFERENT model/session and forbade self-review. There is no second
   model available, so that rule was being satisfied on paper or not at all, which is
   worse than not having it. What replaces it is: a review always happens, it is
   declared as `author` or `independent` truthfully, and an author review must clear
   the falsification gates that catch what a second reader used to catch.
2. **Real browser verification.** Drive the actual behaviour in a real loaded extension
   with evidence. "It serves" is still not "it works". The 127-check journey suite is a
   strong gate and it is sufficient.

### Review without a second model (Paul, 2026-08-27)

The point of the different-model rule was never the second model. It was that an author
cannot see the thing they were already blind to when they wrote the code. With one model,
that blindness does not go away — so it has to be attacked mechanically instead of
socially.

**Every change still gets a review pass.** Prefer a FRESH SESSION that reads only the
diff, with no memory of having written it. Same model, different context; weaker than a
second model, better than reading your own reasoning back to yourself.

**An author review must clear the falsification gates.** These are mechanical — they do
not depend on the reviewer noticing anything:

1. **A changed test must be proven able to fail.** If a commit adds or edits an
   assertion, revert the product fix, show the assertion go RED, restore, show it go
   GREEN, and record both in the entry. An assertion that has never been observed
   failing is not evidence of anything. This is the single highest-value gate here,
   because quietly weakening an assertion is exactly how a green suite starts lying —
   and it is what happened twice in three days (`MAIN-GATES-RED-01`, `-RED-02`).
2. **A fix must be proven to fix.** The reported behaviour reproduces before the change
   and does not after, driven in a real loaded extension.
3. **Deleting coverage requires a guard.** Removing tests is allowed; removing the
   property they protected is not. Leave an assertion that fails if the thing comes
   back (the pattern in `tests/chrome-tools-t12.test.ts` for the removed `debugger`).
4. **The full suite green at the tip**, which was already the bar for `DONE`.

**Never claim independence that did not happen.** The `Review:` field records
`author review <date>` or `independent review <date>, <who>`. Do not write "reviewed"
and leave the kind ambiguous. Historical entries saying "no independent review — the
product owner asked the author to review directly" are the honest pattern; keep it.

**What is genuinely weaker now, stated plainly:** taste, architecture and "you have
solved the wrong problem" are the classes a second reader caught and no gate above will.
Those now rest on the owner noticing them in the product. That is an accepted trade, not
an oversight. If a second model becomes available, rule 1 reverts to requiring it.

Deleted: content-addressed gate evidence, live remote attestation, versioned acceptance
packages, and the separate `GATED`/`READY_FOR_BROWSER`/`INTEGRATING`/`PUSHED`/`CONFIRMED`
distinctions. They produced 322 open handoff records, 152 of them `BLOCKED`, and zero
confirmations. Never fabricate evidence or closure — that rule stands on its own without
the machinery.

### Four working rules (Paul, 2026-08-21)

3. **A review is valid for its content, not its base.** If a candidate passed review and
   `main` advanced without touching the same files, **the review still stands** — rebase
   and land it. Re-review only what actually changed. Do not recreate reviewed work on a
   new base as a matter of course; that treadmill is what converted finished work into 46
   stale branches.
4. **Put the `CAP-FB-*` ID in the commit subject.** Today 2 of 430 commits do, which is
   why every `Recover:` command in `TASKS.md` fails to find its own work.
5. **No worktree or retained evidence on a RAM-backed filesystem.** Both live on durable
   storage. Evidence whose only copy is on tmpfs is not evidence.
6. **No `-vN+1` without a commit in `-vN`.** An agent about to create the next versioned
   attempt with nothing committed in the previous one stops and escalates instead.

**Optimise for one visible increment per day**, not for an unfalsifiable audit trail.
