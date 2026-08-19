# Known Issues — Chrome Agent Platform

This tracks the open findings from the ongoing independent review (sol). The review continues in the background; these are tracked here so they don't block wider-project progress. Each entry links the round it was found + the file area.

**Status legend:** Open / In progress / Verified-fixed.

## Review process
- 30 rounds of independent security/correctness review across the integrated feature histories against the Constitution.
- Last retained clean feature baselines include **119/119 general Chrome journeys** and separate external, commit-bound unified-agent-access evidence. Current integration results must be read from the exact-commit external evidence; historical totals are not presented as proof for new bytes. All permissions remain optional (`manifest.permissions = []`) and no debugger permission is declared.
- The core architecture is confirmed solid (all-optional permissions, enrollment lifecycle, alarm scheduler fencing, screenshot capture, memory/journal CAS).
- The open findings are deep concurrency edge-cases + acceptance-coverage gaps, NOT basic-functionality bugs.

## Open (as of round 27)

### Unified agent access (CAP-FB-20260818-AGENT-ACCESS-01) — residuals
- **Site-agent delegation is text-only.** `agent.delegate` runs the enrolled
  origin's worker with the task text only: no attachments, and no live per-run
  progress stream (the run returns a single result; the composer says so when
  attachments were dropped). A live-progress + attachment path for site agents
  is a follow-up.
- **Enabling a background agent still requires the `alarms` optional
  permission** (by design — fail closed). The side panel shows disabled
  background agents with a "disabled" status; enabling remains a Settings /
  hub gesture.
- **The hub's three agent summary rows** (sidebar + main Named/Background/Site
  lists) predate `<agent-picker>` and still use `capability-row` — they open
  the same agent surfaces, but a future pass could re-express them as the
  shared picker for full consistency.
- **The side-panel page view is control-only.** Cross-origin pages live in real
  tabs; the misleading preview iframe and morph stub were removed. The panel's
  Go/Enter path crosses the sender-authenticated SW route and requires a current
  owner gesture; an agent-opened panel cannot turn its stored target into a tab
  mutation.

### Concurrency edge-cases (deep, low-likelihood)
- **Cooperative-cancellation limit (fundamental):** an already-started page/WebMCP side effect cannot be unwound — the result is discarded but the effect runs. This is a browser constraint (a running page function can't be cancelled). Documented in DESIGN.md. *Mitigations in place: pre-start cancellation, minimized window.*
- **CAS version-scoping refinements:** the version-scoped CAS landed (round 27) but the reviewer may find further ABA edge-cases in the memory/journal compensation.
- **First-message generation acceptance:** the first sync/invoke requires a generation now; verify no residual generationless path.
- **runGenCells per-run isolation:** build-local now; verify no residual shared-state race.
- **MAIN cancel tombstones bounded:** bounded now; verify eviction under load.

### Acceptance-coverage gaps (test/evidence depth)
- **System-prompts surface (feat/system-prompt-settings, all known review blockers corrected; awaiting independent re-review):** the layered/versioned system-prompt architecture + Settings → Advanced UI. The blocked paths are now structurally closed: full `/skill:<id>` bodies compose before protected-last policy at the agent boundary (including foreign prompts); Prompt API generate/stream calls bind the exact session system message + role transcript; every attempt gets an immutable execution id with finalized/unbound attestation capture (including direct delegation); the HMAC key is route-secret, versioned/rotatable, and honestly labelled ephemeral without durable storage; all UI mutations require CAS; named-agent lifecycle locking/cleanup is coordinated; future store envelopes quarantine intact; and FIPS/RFC crypto + malformed-truncation vectors are covered. The full unit, build, gallery, security, Chrome, and real-extension feature gates are rerun on the corrective commit before re-review. No push until the standing independent review clears.
- **No headed-browser screenshot success path** (headless can't grant arbitrary-tab capture; the active-tab path is documented). Needs a headed-browser test.
- **No full real-enrollment lifecycle journey** (enroll → discover → invoke → cleanup → Retry) as a single headed acceptance.
- **[OPEN — corrective implementation, exact-commit evidence + headed gesture required] WebMCP discovery observability** — Paul's "where is the content script / no logs proving it runs" gap. Round 30 blocked the prior corrective commit because its acceptance bypassed `invokeSiteTool`, approved tab identity was lost at invocation, snapshot sessions could replace each other out of order, cancellation tombstones expired, the broadcast nonce was observable, diagnostics retained raw page errors, and the retained artifact did not attest the corrective bytes. The current corrective source routes acceptance through extension-only `tools.invoke` → production `invokeSiteTool`; binds the picker-approved tab and active `documentId`; accepts snapshots only for the SW-issued navigation epoch of that active document; uses an immutable cancellation epoch; keeps the bridge key off `postMessage` and MACs/replay-fences transport; and redacts page exceptions even in diagnostics. **Trust is deliberately limited:** MACs protect cross-world transport from ordinary postMessage injection, but MAIN shares the page realm, so tools, effects, and results remain page-controlled and untrusted. `scripts/webmcp-acceptance.ts` now writes exact-clean-commit evidence outside the tree via `WEBMCP_ARTIFACT_DIR`. This item remains OPEN until that artifact passes independent review, and the two real OS permission prompts still require the headed manual run in `docs/WEBMCP-ACCEPTANCE.md`.
- **[CLOSED — scripts/capability-lifecycle.ts, 21 checks] Capability lifecycles** — grant→use→revoke acceptance for each optional capability (real CDP gestures), npm run test:capabilities.
- **[CLOSED — scripts/a11y-audit.ts, 17 checks] No accessibility audit run** — an automated a11y-tree acceptance (labels/roles/contrast/focus/landmarks across the hub/chat/settings), npm run test:a11y.
- **[CLOSED — scripts/perf-leak-trace.ts, 8 checks] No performance/leak traces** — an automated perf/leak trace (SW register/render budgets, the SW heap + OPFS + hub DOM bounded across a write loop), npm run test:perf.

## Verified-fixed (27 rounds)
- Current-main hub sidebar regression: Tasks/Agents now have parity for panel/list overflow and gutters, inline-end + alignment, expanded/collapsed/RTL/dark geometry, row formatting, and centered keyboard/pointer task-delete behavior; duplicate Site discovery copy removed. Real-extension acceptance: `scripts/sidebar-parity.ts`.
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
- **[CORRECTED LOCALLY IN 0.2.98 — independent review pending] HIGH: model-exposed destructive operations lacked an operation-specific owner grant.** The current correction binds the immutable model execution/UI document, normalized action/target, and a branded complete-payload SHA-256 digest; deduplicates and bounds single-use grants; resolves only from the exact Settings document; uses a private install-scoped OPFS HMAC for opaque target references; and holds named/hook replacement detection+approval consumption+mutation in one subsystem lock. No body `ownerUI`/activation/run flags are trusted. The 125-check loaded-MV3 suite drives real Approve/Deny clicks, proves forged NTP fields fail, exact deny leaves data intact, and verifies the opaque reference across a worker restart. A real fixture-model same-execution retry remains an explicit acceptance gap until independent review.
- HIGH residuals: sidepanel onMessage navigate opens tabs with no sender/grant check; thread authority keys model-writable (forged threads index); unlocked thread/index RMW; global progress broadcast leaks/misattributes tool data; chat never keeps threadId (mixes the global journal); **artifact body/index split writes still race/orphan and are explicitly outside the approval-only correction**; model cross-origin artifact administration needs a separate scoped-read policy; tool cards use one lastTool + String(object); record audio/camera advertised but unwired; mic can survive disconnect.
- Medium: hooks unbounded + catalog permissions undeclared/unrequestable; UTF-8 attachments mojibake; a11y gaps (focus/combobox/speaker/menu/contrast); skills unchecked. The 0.2.98 correction byte-bounds diagnostics and fails arbitrary structured values closed without invoking accessors/Proxy traps; wider diagnostics/skill bounds remain separately open.
(The apiKey leak + the recursive-run risk are the priority fixes.)

---

# Paul's UI/UX issues (2026-08-16) — tracked in docs/UI-FIXES-TRACKER.md

The full tracker is docs/UI-FIXES-TRACKER.md. Summary of the batch:
- DONE: the 5 settings issues (the switch-collision double-toggle, hooks=permissions, the duplicate back button, the origins stretch), the notification icon path, the provider Test-connection buttons, the base-select background-agent picker, the thread navigation (fullscreen + sidebar + background-agents off the NTP), the collapsed-sidebar geometry (the edge nub + centred rail icons + SVG glyphs + reload persistence + RTL), the security fixes (apiKey leak + highs), semver.
- IN PROGRESS (the tracker-remaining worker): View Transitions, HTML-output rendering, the unified Agents area, the + menu options + anchor-positioning, the @mention positioning, the error-console copy buttons + error surfacing.

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
