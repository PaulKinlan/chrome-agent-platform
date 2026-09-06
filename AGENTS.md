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

## Concurrent work: worktrees, merges, and forward-only recovery (owner directive 2026-08-29)
Many agents work on this repo AT THE SAME TIME. That is the expected mode, not
an exception. These rules make that safe:

1. **Every agent works in its OWN git worktree on a fresh branch off the
   `origin/main` tip** (`git fetch origin && git worktree add <path> -b <branch> origin/main`).
   Never implement directly in the primary checkout (`~/chrome-agent-platform`)
   — the primary checkout is shared by every session, and one session moving
   its `main` ref or leaving dirty files breaks everyone else (this happened
   on 2026-08-29 and briefly rewound remote `main`).
2. **Merges land through the coordinator.** The merge preserves BOTH sides'
   features (union-resolve semantic conflicts; never drop one lane's behavior
   to make the conflict go away), then runs the gates in order: production
   build → focused tests → full suite green → browser-driven verification
   where the lane touches behavior. Only then push.
3. **Push explicit SHAs, never the local `main` ref**
   (`git push origin <sha>:main`) — the local ref can be moved by another
   session between your checks and your push. Never use
   `--force`/`--force-with-lease` from the shared checkout.
4. **Forward-only recovery.** When histories collide or something lands
   wrongly, preserve both sides, rebase/merge forward, and keep every landed
   commit intact — the project always moves forward. Reverts and history
   rewrites are reserved for genuinely critical fixes (rare; owner-approved).
   If you find another session's uncommitted or unpushed work in a shared
   place, preserve it and coordinate — never delete it to unblock yourself.

## Task tracking: beads only (Paul, 2026-09-02 — HARD RULE)

**bd (beads) is the ONLY task/bug/next-work tracker.** TASKS.md, TASKS-DONE.md,
KNOWN-ISSUES.md and every other markdown tracker are RETIRED — they are legacy
views kept only for history. Never create, update, or consult them for state;
a markdown tracker entry is not a task. Everything lives in beads, synced to
the GitHub remote via `bd dolt push` (a post-commit hook does this
automatically; run it manually after beads-only changes).

- **Pick work**: `bd ready` (the claimable frontier — open beads with no open
  blockers). Claim atomically: `bd update <id> --claim`.
- **Read work**: `bd show <id>` — the description alone must be enough for any
  agent to implement (intent, design decisions, acceptance, repro, seams).
  A bead too thin to implement from is a defect: thicken it before claiming.
- **Update state**: `bd update <id> --status in_progress`, `bd close <id>`
  (only when the complete fix is on the pushed branch or merged).
- **File everything**: every bug, feature, product ask, or blocker found along
  the way becomes a bead IN THE SAME SESSION you find it, with an honest
  description (what was observed, how to reproduce, acceptance for done).
- **Link as you go**: issues discovered during a task get
  `bd link <new-id> <current-id> --type discovered-from`; hard ordering gets
  `bd dep add <blocked-id> --blocked-by <blocker-id>`. The dependency graph — not
  a human dispatcher — decides what is workable next. (Flags verified against the
  installed CLI: `bd link` takes POSITIONAL ids and `--type`; `--blocked-by` is
  a `bd dep add` flag — `bd link <id> --discovered-from <other>` fails with
  "unknown flag".)
- `.beads/issues.jsonl` is a passive export, not the tracker.

### Epics and breakdown (beads best practice)
A feature is not one bead. Break work down like this:

1. **Epic** (`bd create --type epic`) for the feature/capability, with the
   intent, design direction, and acceptance in the description.
2. **Children** for each stage (`bd dep add <child> <epic>` — parent-child).
   Stages are ordered only by EXPLICIT `blocks` dependencies; numbered names
   never imply sequence.
3. **Detail bar**: every child bead carries enough intent + acceptance that any
   agent — this session, a fresh subagent, a different model — can implement it
   without re-deriving the design. Include: the why, the seams/files, the
   falsification tests that will prove it, and what must NOT change.
4. **Lifecycle**: `open` → `in_progress` → (label `in_review` while a candidate
   is under review) → `closed` = merged to origin/main with the full suite
   green. A failed review stays in_progress with findings recorded as comments.
5. **Repeatable multi-step work** (release checklist, feature pipeline) is
   declared once as a beads **formula** and stamped via `bd cook` + `bd mol
   pour` — see https://beads.gascity.com/workflows.

### Progress visibility
The graph answers "what are we making progress on": `bd ready` = workable now;
`bd list --status in_progress` = in flight; `bd blocked` = waiting. Say what is
actually true — never "landed"/"done" before it is merged and green.

## Parallelize: the fleet is the default (Paul, 2026-09-02 — HARD RULE)

**One agent working alone is a bug.** This repo is worked by a FLEET: multiple
pi instances (intercom peers on different paid models) and pi-subagents
(deepseek-v4-flash workers, gpt-5.6-sol:high reviewers, k3, gemini). The
coordinator session NEVER implements a whole feature inline — it acknowledges,
files/delegates, reviews, and reports. Anything >30s of work is dispatched.

- **Shard by default.** On any new ask: acknowledge → capture the beads →
  dispatch workers (subagent workflows with `context: fresh`, or intercom peers)
  → keep the inbox free. Multiple independent beads = multiple parallel
  workers, each in its own worktree on its own branch.
- **Keep every lane fed.** When a worker finishes, immediately re-task it with
  the next `bd ready` bead. An idle paid model is waste.
- **Different-model review is REQUIRED.** The implementer never reviews its own
  work: flash implements → sol (or another family) reviews → the coordinator
  synthesises findings → revise rounds until PASS. Reviews are
  falsification-focused: "would each test fail if the behavior regressed?"
- **Worker attestation is never trusted.** The coordinator independently
  verifies every delivery: diff inspected against the claims, gates re-run on
  the exact commit, closure claims checked against fetched origin/main.
- **Verify against FETCHED origin/main.** Features land between issue filing
  and pickup (multiple coordinators exist). Before implementing: `git fetch
  origin` + check whether the behavior already exists. If complete: pin it with
  falsification tests, close with evidence. If partial: implement the remainder.
- **Workflow scripts: build them so a finished child is never lost (kqib +
  pa7r, 2026-09-06).** Two lanes lost a completed worker to the PARENT script,
  not to the work. The construction rules:
  1. Task text enters the script as a JSON-serialized value (a
     `JSON.stringify`-built string), never a quoted JS literal with raw
     newlines — kqib died at validation on `Unterminated string constant`
     before either child launched.
  2. `emit()` and `return` carry only fields you projected yourself:
     `built.outputReference ?? null`, `Array.isArray(built.artifactPaths) ?
     built.artifactPaths : []`, or a `JSON.parse(JSON.stringify(x))` round
     trip. A raw optional child field that is `undefined` throws
     `emit.<field> must be a JSON value` and fails the workflow AFTER the
     child completed (pa7r: a 19-minute worker's report was written, the
     review never launched). Today pi-subagents 0.65.1 hands the script NO
     `outputReference` for a completed async child that wrote its declared
     file (chrome-agent-platform-qz11, measured live) — reference the report
     by the `output:` path you passed in, not by a field the child returns.
  3. A fresh-equivalent retry names its agent explicitly (`agent: 'reviewer'`):
     `resume:` was what carried the agent, and resume ids are session-bound, so
     a restarted session cannot resume another session's child.
  4. `subagent({ action: 'validate', workflowScriptPath })` before every
     launch, with the script kept on disk under `cap-evidence/` so the exact
     text that ran is the text that gets retried.
  5. Recovery after a parent failure is a next-stage-only retry in the same
     native protocol (review-only, no worker re-run), the failed run keeps its
     `failed` state, and the completed child's source is left intact.

## Hard rules
- **beads (bd) is the ONLY task/bug/next-work tracker** (owner directive 2026-09-02). TASKS.md, TASKS-DONE.md, KNOWN-ISSUES.md and every other markdown tracker are RETIRED — never create, update, or consult them for state. Pick work with `bd ready`, claim with `bd update <id> --claim`, close only when the complete fix is on the pushed branch. See "Task tracking: beads only" below.
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
- **beads-flow** (.agents/skills/beads-flow) — the fast loop: pick the next
  bead, work it, gate it, ship it. Start here when picking up work.
- **beads** (.agents/skills/beads) — full beads workflow guidance.
- **impeccable** (.agents/skills/impeccable) — the design skill. Use it for EVERY
  UI/design task (the craft-floor, PRODUCT.md, DESIGN.md). Always loaded for design work.
- **modern-web-guidance** (.agents/skills/modern-web-guidance) — modern web APIs
  (base-select, Popover API, CSS anchor-positioning, View Transitions). Use it for
  any modern-web feature.
- skills/web-resilience-audit + skills/web-resilience-fix — the project's
  resilience checks. Run them on the surfaces where applicable.

## Agent private workspaces (CAP-FB-20260831-AGENT-PRIVATE-FS-01)

Every **named and background agent has its own persistent private workspace** — an
OPFS directory (`agent-workspaces/<key>/`) that only that agent can read or write.
It is the agent's sandbox, the same trust level as its origin-keyed memory: no
owner fs-grant is required, no approval card is paid, and no other agent (or the
hub) can see inside it. Files persist across the agent's runs — write in run 1,
read in run 2.

- The model-facing file tools (`list_files`, `find_files`, `read_file`,
  `write_file`, `delete_file`) fall back to the agent's private workspace when
  no local folder is attached to the task. Explicit `grantId` always wins when
  given; the workspace is the default for agent runs without a grant.
- Bounds: 20 MiB / 200 files per agent (honest `workspace_quota_exceeded`
  errors, never silent truncation). `grep_files` does not yet cover the
  workspace (name search via `find_files`, content via `read_file`).
- **Owner fs-grants remain the way to reach shared/global files.** A granted
  folder (via `/folder` or Settings → Local folders) is the shared surface;
  the private workspace is per-agent. When a task attaches a folder, the tools
  operate on the folder; without one, they operate on the agent's workspace.
- Settings → edit an agent → Advanced → **Private workspace** shows usage and
  an owner-gesture Clear button.
- Isolation is by run identity: the workspace key derives from the run's agent
  stamp (`named:<slug>` / `background:<slug>`), so a hub or site run has no
  workspace at all, and agent A's files are never visible to agent B.

## Working conventions (Paul, 2026-08-16)
- **Track every ask.** Every product issue/request gets a stable entry in root
  beads; UI detail also lives in `docs/UI-FIXES-TRACKER.md` (legacy view), and review/system
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
- **Test quickly while iterating; test fully once before pushing (Paul,
  2026-09-03).** The full unit suite is the PRE-PUSH gate, not the per-edit
  loop. Agents were running `deno test --allow-all tests/` (minutes, serial)
  after every change; that command is now refused by the repo (see Testing).
  The ladder:
  1. `npm run test:file -- tests/<name>.test.ts` — the one file you are
     working in (seconds).
  2. `npm run test:changed` — every test that transitively imports what you
     changed vs `origin/main`, plus the always-on security/vocabulary core
     (typically 4-10 s). It fails CLOSED to the full suite when a changed
     executable/config file has no reachable test, so a green subset is
     never a silent skip. `--base <ref>` compares against another ref.
  3. `npm test` — the full unit suite, once, before you push or report done.
     It is the only way to run the whole suite: a raw `deno test tests/` is
     refused, and a raw single-file run finds no modules.
  Never weaken or skip a test to make a subset pass; the subset differs from
  the gate only in WHICH files run.
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
- npm test — the full pure/unit suite (two-phase: build/artifact tests serial,
  everything else parallel; vj4s, ~90 s). **A raw `deno test tests/` sweep is
  refused** (Paul, 2026-09-04): `deno.jsonc` hides `tests/*.test.ts` from
  discovery, so the sweep loads only `tests/00-use-npm-test_test.ts`, which
  prints the runner commands and fails in under a second. The runners pass
  `--config deno.runner.jsonc` and see every file. A raw
  `deno test tests/x.test.ts` reports "No test modules found" — use
  `npm run test:file -- tests/x.test.ts`. Do not add `--config deno.runner.jsonc`
  to a sweep by hand; that is the runner's job.
- Load the extension in headless Chrome + verify the surfaces render + the
  journeys work (CDP). See docs/CONSTITUTION.md for the required journeys.
- **Never name a debugging port.** Every harness in `scripts/` launches its
  browser through `launchChrome()` in `scripts/lib/chrome-launch.ts`, which asks
  the kernel for a port (`--remote-debugging-port=0`) and reads the endpoint back
  from that child process's own stderr. A fixed port silently attaches the
  harness to a zombie or to another lane's browser, and it then prints confident
  PASS/FAIL results about a tree it never loaded — green against the wrong tree
  reads as evidence, which is worse than red. `tests/harness-debug-port.test.ts`
  fails on any fixed port — and, since CAP-FB-20260830-SUITE-HONESTY-01, on any
  spawn path other than `launchChrome()` (it is the ONLY writer of the flag). MV3
  registers its service worker a beat after the browser is reachable, so wait
  for it with `waitForServiceWorker()` rather than relying on how long a
  handshake happens to take.
- **One browser at a time, by construction.** `launchChrome()` takes the
  canonical serialized-Chrome lock (`/tmp/cap-serialized-chrome-acceptance.lock`)
  for the browser's lifetime: two lanes driving headless Chromes together produce
  CDP timeouts that say nothing about the tree. The wait is bounded
  (`CAP_CHROME_LOCK_WAIT_MS`, 20 min default) and printed when it happens; a lane
  that never gets the lock FAILS — it is never turned green. The security
  supervisor already holds the lock, so inside it the launcher skips the take.
  Never wrap a harness in an outer `flock` on that file (it deadlocks the
  harness's own launch). A known failure owned by another entry is carried as
  `EXPECTED-RED` with its owner (`scripts/lib/expected-red.ts`; the KAT
  registry's `expectedRed`), never skipped; the run fails the moment it turns
  green. Every `scripts/*.ts` has exactly one class in
  `scripts/lib/harness-registry.ts` (`tests/harness-registry.test.ts`), and
  every harness exits on its own failures (`tests/scripts-exit-codes.test.ts`).

## The current review (2026-08-30) — read before picking up work

[`REVIEW-2026-08-30.md`](REVIEW-2026-08-30.md) is the full-project reanalysis of exact
`origin/main@fc2255be`, executed by seven lanes in a real loaded extension rather than read
from trackers. It confirms the baseline healthy (build clean, 2457 unit pass, 138/138 Chrome
journeys, 42/42 WebMCP acceptance, hub FCP 15-55 ms, four real providers driven) and finds
that the exec demo fails today on tool gating, on what the transcript keeps, and on the
first screen — not on the tools, the models or the security boundaries. **Section 5 is the
dependency-ordered work queue** (before the demo / the coworker thesis / hygiene) and
**section 6 is the five-minute demo script with its ranked blockers.** Every finding carries
a `CAP-FB-*` ID that exists in [`TASKS.md`](TASKS.md) with full acceptance criteria, gates
and blockers; `CAP-FB-20260830-EXEC-DEMO-01` is the umbrella. The P0 ids are listed in
[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md). Three owner decisions gate the demo path (Q18 host
access, Q19 page actions, Q12 default model) and carry recommended defaults in
[`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md).

Take work by following the beads-flow loop (`bd ready` → claim → durable worktree → gates → push), never from the review
alone. The earlier [`REVIEW-2026-08-21.md`](REVIEW-2026-08-21.md) (the delivery diagnosis)
is kept as history; its two behavioural rules still apply:

- **Put the `CAP-FB-*` ID in the commit subject**, so every `Recover:` command in the
  tracker can find its own work.
- **Never create a `-vN+1` attempt with no commit in `-vN`.** Stop and escalate instead.

## Repository-local task recovery (2026-08-19)

## Task recovery (2026-09-03)

Task state lives in beads (bd) — the Dolt database synced via `refs/dolt/data`
on the GitHub remote. Recovery after a crash: `bd list --status in_progress`
shows claimed lanes; pushed branches on origin carry each lane's work; the
bead comments carry candidate shas and gate evidence. Never consult or revive
the retired markdown trackers (`TASKS.md`, `KNOWN-ISSUES.md` — history only).

## Worktree and evidence hygiene (Paul, 2026-08-22 — CAP-FB-20260821-WORKTREE-HYGIENE-01)

- **Durable worktrees** for every lane live under `~/worktrees/` (durable storage), NEVER on the
  RAM-backed tmpfs; the tmpfs is for transient build/evidence scratch only.
- **Reachability before removal:** no worktree is removed/pruned/reset until its HEAD is provably
  reachable from `origin/main` or an explicit `rescue/*` tag. Unreachable heads are bound under a
  rescue tag BEFORE any cleanup, and dirty worktrees (tracked + untracked changes) are preserved —
  never destroyed — until an owner decision reconciles them.
- **Serialized Chrome evidence** (the canonical lock, acceptance runs, screenshots) is written
  outside the tmpfs to a durable evidence path; the evidence survives reboots.
- **Scripts and tests route evidence, Chrome profiles, and big scratch copies through
  `scripts/lib/durable-root.mjs`** (`durableRoot()`/`durableDir()`; default `$HOME/cap-evidence`,
  override `CAP_DURABLE_ROOT`). The helper REFUSES a RAM-backed target rather than silently
  writing to tmpfs; `tests/durable-root.test.ts` fails if a `/tmp` evidence literal comes back.
  Only tiny cross-process coordination files (the canonical Chrome lock, the slot poison marker)
  stay on tmpfs — a reboot clearing stale locks is a feature.
- **The read-only audit** `node scripts/worktree-audit.mjs` inventories every registered worktree
  (HEAD/branch/dirty tracked+untracked/reachability/rescue/location class) and REFUSES destructive
  operations; private absolute paths are reported as class counts only, never committed.
- Run the audit before any worktree/prune/cleanup decision and before reporting hygiene state.

## Review and delivery lifecycle (Paul, 2026-08-21 — replaces the nine-state model)

**`OPEN → IN_REVIEW → DONE`**, with `BLOCKED` and `ABANDONED` as the two off-ramps.
That is the whole lifecycle.

**Merged is done (Paul, 2026-08-28).** `MERGED` and `DONE` were separate states whose only
difference was a gate that is checked on every commit anyway. The split did nothing except
leave finished work sitting in a tracker looking unfinished. Work on `origin/main` with the
suite green is DONE; the bead closes with the merge sha. Retired trackers
holds ONLY what is in progress or still to do. Legacy `MERGED` entries read as `DONE`.

| State | Means | To leave it you need |
|---|---|---|
| `OPEN` | Not started, or being worked on. | A candidate commit and a review pass. |
| `IN_REVIEW` | A candidate exists and is under review — a fresh session on the diff where possible, an author review with the falsification gates otherwise. The `Review:` field says which. | A review verdict. A failed review stays `IN_REVIEW` with the findings recorded — it does not need its own state. |
| `DONE` | On `origin/main` with the journey suite green at that tip. Terminal — the bead closes with the merge sha. | — |
| `BLOCKED` | Stopped on something external. Records an owner, the reason, and one next action. | Resolution of the named blocker. |
| `ABANDONED` | Will not be done. Records why. Terminal. | — |

`DONE` **does not require a per-task owner interaction.** The nine-state model made the
terminal state depend on explicit product-owner confirmation per task, and the result was
0 of 31 tasks reaching it while the tracker grew without bound. Merged plus green is the
bar. Paul reviews what landed when he wants to, not as a gate on every entry.

Legacy entries written under the old model map as: `IN_PROGRESS`/`FIX_REQUESTED` → `OPEN`;
`REVIEWING`/`REVIEW_PASSED`/`READY_FOR_BROWSER`/`INTEGRATING`/`GATED` → `IN_REVIEW`;
`PUSHED`/`MERGED` → `DONE`; `CONFIRMED` → `DONE`. Existing entries are **not** rewritten — read
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
