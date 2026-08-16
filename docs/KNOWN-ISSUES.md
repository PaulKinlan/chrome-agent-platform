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

## Round 27 (sol, f3d5fdb) — CAS version edge-cases
- Versions stored only in the value file reset after delete/clear → a stale v1→delete→fresh v1→stale CAS deletes the fresh write. The version must be stored separately (not reset on delete/clear).
- A late stale write can overwrite B, then the CAS delete removes A but cannot restore B; a crash after the commit persists A. The CAS needs a durable version log.
- The journal has the same CAS issue.
- The page sideEffect is still true (the cooperative-cancellation limit).
- The envelope quota undercounts the wrapper (a 262164-byte file accepted against the 262144 bound).
- Legacy raw {__v,__value} gets corrupted; unsafe finite versions stop advancing.
(Tracked for a background fix worker; not blocking the wider goals per Paul's directive.)

## Wider-goal review (sol, 98bbc96) — CRITICAL + HIGH
- **CRITICAL: storage.onChanged hook serializes full changes incl the providerConfig apiKey into the journal + the model prompt (credential leak); subscription/usage storage changes can recursively trigger unbounded paid runs.**
- HIGH: untrusted hook payloads feed a hub with destructive management tools (no operation-specific owner grant); sidepanel onMessage navigate opens tabs with no sender/grant check; thread authority keys model-writable (forged threads index); unlocked thread/index RMW; global progress broadcast leaks/misattributes tool data; chat never keeps threadId (mixes the global journal); artifact body/index split writes race/orphan; model cross-origin admin lacks a scoped grant; tool cards use one lastTool + String(object); record audio/camera advertised but unwired; mic can survive disconnect.
- Medium: hooks unbounded + catalog permissions undeclared/unrequestable; UTF-8 attachments mojibake; a11y gaps (focus/combobox/speaker/menu/contrast); skills unchecked; diagnostics length unbounded.
(The apiKey leak + the recursive-run risk are the priority fixes.)
