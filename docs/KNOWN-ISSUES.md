# Known Issues — Chrome Agent Platform

This tracks the open findings from the ongoing independent review (sol). The review continues in the background; these are tracked here so they don't block wider-project progress. Each entry links the round it was found + the file area.

**Status legend:** Open / In progress / Verified-fixed.

## Review process
- 27 rounds of independent security/correctness review (sol, gpt-5.6-sol) against the Constitution.
- Current state: **105/105 CDP journeys + 98/98 unit tests green; all permissions optional (manifest permissions = []); no debugger permission; extension loads + works with zero permissions granted.**
- The core architecture is confirmed solid (all-optional permissions, enrollment lifecycle, alarm scheduler fencing, screenshot capture, memory/journal CAS).
- The open findings are deep concurrency edge-cases + acceptance-coverage gaps, NOT basic-functionality bugs.

## Open (as of round 27)

### Concurrency edge-cases (deep, low-likelihood)
- **Cooperative-cancellation limit (fundamental):** an already-started page/WebMCP side effect cannot be unwound — the result is discarded but the effect runs. This is a browser constraint (a running page function can't be cancelled). Documented in DESIGN.md. *Mitigations in place: pre-start cancellation, minimized window.*
- **CAS version-scoping refinements:** the version-scoped CAS landed (round 27) but the reviewer may find further ABA edge-cases in the memory/journal compensation.
- **First-message generation acceptance:** the first sync/invoke requires a generation now; verify no residual generationless path.
- **runGenCells per-run isolation:** build-local now; verify no residual shared-state race.
- **MAIN cancel tombstones bounded:** bounded now; verify eviction under load.

### Acceptance-coverage gaps (test/evidence depth)
- **No headed-browser screenshot success path** (headless can't grant arbitrary-tab capture; the active-tab path is documented). Needs a headed-browser test.
- **No full real-enrollment lifecycle journey** (enroll → discover → invoke → cleanup → Retry) as a single headed acceptance.
- **Not all capability lifecycles have grant→use→revoke acceptance.**
- **No accessibility audit run** (the a11y fixes landed but no automated a11y-tree acceptance).
- **No performance/leak traces** (the Constitution's performance budgets lack automated traces).

## Verified-fixed (27 rounds)
- All permissions optional (manifest permissions = []); no debugger; screenshots via captureVisibleTab + activeTab.
- Re-entrant mutex deadlock (saveScreenshot).
- Alarm scheduler: execution fencing, crash-safe cancel, one-shot replay loop, owner tokens.
- Enrollment: cross-origin races, ABA, tombstone lifecycle, Scripting-Disable coordination.
- Memory/journal: generation-scoped CAS compensation, fenced reads, UTF-8 quotas, bounded OPFS.
- UI: [object Object], contrast, focus, attachment popup, screenshot reader/UI.
- Fail-closed KV, split-authority, session→storage migration.

## Wider-project goals (not blocked by these issues)
- co-do-style double-iframe UI generation.
- Hooks (system-level events).
- Richer sub-agent picker UI.
- UI refinement (anti-slop).
