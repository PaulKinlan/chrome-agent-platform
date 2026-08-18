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
- **[OPEN — corrective round landed, headed gesture pending] WebMCP discovery observability** — Paul's "where is the content script / no logs proving it runs" gap. The round-28 review BLOCKED the first fix (bypassed evidence + 7 HIGH findings). The corrective round restored in-flight cancellation fencing, added the bridge startup enrollment sync (`enrollment.status` — reload/navigation no longer fails closed), replaced the NTP-selecting active-tab flow with an explicit tab picker (`agent.discoverable-tabs` + exact tabId), replaced blind window.* enumeration with positive opt-in (`window.webmcpExpose`) + source-threaded dispatch (no global-collision hijack), strict schema rejection, versioned singleton teardown in both worlds, complete ordered replacement snapshots (stale tools removed, empty snapshot clears), per-tab per-role injection readiness, and SW-attested vs page-reported status separation (bounded, redacted). Production-path proof: `scripts/webmcp-acceptance.ts` 32/32. **Residual:** the OS-level host-permission prompt gesture is unattested in headless (auto-denied; no display) — run `deno run -A scripts/webmcp-acceptance.ts --headed` and click Allow twice (docs/WEBMCP-ACCEPTANCE.md); until then this stays OPEN.
- **[CLOSED — scripts/capability-lifecycle.ts, 21 checks] Capability lifecycles** — grant→use→revoke acceptance for each optional capability (real CDP gestures), npm run test:capabilities.
- **[CLOSED — scripts/a11y-audit.ts, 17 checks] No accessibility audit run** — an automated a11y-tree acceptance (labels/roles/contrast/focus/landmarks across the hub/chat/settings), npm run test:a11y.
- **[CLOSED — scripts/perf-leak-trace.ts, 8 checks] No performance/leak traces** — an automated perf/leak trace (SW register/render budgets, the SW heap + OPFS + hub DOM bounded across a write loop), npm run test:perf.

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

---

# Paul's UI/UX issues (2026-08-16) — tracked in docs/UI-FIXES-TRACKER.md

The full tracker is docs/UI-FIXES-TRACKER.md. Summary of the batch:
- DONE: the 5 settings issues (the switch-collision double-toggle, hooks=permissions, the duplicate back button, the origins stretch), the notification icon path, the provider Test-connection buttons, the base-select background-agent picker, the thread navigation (fullscreen + sidebar + background-agents off the NTP), the security fixes (apiKey leak + highs), semver.
- IN PROGRESS (the tracker-remaining worker): the sidebar collapse, the new-task + button, View Transitions, HTML-output rendering, the unified Agents area, the + menu options + anchor-positioning, the @mention positioning, the error-console copy buttons + error surfacing.

## Paul meta-directives (2026-08-16)
- Every ask → tracked (UI-FIXES-TRACKER.md / KNOWN-ISSUES.md) + worked in a subagent + visually verified. Nothing dropped.
- Use the impeccable skill for ALL design work + modern-web-guidance for modern-web features.
- Resolve open questions; prioritize known issues; work the plan actively.
- Full-suite-green gate; visual verification (no "it serves" as "it works").

## Fresh sol review (HEAD 0ffd991) — CRITICAL + HIGH
- **[FIXED 78d630a] CRITICAL: the storage-hook paid recursion** — terminated (internal writes return null, never dispatch). ~~NOT fixed~~ — the storage mapper returns changedKeys:[] for internal keys but bind() still dispatches for EVERY storage event; the in-memory limiter throttles but doesn't terminate + resets on SW restart. Internal writes still invoke the subscribed agent.
- **[FIXED 78d630a] HIGH: the scoped hook runs** — now side-effect-free. ~~still expose durable/destructive tools~~ — browserToolset includes schedule_task + browser actions; memory_set is always added. Prompt-injected event data can persist state/schedule future runs. Scoped != side-effect-free.
- **HIGH: hook fan-out is unbounded** — no registry count/template-byte/recipe validation bounds; unique recipeIds let one event enqueue unbounded runs.
- **HIGH: the model-facing enroll_origin lacks a per-origin owner grant** — broad host access lets the model activate any origin without a fresh exact-origin gesture.
- **HIGH correctness: concurrent follow-ups take thread history before run serialization (diverge); nameThreadAsync holds the global thread mutex while awaiting the Prompt API title.**
- Medium: hook-required bookmarks/history/downloads/webNavigation/contextMenus/idle absent from optional_permissions; the media UI claims bytes sent but the SW doesn't pass them; the attach popover show lost on re-render.
(Positive: manifest permissions=[], no debugger, no key literal, redactSecrets blocks the value leak, the deny-list rechecked, the suite green.)

## Security testing (Paul, 2026-08-16) — a standing suite
- **A repeatable security test suite** (an agent/automated tests) reviewing the security of the site: **network exfiltration** (network traces/info must not escape), **sandbox escapes** (HTML/scripts in the double-iframe must not escape + influence the page). chaos + co-do were robust here; match that.
- **MCP-apps-style preference percolation** — user preferences should flow down through the layers (the double-iframe) properly (how? design + implement).

## CRITICAL (sol, HEAD 24dd3f7) — generative-UI sandbox network exfil
- renderHtmlFrame's injected meta CSP is insufficient: (a) injectCspMeta inserts after the first <head>, so resources BEFORE it load before the policy; (b) CSP/default-src does NOT prevent the opaque sandbox from navigating ITSELF (self-location, meta-refresh). A real Chromium probe reproduced attacker requests for all three payloads (pre-csp-image, self-location, meta-refresh). The security suite misses these escapes. Fix: enforce outside attacker-controlled markup/navigation (a non-network-capable document + request interception/URL allow policy); always prepend the CSP; block self-navigation. (sol)

## Sol addendum (HEAD 24dd3f7) — 4 HIGH
- clear() deletes the wrong path (deleting an agent leaves its OPFS sandbox/history; memoryStoreAt.clear() treats every non-master store as a site origin).
- memory_grep lacks a post-read generation recheck (a stale run can return the new enrollment's memory).
- Named agents are NOT actually runnable/delegatable (CRUD/grep/avatar only; no run/delegate path; the AGENT-MODEL.md promise unmet).
- The scoped-hook transitive bypass (the workers dont get readOnlyMemory:scoped + retain site/WebMCP tools; a hook payload can delegate into a side-effecting worker).

## Sol verifications (regression-proven, HEAD 24dd3f7)
- **CAS version issue NOT fixed** — the version is stored only in the value envelope + reset on delete, so a set→v1, delete, set-fresh reuses v1 (a stale compareAndDelete can match/delete the fresh recreation). Fix: a durable per-key version counter that survives delete/clear.
- **Named-agent deletion leaves the OPFS sandbox** (verified: after create→delete, namedAgentMemory still returns the data).

## Sol deep-review of the generative-UI + named-agent layer (HEAD 24dd3f7)
- **CRITICAL: the named-agent avatar path leaks the WRONG provider's key** (getProviderConfig ignores its argument → the active OpenAI/Anthropic/DeepSeek key sent to Google's image API). A cross-provider credential disclosure.
- HIGH: artifact-viewer XSS (the query-param id into innerHTML); artifact network egress (a model-created image artifact with an arbitrary URL loaded outside the sandbox); artifact authority gaps (the model can overwrite asset:<id> bodies; unlocked body+index multi-write).
- HIGH: the thread concurrency is partially fixed (the follow-up history snapshot before the run lock; run 1 releases the lock before appending).
- MEDIUM: the text→HTML detection regex; the preference percolation shadow-root query + done/post ordering.
(All in the sandbox-fix-2 worker, k3.)
