# Agent Guidance — Chrome Agent Platform

Every agent (human or model) working on this repo reads this first.

## The project
A Chrome extension (MV3) that makes Chrome the agent platform: a new-tab agent
hub, per-site sub-agents (WebMCP/inferred tools), origin-keyed OPFS memory,
browser control, recipes, and a chat surface. See docs/DESIGN.md + PLAN.md.

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
- **Track every ask.** Every Paul issue/request goes into docs/UI-FIXES-TRACKER.md
  (UI) or docs/KNOWN-ISSUES.md (review/system) with a status. Nothing is dropped.
  Work through them in subagents; move each to Done with evidence.
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
