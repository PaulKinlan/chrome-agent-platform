# Agent Guidance — Chrome Agent Platform

Every agent (human or model) working on this repo reads this first.

## The project
A Chrome extension (MV3) that makes Chrome the agent platform: a new-tab agent
hub, per-site sub-agents (WebMCP/inferred tools), origin-keyed OPFS memory,
browser control, recipes, and a chat surface. See docs/DESIGN.md + PLAN.md. The
candidate durable-run authority is mapped in
[docs/DURABLE-RUN-ARCHITECTURE.md](docs/DURABLE-RUN-ARCHITECTURE.md), including
its pending-integration and browser-proof status.

## The constitution
**docs/CONSTITUTION.md is non-negotiable.** Every change must satisfy the
security, accessibility, design, memory-resilience, and performance constraints
there. The reviewer agents check against it.

## The workflow (LLM-as-judge)
1. Build (a worker implements).
2. Review (a DIFFERENT model/session, against the constitution — security,
   accessibility, design, memory/perf, severity + file/line).
3. Fix (the worker addresses the findings).
4. Re-review (the reviewer confirms each finding resolved, with evidence).
5. Push only after re-review clears.

## Hard rules
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
- **Scale out + delegate reviews (Paul, 2026-08-17).** Use the whole fleet: spawn
  subagents for parallel implementation AND delegate to the other pi instances via
  intercom (sol, GLM-5.3, deepseek-v4-pro, deepseek-v4-flash). **Every change gets
  an independent review from a DIFFERENT agent/instance** — not self-review. The
  reviewers run continuously on the pushed work; their findings are tracked
  (KNOWN-ISSUES) + actioned. Don''t leave the other instances idle — distribute the
  work + the reviews across them.
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
- **Fleet validation (Paul, 2026-08-16).** Every change is validated by a DIFFERENT
  review agent before it is considered done — the intercom fleet (sol for code/
  security review, deepseek-v4-pro for vision/UI review, GLM-5.3 for a second
  opinion / independent review). The coordinator CAN commit + push frequently (Paul
  tests regularly), but the review agents run on the pushed work continuously:
  review the latest HEAD, report findings, and the coordinator actions them. Never
  let a change sit unreviewed. The review agents' feedback is tracked (KNOWN-ISSUES)
  + worked, not ignored.

## Testing
- deno test tests/ — the pure/unit suite.
- Load the extension in headless Chrome + verify the surfaces render + the
  journeys work (CDP). See docs/CONSTITUTION.md for the required journeys.

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

## Review and delivery lifecycle

Use `OPEN → IN_PROGRESS → REVIEWING → REVIEW_PASSED → READY_FOR_BROWSER →
INTEGRATING → GATED → PUSHED → CONFIRMED`; review failures use `FIX_REQUESTED`, and dependency or
environment stops use `BLOCKED` with an explicit prior state. `READY_FOR_BROWSER`
is not final acceptance. `GATED` requires exact-commit content-addressed evidence,
`PUSHED` an immutable remote ref, and `CONFIRMED` explicit product-owner
confirmation. Never fabricate evidence or closure.
