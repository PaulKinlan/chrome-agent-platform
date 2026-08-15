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
skills/web-resilience-audit + skills/web-resilience-fix are the project's
resilience checks (the failure-matrix audit + the fix mapping). Run them on the
surfaces where applicable.

## Testing
- deno test tests/ — the pure/unit suite.
- Load the extension in headless Chrome + verify the surfaces render + the
  journeys work (CDP). See docs/CONSTITUTION.md for the required journeys.
